description: When a device deletes a row and writes that same row again inside one transaction, sync gets it wrong — depending on the order, the rewritten row is thrown away on receiving devices, or the deleted row's data is left behind forever on the device that deleted it.
files:
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
difficulty: hard
----

## One root cause

Deleting a row has to clean up the sync bookkeeping for that row's cells. That
cleanup (`deleteRowVersionsAndLogEntries`, `sync/sync-context.ts`) works by
*scanning the key-value store* for the row's cell records, then deleting what it
found.

A scan only sees what has already been written. Both callers batch their writes and
flush the batch at a different moment than the cleanup runs, so the cleanup is blind
to writes that belong to the very same transaction. When one transaction touches the
same row with both a delete and a write, the two disagree, and which way it breaks
depends on which happens to be flushed first.

This pre-dates the change-log orphan-cleanup work — the old code
(`ColumnVersionStore.deleteRowVersions`) scanned the same way and had the same blind
spot. Nothing here is a regression; it is a hole that ticket's tests did not cover.

## Symptom 1 — data loss on a receiving device (worse)

`commitChangeMetadata` (`sync/change-applicator.ts`) writes all incoming records in
one batch, flushes it, and *then* runs the delete cleanup for every winning delete.
So the cleanup sees, and deletes, cell records the same batch just wrote.

`applyChanges` accumulates every incoming transaction in the array it is handed
before committing once. So a device that receives "delete row 1" and "re-create row
1" together — routine when a relay or a reconnecting client catches up on several
transactions at once — loses the re-created row entirely, even though the re-create
is newer and won conflict resolution.

Reproduced against `main`: origin inserts row 1, deletes it, re-inserts it with new
values (three separate local transactions); the relay applies all of them in one
`applyChanges` call; the relay ends with **zero** cell records for row 1. Expected:
the three cells of the re-insert.

## Symptom 2 — permanent garbage on the deleting device

`recordDataEvent` (`sync/sync-manager-impl.ts`) is the mirror image: it queues the
transaction's writes into an outer batch that is flushed *after* every event is
processed, and the delete cleanup runs mid-way, against store state that does not yet
include them.

So if a transaction writes a row and then deletes it, the delete cleans up nothing,
and the outer batch afterwards writes the cell records anyway. The row is tombstoned
but its cells stay live locally, forever — they are never revisited unless the same
primary key is deleted again. Other devices resolve the row as deleted (the delete
carries the higher timestamp), so this shows up as unbounded local storage growth
rather than as wrong data.

Reproduced against `main`, both `insert`-then-`delete` and `update`-then-`delete` in
one transaction: three live cell records survive the delete in each case.

This is the same unbounded-growth failure that `1-sync-changelog-orphan-cleanup` set
out to close, still open on the same-transaction path.

## Expected behaviour

Within one transaction (local) or one apply batch (inbound), a delete and a write to
the same row must resolve by timestamp, exactly as they would if they had arrived in
separate transactions:

- Later write wins → the row's cells are live afterwards, indexed in the change log,
  and reach other devices.
- Later delete wins → the row's cells and their change-log entries are gone
  afterwards; only the tombstone and its change-log entry remain.

Neither order may leave cell records behind that no live row owns, and neither may
discard a write that won.

## Notes for whoever picks this up

- The ordering that *does* work today is delete-then-reinsert on the local path, and
  `changelog-orphan-cleanup.spec.ts` now has a test pinning it
  ("keeps a reinsert that follows a delete of the same row in one transaction").
  Whatever fix lands must keep that passing.
- Resolution already collapses in-batch repeats per key on the inbound path
  (`deleteWinners` / `columnWinners` in `commitChangeMetadata`), but the two maps are
  independent — a delete and a column change for the same row are both "winners" and
  never compared against each other. That comparison is probably where the inbound
  half belongs.
- Beware the reason the local path was left as-is: folding the cleanup into the outer
  batch changes what a same-transaction reinsert observes as its own before-image
  (`getColumnVersion` would still return the pre-delete value). Any fix needs an
  answer for that, not just a reordering.
- `sync/sync-context.ts` carries a `KNOWN LIMITATION` comment naming this slug.
