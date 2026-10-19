// Cursor pagination that fails closed.
//
// A silently truncated enumeration is indistinguishable from "the rest was
// deleted" to a connector that diffs what it saw against what it knows, so
// every way the upstream can stop early without saying so is an error here.

export interface Page<T> {
	items: T[];
	hasMore: boolean;
	/** Required when `hasMore` is true. */
	nextCursor?: string | null;
}

export interface PageResult<T> {
	items: T[];
	/** Cursor this page was fetched with (undefined for the first page). */
	cursor: string | undefined;
	/** Cursor of the following page; undefined on the last page. */
	nextCursor: string | undefined;
}

/** The upstream signalled more data but gave no usable way to fetch it. */
export class IncompleteEnumerationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IncompleteEnumerationError';
	}
}

/**
 * Yields one result per page, starting at `startCursor`. Throws
 * `IncompleteEnumerationError` when a page has `hasMore` without a
 * `nextCursor`, or when a cursor repeats (the enumeration would never end or
 * would skip data). The signal is checked before every page. A caller that
 * stops early resumes later from the last yielded `nextCursor`.
 */
export async function* paginate<T>(
	fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
	options: { signal: AbortSignal; context: string; startCursor?: string },
): AsyncGenerator<PageResult<T>, void, undefined> {
	const { signal, context } = options;
	let cursor = options.startCursor;
	const seen = new Set<string>();
	if (cursor !== undefined) {
		seen.add(cursor);
	}
	while (true) {
		signal.throwIfAborted();
		const page = await fetchPage(cursor);
		if (!page.hasMore) {
			yield { items: page.items, cursor, nextCursor: undefined };
			return;
		}
		const nextCursor = page.nextCursor;
		if (typeof nextCursor !== 'string' || nextCursor === '') {
			throw new IncompleteEnumerationError(
				`${context}: the response has more results but no next cursor`,
			);
		}
		if (seen.has(nextCursor)) {
			throw new IncompleteEnumerationError(
				`${context}: the next cursor repeats an earlier cursor`,
			);
		}
		seen.add(nextCursor);
		yield { items: page.items, cursor, nextCursor };
		cursor = nextCursor;
	}
}

/** `value` when it is an array; otherwise `IncompleteEnumerationError`. */
export function requireArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new IncompleteEnumerationError(
			`${context}: expected an array of results, got ${
				value === null ? 'null' : typeof value
			}`,
		);
	}
	return value;
}
