import { type LinearClient } from '@linear/sdk';
import { logInfo } from './log.ts';
import { markdownImagesToLinks } from './markdown.ts';
import {
	dateToIso,
	dateToTime,
	formatLinearTime,
	maxIsoDate,
} from './utils.ts';

export interface LinearComment {
	id: string;
	issueId?: string | null;
	parentId?: string | null;
	body?: string | null;
	quotedText?: string | null;
	user?: LinearCommentUser | null;
	onBehalfOf?: LinearCommentUser | null;
	externalUser?: LinearCommentExternalUser | null;
	botActor?: LinearCommentBotActor | null;
	archivedAt?: Date | string | null;
	createdAt?: Date | string | null;
	updatedAt?: Date | string | null;
	editedAt?: Date | string | null;
	resolvedAt?: Date | string | null;
}

interface LinearCommentUser {
	id?: string | null;
	displayName?: string | null;
	name?: string | null;
	url?: string | null;
}

interface LinearCommentExternalUser {
	id?: string | null;
	displayName?: string | null;
	name?: string | null;
}

interface LinearCommentBotActor {
	id?: string | null;
	name?: string | null;
	userDisplayName?: string | null;
	type?: string | null;
	subType?: string | null;
}

export interface LinearCommentConnection {
	nodes: LinearComment[];
	pageInfo: {
		endCursor?: string | null;
		hasNextPage: boolean;
	};
}

interface IssueCommentSource {
	id: string;
	identifier: string;
	comments?: LinearCommentConnection | null;
}

export interface CommentDeltaState {
	last_comment_updated_at?: string;
	comment_delta_after?: string;
	comment_delta_boundary?: string;
	comment_delta_max_updated_at?: string;
}

export interface CommentDeltaResult {
	issueIds: Set<string>;
	commentCount: number;
	maxUpdatedAt?: string;
	boundary?: string;
	nextAfter?: string;
	hitLimit: boolean;
}

export interface CommentSyncOptions {
	commentDeltaPageSize: number;
	maxCommentDeltasPerPoll: number;
	issueCommentPageSize: number;
	incrementalOverlapMs: number;
}

interface CommentDeltaResponse {
	comments: LinearCommentConnection;
}

interface IssueCommentsResponse {
	issue?: {
		comments: LinearCommentConnection;
	} | null;
}

const COMMENT_DELTA_QUERY = `
	query GetyLinearCommentDelta(
		$after: String
		$boundary: DateTimeOrDuration!
		$first: Int!
	) {
		comments(
			after: $after
			filter: { updatedAt: { gte: $boundary } }
			first: $first
			includeArchived: true
			orderBy: updatedAt
		) {
			nodes {
				id
				issueId
				updatedAt
			}
			pageInfo {
				endCursor
				hasNextPage
			}
		}
	}
`;

const ISSUE_COMMENTS_QUERY = `
	query GetyLinearIssueComments(
		$issueId: String!
		$after: String
		$first: Int!
	) {
		issue(id: $issueId) {
			comments(
				after: $after
				first: $first
				includeArchived: true
				orderBy: createdAt
			) {
				nodes {
					id
					issueId
					parentId
					body
					quotedText
					user {
						id
						displayName
						name
						url
					}
					onBehalfOf {
						id
						displayName
						name
						url
					}
					externalUser {
						id
						displayName
						name
					}
					botActor {
						id
						name
						userDisplayName
						type
						subType
					}
					archivedAt
					createdAt
					updatedAt
					editedAt
					resolvedAt
				}
				pageInfo {
					endCursor
					hasNextPage
				}
			}
		}
	}
`;

export async function changedCommentIssues(
	client: LinearClient,
	state: CommentDeltaState,
	signal: AbortSignal,
	options: CommentSyncOptions,
): Promise<CommentDeltaResult> {
	const issueIds = new Set<string>();
	const boundary = commentBoundary(state, options);
	let after = state.comment_delta_after;
	let maxUpdatedAt = state.comment_delta_max_updated_at;
	let commentCount = 0;
	let hasNextPage = true;
	logInfo('comment delta started', {
		boundary,
		resume_after: after != null,
		page_size: options.commentDeltaPageSize,
		max_comments: options.maxCommentDeltasPerPoll,
	});

	while (hasNextPage && commentCount < options.maxCommentDeltasPerPoll) {
		signal.throwIfAborted();

		const first = Math.min(
			options.commentDeltaPageSize,
			options.maxCommentDeltasPerPoll - commentCount,
		);
		logInfo('fetching comment delta page', {
			after: after == null ? 'no' : 'yes',
			first,
		});
		const response = await client.client.rawRequest<
			CommentDeltaResponse,
			Record<string, unknown>
		>(COMMENT_DELTA_QUERY, {
			after,
			boundary,
			first,
		});
		const connection = response.data?.comments ?? emptyCommentConnection();

		for (const comment of connection.nodes) {
			if (comment.issueId != null) {
				issueIds.add(comment.issueId);
			}
			maxUpdatedAt = maxIsoDate(maxUpdatedAt, dateToIso(comment.updatedAt));
		}

		commentCount += connection.nodes.length;
		after = connection.pageInfo.endCursor ?? undefined;
		hasNextPage = connection.pageInfo.hasNextPage && after != null;
		logInfo('comment delta page processed', {
			comments: connection.nodes.length,
			total_comments: commentCount,
			affected_issues: issueIds.size,
			has_next_page: hasNextPage,
		});

		if (connection.nodes.length === 0) {
			break;
		}
	}
	logInfo('comment delta finished', {
		comments: commentCount,
		affected_issues: issueIds.size,
		hit_limit: hasNextPage,
	});

	return {
		issueIds,
		commentCount,
		maxUpdatedAt,
		boundary,
		nextAfter: hasNextPage ? after : undefined,
		hitLimit: hasNextPage,
	};
}

export async function fetchIssueComments(
	issue: IssueCommentSource,
	client: LinearClient,
	signal: AbortSignal,
	options: CommentSyncOptions,
): Promise<LinearComment[]> {
	const comments = [...(issue.comments?.nodes ?? [])];
	let after = issue.comments?.pageInfo.endCursor ?? undefined;
	let hasNextPage = issue.comments?.pageInfo.hasNextPage === true &&
		after != null;
	let pageCount = issue.comments == null ? 0 : 1;

	while (hasNextPage) {
		signal.throwIfAborted();

		const response = await client.client.rawRequest<
			IssueCommentsResponse,
			Record<string, unknown>
		>(ISSUE_COMMENTS_QUERY, {
			after,
			first: options.issueCommentPageSize,
			issueId: issue.id,
		});
		const connection = response.data?.issue?.comments ??
			emptyCommentConnection();

		pageCount += 1;
		comments.push(...connection.nodes);
		after = connection.pageInfo.endCursor ?? undefined;
		hasNextPage = connection.pageInfo.hasNextPage && after != null;
		if (hasNextPage || pageCount > 1) {
			logInfo('issue comments page processed', {
				issue: issue.identifier,
				pages: pageCount,
				page_comments: connection.nodes.length,
				total_comments: comments.length,
				has_next_page: hasNextPage,
			});
		}

		if (connection.nodes.length === 0) {
			break;
		}
	}

	return comments;
}

export function latestCommentUpdatedAt(
	comments: readonly LinearComment[],
): string | undefined {
	return comments.reduce<string | undefined>(
		(latest, comment) => maxIsoDate(latest, dateToIso(comment.updatedAt)),
		undefined,
	);
}

export function renderCommentsMarkdown(
	comments: readonly LinearComment[],
): string {
	const visibleComments = comments.filter((comment) =>
		comment.archivedAt == null
	);
	if (visibleComments.length === 0) {
		return '';
	}

	const commentsById = new Map(visibleComments.map((comment) => [
		comment.id,
		comment,
	]));
	const childrenByParentId = new Map<string, LinearComment[]>();
	const roots: LinearComment[] = [];

	for (const comment of visibleComments) {
		if (comment.parentId != null && commentsById.has(comment.parentId)) {
			const children = childrenByParentId.get(comment.parentId) ?? [];
			children.push(comment);
			childrenByParentId.set(comment.parentId, children);
			continue;
		}
		roots.push(comment);
	}

	sortComments(roots);
	for (const children of childrenByParentId.values()) {
		sortComments(children);
	}

	const sections = ['## Comments', ''];
	for (const [index, comment] of roots.entries()) {
		if (index > 0) {
			sections.push('', '---', '');
		}
		sections.push(renderCommentBlock(comment, childrenByParentId, 0));
	}

	return sections.join('\n');
}

export function commentBoundary(
	state: CommentDeltaState,
	options: CommentSyncOptions,
): string {
	if (state.comment_delta_boundary != null) {
		return state.comment_delta_boundary;
	}

	const lastCommentUpdatedAt = state.last_comment_updated_at ??
		new Date(0).toISOString();
	return new Date(
		new Date(lastCommentUpdatedAt).getTime() - options.incrementalOverlapMs,
	).toISOString();
}

function renderCommentBlock(
	comment: LinearComment,
	childrenByParentId: Map<string, LinearComment[]>,
	depth: number,
): string {
	const prefix = quotePrefix(depth);
	const body = commentBodyMarkdown(comment);
	const lines = [`${prefix} ${commentHeader(comment)}`];
	if (body.length > 0) {
		lines.push(prefix, ...quoteMarkdownLines(body, prefix));
	}

	for (const child of childrenByParentId.get(comment.id) ?? []) {
		lines.push('', renderCommentBlock(child, childrenByParentId, depth + 1));
	}

	return lines.join('\n');
}

function quotePrefix(depth: number): string {
	return Array.from({ length: depth + 1 }, () => '>').join(' ');
}

function commentHeader(comment: LinearComment): string {
	return `@${commentAuthorName(comment)} · ${commentTime(comment)}`;
}

function commentAuthorName(comment: LinearComment): string {
	const onBehalfOf = displayUserName(comment.onBehalfOf);
	const botActor = displayBotActor(comment.botActor);
	if (onBehalfOf != null) {
		return botActor == null ? onBehalfOf : `${onBehalfOf} via ${botActor}`;
	}

	const user = displayUserName(comment.user);
	if (user != null) {
		return user;
	}

	const externalUser = displayExternalUser(comment.externalUser);
	if (externalUser != null) {
		return botActor == null
			? `${externalUser} (external)`
			: `${externalUser} (external via ${botActor})`;
	}

	return botActor == null ? 'unknown' : `${botActor} (bot)`;
}

function commentTime(comment: LinearComment): string {
	return formatLinearTime(comment.createdAt) ?? 'unknown time';
}

function commentBodyMarkdown(comment: LinearComment): string[] {
	const lines: string[] = [];
	const quoted = comment.quotedText?.trim();
	if (quoted) {
		lines.push(...quoted.split(/\r?\n/).map((line) => `> ${line}`), '');
	}

	const body = markdownImagesToLinks((comment.body ?? '').trim());
	if (body) {
		lines.push(...body.split(/\r?\n/));
	}

	return lines;
}

function quoteMarkdownLines(
	lines: readonly string[],
	prefix: string,
): string[] {
	return lines.map((line) => line === '' ? prefix : `${prefix} ${line}`);
}

function displayUserName(
	user: LinearCommentUser | null | undefined,
): string | null {
	const name = user?.displayName ?? user?.name;
	if (name == null || name.trim() === '') {
		return null;
	}
	return name.trim();
}

function displayExternalUser(
	user: LinearCommentExternalUser | null | undefined,
): string | null {
	const name = user?.displayName ?? user?.name;
	return name == null || name.trim() === '' ? null : name.trim();
}

function displayBotActor(
	actor: LinearCommentBotActor | null | undefined,
): string | null {
	const name = actor?.userDisplayName ?? actor?.name ?? actor?.type;
	return name == null || name.trim() === '' ? null : name.trim();
}

function sortComments(comments: LinearComment[]): void {
	comments.sort((a, b) => {
		const aTime = dateToTime(a.createdAt) ?? Number.NEGATIVE_INFINITY;
		const bTime = dateToTime(b.createdAt) ?? Number.NEGATIVE_INFINITY;
		return aTime - bTime;
	});
}

function emptyCommentConnection(): LinearCommentConnection {
	return {
		nodes: [],
		pageInfo: {
			hasNextPage: false,
		},
	};
}
