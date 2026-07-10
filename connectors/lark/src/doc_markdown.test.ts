import assert from 'node:assert/strict';
import { cleanupDocMarkdown, transformOutsideCode } from './doc_markdown.ts';

Deno.test('code fences and inline code are never modified', () => {
	const text = [
		'before <b>bold</b>',
		'```html',
		'<table><tr><td>raw</td></tr></table>',
		'```',
		'inline `<b>code</b>` stays',
	].join('\n');

	const out = cleanupDocMarkdown(text);
	assert.match(out, /before \*\*bold\*\*/);
	assert.match(out, /<table><tr><td>raw<\/td><\/tr><\/table>/);
	assert.match(out, /`<b>code<\/b>` stays/);
});

Deno.test('transformOutsideCode splits on fences and inline code', () => {
	const out = transformOutsideCode(
		'a `b` c ```\nd\n``` e',
		(segment) => segment.toUpperCase(),
	);
	assert.equal(out, 'A `b` C ```\nd\n``` E');
});

Deno.test('html tables become pipe tables with flattened colspans', () => {
	const out = cleanupDocMarkdown(
		'<table><colgroup><col/><col/><col/></colgroup><tbody>' +
			'<tr><td colspan="2">头</td><td>列3</td></tr>' +
			'<tr><td>a<br/>b</td><td><b>粗</b></td><td>管道|字符</td></tr>' +
			'</tbody></table>',
	);

	const lines = out.trim().split('\n');
	assert.equal(lines[0], '| 头 |  | 列3 |');
	assert.equal(lines[1], '| --- | --- | --- |');
	assert.equal(lines[2], '| a b | **粗** | 管道\\|字符 |');
});

Deno.test('callouts become quoted blocks with their emoji', () => {
	const out = cleanupDocMarkdown(
		'<callout emoji="💡">\n第一行\n第二行\n</callout>',
	);
	assert.match(out, /^> 💡 第一行\n> 第二行$/m);
});

Deno.test('grids unwrap and paragraphs become blank-line breaks', () => {
	const out = cleanupDocMarkdown(
		'<grid><column width-ratio="0.5"><p>左</p></column>' +
			'<column width-ratio="0.5"><p>右</p></column></grid>',
	);
	assert.match(out, /左\n\n右/);
	assert.doesNotMatch(out, /<(?:grid|column|p)/);
});

Deno.test('mentions, links, tasks, and bold convert to markdown', () => {
	const out = cleanupDocMarkdown(
		'- [x] 事项 <cite type="user" user-id="ou_1" user-name="王崧禾"></cite>\n' +
			'<task status="success" task-id="t1"></task>\n' +
			'<a href="https://example.com">示例</a> 与 <b> 加粗 </b>',
	);
	assert.match(out, /- \[x\] 事项 @王崧禾/);
	assert.doesNotMatch(out, /<task/);
	assert.match(out, /\[示例\]\(https:\/\/example\.com\)/);
	assert.match(out, /\*\*加粗\*\*/);
});

Deno.test('media embeds become typed placeholders', () => {
	const out = cleanupDocMarkdown(
		'<figure view-type="Preview"><source mime="video/mp4" href="https://internal-api-drive-stream.feishu.cn/x" token="t"/></figure>\n' +
			'<img name="截图.png" alt="入群二维码说明"/>\n' +
			'<whiteboard token="wb1"></whiteboard>\n' +
			'<bitable table-id="tbl1" token="bas1"></bitable>\n' +
			'<readonly-block token="r1" type="task_list"></readonly-block>\n' +
			'<poll name="表决">选项A\n选项B</poll>\n' +
			'<synced-source>同步内容</synced-source>',
	);
	assert.match(out, /\[视频\]/);
	assert.match(out, /\[图片: 截图\.png\] 入群二维码说明/);
	assert.match(out, /\[画板\]/);
	assert.match(out, /\[多维表格\]\(https:\/\/feishu\.cn\/base\/bas1\)/);
	assert.match(out, /\[任务列表\]/);
	assert.match(out, /\[投票: 表决\]\n选项A\n选项B/);
	assert.match(out, /同步内容/);
	assert.doesNotMatch(out, /<(?:figure|source|img|whiteboard|bitable|poll)/);
});

Deno.test('time elements render as readable dates', () => {
	// 2026-12-22 18:10 in the local (Asia/Shanghai) zone.
	const ms = new Date('2026-12-22T18:10:00').getTime();
	const out = cleanupDocMarkdown(
		`<time creator-id="ou_1" expire-time="${ms}" is-whole-day="false" notify-time="${ms}"></time>` +
			`<time expire-time="${ms}" is-whole-day="true"></time>`,
	);
	assert.match(out, /2026-12-22 18:10/);
	assert.match(out, /2026-12-22(?! 18:10 18:10)/);
});

Deno.test('ephemeral signed image urls collapse to placeholders', () => {
	const out = cleanupDocMarkdown(
		'![](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=abc)\n' +
			'![说明文字](https://internal-api-drive-stream.feishu.cn/x/authcode/?code=d)\n' +
			'![keep](https://example.com/logo.png)',
	);
	assert.match(out, /^\[图片\]$/m);
	assert.match(out, /\[图片: 说明文字\]/);
	assert.match(out, /!\[keep\]\(https:\/\/example\.com\/logo\.png\)/);
});

Deno.test('br inside pipe rows becomes a space, elsewhere a newline', () => {
	const out = cleanupDocMarkdown(
		'| a<br/>b | c |\n| --- | --- |\n\n段落一<br/>段落二',
	);
	assert.match(out, /\| a b \| c \|/);
	assert.match(out, /段落一\n段落二/);
});

Deno.test('author-written pseudo-xml outside the whitelist is untouched', () => {
	const out = cleanupDocMarkdown(
		'请求格式:<request method> 与 <product name> 以及 <protocol>',
	);
	assert.match(out, /<request method>/);
	assert.match(out, /<product name>/);
	assert.match(out, /<protocol>/);
});
