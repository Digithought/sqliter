----
description: When a device downloads a full copy of a synced database, it now works out for itself which rows are which instead of taking the sender's word for it — fixing unreachable bookkeeping (and silent row resurrection) after bootstrapping from a relay server.
files:
  - packages/quereus-sync/src/sync/protocol.ts                # record-shaped entries, SNAPSHOT_WIRE_FORMAT_VERSION, snapshotFormat stamp
  - packages/quereus-sync/src/sync/wire.ts                    # serialized shapes + both codec directions
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # producer emits records; receiver derives identity + HLC-max reconciliation
  - packages/quereus-sync/src/sync/snapshot.ts                # non-streaming producer/apply; per-cell HLC-ascending data changes
  - packages/quereus-sync/src/sync/snapshot-identity.ts       # NEW (review): shared keying resolver + cell/tombstone reconciliation
  - packages/quereus-sync/src/metadata/column-version.ts      # setColumnVersionByIdentityBatch deleted
  - packages/quereus-sync/src/metadata/tombstones.ts          # setTombstoneByIdentityBatch deleted
  - packages/quereus-sync/src/metadata/change-log.ts          # recordColumnChangeByIdentityBatch deleted; deleteEntryByIdentityBatch kept
  - packages/quereus-sync/src/index.ts                        # exports SNAPSHOT_WIRE_FORMAT_VERSION, SnapshotTombstone
  - packages/quereus-sync/test/sync/snapshot-receiver-derives-identity.spec.ts  # relay bootstrap, cell + tombstone collapse, timespan, format gate
  - docs/sync.md                                              # § Row identity vs. address, § Snapshot wire-format version
----

## What shipped

Snapshot bootstrap previously filed incoming per-row bookkeeping (column
versions, tombstones, change-log entries) under the **sender's** pk-identity
strings taken verbatim off the wire. A relay server has no table definitions, so
it keys raw values; a receiver that holds the definition derives a different
identity for the same row (`'Apple'` vs the nocase-folded `'apple'`), so
bootstrapped bookkeeping became unreachable — a snapshot-carried deletion stopped
blocking stale writes.

Three coordinated changes landed in implement:

1. **No identity on the wire.** `SnapshotColumnVersionsChunk.entries` is a
   `ReadonlyArray<{ column, hlc, value, pk }>` (was a packed
   `[${identity}:${column}, hlc, value, pk]` tuple, which also mis-parsed column
   names containing `:`); `identity` removed from tombstone shapes;
   `TableSnapshot.columnVersions` is a flat record array.
2. **Loud format gate.** `SNAPSHOT_WIRE_FORMAT_VERSION` (= 1) is stamped into the
   streaming header chunk and the non-streaming `Snapshot`. Both apply paths
   throw on a missing/mismatched stamp before touching local state.
3. **Receiver derives, and reconciles collapses by timestamp.** Both apply paths
   derive identity locally. Because a raw-keyed sender can hold several records
   for what the receiver considers one row, the receiver keeps the greatest-HLC
   entry per (derived identity, column) — and per identity for tombstones — so a
   collapse resolves by last-writer-wins, not batch order.

## Review findings

### Checked

Read the implement diff (`4918162a`) before the handoff summary, then read every
touched source file plus the ones it depends on but did not touch: the pk-keying
resolver (`metadata/pk-identity.ts`), the store adapter's row grouping and merge
(`sync/store-adapter.ts`), the delta path's equivalent in-batch reconciliation
(`sync/change-applicator.ts`), and the coordinator's snapshot persistence and
restore (`sync-coordinator/src/service/{s3-snapshot-store,coordinator-service,store-manager}.ts`).

Specifically probed, and found **sound**:

- **The "store collapses spellings the same way the identity does" claim** that
  the non-streaming per-cell data path rests on. It holds: `PkKeying` and the
  adapter's `makePkIdentityEncoder` both resolve from the same `TableSchema` via
  `resolvePkKeying`, and the adapter groups rows by that identity before merging.
- **NOT NULL / partial-row risk from the switch to one update per cell.** Not
  reachable: the adapter collapses a row group into a single upsert before it
  touches storage, so no intermediate one-column row is ever written.
- **HLC ties splitting metadata (first-wins) from data (last-wins).** Not
  reachable: `compareHLC` orders on `(wallTime, counter, siteId, opSeq)`, and
  `opSeq` increments per fact within a transaction, so two distinct records for
  one `(identity, column)` cannot tie.
- **Resume/checkpoint correctness after metadata moved to `table-end`.** Improved,
  not regressed: an interrupted table now writes no partial metadata at all, and
  resume still keys off `completedTables`, which updates only at `table-end`.
- **Tombstone contiguity assumption.** The producer's `tb:` scan is key-sorted and
  the key prefix guarantees no interleaving, so flushing on table change is
  correct; the NOTE at the site says so.

### Fixed in this pass (minor)

- **Duplicated reconciliation logic.** The memoized keying resolver (~15 lines)
  and the greatest-HLC cell/tombstone merge (~25 lines) were copy-pasted between
  `snapshot-stream.ts` and `snapshot.ts` — two places that must never drift, since
  a difference between them is exactly the class of bug this ticket fixed.
  Extracted to `src/sync/snapshot-identity.ts` (`createSnapshotKeyingResolver`,
  `reconcileCell`, `keepMaxHLC`, `tableScopedRowKey`); both call sites now share
  one definition. Net −60 lines across the two files.
- **`TableSnapshot.rows` was write-only.** `getSnapshot` materialized a `Row[]`
  for every row in the database that no consumer has ever read (the apply path
  builds from `columnVersions`, and the type has no wire codec). Removed the field
  and its construction; updated the three test literals and the docs type listing.
- **Composite map keys used a literal NUL byte in the source.** `snapshot.ts` and
  `snapshot-stream.ts` each embedded a raw U+0000 in a template literal, which
  made both files register as binary to `grep`/`file`. The shared helper
  length-prefixes each component instead — collision-proof for quoted identifiers
  and arbitrary pk identities, and printable.
- **Stale comment.** The tombstone handler claimed its `flushDataToStore()` was a
  no-op on every later chunk; the *first* tombstone chunk legitimately carries the
  last table's un-flushed row tail. Corrected.
- **Test gap: tombstone collapse.** The two-spellings-of-one-row collapse was
  covered for cells but not for tombstones, even though tombstones have their own
  reconciliation path. Added a spec driving a real raw-keyed relay holding two
  tombstones for one row, asserting both spellings resolve to one record carrying
  the later HLC, and — decisively — that a write timestamped *between* the two
  deletes stays blocked (it would resurrect the row had the earlier tombstone
  won).

### Filed as a new ticket (major)

- `backlog/bug-coordinator-stale-snapshot-blocks-store-open` — the new format
  gate throws out of the coordinator's S3 restore, which runs inside
  `StoreManager.openAndRestore`'s "new store created" callback; that handler
  closes the store and rethrows. A coordinator holding a stale-format snapshot
  therefore **cannot open that database at all**, and the error text ("regenerate
  the snapshot from a live peer") describes a recovery that is impossible while
  the database will not open. A *missing* snapshot is already handled gracefully
  (log, start empty); an unreadable one is strictly less information yet is fatal.
  Not a one-time upgrade wrinkle — the stamp is meant to be bumped again. The
  gate itself is correct and stays; the ticket is about the coordinator's
  disposition of an unloadable snapshot. `docs/sync.md` now carries an operator
  note with today's manual recovery (delete the bucket's snapshot objects) and
  points at the ticket.

### Recorded as tripwires (not tickets)

- **Non-streaming collapse stores the earliest pk spelling.** The adapter's row
  group takes `changes[0].pk`, and the per-cell changes are HLC-ascending, so the
  stored row keeps the *oldest* spelling while the metadata files the *newest*.
  Both are valid addresses for one identity, so lookups and relays agree — but two
  receivers of the same snapshot can display different pk text. `NOTE:` at the
  site in `snapshot.ts`.
- **Streaming accumulator constant factor.** Reconciliation holds an HLC per cell,
  not just a value, so the per-table accumulator costs more than the one it
  replaced (same O-bound). `NOTE:` at the declaration, with the remedy if a very
  wide table ever strains it.
- Pre-existing NOTEs left in place: bootstrapped tombstone `createdAt` re-bases to
  bootstrap time; checkpoint `lastEntryIndex` can lag `entriesProcessed`.

### Deliberately not changed

- **No compatibility shim for old serialized snapshots.** Correct per project
  policy (backwards compat out of scope); the gate makes them fail loudly rather
  than mis-parse.
- **Relay-restore path still has no dedicated end-to-end spec.** Driving it needs
  object storage; noted in the backlog ticket rather than stubbed here.
- **Snapshot apply has no quarantine diversion** for a table outside the local
  basis, unlike the delta path. In practice unreachable: a snapshot carries the
  sender's full migration set, so its tables exist locally by the time keying is
  resolved, and a relay receiver (no schema oracle) resolves everything to raw
  keying and never throws. Left as-is rather than speculatively hardening.

## Verification

- `yarn workspace @quereus/sync test` → **594 passing, 0 failing** (593 before,
  plus the new tombstone-collapse spec).
- `yarn test` (all workspaces) → all green: 7401 engine, 594 sync, 134
  sync-coordinator, 52 sync-client, 1081 store, and the rest. 0 failing.
- `yarn build`, `yarn typecheck`, `yarn lint` → clean.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not
  written.
