import assert from 'node:assert/strict';
import { IncompleteEnumerationError } from '@gety-connectors/utils/paginate';
import type { Logger } from '@gety-connectors/utils/log';
import {
	extractDocContent,
	extractSearchPage,
	isConfirmedGone,
	isoFromLarkTime,
	isRetryableFailure,
	LarkCliClient,
	LarkCliError,
	LarkCliTimeoutError,
	LarkCliUnavailableError,
	normalizeSourceTime,
	stripHighlightTags,
} from './lark_cli.ts';
import { fail, installFakeLarkCli, ok } from './testdata/fake_cli.ts';

Deno.test('isoFromLarkTime parses local minute timestamps', () => {
	const iso = isoFromLarkTime('2026-07-10 11:22');
	assert.ok(iso != null);
	assert.equal(
		new Date(iso).getTime(),
		new Date('2026-07-10T11:22:00').getTime(),
	);

	const withSeconds = isoFromLarkTime('2026-07-10 11:22:33');
	assert.ok(withSeconds != null);
	assert.equal(
		new Date(withSeconds).getTime(),
		new Date('2026-07-10T11:22:33').getTime(),
	);

	assert.equal(isoFromLarkTime(undefined), undefined);
	assert.equal(isoFromLarkTime('not a date'), undefined);
});

Deno.test('normalizeSourceTime handles unix seconds and milliseconds', () => {
	assert.equal(normalizeSourceTime(1752105600), '2025-07-10T00:00:00.000Z');
	assert.equal(normalizeSourceTime('1752105600'), '2025-07-10T00:00:00.000Z');
	assert.equal(
		normalizeSourceTime(1752105600000),
		'2025-07-10T00:00:00.000Z',
	);
	assert.equal(normalizeSourceTime(null), undefined);
});

Deno.test('stripHighlightTags removes search highlight markup', () => {
	assert.equal(stripHighlightTags('<em>Gety</em> roadmap'), 'Gety roadmap');
	assert.equal(stripHighlightTags('plain title'), 'plain title');
});

Deno.test('extractSearchPage maps doc_wiki search entities', () => {
	const page = extractSearchPage({
		results: [
			{
				entity_type: 'DOC',
				result_meta: {
					token: 'doxcnAAAA',
					doc_types: 'DOCX',
					create_time: 1752019200,
					create_time_iso: '2025-07-09T08:00:00+08:00',
					update_time: 1752105600,
					update_time_iso: '2025-07-10T08:00:00+08:00',
					owner_name: 'Channing',
					url: 'https://example.feishu.cn/docx/doxcnAAAA',
				},
				title_highlighted: '<h>Release</h> plan',
			},
			{ result_meta: {}, title_highlighted: 'missing token, skipped' },
		],
		has_more: true,
		page_token: 'next',
	});

	assert.equal(page.entities.length, 1);
	assert.deepEqual(page.entities[0], {
		token: 'doxcnAAAA',
		type: 'docx',
		title: 'Release plan',
		editedAt: '2025-07-10T00:00:00.000Z',
		createdAt: '2025-07-09T00:00:00.000Z',
		url: 'https://example.feishu.cn/docx/doxcnAAAA',
		owner: 'Channing',
	});
	assert.equal(page.hasMore, true);
	assert.equal(page.pageToken, 'next');
});

Deno.test('extractSearchPage reads a null result list as empty and rejects unknown shapes', () => {
	assert.deepEqual(extractSearchPage({ results: null, has_more: false }), {
		entities: [],
		hasMore: false,
		pageToken: undefined,
	});
	// An unrecognized page must not read as "no documents": that would
	// delete the whole index.
	for (const data of [null, { unexpected: true }, { results: {} }]) {
		assert.throws(
			() => extractSearchPage(data),
			IncompleteEnumerationError,
		);
	}
});

Deno.test('search results without an original URL do not invent a display link', () => {
	const page = extractSearchPage({
		results: [{ result_meta: { token: 'doc', doc_types: 'DOCX' } }],
	});
	assert.equal(page.entities[0].url, undefined);
});

class ApiClient extends LarkCliClient {
	args: string[] = [];
	constructor(private reply: unknown) {
		super('unused', new AbortController().signal);
	}
	protected override run(args: string[]): Promise<unknown> {
		this.args = args;
		return Promise.resolve(this.reply);
	}
}

Deno.test('raw metadata API unwraps business responses and sends the user identity', async () => {
	const client = new ApiClient({
		code: 0,
		data: {
			node: { node_token: 'wiki', obj_token: 'doc', parent_node_token: '' },
		},
	});
	const node = await client.getWikiNode('doc', 'docx');
	assert.equal(node.node_token, 'wiki');
	assert.equal(node.obj_token, 'doc');
	assert.equal(node.parent_node_token, undefined);
	assert.deepEqual(client.args.slice(0, 7), [
		'api',
		'GET',
		'/open-apis/wiki/v2/spaces/get_node',
		'--as',
		'user',
		'--format',
		'json',
	]);
	assert.deepEqual(JSON.parse(client.args[8]), {
		token: 'doc',
		obj_type: 'docx',
	});
	const failure = new ApiClient({ code: 131014, msg: 'not mounted' });
	await assert.rejects(
		failure.getWikiNode('doc'),
		(error: unknown) =>
			error instanceof LarkCliError && error.code === '131014',
	);
});

Deno.test('Drive metadata API preserves pagination and rejects malformed success payloads', async () => {
	const client = new ApiClient({
		files: [{
			token: 'doc',
			type: 'docx',
			name: 'Spec',
			parent_token: 'folder',
			url: 'https://team.feishu.cn/docx/doc',
		}],
		has_more: true,
		next_page_token: 'next',
	});
	const page = await client.listDriveFiles('folder', 'page');
	assert.equal(page.pageToken, 'next');
	assert.equal(page.files[0].parent_token, 'folder');
	assert.deepEqual(JSON.parse(client.args[8]), {
		page_size: 200,
		folder_token: 'folder',
		page_token: 'page',
	});
	await assert.rejects(new ApiClient({}).listDriveFiles(), /no file list/);
});

Deno.test('extractDocContent finds markdown in nested payloads', () => {
	assert.equal(extractDocContent('# Title'), '# Title');
	assert.equal(extractDocContent({ content: '# Title' }), '# Title');
	assert.equal(
		extractDocContent({ document: { markdown: '# Nested' } }),
		'# Nested',
	);
	assert.equal(extractDocContent({ content: '   ' }), null);
	assert.equal(extractDocContent(42), null);
});

Deno.test('isRetryableFailure matches rate limits and errors marked retryable', () => {
	assert.equal(
		isRetryableFailure({
			ok: false,
			error: { type: 'api', subtype: 'rate_limit', message: 'slow down' },
		}),
		true,
	);
	assert.equal(
		isRetryableFailure({
			ok: false,
			error: { message: 'HTTP 429 Too Many Requests' },
		}),
		true,
	);
	assert.equal(
		isRetryableFailure({
			ok: false,
			error: { type: 'network', message: 'connection reset', retryable: true },
		}),
		true,
	);
	assert.equal(
		isRetryableFailure({
			ok: false,
			error: { type: 'authorization', message: 'missing scope' },
		}),
		false,
	);
	assert.equal(isRetryableFailure(null), false);
	assert.equal(isRetryableFailure({ ok: false }), false);
});

Deno.test('only not_found and permission_denied confirm a document is gone', () => {
	const error = (type: string, subtype: string) =>
		new LarkCliError('failed', { type, subtype });
	assert.equal(isConfirmedGone(error('api', 'not_found')), true);
	assert.equal(
		isConfirmedGone(error('authorization', 'permission_denied')),
		true,
	);
	assert.equal(isConfirmedGone(error('api', 'unknown')), false);
	assert.equal(isConfirmedGone(error('authorization', 'missing_scope')), false);
	assert.equal(isConfirmedGone(error('network', 'timeout')), false);
	assert.equal(isConfirmedGone(new Error('not found')), false);
});

async function fakeCli(
	rules: Parameters<typeof installFakeLarkCli>[1]['rules'],
) {
	return await installFakeLarkCli(
		await Deno.makeTempDir({ prefix: 'lark-cli-test-' }),
		{ rules },
	);
}

const FAST = { retryBaseDelayMs: 1 };

Deno.test('the CLI client parses success and error envelopes of the real binary', async () => {
	const fake = await fakeCli([
		{ cmd: 'im +chat-list', responses: [ok({ chats: null, has_more: false })] },
		{
			cmd: 'docs +fetch',
			responses: [fail({
				type: 'authorization',
				subtype: 'missing_scope',
				message: 'missing scope',
				missing_scopes: ['docx:document:readonly'],
			})],
		},
	]);
	const client = new LarkCliClient(
		fake.bin,
		new AbortController().signal,
		FAST,
	);
	assert.deepEqual(await client.listChats(), {
		chats: [],
		hasMore: false,
		pageToken: undefined,
	});
	await assert.rejects(client.fetchDocMarkdown('doc'), (error: unknown) => {
		assert.ok(error instanceof LarkCliError);
		assert.deepEqual(error.missingScopes, ['docx:document:readonly']);
		assert.equal(error.type, 'authorization');
		assert.equal(error.subtype, 'missing_scope');
		return true;
	});
	assert.equal((await fake.calls()).length, 2);
});

Deno.test('the CLI client retries rate limits and then succeeds', async () => {
	const fake = await fakeCli([{
		cmd: 'im +chat-list',
		responses: [
			fail({ type: 'api', subtype: 'rate_limit', message: 'slow down' }),
			ok({ chats: [{ chat_id: 'oc_1', name: 'Team' }], has_more: false }),
		],
	}]);
	const client = new LarkCliClient(
		fake.bin,
		new AbortController().signal,
		FAST,
	);
	const page = await client.listChats();
	assert.deepEqual(page.chats.map((chat) => chat.chat_id), ['oc_1']);
	assert.equal((await fake.calls()).length, 2);
});

// The backoff is a real wait inside utils retry (it has no clock seam), so
// where the log lines fall against it is measured on the platform clock.
Deno.test('a retry is logged before its backoff wait and again when its attempt starts', async () => {
	const fake = await fakeCli([{
		cmd: 'im +chat-list',
		responses: [
			fail({
				type: 'api',
				subtype: 'rate_limit',
				message: 'slow down',
				retry_after_seconds: 1,
			}),
			ok({ chats: null, has_more: false }),
		],
	}]);
	const logged: number[] = [];
	const logger: Logger = {
		info: () => logged.push(Date.now()),
		warn: () => {},
		warnOnce: () => {},
		progress: () => {},
	};
	const client = new LarkCliClient(fake.bin, new AbortController().signal, {
		logger,
	});
	await client.listChats();
	const [first, second] = await fake.callTimes();
	assert.equal(logged.length, 2);
	// Without a line before the wait, a slow failed call plus the wait would
	// be silent; without one after it, the wait plus the next call would.
	assert.ok(
		second - logged[0] >= 900,
		`wait logged ${second - logged[0]}ms early`,
	);
	assert.ok(
		logged[0] - first < 900,
		`failure logged ${logged[0] - first}ms in`,
	);
	assert.ok(
		logged[1] - first >= 900,
		`attempt logged ${logged[1] - first}ms in`,
	);
	assert.ok(
		second - logged[1] < 900,
		`call started ${second - logged[1]}ms on`,
	);
});

// The timeout is the wall-clock kill of a real subprocess, so it is exercised
// with a real (short) budget against a fake that hangs.
Deno.test('a hung CLI call is killed at its timeout and retried once', async () => {
	const fake = await fakeCli([{
		cmd: 'im +chat-list',
		responses: [{ sleepMs: 30_000, stdout: '' }],
	}]);
	const client = new LarkCliClient(fake.bin, new AbortController().signal, {
		...FAST,
		timeoutMs: 500,
	});
	const started = Date.now();
	await assert.rejects(client.listChats(), LarkCliTimeoutError);
	assert.ok(Date.now() - started < 10_000);
	assert.equal((await fake.calls()).length, 2);
});

Deno.test('a cancelled poll kills the CLI call and does not retry it', async () => {
	const fake = await fakeCli([{
		cmd: 'im +chat-list',
		responses: [{ sleepMs: 30_000, stdout: '' }],
	}]);
	const controller = new AbortController();
	const client = new LarkCliClient(fake.bin, controller.signal, FAST);
	const watcher = Deno.watchFs(fake.dir);
	const started = Date.now();
	const pending = client.listChats();
	// Cancel once the fake has started (it logs the call, then hangs).
	for await (const event of watcher) {
		if (event.paths.some((path) => path.endsWith('calls.jsonl'))) break;
	}
	controller.abort(new Error('cancelled'));
	await assert.rejects(pending, /cancelled/);
	assert.ok(Date.now() - started < 10_000);
	assert.equal((await fake.calls()).length, 1);
});

Deno.test('a missing binary is reported as unavailable, not as an API failure', async () => {
	const client = new LarkCliClient(
		`lark-cli-missing-${crypto.randomUUID()}`,
		new AbortController().signal,
		FAST,
	);
	await assert.rejects(client.listChats(), LarkCliUnavailableError);
});

Deno.test('a list command with an unknown output shape fails instead of reading as empty', async () => {
	const fake = await fakeCli([
		{ cmd: 'im +chat-list', responses: [ok({ items: [] })] },
		{ cmd: 'im +chat-messages-list', responses: [ok({ messages: 'x' })] },
	]);
	const client = new LarkCliClient(
		fake.bin,
		new AbortController().signal,
		FAST,
	);
	await assert.rejects(client.listChats(), IncompleteEnumerationError);
	await assert.rejects(
		client.listMessages('oc_1', '2026-01-01T00:00:00.000Z'),
		IncompleteEnumerationError,
	);
});
