description: Copying a whole database to a new device fails outright whenever any table has more than a hundred rows, because the table's rows are sent before the instruction that creates the table.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # streamSnapshotChunks (producer), applySnapshotStream (consumer)
  - packages/quereus-sync/src/sync/store-adapter.ts     # applies schema changes before data within one call
  - packages/quereus-sync/test/sync/                    # new spec
  - docs/sync.md                                        # § Streaming Snapshot API chunk order
difficulty: medium
----

## What is broken

`getSnapshotStream` emits its chunks in this order:

```
header → [table-start, column-versions…, table-end]* → schema-migration* → tombstone* → footer
```

The `create table` statements come **after** every table's rows.

`applySnapshotStream` gets away with that only by accident. It buffers row data in
`pendingDataChanges` and schema statements in `pendingSchemaChanges`, and hands both to
the store in one `applyToStore` call — which applies DDL before DML *within a single
call*. As long as nothing forces an early flush, all the rows and all the DDL land in the
same final call at `footer`, and the DDL wins the ordering.

But the consumer flushes early once `pendingDataChanges` reaches `DATA_FLUSH_SIZE`
(100). That flush happens at `table-end`, which is still **before** any
`schema-migration` chunk has arrived. So the flush carries rows with no DDL, and on a
receiver that does not already have the table every one of those rows fails.

Verified against real engine peers: peer A creates `big (id integer primary key, v text)`,
inserts 150 rows; a fresh peer B calls `applySnapshotStream` over A's stream and the
apply throws:

```
apply-to-store failed for 100 change(s): main.big (update): Table not found for
external write: main.big; …
```

The same bootstrap with fewer than 100 rows succeeds, which is why every existing
snapshot test passes.

Consequence: the streaming bootstrap path — the one a new device uses to download a
copy of a synced database — is unusable for any table of realistic size.

## Fix

Send the schema statements first.

In `streamSnapshotChunks`, move the schema-migration emission loop from its current
position (after the per-table loop) to immediately after the `header` yield. The
migration scan bounds (`smBounds`) are already computed above for the header's
`migrationCount`, so this is a move, not a new scan. Resulting order:

```
header → schema-migration* → [table-start, column-versions…, table-end]* → tombstone* → footer
```

In `applySnapshotStream`, make the migration section actually reach the store before the
first table's rows do: at `table-start`, flush any accumulated `pendingSchemaChanges`.
Reaching a `table-start` is precisely "the migration section has ended", so a single
flush there is sufficient — later `table-start`s find nothing pending and the flush is a
no-op. `applyDataToStore` already returns early when both pending arrays are empty.

Nothing else needs to change:

- `applySchemaChange` is already idempotent (`decideSchemaChange` skips a `create_table`
  whose object is already in the wanted state and throws only on a genuine
  same-name/different-definition collision), so a resumed transfer — which re-emits every
  migration — stays correct.
- The non-streaming `applySnapshot` is already correct: it admits the whole snapshot as
  one `admitGroup`, whose single `applyToStore` call applies DDL before DML.
- `SnapshotHeaderChunk.migrationCount` and the footer totals are unaffected.

## Verification

New spec covering the failure directly: a table with more than `DATA_FLUSH_SIZE` rows,
streamed from a peer that has the table to a fresh peer that does not, must bootstrap all
rows. Keep the row count comfortably above 100 (150 is enough) and assert the full row
count on the receiver, not just that the apply did not throw.

Also confirm the existing streaming snapshot specs (including the resume/checkpoint ones)
still pass — the chunk order they observe changes.

## TODO

- [ ] Move the schema-migration emission loop in `streamSnapshotChunks` to directly after
      the header yield.
- [ ] Flush `pendingSchemaChanges` at `table-start` in `applySnapshotStream`.
- [ ] Add a spec: 150-row table, fresh receiver, streaming bootstrap, assert all rows land.
- [ ] Update `docs/sync.md` where it describes the streaming snapshot chunk order, and
      state that DDL now precedes table data (the receiver depends on it).
- [ ] Run `yarn workspace @quereus/sync test` and `yarn build`.
