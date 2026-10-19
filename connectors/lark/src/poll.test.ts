/**
 * End-to-end polls through the host semantics of `runPoll`, against the real
 * lark-cli process boundary (a fake executable) or, for scale, an in-process
 * client.
 */

import assert from 'node:assert/strict';
import { runPoll, startFrameBytes } from '@gety-connectors/testing';
import type { DocUpdate } from '@gety-ai/connector-sdk';
import LarkConnector, {
	type LarkState,
	localDateString,
	weekStartDay,
} from './index.ts';
import {
	type DrivePage,
	LarkCliClient,
	type SearchEntity,
	type WikiNode,
} from './lark_cli.ts';
import {
	fail,
	type FakeRule,
	installFakeLarkCli,
	ok,
} from './testdata/fake_cli.ts';

class BinConnector extends LarkConnector {
	constructor(private readonly bin: string) {
		super();
	}

	protected override createClient(): LarkCliClient {
		return new LarkCliClient(this.bin, this.signal);
	}
}

// A recent day that is not a Monday, so its week and day doc keys differ.
const messageDate = new Date();
messageDate.setDate(
	messageDate.getDate() - (messageDate.getDay() === 2 ? 2 : 1),
);
const MESSAGE_DAY = localDateString(messageDate);

function searchResult(token: string, title: string) {
	return {
		entity_type: 'DOC',
		result_meta: {
			token,
			doc_types: 'DOCX',
			create_time: 1752019200,
			update_time: 1752105600,
			url: `https://example.larksuite.com/docx/${token}`,
		},
		title_highlighted: title,
	};
}

const DOC_URL_B = 'https://example.larksuite.com/docx/doxcnBBBB';

function scenario(overrides: FakeRule[] = []): FakeRule[] {
	return [
		...overrides,
		{
			cmd: 'drive +search',
			when: { '--sort': null },
			responses: [ok({
				results: [
					searchResult('doxcnAAAA', '发布计划'),
					searchResult('doxcnBBBB', '周报'),
				],
				has_more: false,
			})],
		},
		{
			cmd: 'drive +search',
			when: { '--sort': 'edit_time' },
			responses: [ok({
				results: [searchResult('doxcnBBBB', '周报')],
				has_more: false,
			})],
		},
		{
			cmd: 'docs +fetch',
			responses: [ok({ document: { content: '# 正文' } })],
		},
		{
			cmd: 'api GET',
			responses: [{
				stdout: { code: 0, data: { files: [], has_more: false } },
			}],
		},
		{
			cmd: 'im +chat-list',
			responses: [ok({
				chats: [{
					chat_id: 'oc_1',
					name: 'Team',
					chat_mode: 'group',
					chat_app_link:
						'https://applink.larksuite.com/client/chat/open?openChatId=oc_1',
				}],
				has_more: false,
			})],
		},
		{
			cmd: 'im +chat-messages-list',
			responses: [ok({
				messages: [{
					message_id: 'om_1',
					create_time: `${MESSAGE_DAY} 10:00`,
					sender: { name: 'Ann', sender_type: 'user' },
					content: 'hello',
					msg_type: 'text',
				}],
				has_more: false,
			})],
		},
	];
}

function config(grouping: 'week' | 'day' | 'chat', bin: string) {
	// `lark_cli_path` keeps the test runnable against 0.1.x for regression
	// checks; the current connector ignores it.
	return {
		index_chat_history: true,
		chat_grouping: grouping,
		chat_history_days: 30,
		lark_cli_path: bin,
	};
}

const ids = (updates: DocUpdate[]) =>
	updates.map((update) =>
		`${update.kind}:${update.kind === 'upsert' ? update.doc.id : update.id}`
	).sort();

async function setup(rules: FakeRule[]) {
	const dir = await Deno.makeTempDir({ prefix: 'lark-poll-test-' });
	const fake = await installFakeLarkCli(`${dir}/cli`, { rules });
	await Deno.mkdir(`${dir}/data`);
	return { fake, dataDir: `${dir}/data` };
}

Deno.test('a full poll indexes docs and chats, commits state once, and an unchanged poll uploads nothing', async () => {
	const { fake, dataDir } = await setup(scenario());
	const first = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		dataDir,
	});
	assert.equal(first.outcome, 'done', String(first.error));
	const chatUpdates = first.updates.filter((update) =>
		update.kind === 'upsert' && update.doc.doc_type === 'feishu:chat'
	);
	assert.deepEqual(
		ids(first.updates).filter((id) => id.includes(':doc:')),
		['upsert:feishu:doc:doxcnAAAA', 'upsert:feishu:doc:doxcnBBBB'],
	);
	assert.equal(chatUpdates.length, 1);
	const chat = chatUpdates[0];
	const metadata = chat.kind === 'upsert' ? chat.doc.metadata : null;
	// The tenant is Lark, not Feishu: the link comes from lark-cli.
	assert.ok(
		metadata != null && typeof metadata === 'object' &&
			!Array.isArray(metadata) && typeof metadata.url === 'string' &&
			metadata.url.startsWith('https://applink.larksuite.com/'),
	);
	// The host commits state only when the poll succeeds, so carrying it in
	// intermediate batches only costs frame bytes.
	assert.deepEqual(
		first.batches.map((batch) => Object.hasOwn(batch, 'state')),
		[...first.batches.slice(1).map(() => false), true],
	);

	const second = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		lastState: first.committedState,
		dataDir,
	});
	assert.equal(second.outcome, 'done', String(second.error));
	assert.deepEqual(ids(second.updates), []);
});

Deno.test('a failing chat list skips chats but still commits the documents', async () => {
	const { fake, dataDir } = await setup(scenario([{
		cmd: 'im +chat-list',
		responses: [
			fail({ type: 'api', subtype: 'server_error', message: 'boom' }),
		],
	}]));
	const run = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		dataDir,
	});
	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(ids(run.updates), [
		'upsert:feishu:doc:doxcnAAAA',
		'upsert:feishu:doc:doxcnBBBB',
	]);
	// runPoll hands back the committed state as the connector yielded it.
	const state = run.committedState as LarkState;
	assert.deepEqual(Object.keys(state.docs ?? {}).sort(), [
		'doxcnAAAA',
		'doxcnBBBB',
	]);
});

for (
	const [label, failure, deleted] of [
		['not found', { type: 'api', subtype: 'not_found', message: 'gone' }, true],
		[
			'a network error',
			{ type: 'network', message: 'connection reset' },
			false,
		],
	] as const
) {
	Deno.test(
		`a document missing from search is ${
			deleted ? 'deleted' : 'kept'
		} when fetching it fails with ${label}`,
		async () => {
			const searchOnlyA = ok({
				results: [searchResult('doxcnAAAA', '发布计划')],
				has_more: false,
			});
			const { fake, dataDir } = await setup(scenario([{
				cmd: 'docs +fetch',
				when: { '--doc': DOC_URL_B },
				responses: [ok({ document: { content: '# 周报' } }), fail(failure)],
			}]));
			const cfg = { ...config('week', fake.bin), index_chat_history: false };
			const first = await runPoll(new BinConnector(fake.bin), {
				config: cfg,
				dataDir,
			});
			assert.equal(first.outcome, 'done', String(first.error));
			await fake.setScenario({
				rules: scenario([
					{
						cmd: 'docs +fetch',
						when: { '--doc': DOC_URL_B },
						responses: [fail(failure)],
					},
					{ cmd: 'drive +search', responses: [searchOnlyA] },
				]),
			});
			const second = await runPoll(new BinConnector(fake.bin), {
				config: cfg,
				lastState: first.committedState,
				dataDir,
			});
			assert.equal(second.outcome, 'done', String(second.error));
			assert.deepEqual(
				ids(second.updates),
				deleted ? ['delete:feishu:doc:doxcnBBBB'] : [],
			);
			const committed = second.committedState as LarkState;
			const docs = committed.docs ?? {};
			assert.equal(Object.hasOwn(docs, 'doxcnBBBB'), !deleted);
		},
	);
}

class FatalChatsClient extends LarkCliClient {
	override listChats(): Promise<never> {
		return Promise.reject(new Deno.errors.NotCapable('run access denied'));
	}
}

class FatalChatsConnector extends LarkConnector {
	constructor(private readonly bin: string) {
		super();
	}

	protected override createClient(): LarkCliClient {
		return new FatalChatsClient(this.bin, this.signal);
	}
}

Deno.test('a poll that fails after deciding a deletion emits no delete', async () => {
	const { fake, dataDir } = await setup(scenario([{
		cmd: 'docs +fetch',
		when: { '--doc': DOC_URL_B },
		responses: [
			ok({ document: { content: '# 周报' } }),
			fail({ type: 'api', subtype: 'not_found', message: 'gone' }),
		],
	}]));
	const first = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		dataDir,
	});
	assert.equal(first.outcome, 'done', String(first.error));
	await fake.setScenario({
		rules: scenario([
			{
				cmd: 'docs +fetch',
				when: { '--doc': DOC_URL_B },
				responses: [fail({ type: 'api', subtype: 'not_found', message: 'x' })],
			},
			{
				cmd: 'drive +search',
				responses: [ok({
					results: [searchResult('doxcnAAAA', '发布计划')],
					has_more: false,
				})],
			},
		]),
	});
	const failed = await runPoll(new FatalChatsConnector(fake.bin), {
		config: config('week', fake.bin),
		lastState: first.committedState,
		dataDir,
	});
	// The state that would record the deletion is never committed, so the
	// deletion must not reach the index either.
	assert.equal(failed.outcome, 'error');
	assert.deepEqual(
		ids(failed.updates).filter((id) => id.startsWith('delete:')),
		[],
	);
});

const WEEK_DOC = `feishu:chat:oc_1:${weekStartDay(MESSAGE_DAY)}`;
const DAY_DOC = `feishu:chat:oc_1:${MESSAGE_DAY}`;

for (
	const [label, failure] of [
		['the chat list fails', {
			cmd: 'im +chat-list',
			responses: [fail({ type: 'api', subtype: 'server_error', message: 'x' })],
		}],
		['the chat list has an unknown shape', {
			cmd: 'im +chat-list',
			responses: [ok({ items: [] })],
		}],
		['a chat fails to list its messages', {
			cmd: 'im +chat-messages-list',
			responses: [fail({ type: 'api', subtype: 'server_error', message: 'x' })],
		}],
		['a chat row has no chat_id', {
			cmd: 'im +chat-list',
			responses: [ok({ chats: [{ id: 'oc_1' }], has_more: false })],
		}],
		['a message row is not an object', {
			cmd: 'im +chat-messages-list',
			responses: [ok({ messages: [42], has_more: false })],
		}],
		['a live message row has no id or time', {
			cmd: 'im +chat-messages-list',
			responses: [ok({ messages: [{}], has_more: false })],
		}],
	] satisfies [string, FakeRule][]
) {
	Deno.test(`a grouping change keeps the old chat docs while ${label}`, async () => {
		const { fake, dataDir } = await setup(scenario());
		const first = await runPoll(new BinConnector(fake.bin), {
			config: config('week', fake.bin),
			dataDir,
		});
		assert.equal(first.outcome, 'done', String(first.error));
		assert.ok(ids(first.updates).includes(`upsert:${WEEK_DOC}`));

		await fake.setScenario({ rules: scenario([failure]) });
		const degraded = await runPoll(new BinConnector(fake.bin), {
			config: config('day', fake.bin),
			lastState: first.committedState,
			dataDir,
		});
		assert.equal(degraded.outcome, 'done', String(degraded.error));
		assert.deepEqual(
			ids(degraded.updates).filter((id) => id.startsWith('delete:')),
			[],
		);

		await fake.setScenario({ rules: scenario() });
		const rebuilt = await runPoll(new BinConnector(fake.bin), {
			config: config('day', fake.bin),
			lastState: degraded.committedState,
			dataDir,
		});
		assert.equal(rebuilt.outcome, 'done', String(rebuilt.error));
		const updates = ids(rebuilt.updates);
		assert.ok(updates.includes(`delete:${WEEK_DOC}`), updates.join());
		assert.ok(
			ids([...degraded.updates, ...rebuilt.updates]).includes(
				`upsert:${DAY_DOC}`,
			),
		);
	});
}

Deno.test('a deleted-message tombstone does not hold back a grouping change', async () => {
	const { fake, dataDir } = await setup(scenario());
	const first = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		dataDir,
	});
	assert.equal(first.outcome, 'done', String(first.error));
	await fake.setScenario({
		rules: scenario([{
			cmd: 'im +chat-messages-list',
			responses: [ok({
				messages: [
					{ message_id: '', deleted: true },
					{
						message_id: 'om_1',
						create_time: `${MESSAGE_DAY} 10:00`,
						sender: { name: 'Ann', sender_type: 'user' },
						content: 'hello',
					},
				],
				has_more: false,
			})],
		}]),
	});
	const daily = await runPoll(new BinConnector(fake.bin), {
		config: config('day', fake.bin),
		lastState: first.committedState,
		dataDir,
	});
	assert.equal(daily.outcome, 'done', String(daily.error));
	const updates = ids(daily.updates);
	assert.ok(updates.includes(`upsert:${DAY_DOC}`), updates.join());
	assert.ok(updates.includes(`delete:${WEEK_DOC}`), updates.join());
});

Deno.test('switching back after a partial grouping change orphans no replacement doc', async () => {
	const twoChats: FakeRule = {
		cmd: 'im +chat-list',
		responses: [ok({
			chats: [
				{ chat_id: 'oc_1', name: 'Team', chat_mode: 'group' },
				{ chat_id: 'oc_2', name: 'Ops', chat_mode: 'group' },
			],
			has_more: false,
		})],
	};
	const oc2Fails: FakeRule = {
		cmd: 'im +chat-messages-list',
		when: { '--chat-id': 'oc_2' },
		responses: [fail({ type: 'api', subtype: 'server_error', message: 'x' })],
	};
	const { fake, dataDir } = await setup(scenario([twoChats]));
	const weekly = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		dataDir,
	});
	assert.equal(weekly.outcome, 'done', String(weekly.error));

	await fake.setScenario({ rules: scenario([oc2Fails, twoChats]) });
	const partial = await runPoll(new BinConnector(fake.bin), {
		config: config('day', fake.bin),
		lastState: weekly.committedState,
		dataDir,
	});
	assert.equal(partial.outcome, 'done', String(partial.error));
	assert.ok(ids(partial.updates).includes(`upsert:${DAY_DOC}`));

	await fake.setScenario({ rules: scenario([twoChats]) });
	const back = await runPoll(new BinConnector(fake.bin), {
		config: config('week', fake.bin),
		lastState: partial.committedState,
		dataDir,
	});
	assert.equal(back.outcome, 'done', String(back.error));
	// The day doc written by the partial poll is removed; the weekly docs,
	// rebuilt under their old ids, are not.
	assert.deepEqual(
		ids(back.updates).filter((id) => id.startsWith('delete:')),
		[`delete:${DAY_DOC}`],
	);
});

Deno.test('whole-chat docs are not refetched while the chat has no new message', async () => {
	const { fake, dataDir } = await setup(scenario());
	const cfg = config('chat', fake.bin);
	const first = await runPoll(new BinConnector(fake.bin), {
		config: cfg,
		dataDir,
	});
	assert.equal(first.outcome, 'done', String(first.error));
	const before = (await fake.calls()).length;
	const second = await runPoll(new BinConnector(fake.bin), {
		config: cfg,
		lastState: first.committedState,
		dataDir,
	});
	assert.equal(second.outcome, 'done', String(second.error));
	assert.deepEqual(ids(second.updates), []);
	const messageCalls = (await fake.calls()).slice(before).filter((args) =>
		args[1] === '+chat-messages-list'
	);
	// One probe from the newest indexed message's day, not a refetch of the
	// 30-day lookback window.
	assert.equal(messageCalls.length, 1);
	const start = messageCalls[0][messageCalls[0].indexOf('--start') + 1];
	assert.equal(start, new Date(`${MESSAGE_DAY}T00:00:00`).toISOString());
});

/** An in-process client: a 20k-doc wiki is too slow through subprocesses. */
class LargeWikiClient extends LarkCliClient {
	constructor(private readonly count: number) {
		super('unused', new AbortController().signal);
	}

	override withSignal(): LarkCliClient {
		return this;
	}

	override searchDocs(
		options: { sortByEditTime?: boolean; pageToken?: string } = {},
	) {
		if (options.sortByEditTime) {
			return Promise.resolve({ entities: [], hasMore: false });
		}
		const start = Number(options.pageToken ?? 0);
		const end = Math.min(start + 500, this.count);
		const entities: SearchEntity[] = [];
		for (let i = start; i < end; i++) {
			entities.push({
				token: `doxcn${String(i).padStart(22, '0')}`,
				type: 'docx',
				title: `第${i}号设计文档：搜索索引与同步协议说明`,
				editedAt: '2026-07-01T00:00:00.000Z',
				createdAt: '2026-01-01T00:00:00.000Z',
				url: `https://team.feishu.cn/wiki/wikcn${String(i).padStart(22, '0')}`,
				owner: '张三',
			});
		}
		return Promise.resolve({
			entities,
			hasMore: end < this.count,
			...(end < this.count ? { pageToken: String(end) } : {}),
		});
	}

	override getWikiNode(token: string): Promise<WikiNode> {
		const leaf = /^wikcn(\d+)$/.exec(token);
		if (leaf != null) {
			const i = Number(leaf[1]);
			return Promise.resolve({
				node_token: token,
				obj_token: `doxcn${leaf[1]}`,
				space_id: '7000000000000000001',
				parent_node_token: `wikcnsection${i % 400}`,
			});
		}
		const section = /^wikcnsection(\d+)$/.exec(token);
		if (section != null) {
			return Promise.resolve({
				node_token: token,
				space_id: '7000000000000000001',
				title: `第${section[1]}章 产品与工程规范`,
				parent_node_token: `wikcnpart${Number(section[1]) % 20}`,
			});
		}
		return Promise.resolve({
			node_token: token,
			space_id: '7000000000000000001',
			title: `${token.slice(9)}部分 研发知识库总览`,
		});
	}

	override getWikiSpaceName(): Promise<string | undefined> {
		return Promise.resolve('研发知识库');
	}

	override listDriveFiles(): Promise<DrivePage> {
		return Promise.resolve({ files: [], hasMore: false });
	}

	override fetchDocMarkdown(): Promise<string | null> {
		return Promise.resolve('# 正文\n\n同步协议说明。');
	}
}

class LargeWikiConnector extends LarkConnector {
	protected override createClient(): LarkCliClient {
		return new LargeWikiClient(20_000);
	}
}

Deno.test('a 20k-document wiki keeps the committed state far below the StartFrame budget', async () => {
	const dataDir = await Deno.makeTempDir({ prefix: 'lark-poll-test-' });
	const cfg = {
		index_chat_history: false,
		chat_grouping: 'week',
		chat_history_days: 30,
		lark_cli_path: 'unused',
	} as const;
	const first = await runPoll(new LargeWikiConnector(), {
		config: cfg,
		dataDir,
	});
	assert.equal(first.outcome, 'done', String(first.error));
	assert.equal(first.updates.length, 20_000);
	const bytes = startFrameBytes(cfg, first.committedState, { dataDir });
	// Tokens, fetch refs and signatures only; source positions (with their
	// ancestor paths) live in the data directory.
	assert.ok(bytes < 5 * 1024 * 1024, `StartFrame is ${bytes} bytes`);
	const second = await runPoll(new LargeWikiConnector(), {
		config: cfg,
		lastState: first.committedState,
		dataDir,
	});
	assert.equal(second.outcome, 'done', String(second.error));
	assert.equal(second.updates.length, 0);
});
