---
"@gety-connectors/codex": patch
---

A poll that finds no session changed no longer sends the whole connector state
back to Gety (about 4 MB for 26,000 session logs), so polls of an unchanged
Codex history finish sooner.
