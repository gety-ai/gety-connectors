# Linear Connector

This Gety custom connector indexes Linear issues as markdown documents.

## Current Scope

- Authenticates with a Linear personal API key.
- Indexes Linear issues with `doc_type: "linear:issue"`.
- Stores each issue as markdown so Gety can render the source preview when the
  search result has `content_format: "markdown"`.
- Uses each issue's Linear URL as the Gety doc link.
- Re-upserts changed issues using `updatedAt` incremental polling.
- Deletes archived or trashed Linear issues from Gety's index.

See `docs/advanced-sync.md` for comments, webhook, and deeper incremental sync
research.

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

## Install In Gety

1. Create a personal API key in Linear settings.
2. Open Gety's Custom Connectors settings page.
3. Install from local folder and select this repository.
4. Enter the Linear API key.
5. Wait for the first poll to finish, then search for a Linear issue key or
   title.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`.
