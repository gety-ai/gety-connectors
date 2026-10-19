import {
	Connector,
	del,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import { createLogger, type Logger } from '@gety-connectors/utils/log';
import { staleIds } from '@gety-connectors/utils/reconcile';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { isObjectNotFound, NotionClient } from './notion/api.ts';
import { blocksToMarkdown } from './notion/markdown.ts';
import { propertiesToMarkdown } from './notion/properties.ts';
import { isRecord, notionObjectUrl, type NotionPage } from './notion/types.ts';

/** Persisted incremental state: page id → last seen `last_edited_time`. */
export type NotionState = {
	version?: number;
	pages?: Record<string, string>;
};

/** Bump when the state layout changes; old state then triggers a full resync. */
export const STATE_VERSION = 1;

const DOC_TYPE = 'notion:page';
/** Stay under Gety's ~10 MB per-document content limit. */
const MAX_CONTENT_BYTES = 8_000_000;
const TRUNCATION_NOTICE = '\n\n…(content truncated)';

/** Extracts the page title from whichever property has type `title`. */
export function pageTitle(page: NotionPage): string {
	if (isRecord(page.properties)) {
		for (const property of Object.values(page.properties)) {
			if (!isRecord(property) || property.type !== 'title') {
				continue;
			}
			const items = property.title;
			if (!Array.isArray(items)) {
				continue;
			}
			const title = items
				.map((item) =>
					isRecord(item) && typeof item.plain_text === 'string'
						? item.plain_text
						: ''
				)
				.join('')
				.trim();
			if (title.length > 0) {
				return title;
			}
		}
	}
	return 'Untitled';
}

export function buildPageDoc(page: NotionPage, markdown: string): WireDoc {
	const { content, bytes } = clampContent(withProperties(page, markdown));
	const metadata: Record<string, string> = {
		url: typeof page.url === 'string' && page.url.length > 0
			? page.url
			: notionObjectUrl(page.id),
	};
	if (typeof page.created_time === 'string') {
		metadata.created_at = page.created_time;
	}

	const doc: WireDoc = {
		id: page.id,
		title: pageTitle(page),
		content,
		content_format: 'markdown',
		doc_type: DOC_TYPE,
		original_file_size: bytes,
		metadata,
	};
	if (typeof page.last_edited_time === 'string') {
		doc.doc_updated_at = page.last_edited_time;
	}
	const parentId = parentPageId(page);
	if (parentId != null) {
		doc.parent_id = parentId;
	}
	return doc;
}

/** Database-page properties carry key facts; prepend them to the body. */
function withProperties(page: NotionPage, markdown: string): string {
	const properties = isRecord(page.properties)
		? propertiesToMarkdown(page.properties)
		: '';
	if (properties.length === 0) {
		return markdown;
	}
	const section = `## Properties\n\n${properties}`;
	return markdown.length > 0 ? `${section}\n\n${markdown}` : `${section}\n`;
}

/** The parent page id, when the parent is itself a page (not a database). */
function parentPageId(page: NotionPage): string | null {
	const parent = page.parent;
	if (
		isRecord(parent) && parent.type === 'page_id' &&
		typeof parent.page_id === 'string'
	) {
		return parent.page_id;
	}
	return null;
}

/** True when the source marks the page archived or trashed (any API version). */
export function isGonePage(page: NotionPage): boolean {
	return page.archived === true || page.is_archived === true ||
		page.in_trash === true;
}

/** Extracts the known-pages map, discarding stale or malformed state. */
export function knownPagesFromState(
	state: NotionState | null | undefined,
): Record<string, string> {
	if (state?.version !== STATE_VERSION || !isRecord(state.pages)) {
		return {};
	}
	const pages: Record<string, string> = {};
	for (const [id, lastEdited] of Object.entries(state.pages)) {
		if (typeof lastEdited === 'string') {
			pages[id] = lastEdited;
		}
	}
	return pages;
}

function clampContent(text: string): { content: string; bytes: number } {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text).length;
	if (bytes <= MAX_CONTENT_BYTES) {
		return { content: text, bytes };
	}

	const budget = MAX_CONTENT_BYTES - encoder.encode(TRUNCATION_NOTICE).length;
	let end = Math.min(text.length, budget);
	let sliced = text.slice(0, end);
	while (end > 0 && encoder.encode(sliced).length > budget) {
		end = Math.floor(end * 0.9);
		sliced = text.slice(0, end);
	}
	// Do not end on a dangling surrogate half.
	if (/[\uD800-\uDBFF]$/.test(sliced)) {
		sliced = sliced.slice(0, -1);
	}
	const content = sliced + TRUNCATION_NOTICE;
	return { content, bytes: encoder.encode(content).length };
}

export default class NotionConnector extends Connector<
	ManifestConfig,
	NotionState
> {
	/** Split out so tests can inject a client with a stubbed fetch. */
	protected createClient(token: string, logger: Logger): NotionClient {
		return new NotionClient(token, this.signal, { logger });
	}

	/**
	 * Lists every page, upserts the changed ones as it goes (one batch per
	 * page, without state) and ends with one batch carrying the deletions
	 * and the new state. Gety commits state only when the poll succeeds, so
	 * intermediate batches have nothing to checkpoint; they keep the poll
	 * visibly alive and its memory flat.
	 */
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const token = (this.config.personal_access_token ?? '').trim();
		if (token.length === 0) {
			throw new Error(
				'Notion Personal Access Token is required. Create an internal ' +
					'integration at https://www.notion.so/my-integrations and set ' +
					'its secret in the connector settings.',
			);
		}

		const logger = createLogger('notion');
		const client = this.createClient(token, logger);
		const known = knownPagesFromState(this.lastState);
		/** Next state: every listed, readable page → its recorded edit time. */
		const pages: Record<string, string> = {};
		let fetched = 0;

		for await (const results of client.searchPages()) {
			for (const page of results) {
				if (isGonePage(page)) {
					continue;
				}
				const lastEdited = typeof page.last_edited_time === 'string'
					? page.last_edited_time
					: '';
				if (lastEdited.length > 0 && known[page.id] === lastEdited) {
					pages[page.id] = lastEdited;
					continue;
				}

				let markdown: string;
				try {
					markdown = blocksToMarkdown(await client.fetchBlockTree(page.id));
				} catch (error) {
					if (isObjectNotFound(error)) {
						// Deleted or unshared between search and fetch: leaving it
						// out of `pages` deletes it below.
						delete pages[page.id];
						continue;
					}
					throw error;
				}
				pages[page.id] = lastEdited;
				fetched += 1;
				yield { updates: [upsert(buildPageDoc(page, markdown))] };
			}
		}

		// The search above ran to completion (any failure throws), so a known
		// page missing from `pages` is gone from Notion, archived or unshared.
		const deleted = staleIds(Object.keys(known), {
			seen: new Set(Object.keys(pages)),
			complete: true,
		});
		logger.info('Notion sync finished', {
			pages: Object.keys(pages).length,
			fetched,
			deleted: deleted.length,
		});
		yield {
			updates: deleted.map((id) => del(id)),
			state: { version: STATE_VERSION, pages },
		};
	}
}
