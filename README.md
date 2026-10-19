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
connectors (name, description, icon) that Gety's connector gallery reads; see
[its README](packages/catalog/README.md).

Each connector directory keeps the git history of the repository it came from.

## Layout

```text
connectors/<short>/   one connector: manifest.json, src/, scripts/build.ts,
                      package.json (npm metadata), CHANGELOG.md
packages/catalog/     @gety-connectors/catalog
scripts/              repository scripts (sync, catalog, version step, pack checks)
.changeset/           pending changesets
deno.json             Deno workspace (all connectors) and repository tasks
package.json          pnpm workspace root (changesets only)
```

Two tools, two jobs:

- **Deno** builds, type-checks, tests, lints and formats everything. The root
  `deno.json` is a Deno workspace with every connector as a member, so there is
  one `deno.lock`, one formatter/linter configuration for the repository
  scripts, and connectors can later share workspace packages by name.
  `nodeModulesDir` is `none`: Deno resolves `npm:` imports from its own cache
  and ignores pnpm's `node_modules`.
- **pnpm** only carries npm package metadata and runs changesets. No connector
  has npm dependencies.

## Development

Requirements: Deno 2.x, Node.js 22.14 or later (24 recommended) and pnpm 10
(`corepack enable` picks the version in `package.json`).

```sh
pnpm install                    # changesets CLI
deno task --recursive check     # type-check every connector
deno task --recursive test
deno task --recursive build     # writes connectors/*/dist/
deno fmt && deno lint
```

Inside a connector directory the connector's own tasks work as before
(`deno task verify`, `deno task runner`, ...); see its README.

Build output (`dist/`) is not committed: CI builds it before packing, and npm is
the distribution channel. To install a connector from a local folder, run
`deno task build` in it first.

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
2. On every push to `main` with pending changesets, the release workflow opens
   or updates the "chore: version packages" pull request. Its version step
   (`pnpm version-packages`, `scripts/version.ts`) runs `changeset version`
   (versions, CHANGELOG.md), then the sync script (manifest.json, `gety`), then
   regenerates the catalog. When the catalog content changed (a connector's
   name, description or icon) and no changeset already bumped the catalog, the
   catalog gets a patch bump and a changelog entry so it is republished. The
   catalog's `getyCatalog` field is written only here; never edit it by hand.
3. Merging that pull request makes the workflow build every connector, verify
   the tarballs (`deno task verify:packs`), pack the packages whose version is
   not on npm yet, publish them and push `<package>@<version>` tags. No GitHub
   Releases are created: Gety's "Install from GitHub" would treat them as
   connector releases without the assets it requires.

Only the publish job can mint an OIDC token (`id-token: write`); the version job
has `contents: write` and `pull-requests: write`. In the repository settings
(Actions → General), allow GitHub Actions to create pull requests. Pull requests
opened with the workflow's `GITHUB_TOKEN` do not trigger `verify.yml`; the
publish path re-runs the sync check and tarball verification before packing.

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
the first version of every package is published by a maintainer. Use an npm
account that owns the `@gety-connectors` org and has two-factor authentication
enabled. The repository starts with one changeset per connector, which makes the
first npm release 0.2.0 for every connector (0.1.0 was the pre-npm version from
the connector's own repository). The catalog keeps its own version and is first
published at 0.1.0.

1. Push `main`. The release workflow finds the pending changesets and opens the
   "chore: version packages" pull request (connectors at 0.2.0). Check its
   CHANGELOG.md, manifest.json and `package.json` changes.
2. Disable the Release workflow (Actions → Release → Disable workflow), so that
   merging the pull request does not try to publish packages npm does not know
   yet, then merge it.
3. Build and verify from a clean checkout of the merged `main`:

   ```sh
   pnpm install --frozen-lockfile
   deno task sync:check
   deno task --recursive build
   deno task verify:packs
   ```

4. Publish every package at its current version and push the tags:

   ```sh
   npm login
   pnpm exec changeset publish --otp <one-time password>
   git push origin --tags
   ```

   If the one-time password expires partway through, run the command again with
   a new one; packages already on npm are skipped. Publish with
   `changeset
   publish` (pnpm), not `npm publish`, so the LICENSE is packed.

5. For each package (the six connectors and `@gety-connectors/catalog`),
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

6. Enable the Release workflow again.
7. Within two days, validate the setup with a release from CI: merge a pull
   request with a changeset for every package (for example a patch "Publish from
   CI with provenance"), then merge the "chore: version packages" pull request
   and check that the release workflow publishes all seven packages.
8. On each package's Settings page, set Publishing access to "Require two-factor
   authentication and disallow tokens", so only the trusted publisher (and
   maintainers with 2FA) can publish.

## Adding a connector

1. Create `connectors/<short>/` with the connector (same layout and tasks as the
   existing ones) and add it to `workspace` in `deno.json`.
2. Add `package.json` with `name` `@gety-connectors/<short>`, `version` equal to
   the manifest's, `repository` (`directory`: `connectors/<short>`),
   `publishConfig.access: public`, and a `CHANGELOG.md` with an entry for that
   version (copy an existing connector's files); run `deno task sync`.
3. Add a changeset for the catalog so the next release includes the new
   connector. The first publish of the new package is manual: follow the
   bootstrap steps for that one package.

## License

[Apache-2.0](LICENSE). Packages carry no copy of the license: pnpm packs the
workspace root `LICENSE` into every package that has none of its own, and
`deno task verify:packs` checks it is there. Plain `npm pack`/`npm publish`
would leave it out, so publish only through changesets (which uses pnpm here).
