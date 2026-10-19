# Linear Connector

This Gety custom connector indexes Linear issues as markdown documents.

## Current Scope

- Authenticates with a Linear personal API key.
- Requires Gety 0.7.0 or later and may only reach `api.linear.app` (manifest
  `permissions`).
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
- Deletes archived or trashed Linear issues from Gety's index, and issues that
  Linear reports as not found when a changed comment points at them.
- Runs every 5 minutes and processes issue sync page by page, up to 500 issues
  per poll. Comment delta sync runs only after issue pagination is caught up.
  The poll's state is committed only when the whole poll succeeds.
- Retries network errors, timeouts, rate limits, and server errors; requests
  time out after 60 seconds and stop when Gety cancels the poll.
- Polling cannot see issues or comments hard-deleted in Linear without being
  archived first; run Rebuild index on the connector in Gety to drop them.

See `docs/advanced-sync.md` for webhook and deeper incremental sync notes.

## Files

- `manifest.json` declares the connector metadata, config form, and
  `dist/main.js` runtime entry.
- `src/index.ts` contains the poll orchestration; `src/graphql.ts` is the Linear
  GraphQL client, and `src/issue.ts` and `src/comment.ts` hold the queries and
  markdown rendering.
- `dist/main.js` is the build output loaded by Gety (`deno task build`; not
  committed).
- `dist/main.js.map` is its source map, published with it to make debugging the
  bundled entry easier.
- `@gety-ai/connector-sdk` resolves to the repository's vendored copy of the
  Gety SDK (`vendor/gety-deno`); the bundle keeps it external.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map. The connector talks to Linear's GraphQL API with
its own small client (`src/graphql.ts`) on the repository's shared HTTP helpers;
those helpers and the markdown libraries are bundled into `dist/main.js`.

`deno task verify` checks formatting and lint, runs type checking and tests,
then builds; it does not rewrite files (`deno task fix` formats and applies safe
lint fixes). `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Tests use Deno's built-in test runner. Unit tests cover markdown rendering,
cursor transitions, and the GraphQL client's error and rate-limit handling.
`src/poll.test.ts` runs whole polls against an in-memory fake of Linear's API
(`src/fake_linear.ts`): rebuilds, the 500-issue cap, comment cursors, deletes,
retries, cancellation, and malformed responses. No test needs network access or
a Linear API key.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`deno task runner` builds the connector and runs the repository's
`tools/dev-runner.ts`, which runs it the way Gety does: Gety's host runner in a
separate Deno process, sandboxed by the manifest `permissions` (unrestricted
when the manifest declares none), with config values from `.env`, the last
committed state, and the data and home directories. Each poll cycle is a fresh
process, matching Gety's one-shot Deno runner lifecycle, and its state is
committed only when the poll ends successfully. `deno task runner -- --help`
lists the options.

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
3. Install from npm (`@gety-connectors/linear`), or run `deno task build` and
   install from this local folder (build output is not committed).
4. Enter the Linear API key.
5. Wait for the first poll to finish, then search for a Linear issue key or
   title.

After changing files under `src/`, run `deno task build`, then use Restart in
Gety to load the new `dist/main.js`.
