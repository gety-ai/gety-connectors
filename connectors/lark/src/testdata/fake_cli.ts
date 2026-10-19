/**
 * Installs a fake `lark-cli` executable (fake_lark_cli.ts behind a shell
 * wrapper) for tests and sandbox runs. Put `dir/bin` on PATH, or start
 * `bin` directly.
 */

export type FakeResponse = {
	/** JSON-encoded unless a string. */
	stdout?: unknown;
	stderr?: unknown;
	code?: number;
	sleepMs?: number;
};

export type FakeRule = {
	/** First two arguments, e.g. `"drive +search"`. */
	cmd: string;
	/** Flag values the call must carry; `null` requires the flag to be absent. */
	when?: Record<string, string | null>;
	responses: FakeResponse[];
};

export type FakeScenario = { rules: FakeRule[] };

export type FakeLarkCli = {
	dir: string;
	/** Absolute path of the executable, named `lark-cli`. */
	bin: string;
	setScenario(scenario: FakeScenario): Promise<void>;
	/** Arguments of every call so far, in order. */
	calls(): Promise<string[][]>;
	/** Start time (epoch ms) of every call so far, in order. */
	callTimes(): Promise<number[]>;
};

/** A success envelope as lark-cli prints it on stdout. */
export function ok(data: unknown): FakeResponse {
	return { stdout: { ok: true, identity: 'user', data } };
}

/** An error envelope as lark-cli prints it on stderr, with its exit code. */
export function fail(
	error: Record<string, unknown>,
	code = 1,
): FakeResponse {
	return { stderr: { ok: false, identity: 'user', error }, code };
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export async function installFakeLarkCli(
	dir: string,
	scenario: FakeScenario,
): Promise<FakeLarkCli> {
	const program = new URL('./fake_lark_cli.ts', import.meta.url).pathname;
	await Deno.mkdir(`${dir}/bin`, { recursive: true });
	const bin = `${dir}/bin/lark-cli`;
	await Deno.writeTextFile(
		bin,
		[
			'#!/bin/sh',
			`exec ${quote(Deno.execPath())} run --quiet --no-config --no-prompt ` +
			`--allow-read=${quote(dir)} --allow-write=${quote(dir)} ` +
			`${quote(program)} ${quote(dir)} "$@"`,
			'',
		].join('\n'),
	);
	await Deno.chmod(bin, 0o755);
	const records = async (): Promise<{ args: string[]; at: number }[]> => {
		let text = '';
		try {
			text = await Deno.readTextFile(`${dir}/calls.jsonl`);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
		return text.split('\n').filter((line) => line !== '').map((line) =>
			JSON.parse(line)
		);
	};
	const fake: FakeLarkCli = {
		dir,
		bin,
		setScenario: (next) =>
			Deno.writeTextFile(`${dir}/scenario.json`, JSON.stringify(next)),
		calls: async () => (await records()).map((call) => call.args),
		callTimes: async () => (await records()).map((call) => call.at),
	};
	await fake.setScenario(scenario);
	return fake;
}
