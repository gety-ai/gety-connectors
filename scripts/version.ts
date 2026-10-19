// The version step (run by the release workflow's version job and
// by `pnpm version-packages` locally):
//
// 1. `changeset version` bumps package.json versions and writes CHANGELOG.md.
// 2. The new versions are synced into manifest.json and package.json `gety`.
// 3. The catalog is regenerated; when its content changed and changesets did
//    not already bump the catalog, it gets a patch bump and a changelog entry
//    so the new catalog is published.

import { catalogPackagePath } from './catalog.ts';
import { catalogDrift, syncConnectors } from './sync.ts';
import {
	catalogDir,
	formatJson,
	type PackageJson,
	readJson,
} from './connectors.ts';

const versionBefore = (await readJson<PackageJson>(catalogPackagePath)).version;

const changeset = await new Deno.Command('pnpm', {
	args: ['exec', 'changeset', 'version'],
	stdout: 'inherit',
	stderr: 'inherit',
}).output();
if (!changeset.success) {
	Deno.exit(changeset.code);
}

const { outOfSync, errors } = await syncConnectors(true);
for (const file of outOfSync) {
	console.log(`synced ${file}`);
}
if (errors.length > 0) {
	for (const error of errors) {
		console.error(`error: ${error}`);
	}
	Deno.exit(1);
}

const { drifted, generated } = await catalogDrift();
if (drifted) {
	const catalog = await readJson<PackageJson & { getyCatalog?: unknown }>(
		catalogPackagePath,
	);
	catalog.getyCatalog = generated;
	if (catalog.version === versionBefore) {
		catalog.version = bumpPatch(catalog.version);
		await prependChangelog(catalog.name, catalog.version);
	}
	await Deno.writeTextFile(catalogPackagePath, formatJson(catalog));
	console.log(`regenerated packages/catalog (version ${catalog.version})`);
}

function bumpPatch(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(
			`packages/catalog: cannot auto-bump version ${version}; add a changeset for the catalog instead`,
		);
	}
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** Adds a release entry in the format changesets writes. */
async function prependChangelog(name: string, version: string): Promise<void> {
	const path = new URL('CHANGELOG.md', catalogDir);
	const text = await Deno.readTextFile(path);
	const heading = `# ${name}\n\n`;
	if (!text.startsWith(heading)) {
		throw new Error(
			`packages/catalog/CHANGELOG.md must start with "# ${name}"`,
		);
	}
	const entry =
		`## ${version}\n\n### Patch Changes\n\n- Regenerated the catalog from the connector manifests and icons.\n\n`;
	await Deno.writeTextFile(path, heading + entry + text.slice(heading.length));
}
