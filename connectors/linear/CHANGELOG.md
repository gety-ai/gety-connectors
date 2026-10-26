# @gety-connectors/linear

## 0.2.1

### Patch Changes

- 2da5aa2: Requires Gety 0.6.5 or newer. Gety 0.6.3 and 0.6.4 cannot read the
  `permissions` field this connector's manifest declares.

## 0.2.0

### Minor Changes

- ae3279f: Changes from the version developed in the connector's former standalone
  repository, before it moved to gety-connectors:
  
  - Requires a Gety version newer than 0.6.3 and declares
    `net: ["api.linear.app"]`, so it runs sandboxed instead of with full access.
  - Talks to Linear through a small built-in GraphQL client instead of
    `@linear/sdk`; the bundle shrinks from 2.4 MB to under 300 KB.
  - Requests time out after 60 seconds, stop when Gety cancels the poll, and
    retry network errors, server errors and rate limits (waiting for Linear's
    rate-limit reset).
  - Malformed or truncated responses fail the poll instead of being read as
    empty pages.
  - After a full rebuild the comment cursor starts at the rebuild instead of
    1970, so polls no longer rescan every comment.
  - Turning on `index_comments` while an issue pass is unfinished no longer
    makes the rebuild skip issues.
  - Issues Linear reports as not found are deleted instead of failing the poll.
  - Comment times are marked as UTC.
  - State is reported once, at the end of each poll.

## 0.1.0

- Bootstrap npm release that creates the package: the same code as 0.2.0
  apart from the version, published by a maintainer without provenance.
  Superseded by 0.2.0.
