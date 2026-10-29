// Checks the community registrations, community/<manifest id>.json, the way
// the catalog reads them (scripts/catalog.ts), without building the catalog:
// each file's name and fields; the registered version on npm with a `gety`
// manifest whose id is the file name and whose version is the registered one;
// its tarball against the registry's integrity, and its icon under the catalog
// icon rules; the author's GitHub user. Every failing file is reported with
// what failed. The Verify workflow runs it on every pull request.
//
//   deno task community:check                   check against npmjs.org
//   deno task community:check --registry <url>  registry to read
//
// GITHUB_TOKEN, when set, authenticates the GitHub API requests: anonymous
// ones are limited to 60 an hour.

import { communityCatalog, communityDir, defaultRegistry } from './catalog.ts';

let registry = defaultRegistry;
const args = Deno.args.filter((arg) => arg !== '--');
if (args.length > 0) {
	if (args.length !== 2 || args[0] !== '--registry') {
		console.error('usage: deno task community:check [--registry <url>]');
		Deno.exit(2);
	}
	registry = args[1];
}

try {
	const entries = await communityCatalog({
		registry,
		githubToken: Deno.env.get('GITHUB_TOKEN'),
		communityDir,
	});
	for (const entry of entries) {
		console.log(
			`${entry.package}@${entry.version}: ${entry.name}, by @${
				entry.author!.github
			} (GitHub id ${entry.author!.githubId})`,
		);
	}
	console.log(
		`${entries.length} community registration${
			entries.length === 1 ? '' : 's'
		} valid`,
	);
} catch (error) {
	console.error(`error: ${error instanceof Error ? error.message : error}`);
	Deno.exit(1);
}
