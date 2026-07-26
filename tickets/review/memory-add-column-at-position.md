---
description: The in-memory table storage can now be told to put a newly added column at a chosen spot in the column list instead of always at the end, so a wrapper that keeps its own bookkeeping column last stays intact.
files:
  - packages/quereus/src/vtab/module.ts                     # insertAtIndex on the addColumn change (~554)
  - packages/quereus/src/vtab/memory/layer/manager.ts       # shiftSchemaIndicesForInsert (~69); addColumn (~1828)
  - packages/quereus/src/vtab/memory/layer/base.ts          # addColumnToBase / recreatePrimaryTreeWithNewColumn (~339)
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # corrected prepare/install doc comments (~462, ~498)
  - packages/quereus/src/vtab/memory/module.ts              # alterTable dispatch (~944)
  - packages/quereus/src/vtab/memory/table.ts               # alterSchema dispatch (~350)
  - packages/quereus-store/src/common/store-module.ts       # alterAddColumn rejects a non-append position (~1608)
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts   # new describe at the end (~355)
  - packages/quereus-store/test/alter-table.spec.ts         # store rejection test (~99)
difficulty: medium
---

# ADD COLUMN at a caller-chosen position (memory module) — review

## What was built

`SchemaChangeInfo`'s `addColumn` variant gained an optional `insertAtIndex?: number`. When a
module is handed one, the new column lands at that slot instead of the end; omitted means
append, which is what SQL `alter table … add column` always produces. There is **no SQL
syntax** for a position — it is reachable only from an in-process module wrapper. The intended
caller is the transaction-isolation overlay, which keeps a private "this row is deleted"
bookkeeping column last and must insert ahead of it.

The memory module honours a position. The store module rejects one it cannot honour
(`UNSUPPORTED`) rather than silently appending.

## How it works

`MemoryTableManager.addColumn` validates the position (integer in `[0, columnCount]`, else
`MISUSE`) before any mutation, splices the column into the column list, and — only when the
position is a real insert, not the append slot — renumbers every index-bearing schema field
through a new module-level helper `shiftSchemaIndicesForInsert`: primary-key definition,
secondary index key columns, UNIQUE constraint columns, foreign-key child columns,
generated-column dependency map and topo order. Two row-rewrite sites take the position and
splice instead of appending: `BaseLayer.recreatePrimaryTreeWithNewColumn` for committed rows,
and the open-transaction-layer reshape callback for a transaction's own pending rows (kept
inside the fallible pre-mutation phase, as before).

**The append path is unchanged.** `insertAtIndex === undefined` skips the renumber entirely and
takes exactly the code path it took before, so no existing caller or third-party module is
affected.

## Use cases to exercise when reviewing

The new tests live in `packages/quereus/test/alter-column-open-transaction-layer.spec.ts` under
`describe('ALTER TABLE ADD COLUMN at a position (memory module)')`. They drive the capability
through a `PositionedMemoryModule` — a `MemoryTableModule` subclass that injects
`insertAtIndex` into every engine-driven `alter table … add column` — which is the closest
in-repo stand-in for the real wrapper. Every case keeps rows both committed and pending in an
open transaction, so both rewrite sites run.

Covered: insert at index 0; insert at a middle slot; an explicit end position; no position at
all (still appends); a two-column primary key at indices 0 and 2 that the insert shifts to 1
and 3 (asserted via point lookup and a duplicate-key rejection); a secondary index over a
column after the insert point; a UNIQUE constraint over a column after the insert point, still
rejecting duplicates against committed rows; a per-row `default (new.<col>)` backfill;
out-of-range position rejected with the table untouched.

The store side has one test in `packages/quereus-store/test/alter-table.spec.ts` calling
`storeModule.alterTable` directly: position 0 is rejected and the table is untouched; the
append position is accepted.

**Negative check performed:** with the index renumber stubbed out to the identity function,
4 of the 9 memory tests fail (index-0, multi-column PK, secondary index, UNIQUE) — so those
cases genuinely exercise the shift rather than passing by construction.

## Known gaps — please probe these

- **Engine-side CHECK evaluation assumes an append.** `buildAddColumnChecks`
  (`packages/quereus/src/planner/building/alter-table.ts:278`) builds the per-row context for a
  column-level CHECK as `[...existingRow, value]`. A wrapper that redirects an *engine-driven*
  ADD COLUMN to a non-append position and declares a column-level CHECK on the new column
  would have that CHECK evaluated against the append layout. Documented at the `insertAtIndex`
  declaration; **not fixed and not tested** — fixing it means threading a position through the
  engine's ADD COLUMN pipeline, which the ticket scoped out. The real caller (isolation
  overlay) applies the change straight to a module and never reaches this path.
- **No test for an insert into a table that has foreign keys or generated columns.** Both are
  shifted by `shiftSchemaIndicesForInsert`, but only by inspection — no test drives them. The
  self-referential-FK branch (`referencedColumns` shift only when the FK points back at this
  same table) is entirely unexercised.
- **No test for two positioned ADD COLUMNs in one transaction**, nor for a positioned ADD
  COLUMN interleaved with a savepoint. The append-path analogues of both exist in the same
  spec file and pass.
- **Partial-index / UNIQUE predicates are ASTs referring to columns by name**, so they need no
  shift — assumed, not verified against a partial index over a shifted column.
- `yarn test:store` was not run (it re-runs the quereus logic suite against LevelDB and is slow).
  The store change only adds a rejection on an input SQL never produces, so the risk is low,
  but it is unverified.

## Tripwires recorded (not tickets)

- `packages/quereus/src/vtab/memory/layer/manager.ts` — `NOTE:` at the schema-change event emit
  site in `addColumn`: the event carries the column name but not its position. Fine while the
  only non-append caller rebuilds its view from the post-change schema; would need to carry the
  insert point if a position ever became SQL-reachable.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — `NOTE:` in `dropColumn`: it leaves
  `foreignKeys[].columns` and the generated-column bookkeeping unshifted past the removed slot
  (pre-existing, found while writing the insert-side mirror). Not fixed here: the drop side also
  has to decide what to do with a foreign key whose column set the drop empties, which has no
  insert-side counterpart. Also notes that the `primaryKey` field `dropColumn` writes is not a
  `TableSchema` field at all and nothing reads it.
- Two doc comments in `packages/quereus/src/vtab/memory/layer/transaction.ts`
  (`prepareReshapedColumns`, `installReshapedColumns`) asserted that ADD COLUMN "appends past
  every key index". That clause is now false; both were rewritten to state the invariant they
  actually rely on — primary-key *values* are unchanged, so tree ordering and the keys in the
  own-write log stay valid, while the *indices* may be renumbered (which is why `pkFunctions`
  is rebuilt).

## Validation run

- `yarn build` — clean.
- `yarn test` — full workspace suite green (7294 + 279 + 104 + 56 + 17 + 28 + 1043 + 481 + 52 +
  31 + 5 + 74 + 34 + 118 + 22 passing, 0 failing).
- `yarn lint` — clean (includes the `tsc -p tsconfig.test.json` pass over quereus test files).
- `yarn typecheck` — clean; `tsc -p tsconfig.test.json --noEmit` also run by hand in
  `packages/quereus-store` (its lint is a no-op, so the new store test would otherwise go
  untype-checked).
