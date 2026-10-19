# AGENTS.md

Conventions for coding agents working in this repository. Read README.md for the
full picture (layout, release flow, bootstrap).

## Repository shape

- `connectors/<short>/`: one Gety connector each (linear, codex, claude-code,
  chrome, notion, lark), published as `@gety-connectors/<short>`.
- `packages/catalog/`: `@gety-connectors/catalog`, generated and published by
  the release workflow after the connectors; `package.json` there is metadata
  only and `private`.
- `packages/utils/` (`@gety-connectors/utils`) and `packages/testing/`
  (`@gety-connectors/testing`): private Deno workspace packages without a
  `package.json`; never published. Connectors import utils by subpath and bundle
  it; testing is imported from tests only.
- `scripts/`: repository scripts, run through the tasks in the root `deno.json`.
- `tools/`: tooling every connector's tasks call (`build.ts`,
  `generate-manifest-config.ts`, `dev-runner.ts` with its sandbox derivation
  `sandbox.ts`) and `sync-sdk.ts`.
- `vendor/gety-deno/`: byte-exact copy of Gety's Deno connector SDK and host
  runner; the root import map points `@gety-ai/connector-sdk` at it.
- The root `deno.json` is a Deno workspace listing every connector and the
  shared packages; there is a single root `deno.lock`. pnpm is used only for
  package metadata and changesets.

## Commands

Run from the repository root unless noted.

```sh
pnpm install                    # once, for the changesets CLI
deno task --recursive check     # type-check (also regenerates src/gen/manifest.d.ts)
deno task --recursive test
deno task --recursive build     # connectors/*/dist/, needed before verify:packs
deno fmt --check && deno lint
deno task check:tools           # type-check tools/, scripts/ and the vendored runner
deno task test:tools            # tests in tools/ and scripts/
deno task sync:check            # versions, manifests, gety
deno task sync-sdk:check        # vendor/gety-deno matches SOURCE.json
deno task verify:packs          # pack every package and inspect the tarballs
```

`deno task <name>` inside `connectors/<short>/` runs that connector's tasks
(`verify`, `runner`, ...). `verify` only checks; `fix` rewrites files
(`deno fmt`, `deno lint --fix`). `runner` runs the connector under Gety's
sandbox and state semantics (`-- --help` lists its options).

## Rules

- **Connector behavior**: a connector's published entry (`dist/main.js`) must be
  a self-contained esbuild bundle. Sandboxed connectors cannot import `npm:`,
  `jsr:` or `https:` modules at run time; the bundle may only import `node:*`
  built-ins and `@gety-ai/connector-sdk` (provided by the host). `verify:packs`
  enforces this.
- **Versions**: never edit a `version` field, a manifest's `version`, or
  `package.json` `gety`/`files`/`description` by hand. Changesets owns
  `package.json` `version`; `deno task sync` derives the rest from
  `manifest.json`. After editing a `manifest.json`, run `deno task sync` and
  commit both files.
- **Changesets**: every change to what a package ships (source, manifest, icon,
  README content users see) needs a changeset in `.changeset/`
  (`pnpm changeset`, or write the file: front matter
  `"@gety-connectors/<short>": patch|minor|major`, then one changelog line). Do
  not run `changeset version` or edit `CHANGELOG.md` by hand; the release
  workflow does that.
- **Catalog**: never add `version` or `getyCatalog` to
  `packages/catalog/package.json`, never remove its `private`, and never write a
  changeset for `@gety-connectors/catalog`. After the connectors are published,
  the release workflow builds it (`scripts/catalog.ts`) from the manifests'
  `name`, `description` and icon and each connector's npm `latest` version and
  publish time, and publishes it with a patch bump when it changed.
- **Shared packages**: utils is not versioned; its code ships inside each
  connector bundle. A change to `packages/utils` needs a changeset listing every
  connector that imports the changed module. Do not add a `package.json` to
  utils or testing.
- **Build output**: `dist/` is not committed. Do not add it back.
- **Generated files**: `connectors/*/src/gen/manifest.d.ts` is generated from
  `manifest.json` by the connector's `check`/`build` tasks and is committed; CI
  fails if it is stale.
- **Vendored SDK**: never edit `vendor/gety-deno/`; `sync-sdk:check` fails on
  any change. Refresh it with `deno task sync-sdk <gety checkout> --ref <rev>`
  and review `tools/sandbox.ts`/`tools/dev-runner.ts` when it reports that the
  mirrored Gety files changed.
- **Connector tooling**: connector `deno.json` tasks call the shared scripts in
  `tools/`; do not copy them back into a connector.
- **Dependencies**: connectors import dependencies as `npm:`/`jsr:` specifiers
  in their own `deno.json`; esbuild bundles them. Do not add npm dependencies to
  any `package.json` (the root one only holds `@changesets/cli`). After
  dependency changes, commit the updated root `deno.lock`.
- **Adding a connector**: add it to `workspace` in `deno.json`, set its manifest
  `id` to the directory name (`sync:check` enforces it), give it a
  `package.json` and `CHANGELOG.md` like the others and run `deno task sync`.
  Its first npm publish is manual and must precede the next release run, whose
  catalog step fails while a connector is not on npm (README, "Adding a
  connector").
- **Workflows**: `.github/workflows/release.yml` must keep that file name; npm
  trusted publishers are bound to it. Do not add npm tokens; publishing uses
  OIDC. Lint workflow changes with `actionlint`.
- **Releases**: never run `npm publish`, `pnpm publish` or `changeset publish`
  yourself.
- **License**: everything is Apache-2.0 (root `LICENSE`). Every published
  `package.json` has `"license": "Apache-2.0"`; do not add per-package LICENSE
  copies, pnpm packs the root one and `scripts/catalog.ts` copies it into the
  catalog package (`verify:packs` checks both).

## Style

- Formatting is `deno fmt` (tabs, single quotes, 80 columns); linting is
  `deno lint` with the recommended rules.
- Commits follow Conventional Commits (`feat`, `fix`, `refactor`, `test`,
  `docs`, `build`, `ci`, `chore`); scope connector changes with the connector's
  short name, e.g. `fix(notion): ...`. Keep commits atomic and stage paths
  explicitly.
