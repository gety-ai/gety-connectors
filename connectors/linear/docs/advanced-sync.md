# Advanced Linear Sync Notes

These notes capture the current issue/comment polling design and the remaining
sync limitations.

## Sources Checked

- Linear pagination docs: <https://linear.app/developers/pagination>
- Linear rate limiting docs: <https://linear.app/developers/rate-limiting>
- Linear GraphQL schema explorer:
  <https://studio.apollographql.com/public/Linear-API/variant/current/explorer>
- Linear webhook docs: <https://linear.app/developers/webhooks>

## Requests

The connector sends four hand-written GraphQL queries (`src/issue.ts`,
`src/comment.ts`) through its own client in `src/graphql.ts`, built on the
repository's shared HTTP helpers:

- Every request carries the poll's cancel signal and a 60 second timeout per
  attempt.
- Network errors, timeouts, HTTP 429 and 5xx responses are retried with backoff,
  honoring `Retry-After`.
- Linear reports rate limits as HTTP 400 with the error code `RATELIMITED` and
  announces the refill time in `X-RateLimit-*-Reset` headers (epoch
  milliseconds) rather than `Retry-After`. The client retries that 400 only and
  waits until the exhausted bucket resets. Any other 400, authentication errors,
  and GraphQL errors in a 2xx response fail the poll.
- Responses are checked, not defaulted: a missing connection, a page that
  reports more results without a cursor or with the cursor it was requested
  with, or a changed comment without a readable `issueId` and `updatedAt` fails
  the poll instead of reading as an empty or final page.

The "poll finished" log line reports `max_complexity`, the highest
`X-Complexity` Linear returned during the poll. Linear rejects a single query
above 10,000 complexity points. The issue page query asks for 50 issues with
their first 50 comments; by Linear's documented estimate that is above the cap,
but runs of the same query against a real workspace succeeded, so the page sizes
stay as they are. If a workspace ever fails with a complexity error, lower
`issuePageSize` or `issueCommentPageSize` in `src/index.ts`.

## Issue Incremental Sync

- `issues` accepts pagination variables and `includeArchived`.
- `IssueFilter.updatedAt` supports `gt/gte/lt/lte`.
- `IssueSortInput.updatedAt.order` supports ascending and descending sorting.
- Archived or trashed issues are emitted as Gety deletes.

The connector processes issue sync page by page. Each page requests 50 issues
and yields that page's updates; one Gety poll processes up to 500 issues. Gety
commits a poll's state only when the whole poll succeeds, so the state is
yielded once, in the poll's final batch, and a failed poll redoes at most its
500 issues. If issue pagination or a full rebuild still has more pages after
that limit, the final state carries the issue page cursor and the next poll
continues from there. Once issue pagination is caught up, the same poll may
continue with one comment delta pass. Repeated upserts are acceptable because
Gety treats upsert as the full latest source state.

The issue cursor has two layers:

- Completed cursor: `last_issue_updated_at`.
- In-progress page cursor: `issue_delta_after`, `issue_delta_boundary`, and
  `issue_delta_max_updated_at`.

Incremental issue polling uses `updatedAt >= last_issue_updated_at - 1s` to
avoid missing issues around timestamp precision and concurrent poll boundaries.
When Linear returns another page, the poll's state keeps the page cursor and the
same boundary for the next poll. This prevents a large set of issues with the
same `updatedAt` from repeatedly restarting at the first page.

A full rebuild runs on the first poll, after a state schema change, and when
`index_comments` is turned on or off. It starts from the first page, ignoring
any cursor of an incremental pass, and keeps `rebuild_issue_sync` and
`rebuild_started_at` in the state while it spans polls, so large workspaces
converge over several polls. If the schema or `index_comments` changes before it
completes, it starts over from the first page.

## Deletes

- Archived or trashed issues returned by the issue list are deleted.
- When a changed comment points at an issue that Linear reports as not found (an
  `Entity not found` error on the `issue` field), the issue document is deleted.
  Any other error fails the poll without deleting anything.
- Polling cannot see an issue or comment that was hard-deleted without being
  archived or trashed first, or an issue the API key can no longer read. Use
  Rebuild index on the connector in Gety to remove such documents: it clears the
  connector's documents and state, and the next poll indexes the current issues
  from scratch.

## Comments

The connector embeds comments into the owning `linear:issue` markdown document
when `index_comments` is enabled and the issue has visible comments. Search
results still open the issue, and the source preview shows the issue description
followed by the comments.

Comments come from two queries:

- `comments(filter: { updatedAt: { gte } }, orderBy: updatedAt,
  includeArchived: true)`
  finds changed comments (`id`, `issueId`, `updatedAt`).
- `issue(id).comments(orderBy: createdAt, includeArchived: true)` fetches an
  issue's full comment list. The issue page query embeds its first page.
- Comment fields are `id`, `issueId`, `parentId`, `body`, `quotedText`, the
  author (`user`, `onBehalfOf`, `externalUser`, `botActor`), `archivedAt`,
  `createdAt`, `updatedAt`, `editedAt`, and `resolvedAt`.
- `Comment.body` is already markdown.

Implementation shape:

- Comment polling uses a separate `last_comment_updated_at` cursor with a 1
  second overlap. Issue pages never advance this cursor, except that a completed
  full rebuild with comments moves it to `rebuild_started_at`: the rebuild
  already fetched every comment older than that. The start time is the local
  clock minus 10 minutes, an allowance for the local clock running ahead of
  Linear's.
- Changed comments are converted to issue IDs, then each affected issue is
  rebuilt by fetching its full current comment list. At most 50 changed comments
  are scanned per poll.
- Comment delta runs after issue pagination is caught up. If an issue rebuild is
  still paginating, comment delta waits for the next poll.
- Archived comments are fetched so their owning issue can be rebuilt, but they
  are omitted from the rendered markdown.
- Top-level comments are separated by dividers; replies follow their parent as
  blockquotes. Each comment starts with its author and creation time in UTC.
- Empty description and empty comments sections are omitted instead of rendering
  placeholder text.
- Markdown images in issue descriptions and comments are converted into normal
  markdown links before indexing.

Every changed comment causes a full issue upsert.

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
2. If hard-delete cleanup without Rebuild index becomes required, add periodic
   reconciliation against the current issue list.
3. If Gety adds an inbound event endpoint, add webhook support for `Issue` and
   `Comment` resources, then use polling only as reconciliation.
