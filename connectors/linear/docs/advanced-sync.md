# Advanced Linear Sync Notes

These notes capture the next implementation layer after the issues-only MVP.

## Sources Checked

- Linear SDK docs: <https://linear.app/developers/sdk>
- Linear pagination docs: <https://linear.app/developers/pagination>
- Linear GraphQL schema explorer:
  <https://studio.apollographql.com/public/Linear-API/variant/current/explorer>
- Linear webhook docs: <https://linear.app/developers/webhooks>
- Local `@linear/sdk@86.0.0` type definitions.

## Issue Incremental Sync

The current connector already uses issue-level incremental sync:

- `issues` accepts pagination variables and `includeArchived`.
- `IssueFilter.updatedAt` supports `gt/gte/lt/lte`.
- `IssueSortInput.updatedAt.order` supports ascending and descending sorting.
- Archived or trashed issues are emitted as Gety deletes.

The connector uses `updatedAt >= last_updated_at - 1s` to avoid missing issues
around timestamp precision and concurrent poll boundaries. Repeated upserts are
acceptable because Gety treats upsert as the full latest source state.

Remaining limitation: a hard-deleted issue that is no longer returned by the API
cannot be detected by polling alone unless Linear exposes it as trashed or
archived first. Webhooks are the better long-term source for exact delete
events.

## Comments

Comments can be synced with the SDK:

- Top-level query: `linearClient.comments({ first, after, filter, orderBy })`.
- Per-issue query: `issue.comments({ first, after })`.
- `CommentFilter.updatedAt` supports date comparators.
- Comment fields include `id`, `body`, `url`, `issueId`, `parentId`,
  `createdAt`, `updatedAt`, `editedAt`, `archivedAt`, `resolvedAt`, and
  `quotedText`.
- `Comment.body` is already markdown.

Recommended next step: index comments as separate docs:

- `doc_type`: `linear:comment`
- `id`: `linear:comment:<comment.id>`
- `parent_id`: `linear:issue:<comment.issueId>` when `issueId` is present
- `content_format`: `markdown`
- `metadata.url`: `comment.url`

This keeps issue documents stable and avoids rebuilding an issue body every time
a comment changes. It also lets Gety search comments directly while still
preserving the issue hierarchy.

Alternative: append recent comments into the issue markdown. This makes issue
preview more complete, but it creates heavier issue updates and makes comment
deletes/edits harder to represent cleanly.

## Webhooks

Linear supports webhook creation through `webhookCreate` with `teamId` or
`allPublicTeams: true` and resource types such as `Issue`, `Comment`,
`IssueLabel`, `Project`, `Cycle`, and `Reaction`.

Webhook payloads include:

- `action`, `type`, `data`, `url`, `organizationId`, `webhookTimestamp`, and
  `webhookId`.
- HTTP headers include `Linear-Signature`, `Linear-Event`, and
  `Linear-Delivery`.
- Signatures are HMAC-SHA256 over the raw request body and should be checked
  with a timestamp replay window.

Webhooks are the right long-term path for exact issue/comment create, update,
archive, and delete synchronization. They are not part of the current connector
runtime because this connector only implements the Gety polling contract and has
no public HTTP endpoint for Linear to call.

## Recommended Roadmap

1. Add comments as separate `linear:comment` markdown docs with their own
   `last_comment_updated_at` state cursor.
2. Keep issue polling and comment polling independent so a large comment backlog
   cannot block issue metadata updates.
3. Add a bounded backfill mode for comments, for example 500 comments per poll,
   using `updatedAt` ascending order.
4. If Gety adds an inbound event endpoint, add webhook support for `Issue` and
   `Comment` resources, then use polling only as reconciliation.
