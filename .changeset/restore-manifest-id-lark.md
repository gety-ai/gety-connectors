---
"@gety-connectors/lark": minor
---

The manifest id is restored to `feishu` (0.1.x and 0.2.x used `lark`), so a
Feishu connector installed from the old `gety-lark-connector` repository is
recognized as already installed instead of being installed a second time and
indexing every document and chat again. If you installed 0.1.x or 0.2.x of this
package, remove that connector in Gety and install this version again: Gety
treats the `lark` id as a different connector.
