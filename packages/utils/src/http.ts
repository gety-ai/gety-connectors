// JSON requests with a per-attempt timeout, retries for transient failures
// and a fail-closed response-shape check.
//
// Connector requests are reads, so every method (including POST, used by
// search endpoints) is retried by the same rules. A 2xx response whose body
// is not a JSON object is an error, never an empty result: a proxy or captive
// portal answering 200 with HTML must fail the poll, not end an enumeration.

import { isTimeoutError, withTimeout } from './abort.ts';
import { isRecord, parseJsonObject } from './json.ts';
import {
	parseRetryAfter,
	retry,
	type RetryInfo,
	type RetryPolicy,
} from './retry.ts';

export type FetchLike = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RETRY_STATUSES: readonly number[] = [
	408,
	429,
	500,
	502,
	503,
	504,
];

/** Longest response-provided text quoted in an error message. */
const MAX_MESSAGE_DETAIL = 300;

/**
 * A non-2xx response. The message names the method, URL path and status and
 * the body's `code`/`message` strings; it never contains request headers,
 * the request body or the query string.
 */
export class HttpError extends Error {
	readonly status: number;
	/** Parsed JSON body, or the raw text when it is not JSON. */
	readonly body: unknown;
	/** The response's Retry-After, when present and valid. */
	readonly retryAfterMs?: number;

	constructor(
		request: string,
		status: number,
		body: unknown,
		retryAfterMs?: number,
	) {
		super(`${request} failed with HTTP ${status}${bodyDetail(body)}`);
		this.name = 'HttpError';
		this.status = status;
		this.body = body;
		this.retryAfterMs = retryAfterMs;
	}
}

/** A 2xx response whose body is not a JSON object. Not retried. */
export class ResponseShapeError extends Error {
	readonly status: number;

	constructor(request: string, status: number, contentType: string | null) {
		super(
			`${request} returned HTTP ${status} without a JSON object body` +
				` (content-type: ${contentType ?? 'none'})`,
		);
		this.name = 'ResponseShapeError';
		this.status = status;
	}
}

/**
 * The request did not complete: a network error or the per-attempt timeout.
 * Retried; `cause` is the underlying error.
 */
export class TransportError extends Error {
	readonly timedOut: boolean;

	constructor(request: string, cause: unknown, timeoutMs: number) {
		const timedOut = isTimeoutError(cause);
		super(
			timedOut
				? `${request} timed out after ${timeoutMs} ms`
				: `${request} failed: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			{ cause },
		);
		this.name = 'TransportError';
		this.timedOut = timedOut;
	}
}

export interface HttpRetryOptions extends Partial<RetryPolicy> {
	/** Statuses retried; default `DEFAULT_RETRY_STATUSES`. */
	statuses?: readonly number[];
	/**
	 * Veto for an error that would otherwise be retried (a listed status or a
	 * `TransportError`); return false to rethrow it. Example: Notion's
	 * `public_api_request_blocked`.
	 */
	shouldRetry?: (error: unknown) => boolean;
	/** Called before each wait; log a progress line here. */
	onRetry?: (info: RetryInfo) => void;
}

export interface JsonRequestInit {
	method?: string;
	headers?: Record<string, string>;
	/** Serialized with JSON.stringify; sets Content-Type unless given. */
	body?: unknown;
	signal: AbortSignal;
	/** Per-attempt timeout, including reading the body. */
	timeoutMs?: number;
	retry?: HttpRetryOptions;
	/** Runs before every attempt, retries included (e.g. a throttle). */
	beforeAttempt?: (signal: AbortSignal) => Promise<void>;
	fetch?: FetchLike;
}

/**
 * Sends a request and returns the 2xx response body as a JSON object.
 *
 * - Caller cancellation: `signal.reason` is thrown, never retried or wrapped.
 * - `TransportError` (network error, timeout) and `HttpError` with a status
 *   in `retry.statuses` are retried, honoring Retry-After within the cap.
 * - Other non-2xx: `HttpError`. 2xx without a JSON object body:
 *   `ResponseShapeError`. Neither is retried.
 * - When attempts run out, the last error is thrown.
 */
export async function requestJson<T = Record<string, unknown>>(
	url: string,
	init: JsonRequestInit,
): Promise<T> {
	const method = init.method ?? 'GET';
	const request = `${method} ${urlPath(url)}`;
	const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchFn = init.fetch ?? fetch;
	const statuses = init.retry?.statuses ?? DEFAULT_RETRY_STATUSES;
	const headers = { ...init.headers };
	let body: string | undefined;
	if (init.body !== undefined) {
		body = JSON.stringify(init.body);
		if (!Object.keys(headers).some((n) => n.toLowerCase() === 'content-type')) {
			headers['Content-Type'] = 'application/json';
		}
	}

	const attempt = async (_: number, signal: AbortSignal): Promise<T> => {
		await init.beforeAttempt?.(signal);
		const attemptSignal = withTimeout(signal, timeoutMs);
		let response: Response;
		let text: string;
		try {
			response = await fetchFn(url, {
				method,
				headers,
				body,
				signal: attemptSignal,
			});
			text = await response.text();
		} catch (error) {
			signal.throwIfAborted();
			throw new TransportError(request, error, timeoutMs);
		}
		if (!response.ok) {
			throw new HttpError(
				request,
				response.status,
				parseJsonOrText(text),
				parseRetryAfter(response.headers.get('retry-after'), Date.now()),
			);
		}
		const record = parseJsonObject(text);
		if (record === undefined) {
			throw new ResponseShapeError(
				request,
				response.status,
				response.headers.get('content-type'),
			);
		}
		return record as T;
	};

	return await retry(attempt, {
		...init.retry,
		signal: init.signal,
		shouldRetry: (error) => {
			const retryable = error instanceof TransportError ||
				(error instanceof HttpError && statuses.includes(error.status));
			if (!retryable || init.retry?.shouldRetry?.(error) === false) {
				return false;
			}
			return {
				retryAfterMs: error instanceof HttpError
					? error.retryAfterMs
					: undefined,
			};
		},
	});
}

function urlPath(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return '(invalid URL)';
	}
}

function parseJsonOrText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function bodyDetail(body: unknown): string {
	if (!isRecord(body)) {
		return '';
	}
	const parts = [body.code, body.message]
		.filter((part): part is string => typeof part === 'string' && part !== '')
		.map((part) => part.slice(0, MAX_MESSAGE_DETAIL));
	return parts.length === 0 ? '' : `: ${parts.join(': ')}`;
}
