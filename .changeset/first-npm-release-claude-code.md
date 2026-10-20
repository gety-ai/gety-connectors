---
"@gety-connectors/claude-code": minor
---

First release on npm as `@gety-connectors/claude-code`. Changes from the local-folder 0.1.x:

- Runs sandboxed: it can only read `~/.claude/projects`. Requires a Gety version newer than 0.6.3.
- The development-only `PROJECTS_DIR` / `GETY_CONFIG_PROJECTS_DIR` overrides are gone, and `HOME` / `USERPROFILE` are no longer read; sessions are found under the home directory Gety passes in.
- A missing or unreadable projects directory now fails the sync instead of deleting indexed sessions.
- Files whose modification time and size are unchanged are no longer read on every sync; changed files are streamed instead of loaded whole.
- The sync state is saved once, when the sync finishes, instead of after every file.
- Content is limited to 8,000,000 UTF-8 bytes (was about 3 MB counted in characters), still keeping whole conversation rounds.
