---
description: A partial index's WHERE clause that puts a foreign table name in front of a column is now rejected when the index is created, instead of being silently treated as if it named the indexed table.
prereq:
files:
  - packages/quereus/src/vtab/memory/utils/predicate.ts        # compilePredicate: tableName? arg + foreign-qualifier rejection + tripwire NOTE
  - packages/quereus/src/vtab/memory/index.ts                  # MemoryIndex ctor: tableName param → compilePredicate
  - packages/quereus/src/vtab/memory/layer/base.ts             # createMemoryIndex → tableSchema.name
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # 2 MemoryIndex ctor sites → schema.name / newSchema.name
  - packages/quereus/src/vtab/memory/layer/manager.ts          # 3 compilePredicate + probe MemoryIndex → schema.name
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # MV WHERE: deliberately undefined + NOTE
  - packages/quereus-store/src/common/store-module.ts          # 3 compilePredicate → tableSchema.name; stale bug-ref comment tightened
  - packages/quereus-store/src/common/store-table.ts           # 2 compilePredicate → this.tableSchema!.name
  - packages/quereus-isolation/src/isolated-table.ts           # 1 compilePredicate → this.tableSchema!.name
  - packages/quereus/src/runtime/emit/alter-table.ts           # predicateReferencesColumn doc comment (logic unchanged)
  - packages/quereus/test/partial-index-column-rename.spec.ts  # reshaped rejection/positive tests + table-rename regression test
  - docs/schema.md                                             # § index body-change detection: cross-table reference now impossible
difficulty: medium
---

# Complete: reject `CREATE INDEX ... WHERE <foreign-table>.<col>` at create time

## What the bug was

`compilePredicate` resolved a partial-index / partial-UNIQUE / MV predicate's column
references by **bare name** against the indexed table's columns. It rejected a
*schema*-qualified ref (`main.active`) and subqueries, but **never read the `table` field**
of a column reference. So `create index ix on t (name) where zzz.active = 1` was accepted
and behaved exactly as `where active = 1` — two statements that read differently compiled to
the same index. It also let a stale foreign qualifier slip past the ALTER rename/drop
machinery and blow up on a later rebuild.

## What shipped

`compilePredicate(expr, columns, tableName?)` gained an optional owning-table name. When
supplied, a `table`-qualified ref naming any table other than the owning one is rejected at
compile time (case-insensitive); a self-qualifier (`where t.active = 1`, `T.ACTIVE`) is
accepted. Threaded through the recursive unary/binary/in helpers so a qualified ref at any
depth is caught. Schema-qualifier and subquery rejections are untouched.

Every real index / UNIQUE compile site now passes its owning `TableSchema.name`:
- `MemoryIndex` ctor gained a required `tableName` param (inserted before the optional
  trailing `baseInheritreeTable`). All 5 non-test ctor sites and 3 test ctor sites updated.
- Memory manager (×3), store-module (×3), store-table (×2), isolation (×1) pass the owning
  table name.

The MV maintenance site (`database-materialized-views-plan-builders.ts`) deliberately passes
`undefined` (lenient): an MV body may reference its source through a FROM **alias** rather
than the source table's own name, so validating against `sourceSchema.name` would wrongly
reject a legal aliased body — and this site floors to full-rebuild on any throw, so a false
rejection would be a silent maintenance regression. Documented with a `NOTE:` at the site.

## Review findings

Adversarial pass over the implement diff (commit `1eec4bbb`) — read fresh before the
handoff. Scrutinized correctness, DRY, call-site completeness, type safety, the ALTER
rename/rebuild interaction, docs currency, and test coverage.

**Correctness / completeness — checked, no defects.**
- Verified against the parser: a qualified reference (`table.col` or `schema.table.col`)
  always parses to `type: 'column'` carrying a `table` field; an `identifier` node never
  carries `table`. So the `ref.type === 'column' && ref.table` guard catches every foreign
  qualifier — no shape slips through. Schema-qualified refs are still rejected first
  (before the new table check), unchanged.
- Enumerated every `compilePredicate` call site and every `new MemoryIndex` site: all pass
  the owning table name (or, for MV maintenance, deliberately `undefined`). No site missed.
  The manager MV-covering site (`manager.ts:1083`) passes `schema.name` correctly — it
  compiles the *constraint's* `uc.predicate` (scoped to the table), not the aliasable MV
  *body* WHERE, so it is rightly strict, not the lenient MV-body case.
- Ctor arity: `tableName` is required and inserted before the optional `baseInheritreeTable`
  — required-before-optional, no positional ambiguity.

**ALTER rename interaction — checked, handled.** The fix flips a self-qualifier from
"silently ignored" to "must name the owning table", so a table rename that failed to rewrite
the qualifier would now throw on the next index rebuild (previously harmless). Traced the
rename path: `rewriteTableForTableRename` (`alter-table.ts`) rewrites the predicate AST's
self-qualifier `t.active → t2.active` **in place**, and the AST is shared by reference with
the memory manager's schema and the derived UNIQUE constraint, so a subsequent rebuild
recompiles the qualifier against the new name and accepts it. Confirmed empirically.

**Test coverage — one gap, fixed inline (minor).** The reshaped spec covers create-time
rejection, self-qualifier accept (non-unique + case-insensitive UNIQUE enforcement through
live DML), and column-rename of a self-qualified predicate. It did **not** cover **table**
RENAME (as opposed to column rename) of a self-qualified index followed by a rebuild — the
exact surface that changed from lenient to strict. Added
`keeps a self-qualified partial index live across a table RENAME and a following rebuild`
to `partial-index-column-rename.spec.ts`; it renames the table, forces a
consolidation+rebuild via a column rename, and asserts the index survives with a
self-consistent (`t2.is_active`) predicate. Passes.

**Docs — checked, current.** `docs/schema.md` § index body-change detection now states a
cross-table reference cannot survive to the differ (rejected at create time). `alter-table.ts`
`predicateReferencesColumn` doc block and the `store-module.ts` rename-reversal `NOTE:` were
updated to reflect that a live predicate can no longer carry a foreign qualifier. Read each;
they match the new reality.

**Tripwire (recorded, not a ticket).** A store-persisted DB written by *pre-fix* code may
already hold a foreign-qualified partial-index predicate; recompiling it now throws (on
rebuild / first maintenance) where it previously bound by bare name. Genuinely conditional —
only trips if a legacy DB with an already-semantically-wrong index is reopened, and the
project's stance is that backwards compatibility is not yet a concern. Parked as a `NOTE:`
at the rejection site in `predicate.ts` (greppable); no migration attempted.

**Major findings:** none — no new fix/plan/backlog ticket filed.

**Pre-existing failure:** the store-mode `41.2-alter-column.sqllogic:112` failure the
implementer flagged was already resolved by the triage pass (commit `1aaf1c76`, which fixed
`isolation-module.ts` + `store-module.ts` and removed `.pre-existing-error.md`). Not
re-reported; not attributable to this change.

## Validation performed

- `yarn workspace @quereus/quereus lint` — clean (eslint + tsc typecheck of src and test
  files, catching the ctor-arity change at spec call sites; re-run after the added test).
- `yarn workspace @quereus/quereus test` (memory mode, the agent gate) — **6920 passing /
  13 pending** before the added test; the reshaped `partial-index-column-rename` spec now
  **13 passing** (was 12) with the new table-rename regression test.
- Table-rename self-qualifier path additionally verified by direct execution before writing
  the test.
