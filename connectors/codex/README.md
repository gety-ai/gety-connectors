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

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from local folder and select this repository.
3. Wait for the first poll to finish, then search for `Gety Sample Connector`.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`.
