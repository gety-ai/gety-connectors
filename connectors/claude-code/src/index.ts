import {
	Connector,
	del,
	type Doc,
	type PollResult,
	upsert,
} from '@gety-ai/connector-sdk';
import {
	type FileEntry,
	sameFingerprint,
	walkFiles,
} from '@gety-connectors/utils/fs';
import { sha256Hex } from '@gety-connectors/utils/hash';
import { isRecord } from '@gety-connectors/utils/json';
import { readJsonl } from '@gety-connectors/utils/jsonl';
import { staleIds } from '@gety-connectors/utils/reconcile';
import { MAX_CONTENT_BYTES } from '@gety-connectors/utils/text';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManifestConfig } from './gen/manifest.d.ts';

// The SDK does not export its JSON value type; derive it from doc metadata.
type JsonValue = Exclude<Doc['metadata'], undefined>;

/**
 * Claude Code stores chat sessions as JSONL files under `~/.claude/projects`
 * on every platform. Each `.jsonl` file becomes one Gety document.
 */

const DOC_TYPE = 'claude_code:session';
const ID_PREFIX = 'claude-code:';
const STATE_SCHEMA_VERSION = 1;
const encoder = new TextEncoder();

type FileFingerprint = {
	mtime: number;
	size: number;
	/** Empty when the file has no indexable conversation. */
	docId: string;
};

type ClaudeCodeState = {
	schema_version: typeof STATE_SCHEMA_VERSION;
	files: Record<string, FileFingerprint>;
};

type SessionMessage = {
	role: 'user' | 'assistant';
	text: string;
	timestamp: string | null;
};

type Session = {
	messages: SessionMessage[];
	aiTitle: string | null;
	sessionId: string | null;
	project: string | null;
	model: string | null;
	gitBranch: string | null;
	firstMessageTs: string | null;
	lastMessageTs: string | null;
	messageCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	hasUserText: boolean;
	hasAssistantText: boolean;
	/** UTF-16 length of the texts in `messages`. */
	storedChars: number;
	/**
	 * Texts beyond the content budget were dropped instead of stored. Every
	 * UTF-16 unit takes at least one UTF-8 byte, so they could not have been
	 * rendered anyway.
	 */
	textOverflow: boolean;
};

type NormalizedState = {
	files: Record<string, FileFingerprint>;
	forceReindex: boolean;
};

export type PollOptions = {
	/** The Claude Code projects directory. */
	root: string;
	/** Home directory, abbreviated to `~` in rendered project paths. */
	homeDir: string;
	includeSubagents: boolean;
};

/**
 * Extract conversational text from a Claude Code message `content` field.
 *
 * Content may be a plain string or an array of parts. Only `text` parts are
 * returned; `tool_use`, `tool_result`, `thinking`, and other part types are
 * skipped entirely. Returns null when the message has no text.
 */
export function extractText(content: unknown): string | null {
	if (content == null) return null;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	const texts: string[] = [];
	for (const part of content) {
		if (
			isRecord(part) &&
			part.type === 'text' &&
			typeof part.text === 'string'
		) {
			texts.push(part.text);
		}
	}
	return texts.length > 0 ? texts.join('\n\n') : null;
}

/**
 * Map raw Claude model identifiers to readable names when straightforward,
 * e.g. `claude-opus-4-8` -> `Claude Opus 4.8`, `claude-3-5-sonnet` ->
 * `Claude 3.5 Sonnet`. Unknown identifiers are returned unchanged.
 */
export function readableModel(model: string): string {
	if (!model) return model;
	const stripped = model.replace(/-\d{8}$/, '');
	const words: Record<string, string> = {
		opus: 'Opus',
		sonnet: 'Sonnet',
		haiku: 'Haiku',
		fable: 'Fable',
		instant: 'Instant',
	};
	const parts = stripped.split('-').filter(Boolean);
	const out: string[] = [];
	let start = 0;
	if (parts[0] === 'claude') {
		out.push('Claude');
		start = 1;
	}
	for (let i = start; i < parts.length; i += 1) {
		const part = parts[i];
		if (words[part]) {
			out.push(words[part]);
		} else if (
			/^\d+$/.test(part) &&
			parts[i + 1] &&
			/^\d+$/.test(parts[i + 1])
		) {
			out.push(`${part}.${parts[i + 1]}`);
			i += 1;
		} else {
			out.push(part.charAt(0).toUpperCase() + part.slice(1));
		}
	}
	return out.length > 0 ? out.join(' ') : model;
}

function emptySession(): Session {
	return {
		messages: [],
		aiTitle: null,
		sessionId: null,
		project: null,
		model: null,
		gitBranch: null,
		firstMessageTs: null,
		lastMessageTs: null,
		messageCount: 0,
		userMessageCount: 0,
		assistantMessageCount: 0,
		hasUserText: false,
		hasAssistantText: false,
		storedChars: 0,
		textOverflow: false,
	};
}

function addRecord(session: Session, raw: Record<string, unknown>): void {
	const type = raw.type;

	if (type === 'ai-title') {
		const candidate = raw.aiTitle ?? raw['ai-title'];
		if (
			typeof candidate === 'string' && candidate.trim() && !session.aiTitle
		) {
			session.aiTitle = candidate.trim();
		}
	}

	if (typeof raw.sessionId === 'string' && !session.sessionId) {
		session.sessionId = raw.sessionId;
	}
	if (typeof raw.cwd === 'string' && !session.project) {
		session.project = raw.cwd;
	}
	if (typeof raw.gitBranch === 'string' && raw.gitBranch) {
		session.gitBranch = raw.gitBranch;
	}

	if (type !== 'user' && type !== 'assistant') return;

	const message = raw.message;
	if (!isRecord(message)) return;
	const role = message.role;
	if (role !== 'user' && role !== 'assistant') return;

	if (typeof message.model === 'string' && message.model) {
		session.model = message.model;
	}

	const ts = parseTimestamp(raw.timestamp);
	if (ts) {
		if (!session.firstMessageTs) session.firstMessageTs = ts;
		session.lastMessageTs = ts;
	}

	session.messageCount += 1;
	if (role === 'user') {
		session.userMessageCount += 1;
	} else {
		session.assistantMessageCount += 1;
	}

	const text = normalizeMessageText(role, extractText(message.content));
	if (!text) return;
	if (role === 'user') {
		session.hasUserText = true;
	} else {
		session.hasAssistantText = true;
	}
	if (session.storedChars > MAX_CONTENT_BYTES) {
		session.textOverflow = true;
		return;
	}
	session.messages.push({ role, text, timestamp: ts });
	session.storedChars += text.length;
}

function normalizeMessageText(
	role: 'user' | 'assistant',
	text: string | null,
): string | null {
	const trimmedText = text?.trim();
	if (!trimmedText) return null;

	if (role !== 'user') return trimmedText;

	const commandMessage = formatCommandMessage(trimmedText);
	if (commandMessage) return commandMessage;

	return isInjectedUserContext(trimmedText) ? null : trimmedText;
}

function formatCommandMessage(text: string): string | null {
	const commandName = extractXmlTag(text, 'command-name');
	const commandArgs = extractXmlTag(text, 'command-args');

	if (!commandName && !commandArgs) return null;
	if (!commandArgs && isLocalNoiseCommand(commandName)) return null;

	const parts: string[] = [];
	if (commandName) {
		parts.push(`Command: \`${commandName.replaceAll('`', '\\`')}\``);
	}
	if (commandArgs) {
		parts.push(commandArgs);
	}
	return parts.join('\n\n') || null;
}

function extractXmlTag(text: string, tagName: string): string | null {
	const pattern = new RegExp(
		`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`,
		'u',
	);
	const value = text.match(pattern)?.[1]?.trim();
	return value ? value : null;
}

function isLocalNoiseCommand(commandName: string | null): boolean {
	return commandName === '/model' || commandName === '/effort' ||
		commandName === '/usage';
}

function isInjectedUserContext(
	text: string,
): boolean {
	const firstLine = text.trimStart();
	return [
		'# AGENTS.md instructions for',
		'Base directory for this skill:',
		'<environment_context>',
		'<skill_content',
		'<task-notification>',
		'<user_instructions>',
		'<INSTRUCTIONS>',
		'<local-command',
		'<command-',
	].some((prefix) => firstLine.startsWith(prefix));
}

function chooseTitle(session: Session, fileName: string): string {
	if (session.aiTitle) return session.aiTitle;
	for (const message of session.messages) {
		if (message.role !== 'user') continue;
		const cleaned = firstMeaningfulLine(message.text);
		if (cleaned) return truncateTitle(cleaned);
	}
	return session.sessionId ?? fileName;
}

function firstMeaningfulLine(text: string): string {
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (
			trimmed.startsWith('<local-command') || trimmed.startsWith('<command-') ||
			trimmed.startsWith('Command: `')
		) {
			continue;
		}
		return trimmed;
	}
	return '';
}

function truncateTitle(text: string): string {
	const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ??
		text;
	return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
}

function renderMarkdown(
	session: Session,
	title: string,
	homeDir: string,
): { content: string; truncated: boolean } {
	const infoLines: string[] = [];
	if (session.project) {
		infoLines.push(`- Project: \`${tildeHome(session.project, homeDir)}\``);
	}
	if (session.model) {
		infoLines.push(`- Model: \`${readableModel(session.model)}\``);
	}
	if (session.gitBranch) {
		infoLines.push(`- Git branch: \`${session.gitBranch}\``);
	}

	let body = `# ${markdownHeadingText(title)}`;
	if (infoLines.length > 0) {
		body += `\n\n## Session\n\n${infoLines.join('\n')}`;
	}

	// The markdown body follows the Codex connector shape: H1 title, session
	// metadata, then round separators with user/assistant text blocks. Parse and
	// truncation facts are recorded in metadata, never appended to the body.
	// Whole rounds are kept while they fit in the UTF-8 budget.
	let bytes = encoder.encode(body).length;
	let truncated = session.textOverflow;
	for (const round of renderConversationRounds(session.messages)) {
		const block = `\n\n---\n\n${round}`;
		const blockBytes = encoder.encode(block).length;
		if (bytes + blockBytes > MAX_CONTENT_BYTES) {
			truncated = true;
			break;
		}
		body += block;
		bytes += blockBytes;
	}

	return { content: body, truncated };
}

function renderConversationRounds(messages: SessionMessage[]): string[] {
	const rounds: string[][] = [];
	let currentRound: string[] = [];

	for (const message of messages) {
		if (message.role === 'user' && currentRound.length > 0) {
			rounds.push(currentRound);
			currentRound = [];
		}

		const heading = message.role === 'user' ? '## User' : '## Claude Code';
		currentRound.push(`${heading}\n\n${message.text}`);
	}

	if (currentRound.length > 0) {
		rounds.push(currentRound);
	}

	return rounds.map((round) => round.join('\n\n'));
}

function markdownHeadingText(text: string): string {
	return text.replace(/\s+/g, ' ').trim() || 'Untitled Claude Code session';
}

function tildeHome(path: string, homeDir: string): string {
	const home = homeDir.replace(/[\\/]+$/, '');
	if (
		home && (path === home || path.startsWith(`${home}/`) ||
			path.startsWith(`${home}\\`))
	) {
		return '~' + path.slice(home.length);
	}
	return path;
}

function parseTimestamp(value: unknown): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

/**
 * Build a Gety document from already-parsed JSONL records, or null when the
 * session has no user and Claude Code text exchange.
 */
export function buildDocFromRecords(
	records: unknown[],
	options: DocOptions,
): Promise<Doc | null> {
	const session = emptySession();
	for (const record of records) {
		if (isRecord(record)) addRecord(session, record);
	}
	return buildDoc(session, options);
}

type DocOptions = {
	relPath: string;
	fileName: string;
	fileSize: number;
	fileMtime: number;
	parseErrors?: number;
	sourcePath?: string;
	homeDir?: string;
};

async function buildDoc(
	session: Session,
	options: DocOptions,
): Promise<Doc | null> {
	if (!session.hasUserText || !session.hasAssistantText) {
		return null;
	}

	const parseErrors = options.parseErrors ?? 0;
	const id = `${ID_PREFIX}${await sha256Hex(options.relPath)}`;
	const title = chooseTitle(session, options.fileName);
	const { content, truncated } = renderMarkdown(
		session,
		title,
		options.homeDir ?? '',
	);
	const updatedAt = session.lastMessageTs ??
		new Date(options.fileMtime).toISOString();

	const metadata: Record<string, JsonValue> = {
		project: session.project ?? null,
		session_id: session.sessionId ?? null,
		path: options.relPath,
		source_path: options.relPath,
		model: session.model ?? null,
		git_branch: session.gitBranch ?? null,
		message_count: session.messageCount,
		user_message_count: session.userMessageCount,
		assistant_message_count: session.assistantMessageCount,
		file_size: options.fileSize,
	};
	if (session.firstMessageTs) {
		metadata.created_at = session.firstMessageTs;
	}
	if (truncated) {
		metadata.truncated = true;
	}
	if (parseErrors > 0) {
		metadata.parse_errors = parseErrors;
	}
	if (options.sourcePath) {
		metadata.url = pathToFileURL(options.sourcePath).href;
	}

	return {
		id,
		title,
		content,
		content_format: 'markdown',
		doc_type: DOC_TYPE,
		doc_updated_at: updatedAt,
		original_file_size: options.fileSize,
		metadata,
	};
}

/**
 * Stream one JSONL file and build its document (null when it has no
 * indexable exchange). File errors, including `NotFound`, propagate.
 */
async function buildDocFromFile(
	file: FileEntry,
	homeDir: string,
	signal: AbortSignal,
): Promise<Doc | null> {
	const session = emptySession();
	const records = readJsonl(file.absPath, { signal });
	for await (const record of records) {
		addRecord(session, record);
	}
	return buildDoc(session, {
		relPath: file.relPath,
		fileName: basename(file.relPath),
		fileSize: file.size,
		fileMtime: file.mtimeMs,
		parseErrors: records.parseErrors,
		sourcePath: file.absPath,
		homeDir,
	});
}

function isSubagentPath(relPath: string): boolean {
	return relPath.split('/').includes('subagents');
}

function normalizeState(lastState: unknown): NormalizedState {
	if (!isRecord(lastState)) {
		return { files: {}, forceReindex: false };
	}

	if (
		lastState.schema_version === STATE_SCHEMA_VERSION &&
		isRecord(lastState.files)
	) {
		return {
			files: sanitizeFileMap(lastState.files),
			forceReindex: false,
		};
	}

	// Legacy state was a raw Record<relativePath, FileFingerprint>. Preserve it
	// for deletion reconciliation, but force current files to be parsed/upserted
	// once so the new state shape, config snapshot, metadata URL, and empty-session
	// filtering are committed.
	return {
		files: sanitizeFileMap(lastState),
		forceReindex: true,
	};
}

function sanitizeFileMap(
	value: Record<string, unknown>,
): Record<string, FileFingerprint> {
	const files: Record<string, FileFingerprint> = {};
	for (const [relPath, raw] of Object.entries(value)) {
		if (!isRecord(raw)) continue;
		const mtime = typeof raw.mtime === 'number' ? raw.mtime : null;
		const size = typeof raw.size === 'number' ? raw.size : null;
		if (mtime == null || size == null) continue;
		files[relPath] = {
			mtime,
			size,
			docId: typeof raw.docId === 'string' ? raw.docId : '',
		};
	}
	return files;
}

/**
 * Documents to delete, and the file entries to keep. A document is deleted
 * when its file is gone from a complete scan, or was re-read and no longer
 * has an indexable conversation. After a partial scan nothing is deleted:
 * files it did not reach, and files whose document it would have deleted,
 * keep their previous entries until a complete scan decides.
 */
export function reconcileFiles(
	prior: Record<string, FileFingerprint>,
	current: Record<string, FileFingerprint>,
	complete: boolean,
): { deletedDocIds: string[]; files: Record<string, FileFingerprint> } {
	const files = { ...current };
	const deletedDocIds: string[] = [];
	for (const [relPath, fingerprint] of Object.entries(current)) {
		const priorDocId = prior[relPath]?.docId;
		if (fingerprint.docId || !priorDocId) continue;
		if (complete) {
			deletedDocIds.push(priorDocId);
		} else {
			files[relPath] = prior[relPath];
		}
	}
	const stale = staleIds(Object.keys(prior), {
		seen: new Set(Object.keys(current)),
		complete,
	});
	for (const relPath of stale) {
		if (prior[relPath].docId) deletedDocIds.push(prior[relPath].docId);
	}
	if (!complete) {
		for (const [relPath, fingerprint] of Object.entries(prior)) {
			files[relPath] ??= fingerprint;
		}
	}
	return { deletedDocIds, files };
}

/**
 * Incremental poll: scan the projects directory and emit one upsert per new
 * or changed JSONL file (one document per file). A file whose mtime and size
 * match the previous poll is not read at all. Gety commits the state only
 * when the poll succeeds, so it is yielded once, with the deletions, at the
 * end.
 *
 * - A missing projects directory, or a sandbox or permission error, fails the
 *   poll: it must never look like "every session was deleted".
 * - A file that disappears during the poll is skipped, and the poll deletes
 *   nothing (see `reconcileFiles`); the next poll does.
 * - On abort the poll stops without a state.
 */
export async function* pollClaudeCode(
	options: PollOptions,
	lastState: unknown,
	signal: AbortSignal,
): AsyncGenerator<PollResult, void, unknown> {
	const { files: prior, forceReindex } = normalizeState(lastState);
	const accept = (relPath: string) =>
		options.includeSubagents || !isSubagentPath(relPath);
	const scan = await walkFiles(options.root, {
		include: (relPath) => relPath.endsWith('.jsonl') && accept(relPath),
		descend: accept,
		signal,
	});
	if (signal.aborted) return;
	if (scan.rootMissing) {
		throw new Error(
			`Claude Code projects directory not found: ${options.root}. Run Claude Code at least once to create it.`,
		);
	}

	let complete = scan.complete;
	const current: Record<string, FileFingerprint> = {};
	for (const file of scan.files) {
		if (signal.aborted) return;
		const prev = prior[file.relPath];
		if (
			!forceReindex && prev != null &&
			sameFingerprint({ mtimeMs: prev.mtime, size: prev.size }, file)
		) {
			current[file.relPath] = prev;
			continue;
		}

		let doc: Doc | null;
		try {
			doc = await buildDocFromFile(file, options.homeDir, signal);
		} catch (error) {
			if (signal.aborted) return;
			if (error instanceof Deno.errors.NotFound) {
				complete = false;
				continue;
			}
			throw error;
		}

		current[file.relPath] = {
			mtime: file.mtimeMs,
			size: file.size,
			docId: doc?.id ?? '',
		};
		if (doc != null) {
			yield { updates: [upsert(doc)] };
		}
	}

	const { deletedDocIds, files } = reconcileFiles(prior, current, complete);
	const state: ClaudeCodeState = {
		schema_version: STATE_SCHEMA_VERSION,
		files,
	};
	yield { updates: deletedDocIds.map((id) => del(id)), state };
}

export default class ClaudeCodeConnector extends Connector<
	ManifestConfig,
	ClaudeCodeState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		yield* pollClaudeCode(
			{
				root: this.expandHome('~/.claude/projects'),
				homeDir: this.homeDir,
				includeSubagents: this.config.include_subagents === true,
			},
			this.lastState,
			this.signal,
		);
	}
}
