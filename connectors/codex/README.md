# Codex Connector

This Gety custom connector indexes local Codex session JSONL logs as searchable
markdown documents.

## Scope

- Creates one `codex:session` document per Codex session. Codex continues a long
  session in segment files (`rollout-<time>-<session id>_<segment id>.jsonl`);
  all segments of a session are merged, in order, into its document, and a
  change to any of them rebuilds it from all of them.
- Uses the session summary as the title when available, otherwise falls back to
  the first user prompt.
- Adds a short session block with workspace roots and model when available.
- Indexes user messages and Codex final answers.
- Skips prompt-only sessions that do not have a Codex final answer. This applies
  to the merged segments: if removing a segment leaves a session without a Codex
  final answer, its document is deleted like any other prompt-only one.
- Renders Codex as `Codex`, not `Assistant`.
- Separates conversation rounds with `---`.
- Never indexes tool outputs. Their log lines, like reasoning and event lines,
  are recognized from their first bytes and skipped without being decoded.
- Can include brief tool call summaries through a config checkbox. This is off
  by default.
- Can include archived sessions through a config checkbox. This is on by
  default.
- Can include subagent sessions (sessions Codex spawned for another session)
  through a config checkbox. This is off by default. Each session, subagent or
  not, is filed under its own session id.
- Scans all candidate logs during the first poll, yielding real document updates
  as each indexable session is parsed.
- On later polls, lists and stats candidate logs, but only parses files whose
  mtime or size changed.
- Tracks lightweight file fingerprints in connector state so changed files,
  removed files, and config changes can update only the affected session docs.
  Gety commits the state only when a poll succeeds. A poll that finds nothing
  changed sends no state at all, and Gety keeps the committed one.
- Limits each document's content to 8,000,000 UTF-8 bytes; longer sessions are
  cut there and marked with `content_truncated` in the metadata.

The connector reads only `~/.codex/sessions` and `~/.codex/archived_sessions`,
which are the only read permissions its manifest requests (it cannot read the
rest of `~/.codex`, such as `auth.json`). `~` is the home directory Gety passes
in; `CODEX_HOME` is not supported. The `archived_sessions` directory is read
only when archived sessions are enabled.

A missing `~/.codex/sessions` directory fails the poll instead of counting as an
empty one, so the index is never cleared because the directory could not be
found. A missing `archived_sessions` directory counts as empty, since Codex may
not have archived any session yet.

Normal incremental polls do not reread unchanged JSONL content. They compare the
current file list with the stored fingerprints and remove previously indexed
sessions when their last source file disappears. If a file disappears while a
poll is running, that poll deletes and rebuilds nothing for its session; the
next one does.

## Files

- `manifest.json` declares the connector metadata, config form, and
  `dist/main.js` runtime entry.
- `assets/codex-color.svg` is the connector icon shown in Gety.
- `src/index.ts` contains the connector poll/state logic.
- `src/codex_log.ts` contains Codex JSONL scanning, parsing, and markdown
  rendering.
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
runtime through its import map.

`deno task verify` checks formatting and lint, runs type checking and tests,
then builds; it does not rewrite files (`deno task fix` formats and applies safe
lint fixes). `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and cover JSONL parsing, markdown
rendering, state transitions, and whole polls against temporary directories.
They do not read your real Codex history.

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

Config environment variables are derived from manifest field IDs:

- `GETY_CONFIG_INCLUDE_TOOL_CALLS` or `INCLUDE_TOOL_CALLS`
- `GETY_CONFIG_INCLUDE_ARCHIVED_SESSIONS` or `INCLUDE_ARCHIVED_SESSIONS`
- `GETY_CONFIG_INCLUDE_SUBAGENTS` or `INCLUDE_SUBAGENTS`

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
deno task runner -- --state dev/.runner/codex-state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from npm (`@gety-connectors/codex`), or run `deno task build` and
   install from this local folder (build output is not committed).
3. Configure whether tool call summaries, archived sessions and subagent
   sessions should be indexed.
4. Wait for the first poll to finish, then search for a Codex session title or
   prompt.

After changing files under `src/`, run `deno task build`, then use Restart in
Gety to load the new `dist/main.js`.
