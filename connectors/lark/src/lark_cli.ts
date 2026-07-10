/**
 * Thin client over the locally authenticated lark-cli binary.
 *
 * lark-cli prints success envelopes ({ ok: true, data }) to stdout and error
 * envelopes ({ ok: false, error }) to stderr; both streams are parsed. All
 * Lark credentials live in lark-cli itself — this module never sees them.
 */

type JsonRecord = Record<string, unknown>;

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

export class LarkCliError extends Error {
	readonly missingScopes: string[];

	constructor(message: string, missingScopes: string[] = []) {
		super(message);
		this.name = 'LarkCliError';
		this.missingScopes = missingScopes;
	}
}

const DOCS_PAGE_SIZE = '20';
const CHATS_PAGE_SIZE = '100';
const MESSAGES_PAGE_SIZE = '50';

type CliEnvelope = {
	ok?: boolean;
	data?: unknown;
	error?: {
		type?: string;
		subtype?: string;
		code?: unknown;
		message?: string;
		missing_scopes?: unknown;
	};
};

export class LarkCliClient {
	constructor(
		private readonly bin: string,
		private readonly signal: AbortSignal,
		private readonly retryDelaysMs: readonly number[] = [1_000, 2_500, 5_000],
	) {}

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
		if (!isRecord(data)) {
			return { chats: [], hasMore: false };
		}
		const chats: ChatSummary[] = [];
		for (const raw of Array.isArray(data.chats) ? data.chats : []) {
			if (!isRecord(raw)) {
				continue;
			}
			const chatId = asString(raw.chat_id);
			if (chatId == null) {
				continue;
			}
			chats.push({
				chat_id: chatId,
				name: asString(raw.name),
				chat_mode: asString(raw.chat_mode),
			});
		}
		return {
			chats,
			hasMore: data.has_more === true,
			pageToken: asString(data.page_token),
		};
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
		if (!isRecord(data)) {
			return { messages: [], hasMore: false };
		}
		const messages: ChatMessage[] = [];
		for (const raw of Array.isArray(data.messages) ? data.messages : []) {
			if (isRecord(raw)) {
				messages.push(raw as ChatMessage);
			}
		}
		return {
			messages,
			hasMore: data.has_more === true,
			pageToken: asString(data.page_token),
		};
	}

	private async run(args: string[]): Promise<unknown> {
		for (let attempt = 0;; attempt += 1) {
			this.signal.throwIfAborted();

			const command = new Deno.Command(this.bin, {
				args,
				stdin: 'null',
				stdout: 'piped',
				stderr: 'piped',
				signal: this.signal,
			});

			let output: Deno.CommandOutput;
			try {
				output = await command.output();
			} catch (error) {
				this.signal.throwIfAborted();
				throw new LarkCliError(
					`failed to run "${this.bin}": ${errorMessage(error)}. ` +
						'Install lark-cli and finish `lark-cli auth login` first, ' +
						'or set the lark-cli path in the connector config.',
				);
			}

			const stdoutText = new TextDecoder().decode(output.stdout);
			const stderrText = new TextDecoder().decode(output.stderr).trim();
			const envelope = parseEnvelope(stdoutText) ?? parseEnvelope(stderrText);

			if (envelope?.ok === true) {
				return envelope.data ?? null;
			}

			const delay = this.retryDelaysMs[attempt];
			if (delay != null && isRateLimitFailure(envelope)) {
				await abortableDelay(delay, this.signal);
				continue;
			}

			const detail = envelope?.error?.message ??
				(stderrText || `exit code ${output.code}`);
			throw new LarkCliError(
				`lark-cli ${args.slice(0, 2).join(' ')} failed: ${detail}`,
				missingScopes(envelope),
			);
		}
	}
}

export function isRateLimitFailure(
	envelope: CliEnvelope | null | undefined,
): boolean {
	const error = envelope?.error;
	if (error == null) {
		return false;
	}
	const text = [error.type, error.subtype, error.code, error.message]
		.map(String)
		.join(' ');
	return /rate.?limit|too many requests?|\b429\b/i.test(text);
}

function missingScopes(envelope: CliEnvelope | null | undefined): string[] {
	const raw = envelope?.error?.missing_scopes;
	return Array.isArray(raw)
		? raw.filter((scope): scope is string => typeof scope === 'string')
		: [];
}

function parseEnvelope(text: string): CliEnvelope | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? (parsed as CliEnvelope) : null;
	} catch {
		return null;
	}
}

/**
 * Maps a Search v2 doc_wiki page: `results[].result_meta` carries the token,
 * tenant URL, and unix timestamps; the title arrives highlight-tagged in
 * `title_highlighted`. `doc_types` is UPPERCASE (e.g. "DOCX") on the wire.
 */
export function extractSearchPage(data: unknown): SearchPage {
	if (!isRecord(data)) {
		return { entities: [], hasMore: false };
	}

	const results = Array.isArray(data.results) ? data.results : [];
	const entities: SearchEntity[] = [];
	for (const raw of results) {
		if (!isRecord(raw)) {
			continue;
		}
		const meta = isRecord(raw.result_meta) ? raw.result_meta : {};
		const token = asString(meta.token);
		if (token == null) {
			continue;
		}
		const type = (asString(meta.doc_types) ?? asString(raw.entity_type) ??
			'doc').toLowerCase();
		const title = stripHighlightTags(
			asString(raw.title_highlighted) ?? asString(raw.title) ?? '',
		).trim();
		entities.push({
			token,
			type,
			title: title || '无标题文档',
			editedAt: normalizeSourceTime(meta.update_time ?? meta.update_time_iso),
			createdAt: normalizeSourceTime(
				meta.create_time ?? meta.create_time_iso,
			),
			url: asString(meta.url) ?? buildDocUrl(type, token),
			owner: asString(meta.owner_name),
		});
	}

	return {
		entities,
		hasMore: data.has_more === true,
		pageToken: asString(data.page_token),
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

export function buildDocUrl(type: string, token: string): string {
	const path = type === 'docx'
		? 'docx'
		: type === 'wiki'
		? 'wiki'
		: type === 'sheet'
		? 'sheets'
		: type === 'bitable'
		? 'base'
		: 'docs';
	return `https://feishu.cn/${path}/${token}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortableDelay(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
