// Packs every publishable package and checks each tarball against what Gety
// accepts from npm. Build the connectors first (`deno task -r build`).
//
// Connector tarballs (packed with pnpm, as `changeset publish` does) must
// contain, under package/: the manifest entry as a self-contained bundle, the
// icon, CHANGELOG.md with an entry for the version, and a package.json whose
// `gety` equals manifest.json and whose `gety.version` equals `version`.
//
// The catalog is published by the release workflow from a generated directory
// with `npm publish`; it is built here with the connectors' package.json
// versions in place of the registry's (scripts/catalog.ts) and an empty
// community list (its entries come from npm and GitHub, which
// `deno task community:check` covers), and packed with npm. Its tarball must
// carry a valid `getyCatalog`, the README and the LICENSE.

import { UntarStream } from '@std/tar/untar-stream';
import {
	type Catalog,
	catalogPackage,
	type CatalogTemplate,
	catalogTemplatePath,
	firstCatalogVersion,
	officialCatalog,
	type Release,
	writeCatalogPackage,
} from './catalog.ts';
import {
	equalJson,
	license,
	listConnectors,
	type Manifest,
	type PackageJson,
	readJson,
	repoRoot,
} from './connectors.ts';

/** Bare specifiers a bundle may import: Node built-ins and the host SDK. */
const allowedImport = /^(node:.+|@gety-ai\/connector-sdk)$/;

const importPatterns = [
	/^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gm,
	/^import\s*"([^"]+)"/gm,
	/\bimport\(\s*"([^"]+)"\s*\)/g,
	/\b(?:__)?require\(\s*"([^"]+)"\s*\)/g,
];

interface Tarball {
	path: string;
	size: number;
	files: Map<string, Uint8Array>;
}

const decoder = new TextDecoder();
const rootLicense = await Deno.readTextFile(new URL('LICENSE', repoRoot));
const workDir = await Deno.makeTempDir({ prefix: 'gety-connectors-pack-' });
const errors: string[] = [];

try {
	const connectors = await listConnectors();
	const releases = new Map<string, Release>();
	for (const connector of connectors) {
		const tarball = await pack(connector.dir, connector.packageName, 'pnpm');
		const manifest = await readJson<Manifest>(
			new URL('manifest.json', connector.dir),
		);
		checkConnector(connector.packageName, tarball, manifest);
		releases.set(connector.packageName, {
			version: manifest.version,
			publishedAt: new Date(0).toISOString(),
		});
	}
	const template = await readJson<CatalogTemplate>(catalogTemplatePath);
	const catalogDir = `${await Deno.makeTempDir({ dir: workDir })}/catalog`;
	await writeCatalogPackage(
		catalogDir,
		catalogPackage(
			template,
			{ official: await officialCatalog(connectors, releases), community: [] },
			firstCatalogVersion,
		),
	);
	checkCatalog(
		template.name,
		await pack(catalogDir, template.name, 'npm'),
		connectors.length,
	);
} finally {
	await Deno.remove(workDir, { recursive: true });
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`error: ${error}`);
	}
	Deno.exit(1);
}
console.log('all package tarballs are valid');

async function pack(
	dir: string | URL,
	name: string,
	tool: 'pnpm' | 'npm',
): Promise<Tarball> {
	const destination = await Deno.makeTempDir({ dir: workDir });
	const result = await new Deno.Command(tool, {
		args: ['pack', '--pack-destination', destination],
		cwd: dir,
		stdout: 'piped',
		stderr: 'inherit',
	}).output();
	if (!result.success) {
		throw new Error(`${name}: ${tool} pack failed`);
	}
	const [entry] = await Array.fromAsync(Deno.readDir(destination));
	const path = `${destination}/${entry.name}`;
	const files = new Map<string, Uint8Array>();
	const file = await Deno.open(path);
	const entries = file.readable
		.pipeThrough(new DecompressionStream('gzip'))
		.pipeThrough(new UntarStream());
	for await (const tarEntry of entries) {
		const type = tarEntry.header.typeflag;
		if (!tarEntry.path.startsWith('package/')) {
			errors.push(`${name}: ${tarEntry.path} is outside package/`);
		}
		if (type === '0' || type === '\0' || type === '') {
			files.set(
				tarEntry.path.slice('package/'.length),
				new Uint8Array(await new Response(tarEntry.readable).arrayBuffer()),
			);
		} else {
			await tarEntry.readable?.cancel();
			if (type !== '5') {
				errors.push(`${name}: ${tarEntry.path} is not a regular file`);
			}
		}
	}
	return { path, size: (await Deno.stat(path)).size, files };
}

function checkConnector(name: string, tarball: Tarball, manifest: Manifest) {
	const pkg = tarballPackageJson(name, tarball);
	if (!pkg) {
		return;
	}
	if (!pkg.gety) {
		errors.push(`${name}: package.json has no gety field`);
		return;
	}
	if (pkg.gety.version !== pkg.version) {
		errors.push(
			`${name}: gety.version ${pkg.gety.version} differs from version ${pkg.version}`,
		);
	}
	if (!equalJson(pkg.gety, manifest)) {
		errors.push(`${name}: gety differs from manifest.json`);
	}
	const entry = tarball.files.get(pkg.gety.entry);
	if (!entry) {
		errors.push(`${name}: entry ${pkg.gety.entry} is missing`);
	} else {
		for (const specifier of bundleImports(decoder.decode(entry))) {
			if (!allowedImport.test(specifier)) {
				errors.push(
					`${name}: ${pkg.gety.entry} imports "${specifier}"; the entry must be a self-contained bundle`,
				);
			}
		}
	}
	if (!pkg.gety.icon || !tarball.files.has(pkg.gety.icon)) {
		errors.push(`${name}: icon ${pkg.gety.icon} is missing`);
	}
	checkChangelog(name, tarball, pkg.version);
	checkLicense(name, tarball, pkg);
	report(name, pkg.version, tarball);
}

function checkCatalog(name: string, tarball: Tarball, connectorCount: number) {
	const pkg = tarballPackageJson(name, tarball) as
		| (PackageJson & { getyCatalog?: Catalog })
		| undefined;
	if (!pkg) {
		return;
	}
	const size = tarball.files.get('package.json')!.length;
	const catalog = pkg.getyCatalog;
	if (
		!Array.isArray(catalog?.official) || !Array.isArray(catalog?.community)
	) {
		errors.push(`${name}: getyCatalog.official or .community is missing`);
	} else if (catalog.official.length !== connectorCount) {
		errors.push(
			`${name}: getyCatalog lists ${catalog.official.length} official connectors, expected ${connectorCount}`,
		);
	}
	if (!tarball.files.has('README.md')) {
		errors.push(`${name}: README.md is missing`);
	}
	checkLicense(name, tarball, pkg);
	report(name, pkg.version, tarball, `package.json ${size} bytes`);
}

function tarballPackageJson(
	name: string,
	tarball: Tarball,
): PackageJson | undefined {
	const bytes = tarball.files.get('package.json');
	if (!bytes) {
		errors.push(`${name}: package.json is missing`);
		return undefined;
	}
	return JSON.parse(decoder.decode(bytes)) as PackageJson;
}

function checkChangelog(name: string, tarball: Tarball, version: string) {
	const changelog = tarball.files.get('CHANGELOG.md');
	if (!changelog) {
		errors.push(`${name}: CHANGELOG.md is missing`);
	} else if (!decoder.decode(changelog).includes(`\n## ${version}\n`)) {
		errors.push(`${name}: CHANGELOG.md has no "## ${version}" entry`);
	}
}

/**
 * pnpm packs the workspace root LICENSE into every package that has none of
 * its own, so the packages carry no copies; this guards that behavior.
 */
function checkLicense(name: string, tarball: Tarball, pkg: PackageJson) {
	if (pkg.license !== license) {
		errors.push(`${name}: package.json license must be ${license}`);
	}
	const packed = tarball.files.get('LICENSE');
	if (!packed) {
		errors.push(`${name}: LICENSE is missing`);
	} else if (decoder.decode(packed) !== rootLicense) {
		errors.push(`${name}: LICENSE differs from the repository LICENSE`);
	}
}

function bundleImports(source: string): Set<string> {
	const specifiers = new Set<string>();
	for (const pattern of importPatterns) {
		for (const match of source.matchAll(pattern)) {
			specifiers.add(match[1]);
		}
	}
	return specifiers;
}

function report(name: string, version: string, tarball: Tarball, note = '') {
	const files = [...tarball.files.entries()]
		.map(([path, bytes]) => `${path} (${bytes.length})`)
		.join(', ');
	console.log(
		`${name}@${version}: ${tarball.size} bytes packed; ${files}${
			note ? `; ${note}` : ''
		}`,
	);
}
