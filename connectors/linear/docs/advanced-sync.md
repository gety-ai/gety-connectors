# Advanced Linear Sync Notes

These notes capture the current issue/comment polling design and the remaining
sync limitations.

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

The connector processes issue sync page by page. Each page requests 50 issues,
yields that page immediately, and one Gety poll may process up to 500 issues. If
issue pagination or a full rebuild still has more pages after that limit, the
connector persists the issue page cursor and the next poll continues from there.
Once issue pagination is caught up, the same poll may continue with one comment
delta pass. Repeated upserts are acceptable because Gety treats upsert as the
full latest source state.

The issue cursor has two layers:

- Completed cursor: `last_issue_updated_at`.
- In-progress page cursor: `issue_delta_after`, `issue_delta_boundary`, and
  `issue_delta_max_updated_at`.

Incremental issue polling uses `updatedAt >= last_issue_updated_at - 1s` to
avoid missing issues around timestamp precision and concurrent poll boundaries.
When Linear returns another page, the connector persists the page cursor and
keeps the same boundary for the next poll. This prevents a large set of issues
with the same `updatedAt` from repeatedly restarting at the first page.

Full rebuilds use the same issue page cursor and persist `rebuild_issue_sync`
while a rebuild is in progress. Large workspaces therefore converge through
committed issue pages instead of one long all-or-nothing poll.

Remaining limitation: a hard-deleted issue that is no longer returned by the API
cannot be detected by polling alone unless Linear exposes it as trashed or
archived first. If a changed comment points at an issue that can no longer be
fetched, the connector emits a delete for that issue document. Webhooks or a
periodic full reconciliation would be needed for exact hard-delete coverage.

## Comments

The connector embeds comments into the owning `linear:issue` markdown document
when `index_comments` is enabled and the issue has visible comments. This
matches the desired Gety behavior: search results still open the issue, and the
source preview shows the issue description followed by comment blocks when those
sections exist.

Comments are synced with the SDK:

- Top-level query: `linearClient.comments({ first, after, filter, orderBy })`.
- Per-issue query: `issue.comments({ first, after })`.
- `CommentFilter.updatedAt` supports date comparators.
- Comment fields include `id`, `body`, `url`, `issueId`, `parentId`,
  `createdAt`, `updatedAt`, `editedAt`, `archivedAt`, `resolvedAt`, and
  `quotedText`.
- `Comment.body` is already markdown.

Implementation shape:

- Issue polling still uses `updatedAt >= last_issue_updated_at - 1s` and yields
  each issue page separately, up to 500 issues per poll.
- Comment polling uses a separate `last_comment_updated_at` cursor with the same
  1 second overlap. Issue pages never advance this comment cursor; only comment
  delta sync does.
- Changed comments are converted to issue IDs, then each affected issue is
  rebuilt by fetching its full current comment list.
- Comment delta runs after issue pagination is caught up. If an issue rebuild is
  still paginating, comment delta waits for the next poll.
- Archived comments are fetched so their owning issue can be rebuilt, but they
  are omitted from the rendered markdown.
- Comment threads are rendered as separate blocks with dividers between
  top-level comments and nested headings for replies.
- Empty description and empty comments sections are omitted instead of rendering
  placeholder text.
- Markdown images in issue descriptions and comments are converted into normal
  markdown links before indexing.

This approach makes the Gety preview more natural, but every changed comment
causes a full issue upsert. A hard-deleted comment that is no longer returned by
Linear cannot be detected by polling alone unless Linear exposes it first as an
archived comment.

Separate `linear:comment` docs remain a future option if Gety should show
comments as independent search results. In that model, a comment doc would use
`parent_id = linear:issue:<issueId>` and `content_format = markdown`.

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

1. Keep issue polling and comment polling independent so a large comment backlog
   cannot block issue metadata updates.
2. If hard-delete cleanup becomes required, add periodic reconciliation against
   the current issue list.
3. If Gety adds an inbound event endpoint, add webhook support for `Issue` and
   `Comment` resources, then use polling only as reconciliation.
