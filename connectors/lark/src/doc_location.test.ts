import assert from 'node:assert/strict';
import { runPoll } from '@gety-connectors/testing';
import LarkConnector, { buildCloudDoc, type LarkState } from './index.ts';
import { type CloudPosition, DocLocationResolver } from './doc_location.ts';
import {
	type DrivePage,
	LarkCliClient,
	LarkCliError,
	type SearchEntity,
	type WikiNode,
} from './lark_cli.ts';

class FakeClient extends LarkCliClient {
	nodes = new Map<string, WikiNode>();
	spaceName?: string;
	folders = new Map<string, DrivePage>();
	driveCalls = 0;
	bodyCalls = 0;
	failMetadata = false;
	metadataError?: LarkCliError;
	wikiCalls = 0;
	failBody = false;
	entity: SearchEntity = {
		token: 'doc',
		type: 'docx',
		title: 'Spec',
		editedAt: '2026-07-01T00:00:00.000Z',
		url: 'https://team.feishu.cn/wiki/leaf',
	};

	/** Gety's per-connector data directory, where positions are cached. */
	dataDir = Deno.makeTempDirSync({ prefix: 'lark-test-' });

	constructor() {
		super('unused', new AbortController().signal);
	}

	override withSignal(): LarkCliClient {
		return this;
	}

	override getWikiNode(token: string): Promise<WikiNode> {
		this.wikiCalls++;
		if (this.metadataError != null) return Promise.reject(this.metadataError);
		if (this.failMetadata) {
			return Promise.reject(new Error('temporary failure'));
		}
		const node = this.nodes.get(token);
		return node == null
			? Promise.reject(new LarkCliError('not mounted', { code: '131014' }))
			: Promise.resolve(node);
	}

	override getWikiSpaceName(): Promise<string | undefined> {
		return Promise.resolve(this.spaceName);
	}

	override listDriveFiles(folder?: string, page?: string): Promise<DrivePage> {
		this.driveCalls++;
		return Promise.resolve(
			this.folders.get(`${folder ?? ''}:${page ?? ''}`) ??
				{ files: [], hasMore: false },
		);
	}

	override searchDocs() {
		return Promise.resolve({ entities: [this.entity], hasMore: false });
	}

	override fetchDocMarkdown(): Promise<string | null> {
		this.bodyCalls++;
		return this.failBody
			? Promise.reject(new Error('body unavailable'))
			: Promise.resolve('# Spec\n\nText');
	}
}

function wikiClient(): FakeClient {
	const client = new FakeClient();
	client.spaceName = 'Engineering';
	client.nodes.set('leaf', {
		node_token: 'leaf',
		obj_token: 'doc',
		space_id: 'space',
		parent_node_token: 'parent',
	});
	client.nodes.set('parent', {
		node_token: 'parent',
		space_id: 'space',
		title: 'API',
		parent_node_token: 'root',
	});
	client.nodes.set('root', {
		node_token: 'root',
		space_id: 'space',
		title: 'Gety',
	});
	return client;
}

function resolver(client: FakeClient): DocLocationResolver {
	return new DocLocationResolver(client, new AbortController().signal);
}

Deno.test('Wiki location uses the URL node token and preserves document identity', async () => {
	const client = wikiClient();
	const position = await resolver(client).resolve(client.entity);
	assert.deepEqual(position, {
		location: {
			space_name: 'Engineering',
			space_url: 'https://team.feishu.cn/wiki/space/space',
			parent_name: 'API',
			parent_url: 'https://team.feishu.cn/wiki/parent',
			path: 'Gety / API',
			ancestors: [{
				id: 'root',
				title: 'Gety',
				url: 'https://team.feishu.cn/wiki/root',
			}, {
				id: 'parent',
				title: 'API',
				url: 'https://team.feishu.cn/wiki/parent',
			}],
			path_complete: true,
		},
		feishu: {
			node_token: 'leaf',
			obj_token: 'doc',
			space_id: 'space',
			parent_node_token: 'parent',
		},
	});
	assert.equal(
		buildCloudDoc(client.entity, 'Text', position).id,
		'feishu:doc:doc',
	);
});

Deno.test('root Wiki nodes omit missing display fields and remove an old parent', async () => {
	const client = wikiClient();
	const previous = await resolver(client).resolve(client.entity);
	client.nodes.set('leaf', { node_token: 'leaf', obj_token: 'doc' });
	const position = await resolver(client).resolve(client.entity, previous);
	assert.equal(position.location, undefined);
	assert.deepEqual(position.feishu, { node_token: 'leaf', obj_token: 'doc' });
	const doc = buildCloudDoc(
		{ token: 'doc', type: 'docx', title: 'Spec' },
		'Text',
		position,
	);
	assert.ok(!Object.hasOwn(doc.metadata as object, 'url'));
});

Deno.test('inaccessible Wiki ancestors produce a partial path without invented labels', async () => {
	const client = wikiClient();
	client.nodes.delete('root');
	const position = await resolver(client).resolve(client.entity);
	assert.equal(position.location?.path, 'API');
	assert.equal(position.location?.path_complete, false);
	assert.equal(position.location?.parent_name, 'API');
});

Deno.test('Drive traversal handles nested folders, pagination, root moves, and caches per poll', async () => {
	const client = new FakeClient();
	client.entity.url = undefined;
	client.folders.set(':', {
		files: [{ token: 'folder', type: 'folder', name: 'Plans' }],
		hasMore: true,
		pageToken: 'next',
	});
	client.folders.set(':next', {
		files: [{ token: 'root-doc', type: 'docx' }],
		hasMore: false,
	});
	client.folders.set('folder:', {
		files: [{
			token: 'doc',
			type: 'docx',
			parent_token: 'folder',
			url: 'https://team.feishu.cn/docx/doc',
		}],
		hasMore: false,
	});
	const current = resolver(client);
	const position = await current.resolve(client.entity);
	assert.equal(position.location?.path, 'Plans');
	assert.equal(position.location?.parent_name, 'Plans');
	assert.equal(position.feishu?.folder_token, 'folder');
	assert.equal(
		(buildCloudDoc(client.entity, 'Text', position).metadata as { url: string })
			.url,
		'https://team.feishu.cn/docx/doc',
	);
	assert.deepEqual(
		await current.resolve({ ...client.entity, token: 'root-doc' }, position),
		{},
	);
	assert.equal(client.driveCalls, 3);
});

Deno.test('metadata failures preserve the last known position without blocking content', async () => {
	const client = wikiClient();
	const previous = await resolver(client).resolve(client.entity);
	client.failMetadata = true;
	assert.deepEqual(
		await resolver(client).resolve(client.entity, previous),
		previous,
	);
});

Deno.test('missing Wiki scope still resolves Drive folders and avoids repeated failed scope queries', async () => {
	const client = new FakeClient();
	client.metadataError = new LarkCliError('missing scope', {
		missingScopes: ['wiki:node:read'],
	});
	client.folders.set(':', {
		files: [{ token: 'folder', type: 'folder', name: 'Plans' }],
		hasMore: false,
	});
	client.folders.set('folder:', {
		files: [{ token: 'doc', type: 'docx' }, { token: 'other', type: 'docx' }],
		hasMore: false,
	});
	const current = resolver(client);
	assert.equal((await current.resolve(client.entity)).location?.path, 'Plans');
	assert.equal(
		(await current.resolve({ ...client.entity, token: 'other' })).location
			?.path,
		'Plans',
	);
	assert.equal(client.wikiCalls, 1);
	assert.equal(client.driveCalls, 2);
});

class TestConnector extends LarkConnector {
	constructor(private client: FakeClient, budgetMs?: number) {
		super();
		if (budgetMs != null) this.locationBudgetMs = budgetMs;
	}

	protected override createClient(): LarkCliClient {
		return this.client;
	}
}

const CONFIG = {
	index_chat_history: false,
	chat_grouping: 'week',
	chat_history_days: 30,
} as const;

async function poll(
	client: FakeClient,
	state?: LarkState,
	budgetMs?: number,
) {
	const run = await runPoll(new TestConnector(client, budgetMs), {
		config: CONFIG,
		lastState: state ?? null,
		dataDir: client.dataDir,
	});
	assert.equal(run.outcome, 'done', String(run.error));
	const cache = JSON.parse(
		await Deno.readTextFile(`${client.dataDir}/doc-positions.json`),
	) as { positions: Record<string, CloudPosition> };
	return {
		updates: run.updates,
		state: run.committedState as LarkState,
		positions: cache.positions,
	};
}

Deno.test('poll refreshes moved/renamed locations despite unchanged edit time and skips stable bodies', async () => {
	const client = wikiClient();
	const first = await poll(client, { docs: { doc: client.entity.url! } });
	assert.equal(first.updates.length, 1);
	assert.equal(client.bodyCalls, 1);
	const unchanged = await poll(client, first.state);
	assert.equal(unchanged.updates.length, 0);
	assert.equal(client.bodyCalls, 1);
	client.nodes.get('parent')!.title = 'Platform';
	const renamed = await poll(client, unchanged.state);
	assert.equal(renamed.updates.length, 1);
	const update = renamed.updates[0];
	assert.equal(update.kind, 'upsert');
	if (update.kind === 'upsert') {
		assert.ok(
			update.doc.content?.includes(
				'> **目录路径：** [Gety](<https://team.feishu.cn/wiki/root>) / [Platform](<https://team.feishu.cn/wiki/parent>)',
			),
		);
		assert.ok(
			update.doc.content?.includes(
				'> **父节点：** [Platform](<https://team.feishu.cn/wiki/parent>)',
			),
		);
		assert.ok(update.doc.content?.endsWith('# Spec\n\nText'));
	}
	assert.equal(renamed.positions.doc.location?.path, 'Gety / Platform');
	client.nodes.get('leaf')!.parent_node_token = 'root';
	const moved = await poll(client, renamed.state);
	assert.equal(moved.updates.length, 1);
	assert.equal(moved.positions.doc.location?.path, 'Gety');
	client.failMetadata = true;
	const unavailable = await poll(client, moved.state);
	assert.equal(unavailable.updates.length, 0);
	assert.deepEqual(unavailable.positions, moved.positions);
});

Deno.test('failed metadata refresh body fetch is retried without advancing the metadata signature', async () => {
	const client = wikiClient();
	const first = await poll(client);
	client.nodes.get('parent')!.title = 'Changed';
	client.failBody = true;
	const failed = await poll(client, first.state);
	assert.equal(failed.updates.length, 0);
	assert.deepEqual(failed.state.doc_signatures, first.state.doc_signatures);
	assert.deepEqual(failed.positions, first.positions);
	client.failBody = false;
	const retried = await poll(client, failed.state);
	assert.equal(retried.updates.length, 1);
	assert.equal(retried.positions.doc.location?.parent_name, 'Changed');
});

for (
	const malformed of [
		null,
		'x',
		{ location: { ancestors: 'oops', path: 'x' } },
		{ location: { ancestors: [{ id: 1, title: 'API' }] } },
		{ location: { path_complete: 'yes' } },
		{ feishu: 'x' },
	]
) {
	Deno.test(
		`a malformed cached position (${
			JSON.stringify(malformed)
		}) is a cache miss, not a broken document`,
		async () => {
			const client = wikiClient();
			const first = await poll(client);
			const path = `${client.dataDir}/doc-positions.json`;
			const file = JSON.parse(await Deno.readTextFile(path));
			file.positions.doc = malformed;
			await Deno.writeTextFile(path, JSON.stringify(file));
			// With lookups failing, the cached position is the fallback.
			client.failMetadata = true;
			const next = await poll(client, first.state);
			assert.equal(next.updates.length, 1);
			assert.deepEqual(next.positions, { doc: {} });
			client.failMetadata = false;
			const repaired = await poll(client, next.state);
			assert.equal(repaired.positions.doc.location?.path, 'Gety / API');
		},
	);
}

Deno.test('the position cache only seeds polls of the state it was written with', async () => {
	const client = wikiClient();
	const first = await poll(client);
	assert.equal(first.positions.doc.location?.path, 'Gety / API');
	// A resync (no state) must not trust positions cached by an older index:
	// with lookups failing, the doc is rebuilt without the stale location.
	client.failMetadata = true;
	const resync = await poll(client);
	assert.equal(resync.updates.length, 1);
	const update = resync.updates[0];
	assert.ok(update.kind === 'upsert' && !update.doc.content?.includes('API'));
	assert.notEqual(resync.state.positions_epoch, first.state.positions_epoch);
	assert.deepEqual(resync.positions, { doc: {} });
});

Deno.test('Wiki links preserve Lark tenant domains and omit links without a known tenant', async () => {
	const client = wikiClient();
	client.entity.url = 'https://example.larksuite.com/wiki/leaf?from=search';
	const lark = await resolver(client).resolve(client.entity);
	assert.equal(
		lark.location?.space_url,
		'https://example.larksuite.com/wiki/space/space',
	);
	assert.equal(
		lark.location?.parent_url,
		'https://example.larksuite.com/wiki/parent',
	);
	for (const url of [undefined, 'https://feishu.cn.evil.example/wiki/leaf']) {
		client.entity.url = url;
		client.nodes.set('doc', client.nodes.get('leaf')!);
		const unknown = await resolver(client).resolve(client.entity);
		assert.equal(unknown.location?.space_name, 'Engineering');
		assert.equal(unknown.location?.space_url, undefined);
		assert.equal(unknown.location?.parent_url, undefined);
	}
});

Deno.test('Drive paths link folders only when the API provides their URLs', async () => {
	const client = new FakeClient();
	client.folders.set(':', {
		files: [{ token: 'root', type: 'folder', name: 'Plans' }],
		hasMore: false,
	});
	client.folders.set('root:', {
		files: [{
			token: 'parent',
			type: 'folder',
			name: 'API',
			url: 'https://team.feishu.cn/drive/folder/parent',
		}],
		hasMore: false,
	});
	client.folders.set('parent:', {
		files: [{ token: 'doc', type: 'docx' }],
		hasMore: false,
	});
	const position = await resolver(client).resolve(client.entity);
	const doc = buildCloudDoc(client.entity, '# Body', position);
	assert.ok(
		doc.content?.includes(
			'> **目录路径：** Plans / [API](<https://team.feishu.cn/drive/folder/parent>)',
		),
	);
	assert.ok(
		doc.content?.includes(
			'> **父节点：** [API](<https://team.feishu.cn/drive/folder/parent>)',
		),
	);
});

const never = <T>() => new Promise<T>(() => {});

Deno.test('a hung Drive listing is cut off by the budget and later lookups reuse last known positions', async () => {
	const client = new FakeClient();
	client.folders.set(':', {
		files: [{ token: 'folder', type: 'folder', name: 'Plans' }],
		hasMore: false,
	});
	const listDriveFiles = client.listDriveFiles.bind(client);
	client.listDriveFiles = (folder?: string, page?: string) =>
		folder === 'folder'
			? (client.driveCalls++, never())
			: listDriveFiles(folder, page);
	const previous = { location: { path: 'Old' } };
	const current = new DocLocationResolver(
		client,
		new AbortController().signal,
		50,
	);
	const started = Date.now();
	assert.deepEqual(await current.resolve(client.entity, previous), previous);
	assert.ok(Date.now() - started < 1_000);
	const calls = client.wikiCalls + client.driveCalls;
	assert.deepEqual(
		await current.resolve({ ...client.entity, token: 'other' }, previous),
		previous,
	);
	assert.equal(client.wikiCalls + client.driveCalls, calls);
});

Deno.test('a hung Wiki ancestor keeps the last known position instead of a partial path', async () => {
	const client = wikiClient();
	const previous = await resolver(client).resolve(client.entity);
	const getWikiNode = client.getWikiNode.bind(client);
	client.getWikiNode = (token: string) =>
		token === 'root' ? never() : getWikiNode(token);
	client.nodes.get('parent')!.title = 'Renamed';
	const current = new DocLocationResolver(
		client,
		new AbortController().signal,
		50,
	);
	assert.deepEqual(await current.resolve(client.entity, previous), previous);
});

Deno.test('hung location lookups do not withhold document content', async () => {
	const client = new FakeClient();
	client.listDriveFiles = () => never();
	const result = await poll(client, undefined, 50);
	assert.equal(result.updates.length, 1);
	assert.equal(client.bodyCalls, 1);
	assert.ok(result.state.docs?.doc != null);
});

class PagedClient extends FakeClient {
	pages: SearchEntity[][] = [];

	override searchDocs(
		options: { sortByEditTime?: boolean; pageToken?: string } = {},
	) {
		const index = Number(options.pageToken ?? 0);
		const hasMore = index + 1 < this.pages.length;
		return Promise.resolve({
			entities: this.pages[index] ?? [],
			hasMore,
			...(hasMore ? { pageToken: String(index + 1) } : {}),
		});
	}
}

Deno.test('an interrupted first sync commits no state and the next poll redoes it', async () => {
	const client = new PagedClient();
	const entity = (token: string): SearchEntity => ({
		...client.entity,
		token,
		url: `https://team.feishu.cn/docx/${token}`,
	});
	client.pages = [[entity('a'), entity('b')], [entity('c')]];
	const generator = new TestConnector(client).poll();
	const first = (await generator.next()).value;
	// The host cancels the poll after the first batch (e.g. idle timeout).
	// Intermediate batches carry no state, so nothing is committed.
	await generator.return(undefined);
	assert.ok(first != null && !Object.hasOwn(first, 'state'));
	assert.equal(first.updates.length, 2);

	const redone = await poll(client);
	assert.deepEqual(
		redone.updates.map((update) =>
			update.kind === 'upsert' ? update.doc.id : update.id
		),
		['feishu:doc:a', 'feishu:doc:b', 'feishu:doc:c'],
	);
	assert.deepEqual(Object.keys(redone.state.docs ?? {}).sort(), [
		'a',
		'b',
		'c',
	]);
});
