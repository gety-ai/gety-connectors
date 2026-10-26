import type { Doc, PollResult } from '@gety-ai/connector-sdk';
import { runPoll } from '@gety-connectors/testing';
import { MAX_CONTENT_BYTES } from '@gety-connectors/utils/text';
import assert from 'node:assert/strict';
import ClaudeCodeConnector, {
	buildDocFromRecords,
	extractText,
	pollClaudeCode,
	readableModel,
} from './index.ts';
import type { ManifestConfig } from './gen/manifest.d.ts';

type Update = PollResult['updates'][number];

/** A state that has indexed one session, so a wrongful sweep would show. */
const KNOWN_SESSION_STATE = {
	schema_version: 2,
	files: {
		'project/session.jsonl': {
			mtime: 1,
			size: 10,
			docId: 'claude-code:old-doc',
		},
	},
};

function jsonl(records: unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join('\n');
}

/** One user prompt and one Claude Code answer. */
function exchange(
	sessionId: string,
	prompt: string,
	answer: string,
): Record<string, unknown>[] {
	return [
		{
			type: 'user',
			sessionId,
			timestamp: '2026-01-01T00:00:00Z',
			message: { role: 'user', content: prompt },
		},
		{
			type: 'assistant',
			sessionId,
			timestamp: '2026-01-01T00:00:01Z',
			message: { role: 'assistant', content: answer },
		},
	];
}

async function collect(
	batches: AsyncIterable<PollResult>,
): Promise<PollResult[]> {
	const results: PollResult[] = [];
	for await (const batch of batches) results.push(batch);
	return results;
}

/**
 * Runs `fn` with every file read (`Deno.open`, `Deno.readFile`,
 * `Deno.readTextFile`) reported to `onRead` first; `onRead` may throw to
 * simulate a failing read.
 */
async function withFileReadSpy<T>(
	onRead: (path: string) => void,
	fn: () => Promise<T>,
): Promise<T> {
	const fs = Deno as unknown as Record<
		'open' | 'readFile' | 'readTextFile',
		(path: string | URL, ...rest: unknown[]) => unknown
	>;
	const originals = {
		open: fs.open,
		readFile: fs.readFile,
		readTextFile: fs.readTextFile,
	};
	for (const name of ['open', 'readFile', 'readTextFile'] as const) {
		fs[name] = (path, ...rest) => {
			onRead(String(path));
			return originals[name].call(Deno, path, ...rest);
		};
	}
	try {
		return await fn();
	} finally {
		Object.assign(fs, originals);
	}
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
	assert.match(
		content,
		new RegExp(
			'\n## Session\n\n' +
				'- Session ID: `s1`\n' +
				'- Project: `/data/projects/myproject`\n' +
				'- Model: Claude Opus 4\\.8 \\(`claude-opus-4-8`\\)\n' +
				'- Git branch: `main`\n',
		),
	);
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
	// The session id `s-command-args` is listed; the wrapper tags are not.
	assert.doesNotMatch(doc.content ?? '', /<\/?command-name>/);
	assert.doesNotMatch(doc.content ?? '', /<\/?command-args>/);
});

Deno.test('buildDocFromRecords renders identifiers as copyable code spans', async () => {
	const records = (model: string) => [
		{
			type: 'user',
			sessionId: 'id`1',
			cwd: '/tmp/has`tick',
			gitBranch: 'feat/`x`',
			timestamp: '2026-03-03T00:00:00Z',
			message: {
				role: 'user',
				content: '<command-name>/run`x`</command-name>\n' +
					'<command-args>Go.</command-args>',
			},
		},
		{
			type: 'assistant',
			sessionId: 'id`1',
			timestamp: '2026-03-03T00:01:00Z',
			message: { role: 'assistant', model, content: 'Done.' },
		},
	];
	const render = async (model: string) => {
		const doc = await buildDocFromRecords(records(model), {
			relPath: 'p/s-spans.jsonl',
			fileName: 's-spans.jsonl',
			fileSize: 10,
			fileMtime: 0,
		});
		assert.ok(doc);
		return doc;
	};

	const doc = await render('claude-sonnet-4-5-20250929');
	// A backslash does not escape a backtick inside a span: longer fences do.
	assert.match(
		doc.content ?? '',
		new RegExp(
			'\n## Session\n\n' +
				'- Session ID: ``id`1``\n' +
				'- Project: ``/tmp/has`tick``\n' +
				'- Model: Claude Sonnet 4\\.5 \\(`claude-sonnet-4-5-20250929`\\)\n' +
				'- Git branch: `` feat/`x` ``\n',
		),
	);
	assert.match(doc.content ?? '', /## User\n\nCommand: `` \/run`x` ``\n\nGo\./);
	assert.equal(doc.title, 'Go.');
	// Without a readable name, or with an odd one, the id stands alone.
	for (const model of ['<synthetic>', 'claude-*x*']) {
		const content = (await render(model)).content ?? '';
		assert.ok(content.includes(`\n- Model: \`${model}\`\n`), content);
	}
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
	assert.match(content, /## Session\n\n- Session ID: `s6`\n/);
	assert.match(content, /- Project: `\/tmp\/proj6`/);
	assert.match(content, /- Model: Claude Opus 4\.8 \(`claude-opus-4-8`\)/);
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
		root: tmp,
		homeDir: '',
		includeSubagents: false,
	};
	const signal = new AbortController().signal;

	// First poll: one new file -> one upsert, then the state alone.
	const first = await collect(pollClaudeCode(config, null, signal));
	assert.equal(first.length, 2);
	assert.equal(first[0].updates.length, 1);
	assert.equal('state' in first[0], false);
	assert.deepEqual(first[1].updates, []);
	const stateAfterFirst = first[1].state;
	const firstUpdate = first[0].updates[0];
	assert.equal(firstUpdate.kind, 'upsert');
	if (firstUpdate.kind !== 'upsert') throw new Error('expected upsert');
	const docId = firstUpdate.doc.id;
	assert.equal(firstUpdate.doc.title, 'Test session');
	assert.match(firstUpdate.doc.content ?? '', /## User\n\nHello/);
	assert.match(firstUpdate.doc.content ?? '', /## Claude Code\n\nHi there/);
	assert.doesNotMatch(firstUpdate.doc.content ?? '', /tool_use/);
	assert.doesNotMatch(firstUpdate.doc.content ?? '', /tool_result/);

	// Second poll: unchanged -> no updates, the same state.
	const second = await collect(pollClaudeCode(config, stateAfterFirst, signal));
	assert.deepEqual(second, [{ updates: [], state: stateAfterFirst }]);

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
	const third = await collect(pollClaudeCode(config, stateAfterFirst, signal));
	assert.equal(third.length, 2);
	assert.equal(third[0].updates.length, 1);
	const stateAfterThird = third[1].state;
	const thirdUpdate = third[0].updates[0];
	assert.equal(thirdUpdate.kind, 'upsert');
	if (thirdUpdate.kind !== 'upsert') throw new Error('expected upsert');
	assert.equal(thirdUpdate.doc.id, docId);
	assert.match(thirdUpdate.doc.content ?? '', /One more thing/);

	// Delete the file -> the deletion comes with the final state.
	await Deno.remove(filePath);
	const fourth = await collect(pollClaudeCode(config, stateAfterThird, signal));
	assert.deepEqual(fourth, [{
		updates: [{ kind: 'delete', id: docId }],
		state: { schema_version: 2, files: {} },
	}]);

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
		root: tmp,
		homeDir: '',
		includeSubagents: false,
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
			{ root: tmp, homeDir: '', includeSubagents: false },
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
			{ root: tmp, homeDir: '', includeSubagents: true },
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
			{ root: tmp, homeDir: '', includeSubagents: true },
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
			{ root: tmp, homeDir: '', includeSubagents: false },
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

Deno.test('pollClaudeCode does not read files whose mtime and size are unchanged', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const filePath = `${projectDir}/session.jsonl`;
	const textA = jsonl(exchange('h1', 'AAAAA', 'reply'));
	const textB = jsonl(exchange('h1', 'BBBBB', 'reply'));
	assert.equal(textA.length, textB.length, 'test setup: sizes must match');
	await Deno.writeTextFile(filePath, textA);

	const config = { root: tmp, homeDir: '', includeSubagents: false };
	const signal = new AbortController().signal;
	const first = await collect(pollClaudeCode(config, null, signal));
	const state = first.at(-1)?.state;

	// A rewrite that keeps size and mtime is indistinguishable from an
	// unchanged file without reading it, and must not be read.
	const originalStat = await Deno.stat(filePath);
	await Deno.writeTextFile(filePath, textB);
	await Deno.utime(
		filePath,
		originalStat.atime ?? new Date(),
		originalStat.mtime ?? new Date(),
	);

	const opened: string[] = [];
	const second = await withFileReadSpy(
		(path) => opened.push(path),
		() => collect(pollClaudeCode(config, state, signal)),
	);
	assert.deepEqual(opened, []);
	assert.deepEqual(second, [{ updates: [], state }]);

	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode re-indexes every file once after a legacy state', async () => {
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
		root: tmp,
		homeDir: '',
		includeSubagents: false,
	};
	const signal = new AbortController().signal;

	// The legacy state was a bare file map; poll must re-index its files once.
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

Deno.test('pollClaudeCode re-indexes after an older schema and still deletes gone files', async () => {
	const tmp = await Deno.makeTempDir();
	const projectDir = `${tmp}/project`;
	await Deno.mkdir(projectDir, { recursive: true });
	const filePath = `${projectDir}/session.jsonl`;
	await Deno.writeTextFile(filePath, jsonl(exchange('s', 'Prompt', 'Answer')));
	const stat = await Deno.stat(filePath);
	const config = { root: tmp, homeDir: '', includeSubagents: false };
	const signal = new AbortController().signal;

	// Unchanged file, but rendered by an older version; the other one is gone.
	const olderState = {
		schema_version: 1,
		files: {
			'project/session.jsonl': {
				mtime: stat.mtime?.getTime() ?? 0,
				size: stat.size ?? 0,
				docId: 'claude-code:session',
			},
			'project/gone.jsonl': { mtime: 1, size: 1, docId: 'claude-code:gone' },
		},
	};
	const results = await collect(pollClaudeCode(config, olderState, signal));
	const updates = results.flatMap((result) => result.updates);
	assert.deepEqual(updates.map((update) => update.kind), ['upsert', 'delete']);
	assert.deepEqual(updates[1], { kind: 'delete', id: 'claude-code:gone' });
	const state = results.at(-1)?.state as { schema_version: number };
	assert.equal(state.schema_version, 2);

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
		root: tmp,
		homeDir: '',
		includeSubagents: false,
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

Deno.test('pollClaudeCode fails without deletes when the projects root is not a directory', async () => {
	const tmp = await Deno.makeTempDir();
	const rootFile = `${tmp}/not-a-directory`;
	await Deno.writeTextFile(rootFile, 'not a directory');

	const updates: Update[] = [];
	await assert.rejects(async () => {
		for await (
			const result of pollClaudeCode(
				{ root: rootFile, homeDir: '', includeSubagents: false },
				KNOWN_SESSION_STATE,
				new AbortController().signal,
			)
		) {
			updates.push(...result.updates);
		}
	});

	assert.deepEqual(updates, []);
	await Deno.remove(tmp, { recursive: true });
});

Deno.test('poll fails without deletes or state when ~/.claude/projects is missing', async () => {
	const home = await Deno.makeTempDir();
	const run = await runPoll(new ClaudeCodeConnector(), {
		homeDir: home,
		config: { include_subagents: false },
		lastState: KNOWN_SESSION_STATE,
	});

	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /projects directory not found/);
	assert.deepEqual(run.updates, []);
	assert.equal(run.committedState, undefined);
	await Deno.remove(home, { recursive: true });
});

Deno.test('poll reads the projects directory under the given home', async () => {
	const home = await Deno.makeTempDir();
	const projectDir = `${home}/.claude/projects/-work-app`;
	await Deno.mkdir(projectDir, { recursive: true });
	const records = exchange('s1', 'question', 'answer');
	await Deno.writeTextFile(
		`${projectDir}/s1.jsonl`,
		jsonl([{ ...records[0], cwd: `${home}/work/app` }, records[1]]),
	);

	const run = await runPoll(new ClaudeCodeConnector(), {
		homeDir: home,
		config: { include_subagents: false },
	});

	assert.equal(run.outcome, 'done');
	const [update] = run.updates;
	if (update?.kind !== 'upsert') throw new Error('expected one upsert');
	assert.equal(metadataOf(update.doc).path, '-work-app/s1.jsonl');
	assert.match(update.doc.content ?? '', /- Project: `~\/work\/app`/);
	await Deno.remove(home, { recursive: true });
});

Deno.test('pollClaudeCode fails without deletes when a directory is unreadable', async () => {
	const tmp = await Deno.makeTempDir();
	const locked = `${tmp}/locked`;
	await Deno.mkdir(locked);
	await Deno.writeTextFile(
		`${tmp}/open.jsonl`,
		jsonl(exchange('o', 'open', 'reply')),
	);
	await Deno.chmod(locked, 0o000);

	const updates: Update[] = [];
	try {
		await assert.rejects(
			async () => {
				for await (
					const result of pollClaudeCode(
						{ root: tmp, homeDir: '', includeSubagents: false },
						KNOWN_SESSION_STATE,
						new AbortController().signal,
					)
				) {
					updates.push(...result.updates);
				}
			},
			Deno.errors.PermissionDenied,
		);
	} finally {
		await Deno.chmod(locked, 0o755);
		await Deno.remove(tmp, { recursive: true });
	}
	assert.equal(
		updates.some((update) => update.kind === 'delete'),
		false,
	);
});

Deno.test('pollClaudeCode keeps sessions whose file vanished before it was read', async () => {
	const tmp = await Deno.makeTempDir();
	await Deno.writeTextFile(`${tmp}/a.jsonl`, jsonl(exchange('a', 'A1', 'r')));
	await Deno.writeTextFile(`${tmp}/b.jsonl`, jsonl(exchange('b', 'B1', 'r')));
	const config = { root: tmp, homeDir: '', includeSubagents: false };
	const signal = new AbortController().signal;
	const first = await collect(pollClaudeCode(config, null, signal));
	const firstState = first.at(-1)?.state as {
		files: Record<string, unknown>;
	};

	// Both files change; b.jsonl disappears between the listing and its read.
	await Deno.writeTextFile(`${tmp}/a.jsonl`, jsonl(exchange('a', 'A22', 'r')));
	await Deno.writeTextFile(`${tmp}/b.jsonl`, jsonl(exchange('b', 'B22', 'r')));
	const second = await withFileReadSpy((path) => {
		if (path.endsWith('b.jsonl')) {
			throw new Deno.errors.NotFound(`vanished: ${path}`);
		}
	}, () => collect(pollClaudeCode(config, firstState, signal)));
	const secondUpdates = second.flatMap((batch) => batch.updates);
	assert.deepEqual(secondUpdates.map((update) => update.kind), ['upsert']);
	const secondState = second.at(-1)?.state as {
		files: Record<string, unknown>;
	};
	assert.deepEqual(secondState.files['b.jsonl'], firstState.files['b.jsonl']);

	// Once it is really gone, the next complete poll deletes it.
	await Deno.remove(`${tmp}/b.jsonl`);
	const third = await collect(pollClaudeCode(config, secondState, signal));
	assert.deepEqual(
		third.flatMap((batch) => batch.updates).map((update) => update.kind),
		['delete'],
	);
	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode re-renders files an incomplete schema upgrade missed', async () => {
	const tmp = await Deno.makeTempDir();
	await Deno.writeTextFile(`${tmp}/a.jsonl`, jsonl(exchange('a', 'A1', 'r')));
	await Deno.writeTextFile(`${tmp}/b.jsonl`, jsonl(exchange('b', 'B1', 'r')));
	const config = { root: tmp, homeDir: '', includeSubagents: false };
	const signal = new AbortController().signal;
	// Gety keeps the committed state when a poll yields none.
	const committed = (results: PollResult[], previous: unknown) =>
		results.findLast((result) => result.state !== undefined)?.state ??
			previous;
	const upserted = (results: PollResult[]) =>
		results.flatMap((result) => result.updates).flatMap((update) =>
			update.kind === 'upsert' ? [update.doc.content ?? ''] : []
		).sort();
	const first = await collect(pollClaudeCode(config, null, signal));
	// The same files, indexed by the previous schema.
	const older = { ...(committed(first, null) as object), schema_version: 1 };

	// b.jsonl cannot be read during the upgrade poll.
	const partial = await withFileReadSpy((path) => {
		if (path.endsWith('b.jsonl')) throw new Deno.errors.NotFound(path);
	}, () => collect(pollClaudeCode(config, older, signal)));
	assert.equal(upserted(partial).length, 1);
	assert.equal(partial.some((result) => result.state !== undefined), false);

	// The next complete poll renders both files the current way.
	const retry = await collect(
		pollClaudeCode(config, committed(partial, older), signal),
	);
	const contents = upserted(retry);
	assert.equal(contents.length, 2);
	assert.match(contents[0], /- Session ID: `a`/);
	assert.match(contents[1], /- Session ID: `b`/);

	// After that the files are current.
	const unchanged = await collect(
		pollClaudeCode(config, committed(retry, older), signal),
	);
	assert.deepEqual(unchanged.flatMap((result) => result.updates), []);
	await Deno.remove(tmp, { recursive: true });
});

Deno.test('pollClaudeCode deletes an emptied session only after a complete poll', async () => {
	const tmp = await Deno.makeTempDir();
	await Deno.writeTextFile(`${tmp}/a.jsonl`, jsonl(exchange('a', 'A1', 'r')));
	await Deno.writeTextFile(`${tmp}/b.jsonl`, jsonl(exchange('b', 'B1', 'r')));
	const config = { root: tmp, homeDir: '', includeSubagents: false };
	const signal = new AbortController().signal;
	const first = await collect(pollClaudeCode(config, null, signal));
	const firstState = first.at(-1)?.state as {
		files: Record<string, { docId: string }>;
	};
	const aDocId = firstState.files['a.jsonl'].docId;

	// a.jsonl loses its conversation; b.jsonl changes and cannot be read.
	await Deno.writeTextFile(`${tmp}/a.jsonl`, jsonl([{ type: 'mode' }]));
	await Deno.writeTextFile(`${tmp}/b.jsonl`, jsonl(exchange('b', 'B22', 'r')));
	const failRead = (error: Error) => (path: string) => {
		if (path.endsWith('b.jsonl')) throw error;
	};

	// A poll that fails emits nothing before failing.
	const failed: PollResult[] = [];
	await assert.rejects(
		() =>
			withFileReadSpy(
				failRead(new Deno.errors.PermissionDenied('b')),
				async () => {
					for await (
						const batch of pollClaudeCode(config, firstState, signal)
					) failed.push(batch);
				},
			),
		Deno.errors.PermissionDenied,
	);
	assert.deepEqual(failed.flatMap((batch) => batch.updates), []);

	// An incomplete poll deletes nothing and keeps a.jsonl's document.
	const partial = await withFileReadSpy(
		failRead(new Deno.errors.NotFound('b')),
		() => collect(pollClaudeCode(config, firstState, signal)),
	);
	assert.deepEqual(partial.flatMap((batch) => batch.updates), []);
	const partialState = partial.at(-1)?.state as typeof firstState;
	assert.deepEqual(partialState.files['a.jsonl'], firstState.files['a.jsonl']);

	// The next complete poll deletes it.
	const complete = await collect(pollClaudeCode(config, partialState, signal));
	const deleted = complete.flatMap((batch) => batch.updates).flatMap((update) =>
		update.kind === 'delete' ? [update.id] : []
	);
	assert.deepEqual(deleted, [aDocId]);
	await Deno.remove(tmp, { recursive: true });
});

Deno.test('buildDocFromRecords keeps whole rounds within the UTF-8 byte budget', async () => {
	// Title `q` and session id `s`: everything before the answer is fixed.
	const header = '# q\n\n## Session\n\n- Session ID: `s`';
	const prefix = `${header}\n\n---\n\n## User\n\nq\n\n## Claude Code\n\n`;
	const fits = MAX_CONTENT_BYTES - new TextEncoder().encode(prefix).length;
	const options = {
		relPath: 'p/s.jsonl',
		fileName: 's.jsonl',
		fileSize: 1,
		fileMtime: 0,
	};

	const exact = await buildDocFromRecords(
		exchange('s', 'q', 'x'.repeat(fits)),
		options,
	);
	assert.equal(
		new TextEncoder().encode(exact?.content ?? '').length,
		MAX_CONTENT_BYTES,
	);
	assert.equal(metadataOf(exact).truncated, undefined);

	const over = await buildDocFromRecords(
		exchange('s', 'q', 'x'.repeat(fits + 1)),
		options,
	);
	assert.equal(over?.content, header);
	assert.equal(metadataOf(over).truncated, true);

	// Three-byte characters: fewer UTF-16 units than the budget, more bytes.
	const wide = await buildDocFromRecords(
		[
			...exchange('s', 'q', 'first answer'),
			// 2.7M characters: under the old 3 MiB UTF-16 budget, 8.1 MB in UTF-8.
			...exchange('s', 'second', '字'.repeat(2_700_000)),
		],
		options,
	);
	assert.match(wide?.content ?? '', /first answer$/);
	assert.equal(metadataOf(wide).truncated, true);
});

function metadataOf(doc: Doc | null): Record<string, unknown> {
	return (doc?.metadata ?? {}) as Record<string, unknown>;
}
