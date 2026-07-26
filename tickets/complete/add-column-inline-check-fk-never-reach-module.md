---
description: A CHECK or foreign-key rule written inline when adding a column used to silently disappear the next time any column on that table was dropped or renamed; it now sticks, and survives a restart too.
files:
  - packages/quereus/src/schema/constraint-builder.ts       # the three extractColumnLevel* extractors — all return AST table constraints
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAddColumn; revertAddColumn; validateBackfillAgainstChecks
  - packages/quereus-store/src/common/store-module.ts       # alterAddColumn — its duplicate extract-and-persist block is gone
  - packages/quereus/src/index.ts                           # two extractors un-exported (store no longer needs them)
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic   # sections 7a–7g
  - packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts  # persist → reopen round-trip
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts          # inline-constraint arms through the wrapper
  - docs/sql-ddl.md, docs/runtime.md, docs/module-authoring.md
difficulty: medium
---

# ADD COLUMN's inline CHECK / FOREIGN KEY now reach the table's module

## What changed

Before: `alter table t add column c int check (…)` / `… references p(pid)` built the
constraint into the **engine's catalog copy** of the table schema only. The table's storage
module was never told. Every later structural ALTER (`DROP COLUMN`, `RENAME COLUMN`, …) asks
the module for the new schema and installs the module's answer in the catalog verbatim — and
the module's answer had never heard of the constraint, so it was dropped on the floor with no
error. Bad data was accepted afterwards. A store-backed table only kept the constraint
because the store module re-extracted and persisted it in its own ADD COLUMN arm.

Now all three inline kinds (UNIQUE, CHECK, FOREIGN KEY) go through
`module.alterTable({ type: 'addConstraint', constraint })` — the same path
`ALTER TABLE ADD CONSTRAINT` uses. The module owns them, exactly as it owns a constraint
written in `create table`. UNIQUE already worked this way; CHECK and FK joined it.

### `runAddColumn` ordering

1. Extract the inline constraints as synthetic table-level AST constraints (before anything
   is mutated, so a malformed FK still rejects with the table untouched).
2. `module.alterTable({ addColumn })` — materialize + backfill; remap batched events.
3. `withGeneratedColumnGraph` then `schema.addTable(columnOnlySchema)` — register the new
   **column** but no new constraint.
4. Literal-default CHECK backfill scan (per-row/expression defaults already checked each
   value inside the backfill hook).
5. For each inline constraint, in order UNIQUE → CHECK → FK: for an FK, the collation-conflict
   rejection first (before the module call, so a rejected ALTER never persists), then
   `module.alterTable({ addConstraint })`.
6. `schema.addTable(finalTableSchema)` + `table_modified` notify.

Any failure from step 3 onward goes through `revertAddColumn`, which drops the
already-installed CHECK / FK **by name, newest first**, then the column, then un-remaps the
batched events and restores the original catalog entry.

### Two load-bearing properties, and where they live

- **Validation must not see the new constraint.** The optimizer treats a declared constraint
  as a proven invariant and would fold the validating scan to nothing. The catalog holds the
  column-only schema for the whole validation window; each module keeps its new constraint in
  its own cached schema until that constraint's own validation passes. The two engine-bug
  guards (`41.4` cases 1b and 2m) are the real test of this — both are written so a fold makes
  them silently green-with-a-violating-row.
- **A violation leaves the table exactly as it was.** Previously only the column had to be
  dropped (constraints lived engine-side); now installed constraints must be handed back too,
  which is what `revertAddColumn` does. Case 7f covers the interleaving — CHECK installs, FK
  fails.

### Deliberate user-visible change: FK auto-name

An unnamed inline FK on an added column was named `_fk_<column>`. It is now
`_fk_<table>_<column>` — the same name the `create table` spelling produces. The two paths
agreeing is the point of the fix. An unnamed inline CHECK keeps `_check_<column>`, which also
matches `create table`; that required naming it explicitly in the extractor, since the
module's table-level `ADD CONSTRAINT` convention would otherwise rename it `check_<n>`.

### Deleted duplication

- The engine's `mergedChecks` / `mergedForeignKeys` / `resolvedForeignKeys` merge and its own
  copy of the FK existing-row validation (`validateForeignKeyOverExistingRows` is now called
  only by the modules and the other paths).
- The store module's `alterAddColumn` extract-and-persist block (`persistedSchema`).
- `extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys` dropped from the
  `@quereus/quereus` barrel — engine-internal now, matching the UNIQUE extractor.

## Review findings

Reviewed the implement diff (`c649f6d3`) first, then probed the runtime directly with
throwaway scripts against the built engine — 22 scenarios across the memory module, the
isolation wrapper, and (via `test:store`) the store module.

### Checked and clean — no action

Every one of these was exercised against a running engine, not read off the source:

- **Naming parity with `create table`** — `_fk_<table>_<column>`, `_check_<column>`, explicit
  names, and a schema-qualified parent (`references main.p(pid)`) all round-trip; the same
  declarations written as `create table` produce identical names.
- **Constraint payload survives the AST round-trip.** The extractors now hand the module raw
  AST fields instead of pre-built schema objects, so each field was re-checked end to end:
  the `check on insert (…)` operations qualifier (fires on insert, not update — matching the
  `create table` spelling), `on conflict` on an inline UNIQUE, `on delete cascade` /
  `on update cascade` on an inline FK (a parent delete really cascades), and `deferred`.
- **Revert paths.** Literal-default CHECK violation, per-row-default CHECK violation, FK
  orphan, FK collation conflict, malformed multi-parent-column FK, and UNIQUE-installed-then-
  CHECK-fails all leave zero stranded constraints, the original column set, and a writable
  table; the satisfied retry then succeeds.
- **Self-referential inline FK** installs, enforces, and survives a `rename column` of its own
  parent column.
- **Isolation wrapper** (the implement handoff's "not verified" item) — inline CHECK and FK
  both route correctly through `IsolationModule`, enforce, survive an unrelated `drop column`,
  reach rows staged in an open transaction, hold past commit, and revert cleanly. Verified,
  then pinned with four new tests (below).
- **Known gap 1** (dropping a column that *precedes* an FK's child column) is correctly
  excluded — it is the separate in-flight `bug-drop-column-leaves-fk-child-index-dangling`,
  affects every FK regardless of declaration site, and the 7c/7d cases deliberately drop a
  trailing column to avoid it.
- **Known gap 2** (two unnamed `references` clauses on one column both auto-naming to
  `_fk_<table>_<column>`) — reproduced *identically* via `create table`, so it is pre-existing
  engine-wide naming behavior, not introduced here. `drop constraint` on the shared name
  removes both at once, which is also the revert path's end state, so nothing is left
  inconsistent. No ticket filed.
- **Known gap 3** (best-effort revert on the module half) — matches the pre-existing contract
  of the old revert path; the change neither widens nor narrows it.
- **Lint / typecheck / tests** — `yarn build`, `yarn lint`, `yarn typecheck` clean;
  `yarn test` 7328 passing in `packages/quereus`, 312 in `quereus-isolation` (was 308), 1049
  in `quereus-store`, 0 failing anywhere; `yarn test:store` 7322 passing, 0 failing. No
  pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Minor — fixed in this pass

- **`docs/runtime.md` was stale and the change should have touched it.** Its ADD COLUMN
  section still described the deleted design: CHECK/FK "merged into the table-level
  constraint set", the engine running its own `validateForeignKeyOverExistingRows` post-scan,
  and an intermediate `validationSchema` that no longer exists. Rewritten to describe the
  module-owned routing, the per-kind validation split, the FK collation pre-check, the
  auto-naming convention, and `revertAddColumn`; the "why validation runs against a
  column-only schema" callout was updated to name the real variable.
- **`docs/module-authoring.md` did not tell module authors about the new caller.** The
  `addConstraint` mandate row now says ADD COLUMN issues a follow-up `addConstraint` per
  inline constraint, that implementing `addColumn` without `addConstraint` makes
  `add column … check (…)` fail outright, and that `dropConstraint` / `dropColumn` must
  tolerate being called back for something added moments earlier in the same statement.
- **Stale ordering comment in `runAddColumn`** claimed UNIQUE's existing-row validation runs
  first. The literal-default CHECK scan actually precedes the whole install loop, so a column
  violating both reports CHECK. Comment corrected on both sides.
- **Silent `continue` in `validateBackfillAgainstChecks`** skipped a CHECK with no expression.
  Unreachable (the extractor filters those), but silently skipping a constraint we were asked
  to validate is the wrong failure mode — it would admit a violating row. Now throws
  `INTERNAL`.
- **Test coverage for two paths the handoff flagged as unverified.**
  - `41.4` §7g: per-row (expression) DEFAULT together with an inline CHECK, both directions —
    satisfied (backfills, CHECK declared, survives a later `drop column`, still enforces) and
    violating (aborts inside the backfill, table byte-identical, still writable). This is the
    combination `docs/sql-ddl.md` had wrongly called unsupported and which the implement pass
    corrected without a test; the doc claim is now backed. Verified the case actually executes
    by breaking an expectation and confirming the failure, then restoring it.
  - `packages/quereus-isolation/test/alter-table-conformance.spec.ts`: four new cases covering
    inline CHECK, inline FK, rejected-add revert, and an inline CHECK over rows staged in an
    open transaction — all through `IsolationModule`.

### Major — new ticket filed

- **`backlog/bug-add-column-generated-never-backfilled.md`.** `alter table t add column g
  … generated always as (<expr>)` leaves every pre-existing row NULL in the new column,
  permanently, with no error — while the same column declared in `create table` computes
  correctly and rows inserted afterwards compute correctly. The table ends up holding two
  populations that disagree about what the column means. **Independent of this ticket**: it
  reproduces with no constraint on the added column at all, and nothing in this diff touches
  how the new column's value is computed. Found while probing generated columns interacting
  with the rerouted inline CHECK.

### Tripwires — parked as `NOTE:`, not tickets

- `revertAddColumn` hands constraints back **by name**, which assumes the name resolves to
  the one this ALTER installed. A pre-existing constraint can legitimately share an auto-name
  (verified: nothing rejects it, and `create table` collides the same way). Today both modules'
  `dropConstraint` removes every match, so the end state is right — verified by driving the
  exact collision. Parked as a `NOTE:` on `revertAddColumn` saying that if name resolution
  ever narrows to a single match, revert must identify the installed constraint by identity.
- The implement pass's own tripwire (one module round-trip per inline constraint, each taking
  the schema-change latch and rewriting the store's DDL) was already parked as a `NOTE:` at
  the loop in `runAddColumn`, with the remedy. Left as-is — reviewed and agreed.
