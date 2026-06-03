import { del, type DocUpdate, upsert } from '@gety-ai/connector-sdk';
import {
	type Comment,
	type Issue,
	type LinearClient,
	type Project,
	type Team,
	type User,
	type WorkflowState,
} from '@linear/sdk';
import {
	latestCommentUpdatedAt,
	markdownImagesToLinks,
	renderCommentsMarkdown,
} from './comment.ts';

export type IssuesQueryVariables = NonNullable<
	Parameters<LinearClient['issues']>[0]
>;

export const DOC_TYPE = 'linear:issue';

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

export function issueDocId(issue: Issue): string {
	return `linear:issue:${issue.id}`;
}

export function issueIsRemoved(issue: Issue): boolean {
	return issue.archivedAt != null || issue.trashed === true;
}

export function issueUpdatedAt(issue: Issue): string | null {
	return dateToIso(issue.updatedAt);
}

export async function buildIssueUpdate(
	issue: Issue,
	comments: readonly Comment[],
	options: BuildIssueUpdateOptions,
): Promise<DocUpdate> {
	if (issueIsRemoved(issue)) {
		return del(issueDocId(issue));
	}

	const details = await issueDetails(issue);
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
			priority: issue.priority,
			priority_label: issue.priorityLabel,
			state: details.stateName ?? undefined,
			team: details.teamName ?? undefined,
			team_key: details.teamKey ?? undefined,
			assignee: details.assigneeName ?? undefined,
			project: details.projectName ?? undefined,
			created_at: createdAt ?? undefined,
			updated_at: issueUpdatedAt,
			comments_updated_at: commentsUpdatedAt,
		},
	});
}

export function issueDateBoundary(
	value: Issue | string,
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

export function dateToIso(value: Date | null | undefined): string | null {
	return value instanceof Date && !Number.isNaN(value.getTime())
		? value.toISOString()
		: null;
}

export function maxIsoDate(
	a: string | undefined,
	b: string | undefined,
): string | undefined {
	if (a == null) {
		return b;
	}
	if (b == null) {
		return a;
	}
	return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

async function issueDetails(issue: Issue): Promise<IssueDetails> {
	const [assignee, project, state, team] = await Promise.all([
		resolveRelation<User>(issue.assignee),
		resolveRelation<Project>(issue.project),
		resolveRelation<WorkflowState>(issue.state),
		resolveRelation<Team>(issue.team),
	]);

	return {
		assigneeName: assignee?.displayName ?? assignee?.name ?? null,
		projectName: project?.name ?? null,
		stateName: state?.name ?? null,
		teamName: team?.name ?? null,
		teamKey: team?.key ?? null,
	};
}

async function resolveRelation<T>(
	relation: PromiseLike<T> | undefined,
): Promise<T | null> {
	return relation == null ? null : await relation;
}

function renderIssueMarkdown(
	issue: Issue,
	details: IssueDetails,
	comments: readonly Comment[],
	options: BuildIssueUpdateOptions,
): string {
	const description = issue.description?.trim();
	const fields = [
		['Status', details.stateName],
		['Team', formatTeam(details)],
		['Assignee', details.assigneeName],
		['Project', details.projectName],
		['Priority', issue.priorityLabel],
		['Created', dateToIso(issue.createdAt)],
		['Updated', dateToIso(issue.updatedAt)],
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
