---
"@gety-connectors/codex": patch
---

Indexing session logs takes about half as long: tool output, reasoning and
event lines are recognized from their first bytes and skipped without being
decoded. The indexed documents are unchanged.
