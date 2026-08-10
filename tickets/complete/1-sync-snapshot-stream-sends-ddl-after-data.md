description: Copying a whole database to a new device used to fail whenever any table held more than a hundred rows; the rows now arrive after the instruction that creates the table, so the copy succeeds at any size.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts              # producer + consumer
  - packages/quereus-sync/src/sync/protocol.ts                     # SnapshotChunkType doc + reorder
  - packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts  # spec (4 tests)
  - packages/quereus-sync/test/sync/_peer-harness.ts               # shared `toStream` helper
  - docs/sync.md                                                   # § Streaming Snapshot API, § DDL Application Order
  - packages/quereus-sync/README.md                                # § Protocol Types
----

## What changed

A streamed snapshot used to send each table's rows **before** the `create table`
statement that defines it. The receiver got away with that only for small tables: it
buffers rows and schema statements and hands both to the store in one call (which
applies data-definition before data-manipulation *inside* one call), so as long as
nothing forced an early hand-off, everything landed together at the end.

But the receiver hands off early once 100 row-changes accumulate, and that early
hand-off happens before any `create table` has arrived. On a device that does not
already have the table, all 100 rows fail with
`Table not found for external write: main.<table>`.

**Producer** (`streamSnapshotChunks`) — the schema-migration emission loop moved
from after the per-table loop to immediately after the header yield. New order:

```
header → schema-migration* → [table-start, column-versions…, table-end]* → tombstone* → footer
```

**Consumer** (`applySnapshotStream`) — the `table-start` case calls
`flushDataToStore()` first. Reaching a `table-start` means the migration section has
ended, so this pushes accumulated DDL to the store ahead of any row. Later
`table-start`s find nothing pending; `applyDataToStore` returns early when both
pending arrays are empty.

Docs and the `SnapshotChunkType` union were reordered/annotated to state the order
and why it is load-bearing.

## Verification

`packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts` — 4 tests against
real engine peers (`_peer-harness.ts`); sender seeds `big (id integer primary key,
v text)` with `DATA_FLUSH_SIZE + 50` rows, receiver is fresh:

- every schema-migration chunk precedes the first table-start (producer order);
- a fresh receiver bootstraps a table larger than the mid-table flush bound (the
  reported failure verbatim);
- a **second** large table also bootstraps — pins the "later `table-start` finds no
  pending DDL and is a harmless no-op" claim (added in review);
- re-applying the same stream is idempotent (a resumed transfer re-emits every
  migration; no collision, no row duplication).

The implementer confirmed the first three fail at HEAD before the fix, with the
exact reported error.

Full runs, all green after the review edits:

- `yarn workspace @quereus/sync test` → 587 passing, 0 failing
- `yarn test` (monorepo) → all suites passing
- `yarn lint` → clean · `yarn build` → clean · `yarn workspace @quereus/sync
  typecheck` → clean (that tsconfig excludes `test/`, so the spec was additionally
  type-checked with a one-off strict `tsc --noEmit` — clean)

## Review findings

### Checked

Producer/consumer diff read fresh before the handoff summary; the whole of
`snapshot-stream.ts`; `admission.ts` (`applyDataToStore` early-return, error
semantics); `tombstones.ts` (`setTombstoneByIdentityBatch`); the checkpoint
round-trip through `wire.ts` into `resumeSnapshotStream`'s skip set; every consumer
of `getSnapshotStream` / `applySnapshotStream` including the coordinator's S3
snapshot store and restore path; `docs/sync.md` and both package READMEs;
lint / typecheck / build / full test suite.

### Major — filed as a ticket

- **`backlog/bug-sync-resume-loses-trailing-rows-of-completed-table`** — the
  receiver appends a table to `completedTables` at `table-end` while up to 99 of its
  rows are still only in memory. A checkpoint saved in that window tells a resumed
  sender to skip a table whose last rows never reached storage: silent, permanent
  divergence. Pre-existing, not introduced here — and this ticket's `table-start`
  flush incidentally closes the table-to-table window, leaving only the
  tombstone-tail window open. Not fixed inline: the one-line fix is easy, but
  proving it needs an interrupt-then-resume test that does not exist yet.

### Minor — fixed in this pass

- `DATA_FLUSH_SIZE` was a function-local literal with the spec restating `150`
  independently; if the constant rose above 150 the spec would keep passing while
  proving nothing. Hoisted to an exported module constant, spec now derives
  `ROWS = DATA_FLUSH_SIZE + 50` (and the "last row intact" assertion no longer
  hard-codes `id = 150`).
- The implementer's tripwire `NOTE` justified trusting the sender's chunk order with
  "both sides ship together". That is false: `sync-coordinator`'s
  `s3-snapshot-store.ts` gzips a chunk array into S3 and `coordinator-service.ts`
  replays it through `applySnapshotStream` on restore, so a snapshot written before
  this fix outlives the sender process. NOTE rewritten to name that path.
- `toStream` (replay a chunk array as an `AsyncIterable`) was copy-pasted into four
  spec files. Moved to `_peer-harness.ts`; all four now import it.
- `packages/quereus-sync/README.md` listed the chunk types in the old order and
  omitted `tombstone` entirely. Updated to emission order with a pointer to
  `docs/sync.md`.

### Test coverage added

- Second-large-table test (above) — the implementer's "later `table-start`s are a
  no-op" reasoning had no test behind it.

### Implementer-flagged gaps, dispositioned

- *Tombstone-vs-DDL relationship untested.* Reasoning verified by reading
  `setTombstoneByIdentityBatch`: it only writes into the KV batch and never reaches
  the store, so a tombstone cannot hit "table not found". No test added — it would
  pin a non-load-bearing ordering fact.
- *`table-start` flushes the previous table's leftover rows too.* Confirmed
  harmless (their DDL already applied) and strictly better than the old behaviour
  (bounds how long leftovers sit pending). It is also what narrows the resume bug
  filed above.
- *Single-transaction 150-row seed vs. multi-transaction.* The producer groups by
  key scan, not by source transaction, so transaction grouping does not reach the
  flush bound. Left as-is.
- *Resume not exercised end-to-end at >100 rows.* Still true, and it is precisely
  the coverage the filed backlog ticket requires; not duplicated here.

### Tripwires

- `snapshot-stream.ts`, `table-start` case — the receiver trusts the sender's chunk
  order, and that order now outlives the sender via S3-persisted snapshots. Parked
  as the rewritten `NOTE:` at the site (see Minor above). Conditional: only work if
  backwards compat comes into scope.

### Empty categories

- **Blocked / decisions for a human:** none. No cross-repo dependency and no
  judgement call this pass could not make.
- **Pre-existing test failures:** none. `yarn test` is fully green; the only
  stack traces in the log are deliberate fault-injection inside
  `sync-manager.spec.ts`.
