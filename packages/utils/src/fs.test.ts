import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sameFingerprint, walkFiles, type WalkFs } from './fs.ts';

const never = new AbortController().signal;
const jsonl = (relPath: string) => relPath.endsWith('.jsonl');

async function tree(files: Record<string, string>): Promise<string> {
	const root = await Deno.makeTempDir({ prefix: 'utils-fs-' });
	for (const [relPath, content] of Object.entries(files)) {
		const path = join(root, ...relPath.split('/'));
		await Deno.mkdir(join(path, '..'), { recursive: true });
		await Deno.writeTextFile(path, content);
	}
	return root;
}

/** Real file system calls with hooks to inject races and failures. */
function hookedFs(hooks: {
	readDir?: (path: string) => void;
	stat?: (path: string) => void;
}): WalkFs {
	return {
		readDir: (path) => {
			hooks.readDir?.(path);
			return Deno.readDir(path);
		},
		stat: (path) => {
			hooks.stat?.(path);
			return Deno.stat(path);
		},
	};
}

Deno.test('walkFiles lists matching files sorted by relPath', async () => {
	const root = await tree({
		'b/2.jsonl': 'xx',
		'a.jsonl': 'x',
		'b/1.jsonl': '',
		'b/c/3.jsonl': '',
		'notes.txt': '',
	});
	try {
		const result = await walkFiles(root, { include: jsonl, signal: never });
		assert.equal(result.complete, true);
		assert.equal(result.rootMissing, false);
		assert.deepEqual(result.files.map((f) => f.relPath), [
			'a.jsonl',
			'b/1.jsonl',
			'b/2.jsonl',
			'b/c/3.jsonl',
		]);
		const two = result.files[2];
		assert.equal(two.absPath, join(root, 'b', '2.jsonl'));
		assert.equal(two.size, 2);
		assert.ok(two.mtimeMs > 0);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('a missing root is reported, never an empty complete walk', async () => {
	const root = await tree({});
	await Deno.remove(root);
	const result = await walkFiles(root, { include: jsonl, signal: never });
	assert.deepEqual(result, { files: [], complete: false, rootMissing: true });
});

Deno.test('a subdirectory removed during the walk makes it incomplete', async () => {
	const root = await tree({ 'a/1.jsonl': '', 'b/2.jsonl': '' });
	try {
		const fs = hookedFs({
			readDir: (path) => {
				if (path === join(root, 'b')) {
					Deno.removeSync(path, { recursive: true });
				}
			},
		});
		const result = await walkFiles(root, { include: jsonl, signal: never, fs });
		assert.equal(result.complete, false);
		assert.equal(result.rootMissing, false);
		assert.deepEqual(result.files.map((f) => f.relPath), ['a/1.jsonl']);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('a file removed between listing and stat makes it incomplete', async () => {
	const root = await tree({ '1.jsonl': '', '2.jsonl': '' });
	try {
		const fs = hookedFs({
			stat: (path) => {
				if (path.endsWith('2.jsonl')) {
					Deno.removeSync(path);
				}
			},
		});
		const result = await walkFiles(root, { include: jsonl, signal: never, fs });
		assert.equal(result.complete, false);
		assert.deepEqual(result.files.map((f) => f.relPath), ['1.jsonl']);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('permission and sandbox errors are thrown', async () => {
	const root = await tree({ 'a/1.jsonl': '' });
	try {
		for (
			const make of [
				() => new Deno.errors.PermissionDenied('denied'),
				() => new Deno.errors.NotCapable('Requires read access'),
			]
		) {
			const fs = hookedFs({
				readDir: (path) => {
					if (path === join(root, 'a')) throw make();
				},
			});
			await assert.rejects(
				walkFiles(root, { include: jsonl, signal: never, fs }),
				(error) => error instanceof Error && error.name === make().name,
			);
			const statFs = hookedFs({
				stat: () => {
					throw make();
				},
			});
			await assert.rejects(
				walkFiles(root, { include: jsonl, signal: never, fs: statFs }),
				(error) => error instanceof Error && error.name === make().name,
			);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('descend skips directories by relPath', async () => {
	const root = await tree({
		'p/s.jsonl': '',
		'p/subagents/agent.jsonl': '',
		'p/subagents/deeper/x.jsonl': '',
	});
	try {
		const result = await walkFiles(root, {
			include: jsonl,
			descend: (relPath) => !relPath.endsWith('/subagents'),
			signal: never,
		});
		assert.equal(result.complete, true);
		assert.deepEqual(result.files.map((f) => f.relPath), ['p/s.jsonl']);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('an abort during the walk returns an incomplete result', async () => {
	const root = await tree({ 'a/1.jsonl': '', 'b/2.jsonl': '', 'c.jsonl': '' });
	try {
		const controller = new AbortController();
		const fs = hookedFs({
			stat: () => controller.abort(new Error('cancelled')),
		});
		const result = await walkFiles(root, {
			include: jsonl,
			signal: controller.signal,
			fs,
		});
		assert.equal(result.complete, false);
		assert.equal(result.rootMissing, false);
		assert.ok(result.files.length < 3);

		const aborted = await walkFiles(root, {
			include: jsonl,
			signal: AbortSignal.abort(),
		});
		assert.deepEqual(aborted, {
			files: [],
			complete: false,
			rootMissing: false,
		});
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test('sameFingerprint compares mtime and size', () => {
	const cur = { mtimeMs: 10, size: 5 };
	assert.equal(sameFingerprint({ mtimeMs: 10, size: 5 }, cur), true);
	assert.equal(sameFingerprint({ mtimeMs: 11, size: 5 }, cur), false);
	assert.equal(sameFingerprint({ mtimeMs: 10, size: 6 }, cur), false);
	assert.equal(sameFingerprint(undefined, cur), false);
});
