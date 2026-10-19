import {
	Connector,
	del,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import { isRecord } from '@gety-connectors/utils/json';
import { createLogger, type Logger } from '@gety-connectors/utils/log';
import { staleIds } from '@gety-connectors/utils/reconcile';
import { clampUtf8, MAX_CONTENT_BYTES } from '@gety-connectors/utils/text';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { isObjectNotFound, NotionClient } from './notion/api.ts';
import { blocksToMarkdown } from './notion/markdown.ts';
import { propertiesToMarkdown } from './notion/properties.ts';
import { notionObjectUrl, type NotionPage } from './notion/types.ts';

/** Persisted incremental state: page id → last seen `last_edited_time`. */
export type NotionState = {
	version?: number;
	pages?: Record<string, string>;
};

/**
 * Layout version of `NotionState`. A state with another version is ignored:
 * every page is fetched again, but documents known only to that state are
 * not deleted.
 */
export const STATE_VERSION = 1;

const DOC_TYPE = 'notion:page';
const TRUNCATION_NOTICE = '\n\n…(content truncated)';
/**
 * Notion rounds `last_edited_time` down to the minute, so an edit later in
 * the same minute leaves the timestamp unchanged. A fetched page's timestamp
 * is recorded only when that minute ended this long before the poll began
 * (one minute of rounding plus one of clock skew).
 */
const EDIT_TIME_SETTLED_MS = 2 * 60_000;

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
	const { content, bytes } = clampUtf8(
		withProperties(page, markdown),
		MAX_CONTENT_BYTES,
		TRUNCATION_NOTICE,
	);
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
				'Notion Personal Access Token is required. Paste an internal ' +
					'connection token from the Notion Developer portal ' +
					'(https://www.notion.so/developers) or a personal access token ' +
					'(https://www.notion.so/developers/tokens) into the connector ' +
					'settings.',
			);
		}

		const logger = createLogger('notion');
		const client = this.createClient(token, logger);
		const known = knownPagesFromState(this.lastState);
		/** Next state: every listed, readable page → its recorded edit time. */
		const pages: Record<string, string> = {};
		/**
		 * Pages fetched by this poll → the edit time they were fetched at. The
		 * ascending sort repeats a page edited during the search further on.
		 */
		const fetched = new Map<string, string>();
		/**
		 * Taken before the search: the title and properties in each document
		 * come from the search response, which can be minutes older than the
		 * page's block fetch.
		 */
		const pollStartedAt = Date.now();

		for await (const results of client.searchPages()) {
			for (const page of results) {
				// Trashed pages (`in_trash`, called `archived` before API version
				// 2026-03-11) are not indexed; known ones are deleted below.
				if (page.in_trash === true) {
					continue;
				}
				const lastEdited = typeof page.last_edited_time === 'string'
					? page.last_edited_time
					: '';
				if (
					(lastEdited.length > 0 && known[page.id] === lastEdited) ||
					fetched.get(page.id) === lastEdited
				) {
					pages[page.id] ??= lastEdited;
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
				// An unsettled timestamp is recorded as '' so the next poll fetches
				// the page again and picks up edits made later in that minute.
				pages[page.id] =
					pollStartedAt - Date.parse(lastEdited) >= EDIT_TIME_SETTLED_MS
						? lastEdited
						: '';
				fetched.set(page.id, lastEdited);
				yield { updates: [upsert(buildPageDoc(page, markdown))] };
			}
		}

		// The search above ran to completion (any failure throws), so a known
		// page missing from `pages` is gone from Notion, trashed or unshared.
		const deleted = staleIds(Object.keys(known), {
			seen: new Set(Object.keys(pages)),
			complete: true,
		});
		logger.info('Notion sync finished', {
			pages: Object.keys(pages).length,
			fetched: fetched.size,
			deleted: deleted.length,
		});
		yield {
			updates: deleted.map((id) => del(id)),
			state: { version: STATE_VERSION, pages },
		};
	}
}
