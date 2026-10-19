// Streaming line and JSONL readers with bounded memory per chunk.

import { isRecord } from './json.ts';

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * Yields the lines of a UTF-8 file, without `\n` or `\r\n`. A last line
 * without a newline is yielded; a trailing newline does not produce an extra
 * empty line. Multibyte characters split across chunks decode correctly. Each
 * chunk is searched once; the pieces of a line spanning many chunks are
 * joined once when the line ends, so the cost stays linear in the line size.
 * The signal is checked before every chunk (throwing `signal.reason`). Errors
 * opening or reading the file, including `NotFound`, are thrown unchanged.
 */
export async function* readLines(
	path: string,
	options: { signal: AbortSignal; chunkSize?: number },
): AsyncGenerator<string, void, undefined> {
	const { signal } = options;
	signal.throwIfAborted();
	const file = await Deno.open(path, { read: true });
	try {
		const chunk = new Uint8Array(options.chunkSize ?? DEFAULT_CHUNK_SIZE);
		const decoder = new TextDecoder();
		// Pieces of the current line from earlier chunks. Appending to one
		// growing string instead would make V8 flatten it on every search.
		const fragments: string[] = [];
		const finish = (tail: string): string => {
			let line = tail;
			if (fragments.length > 0) {
				fragments.push(tail);
				line = fragments.join('');
				fragments.length = 0;
			}
			return line.endsWith('\r') ? line.slice(0, -1) : line;
		};
		while (true) {
			signal.throwIfAborted();
			const read = await file.read(chunk);
			if (read === null) {
				break;
			}
			const text = decoder.decode(chunk.subarray(0, read), { stream: true });
			let lineStart = 0;
			let newline = text.indexOf('\n');
			while (newline !== -1) {
				yield finish(text.slice(lineStart, newline));
				lineStart = newline + 1;
				newline = text.indexOf('\n', lineStart);
			}
			if (lineStart < text.length) {
				fragments.push(text.slice(lineStart));
			}
		}
		const tail = decoder.decode();
		if (tail !== '' || fragments.length > 0) {
			yield finish(tail);
		}
	} finally {
		file.close();
	}
}

/**
 * Records of a JSONL file, with counters that are final once iteration
 * ends. Iterate it once.
 */
export interface JsonlReader extends AsyncIterable<Record<string, unknown>> {
	/** Non-blank lines that are not valid JSON or not a JSON object. */
	readonly parseErrors: number;
	/** Non-blank lines rejected by `prefilter` (never parsed). */
	readonly skipped: number;
}

/**
 * Streams the JSON object on each line of `path`. Blank lines are ignored.
 * Lines for which `prefilter` returns false are counted in `skipped` without
 * being parsed; malformed lines are counted in `parseErrors`, never thrown.
 * File errors (including `NotFound`) and aborts throw as in `readLines`.
 */
export function readJsonl(
	path: string,
	options: {
		signal: AbortSignal;
		prefilter?: (line: string) => boolean;
		chunkSize?: number;
	},
): JsonlReader {
	const { prefilter } = options;
	const counts = { parseErrors: 0, skipped: 0 };
	async function* records(): AsyncGenerator<Record<string, unknown>> {
		for await (const line of readLines(path, options)) {
			if (line.trim() === '') {
				continue;
			}
			if (prefilter !== undefined && !prefilter(line)) {
				counts.skipped += 1;
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				counts.parseErrors += 1;
				continue;
			}
			if (isRecord(value)) {
				yield value;
			} else {
				counts.parseErrors += 1;
			}
		}
	}
	return {
		[Symbol.asyncIterator]: () => records(),
		get parseErrors() {
			return counts.parseErrors;
		},
		get skipped() {
			return counts.skipped;
		},
	};
}
