import assert from 'node:assert/strict';
import {
	IncompleteEnumerationError,
	type Page,
	type PageResult,
	paginate,
	requireArray,
} from './paginate.ts';

const never = new AbortController().signal;

function pages(map: Record<string, Page<number>>) {
	const requested: (string | undefined)[] = [];
	const fetchPage = (cursor: string | undefined) => {
		requested.push(cursor);
		const page = map[cursor ?? ''];
		if (page === undefined) {
			throw new Error(`no page for ${cursor}`);
		}
		return Promise.resolve(page);
	};
	return { fetchPage, requested };
}

async function collect<T>(
	iterable: AsyncIterable<PageResult<T>>,
): Promise<PageResult<T>[]> {
	const out: PageResult<T>[] = [];
	for await (const page of iterable) {
		out.push(page);
	}
	return out;
}

Deno.test('paginate yields every page with its cursors', async () => {
	const { fetchPage, requested } = pages({
		'': { items: [1, 2], hasMore: true, nextCursor: 'b' },
		b: { items: [3], hasMore: true, nextCursor: 'c' },
		c: { items: [4], hasMore: false, nextCursor: null },
	});
	const result = await collect(
		paginate(fetchPage, { signal: never, context: 'test' }),
	);
	assert.deepEqual(result, [
		{ items: [1, 2], cursor: undefined, nextCursor: 'b' },
		{ items: [3], cursor: 'b', nextCursor: 'c' },
		{ items: [4], cursor: 'c', nextCursor: undefined },
	]);
	assert.deepEqual(requested, [undefined, 'b', 'c']);
});

Deno.test('paginate resumes from startCursor', async () => {
	const { fetchPage, requested } = pages({
		c: { items: [4], hasMore: false },
	});
	const result = await collect(
		paginate(fetchPage, { signal: never, context: 'test', startCursor: 'c' }),
	);
	assert.deepEqual(result, [{
		items: [4],
		cursor: 'c',
		nextCursor: undefined,
	}]);
	assert.deepEqual(requested, ['c']);
});

Deno.test('hasMore without a cursor is an incomplete enumeration', async () => {
	for (const nextCursor of [undefined, null, '']) {
		const { fetchPage } = pages({
			'': { items: [1], hasMore: true, nextCursor },
		});
		await assert.rejects(
			collect(paginate(fetchPage, { signal: never, context: 'search' })),
			(error) => {
				assert.ok(error instanceof IncompleteEnumerationError);
				assert.match(error.message, /^search: /);
				return true;
			},
		);
	}
});

Deno.test('a repeated cursor is an incomplete enumeration', async () => {
	const same = pages({
		'': { items: [1], hasMore: true, nextCursor: 'a' },
		a: { items: [2], hasMore: true, nextCursor: 'a' },
	});
	await assert.rejects(
		collect(paginate(same.fetchPage, { signal: never, context: 'x' })),
		IncompleteEnumerationError,
	);

	const cycle = pages({
		'': { items: [1], hasMore: true, nextCursor: 'a' },
		a: { items: [2], hasMore: true, nextCursor: 'b' },
		b: { items: [3], hasMore: true, nextCursor: 'a' },
	});
	await assert.rejects(
		collect(paginate(cycle.fetchPage, { signal: never, context: 'x' })),
		IncompleteEnumerationError,
	);
	assert.deepEqual(cycle.requested, [undefined, 'a', 'b']);
});

Deno.test('paginate checks the signal between pages', async () => {
	const controller = new AbortController();
	const reason = new Error('cancelled');
	const { fetchPage, requested } = pages({
		'': { items: [1], hasMore: true, nextCursor: 'b' },
		b: { items: [2], hasMore: false },
	});
	const seen: number[] = [];
	await assert.rejects(
		(async () => {
			for await (
				const page of paginate(fetchPage, {
					signal: controller.signal,
					context: 'x',
				})
			) {
				seen.push(...page.items);
				controller.abort(reason);
			}
		})(),
		(error) => error === reason,
	);
	assert.deepEqual(seen, [1]);
	assert.deepEqual(requested, [undefined]);
});

Deno.test('breaking early leaves the resume cursor on the last page', async () => {
	const { fetchPage, requested } = pages({
		'': { items: [1], hasMore: true, nextCursor: 'b' },
		b: { items: [2], hasMore: true, nextCursor: 'c' },
		c: { items: [3], hasMore: false },
	});
	let resume: string | undefined;
	let count = 0;
	for await (
		const page of paginate(fetchPage, { signal: never, context: 'x' })
	) {
		resume = page.nextCursor;
		count += page.items.length;
		if (count >= 2) {
			break;
		}
	}
	assert.equal(resume, 'c');
	assert.deepEqual(requested, [undefined, 'b']);
});

Deno.test('requireArray rejects non-arrays', () => {
	assert.deepEqual(requireArray([1], 'x'), [1]);
	for (const value of [undefined, null, {}, 'a', 1]) {
		assert.throws(
			() => requireArray(value, 'results'),
			IncompleteEnumerationError,
		);
	}
});
