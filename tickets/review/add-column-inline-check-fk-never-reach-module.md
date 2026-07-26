---
description: A CHECK or foreign-key rule written inline when adding a column used to silently disappear the next time any column on that table was dropped or renamed; it now sticks, and survives a restart too.
files:
  - packages/quereus/src/schema/constraint-builder.ts       # the three extractColumnLevel* extractors (~133-235) — all now return AST table constraints
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAddColumn (~365-630); revertAddColumn (~633); validateBackfillAgainstChecks (~712)
  - packages/quereus-store/src/common/store-module.ts       # alterAddColumn (~1600) — its duplicate extract-and-persist block is gone
  - packages/quereus/src/index.ts                           # two extractors un-exported (store no longer needs them)
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic   # new section 7
  - packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts  # new: persist → reopen round-trip
  - docs/sql-ddl.md                                         # ADD COLUMN section (~547)
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

### New `runAddColumn` ordering

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

Any failure from step 3 onward goes through the new `revertAddColumn`, which drops the
already-installed CHECK / FK **by name, newest first**, then the column, then un-remaps the
batched events and restores the original catalog entry.

### Two properties the ticket called load-bearing, and where they now live

- **Validation must not see the new constraint.** The optimizer treats a declared constraint
  as a proven invariant and would fold the validating scan to nothing. Preserved: the catalog
  holds the column-only schema for the whole validation window; each module keeps its new
  constraint in its own cached schema until that constraint's own validation passes. The two
  existing engine-bug guards (`41.4` cases 1b and 2m) still pass, and they are the real test
  of this — both are written so a fold makes them silently green-with-a-violating-row.
- **A violation leaves the table exactly as it was.** Preserved and extended: previously only
  the column had to be dropped (constraints lived engine-side); now installed constraints must
  be handed back too, which is what `revertAddColumn` does. New test 7f covers the specific
  interleaving — CHECK installs, FK fails.

### Deliberate user-visible change: FK auto-name

An unnamed inline FK on an added column was named `_fk_<column>`. It is now
`_fk_<table>_<column>` — the same name the `create table` spelling produces (`manager.ts`
column-level arm). This was the ticket's "decide deliberately" item; the two paths agreeing
is the point of the fix. No existing test asserted the old form (checked). An unnamed inline
CHECK keeps `_check_<column>`, which also matches `create table` — that required naming it
explicitly in the extractor, because the module's table-level `ADD CONSTRAINT` convention
would otherwise have renamed it `check_<n>`.

### Deleted duplication

- The engine's `mergedChecks` / `mergedForeignKeys` / `resolvedForeignKeys` merge and its own
  copy of the FK existing-row validation (`validateForeignKeyOverExistingRows` is now called
  only by the modules and the other paths).
- The store module's `alterAddColumn` extract-and-persist block (`persistedSchema`).
- `extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys` dropped from the
  `@quereus/quereus` barrel — engine-internal now, matching the UNIQUE extractor.

## How to exercise it

Memory module and store module both, via `.sqllogic`:

```sql
pragma foreign_keys = true;
create table p (pid integer primary key);
insert into p values (1);
create table t (id integer primary key, junk text null);
insert into t values (1, 'j');

alter table t add column n integer null check (n is null or n > 0);
alter table t drop column junk;          -- the ALTER that used to eat the CHECK
insert into t values (2, -5);            -- must still be rejected: CHECK
select name from check_constraint_info('t');   -- _check_n
```

Same shape with `references p(pid)` + `foreign_key_info('t')`.

New coverage, all of it new-facing rather than restating what already passed:

| where | case |
|---|---|
| `41.4` §7a/7b | inline CHECK survives `drop column` / `rename column`, still enforces, table still writable |
| `41.4` §7c/7d | inline FK survives `drop column` / `rename column`, still enforces |
| `41.4` §7e | auto-names: `_fk_t_nm_fkcol` / `_check_chkcol`, asserted **equal to** what the same `create table` declaration produces; explicit names round-trip |
| `41.4` §7f | rejected add (CHECK installed, FK fails) leaves zero stranded constraints, table byte-identical, satisfied retry then works |
| store spec | inline CHECK + FK survive an unrelated `rename column` **and** a real persist → `rehydrateCatalog` reopen; FK's child-column position still resolves to `fkcol`; both still enforce after reopen |

Commands run, all green:

- `yarn build`
- `yarn test` — 7328 passing in `packages/quereus`, 1049 in `quereus-store` (was 1048), 0 failing anywhere
- `yarn test:store` — 7322 passing, 0 failing
- `yarn lint`, `yarn typecheck` — clean. Also ran `tsc -p tsconfig.test.json --noEmit` inside
  `packages/quereus-store` explicitly (its `typecheck` script does not cover test files) — clean.

## Known gaps — please probe these

**1. The `drop column` cases in §7c/7d drop a *trailing* column on purpose.** Dropping a
column that **precedes** an FK's child column has to renumber the FK's recorded child
position, and neither module does that yet — `foreign_key_info` then raises a raw `TypeError`
(memory) on the dangling index. That is the separate open ticket
`bug-drop-column-leaves-fk-child-index-dangling` (currently in `implement/`), and it affects
every FK regardless of how it was declared. Consequence of *this* ticket: the ADD COLUMN'd FK
is now a real module-owned FK, so it is now exposed to that defect too — where before it
simply vanished. Vanishing silently was worse, but the reviewer should know the exact repro
from the ticket description (`alter table t add column fkcol int references p(pid)` then
`alter table t drop column junk` where `junk` precedes `fkcol`) still fails until that ticket
lands. I deliberately did not fix it here or add a red test for it.

**2. Multiple inline constraints of the same kind on one column.** Two unnamed `references`
clauses on one added column both auto-name to `_fk_<table>_<column>`; the revert path then
drops "both" with one `dropConstraint`, which happens to be the right end state. `create
table` has the identical collision today, so this is pre-existing engine-wide naming
behavior, not something the reroute introduced — but it is untested in either path and worth
a look.

**3. `revertAddColumn` is best-effort on the module half.** A `dropConstraint` /
`dropColumn` failure during revert is logged, never thrown, so it cannot mask the original
violation — but it means a module that fails mid-revert (e.g. memory's
`ensureSchemaChangeSafety` raising `BUSY`) leaves the module's cached schema inconsistent with
the restored catalog entry. That matches the pre-existing contract of the old revert path; no
test drives a failing revert.

**4. Doc correction outside the strict ticket scope.** `docs/sql-ddl.md` claimed a per-row
(expression) DEFAULT combined with a CHECK on the new column "is not yet supported". That has
been false since the per-row CHECK hook landed (`planner/building/alter-table.ts` compiles the
predicates whenever a backfill is present). I rewrote that bullet along with the inline-constraint
paragraph rather than leave a known-false sentence in the paragraph I was editing. Worth a
second pair of eyes on the accuracy of the replacement text — and note there is still **no
`.sqllogic` case** for per-row DEFAULT + CHECK together, in either direction.

**5. Not verified: the isolation module.** `quereus-isolation` forwards `alterTable` to its
underlying module and does no constraint arithmetic, so it should need nothing — but the extra
`addConstraint` round-trips per ADD COLUMN now pass through it, and I only reasoned about that
rather than testing it.

## Tripwire parked

- One module round-trip per inline constraint, each taking the schema-change latch and (store)
  rewriting the table's DDL. Fine at the counts SQL produces; noted as a `NOTE:` at the loop
  in `runAddColumn` with the remedy (batch the set into one call) if a batched `addConstraint`
  arm ever appears or ADD COLUMN becomes hot.
