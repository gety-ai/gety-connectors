---
"@gety-connectors/lark": minor
---

First release on npm as `@gety-connectors/lark`. The manifest id is now `lark`
(was `feishu`), so existing installs re-index from scratch; it requires a Gety
version newer than 0.6.3.

- Runs sandboxed: the manifest only grants running `lark-cli`, which must be on
  the `PATH` Gety starts with. The `lark_cli_path` setting is removed.
- A document missing from search is deleted only when lark-cli reports it
  `not_found` or `permission_denied`; other fetch failures keep it.
- A failure to list chats skips chats for that poll instead of failing it.
- Changing the chat grouping keeps the old chat docs searchable until the
  rebuild under the new grouping completes.
- State is committed once per successful poll and stays small: source
  positions moved to the data directory, and unchanged chat periods are no
  longer re-uploaded.
- Every lark-cli call has a timeout, retries rate limits and retryable errors,
  and stops on cancellation; unknown lark-cli output fails the poll instead of
  reading as "no documents".
- Chat links use lark-cli's tenant-aware AppLink (Lark tenants no longer get
  Feishu links), and document links are never guessed.
