import assert from 'node:assert/strict';
import {
	commentBoundary,
	type LinearComment,
	renderCommentsMarkdown,
} from './comment.ts';
import { markdownImagesToLinks } from './markdown.ts';

Deno.test('markdownImagesToLinks converts images without touching code', () => {
	const markdown = [
		'![Logo](https://example.com/logo.png)',
		'`![Inline code](https://example.com/code.png)`',
		'```',
		'![Code block](https://example.com/block.png)',
		'```',
		'Text ![Nested](https://example.com/a_(b).png "title")',
	].join('\n');

	assert.equal(
		markdownImagesToLinks(markdown),
		[
			'[Logo](https://example.com/logo.png)',
			'`![Inline code](https://example.com/code.png)`',
			'```',
			'![Code block](https://example.com/block.png)',
			'```',
			'Text [Nested](https://example.com/a_\\(b\\).png "title")',
		].join('\n'),
	);
});

Deno.test('renderCommentsMarkdown omits an empty comments section', () => {
	assert.equal(renderCommentsMarkdown([]), '');
	assert.equal(
		renderCommentsMarkdown([
			comment({
				id: 'archived',
				archivedAt: new Date('2026-06-03T00:00:00.000Z'),
			}),
		]),
		'',
	);
});

Deno.test('renderCommentsMarkdown renders separated threaded comments', () => {
	const markdown = renderCommentsMarkdown([
		comment({
			id: 'root-1',
			body: 'First ![image](https://example.com/a.png)',
			createdAt: new Date('2026-06-03T00:00:00.000Z'),
			user: {
				displayName: 'alice',
				url: 'https://linear.app/example/profiles/alice',
			},
		}),
		comment({
			id: 'reply-1',
			parentId: 'root-1',
			body: 'Reply body',
			createdAt: new Date('2026-06-03T00:01:00.000Z'),
			user: {
				displayName: 'bob',
			},
		}),
		comment({
			id: 'root-2',
			body: 'Second body',
			createdAt: new Date('2026-06-03T00:02:00.000Z'),
		}),
	]);

	assert.match(markdown, /^## Comments/);
	assert.match(markdown, /\n---\n/);
	assert.match(
		markdown,
		/@alice · 2026-06-03 00:00\n\nFirst \[image\]\(https:\/\/example\.com\/a\.png\)/,
	);
	assert.match(
		markdown,
		/> @bob · 2026-06-03 00:01\n>\n> Reply body/,
	);
	assert.match(markdown, /@unknown · 2026-06-03 00:02/);
	assert.doesNotMatch(markdown, /> @alice · 2026-06-03 00:00/);
	assert.doesNotMatch(markdown, /> @unknown · 2026-06-03 00:02/);
	assert.doesNotMatch(markdown, /### Comment/);
	assert.doesNotMatch(markdown, /#### Reply/);
	assert.doesNotMatch(markdown, /- Author:/);
	assert.doesNotMatch(markdown, /!\[image\]/);
});

Deno.test('renderCommentsMarkdown sorts timestamps by actual time', () => {
	const markdown = renderCommentsMarkdown([
		comment({
			id: 'later',
			body: 'Later',
			createdAt: '2026-06-03T00:30:00.000Z',
		}),
		comment({
			id: 'earlier',
			body: 'Earlier',
			createdAt: '2026-06-03T01:00:00.000+01:00',
		}),
	]);

	assert.ok(markdown.indexOf('Earlier') < markdown.indexOf('Later'));
});

Deno.test('commentBoundary resumes an in-progress comment delta page', () => {
	assert.equal(
		commentBoundary({
			comment_delta_boundary: '2026-06-03T00:00:00.000Z',
			last_comment_updated_at: '2026-06-03T01:00:00.000Z',
		}, {
			commentDeltaPageSize: 50,
			issueCommentPageSize: 50,
			maxCommentDeltasPerPoll: 50,
			incrementalOverlapMs: 1000,
		}),
		'2026-06-03T00:00:00.000Z',
	);
});

function comment(overrides: Partial<LinearComment>): LinearComment {
	return {
		id: 'comment',
		body: 'Body',
		parentId: null,
		createdAt: new Date('2026-06-03T00:00:00.000Z'),
		updatedAt: new Date('2026-06-03T00:00:00.000Z'),
		editedAt: null,
		archivedAt: null,
		resolvedAt: null,
		quotedText: null,
		...overrides,
	};
}
