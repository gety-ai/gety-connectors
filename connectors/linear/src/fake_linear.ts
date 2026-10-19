// An in-memory Linear GraphQL endpoint for tests. It answers the connector's
// four operations from `issues` and `comments` with Relay pagination, and
// records every request. Tests only; nothing imports it from src/index.ts.

import { jsonResponse } from '@gety-connectors/testing';
import { isRecord } from '@gety-connectors/utils/json';

export interface FakeIssue {
	id: string;
	identifier: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	description?: string | null;
	archivedAt?: string | null;
	trashed?: boolean | null;
}

export interface FakeComment {
	id: string;
	issueId: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	parentId?: string | null;
	archivedAt?: string | null;
	author?: string;
}

export interface FakeRequest {
	operation: string;
	variables: Record<string, unknown>;
	authorization: string | null;
	signal: AbortSignal | null;
	at: number;
}

export class FakeLinear {
	issues: FakeIssue[] = [];
	comments: FakeComment[] = [];
	readonly requests: FakeRequest[] = [];
	/**
	 * Consulted before the data-backed answer; a returned Response is sent
	 * instead. `undefined` falls through.
	 */
	intercept?: (
		request: FakeRequest,
	) => Response | undefined | Promise<Response | undefined>;

	readonly fetch = async (
		_input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const body: unknown = JSON.parse(String(init?.body));
		if (!isRecord(body) || typeof body.query !== 'string') {
			throw new TypeError('FakeLinear expects a GraphQL JSON body');
		}
		const request: FakeRequest = {
			operation: /query\s+(\w+)/.exec(body.query)?.[1] ?? 'unknown',
			variables: isRecord(body.variables) ? body.variables : {},
			authorization: new Headers(init?.headers).get('authorization'),
			signal: init?.signal ?? null,
			at: performance.now(),
		};
		this.requests.push(request);
		const intercepted = await this.intercept?.(request);
		return intercepted ?? this.answer(request);
	};

	operations(): string[] {
		return this.requests.map((request) => request.operation);
	}

	/** The data-backed answer; an intercept may call it to alter a response. */
	answer({ operation, variables }: FakeRequest): Response {
		switch (operation) {
			case 'GetyLinearIssues': {
				const filter = isRecord(variables.filter) ? variables.filter : {};
				const updatedAt = isRecord(filter.updatedAt) ? filter.updatedAt : {};
				const gte = typeof updatedAt.gte === 'string' ? updatedAt.gte : null;
				const issues = sortBy(
					this.issues.filter((issue) => gte == null || issue.updatedAt >= gte),
					'updatedAt',
				);
				return jsonResponse({
					data: {
						issues: page(
							issues.map((issue) => this.#issueNode(issue, variables)),
							variables,
						),
					},
				});
			}
			case 'GetyLinearIssue': {
				const issue = this.issues.find(({ id }) => id === variables.id);
				if (issue === undefined) {
					return jsonResponse({
						data: null,
						errors: [{
							message: 'Entity not found: Issue',
							path: ['issue'],
							extensions: {
								type: 'invalid input',
								code: 'INVALID_INPUT',
								userPresentableMessage: 'Could not find referenced Issue.',
							},
						}],
					});
				}
				return jsonResponse({
					data: { issue: this.#issueNode(issue, variables) },
				});
			}
			case 'GetyLinearIssueComments':
				return jsonResponse({
					data: {
						issue: {
							comments: page(
								this.#commentsOf(String(variables.issueId)),
								variables,
							),
						},
					},
				});
			case 'GetyLinearCommentDelta': {
				const boundary = String(variables.boundary);
				const changed = sortBy(
					this.comments.filter((comment) => comment.updatedAt >= boundary),
					'updatedAt',
				).map(({ id, issueId, updatedAt }) => ({ id, issueId, updatedAt }));
				return jsonResponse({ data: { comments: page(changed, variables) } });
			}
		}
		return jsonResponse({
			errors: [{ message: `unknown operation ${operation}` }],
		}, { status: 400 });
	}

	#issueNode(issue: FakeIssue, variables: Record<string, unknown>) {
		const node: { id: string } & Record<string, unknown> = {
			description: null,
			archivedAt: null,
			trashed: false,
			...issue,
			url: `https://linear.app/fake/issue/${issue.identifier}`,
			number: Number(issue.identifier.split('-')[1] ?? 0),
			priority: null,
			priorityLabel: null,
			state: { name: 'Todo' },
			team: { name: 'Fake', key: 'FAKE' },
			assignee: null,
			project: null,
		};
		if (variables.includeComments === true) {
			node.comments = page(this.#commentsOf(issue.id), {
				first: variables.commentFirst,
			});
		}
		return node;
	}

	#commentsOf(issueId: string) {
		return sortBy(
			this.comments.filter((comment) => comment.issueId === issueId),
			'createdAt',
		).map(({ author, ...comment }) => ({
			parentId: null,
			archivedAt: null,
			quotedText: null,
			editedAt: null,
			resolvedAt: null,
			...comment,
			user: author === undefined ? null : { displayName: author },
			onBehalfOf: null,
			externalUser: null,
			botActor: null,
		}));
	}
}

function sortBy<T extends { id: string }>(
	items: readonly T[],
	key: keyof T,
): T[] {
	return [...items].sort((a, b) =>
		String(a[key]).localeCompare(String(b[key])) || a.id.localeCompare(b.id)
	);
}

/** A Relay page of `nodes` for the `after`/`first` variables. */
function page<T extends { id: string }>(
	nodes: readonly T[],
	variables: Record<string, unknown>,
) {
	const after = variables.after;
	const start = typeof after === 'string'
		? nodes.findIndex(({ id }) => `cursor:${id}` === after) + 1
		: 0;
	const first = typeof variables.first === 'number' ? variables.first : 50;
	const slice = nodes.slice(start, start + first);
	const last = slice.at(-1);
	return {
		nodes: slice,
		pageInfo: {
			hasNextPage: start + slice.length < nodes.length,
			endCursor: last === undefined ? null : `cursor:${last.id}`,
		},
	};
}

/**
 * Runs `fn` with `globalThis.fetch` answered by `fake`, restoring it after.
 * The connector resolves `fetch` per request, so no seam in its code is
 * needed.
 */
export async function withFakeLinear<T>(
	fake: FakeLinear,
	fn: () => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = fake.fetch as typeof fetch;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}
