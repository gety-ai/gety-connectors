import assert from 'node:assert/strict';
import {
	shouldRebuildAllIssuesForState,
	STATE_SCHEMA_VERSION,
} from './index.ts';

Deno.test('shouldRebuildAllIssuesForState rebuilds when schema is stale', () => {
	assert.equal(
		shouldRebuildAllIssuesForState({
			index_comments: true,
			schema_version: 1,
		}, true),
		true,
	);
	assert.equal(
		shouldRebuildAllIssuesForState({
			index_comments: true,
		}, true),
		true,
	);
});

Deno.test('shouldRebuildAllIssuesForState preserves index_comments rebuild rules', () => {
	assert.equal(
		shouldRebuildAllIssuesForState({
			index_comments: true,
			schema_version: STATE_SCHEMA_VERSION,
		}, true),
		false,
	);
	assert.equal(
		shouldRebuildAllIssuesForState({
			index_comments: false,
			schema_version: STATE_SCHEMA_VERSION,
		}, true),
		true,
	);
	assert.equal(
		shouldRebuildAllIssuesForState({
			index_comments: true,
			schema_version: STATE_SCHEMA_VERSION,
		}, false),
		true,
	);
});
