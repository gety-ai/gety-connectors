import assert from 'node:assert/strict';
import {
	buildIssueUpdate,
	issueDateBoundary,
	type LinearIssue,
} from './issue.ts';

Deno.test('issueDateBoundary subtracts the configured overlap', () => {
	assert.equal(
		issueDateBoundary('2026-06-03T00:00:01.000Z', {
			incrementalOverlapMs: 1000,
		}),
		'2026-06-03T00:00:00.000Z',
	);
});

Deno.test('buildIssueUpdate emits preview timestamps outside markdown content', () => {
	const update = buildIssueUpdate(
		issue({
			createdAt: '2026-06-03T00:00:01.000Z',
			updatedAt: '2026-06-03T00:02:03.000Z',
		}),
		[],
		{ renderComments: false },
	);

	assert.equal(update.kind, 'upsert');
	assert.doesNotMatch(update.doc.content ?? '', /- Created:/);
	assert.doesNotMatch(update.doc.content ?? '', /- Updated:/);
	assert.equal(update.doc.doc_updated_at, '2026-06-03T00:02:03.000Z');
	const metadata = update.doc.metadata as Record<string, unknown>;
	assert.equal(metadata.created_at, '2026-06-03T00:00:01.000Z');
	assert.equal(Object.hasOwn(metadata, 'updated_at'), false);
});

function issue(overrides: Partial<LinearIssue>): LinearIssue {
	return {
		id: 'issue-id',
		identifier: 'DEV-410',
		title: 'Custom connector MVP',
		description: null,
		url: 'https://linear.app/example/issue/DEV-410',
		number: 410,
		priority: null,
		priorityLabel: null,
		createdAt: null,
		updatedAt: null,
		archivedAt: null,
		trashed: false,
		assignee: null,
		project: null,
		state: null,
		team: null,
		comments: null,
		...overrides,
	};
}
