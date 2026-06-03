import assert from 'node:assert/strict';
import { issueDateBoundary } from './issue.ts';

Deno.test('issueDateBoundary subtracts the configured overlap', () => {
	assert.equal(
		issueDateBoundary('2026-06-03T00:00:01.000Z', {
			incrementalOverlapMs: 1000,
		}),
		'2026-06-03T00:00:00.000Z',
	);
});
