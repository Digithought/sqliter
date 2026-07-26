---
description: Adding or removing a column while a transaction was open used to corrupt that transaction's data — wrong-column values, vanishing columns, and rows lost at commit. Now fixed; the column change reaches the transaction's pending rows. Review the fix.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # prepareReshapedColumns / installReshapedColumns + PreparedColumnReshape
  - packages/quereus/src/vtab/memory/layer/manager.ts       # prepareReshapeOnOpenLayers / installReshapeOnOpenLayers; wiring in addColumn / dropColumn
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts   # 10 regression cases
  - docs/memory-table.md                                    # § DDL and transactions, new ADD/DROP COLUMN paragraph
difficulty: medium
---

# Review: ALTER TABLE ADD/DROP COLUMN now reaches open transaction layers (memory module)

## What was broken

`MemoryTableManager.addColumn` / `dropColumn` rewrote the committed base but never touched the
DDL-issuing connection's open transaction layers, which froze the pre-ALTER schema and row arity.
Four symptom classes (all reproduced in the original fix ticket): pending rows missing an added
column; DROP COLUMN committing rows with every value one slot off its column name; a committed
ADD COLUMN undone table-wide when the transaction committed; and — with a savepoint taken before
the ALTER — the transaction's rows vanishing entirely at commit (the `commitTransaction`
snapshot-wrap identity check `readLayer.getSchema() === this.tableSchema` failed against the
frozen schema, so the snapshot's rows were dropped).

## What was built

Modelled on the existing `TransactionLayer.convertColumn` (the analogous machinery for
`alter column … set data type`), per the validated design carried in the fix ticket, with one
structural deviation — see "Deviations" below.

- `TransactionLayer.prepareReshapedColumns(reshapeRow)` — async, **fallible, mutates nothing**:
  collapses the layer's own-write log to its net per-key effect and rewrites each surviving row
  to the new column set.
- `TransactionLayer.installReshapedColumns(newSchema, prepared)` — sync, **infallible, mutation
  only**: swaps in the new schema, rebuilds `pkFunctions` (DROP shifts PK column *indices*; key
  *values* are invariant so recorded own-write keys stay valid), rebuilds the primary tree over
  the parent's already-reshaped one, rewrites the own-write log, rebuilds every secondary index.
- `MemoryTableManager.prepareReshapeOnOpenLayers` / `installReshapeOnOpenLayers` — walk the open
  layers oldest-first; the plans returned by prepare pin the layer set so both phases agree.
- Wiring: `addColumn` appends `backfillEvaluator(row) ?? defaultValue`; `dropColumn` filters out
  the dropped index. **Prepare runs before any mutation** (before `updateSchema` /
  `addColumnToBase`); install runs after the manager schema swap.
- No change to `commitTransaction` was needed — propagating the schema makes its identity check
  pass again, exactly as the fix ticket predicted.

## Deviations from the validated prototype — review these first

1. **Two-phase split instead of the prototype's single-pass `reshapeColumns`.** The fix ticket
   left this as a "decide before landing" question; the failure IS reachable, so the split was
   built. Reachability: ADD COLUMN's per-row `default (new.<col>)` evaluator runs against each
   pending row and can throw (or yield NULL for a NOT NULL column) even when every committed row
   backfilled cleanly — and the `catch` blocks in `addColumn`/`dropColumn` restore only the
   *schemas*, so any throw after `addColumnToBase` has swapped the base tree would leave base
   rows at the new arity under a restored old schema. Running every fallible rewrite before the
   first mutation anywhere makes a failure reject the ALTER with everything untouched.

2. **New enforcement the prototype did not have: NOT NULL is checked on pending rows during
   prepare** (in `addColumn`'s reshape callback, `manager.ts` — grep "would leave NULL in a row
   pending"). Two cases it catches:
   - a per-row DEFAULT yielding NULL for a NOT NULL column on a *pending* row (mirrors the base
     backfill's per-row check in `BaseLayer.recreatePrimaryTreeWithNewColumn`);
   - `add column w text not null` with **no** DEFAULT when the only rows are pending ones — the
     up-front `tableHasRows` gate inspects the committed base alone, so it waves this through,
     and the pending rows would silently get NULL in a NOT NULL column.
   The check is deliberately **ungated** (not restricted to the evaluator path). Known asymmetry
   worth a reviewer's judgement: `not null default null` (explicit literal NULL) on a table with
   committed rows silently backfills NULL into the base (pre-existing leniency, untouched here),
   but the same ALTER with a pending row is now rejected. Rejection was chosen as the safer
   direction; if the policy is wrong, the check is one `if` block.

3. Prepare reads each layer's effective rows *before* the base rebuild rather than after (the
   prototype read after). Equivalent by construction — the base rebuild replaces the base's tree
   object and never mutates the one the layers' copy-on-write chains reference — argued in
   `prepareReshapeOnOpenLayers`'s docstring.

## Validation performed

- New spec `packages/quereus/test/alter-column-open-transaction-layer.spec.ts` — the fix ticket's
  4 cases verbatim, plus: DROP of a column preceding the PK (value-misalignment symptom),
  ADD with only a pending DELETE (column-lost-table-wide symptom), nested savepoints
  (`s1`/`s2`, ALTER at inner, rollback to `s1`), per-row `default (new.v)` reaching pending
  rows, and the two NOT NULL rejection cases (each also asserts the rejection left the schema,
  the pending row, and the transaction intact). 10 passing.
- Negative control: with `installReshapeOnOpenLayers` temporarily stubbed to a no-op, 8 of 10
  fail (the 2 NOT NULL rejection tests live in the prepare phase, which the stub left active;
  against true pre-fix code they fail too — the ALTER succeeds where they expect rejection).
- `yarn test` — all workspaces green, 0 failures (quereus: 7277 passing, 13 pending).
- `yarn lint`, `yarn typecheck` — clean.
- `yarn test:store` NOT run, per the fix ticket: the defect and fix are memory-module-local;
  shared code (`row-convert.ts`, `base.ts`) untouched.

Run the spec directly:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/alter-column-open-transaction-layer.spec.ts"
```

## Known gaps / where to probe

- **Not covered by tests** (probed by hand in the fix stage against the prototype, same logic):
  DROP of an *indexed* column with a secondary-index scan afterwards; ADD with a secondary index
  present; two ADD COLUMNs over the same pending row in one transaction; pending UPDATE (vs
  INSERT/DELETE) of a committed row; UNIQUE enforcement after ADD/DROP; multi-column PK index
  shift on DROP. If the reviewer wants belt-and-braces, these are the cheapest additions.
- A sibling connection opening a transaction *during* an `await` inside the ALTER (between
  prepare and install) is a pre-existing exposure guarded by `ensureSchemaChangeSafety`, not
  widened here — the plans pin the layer set, so a layer born mid-ALTER is simply not reshaped
  (it would freeze whichever schema object it saw). Worth a glance, not believed reachable for
  the DDL connection itself (it cannot run concurrent statements).
- Docs updated: `docs/memory-table.md` § DDL and transactions — ADD/DROP COLUMN added to the
  in-transaction DDL list plus a paragraph on the reshape; the "DDL is not transactional"
  contract statement is unchanged (this fix does not alter it).

## Downstream

`bug-isolation-alter-column-rebuild-drops-savepoint-writes` (in `tickets/fix/`) depends on this
landing: the open-layer column-reshape primitive it needs now exists, as the
`prepareReshapedColumns` / `installReshapedColumns` pair — note the API is that two-phase pair,
not the single `reshapeColumns` method that ticket's sketch names.
