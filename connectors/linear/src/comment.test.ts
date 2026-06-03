import assert from 'node:assert/strict';
import {
	type LinearComment,
	markdownImagesToLinks,
	renderCommentsMarkdown,
} from './comment.ts';

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
			'Text [Nested](https://example.com/a_(b).png "title")',
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
		}),
		comment({
			id: 'reply-1',
			parentId: 'root-1',
			body: 'Reply body',
			createdAt: new Date('2026-06-03T00:01:00.000Z'),
		}),
		comment({
			id: 'root-2',
			body: 'Second body',
			createdAt: new Date('2026-06-03T00:02:00.000Z'),
		}),
	]);

	assert.match(markdown, /^## Comments/);
	assert.match(markdown, /### Comment/);
	assert.match(markdown, /#### Reply/);
	assert.match(markdown, /\n---\n/);
	assert.match(markdown, /First \[image\]\(https:\/\/example\.com\/a\.png\)/);
	assert.doesNotMatch(markdown, /!\[image\]/);
});

interface MockComment {
	id: string;
	body: string;
	parentId: string | null;
	createdAt: Date;
	updatedAt: Date;
	editedAt: Date | null;
	archivedAt: Date | null;
	resolvedAt: Date | null;
	quotedText: string | null;
}

function comment(overrides: Partial<MockComment>): LinearComment {
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
