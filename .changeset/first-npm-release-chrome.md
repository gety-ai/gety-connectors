---
"@gety-connectors/chrome": minor
---

Requires a Gety version newer than 0.6.3. Other changes from the version
developed in the connector's former standalone repository, before it moved to
gety-connectors:

- Runs sandboxed: reads only the Chrome Default profile directory, resolved
  from the home directory (`LOCALAPPDATA` is no longer read).
- A missing profile or an unrecognized Bookmarks format now fails the sync
  instead of indexing nothing or deleting bookmarks; a profile without a
  Bookmarks file still syncs.
- Widening `history_range`, re-enabling history or turning off the non-web
  filter now indexes the older pages that were previously skipped.
- History matches Chrome's own history list: redirect sources and pages only
  loaded in subframes are no longer indexed.
- A cancelled sync no longer deletes history that was not scanned yet.
- `history_range` defaults to the last 90 days.
- The History copy includes Chrome's rollback journal, so in-flight writes are
  read consistently.
