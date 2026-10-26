// The community registration checks of `deno task community:check`
// (scripts/community.ts), which runs communityCatalog.

import { encode } from 'fast-png';
import assert from 'node:assert/strict';
import { communityCatalog, maxPngIconSize } from './catalog.ts';
import {
	addGithubUser,
	type Documents,
	githubUserUrl,
	publish,
	register,
	registrationOf,
	sampleConnector,
	sampleSvg,
	stubRegistry,
	withCommunityDir,
} from './catalog_stub.ts';

const jira = sampleConnector('jira', 'Jira');
const registration = registrationOf(jira);

type Change = (docs: Documents, dir: URL) => Promise<void>;

/**
 * communityCatalog's error once `change` has altered a valid setup: jira
 * published, registered as jira.json by acme, who is a GitHub user.
 */
async function checkError(change: Change): Promise<string> {
	const path = await Deno.makeTempDir();
	try {
		const dir = new URL(`file://${path}/`);
		const docs: Documents = {};
		await publish(docs, jira);
		addGithubUser(docs, 'acme', 1234567);
		await register(dir, 'jira.json', registration);
		await change(docs, dir);
		const error = await communityCatalog(
			stubRegistry(docs, { communityDir: dir }),
		).then(
			() => assert.fail('the check passed'),
			(error: Error) => error,
		);
		return error.message;
	} finally {
		await Deno.remove(path, { recursive: true });
	}
}

Deno.test('a valid registration passes and README.md is skipped', async () => {
	const path = await Deno.makeTempDir();
	try {
		const dir = new URL(`file://${path}/`);
		const docs: Documents = {};
		await Deno.writeTextFile(new URL('README.md', dir), '# Registrations\n');
		const stub = stubRegistry(docs, { communityDir: dir });
		assert.deepEqual(await communityCatalog(stub), []);
		await publish(docs, jira);
		addGithubUser(docs, 'acme', 1234567);
		await register(dir, 'jira.json', registration);
		const entries = await communityCatalog(stub);
		assert.deepEqual(
			entries.map((entry) => [entry.package, entry.version]),
			[['@acme/gety-jira', '1.2.0']],
		);
	} finally {
		await Deno.remove(path, { recursive: true });
	}
});

Deno.test('each failed check names the file and what failed', async (t) => {
	const cases: [string, Change, string][] = [
		[
			'not JSON',
			(_, dir) => register(dir, 'jira.json', '{"package": '),
			'community/jira.json: not valid JSON',
		],
		[
			'an unknown field',
			(_, dir) =>
				register(dir, 'jira.json', { ...registration, homepage: 'x' }),
			'community/jira.json: unknown field "homepage"',
		],
		[
			'an unknown author field',
			(_, dir) =>
				register(dir, 'jira.json', {
					...registration,
					author: { github: 'acme', name: 'Acme' },
				}),
			'community/jira.json: unknown field "author.name"',
		],
		[
			'a version range',
			(_, dir) =>
				register(dir, 'jira.json', { ...registration, version: '^1.2.0' }),
			'community/jira.json: version must be an exact version',
		],
		[
			'a package that is not on npm',
			(_, dir) =>
				register(dir, 'jira.json', {
					...registration,
					package: '@acme/gety-missing',
				}),
			'community/jira.json: @acme/gety-missing is not on npm',
		],
		[
			'a version that is not on npm',
			(_, dir) =>
				register(dir, 'jira.json', { ...registration, version: '1.3.0' }),
			'community/jira.json: @acme/gety-jira@1.3.0 is not on npm',
		],
		[
			'a version without gety',
			(docs) => publish(docs, { ...jira, gety: null }),
			'community/jira.json: @acme/gety-jira@1.2.0 has no gety manifest',
		],
		[
			'a file not named after gety.id',
			async (_, dir) => {
				await Deno.remove(new URL('jira.json', dir));
				await register(dir, 'jira-cloud.json', registration);
			},
			'community/jira-cloud.json: gety.id of @acme/gety-jira@1.2.0 is "jira"; the file name must be the manifest id',
		],
		[
			'a gety.version that is not the registered version',
			(docs) =>
				publish(docs, { ...jira, gety: { ...jira.gety, version: '1.1.0' } }),
			'community/jira.json: gety.version of @acme/gety-jira@1.2.0 is "1.1.0", not the registered version',
		],
		[
			'an icon the catalog cannot convert',
			(docs) =>
				publish(docs, {
					...jira,
					gety: { ...jira.gety, icon: 'icon.gif' },
					files: { 'icon.gif': new Uint8Array([0x47, 0x49, 0x46]) },
				}),
			'community/jira.json: package/icon.gif: icon must be SVG, PNG or WebP',
		],
		[
			'an icon missing from the tarball',
			(docs) =>
				publish(docs, { ...jira, gety: { ...jira.gety, icon: 'logo.svg' } }),
			'community/jira.json: the icon package/logo.svg (gety.icon) was not found in the package @acme/gety-jira@1.2.0; its file name must fit a plain tar header (at most 100 bytes)',
		],
		[
			'a PNG icon larger than the decoded size limit',
			(docs) =>
				publish(docs, {
					...jira,
					gety: { ...jira.gety, icon: 'icon.png' },
					files: {
						'icon.png': encode({
							width: maxPngIconSize + 1,
							height: 1,
							data: new Uint8Array((maxPngIconSize + 1) * 4),
							channels: 4,
							depth: 8,
						}),
					},
				}),
			`community/jira.json: package/icon.png: PNG icon is ${
				maxPngIconSize + 1
			}x1; PNG icons must be at most ${maxPngIconSize}x${maxPngIconSize}`,
		],
		[
			'an icon outside the package',
			(docs) =>
				publish(docs, { ...jira, gety: { ...jira.gety, icon: '../icon.svg' } }),
			'community/jira.json: gety.icon "../icon.svg" is not a path inside the package',
		],
		[
			'an author who is not a GitHub user',
			(_, dir) =>
				register(dir, 'jira.json', {
					...registration,
					author: { github: 'nobody' },
				}),
			'community/jira.json: GitHub user nobody does not exist',
		],
		[
			'a GitHub API error',
			(docs) => {
				docs[githubUserUrl('acme')] = Response.json(
					{ message: 'API rate limit exceeded' },
					{ status: 403, statusText: 'Forbidden' },
				);
				return Promise.resolve();
			},
			'community/jira.json: GET https://api.github.com/users/acme: 403 Forbidden (API rate limit exceeded)',
		],
		[
			'a file that is not a registration',
			(_, dir) => Deno.writeTextFile(new URL('notes.txt', dir), 'notes'),
			'community/notes.txt: not a registration',
		],
	];
	for (const [name, change, problem] of cases) {
		await t.step(name, async () => {
			const message = await checkError(change);
			assert.ok(message.includes(`\n  ${problem}`), message);
		});
	}
});

Deno.test('every failing file is reported', async () => {
	const message = await checkError(async (_, dir) => {
		await register(dir, 'jira.json', { ...registration, homepage: 'x' });
		await register(dir, 'linear.json', '[]');
	});
	assert.ok(message.includes('\n  community/jira.json: unknown field'));
	assert.ok(message.includes('\n  community/linear.json: must be'));
});

Deno.test('the archive is read up to the icon only', () =>
	withCommunityDir(async (dir) => {
		// The header after the last file, the icon, is damaged: it is an error
		// only to read on past the icon.
		const docs: Documents = {};
		await publish(
			docs,
			{ ...jira, files: { 'icon.svg': sampleSvg } },
			(tar) => tar.fill(1, tar.length - 1024, tar.length - 512),
		);
		addGithubUser(docs, 'acme', 1234567);
		await register(dir, 'jira.json', registration);
		const entries = await communityCatalog(
			stubRegistry(docs, { communityDir: dir }),
		);
		assert.deepEqual(entries.map((entry) => entry.package), [jira.package]);
	}));
