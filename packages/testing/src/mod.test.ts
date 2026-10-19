import assert from 'node:assert/strict';
import {
	assertStartFrameBudget,
	jsonResponse,
	MAX_START_FRAME_BYTES,
	type PollBatch,
	runPoll,
	startFrameBytes,
} from './mod.ts';

/** `mutate` sets `cursor = 99` on the connector's lastState and config. */
type Step = PollBatch | 'throw' | 'abort' | 'mutate';

/** A minimal connector that replays `steps` and records what it was given. */
class FakeConnector {
	protected config: Record<string, unknown> = {};
	protected lastState: unknown = null;
	protected signal = new AbortController().signal;
	protected dataDir = '';
	protected homeDir = '';
	loaded = false;
	seen?: Record<string, unknown>;

	constructor(
		private readonly steps: Step[],
		private readonly controller?: AbortController,
	) {}

	onLoad(): void {
		this.loaded = true;
		this.seen = {
			config: this.config,
			lastState: this.lastState,
			signal: this.signal,
			dataDir: this.dataDir,
			homeDir: this.homeDir,
		};
	}

	async *poll(): AsyncGenerator<PollBatch, void, unknown> {
		for (const step of this.steps) {
			if (step === 'throw') {
				throw new Error('upstream failed');
			}
			if (step === 'abort') {
				this.controller!.abort();
				continue;
			}
			if (step === 'mutate') {
				const state = this.lastState;
				assert.ok(state !== null && typeof state === 'object');
				Object.assign(state, { cursor: 99 });
				this.config.cursor = 99;
				continue;
			}
			yield await Promise.resolve(step);
		}
	}
}

const upsert = (id: string) => ({ kind: 'upsert', doc: { id, title: id } });

Deno.test('runPoll injects the runner fields before onLoad', async () => {
	const controller = new AbortController();
	const connector = new FakeConnector([]);
	await runPoll(connector, {
		config: { token: 't' },
		lastState: { cursor: 1 },
		signal: controller.signal,
		dataDir: '/data',
		homeDir: '/home/u',
	});
	assert.equal(connector.loaded, true);
	assert.deepEqual(connector.seen, {
		config: { token: 't' },
		lastState: { cursor: 1 },
		signal: controller.signal,
		dataDir: '/data',
		homeDir: '/home/u',
	});
});

Deno.test('a successful poll commits the last state', async () => {
	const run = await runPoll(
		new FakeConnector([
			{ updates: [upsert('a')] },
			{ updates: [upsert('b')], state: { cursor: 2 } },
			{ updates: [{ kind: 'delete', id: 'c' }] },
		]),
		{ lastState: { cursor: 1 } },
	);
	assert.equal(run.outcome, 'done');
	assert.equal(run.error, undefined);
	assert.equal(run.batches.length, 3);
	assert.deepEqual(run.updates, [
		upsert('a'),
		upsert('b'),
		{ kind: 'delete', id: 'c' },
	]);
	assert.deepEqual(run.committedState, { cursor: 2 });
});

Deno.test('batches without state keep the previous state', async () => {
	const run = await runPoll(new FakeConnector([{ updates: [] }]), {
		lastState: { cursor: 1 },
	});
	assert.deepEqual(run.committedState, { cursor: 1 });

	const fresh = await runPoll(new FakeConnector([{ updates: [] }]));
	assert.equal(fresh.committedState, null);

	const cleared = await runPoll(
		new FakeConnector([{ updates: [], state: null }]),
		{ lastState: { cursor: 1 } },
	);
	assert.equal(cleared.committedState, null);

	const undefinedState = await runPoll(
		new FakeConnector([{ updates: [], state: undefined }]),
		{ lastState: { cursor: 1 } },
	);
	assert.deepEqual(
		undefinedState.committedState,
		{ cursor: 1 },
		'state: undefined is omitted on the wire',
	);
});

Deno.test('a poll without batches commits nothing', async () => {
	const run = await runPoll(new FakeConnector([]), { lastState: { c: 1 } });
	assert.equal(run.outcome, 'done');
	assert.equal(run.committedState, undefined);
});

Deno.test('a failing poll commits nothing, even after a state batch', async () => {
	const run = await runPoll(
		new FakeConnector([
			{ updates: [upsert('a')], state: { cursor: 2 } },
			'throw',
		]),
		{ lastState: { cursor: 1 } },
	);
	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /upstream failed/);
	assert.equal(run.batches.length, 1);
	assert.equal(run.committedState, undefined);
});

Deno.test('a cancelled poll commits nothing and drops later batches', async () => {
	const controller = new AbortController();
	const run = await runPoll(
		new FakeConnector([
			{ updates: [upsert('a')], state: { cursor: 2 } },
			'abort',
			{ updates: [upsert('b')], state: { cursor: 3 } },
		], controller),
		{ signal: controller.signal },
	);
	assert.equal(run.outcome, 'cancelled');
	assert.deepEqual(run.updates, [upsert('a')]);
	assert.equal(run.committedState, undefined);

	const before = new FakeConnector([{ updates: [] }]);
	const early = await runPoll(before, { signal: AbortSignal.abort() });
	assert.equal(early.outcome, 'cancelled');
	assert.equal(before.loaded, false);
});

Deno.test('batches are JSON round-tripped like the wire', async () => {
	const run = await runPoll(
		new FakeConnector([{
			updates: [{
				kind: 'upsert',
				doc: { id: 'a', title: 'A', at: new Date(0), gone: undefined },
			}],
			state: { seen: ['a'], when: new Date(0) },
		}]),
	);
	assert.deepEqual(run.updates, [{
		kind: 'upsert',
		doc: { id: 'a', title: 'A', at: '1970-01-01T00:00:00.000Z' },
	}]);
	assert.deepEqual(run.committedState, {
		seen: ['a'],
		when: '1970-01-01T00:00:00.000Z',
	});
});

Deno.test('a state over the StartFrame budget fails the poll', async () => {
	const big = 'x'.repeat(MAX_START_FRAME_BYTES);
	const run = await runPoll(
		new FakeConnector([
			{ updates: [], state: { ok: true } },
			{ updates: [upsert('a')], state: { big } },
		]),
	);
	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /StartFrame exceeded max size/);
	assert.equal(run.batches.length, 1);
	assert.equal(run.committedState, undefined);
});

Deno.test('mutating lastState without a state batch commits the host copy', async () => {
	const lastState = { cursor: 1 };
	const config = { cursor: 1 };
	const run = await runPoll(
		new FakeConnector(['mutate', { updates: [upsert('a')] }]),
		{ lastState, config },
	);
	assert.equal(run.outcome, 'done');
	assert.deepEqual(run.committedState, { cursor: 1 });
	assert.deepEqual(lastState, { cursor: 1 });
	assert.deepEqual(config, { cursor: 1 });
});

Deno.test('mutating lastState then failing leaves the input checkpoint intact', async () => {
	const lastState = { cursor: 1 };
	const run = await runPoll(
		new FakeConnector(['mutate', { updates: [upsert('a')] }, 'throw']),
		{ lastState },
	);
	assert.equal(run.outcome, 'error');
	assert.equal(run.committedState, undefined);
	assert.deepEqual(lastState, { cursor: 1 });

	// A rerun from the same checkpoint sees the original state.
	const rerun = new FakeConnector([]);
	await runPoll(rerun, { lastState });
	assert.deepEqual(rerun.seen?.lastState, { cursor: 1 });
});

Deno.test('a state yielded and then mutated is committed as yielded', async () => {
	const state = { cursor: 2 };
	class Mutating extends FakeConnector {
		override async *poll(): AsyncGenerator<PollBatch, void, unknown> {
			yield await Promise.resolve({ updates: [], state });
			state.cursor = 99;
		}
	}
	const run = await runPoll(new Mutating([]));
	assert.deepEqual(run.committedState, { cursor: 2 });
});

Deno.test('an oversized initial StartFrame fails before onLoad', async () => {
	const connector = new FakeConnector([{ updates: [upsert('a')] }]);
	const run = await runPoll(connector, {
		lastState: { big: 'x'.repeat(MAX_START_FRAME_BYTES) },
	});
	assert.equal(run.outcome, 'error');
	assert.match(String(run.error), /StartFrame exceeded max size/);
	assert.equal(connector.loaded, false);
	assert.deepEqual(run.batches, []);
	assert.equal(run.committedState, undefined);

	const bigConfig = await runPoll(new FakeConnector([]), {
		config: { big: 'x'.repeat(MAX_START_FRAME_BYTES) },
	});
	assert.equal(bigConfig.outcome, 'error');
});

Deno.test('the connector receives JSON copies of config and lastState', async () => {
	const connector = new FakeConnector([]);
	await runPoll(connector, {
		config: { when: new Date(0), gone: undefined },
		lastState: { when: new Date(0) },
	});
	assert.deepEqual(connector.seen?.config, {
		when: '1970-01-01T00:00:00.000Z',
	});
	assert.deepEqual(connector.seen?.lastState, {
		when: '1970-01-01T00:00:00.000Z',
	});
});

Deno.test('startFrameBytes counts the whole frame line', () => {
	const expected = JSON.stringify({
		protocol_version: '0.2.0',
		config: { a: '飞' },
		last_state: null,
		data_dir: '/d',
		home_dir: '/h',
	});
	assert.equal(
		startFrameBytes({ a: '飞' }, undefined, { dataDir: '/d', homeDir: '/h' }),
		new TextEncoder().encode(expected).length + 1,
	);
	// A string state of n chars replaces `null` (4 bytes) with n + 2 bytes.
	const fits = MAX_START_FRAME_BYTES - startFrameBytes({}, null) + 2;
	assert.equal(startFrameBytes({}, 'x'.repeat(fits)), MAX_START_FRAME_BYTES);
	assertStartFrameBudget({}, 'x'.repeat(fits));
	assert.throws(
		() => assertStartFrameBudget({}, 'x'.repeat(fits + 1)),
		/StartFrame exceeded max size/,
	);
});

Deno.test('jsonResponse builds a JSON response', async () => {
	const response = jsonResponse({ ok: true });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'application/json');
	assert.deepEqual(await response.json(), { ok: true });

	const error = jsonResponse({ code: 'x' }, {
		status: 429,
		headers: { 'retry-after': '1' },
	});
	assert.equal(error.status, 429);
	assert.equal(error.headers.get('retry-after'), '1');
	assert.equal(error.headers.get('content-type'), 'application/json');
});
