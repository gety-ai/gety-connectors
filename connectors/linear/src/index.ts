import {
	Connector,
	type DocUpdate,
	type PollResult,
} from '@gety-ai/connector-sdk';
import { LinearClient, LinearDocument } from '@linear/sdk';
import {
	changedCommentIssues,
	type CommentDeltaResult,
	fetchIssueComments,
} from './comment.ts';
import type { ManifestConfig } from './gen/manifest.d.ts';
import {
	buildIssueUpdate,
	issueDateBoundary,
	issueIsRemoved,
	type IssuesQueryVariables,
	issueUpdatedAt,
	maxIsoDate,
} from './issue.ts';

interface LinearState {
	schema_version?: 1 | 2;
	last_updated_at?: string;
	last_issue_updated_at?: string;
	last_comment_updated_at?: string;
	comment_delta_after?: string;
	comment_delta_boundary?: string;
	comment_delta_max_updated_at?: string;
	last_poll_completed_at?: string;
	last_poll_issue_count?: number;
	last_poll_comment_count?: number;
	last_poll_rebuilt_issue_count?: number;
	last_poll_update_count?: number;
	last_poll_hit_limit?: boolean;
	index_comments?: boolean;
}

interface SyncOptions {
	// Number of issues requested from Linear in each paginated API call.
	issuePageSize: number;

	// Maximum number of issues processed in one Gety poll.
	maxIssuesPerPoll: number;

	// Number of changed comments requested from Linear in each API call.
	commentDeltaPageSize: number;

	// Maximum number of changed comments scanned in one Gety poll.
	maxCommentDeltasPerPoll: number;

	// Number of comments requested per page when rebuilding one issue.
	issueCommentPageSize: number;

	// Timestamp overlap used by incremental polling to avoid boundary misses.
	incrementalOverlapMs: number;
}

const DEFAULT_SYNC_OPTIONS: SyncOptions = {
	issuePageSize: 50,
	maxIssuesPerPoll: 500,
	commentDeltaPageSize: 50,
	maxCommentDeltasPerPoll: 500,
	issueCommentPageSize: 50,
	incrementalOverlapMs: 1000,
};

export default class LinearConnector
	extends Connector<ManifestConfig, LinearState> {
	private client!: LinearClient;
	private indexComments = true;
	private readonly syncOptions = DEFAULT_SYNC_OPTIONS;

	override onload(): void {
		this.client = new LinearClient({ apiKey: this.config.api_key });
		this.indexComments = this.config.index_comments;
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const previousState = this.lastState ?? {};
		const rebuildAllIssues = this.shouldRebuildAllIssues(previousState);
		const issueResult = await this.pollIssues(previousState, rebuildAllIssues);
		const commentDelta = this.indexComments
			? await changedCommentIssues(
				this.client,
				previousState,
				this.signal,
				this.syncOptions,
			)
			: emptyCommentDelta(previousState);

		const rebuiltFromComments = await this.rebuildCommentIssues(
			commentDelta.issueIds,
			issueResult.touchedIssueIds,
		);
		const updates = [...issueResult.updates, ...rebuiltFromComments.updates];

		yield {
			updates,
			state: {
				schema_version: 2,
				last_issue_updated_at: issueResult.lastIssueUpdatedAt,
				last_comment_updated_at: nextCommentUpdatedAt(
					previousState,
					commentDelta,
				),
				comment_delta_after: commentDelta.nextAfter,
				comment_delta_boundary: commentDelta.nextAfter
					? commentDelta.boundary
					: undefined,
				comment_delta_max_updated_at: commentDelta.nextAfter
					? commentDelta.maxUpdatedAt
					: undefined,
				last_poll_completed_at: new Date().toISOString(),
				last_poll_issue_count: issueResult.issueCount,
				last_poll_comment_count: commentDelta.commentCount,
				last_poll_rebuilt_issue_count: rebuiltFromComments.issueCount,
				last_poll_update_count: updates.length,
				last_poll_hit_limit: issueResult.hitLimit || commentDelta.hitLimit,
				index_comments: this.indexComments,
			} satisfies LinearState,
		};
	}

	private shouldRebuildAllIssues(previousState: LinearState): boolean {
		if (previousState.index_comments === this.indexComments) {
			return false;
		}
		return this.indexComments || previousState.index_comments === true;
	}

	private async pollIssues(
		previousState: LinearState,
		rebuildAllIssues: boolean,
	): Promise<IssuePollResult> {
		const filter = buildIssueFilter(
			previousState,
			rebuildAllIssues,
			this.syncOptions,
		);
		const updates: DocUpdate[] = [];
		const touchedIssueIds = new Set<string>();

		let after: string | undefined;
		let issueCount = 0;
		let lastIssueUpdatedAt = previousState.last_issue_updated_at ??
			previousState.last_updated_at;
		let hasNextPage = true;

		while (hasNextPage && issueCount < this.syncOptions.maxIssuesPerPoll) {
			this.signal.throwIfAborted();

			const first = Math.min(
				this.syncOptions.issuePageSize,
				this.syncOptions.maxIssuesPerPoll - issueCount,
			);
			const connection = await this.client.issues({
				after,
				filter,
				first,
				includeArchived: true,
				sort: {
					updatedAt: {
						order: LinearDocument.PaginationSortOrder.Ascending,
					},
				},
			});

			for (const issue of connection.nodes) {
				touchedIssueIds.add(issue.id);
				const updatedAt = issueUpdatedAt(issue);
				if (updatedAt != null) {
					lastIssueUpdatedAt = maxIsoDate(lastIssueUpdatedAt, updatedAt);
				}

				const comments = this.indexComments && !issueIsRemoved(issue)
					? await fetchIssueComments(issue, this.signal, this.syncOptions)
					: [];
				updates.push(
					await buildIssueUpdate(issue, comments, {
						renderComments: this.indexComments,
					}),
				);
			}

			issueCount += connection.nodes.length;
			after = connection.pageInfo.endCursor ?? undefined;
			hasNextPage = connection.pageInfo.hasNextPage && after != null;

			if (connection.nodes.length === 0) {
				break;
			}
		}

		return {
			updates,
			touchedIssueIds,
			issueCount,
			lastIssueUpdatedAt,
			hitLimit: hasNextPage,
		};
	}

	private async rebuildCommentIssues(
		issueIds: Set<string>,
		alreadyTouched: Set<string>,
	): Promise<CommentIssueRebuildResult> {
		const updates: DocUpdate[] = [];
		let issueCount = 0;

		for (const issueId of issueIds) {
			if (alreadyTouched.has(issueId)) {
				continue;
			}

			this.signal.throwIfAborted();
			const issue = await this.client.issue(issueId);
			const comments = issueIsRemoved(issue)
				? []
				: await fetchIssueComments(issue, this.signal, this.syncOptions);
			updates.push(
				await buildIssueUpdate(issue, comments, {
					renderComments: this.indexComments,
				}),
			);
			issueCount += 1;
		}

		return { updates, issueCount };
	}
}

interface IssuePollResult {
	updates: DocUpdate[];
	touchedIssueIds: Set<string>;
	issueCount: number;
	lastIssueUpdatedAt?: string;
	hitLimit: boolean;
}

interface CommentIssueRebuildResult {
	updates: DocUpdate[];
	issueCount: number;
}

function buildIssueFilter(
	state: LinearState,
	rebuildAllIssues: boolean,
	options: SyncOptions,
): IssuesQueryVariables['filter'] {
	if (rebuildAllIssues) {
		return undefined;
	}

	const lastIssueUpdatedAt = state.last_issue_updated_at ??
		state.last_updated_at;
	if (lastIssueUpdatedAt == null) {
		return undefined;
	}

	return { updatedAt: { gte: issueDateBoundary(lastIssueUpdatedAt, options) } };
}

function emptyCommentDelta(state: LinearState): CommentDeltaResult {
	return {
		issueIds: new Set(),
		commentCount: 0,
		maxUpdatedAt: state.comment_delta_max_updated_at,
		boundary: state.comment_delta_boundary,
		nextAfter: undefined,
		hitLimit: false,
	};
}

function nextCommentUpdatedAt(
	state: LinearState,
	delta: CommentDeltaResult,
): string | undefined {
	if (delta.nextAfter != null) {
		return state.last_comment_updated_at;
	}

	return maxIsoDate(
		state.last_comment_updated_at,
		delta.maxUpdatedAt ?? state.comment_delta_max_updated_at,
	);
}
