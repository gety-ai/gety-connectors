# Gety Sample Connector

This is a minimal runnable Gety custom connector. It emits a small set of fixed
documents that link to <https://gety.ai/>.

## Files

- `manifest.json` declares the connector metadata and uses `dist/main.js` as the
  Gety runtime entry.
- `src/index.ts` contains the connector source code.
- `dist/main.js` is the committed build output loaded by Gety.
- `dist/main.js.map` is committed to make debugging the bundled entry easier.
- `dev/gety-connector-sdk/mod.ts` is a local development shim so `deno check`
  and the build script do not require the npm SDK to be installed.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map.

`deno task verify` formats code, applies safe lint fixes, runs type checking,
then builds. `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and cover stable connector behavior.
They do not require network access.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`dev/runner.ts` is a generic local runner for the Gety connector runtime
contract. It is not sample-specific: it reads `manifest.json`, imports the
manifest `entry` (`dist/main.js` by default), builds config values from `.env`,
injects `config`, `lastState`, and `signal`, then runs `onLoad()` and `poll()`.
Each poll cycle creates a fresh connector instance and runs `onLoad()`, matching
Gety's one-shot Deno runner lifecycle.

Config environment variables are derived from manifest field IDs. For example, a
field named `api_key` can be set as `GETY_CONFIG_API_KEY` or `API_KEY`, and a
nested field named `auth.api_key` can be set as `GETY_CONFIG_AUTH_API_KEY` or
`AUTH_API_KEY`. This sample connector has no config fields, so `.env.example`
only documents that no values are required. Optional fields without `.env`
values use the same implicit defaults as Gety's install form: strings become
`""`, numbers become `0`, and checkboxes become `false`.

Runner output is written outside git:

```text
dev/runs/<timestamp>/
  summary.json
  state.before.json
  state.after.json
  updates.json
  deletes.json
  docs/
    0001-<doc_type>__<doc_id>.md
    0001-<doc_type>__<doc_id>.json
```

The persistent runner state lives at `dev/.runner/state.json`, so repeated runs
exercise incremental sync. Use `--reset-state` to start from an empty state.
Optional flags:

```bash
deno task runner -- --polls 3 --interval 60
deno task runner -- --state dev/.runner/sample-state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from local folder and select this repository.
3. Wait for the first poll to finish, then search for `Gety Sample Connector`.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`.
