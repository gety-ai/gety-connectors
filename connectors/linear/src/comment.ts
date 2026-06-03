import { type LinearClient } from '@linear/sdk';
import { logInfo } from './log.ts';
import { dateToIso, formatLinearTime, maxIsoDate } from './utils.ts';

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

export function markdownImagesToLinks(markdown: string): string {
	const lines = markdown.split('\n');
	const convertedLines: string[] = [];
	let fence: MarkdownFence | null = null;

	for (const line of lines) {
		const fenceMarker = parseFenceMarker(line);
		if (fence != null) {
			convertedLines.push(line);
			if (
				fenceMarker != null && fenceMarker.char === fence.char &&
				fenceMarker.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}

		if (fenceMarker != null) {
			fence = fenceMarker;
			convertedLines.push(line);
			continue;
		}

		convertedLines.push(markdownLineImagesToLinks(line));
	}

	return convertedLines.join('\n');
}

function commentBoundary(
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
		const aTime = dateToIso(a.createdAt) ?? '';
		const bTime = dateToIso(b.createdAt) ?? '';
		return aTime.localeCompare(bTime);
	});
}

interface MarkdownFence {
	char: '`' | '~';
	length: number;
}

function parseFenceMarker(line: string): MarkdownFence | null {
	const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
	if (match == null) {
		return null;
	}

	const marker = match[1];
	return {
		char: marker[0] as MarkdownFence['char'],
		length: marker.length,
	};
}

function markdownLineImagesToLinks(line: string): string {
	let result = '';
	let index = 0;

	while (index < line.length) {
		const codeSpanEnd = codeSpanCloseIndex(line, index);
		if (codeSpanEnd != null) {
			result += line.slice(index, codeSpanEnd);
			index = codeSpanEnd;
			continue;
		}

		const image = parseMarkdownImage(line, index);
		if (image == null) {
			result += line[index];
			index += 1;
			continue;
		}

		const label = image.alt.trim() === '' ? 'Image' : image.alt;
		result += `[${label}]${image.target}`;
		index = image.end;
	}

	return result;
}

function codeSpanCloseIndex(line: string, start: number): number | null {
	if (line[start] !== '`' || isEscaped(line, start)) {
		return null;
	}

	let tickCount = 1;
	while (line[start + tickCount] === '`') {
		tickCount += 1;
	}

	const close = line.indexOf('`'.repeat(tickCount), start + tickCount);
	return close === -1 ? null : close + tickCount;
}

interface MarkdownImage {
	alt: string;
	target: string;
	end: number;
}

function parseMarkdownImage(line: string, start: number): MarkdownImage | null {
	if (
		line[start] !== '!' || line[start + 1] !== '[' ||
		isEscaped(line, start)
	) {
		return null;
	}

	const altEnd = closingBracketIndex(line, start + 2);
	if (altEnd == null) {
		return null;
	}

	const targetStart = altEnd + 1;
	const targetEnd = closingTargetIndex(line, targetStart);
	if (targetEnd == null) {
		return null;
	}

	return {
		alt: line.slice(start + 2, altEnd),
		target: line.slice(targetStart, targetEnd),
		end: targetEnd,
	};
}

function closingBracketIndex(line: string, start: number): number | null {
	let depth = 0;
	for (let index = start; index < line.length; index += 1) {
		const char = line[index];
		if (isEscaped(line, index)) {
			continue;
		}
		if (char === '[') {
			depth += 1;
			continue;
		}
		if (char === ']') {
			if (depth === 0) {
				return index;
			}
			depth -= 1;
		}
	}
	return null;
}

function closingTargetIndex(line: string, start: number): number | null {
	const opener = line[start];
	if (opener === '(') {
		return closingParenIndex(line, start + 1);
	}
	if (opener === '[') {
		const end = closingBracketIndex(line, start + 1);
		return end == null ? null : end + 1;
	}
	return null;
}

function closingParenIndex(line: string, start: number): number | null {
	let depth = 0;
	for (let index = start; index < line.length; index += 1) {
		const char = line[index];
		if (isEscaped(line, index)) {
			continue;
		}
		if (char === '(') {
			depth += 1;
			continue;
		}
		if (char === ')') {
			if (depth === 0) {
				return index + 1;
			}
			depth -= 1;
		}
	}
	return null;
}

function isEscaped(value: string, index: number): boolean {
	let slashCount = 0;
	for (
		let cursor = index - 1;
		cursor >= 0 && value[cursor] === '\\';
		cursor -= 1
	) {
		slashCount += 1;
	}
	return slashCount % 2 === 1;
}

function emptyCommentConnection(): LinearCommentConnection {
	return {
		nodes: [],
		pageInfo: {
			hasNextPage: false,
		},
	};
}
