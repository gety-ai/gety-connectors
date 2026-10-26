import { decodeBase64, encodeBase64 } from '@std/encoding/base64';
import { decode, encode } from 'fast-png';
import assert from 'node:assert/strict';
import {
	buildCatalogPackage,
	type Catalog,
	catalogIconSize,
	type CatalogOptions,
	communityCatalog,
	firstCatalogVersion,
	maxCatalogPackageBytes,
	nextCatalogVersion,
	officialCatalog,
	webpDimensions,
	writeCatalogPackage,
} from './catalog.ts';
import {
	addGithubUser,
	type Documents,
	githubUserUrl,
	packumentUrl,
	publish,
	register,
	registrationOf,
	sampleConnector,
	sampleSvg,
	stubRegistry,
	tarballUrl,
	tgz,
	withCommunityDir,
} from './catalog_stub.ts';
import { listConnectors, type PackageJson, readJson } from './connectors.ts';

const connectors = await listConnectors();
const gitVersions = new Map<string, string>();
for (const connector of connectors) {
	const pkg = await readJson<PackageJson>(
		new URL('package.json', connector.dir),
	);
	gitVersions.set(connector.packageName, pkg.version);
}
const first = connectors[0].packageName;

interface Packument {
	name: string;
	'dist-tags': Record<string, string>;
	time: Record<string, string>;
}

const catalogLatestUrl = `${packumentUrl('@gety-connectors/catalog')}/latest`;

/** Every connector's packument, at its git version published at `publishedAt`. */
function connectorPackuments(
	publishedAt = '2026-10-01T08:00:00.000Z',
): Map<string, Packument> {
	const packuments = new Map<string, Packument>();
	for (const [packageName, version] of gitVersions) {
		packuments.set(packageName, {
			name: packageName,
			'dist-tags': { latest: version, next: '99.0.0-next.1' },
			time: {
				created: '2026-01-01T00:00:00.000Z',
				modified: '2026-10-02T00:00:00.000Z',
				'0.0.1': '2026-01-01T00:00:00.000Z',
				[version]: publishedAt,
				'99.0.0-next.1': '2026-10-02T00:00:00.000Z',
			},
		});
	}
	return packuments;
}

function documents(
	packuments: Map<string, Packument>,
	extra: Documents = {},
): Documents {
	const result: Documents = { ...extra };
	for (const [packageName, packument] of packuments) {
		result[packumentUrl(packageName)] = packument;
	}
	return result;
}

async function changedCatalog(stub: CatalogOptions): Promise<Catalog> {
	const build = await buildCatalogPackage(stub);
	assert.ok(build.changed);
	return build.pkg.getyCatalog;
}

Deno.test('lists every connector at dist-tags.latest with its publish time', () =>
	withCommunityDir(async (dir) => {
		const stub = stubRegistry(
			documents(connectorPackuments('2026-10-01T08:00:00Z')),
			{ communityDir: dir },
		);
		const catalog = await changedCatalog(stub);
		assert.deepEqual(
			catalog.official.map((entry) => entry.package),
			connectors.map((connector) => connector.packageName),
		);
		for (const entry of catalog.official) {
			assert.equal(entry.version, gitVersions.get(entry.package));
			assert.equal(entry.publishedAt, '2026-10-01T08:00:00.000Z');
			assert.match(entry.icon, /^data:image\/(svg\+xml|png|webp);base64,/);
			assert.equal('author' in entry, false);
		}
		assert.deepEqual(catalog.community, []);
		assert.ok(stub.requested.includes(catalogLatestUrl));
	}));

Deno.test('the first catalog gets the first version and no private flag', () =>
	withCommunityDir(async (dir) => {
		const build = await buildCatalogPackage(
			stubRegistry(documents(connectorPackuments()), { communityDir: dir }),
		);
		assert.ok(build.changed);
		assert.equal(build.pkg.version, firstCatalogVersion);
		assert.equal(build.pkg.name, '@gety-connectors/catalog');
		assert.equal('private' in build.pkg, false);
		assert.deepEqual(Object.keys(build.pkg).slice(0, 2), ['name', 'version']);
	}));

Deno.test('fails when a connector is not on npm', () =>
	withCommunityDir(async (dir) => {
		const packuments = connectorPackuments();
		packuments.delete(first);
		const stub = stubRegistry(documents(packuments), {
			communityDir: dir,
			attempts: 3,
		});
		await assert.rejects(buildCatalogPackage(stub), (error: Error) => {
			assert.ok(error.message.includes(first));
			return true;
		});
		assert.equal(
			stub.requested.filter((url) => url === packumentUrl(first)).length,
			3,
		);
		assert.equal(stub.requested.includes(catalogLatestUrl), false);
	}));

Deno.test('fails when dist-tags.latest is not the checked-out version', () =>
	withCommunityDir(async (dir) => {
		const packuments = connectorPackuments();
		packuments.get(first)!['dist-tags'].latest = '0.0.1';
		await assert.rejects(
			buildCatalogPackage(
				stubRegistry(documents(packuments), { communityDir: dir, attempts: 2 }),
			),
			(error: Error) => {
				assert.ok(error.message.includes(first));
				return true;
			},
		);
	}));

Deno.test('fails when the packument has no time for the latest version', () =>
	withCommunityDir(async (dir) => {
		const packuments = connectorPackuments();
		delete packuments.get(first)!.time[gitVersions.get(first)!];
		await assert.rejects(
			buildCatalogPackage(
				stubRegistry(documents(packuments), { communityDir: dir }),
			),
		);
	}));

Deno.test('reads a stale packument again until it has the version', () =>
	withCommunityDir(async (dir) => {
		const fresh = connectorPackuments();
		const stale = connectorPackuments();
		stale.get(first)!['dist-tags'].latest = '0.0.1';
		let reads = 0;
		const stub = stubRegistry(
			() => documents(reads++ < connectors.length ? stale : fresh),
			{ communityDir: dir, attempts: 3 },
		);
		const catalog = await changedCatalog(stub);
		const entry = catalog.official.find((entry) => entry.package === first);
		assert.equal(entry?.version, gitVersions.get(first));
		// The second read asks only for the connector that was stale.
		assert.equal(
			stub.requested.filter((url) => url === packumentUrl(first)).length,
			2,
		);
	}));

Deno.test('skips publishing when the published catalog is equal', () =>
	withCommunityDir(async (dir) => {
		const packuments = connectorPackuments();
		const catalog = await changedCatalog(
			stubRegistry(documents(packuments), { communityDir: dir }),
		);
		// The same content with the keys in another order.
		const reordered = {
			community: catalog.community,
			official: catalog.official.map((entry) =>
				Object.fromEntries(Object.entries(entry).reverse())
			),
		};
		const build = await buildCatalogPackage(
			stubRegistry(
				documents(packuments, {
					[catalogLatestUrl]: { version: '0.1.4', getyCatalog: reordered },
				}),
				{ communityDir: dir },
			),
		);
		assert.ok(!build.changed);
		assert.equal(build.published.version, '0.1.4');
	}));

Deno.test('bumps the published patch version when the catalog changed', () =>
	withCommunityDir(async (dir) => {
		const catalog = await changedCatalog(
			stubRegistry(documents(connectorPackuments()), { communityDir: dir }),
		);
		const build = await buildCatalogPackage(
			stubRegistry(
				documents(connectorPackuments('2026-10-05T08:00:00.000Z'), {
					[catalogLatestUrl]: { version: '0.1.4', getyCatalog: catalog },
				}),
				{ communityDir: dir },
			),
		);
		assert.ok(build.changed);
		assert.equal(build.pkg.version, '0.1.5');
	}));

Deno.test('nextCatalogVersion', (t) =>
	withCommunityDir(async (dir) => {
		const catalog = await changedCatalog(
			stubRegistry(documents(connectorPackuments()), { communityDir: dir }),
		);
		await t.step('first version when nothing is published', () => {
			assert.equal(nextCatalogVersion(undefined, catalog), firstCatalogVersion);
		});
		await t.step('patch bump of a changed catalog', () => {
			assert.equal(
				nextCatalogVersion({ version: '1.9.9', getyCatalog: {} }, catalog),
				'1.9.10',
			);
		});
		await t.step('undefined when equal', () => {
			assert.equal(
				nextCatalogVersion({ version: '1.9.9', getyCatalog: catalog }, catalog),
				undefined,
			);
		});
		await t.step('rejects a version it cannot bump', () => {
			assert.throws(() =>
				nextCatalogVersion(
					{ version: '1.0.0-beta.1', getyCatalog: {} },
					catalog,
				)
			);
		});
	}));

Deno.test('writeCatalogPackage writes a new directory only', () =>
	withCommunityDir(async (dir) => {
		const build = await buildCatalogPackage(
			stubRegistry(documents(connectorPackuments()), { communityDir: dir }),
		);
		assert.ok(build.changed);
		const parent = await Deno.makeTempDir();
		try {
			const out = `${parent}/catalog`;
			await writeCatalogPackage(out, build.pkg);
			const names = (await Array.fromAsync(Deno.readDir(out)))
				.map((entry) => entry.name)
				.sort();
			assert.deepEqual(names, ['LICENSE', 'README.md', 'package.json']);
			assert.deepEqual(
				JSON.parse(await Deno.readTextFile(`${out}/package.json`)),
				build.pkg,
			);
			await assert.rejects(writeCatalogPackage(out, build.pkg));
		} finally {
			await Deno.remove(parent, { recursive: true });
		}
	}));

Deno.test('lists a community registration from its registered version', async () => {
	await withCommunityDir(async (dir) => {
		const docs: Documents = {};
		const jira = sampleConnector('jira', 'Jira');
		await publish(docs, {
			...jira,
			gety: {
				...jira.gety,
				icon: './assets/jira.svg',
				description: 'Indexes Jira issues.\nSecond line.',
			},
			files: { 'assets/jira.svg': sampleSvg },
			publishedAt: '2026-10-20T03:00:00Z',
		});
		addGithubUser(docs, 'acme', 1234567);
		await register(dir, 'jira.json', registrationOf(jira));
		const stub = stubRegistry(docs, {
			communityDir: dir,
			githubToken: 'github-token',
		});
		assert.deepEqual(await communityCatalog(stub), [
			{
				package: '@acme/gety-jira',
				name: 'Jira',
				description: 'Indexes Jira issues.',
				icon: `data:image/svg+xml;base64,${
					encodeBase64(new TextEncoder().encode(sampleSvg))
				}`,
				version: '1.2.0',
				publishedAt: '2026-10-20T03:00:00.000Z',
				author: { github: 'acme', githubId: 1234567 },
			},
		]);
		// The token goes to the GitHub API only, not to the registry.
		assert.deepEqual(stub.authorized, [githubUserUrl('acme')]);
	});
});

Deno.test('a community PNG icon is downscaled like an official one', async () => {
	await withCommunityDir(async (dir) => {
		const docs: Documents = {};
		const size = catalogIconSize * 2;
		const png = encode({
			width: size,
			height: size,
			data: new Uint8Array(size * size * 4).fill(200),
			channels: 4,
			depth: 8,
		});
		const jira = sampleConnector('jira', 'Jira');
		await publish(docs, {
			...jira,
			gety: { ...jira.gety, icon: 'icon.png' },
			files: { 'icon.png': png },
		});
		addGithubUser(docs, 'acme', 1);
		await register(dir, 'jira.json', registrationOf(jira));
		const [entry] = await communityCatalog(
			stubRegistry(docs, { communityDir: dir }),
		);
		const prefix = 'data:image/png;base64,';
		assert.ok(entry.icon.startsWith(prefix));
		const icon = decode(decodeBase64(entry.icon.slice(prefix.length)));
		assert.deepEqual([icon.width, icon.height], [128, 128]);
	});
});

Deno.test('sorts community entries by name, ignoring case', async () => {
	await withCommunityDir(async (dir) => {
		const docs: Documents = {};
		addGithubUser(docs, 'acme', 1);
		for (const [id, name] of [['a', 'beta'], ['b', 'Zeta'], ['c', 'alpha']]) {
			const pkg = sampleConnector(id, name);
			await publish(docs, pkg);
			await register(dir, `${id}.json`, registrationOf(pkg));
		}
		const entries = await communityCatalog(
			stubRegistry(docs, { communityDir: dir }),
		);
		assert.deepEqual(entries.map((entry) => entry.name), [
			'alpha',
			'beta',
			'Zeta',
		]);
	});
});

Deno.test('fails the catalog when a tarball does not match its integrity', async () => {
	await withCommunityDir(async (dir) => {
		const docs = documents(connectorPackuments());
		const jira = sampleConnector('jira', 'Jira');
		await publish(docs, jira);
		addGithubUser(docs, 'acme', 1);
		await register(dir, 'jira.json', registrationOf(jira));
		docs[tarballUrl(jira.package, jira.version)] = await tgz({
			'package/icon.svg': new TextEncoder().encode('<svg/>'),
		});
		await assert.rejects(
			buildCatalogPackage(stubRegistry(docs, { communityDir: dir })),
			/community\/jira\.json: the tarball of @acme\/gety-jira@1\.2\.0 does not match its dist\.integrity/,
		);
	});
});

Deno.test('publishes the official and community lists, without connectors', async () => {
	await withCommunityDir(async (dir) => {
		const docs = documents(connectorPackuments());
		const jira = sampleConnector('jira', 'Jira');
		await publish(docs, jira);
		addGithubUser(docs, 'acme', 1234567);
		await register(dir, 'jira.json', registrationOf(jira));
		const catalog = await changedCatalog(
			stubRegistry(docs, { communityDir: dir }),
		);
		assert.deepEqual(Object.keys(catalog), ['official', 'community']);
		assert.equal(catalog.official.length, connectors.length);
		assert.deepEqual(
			catalog.community.map((entry) => [entry.package, entry.author]),
			[['@acme/gety-jira', { github: 'acme', githubId: 1234567 }]],
		);
	});
});

Deno.test('the package size limit counts the community list', async () => {
	await withCommunityDir(async (dir) => {
		const docs = documents(connectorPackuments());
		addGithubUser(docs, 'acme', 1);
		// Two icons just under the per-icon limit outgrow the package limit.
		const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!--${
			'x'.repeat(23 * 1024)
		}--></svg>`;
		for (const id of ['a', 'b']) {
			const pkg = sampleConnector(id, id);
			await publish(docs, { ...pkg, files: { 'icon.svg': svg } });
			await register(dir, `${id}.json`, registrationOf(pkg));
		}
		await assert.rejects(
			buildCatalogPackage(stubRegistry(docs, { communityDir: dir })),
			new RegExp(`more than ${maxCatalogPackageBytes}; use smaller icons`),
		);
	});
});

/** A WebP file whose first chunk is `fourCC` with `payload` (headers only). */
function webp(fourCC: string, payload: number[]): Uint8Array {
	const chunk = [
		...new TextEncoder().encode(fourCC),
		...uint32(payload.length),
	];
	const body = [...new TextEncoder().encode('WEBP'), ...chunk, ...payload];
	return new Uint8Array([
		...new TextEncoder().encode('RIFF'),
		...uint32(body.length),
		...body,
	]);
}

function uint32(value: number): number[] {
	return [
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		value >>> 24,
	];
}

function webpVp8x(width: number, height: number): Uint8Array {
	return webp('VP8X', [
		0x10,
		0,
		0,
		0,
		...uint32(width - 1).slice(0, 3),
		...uint32(height - 1).slice(0, 3),
	]);
}

const webpPath = 'icon.webp';

Deno.test('webpDimensions reads VP8X, VP8L and VP8 headers', () => {
	assert.deepEqual(webpDimensions(webpPath, webpVp8x(300, 200)), {
		width: 300,
		height: 200,
	});
	const lossless = (299 | (199 << 14)) >>> 0;
	assert.deepEqual(
		webpDimensions(webpPath, webp('VP8L', [0x2f, ...uint32(lossless), 0])),
		{ width: 300, height: 200 },
	);
	assert.deepEqual(
		webpDimensions(
			webpPath,
			webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 44, 1, 200, 0]),
		),
		{ width: 300, height: 200 },
	);
	assert.throws(() => webpDimensions(webpPath, webp('VP8X', [0, 0])));
	assert.throws(() => webpDimensions(webpPath, new Uint8Array(40)));
});

Deno.test('a WebP icon larger than the catalog icon size fails the catalog', async () => {
	const dir = await Deno.makeTempDir();
	try {
		const connector = {
			short: 'sample',
			dir: new URL(`file://${dir}/`),
			packageName: '@gety-connectors/sample',
		};
		await Deno.writeTextFile(
			`${dir}/manifest.json`,
			JSON.stringify({ name: 'Sample', icon: 'icon.webp' }),
		);
		const releases = new Map([[connector.packageName, {
			version: '1.0.0',
			publishedAt: '2026-10-01T08:00:00.000Z',
		}]]);
		await Deno.writeFile(
			`${dir}/icon.webp`,
			webpVp8x(catalogIconSize, catalogIconSize),
		);
		const [entry] = await officialCatalog([connector], releases);
		assert.match(entry.icon, /^data:image\/webp;base64,/);
		await Deno.writeFile(
			`${dir}/icon.webp`,
			webpVp8x(catalogIconSize + 1, catalogIconSize),
		);
		await assert.rejects(officialCatalog([connector], releases));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
