import assert from 'node:assert/strict';
import {
	addDays,
	buildChatPeriodDoc,
	buildCloudDoc,
	chatTitle,
	clampContent,
	dayStartISO,
	groupDaysByPeriod,
	groupMessagesByDay,
	isUnchangedDoc,
	localDateString,
	periodKey,
	periodLabel,
	renderChatPeriod,
	senderLabel,
	weekStartDay,
} from './index.ts';

Deno.test('dayStartISO and localDateString round-trip a local day', () => {
	const day = '2026-07-10';
	const iso = dayStartISO(day);
	assert.equal(localDateString(new Date(iso)), day);
});

Deno.test('week periods key on Monday and label as a date range', () => {
	// 2026-07-10 is a Friday in the week of Monday 2026-07-06.
	assert.equal(weekStartDay('2026-07-10'), '2026-07-06');
	assert.equal(weekStartDay('2026-01-01'), '2025-12-29');
	assert.equal(addDays('2026-07-06', 6), '2026-07-12');
	assert.equal(periodKey('2026-07-10', 'week'), '2026-07-06');
	assert.equal(periodKey('2026-07-10', 'day'), '2026-07-10');
	assert.equal(
		periodLabel('2026-07-06', 'week'),
		'2026-07-06 ~ 2026-07-12',
	);
	assert.equal(periodLabel('2026-07-10', 'day'), '2026-07-10');
});

Deno.test('clampContent keeps small content and truncates huge content', () => {
	const small = clampContent('# hello');
	assert.equal(small.content, '# hello');
	assert.equal(small.bytes, 7);

	const huge = clampContent('宇'.repeat(4_000_000));
	assert.ok(huge.bytes <= 8_000_000);
	assert.ok(huge.content.endsWith('…(内容超长,已被连接器截断)'));
	// The cut must not split a UTF-16 surrogate pair or a multibyte rune.
	assert.equal(
		new TextEncoder().encode(huge.content).length,
		huge.bytes,
	);
});

Deno.test('isUnchangedDoc gates refetch on index membership and mark', () => {
	const indexed = new Set(['t1']);
	const mark = '2026-07-01T00:00:00.000Z';

	// Indexed and not edited since the mark: skip.
	assert.equal(
		isUnchangedDoc(
			{ token: 't1', editedAt: '2026-06-30T00:00:00.000Z' },
			indexed,
			mark,
		),
		true,
	);
	// Edited past the mark: refetch.
	assert.equal(
		isUnchangedDoc(
			{ token: 't1', editedAt: '2026-07-02T00:00:00.000Z' },
			indexed,
			mark,
		),
		false,
	);
	// Not in the index (failed fetch last poll, or restored): refetch even
	// though its edit time is behind the mark.
	assert.equal(
		isUnchangedDoc(
			{ token: 't2', editedAt: '2026-06-30T00:00:00.000Z' },
			indexed,
			mark,
		),
		false,
	);
	// No edit time or no mark: refetch.
	assert.equal(isUnchangedDoc({ token: 't1' }, indexed, mark), false);
	assert.equal(
		isUnchangedDoc(
			{ token: 't1', editedAt: '2026-06-30T00:00:00.000Z' },
			indexed,
			undefined,
		),
		false,
	);
});

Deno.test('buildCloudDoc emits a stable markdown doc with url metadata', () => {
	const doc = buildCloudDoc(
		{
			token: 'doxcnAAAA',
			type: 'docx',
			title: 'Release plan',
			editedAt: '2026-07-10T00:00:00.000Z',
			createdAt: '2026-07-01T00:00:00.000Z',
			url: 'https://feishu.cn/docx/doxcnAAAA',
			owner: 'Channing',
		},
		'# Release plan\n\nShip it.',
	);

	assert.equal(doc.id, 'feishu:doc:doxcnAAAA');
	assert.equal(doc.doc_type, 'feishu:docx');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(doc.doc_updated_at, '2026-07-10T00:00:00.000Z');
	assert.equal(
		doc.content,
		'> **原链接：** [打开原文](<https://feishu.cn/docx/doxcnAAAA>)\n\n---\n\n# Release plan\n\nShip it.',
	);
	assert.equal(
		doc.original_file_size,
		new TextEncoder().encode(doc.content).length,
	);
	assert.deepEqual(doc.metadata, {
		url: 'https://feishu.cn/docx/doxcnAAAA',
		token: 'doxcnAAAA',
		source_type: 'docx',
		created_at: '2026-07-01T00:00:00.000Z',
		owner: 'Channing',
	});
});

Deno.test('groupMessagesByDay buckets by local date and drops deleted', () => {
	const grouped = groupMessagesByDay([
		{ content: 'a', create_time: '2026-07-09 08:00' },
		{ content: 'b', create_time: '2026-07-09 09:00' },
		{ content: 'c', create_time: '2026-07-10 10:00' },
		{ content: 'gone', create_time: '2026-07-10 10:05', deleted: true },
		{ content: 'no time' },
	]);

	assert.deepEqual([...grouped.keys()], ['2026-07-09', '2026-07-10']);
	assert.equal(grouped.get('2026-07-09')?.length, 2);
	assert.equal(grouped.get('2026-07-10')?.length, 1);
});

Deno.test('groupDaysByPeriod merges days into ISO weeks', () => {
	const byDay = groupMessagesByDay([
		{ content: 'a', create_time: '2026-07-05 08:00' }, // Sunday, W27
		{ content: 'b', create_time: '2026-07-06 09:00' }, // Monday, W28
		{ content: 'c', create_time: '2026-07-10 10:00' }, // Friday, W28
	]);

	const daily = groupDaysByPeriod(byDay, 'day');
	assert.deepEqual([...daily.keys()], [
		'2026-07-05',
		'2026-07-06',
		'2026-07-10',
	]);

	const weekly = groupDaysByPeriod(byDay, 'week');
	assert.deepEqual([...weekly.keys()].sort(), ['2026-06-29', '2026-07-06']);
	assert.deepEqual([...weekly.get('2026-07-06')!.keys()].sort(), [
		'2026-07-06',
		'2026-07-10',
	]);

	const whole = groupDaysByPeriod(byDay, 'chat');
	assert.deepEqual([...whole.keys()], ['all']);
	assert.equal(whole.get('all')!.size, 3);
});

Deno.test('senderLabel prefers names and marks bots', () => {
	assert.equal(
		senderLabel({ sender: { id: 'ou_1', name: 'Xinyi', sender_type: 'user' } }),
		'Xinyi',
	);
	assert.equal(
		senderLabel({ sender: { id: 'cli_1', sender_type: 'app' } }),
		'bot(cli_1)',
	);
	assert.equal(senderLabel({ sender: { id: 'ou_2' } }), 'ou_2');
	assert.equal(senderLabel({}), '未知');
});

Deno.test('chatTitle falls back by chat mode', () => {
	assert.equal(chatTitle({ chat_id: 'oc_1', name: 'Team' }), 'Team');
	assert.equal(chatTitle({ chat_id: 'oc_2', chat_mode: 'p2p' }), '私聊');
	assert.equal(chatTitle({ chat_id: 'oc_3' }), '群聊');
});

Deno.test('renderChatPeriod writes a readable day transcript', () => {
	const markdown = renderChatPeriod(
		'Team',
		'2026-07-10',
		new Map([[
			'2026-07-10',
			[
				{
					content: 'hello',
					create_time: '2026-07-10 09:15',
					sender: { id: 'ou_1', name: 'Xinyi', sender_type: 'user' },
				},
				{
					content: 'line one\nline two',
					create_time: '2026-07-10 10:31',
					sender: { id: 'cli_1', sender_type: 'app' },
				},
				{
					msg_type: 'image',
					create_time: '2026-07-10 11:00',
					sender: { id: 'ou_1', name: 'Xinyi', sender_type: 'user' },
				},
			],
		]]),
		'day',
	);

	assert.match(markdown, /^# Team — 2026-07-10/);
	assert.doesNotMatch(markdown, /^## /m);
	assert.match(markdown, /\*\*\[09:15\] Xinyi:\*\* hello/);
	assert.match(markdown, /\*\*\[10:31\] bot\(cli_1\):\*\*\nline one\nline two/);
	assert.match(markdown, /\*\*\[11:00\] Xinyi:\*\* \(image\)/);
});

Deno.test('renderChatPeriod writes day sections inside a week doc', () => {
	const markdown = renderChatPeriod(
		'Team',
		'2026-07-06 ~ 2026-07-12',
		new Map([
			['2026-07-10', [{ content: 'later', create_time: '2026-07-10 09:15' }]],
			['2026-07-06', [{ content: 'earlier', create_time: '2026-07-06 08:00' }]],
		]),
		'week',
	);

	assert.match(markdown, /^# Team — 2026-07-06 ~ 2026-07-12/);
	const monday = markdown.indexOf('## 2026-07-06');
	const friday = markdown.indexOf('## 2026-07-10');
	assert.ok(monday >= 0 && friday > monday, 'days are sorted sections');
});

Deno.test('buildChatPeriodDoc emits stable ids for both groupings', () => {
	const days = new Map([[
		'2026-07-10',
		[
			{
				content: 'hello',
				create_time: '2026-07-10 09:15',
				sender: { id: 'ou_1', name: 'Xinyi', sender_type: 'user' },
			},
		],
	]]);

	const dayDoc = buildChatPeriodDoc(
		{ chat_id: 'oc_abc', name: 'Team', chat_mode: 'group' },
		'day',
		'2026-07-10',
		days,
	);
	assert.equal(dayDoc.id, 'feishu:chat:oc_abc:2026-07-10');
	assert.equal(dayDoc.title, 'Team · 2026-07-10');
	assert.equal(dayDoc.doc_type, 'feishu:chat');
	assert.equal(dayDoc.content_format, 'markdown');
	assert.equal(
		dayDoc.doc_updated_at,
		new Date('2026-07-10T09:15:00').toISOString(),
	);
	assert.deepEqual(dayDoc.metadata, {
		url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_abc',
		chat_id: 'oc_abc',
		chat_name: 'Team',
		date: '2026-07-10',
		grouping: 'day',
		message_count: 1,
	});

	const weekDoc = buildChatPeriodDoc(
		{ chat_id: 'oc_abc', name: 'Team', chat_mode: 'group' },
		'week',
		'2026-07-06',
		days,
	);
	assert.equal(weekDoc.id, 'feishu:chat:oc_abc:2026-07-06');
	assert.equal(weekDoc.title, 'Team · 2026-07-06 ~ 2026-07-12');
	const weekMetadata = weekDoc.metadata as Record<string, unknown>;
	assert.equal(weekMetadata.date, '2026-07-06 ~ 2026-07-12');
	assert.equal(weekMetadata.grouping, 'week');
});

Deno.test('whole-chat docs use the bare chat id and a date-range label', () => {
	const days = new Map([
		['2026-07-06', [{ content: 'earlier', create_time: '2026-07-06 08:00' }]],
		['2026-07-10', [{ content: 'later', create_time: '2026-07-10 09:15' }]],
	]);

	const doc = buildChatPeriodDoc(
		{ chat_id: 'oc_abc', name: 'Team', chat_mode: 'group' },
		'chat',
		'all',
		days,
	);
	assert.equal(doc.id, 'feishu:chat:oc_abc');
	assert.equal(doc.title, 'Team');
	assert.match(String(doc.content), /^# Team — 2026-07-06 ~ 2026-07-10/);
	assert.match(String(doc.content), /## 2026-07-06/);
	assert.match(String(doc.content), /## 2026-07-10/);
	const metadata = doc.metadata as Record<string, unknown>;
	assert.equal(metadata.date, '2026-07-06 ~ 2026-07-10');
	assert.equal(metadata.grouping, 'chat');
	assert.equal(metadata.message_count, 2);
	assert.equal(
		doc.doc_updated_at,
		new Date('2026-07-10T09:15:00').toISOString(),
	);
});

Deno.test('cloud markdown includes human source context without location metadata or resource IDs', () => {
	const doc = buildCloudDoc(
		{ token: 'private-id', type: 'docx', title: 'Doc' },
		'# Body',
		{
			location: {
				space_name: '工程知识库',
				parent_name: 'API',
				path: 'Gety / API',
			},
			feishu: { node_token: 'private-node' },
		},
	);
	assert.equal(
		doc.content,
		'> **知识库：** 工程知识库\n>\n> **父节点：** API\n>\n> **目录路径：** Gety / API\n\n---\n\n# Body',
	);
	assert.deepEqual(doc.metadata, { token: 'private-id', source_type: 'docx' });
});

Deno.test('cloud markdown omits missing source fields and leaves an empty source block out', () => {
	const entity = { token: 'doc', type: 'docx', title: 'Doc' };
	assert.equal(buildCloudDoc(entity, '# Body').content, '# Body');
	assert.equal(
		buildCloudDoc(entity, '# Body', {
			location: { space_name: ' ', parent_name: 'Parent' },
		}).content,
		'> **父节点：** Parent\n\n---\n\n# Body',
	);
});

Deno.test('cloud markdown escapes source names and marks incomplete paths', () => {
	const doc = buildCloudDoc(
		{ token: 'doc', type: 'docx', title: 'Doc', url: 'invalid' },
		'# Body',
		{
			location: {
				parent_name: '[API]\n# title',
				path: 'Gety / API',
				path_complete: false,
			},
		},
	);
	assert.equal(
		doc.content,
		'> **父节点：** \\[API\\] \\# title\n>\n> **目录路径：** … / Gety / API\n\n---\n\n# Body',
	);
});
