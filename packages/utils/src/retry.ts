// Retry with capped exponential backoff (full jitter) and Retry-After.
//
// The host treats a poll with no frame for 10 minutes as hung, so a single
// wait must stay well below that and should be announced first: `onRetry`
// runs before every wait, which is where a connector logs a progress line.

import { sleep } from './abort.ts';

export interface RetryPolicy {
	/** Attempts including the first one. */
	maxAttempts: number;
	/** Backoff base: attempt n (0-based) waits up to `baseDelayMs * 2^n`. */
	baseDelayMs: number;
	/** Upper bound of a backoff delay. */
	maxDelayMs: number;
	/**
	 * Upper bound of a server-requested delay (Retry-After). Larger than
	 * `maxDelayMs` because workspace-level rate limits can ask for more than
	 * a minute, and below the host's 10-minute idle limit.
	 */
	maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
	maxAttempts: 6,
	baseDelayMs: 1_000,
	maxDelayMs: 60_000,
	maxRetryAfterMs: 300_000,
};

export interface RetryInfo {
	/** 0-based index of the attempt that failed. */
	attempt: number;
	delayMs: number;
	error: unknown;
}

/**
 * `false`: rethrow `error`. `true`: retry after the backoff delay.
 * `{ retryAfterMs }`: retry after that delay (capped by `maxRetryAfterMs`);
 * an undefined `retryAfterMs` means the backoff delay.
 */
export type RetryDecision = boolean | { retryAfterMs?: number };

export interface RetryOptions extends Partial<RetryPolicy> {
	signal: AbortSignal;
	shouldRetry: (error: unknown) => RetryDecision;
	onRetry?: (info: RetryInfo) => void;
	/** Jitter source in [0, 1); injectable for tests. */
	random?: () => number;
}

/**
 * Runs `fn` until it resolves, `shouldRetry` declines, or the attempts are
 * used up. The last error is rethrown unchanged so callers can classify it.
 * When the caller's signal is aborted, no further attempt is made and
 * `signal.reason` is thrown.
 */
export async function retry<T>(
	fn: (attempt: number, signal: AbortSignal) => Promise<T>,
	options: RetryOptions,
): Promise<T> {
	const { signal, shouldRetry, onRetry, random = Math.random } = options;
	const policy: RetryPolicy = {
		maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
		baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
		maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
		maxRetryAfterMs: options.maxRetryAfterMs ??
			DEFAULT_RETRY_POLICY.maxRetryAfterMs,
	};
	for (let attempt = 0;; attempt += 1) {
		signal.throwIfAborted();
		try {
			return await fn(attempt, signal);
		} catch (error) {
			signal.throwIfAborted();
			if (attempt + 1 >= policy.maxAttempts) {
				throw error;
			}
			const decision = shouldRetry(error);
			if (decision === false) {
				throw error;
			}
			const requested = decision === true ? undefined : decision.retryAfterMs;
			const delayMs = requested === undefined
				? backoffDelay(attempt, policy, random)
				: Math.min(Math.max(0, requested), policy.maxRetryAfterMs);
			onRetry?.({ attempt, delayMs, error });
			await sleep(delayMs, signal);
		}
	}
}

/**
 * Full-jitter backoff for the 0-based `attempt` that just failed:
 * `random() * min(maxDelayMs, baseDelayMs * 2^attempt)`, rounded down.
 */
export function backoffDelay(
	attempt: number,
	policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
	random: () => number = Math.random,
): number {
	const ceiling = Math.min(
		policy.maxDelayMs,
		policy.baseDelayMs * 2 ** attempt,
	);
	return Math.floor(random() * ceiling);
}

/**
 * A Retry-After header value in milliseconds: delay-seconds or an HTTP-date
 * (relative to `nowMs`, never negative). Undefined when absent or invalid.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	nowMs: number,
): number | undefined {
	const text = value?.trim();
	if (!text) {
		return undefined;
	}
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		return Math.round(Number(text) * 1000);
	}
	// HTTP-dates always spell out the month; this keeps Date.parse from
	// reading bare numbers such as "-5" as years.
	const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
	return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
