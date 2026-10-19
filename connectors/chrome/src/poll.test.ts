import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DocUpdate } from '@gety-ai/connector-sdk';
import { runPoll } from '@gety-connectors/testing';
import ChromeConnector, {
	bookmarkDocId,
	defaultChromeProfilePath,
	historyDocId,
} from './index.ts';

const WEBKIT_UNIX_OFFSET_MICROS = 11644473600000000n;
const DAY_MS = 86_400_000;

interface Row {
	url: string;
	daysAgo: number;
	hidden?: boolean;
	/** The one visit's transition; defaults to a link that ends its chain. */
	transition?: number;
	/** Explicit visits, replacing the default one at `daysAgo`. */
	visits?: { daysAgo: number; transition: number }[];
}

const CHAIN_START = 0x10000000;
const CHAIN_END = 0x20000000;
const LINK = 0;
const AUTO_SUBFRAME = 3;

type Update = DocUpdate;

function webkitDaysAgo(days: number): bigint {
	return BigInt(Date.now() - days * DAY_MS) * 1000n +
		WEBKIT_UNIX_OFFSET_MICROS;
}

/** A temp home with a Default profile whose History holds `rows`. */
function makeHome(rows: Row[]): { home: string; profile: string } {
	const home = mkdtempSync(join(tmpdir(), 'chrome-poll-test-'));
	const profile = join(
		home,
		...defaultChromeProfilePath(Deno.build.os).slice(2).split('/'),
	);
	mkdirSync(profile, { recursive: true });
	const db = new DatabaseSync(join(profile, 'History'));
	db.exec(
		`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT,
			visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER,
			hidden INTEGER);
		CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER,
			visit_time INTEGER, transition INTEGER)`,
	);
	const insertUrl = db.prepare(
		'INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, 1, 0, ?, ?)',
	);
	const insertVisit = db.prepare(
		'INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)',
	);
	db.exec('BEGIN');
	for (const row of rows) {
		const time = webkitDaysAgo(row.daysAgo);
		const { lastInsertRowid } = insertUrl.run(
			row.url,
			row.url,
			time,
			row.hidden ? 1 : 0,
		);
		const visits = row.visits ?? [{
			daysAgo: row.daysAgo,
			transition: row.transition ?? (LINK | CHAIN_START | CHAIN_END),
		}];
		for (const visit of visits) {
			insertVisit.run(
				lastInsertRowid,
				webkitDaysAgo(visit.daysAgo),
				visit.transition,
			);
		}
	}
	db.exec('COMMIT');
	db.close();
	return { home, profile };
}

function upsertedIds(updates: Update[]): string[] {
	return updates.flatMap((u) => u.kind === 'upsert' ? [u.doc.id] : []).sort();
}

function deletedIds(updates: Update[]): string[] {
	return updates.flatMap((u) => u.kind === 'delete' ? [u.id] : []).sort();
}

function ids(urls: string[]): string[] {
	return urls.map(historyDocId).sort();
}

const RECENT = ['https://a.example/', 'https://b.example/'];
const OLDER = [
	'https://c.example/',
	'https://d.example/',
	'https://e.example/',
];
const FIXTURE: Row[] = [
	{ url: RECENT[0], daysAgo: 1 },
	{ url: RECENT[1], daysAgo: 2 },
	{ url: OLDER[0], daysAgo: 20 },
	{ url: OLDER[1], daysAgo: 40 },
	{ url: OLDER[2], daysAgo: 60 },
];
const BASE_CONFIG = { index_bookmarks: false, history_skip_non_web: true };

Deno.test('poll backfills older history when the range is widened', async () => {
	const { home } = makeHome(FIXTURE);
	try {
		const first = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { ...BASE_CONFIG, history_range: '7d' },
		});
		assert.equal(first.outcome, 'done');
		assert.deepEqual(upsertedIds(first.updates), ids(RECENT));

		const widened = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { ...BASE_CONFIG, history_range: '90d' },
			lastState: first.committedState,
		});
		assert.equal(widened.outcome, 'done');
		// Every older row reaches the index, not just the cursor boundary.
		for (const id of ids(OLDER)) {
			assert.ok(upsertedIds(widened.updates).includes(id), id);
		}
		assert.deepEqual(deletedIds(widened.updates), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('poll backfills all history after it is disabled and re-enabled', async () => {
	const { home } = makeHome(FIXTURE);
	try {
		const config = { ...BASE_CONFIG, history_range: '90d' };
		const first = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config,
		});
		const off = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { ...config, index_history: false },
			lastState: first.committedState,
		});
		assert.deepEqual(
			deletedIds(off.updates),
			ids([...RECENT, ...OLDER]),
		);
		const on = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config,
			lastState: off.committedState,
		});
		assert.equal(on.outcome, 'done');
		assert.deepEqual(
			upsertedIds(on.updates),
			ids([...RECENT, ...OLDER]),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('a steady-state poll re-emits only rows at or after the cursor', async () => {
	const { home } = makeHome(FIXTURE);
	try {
		const config = { ...BASE_CONFIG, history_range: '90d' };
		const first = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config,
		});
		const second = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config,
			lastState: first.committedState,
		});
		assert.deepEqual(upsertedIds(second.updates), ids([RECENT[0]]));
		assert.deepEqual(deletedIds(second.updates), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('a missing profile fails the poll without deletes or a commit', async () => {
	const home = mkdtempSync(join(tmpdir(), 'chrome-poll-test-'));
	try {
		const run = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { history_range: '90d' },
			lastState: {
				history_ids: [historyDocId('https://a.example/')],
				bookmark_ids: [bookmarkDocId('g1')],
			},
		});
		assert.equal(run.outcome, 'error');
		assert.match(String(run.error), /Chrome profile not found/);
		assert.deepEqual(run.updates, []);
		assert.equal(run.committedState, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('a profile without a Bookmarks file deletes the indexed bookmarks', async () => {
	const { home } = makeHome([]);
	try {
		const run = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { history_range: '90d' },
			lastState: { bookmark_ids: [bookmarkDocId('g1')], history_ids: [] },
		});
		assert.equal(run.outcome, 'done');
		assert.deepEqual(deletedIds(run.updates), [
			bookmarkDocId('g1'),
		]);
		assert.deepEqual(run.committedState, { history_ids: [], bookmark_ids: [] });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

const MALFORMED_BOOKMARKS: Record<string, unknown> = {
	'no roots': { version: 1 },
	'array roots': { roots: [] },
	'root children not an array': {
		roots: { bookmark_bar: { type: 'folder', children: 'invalid' } },
	},
	'unknown node type': {
		roots: {
			bookmark_bar: {
				type: 'folder',
				children: [{ type: 'unknown', guid: 'g1' }],
			},
		},
	},
	'nested folder without children': {
		roots: {
			bookmark_bar: {
				type: 'folder',
				children: [
					{ type: 'url', guid: 'g2', url: 'https://ok.example/' },
					{
						type: 'folder',
						name: 'design',
						children: [{ type: 'folder', name: 'broken' }],
					},
				],
			},
		},
	},
};

for (const [name, payload] of Object.entries(MALFORMED_BOOKMARKS)) {
	Deno.test(`a Bookmarks file with ${name} fails instead of deleting`, async () => {
		const { home, profile } = makeHome([]);
		try {
			writeFileSync(join(profile, 'Bookmarks'), JSON.stringify(payload));
			const run = await runPoll(new ChromeConnector(), {
				homeDir: home,
				config: { history_range: '90d' },
				lastState: {
					bookmark_ids: [bookmarkDocId('g1'), bookmarkDocId('g2')],
					history_ids: [],
				},
			});
			assert.equal(run.outcome, 'error');
			assert.match(String(run.error), /Unrecognized Chrome Bookmarks format/);
			assert.deepEqual(run.updates, []);
			assert.equal(run.committedState, undefined);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}

Deno.test('only pages with a visible visit are indexed', async () => {
	const { home } = makeHome([
		{ url: 'https://shown.example/', daysAgo: 1 },
		// urls.hidden alone does not hide a page from Chrome's history list.
		{ url: 'https://hidden-flag.example/', daysAgo: 1, hidden: true },
		{
			url: 'https://frame.example/',
			daysAgo: 1,
			transition: AUTO_SUBFRAME | CHAIN_START | CHAIN_END,
		},
		{
			url: 'http://redirect-source.example/',
			daysAgo: 1,
			transition: LINK | CHAIN_START,
		},
	]);
	try {
		const run = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { ...BASE_CONFIG, history_range: '90d' },
		});
		assert.deepEqual(
			upsertedIds(run.updates),
			ids(['https://shown.example/', 'https://hidden-flag.example/']),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('a visible visit must fall within the range', async () => {
	const mixed = 'https://mixed.example/';
	const { home } = makeHome([
		{ url: 'https://anchor.example/', daysAgo: 1 },
		{
			url: mixed,
			daysAgo: 2,
			visits: [
				{ daysAgo: 40, transition: LINK | CHAIN_START | CHAIN_END },
				{ daysAgo: 2, transition: AUTO_SUBFRAME | CHAIN_START | CHAIN_END },
			],
		},
	]);
	const [mixedId] = ids([mixed]);
	try {
		let lastState: unknown = null;
		const poll = async (range: string) => {
			const run = await runPoll(new ChromeConnector(), {
				homeDir: home,
				config: { ...BASE_CONFIG, history_range: range },
				lastState,
			});
			assert.equal(run.outcome, 'done');
			lastState = run.committedState;
			return run.updates;
		};
		// Only a subframe visit is inside 7 days.
		assert.ok(!upsertedIds(await poll('7d')).includes(mixedId));
		// Widened: backfilled although its last visit is below the cursor.
		assert.ok(upsertedIds(await poll('90d')).includes(mixedId));
		assert.deepEqual(deletedIds(await poll('7d')), [mixedId]);
		assert.ok(upsertedIds(await poll('90d')).includes(mixedId));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('only the final batch carries state', async () => {
	const rows = Array.from({ length: 1200 }, (_, i) => ({
		url: `https://row${i}.example/`,
		daysAgo: 1 + i / 10_000,
	}));
	const { home } = makeHome(rows);
	try {
		const run = await runPoll(new ChromeConnector(), {
			homeDir: home,
			config: { ...BASE_CONFIG, history_range: '90d' },
		});
		assert.equal(run.outcome, 'done');
		assert.ok(run.batches.length >= 3);
		const withState = run.batches.flatMap((b, i) =>
			Object.hasOwn(b, 'state') ? [i] : []
		);
		assert.deepEqual(withState, [run.batches.length - 1]);
		assert.equal(upsertedIds(run.updates).length, 1200);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

Deno.test('aborting mid-scan ends the poll without deletes', async () => {
	const rows = Array.from({ length: 1200 }, (_, i) => ({
		url: `https://row${i}.example/`,
		daysAgo: 1 + i / 10_000,
	}));
	const { home } = makeHome(rows);
	try {
		const controller = new AbortController();
		const connector = new ChromeConnector();
		// Drive poll() directly: runPoll drops batches after an abort, and
		// this test is about what the connector still emits.
		Object.assign(connector, {
			config: { ...BASE_CONFIG, history_range: '90d' },
			lastState: { history_ids: ids(rows.map((r) => r.url)), bookmark_ids: [] },
			signal: controller.signal,
			homeDir: home,
		});
		const after: Update[] = [];
		let first = true;
		for await (const batch of connector.poll()) {
			if (first) {
				first = false;
				controller.abort();
				continue;
			}
			after.push(...(batch.updates));
		}
		assert.deepEqual(deletedIds(after), []);
		assert.deepEqual(after, []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
