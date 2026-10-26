# @gety-connectors/codex

## 0.3.0

### Minor Changes

- 5e89cfd: Session documents now list the session id (what `codex resume` takes), so
  searching for an id finds its session. The id, workspace roots, model, and the
  commands and file names in tool call summaries are code spans that copy exactly,
  even when they contain backticks. Existing sessions are re-indexed once in the
  new format.
- 261547f: The manifest id is restored to `codex_sessions` (0.1.x and 0.2.x used
  `codex`), so a Codex connector installed from the old `gety-codex-connector`
  repository is recognized as already installed instead of being installed a
  second time and indexing every session again. If you installed 0.1.x or 0.2.x
  of this package, remove that connector in Gety and install this version again:
  Gety treats the `codex` id as a different connector.

### Patch Changes

- 2da5aa2: Requires Gety 0.6.5 or newer. Gety 0.6.3 and 0.6.4 cannot read the
  `permissions` field this connector's manifest declares.
- 8e42d41: A poll that finds no session changed no longer sends the whole connector state
  back to Gety (about 4 MB for 26,000 session logs), so polls of an unchanged
  Codex history finish sooner.
- 5914195: Indexing session logs takes about half as long: tool output, reasoning and
  event lines are recognized from their first bytes and skipped without being
  decoded. The indexed documents are unchanged.
- 1e3bfae: Listing the session logs takes less time on every poll: each file is stat'ed
  directly instead of through a round trip to a worker thread.

## 0.2.0

### Minor Changes

- ae3279f: Changes from the version developed in the connector's former standalone repository, before it moved to gety-connectors:
  
  - The manifest id is now `codex` (was `codex_sessions`); uninstall the old connector first.
  - Runs sandboxed: it can only read `~/.codex/sessions` and `~/.codex/archived_sessions` (not `auth.json` or the rest of `~/.codex`). Requires a Gety version newer than 0.6.3.
  - `CODEX_HOME` is no longer read; sessions are found under the home directory Gety passes in.
  - A missing `~/.codex/sessions` now fails the sync instead of deleting every indexed session.
  - Subagent sessions are no longer filed under their parent's id, which hid them and could replace the parent's content. New option `include_subagents` (off by default) indexes them as their own documents.
  - A long session that Codex continued in several segment files is indexed as one document with all of its turns, instead of only the last segment.
  - A file removed while a sync runs no longer fails the sync.
  - Content is limited by UTF-8 bytes (8,000,000) instead of 900,000 characters.

## 0.1.0

- Bootstrap npm release that creates the package: the same code as 0.2.0
  apart from the version, published by a maintainer without provenance.
  Superseded by 0.2.0.
