---
description: The in-memory table storage can now be told to put a newly added column at a chosen spot in the column list instead of always at the end, so a wrapper that keeps its own bookkeeping column last stays intact.
files:
  - packages/quereus/src/vtab/module.ts                     # insertAtIndex on the addColumn change (~554)
  - packages/quereus/src/vtab/memory/layer/manager.ts       # shiftSchemaIndicesForInsert (~69); addColumn (~1830)
  - packages/quereus/src/vtab/memory/layer/base.ts          # addColumnToBase / recreatePrimaryTreeWithNewColumn (~339)
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # corrected prepare/install doc comments (~462, ~498)
  - packages/quereus/src/vtab/memory/module.ts              # alterTable dispatch (~944)
  - packages/quereus/src/vtab/memory/table.ts               # alterSchema dispatch (~350)
  - packages/quereus-store/src/common/store-module.ts       # alterAddColumn rejects a non-append position (~1608)
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts   # positioned-ADD-COLUMN describe (~375)
  - packages/quereus-store/test/alter-table.spec.ts         # store rejection test (~99)
  - docs/module-authoring.md                                # SchemaChangeInfo union + both per-arm mandate tables
  - docs/memory-table.md                                    # column-reshape section
difficulty: medium
---

# ADD COLUMN at a caller-chosen position (memory module) — complete

## What shipped

`SchemaChangeInfo`'s `addColumn` variant carries an optional `insertAtIndex?: number`. When a
module is handed one, the new column lands at that slot instead of the end; omitted means
append, which is what SQL `alter table … add column` always produces. There is **no SQL
syntax** for a position — it is reachable only from an in-process module wrapper. The intended
caller is the transaction-isolation overlay, which keeps a private "this row is deleted"
bookkeeping column last and must insert ahead of it.

The memory module honours a position. The store module rejects one it cannot honour
(`UNSUPPORTED`) rather than silently appending.

`MemoryTableManager.addColumn` validates the position (integer in `[0, columnCount]`, else
`MISUSE`) before any mutation, splices the column into the column list, and — only when the
position is a real insert, not the append slot — renumbers every index-bearing schema field
through the module-level helper `shiftSchemaIndicesForInsert`: primary-key definition,
secondary index key columns, UNIQUE constraint columns, foreign-key child columns,
generated-column dependency map and topo order. Two row-rewrite sites take the position and
splice instead of appending: `BaseLayer.recreatePrimaryTreeWithNewColumn` for committed rows,
and the open-transaction-layer reshape callback for a transaction's own pending rows (kept
inside the fallible pre-mutation phase).

**The append path is unchanged.** `insertAtIndex === undefined` skips the renumber entirely and
takes exactly the code path it took before, so no existing caller or third-party module is
affected.

## Review findings

The implement-stage diff (`fde897db`) was read in full before the handoff summary. Scope of the
pass: every `TableSchema` field enumerated against the shift helper; every consumer of a shifted
column index traced (`MemoryIndex` construction, `implicitIndexNameFor`, the primary-key
extractors on both the base layer and each open transaction layer); the engine's own ADD COLUMN
pipeline read for append assumptions beyond the one the handoff already documented; every module
implementing the `addColumn` arm checked; both affected docs read against the new reality.

### Fixed in this pass (minor)

- **Dead code — the self-referencing foreign-key branch.** `shiftSchemaIndicesForInsert`
  shifted `foreignKeys[].referencedColumns` when the key pointed back at the same table, with a
  paragraph of doc explaining the distinction. Every production constructor of a foreign key
  (`schema/constraint-builder.ts` ×2, `schema/manager.ts`) sets `referencedColumns` to a frozen
  **empty** array — parent-side indices are resolved on demand from `referencedColumnNames`
  against the parent's current schema (`resolveReferencedColumns`). So the branch shifted an
  always-empty array and could never be tested. Removed the helper and the branch (~8 lines);
  the doc now states why no shift is owed there. Behaviour is identical for every in-repo
  construction path.
- **`docs/module-authoring.md` was stale — and it is the module author's contract page.** The
  `SchemaChangeInfo` union it prints verbatim omitted `insertAtIndex`, and both per-arm mandate
  tables still read "append the column" with no mention of the new obligation. Since the option
  imposes a duty on *every* module author (reject a position you cannot honour rather than
  silently appending), leaving it undocumented was the largest gap in the change. Both tables
  and the union snippet updated.
- **`docs/memory-table.md` still asserted the claim the implementer had already retracted in
  code.** Its column-reshape section said "ADD appends the backfilled value" and "the key values
  are invariant (ADD appends past them)" — the same false clause that was correctly rewritten in
  the two `transaction.ts` doc comments but missed here. Corrected, and a short paragraph added
  documenting the position option and the engine-side CHECK caveat below.
- **`derivation.logicalKey` / `derivation.ordering` were unmentioned.** Both hold indices into
  this table's own columns and are not shifted. That is correct — they exist only on a
  maintained table (a materialized view's backing table), whose structural ALTERs the emitter
  rejects before dispatch — but the helper's doc enumerated what needs nothing and omitted them,
  which reads as an oversight. Added with the reason.

### Fixed in this pass (test coverage)

The handoff named four coverage gaps. All four are now covered; **none of them was broken** —
each new test passed on first run, so these confirm the implementation rather than repair it.
`packages/quereus` goes 7294 → 7298 passing.

- *Foreign keys and generated columns.* A direct module call asserts that FK child columns shift
  (1 → 2), that `referencedColumns` stays empty, and that the generated-column dependency map and
  topo order both renumber (`[[2,[0]]]` → `[[3,[1]]]`). Driven through the module rather than
  through SQL because the engine recomputes the generated-column graph from column names right
  after its own ADD COLUMN, so only a module-API caller observes what the module leaves.
- *Partial indexes.* The handoff assumed, without checking, that a partial predicate needs no
  shift because it names its columns. Verified: `compilePredicate` resolves against the current
  column list and `MemoryIndex` — predicate included — is reconstructed by
  `rebuildAllSecondaryIndexes`. Now also tested, with an index whose key column *and* predicate
  column both shift, plus a write after the reshape so index maintenance runs under the new layout.
- *Two positioned adds in one transaction*, the second positioned relative to the first.
- *Positioned add interleaved with a savepoint*, asserting the pre-savepoint row survives at the
  inserted-column layout (DDL is not transactional here, so the column change itself survives the
  rollback).

### Filed as tickets (major)

- **`tickets/fix/bug-drop-column-leaves-fk-child-index-dangling.md`** — pre-existing, reachable
  from plain SQL, reproduced during this review. `dropColumn` renumbers the primary key, indexes
  and UNIQUE constraints past a removed slot but never `foreignKeys[].columns`, so dropping a
  column that precedes an FK child column leaves the FK pointing past the end of the table; the
  next enforced write dies with a raw `TypeError: Cannot read properties of undefined (reading
  'name')` instead of a constraint error. The implementer parked this as a tripwire NOTE, which
  understates it — a live crash on legal SQL is a defect, not a conditional concern. Routed to
  `fix/` (top-priority stage). The NOTE at the site was rewritten to point at the ticket, and its
  generated-column half was corrected: the engine recomputes that graph from names in
  `runDropColumn`, so it is stale only for a direct module caller.
- **`tickets/backlog/debt-isolation-overlay-add-column-position.md`** — `IsolationModule.alterTable`
  forwards the schema change verbatim to the underlying module, position included, while
  `translateOverlayRow` unconditionally appends the new value to its overlay rows. A position
  supplied from above isolation would therefore land at the requested slot underneath and at the
  end in the overlay, whose schema claims the requested slot — every value from there on read
  under the wrong name, silently. Dormant (nothing sets a position today), so `debt-`. It is also
  the natural home for the intended consumer, since the overlay is the reason `insertAtIndex`
  exists.

### Tripwires (parked in code, not ticketed)

- *Engine-side column-level CHECK assumes an append.* `buildAddColumnChecks`
  (`planner/building/alter-table.ts:278`) builds the per-row context as `[...existingRow, value]`,
  so a wrapper redirecting an *engine-driven* ADD COLUMN to a position must not declare a
  column-level CHECK on the new column. Three conditions must coincide for it to bite and none is
  reachable today. Already parked at the `insertAtIndex` declaration by the implementer; this pass
  additionally surfaced it in `docs/memory-table.md`, where a reader of the reshape section will
  meet it.
- *The schema-change event carries the column name but not its position.* Implementer's NOTE at
  the emit site in `manager.ts`; verified accurate and left as-is.

### Checked, nothing found

- **Append path untouched.** The `targetIndex < appendIndex` gate means an omitted or
  end-position `insertAtIndex` skips `shiftSchemaIndicesForInsert` entirely, so third-party
  modules and every existing caller take the pre-change path.
- **Failure atomicity.** The position is validated before the first mutation; the `catch` restores
  the original schema on both the manager and the base layer and rebuilds the key functions. The
  pending-row reshape stays in the fallible pre-mutation phase, so a throwing backfill still
  rejects the ALTER with base, schema and every layer untouched.
- **Index-name stability.** `implicitIndexNameFor` derives an auto-index name from column *names*
  read at the shifted indices, so the constraint↔covering-structure link survives a renumber.
  Worth confirming, since an index-derived name would have orphaned every implicit UNIQUE index.
- **Remaining schema fields.** `checkConstraints` (AST), `tableConstraints` (AST),
  `statistics.columnStats` (name-keyed), `mutationContext` (no indices) genuinely need nothing.
- **Store rejection.** Compares against the *pre-alter* column count, so the append position it
  accepts is the right one; the throw precedes every mutation.
- **Source hygiene.** `shiftSchemaIndicesForInsert` is a pure module-level function of the right
  size with one clear job. `MemoryTableManager.addColumn` is now ~130 lines, which is long — but
  its shape and comment density match `alterColumn` / `dropColumn` beside it, and
  `backlog/debt-memory-alter-column-method-too-long` already tracks that family. Not re-filed as a
  duplicate.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (includes the `tsc -p tsconfig.test.json` pass over quereus test files);
  re-run for `@quereus/quereus` after the final comment edit.
- `yarn typecheck` — clean.
- `yarn test` — full workspace suite green, 0 failing (7298 + 279 + 104 + 56 + 17 + 28 + 1043 +
  481 + 52 + 31 + 5 + 74 + 34 + 118 + 22 passing).
- `yarn test:store` — **not run**, same call the implementer made: it re-runs the quereus logic
  suite against LevelDB and is slow, while the store-side change only adds a rejection on an input
  SQL never produces. Still unverified against LevelDB.
