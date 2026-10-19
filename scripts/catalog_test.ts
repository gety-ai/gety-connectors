import assert from 'node:assert/strict';
import {
	buildCatalogPackage,
	type Catalog,
	firstCatalogVersion,
	nextCatalogVersion,
	type RegistryOptions,
	writeCatalogPackage,
} from './catalog.ts';
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

/** Registry documents by URL path; a missing path answers 404. */
type Documents = Record<string, unknown>;

function packumentPath(packageName: string): string {
	return `/${packageName.replace('/', '%2F')}`;
}

const catalogLatestPath = `${packumentPath('@gety-connectors/catalog')}/latest`;

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
		result[packumentPath(packageName)] = packument;
	}
	return result;
}

function stubRegistry(
	current: Documents | (() => Documents),
	options: Partial<RegistryOptions> = {},
): RegistryOptions & { requested: string[] } {
	const requested: string[] = [];
	return {
		registry: 'https://registry.test/',
		attempts: 1,
		retryDelayMs: 0,
		...options,
		requested,
		fetch: (url) => {
			requested.push(url.pathname);
			const body = (typeof current === 'function' ? current() : current)[
				url.pathname
			];
			return Promise.resolve(
				body === undefined
					? Response.json({ error: 'Not found' }, { status: 404 })
					: Response.json(body),
			);
		},
	};
}

async function changedCatalog(stub: RegistryOptions): Promise<Catalog> {
	const build = await buildCatalogPackage(stub);
	assert.ok(build.changed);
	return build.pkg.getyCatalog;
}

Deno.test('lists every connector at dist-tags.latest with its publish time', async () => {
	const stub = stubRegistry(
		documents(connectorPackuments('2026-10-01T08:00:00Z')),
	);
	const catalog = await changedCatalog(stub);
	assert.deepEqual(
		catalog.connectors.map((entry) => entry.package),
		connectors.map((connector) => connector.packageName),
	);
	for (const entry of catalog.connectors) {
		assert.equal(entry.version, gitVersions.get(entry.package));
		assert.equal(entry.publishedAt, '2026-10-01T08:00:00.000Z');
		assert.match(entry.icon, /^data:image\/(svg\+xml|png|webp);base64,/);
	}
	assert.ok(stub.requested.includes(catalogLatestPath));
});

Deno.test('the first catalog gets the first version and no private flag', async () => {
	const build = await buildCatalogPackage(
		stubRegistry(documents(connectorPackuments())),
	);
	assert.ok(build.changed);
	assert.equal(build.pkg.version, firstCatalogVersion);
	assert.equal(build.pkg.name, '@gety-connectors/catalog');
	assert.equal('private' in build.pkg, false);
	assert.deepEqual(Object.keys(build.pkg).slice(0, 2), ['name', 'version']);
});

Deno.test('fails when a connector is not on npm', async () => {
	const packuments = connectorPackuments();
	packuments.delete(first);
	const stub = stubRegistry(documents(packuments), { attempts: 3 });
	await assert.rejects(buildCatalogPackage(stub), (error: Error) => {
		assert.ok(error.message.includes(first));
		return true;
	});
	assert.equal(
		stub.requested.filter((path) => path === packumentPath(first)).length,
		3,
	);
	assert.equal(stub.requested.includes(catalogLatestPath), false);
});

Deno.test('fails when dist-tags.latest is not the checked-out version', async () => {
	const packuments = connectorPackuments();
	packuments.get(first)!['dist-tags'].latest = '0.0.1';
	await assert.rejects(
		buildCatalogPackage(stubRegistry(documents(packuments), { attempts: 2 })),
		(error: Error) => {
			assert.ok(error.message.includes(first));
			return true;
		},
	);
});

Deno.test('fails when the packument has no time for the latest version', async () => {
	const packuments = connectorPackuments();
	delete packuments.get(first)!.time[gitVersions.get(first)!];
	await assert.rejects(
		buildCatalogPackage(stubRegistry(documents(packuments))),
	);
});

Deno.test('reads a stale packument again until it has the version', async () => {
	const fresh = connectorPackuments();
	const stale = connectorPackuments();
	stale.get(first)!['dist-tags'].latest = '0.0.1';
	let reads = 0;
	const stub = stubRegistry(
		() => documents(reads++ < connectors.length ? stale : fresh),
		{ attempts: 3 },
	);
	const catalog = await changedCatalog(stub);
	const entry = catalog.connectors.find((entry) => entry.package === first);
	assert.equal(entry?.version, gitVersions.get(first));
	// The second read asks only for the connector that was stale.
	assert.equal(
		stub.requested.filter((path) => path === packumentPath(first)).length,
		2,
	);
});

Deno.test('skips publishing when the published catalog is equal', async () => {
	const packuments = connectorPackuments();
	const catalog = await changedCatalog(stubRegistry(documents(packuments)));
	// The same content with the keys in another order.
	const reordered = {
		connectors: catalog.connectors.map((entry) =>
			Object.fromEntries(Object.entries(entry).reverse())
		),
	};
	const build = await buildCatalogPackage(
		stubRegistry(
			documents(packuments, {
				[catalogLatestPath]: { version: '0.1.4', getyCatalog: reordered },
			}),
		),
	);
	assert.ok(!build.changed);
	assert.equal(build.published.version, '0.1.4');
});

Deno.test('bumps the published patch version when the catalog changed', async () => {
	const catalog = await changedCatalog(
		stubRegistry(documents(connectorPackuments())),
	);
	const build = await buildCatalogPackage(
		stubRegistry(
			documents(connectorPackuments('2026-10-05T08:00:00.000Z'), {
				[catalogLatestPath]: { version: '0.1.4', getyCatalog: catalog },
			}),
		),
	);
	assert.ok(build.changed);
	assert.equal(build.pkg.version, '0.1.5');
});

Deno.test('nextCatalogVersion', async (t) => {
	const catalog = await changedCatalog(
		stubRegistry(documents(connectorPackuments())),
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
			nextCatalogVersion({ version: '1.0.0-beta.1', getyCatalog: {} }, catalog)
		);
	});
});

Deno.test('writeCatalogPackage writes a new directory only', async () => {
	const build = await buildCatalogPackage(
		stubRegistry(documents(connectorPackuments())),
	);
	assert.ok(build.changed);
	const parent = await Deno.makeTempDir();
	try {
		const dir = `${parent}/catalog`;
		await writeCatalogPackage(dir, build.pkg);
		const names = (await Array.fromAsync(Deno.readDir(dir)))
			.map((entry) => entry.name)
			.sort();
		assert.deepEqual(names, ['LICENSE', 'README.md', 'package.json']);
		assert.deepEqual(
			JSON.parse(await Deno.readTextFile(`${dir}/package.json`)),
			build.pkg,
		);
		await assert.rejects(writeCatalogPackage(dir, build.pkg));
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});
