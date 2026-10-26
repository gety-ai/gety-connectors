import type { PollResult } from '@gety-ai/connector-sdk';
import { type PollRun, runPoll } from '@gety-connectors/testing';
import { MAX_CONTENT_BYTES } from '@gety-connectors/utils/text';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import {
	buildCodexSessionDelete,
	buildCodexSessionUpdate,
	type CodexSessionFile,
	isIndexableCodexSession,
	parseCodexSessionFiles,
	parseCodexSessionLines,
} from './codex_log.ts';
import CodexConnector, {
	type CodexOptions,
	type CodexState,
	initialState,
	nextState,
} from './index.ts';

const file: CodexSessionFile = {
	path:
		'/home/example/.codex/sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
	stateKey:
		'sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
	mtimeMs: Date.parse('2026-06-03T10:30:00.000Z'),
	size: 1234,
};

Deno.test('parseCodexSessionLines builds a clean session doc without tool outputs', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
				timestamp: '2026-06-03T10:00:00.000Z',
				cwd: '/home/example/dev/gety',
				cli_version: '0.136.0',
				source: 'cli',
			}),
			jsonLine('turn_context', {
				summary: 'Codex connector design',
				cwd: '/home/example/dev/gety',
				workspace_roots: ['/home/example/dev/gety'],
				model: 'gpt-5.5',
			}),
			message('user', 'Build a connector.'),
			message('assistant', 'I am checking files.', 'commentary'),
			functionCall('exec_command', { cmd: 'deno task verify' }),
			functionCallOutput('very large output that must not be indexed'),
			message('assistant', 'Done.', 'final_answer'),
			message('user', 'One more change.'),
			message('assistant', 'Updated.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.id, '019e8abc-1234-7abc-8def-123456789abc');
	assert.equal(session.title, 'Codex connector design');
	assert.equal(session.cwd, '/home/example/dev/gety');
	assert.equal(session.messageCount, 4);
	assert.equal(session.userMessageCount, 2);
	assert.equal(session.codexMessageCount, 2);
	assert.equal(session.toolCallCount, 0);
	assert.match(session.content, /^# Codex connector design/);
	assert.match(
		session.content,
		new RegExp(
			'\n## Session\n\n' +
				'- Session ID: `019e8abc-1234-7abc-8def-123456789abc`\n' +
				'- Workspace: `/home/example/dev/gety`\n' +
				'- Model: `gpt-5\\.5`\n',
		),
	);
	assert.doesNotMatch(session.content, /- Started:/);
	assert.doesNotMatch(session.content, /- Updated:/);
	assert.doesNotMatch(session.content, /Cwd/);
	assert.match(session.content, /## User\n\nBuild a connector\./);
	assert.match(session.content, /## Codex\n\nDone\./);
	assert.match(session.content, /\n---\n/);
	assert.doesNotMatch(session.content, /checking files/);
	assert.doesNotMatch(session.content, /very large output/);
	assert.doesNotMatch(session.content, /Tool Calls/);
});

Deno.test('parseCodexSessionLines includes tool call summaries when enabled', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
			}),
			message('user', 'Run checks.'),
			functionCall('exec_command', { cmd: 'deno task verify' }),
			customToolCall(
				'apply_patch',
				[
					'*** Begin Patch',
					'*** Update File: src/index.ts',
					'@@',
					'*** End Patch',
				].join('\n'),
			),
			functionCallOutput('this output is still omitted'),
			message('assistant', 'Checks passed.', 'final_answer'),
		],
		file,
		{ includeToolCalls: true },
	);

	assert.equal(session.toolCallCount, 2);
	assert.match(session.content, /## Tool Calls/);
	assert.match(session.content, /- exec_command: `deno task verify`/);
	assert.match(session.content, /- apply_patch: `src\/index\.ts`/);
	assert.doesNotMatch(session.content, /this output is still omitted/);
});

Deno.test('parseCodexSessionLines renders identifiers as copyable code spans', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('turn_context', {
				workspace_roots: ['/tmp/has`tick', '`edge'],
				model: 'gpt``5',
			}),
			message('user', 'Run it.'),
			functionCall('exec_command', { cmd: 'echo `date`\n  | tee log' }),
			customToolCall(
				'apply_patch',
				'*** Begin Patch\n*** Add File: a`b.ts\n*** Delete File: c.ts\n',
			),
			message('assistant', 'Ran.', 'final_answer'),
		],
		file,
		{ includeToolCalls: true },
	);

	// Without session_meta, the id comes from the file name.
	assert.match(
		session.content,
		new RegExp(
			'\n- Session ID: `019e8abc-1234-7abc-8def-123456789abc`\n' +
				'- Workspace:\n' +
				'  - ``/tmp/has`tick``\n' +
				'  - `` `edge ``\n' +
				'- Model: ```gpt``5```\n',
		),
	);
	assert.match(
		session.content,
		/\n- exec_command: ``echo `date` \| tee log``\n/,
	);
	assert.match(session.content, /\n- apply_patch: ``a`b\.ts``, `c\.ts`$/);
});

Deno.test('parseCodexSessionLines uses only session, turn and item lines', () => {
	const text = (role: string, value: string) => ({
		type: 'message',
		role,
		content: [{
			type: role === 'user' ? 'input_text' : 'output_text',
			text: value,
		}],
	});
	const session = parseCodexSessionLines(
		[
			loggedLine('session_meta', { id: PARENT_ID }),
			loggedLine('turn_context', { model: 'gpt-5.5' }),
			loggedLine('response_item', text('user', 'Real prompt.')),
			// Events and compaction history repeat messages as nested records.
			loggedLine('event_msg', {
				type: 'item_completed',
				item: text('user', 'Event copy.'),
			}),
			loggedLine('compacted', {
				message: '',
				replacement_history: [text('user', 'Compacted copy.')],
			}),
			loggedLine('response_item', {
				type: 'reasoning',
				summary: [{ type: 'summary_text', text: 'Thinking.' }],
			}),
			// Shapes Codex does not write are left to the text filter.
			loggedLine('response_item', {
				role: 'assistant',
				type: 'message',
				phase: 'final_answer',
				content: [{ type: 'output_text', text: 'Payload type second.' }],
			}),
			JSON.stringify({
				payload: text('user', 'Type key last.'),
				type: 'response_item',
			}),
		],
		file,
		{ includeToolCalls: true },
	);

	assert.equal(session.id, PARENT_ID);
	assert.equal(session.userMessageCount, 2);
	assert.equal(session.codexMessageCount, 1);
	assert.match(session.content, /gpt-5\.5/);
	assert.match(session.content, /## User\n\nReal prompt\./);
	assert.match(session.content, /## Codex\n\nPayload type second\./);
	assert.match(session.content, /## User\n\nType key last\./);
	assert.doesNotMatch(session.content, /Event copy|Compacted copy|Thinking/);
});

Deno.test('poll reads past long tool output without indexing it', async () => {
	await withHome(async (home) => {
		// Each output line spans several 64 KiB reads.
		const output = '输出 output\n'.repeat(20_000);
		await writeSession(home, 'sessions/2026/06/03/long.jsonl', [
			jsonLine('session_meta', { id: PARENT_ID }),
			message('user', 'Run the build.'),
			functionCall('exec_command', { cmd: 'deno task build' }),
			functionCallOutput(output),
			jsonLine('event_msg', {
				type: 'exec_command_end',
				aggregated_output: output,
			}),
			message('assistant', 'Built.', 'final_answer'),
		]);

		for (const includeToolCalls of [false, true]) {
			const run = await poll(
				home,
				{ include_tool_calls: includeToolCalls },
				null,
			);
			assert.equal(run.outcome, 'done');
			const [update] = run.updates;
			if (update?.kind !== 'upsert') throw new Error('expected an upsert');
			const content = update.doc.content ?? '';
			assert.match(content, /## User\n\nRun the build\./);
			assert.match(content, /## Codex\n\nBuilt\./);
			assert.doesNotMatch(content, /输出/);
			assert.equal(content.includes('deno task build'), includeToolCalls);
		}
	});
});

Deno.test('parseCodexSessionLines falls back to the first prompt title', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('turn_context', { summary: 'auto' }),
			message('user', 'First prompt title.\n\nLong body.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.title, 'First prompt title.');
});

Deno.test('parseCodexSessionLines renders directory when workspace is missing', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				cwd: '/home/example/dev/gety',
			}),
			message('user', 'Question.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.match(session.content, /- Directory: `\/home\/example\/dev\/gety`/);
	assert.doesNotMatch(session.content, /- Workspace:/);
});

Deno.test('parseCodexSessionLines skips injected user context', () => {
	const session = parseCodexSessionLines(
		[
			message(
				'user',
				'# AGENTS.md instructions for /home/example/dev/gety\n\nDo not index.',
			),
			message('user', 'Real prompt.'),
			message('assistant', 'Real answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.title, 'Real prompt.');
	assert.equal(isIndexableCodexSession(session, false), true);
	assert.match(session.content, /Real prompt/);
	assert.doesNotMatch(session.content, /Do not index/);
});

Deno.test('isIndexableCodexSession rejects sessions with only injected context', () => {
	const session = parseCodexSessionLines(
		[
			message(
				'user',
				'# AGENTS.md instructions for /home/example/dev/gety\n\nDo not index.',
			),
			message(
				'user',
				'<environment_context>\n  <cwd>/home/example/dev/gety</cwd>\n</environment_context>',
			),
			message('assistant', 'Orphan final answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.userMessageCount, 0);
	assert.equal(isIndexableCodexSession(session, false), false);
});

Deno.test('isIndexableCodexSession rejects prompt-only sessions', () => {
	const session = parseCodexSessionLines(
		[
			message('user', 'whats 2+2?'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.userMessageCount, 1);
	assert.equal(session.codexMessageCount, 0);
	assert.equal(isIndexableCodexSession(session, false), false);
});

Deno.test('parseCodexSessionFiles returns null for sessions it does not index', async () => {
	await withHome(async (home) => {
		const parse = async (
			lines: string[],
			skipSubagents: boolean,
		) => {
			const stateKey = 'sessions/2026/06/03/session.jsonl';
			await writeSession(home, stateKey, lines);
			const path = join(home, '.codex', stateKey);
			const { mtime, size } = await Deno.stat(path);
			return parseCodexSessionFiles(
				[{ path, stateKey, mtimeMs: mtime?.getTime() ?? 0, size }],
				{ includeToolCalls: false, skipSubagents },
				new AbortController().signal,
			);
		};
		const subagent = [
			jsonLine('session_meta', {
				id: CHILD_ID,
				thread_source: 'subagent',
				source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } },
			}),
			...sessionLines(CHILD_ID).slice(1),
		];

		assert.equal((await parse(sessionLines(PARENT_ID), true))?.id, PARENT_ID);
		assert.equal(
			await parse([
				jsonLine('session_meta', { id: PARENT_ID }),
				message('user', 'whats 2+2?'),
			], true),
			null,
		);
		assert.equal(await parse(subagent, true), null);
		assert.equal((await parse(subagent, false))?.id, CHILD_ID);
	});
});

Deno.test('buildCodexSessionUpdate emits stable Gety metadata', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
				timestamp: '2026-06-03T10:00:00.000Z',
				model_provider: 'openai',
			}),
			jsonLine('turn_context', {
				workspace_roots: ['/home/example/dev/gety'],
				model: 'gpt-5.5',
			}),
			message('user', 'Question.'),
			message('assistant', 'Answer.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);
	const update = buildCodexSessionUpdate(session);

	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') {
		throw new Error('Expected an upsert.');
	}

	assert.equal(
		update.doc.id,
		'codex:session:019e8abc-1234-7abc-8def-123456789abc',
	);
	assert.equal(update.doc.doc_type, 'codex:session');
	assert.equal(update.doc.content_format, 'markdown');
	assert.equal(update.doc.doc_updated_at, '2026-06-03T10:30:00.000Z');
	assert.equal(update.doc.original_file_size, 1234);
	assert.deepEqual(update.doc.metadata, {
		url:
			'file:///home/example/.codex/sessions/2026/06/03/rollout-2026-06-03T10-00-00-019e8abc-1234-7abc-8def-123456789abc.jsonl',
		source: 'codex',
		source_path: file.path,
		session_id: '019e8abc-1234-7abc-8def-123456789abc',
		cwd: undefined,
		workspace_roots: ['/home/example/dev/gety'],
		model: 'gpt-5.5',
		model_provider: 'openai',
		created_at: '2026-06-03T10:00:00.000Z',
		cli_version: undefined,
		message_count: 2,
		user_message_count: 1,
		codex_message_count: 1,
		tool_call_count: 0,
		content_truncated: false,
	});
});

Deno.test('buildCodexSessionDelete targets the same stable session doc id', () => {
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: '019e8abc-1234-7abc-8def-123456789abc',
			}),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.deepEqual(buildCodexSessionDelete(session), {
		kind: 'delete',
		id: 'codex:session:019e8abc-1234-7abc-8def-123456789abc',
	});
});

Deno.test('parseCodexSessionLines keeps the first session_meta of a forked subagent', () => {
	// A subagent log starts with its own meta, then repeats its parent's.
	const session = parseCodexSessionLines(
		[
			jsonLine('session_meta', {
				id: CHILD_ID,
				timestamp: '2026-06-03T11:00:00.000Z',
				cwd: '/home/example/child',
				thread_source: 'subagent',
				source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } },
			}),
			jsonLine('session_meta', {
				id: PARENT_ID,
				timestamp: '2026-06-03T10:00:00.000Z',
				cwd: '/home/example/parent',
				source: 'cli',
			}),
			message('user', 'Review the diff.'),
			message('assistant', 'Looks fine.', 'final_answer'),
		],
		file,
		{ includeToolCalls: false },
	);

	assert.equal(session.id, CHILD_ID);
	assert.equal(session.startedAt, '2026-06-03T11:00:00.000Z');
	assert.equal(session.cwd, '/home/example/child');
	assert.equal(session.source, undefined);
	assert.equal(session.subagent, true);
	assert.equal(isIndexableCodexSession(session, false), false);
	assert.equal(isIndexableCodexSession(session, true), true);
});

Deno.test('parseCodexSessionLines limits content by UTF-8 bytes', () => {
	const ascii = parseCodexSessionLines(
		[message('user', 'a'.repeat(1_000_000)), message('assistant', 'ok')],
		file,
		{ includeToolCalls: false },
	);
	assert.equal(ascii.contentTruncated, false);
	assert.match(ascii.content, /## Codex\n\nok$/);

	const cjk = parseCodexSessionLines(
		[message('user', '字'.repeat(3_000_000)), message('assistant', 'ok')],
		file,
		{ includeToolCalls: false },
	);
	const bytes = new TextEncoder().encode(cjk.content).length;
	assert.equal(cjk.contentTruncated, true);
	assert.ok(bytes <= MAX_CONTENT_BYTES, `${bytes} bytes`);
	assert.ok(bytes > MAX_CONTENT_BYTES - 3, `${bytes} bytes`);
});

Deno.test('poll fails without deleting when the sessions directory is missing', async () => {
	await withHome(async (home) => {
		const run = await poll(home, {}, {
			...nextState({}, ['indexed-session'], DEFAULT_OPTIONS),
		});

		assert.equal(run.outcome, 'error');
		assert.match(String(run.error), /Codex sessions directory not found/);
		assert.deepEqual(run.updates, []);
		assert.equal(run.committedState, undefined);
	});
});

Deno.test('poll indexes subagent sessions under their own ids only when enabled', async () => {
	await withHome(async (home) => {
		await writeSession(home, 'sessions/2026/06/03/parent.jsonl', [
			jsonLine('session_meta', { id: PARENT_ID, source: 'cli' }),
			message('user', 'Parent prompt.'),
			message('assistant', 'Parent answer.', 'final_answer'),
		]);
		await writeSession(home, 'sessions/2026/06/03/child.jsonl', [
			jsonLine('session_meta', {
				id: CHILD_ID,
				thread_source: 'subagent',
				source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } },
			}),
			jsonLine('session_meta', { id: PARENT_ID, source: 'cli' }),
			message('user', 'Child prompt.'),
			message('assistant', 'Child answer.', 'final_answer'),
		]);

		const excluded = await poll(home, {}, null);
		assert.equal(excluded.outcome, 'done');
		assert.deepEqual(upserts(excluded), [
			{ id: `codex:session:${PARENT_ID}`, title: 'Parent prompt.' },
		]);

		const included = await poll(home, { include_subagents: true }, null);
		assert.deepEqual(
			upserts(included).sort((a, b) => a.id.localeCompare(b.id)),
			[
				{ id: `codex:session:${PARENT_ID}`, title: 'Parent prompt.' },
				{ id: `codex:session:${CHILD_ID}`, title: 'Child prompt.' },
			],
		);

		// Turning the option off again re-parses and deletes the subagent.
		const switched = await poll(home, {}, included.committedState);
		assert.deepEqual(deletes(switched), [`codex:session:${CHILD_ID}`]);
		assert.deepEqual(
			(switched.committedState as CodexState).indexed_sessions,
			[PARENT_ID],
		);
	});
});

Deno.test('poll deletes removed sessions and does not open unchanged files', async () => {
	await withHome(async (home) => {
		await writeSession(home, 'sessions/a.jsonl', sessionLines('session-a'));
		await writeSession(
			home,
			'archived_sessions/b.jsonl',
			sessionLines('session-b'),
		);
		const first = await poll(home, {}, null);
		assert.equal(upserts(first).length, 2);
		// Intermediate batches never carry state.
		assert.ok(first.batches.slice(0, -1).every((batch) => !('state' in batch)));

		await Deno.remove(join(home, '.codex/archived_sessions/b.jsonl'));
		const opened: string[] = [];
		const second = await withOpenSpy(
			(path) => opened.push(path),
			() => poll(home, {}, first.committedState),
		);
		assert.equal(second.outcome, 'done');
		assert.deepEqual(opened, []);
		assert.deepEqual(second.updates, [
			{ kind: 'delete', id: 'codex:session:session-b' },
		]);
		assert.deepEqual(
			(second.committedState as CodexState).indexed_sessions,
			['session-a'],
		);
	});
});

Deno.test('poll sends no batch when nothing changed', async () => {
	await withHome(async (home) => {
		await writeSession(home, 'sessions/a.jsonl', sessionLines('session-a'));
		const first = await poll(home, {}, null);
		assert.equal(upserts(first).length, 1);

		const second = await poll(home, {}, first.committedState);
		assert.equal(second.outcome, 'done');
		assert.deepEqual(second.batches, []);
		assert.equal(second.committedState, undefined);

		// A new log of a session that is not indexed changes only the state.
		await writeSession(home, 'sessions/b.jsonl', [
			message('user', 'Only a prompt.'),
		]);
		const third = await poll(home, {}, first.committedState);
		assert.deepEqual(third.updates, []);
		const thirdState = third.committedState as CodexState;
		assert.deepEqual(Object.keys(thirdState.files ?? {}), [
			'sessions/a.jsonl',
			'sessions/b.jsonl',
		]);

		// So does removing it again.
		await Deno.remove(join(home, '.codex/sessions/b.jsonl'));
		const fourth = await poll(home, {}, thirdState);
		assert.deepEqual(fourth.updates, []);
		const fourthState = fourth.committedState as CodexState;
		assert.deepEqual(Object.keys(fourthState.files ?? {}), [
			'sessions/a.jsonl',
		]);

		// And a changed option, with the same documents.
		const fifth = await poll(
			home,
			{ include_archived_sessions: false },
			fourthState,
		);
		assert.equal(
			(fifth.committedState as CodexState).include_archived_sessions,
			false,
		);
	});
});

Deno.test('poll keeps sessions whose file vanished before it was read', async () => {
	await withHome(async (home) => {
		await writeSession(home, 'sessions/a.jsonl', sessionLines('session-a'));
		await writeSession(home, 'sessions/b.jsonl', sessionLines('session-b'));
		const first = await poll(home, {}, null);

		// Both files change; b disappears between the listing and its read.
		await writeSession(home, 'sessions/a.jsonl', sessionLines('session-a', 2));
		await writeSession(home, 'sessions/b.jsonl', sessionLines('session-b', 2));
		const vanished = join(home, '.codex/sessions/b.jsonl');
		const second = await withOpenSpy((path) => {
			if (path === vanished) {
				throw new Deno.errors.NotFound(`No such file: ${path}`);
			}
		}, () => poll(home, {}, first.committedState));
		assert.equal(second.outcome, 'done');
		assert.deepEqual(upserts(second), [
			{ id: 'codex:session:session-a', title: 'Prompt 1 for session-a' },
		]);
		assert.deepEqual(deletes(second), []);
		assert.deepEqual(
			(second.committedState as CodexState).indexed_sessions,
			['session-a', 'session-b'],
		);

		await Deno.remove(vanished);
		const third = await poll(home, {}, second.committedState);
		assert.deepEqual(deletes(third), ['codex:session:session-b']);
	});
});

Deno.test('poll indexes every segment of a paginated session as one document', async () => {
	await withHome(async (home) => {
		// Written newest first, so file mtimes do not match the session order.
		await writeSession(home, SEGMENT_PATHS[2], [
			jsonLine('session_meta', { id: PARENT_ID }),
			message('user', 'Second prompt'),
			message('assistant', 'Second answer.', 'final_answer'),
		]);
		await writeSession(home, SEGMENT_PATHS[1], [
			jsonLine('session_meta', { id: PARENT_ID }),
			message('user', 'First prompt'),
			message('assistant', 'First answer.', 'final_answer'),
			message('user', 'Second prompt'),
		]);
		await writeSession(home, SEGMENT_PATHS[0], [
			jsonLine('session_meta', { id: PARENT_ID }),
			message('user', 'First prompt'),
		]);

		const run = await poll(home, {}, null);
		assert.equal(run.outcome, 'done');
		assert.equal(run.updates.length, 1);
		const [update] = run.updates;
		if (update.kind !== 'upsert') throw new Error('expected an upsert');
		assert.equal(update.doc.id, `codex:session:${PARENT_ID}`);
		assert.equal(update.doc.title, 'First prompt');
		const content = update.doc.content ?? '';
		assert.ok(content.includes('First answer.'), content);
		assert.ok(
			content.indexOf('First answer.') < content.indexOf('Second answer.'),
			content,
		);
		let totalSize = 0;
		for (const path of SEGMENT_PATHS) {
			totalSize += (await Deno.stat(join(home, '.codex', path))).size;
		}
		assert.equal(update.doc.original_file_size, totalSize);
		assert.equal(
			(update.doc.metadata as Record<string, unknown>).source_path,
			join(home, '.codex', SEGMENT_PATHS[0]),
		);
	});
});

Deno.test('poll rebuilds a paginated session from all segments when one changes', async () => {
	await withHome(async (home) => {
		const segment = (prompt: string, answer: string) => [
			jsonLine('session_meta', { id: PARENT_ID }),
			message('user', prompt),
			message('assistant', answer, 'final_answer'),
		];
		await writeSession(home, SEGMENT_PATHS[0], segment('One', 'Answer one.'));
		await writeSession(home, SEGMENT_PATHS[1], segment('Two', 'Answer two.'));
		const first = await poll(home, {}, null);

		// Appending to the last segment re-reads the first one too.
		await writeSession(home, SEGMENT_PATHS[1], [
			...segment('Two', 'Answer two.'),
			message('user', 'Three'),
			message('assistant', 'Answer three.', 'final_answer'),
		]);
		const second = await poll(home, {}, first.committedState);
		const [update] = second.updates;
		if (second.updates.length !== 1 || update.kind !== 'upsert') {
			throw new Error('expected one upsert');
		}
		assert.match(update.doc.content ?? '', /Answer one\.[^]*Answer three\./);

		// Losing a segment rebuilds the session from the rest.
		await Deno.remove(join(home, '.codex', SEGMENT_PATHS[1]));
		const third = await poll(home, {}, second.committedState);
		const [rebuilt] = third.updates;
		if (third.updates.length !== 1 || rebuilt.kind !== 'upsert') {
			throw new Error('expected one upsert');
		}
		assert.match(rebuilt.doc.content ?? '', /Answer one\./);
		assert.doesNotMatch(rebuilt.doc.content ?? '', /Answer two\./);

		// Only when the last segment is gone is the session deleted.
		await Deno.remove(join(home, '.codex', SEGMENT_PATHS[0]));
		const fourth = await poll(home, {}, third.committedState);
		assert.deepEqual(fourth.updates, [
			{ kind: 'delete', id: `codex:session:${PARENT_ID}` },
		]);
	});
});

Deno.test('poll keeps a paginated session whose segment vanished before it was read', async () => {
	await withHome(async (home) => {
		await writeSession(home, SEGMENT_PATHS[0], sessionLines(PARENT_ID));
		await writeSession(home, SEGMENT_PATHS[1], sessionLines(PARENT_ID));
		const first = await poll(home, {}, null);

		await writeSession(home, SEGMENT_PATHS[1], sessionLines(PARENT_ID, 2));
		const vanished = join(home, '.codex', SEGMENT_PATHS[0]);
		const second = await withOpenSpy((path) => {
			if (path === vanished) {
				throw new Deno.errors.NotFound(`No such file: ${path}`);
			}
		}, () => poll(home, {}, first.committedState));
		assert.equal(second.outcome, 'done');
		// The session stays as the first poll left it: there is nothing to send.
		assert.deepEqual(second.batches, []);
		assert.equal(second.committedState, undefined);

		await Deno.remove(vanished);
		const third = await poll(home, {}, first.committedState);
		assert.deepEqual(upserts(third), [
			{ id: `codex:session:${PARENT_ID}`, title: `Prompt 1 for ${PARENT_ID}` },
		]);
	});
});

Deno.test('poll keeps a paginated session whose segment the listing missed', async () => {
	await withHome(async (home) => {
		const segment = (answers: string[]) => [
			jsonLine('session_meta', { id: PARENT_ID }),
			...answers.flatMap((answer) => [
				message('user', `Question for ${answer}`),
				message('assistant', answer, 'final_answer'),
			]),
		];
		await writeSession(home, SEGMENT_PATHS[0], segment(['Answer one.']));
		await writeSession(home, SEGMENT_PATHS[1], segment(['Answer two.']));
		const first = await poll(home, {}, null);

		// The last segment grows while the listing loses track of the first.
		await writeSession(
			home,
			SEGMENT_PATHS[1],
			segment(['Answer two.', 'Answer three.']),
		);
		const missed = join(home, '.codex', SEGMENT_PATHS[0]);
		const second = await withStatSpy((path) => {
			if (path === missed) {
				throw new Deno.errors.NotFound(`No such file: ${path}`);
			}
		}, () => poll(home, {}, first.committedState));
		assert.equal(second.outcome, 'done');
		// The session stays as the first poll left it: there is nothing to send.
		assert.deepEqual(second.batches, []);
		assert.equal(second.committedState, undefined);

		// A complete poll rebuilds the session from both segments.
		const third = await poll(home, {}, first.committedState);
		const [update] = third.updates;
		if (third.updates.length !== 1 || update.kind !== 'upsert') {
			throw new Error('expected one upsert');
		}
		assert.match(update.doc.content ?? '', /Answer one\.[^]*Answer three\./);
	});
});

Deno.test('nextState stores sorted file fingerprints, indexed sessions and options', () => {
	assert.deepEqual(
		nextState(
			{
				'/b.jsonl': { mtime_ms: 2, size: 20, indexed: false },
				'/a.jsonl': {
					session_id: 'session-a',
					mtime_ms: 1,
					size: 10,
					indexed: true,
				},
			},
			['session-a', 'session-a'],
			DEFAULT_OPTIONS,
		),
		{
			schema_version: 4,
			include_tool_calls: false,
			include_archived_sessions: true,
			include_subagents: false,
			files: {
				'/a.jsonl': {
					session_id: 'session-a',
					mtime_ms: 1,
					size: 10,
					indexed: true,
				},
				'/b.jsonl': { mtime_ms: 2, size: 20, indexed: false },
			},
			indexed_sessions: ['session-a'],
		},
	);
});

Deno.test('initialState resets file fingerprints when an option changes', () => {
	const state = nextState(
		{
			'/a.jsonl': {
				session_id: 'session-a',
				mtime_ms: 1,
				size: 10,
				indexed: true,
			},
		},
		['session-a'],
		DEFAULT_OPTIONS,
	);
	assert.equal(initialState(state, DEFAULT_OPTIONS), state);
	for (
		const changed of [
			{ includeToolCalls: true },
			{ includeArchivedSessions: false },
			{ includeSubagents: true },
		]
	) {
		const options = { ...DEFAULT_OPTIONS, ...changed };
		assert.deepEqual(
			initialState(state, options),
			nextState({}, ['session-a'], options),
		);
	}
});

const PARENT_ID = '019e8abc-1234-7abc-8def-123456789abc';
const CHILD_ID = '019e8abc-5678-7abc-8def-123456789abc';
const SEGMENT_IDS = [
	'019e8abc-9001-7abc-8def-123456789abc',
	'019e8abc-9002-7abc-8def-123456789abc',
];
/** One session continued in two segment files, in session order. */
const SEGMENT_PATHS = [
	`sessions/2026/09/14/rollout-2026-09-14T12-00-12-${PARENT_ID}.jsonl`,
	`sessions/2026/09/14/rollout-2026-09-14T12-01-03-${PARENT_ID}_${
		SEGMENT_IDS[0]
	}.jsonl`,
	`sessions/2026/09/14/rollout-2026-09-14T13-42-11-${PARENT_ID}_${
		SEGMENT_IDS[1]
	}.jsonl`,
];

const DEFAULT_OPTIONS: CodexOptions = {
	includeToolCalls: false,
	includeArchivedSessions: true,
	includeSubagents: false,
};

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await Deno.makeTempDir();
	try {
		await fn(home);
	} finally {
		await Deno.remove(home, { recursive: true });
	}
}

async function writeSession(
	home: string,
	relPath: string,
	lines: readonly string[],
): Promise<void> {
	const path = join(home, '.codex', relPath);
	await Deno.mkdir(dirname(path), { recursive: true });
	await Deno.writeTextFile(path, `${lines.join('\n')}\n`);
}

function sessionLines(id: string, turns = 1): string[] {
	const lines = [jsonLine('session_meta', { id })];
	for (let turn = 1; turn <= turns; turn += 1) {
		lines.push(
			message('user', `Prompt ${turn} for ${id}`),
			message('assistant', `Answer ${turn}.`, 'final_answer'),
		);
	}
	return lines;
}

function poll(
	home: string,
	config: Record<string, unknown>,
	lastState: unknown,
): Promise<PollRun<PollResult>> {
	return runPoll(new CodexConnector(), {
		homeDir: home,
		config: {
			include_tool_calls: false,
			include_archived_sessions: true,
			include_subagents: false,
			...config,
		},
		lastState,
	});
}

function upserts(run: PollRun<PollResult>): { id: string; title: string }[] {
	return run.updates.flatMap((update) =>
		update.kind === 'upsert'
			? [{ id: update.doc.id, title: update.doc.title }]
			: []
	);
}

function deletes(run: PollRun<PollResult>): string[] {
	return run.updates.flatMap((update) =>
		update.kind === 'delete' ? [update.id] : []
	);
}

/** Runs `fn` with `Deno.open` reporting each opened path to `onOpen`. */
async function withOpenSpy<T>(
	onOpen: (path: string) => void,
	fn: () => Promise<T>,
): Promise<T> {
	const deno = Deno as { open: typeof Deno.open };
	const open = deno.open;
	deno.open = (path, options) => {
		onOpen(String(path));
		return open(path, options);
	};
	try {
		return await fn();
	} finally {
		deno.open = open;
	}
}

/** Runs `fn` with `Deno.statSync` reporting each path to `onStat` first. */
async function withStatSpy<T>(
	onStat: (path: string) => void,
	fn: () => Promise<T>,
): Promise<T> {
	const deno = Deno as { statSync: typeof Deno.statSync };
	const statSync = deno.statSync;
	deno.statSync = (path) => {
		onStat(String(path));
		return statSync(path);
	};
	try {
		return await fn();
	} finally {
		deno.statSync = statSync;
	}
}

function jsonLine(type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ type, payload });
}

/** A log line as Codex writes it: timestamp first, then type and payload. */
function loggedLine(type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({
		timestamp: '2026-06-03T10:00:00.000Z',
		type,
		payload,
	});
}

function message(
	role: string,
	text: string,
	phase?: string,
): string {
	return jsonLine('response_item', {
		type: 'message',
		role,
		phase,
		content: [
			{
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text,
			},
		],
	});
}

function functionCall(name: string, args: Record<string, unknown>): string {
	return jsonLine('response_item', {
		type: 'function_call',
		name,
		arguments: JSON.stringify(args),
		call_id: 'call-id',
	});
}

function customToolCall(name: string, input: string): string {
	return jsonLine('response_item', {
		type: 'custom_tool_call',
		name,
		input,
		call_id: 'call-id',
	});
}

function functionCallOutput(output: string): string {
	return jsonLine('response_item', {
		type: 'function_call_output',
		call_id: 'call-id',
		output,
	});
}
