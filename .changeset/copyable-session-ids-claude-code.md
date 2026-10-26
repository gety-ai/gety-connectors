---
"@gety-connectors/claude-code": minor
---

Session documents now list the session id (what `claude --resume` takes), so
searching for an id finds its session. The id, project, model, git branch, and
slash command names are code spans that copy exactly, even when they contain
backticks; the model keeps its readable name in front. Existing sessions are
re-indexed once in the new format, and files deleted meanwhile are still
removed.
