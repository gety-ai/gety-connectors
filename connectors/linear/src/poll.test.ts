import assert from 'node:assert/strict';
import type { DocUpdate } from '@gety-ai/connector-sdk';
import { jsonResponse, runPoll } from '@gety-connectors/testing';
import { type FakeIssue, FakeLinear, withFakeLinear } from './fake_linear.ts';
import LinearConnector from './index.ts';

const API_KEY = 'lin_api_test_secret';

function poll(
	fake: FakeLinear,
	init: { lastState?: unknown; indexComments?: boolean; signal?: AbortSignal } =
		{},
) {
	return withFakeLinear(fake, () =>
		runPoll(new LinearConnector(), {
			config: { api_key: API_KEY, index_comments: init.indexComments ?? true },
			lastState: init.lastState,
			signal: init.signal,
		}));
}

function issue(n: number, overrides: Partial<FakeIssue> = {}): FakeIssue {
	const time = new Date(Date.UTC(2026, 5, 3, 0, n)).toISOString();
	return {
		id: `issue-${n}`,
		identifier: `ENG-${n}`,
		title: `Issue ${n}`,
		createdAt: time,
		updatedAt: time,
		...overrides,
	};
}

function errorsOf(...errors: Record<string, unknown>[]) {
	return { errors };
}

const CAUGHT_UP = {
	schema_version: 2,
	index_comments: true,
	last_issue_updated_at: '2026-06-03T00:10:00.000Z',
	last_comment_updated_at: '2026-06-03T00:10:00.000Z',
};

Deno.test('poll sends the API key and indexes issues', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1), issue(2)];

	const run = await poll(fake);

	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(
		run.updates.map((update) => update.kind === 'upsert' && update.doc.id),
		['linear:issue:issue-1', 'linear:issue:issue-2'],
	);
	assert.ok(fake.requests.every((r) => r.authorization === API_KEY));
});

Deno.test('poll retries HTTP 429 after Retry-After', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	let limited = 0;
	fake.intercept = () => {
		if (limited++ === 0) {
			return jsonResponse({}, {
				status: 429,
				headers: { 'retry-after': '0' },
			});
		}
	};

	const run = await poll(fake);

	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(fake.operations().slice(0, 2), [
		'GetyLinearIssues',
		'GetyLinearIssues',
	]);
	assert.equal(run.updates.length, 1);
});

Deno.test('poll does not retry an authentication error or leak the key', async () => {
	const fake = new FakeLinear();
	fake.intercept = () =>
		jsonResponse(
			errorsOf({
				message: 'Authentication required, not authenticated',
				extensions: {
					type: 'authentication error',
					code: 'AUTHENTICATION_ERROR',
				},
			}),
			{ status: 401 },
		);

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.equal(fake.requests.length, 1);
	assert.match(String(run.error), /Authentication required/);
	assert.doesNotMatch(String(run.error), new RegExp(API_KEY));
	assert.equal(run.committedState, undefined);
});

Deno.test('poll cancellation aborts the in-flight request', async () => {
	const fake = new FakeLinear();
	const controller = new AbortController();
	fake.intercept = ({ signal }) => {
		controller.abort(new Error('cancelled'));
		// A request sent without the poll's signal cannot be aborted; answer it
		// so the poll still ends.
		if (signal == null) {
			return jsonResponse({}, { status: 503 });
		}
		return new Promise<Response>((_, reject) => {
			signal.throwIfAborted();
			signal.addEventListener('abort', () => reject(signal.reason));
		});
	};

	const run = await poll(fake, { signal: controller.signal });

	assert.equal(run.outcome, 'cancelled');
	assert.equal(fake.requests.length, 1);
	assert.equal(fake.requests[0].signal?.aborted, true);
});

Deno.test('poll fails on a 2xx response that is not GraphQL JSON', async () => {
	const fake = new FakeLinear();
	fake.intercept = () =>
		new Response('<html>portal</html>', {
			headers: { 'content-type': 'text/html' },
		});

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.equal(run.committedState, undefined);
});

Deno.test('poll fails instead of reading a malformed issue page as empty', async () => {
	const fake = new FakeLinear();
	fake.intercept = () => jsonResponse({ data: { issues: null } });

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /issues: expected an object/);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll fails when a page has more results but no cursor', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.intercept = ({ operation }) => {
		if (operation === 'GetyLinearIssues') {
			return jsonResponse({
				data: {
					issues: {
						nodes: [],
						pageInfo: { hasNextPage: true, endCursor: null },
					},
				},
			});
		}
	};

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /more results but no next cursor/);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll fails when issue comments are truncated', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.comments = Array.from({ length: 51 }, (_, i) => ({
		id: `comment-${String(i).padStart(2, '0')}`,
		issueId: 'issue-1',
		body: `Comment ${i}`,
		createdAt: new Date(Date.UTC(2026, 5, 3, 1, i)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 5, 3, 1, i)).toISOString(),
	}));
	fake.intercept = ({ operation }) => {
		if (operation === 'GetyLinearIssueComments') {
			return jsonResponse({
				data: {
					issue: {
						comments: {
							nodes: [],
							pageInfo: { hasNextPage: true, endCursor: null },
						},
					},
				},
			});
		}
	};

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /comments: .*no next cursor/);
});

Deno.test('poll fails when an issue page repeats the requested cursor', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.intercept = async (request) => {
		if (request.operation !== 'GetyLinearIssues') {
			return undefined;
		}
		const body = await fake.answer(request).json();
		body.data.issues.pageInfo = {
			hasNextPage: true,
			endCursor: 'cursor:stuck',
		};
		return jsonResponse(body);
	};

	const run = await poll(fake);

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /repeats the requested cursor/);
	assert.equal(run.committedState, undefined);
	assert.equal(fake.operations().length, 2);
});

function commentDelta(nodes: Record<string, unknown>[]) {
	return jsonResponse({
		data: {
			comments: {
				nodes,
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		},
	});
}

Deno.test('poll fails on a comment delta node without an issue', async () => {
	const fake = new FakeLinear();
	fake.intercept = ({ operation }) =>
		operation === 'GetyLinearCommentDelta'
			? commentDelta([{ id: 'c1', updatedAt: '2026-06-03T00:20:00.000Z' }])
			: undefined;

	const run = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /comments\.nodes\[0\]/);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll fails on a comment delta node without a valid time', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.intercept = ({ operation }) =>
		operation === 'GetyLinearCommentDelta'
			? commentDelta([{ id: 'c1', issueId: 'issue-1', updatedAt: 'soon' }])
			: undefined;

	const run = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(run.outcome, 'error');
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll skips changed comments that belong to no issue', async () => {
	// Comments on project updates and documents have a null issueId.
	const fake = new FakeLinear();
	fake.intercept = ({ operation }) =>
		operation === 'GetyLinearCommentDelta'
			? commentDelta([{
				id: 'c1',
				issueId: null,
				updatedAt: '2026-06-03T00:20:00.000Z',
			}])
			: undefined;

	const run = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(run.updates, []);
	const state = run.committedState as Record<string, unknown>;
	assert.equal(state.last_comment_updated_at, '2026-06-03T00:20:00.000Z');
});

function changedComment(id: string, issueId: string, minute: number) {
	const time = new Date(Date.UTC(2026, 5, 3, 0, minute)).toISOString();
	return { id, issueId, body: id, createdAt: time, updatedAt: time };
}

Deno.test('poll deletes an issue that Linear reports as not found', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.comments = [
		changedComment('c1', 'issue-gone', 20),
		changedComment('c2', 'issue-1', 21),
	];

	const run = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(
		run.updates.map((update) =>
			update.kind === 'delete'
				? `delete ${update.id}`
				: `upsert ${update.doc.id}`
		),
		['delete linear:issue:issue-gone', 'upsert linear:issue:issue-1'],
	);
});

Deno.test('poll keeps an issue when fetching it fails for another reason', async () => {
	const fake = new FakeLinear();
	fake.comments = [changedComment('c1', 'issue-1', 20)];
	fake.intercept = ({ operation }) => {
		if (operation === 'GetyLinearIssue') {
			return jsonResponse(errorsOf({
				message: 'You do not have access to this resource',
				path: ['issue'],
				extensions: { code: 'FORBIDDEN', type: 'forbidden' },
			}));
		}
	};

	const run = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(run.outcome, 'error');
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
});

Deno.test('poll yields state only in its final batch and resumes past the cap', async () => {
	const fake = new FakeLinear();
	fake.issues = Array.from({ length: 501 }, (_, i) => issue(i));

	const first = await poll(fake);

	assert.equal(first.outcome, 'done', String(first.error));
	assert.equal(first.updates.length, 500);
	assert.ok(
		first.batches.slice(0, -1).every((batch) => !Object.hasOwn(batch, 'state')),
		'an intermediate batch carried state',
	);
	assert.ok(Object.hasOwn(first.batches.at(-1)!, 'state'));
	assert.ok(!fake.operations().includes('GetyLinearCommentDelta'));
	const capped = first.committedState as Record<string, unknown>;
	assert.equal(typeof capped.issue_delta_after, 'string');

	const second = await poll(fake, { lastState: first.committedState });

	assert.equal(second.outcome, 'done', String(second.error));
	assert.deepEqual(
		second.updates.map((update) => update.kind === 'upsert' && update.doc.id),
		['linear:issue:issue-500'],
	);
	const done = second.committedState as Record<string, unknown>;
	assert.equal(done.issue_delta_after, undefined);
	assert.equal(done.last_issue_updated_at, issue(500).updatedAt);
});

Deno.test('poll replays the same state to the same updates', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(11), issue(12)];
	fake.comments = [changedComment('c1', 'issue-1', 20)];
	fake.issues.push(issue(1));

	const first = await poll(fake, { lastState: CAUGHT_UP });
	const replay = await poll(fake, { lastState: CAUGHT_UP });

	assert.equal(first.outcome, 'done', String(first.error));
	assert.deepEqual(replay.updates, first.updates);
	assert.deepEqual(replay.committedState, first.committedState);
});

const SKEW_MS = 10 * 60_000;

function commentDeltaBoundaries(fake: FakeLinear): number[] {
	return fake.requests
		.filter((request) => request.operation === 'GetyLinearCommentDelta')
		.map((request) => Date.parse(String(request.variables.boundary)));
}

Deno.test('a full rebuild starts the comment cursor at the rebuild', async () => {
	const fake = new FakeLinear();
	fake.issues = [issue(1)];
	fake.comments = [changedComment('c1', 'issue-1', 2)];
	const pollStarted = Date.now();

	const run = await poll(fake);

	assert.equal(run.outcome, 'done', String(run.error));
	// The rebuild already rendered c1; scanning comments from the epoch would
	// rebuild issue-1 a second time.
	assert.equal(run.updates.length, 1);
	const [boundary] = commentDeltaBoundaries(fake);
	assert.ok(
		boundary >= pollStarted - SKEW_MS - 60_000,
		`comment delta started at ${new Date(boundary).toISOString()}`,
	);
});

Deno.test('a rebuild spanning polls keeps its start time for comments', async () => {
	const fake = new FakeLinear();
	fake.issues = Array.from({ length: 501 }, (_, i) => issue(i));
	const pollStarted = Date.now();

	const first = await poll(fake);
	const capped = first.committedState as Record<string, unknown>;
	const second = await poll(fake, { lastState: first.committedState });

	assert.equal(second.outcome, 'done', String(second.error));
	const rebuildStartedAt = Date.parse(String(capped.rebuild_started_at));
	assert.ok(rebuildStartedAt >= pollStarted - SKEW_MS - 60_000);
	const done = second.committedState as Record<string, unknown>;
	assert.equal(done.last_comment_updated_at, capped.rebuild_started_at);
	assert.equal(done.rebuild_started_at, undefined);
});

Deno.test('enabling comments mid issue pass rebuilds from the first page', async () => {
	// An incremental pass without comments stopped at the cap, leaving a cursor
	// into the list filtered by updatedAt.
	const fake = new FakeLinear();
	fake.issues = Array.from({ length: 13 }, (_, i) => issue(i + 1));
	const lastState = {
		schema_version: 2,
		index_comments: false,
		last_issue_updated_at: '2026-06-03T00:10:00.000Z',
		issue_delta_after: 'cursor:issue-12',
		issue_delta_boundary: '2026-06-03T00:09:59.000Z',
	};

	const run = await poll(fake, { lastState, indexComments: true });

	assert.equal(run.outcome, 'done', String(run.error));
	assert.equal(run.updates.length, 13);
	assert.equal(fake.requests[0].variables.after, undefined);
});

Deno.test('poll deletes archived and trashed issues', async () => {
	const fake = new FakeLinear();
	fake.issues = [
		issue(1),
		issue(2, { archivedAt: '2026-06-03T01:00:00.000Z' }),
		issue(3, { trashed: true }),
	];

	const run = await poll(fake);

	assert.equal(run.outcome, 'done', String(run.error));
	assert.deepEqual(
		run.updates.map((update) =>
			update.kind === 'delete'
				? `delete ${update.id}`
				: `upsert ${update.doc.id}`
		),
		[
			'upsert linear:issue:issue-1',
			'delete linear:issue:issue-2',
			'delete linear:issue:issue-3',
		],
	);
});

function docContent(updates: DocUpdate[], id: string): string {
	const update = updates.find((u) => u.kind === 'upsert' && u.doc.id === id);
	assert.ok(update?.kind === 'upsert', `no upsert for ${id}`);
	return String(update.doc.content);
}

Deno.test('enabling comments during a capped rebuild restarts it', async () => {
	const fake = new FakeLinear();
	fake.issues = Array.from({ length: 501 }, (_, i) => issue(i));
	fake.comments = [changedComment('c-old', 'issue-0', 2)];

	const first = await poll(fake, { indexComments: false });
	const second = await poll(fake, {
		lastState: first.committedState,
		indexComments: true,
	});
	const third = await poll(fake, {
		lastState: second.committedState,
		indexComments: true,
	});

	assert.equal(third.outcome, 'done', String(third.error));
	// The pages of the first poll were rendered without comments; the rebuild
	// must render them again instead of resuming at issue 500.
	assert.match(docContent(second.updates, 'linear:issue:issue-0'), /c-old/);
	const restarted = second.committedState as Record<string, unknown>;
	const done = third.committedState as Record<string, unknown>;
	assert.equal(done.last_comment_updated_at, restarted.rebuild_started_at);
});

Deno.test('disabling comments during a capped rebuild restarts it', async () => {
	const fake = new FakeLinear();
	fake.issues = Array.from({ length: 501 }, (_, i) => issue(i));
	fake.comments = [changedComment('c-old', 'issue-0', 2)];

	const first = await poll(fake, { indexComments: true });
	assert.match(docContent(first.updates, 'linear:issue:issue-0'), /c-old/);
	const second = await poll(fake, {
		lastState: first.committedState,
		indexComments: false,
	});

	assert.equal(second.outcome, 'done', String(second.error));
	assert.doesNotMatch(
		docContent(second.updates, 'linear:issue:issue-0'),
		/c-old/,
	);
});
