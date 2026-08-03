description: While a device is downloading a full copy of a database, anything the user writes at the same time is silently thrown away. There is no way to stop those writes, only a warning in the documentation.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # applySnapshotStream — clears metadata at the header, then overwrites cells unconditionally
  - packages/quereus-sync/src/sync/snapshot.ts          # applySnapshot — the non-streaming path has the same shape
  - packages/quereus-sync-client/src/sync-client.ts     # exposes the 'bootstrapping' status callers are asked to respect
----

## Problem

Downloading a full copy of a database ("bootstrap") is destructive by design: it
clears the receiver's sync bookkeeping and then writes every incoming row's
bookkeeping record straight over whatever is there, without comparing timestamps
the way normal incoming changes do.

If the application writes to the database while that is happening, the write
lands, and is then overwritten by the download with no conflict reported and no
record left to push the write back to the server. It is lost.

Today the only protection is a documented contract: the sync client publishes a
`bootstrapping` status and its documentation says do not write during it. Nothing
enforces it, and an app that ignores it gets silent data loss rather than an
error.

Filed while planning `feat-sync-client-snapshot-bootstrap`, which introduced the
observable status and the documented contract but deliberately stopped short of
enforcement.

## What a fix would need to decide

- **Where the barrier lives.** The sync client cannot block application writes —
  it does not sit on the write path. Enforcement has to be in the engine or the
  store layer, which means a way for a snapshot apply to mark the database
  closed for local writes and release it at the footer.
- **What a blocked write does.** Fail fast with a clear error, or queue and
  replay after the bootstrap finishes? Replay is friendlier but reintroduces the
  merge question the current design avoids by declaring the snapshot the winner.
- **Crash release.** A barrier taken at the header and released at the footer
  must not survive a crash mid-transfer, or the database is permanently
  read-only. A durable barrier needs a release path that a resumed transfer (or
  an explicit abandon) can drive.
- **Scope.** The same hazard exists on the non-streaming `applySnapshot` path;
  decide whether one barrier covers both.
