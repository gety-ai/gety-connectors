import { sleep } from '@gety-connectors/utils/abort';
import {
	type FetchLike,
	HttpError,
	requestJson,
} from '@gety-connectors/utils/http';
import { isRecord } from '@gety-connectors/utils/json';
import { createLogger, type Logger } from '@gety-connectors/utils/log';
import {
	IncompleteEnumerationError,
	type Page,
	paginate,
	requireArray,
} from '@gety-connectors/utils/paginate';
import type { RetryPolicy } from '@gety-connectors/utils/retry';
import type { BlockNode, NotionBlock, NotionPage } from './types.ts';

const DEFAULT_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const PAGE_SIZE = 100;
/**
 * Notion asks clients to retry 429 and 529 (`service_overload`); 500 and the
 * gateway errors are transient too, and every request here is a read.
 */
const RETRY_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504, 529];
/** Notion allows ~3 requests/second on average; stay just under it. */
const DEFAULT_REQUEST_INTERVAL_MS = 350;
/** Safety bound for pathological block nesting. */
const MAX_BLOCK_DEPTH = 32;

export interface NotionClientOptions {
	baseUrl?: string;
	fetchFn?: FetchLike;
	/** Minimum delay between request starts; 0 disables throttling. */
	requestIntervalMs?: number;
	/** Per-attempt timeout; defaults to the utils http default. */
	timeoutMs?: number;
	/** Overrides of the utils retry policy (tests shorten the waits). */
	retry?: Partial<RetryPolicy>;
	logger?: Logger;
}

/**
 * True when Notion itself reports the object as gone or not shared with the
 * integration: a 404 carrying Notion's `object_not_found` error body. Any
 * other 404 (a proxy or routing error) proves nothing about the object.
 */
export function isObjectNotFound(error: unknown): boolean {
	return error instanceof HttpError && error.status === 404 &&
		isRecord(error.body) && error.body.object === 'error' &&
		error.body.code === 'object_not_found';
}

export class NotionClient {
	#token: string;
	#signal: AbortSignal;
	#baseUrl: string;
	#fetchFn: FetchLike | undefined;
	#requestIntervalMs: number;
	#timeoutMs: number | undefined;
	#retry: Partial<RetryPolicy>;
	#logger: Logger;
	#nextRequestAt = 0;

	constructor(
		token: string,
		signal: AbortSignal,
		options: NotionClientOptions = {},
	) {
		this.#token = token;
		this.#signal = signal;
		this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.#fetchFn = options.fetchFn;
		this.#requestIntervalMs = Math.max(
			0,
			options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
		);
		this.#timeoutMs = options.timeoutMs;
		this.#retry = options.retry ?? {};
		this.#logger = options.logger ?? createLogger('notion');
	}

	/**
	 * Yields every page shared with the integration, one search page at a
	 * time. Throws instead of ending early on any response it cannot fully
	 * read: a short enumeration would diff-delete the pages it missed.
	 */
	async *searchPages(): AsyncGenerator<NotionPage[], void, unknown> {
		const pages = paginate(
			async (cursor) =>
				listPage(
					await this.#request('POST', '/search', {
						filter: { property: 'object', value: 'page' },
						// Ascending: timestamps never decrease, so a page edited while
						// we paginate can only move toward the end of the cursor stream
						// and is still enumerated (descending could skip it, and a
						// skipped page would be wrongly diff-deleted).
						sort: { direction: 'ascending', timestamp: 'last_edited_time' },
						page_size: PAGE_SIZE,
						...(cursor === undefined ? {} : { start_cursor: cursor }),
					}),
					'Notion search',
				),
			{ signal: this.#signal, context: 'Notion search' },
		);
		for await (const { items } of pages) {
			yield items.map(searchResult);
		}
	}

	/**
	 * Fetches the full block tree of a page (without descending into child
	 * pages). A 404 for the page itself is thrown; a 404 below it (a block
	 * or a synced block's original that is not shared with the integration)
	 * leaves that subtree empty and keeps the rest of the page.
	 */
	async fetchBlockTree(pageId: string): Promise<BlockNode[]> {
		return await this.#fetchDescendants(pageId, new Set([pageId]), 0);
	}

	async #fetchDescendants(
		parentId: string,
		visited: Set<string>,
		depth: number,
	): Promise<BlockNode[]> {
		if (depth >= MAX_BLOCK_DEPTH) {
			return [];
		}
		let blocks: NotionBlock[];
		try {
			blocks = await this.#fetchAllChildren(parentId);
		} catch (error) {
			if (depth === 0 || !isObjectNotFound(error)) {
				throw error;
			}
			this.#logger.warn('Skipping blocks Notion reports as not found', {
				block: parentId,
			});
			return [];
		}
		const nodes: BlockNode[] = [];
		for (const block of blocks) {
			const node: BlockNode = { block, children: [] };
			const childSource = childFetchId(block);
			if (childSource != null && !visited.has(childSource)) {
				visited.add(childSource);
				node.children = await this.#fetchDescendants(
					childSource,
					visited,
					depth + 1,
				);
			}
			nodes.push(node);
		}
		return nodes;
	}

	async #fetchAllChildren(blockId: string): Promise<NotionBlock[]> {
		const pages = paginate(
			async (cursor) => {
				const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
				if (cursor !== undefined) {
					query.set('start_cursor', cursor);
				}
				return listPage(
					await this.#request(
						'GET',
						`/blocks/${encodeURIComponent(blockId)}/children?${query}`,
					),
					'Notion block children',
				);
			},
			{ signal: this.#signal, context: 'Notion block children' },
		);
		const blocks: NotionBlock[] = [];
		for await (const { items } of pages) {
			for (const item of items) {
				if (
					isRecord(item) && typeof item.id === 'string' &&
					typeof item.type === 'string'
				) {
					blocks.push(item as unknown as NotionBlock);
				}
			}
		}
		return blocks;
	}

	async #request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		try {
			return await requestJson(`${this.#baseUrl}${path}`, {
				method,
				headers: {
					'Authorization': `Bearer ${this.#token}`,
					'Notion-Version': NOTION_VERSION,
				},
				body,
				signal: this.#signal,
				timeoutMs: this.#timeoutMs,
				fetch: this.#fetchFn,
				beforeAttempt: (signal) => this.#waitForRequestSlot(signal),
				retry: {
					...this.#retry,
					statuses: RETRY_STATUSES,
					// A blocked request stays blocked; retrying only delays the error.
					shouldRetry: (error) =>
						!(error instanceof HttpError && isRecord(error.body) &&
							error.body.code === 'public_api_request_blocked'),
					onRetry: ({ attempt, delayMs, error }) =>
						this.#logger.warn('Notion request failed; retrying', {
							attempt: attempt + 1,
							wait_s: Math.ceil(delayMs / 1000),
							error: error instanceof Error ? error.message : String(error),
						}),
				},
			});
		} catch (error) {
			if (error instanceof HttpError && error.status === 401) {
				throw new Error(
					'Notion rejected the API token (HTTP 401): token invalid or ' +
						'expired. Create a new token and update the connector settings.',
					{ cause: error },
				);
			}
			throw error;
		}
	}

	async #waitForRequestSlot(signal: AbortSignal): Promise<void> {
		await sleep(this.#nextRequestAt - Date.now(), signal);
		this.#nextRequestAt = Date.now() + this.#requestIntervalMs;
	}
}

/** A Notion list response as a page; throws on any unexpected shape. */
function listPage(
	response: Record<string, unknown>,
	context: string,
): Page<unknown> {
	const items = requireArray(response.results, context);
	if (typeof response.has_more !== 'boolean') {
		throw new IncompleteEnumerationError(
			`${context}: the response has no has_more flag`,
		);
	}
	return {
		items,
		hasMore: response.has_more,
		nextCursor: typeof response.next_cursor === 'string'
			? response.next_cursor
			: null,
	};
}

/**
 * A result of the page-filtered search. Anything other than a page with an
 * id breaks the response contract and fails the enumeration: skipping it
 * could hide a page, and a hidden page would be diff-deleted.
 */
function searchResult(item: unknown): NotionPage {
	if (
		!isRecord(item) || item.object !== 'page' ||
		typeof item.id !== 'string' || item.id.length === 0
	) {
		throw new IncompleteEnumerationError(
			'Notion search: a result is not a page with an id',
		);
	}
	return item as unknown as NotionPage;
}

/**
 * Which block id, if any, should be fetched to obtain this block's children.
 * Child pages/databases are separate documents and are never descended into;
 * duplicated synced blocks read their children from the original block.
 */
function childFetchId(block: NotionBlock): string | null {
	if (
		block.type === 'child_page' || block.type === 'child_database' ||
		block.type === 'unsupported'
	) {
		return null;
	}
	if (block.type === 'synced_block') {
		const payload = block.synced_block;
		if (isRecord(payload) && isRecord(payload.synced_from)) {
			const original = payload.synced_from.block_id;
			if (typeof original === 'string') {
				return original;
			}
		}
	}
	return block.has_children === true ? block.id : null;
}
