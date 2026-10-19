// Keeps every connector's manifest.json and package.json in sync.
//
// package.json `version` (owned by changesets) is the source of truth for the
// version; manifest.json is the source of truth for everything else. This
// script writes the version into manifest.json and regenerates package.json
// `description`, `files` and `gety` (the full manifest) from it.
//
//   deno task sync         write the derived fields
//   deno task sync:check   fail if anything is out of sync (CI)

import {
	type Connector,
	exists,
	formatJson,
	license,
	listConnectors,
	type Manifest,
	oneLine,
	packageFiles,
	type PackageJson,
	readJson,
	repositoryUrl,
	setManifestVersion,
} from './connectors.ts';

export interface SyncResult {
	/** Files whose content differs from the synced content. */
	outOfSync: string[];
	/** Problems the script cannot fix by itself. */
	errors: string[];
}

export async function syncConnectors(write: boolean): Promise<SyncResult> {
	const result: SyncResult = { outOfSync: [], errors: [] };
	for (const connector of await listConnectors()) {
		await syncConnector(connector, write, result);
	}
	return result;
}

async function syncConnector(
	connector: Connector,
	write: boolean,
	result: SyncResult,
): Promise<void> {
	const label = `connectors/${connector.short}`;
	const manifestPath = new URL('manifest.json', connector.dir);
	const packagePath = new URL('package.json', connector.dir);
	if (!(await exists(packagePath))) {
		result.errors.push(`${label}: package.json is missing`);
		return;
	}
	const pkg = await readJson<PackageJson>(packagePath);
	const manifestText = await Deno.readTextFile(manifestPath);
	const syncedManifestText = setManifestVersion(manifestText, pkg.version);
	const manifest = JSON.parse(syncedManifestText) as Manifest;

	if (manifest.id !== connector.short) {
		result.errors.push(
			`${label}/manifest.json: id must be "${connector.short}", the directory and package short name`,
		);
	}
	if (pkg.name !== connector.packageName) {
		result.errors.push(
			`${label}/package.json: name must be ${connector.packageName}`,
		);
	}
	if (
		pkg.repository?.url !== repositoryUrl ||
		pkg.repository?.directory !== label
	) {
		result.errors.push(
			`${label}/package.json: repository must be { url: ${repositoryUrl}, directory: ${label} }`,
		);
	}
	if (pkg.publishConfig?.access !== 'public') {
		result.errors.push(
			`${label}/package.json: publishConfig.access must be public`,
		);
	}
	if (pkg.license !== license) {
		result.errors.push(`${label}/package.json: license must be ${license}`);
	}
	if (!(await exists(new URL('CHANGELOG.md', connector.dir)))) {
		result.errors.push(`${label}: CHANGELOG.md is missing`);
	}
	if (
		!manifest.icon || !(await exists(new URL(manifest.icon, connector.dir)))
	) {
		result.errors.push(
			`${label}: manifest.json icon must name an existing file`,
		);
	}

	pkg.description = oneLine(manifest.description);
	pkg.files = packageFiles(manifest);
	pkg.gety = manifest;
	const syncedPackageText = formatJson(pkg);

	if (syncedManifestText !== manifestText) {
		result.outOfSync.push(`${label}/manifest.json`);
		if (write) {
			await Deno.writeTextFile(manifestPath, syncedManifestText);
		}
	}
	if (syncedPackageText !== (await Deno.readTextFile(packagePath))) {
		result.outOfSync.push(`${label}/package.json`);
		if (write) {
			await Deno.writeTextFile(packagePath, syncedPackageText);
		}
	}
}

if (import.meta.main) {
	const check = Deno.args.includes('--check');
	const { outOfSync, errors } = await syncConnectors(!check);
	if (check && outOfSync.length > 0) {
		errors.push(
			...outOfSync.map((file) =>
				`${file} is out of sync with package.json version / manifest.json; run \`deno task sync\``
			),
		);
	} else {
		for (const file of outOfSync) {
			console.log(`synced ${file}`);
		}
	}
	if (errors.length > 0) {
		for (const error of errors) {
			console.error(`error: ${error}`);
		}
		Deno.exit(1);
	}
	console.log(check ? 'everything is in sync' : 'sync complete');
}
