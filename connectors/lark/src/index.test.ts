import assert from 'node:assert/strict';
import {
	buildChatDayDoc,
	buildCloudDoc,
	chatTitle,
	clampContent,
	dayStartISO,
	groupMessagesByDay,
	isUnchangedDoc,
	localDateString,
	renderChatDay,
	senderLabel,
} from './index.ts';

Deno.test('dayStartISO and localDateString round-trip a local day', () => {
	const day = '2026-07-10';
	const iso = dayStartISO(day);
	assert.equal(localDateString(new Date(iso)), day);
});

Deno.test('clampContent keeps small content and truncates huge content', () => {
	const small = clampContent('# hello');
	assert.equal(small.content, '# hello');
	assert.equal(small.bytes, 7);

	const huge = clampContent('宇'.repeat(4_000_000));
	assert.ok(huge.bytes <= 8_000_000);
	assert.ok(huge.content.endsWith('…(content truncated by connector)'));
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

	assert.equal(doc.id, 'lark:doc:doxcnAAAA');
	assert.equal(doc.doc_type, 'lark:docx');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(doc.doc_updated_at, '2026-07-10T00:00:00.000Z');
	assert.equal(doc.original_file_size, 24);
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
	assert.equal(senderLabel({}), 'unknown');
});

Deno.test('chatTitle falls back by chat mode', () => {
	assert.equal(chatTitle({ chat_id: 'oc_1', name: 'Team' }), 'Team');
	assert.equal(
		chatTitle({ chat_id: 'oc_2', chat_mode: 'p2p' }),
		'Direct message',
	);
	assert.equal(chatTitle({ chat_id: 'oc_3' }), 'Group chat');
});

Deno.test('renderChatDay writes a readable transcript', () => {
	const markdown = renderChatDay('Team', '2026-07-10', [
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
	]);

	assert.match(markdown, /^# Team — 2026-07-10/);
	assert.match(markdown, /\*\*\[09:15\] Xinyi:\*\* hello/);
	assert.match(markdown, /\*\*\[10:31\] bot\(cli_1\):\*\*\nline one\nline two/);
	assert.match(markdown, /\*\*\[11:00\] Xinyi:\*\* \(image\)/);
});

Deno.test('buildChatDayDoc emits stable ids and chat applink', () => {
	const doc = buildChatDayDoc(
		{ chat_id: 'oc_abc', name: 'Team', chat_mode: 'group' },
		'2026-07-10',
		[
			{
				content: 'hello',
				create_time: '2026-07-10 09:15',
				sender: { id: 'ou_1', name: 'Xinyi', sender_type: 'user' },
			},
		],
	);

	assert.equal(doc.id, 'lark:chat:oc_abc:2026-07-10');
	assert.equal(doc.title, 'Team · 2026-07-10');
	assert.equal(doc.doc_type, 'lark:chat');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(
		doc.doc_updated_at,
		new Date('2026-07-10T09:15:00').toISOString(),
	);
	assert.deepEqual(doc.metadata, {
		url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_abc',
		chat_id: 'oc_abc',
		chat_name: 'Team',
		date: '2026-07-10',
		message_count: 1,
	});
});
