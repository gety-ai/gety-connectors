// Byte-accurate content truncation and a few Markdown primitives.

/**
 * Content budget of one document in UTF-8 bytes: below the host's 10 MB
 * per-document limit, leaving room for title and metadata.
 */
export const MAX_CONTENT_BYTES = 8_000_000;

const encoder = new TextEncoder();

export interface ClampedText {
	content: string;
	/** UTF-8 size of `content`. */
	bytes: number;
	truncated: boolean;
}

/**
 * `text` when it fits in `maxBytes` UTF-8 bytes; otherwise the longest prefix
 * that fits together with `notice`, followed by `notice`. The cut lands on a
 * code point boundary (a surrogate pair is never split), and the result,
 * notice included, never exceeds `maxBytes`. Throws when `notice` alone does
 * not fit. Encodes at most `maxBytes` bytes of `text`.
 */
export function clampUtf8(
	text: string,
	maxBytes: number,
	notice: string,
): ClampedText {
	const noticeBytes = encoder.encode(notice).length;
	if (noticeBytes > maxBytes) {
		throw new RangeError(
			`truncation notice (${noticeBytes} bytes) exceeds the budget of ${maxBytes} bytes`,
		);
	}
	// encodeInto writes only whole code points and reports how many UTF-16
	// units it consumed, which is exactly the longest prefix that fits. A
	// UTF-16 unit takes at most 3 bytes, so short text needs a short buffer.
	const buffer = new Uint8Array(Math.min(maxBytes, text.length * 3));
	const whole = encoder.encodeInto(text, buffer);
	if (whole.read === text.length) {
		return { content: text, bytes: whole.written, truncated: false };
	}
	const prefix = encoder.encodeInto(
		text,
		buffer.subarray(0, maxBytes - noticeBytes),
	);
	return {
		content: text.slice(0, prefix.read) + notice,
		bytes: prefix.written + noticeBytes,
		truncated: true,
	};
}

/**
 * One pipe-table cell: line breaks become spaces, `|` is escaped, and the
 * result is trimmed.
 */
export function pipeCell(text: string): string {
	return text.replace(/\r\n|[\r\n]/g, ' ').replaceAll('|', '\\|').trim();
}

/**
 * A Markdown pipe table. Cells are raw text and pass through `pipeCell`;
 * rows are padded to the widest row (or `width`, when larger). With
 * `header: false` the header row is left empty and every row is a body row.
 * Returns `''` when there are no rows.
 */
export function pipeTable(
	rows: readonly (readonly string[])[],
	options: { header: boolean; width?: number },
): string {
	if (rows.length === 0) {
		return '';
	}
	const width = Math.max(
		options.width ?? 0,
		...rows.map((row) => row.length),
		1,
	);
	const line = (row: readonly string[]) =>
		`| ${
			Array.from({ length: width }, (_, i) => pipeCell(row[i] ?? '')).join(
				' | ',
			)
		} |`;
	const header = options.header ? rows[0] : [];
	const body = options.header ? rows.slice(1) : rows;
	return [
		line(header),
		`| ${Array(width).fill('---').join(' | ')} |`,
		...body.map(line),
	].join('\n');
}

/**
 * `value` as a normalized URL when it is an absolute http(s) URL without
 * credentials; otherwise undefined.
 */
export function httpUrl(value: string | undefined): string | undefined {
	if (!value?.trim()) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.username !== '' || url.password !== ''
	) {
		return undefined;
	}
	return url.href;
}

/**
 * `[label](<url>)` with the label's whitespace collapsed and Markdown
 * punctuation escaped. Without a usable `url` (see `httpUrl`), or with an
 * empty label, only the escaped label is returned.
 */
export function markdownLink(label: string, url: string | undefined): string {
	const text = label.replace(/\s+/g, ' ').trim().replace(
		/[\\`*_{}\[\]()<>#!|]/g,
		'\\$&',
	);
	const href = httpUrl(url);
	if (text === '' || href === undefined) {
		return text;
	}
	// URL serialization already percent-encodes `<` and `>`; this keeps the
	// angle-bracket destination unbreakable regardless.
	return `[${text}](<${href.replaceAll('<', '%3C').replaceAll('>', '%3E')}>)`;
}

/**
 * A Markdown code span (CommonMark 0.31.2 §6.1) that shows `value`
 * verbatim, so copying the span copies `value`. Backslash escapes do not work
 * inside a span: the fence is one backtick longer than the longest backtick
 * run in `value` instead, and a space pads each side when `value` starts or
 * ends with a backtick, or starts and ends with a space without being all
 * spaces (the parser strips one space from each side then). Line breaks, which
 * a span shows as spaces and which could start a new block, become spaces.
 * Returns `''` for an empty value, which no span can show.
 */
export function inlineCode(value: string): string {
	const text = value.replace(/\r\n?|\n/g, ' ');
	if (text === '') {
		return '';
	}
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) {
		longest = Math.max(longest, run.length);
	}
	const fence = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ||
			(text.startsWith(' ') && text.endsWith(' ') && !/^ +$/.test(text))
		? ' '
		: '';
	return `${fence}${pad}${text}${pad}${fence}`;
}
