/**
 * Last known source positions of the indexed cloud documents, kept in the
 * data directory instead of the state. A position carries ancestor titles
 * and URLs (about 1 KB per document); in the state it would push the
 * StartFrame past the host's 16 MiB budget at roughly 13k documents, after
 * which every poll fails.
 *
 * The cache is advisory: a cached position is only the fallback when this
 * poll's location lookup fails or runs out of budget. A cache newer or older
 * than the committed state therefore costs at most a refetch. It is bound to
 * the state by an epoch kept in the state: a resync clears the state, the
 * next poll starts a new epoch, and the old file is ignored.
 */

import { isRecord } from '@gety-connectors/utils/json';
import type { Logger } from '@gety-connectors/utils/log';
import type { CloudPosition } from './doc_location.ts';
import { errorMessage } from './lark_cli.ts';

const CACHE_FILE = 'doc-positions.json';

type CacheFile = { epoch: string; positions: Record<string, CloudPosition> };

const LOCATION_STRINGS = [
	'space_name',
	'space_url',
	'parent_name',
	'parent_url',
	'path',
] as const;
const FEISHU_STRINGS = [
	'node_token',
	'obj_token',
	'space_id',
	'parent_node_token',
	'origin_node_token',
	'origin_space_id',
	'folder_token',
] as const;

const optionalString = (value: unknown) =>
	value === undefined || typeof value === 'string';

/**
 * Whether a cached entry has the shape `CloudPosition` declares, nested
 * fields included: the file lives outside the connector's control, and a
 * corrupt fallback position would otherwise keep breaking the document it
 * belongs to whenever location lookups fail.
 */
function isCloudPosition(value: unknown): value is CloudPosition {
	if (!isRecord(value) || !optionalString(value.url)) return false;
	const { location, feishu } = value;
	if (location !== undefined) {
		if (!isRecord(location)) return false;
		if (!LOCATION_STRINGS.every((key) => optionalString(location[key]))) {
			return false;
		}
		if (
			location.path_complete !== undefined &&
			typeof location.path_complete !== 'boolean'
		) {
			return false;
		}
		const ancestors = location.ancestors;
		if (
			ancestors !== undefined &&
			!(Array.isArray(ancestors) &&
				ancestors.every((item) =>
					isRecord(item) && typeof item.id === 'string' &&
					typeof item.title === 'string' && optionalString(item.url)
				))
		) {
			return false;
		}
	}
	return feishu === undefined ||
		(isRecord(feishu) &&
			FEISHU_STRINGS.every((key) => optionalString(feishu[key])));
}

export type PositionCache = {
	positions: Record<string, CloudPosition>;
	/**
	 * False when the file was missing, unreadable, from another epoch, or had
	 * malformed entries.
	 */
	matched: boolean;
};

/**
 * The cached positions of `epoch`; empty when there is no data directory, no
 * file, a file of another epoch, or an unreadable file. A sandbox denial is
 * rethrown: the data directory is always granted, so it is a host bug.
 */
export async function readPositionCache(
	dataDir: string,
	epoch: string,
	logger: Logger,
): Promise<PositionCache> {
	if (dataDir === '') {
		return { positions: {}, matched: false };
	}
	let text: string;
	try {
		text = await Deno.readTextFile(
			`${dataDir.replace(/[\\/]+$/, '')}/${CACHE_FILE}`,
		);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return { positions: {}, matched: false };
		}
		if (error instanceof Deno.errors.NotCapable) throw error;
		logger.warn(`ignoring the position cache: ${errorMessage(error)}`);
		return { positions: {}, matched: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.positions)) {
		logger.warn('ignoring a malformed position cache');
		return { positions: {}, matched: false };
	}
	if (parsed.epoch !== epoch) {
		return { positions: {}, matched: false };
	}
	const positions: Record<string, CloudPosition> = {};
	let dropped = 0;
	for (const [token, position] of Object.entries(parsed.positions)) {
		if (isCloudPosition(position)) {
			positions[token] = position;
		} else {
			dropped += 1;
		}
	}
	if (dropped > 0) {
		logger.warn('ignoring malformed entries of the position cache', {
			dropped,
		});
	}
	// A partly malformed file is rewritten at the end of the poll.
	return { positions, matched: dropped === 0 };
}

/**
 * Replaces the cache with `positions` for `epoch` (write, then rename, so a
 * killed poll never leaves a torn file). A failed write is logged and
 * otherwise ignored: the next poll just starts from an empty cache.
 */
export async function writePositionCache(
	dataDir: string,
	epoch: string,
	positions: Record<string, CloudPosition>,
	logger: Logger,
): Promise<void> {
	if (dataDir === '') {
		return;
	}
	const path = `${dataDir.replace(/[\\/]+$/, '')}/${CACHE_FILE}`;
	const file: CacheFile = { epoch, positions };
	try {
		await Deno.writeTextFile(`${path}.tmp`, JSON.stringify(file));
		await Deno.rename(`${path}.tmp`, path);
	} catch (error) {
		if (error instanceof Deno.errors.NotCapable) throw error;
		logger.warn(`could not write the position cache: ${errorMessage(error)}`);
	}
}
