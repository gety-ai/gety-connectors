import assert from 'node:assert/strict';
import {
	buildDocUrl,
	extractDocContent,
	extractSearchPage,
	isoFromLarkTime,
	isRateLimitFailure,
	normalizeSourceTime,
	stripHighlightTags,
} from './lark_cli.ts';

Deno.test('isoFromLarkTime parses local minute timestamps', () => {
	const iso = isoFromLarkTime('2026-07-10 11:22');
	assert.ok(iso != null);
	assert.equal(
		new Date(iso).getTime(),
		new Date('2026-07-10T11:22:00').getTime(),
	);

	const withSeconds = isoFromLarkTime('2026-07-10 11:22:33');
	assert.ok(withSeconds != null);
	assert.equal(
		new Date(withSeconds).getTime(),
		new Date('2026-07-10T11:22:33').getTime(),
	);

	assert.equal(isoFromLarkTime(undefined), undefined);
	assert.equal(isoFromLarkTime('not a date'), undefined);
});

Deno.test('normalizeSourceTime handles unix seconds and milliseconds', () => {
	assert.equal(normalizeSourceTime(1752105600), '2025-07-10T00:00:00.000Z');
	assert.equal(normalizeSourceTime('1752105600'), '2025-07-10T00:00:00.000Z');
	assert.equal(
		normalizeSourceTime(1752105600000),
		'2025-07-10T00:00:00.000Z',
	);
	assert.equal(normalizeSourceTime(null), undefined);
});

Deno.test('stripHighlightTags removes search highlight markup', () => {
	assert.equal(stripHighlightTags('<em>Gety</em> roadmap'), 'Gety roadmap');
	assert.equal(stripHighlightTags('plain title'), 'plain title');
});

Deno.test('extractSearchPage maps doc_wiki search entities', () => {
	const page = extractSearchPage({
		results: [
			{
				entity_type: 'DOC',
				result_meta: {
					token: 'doxcnAAAA',
					doc_types: 'DOCX',
					create_time: 1752019200,
					create_time_iso: '2025-07-09T08:00:00+08:00',
					update_time: 1752105600,
					update_time_iso: '2025-07-10T08:00:00+08:00',
					owner_name: 'Channing',
					url: 'https://example.feishu.cn/docx/doxcnAAAA',
				},
				title_highlighted: '<h>Release</h> plan',
			},
			{ result_meta: {}, title_highlighted: 'missing token, skipped' },
		],
		has_more: true,
		page_token: 'next',
	});

	assert.equal(page.entities.length, 1);
	assert.deepEqual(page.entities[0], {
		token: 'doxcnAAAA',
		type: 'docx',
		title: 'Release plan',
		editedAt: '2025-07-10T00:00:00.000Z',
		createdAt: '2025-07-09T00:00:00.000Z',
		url: 'https://example.feishu.cn/docx/doxcnAAAA',
		owner: 'Channing',
	});
	assert.equal(page.hasMore, true);
	assert.equal(page.pageToken, 'next');
});

Deno.test('extractSearchPage tolerates unknown shapes', () => {
	assert.deepEqual(extractSearchPage(null), { entities: [], hasMore: false });
	assert.deepEqual(extractSearchPage({ unexpected: true }), {
		entities: [],
		hasMore: false,
		pageToken: undefined,
	});
});

Deno.test('extractDocContent finds markdown in nested payloads', () => {
	assert.equal(extractDocContent('# Title'), '# Title');
	assert.equal(extractDocContent({ content: '# Title' }), '# Title');
	assert.equal(
		extractDocContent({ document: { markdown: '# Nested' } }),
		'# Nested',
	);
	assert.equal(extractDocContent({ content: '   ' }), null);
	assert.equal(extractDocContent(42), null);
});

Deno.test('buildDocUrl maps source types to url paths', () => {
	assert.equal(buildDocUrl('docx', 't'), 'https://feishu.cn/docx/t');
	assert.equal(buildDocUrl('wiki', 't'), 'https://feishu.cn/wiki/t');
	assert.equal(buildDocUrl('doc', 't'), 'https://feishu.cn/docs/t');
});

Deno.test('isRateLimitFailure matches only explicit rate-limit errors', () => {
	assert.equal(
		isRateLimitFailure({
			ok: false,
			error: { type: 'rate_limit', message: 'slow down' },
		}),
		true,
	);
	assert.equal(
		isRateLimitFailure({
			ok: false,
			error: { message: 'HTTP 429 Too Many Requests' },
		}),
		true,
	);
	assert.equal(
		isRateLimitFailure({
			ok: false,
			error: { type: 'authorization', message: 'missing scope' },
		}),
		false,
	);
	assert.equal(isRateLimitFailure(null), false);
	assert.equal(isRateLimitFailure({ ok: false }), false);
});
