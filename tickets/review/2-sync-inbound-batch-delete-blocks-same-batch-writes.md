----
description: A device that received a row's deletion and a later re-creation of that row in one sync round used to lose the re-created row (its bookkeeping, and — under the resurrection setting — the row itself). One sync round now produces the same result as the same changes received across separate rounds.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - packages/quereus-sync/test/sync/_peer-harness.ts
  - docs/sync.md
difficulty: hard
----

Implements the inbound-apply half of `sync-delete-cleanup-misses-same-batch-writes`.
The local-capture half is `sync-local-capture-read-your-own-writes` (still in
implement/); it depends on the `keepColumns` helper parameter added here.

## What was wrong, as actually measured

The implement ticket predicted (from code reading, flagged as unconfirmed) that a
one-batch delete + re-creation would leave the row **present** in the store-backed
table with zero sync cell records. Measured with a real `Database` peer, the
prediction was wrong in one place: the store adapter collapsed each row's batch of
changes with **delete-wins-over-updates** (`buildRowOp`), so the row ended **absent**
from the table too. That changed the defect inventory:

- **Default (`allowResurrection: false`)**: final data happened to be right (row
  absent everywhere), but `ApplyResult` counted the blocked column changes as
  `applied` (measured `applied: 3, skipped: 0` where separate applies give
  `applied: 1, skipped: 2` per the two-column harness table) and `onRemoteChange`
  emitted them as applied.
- **`allowResurrection: true`**: the re-creation — which wins conflict resolution and
  must survive — lost in BOTH stores: Phase 3's delete cleanup wiped its cell
  records/change-log entries, and the adapter's delete-wins collapse kept it out of
  the actual table.

## What changed

- **`reconcileInBatchDeletes`** (`change-applicator.ts`): runs between Phase 1
  (resolve) and Phase 2 (store write) in both `applyChanges` and the quarantine
  drain (`drainTableGroup`). For each row, the max-timestamp in-batch applied delete
  blocks the batch's column changes by the exact `TombstoneStore.isDeletedAndBlocking`
  rule: everything blocked under the default; under `allowResurrection` only changes
  at or below the delete's timestamp. Blocked changes flip to `skipped` (data change
  dropped); surviving columns are recorded on the winning delete's new
  `ResolvedChange.keepColumns`. Counters, `dataChangesToApply`, and the
  `onRemoteChange` payload are all rebuilt from the reconciled outcomes.
- **`deleteRowVersionsAndLogEntries`** (`sync-context.ts`) and
  `ColumnVersionStore.deleteRowVersionsBatch` gained `keepColumns?: ReadonlySet<string>`
  — the post-delete cleanup skips those columns' cell records and their paired
  change-log entries. `commitChangeMetadata` passes each winning delete's set.
- **Store adapter** (`store-adapter.ts`): row-group collapse changed from
  delete-wins to **net effect in batch order** — a delete resets the row to absent,
  updates after it rebuild from a PK+nulls base (never the pre-delete image),
  updates with no later delete keep today's UPSERT merge. Required for the
  resurrection case to reach the table; behavior-identical when no update follows a
  delete.
- Grouping keys: `deleteKey`/`columnKey` now share `rowIdentityKey`; a table created
  by the same batch's DDL (no schema yet at reconcile time) groups under the raw pk
  encoding.
- Doc fixes: `SyncConfig.allowResurrection` comment now matches the code (false
  blocks **unconditionally**, not "earlier HLC" as it claimed); same correction plus
  the in-batch rule in `docs/sync.md` § Tombstones and Deletions.
- Test harness `makePeer` accepts `config?: Partial<SyncConfig>`.

## How to validate

`yarn workspace @quereus/sync run test` (547 passing) and `yarn typecheck` — both
green; full `yarn test` also run green.

Key cases, all in `changelog-orphan-cleanup.spec.ts` → "in-batch delete +
re-creation" (origin does insert / delete / re-insert as three local transactions;
receiver applies the resulting changesets in ONE `applyChanges` call, and a twin
receiver applies them one call each — **parity is asserted by direct comparison**,
not hardcoded numbers):

- resurrection on: 3 re-created cell records survive, 3 column log entries + the
  delete entry, `getChangesSince` re-emits the re-created row to a third peer
  identically from both receivers.
- default: 0 cell records, 1 log entry, `skipped` counts the blocked columns.
- reverse order (column writes older than the same-batch delete): still deleted
  under both settings, with an explicit guard that the delete's timestamp really is
  the max.
- store-backed (real `Database` peers): the actual `orders` table row re-appears
  (resurrection) / stays absent (default), matching separate applies.
- adapter unit tests (`store-adapter-seam.spec.ts`): the old "delete-wins" pin was
  **rewritten** to net-effect semantics, plus a new case proving a partial
  re-creation gets PK+nulls, not the pre-delete image.

## Known gaps / notes for the reviewer

- **Event-stream divergence (accepted, per ticket design):** reconciliation runs
  after Phase 1, but `resolveChange` emits `onConflictResolved` during Phase 1 — so
  a column change that loses to a pre-batch local version still emits, and a
  winner-then-blocked change can emit `winner: 'remote'` for a change that ends
  `skipped`. Separate applies would emit nothing for it. State, counters, and
  `onRemoteChange` are parity-exact; this one observational event is not.
- **Module/watch event shape:** a batched delete+re-create surfaces as one net
  `update`/`insert` store event where separate applies surface delete-then-insert
  (and a value-identical re-create nets to no event). Final data identical.
- **Adapter order sensitivity (tripwire, NOTE at `buildRowOp`):** net-effect
  collapse trusts batch order = timestamp order, which `getChangesSince` guarantees;
  `DataChangeToApply` carries no HLC to re-sort by. A reordering transport would
  need the HLC threaded through.
- **Fresh-table keying edge (comment at `rowIdentityKey`):** a same-batch
  create-table + delete + re-create with collation-variant pk spellings can group
  differently at reconcile (raw keying, pre-DDL) vs Phase 3 (resolved keying).
- **Open semantic question for whoever owns it:** the old `allowResurrection: false`
  doc claimed HLC-conditional blocking ("prevents any column write with earlier
  HLC"); the code blocks unconditionally until tombstone pruning. This ticket fixed
  the comment to match the code, per instruction — whether the *semantics* should
  instead match the old comment was explicitly left open.
- `emitConflictResolved` ordering aside, the sibling local-capture ticket
  (`sync-local-capture-read-your-own-writes`) will further change
  `deleteRowVersionsAndLogEntries` (caller-owned batch); the `keepColumns`
  parameter it expects is in place, and the KNOWN LIMITATION comment there is now
  scoped to the local half only.
