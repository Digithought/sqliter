---
description: Adding a computed column to a table that already had rows used to leave those rows blank forever; it now computes them, and rejects the whole change if it cannot.
files:
  - packages/quereus/src/planner/building/alter-table.ts                        # buildAddColumnBackfill — the fix
  - packages/quereus/src/schema/table.ts                                        # validateAddColumnGeneratedRefs — new pre-flight (bottom of the generated-column section)
  - packages/quereus/src/vtab/memory/layer/manager.ts                           # addColumn — NOT NULL gate now exempts a supplied evaluator (~line 1927)
  - packages/quereus/src/runtime/emit/alter-table.ts                            # runAddColumn / emitAlterTable — comments widened only
  - packages/quereus/src/planner/nodes/alter-table-node.ts                      # AddColumnBackfill / AddColumnCheck docs
  - packages/quereus/src/vtab/module.ts                                         # SchemaChangeInfo.backfillEvaluator doc
  - packages/quereus/src/vtab/memory/layer/base.ts                              # comments only
  - packages/quereus-store/src/common/store-module-alter.ts                     # comments only
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # new coverage
  - docs/sql-ddl.md                                                             # § Generated Columns, § Default Values, § ADD COLUMN
  - docs/types.md                                                               # § ALTER backfills follow the same rule
difficulty: medium
---

# What changed

`alter table t add column g integer generated always as (v * 2)` on a table that
already held rows used to leave `g` NULL in every one of them, forever, while rows
inserted afterwards computed it correctly. It now computes the value for the existing
rows too.

The engine already had the machinery: an ADD COLUMN whose DEFAULT cannot be reduced to
a constant (`default (new.<col>)`) is compiled into a small per-row expression, and each
storage module calls it once per existing row. That path was keyed on the column having
a `default` clause, so a `generated always as` clause produced nothing and the module
wrote its single fallback value — NULL, because a generated column has no DEFAULT.

`buildAddColumnBackfill` (`packages/quereus/src/planner/building/alter-table.ts`) now
sources its expression from a `generated` clause as well as a `default` one. Everything
downstream — the emitter's per-row evaluator, both storage modules, the isolation
layer's staged-row migration, the batched change-event remap — was already written
against "an evaluator was supplied", so it all inherits the fix unchanged.

Two supporting changes were needed:

- **The generated arm never folds to a constant.** The DEFAULT arm returns early when
  the default reduces to a literal, because the module bulk-writes that literal from
  the column's stored default value. A generated column has no stored default, so the
  same shortcut writes NULL — which is why `generated always as (2)` was broken too.
- **The memory module's "NOT NULL needs a value" gate** (`MemoryTableManager.addColumn`)
  asked *which kind of DEFAULT was written* rather than *was a per-row value supplied*,
  so it rejected a mandatory generated column on a non-empty table that the new backfill
  can fill perfectly well. It now also accepts a supplied evaluator as a value source
  (the store module's equivalent gate already did).

# Behaviour changes a reviewer should look at deliberately

Four statements behave differently than before. Three are the point of the ticket; all
four are intentional, and each is covered by the new test file.

1. **`add column g … generated always as (…)` with no `null` in the declaration is now
   accepted on a non-empty table.** Columns are mandatory by default in this engine
   (`default_column_nullability` ships as `not_null`), so the bare spelling used to be
   rejected outright with *"Cannot add NOT NULL column … without a DEFAULT value"*. It
   now backfills.
2. **`add column g … generated always as (random())` is now rejected at `ALTER` time**,
   including on an empty table. It used to be accepted silently and fail at the next
   INSERT. This matches the DEFAULT arm, which has always validated determinism at
   plan-build regardless of row count, and it still honours the `nondeterministic_schema`
   escape hatch.
3. **An inline `check` on a generated column is now enforced against each backfilled
   row.** `add column g integer null generated always as (v * 2) check (g > 100)` over a
   row with `v = 5` used to be accepted silently — the post-backfill scan saw the
   un-backfilled NULL, and `not (null > 100)` is NULL, so no violation was detected. It
   now rejects and leaves the table untouched. This falls out of the fix rather than
   being added by it (the CHECK compilation is gated on a backfill being present).
4. **A bad generated expression is now caught at plan-build rather than after the column
   is materialized.** Left alone, that would have degraded the message: the expression is
   compiled against a scope holding only the *existing* columns, so `generated always as
   (nope * 2)` and the self-referencing `generated always as (g + 1)` would both surface
   as a bare `Column not found`. A new pre-flight
   (`validateAddColumnGeneratedRefs` in `schema/table.ts`) raises the same two messages
   `CREATE TABLE` raises, so the two authoring surfaces still report identically. It can
   only move those rejections earlier — the emitter's own graph rebuild still runs and
   would raise the same errors — so it cannot reject anything that used to work. Both
   rejections are pre-mutation.

# Validation

- `yarn build` — clean.
- `yarn test` (memory backend, whole monorepo) — 7854 passing in `packages/quereus`, all
  other packages green, 0 failing.
- `yarn lint` — clean.
- `yarn test:store` (LevelDB-backed re-run of the `.sqllogic` corpus, which also puts the
  isolation layer in the path) — 7845 passing, 22 pending, 0 failing. The new file passes
  under both backends.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

New coverage lives in
`packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic`, next to
the existing `41-generated-column-errors.sqllogic`. Nine sections:

- every spelling backfills — bare, `virtual`, `stored` — and each agrees with a row
  inserted after the ALTER; `table_info.generated` still reports the spelling (1 =
  VIRTUAL, 2 = STORED), which is informational only.
- a constant generated expression (`generated always as (2)`) backfills.
- a generated expression over an existing generated column resolves.
- the computed value is converted to the new column's declared type, so a backfilled cell
  and an inserted one have the same `typeof`.
- `not null generated`: accepted and backfilled when the expression is total; rejected
  with the table untouched when it yields NULL for an existing row.
- an inline CHECK: violated ⇒ ALTER rejected, table untouched; satisfied ⇒ accepted.
- a non-deterministic expression rejected on both a populated and an empty table.
- the two error-message regressions above.
- the declarative route (`declare schema` + `apply schema`) — verified that the schema
  differ emits `ALTER TABLE t ADD COLUMN g INTEGER null generated always as (v * 2)`, i.e.
  the same emitter, not a drop-and-recreate.

# Known gaps — treat the tests above as a floor

- **Staged rows.** No test performs the ALTER inside an open transaction that has
  uncommitted rows for the table. Both the memory manager
  (`prepareReshapeOnOpenLayers`) and the isolation layer
  (`quereus-isolation/src/alter-migration.ts`) run the evaluator over those rows, and
  both were already written against the evaluator rather than against DEFAULT, so they
  should inherit the fix — but that is reasoning, not a test. The nearest existing
  coverage is `41.8-alter-savepoint-staged-rows.sqllogic` for the DEFAULT path.
- **Generated + inline UNIQUE / FOREIGN KEY on the same ADD COLUMN.** Only the CHECK
  interaction is covered. The constraint-install loop is shared with the DEFAULT path
  (`41.3-alter-add-column-unique.sqllogic`, `41.4-alter-add-column-constraints.sqllogic`),
  so nothing generated-specific is expected, but it is unverified.
- **Collation.** A generated expression that compares against a column with a
  non-BINARY collation is untested for the backfill path. The scope builder
  (`buildRowDefaultScope`) resolves against the declared column type, which carries the
  collation, so it should match write-time — again unverified.
- **Modules that opt out.** A module advertising `delegatesNotNullBackfill` owns the
  NOT NULL decision itself; that path is untouched and untested for generated columns.
- **VIRTUAL is still stored.** This engine materializes a generated value at write time
  regardless of the keyword, so one backfill path serves both spellings. That is
  pre-existing and documented; the ticket confirmed there is no distinction to make yet.

# A related defect found on the way, filed separately

Fully aligning the memory module's NOT NULL gate with the store's (asking only "was a
value supplied?") turned out to reject a statement the memory module accepts today:
`add column extra text default null` on a non-empty table, where the column is mandatory
because of the session default rather than because the statement says `not null`. Memory
accepts it and stores NULL in a mandatory column; every later insert that omits the
column then fails. Reproduced on a plain memory table.

That is a real defect but a different one, and closing it changes which DDL the engine
accepts — so the gate was left laxer than the store's, with a `NOTE:` at the site, and
the defect is filed as **`tickets/fix/bug-add-column-default-null-notnull-hole.md`**. It
names the one existing test (`packages/quereus/test/optimizer/statistics.spec.ts` ~line
588) that relies on the current behaviour and how to adjust it. The `!backfillEvaluator`
clause this ticket added to that gate is the load-bearing one for generated columns and
is unaffected by that decision.
