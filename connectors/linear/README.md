# Linear Connector

This Gety custom connector indexes Linear issues as markdown documents.

## Current Scope

- Authenticates with a Linear personal API key.
- Indexes Linear issues with `doc_type: "linear:issue"`.
- Stores each issue as markdown so Gety can render the source preview when the
  search result has `content_format: "markdown"`.
- Appends Linear comments into the issue markdown when `index_comments` is
  enabled and the issue has visible comments.
- Converts markdown images in issue descriptions and comments into normal links
  so the Gety preview does not load remote images inline.
- Uses each issue's Linear URL as the Gety doc link.
- Re-upserts changed issues using `updatedAt` incremental polling.
- Rebuilds affected issue documents when comments are created, edited, resolved,
  or archived.
- Deletes archived or trashed Linear issues from Gety's index.

See `docs/advanced-sync.md` for webhook and deeper incremental sync notes.

## Files

- `manifest.json` declares the connector metadata, config form, and
  `dist/main.js` runtime entry.
- `src/index.ts` contains the connector source code.
- `dist/main.js` is the committed build output loaded by Gety.
- `dist/main.js.map` is committed to make debugging the bundled entry easier.
- `dev/gety-connector-sdk/mod.ts` is a local development shim so `deno check`
  and the build script do not require the Gety SDK to be installed.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map. The Linear SDK is bundled into `dist/main.js`.

`deno task verify` formats code, applies safe lint fixes, runs type checking,
then builds. `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and cover stable pure functions such
as markdown rendering and incremental timestamp boundaries. They do not require
network access or a Linear API key.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`dev/runner.ts` is a generic local runner for the Gety connector runtime
contract. It reads `manifest.json`, imports the manifest `entry` (`dist/main.js`
by default), builds config values from `.env`, injects `config`, `lastState`,
and `signal`, then runs `onLoad()` and `poll()`. Each poll cycle creates a fresh
connector instance and runs `onLoad()`, matching Gety's one-shot Deno runner
lifecycle.

Config environment variables are derived from manifest field IDs. For example,
`api_key` can be set as `GETY_CONFIG_API_KEY` or `API_KEY`, and `index_comments`
can be set as `GETY_CONFIG_INDEX_COMMENTS` or `INDEX_COMMENTS`. Optional fields
without `.env` values use the same implicit defaults as Gety's install form:
strings become `""`, numbers become `0`, and checkboxes become `false`.

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
deno task runner -- --state dev/.runner/linear-state.json --out-dir dev/runs
```

## Install In Gety

1. Create a personal API key in Linear settings.
2. Open Gety's Custom Connectors settings page.
3. Install from local folder and select this repository.
4. Enter the Linear API key.
5. Wait for the first poll to finish, then search for a Linear issue key or
   title.

After changing files under `src/`, run `deno task build`, then use Restart in
Gety to load the new `dist/main.js`.
