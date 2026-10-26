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
 * Decides how `readJsonl` handles a line from its first bytes, before the
 * line is decoded: `true` parses it, `false` skips it without decoding it,
 * `undefined` decodes it and leaves the decision to `prefilter`.
 * `bytes[start..end)` is the start of the line: its first `LINE_PREFIX_BYTES`
 * bytes, or the whole line without its line ending when it is shorter.
 * `bytes` is only valid during the call.
 */
export type LinePrefixFilter = (
	bytes: Uint8Array,
	start: number,
	end: number,
) => boolean | undefined;

/** How many leading bytes of a line a `LinePrefixFilter` sees. */
export const LINE_PREFIX_BYTES = 256;

/**
 * Records of a JSONL file, with counters that are final once iteration
 * ends. Iterate it once.
 */
export interface JsonlReader extends AsyncIterable<Record<string, unknown>> {
	/** Non-blank lines that are not valid JSON or not a JSON object. */
	readonly parseErrors: number;
	/** Lines rejected by `linePrefix` or `prefilter` (never parsed). */
	readonly skipped: number;
}

/**
 * Streams the JSON object on each line of `path`. Blank lines are ignored.
 * Lines that `linePrefix` or `prefilter` rejects are counted in `skipped`
 * without being parsed; malformed lines are counted in `parseErrors`, never
 * thrown. File errors (including `NotFound`) and aborts throw as in
 * `readLines`.
 *
 * With `linePrefix`, the file is split into lines as bytes and each line is
 * judged by its first bytes before it is decoded, so a line it rejects costs
 * no decoding and no `prefilter` scan. The lines that are decoded are the
 * same as `readLines` yields.
 */
export function readJsonl(
	path: string,
	options: {
		signal: AbortSignal;
		prefilter?: (line: string) => boolean;
		linePrefix?: LinePrefixFilter;
		chunkSize?: number;
	},
): JsonlReader {
	const { prefilter, linePrefix } = options;
	const counts = { parseErrors: 0, skipped: 0 };
	const admit = (line: string): boolean => {
		if (line.trim() === '') {
			return false;
		}
		if (prefilter !== undefined && !prefilter(line)) {
			counts.skipped += 1;
			return false;
		}
		return true;
	};
	async function* records(): AsyncGenerator<Record<string, unknown>> {
		const lines = linePrefix === undefined
			? readLines(path, options)
			: readPrefixedLines(path, options, linePrefix, admit, counts);
		for await (const line of lines) {
			// readPrefixedLines only yields lines to parse.
			if (linePrefix === undefined && !admit(line)) {
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

const LF = 0x0a;
const CR = 0x0d;

/**
 * The lines `readJsonl` parses when it has a `linePrefix`. Each line is split
 * off as bytes and judged by `linePrefix` first: a line it rejects is counted
 * in `counts.skipped` and never decoded, a line it cannot judge is decoded
 * and yielded if `admit` accepts it, a line it accepts is decoded and
 * yielded. Lines decode exactly as `readLines` decodes them, and the signal
 * is checked before every read.
 */
async function* readPrefixedLines(
	path: string,
	options: { signal: AbortSignal; chunkSize?: number },
	linePrefix: LinePrefixFilter,
	admit: (line: string) => boolean,
	counts: { skipped: number },
): AsyncGenerator<string, void, undefined> {
	const { signal } = options;
	signal.throwIfAborted();
	const file = await Deno.open(path, { read: true });
	try {
		const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
		// A read lands after the unconsumed bytes, which are at most the start
		// of a line still too short to judge.
		const buffer = new Uint8Array(LINE_PREFIX_BYTES + chunkSize);
		let data = buffer.subarray(0, 0);
		let pos = 0;
		let more = true;
		const fill = async (): Promise<void> => {
			signal.throwIfAborted();
			buffer.copyWithin(0, pos, data.length);
			const kept = data.length - pos;
			const read = await file.read(buffer.subarray(kept, kept + chunkSize));
			more = read !== null;
			data = buffer.subarray(0, kept + (read ?? 0));
			pos = 0;
		};
		// Lines are decoded one at a time, and each `decode` call would drop a
		// byte order mark again: only the file's own is dropped, as a streaming
		// decoder does.
		const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
		while (more && data.length < 3) {
			await fill();
		}
		if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
			pos = 3;
		}

		// A line longer than the buffered bytes is either skipped up to its
		// newline or collected in `pieces` and joined once it ends.
		let mode: 'start' | 'skip' | 'keep' = 'start';
		let verdict: boolean | undefined;
		const pieces: Uint8Array[] = [];
		while (true) {
			if (mode === 'start') {
				const newline = data.indexOf(LF, pos);
				let lineEnd = newline === -1 ? data.length : newline;
				if (newline === -1 && more && lineEnd - pos <= LINE_PREFIX_BYTES) {
					// Read on until the line's end or more than its prefix is in: the
					// last buffered byte could be the CR of its CRLF.
					await fill();
					continue;
				}
				if (newline === -1 && more) {
					// The line goes on past the buffered bytes, which hold its prefix.
					verdict = linePrefix(data, pos, pos + LINE_PREFIX_BYTES);
					if (verdict === false) {
						counts.skipped += 1;
						mode = 'skip';
					} else {
						pieces.push(data.slice(pos));
						mode = 'keep';
					}
					pos = data.length;
					await fill();
					continue;
				}
				if (newline === -1 && pos === data.length) {
					break;
				}
				// The whole line is buffered.
				const start = pos;
				pos = newline === -1 ? lineEnd : lineEnd + 1;
				if (lineEnd > start && data[lineEnd - 1] === CR) {
					lineEnd -= 1;
				}
				if (lineEnd === start) {
					continue;
				}
				const lineVerdict = linePrefix(
					data,
					start,
					Math.min(lineEnd, start + LINE_PREFIX_BYTES),
				);
				if (lineVerdict === false) {
					counts.skipped += 1;
					continue;
				}
				const line = decoder.decode(data.subarray(start, lineEnd));
				if (lineVerdict || admit(line)) {
					yield line;
				}
				continue;
			}

			// Inside a line that started in an earlier read.
			const newline = data.indexOf(LF, pos);
			if (newline === -1 && more) {
				if (mode === 'keep') {
					pieces.push(data.slice(pos));
				}
				pos = data.length;
				await fill();
				continue;
			}
			const lineEnd = newline === -1 ? data.length : newline;
			const tail = data.subarray(pos, lineEnd);
			pos = newline === -1 ? lineEnd : lineEnd + 1;
			const kept = mode === 'keep';
			mode = 'start';
			if (kept) {
				pieces.push(tail);
				let bytes = concat(pieces);
				pieces.length = 0;
				if (bytes.at(-1) === CR) {
					bytes = bytes.subarray(0, -1);
				}
				const line = decoder.decode(bytes);
				if (verdict || admit(line)) {
					yield line;
				}
			}
		}
	} finally {
		file.close();
	}
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) {
		length += part.length;
	}
	const joined = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}
