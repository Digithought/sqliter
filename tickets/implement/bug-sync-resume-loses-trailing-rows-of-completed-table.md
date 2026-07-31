description: While copying a database to another device, the receiver records "this table is done" in its restart-point file. Today that record happens to be written only after the table's rows are safely stored, but nothing in the code enforces it — so a small unrelated edit elsewhere would silently start losing the last rows of a table on a resumed copy. Make the rule explicit, and add the missing test coverage for resuming an interrupted copy.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts  # applySnapshotStream: `table-end`, `flushDataToStore`, `flushMetadataBatch`
  - packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts  # nearest existing coverage of the flush bounds
  - packages/quereus-sync/test/sync/_peer-harness.ts  # makePeer / toStream / localWrite
difficulty: easy
repro: none — verified NOT reproducible at HEAD; reproduces immediately once one unrelated line is removed (counter-experiment below)
----

## What was found

The originating ticket predicted silent row loss on a resumed snapshot transfer.
**It does not happen at HEAD.** The window it described is closed — but closed
*incidentally*, by a line that exists for an unrelated reason and carries a comment
saying so. So the safety property is real, load-bearing, and undocumented.

This ticket is therefore **hardening plus missing test coverage**, not a live bug fix.
Do not describe it as fixing observable data loss.

### The property that must hold

`applySnapshotStream` (`packages/quereus-sync/src/sync/snapshot-stream.ts`) accumulates
incoming rows in `pendingDataChanges` and pushes them to storage in batches of
`DATA_FLUSH_SIZE` (100). Separately it saves a resume checkpoint listing the tables it
considers complete. On resume the sender reads that list and **skips those tables
entirely** (`resumeSnapshotStream` → `completedSet.has(tableKey)` → `continue`), and the
receiver preserves their CRDT metadata through `clearExistingMetadata` — so a table named
in a checkpoint is never re-sent and never reconciled afterwards.

The invariant: **a table may appear in a saved checkpoint's `completedTables` only after
every one of its rows has returned from `applyDataToStore`.**

Nothing states or enforces this. The `table-end` handler appends to `completedTables`
(`snapshot-stream.ts:653-655`) while up to 99 of that table's rows are still only in
`pendingDataChanges`.

### Why it is nevertheless safe today

Every path that can save a checkpoint happens to have drained `pendingDataChanges` first:

- **checkpoint from the `table-end` row loop** (`batchSize` crosses `BATCH_FLUSH_SIZE`) —
  `completedTables` excludes the table being processed, and every earlier table's rows
  were flushed at this table's `table-start`.
- **checkpoint from a `tombstone` chunk** — the handler calls `flushDataToStore()`
  unconditionally at its top (`snapshot-stream.ts:585`) before `flushTombstones()` can
  trigger a checkpoint.
- **checkpoint from the `footer`** — `flushTombstones()` runs before `flushDataToStore()`
  there, but the last `tombstone` chunk already drained the pending rows and no chunk
  after it adds any.

That `snapshot-stream.ts:585` flush was added by `sync-snapshot-receiver-derives-row-identity`
so a fully-deleted table's `create table` reaches the store before `resolveKeying` runs.
Its comment explains exactly that. Checkpoint safety is a side effect nobody wrote down.

### How this was verified

Probe spec: wrap the receiver's `applyToStore` to count rows actually pushed to storage,
and wrap the receiver's `kv.put` to snapshot `completedTables` at every `sc:` checkpoint
write. Sender: table `big` with 150 rows (`DATA_FLUSH_SIZE + 50`, deliberately not a
multiple of the flush bound) plus table `ghost` with 1200 rows inserted then fully deleted
(1200 tombstones, above the 1000 `BATCH_FLUSH_SIZE`). Receiver is fresh.

- **At HEAD:** one checkpoint save, `completedTables: ["main.big"]`, `rowsApplied: 150`.
  Invariant holds; all 150 rows land.
- **With `snapshot-stream.ts:585`'s `await flushDataToStore();` commented out** (nothing
  else changed): same single checkpoint save, `completedTables: ["main.big"]`,
  `rowsApplied: **100**`. The checkpoint tells the sender `main.big` is done while 50 of
  its rows are still in memory. A resume from that checkpoint drops those 50 rows with no
  error on either side.

The counter-experiment was reverted; `snapshot-stream.ts` is unmodified.

## Work

Two independent arms, both at the one site (`applySnapshotStream`).

**Arm 1 — make the invariant structural.** Stage newly-finished tables and graduate them
into `completedTables` only inside `flushDataToStore`, after `applyDataToStore` returns.
No extra store round-trip; cross-table batching is unchanged.

```ts
// Tables whose `table-end` arrived but whose trailing rows may still sit in
// `pendingDataChanges`. They graduate into `completedTables` only once
// `applyDataToStore` has returned — a checkpoint naming a table whose last rows
// are still in memory tells the sender to skip that table on resume, and those
// rows are then never sent, never reconciled, and never reported.
let stagedCompletedTables: string[] = [];

const flushDataToStore = async (): Promise<void> => {
  // ...unchanged...
  await applyDataToStore(ctx, pendingDataChanges, schemaChanges, { remote: true, bootstrap: true });
  pendingDataChanges = [];
  pendingSchemaMigrations = [];
  completedTables.push(...stagedCompletedTables);
  stagedCompletedTables = [];
};
```

`table-end` then pushes `currentTable` onto `stagedCompletedTables` instead of
`completedTables`.

Points already checked against the current code — confirm they still hold, don't re-derive:

- `flushDataToStore` runs unconditionally, so a table with no pending rows still graduates
  (`applyDataToStore` early-returns; graduation must sit *outside* that early return).
- The `header` handler seeds `completedTables` directly from the persisted checkpoint —
  those tables are already durable from the prior session and must NOT go through staging.
- The `footer`'s `bootstrapFinalize` reads `completedTables` at `snapshot-stream.ts:704`,
  which runs after the footer's own `flushDataToStore()` — so staged tables are graduated
  by then and the bootstrap notification set is unchanged.
- `tablesProcessed` is a separate counter; leave it alone.
- Metadata needs no equivalent change: `flushMetadataBatch` already does `await batch.write()`
  *before* `saveSnapshotCheckpoint`, so a completed table's column-version and change-log
  records are always durable ahead of any checkpoint naming it.
- Staging holds at most one entry per table between flushes — bounded by table count.

**Arm 2 — cover the resume path.** No spec drives `resumeSnapshotStream` end-to-end today;
that gap is why the original prediction went unchecked for so long.

## TODO

- Add `stagedCompletedTables` to `applySnapshotStream` and move the `table-end` append into
  `flushDataToStore`, with the comment above stating the invariant in full.
- Add an end-to-end interrupt-then-resume spec (new file, e.g.
  `packages/quereus-sync/test/sync/snapshot-resume.spec.ts`, using `_peer-harness.ts`):
  seed a table with `DATA_FLUSH_SIZE + 50` rows; feed the receiver a chunk stream that
  throws partway through; read the receiver's checkpoint via
  `receiver.manager.getSnapshotCheckpoint(snapshotId)`; drive
  `sender.manager.resumeSnapshotStream(checkpoint)` into a second
  `receiver.manager.applySnapshotStream`; assert the receiver ends with every row and that
  the final row's value is intact.
- Add the checkpoint invariant probe to the same spec: wrap the receiver's `applyToStore`
  (count rows pushed) and `kv.put` (capture `completedTables` on each `sc:` write), then
  assert every checkpoint's completed tables are fully backed by rows already applied.
  Both wrappers are plain field assignments on `SyncManagerImpl` (`kv` and `applyToStore`
  are ordinary instance fields, not accessors). Scenario that exercises it: table `big`
  with `DATA_FLUSH_SIZE + 50` rows plus a second table fully deleted with more than
  `BATCH_FLUSH_SIZE` (1000) rows, so a checkpoint actually fires. Runtime of the probe as
  written was ~4s — set an explicit mocha timeout, the 2s default is too short.
- Note in the new spec's header comment that the invariant was previously upheld only as a
  side effect of the `tombstone` handler's DDL-ordering flush, so a future reader does not
  "simplify" that flush away.
- Run `yarn workspace @quereus/sync test` and `yarn workspace @quereus/sync typecheck`.

## Neighbours (do not fold in)

`tickets/backlog/bug-sync-resume-snapshot-unvalidated-checkpoint` also names
`snapshot-stream.ts`, but its site is the *sender/coordinator* trusting a client-supplied
checkpoint. Different site, different concern — leave it alone.
