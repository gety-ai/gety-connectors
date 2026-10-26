import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import { walkFiles } from '@gety-connectors/utils/fs';
import {
	isRecord,
	parseJsonObject,
	stringValue,
} from '@gety-connectors/utils/json';
import { LINE_PREFIX_BYTES, readJsonl } from '@gety-connectors/utils/jsonl';
import { clampUtf8, MAX_CONTENT_BYTES } from '@gety-connectors/utils/text';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CodexSessionFile {
	path: string;
	stateKey: string;
	mtimeMs: number;
	size: number;
}

/**
 * The log files of one session, in session order. Codex continues a long
 * session in segment files named `rollout-<time>-<session id>_<segment
 * id>.jsonl` next to the first `rollout-<time>-<session id>.jsonl`; each
 * segment holds only the turns written after the previous one.
 */
export interface CodexSessionGroup {
	/** See `sessionGroupKey`. */
	key: string;
	files: CodexSessionFile[];
}

/** A directory of session logs; `stateKey` prefixes its files' state keys. */
export interface CodexSessionRoot {
	path: string;
	stateKey: string;
	/**
	 * A missing required root fails the poll; a missing optional root counts
	 * as an empty directory.
	 */
	required: boolean;
}

export interface CodexSessionListing {
	/** Sorted by mtime, oldest first, then by path. */
	files: CodexSessionFile[];
	/** False when an entry vanished during the walk or it was aborted. */
	complete: boolean;
}

export interface ParseCodexSessionOptions {
	includeToolCalls: boolean;
	/**
	 * Stop reading once the session's own `session_meta` marks it as a
	 * subagent session: its content is not needed when subagents are excluded.
	 */
	skipSubagents?: boolean;
}

export interface CodexSession {
	id: string;
	title: string;
	sourcePath: string;
	sourceSize: number;
	url: string;
	startedAt?: string;
	updatedAt: string;
	cwd?: string;
	workspaceRoots: string[];
	model?: string;
	modelProvider?: string;
	cliVersion?: string;
	source?: string;
	messageCount: number;
	userMessageCount: number;
	codexMessageCount: number;
	toolCallCount: number;
	/** Spawned by another session (Codex multi-agent), per its own meta. */
	subagent: boolean;
	contentTruncated: boolean;
	content: string;
}

export function isIndexableCodexSession(
	session: CodexSession,
	includeSubagents: boolean,
): boolean {
	return (includeSubagents || !session.subagent) &&
		session.userMessageCount > 0 && session.codexMessageCount > 0;
}

interface LogEvent {
	timestamp?: string;
	type?: string;
	payload?: Record<string, unknown>;
}

interface MessageItem {
	type?: string;
	role?: string;
	phase?: string;
	content?: unknown;
}

interface ToolCallItem {
	type?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
}

interface ConversationRound {
	userMessages: string[];
	codexMessages: string[];
	toolCalls: string[];
}

interface SessionContentMeta {
	cwd?: string;
	workspaceRoots: readonly string[];
	model?: string;
}

interface ParseAccumulator {
	/** The first `session_meta` was applied; later ones are ignored. */
	sawSessionMeta: boolean;
	subagent: boolean;
	id?: string;
	summary?: string;
	firstPrompt?: string;
	startedAt?: string;
	cwd?: string;
	workspaceRoots: string[];
	model?: string;
	modelProvider?: string;
	cliVersion?: string;
	source?: string;
	messageCount: number;
	userMessageCount: number;
	codexMessageCount: number;
	toolCallCount: number;
	rounds: ConversationRound[];
	currentRound: ConversationRound | null;
}

const SESSION_DOC_TYPE = 'codex:session';

/**
 * Lists the `.jsonl` files under `roots`. Throws when a required root does
 * not exist: a missing source is an error, never an empty one (otherwise the
 * poll would delete every indexed session). Sandbox and permission errors
 * are thrown as well.
 */
export async function listCodexSessionFiles(
	roots: readonly CodexSessionRoot[],
	signal: AbortSignal,
): Promise<CodexSessionListing> {
	const files: CodexSessionFile[] = [];
	let complete = true;
	for (const root of roots) {
		const walk = await walkFiles(root.path, {
			include: (relPath) => relPath.endsWith('.jsonl'),
			signal,
		});
		if (walk.rootMissing) {
			if (root.required) {
				throw new Error(
					`Codex sessions directory not found: ${root.path}. Run Codex at least once to create it.`,
				);
			}
			continue;
		}
		complete &&= walk.complete;
		for (const entry of walk.files) {
			files.push({
				path: entry.absPath,
				stateKey: `${root.stateKey}/${entry.relPath}`,
				mtimeMs: entry.mtimeMs,
				size: entry.size,
			});
		}
	}

	files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
	return { files, complete };
}

/**
 * The session a log file belongs to: the session id in its Codex file name,
 * or, for a name that does not follow the Codex pattern, its own state key.
 * A pure function of the state key, so the session of a file that is gone
 * can still be found from the previous state.
 */
export function sessionGroupKey(stateKey: string): string {
	return ROLLOUT_FILE_NAME.exec(basename(stateKey))?.[1] ?? stateKey;
}

/**
 * Groups `files` (as listed) by session. Segments are ordered by the time in
 * their name; sessions by their newest file, oldest first.
 */
export function groupCodexSessionFiles(
	files: readonly CodexSessionFile[],
): CodexSessionGroup[] {
	const groups = new Map<string, CodexSessionFile[]>();
	const byNewest = [...files].sort((a, b) =>
		b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)
	);
	for (const file of byNewest) {
		const key = sessionGroupKey(file.stateKey);
		const group = groups.get(key);
		if (group == null) {
			groups.set(key, [file]);
		} else {
			group.push(file);
		}
	}
	return [...groups].reverse().map(([key, group]) => ({
		key,
		files: group.sort((a, b) =>
			basename(a.path).localeCompare(basename(b.path)) ||
			a.stateKey.localeCompare(b.stateKey)
		),
	}));
}

/**
 * Streams the log files of one session, in order, into one session. Errors
 * opening any of them (e.g. `NotFound`) propagate.
 */
export async function parseCodexSessionFiles(
	files: readonly CodexSessionFile[],
	options: ParseCodexSessionOptions,
	signal: AbortSignal,
): Promise<CodexSession> {
	const accumulator = emptyAccumulator();
	for (const file of files) {
		const records = readJsonl(file.path, {
			signal,
			linePrefix: (bytes, start, end) =>
				lineVerdict(bytes, start, end, options),
			prefilter: (line) => shouldParseLine(line, options),
		});
		for await (const record of records) {
			applyEvent(accumulator, record as LogEvent, options);
			if (options.skipSubagents && accumulator.subagent) {
				return sessionFromAccumulator(accumulator, files);
			}
		}
	}
	return sessionFromAccumulator(accumulator, files);
}

export function parseCodexSessionLines(
	lines: readonly string[],
	file: CodexSessionFile,
	options: ParseCodexSessionOptions,
): CodexSession {
	const accumulator = emptyAccumulator();
	for (const line of lines) {
		const event = parseRelevantLine(line, options);
		if (event == null) {
			continue;
		}
		applyEvent(accumulator, event, options);
		if (options.skipSubagents && accumulator.subagent) {
			break;
		}
	}

	return sessionFromAccumulator(accumulator, [file]);
}

function emptyAccumulator(): ParseAccumulator {
	return {
		sawSessionMeta: false,
		subagent: false,
		workspaceRoots: [],
		messageCount: 0,
		userMessageCount: 0,
		codexMessageCount: 0,
		toolCallCount: 0,
		rounds: [],
		currentRound: null,
	};
}

/** `files` are the session's log files in order; the first one starts it. */
function sessionFromAccumulator(
	accumulator: ParseAccumulator,
	files: readonly CodexSessionFile[],
): CodexSession {
	finishCurrentRound(accumulator);

	const first = files[0];
	const id = accumulator.id ?? sessionIdFromPath(first.path);
	const title = titleForSession(accumulator, first.path);
	const updatedAt = new Date(
		Math.max(...files.map((file) => file.mtimeMs)),
	).toISOString();
	const contentResult = renderSessionContent(title, accumulator.rounds, {
		cwd: accumulator.cwd,
		workspaceRoots: accumulator.workspaceRoots,
		model: accumulator.model,
	});

	return {
		id,
		title,
		sourcePath: first.path,
		sourceSize: files.reduce((total, file) => total + file.size, 0),
		url: pathToFileURL(first.path).href,
		startedAt: accumulator.startedAt,
		updatedAt,
		cwd: accumulator.cwd,
		workspaceRoots: accumulator.workspaceRoots,
		model: accumulator.model,
		modelProvider: accumulator.modelProvider,
		cliVersion: accumulator.cliVersion,
		source: accumulator.source,
		messageCount: accumulator.messageCount,
		userMessageCount: accumulator.userMessageCount,
		codexMessageCount: accumulator.codexMessageCount,
		toolCallCount: accumulator.toolCallCount,
		subagent: accumulator.subagent,
		contentTruncated: contentResult.truncated,
		content: contentResult.content,
	};
}

export function buildCodexSessionUpdate(session: CodexSession): DocUpdate {
	return upsert({
		id: codexSessionDocId(session.id),
		title: session.title,
		content: session.content,
		content_format: 'markdown',
		doc_updated_at: session.updatedAt,
		doc_type: SESSION_DOC_TYPE,
		original_file_size: session.sourceSize,
		metadata: {
			url: session.url,
			source: 'codex',
			source_path: session.sourcePath,
			session_id: session.id,
			cwd: session.cwd,
			workspace_roots: session.workspaceRoots,
			model: session.model,
			model_provider: session.modelProvider,
			created_at: session.startedAt,
			cli_version: session.cliVersion,
			message_count: session.messageCount,
			user_message_count: session.userMessageCount,
			codex_message_count: session.codexMessageCount,
			tool_call_count: session.toolCallCount,
			content_truncated: session.contentTruncated,
		},
	});
}

export function buildCodexSessionDelete(
	session: Pick<CodexSession, 'id'>,
): DocUpdate {
	return del(codexSessionDocId(session.id));
}

function codexSessionDocId(sessionId: string): string {
	return `codex:session:${sessionId}`;
}

function parseRelevantLine(
	line: string,
	options: ParseCodexSessionOptions,
): LogEvent | null {
	// The decision readJsonl makes in parseCodexSessionFiles.
	const bytes = encoder.encode(line);
	const verdict = lineVerdict(
		bytes,
		0,
		Math.min(bytes.length, LINE_PREFIX_BYTES),
		options,
	);
	if (
		verdict === false ||
		(verdict === undefined && !shouldParseLine(line, options))
	) {
		return null;
	}
	return (parseJsonObject(line) as LogEvent | undefined) ?? null;
}

const encoder = new TextEncoder();
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
/** After the opening quote of a `type` key, up to its string value. */
const TYPE_KEY = encoder.encode('type":"');
/** After a `response_item` value, up to the payload's own type value. */
const PAYLOAD_TYPE = encoder.encode(',"payload":{"type":"');
const SESSION_META = encoder.encode('session_meta');
const TURN_CONTEXT = encoder.encode('turn_context');
const RESPONSE_ITEM = encoder.encode('response_item');
const MESSAGE = encoder.encode('message');
const FUNCTION_CALL = encoder.encode('function_call');
const CUSTOM_TOOL_CALL = encoder.encode('custom_tool_call');

/**
 * Whether `applyEvent` can use a log line, judged from its first bytes
 * `bytes[start..end)` before it is decoded (see `LinePrefixFilter`). Codex
 * writes every line as `{"timestamp":…,"type":"<kind>","payload":{"type":…`.
 * `session_meta` and `turn_context` lines are used, and so are
 * `response_item` lines whose payload is a message, or a tool call when tool
 * calls are indexed; the payload is the item itself, so its own type decides.
 * Every other line is rejected undecoded: most of a log is tool output,
 * reasoning and events. A line in another shape (or with an escaped type)
 * gets `undefined` and is left to `shouldParseLine`.
 */
function lineVerdict(
	bytes: Uint8Array,
	start: number,
	end: number,
	options: ParseCodexSessionOptions,
): boolean | undefined {
	const kind = topLevelTypeValue(bytes, start, end);
	const kindEnd = kind === -1 ? -1 : plainStringEnd(bytes, kind, end);
	if (kindEnd === -1) {
		return undefined;
	}
	if (
		equalsAt(bytes, kind, kindEnd, SESSION_META) ||
		equalsAt(bytes, kind, kindEnd, TURN_CONTEXT)
	) {
		return true;
	}
	if (!equalsAt(bytes, kind, kindEnd, RESPONSE_ITEM)) {
		return false;
	}
	if (!startsWithAt(bytes, kindEnd + 1, end, PAYLOAD_TYPE)) {
		return undefined;
	}
	const item = kindEnd + 1 + PAYLOAD_TYPE.length;
	const itemEnd = plainStringEnd(bytes, item, end);
	if (itemEnd === -1) {
		return undefined;
	}
	return equalsAt(bytes, item, itemEnd, MESSAGE) ||
		(options.includeToolCalls &&
			(equalsAt(bytes, item, itemEnd, FUNCTION_CALL) ||
				equalsAt(bytes, item, itemEnd, CUSTOM_TOOL_CALL)));
}

/**
 * Index of the first byte of the top-level `type` key's string value in
 * `bytes[start..end)`, or -1 when the bytes do not start an object or the
 * key is not among them. Strings are skipped whole and nested objects and
 * arrays are counted, so only a key of the line's own object matches.
 */
function topLevelTypeValue(
	bytes: Uint8Array,
	start: number,
	end: number,
): number {
	if (bytes[start] !== OPEN_BRACE) {
		return -1;
	}
	let depth = 0;
	for (let i = start; i < end; i += 1) {
		const byte = bytes[i];
		if (byte === QUOTE) {
			// `"type":"` cannot occur inside a string, where `"` is escaped.
			if (depth === 1 && startsWithAt(bytes, i + 1, end, TYPE_KEY)) {
				return i + 1 + TYPE_KEY.length;
			}
			i = closingQuote(bytes, i + 1, end);
			if (i === -1) {
				return -1;
			}
		} else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
			depth += 1;
		} else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
			depth -= 1;
		}
	}
	return -1;
}

/** Index of the `"` closing a string whose content starts at `from`, or -1. */
function closingQuote(bytes: Uint8Array, from: number, end: number): number {
	for (let i = from; i < end; i += 1) {
		if (bytes[i] === BACKSLASH) {
			i += 1;
		} else if (bytes[i] === QUOTE) {
			return i;
		}
	}
	return -1;
}

/**
 * Index of the `"` closing a string whose content starts at `from`, or -1
 * when the string has an escape or does not end before `end`.
 */
function plainStringEnd(bytes: Uint8Array, from: number, end: number): number {
	for (let i = from; i < end; i += 1) {
		if (bytes[i] === QUOTE) {
			return i;
		}
		if (bytes[i] === BACKSLASH) {
			return -1;
		}
	}
	return -1;
}

// Hand-written loops: a TypedArray#indexOf call per candidate position cost
// more than it saved on real logs.
function startsWithAt(
	bytes: Uint8Array,
	at: number,
	end: number,
	expected: Uint8Array,
): boolean {
	if (at + expected.length > end) {
		return false;
	}
	for (let j = 0; j < expected.length; j += 1) {
		if (bytes[at + j] !== expected[j]) {
			return false;
		}
	}
	return true;
}

/** `bytes[from..to)` is exactly `expected`. */
function equalsAt(
	bytes: Uint8Array,
	from: number,
	to: number,
	expected: Uint8Array,
): boolean {
	return to - from === expected.length &&
		startsWithAt(bytes, from, to, expected);
}

function shouldParseLine(
	line: string,
	options: ParseCodexSessionOptions,
): boolean {
	if (
		line.includes('"type":"session_meta"') ||
		line.includes('"type":"turn_context"') ||
		line.includes('"type":"message"')
	) {
		return true;
	}

	if (!options.includeToolCalls) {
		return false;
	}

	return line.includes('"type":"function_call"') ||
		line.includes('"type":"custom_tool_call"') ||
		line.includes('"name":"apply_patch"');
}

function applyEvent(
	accumulator: ParseAccumulator,
	event: LogEvent,
	options: ParseCodexSessionOptions,
): void {
	if (event.type === 'session_meta') {
		applySessionMeta(accumulator, event);
		return;
	}

	if (event.type === 'turn_context') {
		applyTurnContext(accumulator, event);
		return;
	}

	if (event.type !== 'response_item') {
		return;
	}

	const item = responseItem(event);
	if (item?.type === 'message') {
		applyMessage(accumulator, item as MessageItem);
		return;
	}

	if (
		options.includeToolCalls &&
		(item?.type === 'function_call' || item?.type === 'custom_tool_call')
	) {
		applyToolCall(accumulator, item as ToolCallItem);
	}
}

/**
 * Applies the file's first `session_meta` only. A forked or subagent session
 * starts with its own meta and then repeats its parent's; letting a later
 * meta win would file the child under the parent's id.
 */
function applySessionMeta(
	accumulator: ParseAccumulator,
	event: LogEvent,
): void {
	const payload = event.payload;
	if (!isRecord(payload) || accumulator.sawSessionMeta) {
		return;
	}

	accumulator.sawSessionMeta = true;
	accumulator.subagent = payload.thread_source === 'subagent' ||
		(isRecord(payload.source) && payload.source.subagent != null);
	accumulator.id = stringValue(payload.id);
	accumulator.startedAt = stringValue(payload.timestamp) ??
		stringValue(event.timestamp);
	accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
	accumulator.cliVersion = stringValue(payload.cli_version);
	accumulator.source = stringValue(payload.source);
	accumulator.modelProvider = stringValue(payload.model_provider);
}

function applyTurnContext(
	accumulator: ParseAccumulator,
	event: LogEvent,
): void {
	const payload = event.payload;
	if (payload == null) {
		return;
	}

	accumulator.cwd = stringValue(payload.cwd) ?? accumulator.cwd;
	accumulator.workspaceRoots = stringArrayValue(payload.workspace_roots) ??
		accumulator.workspaceRoots;
	accumulator.model = stringValue(payload.model) ?? accumulator.model;
	const summary = cleanSummary(stringValue(payload.summary));
	if (accumulator.summary == null && summary != null) {
		accumulator.summary = summary;
	}
}

function applyMessage(
	accumulator: ParseAccumulator,
	item: MessageItem,
): void {
	const role = item.role;
	const text = extractMessageText(item.content);
	if (text == null) {
		return;
	}

	if (role === 'user') {
		if (isInjectedUserContext(text)) {
			return;
		}
		finishCurrentRound(accumulator);
		accumulator.currentRound = emptyRound();
		accumulator.currentRound.userMessages.push(text);
		accumulator.firstPrompt ??= text;
		accumulator.messageCount += 1;
		accumulator.userMessageCount += 1;
		return;
	}

	if (role === 'assistant' && isFinalCodexMessage(item)) {
		const round = ensureRound(accumulator);
		round.codexMessages.push(text);
		accumulator.messageCount += 1;
		accumulator.codexMessageCount += 1;
	}
}

function applyToolCall(
	accumulator: ParseAccumulator,
	item: ToolCallItem,
): void {
	const summary = summarizeToolCall(item);
	if (summary == null) {
		return;
	}

	ensureRound(accumulator).toolCalls.push(summary);
	accumulator.toolCallCount += 1;
}

function responseItem(event: LogEvent): Record<string, unknown> | null {
	const payload = event.payload;
	if (payload == null) {
		return null;
	}

	const nested = payload.item;
	return isRecord(nested) ? nested : payload;
}

function isFinalCodexMessage(item: MessageItem): boolean {
	return item.phase == null || item.phase === '' ||
		item.phase === 'final_answer';
}

function ensureRound(accumulator: ParseAccumulator): ConversationRound {
	if (accumulator.currentRound == null) {
		accumulator.currentRound = emptyRound();
	}
	return accumulator.currentRound;
}

function finishCurrentRound(accumulator: ParseAccumulator): void {
	const round = accumulator.currentRound;
	if (round == null) {
		return;
	}

	if (
		round.userMessages.length > 0 ||
		round.codexMessages.length > 0 ||
		round.toolCalls.length > 0
	) {
		accumulator.rounds.push(round);
	}
	accumulator.currentRound = null;
}

function emptyRound(): ConversationRound {
	return {
		userMessages: [],
		codexMessages: [],
		toolCalls: [],
	};
}

function extractMessageText(content: unknown): string | null {
	if (typeof content === 'string') {
		return cleanMessageText(content);
	}
	if (!Array.isArray(content)) {
		return null;
	}

	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) {
			continue;
		}

		const text = stringValue(item.text) ??
			stringValue(item.input_text) ??
			stringValue(item.output_text);
		if (text != null) {
			parts.push(text);
		}
	}

	return cleanMessageText(parts.join('\n\n'));
}

function cleanMessageText(text: string): string | null {
	const cleaned = text.replace(/\r\n/g, '\n').trim();
	return cleaned === '' ? null : cleaned;
}

function summarizeToolCall(item: ToolCallItem): string | null {
	const name = item.name?.trim();
	if (!name) {
		return null;
	}

	const input = item.arguments ?? item.input;
	if (name === 'exec_command') {
		const args = isRecord(input)
			? input
			: typeof input === 'string'
			? parseJsonObject(input)
			: undefined;
		const cmd = stringValue(args?.cmd);
		return cmd == null ? name : `${name}: ${oneLine(cmd)}`;
	}

	if (name === 'apply_patch') {
		const patch = typeof input === 'string' ? input : '';
		const files = [
			...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
		]
			.map((match) => match[1].trim())
			.slice(0, 3);
		return files.length === 0 ? name : `${name}: ${files.join(', ')}`;
	}

	return name;
}

function renderSessionContent(
	title: string,
	rounds: readonly ConversationRound[],
	meta: SessionContentMeta,
): { content: string; truncated: boolean } {
	const lines = [`# ${title}`];
	const sessionLines = renderSessionMeta(meta);
	if (sessionLines.length > 0) {
		lines.push('', '## Session', '', ...sessionLines);
	}

	for (const [index, round] of rounds.entries()) {
		if (index > 0 || lines.length > 1) {
			lines.push('', '---', '');
		}

		if (round.userMessages.length > 0) {
			lines.push('## User', '', round.userMessages.join('\n\n'));
		}

		if (round.codexMessages.length > 0) {
			if (round.userMessages.length > 0) {
				lines.push('');
			}
			lines.push('## Codex', '', round.codexMessages.join('\n\n'));
		}

		if (round.toolCalls.length > 0) {
			if (
				round.userMessages.length > 0 ||
				round.codexMessages.length > 0
			) {
				lines.push('');
			}
			lines.push(
				'## Tool Calls',
				'',
				...round.toolCalls.map((toolCall) => `- ${toolCall}`),
			);
		}
	}

	// UTF-8 bytes, the host's unit; the cut may land inside a message. The
	// truncation is recorded in metadata, not in the body.
	const clamped = clampUtf8(lines.join('\n'), MAX_CONTENT_BYTES, '');
	return {
		content: clamped.truncated ? clamped.content.trimEnd() : clamped.content,
		truncated: clamped.truncated,
	};
}

function renderSessionMeta(meta: SessionContentMeta): string[] {
	const lines: string[] = [];

	if (meta.workspaceRoots.length === 1) {
		lines.push(`- Workspace: \`${meta.workspaceRoots[0]}\``);
	} else if (meta.workspaceRoots.length > 1) {
		lines.push(
			'- Workspace:',
			...meta.workspaceRoots.map((root) => `  - \`${root}\``),
		);
	} else if (meta.cwd != null) {
		lines.push(`- Directory: \`${meta.cwd}\``);
	}

	if (meta.model != null) {
		lines.push(`- Model: \`${meta.model}\``);
	}

	return lines;
}

function titleForSession(
	accumulator: ParseAccumulator,
	path: string,
): string {
	return accumulator.summary ??
		firstPromptTitle(accumulator.firstPrompt) ??
		basename(path, '.jsonl');
}

function firstPromptTitle(prompt: string | undefined): string | null {
	if (prompt == null) {
		return null;
	}

	const firstParagraph = prompt.split(/\n\s*\n/)[0]?.trim();
	if (!firstParagraph) {
		return null;
	}

	return oneLine(firstParagraph).slice(0, 120);
}

function cleanSummary(summary: string | undefined): string | null {
	const cleaned = summary?.trim();
	if (!cleaned) {
		return null;
	}

	const normalized = cleaned.toLowerCase();
	if (
		normalized === 'null' || normalized === 'none' || normalized === 'n/a' ||
		normalized === 'auto'
	) {
		return null;
	}
	return oneLine(cleaned);
}

function isInjectedUserContext(text: string): boolean {
	return text.startsWith('# AGENTS.md instructions for ') ||
		text.startsWith('<environment_context>') ||
		text.startsWith('<user_instructions>') ||
		text.startsWith('<INSTRUCTIONS>');
}

/** `rollout-<time>-<session id>[_<segment id>].jsonl` */
const ROLLOUT_FILE_NAME =
	/^rollout-.+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;

function sessionIdFromPath(path: string): string {
	return ROLLOUT_FILE_NAME.exec(basename(path))?.[1] ??
		basename(path, '.jsonl');
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const strings = value.filter((item): item is string =>
		typeof item === 'string' && item.trim() !== ''
	);
	return strings.length > 0 ? [...new Set(strings)] : undefined;
}
