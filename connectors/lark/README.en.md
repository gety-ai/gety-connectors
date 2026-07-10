# Gety Feishu Connector

[简体中文](./README.md)

A [Gety](https://gety.ai/) custom connector that indexes your Lark / Feishu
content through a locally authenticated
[lark-cli](https://github.com/larksuite/cli):

- **Cloud documents** — docx documents and wiki pages you can access, exported
  as markdown. Documents that disappear from the source (deleted, or access
  lost) are removed from the index during sync.
- **Chat history** _(optional, on by default)_ — group chats and direct
  messages, grouped into one searchable document per chat per ISO week (default)
  or per day.

The connector never stores Lark credentials itself. All API calls go through
`lark-cli`, which keeps its own OAuth tokens.

## Prerequisites

1. Install [lark-cli](https://github.com/larksuite/cli) (1.0.58 or newer) and
   make sure it is on your `PATH`, or set its path in the connector settings.
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

1. Build the connector (requires [Deno](https://deno.com/)):

   ```bash
   deno task verify
   ```

2. In Gety, open **Custom Connectors** and install this folder.
3. Fill in the settings (labels are in Chinese):

   | Setting (中文)   | Default     | Meaning                                                                                        |
   | ---------------- | ----------- | ---------------------------------------------------------------------------------------------- |
   | 索引聊天记录     | checked     | Index group chats and direct messages. Unchecking removes previously indexed chats.            |
   | 聊天记录聚合粒度 | 按周 (week) | Group each chat's messages per ISO week or per day. Changing this re-indexes all chat history. |
   | 聊天记录回溯天数 | 30          | How many days of chat history to backfill on the first sync.                                   |
   | lark-cli 路径    | `lark-cli`  | Path to the lark-cli executable if it is not on the `PATH` inherited by Gety.                  |

After source edits, rebuild (`deno task build`) and click **Restart** for this
connector in Gety. After manifest edits, reinstall the connector.

## What gets indexed

| Source         | Gety doc id                           | Link target                        |
| -------------- | ------------------------------------- | ---------------------------------- |
| Cloud document | `feishu:doc:<token>`                  | The document in the browser        |
| Chat history   | `feishu:chat:<chat_id>:<week or day>` | The chat in the Lark app (applink) |

Week keys look like `2026-W28` (ISO 8601), day keys like `2026-07-10`.

Sync behavior:

- Documents are discovered by a full two-pass Search v2 enumeration (the two
  sort orders have complementary recall and are unioned). Content is refetched
  only for documents edited since the last sync or not yet in the index, so a
  transient fetch failure is retried on the next poll instead of being lost.
- Search enumeration recall is unstable between polls, so a document missing
  from a completed enumeration is deleted only after a direct fetch confirms it
  is no longer accessible. An empty enumeration is treated as a source-side
  glitch and skips the deletion pass.
- Each chat keeps a day-granular cursor; the still-open period (current day or
  week) is refetched in full so its transcript stays complete.
- Switching the grouping deletes all chat docs and rebuilds them from the
  lookback window with the new grouping.
- Document and transcript content is capped at 8 MB, below Gety's per-document
  limit.

## Local development

```bash
deno task verify                    # fmt + lint + generate + type-check + test + build
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
- Chat transcripts store message text only; images and files appear as
  placeholders like `(image)`.
- The connector shells out to `lark-cli`, so Gety must run on a machine where
  `lark-cli` is installed and authenticated.
