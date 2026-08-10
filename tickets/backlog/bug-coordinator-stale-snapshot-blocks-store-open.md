----
description: If the sync server has an old saved backup of a database that a newer build can no longer read, that database can never be opened again — the server refuses to start it up instead of just ignoring the unusable backup and rebuilding from the clients that reconnect.
files:
  - packages/sync-coordinator/src/service/coordinator-service.ts   # restoreFromS3 — applies the stored snapshot, no error handling
  - packages/sync-coordinator/src/service/store-manager.ts         # openAndRestore — closes the store and rethrows on callback failure
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts     # downloadLatestSnapshot — reads the persisted chunk array
  - packages/quereus-sync/src/sync/snapshot-stream.ts              # applySnapshotStream — the header format gate that throws
  - docs/sync.md                                                   # § Snapshot wire-format version — operator note describing today's manual recovery
difficulty: medium
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Filed below corruption because no data is lost - the database rebuilds from reconnecting clients once an operator deletes the stale snapshot objects - so the cheapest fix may be to make the error say that rather than to change the restore path.
----

## What happens today

The sync server (the "coordinator") keeps a periodic full backup of each database
in cloud object storage, plus the incremental batches written since that backup.
When it is asked for a database it has no local copy of, it downloads the backup,
loads it, and replays the batches on top.

Snapshots now carry a format stamp, and a loader that does not recognise the
stamp refuses the snapshot outright rather than mis-reading it. That refusal is
the right call — but it surfaces in the worst possible place:

- the refusal is thrown out of the restore step,
- the restore step is the "new store was just created" callback,
- and that callback's failure handler closes the store and rethrows.

So the database simply fails to open. Every subsequent attempt repeats the same
download and the same failure. Nothing in the pipeline notices that the *only*
unusable thing is the backup file.

The operator's escape hatch (documented in `docs/sync.md`) is to delete the
stale snapshot objects from the bucket by hand; the server then opens empty and
rebuilds from the clients that reconnect. But nothing tells them that — the error
they see says "regenerate the snapshot from a live peer", which is impossible
while the database will not open.

This is not a one-time upgrade wrinkle. The format stamp is meant to be bumped on
any future breaking change to snapshot contents, so the same wedge recurs at
every bump.

## Why it matters

A missing backup is already handled gracefully: the server logs "no snapshot
found" and starts empty. An *unreadable* backup is strictly less information than
a missing one, yet it is treated as fatal. For a relay whose whole job is to
re-accumulate state from the clients that connect to it, refusing to start is a
worse outcome than starting empty.

## What to decide / build

Pick and implement a policy for "the stored snapshot cannot be loaded":

- **Log loudly and continue empty**, matching the missing-snapshot path — the
  server keeps serving, the operator sees a clear warning, and the next snapshot
  it writes carries the current format. Risk: the batches replayed on top of an
  empty store may reference state the discarded snapshot held, so the recovery
  needs to decide whether to also skip those batches.
- **Refuse but self-explain** — keep failing the open, but with an error that
  names the exact bucket keys to remove and says the database will not open until
  they are gone.
- **Archive and continue** — move the unreadable snapshot objects aside
  (preserving them for forensics), then continue empty.

Whichever is chosen, distinguish "cannot load this snapshot" from a genuine
storage/permission failure: the latter probably *should* still be fatal.

## Notes

- Only the coordinator's restore path is affected. A client bootstrapping from a
  live peer sees the same refusal, but there the snapshot is regenerated on
  demand, so retrying against an upgraded peer resolves it.
- Reproduction needs an object-storage-backed coordinator; the existing
  coordinator suite does not drive `restoreFromS3` end to end, so a regression
  test for whichever policy is chosen would be new coverage.
