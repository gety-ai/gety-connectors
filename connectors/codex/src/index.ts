import { Connector, type PollResult } from '@gety-ai/connector-sdk';
import { sameFingerprint } from '@gety-connectors/utils/fs';
import { staleIds } from '@gety-connectors/utils/reconcile';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildCodexSessionDelete,
	buildCodexSessionUpdate,
	type CodexSession,
	type CodexSessionGroup,
	type CodexSessionRoot,
	groupCodexSessionFiles,
	listCodexSessionFiles,
	parseCodexSessionFiles,
	sessionGroupKey,
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

/** A state of another version re-renders every session (see initialState). */
const STATE_SCHEMA_VERSION = 4;

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
		const previousGroupSizes = new Map<string, number>();
		for (const stateKey of Object.keys(previousFiles)) {
			const key = sessionGroupKey(stateKey);
			previousGroupSizes.set(key, (previousGroupSizes.get(key) ?? 0) + 1);
		}
		const currentFiles: Record<string, CodexFileState> = {};
		const currentIndexed = new Set<string>();
		let reparsed = false;
		for (const group of groupCodexSessionFiles(listing.files)) {
			this.signal.throwIfAborted();
			if (isUnchangedGroup(group, previousFiles, previousGroupSizes)) {
				for (const file of group.files) {
					const previousFile = previousFiles[file.stateKey];
					currentFiles[file.stateKey] = previousFile;
					if (previousFile.indexed && previousFile.session_id != null) {
						currentIndexed.add(previousFile.session_id);
					}
				}
				continue;
			}
			if (
				!listing.complete &&
				group.files.filter((file) => previousFiles[file.stateKey] != null)
						.length < (previousGroupSizes.get(group.key) ?? 0)
			) {
				// The listing missed a file of this session, which may still exist:
				// rebuilding from the rest could drop its turns. Keep the session as
				// the previous poll left it (see below) and let a complete poll decide.
				continue;
			}

			let session: CodexSession | null;
			try {
				session = await parseCodexSessionFiles(group.files, {
					includeToolCalls: options.includeToolCalls,
					skipSubagents: !options.includeSubagents,
				}, this.signal);
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) {
					// A file was removed since the walk: keep the session as the
					// previous poll left it (see below) and let the next poll decide.
					complete = false;
					continue;
				}
				throw error;
			}
			reparsed = true;
			for (const file of group.files) {
				const fingerprint = { mtime_ms: file.mtimeMs, size: file.size };
				currentFiles[file.stateKey] = session != null
					? { session_id: session.id, ...fingerprint, indexed: true }
					: { ...fingerprint, indexed: false };
			}
			if (session != null) {
				currentIndexed.add(session.id);
				yield { updates: [buildCodexSessionUpdate(session)] };
			}
		}

		if (!complete) {
			// Files this poll did not reach or did not rebuild keep their entries.
			for (const [stateKey, previousFile] of Object.entries(previousFiles)) {
				currentFiles[stateKey] ??= previousFile;
			}
		}
		const known = state.indexed_sessions ?? [];
		const { deleted, indexed } = reconcileSessions(
			known,
			currentIndexed,
			complete,
		);
		const indexedSet = new Set(indexed);
		if (
			// initialState returns the committed state itself when it applies.
			state === this.lastState && !reparsed && deleted.length === 0 &&
			Object.keys(currentFiles).length === Object.keys(previousFiles).length &&
			indexedSet.size === known.length &&
			known.every((id) => indexedSet.has(id))
		) {
			// The state would be the committed one again: a poll without batches
			// leaves it as it is, without sending it back to Gety to store.
			return;
		}
		yield {
			updates: deleted.map((id) => buildCodexSessionDelete({ id })),
			state: nextState(currentFiles, indexed, options),
		};
	}
}

/**
 * The session's files are exactly the ones the previous poll saw, with the
 * same fingerprints, so its document is current without reading them.
 */
function isUnchangedGroup(
	group: CodexSessionGroup,
	previousFiles: Readonly<Record<string, CodexFileState>>,
	previousGroupSizes: ReadonlyMap<string, number>,
): boolean {
	return previousGroupSizes.get(group.key) === group.files.length &&
		group.files.every((file) => {
			const previousFile = previousFiles[file.stateKey];
			return previousFile != null &&
				sameFingerprint(
					{ mtimeMs: previousFile.mtime_ms, size: previousFile.size },
					file,
				);
		});
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
