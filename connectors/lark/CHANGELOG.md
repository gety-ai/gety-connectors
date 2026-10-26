# @gety-connectors/lark

## 0.3.0

### Minor Changes

- 261547f: The manifest id is restored to `feishu` (0.1.x and 0.2.x used `lark`), so a
  Feishu connector installed from the old `gety-lark-connector` repository is
  recognized as already installed instead of being installed a second time and
  indexing every document and chat again. If you installed 0.1.x or 0.2.x of this
  package, remove that connector in Gety and install this version again: Gety
  treats the `lark` id as a different connector.

### Patch Changes

- 2da5aa2: Requires Gety 0.6.5 or newer. Gety 0.6.3 and 0.6.4 cannot read the
  `permissions` field this connector's manifest declares.

## 0.2.0

### Minor Changes

- ae3279f: The manifest id is now `lark` (was `feishu`), so existing installs re-index
  from scratch; it requires a Gety version newer than 0.6.3. Other changes from
  the version developed in the connector's former standalone repository, before
  it moved to gety-connectors:
  
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

## 0.1.0

- Bootstrap npm release that creates the package: the same code as 0.2.0
  apart from the version, published by a maintainer without provenance.
  Superseded by 0.2.0.
