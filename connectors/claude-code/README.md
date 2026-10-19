# Claude Code

A Gety custom connector that indexes
[Claude Code](https://claude.com/claude-code) chat sessions from the local
Claude Code projects directory so they are searchable in Gety.

Each Claude Code session is stored as a JSONL file under a per-platform projects
directory. This connector turns indexable session `.jsonl` files into Gety
documents containing the conversational text as markdown. Subagent/workflow logs
under a `subagents/` path segment are skipped by default because they are
implementation details of a parent session rather than user-level conversations;
they can be included with the `include_subagents` checkbox.

## Data source

The projects directory is auto-detected per platform:

- Linux/macOS: `~/.claude/projects`
- Windows: `%USERPROFILE%\.claude\projects`

`HOME` and `USERPROFILE` are read from the environment. There is no connector
setting for the folder path; the required `include_subagents` checkbox defaults
to false. For local development only, `PROJECTS_DIR` or
`GETY_CONFIG_PROJECTS_DIR` can override the auto-detected path.

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
- Rendered content is capped at ~3 MB; when this happens the body is cut at a
  message boundary and `metadata.truncated: true` is set (no note is written
  into the body).

## Incremental sync

State stores a schema version, the `include_subagents` config snapshot, and a
map from each relative file path to a fingerprint
(`{ mtime, size, hash, docId }`). The fingerprint includes a SHA-256 hash of the
file's raw content, so even same-size/same-mtime rewrites are detected. Old
state entries that predate the hash/schema fields are treated as changed and
re-indexed. Files are read and hashed one at a time and yielded immediately —
the poll never builds every document up front.

On each poll:

- Changed and new files are read and emitted as upserts, one batch per file (the
  real source boundary).
- Files that disappeared or newly fall out of scope (for example, after toggling
  `include_subagents` off) are emitted as `del(id)` in a single deletion batch —
  but only when the scan was authoritative (see below).
- Unchanged files are skipped (fingerprint match, including the content hash).
- State is persisted with each yielded batch.

### Deletion safety

Deletions never fire on transient scan/read errors:

- If scanning the root or any subdirectory hits a read/permission error (other
  than the root directory truly not existing), no deletions are emitted for that
  poll and prior state is preserved for unknown paths.
- If a file appears in the scan but `readTextFile` fails, its previous doc and
  state are left untouched and it is skipped for that poll.
- A deletion is only emitted when a previously indexed file is absent from a
  successful, complete scan (or when the root directory itself no longer
  exists).

## Files

- `manifest.json` declares the connector metadata and uses `dist/main.js` as the
  Gety runtime entry.
- `src/index.ts` contains the connector source code.
- `dist/main.js` is the build output loaded by Gety (`deno task build`; not
  committed).
- `dist/main.js.map` is its source map, published with it to make debugging the
  bundled entry easier.
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

Unit tests use Deno's built-in test runner and cover text extraction (skipping
`tool_use`/`tool_result`/`thinking`), title choice, model name prettification,
document building, and incremental poll behavior (index / skip unchanged /
update on change / delete on removal, including nested JSONL files). Tests that
touch the filesystem require env/read/write permissions, which the `test` task
grants.

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

Config environment variables are derived from manifest field IDs:

- `include_subagents`: `GETY_CONFIG_INCLUDE_SUBAGENTS` or `INCLUDE_SUBAGENTS`;
  defaults to `false`.

The folder path is auto-detected and is not shown as a connector setting. For
local development only, `PROJECTS_DIR` or `GETY_CONFIG_PROJECTS_DIR` can
override it.

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
