/**
 * Post-processing for lark-cli's docx markdown export.
 *
 * Gety's markdown renderer does not render raw HTML, so the structural HTML
 * elements lark-cli emits (tables with merged cells, layout grids, callouts,
 * mentions, media embeds…) are converted to plain markdown equivalents or
 * searchable placeholders. Only whitelisted tags are touched: pseudo-XML the
 * document author wrote in prose (e.g. `<product name>`) is left as-is, and
 * fenced/inline code is never modified.
 */

const EPHEMERAL_URL_MARKERS = ['internal-api-drive-stream', '/authcode/'];

export function cleanupDocMarkdown(text: string): string {
	return transformOutsideCode(text, (segment) => {
		let out = segment;
		out = convertTables(out);
		out = convertCallouts(out);
		out = stripGrids(out);
		out = transformInline(out);
		out = convertBlockLevel(out);
		out = replaceEphemeralImages(out);
		out = convertLineBreaks(out);
		return out.replace(/\n{3,}/g, '\n\n');
	});
}

/** Applies fn to the parts of the text outside fenced blocks and inline code. */
export function transformOutsideCode(
	text: string,
	fn: (segment: string) => string,
): string {
	const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
	return parts
		.map((part, index) => (index % 2 === 0 ? fn(part) : part))
		.join('');
}

/**
 * lark-cli emits HTML tables only for tables with merged cells (simple ones
 * are already pipe tables). Merges are flattened: a colspan pads its row with
 * empty cells, so every cell's text lands in a searchable, renderable table.
 */
function convertTables(text: string): string {
	return text.replace(/<table>[\s\S]*?<\/table>/g, (block) => {
		const rows: string[][] = [];
		for (const row of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
			const cells: string[] = [];
			for (
				const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/g)
			) {
				const colspan = Number(/colspan="(\d+)"/.exec(cell[1])?.[1] ?? '1');
				cells.push(flattenCell(cell[2]));
				for (let extra = 1; extra < colspan; extra += 1) {
					cells.push('');
				}
			}
			rows.push(cells);
		}
		if (rows.length === 0) {
			return '';
		}
		const width = Math.max(...rows.map((cells) => cells.length), 1);
		const line = (cells: string[]) =>
			`| ${
				Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')
			} |`;
		const separator = `| ${Array(width).fill('---').join(' | ')} |`;
		return [
			'',
			line(rows[0]),
			separator,
			...rows.slice(1).map(line),
			'',
		].join('\n');
	});
}

/** Cell content must stay on one pipe-table line with pipes escaped. */
function flattenCell(content: string): string {
	let out = content;
	out = transformInline(out);
	out = out
		.replace(/<br\s*\/?>/g, ' ')
		.replace(/<p(?:\s[^>]*)?>|<\/p>/g, ' ')
		.replace(/<li(?:\s[^>]*)?>/g, ' • ')
		.replace(/<\/li>/g, ' ')
		.replace(/<\/?(?:ul|ol|blockquote)(?:\s[^>]*)?>/g, ' ');
	return out.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** `<callout emoji="💡">…</callout>` becomes a quoted block. */
function convertCallouts(text: string): string {
	return text.replace(
		/<callout\b([^>]*)>([\s\S]*?)<\/callout>/g,
		(_, attrs: string, inner: string) => {
			const emoji = /emoji="([^"]*)"/.exec(attrs)?.[1];
			const lines = inner.trim().split('\n');
			const quoted = lines
				.map((line, index) =>
					index === 0 && emoji ? `> ${emoji} ${line}` : `> ${line}`
				)
				.join('\n');
			return `\n${quoted}\n`;
		},
	);
}

/** Layout grids carry no meaning: keep the column contents in order. */
function stripGrids(text: string): string {
	return text
		.replace(/<\/?grid>/g, '')
		.replace(/<column\b[^>]*>/g, '')
		.replace(/<\/column>/g, '\n\n');
}

/**
 * Inline whitelisted elements, shared between flow text and table cells.
 * Placeholders keep the searchable parts (names, alt text, tokens as links).
 */
function transformInline(text: string): string {
	let out = text;

	// @mentions: the user name is the searchable part.
	out = out.replace(
		/<cite\b([^>]*)>([\s\S]*?)<\/cite>/g,
		(_, attrs: string, inner: string) => {
			const name = /user-name="([^"]*)"/.exec(attrs)?.[1];
			return name ? `@${name}` : inner.trim();
		},
	);

	// Media embeds: ephemeral signed URLs are useless, keep a typed marker.
	out = out.replace(/<source\b([^>]*?)\/?>/g, (_, attrs: string) => {
		const mime = /mime="([^"]*)"/.exec(attrs)?.[1] ?? '';
		if (mime.startsWith('video/')) {
			return '[视频]';
		}
		if (mime.startsWith('audio/')) {
			return '[音频]';
		}
		if (mime.startsWith('image/')) {
			return '[图片]';
		}
		return '[附件]';
	});
	out = out.replace(/<\/?figure[^>]*>/g, '');

	// Inline images carry name and alt description text worth indexing.
	out = out.replace(/<img\b([^>]*?)\/?>/g, (_, attrs: string) => {
		const name = /name="([^"]*)"/.exec(attrs)?.[1];
		const alt = /alt="([^"]*)"/.exec(attrs)?.[1];
		const label = name ? `[图片: ${name}]` : '[图片]';
		return alt ? `${label} ${alt}` : label;
	});

	out = out.replace(
		/<whiteboard\b[^>]*>(?:[\s\S]*?<\/whiteboard>)?/g,
		'[画板]',
	);

	out = out.replace(
		/<bitable\b([^>]*)>(?:[\s\S]*?<\/bitable>)?/g,
		(_, attrs: string) => {
			const token = /token="([^"]*)"/.exec(attrs)?.[1];
			return token
				? `[多维表格](https://feishu.cn/base/${token})`
				: '[多维表格]';
		},
	);

	// Empty status tag next to an already-rendered `- [x]` checkbox.
	out = out.replace(/<task\b[^>]*>(?:[\s\S]*?<\/task>)?/g, '');

	out = out.replace(
		/<time\b([^>]*)>(?:[\s\S]*?<\/time>)?/g,
		(_, attrs: string) => {
			const ms = Number(/expire-time="(\d+)"/.exec(attrs)?.[1]);
			if (!Number.isFinite(ms)) {
				return '[日期]';
			}
			const date = new Date(ms);
			const day = `${date.getFullYear()}-${
				String(date.getMonth() + 1).padStart(2, '0')
			}-${String(date.getDate()).padStart(2, '0')}`;
			if (/is-whole-day="true"/.test(attrs)) {
				return day;
			}
			const time = `${String(date.getHours()).padStart(2, '0')}:${
				String(date.getMinutes()).padStart(2, '0')
			}`;
			return `${day} ${time}`;
		},
	);

	out = out.replace(
		/<poll\b([^>]*)>([\s\S]*?)<\/poll>/g,
		(_, attrs: string, inner: string) => {
			const name = /name="([^"]*)"/.exec(attrs)?.[1];
			const label = name ? `[投票: ${name}]` : '[投票]';
			const body = inner.trim();
			return body ? `${label}\n${body}` : label;
		},
	);

	out = out.replace(/<\/?synced-source>/g, '');

	out = out.replace(
		/<readonly-block\b([^>]*)>(?:[\s\S]*?<\/readonly-block>)?/g,
		(_, attrs: string) =>
			/type="task_list"/.test(attrs) ? '[任务列表]' : '[只读区块]',
	);

	out = out.replace(
		/<a\b([^>]*)>([\s\S]*?)<\/a>/g,
		(_, attrs: string, inner: string) => {
			const href = /href="([^"]*)"/.exec(attrs)?.[1];
			const label = inner.trim();
			if (href == null) {
				return label;
			}
			return label ? `[${label}](${href})` : href;
		},
	);

	out = out.replace(
		/<b>\s*([\s\S]*?)\s*<\/b>/g,
		(_, inner: string) => (inner === '' ? '' : `**${inner}**`),
	);

	return out;
}

/** Block-level leftovers outside tables (mostly from grid columns). */
function convertBlockLevel(text: string): string {
	return text
		.replace(/<p(?:\s[^>]*)?>/g, '')
		.replace(/<\/p>/g, '\n\n')
		.replace(/<\/?(?:ul|ol)(?:\s[^>]*)?>/g, '\n')
		.replace(/<li(?:\s[^>]*)?>/g, '\n- ')
		.replace(/<\/li>/g, '')
		.replace(
			/<blockquote(?:\s[^>]*)?>([\s\S]*?)<\/blockquote>/g,
			(_, inner: string) =>
				`\n${inner.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n`,
		);
}

/** `![alt](signed url)` expires in minutes; keep the alt text only. */
function replaceEphemeralImages(text: string): string {
	return text.replace(
		/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
		(whole, alt: string, url: string) => {
			if (!EPHEMERAL_URL_MARKERS.some((marker) => url.includes(marker))) {
				return whole;
			}
			const label = alt.trim();
			return label ? `[图片: ${label}]` : '[图片]';
		},
	);
}

/** `<br/>` inside a pipe-table line must not break the row. */
function convertLineBreaks(text: string): string {
	return text
		.split('\n')
		.map((line) =>
			line.replace(/<br\s*\/?>/g, line.trimStart().startsWith('|') ? ' ' : '\n')
		)
		.join('\n');
}
