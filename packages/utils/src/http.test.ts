import assert from 'node:assert/strict';
import { isTimeoutError } from './abort.ts';
import { isRecord } from './json.ts';
import {
	type FetchLike,
	HttpError,
	type JsonRequestInit,
	requestJson,
	ResponseShapeError,
	TransportError,
} from './http.ts';

const URL_ = 'https://api.example.test/v1/items?token=query-secret';
const never = new AbortController().signal;

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

/** A fetch replaying `responses` in order and recording each call. */
function scripted(
	responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[],
) {
	const calls: RequestInit[] = [];
	const fetch: FetchLike = (_url, init) => {
		calls.push(init);
		const next = responses.shift();
		if (next === undefined) {
			throw new Error('unexpected request');
		}
		if (typeof next === 'function') {
			return next(init);
		}
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	};
	return { fetch, calls };
}

const fastRetry = { baseDelayMs: 1, maxDelayMs: 1 };

function request(fetch: FetchLike, init: Partial<JsonRequestInit> = {}) {
	return requestJson(URL_, {
		signal: never,
		fetch,
		...init,
		retry: { ...fastRetry, ...init.retry },
	});
}

/** Never settles until the request signal aborts, then rejects with its reason. */
function hang(init: RequestInit): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
		once: true,
	});
	return promise;
}

Deno.test('returns the JSON object of a 2xx response', async () => {
	const { fetch } = scripted([json({ ok: true, results: [1] })]);
	assert.deepEqual(await request(fetch), { ok: true, results: [1] });
});

Deno.test('sends a JSON body with a content type unless one is given', async () => {
	const { fetch, calls } = scripted([json({}), json({})]);
	await request(fetch, { method: 'POST', body: { q: 'x' } });
	await request(fetch, {
		method: 'POST',
		body: { q: 'y' },
		headers: { 'content-type': 'application/vnd.test+json' },
	});
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[0].body, '{"q":"x"}');
	assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' });
	assert.deepEqual(calls[1].headers, {
		'content-type': 'application/vnd.test+json',
	});
});

Deno.test('retries 429 after Retry-After, then succeeds', async () => {
	const waits: number[] = [];
	const { fetch, calls } = scripted([
		json({ code: 'rate_limited' }, 429, { 'retry-after': '0' }),
		json({ done: true }),
	]);
	const result = await request(fetch, {
		retry: { onRetry: ({ delayMs }) => waits.push(delayMs) },
	});
	assert.deepEqual(result, { done: true });
	assert.equal(calls.length, 2);
	assert.deepEqual(waits, [0]);
});

Deno.test('caps Retry-After at maxRetryAfterMs', async () => {
	const waits: number[] = [];
	const { fetch } = scripted([
		json({}, 503, { 'retry-after': '3600' }),
		json({ done: true }),
	]);
	await request(fetch, {
		retry: {
			maxRetryAfterMs: 2,
			onRetry: ({ delayMs }) => waits.push(delayMs),
		},
	});
	assert.deepEqual(waits, [2]);
});

Deno.test('retries the default 5xx statuses', async () => {
	for (const status of [408, 500, 502, 503, 504]) {
		const { fetch, calls } = scripted([json({}, status), json({ ok: 1 })]);
		assert.deepEqual(await request(fetch), { ok: 1 });
		assert.equal(calls.length, 2, `status ${status}`);
	}
});

Deno.test('retry statuses are configurable (529 for Notion)', async () => {
	const once = scripted([json({}, 529), json({ ok: 1 })]);
	await assert.rejects(request(once.fetch), HttpError);
	assert.equal(once.calls.length, 1);

	const configured = scripted([json({}, 529), json({ ok: 1 })]);
	assert.deepEqual(
		await request(configured.fetch, {
			retry: { statuses: [429, 500, 502, 503, 504, 529] },
		}),
		{ ok: 1 },
	);
});

Deno.test('shouldRetry can veto a retryable error', async () => {
	const { fetch, calls } = scripted([
		json({ code: 'public_api_request_blocked' }, 503),
	]);
	await assert.rejects(
		request(fetch, {
			retry: {
				shouldRetry: (error) =>
					!(error instanceof HttpError && isRecord(error.body) &&
						error.body.code === 'public_api_request_blocked'),
			},
		}),
		HttpError,
	);
	assert.equal(calls.length, 1);
});

Deno.test('retries network errors and gives up with a TransportError', async () => {
	const ok = scripted([new TypeError('connection reset'), json({ ok: 1 })]);
	assert.deepEqual(await request(ok.fetch), { ok: 1 });
	assert.equal(ok.calls.length, 2);

	const down = scripted([
		new TypeError('dns'),
		new TypeError('dns'),
		new TypeError('dns'),
	]);
	await assert.rejects(request(down.fetch, { retry: { maxAttempts: 3 } }), (
		error,
	) => {
		assert.ok(error instanceof TransportError);
		assert.equal(error.timedOut, false);
		assert.ok(error.cause instanceof TypeError);
		assert.match(error.message, /^GET \/v1\/items failed: dns$/);
		return true;
	});
	assert.equal(down.calls.length, 3);
});

Deno.test('a stalled attempt times out and is retried', async () => {
	const { fetch, calls } = scripted([hang, json({ ok: 1 })]);
	assert.deepEqual(await request(fetch, { timeoutMs: 10 }), { ok: 1 });
	assert.equal(calls.length, 2);
	assert.equal(isTimeoutError(calls[0].signal!.reason), true);
});

Deno.test('timeouts on every attempt end in a timed-out TransportError', async () => {
	const { fetch, calls } = scripted([hang, hang]);
	await assert.rejects(
		request(fetch, { timeoutMs: 5, retry: { maxAttempts: 2 } }),
		(error) => {
			assert.ok(error instanceof TransportError);
			assert.equal(error.timedOut, true);
			assert.match(error.message, /timed out after 5 ms/);
			return true;
		},
	);
	assert.equal(calls.length, 2);
});

Deno.test('the timeout also covers reading the body', async () => {
	const stalledBody = (init: RequestInit) => {
		const body = new ReadableStream({
			start(controller) {
				init.signal!.addEventListener(
					'abort',
					() => controller.error(init.signal!.reason),
				);
			},
		});
		return Promise.resolve(new Response(body, { status: 200 }));
	};
	const { fetch, calls } = scripted([stalledBody, json({ ok: 1 })]);
	assert.deepEqual(await request(fetch, { timeoutMs: 10 }), { ok: 1 });
	assert.equal(calls.length, 2);
});

Deno.test('caller cancellation is not retried and keeps its reason', async () => {
	const controller = new AbortController();
	const reason = new Error('poll cancelled');
	const { fetch, calls } = scripted([(init) => {
		const pending = hang(init);
		controller.abort(reason);
		return pending;
	}]);
	await assert.rejects(
		request(fetch, { signal: controller.signal }),
		(error) => error === reason,
	);
	assert.equal(calls.length, 1);
});

Deno.test('cancellation during a retry wait stops without another attempt', async () => {
	const controller = new AbortController();
	const reason = new Error('poll cancelled');
	const { fetch, calls } = scripted([json({}, 429, { 'retry-after': '60' })]);
	await assert.rejects(
		request(fetch, {
			signal: controller.signal,
			retry: { onRetry: () => controller.abort(reason) },
		}),
		(error) => error === reason,
	);
	assert.equal(calls.length, 1);
});

Deno.test('a 2xx HTML body is a ResponseShapeError, not an empty result', async () => {
	const { fetch, calls } = scripted([
		new Response('<html>portal</html>', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		}),
	]);
	await assert.rejects(request(fetch), (error) => {
		assert.ok(error instanceof ResponseShapeError);
		assert.match(error.message, /text\/html/);
		return true;
	});
	assert.equal(calls.length, 1, 'shape errors are not retried');
});

Deno.test('2xx JSON arrays, null and empty bodies are shape errors', async () => {
	for (const body of ['[1,2]', 'null', '', '"text"']) {
		const { fetch } = scripted([new Response(body, { status: 200 })]);
		await assert.rejects(request(fetch), ResponseShapeError, body);
	}
});

Deno.test('a non-2xx response is an HttpError with the parsed body', async () => {
	const { fetch } = scripted([
		json({ code: 'object_not_found', message: 'Could not find page' }, 404),
	]);
	await assert.rejects(request(fetch), (error) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.status, 404);
		assert.deepEqual(error.body, {
			code: 'object_not_found',
			message: 'Could not find page',
		});
		assert.equal(
			error.message,
			'GET /v1/items failed with HTTP 404: object_not_found: Could not find page',
		);
		return true;
	});

	const text = scripted([new Response('Bad gateway', { status: 400 })]);
	await assert.rejects(request(text.fetch), (error) => {
		assert.ok(error instanceof HttpError);
		assert.equal(error.body, 'Bad gateway');
		assert.equal(error.message, 'GET /v1/items failed with HTTP 400');
		return true;
	});
});

Deno.test('error messages never contain credentials, the body or the query', async () => {
	const secret = 'sk-live-very-secret';
	const { fetch } = scripted([json({ message: 'unauthorized' }, 401)]);
	await assert.rejects(
		request(fetch, {
			method: 'POST',
			headers: { Authorization: `Bearer ${secret}` },
			body: { password: secret },
		}),
		(error) => {
			assert.ok(error instanceof HttpError);
			assert.ok(!error.message.includes(secret));
			assert.ok(!error.message.includes('query-secret'));
			assert.ok(!error.message.includes('password'));
			return true;
		},
	);
});

Deno.test('beforeAttempt runs before every attempt, retries included', async () => {
	const events: string[] = [];
	const { fetch } = scripted([
		() => {
			events.push('fetch');
			return Promise.resolve(json({}, 502));
		},
		new TypeError('reset'),
		() => {
			events.push('fetch');
			return Promise.resolve(json({ ok: 1 }));
		},
	]);
	let attempts = 0;
	await request(fetch, {
		beforeAttempt: (signal) => {
			assert.equal(signal, never);
			attempts += 1;
			events.push('before');
			return Promise.resolve();
		},
	});
	assert.equal(attempts, 3);
	assert.deepEqual(events, ['before', 'fetch', 'before', 'before', 'fetch']);
});
