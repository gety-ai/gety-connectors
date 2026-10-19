import assert from 'node:assert/strict';
import { staleIds } from './reconcile.ts';

Deno.test('a complete enumeration yields the unseen known ids in order', () => {
	assert.deepEqual(
		staleIds(['d', 'a', 'c', 'b'], {
			seen: new Set(['a', 'b', 'x']),
			complete: true,
		}),
		['d', 'c'],
	);
});

Deno.test('a partial enumeration yields no deletions', () => {
	assert.deepEqual(
		staleIds(['a', 'b'], { seen: new Set(), complete: false }),
		[],
	);
});

Deno.test('known may be empty or any iterable', () => {
	assert.deepEqual(staleIds([], { seen: new Set(['a']), complete: true }), []);
	assert.deepEqual(
		staleIds(new Map([['k', 1], ['j', 2]]).keys(), {
			seen: new Set(['j']),
			complete: true,
		}),
		['k'],
	);
	assert.deepEqual(
		staleIds(['a'], { seen: new Set(), complete: true }),
		['a'],
		'an empty complete enumeration deletes everything known',
	);
});
