---
"@gety-connectors/linear": minor
---

First release on npm as `@gety-connectors/linear`. Compared with the 0.1.x
local-folder connector:

- Requires a Gety version newer than 0.6.3 and declares
  `net: ["api.linear.app"]`, so it runs sandboxed instead of with full access.
- Talks to Linear through a small built-in GraphQL client instead of
  `@linear/sdk`; the bundle shrinks from 2.4 MB to under 300 KB.
- Requests time out after 60 seconds, stop when Gety cancels the poll, and
  retry network errors, server errors and rate limits (waiting for Linear's
  rate-limit reset).
- Malformed or truncated responses fail the poll instead of being read as
  empty pages.
- After a full rebuild the comment cursor starts at the rebuild instead of
  1970, so polls no longer rescan every comment.
- Turning on `index_comments` while an issue pass is unfinished no longer
  makes the rebuild skip issues.
- Issues Linear reports as not found are deleted instead of failing the poll.
- Comment times are marked as UTC.
- State is reported once, at the end of each poll.
