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

| Field                  | Type     | Default  | Notes                                                 |
| ---------------------- | -------- | -------- | ----------------------------------------------------- |
| `index_bookmarks`      | checkbox | `true`   | Index the Bookmarks file.                             |
| `index_history`        | checkbox | `true`   | Index the History database.                           |
| `history_range`        | dropdown | required | `7d` · `30d` · `90d` · `365d` · `all` — how far back. |
| `history_skip_non_web` | checkbox | `true`   | Skip non-`http(s)` history URLs.                      |

The Chrome **Default** profile directory is detected from the host OS — there is
no profile setting:

| OS      | Profile directory                                     |
| ------- | ----------------------------------------------------- |
| Linux   | `~/.config/google-chrome/Default`                     |
| macOS   | `~/Library/Application Support/Google/Chrome/Default` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default`      |

`history_range` indexes only pages whose last visit falls within the window
(`all` removes the window). Pages never actually loaded are skipped.

## Sync behavior

- **Incremental history** via a `last_visit_time` high-water-mark cursor: each
  poll re-emits only pages visited since the last poll.
- **Bookmarks** are re-scanned in full each poll (small) and upserted
  idempotently.
- **Deletes stay in sync**: the connector remembers indexed ids in state and
  emits `del()` for bookmarks/history that disappear or fall out of scope.

Chrome keeps the live `History` DB locked and may hold recent writes in a WAL,
so each poll copies `History` (+ `-wal`/`-shm`) to a temp dir and reads the
copy.

## Build

```bash
deno task verify   # fmt + lint + type-check + test + build
deno task build    # just rebuild dist/main.js
```

`src/index.ts` is the source; `dist/main.js` is the built entry Gety loads (not
committed; `deno task build` writes it). After editing source, rebuild and use
**Restart** in Gety.

## Local runner

```bash
cp .env.example .env       # sets GETY_CONFIG_HISTORY_RANGE (required)
deno task runner -- --reset-state
deno task runner -- --polls 2
```

`history_range` is required, so set `GETY_CONFIG_HISTORY_RANGE` in `.env` (e.g.
`90d`). Output is written under `dev/runs/<timestamp>/` (summary, state
before/after, updates/deletes, and per-doc snapshots).

## Install in Gety

1. Open Gety's Custom Connectors settings.
2. Install from npm (`@gety-connectors/chrome`), or run `deno task build` and
   install from this local folder (build output is not committed).
3. Choose a `history_range` (and toggle bookmarks/history if desired).
4. Wait for the first poll, then search, e.g. `gety search <term>`.
