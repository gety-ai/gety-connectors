# Google Chrome Connector for Gety

Indexes a local Google Chrome profile into Gety:

- **Bookmarks** — from the profile's `Bookmarks` JSON file, with folder
  breadcrumbs (`Bookmarks bar / design`) as searchable context.
- **Browsing history** — from the profile's `History` SQLite database (`urls`
  table), with a configurable scope.

Each document links back to the page URL (`doc_link → metadata.url`), so opening
a result launches it in the browser. Chrome does not store page body text, so
documents are searchable by **title, URL, and bookmark folder** — not full page
content.

## Documents

| Source   | `doc_type`        | `id`                         | `doc_updated_at`             | Link           |
| -------- | ----------------- | ---------------------------- | ---------------------------- | -------------- |
| Bookmark | `chrome:bookmark` | `chrome:bookmark:<guid>`     | `date_modified`/`date_added` | `metadata.url` |
| History  | `chrome:history`  | `chrome:history:<sha1(url)>` | `last_visit_time`            | `metadata.url` |

Timestamps are converted from Chrome's WebKit epoch (microseconds since
1601-01-01) to RFC 3339. Non-`http(s)` URLs (e.g. `chrome://`) get no link.

## Configuration

| Field                  | Type     | Default | Notes                                                 |
| ---------------------- | -------- | ------- | ----------------------------------------------------- |
| `index_bookmarks`      | checkbox | `true`  | Index the Bookmarks file.                             |
| `index_history`        | checkbox | `true`  | Index the History database.                           |
| `history_range`        | dropdown | `90d`   | `7d` · `30d` · `90d` · `365d` · `all` — how far back. |
| `history_skip_non_web` | checkbox | `true`  | Skip non-`http(s)` history URLs.                      |

The Chrome **Default** profile directory is detected from the host OS — there is
no profile setting. The manifest grants read access to that directory only:

| OS      | Profile directory                                     |
| ------- | ----------------------------------------------------- |
| Linux   | `~/.config/google-chrome/Default`                     |
| macOS   | `~/Library/Application Support/Google/Chrome/Default` |
| Windows | `~/AppData/Local/Google/Chrome/User Data/Default`     |

If the profile directory does not exist, the sync fails with a clear message and
nothing is deleted. A profile without a `Bookmarks` file has no bookmarks; a
`Bookmarks` file in a format the connector does not recognize fails the sync.

`history_range` indexes only pages whose last visit falls within the window
(`all` removes the window). Like Chrome's own history list, a page is indexed
only if it has a visible visit in the window: one that ends a redirect chain and
is not a subframe load. Redirect sources and subframe-only pages are skipped, as
are pages never actually loaded.

## Sync behavior

- **Incremental history** via a `last_visit_time` high-water-mark cursor: each
  poll re-emits pages visited since the last poll, plus any in-range page not
  indexed yet (after widening the range, re-enabling history, or turning off the
  non-web filter).
- **Bookmarks** are re-scanned in full each poll (small) and upserted
  idempotently.
- **Deletes stay in sync**: the connector remembers indexed ids in state and
  emits `del()` for bookmarks/history that disappear or fall out of scope. A
  cancelled poll emits no deletes.

Chrome keeps the live `History` DB locked and may hold in-flight writes in a
rollback journal or a WAL, so each poll copies `History` (+ `-journal`/`-wal`/
`-shm`) to a temp dir and reads the copy.

## Build

```bash
deno task verify   # fmt/lint check + type-check + test + build
deno task build    # just rebuild dist/main.js
```

`src/index.ts` is the source; `dist/main.js` is the built entry Gety loads (not
committed; `deno task build` writes it). After editing source, rebuild and use
**Restart** in Gety.

## Local runner

```bash
cp .env.example .env       # optional config overrides
deno task runner -- --reset-state
deno task runner -- --polls 2
```

The runner sandboxes the connector with the manifest `permissions`. Output is
written under `dev/runs/<timestamp>/` (summary, state before/after,
updates/deletes, and per-doc snapshots).

## Install in Gety

1. Open Gety's Custom Connectors settings.
2. Install from npm (`@gety-connectors/chrome`), or run `deno task build` and
   install from this local folder (build output is not committed).
3. Optionally change `history_range` (and toggle bookmarks/history).
4. Wait for the first poll, then search, e.g. `gety search <term>`.
