---
"@gety-connectors/codex": minor
---

The manifest id is restored to `codex_sessions` (0.1.x and 0.2.x used
`codex`), so a Codex connector installed from the old `gety-codex-connector`
repository is recognized as already installed instead of being installed a
second time and indexing every session again. If you installed 0.1.x or 0.2.x
of this package, remove that connector in Gety and install this version again:
Gety treats the `codex` id as a different connector.
