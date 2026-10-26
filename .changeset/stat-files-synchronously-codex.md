---
"@gety-connectors/codex": patch
---

Listing the session logs takes less time on every poll: each file is stat'ed
directly instead of through a round trip to a worker thread.
