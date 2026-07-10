# Gety Lark / Feishu Connector

[简体中文](./README.zh-CN.md)

A [Gety](https://gety.ai/) custom connector that indexes your Lark / Feishu
content through a locally authenticated
[lark-cli](https://github.com/larksuite/cli):

- **Cloud documents** — docx documents and wiki pages you can access, exported
  as markdown. Documents that disappear from the source (deleted, or access
  lost) are removed from the index on the next sync.
- **Chat history** _(optional, on by default)_ — group chats and direct
  messages, indexed as one searchable document per chat per day.

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
3. Fill in the settings:

   | Setting                      | Default    | Meaning                                                                       |
   | ---------------------------- | ---------- | ----------------------------------------------------------------------------- |
   | Index chat history           | checked    | Index group chats and direct messages. Uncheck to index cloud documents only. |
   | Chat history lookback (days) | 30         | How many days of chat history to backfill on the first sync.                  |
   | lark-cli path                | `lark-cli` | Path to the lark-cli executable if it is not on the `PATH` inherited by Gety. |

After source edits, rebuild (`deno task build`) and click **Restart** for this
connector in Gety. After manifest edits, reinstall the connector.

## What gets indexed

| Source              | Gety doc id                  | Link target                        |
| ------------------- | ---------------------------- | ---------------------------------- |
| Cloud document      | `lark:doc:<token>`           | The document in the browser        |
| Chat day transcript | `lark:chat:<chat_id>:<date>` | The chat in the Lark app (applink) |

Sync behavior:

- Documents are discovered by a full two-pass Search v2 enumeration (the two
  sort orders have complementary recall and are unioned). Content is refetched
  only for documents edited since the last sync or not yet in the index, so a
  transient fetch failure is retried on the next poll instead of being lost.
- Search enumeration recall is unstable between polls, so a document missing
  from a completed enumeration is deleted only after a direct fetch confirms it
  is no longer accessible. An empty enumeration is treated as a source-side
  glitch and skips the deletion pass.
- Each chat keeps a per-chat cursor at day granularity; the most recent day is
  refetched in full so the day transcript stays complete.
- Document and transcript content is capped at 8 MB, below Gety's per-document
  limit.

## Local development

```bash
deno task verify                    # fmt + lint + generate + type-check + test + build
deno task runner -- --reset-state   # full sync into dev/runs/<timestamp>/
deno task runner -- --polls 2       # verify incremental behavior
```

Runner config overrides go into `.env` (see `.env.example`), e.g.
`GETY_CONFIG_INDEX_CHAT_HISTORY=false`.

## Limitations

- Sheets, bitables, slides, mindnotes, file attachments, and legacy "doc"
  documents (rejected by the v2 fetch API) are not indexed.
- Deleted messages disappear from a day transcript only when that day is
  refetched; past chat-day documents are never deleted.
- Chat transcripts store message text only; images and files appear as
  placeholders like `(image)`.
- The connector shells out to `lark-cli`, so Gety must run on a machine where
  `lark-cli` is installed and authenticated.
