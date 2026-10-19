import assert from 'node:assert/strict';
import {
	clampUtf8,
	httpUrl,
	markdownLink,
	MAX_CONTENT_BYTES,
	pipeCell,
	pipeTable,
} from './text.ts';

const bytes = (text: string) => new TextEncoder().encode(text).length;

Deno.test('clampUtf8 keeps text that fits, exactly full included', () => {
	assert.deepEqual(clampUtf8('abcde', 5, '…'), {
		content: 'abcde',
		bytes: 5,
		truncated: false,
	});
	assert.deepEqual(clampUtf8('中文', 6, ''), {
		content: '中文',
		bytes: 6,
		truncated: false,
	});
	assert.deepEqual(clampUtf8('', 0, ''), {
		content: '',
		bytes: 0,
		truncated: false,
	});
});

Deno.test('clampUtf8 truncates ASCII and appends the notice within budget', () => {
	assert.deepEqual(clampUtf8('abcdef', 5, '…'), {
		content: 'ab…',
		bytes: 5,
		truncated: true,
	});
});

Deno.test('clampUtf8 cuts CJK on a code point boundary', () => {
	// 中文字 is 9 bytes; 8 bytes of budget fit two characters.
	assert.deepEqual(clampUtf8('中文字', 8, ''), {
		content: '中文',
		bytes: 6,
		truncated: true,
	});
	assert.deepEqual(clampUtf8('a中文', 6, '.'), {
		content: 'a中.',
		bytes: 5,
		truncated: true,
	});
});

Deno.test('clampUtf8 never splits an emoji surrogate pair', () => {
	assert.deepEqual(clampUtf8('😀😀', 7, ''), {
		content: '😀',
		bytes: 4,
		truncated: true,
	});
	assert.deepEqual(clampUtf8('😀😀', 3, ''), {
		content: '',
		bytes: 0,
		truncated: true,
	});
	assert.deepEqual(clampUtf8('😀😀', 5, '!'), {
		content: '😀!',
		bytes: 5,
		truncated: true,
	});
});

Deno.test('clampUtf8 holds its invariants at every budget', () => {
	const text = 'aé中😀b\u{10348}z中文👩‍👩‍👧x';
	const notice = '[…]';
	for (let max = bytes(notice); max <= bytes(text) + 2; max += 1) {
		const result = clampUtf8(text, max, notice);
		assert.equal(result.bytes, bytes(result.content), `max ${max}`);
		assert.ok(result.bytes <= max, `max ${max}`);
		if (result.truncated) {
			const prefix = result.content.slice(0, -notice.length);
			assert.ok(text.startsWith(prefix));
			assert.ok(!/[\uD800-\uDBFF]$/.test(prefix), `max ${max}`);
			// The longest prefix: one more code point would not fit.
			const next = String.fromCodePoint(text.codePointAt(prefix.length)!);
			assert.ok(bytes(prefix + next) + bytes(notice) > max, `max ${max}`);
		} else {
			assert.equal(result.content, text);
		}
	}
});

Deno.test('clampUtf8 rejects a notice larger than the budget', () => {
	assert.throws(() => clampUtf8('long text', 2, '…'), RangeError);
	assert.throws(() => clampUtf8('', 2, '…'), RangeError);
});

Deno.test('clampUtf8 handles content at the document budget', () => {
	const notice = '\n\n[truncated]';
	const result = clampUtf8(
		'x'.repeat(MAX_CONTENT_BYTES + 10),
		MAX_CONTENT_BYTES,
		notice,
	);
	assert.equal(result.truncated, true);
	assert.equal(result.bytes, MAX_CONTENT_BYTES);
	assert.ok(result.content.endsWith(notice));
});

Deno.test('pipeCell flattens line breaks and escapes pipes', () => {
	assert.equal(pipeCell('  a|b\nc\r\nd\re  '), 'a\\|b c d e');
});

Deno.test('pipeTable pads uneven rows and escapes cells', () => {
	assert.equal(
		pipeTable([['Name', 'Value'], ['a|b'], ['multi\nline', 'x', 'extra']], {
			header: true,
		}),
		[
			'| Name | Value |  |',
			'| --- | --- | --- |',
			'| a\\|b |  |  |',
			'| multi line | x | extra |',
		].join('\n'),
	);
});

Deno.test('pipeTable without a header leaves the header row empty', () => {
	assert.equal(
		pipeTable([['a', 'b']], { header: false, width: 3 }),
		['|  |  |  |', '| --- | --- | --- |', '| a | b |  |'].join('\n'),
	);
	assert.equal(pipeTable([], { header: true }), '');
});

Deno.test('httpUrl only accepts credential-free http(s) URLs', () => {
	assert.equal(httpUrl('https://example.com/a b'), 'https://example.com/a%20b');
	assert.equal(httpUrl(' http://example.com '), 'http://example.com/');
	for (
		const value of [
			undefined,
			'',
			'  ',
			'javascript:alert(1)',
			'file:///etc/passwd',
			'ftp://example.com',
			'https://user:pw@example.com',
			'https://user@example.com',
			'/relative',
			'not a url',
		]
	) {
		assert.equal(httpUrl(value), undefined, String(value));
	}
});

Deno.test('markdownLink wraps the URL in angle brackets', () => {
	assert.equal(
		markdownLink('Doc', 'https://example.com/a (b)/c d'),
		'[Doc](<https://example.com/a%20(b)/c%20d>)',
	);
	assert.equal(
		markdownLink('q', 'https://example.com/?x=<y>'),
		'[q](<https://example.com/?x=%3Cy%3E>)',
	);
});

Deno.test('markdownLink escapes the label and falls back to text', () => {
	assert.equal(
		markdownLink(' [a] *b*\n_c_ ', 'https://e.com'),
		'[\\[a\\] \\*b\\* \\_c\\_](<https://e.com/>)',
	);
	assert.equal(markdownLink('Run me', 'javascript:alert(1)'), 'Run me');
	assert.equal(markdownLink('Secret', 'https://user:pw@host/'), 'Secret');
	assert.equal(markdownLink('Plain', undefined), 'Plain');
	assert.equal(markdownLink('', 'https://e.com'), '');
	assert.equal(markdownLink('  ', 'https://e.com'), '');
});
