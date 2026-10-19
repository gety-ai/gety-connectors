import { Connector, type PollResult } from '@gety-ai/connector-sdk';
import { sameFingerprint } from '@gety-connectors/utils/fs';
import { staleIds } from '@gety-connectors/utils/reconcile';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildCodexSessionDelete,
	buildCodexSessionUpdate,
	type CodexSession,
	type CodexSessionRoot,
	isIndexableCodexSession,
	listCodexSessionFiles,
	parseCodexSessionFile,
} from './codex_log.ts';

export interface CodexFileState {
	session_id?: string;
	mtime_ms: number;
	size: number;
	indexed: boolean;
}

export interface CodexState {
	schema_version?: number;
	include_tool_calls?: boolean;
	include_archived_sessions?: boolean;
	include_subagents?: boolean;
	files?: Record<string, CodexFileState>;
	/** Session ids with a document in the index. */
	indexed_sessions?: string[];
}

/** The config values that decide which sessions are indexed and how. */
export interface CodexOptions {
	includeToolCalls: boolean;
	includeArchivedSessions: boolean;
	includeSubagents: boolean;
}

const STATE_SCHEMA_VERSION = 3;

export default class CodexConnector extends Connector<
	ManifestConfig,
	CodexState
> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const options: CodexOptions = {
			includeToolCalls: this.config.include_tool_calls ?? false,
			includeArchivedSessions: this.config.include_archived_sessions ?? true,
			includeSubagents: this.config.include_subagents ?? false,
		};
		const roots: CodexSessionRoot[] = [
			{
				path: this.expandHome('~/.codex/sessions'),
				stateKey: 'sessions',
				required: true,
			},
		];
		if (options.includeArchivedSessions) {
			// Codex creates it on the first archive; until then it is empty.
			roots.push({
				path: this.expandHome('~/.codex/archived_sessions'),
				stateKey: 'archived_sessions',
				required: false,
			});
		}

		const state = initialState(this.lastState, options);
		const previousFiles = state.files ?? {};
		const listing = await listCodexSessionFiles(roots, this.signal);
		this.signal.throwIfAborted();

		let complete = listing.complete;
		const currentFiles: Record<string, CodexFileState> = {};
		const currentIndexed = new Set<string>();
		for (const file of listing.files) {
			this.signal.throwIfAborted();
			const previousFile = previousFiles[file.stateKey];
			if (
				previousFile != null &&
				sameFingerprint(
					{ mtimeMs: previousFile.mtime_ms, size: previousFile.size },
					file,
				)
			) {
				currentFiles[file.stateKey] = previousFile;
				if (previousFile.indexed && previousFile.session_id != null) {
					currentIndexed.add(previousFile.session_id);
				}
				continue;
			}

			let session: CodexSession;
			try {
				session = await parseCodexSessionFile(file, {
					includeToolCalls: options.includeToolCalls,
					skipSubagents: !options.includeSubagents,
				}, this.signal);
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) {
					// Removed since the walk: the next poll deletes its session.
					complete = false;
					continue;
				}
				throw error;
			}
			if (isIndexableCodexSession(session, options.includeSubagents)) {
				currentFiles[file.stateKey] = {
					session_id: session.id,
					mtime_ms: file.mtimeMs,
					size: file.size,
					indexed: true,
				};
				currentIndexed.add(session.id);
				yield { updates: [buildCodexSessionUpdate(session)] };
				continue;
			}

			currentFiles[file.stateKey] = {
				mtime_ms: file.mtimeMs,
				size: file.size,
				indexed: false,
			};
		}

		const { deleted, indexed } = reconcileSessions(
			state.indexed_sessions ?? [],
			currentIndexed,
			complete,
		);
		yield {
			updates: deleted.map((id) => buildCodexSessionDelete({ id })),
			state: nextState(currentFiles, indexed, options),
		};
	}
}

/**
 * Sessions to delete and the sessions still indexed afterwards. Only a
 * complete listing deletes; after a partial one, sessions it did not reach
 * stay indexed (and known) until a complete poll decides.
 */
export function reconcileSessions(
	known: readonly string[],
	current: ReadonlySet<string>,
	complete: boolean,
): { deleted: string[]; indexed: string[] } {
	const deleted = staleIds(known, { seen: current, complete });
	const indexed = complete ? [...current] : [...current, ...known];
	return { deleted, indexed };
}

/**
 * `state` when it was written with the current schema and options. Otherwise
 * file fingerprints are dropped so every file is parsed again, and the
 * indexed sessions are kept so the ones no longer produced get deleted.
 */
export function initialState(
	state: CodexState | null | undefined,
	options: CodexOptions,
): CodexState {
	if (
		state?.schema_version !== STATE_SCHEMA_VERSION ||
		state.include_tool_calls !== options.includeToolCalls ||
		state.include_archived_sessions !== options.includeArchivedSessions ||
		state.include_subagents !== options.includeSubagents
	) {
		// Older states listed indexed sessions only through their files.
		const indexed = state?.indexed_sessions ??
			Object.values(state?.files ?? {}).flatMap((file) =>
				file.indexed && file.session_id != null ? [file.session_id] : []
			);
		return nextState({}, indexed, options);
	}
	return state;
}

export function nextState(
	files: Record<string, CodexFileState>,
	indexedSessions: Iterable<string>,
	options: CodexOptions,
): CodexState {
	return {
		schema_version: STATE_SCHEMA_VERSION,
		include_tool_calls: options.includeToolCalls,
		include_archived_sessions: options.includeArchivedSessions,
		include_subagents: options.includeSubagents,
		files: Object.fromEntries(
			Object.entries(files).sort(([left], [right]) =>
				left.localeCompare(right)
			),
		),
		indexed_sessions: [...new Set(indexedSessions)].sort(),
	};
}
