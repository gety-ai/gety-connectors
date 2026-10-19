// A small GraphQL client for Linear's API on the shared HTTP layer: the
// caller's signal, a per-attempt timeout, and retries for transient failures.
//
// Linear reports rate limits with HTTP 400 and a `RATELIMITED` error code
// rather than 429, and says when a bucket refills through
// `X-RateLimit-*-Reset` headers (UTC epoch milliseconds) rather than
// Retry-After (https://linear.app/developers/rate-limiting). The fetch wrapper
// below turns the reset time of an exhausted bucket into Retry-After, so the
// shared retry waits for it (capped by the retry policy).

import {
	DEFAULT_RETRY_STATUSES,
	type FetchLike,
	HttpError,
	requestJson,
	TransportError,
} from '@gety-connectors/utils/http';
import { isRecord } from '@gety-connectors/utils/json';
import {
	IncompleteEnumerationError,
	requireArray,
} from '@gety-connectors/utils/paginate';
import type { RetryInfo, RetryPolicy } from '@gety-connectors/utils/retry';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** Per-attempt timeout of a Linear request, reading the body included. */
export const REQUEST_TIMEOUT_MS = 60_000;

const RETRY_STATUSES: readonly number[] = [...DEFAULT_RETRY_STATUSES, 400];

/** Longest response-provided text quoted per error in a message. */
const MAX_MESSAGE_DETAIL = 300;

/** One entry of a GraphQL response's `errors`. */
export interface GraphQLErrorEntry {
	message: string;
	path?: readonly (string | number)[];
	/** `extensions.code`, e.g. `RATELIMITED`, `AUTHENTICATION_ERROR`. */
	code?: string;
	/** `extensions.type`, e.g. `invalid input`, `ratelimited`. */
	type?: string;
}

/**
 * A Linear response with a non-empty `errors` list, from a 2xx response or
 * a 4xx/5xx one with a GraphQL body. The message carries the operation name,
 * the status and the errors' codes and messages, never request headers or
 * variables.
 */
export class GraphQLError extends Error {
	readonly operation: string;
	/** HTTP status; undefined for a 2xx response. */
	readonly status?: number;
	readonly errors: readonly GraphQLErrorEntry[];

	constructor(
		operation: string,
		status: number | undefined,
		errors: readonly GraphQLErrorEntry[],
		options?: ErrorOptions,
	) {
		const http = status === undefined ? '' : ` (HTTP ${status})`;
		super(
			`Linear ${operation} failed${http}: ${errors.map(describe).join('; ')}`,
			options,
		);
		this.name = 'GraphQLError';
		this.operation = operation;
		this.status = status;
		this.errors = errors;
	}
}

/** A 2xx response that does not have the shape the query asked for. */
export class UnexpectedResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnexpectedResponseError';
	}
}

export interface LinearGraphQLOptions {
	/** Personal API key, sent as the Authorization header. */
	apiKey: string;
	signal: AbortSignal;
	timeoutMs?: number;
	retry?: Partial<RetryPolicy>;
	/** Called before each retry wait; log a line here. */
	onRetry?: (info: RetryInfo & { operation: string }) => void;
	fetch?: FetchLike;
	now?: () => number;
}

export class LinearGraphQL {
	readonly #options: LinearGraphQLOptions;
	readonly #fetch: FetchLike;
	#maxComplexity: number | undefined;

	constructor(options: LinearGraphQLOptions) {
		this.#options = options;
		const send = options.fetch ?? ((input, init) => fetch(input, init));
		const now = options.now ?? Date.now;
		this.#fetch = async (input, init) => {
			const response = await send(input, init);
			const complexity = numberHeader(response.headers, 'x-complexity');
			if (complexity !== undefined) {
				this.#maxComplexity = Math.max(this.#maxComplexity ?? 0, complexity);
			}
			return withRateLimitRetryAfter(response, now());
		};
	}

	/** Highest `X-Complexity` Linear reported for this client's requests. */
	get maxComplexity(): number | undefined {
		return this.#maxComplexity;
	}

	/**
	 * Runs `query` and returns its `data`. Throws `GraphQLError` for a
	 * response with `errors` (partial data included), `HttpError` or
	 * `TransportError` once retries are used up, `UnexpectedResponseError` for
	 * a 2xx response without `data`, and the signal's reason on cancellation.
	 */
	async request<T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> {
		const operation = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ??
			'request';
		let body: Record<string, unknown>;
		try {
			body = await requestJson(LINEAR_GRAPHQL_URL, {
				method: 'POST',
				headers: { Authorization: this.#options.apiKey },
				body: { query, variables },
				signal: this.#options.signal,
				timeoutMs: this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS,
				fetch: this.#fetch,
				retry: {
					...this.#options.retry,
					statuses: RETRY_STATUSES,
					// 400 is also Linear's status for invalid queries and input;
					// only the rate-limit flavor is transient.
					shouldRetry: (error) =>
						!(error instanceof HttpError && error.status === 400) ||
						isRateLimited(error.body),
					onRetry: (info) => this.#options.onRetry?.({ ...info, operation }),
				},
			});
		} catch (error) {
			if (error instanceof HttpError && isRecord(error.body)) {
				const errors = parseErrors(error.body.errors);
				if (errors !== undefined) {
					throw new GraphQLError(operation, error.status, errors, {
						cause: error,
					});
				}
			}
			throw error;
		}
		const errors = parseErrors(body.errors);
		if (errors !== undefined) {
			throw new GraphQLError(operation, undefined, errors);
		}
		if (!isRecord(body.data)) {
			throw new UnexpectedResponseError(
				`Linear ${operation} returned no data`,
			);
		}
		return body.data as T;
	}
}

/**
 * True when every error of `error` says that the entity requested at the root
 * field `field` does not exist. Any other error, a not-found error on a nested
 * field included, is no proof that the entity is gone.
 *
 * Linear's wording is not part of its schema: both `extensions.code`
 * `ENTITY_NOT_FOUND` and the message `Entity not found...` (reported with
 * `INVALID_INPUT`) are accepted.
 */
export function isEntityNotFound(error: unknown, field: string): boolean {
	return error instanceof GraphQLError &&
		error.errors.every((entry) =>
			(entry.code === 'ENTITY_NOT_FOUND' ||
				/^Entity not found\b/i.test(entry.message)) &&
			(entry.path === undefined ||
				(entry.path.length === 1 && entry.path[0] === field))
		);
}

/** A short reason for a retry log line. */
export function retryReason(error: unknown): string {
	if (error instanceof HttpError) {
		return isRateLimited(error.body) ? 'rate_limited' : `http_${error.status}`;
	}
	if (error instanceof TransportError) {
		return error.timedOut ? 'timeout' : 'network';
	}
	return 'unknown';
}

/** A Relay connection as Linear returns it. */
export interface Connection<T> {
	nodes: T[];
	pageInfo: { endCursor?: string | null; hasNextPage: boolean };
}

/**
 * `value` checked as a connection whose nodes are objects with a string `id`.
 * Anything else is an `UnexpectedResponseError`: an unknown shape must fail
 * the poll, not read as an empty page.
 */
export function requireConnection<T extends { id: string }>(
	value: unknown,
	context: string,
): Connection<T> {
	const connection = requireRecord(value, context);
	const nodes = requireArray(connection.nodes, `${context}.nodes`);
	for (const node of nodes) {
		if (!isRecord(node) || typeof node.id !== 'string') {
			throw new UnexpectedResponseError(
				`${context}.nodes: expected objects with a string id`,
			);
		}
	}
	const pageInfo = requireRecord(connection.pageInfo, `${context}.pageInfo`);
	const endCursor = pageInfo.endCursor;
	if (
		typeof pageInfo.hasNextPage !== 'boolean' ||
		(endCursor != null && typeof endCursor !== 'string')
	) {
		throw new UnexpectedResponseError(
			`${context}.pageInfo: unexpected hasNextPage or endCursor`,
		);
	}
	return connection as unknown as Connection<T>;
}

/**
 * The cursor of the page after `connection`, which was requested with
 * `after`; undefined on the last page. A page that has more results but no
 * cursor would silently truncate the enumeration, and one that returns the
 * requested cursor would repeat itself forever, so both are an
 * `IncompleteEnumerationError`.
 */
export function nextPageCursor(
	connection: Connection<unknown>,
	after: string | undefined,
	context: string,
): string | undefined {
	if (!connection.pageInfo.hasNextPage) {
		return undefined;
	}
	const cursor = connection.pageInfo.endCursor;
	if (cursor == null || cursor === '') {
		throw new IncompleteEnumerationError(
			`${context}: the response has more results but no next cursor`,
		);
	}
	if (cursor === after) {
		throw new IncompleteEnumerationError(
			`${context}: the next cursor repeats the requested cursor`,
		);
	}
	return cursor;
}

export function requireRecord(
	value: unknown,
	context: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new UnexpectedResponseError(`${context}: expected an object`);
	}
	return value;
}

function parseErrors(value: unknown): GraphQLErrorEntry[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	return value.map((entry): GraphQLErrorEntry => {
		const record = isRecord(entry) ? entry : {};
		const extensions = isRecord(record.extensions) ? record.extensions : {};
		return {
			message: typeof record.message === 'string'
				? record.message
				: 'unknown error',
			path: Array.isArray(record.path)
				? record.path.filter((part): part is string | number =>
					typeof part === 'string' || typeof part === 'number'
				)
				: undefined,
			code: typeof extensions.code === 'string' ? extensions.code : undefined,
			type: typeof extensions.type === 'string' ? extensions.type : undefined,
		};
	});
}

function isRateLimited(body: unknown): boolean {
	const errors = isRecord(body) ? parseErrors(body.errors) : undefined;
	return errors?.some((error) =>
		error.code === 'RATELIMITED' || error.type === 'ratelimited'
	) ?? false;
}

function describe(error: GraphQLErrorEntry): string {
	const text = error.code === undefined
		? error.message
		: `${error.code}: ${error.message}`;
	return text.slice(0, MAX_MESSAGE_DETAIL);
}

/**
 * `response` with a Retry-After header derived from Linear's rate-limit
 * headers when it is an error response without one and a bucket is
 * exhausted: the wait until the latest such bucket resets.
 */
function withRateLimitRetryAfter(response: Response, nowMs: number): Response {
	if (response.ok || response.headers.has('retry-after')) {
		return response;
	}
	const delayMs = rateLimitDelayMs(response.headers, nowMs);
	if (delayMs === undefined) {
		return response;
	}
	const headers = new Headers(response.headers);
	headers.set('retry-after', String(Math.ceil(delayMs / 1000)));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Milliseconds until every exhausted Linear rate-limit bucket resets, or
 * undefined when the headers show none exhausted. The complexity bucket is
 * exhausted when what remains is less than this query's complexity.
 */
export function rateLimitDelayMs(
	headers: Headers,
	nowMs: number,
): number | undefined {
	const buckets = [
		{ prefix: 'x-ratelimit-requests', needs: 1 },
		{ prefix: 'x-ratelimit-endpoint-requests', needs: 1 },
		{
			prefix: 'x-ratelimit-complexity',
			needs: numberHeader(headers, 'x-complexity') ?? 1,
		},
	];
	let delayMs: number | undefined;
	for (const { prefix, needs } of buckets) {
		const remaining = numberHeader(headers, `${prefix}-remaining`);
		const resetAt = numberHeader(headers, `${prefix}-reset`);
		if (
			remaining === undefined || resetAt === undefined || remaining >= needs
		) {
			continue;
		}
		delayMs = Math.max(delayMs ?? 0, resetAt - nowMs);
	}
	return delayMs;
}

function numberHeader(headers: Headers, name: string): number | undefined {
	const value = headers.get(name)?.trim();
	if (!value) {
		return undefined;
	}
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}
