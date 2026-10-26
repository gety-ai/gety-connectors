---
"@gety-connectors/codex": minor
---

Session documents now list the session id (what `codex resume` takes), so
searching for an id finds its session. The id, workspace roots, model, and the
commands and file names in tool call summaries are code spans that copy exactly,
even when they contain backticks. Existing sessions are re-indexed once in the
new format.
