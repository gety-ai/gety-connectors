/**
 * A stand-in for the lark-cli executable, started through the wrapper that
 * `installFakeLarkCli` (fake_cli.ts) writes: `fake_lark_cli.ts <dir> <args>`.
 *
 * It answers from `<dir>/scenario.json` and appends every invocation to
 * `<dir>/calls.jsonl`. A rule matches on the command (first two arguments)
 * and on flag values (`null`: the flag is absent); its n-th matching call
 * gets `responses[n]`, the last response repeating.
 */

import type { FakeResponse, FakeScenario } from './fake_cli.ts';

const [dir, ...args] = Deno.args;
const scenario: FakeScenario = JSON.parse(
	await Deno.readTextFile(`${dir}/scenario.json`),
);
const command = `${args[0]} ${args[1]}`;
const flag = (name: string): string | null => {
	const index = args.indexOf(name);
	return index < 0 ? null : args[index + 1];
};
const ruleIndex = scenario.rules.findIndex((rule) =>
	rule.cmd === command &&
	Object.entries(rule.when ?? {}).every(([name, value]) => flag(name) === value)
);

let previous = 0;
try {
	for (
		const line of (await Deno.readTextFile(`${dir}/calls.jsonl`)).split('\n')
	) {
		if (line !== '' && JSON.parse(line).rule === ruleIndex) previous += 1;
	}
} catch (error) {
	if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await Deno.writeTextFile(
	`${dir}/calls.jsonl`,
	`${JSON.stringify({ rule: ruleIndex, args, at: Date.now() })}\n`,
	{ append: true },
);

const responses = scenario.rules[ruleIndex]?.responses;
const response: FakeResponse = responses == null
	? {
		stderr: {
			ok: false,
			error: { type: 'validation', message: `no fake rule for ${command}` },
		},
		code: 2,
	}
	: responses[Math.min(previous, responses.length - 1)];

if (response.sleepMs != null) {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, response.sleepMs);
	await promise;
}
const encoder = new TextEncoder();
for (
	const [stream, value] of [
		[Deno.stdout, response.stdout],
		[Deno.stderr, response.stderr],
	] as const
) {
	if (value === undefined) continue;
	let bytes = encoder.encode(
		typeof value === 'string' ? value : JSON.stringify(value),
	);
	while (bytes.length > 0) bytes = bytes.subarray(stream.writeSync(bytes));
}
Deno.exit(response.code ?? 0);
