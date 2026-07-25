description: A brand-new device using the sync client has no way to download an existing database — the client can only fetch incremental changes, so it can never catch up from empty.
files:
  - packages/quereus-sync-client/src/sync-client.ts   # only sends handshake / get_changes / apply_changes today
  - packages/quereus-sync/src/sync/wire.ts            # get_snapshot, resume_snapshot, snapshot_chunk, snapshot_complete message shapes
  - packages/quereus-sync/src/sync/snapshot-stream.ts # applySnapshotStream, getSnapshotCheckpoint, resumeSnapshotStream
  - packages/sync-coordinator/src/server/websocket.ts # server side already handles both get_snapshot and resume_snapshot
difficulty: hard
----

## Problem

`SyncClient` speaks only the incremental half of the sync protocol: it
handshakes, asks for changes since a stored clock value, and pushes local
changes back. It never asks for a full copy of the database.

That is fine for a device that already has the data. It is not fine for a new
one: an empty client asking for "changes since nothing" is not the same as
receiving the database, and there is no code path that gets it there.

The server side is already built. The coordinator answers `get_snapshot` by
streaming the whole database in chunks, and answers `resume_snapshot` by
continuing a stream from a saved position. The engine side is also built —
`applySnapshotStream` consumes such a stream and writes it locally, saving a
position ("checkpoint") as it goes so an interrupted transfer can pick up where
it stopped. Only the client wiring between the two is missing.

## What "done" looks like

- A client with no local data can connect and end up with a full, usable copy of
  the database, then continue with normal incremental sync.
- If that download is interrupted (connection drop, app close), reconnecting
  continues from the saved position instead of starting over.
- Progress is observable — a caller can show "3 of 12 tables" rather than a
  silent multi-minute stall.

## Open questions for the design pass

- **When does the client decide it needs a snapshot?** Options: explicit caller
  request, automatic on first connect to an empty database, or a server signal
  that the requested starting point is too old to serve incrementally (the
  engine already has a `canDeltaSync` check for exactly this question).
- **What happens to changes the user makes locally while a snapshot is landing?**
  A snapshot application clears existing sync metadata before writing, so
  concurrent local writes need either blocking or a defined merge story.
- **How is a partially-applied snapshot surfaced?** A half-downloaded database
  is not queryable-correct; the client needs a state a caller can check before
  reading.
- **Retry policy.** The client already reconnects on transient errors; resume
  should hook that existing path rather than grow a second one.

## Context

Noticed during review of the resume-checkpoint serialization work: that ticket
made the `resume_snapshot` message actually sendable and taught the server to
decode it, but nothing in the shipped client ever sends it. Filing the client
gap separately rather than growing that fix.

Related, separate: `bug-sync-resume-snapshot-unvalidated-checkpoint` covers the
server trusting whatever position the client claims.
