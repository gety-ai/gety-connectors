import { paginate } from '@gety-connectors/utils/paginate';
import {
	type Connection,
	type LinearGraphQL,
	nextPageCursor,
	requireConnection,
	requireRecord,
	UnexpectedResponseError,
} from './graphql.ts';
import { log } from './log.ts';
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

interface IssueCommentSource {
	id: string;
	identifier: string;
	comments?: Connection<LinearComment> | null;
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

/** A node of the comment delta query. */
interface ChangedComment {
	id: string;
	// Null for comments outside issues, such as on project updates.
	issueId: string | null;
	updatedAt: string;
}

export interface CommentSyncOptions {
	commentDeltaPageSize: number;
	maxCommentDeltasPerPoll: number;
	issueCommentPageSize: number;
	incrementalOverlapMs: number;
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
	client: LinearGraphQL,
	state: CommentDeltaState,
	signal: AbortSignal,
	options: CommentSyncOptions,
): Promise<CommentDeltaResult> {
	const issueIds = new Set<string>();
	const boundary = commentBoundary(state, options);
	let maxUpdatedAt = state.comment_delta_max_updated_at;
	let commentCount = 0;
	let nextAfter: string | undefined;
	log.info('comment delta started', {
		boundary,
		resume_after: state.comment_delta_after != null,
		page_size: options.commentDeltaPageSize,
		max_comments: options.maxCommentDeltasPerPoll,
	});

	const pages = paginate<ChangedComment>(async (after) => {
		const data = await client.request<{ comments?: unknown }>(
			COMMENT_DELTA_QUERY,
			{
				after,
				boundary,
				first: Math.min(
					options.commentDeltaPageSize,
					options.maxCommentDeltasPerPoll - commentCount,
				),
			},
		);
		const connection = requireConnection<{ id: string }>(
			data.comments,
			'comments',
		);
		return {
			items: connection.nodes.map((node, index) =>
				requireChangedComment(node, `comments.nodes[${index}]`)
			),
			hasMore: connection.pageInfo.hasNextPage,
			nextCursor: connection.pageInfo.endCursor,
		};
	}, {
		signal,
		context: 'Linear comment delta',
		startCursor: state.comment_delta_after,
	});
	for await (const page of pages) {
		for (const comment of page.items) {
			if (comment.issueId !== null) {
				issueIds.add(comment.issueId);
			}
			maxUpdatedAt = maxIsoDate(maxUpdatedAt, comment.updatedAt);
		}
		commentCount += page.items.length;
		nextAfter = page.nextCursor;
		log.progress('comment delta page processed', {
			comments: page.items.length,
			total_comments: commentCount,
			affected_issues: issueIds.size,
			has_next_page: nextAfter != null,
		});
		// An empty page that still has a next page resumes on the next poll.
		if (
			commentCount >= options.maxCommentDeltasPerPoll ||
			page.items.length === 0
		) {
			break;
		}
	}
	log.info('comment delta finished', {
		comments: commentCount,
		affected_issues: issueIds.size,
		hit_limit: nextAfter != null,
	});

	return {
		issueIds,
		commentCount,
		maxUpdatedAt,
		boundary,
		nextAfter,
		hitLimit: nextAfter != null,
	};
}

/**
 * `value` checked as a comment delta node. The comment cursor advances past
 * every node, so a node without a readable issue or time would drop a change
 * silently; it fails the poll instead.
 */
function requireChangedComment(
	value: unknown,
	context: string,
): ChangedComment {
	const { id, issueId, updatedAt } = requireRecord(value, context);
	if (
		typeof id !== 'string' ||
		(issueId !== null && typeof issueId !== 'string') ||
		typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))
	) {
		throw new UnexpectedResponseError(
			`${context}: expected id, issueId (string or null) and updatedAt`,
		);
	}
	return { id, issueId, updatedAt };
}

/**
 * Every comment of `issue`: the first page embedded in the issue, then the
 * remaining pages. A truncated enumeration is an error, since the issue
 * document would silently lose comments.
 */
export async function fetchIssueComments(
	issue: IssueCommentSource,
	client: LinearGraphQL,
	signal: AbortSignal,
	options: CommentSyncOptions,
): Promise<LinearComment[]> {
	const first = requireConnection<LinearComment>(
		issue.comments,
		`issue ${issue.identifier} comments`,
	);
	const comments = [...first.nodes];
	const startCursor = nextPageCursor(
		first,
		undefined,
		`issue ${issue.identifier} comments`,
	);
	if (startCursor === undefined) {
		return comments;
	}

	const pages = paginate<LinearComment>(async (after) => {
		const data = await client.request<{ issue?: unknown }>(
			ISSUE_COMMENTS_QUERY,
			{ after, first: options.issueCommentPageSize, issueId: issue.id },
		);
		const connection = requireConnection<LinearComment>(
			requireRecord(data.issue, 'issue').comments,
			'issue.comments',
		);
		return {
			items: connection.nodes,
			hasMore: connection.pageInfo.hasNextPage,
			nextCursor: connection.pageInfo.endCursor,
		};
	}, {
		signal,
		context: `Linear issue ${issue.identifier} comments`,
		startCursor,
	});
	for await (const page of pages) {
		comments.push(...page.items);
		log.progress('issue comments page processed', {
			issue: issue.identifier,
			page_comments: page.items.length,
			total_comments: comments.length,
			has_next_page: page.nextCursor != null,
		});
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
	const lines = [
		prefix == null
			? commentHeader(comment)
			: `${prefix} ${commentHeader(comment)}`,
	];
	if (body.length > 0) {
		if (prefix == null) {
			lines.push('', ...body);
		} else {
			lines.push(prefix, ...quoteMarkdownLines(body, prefix));
		}
	}

	for (const child of childrenByParentId.get(comment.id) ?? []) {
		lines.push('', renderCommentBlock(child, childrenByParentId, depth + 1));
	}

	return lines.join('\n');
}

function quotePrefix(depth: number): string | null {
	if (depth === 0) {
		return null;
	}
	return Array.from({ length: depth }, () => '>').join(' ');
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
