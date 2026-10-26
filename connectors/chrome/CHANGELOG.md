# @gety-connectors/chrome

## 0.2.1

### Patch Changes

- 2da5aa2: Requires Gety 0.6.5 or newer. Gety 0.6.3 and 0.6.4 cannot read the
  `permissions` field this connector's manifest declares.

## 0.2.0

### Minor Changes

- ae3279f: Requires a Gety version newer than 0.6.3. Other changes from the version
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

## 0.1.0

- Bootstrap npm release that creates the package: the same code as 0.2.0
  apart from the version, published by a maintainer without provenance.
  Superseded by 0.2.0.
