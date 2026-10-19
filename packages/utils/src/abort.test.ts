import assert from 'node:assert/strict';
import { isTimeoutError, sleep, withTimeout } from './abort.ts';

/** An AbortSignal that counts its live abort listeners. */
function countingSignal() {
	const controller = new AbortController();
	const signal = controller.signal;
	let listeners = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((...args: Parameters<typeof add>) => {
		listeners += 1;
		add(...args);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
		listeners -= 1;
		remove(...args);
	}) as typeof signal.removeEventListener;
	return { controller, signal, listeners: () => listeners };
}

Deno.test('sleep resolves immediately for ms <= 0', async () => {
	await sleep(0, new AbortController().signal);
	await sleep(-5, new AbortController().signal);
});

Deno.test('sleep rejects with the reason of an already aborted signal', async () => {
	const reason = new Error('cancelled');
	await assert.rejects(sleep(10, AbortSignal.abort(reason)), (error) => {
		assert.equal(error, reason);
		return true;
	});
	await assert.rejects(sleep(0, AbortSignal.abort(reason)), (error) => {
		assert.equal(error, reason);
		return true;
	});
});

Deno.test('sleep rejects with the original reason when aborted while waiting', async () => {
	// The test sanitizer fails the test if the 60 s timer is left running.
	const controller = new AbortController();
	const reason = new Error('stop');
	const pending = sleep(60_000, controller.signal);
	controller.abort(reason);
	await assert.rejects(pending, (error) => {
		assert.equal(error, reason);
		return true;
	});
});

Deno.test('sleep removes its abort listener after a normal wait', async () => {
	const { signal, listeners } = countingSignal();
	await sleep(1, signal);
	assert.equal(listeners(), 0);
});

Deno.test('withTimeout tells a timeout from caller cancellation', async () => {
	const caller = new AbortController();
	const timed = withTimeout(caller.signal, 5);
	await sleep(20, new AbortController().signal);
	assert.equal(timed.aborted, true);
	assert.equal(isTimeoutError(timed.reason), true);
	assert.equal(caller.signal.aborted, false);

	const cancelled = new AbortController();
	const reason = new Error('user cancelled');
	const signal = withTimeout(cancelled.signal, 60_000);
	cancelled.abort(reason);
	assert.equal(signal.aborted, true);
	assert.equal(signal.reason, reason);
	assert.equal(isTimeoutError(signal.reason), false);
});

Deno.test('isTimeoutError only matches TimeoutError', () => {
	assert.equal(isTimeoutError(new DOMException('x', 'TimeoutError')), true);
	assert.equal(isTimeoutError(new DOMException('x', 'AbortError')), false);
	assert.equal(isTimeoutError(new Error('TimeoutError')), false);
});
