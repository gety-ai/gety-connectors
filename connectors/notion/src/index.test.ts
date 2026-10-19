import assert from 'node:assert/strict';
import type { Logger } from '@gety-connectors/utils/log';
import { jsonResponse, runPoll } from '@gety-connectors/testing';
import type { FetchLike } from '@gety-connectors/utils/http';
import NotionConnector, {
	buildPageDoc,
	knownPagesFromState,
	pageTitle,
	STATE_VERSION,
} from './index.ts';
import { NotionClient } from './notion/api.ts';
import type { NotionPage } from './notion/types.ts';

const TS_OLD = '2026-01-01T00:00:00.000Z';
const TS_NEW = '2026-02-02T00:00:00.000Z';
const CONFIG = { personal_access_token: 'test-token' };
const NOT_FOUND = { object: 'error', code: 'object_not_found', message: 'x' };

function titleProperty(text: string): Record<string, unknown> {
	return { Name: { type: 'title', title: [{ plain_text: text }] } };
}

function page(
	id: string,
	lastEdited: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		object: 'page',
		id,
		last_edited_time: lastEdited,
		properties: titleProperty(id.toUpperCase()),
		...extra,
	};
}

function paragraph(text: string): Record<string, unknown> {
	return {
		id: `p-${text}`,
		type: 'paragraph',
		paragraph: { rich_text: [{ plain_text: text }] },
	};
}

/**
 * A fake Notion API: one search page with `pages`, block children from
 * `blocks` (keyed by parent id) and 404 for any other block. Every request
 * URL is recorded in `requests`.
 */
function fakeNotion(
	pages: Record<string, unknown>[],
	blocks: Record<string, Record<string, unknown>[]> = {},
): FetchLike & { requests: string[] } {
	const requests: string[] = [];
	const fetchFn = (url: string) => {
		requests.push(url);
		if (url.endsWith('/search')) {
			return Promise.resolve(
				jsonResponse({ results: pages, has_more: false, next_cursor: null }),
			);
		}
		const id = url.match(/\/blocks\/([^/?]+)\/children/)?.[1] ?? '';
		const children = blocks[decodeURIComponent(id)];
		return Promise.resolve(
			children === undefined
				? jsonResponse(NOT_FOUND, { status: 404 })
				: jsonResponse({ results: children, has_more: false }),
		);
	};
	return Object.assign(fetchFn, { requests });
}

class TestConnector extends NotionConnector {
	constructor(private readonly fetchFn: FetchLike) {
		super();
	}

	protected override createClient(
		token: string,
		logger: Logger,
	): NotionClient {
		return new NotionClient(token, this.signal, {
			baseUrl: 'https://notion.test/v1',
			fetchFn: this.fetchFn,
			requestIntervalMs: 0,
			retry: { baseDelayMs: 0 },
			logger,
		});
	}
}

/** The updates of a run as `[kind, id]` pairs. */
function updateIds(updates: unknown[]): [string, string][] {
	return updates.map((update) => {
		const { kind, id, doc } = update as {
			kind: string;
			id?: string;
			doc?: { id: string };
		};
		return [kind, doc?.id ?? id ?? ''];
	});
}

Deno.test('pageTitle finds the title property regardless of its name', () => {
	const page: NotionPage = {
		object: 'page',
		id: 'p1',
		properties: {
			Status: { type: 'select', select: { name: 'Open' } },
			...titleProperty('My Page'),
		},
	};
	assert.equal(pageTitle(page), 'My Page');
	assert.equal(pageTitle({ object: 'page', id: 'p2' }), 'Untitled');
});

Deno.test('buildPageDoc maps notion page fields onto the wire doc', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'page-1',
			url: 'https://www.notion.so/My-Page-page1',
			created_time: TS_OLD,
			last_edited_time: TS_NEW,
			properties: titleProperty('My Page'),
		},
		'# Body\n',
	);

	assert.equal(doc.id, 'page-1');
	assert.equal(doc.title, 'My Page');
	assert.equal(doc.content, '# Body\n');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(doc.doc_type, 'notion:page');
	assert.equal(doc.doc_updated_at, TS_NEW);
	assert.equal(doc.original_file_size, 7);
	assert.deepEqual(doc.metadata, {
		url: 'https://www.notion.so/My-Page-page1',
		created_at: TS_OLD,
	});
});

Deno.test('buildPageDoc falls back to a constructed notion url', () => {
	const doc = buildPageDoc(
		{ object: 'page', id: 'abc-123', properties: {} },
		'',
	);
	assert.deepEqual(doc.metadata, { url: 'https://www.notion.so/abc123' });
});

Deno.test('buildPageDoc links child pages to their parent page', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'child-1',
			parent: { type: 'page_id', page_id: 'parent-1' },
			properties: titleProperty('Child'),
		},
		'body\n',
	);
	assert.equal(doc.parent_id, 'parent-1');

	const rootDoc = buildPageDoc(
		{
			object: 'page',
			id: 'root-1',
			parent: { type: 'workspace', workspace: true },
			properties: titleProperty('Root'),
		},
		'body\n',
	);
	assert.equal(rootDoc.parent_id, undefined);
});

Deno.test('buildPageDoc prepends database properties to the content', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'db-row-1',
			properties: {
				...titleProperty('Task'),
				Status: { type: 'status', status: { name: 'In progress' } },
				Tags: {
					type: 'multi_select',
					multi_select: [{ name: 'a' }, { name: 'b' }],
				},
			},
		},
		'# Body\n',
	);
	assert.equal(
		doc.content,
		'## Properties\n\n- **Status:** In progress\n- **Tags:** a, b\n\n# Body\n',
	);

	const plain = buildPageDoc(
		{ object: 'page', id: 'plain-1', properties: titleProperty('Plain') },
		'# Body\n',
	);
	assert.equal(plain.content, '# Body\n');
});

Deno.test('buildPageDoc truncates oversized content within the byte budget', () => {
	// 3-byte characters, so the cut has to land on a code point boundary.
	const doc = buildPageDoc(
		{ object: 'page', id: 'big', properties: {} },
		'界'.repeat(3_000_000),
	);
	const content = doc.content ?? '';
	const bytes = new TextEncoder().encode(content).length;

	assert.equal(doc.original_file_size, bytes);
	assert.ok(bytes <= 8_000_000, `${bytes} bytes`);
	assert.ok(bytes > 7_999_000, `${bytes} bytes`);
	assert.match(content, /^界+\n\n…\(content truncated\)$/);
});

Deno.test('stale or malformed state triggers a full resync', () => {
	assert.deepEqual(knownPagesFromState(undefined), {});
	assert.deepEqual(knownPagesFromState({ pages: { a: TS_OLD } }), {});
	assert.deepEqual(
		knownPagesFromState({ version: 99, pages: { a: TS_OLD } }),
		{},
	);
	assert.deepEqual(
		knownPagesFromState({
			version: STATE_VERSION,
			pages: { a: TS_OLD, b: 42 as unknown as string },
		}),
		{ a: TS_OLD },
	);
});

Deno.test('poll fails fast without a personal access token', async () => {
	const run = await runPoll(
		new TestConnector(() => {
			throw new Error('poll must not reach the network without a token');
		}),
		{ config: { personal_access_token: '   ' } },
	);

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /Personal Access Token is required/);
});

Deno.test('a 200 HTML search response fails the poll and deletes nothing', async () => {
	// A captive portal or proxy answering 200 with HTML used to end the
	// enumeration early, and the delete diff then removed every known page.
	const connector = new TestConnector(() =>
		Promise.resolve(
			new Response('<html>Sign in to the network</html>', {
				headers: { 'content-type': 'text/html' },
			}),
		)
	);

	const run = await runPoll(connector, {
		config: CONFIG,
		lastState: {
			version: STATE_VERSION,
			pages: { a: TS_OLD, b: TS_OLD, c: TS_OLD },
		},
	});

	assert.equal(run.outcome, 'error');
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
});

Deno.test('a search result that is not a page fails the poll and deletes nothing', async () => {
	const connector = new TestConnector(() =>
		Promise.resolve(
			jsonResponse({
				results: [{ object: 'unexpected', id: 'a' }],
				has_more: false,
				next_cursor: null,
			}),
		)
	);

	const run = await runPoll(connector, {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { a: TS_OLD } },
	});

	assert.equal(run.outcome, 'error');
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
});

Deno.test('an unshared synced original keeps the page indexed', async () => {
	const notion = fakeNotion([page('a', TS_NEW)], {
		a: [
			{
				id: 'sync',
				type: 'synced_block',
				has_children: true,
				synced_block: { synced_from: { block_id: 'unshared' } },
			},
			paragraph('Own text.'),
		],
	});

	const run = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { a: TS_OLD } },
	});

	assert.equal(run.outcome, 'done');
	assert.deepEqual(updateIds(run.updates), [['upsert', 'a']]);
	const update = run.updates[0] as { doc: { content: string } };
	assert.equal(update.doc.content, 'Own text.\n');
	assert.deepEqual(run.committedState, {
		version: STATE_VERSION,
		pages: { a: TS_NEW },
	});
});

Deno.test('a page that is gone when its blocks are fetched is deleted', async () => {
	const notion = fakeNotion([page('a', TS_NEW)]);

	const run = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { a: TS_OLD } },
	});

	assert.equal(run.outcome, 'done');
	assert.deepEqual(updateIds(run.updates), [['delete', 'a']]);
	assert.deepEqual(run.committedState, { version: STATE_VERSION, pages: {} });
});

Deno.test('a proxy 404 for a listed page fails the poll and deletes nothing', async () => {
	const connector = new TestConnector((url) =>
		Promise.resolve(
			url.endsWith('/search')
				? jsonResponse({
					results: [page('a', TS_NEW)],
					has_more: false,
					next_cursor: null,
				})
				: new Response('<html>proxy route not found</html>', {
					status: 404,
					headers: { 'content-type': 'text/html' },
				}),
		)
	);

	const run = await runPoll(connector, {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { a: TS_OLD } },
	});

	assert.equal(run.outcome, 'error');
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll upserts changed pages, skips unchanged ones, deletes gone ones', async () => {
	const notion = fakeNotion(
		[page('aaa', TS_OLD), page('bbb', TS_NEW)],
		{ bbb: [paragraph('Hello from B.')] },
	);

	const run = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: {
			version: STATE_VERSION,
			pages: { aaa: TS_OLD, ccc: TS_OLD },
		},
	});

	assert.equal(run.outcome, 'done');
	assert.deepEqual(updateIds(run.updates), [
		['upsert', 'bbb'],
		['delete', 'ccc'],
	]);
	const update = run.updates[0] as { doc: { title: string; content: string } };
	assert.equal(update.doc.title, 'BBB');
	assert.equal(update.doc.content, 'Hello from B.\n');
	assert.deepEqual(run.committedState, {
		version: STATE_VERSION,
		pages: { aaa: TS_OLD, bbb: TS_NEW },
	});
	assert.ok(
		!notion.requests.some((url) => url.includes('/blocks/aaa/')),
		'unchanged pages must not be re-fetched',
	);
});

Deno.test('each changed page is its own batch and only the last carries state', async () => {
	const notion = fakeNotion(
		[page('a', TS_NEW), page('b', TS_NEW), page('c', TS_NEW)],
		{ a: [paragraph('A')], b: [paragraph('B')], c: [paragraph('C')] },
	);

	const run = await runPoll(new TestConnector(notion), { config: CONFIG });

	assert.equal(run.outcome, 'done');
	assert.deepEqual(
		run.batches.map((batch) => [
			updateIds(batch.updates),
			Object.hasOwn(batch, 'state'),
		]),
		[
			[[['upsert', 'a']], false],
			[[['upsert', 'b']], false],
			[[['upsert', 'c']], false],
			[[], true],
		],
	);
	assert.deepEqual(run.committedState, {
		version: STATE_VERSION,
		pages: { a: TS_NEW, b: TS_NEW, c: TS_NEW },
	});
});

Deno.test('a page edited in the current minute is fetched again next poll', async () => {
	// Notion rounds last_edited_time down to the minute: an edit later in
	// this minute would keep the timestamp, so it must not be trusted yet.
	const thisMinute = new Date(Math.floor(Date.now() / 60_000) * 60_000)
		.toISOString();
	const notion = fakeNotion(
		[page('recent', thisMinute), page('settled', TS_NEW)],
		{ recent: [paragraph('R')], settled: [paragraph('S')] },
	);

	const first = await runPoll(new TestConnector(notion), { config: CONFIG });
	const second = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: first.committedState,
	});

	assert.deepEqual(updateIds(first.updates), [
		['upsert', 'recent'],
		['upsert', 'settled'],
	]);
	assert.deepEqual(updateIds(second.updates), [['upsert', 'recent']]);
});

Deno.test('a same-minute edit is not lost when the block fetch runs minutes after search', async () => {
	// The title comes from the search response; a slow page before it delays
	// its block fetch past the settle window, but the search data stays old.
	const realNow = Date.now;
	let now = Date.parse('2026-10-19T10:00:20.000Z');
	Date.now = () => now;
	try {
		const edited = '2026-10-19T10:00:00.000Z';
		let title = 'BEFORE EDIT';
		const fetchFn = (url: string) => {
			if (url.endsWith('/search')) {
				return Promise.resolve(jsonResponse({
					results: [
						page('slow', TS_NEW),
						page('target', edited, { properties: titleProperty(title) }),
					],
					has_more: false,
					next_cursor: null,
				}));
			}
			if (url.includes('/blocks/slow/')) {
				now += 3 * 60_000;
			}
			return Promise.resolve(jsonResponse({ results: [], has_more: false }));
		};

		const first = await runPoll(new TestConnector(fetchFn), { config: CONFIG });
		title = 'AFTER EDIT';
		now += 60_000;
		const second = await runPoll(new TestConnector(fetchFn), {
			config: CONFIG,
			lastState: first.committedState,
		});

		const titles = (run: { updates: unknown[] }) =>
			(run.updates as { doc: { id: string; title: string } }[])
				.filter((update) => update.doc.id === 'target')
				.map((update) => update.doc.title);
		assert.deepEqual(titles(first), ['BEFORE EDIT']);
		assert.deepEqual(titles(second), ['AFTER EDIT']);
	} finally {
		Date.now = realNow;
	}
});

Deno.test('a page listed twice in one poll is fetched once', async () => {
	const notion = fakeNotion(
		[page('a', TS_NEW), page('b', TS_NEW), page('a', TS_NEW)],
		{ a: [paragraph('A')], b: [paragraph('B')] },
	);

	const run = await runPoll(new TestConnector(notion), { config: CONFIG });

	assert.deepEqual(updateIds(run.updates), [
		['upsert', 'a'],
		['upsert', 'b'],
	]);
	assert.equal(
		notion.requests.filter((url) => url.includes('/blocks/a/')).length,
		1,
	);
	assert.deepEqual(run.committedState, {
		version: STATE_VERSION,
		pages: { a: TS_NEW, b: TS_NEW },
	});
});

Deno.test('a page edited during the search is fetched again', async () => {
	const TS_LATER = '2026-02-03T00:00:00.000Z';
	const notion = fakeNotion(
		[page('a', TS_NEW), page('a', TS_LATER)],
		{ a: [paragraph('A')] },
	);

	const run = await runPoll(new TestConnector(notion), { config: CONFIG });

	assert.deepEqual(updateIds(run.updates), [
		['upsert', 'a'],
		['upsert', 'a'],
	]);
	assert.deepEqual(run.committedState, {
		version: STATE_VERSION,
		pages: { a: TS_LATER },
	});
});

Deno.test('a cancelled poll deletes nothing and commits no state', async () => {
	const controller = new AbortController();
	const notion = fakeNotion([page('a', TS_NEW), page('b', TS_NEW)], {
		a: [paragraph('A')],
		b: [paragraph('B')],
	});
	const cancelling: FetchLike = (url, init) => {
		if (url.includes('/blocks/b/')) {
			controller.abort(new Error('cancelled by host'));
		}
		return notion(url, init);
	};

	const run = await runPoll(new TestConnector(cancelling), {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { old: TS_OLD } },
		signal: controller.signal,
	});

	assert.equal(run.outcome, 'cancelled');
	assert.ok(updateIds(run.updates).every(([kind]) => kind === 'upsert'));
	assert.equal(run.committedState, undefined);
});

Deno.test('poll skips archived pages entirely', async () => {
	const notion = fakeNotion([page('zzz', TS_NEW, { archived: true })]);

	const run = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: { zzz: TS_OLD } },
	});

	assert.deepEqual(updateIds(run.updates), [['delete', 'zzz']]);
	assert.deepEqual(run.committedState, { version: STATE_VERSION, pages: {} });
});

Deno.test('poll skips pages flagged is_archived (2026-03-11 field name)', async () => {
	const notion = fakeNotion([page('yyy', TS_NEW, { is_archived: true })]);

	const run = await runPoll(new TestConnector(notion), {
		config: CONFIG,
		lastState: { version: STATE_VERSION, pages: {} },
	});

	assert.deepEqual(run.updates, []);
});
