description: When copying a database to another device is interrupted and later resumed, the last few rows of a table can be dropped without any error — both sides then believe the copy succeeded even though rows are missing.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts  # applySnapshotStream: `table-end` / `flushDataToStore` / `flushMetadataBatch`
  - packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts  # nearest existing coverage of the flush bounds
----

## Problem

The receiver of a streamed snapshot marks a table "completed" before that table's
last rows have actually been written to storage. If the transfer is interrupted in
that window and later resumed, the sender skips the table it is told is already
done, so those rows never arrive — and nothing reports a problem.

### Mechanics

`applySnapshotStream` accumulates incoming rows in `pendingDataChanges` and writes
them to storage in batches (every `DATA_FLUSH_SIZE` = 100 rows). Separately, it
periodically saves a resume checkpoint listing the tables it considers complete.

At the `table-end` chunk it does, in order:

1. push the table's remaining rows into `pendingDataChanges`, flushing each time
   the batch reaches 100;
2. append the table to `completedTables`.

Step 2 runs even though up to 99 rows are still only in memory. A checkpoint saved
between step 2 and the next flush therefore claims the table is fully applied while
some of its rows are not in storage.

The checkpoint is sent back to the sender on resume
(`resumeSnapshotStream` → `completedSet.has(tableKey)` → `continue`), so the sender
skips the table entirely. The receiver's CRDT metadata for that table was preserved
through `clearExistingMetadata`, so its column-version records still claim the rows
exist. Result: silent, permanent divergence — no error, no retry, and nothing
reconciles it afterwards.

### How narrow is the window?

Narrower than it first looks, because checkpoints are only saved from the
column-versions and tombstone chunk handlers (at 1000 metadata writes). After a
`table-end` the next chunk is either:

- **another `table-start`** — which now flushes pending data first (added by
  `sync-snapshot-stream-sends-ddl-after-data`), so the window is closed; or
- **the tombstone section** — which is *not* closed. Enough tombstones to trigger a
  checkpoint save while the last table's trailing rows are still pending reopens it.

So today it needs: a table whose row count is not an exact multiple of 100, no
further tables after it, at least 1000 tombstone entries behind it, and an
interruption in that window. Rare, but the failure is silent data loss, and the
window widens again if the flush cadence is ever changed.

## Expected behaviour

A table appears in `completedTables` only once every one of its rows is durably in
storage. A resumed transfer that skips a "completed" table must be safe to skip.

## Direction / open questions (for the fix pass)

- Simplest shape: hold newly-finished tables in a staging list and move them into
  `completedTables` inside `flushDataToStore`, after `applyDataToStore` returns.
  Keeps the current cross-table batching (no extra flush per table).
- Alternative: flush unconditionally at `table-end`. Simpler to read, but costs one
  store round-trip per table — bad for a database with many small tables.
- Needs a test that actually drives interrupt-then-resume over a table whose row
  count is not a multiple of the flush bound, and asserts the resumed receiver ends
  up with every row. No existing spec drives `resumeSnapshotStream` end-to-end
  against a large table.

Found during review of `sync-snapshot-stream-sends-ddl-after-data`; the ordering
bug that ticket fixed is unrelated to this one, though its `table-start` flush
happens to close most of this window.
