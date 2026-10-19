/**
 * Thin client over the locally authenticated lark-cli binary.
 *
 * lark-cli prints success envelopes ({ ok: true, data }) to stdout and error
 * envelopes ({ ok: false, error }) to stderr; both streams are parsed. All
 * Lark credentials live in lark-cli itself — this module never sees them.
 *
 * The program is always started by name: Gety's sandbox grants `run` by
 * program name and resolves it on `PATH`.
 */

import { isTimeoutError, withTimeout } from '@gety-connectors/utils/abort';
import {
	isRecord,
	nonEmptyString,
	parseJsonObject,
} from '@gety-connectors/utils/json';
import type { Logger } from '@gety-connectors/utils/log';
import {
	IncompleteEnumerationError,
	requireArray,
} from '@gety-connectors/utils/paginate';
import { retry } from '@gety-connectors/utils/retry';

export const LARK_CLI = 'lark-cli';

export type WikiNode = {
	node_token: string;
	obj_token?: string;
	space_id?: string;
	parent_node_token?: string;
	title?: string;
	origin_node_token?: string;
	origin_space_id?: string;
};

export type DriveFile = {
	token: string;
	type: string;
	name?: string;
	parent_token?: string;
	url?: string;
};

export type DrivePage = {
	files: DriveFile[];
	hasMore: boolean;
	pageToken?: string;
};

export type SearchEntity = {
	token: string;
	type: string;
	title: string;
	editedAt?: string;
	createdAt?: string;
	url?: string;
	owner?: string;
};

export type SearchPage = {
	entities: SearchEntity[];
	hasMore: boolean;
	pageToken?: string;
};

export type ChatSummary = {
	chat_id: string;
	name?: string;
	chat_mode?: string;
	/** Tenant-aware AppLink lark-cli builds for the chat (1.0.9x and later). */
	app_link?: string;
};

export type ChatPage = {
	chats: ChatSummary[];
	hasMore: boolean;
	pageToken?: string;
};

export type ChatMessage = {
	message_id?: string;
	msg_type?: string;
	content?: string;
	create_time?: string;
	deleted?: boolean;
	sender?: {
		id?: string;
		name?: string;
		sender_type?: string;
	};
};

export type MessagePage = {
	messages: ChatMessage[];
	hasMore: boolean;
	pageToken?: string;
};

/**
 * A failed lark-cli call. `type` and `subtype` are lark-cli's wire-stable
 * error taxonomy (errs/ERROR_CONTRACT.md in the lark-cli repository); `code`
 * is the upstream numeric code when known.
 */
export class LarkCliError extends Error {
	readonly missingScopes: string[];
	readonly code?: string;
	readonly type?: string;
	readonly subtype?: string;

	constructor(
		message: string,
		details: {
			missingScopes?: string[];
			code?: unknown;
			type?: string;
			subtype?: string;
		} = {},
	) {
		super(message);
		this.name = 'LarkCliError';
		this.missingScopes = details.missingScopes ?? [];
		this.code = details.code == null ? undefined : String(details.code);
		this.type = details.type;
		this.subtype = details.subtype;
	}
}

/** One lark-cli call ran out of its time budget and was killed. */
export class LarkCliTimeoutError extends LarkCliError {
	constructor(message: string) {
		super(message);
		this.name = 'LarkCliTimeoutError';
	}
}

/**
 * lark-cli could not be started at all. Every call would fail the same way,
 * so callers must not treat it as a per-item failure.
 */
export class LarkCliUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'LarkCliUnavailableError';
	}
}

/**
 * True for errors that end the poll wherever they occur: cancellation, a
 * sandbox denial, or a lark-cli that cannot be started. Per-item error
 * handlers rethrow these instead of skipping the item, so a missing grant
 * fails the sync instead of looking like an empty source.
 */
export function isFatalError(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || error instanceof LarkCliUnavailableError ||
		error instanceof Deno.errors.NotCapable;
}

/**
 * True only when lark-cli confirms that the resource is gone or that the
 * user lost access to it. Any other failure — network, rate limit, timeout,
 * a missing scope, an unclassified upstream code, or an older lark-cli
 * without the error taxonomy — leaves the answer unknown.
 */
export function isConfirmedGone(error: unknown): boolean {
	return error instanceof LarkCliError &&
		((error.type === 'api' && error.subtype === 'not_found') ||
			(error.type === 'authorization' &&
				error.subtype === 'permission_denied'));
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const DOCS_PAGE_SIZE = '20';
const CHATS_PAGE_SIZE = '100';
const MESSAGES_PAGE_SIZE = '50';

/**
 * Per-call budget. A call blocked on a keychain prompt or a stalled
 * connection would otherwise hold the poll until the host's 10-minute idle
 * limit kills it.
 */
export const CALL_TIMEOUT_MS = 5 * 60_000;
/** Attempts per call, including the first; retries only transient failures. */
const MAX_ATTEMPTS = 4;
/** A timed-out call is retried once: a second hang is not transient. */
const MAX_TIMEOUT_RETRIES = 1;

type CliEnvelope = {
	ok?: boolean;
	data?: unknown;
	error?: {
		type?: string;
		subtype?: string;
		code?: unknown;
		message?: string;
		missing_scopes?: unknown;
		retryable?: unknown;
		retry_after_seconds?: unknown;
	};
};

/** A failed call whose envelope allows a retry, with the requested delay. */
class RetryableCliError extends LarkCliError {
	constructor(message: string, readonly retryAfterMs: number | undefined) {
		super(message);
	}
}

export type LarkCliOptions = {
	logger?: Logger;
	timeoutMs?: number;
	/** Backoff base for retries; tests shorten it. */
	retryBaseDelayMs?: number;
};

export class LarkCliClient {
	constructor(
		private readonly bin: string,
		private readonly signal: AbortSignal,
		private readonly options: LarkCliOptions = {},
	) {}

	/** Same CLI, cancelled by `signal` instead (kills in-flight subprocesses). */
	withSignal(signal: AbortSignal): LarkCliClient {
		return new LarkCliClient(this.bin, signal, this.options);
	}

	/**
	 * One page of the Search v2 browse enumeration. An empty query needs the
	 * wide --created-since window to browse instead of returning only recent
	 * documents, and the server-side --doc-types filter returns zero results
	 * in that mode, so type filtering must happen in the caller. The default
	 * sort and edit_time sort have complementary recall and must be unioned.
	 */
	searchDocs(
		options: { sortByEditTime?: boolean; pageToken?: string } = {},
	): Promise<SearchPage> {
		return this.run([
			'drive',
			'+search',
			'--as',
			'user',
			'--query',
			'',
			'--created-since',
			'2000-01-01',
			'--page-size',
			DOCS_PAGE_SIZE,
			...(options.sortByEditTime ? ['--sort', 'edit_time'] : []),
			...(options.pageToken == null ? [] : ['--page-token', options.pageToken]),
		]).then(extractSearchPage);
	}

	/**
	 * Fetches a document's markdown export. Prefer passing the URL: lark-cli
	 * unwraps wiki URLs to the underlying document, which a bare wiki node
	 * token would not resolve. Returns null when the document has no content.
	 */
	async fetchDocMarkdown(ref: string): Promise<string | null> {
		const data = await this.run([
			'docs',
			'+fetch',
			'--api-version',
			'v2',
			'--as',
			'user',
			'--doc',
			ref,
			'--doc-format',
			'markdown',
			'--scope',
			'full',
		]);
		return extractDocContent(data);
	}

	async getWikiNode(token: string, objType?: string): Promise<WikiNode> {
		const data = await this.api('/open-apis/wiki/v2/spaces/get_node', {
			token,
			...(objType == null ? {} : { obj_type: objType }),
		});
		const node = isRecord(data) && isRecord(data.node) ? data.node : null;
		const nodeToken = nonEmptyString(node?.node_token);
		if (node == null || nodeToken == null) {
			throw new LarkCliError('Wiki response contains no node');
		}
		return {
			node_token: nodeToken,
			obj_token: nonEmptyString(node.obj_token),
			space_id: nonEmptyString(node.space_id),
			parent_node_token: nonEmptyString(node.parent_node_token),
			title: nonEmptyString(node.title),
			origin_node_token: nonEmptyString(node.origin_node_token),
			origin_space_id: nonEmptyString(node.origin_space_id),
		};
	}

	async getWikiSpaceName(spaceId: string): Promise<string | undefined> {
		const data = await this.api(
			`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}`,
		);
		return isRecord(data) && isRecord(data.space)
			? nonEmptyString(data.space.name)
			: undefined;
	}

	async listDriveFiles(
		folderToken?: string,
		pageToken?: string,
	): Promise<DrivePage> {
		const data = await this.api('/open-apis/drive/v1/files', {
			page_size: 200,
			...(folderToken == null ? {} : { folder_token: folderToken }),
			...(pageToken == null ? {} : { page_token: pageToken }),
		});
		if (!isRecord(data) || !Array.isArray(data.files)) {
			throw new LarkCliError('Drive response contains no file list');
		}
		const files: DriveFile[] = [];
		for (const item of data.files) {
			if (!isRecord(item)) continue;
			const token = nonEmptyString(item.token);
			const type = nonEmptyString(item.type);
			if (token == null || type == null) continue;
			files.push({
				token,
				type,
				name: nonEmptyString(item.name),
				parent_token: nonEmptyString(item.parent_token),
				url: nonEmptyString(item.url),
			});
		}
		return {
			files,
			hasMore: data.has_more === true,
			pageToken: nonEmptyString(data.next_page_token),
		};
	}

	private async api(
		path: string,
		params: Record<string, string | number> = {},
	): Promise<unknown> {
		const result = await this.run([
			'api',
			'GET',
			path,
			'--as',
			'user',
			'--format',
			'json',
			'--params',
			JSON.stringify(params),
		]);
		// Raw API envelopes may contain the original OpenAPI code/data wrapper.
		if (isRecord(result) && typeof result.code === 'number') {
			if (result.code !== 0) {
				throw new LarkCliError(
					nonEmptyString(result.msg) ?? `OpenAPI error ${result.code}`,
					{ code: result.code },
				);
			}
			return result.data;
		}
		return result;
	}

	/** Group and p2p chats, most recently active first. */
	async listChats(pageToken?: string): Promise<ChatPage> {
		const data = await this.run([
			'im',
			'+chat-list',
			'--as',
			'user',
			'--types',
			'group,p2p',
			'--sort',
			'active_time',
			'--page-size',
			CHATS_PAGE_SIZE,
			...(pageToken == null ? [] : ['--page-token', pageToken]),
		]);
		const context = 'lark-cli im +chat-list';
		const page = listPage(data, 'chats', context);
		const chats: ChatSummary[] = [];
		for (const raw of page.items) {
			// A chat row without an id cannot be synced; skipping it would let
			// the sync count as complete and retire that chat's old docs.
			const chatId = isRecord(raw) ? nonEmptyString(raw.chat_id) : undefined;
			if (!isRecord(raw) || chatId == null) {
				throw new IncompleteEnumerationError(
					`${context}: unexpected chat row without chat_id`,
				);
			}
			chats.push({
				chat_id: chatId,
				name: nonEmptyString(raw.name),
				chat_mode: nonEmptyString(raw.chat_mode),
				app_link: nonEmptyString(raw.chat_app_link),
			});
		}
		return { chats, hasMore: page.hasMore, pageToken: page.pageToken };
	}

	async listMessages(
		chatId: string,
		startISO: string,
		pageToken?: string,
	): Promise<MessagePage> {
		const data = await this.run([
			'im',
			'+chat-messages-list',
			'--as',
			'user',
			'--chat-id',
			chatId,
			'--start',
			startISO,
			'--order',
			'asc',
			'--no-reactions',
			'--page-size',
			MESSAGES_PAGE_SIZE,
			...(pageToken == null ? [] : ['--page-token', pageToken]),
		]);
		const context = 'lark-cli im +chat-messages-list';
		const page = listPage(data, 'messages', context);
		const messages: ChatMessage[] = [];
		for (const raw of page.items) {
			const message = parseMessage(raw);
			if (message == null) {
				throw new IncompleteEnumerationError(
					`${context}: unexpected message row without message_id or create_time`,
				);
			}
			messages.push(message);
		}
		return { messages, hasMore: page.hasMore, pageToken: page.pageToken };
	}

	/**
	 * Runs one lark-cli command and returns the success envelope's `data`.
	 * Each attempt has its own timeout; rate limits, envelopes marked
	 * retryable and (once) timeouts are retried with backoff. Cancellation is
	 * never retried and surfaces as the signal's reason. A retry is logged
	 * both when its wait starts and when its attempt starts, so neither a
	 * slow failed call plus the wait, nor the wait plus the next call, is
	 * silent for longer than one call's timeout.
	 */
	protected async run(args: string[]): Promise<unknown> {
		const command = args.slice(0, 2).join(' ');
		let timeouts = 0;
		let retrying = false;
		const result = await retry(
			(attempt, signal) => {
				if (retrying) {
					this.options.logger?.info('retrying lark-cli call now', {
						command,
						attempt,
					});
				}
				return this.runOnce(args, command, signal);
			},
			{
				signal: this.signal,
				maxAttempts: MAX_ATTEMPTS,
				baseDelayMs: this.options.retryBaseDelayMs ?? 1_000,
				maxDelayMs: 30_000,
				shouldRetry: (error) => {
					if (error instanceof LarkCliTimeoutError) {
						timeouts += 1;
						return timeouts <= MAX_TIMEOUT_RETRIES;
					}
					if (error instanceof RetryableCliError) {
						return { retryAfterMs: error.retryAfterMs };
					}
					return false;
				},
				onRetry: ({ delayMs, error }) => {
					retrying = true;
					this.options.logger?.info('lark-cli call failed; retrying', {
						command,
						delay_ms: delayMs,
						reason: errorMessage(error),
					});
				},
			},
		);
		this.options.logger?.progress('lark-cli call finished', { command });
		return result;
	}

	private async runOnce(
		args: string[],
		command: string,
		signal: AbortSignal,
	): Promise<unknown> {
		const timeoutMs = this.options.timeoutMs ?? CALL_TIMEOUT_MS;
		const attemptSignal = withTimeout(signal, timeoutMs);
		let output: Deno.CommandOutput;
		try {
			output = await new Deno.Command(this.bin, {
				args,
				stdin: 'null',
				stdout: 'piped',
				stderr: 'piped',
				signal: attemptSignal,
			}).output();
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof Deno.errors.NotCapable) {
				// The sandbox's own message names the missing `run` grant.
				throw error;
			}
			if (error instanceof Deno.errors.NotFound) {
				throw new LarkCliUnavailableError(
					`"${this.bin}" was not found on the PATH Gety runs with. ` +
						'Install lark-cli, finish `lark-cli auth login`, and make sure ' +
						'the lark-cli executable is on PATH (see the connector README).',
					{ cause: error },
				);
			}
			throw new LarkCliUnavailableError(
				`failed to start "${this.bin}": ${errorMessage(error)}`,
				{ cause: error },
			);
		}
		// A killed child resolves output() instead of rejecting it.
		signal.throwIfAborted();
		if (attemptSignal.aborted && isTimeoutError(attemptSignal.reason)) {
			throw new LarkCliTimeoutError(
				`lark-cli ${command} timed out after ${Math.round(timeoutMs / 1000)}s`,
			);
		}

		const stdoutText = new TextDecoder().decode(output.stdout);
		const stderrText = new TextDecoder().decode(output.stderr).trim();
		const envelope = (parseJsonObject(stdoutText) ??
			parseJsonObject(stderrText)) as CliEnvelope | undefined;

		if (envelope?.ok === true) {
			return envelope.data ?? null;
		}

		const error = envelope?.error;
		const message = `lark-cli ${command} failed: ${
			error?.message ?? (stderrText || `exit code ${output.code}`)
		}`;
		if (isRetryableFailure(envelope)) {
			const seconds = error?.retry_after_seconds;
			throw new RetryableCliError(
				message,
				typeof seconds === 'number' && Number.isFinite(seconds) &&
					seconds >= 0
					? seconds * 1000
					: undefined,
			);
		}
		throw new LarkCliError(message, {
			missingScopes: Array.isArray(error?.missing_scopes)
				? error.missing_scopes.filter((scope): scope is string =>
					typeof scope === 'string'
				)
				: [],
			code: error?.code,
			type: nonEmptyString(error?.type),
			subtype: nonEmptyString(error?.subtype),
		});
	}
}

/**
 * Rate limits (by subtype, or by wording for lark-cli versions without the
 * taxonomy) and envelopes lark-cli marks `retryable` are transient.
 */
export function isRetryableFailure(
	envelope: CliEnvelope | null | undefined,
): boolean {
	const error = envelope?.error;
	if (error == null) {
		return false;
	}
	if (error.retryable === true) {
		return true;
	}
	const text = [error.type, error.subtype, error.code, error.message]
		.map(String)
		.join(' ');
	return /rate.?limit|too many requests?|\b429\b/i.test(text);
}

/**
 * The item list and pagination of a list command's `data`. lark-cli is a Go
 * program, so an empty list may arrive as `null`; anything else that is not
 * an array means the output format changed, and a silently empty page would
 * read as "everything was deleted".
 */
function listPage(
	data: unknown,
	key: string,
	context: string,
): { items: unknown[]; hasMore: boolean; pageToken?: string } {
	if (!isRecord(data) || !Object.hasOwn(data, key)) {
		throw new IncompleteEnumerationError(
			`${context}: unexpected output without "${key}"`,
		);
	}
	const raw = data[key];
	return {
		items: raw === null ? [] : requireArray(raw, context),
		hasMore: data.has_more === true,
		pageToken: nonEmptyString(data.page_token),
	};
}

/** lark-cli's `create_time` form: local "YYYY-MM-DD HH:MM". */
const MESSAGE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

/**
 * Reads one `im +chat-messages-list` row. A live message must carry the id
 * and time the chat docs are keyed and ordered by; a deleted-message
 * tombstone is kept whatever else it carries, since it is never indexed.
 * Returns undefined for any other row so the caller can fail closed.
 */
function parseMessage(raw: unknown): ChatMessage | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const deleted = raw.deleted === true;
	const messageId = nonEmptyString(raw.message_id);
	const createTime = typeof raw.create_time === 'string' &&
			MESSAGE_TIME.test(raw.create_time)
		? raw.create_time
		: undefined;
	if (!deleted && (messageId == null || createTime == null)) {
		return undefined;
	}
	const sender = isRecord(raw.sender) ? raw.sender : undefined;
	return {
		message_id: messageId,
		msg_type: nonEmptyString(raw.msg_type),
		content: typeof raw.content === 'string' ? raw.content : undefined,
		create_time: createTime,
		deleted,
		sender: sender == null ? undefined : {
			id: nonEmptyString(sender.id),
			name: nonEmptyString(sender.name),
			sender_type: nonEmptyString(sender.sender_type),
		},
	};
}

/**
 * Maps a Search v2 doc_wiki page: `results[].result_meta` carries the token,
 * tenant URL, and unix timestamps; the title arrives highlight-tagged in
 * `title_highlighted`. `doc_types` is UPPERCASE (e.g. "DOCX") on the wire.
 */
export function extractSearchPage(data: unknown): SearchPage {
	const page = listPage(data, 'results', 'lark-cli drive +search');
	const entities: SearchEntity[] = [];
	for (const raw of page.items) {
		if (!isRecord(raw)) {
			continue;
		}
		const meta = isRecord(raw.result_meta) ? raw.result_meta : {};
		const token = nonEmptyString(meta.token);
		if (token == null) {
			continue;
		}
		const type = (nonEmptyString(meta.doc_types) ??
			nonEmptyString(raw.entity_type) ?? 'doc').toLowerCase();
		const title = stripHighlightTags(
			nonEmptyString(raw.title_highlighted) ?? nonEmptyString(raw.title) ??
				'',
		).trim();
		entities.push({
			token,
			type,
			title: title || '无标题文档',
			editedAt: normalizeSourceTime(meta.update_time ?? meta.update_time_iso),
			createdAt: normalizeSourceTime(
				meta.create_time ?? meta.create_time_iso,
			),
			url: nonEmptyString(meta.url),
			owner: nonEmptyString(meta.owner_name),
		});
	}

	return {
		entities,
		hasMore: page.hasMore,
		pageToken: page.pageToken,
	};
}

export function extractDocContent(data: unknown): string | null {
	if (typeof data === 'string') {
		return data.trim() === '' ? null : data;
	}
	if (!isRecord(data)) {
		return null;
	}
	for (const key of ['content', 'markdown', 'text', 'document', 'data']) {
		const value = data[key];
		if (typeof value === 'string' && value.trim() !== '') {
			return value;
		}
		if (isRecord(value)) {
			const nested = extractDocContent(value);
			if (nested != null) {
				return nested;
			}
		}
	}
	return null;
}

/**
 * lark-cli emits local times like "2026-07-10 11:22"; the connector runs on
 * the same machine as the CLI, so parsing in the local zone is correct.
 */
export function isoFromLarkTime(
	value: string | undefined,
): string | undefined {
	if (!value) {
		return undefined;
	}
	let normalized = value.trim();
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
		normalized = normalized.replace(' ', 'T');
		if (/T\d{2}:\d{2}$/.test(normalized)) {
			normalized = `${normalized}:00`;
		}
	}
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Accepts unix seconds/milliseconds (number or numeric string) or date text. */
export function normalizeSourceTime(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const ms = value > 1e12 ? value : value * 1000;
		return new Date(ms).toISOString();
	}
	if (typeof value === 'string') {
		if (/^\d+$/.test(value)) {
			return normalizeSourceTime(Number(value));
		}
		return isoFromLarkTime(value);
	}
	return undefined;
}

export function stripHighlightTags(value: string): string {
	return value.replace(/<\/?[a-z][^>]*>/gi, '');
}
