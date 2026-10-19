# Claude Code

A Gety custom connector that indexes
[Claude Code](https://claude.com/claude-code) chat sessions from the local
Claude Code projects directory so they are searchable in Gety.

Each Claude Code session is stored as a JSONL file under `~/.claude/projects`.
This connector turns indexable session `.jsonl` files into Gety documents
containing the conversational text as markdown. Subagent/workflow logs under a
`subagents/` path segment are skipped by default because they are implementation
details of a parent session rather than user-level conversations; they can be
included with the `include_subagents` checkbox.

## Data source

The connector reads `~/.claude/projects` (on Windows,
`%USERPROFILE%\.claude\projects`), where `~` is the home directory Gety passes
in. It is the only read permission the manifest requests. There is no connector
setting for the folder path; the `include_subagents` checkbox defaults to false.

A missing projects directory, or one the connector cannot read, fails the poll
instead of counting as empty, so the index is never cleared because the
directory could not be found.

## Document model

- A `.jsonl` file is indexed only when it has at least one rendered user message
  and at least one rendered Claude Code response. Empty, malformed, tool-only,
  prompt-only, and assistant-only sessions are skipped.
- Stable id: `claude-code:<sha256(relative path)>`.
- `doc_type`: `claude_code:session`.
- `content_format`: `markdown`.
- Title: `ai-title`/`aiTitle` record if present, else the first meaningful user
  text snippet, else the session id / file basename.
- Content: only user and assistant **text** is rendered. Slash-command user
  prompts keep the command name (for example,
  `` Command: `/code-review-expert` ``) and the command arguments while dropping
  the XML wrapper tags. Injected context such as `<environment_context>`,
  local-command records, and AGENTS.md instruction blocks is skipped.
  `tool_use`, `tool_result`, `thinking`, and other non-text message parts are
  omitted entirely. Messages with no text after skipping parts are omitted.
- The markdown body follows the Codex connector shape: `# {title}`,
  `## Session`, a `---` separator, then `## User` / `## Claude Code` sections
  grouped by conversation round. Parse-error and truncation facts are recorded
  in metadata and are never appended to the body.
- The `## Session` section includes only Project, Model, and Git branch (when
  available). Model identifiers are prettified (e.g. `claude-opus-4-8` ->
  `Claude Opus 4.8`).
- `metadata.url` is a stable `file://` URL for the source JSONL file. The
  manifest declares `doc_link: { "kind": "url", "field": "url" }` so Gety can
  open the local source file.
- `doc_updated_at` is the last message timestamp (else file mtime).
  `metadata.created_at` is the first message timestamp when available.
- Metadata includes `project`, `session_id`, `path`, `source_path`, `url`,
  `model`, `git_branch`, `message_count`, `user_message_count`,
  `assistant_message_count`, `file_size`, `parse_errors` (only when malformed
  lines are skipped), and `truncated` (only when the body was capped).
- Rendered content is capped at 8,000,000 UTF-8 bytes. When a session is longer,
  the body keeps the whole conversation rounds that fit and
  `metadata.truncated: true` is set (no note is written into the body).

## Incremental sync

State stores a schema version and a map from each relative file path to a
fingerprint (`{ mtime, size, docId }`). A file whose mtime and size match the
previous poll is not opened. A state in the older bare-file-map shape makes
every file re-index once.

On each poll:

- Changed and new files are streamed one at a time and emitted as upserts, one
  batch per file (the real source boundary). These batches carry no state.
- Files that disappeared or newly fall out of scope (for example, after toggling
  `include_subagents` off) are deleted in the final batch, together with the new
  state. Gety commits the state only when the poll succeeds, so a failed or
  cancelled poll starts over from the previous state.

### Deletion safety

- A missing projects directory, or a read or permission error while scanning it,
  fails the poll: nothing is deleted and the state is not committed.
- If a file disappears between the scan and its read, it is skipped and that
  poll deletes nothing; the next poll deletes it if it is really gone.
- A deletion is only emitted when a previously indexed file is absent from a
  successful, complete scan.

## Files

- `manifest.json` declares the connector metadata and uses `dist/main.js` as the
  Gety runtime entry.
- `src/index.ts` contains the connector source code.
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

Unit tests use Deno's built-in test runner and cover text extraction (skipping
`tool_use`/`tool_result`/`thinking`), title choice, model name prettification,
document building and truncation, and incremental poll behavior (index / skip
unchanged without reading / update on change / delete on removal, missing or
unreadable directories, files vanishing mid-poll). Tests that touch the
filesystem require read/write permissions, which the `test` task grants.

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

- `include_subagents`: `GETY_CONFIG_INCLUDE_SUBAGENTS` or `INCLUDE_SUBAGENTS`;
  defaults to `false`.

The folder path is not a connector setting; the runner passes your home
directory, as Gety does.

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
deno task runner -- --state dev/.runner/state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from npm (`@gety-connectors/claude-code`), or run `deno task build`
   and install from this local folder (build output is not committed).
3. Wait for the first poll to finish, then search for Claude Code sessions.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`.
