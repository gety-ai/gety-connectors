# Gety connectors

The official [Gety](https://gety.ai) custom connectors. Each connector is a
TypeScript program run by Gety's Deno host, published to npm as its own package,
and installable with "Install from npm" in Gety or
`gety connector install --npm <package>`.

| Connector     | Directory                | npm package                    |
| ------------- | ------------------------ | ------------------------------ |
| Linear        | `connectors/linear`      | `@gety-connectors/linear`      |
| Codex         | `connectors/codex`       | `@gety-connectors/codex`       |
| Claude Code   | `connectors/claude-code` | `@gety-connectors/claude-code` |
| Google Chrome | `connectors/chrome`      | `@gety-connectors/chrome`      |
| Notion        | `connectors/notion`      | `@gety-connectors/notion`      |
| Feishu        | `connectors/lark`        | `@gety-connectors/lark`        |

A connector's directory name is its short name, and both its npm package name
(`@gety-connectors/<short>`) and its manifest `id` use it;
`deno task sync:check` enforces this.

`packages/catalog` is `@gety-connectors/catalog`, the generated list of these
connectors and of the community connectors registered in `community/` (name,
description, icon, registered npm version) that Gety's connector gallery reads;
see [its README](packages/catalog/README.md).

`packages/utils` (`@gety-connectors/utils`) and `packages/testing`
(`@gety-connectors/testing`) are workspace-only Deno packages, never published:
they have no `package.json`, so pnpm, changesets and `verify:packs` do not see
them. Connectors import utils by subpath (`@gety-connectors/utils/http`,
`/retry`, `/paginate`, ...; see `packages/utils/deno.json`) and esbuild bundles
the modules they use into `dist/main.js`. The testing helpers (`runPoll` with
the host's state-commit semantics, `jsonResponse`, the StartFrame budget) are
for tests only. A change to utils ships only through the connectors that bundle
it, so its changeset lists every affected connector.

Each connector directory keeps the git history of the repository it came from.

## Layout

```text
connectors/<short>/   one connector: manifest.json, src/, package.json (npm
                      metadata), CHANGELOG.md
packages/catalog/     @gety-connectors/catalog
community/            community connector registrations for the catalog
packages/utils/       shared runtime modules bundled into connectors (not published)
packages/testing/     test helpers for connectors (not published)
tools/                connector tooling shared by every connector (build,
                      config types, dev runner, SDK sync)
vendor/gety-deno/     byte-exact copy of Gety's Deno connector SDK and runner
scripts/              repository scripts (sync, catalog, version step, pack checks)
.changeset/           pending changesets
deno.json             Deno workspace (connectors, utils, testing) and repository tasks
package.json          pnpm workspace root (changesets only)
```

Two tools, two jobs:

- **Deno** builds, type-checks, tests, lints and formats everything. The root
  `deno.json` is a Deno workspace with every connector and the shared packages
  as members, so there is one `deno.lock`, one formatter/linter configuration
  for the repository scripts, and connectors import the shared packages by name.
  `nodeModulesDir` is `none`: Deno resolves `npm:` imports from its own cache
  and ignores pnpm's `node_modules`.
- **pnpm** only carries npm package metadata and runs changesets. No connector
  has npm dependencies.

## Development

Requirements: Deno 2.x (CI pins 2.8.1, the version Gety bundles), Node.js 22.14
or later (24 recommended) and pnpm 10 (`corepack enable` picks the version in
`package.json`).

```sh
pnpm install                    # changesets CLI
deno task --recursive check     # type-check every connector
deno task --recursive test
deno task --recursive build     # writes connectors/*/dist/
deno fmt --check && deno lint
deno task check:tools && deno task test:tools
deno task sync-sdk:check        # vendor/gety-deno is unmodified
deno task community:check       # community/ registrations (npm, GitHub)
```

Inside a connector directory the connector's own tasks work as before
(`deno task verify`, `deno task runner`, ...); see its README. They call the
shared scripts in `tools/`; `verify` only checks and never rewrites files
(`deno task fix` formats and applies lint fixes).

Build output (`dist/`) is not committed: CI builds it before packing, and npm is
the distribution channel. To install a connector from a local folder, run
`deno task build` in it first.

### Gety SDK

`@gety-ai/connector-sdk` is not published; the root `deno.json` maps it to
`vendor/gety-deno/sdk/src/mod.ts`, a copy of Gety's `connectors/deno` runtime
(SDK, host runner, schemas). Bundles keep the SDK import external: Gety provides
it at run time. `vendor/gety-deno/SOURCE.json` records the Gety commit and the
hash of every file; CI fails if a vendored file is edited. Refresh it from a
Gety checkout instead:

```sh
deno task sync-sdk ../gety --ref <commit>
```

The command also reports whether the Gety files that `tools/dev-runner.ts`
mirrors (sandbox arguments, state commit) changed since the last sync.

### Dev runner

`deno task runner` in a connector directory builds it and runs
`tools/dev-runner.ts`, which runs the connector the way Gety does: the vendored
host runner in a separate Deno process, with the sandbox arguments Gety derives
from the manifest `permissions` (a manifest without `permissions` runs
unrestricted, as in Gety), and Gety's state semantics: the state is committed
only when the poll ends successfully. Try a `permissions` value before putting
it in the manifest with `--permissions '<json>'`; `--full-access` runs
unrestricted, `--deno <path>` picks the Deno binary. See
`deno task runner -- --help`.

## Versions and manifests

The npm `version` in each connector's `package.json` is the single source of
truth for the connector's version, and changesets owns it. Everything else about
a connector comes from its `manifest.json`. `scripts/sync.ts` connects the two:

- it writes `version` into `manifest.json`;
- it regenerates `package.json` `gety` (the complete manifest, which Gety reads
  from npm), `files` (entry, source map, icon, `CHANGELOG.md`) and `description`
  from `manifest.json`.

After editing a `manifest.json`, run `deno task sync` and commit the result;
`deno task sync:check` (CI) fails when anything is out of sync. Never edit
`gety`, `files` or a manifest's `version` by hand.

## Releasing

Releases are driven by [changesets](https://changesets.dev) and
`.github/workflows/release.yml`.

1. A pull request that changes what a package ships adds a changeset:
   `pnpm changeset`, select the packages and bump types, and write the changelog
   line. Gety shows these CHANGELOG.md entries in its version dialog.
2. On every push to `main` with pending changesets, the release workflow
   force-pushes the version changes to the `changeset-release/main` branch. An
   open "chore: version packages" pull request from that branch updates with the
   push; when none is open, a maintainer opens it from the link in the job
   summary. Its version step (`pnpm version-packages`, `scripts/version.ts`)
   runs `changeset version` (versions, CHANGELOG.md), then the sync script
   (manifest.json, `gety`).
3. Merging that pull request makes the workflow build every connector, verify
   the tarballs (`deno task verify:packs`), pack the packages whose version is
   not on npm yet, publish them and push `<package>@<version>` tags. No GitHub
   Releases are created: Gety's "Install from GitHub" would treat them as
   connector releases without the assets it requires.
4. The same publish job then generates the catalog (`scripts/catalog.ts`): the
   connectors' names, descriptions and icons at the merged commit, with each
   connector's `latest` version and publish time read from the registry, and one
   entry per community registration in `community/`, read from the registered
   version on npm and the author's GitHub user (the job passes its
   `GITHUB_TOKEN` for the GitHub API). Every connector must be on npm at its
   `package.json` version; the step waits a few minutes for the registry's cache
   to catch up and then fails, naming the connectors it could not find. A
   community registration that no longer passes `deno task community:check`
   fails the step too. When the generated `getyCatalog` differs from the
   published one, the job publishes it with `npm publish` as the published
   catalog version plus a patch; otherwise it publishes nothing. The catalog is
   not managed by changesets (its `package.json` is `private` and has no
   version): a change to a connector's name, description or icon ships with that
   connector's release, and no catalog changeset is needed.
5. A push to `main` with nothing to version or publish (no pending changesets,
   every package version on npm), such as a merged community registration, runs
   the catalog job instead: the same catalog steps
   (`.github/actions/publish-catalog`), publishing the catalog when it changed.
   A push with pending changesets leaves the catalog to the release that
   follows, because the manifests may carry unreleased names, descriptions or
   icons; a community registration merged then is listed after that release.

If the publish job fails partway (a package or the catalog), re-run the failed
job: changesets skips the packages already on npm, and the catalog is generated
again; re-run a failed catalog job the same way. `deno task catalog` (without
`--out`) prints what would be published.

Only the publish and catalog jobs can mint an OIDC token (`id-token: write`);
the version job has `contents: write` to push its branch and
`pull-requests: read` to find the open pull request. The organization does not
allow GitHub Actions to create pull requests, so the workflow never opens one
itself. Pushes made with the workflow's `GITHUB_TOKEN` do not trigger
`verify.yml` on that pull request; the publish path re-runs the sync check and
tarball verification before packing.

npm only installs `latest` or an exact version in Gety, and npm never lets a
version be republished, so fix a bad release by publishing a new version.

### How publishing authenticates

Publishing uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is
no `NPM_TOKEN`. Provenance is attached automatically because the repository is
public. Under a pnpm workspace, `changeset publish` publishes with
`pnpm publish`
([`getPublishTool.ts`](https://github.com/changesets/changesets/blob/e2ee472cc6c901a0bb29781dac12603f6e4d5215/packages/cli/src/commands/publish/getPublishTool.ts),
[`lib/pnpm.ts`](https://github.com/changesets/changesets/blob/e2ee472cc6c901a0bb29781dac12603f6e4d5215/packages/cli/src/lib/pnpm.ts)).
pnpm 10, pinned in `package.json`, does not publish by itself: it runs the npm
CLI found next to the Node.js binary
([`publish.ts`](https://github.com/pnpm/pnpm/blob/v10.28.0/releasing/plugin-commands-publishing/src/publish.ts),
[`run-npm`](https://github.com/pnpm/pnpm/blob/v10.28.0/exec/run-npm/src/index.ts)),
and that npm performs the OIDC exchange. Trusted publishing needs npm 11.5.1 or
later and Node.js 22.14 or later; Node.js 24 ships a recent enough npm, and the
publish job checks the npm version before publishing. (pnpm 11 and later publish
natively and support trusted publishing themselves, see
[pnpm publish](https://pnpm.io/cli/publish); revisit this paragraph when
upgrading pnpm.)

### First publish (bootstrap)

npm can only configure a trusted publisher for a package that already exists, so
a maintainer publishes the first version of every package: the connectors first,
then the catalog, which lists them at their npm versions. Use an npm account
that owns the `@gety-connectors` org and has two-factor authentication enabled.
The first npm version of every connector is 0.1.0, published by hand from `main`
only to create the package; it carries no provenance. The repository starts with
one changeset per connector, so the version branch raises the connectors to
0.2.0, the first release from CI with provenance.

The Release workflow stays enabled throughout: while changesets are pending, a
push to `main` only updates `changeset-release/main`, and the publish job skips
versions already on npm.

1. Build and verify from a clean checkout of `main` (changesets pending,
   connectors at 0.1.0):

   ```sh
   pnpm install --frozen-lockfile
   deno task sync:check
   deno task --recursive build
   deno task verify:packs
   ```

2. Publish the six connectors at 0.1.0 (the catalog is `private`, so changesets
   skips it) and push the `<package>@0.1.0` tags that `changeset publish`
   creates, as the workflow does for its releases:

   ```sh
   npm login
   pnpm exec changeset publish --otp <one-time password>
   git push origin $(git tag --points-at HEAD)
   ```

   If the one-time password expires partway through, run the command again with
   a new one; packages already on npm are skipped. Publish the connectors with
   `changeset publish` (pnpm), not `npm publish`, so the LICENSE is packed.

3. Generate the catalog from the registry and publish it at 0.1.0. The command
   waits until the registry serves every connector at its `package.json` version
   (its cache can lag a few minutes behind a publish) and fails if one is
   missing; the directory must not exist yet, and it contains the LICENSE:

   ```sh
   deno task catalog --out /tmp/gety-connectors-catalog
   npm publish /tmp/gety-connectors-catalog --otp <one-time password>
   ```

4. For each package (the six connectors and `@gety-connectors/catalog`),
   configure the trusted publisher and allow it to publish. `npm trust` needs
   npm 11.10 or later and `--allow-publish` needs 11.15 or later, hence
   `npx npm@11`:

   ```sh
   for pkg in linear codex claude-code chrome notion lark catalog; do
     npx -y npm@11 trust github "@gety-connectors/$pkg" \
       --repo gety-ai/gety-connectors --file release.yml --allow-publish --yes
     sleep 2
   done
   ```

   The first call asks for two-factor authentication; choosing "skip for the
   next 5 minutes" on the npm website lets the rest proceed. Alternatively, set
   the same values on each package's Settings page on npmjs.com (publisher:
   GitHub Actions, organization `gety-ai`, repository `gety-connectors`,
   workflow `release.yml`, no environment) and enable "Allow npm publish".

5. Within two days of configuring the trusted publishers, merge
   `changeset-release/main` (connectors at 0.2.0): npm expires a trusted
   publisher that has not published within two days
   ([configuration expiry](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)).
   GitHub Actions cannot open pull requests in this organization, so open the
   "chore: version packages" pull request from the link in the summary of the
   latest Release run on `main`, check its CHANGELOG.md, manifest.json and
   `package.json` changes, and merge it. The release workflow publishes the six
   connectors at 0.2.0 and, because their versions changed, catalog 0.1.1. Check
   on npmjs.com that these versions show provenance.
6. On each package's Settings page, set Publishing access to "Require two-factor
   authentication and disallow tokens", so only the trusted publisher (and
   maintainers with 2FA) can publish.
7. Optionally, once 0.2.0 is live, deprecate the bootstrap versions with
   `npm deprecate @gety-connectors/<short>@0.1.0 "<reason>"`; each call asks for
   two-factor authentication on the npm website.

## Adding a connector

1. Create `connectors/<short>/` with the connector (same layout and tasks as the
   existing ones; manifest `id` set to `<short>`) and add it to `workspace` in
   `deno.json`.
2. Add `package.json` with `name` `@gety-connectors/<short>`, `version` equal to
   the manifest's, `license` `Apache-2.0`, `repository` (`directory`:
   `connectors/<short>`), `publishConfig.access: public`, and a `CHANGELOG.md`
   with an entry for that version (copy an existing connector's files); run
   `deno task sync`.
3. Publish the new package's first version by hand before the next release run
   (bootstrap steps 1, 2, 4 and 6, for that one package): the release workflow
   cannot publish a package npm does not know, and its catalog step fails while
   a connector in the repository is not on npm. The catalog lists the new
   connector from the next release on; no catalog changeset is needed. To list
   it right away, run bootstrap step 3.

## License

[Apache-2.0](LICENSE). Packages carry no copy of the license: pnpm packs the
workspace root `LICENSE` into every package that has none of its own, and
`deno task verify:packs` checks it is there. Plain `npm pack`/`npm publish`
would leave it out, so publish the connectors only through changesets (which
uses pnpm here). The catalog is the exception: `scripts/catalog.ts` copies the
`LICENSE` into the directory it writes, which is published with `npm publish`.
