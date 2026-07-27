----
description: When a device downloads a full copy of a synced database, it now works out for itself which rows are which instead of taking the sender's word for it — fixing unreachable bookkeeping (and silent row resurrection) after bootstrapping from a relay server.
prereq: sync-snapshot-stream-sends-ddl-after-data
files:
  - packages/quereus-sync/src/sync/protocol.ts                # record-shaped entries, SNAPSHOT_WIRE_FORMAT_VERSION, snapshotFormat on header + Snapshot
  - packages/quereus-sync/src/sync/wire.ts                    # serialized shapes + both codec directions
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # producer emits records; receiver derives identity + HLC-max reconciliation
  - packages/quereus-sync/src/sync/snapshot.ts                # non-streaming producer/apply; per-cell HLC-ascending data changes
  - packages/quereus-sync/src/metadata/column-version.ts      # setColumnVersionByIdentityBatch deleted (inlined into pk-taking setter)
  - packages/quereus-sync/src/metadata/tombstones.ts          # setTombstoneByIdentityBatch deleted
  - packages/quereus-sync/src/metadata/change-log.ts          # recordColumnChangeByIdentityBatch deleted; deleteEntryByIdentityBatch kept
  - packages/quereus-sync/src/index.ts                        # exports SNAPSHOT_WIRE_FORMAT_VERSION, SnapshotTombstone
  - packages/quereus-sync/test/sync/snapshot-receiver-derives-identity.spec.ts  # NEW: relay bootstrap, collapse, timespan, format gate
  - packages/quereus-sync/test/sync/pk-key-identity.spec.ts   # stale sender-trust comment rewritten
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quereus-sync/test/wire.spec.ts
  - docs/sync.md                                              # § Row identity vs. address, § Snapshot wire-format version, type listings
difficulty: hard
----

## What was built

Snapshot bootstrap previously filed incoming per-row bookkeeping (column versions,
tombstones, change-log entries) under the **sender's** pk-identity strings taken
verbatim off the wire. A relay server has no table definitions, so it keys raw
values; a receiver that holds the definition derives a different identity for the
same row (`'Apple'` vs the nocase-folded `'apple'`), so bootstrapped bookkeeping
became unreachable — a snapshot-carried deletion stopped blocking stale writes.

Three coordinated changes:

**1. No identity on the wire.** `SnapshotColumnVersionsChunk.entries` is now
`ReadonlyArray<{ column, hlc, value, pk }>` (was a packed
`[${identity}:${column}, hlc, value, pk]` tuple, which also mis-parsed column
names containing `:`). `identity` removed from tombstone shapes;
`TableSnapshot.columnVersions` is a flat record array (was a Map keyed by
identity:column). `wire.ts` serialized shapes and both codec directions updated.

**2. Loud format gate.** `SNAPSHOT_WIRE_FORMAT_VERSION` (= 1) is stamped into the
streaming header chunk (`snapshotFormat`) and the non-streaming `Snapshot`. Both
apply paths throw on a missing/mismatched stamp **before touching local state**,
with a status:'error' event. This protects against the coordinator's S3 store,
which persists serialized chunks at rest — an old stored snapshot would otherwise
silently mis-parse. Recovery: regenerate the snapshot (documented in docs/sync.md
§ Snapshot wire-format version).

**3. Receiver derives, and reconciles collapses by timestamp.** Both apply paths
derive identity locally via the pk-taking store setters. Because a raw-keyed
sender can hold several records for what the receiver considers one row, the
receiver reconciles per (derived identity, column) — and per identity for
tombstones — keeping the **greatest-HLC** entry, so a collapse resolves by
last-writer-wins, not batch order, and each surviving cell has exactly one cv:
record + one cl: entry (so `getChangesSince` re-emits it once). Collapsed rows
are addressed by the newest write's pk spelling.

Mechanically, `applySnapshotStream` accumulates one table's cells keyed by
derived identity (same memory bound as the old accumulator), writes metadata +
data at `table-end`; tombstones accumulate per (schema, table) and flush on table
change and at footer (correct only because the producer's key-sorted `tb:` scan
keeps one table's chunks contiguous — NOTE at the site). `applySnapshot` does the
same reconciliation inside `commitMetadata`.

The three `…ByIdentityBatch` WRITE setters are deleted (no callers remain);
`ChangeLogStore.deleteEntryByIdentityBatch` is kept for the tombstone GC sweep.

## Design decisions a reviewer should probe

- **Non-streaming data path is per-cell.** `applySnapshot` builds its data
  changes BEFORE the snapshot's own DDL runs (data + schema go to the store in
  one `applyToStore` call), so no receiver keying is resolvable at that point.
  It emits one single-column update per cell, HLC-ascending across the table:
  the store collapses pk spellings with the same rules the identity uses, so
  the data converges to per-cell LWW matching the reconciled metadata. This
  relies on the store's external-write spelling collapse agreeing with
  `encodePkIdentity` — true by construction (both mirror engine row identity),
  but worth a skeptical look. O(cells) updates is a deliberate tradeoff for the
  small-database path (NOTE at the site). The streaming path groups rows
  normally (DDL has landed by `table-end`).
- **Keying-resolution failures now precede data-flush failures.** A snapshot
  naming a table with no local definition and no create-table migration fails
  with "No table schema for main.X" at derivation (status:'error' emitted, same
  posture as the drift gate) instead of "apply-to-store failed" later. The
  ticket deemed this the right outcome; `snapshot-bootstrap.spec.ts`
  ("mid-bootstrap failure") pins the new shape.
- **Tombstone-only tables.** A fully-deleted table has no `table-start`, so the
  tombstone handler calls `flushDataToStore()` first to push pending DDL before
  resolving keying (no-op on later chunks). Caught by the existing
  snapshot-tombstones-and-drift spec during implementation.
- **Row address = newest write's spelling.** Any spelling from the equivalence
  class is valid; newest was chosen for determinism. Check the collapse specs if
  a different rule seems preferable.

## Verification performed

- NEW `test/sync/snapshot-receiver-derives-identity.spec.ts`:
  - relay-as-sender bootstrap (the ticket's confirmed reproduction, promoted):
    metadata findable under other spellings, stale pre-delete write for a third
    spelling does NOT resurrect the row;
  - two-spellings collapse via a real raw-keyed relay: one surviving record,
    later HLC wins, `getChangesSince` emits it once (streaming AND non-streaming
    variants);
  - `timespan` variant (`PT1H`/`PT60M` — semantic transform, not collation);
  - format-gate refusal on both paths, pre-existing metadata untouched.
- `pk-key-identity.spec.ts` bootstrap spec passes unchanged (its sender-trust
  comment rewritten).
- Full runs: `yarn workspace @quereus/sync test` → 593 passing, 0 failing;
  root `yarn test` → all workspaces green (7401 engine + all others);
  `yarn build` and `yarn typecheck` clean; sync-client (52) and
  sync-coordinator (134) suites pass against the new wire shapes.

## Known gaps / candidate review angles

- **No compatibility shim for old serialized snapshots** — deliberate (backwards
  compat out of scope per project rules); the gate makes them fail loudly. An
  operator with S3-stored snapshots must regenerate after deploying this.
- **Tombstone `createdAt` still re-bases to bootstrap time** (pre-existing,
  NOTE kept at both write sites).
- The relay-restore path (`StoreManager.onStoreCreated` applying an S3 snapshot
  to a fresh relay) is exercised only indirectly (relay keying = RAW = derived,
  and coordinator tests pass); no new spec drives that exact path end-to-end.
- Mid-table checkpoint saves now happen only during `table-end`/tombstone
  writes (metadata accumulates during chunk processing instead of writing
  eagerly), so `lastEntryIndex` in a checkpoint can lag `entriesProcessed`
  reporting. Resume correctness is unaffected — it keys off `completedTables`,
  which still updates only at `table-end`.

## Review findings

(to be filled by review)
