---
"@gety-connectors/codex": minor
---

First release on npm as `@gety-connectors/codex`. Changes from the local-folder 0.1.x:

- The manifest id is now `codex` (was `codex_sessions`); uninstall the old connector first.
- Runs sandboxed: it can only read `~/.codex/sessions` and `~/.codex/archived_sessions` (not `auth.json` or the rest of `~/.codex`). Requires a Gety version newer than 0.6.3.
- `CODEX_HOME` is no longer read; sessions are found under the home directory Gety passes in.
- A missing `~/.codex/sessions` now fails the sync instead of deleting every indexed session.
- Subagent sessions are no longer filed under their parent's id, which hid them and could replace the parent's content. New option `include_subagents` (off by default) indexes them as their own documents.
- A long session that Codex continued in several segment files is indexed as one document with all of its turns, instead of only the last segment.
- A file removed while a sync runs no longer fails the sync.
- Content is limited by UTF-8 bytes (8,000,000) instead of 900,000 characters.
