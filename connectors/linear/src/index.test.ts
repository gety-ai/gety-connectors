import assert from 'node:assert/strict';
import {
	buildIssueBoundary,
	buildIssueFilter,
	type LinearState,
	nextCommentUpdatedAt,
	nextIssueUpdatedAt,
	nextStateAfterCommentSync,
	nextStateAfterIssuePage,
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

Deno.test('buildIssueFilter uses a stable in-progress boundary', () => {
	assert.deepEqual(
		buildIssueFilter(
			{
				issue_delta_boundary: '2026-06-03T00:00:00.000Z',
				last_issue_updated_at: '2026-06-03T01:00:00.000Z',
			},
			false,
			{
				incrementalOverlapMs: 1000,
			},
		),
		{ updatedAt: { gte: '2026-06-03T00:00:00.000Z' } },
	);
	assert.equal(
		buildIssueBoundary(
			{
				last_issue_updated_at: '2026-06-03T01:00:00.000Z',
			},
			false,
			{
				incrementalOverlapMs: 1000,
			},
		),
		'2026-06-03T00:59:59.000Z',
	);
	assert.equal(
		buildIssueFilter(
			{
				last_issue_updated_at: '2026-06-03T01:00:00.000Z',
			},
			true,
			{
				incrementalOverlapMs: 1000,
			},
		),
		undefined,
	);
});

Deno.test('nextStateAfterIssuePage persists partial issue cursors', () => {
	const partial = nextStateAfterIssuePage({}, {
		boundary: '2026-06-03T00:00:00.000Z',
		hitLimit: true,
		maxUpdatedAt: '2026-06-03T00:02:00.000Z',
		nextAfter: 'issue-cursor',
		rebuildAllIssues: true,
	}, true);

	assert.deepEqual(partial, {
		schema_version: STATE_SCHEMA_VERSION,
		last_issue_updated_at: undefined,
		issue_delta_after: 'issue-cursor',
		issue_delta_boundary: '2026-06-03T00:00:00.000Z',
		issue_delta_max_updated_at: '2026-06-03T00:02:00.000Z',
		rebuild_issue_sync: true,
		last_comment_updated_at: undefined,
		comment_delta_after: undefined,
		comment_delta_boundary: undefined,
		comment_delta_max_updated_at: undefined,
		index_comments: true,
	});
});

Deno.test('nextStateAfterIssuePage keeps comment cursor independent', () => {
	const state = nextStateAfterIssuePage({
		last_comment_updated_at: '2026-06-03T00:01:00.000Z',
		comment_delta_after: 'comment-cursor',
		comment_delta_boundary: '2026-06-03T00:00:00.000Z',
		comment_delta_max_updated_at: '2026-06-03T00:02:00.000Z',
	}, {
		hitLimit: false,
		maxUpdatedAt: '2026-06-03T00:03:00.000Z',
		nextAfter: undefined,
		rebuildAllIssues: false,
	}, true);

	assert.equal(
		state.last_comment_updated_at,
		'2026-06-03T00:01:00.000Z',
	);
	assert.equal(state.comment_delta_after, 'comment-cursor');
	assert.equal(state.comment_delta_boundary, '2026-06-03T00:00:00.000Z');
	assert.equal(
		state.comment_delta_max_updated_at,
		'2026-06-03T00:02:00.000Z',
	);
});

Deno.test('next issue state advances only after pagination completes', () => {
	const state: LinearState = {
		last_issue_updated_at: '2026-06-03T00:00:00.000Z',
		issue_delta_max_updated_at: '2026-06-03T00:03:00.000Z',
	};

	assert.equal(
		nextIssueUpdatedAt(state, {
			maxUpdatedAt: '2026-06-03T00:04:00.000Z',
			nextAfter: 'issue-cursor',
		}),
		'2026-06-03T00:00:00.000Z',
	);
	assert.equal(
		nextIssueUpdatedAt(state, {
			nextAfter: undefined,
		}),
		'2026-06-03T00:03:00.000Z',
	);
});

Deno.test('nextStateAfterCommentSync resumes and completes comment cursors', () => {
	const state: LinearState = {
		last_comment_updated_at: '2026-06-03T00:00:00.000Z',
		comment_delta_max_updated_at: '2026-06-03T00:02:00.000Z',
	};
	const partial = nextStateAfterCommentSync(state, {
		issueIds: new Set(['issue-id']),
		commentCount: 50,
		maxUpdatedAt: '2026-06-03T00:03:00.000Z',
		boundary: '2026-06-02T23:59:59.000Z',
		nextAfter: 'comment-cursor',
		hitLimit: true,
	}, true);

	assert.equal(partial.last_comment_updated_at, state.last_comment_updated_at);
	assert.equal(partial.comment_delta_after, 'comment-cursor');

	const complete = nextStateAfterCommentSync(partial, {
		issueIds: new Set(),
		commentCount: 0,
		boundary: partial.comment_delta_boundary,
		maxUpdatedAt: undefined,
		nextAfter: undefined,
		hitLimit: false,
	}, true);
	assert.equal(
		nextCommentUpdatedAt(partial, {
			issueIds: new Set(),
			commentCount: 0,
			boundary: partial.comment_delta_boundary,
			maxUpdatedAt: undefined,
			nextAfter: undefined,
			hitLimit: false,
		}),
		'2026-06-03T00:03:00.000Z',
	);
	assert.equal(complete.last_comment_updated_at, '2026-06-03T00:03:00.000Z');
	assert.equal(complete.comment_delta_after, undefined);
});
