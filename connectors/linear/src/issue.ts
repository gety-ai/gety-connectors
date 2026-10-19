import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import {
	latestCommentUpdatedAt,
	type LinearComment,
	renderCommentsMarkdown,
} from './comment.ts';
import {
	type Connection,
	type LinearGraphQL,
	requireConnection,
	requireRecord,
	UnexpectedResponseError,
} from './graphql.ts';
import { markdownImagesToLinks } from './markdown.ts';
import { dateToIso, maxIsoDate } from './utils.ts';

export interface IssueFilter {
	updatedAt: { gte: string };
}

export interface IssuePageVariables {
	after?: string;
	filter?: IssueFilter;
	first: number;
}

export const DOC_TYPE = 'linear:issue';

export interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	url: string;
	number: number;
	priority?: number | null;
	priorityLabel?: string | null;
	createdAt?: Date | string | null;
	updatedAt?: Date | string | null;
	archivedAt?: Date | string | null;
	trashed?: boolean | null;
	assignee?: LinearUser | null;
	project?: LinearProject | null;
	state?: LinearWorkflowState | null;
	team?: LinearTeam | null;
	comments?: Connection<LinearComment> | null;
}

interface LinearUser {
	displayName?: string | null;
	name?: string | null;
}

interface LinearProject {
	name?: string | null;
}

interface LinearWorkflowState {
	name?: string | null;
}

interface LinearTeam {
	name?: string | null;
	key?: string | null;
}

interface IssueDetails {
	assigneeName: string | null;
	projectName: string | null;
	stateName: string | null;
	teamName: string | null;
	teamKey: string | null;
}

interface BuildIssueUpdateOptions {
	renderComments: boolean;
}

interface IssueIncrementalOptions {
	incrementalOverlapMs: number;
}

const ISSUE_FIELDS = `
	id
	identifier
	title
	description
	url
	number
	priority
	priorityLabel
	createdAt
	updatedAt
	archivedAt
	trashed
	state {
		name
	}
	team {
		name
		key
	}
	assignee {
		displayName
		name
	}
	project {
		name
	}
`;

const COMMENT_FIELDS = `
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
`;

const ISSUE_PAGE_QUERY = `
	query GetyLinearIssues(
		$after: String
		$filter: IssueFilter
		$first: Int!
		$includeComments: Boolean!
		$commentFirst: Int!
		$sort: [IssueSortInput!]
	) {
		issues(
			after: $after
			filter: $filter
			first: $first
			includeArchived: true
			sort: $sort
		) {
			nodes {
				${ISSUE_FIELDS}
				comments(
					first: $commentFirst
					includeArchived: true
					orderBy: createdAt
				) @include(if: $includeComments) {
					nodes {
						${COMMENT_FIELDS}
					}
					pageInfo {
						endCursor
						hasNextPage
					}
				}
			}
			pageInfo {
				endCursor
				hasNextPage
			}
		}
	}
`;

const ISSUE_QUERY = `
	query GetyLinearIssue(
		$id: String!
		$includeComments: Boolean!
		$commentFirst: Int!
	) {
		issue(id: $id) {
			${ISSUE_FIELDS}
			comments(
				first: $commentFirst
				includeArchived: true
				orderBy: createdAt
			) @include(if: $includeComments) {
				nodes {
					${COMMENT_FIELDS}
				}
				pageInfo {
					endCursor
					hasNextPage
				}
			}
		}
	}
`;

export async function fetchIssuePage(
	client: LinearGraphQL,
	variables: IssuePageVariables,
	includeComments: boolean,
	commentFirst: number,
): Promise<Connection<LinearIssue>> {
	const data = await client.request<{ issues?: unknown }>(ISSUE_PAGE_QUERY, {
		...variables,
		commentFirst,
		includeComments,
		sort: [{ updatedAt: { order: 'Ascending' } }],
	});
	const connection = requireConnection<LinearIssue>(data.issues, 'issues');
	for (const issue of connection.nodes) {
		requireIssue(issue, includeComments, 'issues.nodes');
	}
	return connection;
}

export async function fetchIssueById(
	client: LinearGraphQL,
	id: string,
	includeComments: boolean,
	commentFirst: number,
): Promise<LinearIssue> {
	const data = await client.request<{ issue?: unknown }>(ISSUE_QUERY, {
		commentFirst,
		id,
		includeComments,
	});
	return requireIssue(data.issue, includeComments, 'issue');
}

/** `value` checked as an issue, with its first comments page if requested. */
function requireIssue(
	value: unknown,
	includeComments: boolean,
	context: string,
): LinearIssue {
	const issue = requireRecord(value, context);
	if (typeof issue.id !== 'string' || typeof issue.identifier !== 'string') {
		throw new UnexpectedResponseError(
			`${context}: expected an issue with a string id and identifier`,
		);
	}
	if (includeComments) {
		requireConnection(issue.comments, `${context}.comments`);
	}
	return issue as unknown as LinearIssue;
}

export function issueDocId(issue: LinearIssue): string {
	return issueDocIdFromId(issue.id);
}

export function issueDocIdFromId(issueId: string): string {
	return `linear:issue:${issueId}`;
}

export function buildIssueDelete(issueId: string): DocUpdate {
	return del(issueDocIdFromId(issueId));
}

export function issueIsRemoved(issue: LinearIssue): boolean {
	return issue.archivedAt != null || issue.trashed === true;
}

export function issueUpdatedAt(issue: LinearIssue): string | null {
	return dateToIso(issue.updatedAt);
}

export function buildIssueUpdate(
	issue: LinearIssue,
	comments: readonly LinearComment[],
	options: BuildIssueUpdateOptions,
): DocUpdate {
	if (issueIsRemoved(issue)) {
		return del(issueDocId(issue));
	}

	const details = issueDetails(issue);
	const issueUpdatedAt = dateToIso(issue.updatedAt) ?? new Date().toISOString();
	const commentsUpdatedAt = options.renderComments
		? latestCommentUpdatedAt(comments)
		: undefined;
	const docUpdatedAt = maxIsoDate(issueUpdatedAt, commentsUpdatedAt) ??
		issueUpdatedAt;
	const createdAt = dateToIso(issue.createdAt);

	return upsert({
		id: issueDocId(issue),
		title: `${issue.identifier} ${issue.title}`,
		content: renderIssueMarkdown(issue, details, comments, options),
		content_format: 'markdown',
		doc_updated_at: docUpdatedAt,
		doc_type: DOC_TYPE,
		metadata: {
			url: issue.url,
			source: 'linear',
			issue_id: issue.id,
			identifier: issue.identifier,
			number: issue.number,
			priority: issue.priority ?? undefined,
			priority_label: issue.priorityLabel ?? undefined,
			state: details.stateName ?? undefined,
			team: details.teamName ?? undefined,
			team_key: details.teamKey ?? undefined,
			assignee: details.assigneeName ?? undefined,
			project: details.projectName ?? undefined,
			created_at: createdAt ?? undefined,
			comments_updated_at: commentsUpdatedAt,
		},
	});
}

export function issueDateBoundary(
	value: LinearIssue | string,
	options: IssueIncrementalOptions,
): string | undefined {
	const iso = typeof value === 'string' ? value : issueUpdatedAt(value);
	if (iso == null) {
		return undefined;
	}

	return new Date(
		new Date(iso).getTime() - options.incrementalOverlapMs,
	).toISOString();
}

function issueDetails(issue: LinearIssue): IssueDetails {
	return {
		assigneeName: issue.assignee?.displayName ?? issue.assignee?.name ?? null,
		projectName: issue.project?.name ?? null,
		stateName: issue.state?.name ?? null,
		teamName: issue.team?.name ?? null,
		teamKey: issue.team?.key ?? null,
	};
}

function renderIssueMarkdown(
	issue: LinearIssue,
	details: IssueDetails,
	comments: readonly LinearComment[],
	options: BuildIssueUpdateOptions,
): string {
	const description = issue.description?.trim();
	const fields = [
		['Status', details.stateName],
		['Team', formatTeam(details)],
		['Assignee', details.assigneeName],
		['Project', details.projectName],
		['Priority', issue.priorityLabel],
	];

	const sections = [
		`# ${issue.identifier}: ${issue.title}`,
		'',
		'## Details',
		...fields.map(([label, value]) => `- ${label}: ${value ?? 'None'}`),
	];

	if (description) {
		sections.push('', '## Description', '', markdownImagesToLinks(description));
	}

	const commentsMarkdown = options.renderComments
		? renderCommentsMarkdown(comments)
		: '';
	if (commentsMarkdown) {
		sections.push('', commentsMarkdown);
	}

	return sections.join('\n');
}

function formatTeam(details: IssueDetails): string | null {
	if (details.teamName == null && details.teamKey == null) {
		return null;
	}
	if (details.teamName != null && details.teamKey != null) {
		return `${details.teamName} (${details.teamKey})`;
	}
	return details.teamName ?? details.teamKey;
}
