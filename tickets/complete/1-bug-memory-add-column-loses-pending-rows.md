---
description: Adding or removing a column while a transaction was open used to corrupt that transaction's data — wrong-column values, vanishing columns, and rows lost at commit. Fixed, reviewed, and extended with the missing test coverage.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # prepareReshapedColumns / installReshapedColumns; new installNetOwnWrites helper
  - packages/quereus/src/vtab/memory/layer/manager.ts       # prepareReshapeOnOpenLayers / installReshapeOnOpenLayers; wiring in addColumn / dropColumn
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts   # 18 regression cases
  - docs/memory-table.md                                    # § DDL and transactions, ADD/DROP COLUMN paragraph
difficulty: medium
---

# Complete: `ALTER TABLE ADD` / `DROP COLUMN` reaches open transaction layers (memory module)

## What shipped

`MemoryTableManager.addColumn` / `dropColumn` rewrote the committed base but never touched the
DDL-issuing connection's open transaction layers, freezing the pre-`ALTER` schema and row arity
for the transaction's own uncommitted rows. Four symptoms: pending rows missing an added column;
`DROP COLUMN` committing rows whose values sat one slot off their column names; a committed
`ADD COLUMN` undone table-wide at commit; and, with a savepoint taken before the `ALTER`, the
transaction's rows vanishing entirely at commit.

The fix propagates the column change into every open layer of the DDL connection, oldest-first,
as a two-phase pair on `TransactionLayer`:

- `prepareReshapedColumns(reshapeRow)` — async, fallible, mutates nothing. Collapses the layer's
  own-write log to its net per-key effect and rewrites each surviving row to the new column set.
- `installReshapedColumns(newSchema, prepared)` — sync, infallible, mutation only. Swaps the
  schema, rebuilds `pkFunctions` (`DROP` shifts primary-key column *indices*; key *values* are
  invariant so recorded own-write keys stay valid), rebuilds the primary tree over the parent's
  already-reshaped one, rewrites the own-write log, rebuilds every secondary index.

Every prepare runs before the first mutation anywhere, so a failing per-row backfill rejects the
whole `ALTER` with the schema, the base, and every layer untouched. `commitTransaction` needed no
change: propagating the schema makes its snapshot-wrap identity check pass again.

## Review findings

### Checked and clean

- **Core correctness of the reshape.** Read the implement diff before the handoff summary. The
  oldest-first ordering, the copy-on-write rebuild over the parent's *fresh* tree, the
  key-invariance argument that lets prepared deletions apply verbatim under rebuilt
  `pkFunctions`, and the claim that reading effective rows *before* the base rebuild is safe (the
  base *replaces* its tree object rather than mutating the one open layers inherit from) all hold
  up under inspection.
- **Concurrency exposure.** `ensureSchemaChangeSafety` (manager.ts:2983) raises `BUSY` for any
  connection other than the DDL issuer holding open work, and the prepare/install plans pin the
  layer set, so the two phases cannot disagree. The handoff's characterisation is accurate.
- **Error handling / atomicity.** `addColumn`'s `catch` restores only schemas, which is why
  prepare must precede every mutation — it does. A base-backfill failure discards the prepared
  plans un-installed.
- **All eight coverage gaps the handoff flagged as "probed by hand, not covered by tests."**
  Each was written as a probe against the landed code; all eight passed, so no defect was found
  there. Eight of them are now permanent regressions in the spec (see below).

### Fixed in this pass

- **Documentation stated a rationale that is false.** Both `manager.ts`'s reshape comment and the
  new `docs/memory-table.md` paragraph claimed the new `NOT NULL` check "additionally covers the
  no-DEFAULT case, which the `tableHasRows` gate waves through when the only rows are pending
  ones." It does not: `validateNotNullBackfill` (`runtime/emit/alter-table.ts:673`) already
  rejects `ADD COLUMN ... NOT NULL` with no usable `DEFAULT` by running `select 1 from <t> limit
  1` through the engine, which sees the DDL connection's *effective* rows — pending ones
  included. Verified by message: the no-`DEFAULT` case reports the emitter's wording, only the
  per-row-evaluator case reports the new module-level one. Comment and docs corrected; the check
  itself is kept ungated (deliberate defence in depth, now labelled as such rather than as
  coverage of a hole that does not exist).
- **A test that did not test what its name claimed.** `'ADD COLUMN NOT NULL without DEFAULT is
  rejected when pending rows exist'` asserted only `/NOT NULL/i`, which both gates satisfy, so it
  passed on the emitter gate and would have passed identically *without* the fix — contradicting
  the handoff's negative-control claim that it fails against pre-fix code. Kept (it is a real
  non-regression guard) but relabelled with a comment naming the gate it actually exercises; its
  sibling now asserts the reshape-specific message so the two cannot be confused again.
- **Third copy of a subtle 28-line block (DRY).** `rekeyPrimaryKey`, `convertColumn`, and the new
  `installReshapedColumns` each carried their own copy of "build a tree over the parent's, replay
  the net own-writes, rewrite the own-write log, rebuild every secondary index" — invariant-laden
  code where a future correction would have to be applied three times. Extracted to
  `installNetOwnWrites` + `newPrimaryTreeOverParent`. The re-occupied-deletion filter that only
  `rekeyPrimaryKey` needed is now applied unconditionally; it is provably a no-op where key values
  are invariant, which is argued at the helper.
- **The `not null default null` asymmetry the handoff flagged for reviewer judgement is a
  non-issue.** The claim was that it silently backfills `NULL` on committed rows while the same
  `ALTER` with a pending row is now rejected. It is rejected in *both* cases, by the same emitter
  gate — a literal `NULL` default does not count as a usable one. Nothing to decide; no policy
  change made.

### Filed as a new ticket (major)

- `tickets/fix/bug-alter-column-change-events-keep-pre-alter-row-shape.md` — the reshape rewrites
  the pending *rows* but not the parallel per-transaction change-notification log, so a commit
  after an in-transaction column change emits `DatabaseDataChangeEvent`s describing rows in the
  pre-`ALTER` shape. Reproduced: after `drop column w`, the emitted `newRow` is `[1,"a","p"]`
  against a two-column table; after `add column w`, it is `[1,"a"]` against a three-column one.
  `quereus-sync` pairs `newRow[i]` with `columns[i].name` read at event time, so a `DROP` writes
  every trailing value under the wrong column name (and one under a fabricated `col_<n>`) into
  the sync change log. Not a regression — pre-fix the rows were wrong too — and only reachable
  with a registered listener, but it is silent corruption for a replicated table. Filed rather
  than fixed inline because `oldRow` (an update's pre-image) has no obviously correct backfill
  value for a per-row `default (new.<col>)`; the ticket lays out three options. `convertColumn`
  and `rekeyPrimaryKey` leave the same log stale and are in that ticket's scope.

### Tripwires

None recorded. The two conditional concerns considered were the memory cost of materialising every
pending row twice during prepare and a throw between install and the event emission leaving layers
reshaped under a restored schema; both are already covered by existing `NOTE:` comments on
`ownWrites` and by the pre-existing shape of the `catch` blocks, so adding a third marker would be
noise rather than knowledge.

### Test coverage added

Eight regressions, taking the spec from 10 to 18 cases. They exercise the structures
`installReshapedColumns` rebuilds *beyond* the primary tree, none of which the original ten
touched: dropping an indexed column, an index over a column *after* the dropped slot, `ADD` with a
secondary index present, two `ADD COLUMN`s over one pending row, a pending `UPDATE` (rather than
`INSERT`/`DELETE`) of a committed row, `UNIQUE` enforcement after both `ADD` and `DROP`, and a
multi-column primary key whose extractor indices shift on `DROP`.

## Validation

- `packages/quereus/test/alter-column-open-transaction-layer.spec.ts` — 18 passing.
- `yarn test` — all workspaces green, 0 failures (quereus 7285 passing). Re-run after the DRY
  extraction, since that touched the `rekeyPrimaryKey` / `convertColumn` hot paths.
- `yarn lint` — clean (includes the `tsc -p tsconfig.test.json --noEmit` pass over spec files).
- `yarn test:store` not run, per the fix ticket: the defect and fix are memory-module-local and
  the shared code (`row-convert.ts`, `base.ts`) is untouched.

## Downstream

`bug-isolation-alter-column-rebuild-drops-savepoint-writes` (in `tickets/fix/`) depends on this
landing: the open-layer column-reshape primitive it needs exists as the `prepareReshapedColumns` /
`installReshapedColumns` pair — note the API is that two-phase pair, not the single
`reshapeColumns` method that ticket's sketch names.
