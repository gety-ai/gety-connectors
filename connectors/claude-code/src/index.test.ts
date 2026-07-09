import assert from 'node:assert/strict';
import {
	buildDocFromRecords,
	defaultProjectsDir,
	extractText,
	pollClaudeCode,
	readableModel,
} from './index.ts';
import type { ManifestConfig } from './gen/manifest.d.ts';

function jsonl(records: unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join('\n');
}

Deno.test('ManifestConfig exposes only include_subagents', () => {
	// Compile-time: include_subagents is the only user-visible setting in the
	// manifest; the projects directory is auto-detected by the connector.
	const config: ManifestConfig = { include_subagents: false };
	assert.equal(config.include_subagents, false);
});

Deno.test('extractText returns string content directly', () => {
	assert.equal(extractText('hello'), 'hello');
	assert.equal(extractText(null), null);
	assert.equal(extractText(undefined), null);
	assert.equal(extractText(42), null);
});

Deno.test('extractText keeps only text parts and skips tool_use/tool_result/thinking', () => {
	const content = [
		{ type: 'thinking', thinking: 'internal reasoning' },
		{ type: 'text', text: 'visible answer' },
		{ type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
		{ type: 'text', text: 'more visible' },
		{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
	];
	assert.equal(extractText(content), 'visible answer\n\nmore visible');
});

Deno.test('extractText returns null when no text parts are present', () => {
	const content = [
		{ type: 'tool_use', id: 't1', name: 'Bash', input: {} },
		{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
	];
	assert.equal(extractText(content), null);
});

Deno.test('readableModel maps common identifiers to readable names', () => {
	assert.equal(readableModel('claude-opus-4-8'), 'Claude Opus 4.8');
	assert.equal(readableModel('claude-sonnet-4-5'), 'Claude Sonnet 4.5');
	assert.equal(readableModel('claude-3-5-sonnet'), 'Claude 3.5 Sonnet');
	assert.equal(readableModel('claude-3-7-sonnet'), 'Claude 3.7 Sonnet');
	assert.equal(readableModel('claude-fable-5'), 'Claude Fable 5');
	assert.equal(
		readableModel('claude-opus-4-8-20250101'),
		'Claude Opus 4.8',
	);
	assert.equal(readableModel('unknown-model'), 'Unknown Model');
});

Deno.test('buildDocFromRecords builds a markdown doc with only user/assistant text', async () => {
	const records = [
		{ type: 'ai-title', aiTitle: 'Plan a trip', sessionId: 's1' },
		{
			type: 'user',
			sessionId: 's1',
			cwd: '/data/projects/myproject',
			gitBranch: 'main',
			timestamp: '2026-01-02T03:04:05.000Z',
			message: { role: 'user', content: 'Where should I go?' },
		},
		{
			type: 'assistant',
			sessionId: 's1',
			cwd: '/data/projects/myproject',
			gitBranch: 'main',
			version: '1.2.3',
			timestamp: '2026-01-02T03:05:00.000Z',
			message: {
				role: 'assistant',
				model: 'claude-opus-4-8',
				content: [
					{ type: 'thinking', thinking: 'reasoning' },
					{ type: 'text', text: 'Try Lisbon.' },
					{ type: 'tool_use', id: 't1', name: 'Bash', input: {} },
				],
			},
		},
		{
			type: 'user',
			sessionId: 's1',
			timestamp: '2026-01-02T03:06:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
				],
			},
		},
	];

	const doc = await buildDocFromRecords(records, {
		relPath: 'project/session.jsonl',
		fileName: 'session.jsonl',
		fileSize: 1234,
		fileMtime: Date.parse('2026-01-02T00:00:00Z'),
		sourcePath: '/data/projects/myproject/session.jsonl',
	});

	assert.ok(doc, 'expected a doc');
	assert.equal(doc.doc_type, 'claude_code:session');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(doc.title, 'Plan a trip');
	assert.equal(doc.id.startsWith('claude-code:'), true);
	assert.equal(doc.doc_updated_at, '2026-01-02T03:06:00.000Z');
	assert.equal(doc.original_file_size, 1234);

	const content = doc.content ?? '';
	assert.match(content, /^# Plan a trip/);
	assert.match(content, /## Session/);
	assert.match(content, /- Project: `\/data\/projects\/myproject`/);
	assert.match(content, /- Model: `Claude Opus 4.8`/);
	assert.match(content, /- Git branch: `main`/);
	assert.match(content, /## User/);
	assert.match(content, /Where should I go\?/);
	assert.match(content, /## Claude Code/);
	assert.match(content, /Try Lisbon\./);
	// tool_use / tool_result / thinking must NOT appear in the markdown.
	assert.doesNotMatch(content, /tool_use/);
	assert.doesNotMatch(content, /tool_result/);
	assert.doesNotMatch(content, /reasoning/);
	assert.doesNotMatch(content, /output/);
	// The tool_result-only user message must be omitted entirely.
	assert.doesNotMatch(content, /## User\n\noutput/);

	const metadata = doc.metadata as Record<string, unknown>;
	assert.equal(metadata.project, '/data/projects/myproject');
	assert.equal(metadata.session_id, 's1');
	assert.equal(metadata.path, 'project/session.jsonl');
	assert.equal(metadata.source_path, 'project/session.jsonl');
	assert.equal(metadata.model, 'claude-opus-4-8');
	assert.equal(metadata.git_branch, 'main');
	assert.equal(metadata.message_count, 3);
	assert.equal(metadata.user_message_count, 2);
	assert.equal(metadata.assistant_message_count, 1);
	assert.equal(metadata.created_at, '2026-01-02T03:04:05.000Z');
	assert.equal(metadata.file_size, 1234);
	assert.equal(metadata.url, 'file:///data/projects/myproject/session.jsonl');
});

Deno.test('buildDocFromRecords title falls back to first user text when no ai-title', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's2',
			timestamp: '2026-02-01T00:00:00Z',
			message: { role: 'user', content: 'How do I bake bread?' },
		},
		{
			type: 'assistant',
			sessionId: 's2',
			timestamp: '2026-02-01T00:01:00Z',
			message: { role: 'assistant', content: 'Mix flour and water.' },
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s2.jsonl',
		fileName: 's2.jsonl',
		fileSize: 10,
		fileMtime: 0,
	});
	assert.ok(doc);
	assert.equal(doc.title, 'How do I bake bread?');
});

Deno.test('buildDocFromRecords skips injected command context messages', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's3',
			timestamp: '2026-03-01T00:00:00Z',
			message: {
				role: 'user',
				content:
					'<command-name>/model</command-name>\n<local-command-stdout>Set model</local-command-stdout>',
			},
		},
		{
			type: 'user',
			sessionId: 's3',
			timestamp: '2026-03-01T00:00:01Z',
			message: {
				role: 'user',
				content: 'Base directory for this skill: /tmp/skill',
			},
		},
		{
			type: 'user',
			sessionId: 's3',
			timestamp: '2026-03-01T00:00:02Z',
			message: {
				role: 'user',
				content:
					'<task-notification>Agent finished with internal output</task-notification>',
			},
		},
		{
			type: 'user',
			sessionId: 's3',
			timestamp: '2026-03-01T00:00:03Z',
			message: { role: 'user', content: 'Real question' },
		},
		{
			type: 'assistant',
			sessionId: 's3',
			timestamp: '2026-03-01T00:00:04Z',
			message: { role: 'assistant', content: 'Real answer' },
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s3.jsonl',
		fileName: 's3.jsonl',
		fileSize: 10,
		fileMtime: 0,
	});
	assert.ok(doc);
	assert.equal(doc.title, 'Real question');
	assert.doesNotMatch(doc.content ?? '', /command-name/);
	assert.doesNotMatch(doc.content ?? '', /Base directory for this skill/);
	assert.doesNotMatch(doc.content ?? '', /task-notification/);
	assert.match(doc.content ?? '', /Real question/);
});

Deno.test('buildDocFromRecords preserves slash-command arguments as user input', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's-command-args',
			timestamp: '2026-03-02T00:00:00Z',
			message: {
				role: 'user',
				content: '<command-message>code-review-expert</command-message>\n' +
					'<command-name>/code-review-expert</command-name>\n' +
					'<command-args>帮我看当前分支和 develop 的区别。review 代码。\n\n1. 生成的 ts 类型有没有改进的空间？\n2. 会不会影响 fix/dev-494/docx-ocr 分支</command-args>',
			},
		},
		{
			type: 'assistant',
			sessionId: 's-command-args',
			timestamp: '2026-03-02T00:01:00Z',
			message: {
				role: 'assistant',
				content: '我会 review 当前分支。',
			},
		},
	];

	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s-command-args.jsonl',
		fileName: 's-command-args.jsonl',
		fileSize: 10,
		fileMtime: 0,
	});

	assert.ok(doc);
	assert.equal(doc.title, '帮我看当前分支和 develop 的区别。review 代码。');
	assert.match(doc.content ?? '', /Command: `\/code-review-expert`/);
	assert.match(
		doc.content ?? '',
		/## User\n\nCommand: `\/code-review-expert`\n\n帮我看当前分支和 develop 的区别。review 代码。/,
	);
	assert.match(doc.content ?? '', /会不会影响 fix\/dev-494\/docx-ocr 分支/);
	assert.match(doc.content ?? '', /## Claude Code\n\n我会 review 当前分支。/);
	assert.doesNotMatch(doc.content ?? '', /command-name/);
	assert.doesNotMatch(doc.content ?? '', /command-args/);
});

Deno.test('buildDocFromRecords skips sessions without user text', async () => {
	const records = [
		{
			type: 'assistant',
			timestamp: '2026-04-01T00:00:00Z',
			message: { role: 'assistant', content: 'A response with no user.' },
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/orphan.jsonl',
		fileName: 'orphan.jsonl',
		fileSize: 10,
		fileMtime: 0,
	});
	assert.equal(doc, null);
});

Deno.test('buildDocFromRecords skips sessions with no Claude Code response', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's4',
			cwd: '/tmp/proj4',
			gitBranch: 'dev',
			timestamp: '2026-05-01T00:00:00Z',
			message: {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
				],
			},
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s4.jsonl',
		fileName: 's4.jsonl',
		fileSize: 10,
		fileMtime: Date.parse('2026-05-01T00:00:00Z'),
	});
	assert.equal(doc, null);
});

Deno.test('buildDocFromRecords skips empty sessions', async () => {
	const records = [
		{ type: 'mode', mode: 'normal' },
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/empty.jsonl',
		fileName: 'empty.jsonl',
		fileSize: 5,
		fileMtime: 0,
	});
	assert.equal(doc, null);
});

Deno.test('buildDocFromRecords tracks parse errors in metadata only, never in the body', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's5',
			timestamp: '2026-06-01T00:00:00Z',
			message: { role: 'user', content: 'Hi' },
		},
		{
			type: 'assistant',
			sessionId: 's5',
			timestamp: '2026-06-01T00:01:00Z',
			message: { role: 'assistant', content: 'Hello' },
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s5.jsonl',
		fileName: 's5.jsonl',
		fileSize: 10,
		fileMtime: 0,
		parseErrors: 2,
	});
	assert.ok(doc);
	const metadata = doc.metadata as Record<string, unknown>;
	assert.equal(metadata.parse_errors, 2);
	// Parse-error notes must not appear anywhere in the markdown body.
	const content = doc.content ?? '';
	assert.doesNotMatch(content, /unparseable/);
	assert.doesNotMatch(content, /parse/i);
	// The body is header + message blocks only.
	assert.match(content, /## User\n\nHi/);
});

Deno.test('buildDocFromRecords renders Codex-style session and round sections', async () => {
	const records = [
		{
			type: 'user',
			sessionId: 's6',
			cwd: '/tmp/proj6',
			gitBranch: 'feature',
			timestamp: '2026-07-01T00:00:00Z',
			message: { role: 'user', content: 'First question' },
		},
		{
			type: 'assistant',
			sessionId: 's6',
			timestamp: '2026-07-01T00:01:00Z',
			message: {
				role: 'assistant',
				model: 'claude-opus-4-8',
				content: 'An answer',
			},
		},
	];
	const doc = await buildDocFromRecords(records, {
		relPath: 'p/s6.jsonl',
		fileName: 's6.jsonl',
		fileSize: 10,
		fileMtime: 0,
	});
	assert.ok(doc);
	const content = doc.content ?? '';
	assert.match(content, /^# First question/);
	assert.match(content, /## Session/);
	assert.match(content, /- Project: `\/tmp\/proj6`/);
	assert.match(content, /- Model: `Claude Opus 4.8`/);
	assert.match(content, /- Git branch: `feature`/);
	assert.match(
		content,
		/---\n\n## User\n\nFirst question\n\n## Claude Code\n\nAn answer/,
	);
});

Deno.test('pollClaudeCode indexes, skips unchanged, updates on change, deletes on removal', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const filePath = `${projectDir}/session.jsonl`;
	const baseRecords = [
		{ type: 'ai-title', aiTitle: 'Test session', sessionId: 's1' },
		{
			type: 'user',
			sessionId: 's1',
			cwd: '/tmp/proj',
			gitBranch: 'main',
			timestamp: '2026-01-01T00:00:00Z',
			message: { role: 'user', content: 'Hello' },
		},
		{
			type: 'assistant',
			sessionId: 's1',
			timestamp: '2026-01-01T00:01:00Z',
			message: {
				role: 'assistant',
				model: 'claude-opus-4-8',
				content: [
					{ type: 'text', text: 'Hi there' },
					{ type: 'tool_use', id: 't1', name: 'Bash', input: {} },
				],
			},
		},
		{
			type: 'user',
			sessionId: 's1',
			timestamp: '2026-01-01T00:02:00Z',
			message: {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 't1', content: 'output' },
				],
			},
		},
	];
	await Deno.writeTextFile(filePath, jsonl(baseRecords));

	const config = {
		projects_dir: tmp,
		include_subagents: false,
	};
	const signal = new AbortController().signal;

	// First poll: one new file -> one upsert.
	const first = [];
	let stateAfterFirst: unknown = null;
	for await (const result of pollClaudeCode(config, null, signal)) {
		first.push(result);
		if (result.state !== undefined) stateAfterFirst = result.state;
	}
	assert.equal(first.length, 1);
	assert.equal(first[0].updates.length, 1);
	const firstUpdate = first[0].updates[0];
	assert.equal(firstUpdate.kind, 'upsert');
	if (firstUpdate.kind !== 'upsert') throw new Error('expected upsert');
	const docId = firstUpdate.doc.id;
	assert.equal(firstUpdate.doc.title, 'Test session');
	assert.match(firstUpdate.doc.content ?? '', /## User\n\nHello/);
	assert.match(firstUpdate.doc.content ?? '', /## Claude Code\n\nHi there/);
	assert.doesNotMatch(firstUpdate.doc.content ?? '', /tool_use/);
	assert.doesNotMatch(firstUpdate.doc.content ?? '', /tool_result/);

	// Second poll: unchanged -> no batches.
	const second = [];
	for await (const result of pollClaudeCode(config, stateAfterFirst, signal)) {
		second.push(result);
	}
	assert.equal(second.length, 0);

	// Modify the file (size changes -> fingerprint changes) -> one upsert, same id.
	await Deno.writeTextFile(
		filePath,
		jsonl(baseRecords) +
			'\n' +
			JSON.stringify({
				type: 'user',
				sessionId: 's1',
				timestamp: '2026-01-01T00:03:00Z',
				message: { role: 'user', content: 'One more thing' },
			}),
	);
	const third = [];
	let stateAfterThird: unknown = stateAfterFirst;
	for await (const result of pollClaudeCode(config, stateAfterFirst, signal)) {
		third.push(result);
		if (result.state !== undefined) stateAfterThird = result.state;
	}
	assert.equal(third.length, 1);
	assert.equal(third[0].updates.length, 1);
	const thirdUpdate = third[0].updates[0];
	assert.equal(thirdUpdate.kind, 'upsert');
	if (thirdUpdate.kind !== 'upsert') throw new Error('expected upsert');
	assert.equal(thirdUpdate.doc.id, docId);
	assert.match(thirdUpdate.doc.content ?? '', /One more thing/);

	// Delete the file -> one deletion batch with the same id.
	await Deno.remove(filePath);
	const fourth = [];
	for await (const result of pollClaudeCode(config, stateAfterThird, signal)) {
		fourth.push(result);
	}
	assert.equal(fourth.length, 1);
	assert.equal(fourth[0].updates.length, 1);
	const fourthUpdate = fourth[0].updates[0];
	assert.equal(fourthUpdate.kind, 'delete');
	if (fourthUpdate.kind !== 'delete') throw new Error('expected delete');
	assert.equal(fourthUpdate.id, docId);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode indexes nested jsonl files as separate docs', async () => {
	const tmp = await Deno.makeTempDir();
	const nestedDir = `${tmp}/project/sub`;
	await Deno.mkdir(nestedDir, { recursive: true });
	const topFile = `${tmp}/project/top.jsonl`;
	const nestedFile = `${nestedDir}/agent.jsonl`;
	await Deno.writeTextFile(
		topFile,
		jsonl([
			{
				type: 'user',
				sessionId: 'top',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'top message' },
			},
			{
				type: 'assistant',
				sessionId: 'top',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'top response' },
			},
		]),
	);
	await Deno.writeTextFile(
		nestedFile,
		jsonl([
			{
				type: 'user',
				sessionId: 'nested',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'nested message' },
			},
			{
				type: 'assistant',
				sessionId: 'nested',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'nested response' },
			},
		]),
	);

	const config = {
		projects_dir: tmp,
		include_subagents: false,
	};
	const signal = new AbortController().signal;
	const updates = [];
	for await (const result of pollClaudeCode(config, null, signal)) {
		updates.push(...result.updates);
	}
	assert.equal(updates.length, 2);
	assert.equal(
		updates.filter((u) => u.kind === 'upsert').length,
		2,
	);
	const titles = updates
		.map((u) => u.kind === 'upsert' ? u.doc.title : null)
		.sort();
	assert.deepEqual(titles, ['nested message', 'top message']);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode excludes subagent jsonl files but keeps main sessions', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	const directSubagentDir = `${projectDir}/session-id/subagents`;
	const workflowDir = `${directSubagentDir}/workflows/wf_123`;
	const regularDir = `${projectDir}/tools`;
	await Deno.mkdir(directSubagentDir, { recursive: true });
	await Deno.mkdir(workflowDir, { recursive: true });
	await Deno.mkdir(regularDir, { recursive: true });

	await Deno.writeTextFile(
		`${projectDir}/session-id.jsonl`,
		jsonl([
			{
				type: 'user',
				sessionId: 'main',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'main session' },
			},
			{
				type: 'assistant',
				sessionId: 'main',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'main response' },
			},
		]),
	);
	await Deno.writeTextFile(
		`${directSubagentDir}/agent-abc.jsonl`,
		jsonl([
			{
				type: 'user',
				isSidechain: true,
				agentId: 'agent-abc',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'subagent direct' },
			},
			{
				type: 'assistant',
				isSidechain: true,
				agentId: 'agent-abc',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'subagent response' },
			},
		]),
	);
	await Deno.writeTextFile(
		`${workflowDir}/journal.jsonl`,
		jsonl([
			{ type: 'started', agentId: 'agent-workflow' },
			{ type: 'result', agentId: 'agent-workflow', result: {} },
		]),
	);
	await Deno.writeTextFile(
		`${workflowDir}/agent-def.jsonl`,
		jsonl([
			{
				type: 'user',
				isSidechain: true,
				agentId: 'agent-def',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'subagent workflow' },
			},
			{
				type: 'assistant',
				isSidechain: true,
				agentId: 'agent-def',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'workflow response' },
			},
		]),
	);
	await Deno.writeTextFile(
		`${regularDir}/subagents_are_great.jsonl`,
		jsonl([
			{
				type: 'user',
				sessionId: 'not-subagent',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'regular filename' },
			},
			{
				type: 'assistant',
				sessionId: 'not-subagent',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'regular response' },
			},
		]),
	);

	const updates = [];
	for await (
		const result of pollClaudeCode(
			{ projects_dir: tmp, include_subagents: false },
			null,
			new AbortController().signal,
		)
	) {
		updates.push(...result.updates);
	}

	const titles = updates
		.map((u) => u.kind === 'upsert' ? u.doc.title : null)
		.sort();
	assert.deepEqual(titles, ['main session', 'regular filename']);

	const withSubagents = [];
	for await (
		const result of pollClaudeCode(
			{ projects_dir: tmp, include_subagents: true },
			null,
			new AbortController().signal,
		)
	) {
		withSubagents.push(...result.updates);
	}
	const titlesWithSubagents = withSubagents
		.map((u) => u.kind === 'upsert' ? u.doc.title : null)
		.sort();
	assert.deepEqual(titlesWithSubagents, [
		'main session',
		'regular filename',
		'subagent direct',
		'subagent workflow',
	]);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode deletes previously indexed subagents when include_subagents is disabled', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	const subagentDir = `${projectDir}/session/subagents`;
	await Deno.mkdir(subagentDir, { recursive: true });
	await Deno.writeTextFile(
		`${projectDir}/session.jsonl`,
		jsonl([
			{
				type: 'user',
				sessionId: 'main',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'main' },
			},
			{
				type: 'assistant',
				sessionId: 'main',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'main response' },
			},
		]),
	);
	await Deno.writeTextFile(
		`${subagentDir}/agent-abc.jsonl`,
		jsonl([
			{
				type: 'user',
				isSidechain: true,
				agentId: 'agent-abc',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'subagent' },
			},
			{
				type: 'assistant',
				isSidechain: true,
				agentId: 'agent-abc',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'subagent response' },
			},
		]),
	);

	let state: unknown = null;
	const indexed = [];
	for await (
		const result of pollClaudeCode(
			{ projects_dir: tmp, include_subagents: true },
			null,
			new AbortController().signal,
		)
	) {
		indexed.push(...result.updates);
		if (result.state !== undefined) state = result.state;
	}
	assert.equal(indexed.length, 2);

	const deleted: string[] = [];
	for await (
		const result of pollClaudeCode(
			{ projects_dir: tmp, include_subagents: false },
			state,
			new AbortController().signal,
		)
	) {
		for (const update of result.updates) {
			if (update.kind === 'delete') deleted.push(update.id);
		}
	}

	assert.equal(deleted.length, 1);
	await Deno.remove(tmp, { recursive: true });
});

Deno.test('defaultProjectsDir prefers USERPROFILE on Windows and HOME elsewhere', () => {
	const env = {
		get(name: string): string | undefined {
			if (name === 'HOME') return '/home/user';
			if (name === 'USERPROFILE') return 'C:\\Users\\user';
			return undefined;
		},
	};
	assert.equal(
		defaultProjectsDir(env, 'windows'),
		'C:\\Users\\user\\.claude\\projects',
	);
	assert.equal(
		defaultProjectsDir(env, 'linux'),
		'/home/user/.claude/projects',
	);
	assert.equal(
		defaultProjectsDir(env, 'darwin'),
		'/home/user/.claude/projects',
	);
});

Deno.test('defaultProjectsDir falls back to the other variable when preferred is unset', () => {
	const onlyUserProfile = {
		get(name: string): string | undefined {
			return name === 'USERPROFILE' ? 'C:\\Users\\only' : undefined;
		},
	};
	// On linux HOME is preferred but missing, so it falls back to USERPROFILE.
	assert.equal(
		defaultProjectsDir(onlyUserProfile, 'linux'),
		'C:\\Users\\only/.claude/projects',
	);

	const onlyHome = {
		get(name: string): string | undefined {
			return name === 'HOME' ? '/home/only' : undefined;
		},
	};
	// On windows USERPROFILE is preferred but missing, so it falls back to HOME.
	assert.equal(
		defaultProjectsDir(onlyHome, 'windows'),
		'\\home\\only\\.claude\\projects',
	);
});

Deno.test('pollClaudeCode re-indexes same-size/same-mtime rewrites via content hash', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const filePath = `${projectDir}/session.jsonl`;

	const recordsA = [
		{
			type: 'user',
			sessionId: 'h1',
			timestamp: '2026-01-01T00:00:00Z',
			message: { role: 'user', content: 'AAAAA' },
		},
		{
			type: 'assistant',
			sessionId: 'h1',
			timestamp: '2026-01-01T00:00:01Z',
			message: { role: 'assistant', content: 'reply' },
		},
	];
	// Same byte length as recordsA content but different text.
	const recordsB = [
		{
			type: 'user',
			sessionId: 'h1',
			timestamp: '2026-01-01T00:00:00Z',
			message: { role: 'user', content: 'BBBBB' },
		},
		{
			type: 'assistant',
			sessionId: 'h1',
			timestamp: '2026-01-01T00:00:01Z',
			message: { role: 'assistant', content: 'reply' },
		},
	];
	await Deno.writeTextFile(filePath, jsonl(recordsA));

	const config = {
		projects_dir: tmp,
		include_subagents: false,
	};
	const signal = new AbortController().signal;

	let state: unknown = null;
	for await (const result of pollClaudeCode(config, null, signal)) {
		if (result.state !== undefined) state = result.state;
	}

	// Rewrite with equal size, and force identical mtime to prove the hash (not
	// mtime/size) triggers the re-index.
	const textA = jsonl(recordsA);
	const textB = jsonl(recordsB);
	assert.equal(textA.length, textB.length, 'test setup: sizes must match');
	const originalStat = await Deno.stat(filePath);
	await Deno.writeTextFile(filePath, textB);
	await Deno.utime(
		filePath,
		originalStat.atime ?? new Date(),
		originalStat.mtime ?? new Date(),
	);

	const updates = [];
	for await (const result of pollClaudeCode(config, state, signal)) {
		updates.push(...result.updates);
	}
	assert.equal(updates.length, 1, 'content change must be detected via hash');
	const update = updates[0];
	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') throw new Error('expected upsert');
	assert.match(update.doc.content ?? '', /BBBBB/);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode treats old state missing hash as changed', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const filePath = `${projectDir}/session.jsonl`;
	await Deno.writeTextFile(
		filePath,
		jsonl([
			{
				type: 'user',
				sessionId: 'legacy',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'legacy content' },
			},
			{
				type: 'assistant',
				sessionId: 'legacy',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'legacy response' },
			},
		]),
	);
	const stat = await Deno.stat(filePath);
	const config = {
		projects_dir: tmp,
		include_subagents: false,
	};
	const signal = new AbortController().signal;

	// Legacy state shape lacked `hash`; poll must re-index it.
	const legacyState = {
		'project/session.jsonl': {
			mtime: stat.mtime?.getTime() ?? 0,
			size: stat.size ?? 0,
			docId: 'claude-code:legacy',
		},
	};

	const updates = [];
	for await (const result of pollClaudeCode(config, legacyState, signal)) {
		updates.push(...result.updates);
	}
	assert.equal(updates.length, 1);
	assert.equal(updates[0].kind, 'upsert');

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode deletes missing files after a complete scan', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const keep = `${projectDir}/keep.jsonl`;
	const gone = `${projectDir}/gone.jsonl`;
	await Deno.writeTextFile(
		keep,
		jsonl([
			{
				type: 'user',
				sessionId: 'k',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'keep me' },
			},
			{
				type: 'assistant',
				sessionId: 'k',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'keep response' },
			},
		]),
	);
	await Deno.writeTextFile(
		gone,
		jsonl([
			{
				type: 'user',
				sessionId: 'g',
				timestamp: '2026-01-01T00:00:00Z',
				message: { role: 'user', content: 'remove me' },
			},
			{
				type: 'assistant',
				sessionId: 'g',
				timestamp: '2026-01-01T00:00:01Z',
				message: { role: 'assistant', content: 'remove response' },
			},
		]),
	);
	const config = {
		projects_dir: tmp,
		include_subagents: false,
	};
	const signal = new AbortController().signal;

	let state: unknown = null;
	for await (const result of pollClaudeCode(config, null, signal)) {
		if (result.state !== undefined) state = result.state;
	}

	await Deno.remove(gone);
	const deletions: string[] = [];
	for await (const result of pollClaudeCode(config, state, signal)) {
		for (const u of result.updates) {
			if (u.kind === 'delete') deletions.push(u.id);
		}
	}
	assert.equal(deletions.length, 1, 'exactly the removed file is deleted');

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode suppresses deletions when the scan is not authoritative', async () => {
	const tmp = await Deno.makeTempDir();
	const rootFile = `${tmp}/not-a-directory`;
	await Deno.writeTextFile(rootFile, 'not a directory');

	const priorState = {
		'project/session.jsonl': {
			mtime: 1,
			size: 10,
			hash: 'abc',
			docId: 'claude-code:old-doc',
		},
	};

	const updates = [];
	for await (
		const result of pollClaudeCode(
			{ projects_dir: rootFile, include_subagents: false },
			priorState,
			new AbortController().signal,
		)
	) {
		updates.push(...result.updates);
	}

	assert.equal(updates.length, 0);
	await Deno.remove(tmp, { recursive: true });
});
