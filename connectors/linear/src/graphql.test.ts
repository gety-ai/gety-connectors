import assert from 'node:assert/strict';
import { jsonResponse } from '@gety-connectors/testing';
import {
	GraphQLError,
	type GraphQLErrorEntry,
	isEntityNotFound,
	LinearGraphQL,
	rateLimitDelayMs,
} from './graphql.ts';

const NOW = Date.UTC(2026, 5, 3);
const QUERY = 'query GetyLinearIssue($id: String!) { issue(id: $id) { id } }';

function client(
	responses: Response[],
	options: { signal?: AbortSignal; onRetry?: (delayMs: number) => void } = {},
) {
	let calls = 0;
	const graphql = new LinearGraphQL({
		apiKey: 'key',
		signal: options.signal ?? new AbortController().signal,
		now: () => NOW,
		fetch: () => {
			const response = responses[calls++];
			assert.ok(response, `unexpected request ${calls}`);
			return Promise.resolve(response);
		},
		onRetry: ({ delayMs }) => options.onRetry?.(delayMs),
	});
	return { graphql, calls: () => calls };
}

Deno.test('LinearGraphQL waits for the reset of an exhausted rate limit', async () => {
	const controller = new AbortController();
	const delays: number[] = [];
	const { graphql, calls } = client([
		jsonResponse({
			errors: [{
				message: 'Rate limit exceeded',
				extensions: { code: 'RATELIMITED', type: 'ratelimited' },
			}],
		}, {
			status: 400,
			headers: {
				'x-ratelimit-requests-remaining': '0',
				'x-ratelimit-requests-reset': String(NOW + 120_500),
			},
		}),
	], {
		signal: controller.signal,
		onRetry: (delayMs) => {
			delays.push(delayMs);
			// Stop at the wait instead of sleeping through it.
			controller.abort(new Error('stop'));
		},
	});

	await assert.rejects(graphql.request(QUERY, { id: 'a' }), /stop/);
	assert.deepEqual(delays, [121_000]);
	assert.equal(calls(), 1);
});

Deno.test('rateLimitDelayMs reads the exhausted buckets only', () => {
	const headers = new Headers({
		'x-complexity': '500',
		'x-ratelimit-requests-remaining': '5',
		'x-ratelimit-requests-reset': String(NOW + 60_000),
		'x-ratelimit-complexity-remaining': '100',
		'x-ratelimit-complexity-reset': String(NOW + 30_000),
	});
	assert.equal(rateLimitDelayMs(headers, NOW), 30_000);

	headers.set('x-ratelimit-complexity-remaining', '1000');
	assert.equal(rateLimitDelayMs(headers, NOW), undefined);
});

Deno.test('LinearGraphQL does not retry a 400 that is not a rate limit', async () => {
	const { graphql, calls } = client([
		jsonResponse({
			errors: [{
				message: 'Cannot query field "nope" on type "Issue".',
				extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
			}],
		}, { status: 400 }),
	]);

	const error = await graphql.request(QUERY, { id: 'a' }).catch((e) => e);

	assert.ok(error instanceof GraphQLError);
	assert.equal(error.status, 400);
	assert.equal(error.operation, 'GetyLinearIssue');
	assert.equal(error.errors[0].code, 'GRAPHQL_VALIDATION_FAILED');
	assert.equal(calls(), 1);
});

Deno.test('LinearGraphQL rejects a 2xx response with errors', async () => {
	const { graphql } = client([
		jsonResponse({
			data: null,
			errors: [{
				message: 'Entity not found: Issue',
				path: ['issue'],
				extensions: { code: 'INVALID_INPUT', type: 'invalid input' },
			}],
		}),
	]);

	const error = await graphql.request(QUERY, { id: 'a' }).catch((e) => e);

	assert.ok(error instanceof GraphQLError);
	assert.equal(error.status, undefined);
	assert.deepEqual(error.errors, [{
		message: 'Entity not found: Issue',
		path: ['issue'],
		code: 'INVALID_INPUT',
		type: 'invalid input',
	}]);
});

Deno.test('isEntityNotFound accepts only a not-found error on the field', () => {
	const notFound = (entries: GraphQLErrorEntry[]) =>
		new GraphQLError('GetyLinearIssue', undefined, entries);
	const invalidInput: GraphQLErrorEntry = {
		message: 'Entity not found: Issue',
		path: ['issue'],
		code: 'INVALID_INPUT',
	};
	const coded: GraphQLErrorEntry = {
		message: 'Entity not found',
		path: ['issue'],
		code: 'ENTITY_NOT_FOUND',
	};

	assert.equal(isEntityNotFound(notFound([invalidInput]), 'issue'), true);
	assert.equal(isEntityNotFound(notFound([coded]), 'issue'), true);
	assert.equal(
		isEntityNotFound(
			notFound([{ ...coded, path: ['issue', 'project'] }]),
			'issue',
		),
		false,
	);
	assert.equal(
		isEntityNotFound(
			notFound([invalidInput, { message: 'Internal error' }]),
			'issue',
		),
		false,
	);
	assert.equal(
		isEntityNotFound(new Error('Entity not found: Issue'), 'issue'),
		false,
	);
});
