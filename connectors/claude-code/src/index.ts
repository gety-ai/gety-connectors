import {
	Connector,
	del,
	type Doc,
	type JsonValue,
	type PollResult,
	upsert,
} from '@gety-ai/connector-sdk';
import { basename, join, normalize, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManifestConfig } from './gen/manifest.d.ts';

/**
 * Claude Code stores chat sessions as JSONL files under a per-platform
 * projects directory. Each `.jsonl` file becomes one Gety document.
 *
 * - Linux/macOS: ~/.claude/projects
 * - Windows:     %USERPROFILE%\.claude\projects
 */

const DOC_TYPE = 'claude_code:session';
const ID_PREFIX = 'claude-code:';
const STATE_SCHEMA_VERSION = 1;
/** Soft cap for rendered markdown content (~3 MB). */
const MAX_CONTENT_BYTES = 3 * 1024 * 1024;

type FileFingerprint = {
	mtime: number;
	size: number;
	hash: string;
	docId: string;
};

type ClaudeCodeState = {
	schema_version: typeof STATE_SCHEMA_VERSION;
	include_subagents: boolean;
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
};

type EnvLike = {
	get(name: string): string | undefined;
};

type ScannedFile = {
	absPath: string;
	relPath: string;
	mtime: number;
	size: number;
};

type NormalizedState = {
	files: Record<string, FileFingerprint>;
	forceReindex: boolean;
};

type RuntimeConfig = ManifestConfig & {
	/** Hidden development/back-compat override; not exposed as a connector setting. */
	projects_dir?: string;
};

export function defaultProjectsDir(
	env: EnvLike = Deno.env,
	os: typeof Deno.build.os = Deno.build.os,
): string {
	// On Windows prefer USERPROFILE; elsewhere prefer HOME. Fall back to the
	// other variable so unusual environments still resolve a home directory.
	const home = os === 'windows'
		? env.get('USERPROFILE') ?? env.get('HOME')
		: env.get('HOME') ?? env.get('USERPROFILE');
	if (!home) {
		throw new Error(
			'Cannot determine home directory for Claude Code projects. Set HOME or USERPROFILE.',
		);
	}
	return os === 'windows'
		? win32.join(home, '.claude', 'projects')
		: join(home, '.claude', 'projects');
}

function resolveRoot(config: RuntimeConfig, env: EnvLike = Deno.env): string {
	const override = config.projects_dir ?? env.get('GETY_CONFIG_PROJECTS_DIR') ??
		env.get('PROJECTS_DIR');
	if (typeof override === 'string' && override.trim()) {
		return normalize(override);
	}
	return defaultProjectsDir();
}

function includeSubagents(config: RuntimeConfig): boolean {
	return config.include_subagents === true;
}

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

function extractSession(records: unknown[]): Session {
	const messages: SessionMessage[] = [];
	let aiTitle: string | null = null;
	let sessionId: string | null = null;
	let project: string | null = null;
	let model: string | null = null;
	let gitBranch: string | null = null;
	let firstMessageTs: string | null = null;
	let lastMessageTs: string | null = null;
	let messageCount = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;

	for (const raw of records) {
		if (!isRecord(raw)) continue;
		const type = raw.type;

		if (type === 'ai-title') {
			const candidate = raw.aiTitle ?? raw['ai-title'];
			if (typeof candidate === 'string' && candidate.trim() && !aiTitle) {
				aiTitle = candidate.trim();
			}
		}

		if (typeof raw.sessionId === 'string' && !sessionId) {
			sessionId = raw.sessionId;
		}
		if (typeof raw.cwd === 'string' && !project) {
			project = raw.cwd;
		}
		if (typeof raw.gitBranch === 'string' && raw.gitBranch) {
			gitBranch = raw.gitBranch;
		}

		if (type !== 'user' && type !== 'assistant') continue;

		const message = raw.message;
		if (!isRecord(message)) continue;
		const role = message.role;
		if (role !== 'user' && role !== 'assistant') continue;

		if (typeof message.model === 'string' && message.model) {
			model = message.model;
		}

		const ts = parseTimestamp(raw.timestamp);
		if (ts) {
			if (!firstMessageTs) firstMessageTs = ts;
			lastMessageTs = ts;
		}

		messageCount += 1;
		if (role === 'user') {
			userMessageCount += 1;
		} else {
			assistantMessageCount += 1;
		}

		const text = normalizeMessageText(role, extractText(message.content));
		if (text) {
			messages.push({ role, text, timestamp: ts });
		}
	}

	return {
		messages,
		aiTitle,
		sessionId,
		project,
		model,
		gitBranch,
		firstMessageTs,
		lastMessageTs,
		messageCount,
		userMessageCount,
		assistantMessageCount,
	};
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

function isIndexableSession(session: Session): boolean {
	return session.messages.some((message) => message.role === 'user') &&
		session.messages.some((message) => message.role === 'assistant');
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
): { content: string; truncated: boolean } {
	const infoLines: string[] = [];
	if (session.project) {
		infoLines.push(`- Project: \`${tildeHome(session.project)}\``);
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
	let truncated = false;
	const budget = MAX_CONTENT_BYTES;
	for (const round of renderConversationRounds(session.messages)) {
		const block = `\n\n---\n\n${round}`;
		if (body.length + block.length > budget) {
			truncated = true;
			break;
		}
		body += block;
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

function tildeHome(path: string): string {
	const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
	if (home && path.startsWith(home)) {
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

function parseJsonl(text: string): {
	records: unknown[];
	parseErrors: number;
} {
	const records: unknown[] = [];
	let parseErrors = 0;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			parseErrors += 1;
		}
	}
	return { records, parseErrors };
}

async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const buffer = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(buffer);
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
}

/**
 * Build a Gety document from already-parsed JSONL records. Pure aside from
 * the stable id hash, so it is straightforward to unit test.
 */
export async function buildDocFromRecords(
	records: unknown[],
	options: {
		relPath: string;
		fileName: string;
		fileSize: number;
		fileMtime: number;
		parseErrors?: number;
		sourcePath?: string;
	},
): Promise<Doc | null> {
	const session = extractSession(records);
	if (!isIndexableSession(session)) {
		return null;
	}

	const parseErrors = options.parseErrors ?? 0;
	const id = `${ID_PREFIX}${await sha256Hex(options.relPath)}`;
	const title = chooseTitle(session, options.fileName);
	const { content, truncated } = renderMarkdown(session, title);
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
 * Read a single JSONL file, hash its raw content, and build its document.
 *
 * Returns `null` only when the file could not be read (permission or transient
 * IO error). A read failure means "skip this file for this poll" — callers
 * must not treat it as a deletion. A file that reads successfully may still be
 * intentionally skipped when it has no indexable user+assistant exchange.
 */
async function buildDocFromFile(
	root: string,
	relPath: string,
	stat: { mtime: number; size: number },
): Promise<
	| { kind: 'doc'; doc: Doc; hash: string }
	| { kind: 'skip'; hash: string }
	| null
> {
	const absPath = join(root, relPath);
	let text: string;
	try {
		text = await Deno.readTextFile(absPath);
	} catch {
		return null;
	}
	const hash = await sha256Hex(text);
	const { records, parseErrors } = parseJsonl(text);
	const doc = await buildDocFromRecords(records, {
		relPath,
		fileName: basename(relPath),
		fileSize: stat.size,
		fileMtime: stat.mtime,
		parseErrors,
		sourcePath: absPath,
	});
	return doc == null ? { kind: 'skip', hash } : { kind: 'doc', doc, hash };
}

type ScanResult = {
	/** Files discovered so far. */
	files: Map<string, ScannedFile>;
	/**
	 * True only when the entire tree was traversed without any read/stat error.
	 * When false the scan is partial and deletions must be suppressed, because a
	 * missing path may simply be one we failed to read rather than one removed.
	 */
	complete: boolean;
	/** True when the root directory itself does not exist. */
	rootMissing: boolean;
};

async function scanJsonl(
	root: string,
	signal: AbortSignal,
	includeSubagentFiles: boolean,
): Promise<ScanResult> {
	const files = new Map<string, ScannedFile>();
	const result: ScanResult = { files, complete: true, rootMissing: false };

	async function walk(dir: string, base: string): Promise<void> {
		let iter: AsyncIterable<Deno.DirEntry>;
		try {
			iter = Deno.readDir(dir);
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				// A missing subdirectory (raced deletion) is a real absence, but a
				// missing root is handled specially by the caller.
				if (base === '') {
					result.rootMissing = true;
				} else {
					result.complete = false;
				}
				return;
			}
			// Permission or other IO error: the scan is partial.
			result.complete = false;
			return;
		}

		try {
			for await (const entry of iter) {
				if (signal.aborted) return;
				const childAbs = join(dir, entry.name);
				const childRel = base ? `${base}/${entry.name}` : entry.name;
				if (entry.isDirectory) {
					if (!includeSubagentFiles && isSubagentPath(childRel)) continue;
					await walk(childAbs, childRel);
				} else if (
					entry.isFile && entry.name.endsWith('.jsonl') &&
					(includeSubagentFiles || !isSubagentPath(childRel))
				) {
					let stat: Deno.FileInfo;
					try {
						stat = await Deno.stat(childAbs);
					} catch {
						// Could not stat a file we listed: treat the scan as partial so
						// we do not risk deleting its prior doc.
						result.complete = false;
						continue;
					}
					files.set(childRel, {
						absPath: childAbs,
						relPath: childRel,
						mtime: stat.mtime?.getTime() ?? 0,
						size: stat.size ?? 0,
					});
				}
			}
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) {
				if (base === '') {
					result.rootMissing = true;
				} else {
					result.complete = false;
				}
				return;
			}
			// Error while iterating entries: the scan is partial.
			result.complete = false;
		}
	}

	await walk(root, '');
	return result;
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
			hash: typeof raw.hash === 'string' ? raw.hash : '',
			docId: typeof raw.docId === 'string' ? raw.docId : '',
		};
	}
	return files;
}

function makeState(
	files: Record<string, FileFingerprint>,
	includeSubagentFiles: boolean,
): ClaudeCodeState {
	return {
		schema_version: STATE_SCHEMA_VERSION,
		include_subagents: includeSubagentFiles,
		files,
	};
}

/**
 * Incremental poll: scan the projects directory, emit one upsert per changed
 * or new JSONL file (one document per file), and one batch of deletions for
 * files that disappeared from a complete scan. State maps relative path to a
 * fingerprint ({mtime, size, hash, docId}) and is persisted with each batch.
 *
 * Safety rules for deletions:
 * - Deletions are only emitted when the scan completed with no read/stat error
 *   (aside from the root directory truly not existing). A partial scan keeps
 *   prior state for unknown paths so transient errors never wipe documents.
 * - A file present in the scan whose `readTextFile` fails is skipped: its prior
 *   doc and state are preserved untouched for this poll.
 *
 * Files are read and hashed one at a time and yielded immediately, so we never
 * build every document up front.
 */
export async function* pollClaudeCode(
	config: RuntimeConfig,
	lastState: unknown,
	signal: AbortSignal,
): AsyncGenerator<PollResult, void, unknown> {
	const includeSubagentFiles = includeSubagents(config);
	const priorState = normalizeState(lastState);
	const prior = priorState.files;
	const working: Record<string, FileFingerprint> = { ...prior };
	const root = resolveRoot(config);

	const scan = await scanJsonl(root, signal, includeSubagentFiles);
	if (signal.aborted) return;

	// Deletions are only safe when the scan is authoritative: either it fully
	// succeeded, or the root genuinely does not exist (so every prior file is
	// truly gone). Any partial scan (permission/IO error on a subtree or file)
	// suppresses deletions and preserves prior state for unknown paths.
	const scanAuthoritative = scan.complete || scan.rootMissing;

	const current = scan.files;
	if (scanAuthoritative) {
		const deletedIds: string[] = [];
		for (const [relPath, fingerprint] of Object.entries(prior)) {
			if (!current.has(relPath)) {
				if (fingerprint.docId) {
					deletedIds.push(fingerprint.docId);
				}
				delete working[relPath];
			}
		}
		if (deletedIds.length > 0) {
			yield {
				updates: deletedIds.map((id) => del(id)),
				state: makeState({ ...working }, includeSubagentFiles),
			};
		}
	}

	// Changed / new files: one batch per file (real source boundary). Fingerprint
	// includes a content hash so same-size/same-mtime rewrites are detected. Old
	// state entries missing a hash are treated as changed.
	for (const [relPath, { mtime, size }] of current) {
		if (signal.aborted) break;
		const prev = prior[relPath];
		const cheapUnchanged = !priorState.forceReindex && prev != null &&
			prev.mtime === mtime &&
			prev.size === size &&
			typeof prev.hash === 'string' && prev.hash.length > 0;

		const built = await buildDocFromFile(root, relPath, { mtime, size });
		if (built == null) {
			// Read failed for a file that was present in the scan. Do not delete or
			// replace its prior doc/state; skip it for this poll.
			continue;
		}

		if (built.kind === 'skip') {
			working[relPath] = {
				mtime,
				size,
				hash: built.hash,
				docId: '',
			};
			if (prev?.docId) {
				yield {
					updates: [del(prev.docId)],
					state: makeState({ ...working }, includeSubagentFiles),
				};
			}
			continue;
		}

		if (cheapUnchanged && prev.hash === built.hash) {
			// Content is genuinely unchanged; keep prior fingerprint as-is.
			continue;
		}

		working[relPath] = {
			mtime,
			size,
			hash: built.hash,
			docId: built.doc.id,
		};
		yield {
			updates: [upsert(built.doc)],
			state: makeState({ ...working }, includeSubagentFiles),
		};
	}
}

export default class ClaudeCodeConnector extends Connector<
	ManifestConfig,
	ClaudeCodeState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		yield* pollClaudeCode(this.config, this.lastState ?? null, this.signal);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
