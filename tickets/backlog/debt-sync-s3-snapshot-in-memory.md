description: A code comment claims the sync server streams database snapshots to and from S3, but it actually loads the whole snapshot into memory as one big string first, which will blow up on large databases.
files:
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts
  - packages/sync-coordinator/src/service/s3-batch-store.ts
tradeoffs: Only bites large databases on the coordinator, which no deployment has reported hitting, and it depends on confirming the AWS SDK streaming body shape fits the snapshot chunk stream.
----

## Problem

The S3 snapshot store fully materializes a snapshot as a single in-memory string before
upload (and, presumably, on download) despite a comment claiming the path is streamed. A
large database's snapshot is held entirely in memory, so the coordinator's peak memory scales
with snapshot size — an OOM risk at scale.

Surfaced by the same review as the shared-protocol work.

## Direction / open questions (for the fix pass)

- The sync engine already produces snapshots as an async chunk stream
  (`getSnapshotStream` in `packages/quereus-sync/src/sync/snapshot-stream.ts`) — the fix is to
  carry that stream through to the S3 SDK's streaming upload/download rather than
  `JSON.stringify`-ing the whole thing.
- Confirm the AWS SDK client in use (`@aws-sdk/client-s3`) supports the streaming body shape
  needed and the object size fits the intended part/multipart approach.
- Fix the misleading comment either way.

Performance/scaling hardening; only bites large databases, hence backlog rather than an
active bug.
