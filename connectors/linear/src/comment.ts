import {
	type Comment,
	type Issue,
	type LinearClient,
	LinearDocument,
} from '@linear/sdk';

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

	while (hasNextPage && commentCount < options.maxCommentDeltasPerPoll) {
		signal.throwIfAborted();

		const first = Math.min(
			options.commentDeltaPageSize,
			options.maxCommentDeltasPerPoll - commentCount,
		);
		const connection = await client.comments({
			after,
			filter: { updatedAt: { gte: boundary } },
			first,
			includeArchived: true,
			orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
		});

		for (const comment of connection.nodes) {
			if (comment.issueId != null) {
				issueIds.add(comment.issueId);
			}
			maxUpdatedAt = maxIsoDate(maxUpdatedAt, dateToIso(comment.updatedAt));
		}

		commentCount += connection.nodes.length;
		after = connection.pageInfo.endCursor ?? undefined;
		hasNextPage = connection.pageInfo.hasNextPage && after != null;

		if (connection.nodes.length === 0) {
			break;
		}
	}

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
	issue: Issue,
	signal: AbortSignal,
	options: CommentSyncOptions,
): Promise<Comment[]> {
	const comments: Comment[] = [];
	let after: string | undefined;
	let hasNextPage = true;

	while (hasNextPage) {
		signal.throwIfAborted();

		const connection = await issue.comments({
			after,
			first: options.issueCommentPageSize,
			includeArchived: true,
			orderBy: LinearDocument.PaginationOrderBy.CreatedAt,
		});

		comments.push(...connection.nodes);
		after = connection.pageInfo.endCursor ?? undefined;
		hasNextPage = connection.pageInfo.hasNextPage && after != null;

		if (connection.nodes.length === 0) {
			break;
		}
	}

	return comments;
}

export function latestCommentUpdatedAt(
	comments: readonly Comment[],
): string | undefined {
	return comments.reduce<string | undefined>(
		(latest, comment) => maxIsoDate(latest, dateToIso(comment.updatedAt)),
		undefined,
	);
}

export function renderCommentsMarkdown(comments: readonly Comment[]): string {
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
	const childrenByParentId = new Map<string, Comment[]>();
	const roots: Comment[] = [];

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
	comment: Comment,
	childrenByParentId: Map<string, Comment[]>,
	depth: number,
): string {
	const headingLevel = Math.min(3 + depth, 6);
	const title = depth === 0 ? 'Comment' : 'Reply';
	const body = markdownImagesToLinks(comment.body.trim());
	const lines = [
		`${'#'.repeat(headingLevel)} ${title}`,
		'',
		...commentMetadata(comment),
		'',
		...quotedText(comment),
	];
	if (body) {
		lines.push(body);
	}

	for (const child of childrenByParentId.get(comment.id) ?? []) {
		lines.push('', renderCommentBlock(child, childrenByParentId, depth + 1));
	}

	return lines.join('\n');
}

function commentMetadata(comment: Comment): string[] {
	const metadata = [`- Created: ${dateToIso(comment.createdAt) ?? 'Unknown'}`];
	const updatedAt = dateToIso(comment.updatedAt);
	const editedAt = dateToIso(comment.editedAt);
	const resolvedAt = dateToIso(comment.resolvedAt);

	if (updatedAt != null) {
		metadata.push(`- Updated: ${updatedAt}`);
	}
	if (editedAt != null) {
		metadata.push(`- Edited: ${editedAt}`);
	}
	if (resolvedAt != null) {
		metadata.push(`- Resolved: ${resolvedAt}`);
	}

	return metadata;
}

function quotedText(comment: Comment): string[] {
	const quoted = comment.quotedText?.trim();
	if (!quoted) {
		return [];
	}

	return [
		...quoted.split(/\r?\n/).map((line) => `> ${line}`),
		'',
	];
}

function sortComments(comments: Comment[]): void {
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

function dateToIso(value: Date | null | undefined): string | null {
	return value instanceof Date && !Number.isNaN(value.getTime())
		? value.toISOString()
		: null;
}

function maxIsoDate(
	a: string | undefined,
	b: string | null | undefined,
): string | undefined {
	if (a == null) {
		return b ?? undefined;
	}
	if (b == null) {
		return a;
	}
	return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}
