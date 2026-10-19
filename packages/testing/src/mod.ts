// Test helpers that reproduce the Gety host's poll semantics. Import only
// from tests; nothing here belongs in a connector bundle.
//
// The helpers are typed structurally and do not import the connector SDK, so
// they work with whichever SDK copy a connector's import map points at.

/** A poll result as the connector yields it. */
export interface PollBatch {
	updates: unknown[];
	state?: unknown;
}

/** What `runPoll` needs from a connector instance. */
export interface PollingConnector {
	onLoad?(): void | Promise<void>;
	poll(): AsyncGenerator<PollBatch, void, unknown>;
}

type BatchOf<C extends PollingConnector> = C extends
	{ poll(): AsyncGenerator<infer B, void, unknown> } ? B : never;

export interface PollInit {
	config?: Record<string, unknown>;
	/** The host's stored state; `null` (default) on a first poll. */
	lastState?: unknown;
	signal?: AbortSignal;
	dataDir?: string;
	homeDir?: string;
}

export interface PollRun<B extends PollBatch = PollBatch> {
	/**
	 * `done`: the stream ended normally. `error`: the connector threw or a
	 * state broke the StartFrame budget. `cancelled`: the signal was aborted.
	 */
	outcome: 'done' | 'error' | 'cancelled';
	/** Batches as they cross the wire (JSON round-tripped), in order. */
	batches: B[];
	updates: B['updates'];
	/**
	 * The state the host persists: after `done` with at least one batch, the
	 * last batch's state (a batch without `state` keeps the previous one,
	 * starting from `lastState`). `undefined` when nothing is committed: the
	 * poll failed, was cancelled, or yielded no batch.
	 */
	committedState: unknown;
	error?: unknown;
}

/**
 * Runs one poll the way Gety's runner and host do. The host checks the
 * StartFrame budget before starting the runner (an oversized frame fails the
 * poll without loading the connector), and the connector receives config and
 * lastState through the serialized frame: JSON copies, so mutating them never
 * touches the host's checkpoint or `init`. Then config, lastState, signal,
 * dataDir and homeDir are injected, `onLoad` runs, and `poll()` is drained
 * (stopping when the signal aborts); every yielded state is checked against
 * the budget, and state is committed only when the stream succeeds.
 * Pass a fresh connector instance per poll, as the host starts a new process
 * for each.
 */
export async function runPoll<C extends PollingConnector>(
	connector: C,
	init: PollInit = {},
): Promise<PollRun<BatchOf<C>>> {
	const signal = init.signal ?? new AbortController().signal;
	const dirs = { dataDir: init.dataDir ?? '', homeDir: init.homeDir ?? '' };
	const run: PollRun<BatchOf<C>> = {
		outcome: 'cancelled',
		batches: [],
		updates: [],
		committedState: undefined,
	};
	try {
		// The host's own copies, as it holds them before sending the frame.
		const config = wireCopy(init.config ?? {});
		let checkpoint = wireCopy(init.lastState ?? null);
		assertStartFrameBudget(config, checkpoint, dirs);
		if (signal.aborted) {
			return run;
		}
		const internals = connector as unknown as Record<string, unknown>;
		internals.config = wireCopy(config);
		internals.lastState = wireCopy(checkpoint);
		internals.signal = signal;
		internals.dataDir = dirs.dataDir;
		internals.homeDir = dirs.homeDir;

		let yielded = false;
		await connector.onLoad?.();
		if (signal.aborted) {
			return run;
		}
		for await (const result of connector.poll()) {
			if (signal.aborted) {
				break;
			}
			const batch = wireCopy(result) as BatchOf<C>;
			if (Object.hasOwn(batch, 'state')) {
				assertStartFrameBudget(config, batch.state, dirs);
				checkpoint = wireCopy(batch.state);
			}
			run.batches.push(batch);
			run.updates.push(...batch.updates);
			yielded = true;
		}
		if (signal.aborted) {
			return run;
		}
		run.outcome = 'done';
		run.committedState = yielded ? checkpoint : undefined;
	} catch (error) {
		run.outcome = signal.aborted ? 'cancelled' : 'error';
		run.error = error;
	}
	return run;
}

/** `value` after a JSON round trip, as it crosses the runner's pipes. */
function wireCopy(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** A 200 JSON response unless `init` says otherwise. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

/** The host's StartFrame limit (`MAX_START_FRAME_BYTES`). */
export const MAX_START_FRAME_BYTES = 16 * 1024 * 1024;
/** Protocol version written by the host into every StartFrame. */
const PROTOCOL_VERSION = '0.2.0';
const encoder = new TextEncoder();

/**
 * Size in bytes of the StartFrame line the host would send for `config` and
 * `state` (JSON plus the trailing newline). Number formatting can differ from
 * the host's serde_json by a few bytes; budgets are far larger.
 */
export function startFrameBytes(
	config: unknown,
	state: unknown,
	dirs: { dataDir?: string; homeDir?: string } = {},
): number {
	const frame = {
		protocol_version: PROTOCOL_VERSION,
		config,
		last_state: state ?? null,
		data_dir: dirs.dataDir ?? '',
		home_dir: dirs.homeDir ?? '',
	};
	return encoder.encode(JSON.stringify(frame)).length + 1;
}

/**
 * Throws when the StartFrame for `config` and `state` exceeds the host's
 * 16 MiB budget; the host fails the poll in that case.
 */
export function assertStartFrameBudget(
	config: unknown,
	state: unknown,
	dirs: { dataDir?: string; homeDir?: string } = {},
): void {
	const bytes = startFrameBytes(config, state, dirs);
	if (bytes > MAX_START_FRAME_BYTES) {
		throw new Error(
			`StartFrame exceeded max size: actual ${bytes} bytes, max ${MAX_START_FRAME_BYTES} bytes`,
		);
	}
}
