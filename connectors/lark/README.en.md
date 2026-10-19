# Gety Feishu Connector

[简体中文](./README.md)

A [Gety](https://gety.ai/) custom connector that indexes your Lark / Feishu
content through a locally authenticated
[lark-cli](https://github.com/larksuite/cli):

- **Cloud documents** — docx documents and wiki pages you can access, exported
  as markdown. Documents confirmed deleted at the source, or no longer
  accessible, are removed from the index during sync.
- **Chat history** _(optional, on by default)_ — group chats and direct
  messages, grouped into one searchable document per chat per ISO week
  (default), per day, or ungrouped (one document per chat covering the lookback
  window).

The connector never stores Lark credentials itself. All API calls go through
`lark-cli`, which keeps its own OAuth tokens.

## Prerequisites

1. Install [lark-cli](https://github.com/larksuite/cli) (1.0.58 or newer) and
   make sure `lark-cli` is on the **`PATH` Gety starts with**. The manifest only
   grants running a program named `lark-cli` (`permissions.run`); a custom path
   is no longer supported.
   - On macOS, Gety adds `/opt/homebrew/bin` and `/usr/local/bin` to `PATH`, so
     a Homebrew install works as is.
   - With a Node version manager (nvm, fnm, volta, …), a global npm install puts
     `lark-cli` only on that tool's shell `PATH`, and npm's launcher relies on
     `env node`, which fails inside Gety. Link the package's native executable
     into a directory on `PATH` instead:

     ```bash
     sudo ln -sf "$(npm root -g)/@larksuite/cli/bin/lark-cli" /usr/local/bin/lark-cli
     ```
2. Sign in and grant scopes in one step. `lark-cli auth login` **requires**
   explicit scopes — running it bare fails with "please specify the scopes to
   authorize". Use:

   ```bash
   lark-cli auth login --recommend --scope "search:docs:read contact:user.basic_profile:readonly"
   ```

   - `--recommend` grants the standard auto-approve read scopes the connector
     relies on, including `docx:document:readonly`, `im:chat:read`,
     `im:message:readonly`, `im:message.*_msg:get_as_user`, and
     `wiki:node:read`.
   - `search:docs:read` (enumerate cloud documents) and
     `contact:user.basic_profile:readonly` (resolve sender names in chat
     transcripts) are **not** in the recommended set and must be listed
     explicitly. `search:docs:read` may additionally require approving the
     permission for your app in the Lark developer console first.

   Check what is currently granted with `lark-cli auth status`.

## Install in Gety

1. In Gety, open **Custom Connectors**.
2. Install from npm (`@gety-connectors/lark`), or run `deno task build`
   (requires [Deno](https://deno.com/)) and install from this local folder
   (build output is not committed).
3. Fill in the settings (labels are in Chinese):

   | Setting (中文)   | Default     | Meaning                                                                                                                   |
   | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
   | 索引聊天记录     | checked     | Index group chats and direct messages. Unchecking removes previously indexed chats.                                       |
   | 聊天记录聚合粒度 | 按周 (week) | Group each chat's messages per ISO week, per day, or not at all (one doc per chat within the lookback). Re-indexes chats. |
   | 聊天记录回溯天数 | 30          | Days of chat history to backfill on the first sync; in ungrouped mode also the span each chat document covers.            |

After source edits, rebuild (`deno task build`) and click **Restart** for this
connector in Gety. After manifest edits, reinstall the connector.

## What gets indexed

| Source           | Gety doc id                           | Link target                        |
| ---------------- | ------------------------------------- | ---------------------------------- |
| Cloud document   | `feishu:doc:<token>`                  | The document in the browser        |
| Chat (week/day)  | `feishu:chat:<chat_id>:<week or day>` | The chat in the Lark app (applink) |
| Chat (ungrouped) | `feishu:chat:<chat_id>`               | The chat in the Lark app (applink) |

Week docs key on the week's Monday and display a date range such as
`2026-07-06 ~ 2026-07-12`; day docs use `2026-07-10`; ungrouped mode keeps the
chat's messages within the lookback window in one document with per-day
sections.

Sync behavior:

- Documents are discovered by a full two-pass Search v2 enumeration (the two
  sort orders have complementary recall and are unioned). Content is refetched
  only for documents whose content or source context changed, or which are not
  yet in the index, so a transient fetch failure is retried on the next poll.
- Search enumeration recall is unstable between polls, so a document missing
  from a completed enumeration is deleted only when a direct fetch fails with
  lark-cli's `not_found` or `permission_denied` error; network errors, timeouts
  and any other failure keep it. An incomplete enumeration (e.g. a missing
  search scope) or an empty one skips the deletion pass.
- Sync state is committed only when a poll finishes successfully; a cancelled
  poll restarts from the last committed state. Document source positions are
  cached in the connector's data directory, not in the sync state.
- Each chat keeps a cursor; the still-open period (current day or week) is
  refetched in full so its transcript stays complete, and is not re-uploaded
  when unchanged. In ungrouped mode a cheap probe checks for new messages first,
  and only then is the lookback window refetched to rebuild that chat's
  document; oversized chats drop their oldest days to fit the content cap.
- If listing chats fails, chats are skipped for that poll and documents still
  commit; a failing chat skips only that chat.
- Switching the grouping rebuilds the chat docs from the lookback window with
  the new grouping; the old chat docs stay searchable and are deleted only once
  a rebuild completes (the chat list and every chat's messages listed).
- Document and transcript content is capped at 8 MB, below Gety's per-document
  limit.
- Each `lark-cli` call is limited to 5 minutes; rate limits and errors lark-cli
  marks retryable are retried with backoff.

## Source context in Markdown

Cloud document Markdown starts with any available Wiki space, parent node or
folder, directory path, and original link. Each field appears only when it has a
value. With no source information, the original body is kept without an empty
header. Paths run from the root to the parent and exclude the document title.
Incomplete ancestor paths start with `… /`.

The space name links to its Wiki space, the parent name to its page, and each
path segment to its own ancestor. Wiki links retain the source document’s Feishu
or Lark tenant domain; Drive folders use API-provided URLs only. Names remain
plain text when no reliable link is available.

Source context is part of the Markdown content, so no Gety host changes are
required. No `metadata.location` or `metadata.feishu` fields are added; existing
metadata stays compatible. Resource IDs are used internally for lookups and sync
state, never as display text. No additional authentication token is needed:
lookups use the signed-in `lark-cli` user.

Moves and parent or space renames refresh source context even when the document
edit time is unchanged. Permission or temporary lookup failures do not block
content indexing and preserve previously resolved context. Drive paths come from
the accessible folder tree; shared documents may have no discoverable full path.

## Local development

```bash
deno task verify                    # fmt/lint check + generate + type-check + test + build
deno task runner -- --reset-state   # full sync into dev/runs/<timestamp>/
deno task runner -- --polls 2       # verify incremental behavior
```

Runner config overrides go into `.env` (see `.env.example`), e.g.
`GETY_CONFIG_INDEX_CHAT_HISTORY=false` or `GETY_CONFIG_CHAT_GROUPING=day`.

## Limitations

- Sheets, bitables, slides, mindnotes, file attachments, and legacy "doc"
  documents (rejected by the v2 fetch API) are not indexed.
- Recalled messages disappear from a transcript only when its period is
  refetched; historical chat docs are not swept message-by-message.
- Images are not displayed; they appear as `[图片]` / `[图片: description]`
  placeholders with the description text searchable. Feishu's signed image URLs
  expire within ~30 minutes (measured), while polls run hourly and only refetch
  edited documents — a kept URL would be a broken image at view time.
- The connector shells out to `lark-cli`, so Gety must run on a machine where
  `lark-cli` is installed and authenticated.
- lark-cli 1.0.98 does not classify the error for a deleted docx as `not_found`
  yet, so such documents may stay in the index until lark-cli reports a definite
  error type.
- The `lark-cli.cmd` launcher of an npm install on Windows is unverified.
