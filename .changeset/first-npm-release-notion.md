---
"@gety-connectors/notion": minor
---

First release on npm as `@gety-connectors/notion`. Requires a Gety version newer than 0.6.3 and runs sandboxed with network access to `api.notion.com` only. A non-JSON or malformed Notion response (for example a captive portal answering 200 with HTML) now fails the poll instead of deleting every indexed page. A synced block whose original is not shared with the integration no longer removes its page from the index. Requests time out and are retried on network errors, 500 and 529, honoring `Retry-After` up to five minutes; a 401 reports that the token is invalid or expired. Pages are sent to Gety one at a time and state is saved once per poll; pages edited in the minute before a poll are fetched again next poll, and a page listed twice in one poll is fetched once. Truncation of very large pages keeps close to the 8 MB budget, and only http(s) targets are rendered as links.
