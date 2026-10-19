import assert from 'node:assert/strict';
import {
	backoffDelay,
	DEFAULT_RETRY_POLICY,
	parseRetryAfter,
	retry,
	type RetryInfo,
} from './retry.ts';

const never = new AbortController().signal;

Deno.test('backoffDelay is full jitter over a capped exponential', () => {
	const policy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };
	const top = () => 0.999_999;
	assert.deepEqual(
		[0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, policy, top)),
		[999, 1_999, 3_999, 7_999, 15_999, 31_999, 59_999, 59_999],
	);
	assert.equal(backoffDelay(3, policy, () => 0.5), 4_000);
	assert.equal(backoffDelay(3, policy, () => 0), 0);
});

Deno.test('retry follows the backoff sequence and reports each wait', async () => {
	const waits: RetryInfo[] = [];
	const errors = [new Error('a'), new Error('b'), new Error('c')];
	const seen: number[] = [];
	const result = await retry((attempt) => {
		seen.push(attempt);
		return attempt < errors.length
			? Promise.reject(errors[attempt])
			: Promise.resolve('ok');
	}, {
		signal: never,
		baseDelayMs: 2,
		maxDelayMs: 5,
		shouldRetry: () => true,
		onRetry: (info) => waits.push(info),
		random: () => 0.5,
	});
	assert.equal(result, 'ok');
	assert.deepEqual(seen, [0, 1, 2, 3]);
	assert.deepEqual(waits.map((w) => w.delayMs), [1, 2, 2]);
	assert.deepEqual(waits.map((w) => w.attempt), [0, 1, 2]);
	assert.deepEqual(waits.map((w) => w.error), errors);
});

Deno.test('retry rethrows the last error unchanged when attempts run out', async () => {
	let calls = 0;
	let waits = 0;
	const last = new TypeError('final');
	await assert.rejects(
		retry(() => {
			calls += 1;
			return Promise.reject(calls === 3 ? last : new Error(`try ${calls}`));
		}, {
			signal: never,
			maxAttempts: 3,
			baseDelayMs: 0,
			shouldRetry: () => true,
			onRetry: () => waits += 1,
		}),
		(error) => {
			assert.equal(error, last);
			return true;
		},
	);
	assert.equal(calls, 3);
	assert.equal(waits, 2);
});

Deno.test('retry calls fn once when shouldRetry declines', async () => {
	let calls = 0;
	const failure = new Error('permanent');
	await assert.rejects(
		retry(() => {
			calls += 1;
			return Promise.reject(failure);
		}, { signal: never, shouldRetry: () => false }),
		(error) => error === failure,
	);
	assert.equal(calls, 1);
});

Deno.test('retry uses a requested delay, capped by maxRetryAfterMs', async () => {
	const delays: number[] = [];
	let calls = 0;
	await retry(() => {
		calls += 1;
		return calls < 4 ? Promise.reject(new Error('busy')) : Promise.resolve();
	}, {
		signal: never,
		maxRetryAfterMs: 3,
		baseDelayMs: 1,
		shouldRetry: () =>
			calls === 1
				? { retryAfterMs: 2 }
				: calls === 2
				? { retryAfterMs: 999_999 }
				: { retryAfterMs: undefined },
		onRetry: ({ delayMs }) => delays.push(delayMs),
		random: () => 0,
	});
	assert.deepEqual(delays, [2, 3, 0]);
});

Deno.test('retry stops with the cancel reason when aborted during a wait', async () => {
	const controller = new AbortController();
	const reason = new Error('cancelled');
	let calls = 0;
	const pending = retry(() => {
		calls += 1;
		return Promise.reject(new Error('flaky'));
	}, {
		signal: controller.signal,
		shouldRetry: () => ({ retryAfterMs: 60_000 }),
		onRetry: () => controller.abort(reason),
	});
	await assert.rejects(pending, (error) => error === reason);
	assert.equal(calls, 1);
});

Deno.test('retry does not retry a failure caused by cancellation', async () => {
	const controller = new AbortController();
	const reason = new Error('cancelled');
	let calls = 0;
	let asked = 0;
	await assert.rejects(
		retry(() => {
			calls += 1;
			controller.abort(reason);
			return Promise.reject(new Error('aborted fetch'));
		}, {
			signal: controller.signal,
			shouldRetry: () => {
				asked += 1;
				return true;
			},
		}),
		(error) => error === reason,
	);
	assert.equal(calls, 1);
	assert.equal(asked, 0);
});

Deno.test('retry never starts with an aborted signal', async () => {
	const reason = new Error('gone');
	let calls = 0;
	await assert.rejects(
		retry(() => {
			calls += 1;
			return Promise.resolve();
		}, { signal: AbortSignal.abort(reason), shouldRetry: () => true }),
		(error) => error === reason,
	);
	assert.equal(calls, 0);
});

Deno.test('the default policy matches the documented values', () => {
	assert.deepEqual(DEFAULT_RETRY_POLICY, {
		maxAttempts: 6,
		baseDelayMs: 1_000,
		maxDelayMs: 60_000,
		maxRetryAfterMs: 300_000,
	});
});

Deno.test('parseRetryAfter accepts delay-seconds and HTTP-dates', () => {
	const now = Date.parse('2026-10-19T12:00:00Z');
	assert.equal(parseRetryAfter('120', now), 120_000);
	assert.equal(parseRetryAfter(' 0 ', now), 0);
	assert.equal(parseRetryAfter('1.5', now), 1_500);
	assert.equal(parseRetryAfter('Mon, 19 Oct 2026 12:00:30 GMT', now), 30_000);
	assert.equal(parseRetryAfter('Mon, 19 Oct 2026 11:59:00 GMT', now), 0);
	assert.equal(parseRetryAfter(null, now), undefined);
	assert.equal(parseRetryAfter('', now), undefined);
	assert.equal(parseRetryAfter('-5', now), undefined);
	assert.equal(parseRetryAfter('soon', now), undefined);
});
