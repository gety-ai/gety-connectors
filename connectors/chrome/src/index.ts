import {
	Connector,
	del,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { staleIds } from '@gety-connectors/utils/reconcile';
import { isRecord } from '@gety-connectors/utils/json';
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The SDK does not export its JSON value type; derive it from doc metadata.
type JsonValue = Exclude<WireDoc['metadata'], undefined>;

// Chrome/WebKit timestamps count microseconds since 1601-01-01 UTC.
// Subtract the offset to 1970-01-01 to get a Unix timestamp.
const WEBKIT_UNIX_OFFSET_MICROS = 11644473600000000n;

const DOC_TYPE_BOOKMARK = 'chrome:bookmark';
const DOC_TYPE_HISTORY = 'chrome:history';
const HISTORY_BATCH_SIZE = 500;

type State = {
	/** Highest history `last_visit_time` (WebKit micros) seen so far, decimal string. */
	history_cursor?: string;
	/** All history doc ids currently in scope; used to diff deletes. */
	history_ids?: string[];
	/** All bookmark doc ids currently present; used to diff deletes. */
	bookmark_ids?: string[];
};

// --------------------------------------------------------------------------
// Pure helpers (covered by unit tests; no filesystem access).
// --------------------------------------------------------------------------

export function webkitMicrosToRfc3339(micros: bigint): string | null {
	if (micros <= 0n) return null;
	const unixMicros = micros - WEBKIT_UNIX_OFFSET_MICROS;
	const ms = Number(unixMicros / 1000n);
	if (!Number.isFinite(ms)) return null;
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

export function parseWebkitTimestamp(
	value: string | number | bigint | null | undefined,
): bigint | null {
	if (value == null || value === '') return null;
	try {
		const micros = typeof value === 'bigint'
			? value
			: BigInt(String(value).trim());
		return micros > 0n ? micros : null;
	} catch {
		return null;
	}
}

export function isWebUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * The Chrome "Default" profile directory for a `Deno.build.os` value, as a
 * `~/` path. These are exactly the `permissions.read` paths in manifest.json;
 * the connector reads nothing outside them.
 */
export function defaultChromeProfilePath(os: string): string {
	switch (os) {
		case 'darwin':
			return '~/Library/Application Support/Google/Chrome/Default';
		case 'windows':
			return '~/AppData/Local/Google/Chrome/User Data/Default';
		default: // linux and other unix-likes
			return '~/.config/google-chrome/Default';
	}
}

/** True when `error` is a filesystem "not found" error. */
function isNotFound(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'ENOENT' ||
		error instanceof Deno.errors.NotFound;
}

/** Maps a `history_range` dropdown value to a max age in days (null = no limit). */
export function historyRangeToMaxAgeDays(range: string): number | null {
	switch (range) {
		case '7d':
			return 7;
		case '30d':
			return 30;
		case '90d':
			return 90;
		case '365d':
			return 365;
		case 'all':
			return null;
		default:
			return 90;
	}
}

export function historyCutoffWebkitMicros(
	maxAgeDays: number | null,
	nowMs: number,
): bigint | null {
	if (maxAgeDays == null) return null;
	const cutoffUnixMs = nowMs - maxAgeDays * 86_400_000;
	const micros = BigInt(Math.floor(cutoffUnixMs)) * 1000n +
		WEBKIT_UNIX_OFFSET_MICROS;
	return micros > 0n ? micros : 0n;
}

export function sha1Hex(value: string): string {
	return createHash('sha1').update(value).digest('hex');
}

export function bookmarkDocId(guid: string): string {
	return `chrome:bookmark:${guid}`;
}

export function historyDocId(url: string): string {
	return `chrome:history:${sha1Hex(url)}`;
}

export interface BookmarkEntry {
	guid: string;
	name: string;
	url: string;
	folder: string;
	dateAdded: bigint | null;
	dateModified: bigint | null;
}

const ROOT_LABELS: Record<string, string> = {
	bookmark_bar: 'Bookmarks bar',
	other: 'Other bookmarks',
	synced: 'Mobile bookmarks',
};

/**
 * Every bookmark under the file's `roots`. Fails closed: a shape it does not
 * recognize throws instead of being skipped, because a silently dropped
 * subtree would read as deleted bookmarks.
 */
export function flattenBookmarks(bookmarksJson: unknown): BookmarkEntry[] {
	const out: BookmarkEntry[] = [];
	const roots = (bookmarksJson as { roots?: unknown } | null)?.roots;
	if (!isRecord(roots)) {
		throw new Error('Unrecognized Chrome Bookmarks format: no roots object.');
	}
	for (const [rootKey, rootNode] of Object.entries(roots)) {
		const label = ROOT_LABELS[rootKey] ??
			(isRecord(rootNode) && typeof rootNode.name === 'string'
				? rootNode.name
				: rootKey);
		for (const child of folderChildren(rootNode, `roots.${rootKey}`)) {
			walkBookmarkNode(child, [label], out);
		}
	}
	return out;
}

function folderChildren(node: unknown, where: string): unknown[] {
	if (!isRecord(node) || !Array.isArray(node.children)) {
		throw new Error(
			`Unrecognized Chrome Bookmarks format: ${where} is not a folder.`,
		);
	}
	return node.children;
}

function walkBookmarkNode(
	node: unknown,
	trail: string[],
	out: BookmarkEntry[],
): void {
	const where = [...trail, isRecord(node) ? String(node.name ?? '') : '']
		.join(' / ');
	if (isRecord(node) && node.type === 'url' && typeof node.url === 'string') {
		const guid = typeof node.guid === 'string' && node.guid
			? node.guid
			: node.url;
		if (!guid) {
			throw new Error(
				`Unrecognized Chrome Bookmarks format: bookmark without guid or url at ${where}.`,
			);
		}
		out.push({
			guid,
			name: typeof node.name === 'string' ? node.name : '',
			url: node.url,
			folder: trail.join(' / '),
			dateAdded: parseWebkitTimestamp(node.date_added as string),
			dateModified: parseWebkitTimestamp(node.date_modified as string),
		});
		return;
	}
	if (isRecord(node) && node.type === 'folder') {
		const name = typeof node.name === 'string' ? node.name : '';
		const nextTrail = name ? [...trail, name] : trail;
		for (const child of folderChildren(node, where)) {
			walkBookmarkNode(child, nextTrail, out);
		}
		return;
	}
	throw new Error(
		`Unrecognized Chrome Bookmarks format: unknown node at ${where}.`,
	);
}

export function buildBookmarkDoc(entry: BookmarkEntry): WireDoc {
	const title = entry.name || entry.url || 'Untitled bookmark';
	const createdAt = entry.dateAdded
		? webkitMicrosToRfc3339(entry.dateAdded)
		: null;
	const updatedAt = webkitMicrosToRfc3339(
		entry.dateModified ?? entry.dateAdded ?? 0n,
	);

	const lines = [title, ''];
	if (entry.url) lines.push(entry.url, '');
	if (entry.folder) lines.push(`Folder: ${entry.folder}`);
	if (createdAt) lines.push(`Added: ${createdAt}`);
	const content = lines.join('\n');

	const metadata: Record<string, JsonValue> = {};
	if (isWebUrl(entry.url)) metadata.url = entry.url;
	if (entry.folder) metadata.folder = entry.folder;
	if (createdAt) metadata.created_at = createdAt;

	const doc: WireDoc = {
		id: bookmarkDocId(entry.guid),
		title,
		content,
		content_format: 'plaintext',
		doc_type: DOC_TYPE_BOOKMARK,
		metadata,
		original_file_size: content.length,
	};
	if (updatedAt) doc.doc_updated_at = updatedAt;
	return doc;
}

export interface HistoryRow {
	url: string;
	title: string;
	visitCount: number;
	lastVisit: bigint;
}

export function buildHistoryDoc(row: HistoryRow): WireDoc {
	const title = row.title.trim() ? row.title.trim() : row.url;
	const lastVisited = webkitMicrosToRfc3339(row.lastVisit);

	const lines = [title, '', row.url, '', `Visits: ${row.visitCount}`];
	if (lastVisited) lines.push(`Last visited: ${lastVisited}`);
	const content = lines.join('\n');

	const metadata: Record<string, JsonValue> = { visit_count: row.visitCount };
	if (isWebUrl(row.url)) metadata.url = row.url;

	const doc: WireDoc = {
		id: historyDocId(row.url),
		title,
		content,
		content_format: 'plaintext',
		doc_type: DOC_TYPE_HISTORY,
		metadata,
		original_file_size: content.length,
	};
	if (lastVisited) doc.doc_updated_at = lastVisited;
	return doc;
}

/** The poll's enumeration of one source: every doc id in scope. */
interface Scan {
	seen: Set<string>;
	/** False when the scan stopped early (abort); then nothing is deleted. */
	complete: boolean;
}

/**
 * The one place deletes are decided. A disabled source drops every id it had
 * indexed; an enabled one drops the ids its complete scan no longer saw.
 */
function sourceDeletes(previousIds: string[] | undefined, scan: Scan | null) {
	if (scan == null) return previousIds ?? [];
	return staleIds(previousIds ?? [], scan);
}

// --------------------------------------------------------------------------
// Connector
// --------------------------------------------------------------------------

export default class ChromeConnector extends Connector<ManifestConfig, State> {
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const profileDir = this.expandHome(
			defaultChromeProfilePath(Deno.build.os),
		);
		const indexBookmarks = this.config.index_bookmarks !== false;
		const indexHistory = this.config.index_history !== false;
		const range = String(this.config.history_range ?? '90d');
		const skipNonWeb = this.config.history_skip_non_web !== false;
		const prev: State = this.lastState ?? {};

		// A missing profile is an error, never "everything was deleted".
		let profileFound: boolean;
		try {
			profileFound = statSync(profileDir).isDirectory();
		} catch (error) {
			if (!isNotFound(error)) throw error;
			profileFound = false;
		}
		if (!profileFound) {
			throw new Error(
				`Chrome profile not found at ${profileDir}. Open Google Chrome with its Default profile once, then sync again.`,
			);
		}

		// Intermediate batches carry updates only; the final batch commits
		// state once every enabled source has been scanned.
		let bookmarkScan: Scan | null = null;
		if (indexBookmarks) {
			const updates = [];
			bookmarkScan = { seen: new Set(), complete: true };
			for (const entry of readBookmarks(join(profileDir, 'Bookmarks'))) {
				const doc = buildBookmarkDoc(entry);
				if (bookmarkScan.seen.has(doc.id)) continue;
				bookmarkScan.seen.add(doc.id);
				updates.push(upsert(doc));
			}
			if (updates.length > 0) yield { updates };
		}

		let historyScan: HistoryScan | null = null;
		if (indexHistory) {
			historyScan = {
				seen: new Set(),
				complete: false,
				cursor: parseWebkitTimestamp(prev.history_cursor) ?? 0n,
			};
			yield* this.scanHistory(
				join(profileDir, 'History'),
				range,
				skipNonWeb,
				prev,
				historyScan,
			);
		}
		// Cancelled: stop without deletes or state.
		if (this.signal.aborted || historyScan?.complete === false) return;

		const deletes = [
			...sourceDeletes(prev.bookmark_ids, bookmarkScan),
			...sourceDeletes(prev.history_ids, historyScan),
		].map((id) => del(id));
		const state: State = {
			history_cursor: historyScan && historyScan.cursor > 0n
				? historyScan.cursor.toString()
				: undefined,
			history_ids: historyScan ? [...historyScan.seen] : [],
			bookmark_ids: bookmarkScan ? [...bookmarkScan.seen] : [],
		};
		yield { updates: deletes, state };
	}

	/**
	 * Upserts in-range history rows that are new since the cursor or not yet
	 * indexed, and records every in-range id in `scan.seen`. Sets
	 * `scan.complete` only after every row was read.
	 */
	private async *scanHistory(
		historyPath: string,
		range: string,
		skipNonWeb: boolean,
		prev: State,
		scan: HistoryScan,
	): AsyncGenerator<PollResult> {
		const cutoff = historyCutoffWebkitMicros(
			historyRangeToMaxAgeDays(range),
			Date.now(),
		);
		const prevCursor = parseWebkitTimestamp(prev.history_cursor);
		// Ids the last committed poll indexed. An in-range row missing here
		// (range widened, history re-enabled, filter relaxed) is backfilled
		// even when it is older than the cursor.
		const indexed = new Set(prev.history_ids ?? []);

		// Chrome locks the live DB and keeps in-flight writes in a rollback
		// journal or a WAL, so copy History with its -journal/-wal/-shm to a
		// throwaway dir and open the copy read-write so SQLite can recover it.
		const tmpRoot = mkdtempSync(join(tmpdir(), 'gety-chrome-'));
		const tmpDb = join(tmpRoot, 'History');
		try {
			try {
				copyFileSync(historyPath, tmpDb);
			} catch (error) {
				if (!isNotFound(error)) throw error;
				throw new Error(`Chrome History database not found at ${historyPath}.`);
			}
			for (const ext of ['-journal', '-wal', '-shm']) {
				try {
					copyFileSync(historyPath + ext, tmpDb + ext);
				} catch (error) {
					if (!isNotFound(error)) throw error;
				}
			}

			// Index the pages Chrome's own history list shows: skip phantom rows
			// never actually loaded, and require a visible visit in range, i.e.
			// one ending a redirect chain (CHAIN_END) that is neither a subframe
			// load (AUTO/MANUAL_SUBFRAME) nor KEYWORD_GENERATED. This drops
			// redirect sources and subframe-only pages; `urls.hidden` is not
			// used, as Chrome's history list does not use it either.
			const visibleVisit = [
				'v.url = urls.id',
				'(v.transition & 0x20000000) != 0',
				'(v.transition & 255) NOT IN (3, 4, 10)',
			];
			const conditions = [
				'last_visit_time > 0',
				'(visit_count > 0 OR typed_count > 0)',
			];
			const params: bigint[] = [];
			if (cutoff != null) {
				conditions.push('last_visit_time >= ?');
				visibleVisit.push('v.visit_time >= ?');
				params.push(cutoff, cutoff);
			}
			conditions.push(
				`EXISTS (SELECT 1 FROM visits v WHERE ${visibleVisit.join(' AND ')})`,
			);
			const sql =
				`SELECT url, title, visit_count, last_visit_time FROM urls WHERE ${
					conditions.join(' AND ')
				} ORDER BY last_visit_time ASC`;

			const db = new DatabaseSync(tmpDb, { readOnly: false });
			try {
				const stmt = db.prepare(sql);
				stmt.setReadBigInts(true);

				let updates: PollResult['updates'] = [];
				for (const raw of stmt.iterate(...params)) {
					if (this.signal.aborted) return;
					const r = raw as Record<string, unknown>;
					const url = typeof r.url === 'string' ? r.url : '';
					if (!url) continue;
					if (skipNonWeb && !isWebUrl(url)) continue;

					const lastVisit = r.last_visit_time as bigint;
					const doc = buildHistoryDoc({
						url,
						title: typeof r.title === 'string' ? r.title : '',
						visitCount: Number(r.visit_count ?? 0),
						lastVisit,
					});
					scan.seen.add(doc.id);
					if (lastVisit > scan.cursor) scan.cursor = lastVisit;

					// `>=` keeps the boundary row so equal timestamps are not
					// missed; re-upserting it is idempotent.
					if (
						prevCursor == null || lastVisit >= prevCursor ||
						!indexed.has(doc.id)
					) {
						updates.push(upsert(doc));
						if (updates.length >= HISTORY_BATCH_SIZE) {
							yield { updates };
							updates = [];
						}
					}
				}
				if (updates.length > 0) yield { updates };
				scan.complete = true;
			} finally {
				db.close();
			}
		} finally {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	}
}

interface HistoryScan extends Scan {
	/** Highest `last_visit_time` seen (WebKit micros), starting at the old cursor. */
	cursor: bigint;
}

/**
 * Bookmarks in the profile's `Bookmarks` file. A missing file is a profile
 * without bookmarks; an unrecognized format fails the poll (see
 * flattenBookmarks) instead of deleting bookmarks.
 */
function readBookmarks(path: string): BookmarkEntry[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	return flattenBookmarks(JSON.parse(text));
}
