import {
	Connector,
	del,
	type DocUpdate,
	type PollResult,
	upsert,
} from '@gety-ai/connector-sdk';
import {
	type Issue,
	LinearClient,
	LinearDocument,
	type Project,
	type Team,
	type User,
	type WorkflowState,
} from '@linear/sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';

type LinearState = {
	schema_version?: 1;
	last_updated_at?: string;
	last_poll_completed_at?: string;
	last_poll_issue_count?: number;
	last_poll_update_count?: number;
	last_poll_hit_limit?: boolean;
};

type IssueDetails = {
	assigneeName: string | null;
	projectName: string | null;
	stateName: string | null;
	teamName: string | null;
	teamKey: string | null;
};

type IssuesQueryVariables = NonNullable<Parameters<LinearClient['issues']>[0]>;

const DOC_TYPE = 'linear:issue';
const ISSUE_PAGE_SIZE = 50;
const MAX_ISSUES_PER_POLL = 500;
const INCREMENTAL_OVERLAP_MS = 1000;

function readState(value: unknown): LinearState {
	if (value === null || typeof value !== 'object') {
		return {};
	}

	const state = value as LinearState;
	return {
		schema_version: state.schema_version === 1 ? 1 : undefined,
		last_updated_at: readIsoDateString(state.last_updated_at),
		last_poll_completed_at: readIsoDateString(state.last_poll_completed_at),
		last_poll_issue_count: readNumber(state.last_poll_issue_count),
		last_poll_update_count: readNumber(state.last_poll_update_count),
		last_poll_hit_limit: typeof state.last_poll_hit_limit === 'boolean'
			? state.last_poll_hit_limit
			: undefined,
	};
}

function readIsoDateString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function dateToIso(value: Date | null | undefined): string | null {
	return value instanceof Date && !Number.isNaN(value.getTime())
		? value.toISOString()
		: null;
}

function maxIsoDate(a: string | undefined, b: string): string {
	if (a == null) {
		return b;
	}
	return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

function buildIssueFilter(state: LinearState): IssuesQueryVariables['filter'] {
	if (state.last_updated_at == null) {
		return undefined;
	}

	const boundary = new Date(
		new Date(state.last_updated_at).getTime() - INCREMENTAL_OVERLAP_MS,
	).toISOString();
	return { updatedAt: { gte: boundary } };
}

async function readIssueDetails(issue: Issue): Promise<IssueDetails> {
	const [assignee, project, state, team] = await Promise.all([
		readRelation<User>(issue.assignee),
		readRelation<Project>(issue.project),
		readRelation<WorkflowState>(issue.state),
		readRelation<Team>(issue.team),
	]);

	return {
		assigneeName: assignee?.displayName ?? assignee?.name ?? null,
		projectName: project?.name ?? null,
		stateName: state?.name ?? null,
		teamName: team?.name ?? null,
		teamKey: team?.key ?? null,
	};
}

async function readRelation<T>(
	relation: PromiseLike<T> | undefined,
): Promise<T | null> {
	if (relation == null) {
		return null;
	}

	try {
		return await relation;
	} catch {
		return null;
	}
}

function issueDocId(issue: Issue): string {
	return `linear:issue:${issue.id}`;
}

function issueIsRemoved(issue: Issue): boolean {
	return issue.archivedAt != null || issue.trashed === true;
}

async function issueToUpdate(issue: Issue): Promise<DocUpdate> {
	if (issueIsRemoved(issue)) {
		return del(issueDocId(issue));
	}

	const details = await readIssueDetails(issue);
	const updatedAt = dateToIso(issue.updatedAt) ?? new Date().toISOString();
	const createdAt = dateToIso(issue.createdAt);

	return upsert({
		id: issueDocId(issue),
		title: `${issue.identifier} ${issue.title}`,
		content: renderIssueMarkdown(issue, details),
		content_format: 'markdown',
		doc_updated_at: updatedAt,
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
			updated_at: updatedAt,
		},
	});
}

function renderIssueMarkdown(issue: Issue, details: IssueDetails): string {
	const description = issue.description?.trim() || '_No description._';
	const fields = [
		['Status', details.stateName],
		['Team', formatTeam(details)],
		['Assignee', details.assigneeName],
		['Project', details.projectName],
		['Priority', issue.priorityLabel],
		['Created', dateToIso(issue.createdAt)],
		['Updated', dateToIso(issue.updatedAt)],
	];

	return [
		`# ${issue.identifier}: ${issue.title}`,
		'',
		`[Open in Linear](${issue.url})`,
		'',
		'## Details',
		...fields.map(([label, value]) => `- ${label}: ${value ?? 'None'}`),
		'',
		'## Description',
		'',
		description,
	].join('\n');
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

export default class LinearConnector
	extends Connector<ManifestConfig, LinearState> {
	private client!: LinearClient;

	override onload(): void {
		this.client = new LinearClient({ apiKey: this.config.api_key.trim() });
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const previousState = readState(this.lastState);
		const filter = buildIssueFilter(previousState);
		const updates: DocUpdate[] = [];

		let after: string | undefined;
		let issueCount = 0;
		let lastUpdatedAt = previousState.last_updated_at;
		let hasNextPage = true;

		while (hasNextPage && issueCount < MAX_ISSUES_PER_POLL) {
			this.signal.throwIfAborted();

			const first = Math.min(ISSUE_PAGE_SIZE, MAX_ISSUES_PER_POLL - issueCount);
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
				const updatedAt = dateToIso(issue.updatedAt);
				if (updatedAt != null) {
					lastUpdatedAt = maxIsoDate(lastUpdatedAt, updatedAt);
				}
				updates.push(await issueToUpdate(issue));
			}

			issueCount += connection.nodes.length;
			after = connection.pageInfo.endCursor ?? undefined;
			hasNextPage = connection.pageInfo.hasNextPage && after != null;

			if (connection.nodes.length === 0) {
				break;
			}
		}

		yield {
			updates,
			state: {
				schema_version: 1,
				last_updated_at: lastUpdatedAt,
				last_poll_completed_at: new Date().toISOString(),
				last_poll_issue_count: issueCount,
				last_poll_update_count: updates.length,
				last_poll_hit_limit: hasNextPage,
			} satisfies LinearState,
		};
	}
}
