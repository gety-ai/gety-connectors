// The version step (run by the release workflow's version job and
// by `pnpm version-packages` locally):
//
// 1. `changeset version` bumps package.json versions and writes CHANGELOG.md.
// 2. The new versions are synced into manifest.json and package.json `gety`.
//
// The catalog is not part of it: the release workflow generates and publishes
// it after publishing the connectors (scripts/catalog.ts).

import { syncConnectors } from './sync.ts';

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
