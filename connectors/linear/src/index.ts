import {
	Connector,
	type DocUpdate,
	type PollResult,
} from '@gety-ai/connector-sdk';
import {
	changedCommentIssues,
	type CommentDeltaResult,
	fetchIssueComments,
} from './comment.ts';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { LinearGraphQL, nextPageCursor, retryReason } from './graphql.ts';
import {
	buildIssueDelete,
	buildIssueUpdate,
	fetchIssueById,
	fetchIssuePage,
	issueDateBoundary,
	type IssueFilter,
	issueIsRemoved,
	issueUpdatedAt,
} from './issue.ts';
import { log } from './log.ts';
import { maxIsoDate } from './utils.ts';

export interface LinearState {
	schema_version?: number;
	last_issue_updated_at?: string;
	issue_delta_after?: string;
	issue_delta_boundary?: string;
	issue_delta_max_updated_at?: string;
	rebuild_issue_sync?: boolean;
	last_comment_updated_at?: string;
	comment_delta_after?: string;
	comment_delta_boundary?: string;
	comment_delta_max_updated_at?: string;
	index_comments?: boolean;
}

interface SyncOptions {
	// Number of issues requested from Linear in each page.
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
	maxCommentDeltasPerPoll: 50,
	issueCommentPageSize: 50,
	incrementalOverlapMs: 1000,
};

export const STATE_SCHEMA_VERSION = 2;

export default class LinearConnector
	extends Connector<ManifestConfig, LinearState> {
	private client!: LinearGraphQL;
	private indexComments = true;
	private readonly syncOptions = DEFAULT_SYNC_OPTIONS;

	override onLoad(): void {
		this.client = new LinearGraphQL({
			apiKey: this.config.api_key,
			signal: this.signal,
			onRetry: ({ operation, attempt, delayMs, error }) =>
				log.warn('request retrying', {
					operation,
					attempt: attempt + 1,
					delay_ms: delayMs,
					reason: retryReason(error),
				}),
		});
		this.indexComments = this.config.index_comments ?? true;
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const previousState = this.lastState ?? {};
		const rebuildAllIssues = this.shouldRebuildAllIssues(previousState);
		let stateAfterIssues = previousState;
		let issuePages = 0;
		let issueCount = 0;
		let issueUpdates = 0;
		log.info('poll started', {
			index_comments: this.indexComments,
			rebuild_all_issues: rebuildAllIssues,
			has_issue_cursor: (previousState.issue_delta_after ??
				previousState.last_issue_updated_at) != null,
			has_comment_cursor: (previousState.comment_delta_after ??
				previousState.comment_delta_boundary ??
				previousState.last_comment_updated_at) != null,
		});

		while (issueCount < this.syncOptions.maxIssuesPerPoll) {
			const shouldRebuildPage = this.shouldRebuildAllIssues(stateAfterIssues);
			const remainingIssues = this.syncOptions.maxIssuesPerPoll - issueCount;
			const issueResult = await this.pollIssuePage(
				stateAfterIssues,
				shouldRebuildPage,
				Math.min(this.syncOptions.issuePageSize, remainingIssues),
			);
			const shouldYieldIssuePage = shouldYieldIssueResult(
				stateAfterIssues,
				issueResult,
				shouldRebuildPage,
			);
			stateAfterIssues = nextStateAfterIssuePage(
				stateAfterIssues,
				issueResult,
				this.indexComments,
			);
			if (shouldYieldIssuePage) {
				issuePages += 1;
				issueCount += issueResult.issueCount;
				issueUpdates += issueResult.updates.length;
				yield { updates: issueResult.updates, state: stateAfterIssues };
			}
			if (!issueResult.hitLimit || issueResult.issueCount === 0) {
				break;
			}
		}

		if (stateAfterIssues.issue_delta_after != null) {
			log.info('poll finished', {
				phase: 'issues',
				issue_pages: issuePages,
				issues: issueCount,
				issue_updates: issueUpdates,
				total_updates: issueUpdates,
				hit_limit: true,
				max_complexity: this.client.maxComplexity,
			});
			return;
		}

		const commentDelta = this.indexComments
			? await changedCommentIssues(
				this.client,
				stateAfterIssues,
				this.signal,
				this.syncOptions,
			)
			: emptyCommentDelta(stateAfterIssues);
		if (!this.indexComments) {
			log.info('comment sync skipped', {
				reason: 'index_comments_disabled',
			});
		}

		const rebuiltFromComments = this.indexComments
			? await this.rebuildCommentIssues(commentDelta.issueIds)
			: emptyCommentIssueRebuildResult();
		log.info('poll finished', {
			phase: 'comments',
			issue_pages: issuePages,
			issues: issueCount,
			issue_updates: issueUpdates,
			scanned_comments: commentDelta.commentCount,
			rebuilt_issues: rebuiltFromComments.issueCount,
			total_updates: issueUpdates + rebuiltFromComments.updates.length,
			hit_limit: commentDelta.hitLimit,
			max_complexity: this.client.maxComplexity,
		});

		yield {
			updates: rebuiltFromComments.updates,
			state: nextStateAfterCommentSync(
				stateAfterIssues,
				commentDelta,
				this.indexComments,
			),
		};
	}

	private shouldRebuildAllIssues(previousState: LinearState): boolean {
		return previousState.rebuild_issue_sync === true ||
			shouldRebuildAllIssuesForState(previousState, this.indexComments);
	}

	private async pollIssuePage(
		previousState: LinearState,
		rebuildAllIssues: boolean,
		first: number,
	): Promise<IssuePageResult> {
		const filter = buildIssueFilter(
			previousState,
			rebuildAllIssues,
			this.syncOptions,
		);
		const after = previousState.issue_delta_after;
		const boundary = buildIssueBoundary(
			previousState,
			rebuildAllIssues,
			this.syncOptions,
		);
		const updates: DocUpdate[] = [];
		let maxUpdatedAt = previousState.issue_delta_max_updated_at;

		log.progress('issue sync started', {
			mode: rebuildAllIssues ? 'rebuild' : 'incremental',
			page_size: first,
			resume_after: after != null,
			has_filter: filter != null,
		});

		const connection = await fetchIssuePage(
			this.client,
			{ after, filter, first },
			this.indexComments,
			this.syncOptions.issueCommentPageSize,
		);
		const nextAfter = nextPageCursor(connection, after, 'Linear issues');

		const pageStartedAt = performance.now();
		let extraCommentPageIssueCount = 0;
		for (const issue of connection.nodes) {
			this.signal.throwIfAborted();

			const updatedAt = issueUpdatedAt(issue);
			if (updatedAt != null) {
				maxUpdatedAt = maxIsoDate(maxUpdatedAt, updatedAt);
			}

			const comments = this.indexComments && !issueIsRemoved(issue)
				? await fetchIssueComments(
					issue,
					this.client,
					this.signal,
					this.syncOptions,
				)
				: [];
			if (issue.comments?.pageInfo.hasNextPage === true) {
				extraCommentPageIssueCount += 1;
			}
			updates.push(buildIssueUpdate(issue, comments, {
				renderComments: this.indexComments,
			}));
		}

		const hitLimit = nextAfter != null;
		log.progress('issue page processed', {
			issues: connection.nodes.length,
			updates: updates.length,
			page_ms: Math.round(performance.now() - pageStartedAt),
			extra_comment_page_issues: extraCommentPageIssueCount,
			has_next_page: hitLimit,
		});

		return {
			updates,
			issueCount: connection.nodes.length,
			maxUpdatedAt,
			boundary,
			nextAfter,
			hitLimit,
			rebuildAllIssues,
		};
	}

	private async rebuildCommentIssues(
		issueIds: Set<string>,
	): Promise<CommentIssueRebuildResult> {
		const updates: DocUpdate[] = [];
		let issueCount = 0;

		if (issueIds.size > 0) {
			log.info('comment issue rebuild started', {
				affected_issues: issueIds.size,
			});
		}

		for (const issueId of issueIds) {
			this.signal.throwIfAborted();
			const issue = await fetchIssueById(
				this.client,
				issueId,
				this.indexComments,
				this.syncOptions.issueCommentPageSize,
			);
			if (issue == null) {
				updates.push(buildIssueDelete(issueId));
				issueCount += 1;
				continue;
			}
			const comments = issueIsRemoved(issue) ? [] : await fetchIssueComments(
				issue,
				this.client,
				this.signal,
				this.syncOptions,
			);
			updates.push(buildIssueUpdate(issue, comments, {
				renderComments: this.indexComments,
			}));
			issueCount += 1;
			log.progress('comment issue rebuilt', {
				issue: issue.identifier,
				rebuilt_issues: issueCount,
			});
		}
		if (issueIds.size > 0) {
			log.info('comment issue rebuild finished', {
				rebuilt_issues: issueCount,
			});
		}

		return { updates, issueCount };
	}
}

interface IssuePageResult extends IssueStateResult {
	updates: DocUpdate[];
	issueCount: number;
}

export interface IssueStateResult {
	maxUpdatedAt?: string;
	boundary?: string;
	nextAfter?: string;
	hitLimit: boolean;
	rebuildAllIssues: boolean;
}

interface CommentIssueRebuildResult {
	updates: DocUpdate[];
	issueCount: number;
}

export function shouldRebuildAllIssuesForState(
	previousState: Pick<LinearState, 'index_comments' | 'schema_version'>,
	indexComments: boolean,
): boolean {
	if (previousState.schema_version !== STATE_SCHEMA_VERSION) {
		return true;
	}
	if (previousState.index_comments === indexComments) {
		return false;
	}
	return indexComments || previousState.index_comments === true;
}

export function shouldYieldIssueResult(
	previousState: Pick<LinearState, 'issue_delta_after'>,
	result: Pick<IssueStateResult, 'hitLimit'> & { issueCount: number },
	rebuildAllIssues: boolean,
): boolean {
	return rebuildAllIssues || previousState.issue_delta_after != null ||
		result.issueCount > 0 || result.hitLimit;
}

export function buildIssueFilter(
	state: LinearState,
	rebuildAllIssues: boolean,
	options: Pick<SyncOptions, 'incrementalOverlapMs'>,
): IssueFilter | undefined {
	const boundary = buildIssueBoundary(state, rebuildAllIssues, options);
	if (boundary == null) {
		return undefined;
	}
	return { updatedAt: { gte: boundary } };
}

export function buildIssueBoundary(
	state: LinearState,
	rebuildAllIssues: boolean,
	options: Pick<SyncOptions, 'incrementalOverlapMs'>,
): string | undefined {
	if (rebuildAllIssues) {
		return undefined;
	}
	if (state.issue_delta_boundary != null) {
		return state.issue_delta_boundary;
	}
	if (state.last_issue_updated_at == null) {
		return undefined;
	}
	return issueDateBoundary(state.last_issue_updated_at, options);
}

export function nextStateAfterIssuePage(
	state: LinearState,
	result: IssueStateResult,
	indexComments: boolean,
): LinearState {
	return {
		schema_version: STATE_SCHEMA_VERSION,
		last_issue_updated_at: nextIssueUpdatedAt(state, result),
		issue_delta_after: result.nextAfter,
		issue_delta_boundary: result.nextAfter ? result.boundary : undefined,
		issue_delta_max_updated_at: result.nextAfter
			? result.maxUpdatedAt
			: undefined,
		rebuild_issue_sync: result.nextAfter && result.rebuildAllIssues
			? true
			: undefined,
		last_comment_updated_at: indexComments
			? state.last_comment_updated_at
			: undefined,
		comment_delta_after: indexComments ? state.comment_delta_after : undefined,
		comment_delta_boundary: indexComments
			? state.comment_delta_boundary
			: undefined,
		comment_delta_max_updated_at: indexComments
			? state.comment_delta_max_updated_at
			: undefined,
		index_comments: indexComments,
	};
}

export function nextIssueUpdatedAt(
	state: LinearState,
	result: Pick<IssueStateResult, 'maxUpdatedAt' | 'nextAfter'>,
): string | undefined {
	if (result.nextAfter != null) {
		return state.last_issue_updated_at;
	}
	return maxIsoDate(
		state.last_issue_updated_at,
		result.maxUpdatedAt ?? state.issue_delta_max_updated_at,
	);
}

export function nextStateAfterCommentSync(
	state: LinearState,
	delta: CommentDeltaResult,
	indexComments: boolean,
): LinearState {
	return {
		schema_version: STATE_SCHEMA_VERSION,
		last_issue_updated_at: state.last_issue_updated_at,
		issue_delta_after: state.issue_delta_after,
		issue_delta_boundary: state.issue_delta_boundary,
		issue_delta_max_updated_at: state.issue_delta_max_updated_at,
		rebuild_issue_sync: state.rebuild_issue_sync,
		last_comment_updated_at: indexComments
			? nextCommentUpdatedAt(state, delta)
			: undefined,
		comment_delta_after: indexComments ? delta.nextAfter : undefined,
		comment_delta_boundary: indexComments && delta.nextAfter
			? delta.boundary
			: undefined,
		comment_delta_max_updated_at: indexComments && delta.nextAfter
			? delta.maxUpdatedAt
			: undefined,
		index_comments: indexComments,
	};
}

export function nextCommentUpdatedAt(
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

function emptyCommentIssueRebuildResult(): CommentIssueRebuildResult {
	return { updates: [], issueCount: 0 };
}
