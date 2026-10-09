import assert from 'node:assert/strict';
import FeishuConnector, { buildCloudDoc, type FeishuState } from './index.ts';
import { DocLocationResolver } from './doc_location.ts';
import {
	type DrivePage,
	LarkCliClient,
	LarkCliError,
	type SearchEntity,
	type WikiNode,
} from './lark_cli.ts';
import type { PollResult } from '@gety-ai/connector-sdk';

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

	constructor() {
		super('unused', new AbortController().signal);
	}

	override getWikiNode(token: string): Promise<WikiNode> {
		this.wikiCalls++;
		if (this.metadataError != null) return Promise.reject(this.metadataError);
		if (this.failMetadata) {
			return Promise.reject(new Error('temporary failure'));
		}
		const node = this.nodes.get(token);
		return node == null
			? Promise.reject(new LarkCliError('not mounted', [], '131014'))
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
			parent_name: 'API',
			path: 'Gety / API',
			ancestors: [{ id: 'root', title: 'Gety' }, {
				id: 'parent',
				title: 'API',
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
	client.metadataError = new LarkCliError('missing scope', ['wiki:node:read']);
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

class TestConnector extends FeishuConnector {
	constructor(private client: FakeClient, state?: FeishuState) {
		super();
		this.config = {
			index_chat_history: false,
			chat_grouping: 'week',
			chat_history_days: 30,
			lark_cli_path: 'unused',
		};
		this.lastState = state ?? null;
	}

	protected override createClient(): LarkCliClient {
		return this.client;
	}
}

async function poll(client: FakeClient, state?: FeishuState) {
	const results: PollResult[] = [];
	for await (const result of new TestConnector(client, state).poll()) {
		results.push(result);
	}
	return {
		updates: results.flatMap((result) => result.updates),
		state: results.findLast((result) => result.state != null)!
			.state as FeishuState,
	};
}

Deno.test('poll refreshes moved/renamed locations despite unchanged edit time and skips stable bodies', async () => {
	const client = wikiClient();
	const first = await poll(client, {
		docs: { doc: client.entity.url! },
		docs_high_water: client.entity.editedAt,
	});
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
		assert.ok(update.doc.content?.includes('> **目录路径：** Gety / Platform'));
		assert.ok(update.doc.content?.includes('> **父节点：** Platform'));
		assert.ok(update.doc.content?.endsWith('# Spec\n\nText'));
	}
	assert.equal(
		renamed.state.doc_positions?.doc.location?.path,
		'Gety / Platform',
	);
	client.nodes.get('leaf')!.parent_node_token = 'root';
	const moved = await poll(client, renamed.state);
	assert.equal(moved.updates.length, 1);
	assert.equal(moved.state.doc_positions?.doc.location?.path, 'Gety');
	client.failMetadata = true;
	const unavailable = await poll(client, moved.state);
	assert.equal(unavailable.updates.length, 0);
	assert.deepEqual(unavailable.state.doc_positions, moved.state.doc_positions);
});

Deno.test('failed metadata refresh body fetch is retried without advancing the metadata signature', async () => {
	const client = wikiClient();
	const first = await poll(client);
	client.nodes.get('parent')!.title = 'Changed';
	client.failBody = true;
	const failed = await poll(client, first.state);
	assert.equal(failed.updates.length, 0);
	assert.deepEqual(failed.state.doc_signatures, first.state.doc_signatures);
	assert.deepEqual(failed.state.doc_positions, first.state.doc_positions);
	client.failBody = false;
	const retried = await poll(client, failed.state);
	assert.equal(retried.updates.length, 1);
	assert.equal(
		retried.state.doc_positions?.doc.location?.parent_name,
		'Changed',
	);
});

Deno.test('existing metadata-only signatures refresh Markdown once after upgrading', async () => {
	const client = wikiClient();
	const first = await poll(client);
	const e = client.entity;
	const oldData = JSON.stringify([
		e.token,
		e.type,
		e.title,
		e.editedAt,
		e.createdAt,
		e.url,
		e.owner,
		first.state.doc_positions?.doc,
	]);
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(oldData),
	);
	const oldSignature = Array.from(
		new Uint8Array(digest),
		(value) => value.toString(16).padStart(2, '0'),
	).join('');
	const upgraded = await poll(client, {
		...first.state,
		doc_signatures: { doc: oldSignature },
	});
	assert.equal(upgraded.updates.length, 1);
	const update = upgraded.updates[0];
	assert.equal(update.kind, 'upsert');
	if (update.kind === 'upsert') {
		assert.ok(update.doc.content?.includes('> **知识库：** Engineering'));
	}
	const next = await poll(client, upgraded.state);
	assert.equal(next.updates.length, 0);
});
