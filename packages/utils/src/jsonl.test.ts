import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
	LINE_PREFIX_BYTES,
	type LinePrefixFilter,
	readJsonl,
	readLines,
} from './jsonl.ts';

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

const utf8 = new TextEncoder();

/** UTF-8 strings and raw byte runs, concatenated. */
function bytesOf(...parts: (string | number[])[]): Uint8Array {
	const chunks = parts.map((part) =>
		typeof part === 'string' ? utf8.encode(part) : Uint8Array.from(part)
	);
	const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** The lines `prefilter` sees, the records and the counters of a read. */
async function readAll(
	path: string,
	options: { chunkSize?: number; linePrefix?: LinePrefixFilter },
) {
	const lines: string[] = [];
	const reader = readJsonl(path, {
		signal: never,
		...options,
		prefilter: (line) => lines.push(line) > 0,
	});
	const records: Record<string, unknown>[] = [];
	for await (const record of reader) {
		records.push(record);
	}
	const { parseErrors, skipped } = reader;
	return { lines, records, parseErrors, skipped };
}

Deno.test('readJsonl with linePrefix decodes lines as readLines does', async () => {
	// `{"pad":"` + 246 + `"}`: exactly a prefix long.
	const exact = `{"pad":"${'x'.repeat(LINE_PREFIX_BYTES - 10)}"}`;
	const content = bytesOf(
		[0xef, 0xbb, 0xbf],
		'{"a":1}\r\n',
		'\n',
		'  \r\n',
		'\ufeff{"bom":"later"}\n',
		'{"text":"中文😀é"}\n',
		[0x7b, 0xff, 0x7d, 0x0a],
		'{"cut":"',
		[0xe4, 0xb8],
		'\n',
		`${exact}\r\n`,
		`${exact}y\n`,
		`${JSON.stringify({ text: '字'.repeat(2_000) })}\n`,
		'{"last":true}\r',
	);
	await withFile(content, async (path) => {
		const expected = await readAll(path, {});
		assert.equal(expected.records.length, 5);
		assert.equal(expected.parseErrors, 4);
		for (
			const chunkSize of [1, 2, 3, 7, 255, 256, 257, 1024, 64 * 1024]
		) {
			assert.deepEqual(
				await readAll(path, { chunkSize, linePrefix: () => undefined }),
				expected,
				`chunk ${chunkSize}`,
			);
		}
	});
});

Deno.test('readJsonl linePrefix sees the first bytes of each line', async () => {
	const lines = [
		'{"a":1}',
		'x'.repeat(256),
		// With the CR of its CRLF, as long as a prefix.
		'w'.repeat(255),
		'y'.repeat(300),
		'z'.repeat(255),
	];
	const content = `${lines[0]}\r\n\n${lines[1]}\r\n${lines[2]}\r\n${
		lines[3]
	}\n${lines[4]}\r`;
	const decoder = new TextDecoder();
	await withFile(content, async (path) => {
		for (const chunkSize of [1, 5, 256, 257, 64 * 1024]) {
			const prefixes: string[] = [];
			const reader = readJsonl(path, {
				signal: never,
				chunkSize,
				linePrefix: (bytes, start, end) => {
					prefixes.push(decoder.decode(bytes.subarray(start, end)));
					return false;
				},
			});
			for await (const _ of reader) {
				// every line is skipped
			}
			assert.deepEqual(
				prefixes,
				lines.map((line) => line.slice(0, LINE_PREFIX_BYTES)),
				`chunk ${chunkSize}`,
			);
			assert.equal(reader.skipped, lines.length);
		}
	});
});

Deno.test('readJsonl linePrefix parses, skips undecoded, or defers to prefilter', async () => {
	const content = [
		'{"verdict":"parse","n":1}',
		`{"verdict":"skip","pad":"${'字'.repeat(400_000)}"}`,
		'{"verdict":"defer","keep":true}',
		'{"verdict":"defer","keep":false}',
		'{"verdict":"skip"}',
	].join('\n');
	// The byte after `{"verdict":"`.
	const verdicts: Record<string, boolean | undefined> = {
		p: true,
		s: false,
		d: undefined,
	};
	const decode = TextDecoder.prototype.decode;
	let decodedBytes = 0;
	TextDecoder.prototype.decode = function (input, options) {
		decodedBytes += (input as ArrayBufferView | undefined)?.byteLength ?? 0;
		return decode.call(this, input, options);
	};
	try {
		await withFile(content, async (path) => {
			const filtered: string[] = [];
			const reader = readJsonl(path, {
				signal: never,
				chunkSize: 1024,
				linePrefix: (bytes, start) =>
					verdicts[String.fromCharCode(bytes[start + 12])],
				prefilter: (line) => {
					filtered.push(line);
					return line.includes('"keep":true');
				},
			});
			const records: Record<string, unknown>[] = [];
			for await (const record of reader) {
				records.push(record);
			}
			assert.deepEqual(records, [
				{ verdict: 'parse', n: 1 },
				{ verdict: 'defer', keep: true },
			]);
			assert.deepEqual(filtered, [
				'{"verdict":"defer","keep":true}',
				'{"verdict":"defer","keep":false}',
			]);
			assert.equal(reader.skipped, 3);
			assert.equal(reader.parseErrors, 0);
		});
	} finally {
		TextDecoder.prototype.decode = decode;
	}
	// Only the three short lines that were not skipped from their prefix.
	assert.equal(decodedBytes, 25 + 31 + 32);
});

Deno.test('readJsonl with linePrefix stops with the abort reason between chunks', async () => {
	await withFile('{"a":1}\n{"a":2}\n{"a":3}\n', async (path) => {
		const controller = new AbortController();
		const reason = new Error('cancelled');
		const seen: Record<string, unknown>[] = [];
		await assert.rejects(
			(async () => {
				for await (
					const record of readJsonl(path, {
						signal: controller.signal,
						chunkSize: 2,
						linePrefix: () => true,
					})
				) {
					seen.push(record);
					controller.abort(reason);
				}
			})(),
			(error) => error === reason,
		);
		assert.deepEqual(seen, [{ a: 1 }]);
	});
	await assert.rejects(
		(async () => {
			for await (
				const _ of readJsonl(join(Deno.cwd(), 'missing.jsonl'), {
					signal: never,
					linePrefix: () => true,
				})
			) {
				// unreachable
			}
		})(),
		Deno.errors.NotFound,
	);
});
