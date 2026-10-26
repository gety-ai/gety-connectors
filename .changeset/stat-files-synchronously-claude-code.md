---
"@gety-connectors/claude-code": patch
---

Listing the session files takes less time on every poll: each file is stat'ed
directly instead of through a round trip to a worker thread.
