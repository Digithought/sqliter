---
description: Adding a computed column to a table that already had rows used to leave those rows blank forever; it now computes them, and rejects the whole change if it cannot.
files:
  - packages/quereus/src/planner/building/alter-table.ts                        # buildAddColumnBackfill — the fix
  - packages/quereus/src/schema/table.ts                                        # validateAddColumnGeneratedRefs — pre-flight (adjusted in review)
  - packages/quereus/src/vtab/memory/layer/manager.ts                           # addColumn — NOT NULL gate exempts a supplied evaluator
  - packages/quereus/src/runtime/emit/alter-table.ts                            # runAddColumn / emitAlterTable
  - packages/quereus/src/planner/nodes/alter-table-node.ts                      # AddColumnBackfill / AddColumnCheck docs
  - packages/quereus/src/vtab/module.ts                                         # SchemaChangeInfo.backfillEvaluator doc
  - packages/quereus/src/vtab/memory/layer/base.ts                              # comments only
  - packages/quereus-store/src/common/store-module-alter.ts                     # comments only
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # coverage (sections 10–13 added in review)
  - docs/sql-ddl.md                                                             # § Generated Columns, § Default Values, § ADD COLUMN
  - docs/types.md                                                               # § ALTER backfills follow the same rule
  - docs/runtime.md                                                             # § Determinism Validation (added in review)
  - docs/module-authoring.md                                                    # addColumn module contract (added in review)
difficulty: medium
---

# What shipped

`alter table t add column g integer generated always as (v * 2)` on a table that
already held rows used to leave `g` NULL in every one of them, forever, while rows
inserted afterwards computed it correctly. It now computes the value for the existing
rows too, and rejects the whole `ALTER` — leaving the table untouched — when it cannot
(NOT NULL left NULL, an inline CHECK or UNIQUE violated).

The engine already had the machinery: an ADD COLUMN whose DEFAULT cannot be reduced to
a constant (`default (new.<col>)`) is compiled into a small per-row expression, and each
storage module calls it once per existing row. That path was keyed on the column having
a `default` clause, so a `generated always as` clause produced nothing and the module
wrote its single fallback value — NULL, because a generated column has no DEFAULT.
`buildAddColumnBackfill` now sources its expression from a `generated` clause as well.
Everything downstream — the emitter's per-row evaluator, both storage modules, the
isolation layer's staged-row migration, the batched change-event remap — was already
written against "an evaluator was supplied", so it inherited the fix unchanged.

Two supporting changes were needed: the generated arm never takes the DEFAULT arm's
fold-to-a-constant shortcut (there is no stored default for a module to bulk-write, so
folding would write NULL — which is why `generated always as (2)` was broken too), and
the memory module's "NOT NULL needs a value" gate now asks *was a per-row value
supplied* rather than only *which kind of DEFAULT was written* (the store module's
equivalent gate already did).

# Behaviour changes

Four statements behave differently than before. All four are intentional and covered by
`packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic`.

1. **`add column g … generated always as (…)` with no `null` in the declaration is now
   accepted on a non-empty table.** Columns are mandatory by default in this engine
   (`default_column_nullability` ships as `not_null`), so the bare spelling used to be
   rejected outright with *"Cannot add NOT NULL column … without a DEFAULT value"*.
2. **`add column g … generated always as (random())` is now rejected at `ALTER` time**,
   including on an empty table, rather than at the next INSERT. Matches the DEFAULT arm,
   and still honours the `nondeterministic_schema` escape hatch.
3. **An inline `check` on a generated column is now enforced against each backfilled
   row.** It used to pass silently: the post-backfill scan saw the un-backfilled NULL,
   and `not (null > 100)` is NULL, so no violation was detected.
4. **A bad generated expression is caught at plan-build** by a new pre-flight
   (`validateAddColumnGeneratedRefs`, `schema/table.ts`) that raises the same two
   messages `CREATE TABLE` raises, instead of the bare `Column not found` the
   existing-columns-only compile scope would otherwise produce. It only moves those
   rejections earlier — the emitter's own graph rebuild still runs.

# Review findings

Read the implement diff (`b81a907d`) first, then the current state of every file it
touched.

**Fixed in this pass (minor):**

- **`validateAddColumnGeneratedRefs` misreported a duplicate column as a cycle.**
  Regression introduced by the implement diff. `alter table t add column v integer
  generated always as (v * 2)` where `v` already exists is a *duplicate column* — the
  reference resolves to the existing sibling — but the pre-flight tested the name match
  before considering whether the name was already taken, so the user got *"Cyclic
  dependency in generated columns: 'v'"* instead of `runAddColumn`'s *"Column 'v'
  already exists in table 't'"*. Before the implement diff no pre-flight ran and the
  correct message was reported, so this was a fresh, user-visible message regression.
  Fixed by skipping the cycle branch when the new column name is already a column of the
  table; covered by test section 12 (both the self-referencing and the
  non-self-referencing spelling).
- **`docs/runtime.md` § Determinism Validation was stale.** It described `ALTER TABLE
  ADD COLUMN`'s per-row backfill as a DEFAULT-only mechanism, and listed `GENERATED
  ALWAYS AS` validation as happening only at INSERT/UPDATE build. Rewritten to cover the
  generated arm, its three deliberate differences from the DEFAULT arm (never folded,
  generated-flavoured determinism validator, the reference pre-flight), and the fact
  that each module's NOT NULL gate keys on the evaluator's presence.
- **`docs/module-authoring.md` `addColumn` contract row was stale.** It told module
  authors `backfillEvaluator` arrives only for a non-foldable DEFAULT. That is the exact
  sentence a module author would build a wrong NOT NULL gate from — the same wrong gate
  the memory module had. Updated to name both sources and to say plainly that the gate
  should key on the evaluator's presence, not on the column def's DEFAULT.
- **Test coverage extended** (the implement ticket listed these as gaps; all four now
  pass under both `yarn test` and `yarn test:store`):
  - §10 staged rows — the ALTER runs inside an open transaction holding an uncommitted
    row; both the committed and the staged row backfill, and the staged one still
    commits. Exercises `prepareReshapeOnOpenLayers` (memory) and the isolation overlay
    migration (store), which the implementer had only reasoned about.
  - §11 inline `unique` on the generated column — distinct computed values accepted,
    colliding ones reject the whole ALTER with the table untouched.
  - §12 the duplicate-column message above.
  - §13 the added column is a first-class generated column afterwards — `update` of a
    source column recomputes it, and `update`/`insert` writing to it directly are
    refused. This checks that the ALTER also rebuilds the table's generated-column
    dependency graph, not merely that it backfilled once.

**Checked and found sound (no action):**

- Pre-flight equivalence with `CREATE TABLE`. Both messages match
  `extractGeneratedColumnDependencies` / `topoSortGeneratedColumns` verbatim, including
  status code, and the pre-flight uses the same node shapes and the same skip rules
  (a ref qualified to another table is skipped; only the unambiguous `column` shape
  yields "not found"). It cannot reject anything the emitter's own rebuild would accept.
  A function *name* cannot be mistaken for a self-reference — `traverseAst` does not
  descend into `FunctionExpr.name`.
- The three revert/abort paths. A CHECK or NOT NULL violation throws inside the per-row
  hook, so the module's staged tree/batch is discarded before publication; a UNIQUE or
  FK violation lands after materialization and goes through `revertAddColumn`. Both
  verified by the tests leaving the table exactly as it was.
- The batched change-event remap (`remapBatchedDataEvents`) and the memory module's
  event-log variant both prefer the evaluator over the folded default and fall back to
  NULL best-effort, so a generated column inherits correct event images.
- `withGeneratedColumnGraph` is re-derived after the column lands and after every inline
  constraint round-trip, so the catalog's dependency graph includes the new column
  (proven by §13).
- Collation on a generated backfill expression, flagged as a gap by the implementer, is
  not generated-specific: `buildAddColumnBackfill` is one function serving both arms and
  the attributes it mints carry each column's declared collation, so the DEFAULT arm's
  existing coverage applies. Left untested deliberately rather than filed.
- Source hygiene. No new file, one new exported function placed next to its two
  siblings, no `any`, no lint or typecheck complaints. Comment density on the touched
  hunks is high but matches the surrounding file.

**Major findings: none.** No new `fix/`, `plan/`, or `backlog/` tickets were filed from
this review. Every defect found was a message regression or a doc/test gap, all fixed
inline.

**Tripwires (conditional; parked, not ticketed):**

- *Constant generated expressions are evaluated per row.* `generated always as (2)` over
  a large table pays one scalar evaluation per existing row because there is no
  `defaultValue` channel for a module to bulk-write. Parked as the existing explanatory
  comment in `buildAddColumnBackfill` (`planner/building/alter-table.ts`), which already
  states the reason the fold is skipped. If the per-row cost ever shows up, the fix is to
  add a bulk-value channel for the generated arm, not to restore the fold.
- *Modules advertising `delegatesNotNullBackfill` own the NOT NULL decision themselves*
  and are untested for generated columns; no shipped module turns the flag on. Parked as
  the gate guidance now written into `docs/module-authoring.md`'s `addColumn` row, which
  is what an author of such a module reads.
- *The memory module's NOT NULL gate stays laxer than the store's* for `default null` on
  a column mandatory only via the session `default_column_nullability`. Left as-is with a
  `NOTE:` at the site; the underlying defect is a separate in-flight ticket,
  `bug-add-column-default-null-notnull-hole` in `tickets/fix/`. The `!backfillEvaluator`
  clause this work added to that gate is independent of how that ticket resolves.

# Validation

Run at review, after the review's own edits:

- `yarn build` — clean.
- `yarn test` (memory backend, whole monorepo) — 7854 passing in `packages/quereus`,
  every other package green, **0 failing**.
- `yarn test:store` (LevelDB-backed re-run of the `.sqllogic` corpus, which also puts the
  isolation layer in the path) — 7845 passing, 22 pending, **0 failing**.
- `yarn lint` — clean.

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

# Remaining untested surface

Deliberately left, none of it generated-specific:

- Inline `foreign key` on a generated ADD COLUMN (UNIQUE and CHECK are now covered; the
  constraint-install loop is shared with the DEFAULT path).
- A generated expression comparing against a non-BINARY-collation column (see above).
- Modules that advertise `delegatesNotNullBackfill` (see tripwires).
- VIRTUAL vs STORED remain indistinguishable — this engine materializes a generated
  value at write time either way, so one backfill path serves both spellings. Pre-existing
  and documented.
