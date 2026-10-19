import assert from 'node:assert/strict';
import { jsonResponse } from '@gety-connectors/testing';
import { HttpError, ResponseShapeError } from '@gety-connectors/utils/http';
import type { LogDetails, Logger } from '@gety-connectors/utils/log';
import { IncompleteEnumerationError } from '@gety-connectors/utils/paginate';
import { NotionClient, type NotionClientOptions } from './api.ts';
import type { NotionPage } from './types.ts';

type StubFetch = (
	url: string,
	init: RequestInit,
) => Response | Promise<Response>;

function makeClient(
	fetchFn: StubFetch,
	options: NotionClientOptions & { signal?: AbortSignal } = {},
): NotionClient {
	const { signal = new AbortController().signal, ...rest } = options;
	return new NotionClient('test-token', signal, {
		baseUrl: 'https://notion.test/v1',
		fetchFn: (url, init) => Promise.resolve(fetchFn(url, init)),
		requestIntervalMs: 0,
		retry: { baseDelayMs: 0 },
		logger: silentLogger(),
		...rest,
	});
}

function silentLogger(
	onWarn: (message: string, details?: LogDetails) => void = () => {},
): Logger {
	return {
		info: () => {},
		warn: onWarn,
		warnOnce: (_key, message, details) => onWarn(message, details),
		progress: () => {},
	};
}

async function collect<T>(iterator: AsyncGenerator<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterator) {
		items.push(item);
	}
	return items;
}

const EMPTY_LIST = { results: [], has_more: false, next_cursor: null };

Deno.test('searchPages paginates the page-filtered search', async () => {
	const bodies: Record<string, unknown>[] = [];
	const client = makeClient((_url, init) => {
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		bodies.push(body);
		if (body.start_cursor == null) {
			return jsonResponse({
				results: [{ object: 'page', id: 'p1' }],
				has_more: true,
				next_cursor: 'cursor-2',
			});
		}
		return jsonResponse({
			results: [{ object: 'page', id: 'p2' }],
			has_more: false,
			next_cursor: null,
		});
	});

	const batches = await collect(client.searchPages());

	assert.equal(batches.length, 2);
	assert.deepEqual(batches[0].map((page: NotionPage) => page.id), ['p1']);
	assert.deepEqual(batches[1].map((page: NotionPage) => page.id), ['p2']);
	assert.equal(bodies[1].start_cursor, 'cursor-2');
	assert.deepEqual(bodies[0].filter, { property: 'object', value: 'page' });
	// Ascending keeps mid-poll edits enumerable; descending could skip
	// pages and cause false diff-deletes.
	assert.deepEqual(bodies[0].sort, {
		direction: 'ascending',
		timestamp: 'last_edited_time',
	});
});

Deno.test('request retries 429 responses honoring retry-after', async () => {
	let attempts = 0;
	const client = makeClient(() => {
		attempts += 1;
		if (attempts === 1) {
			return new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '0' },
			});
		}
		return jsonResponse(EMPTY_LIST);
	});

	const batches = await collect(client.searchPages());

	assert.equal(attempts, 2);
	assert.deepEqual(batches, [[]]);
});

Deno.test('request retries 500, 529 and network errors', async () => {
	const failures: (() => Response)[] = [
		() => jsonResponse({ code: 'internal_server_error' }, { status: 500 }),
		() => jsonResponse({ code: 'service_overload' }, { status: 529 }),
		() => {
			throw new TypeError('connection reset');
		},
	];
	let attempts = 0;
	const client = makeClient(() => {
		attempts += 1;
		const failure = failures[attempts - 1];
		return failure === undefined ? jsonResponse(EMPTY_LIST) : failure();
	});

	assert.deepEqual(await collect(client.searchPages()), [[]]);
	assert.equal(attempts, 4);
});

Deno.test('a request that exceeds the timeout is retried', async () => {
	let attempts = 0;
	const client = makeClient((_url, init) => {
		attempts += 1;
		if (attempts > 1) {
			return jsonResponse(EMPTY_LIST);
		}
		// Hangs until the per-attempt timeout (AbortSignal.timeout, real clock)
		// aborts it. The fallback answer, a non-JSON 200, only arrives when
		// nothing aborts the attempt, so a missing timeout fails instead of
		// hanging the test run.
		const { promise, resolve, reject } = Promise.withResolvers<Response>();
		const fallback = setTimeout(() => resolve(new Response('late')), 500);
		init.signal?.addEventListener('abort', () => {
			clearTimeout(fallback);
			reject(init.signal?.reason);
		});
		return promise;
	}, { timeoutMs: 20 });

	assert.deepEqual(await collect(client.searchPages()), [[]]);
	assert.equal(attempts, 2);
});

Deno.test('public_api_request_blocked is not retried', async () => {
	let attempts = 0;
	const client = makeClient(() => {
		attempts += 1;
		return jsonResponse(
			{ object: 'error', code: 'public_api_request_blocked', message: 'no' },
			{ status: 429, headers: { 'retry-after': '0' } },
		);
	});

	await assert.rejects(() => collect(client.searchPages()), HttpError);
	assert.equal(attempts, 1);
});

Deno.test('Retry-After above a minute is honored and announced', async () => {
	const controller = new AbortController();
	const warnings: LogDetails[] = [];
	const client = makeClient(
		() =>
			jsonResponse({ code: 'rate_limited' }, {
				status: 429,
				headers: { 'retry-after': '120' },
			}),
		{
			signal: controller.signal,
			logger: silentLogger((_message, details) => {
				warnings.push(details ?? {});
				// Stop during the announced wait instead of sleeping through it.
				controller.abort(new Error('test stop'));
			}),
		},
	);

	await assert.rejects(() => collect(client.searchPages()), /test stop/);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].wait_s, 120);
});

Deno.test('a 2xx HTML response fails instead of ending the search', async () => {
	const client = makeClient(() =>
		new Response('<html>portal</html>', {
			headers: { 'content-type': 'text/html' },
		})
	);

	await assert.rejects(() => collect(client.searchPages()), ResponseShapeError);
});

Deno.test('a 2xx response without a results array fails', async () => {
	for (const body of [{ has_more: false }, { results: {}, has_more: false }]) {
		const client = makeClient(() => jsonResponse(body));
		await assert.rejects(
			() => collect(client.searchPages()),
			IncompleteEnumerationError,
		);
	}
});

Deno.test('a search result that is not a page with an id fails the enumeration', async () => {
	for (
		const result of [
			{ object: 'page' },
			{ object: 'page', id: '' },
			{ object: 'unexpected', id: 'a' },
			{ object: 'database', id: 'd1' },
		]
	) {
		const client = makeClient(() =>
			jsonResponse({ results: [result], has_more: false })
		);

		await assert.rejects(
			() => collect(client.searchPages()),
			IncompleteEnumerationError,
			JSON.stringify(result),
		);
	}
});

Deno.test('non-ok responses throw HttpError with the Notion error body', async () => {
	const client = makeClient(() =>
		jsonResponse(
			{
				object: 'error',
				code: 'restricted_resource',
				message: 'Insufficient permissions.',
			},
			{ status: 403 },
		)
	);

	await assert.rejects(
		() => client.searchPages().next(),
		(error: unknown) => {
			assert.ok(error instanceof HttpError);
			assert.equal(error.status, 403);
			assert.deepEqual(error.body, {
				object: 'error',
				code: 'restricted_resource',
				message: 'Insufficient permissions.',
			});
			return true;
		},
	);
});

Deno.test('a 401 says the token is invalid or expired', async () => {
	const client = makeClient(() =>
		jsonResponse(
			{
				object: 'error',
				code: 'unauthorized',
				message: 'API token is invalid.',
			},
			{ status: 401 },
		)
	);

	await assert.rejects(
		() => client.searchPages().next(),
		/token invalid or expired/,
	);
});

Deno.test('cancellation stops requests and rejects with the reason', async () => {
	const controller = new AbortController();
	let attempts = 0;
	const client = makeClient(() => {
		attempts += 1;
		controller.abort(new Error('cancelled by host'));
		return jsonResponse({
			results: [],
			has_more: true,
			next_cursor: `c${attempts}`,
		});
	}, { signal: controller.signal });

	await assert.rejects(
		() => collect(client.searchPages()),
		/cancelled by host/,
	);
	assert.equal(attempts, 1);
});

Deno.test('fetchBlockTree recurses children, skips child pages, resolves synced blocks', async () => {
	const calls: string[] = [];
	const childrenByParent: Record<string, unknown[]> = {
		'page-1': [
			{ id: 'b1', type: 'toggle', has_children: true, toggle: {} },
			{
				id: 'b2',
				type: 'child_page',
				has_children: true,
				child_page: { title: 'Sub' },
			},
			{
				id: 'b3',
				type: 'synced_block',
				has_children: false,
				synced_block: { synced_from: { block_id: 'orig-1' } },
			},
		],
		'b1': [{ id: 'b4', type: 'paragraph', has_children: false, paragraph: {} }],
		'orig-1': [
			{ id: 'b5', type: 'paragraph', has_children: false, paragraph: {} },
		],
	};
	const client = makeClient((url) => {
		calls.push(url);
		const id = url.match(/blocks\/([^/?]+)\/children/)?.[1] ?? '';
		return jsonResponse({
			results: childrenByParent[id] ?? [],
			has_more: false,
		});
	});

	const tree = await client.fetchBlockTree('page-1');

	assert.deepEqual(tree.map((node) => node.block.id), ['b1', 'b2', 'b3']);
	assert.deepEqual(tree[0].children.map((node) => node.block.id), ['b4']);
	assert.equal(tree[1].children.length, 0);
	assert.deepEqual(tree[2].children.map((node) => node.block.id), ['b5']);
	assert.ok(!calls.some((url) => url.includes('/blocks/b2/')));
});

const NOT_FOUND = { object: 'error', code: 'object_not_found', message: 'x' };

Deno.test('a 404 below the page skips only that subtree', async () => {
	const childrenByParent: Record<string, unknown[]> = {
		'page-1': [
			{
				id: 'b1',
				type: 'synced_block',
				has_children: true,
				synced_block: { synced_from: { block_id: 'unshared-original' } },
			},
			{ id: 'b2', type: 'toggle', has_children: true, toggle: {} },
			{ id: 'b3', type: 'paragraph', has_children: false, paragraph: {} },
		],
	};
	const client = makeClient((url) => {
		const id = url.match(/blocks\/([^/?]+)\/children/)?.[1] ?? '';
		const children = childrenByParent[id];
		return children === undefined
			? jsonResponse(NOT_FOUND, { status: 404 })
			: jsonResponse({ results: children, has_more: false });
	});

	const tree = await client.fetchBlockTree('page-1');

	assert.deepEqual(tree.map((node) => node.block.id), ['b1', 'b2', 'b3']);
	assert.deepEqual(tree.map((node) => node.children.length), [0, 0, 0]);
});

Deno.test('a 404 for the page itself is thrown', async () => {
	const client = makeClient(() => jsonResponse(NOT_FOUND, { status: 404 }));

	await assert.rejects(
		() => client.fetchBlockTree('page-1'),
		(error: unknown) => error instanceof HttpError && error.status === 404,
	);
});

Deno.test('a 404 without a Notion object_not_found body is not a missing block', async () => {
	const client = makeClient((url) =>
		url.includes('/blocks/page-1/')
			? jsonResponse({
				results: [{ id: 'b1', type: 'toggle', has_children: true }],
				has_more: false,
			})
			: new Response('<html>proxy route not found</html>', {
				status: 404,
				headers: { 'content-type': 'text/html' },
			})
	);

	await assert.rejects(
		() => client.fetchBlockTree('page-1'),
		(error: unknown) => error instanceof HttpError && error.status === 404,
	);
});

Deno.test('block children pagination follows next_cursor', async () => {
	const client = makeClient((url) => {
		const second = url.includes('start_cursor=cursor-2');
		return jsonResponse({
			results: [
				{ id: second ? 'b2' : 'b1', type: 'paragraph', paragraph: {} },
			],
			has_more: !second,
			next_cursor: second ? null : 'cursor-2',
		});
	});

	const tree = await client.fetchBlockTree('page-1');

	assert.deepEqual(tree.map((node) => node.block.id), ['b1', 'b2']);
});

Deno.test('requests carry auth and version headers', async () => {
	let headers: Headers | null = null;
	const client = makeClient((_url, init) => {
		headers = new Headers(init.headers);
		return jsonResponse(EMPTY_LIST);
	});

	await collect(client.searchPages());

	assert.ok(headers != null);
	assert.equal(
		(headers as Headers).get('authorization'),
		'Bearer test-token',
	);
	assert.equal((headers as Headers).get('notion-version'), '2026-03-11');
});

Deno.test('has_more without next_cursor fails instead of truncating', async () => {
	const client = makeClient(() =>
		jsonResponse({
			results: [{ object: 'page', id: 'p1' }],
			has_more: true,
			next_cursor: null,
		})
	);

	await assert.rejects(
		() => collect(client.searchPages()),
		IncompleteEnumerationError,
	);
});

Deno.test('requests are spaced by the configured interval', async () => {
	const timestamps: number[] = [];
	const client = makeClient(() => {
		timestamps.push(Date.now());
		return jsonResponse({
			results: [],
			has_more: timestamps.length < 3,
			next_cursor: timestamps.length < 3 ? `c${timestamps.length}` : null,
		});
	}, { requestIntervalMs: 30 });

	await collect(client.searchPages());

	assert.equal(timestamps.length, 3);
	assert.ok(timestamps[1] - timestamps[0] >= 25);
	assert.ok(timestamps[2] - timestamps[1] >= 25);
});
