description: Copying a whole database to a new device used to fail whenever any table held more than a hundred rows; the rows now arrive after the instruction that creates the table, so the copy succeeds at any size.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts              # producer + consumer, both edited
  - packages/quereus-sync/src/sync/protocol.ts                     # SnapshotChunkType doc + reorder
  - packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts  # new spec (3 tests)
  - docs/sync.md                                                   # § Streaming Snapshot API, § DDL Application Order
difficulty: medium
----

## What changed

A streamed snapshot used to send each table's rows **before** the `create table`
statement that defines it. The receiver got away with that only for small tables: it
buffers rows and schema statements and hands both to the store in one call (which
applies data-definition before data-manipulation *inside* one call), so as long as
nothing forced an early hand-off, everything landed together at the end.

But the receiver hands off early once 100 row-changes accumulate, and that early
hand-off happens before any `create table` has arrived. On a device that does not
already have the table, all 100 rows fail.

Two edits fix it:

**Producer** (`streamSnapshotChunks`, snapshot-stream.ts) — the schema-migration
emission loop moved from after the per-table loop to immediately after the header
yield. Pure move; the scan bounds (`smBounds`) were already computed above for the
header's `migrationCount`. New order:

```
header → schema-migration* → [table-start, column-versions…, table-end]* → tombstone* → footer
```

**Consumer** (`applySnapshotStream`) — the `table-start` case now calls
`flushDataToStore()` first. Reaching a `table-start` means the migration section has
ended, so this pushes the accumulated DDL to the store ahead of any row. Later
`table-start`s find nothing pending; `applyDataToStore` returns early when both
pending arrays are empty, so the repeat is a no-op.

Docs and the `SnapshotChunkType` union were reordered/annotated to state the order and
why it is load-bearing.

## Verification done

`packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts` — 3 tests, real engine
peers via `_peer-harness.ts` (sender creates `big (id integer primary key, v text)` +
150 rows; receiver is fresh and has no `big`):

- **every schema-migration chunk precedes the first table-start** — pins the producer
  order directly off `getSnapshotStream()`.
- **a fresh receiver bootstraps a table larger than the mid-table flush bound** — the
  ticket's failure verbatim; asserts all 150 rows and spot-checks the last one.
- **re-applying the same stream is idempotent** — a resumed/retried transfer re-emits
  every migration; asserts no collision and no row duplication.

**These three were confirmed to fail at HEAD before the fix**, with the exact reported
error (`apply-to-store failed for 100 change(s): main.big (update): Table not found for
external write: main.big`). Checked by restoring the file from `git show HEAD:…`,
running the spec, then restoring the fixed version — the working tree is back to the
fixed state (`git diff --stat` confirms).

Also run, all green:

- `yarn workspace @quereus/sync test` → 586 passing, 0 failing (includes the existing
  streaming snapshot + resume/checkpoint specs, whose observed chunk order changed).
- `yarn test` (whole monorepo) → all suites passing, no failures.
- `yarn build` → clean.
- `yarn workspace @quereus/sync typecheck` → clean. Note: that package's tsconfig
  **excludes `test/`**, so the new spec is not covered by it; it was type-checked
  separately with a one-off `tsc --noEmit --strict` run (clean).

## Known gaps — worth a reviewer's attention

- **No test asserts the tombstone-vs-DDL relationship.** Tombstone chunks still come
  after all table data. That is believed safe because a tombstone write is pure CRDT
  metadata keyed by the sender's identity and never touches the store (so it cannot hit
  "table not found"), but no test pins that reasoning.
- **The `table-start` flush also flushes leftover row changes from the *previous*
  table**, not only schema changes. That is harmless (their DDL already applied) and
  keeps the code to one call, but it is a slightly wider action than the ticket
  described. Worth confirming nobody depends on rows for table N being flushed strictly
  within table N's section.
- **The 150-row spec inserts all rows in one `insert … values (…),(…)` statement**, so
  the whole table is one source transaction. A multi-transaction table of the same size
  was not exercised; the failure mode is about flush bounds, not transaction grouping,
  so this is believed equivalent — but it is an assumption, not a tested fact.
- **Resume path not exercised end-to-end at >100 rows.** The idempotency test re-applies
  the same full stream, which covers "migrations re-emitted, no collision", but a real
  `resumeSnapshotStream` from a saved checkpoint over a large table was not driven.
- **`DATA_FLUSH_SIZE` (100) is hard-coded and the spec's 150 is tied to it.** If the
  constant ever rises above 150 the test stops proving anything and would still pass.

## Tripwire parked in code

`snapshot-stream.ts`, `table-start` case — a `NOTE:` recording that the receiver now
trusts the sender's chunk order: a sender still using the old order fails exactly as
before. If cross-version snapshot interop is ever required, the receiver would have to
buffer all data until the footer, which is the memory cost the streaming path exists to
avoid. Conditional, not a defect today (both sides ship together).
