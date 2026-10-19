import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJsonl, readLines } from './jsonl.ts';

const never = new AbortController().signal;

async function withFile(
	content: string | Uint8Array,
	body: (path: string) => Promise<void>,
): Promise<void> {
	const dir = await Deno.makeTempDir({ prefix: 'utils-jsonl-' });
	const path = join(dir, 'log.jsonl');
	try {
		if (typeof content === 'string') {
			await Deno.writeTextFile(path, content);
		} else {
			await Deno.writeFile(path, content);
		}
		await body(path);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
}

async function lines(path: string, chunkSize?: number): Promise<string[]> {
	const out: string[] = [];
	for await (const line of readLines(path, { signal: never, chunkSize })) {
		out.push(line);
	}
	return out;
}

Deno.test('readLines handles CRLF, blank lines and a missing final newline', async () => {
	await withFile('a\r\n\nb\nc', async (path) => {
		for (const chunkSize of [1, 2, 3, 64 * 1024]) {
			assert.deepEqual(await lines(path, chunkSize), ['a', '', 'b', 'c']);
		}
	});
	await withFile('a\nb\n', async (path) => {
		assert.deepEqual(await lines(path, 1), ['a', 'b']);
	});
	await withFile('', async (path) => {
		assert.deepEqual(await lines(path), []);
	});
});

Deno.test('readLines decodes multibyte characters split across chunks', async () => {
	const text = '中文😀é\n飞书\r\n👩‍👩‍👧';
	await withFile(text, async (path) => {
		// Chunk sizes 1..7 split every 2-, 3- and 4-byte sequence somewhere.
		for (let chunkSize = 1; chunkSize <= 7; chunkSize += 1) {
			assert.deepEqual(
				await lines(path, chunkSize),
				['中文😀é', '飞书', '👩‍👩‍👧'],
				`chunk ${chunkSize}`,
			);
		}
	});
});

Deno.test('readLines assembles a multi-megabyte line spanning many chunks', async () => {
	const long = JSON.stringify({ text: '字'.repeat(1_500_000) });
	await withFile(`{"a":1}\n${long}\n{"b":2}\n`, async (path) => {
		const out = await lines(path, 1024);
		assert.equal(out.length, 3);
		assert.equal(out[1], long);
		assert.equal(out[2], '{"b":2}');
	});
});

Deno.test('readLines time grows linearly with the length of one line', async () => {
	// One ASCII line of `mib` MiB read in default 64 KiB chunks; best of 3.
	const bestMs = async (mib: number): Promise<number> => {
		const bytes = new Uint8Array(mib * 1024 * 1024 + 1).fill(0x78);
		bytes[bytes.length - 1] = 0x0a;
		let best = Infinity;
		await withFile(bytes, async (path) => {
			for (let run = 0; run < 3; run += 1) {
				const start = performance.now();
				let length = 0;
				for await (const line of readLines(path, { signal: never })) {
					length += line.length;
				}
				best = Math.min(best, performance.now() - start);
				assert.equal(length, mib * 1024 * 1024);
			}
		});
		return best;
	};
	const small = await bestMs(8);
	const large = await bestMs(64);
	// 8x the input: linear reading takes ~8x as long; quadratic reassembly of
	// the line took ~60x. The bound leaves room for noisy CI machines.
	const ratio = large / Math.max(small, 1);
	assert.ok(ratio < 24, `64 MiB took ${ratio.toFixed(1)}x as long as 8 MiB`);
});

Deno.test('readLines stops with the abort reason between chunks', async () => {
	await withFile('a\nb\nc\nd\n', async (path) => {
		const controller = new AbortController();
		const reason = new Error('cancelled');
		const seen: string[] = [];
		await assert.rejects(
			(async () => {
				for await (
					const line of readLines(path, {
						signal: controller.signal,
						chunkSize: 2,
					})
				) {
					seen.push(line);
					controller.abort(reason);
				}
			})(),
			(error) => error === reason,
		);
		assert.deepEqual(seen, ['a']);
	});
});

Deno.test('readLines throws NotFound unchanged', async () => {
	await assert.rejects(
		lines(join(Deno.cwd(), 'does-not-exist.jsonl')),
		Deno.errors.NotFound,
	);
});

Deno.test('readJsonl yields objects and counts parse errors and skipped lines', async () => {
	const content = [
		'{"type":"message","n":1}',
		'',
		'   ',
		'{"type":"noise"}',
		'{broken',
		'[1,2]',
		'"str"',
		'{"type":"message","n":2}',
	].join('\r\n');
	await withFile(content, async (path) => {
		const reader = readJsonl(path, {
			signal: never,
			prefilter: (line) => !line.includes('"noise"'),
		});
		const records: Record<string, unknown>[] = [];
		for await (const record of reader) {
			records.push(record);
		}
		assert.deepEqual(records, [
			{ type: 'message', n: 1 },
			{ type: 'message', n: 2 },
		]);
		assert.equal(reader.parseErrors, 3);
		assert.equal(reader.skipped, 1);
	});
});

Deno.test('readJsonl prefilter sees lines that are never parsed', async () => {
	await withFile('{"keep":1}\n{not json but skipped\n', async (path) => {
		const reader = readJsonl(path, {
			signal: never,
			prefilter: (line) => line.includes('keep'),
		});
		const records = [];
		for await (const record of reader) {
			records.push(record);
		}
		assert.deepEqual(records, [{ keep: 1 }]);
		assert.equal(reader.parseErrors, 0);
		assert.equal(reader.skipped, 1);
	});
});

Deno.test('readJsonl propagates aborts and NotFound', async () => {
	await withFile('{"a":1}\n{"a":2}\n', async (path) => {
		const reason = new Error('stop');
		const reader = readJsonl(path, { signal: AbortSignal.abort(reason) });
		await assert.rejects(
			(async () => {
				for await (const _ of reader) {
					// unreachable
				}
			})(),
			(error) => error === reason,
		);
	});
	await assert.rejects(
		(async () => {
			for await (
				const _ of readJsonl(join(Deno.cwd(), 'missing.jsonl'), {
					signal: never,
				})
			) {
				// unreachable
			}
		})(),
		Deno.errors.NotFound,
	);
});
