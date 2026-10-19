// Cancellable waits and per-call timeouts.
//
// Every wait observes the caller's signal, so a cancelled poll stops promptly.
// `withTimeout` bounds one external call; whether the call ended because of
// the caller or the timeout is told apart by the caller's own signal
// (`signal.aborted`) or by `isTimeoutError(error)`: cancellation is never
// retried, a timeout may be.

/**
 * Resolves after `ms` milliseconds. Rejects with `signal.reason` when the
 * signal is already aborted or aborts while waiting; the timer and the abort
 * listener are always released.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	if (ms <= 0) {
		return Promise.resolve();
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal.reason);
	};
	const timer = setTimeout(() => {
		signal.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	signal.addEventListener('abort', onAbort, { once: true });
	return promise;
}

/**
 * A signal that aborts when `signal` aborts (reason: the caller's reason) or
 * after `timeoutMs` (reason: a `TimeoutError` DOMException), whichever comes
 * first. Create one per attempt so each attempt gets its own budget.
 */
export function withTimeout(
	signal: AbortSignal,
	timeoutMs: number,
): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** True for the reason of a signal from `withTimeout` that timed out. */
export function isTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'TimeoutError';
}
