---
description: Renaming a column used to silently destroy any index whose WHERE clause mentioned that column; now the index survives the rename, and dropping such a column is rejected with a clear message.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts             # new renameColumnInIndexPredicates
  - packages/quereus/src/vtab/memory/layer/manager.ts          # renameColumn — rewrite + reverse-on-failure
  - packages/quereus/src/vtab/memory/layer/base.ts             # createSecondaryIndexes (swallow removed), rebuildAllSecondaryIndexes (stale-map fix)
  - packages/quereus/src/runtime/emit/alter-table.ts           # runDropColumn pre-check, predicateReferencesColumn
  - packages/quereus/test/partial-index-column-rename.spec.ts  # regression spec (10 tests)
  - docs/sql.md                                                # RENAME COLUMN / DROP COLUMN semantics
  - docs/schema.md                                             # corrected claim about cross-table refs in index predicates
difficulty: medium
---

# Complete: `RENAME COLUMN` no longer drops a partial index

## What the bug was

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where active = 1;
alter table t rename column active to is_active;
```

The memory table's base-layer `secondaryIndexes` map went from `['ix']` to `[]` while the
catalog still advertised `ix`. Invisible until a plan picked the index by name and got
`Secondary index 'ix' not found`.

Cause: the module rebuilt its indexes against the *new* column list before anything had
rewritten `ix`'s predicate, so `compilePredicate` threw "unknown column 'active'", and
`BaseLayer.createSecondaryIndexes` caught that, logged, and returned a map missing the
index. The catalog-side predicate rewrite only ran *after* the module call.

## What shipped

**A shared predicate rewriter.** `renameColumnInIndexPredicates` in
`schema/rename-rewriter.ts` walks `IndexSchema[]` and applies
`renameColumnInCheckExpression` to each `predicate` in place. A partial-index predicate
resolves unqualified refs against its own table, exactly as a CHECK expression does. It is
idempotent.

**Called inside the module, in the one window that works.**
`MemoryTableManager.renameColumn` calls it after `ensureSchemaChangeSafety()` (which
consolidates transaction layers and rebuilds indexes against the *old* columns) and before
`baseLayer.updateSchema(...)` + `handleColumnRename()` (which rebuild against the *new*
columns). The rewrite is in place, because the `Expression` object is shared by reference
with the catalog's `TableSchema` and, for a unique partial index, with the
`derivedFromIndex` UNIQUE constraint. `renameColumn`'s `catch` therefore also runs the
rewrite in reverse.

**The swallow is gone.** `BaseLayer.createSecondaryIndexes` no longer catches construction
failures; an index that cannot be built now fails the DDL instead of vanishing.
Duplicate-key tolerance stays in `populateSecondaryIndexes`.

**`DROP COLUMN` of a predicate-referenced column is rejected up front,** in `runDropColumn`
(engine-level, so it covers every module), with
`Cannot drop column 'active' from 't': it is referenced by the WHERE clause of partial index 'ix'`.
The reference is found by walking the predicate AST, not by string match.

**Adjacent defect fixed.** `BaseLayer.rebuildAllSecondaryIndexes` early-returned when the
schema declared no indexes *without clearing the map*, so an index dropped by `DROP COLUMN`
(last surviving key column) lingered as an emptied-but-live structure that every subsequent
base write still maintained.

## Review findings

The implement-stage diff (`cbd9aa5d`) was read before its handoff summary. Every claim in
that summary was re-derived against the code, and the "known gaps" section was treated as a
list of things to disprove rather than accept.

### Major — one confirmed defect, filed as a new ticket

**`CREATE INDEX ... WHERE <foreign-table>.<col> = 1` is silently accepted, and the
predicate binds to the indexed table's own column.** Filed as
`tickets/backlog/bug-partial-index-predicate-ignores-table-qualifier.md`.

`compilePredicate` rejects schema-qualified refs and subqueries, but never inspects a
column reference's *table* qualifier — it resolves every ref by bare name against the
indexed table's columns. So `where zzz.active = 1` on table `t` compiles to exactly the
same evaluator as `where active = 1`, and `create index` accepts it. Verified by direct
execution, not by reading.

This is pre-existing (it predates this ticket's diff) and the fix reaches across two
packages — `compilePredicate` is a public export with six call sites spanning the memory
module, materialized views, and `quereus-store` — so it is out of scope for a review pass
and belongs in its own ticket.

Two consequences were confirmed by running them:

- `alter table t rename column active to is_active` now **fails** on such a table, because
  the rename rewriter correctly declines to rewrite a ref qualified by a different table
  and the rebuild then compiles the stale predicate. It fails cleanly (the rollback path
  works, the index survives, the column keeps its old name), so this is a usability
  regression on a nonsense index, not corruption. Left as-is; the new ticket removes the
  nonsense index at its source.
- `alter table t drop column active` **escaped the new pre-check entirely** and died inside
  the module with a raw `Partial-index predicate references unknown column 'active'` — the
  exact leak the pre-check was added to prevent. This one was fixed here; see below.

### Minor — fixed in this pass

- **`predicateReferencesColumn` gated on the table qualifier, so `DROP COLUMN` had an
  escape hatch** (`runtime/emit/alter-table.ts`). It matched a column node only when the
  node's `table` was absent or equal to the indexed table's name, while `compilePredicate`
  ignores the qualifier altogether. Any predicate carrying a foreign qualifier slipped
  through the guard. Changed to match on the column name alone, mirroring the compiler's
  actual binding rule; the doc comment now explains *why* the qualifier is ignored and
  points at the new ticket. Regression test added.

- **The rollback flag was armed from the rewriter's return value, so a throw partway
  through the rewrite would have skipped the reverse pass** (`vtab/memory/layer/manager.ts`).
  `renameColumnInIndexPredicates` walks the indexes one at a time; had it thrown on index
  two, indexes already rewritten would have kept the new column name while the column
  itself reverted. `predicatesRewritten` is now set immediately *before* the call. The
  reverse pass is a no-op when no predicate names the new column, so arming it eagerly
  costs nothing. (No current path makes the rewriter throw — this closes the hole rather
  than fixing an observed failure.)

- **`docs/schema.md` asserted an invariant that is false.** Its index-body-diffing section
  claimed "a *cross*-table reference is unreachable today — the memory backend rejects
  subqueries and any cross-table reference in partial-index predicates at create time".
  The subquery half is true; the cross-table half is not, as above. Reworded to describe
  what the code actually does. The new ticket notes this should be tightened again once
  creation rejects a foreign qualifier.

### Checked and clean

- **Blast radius of removing the swallow.** `createSecondaryIndexes` can now throw out of
  `BaseLayer`'s constructor, `addColumnToBase`, `dropColumnFromBase`, `handleColumnRename`,
  and the commit-time consolidation in `MemoryTableManager`. Every one of those is an
  invariant path — the schema handed in must already name only surviving columns — and the
  full suite exercises all of them. No regression. This remains the widest-blast-radius
  change in the diff and is called out as such.
- **The stale-map fix.** `rebuildAllSecondaryIndexes`'s empty path now clears the map. The
  preceding `clearExistingSecondaryIndexes()` call is redundant on that path but is left
  alone: it also clears trees that an un-re-pointed `TransactionLayer` may still hold, and
  untangling that ownership is not this ticket's business.
- **The UNIQUE `derivedFromIndex` predicate sharing.** In-place rewrite genuinely keeps the
  derived constraint in step; the existing unique-partial-index test proves enforcement
  survives under the new column name.
- **The store-module reading in the handoff.** Confirmed: `quereus-store` carries the
  predicate AST forward untouched on rename and compiles it lazily at the next write, so it
  never reaches the memory module's failure. Its stale persisted DDL bundle is a separate,
  already-filed concern (`2-bug-store-rename-column-persists-stale-index-predicate`, in
  `implement/`). No further ticket needed, and the handoff's decision not to export
  `renameColumnInIndexPredicates` for the store is correct.
- **`predicateReferencesColumn`'s depth-blindness.** Re-verified against `compilePredicate`:
  `in` subqueries are explicitly rejected and every other subquery form falls to the
  `default` "unsupported expression" throw. The walk cannot meet a nested scope today. The
  `NOTE:` tripwire at the function is accurate and stays.

### Considered and deliberately not changed

- **`DROP COLUMN` of a column that is both an index's sole key column *and* named by its
  predicate is now rejected**, even though the index would have been dropped outright
  anyway. Relaxing this would require the engine to model the module's index-narrowing
  policy. `docs/sql.md` already tells the user to drop the index first, and a regression
  test pins the behaviour. Left conservative.
- **The rollback test's fault injection.** The handoff asked whether a naturally reachable
  failure exists between the predicate rewrite and the rebuild. None was found — nothing
  between `renameColumnInIndexPredicates` and `handleColumnRename` can fail on any input
  the engine admits. Monkeypatching `BaseLayer.handleColumnRename` remains the only way to
  cover the `catch`, and covering it is worth the reach past a private field. Left as-is.
- **`yarn test:store` still not run.** The `DROP COLUMN` pre-check is engine-level and the
  store runner replays the same `test/logic/*.sqllogic` corpus that `yarn test` already
  runs green; no logic test drops a predicate-referenced column, so the store path sees no
  new rejection. Running it here would add ~10 minutes for no new coverage.

### Tests

The spec `packages/quereus/test/partial-index-column-rename.spec.ts` went from 5 to 10
tests. It asserts on the memory module's **live** `secondaryIndexes` map, because the
pre-existing rename tests in `test/index-ddl-roundtrip.spec.ts` assert only on
reconstructed DDL text and stayed green while the index was gone.

Kept from implement: partial index survives rename; unique partial index still enforces
under the new name; `DROP COLUMN` of a predicate column rejected; `DROP COLUMN` of a
key-only column still succeeds and clears the map; rewrite rolls back on failure.

Added in review, each covering a case the handoff listed as untried:

- table-qualified *and* case-varied predicate (`where t.ACTIVE = 1`) survives the rename
  with its predicate rewritten and its row count correct;
- two partial indexes on one table, only one naming the renamed column — the other's
  predicate is left untouched;
- rename inside an explicit transaction with a prior uncommitted write on the same
  connection, which forces `ensureSchemaChangeSafety` to consolidate a live transaction
  layer;
- `DROP COLUMN` rejected when the predicate reaches the column through a foreign qualifier
  (the escape hatch found above — this test fails against the implement-stage code);
- `DROP INDEX ix` then `DROP COLUMN active` succeeds and leaves the map empty.

### Tripwires (recorded, not ticketed)

Both tripwires the implement stage parked were re-read and remain accurate; no new ones
were added.

- `runtime/emit/alter-table.ts`, `rewriteTableForColumnRename` — comment: the store's
  persisted DDL bundle is momentarily stale and is corrected by this pass; if this pass ever
  stops rewriting predicates for hook modules, that staleness becomes permanent.
- `runtime/emit/alter-table.ts`, `predicateReferencesColumn` — `NOTE:` the walk is
  depth-blind and would need a scope stack if partial-index predicates ever admit
  subqueries.

## Validation

- `yarn lint` from repo root: clean.
- `yarn test` from repo root: green. quereus 6776 passing (up from 6771 — the 5 new tests),
  9 pending, 0 failing; every other package unchanged. No pre-existing failures surfaced.
