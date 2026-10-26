// Local directory walks for connectors that index files.
//
// The walk reports whether it saw the whole tree, because deletions may only
// come from a complete enumeration. A missing root is reported separately and
// must become an error in the caller: it is not an empty source. Sandbox and
// permission errors are thrown so the poll fails with a clear message instead
// of succeeding with nothing indexed.

import { join } from 'node:path';

export interface FileEntry {
	absPath: string;
	/** Path below the root, `/`-separated on every platform. */
	relPath: string;
	mtimeMs: number;
	size: number;
}

export interface WalkResult {
	/** Sorted by `relPath` (code unit order). */
	files: FileEntry[];
	/**
	 * False when an entry vanished during the walk (a subdirectory or a file
	 * between listing and stat), when the root is missing, or when the walk
	 * was aborted.
	 */
	complete: boolean;
	/** The root directory does not exist. Treat as an error. */
	rootMissing: boolean;
}

/** File system calls used by `walkFiles`; replaceable in tests. */
export interface WalkFs {
	readDir(path: string): AsyncIterable<Deno.DirEntry>;
	stat(path: string): Deno.FileInfo;
}

export interface WalkOptions {
	/** Files to report, by `relPath`. */
	include: (relPath: string) => boolean;
	/** Directories to enter, by `relPath`; default: all. */
	descend?: (relPath: string) => boolean;
	signal: AbortSignal;
	/** Test seam; defaults to `Deno.readDir`/`Deno.statSync`. */
	fs?: WalkFs;
}

const denoFs: WalkFs = {
	readDir: (path) => Deno.readDir(path),
	// `Deno.stat` makes a round trip through the blocking thread pool per file:
	// over 25,800 files that took 184 ms, `Deno.statSync` 27 ms. A local stat
	// blocks the event loop for microseconds.
	stat: (path) => Deno.statSync(path),
};

/**
 * Recursively lists the files under `root` that `include` accepts. Only
 * regular files and directories are followed (symlinks are skipped).
 * `NotFound` below the root marks the walk incomplete and skips the entry;
 * every other error is thrown. An aborted signal returns the files found so
 * far with `complete: false`.
 */
export async function walkFiles(
	root: string,
	options: WalkOptions,
): Promise<WalkResult> {
	const { include, descend, signal } = options;
	const fs = options.fs ?? denoFs;
	const files: FileEntry[] = [];
	let complete = true;
	let rootMissing = false;

	const walk = async (dir: string, base: string): Promise<void> => {
		try {
			for await (const entry of fs.readDir(dir)) {
				if (signal.aborted) {
					complete = false;
					return;
				}
				const absPath = join(dir, entry.name);
				const relPath = base === '' ? entry.name : `${base}/${entry.name}`;
				if (entry.isDirectory) {
					if (descend === undefined || descend(relPath)) {
						await walk(absPath, relPath);
					}
				} else if (entry.isFile && include(relPath)) {
					const info = statFile(absPath);
					if (info !== undefined) {
						files.push({
							absPath,
							relPath,
							mtimeMs: info.mtime?.getTime() ?? 0,
							size: info.size,
						});
					}
				}
			}
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) {
				throw error;
			}
			if (base === '') {
				rootMissing = true;
			}
			complete = false;
		}
	};

	const statFile = (path: string): Deno.FileInfo | undefined => {
		try {
			return fs.stat(path);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) {
				throw error;
			}
			complete = false;
			return undefined;
		}
	};

	await walk(root, '');
	if (signal.aborted) {
		complete = false;
	}
	files.sort((a, b) =>
		a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
	);
	return { files, complete, rootMissing };
}

export interface Fingerprint {
	mtimeMs: number;
	size: number;
}

/** True when `prev` exists and has the same mtime and size as `cur`. */
export function sameFingerprint(
	prev: Fingerprint | undefined,
	cur: Fingerprint,
): boolean {
	return prev !== undefined && prev.mtimeMs === cur.mtimeMs &&
		prev.size === cur.size;
}
