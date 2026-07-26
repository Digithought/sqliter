---
description: A CHECK or foreign-key rule written inline when adding a column works at first, but silently disappears the next time any column on that table is dropped or renamed — after which bad data is accepted with no error.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAddColumn (~428-693) — the engine-only merge; runDropColumn (~815); runRenameColumn
  - packages/quereus/src/schema/constraint-builder.ts       # extractColumnLevel{Check,ForeignKey,Unique}Constraints (~141, ~165, ~214)
  - packages/quereus/src/vtab/memory/layer/manager.ts       # addConstraint (~2960) + addCheckConstraint (~3018) / addForeignKeyConstraint (~3119) — the arms to route into
  - packages/quereus-store/src/common/store-module.ts       # store's addConstraint arm — persists the DDL
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
  - docs/sql-ddl.md                                         # ADD COLUMN section (~561) claims these are enforced like the inline UNIQUE
difficulty: medium
---

# ADD COLUMN's inline CHECK / FOREIGN KEY never reach the table's module

## What happens

```sql
create table p (pid integer primary key);
create table t (id integer primary key, junk text);
insert into p values (1);

alter table t add column fkcol integer references p(pid);
insert into t values (1, 'j', 999);   -- correctly rejected

alter table t drop column junk;       -- unrelated column
insert into t values (2, 999);        -- ACCEPTED — the foreign key is gone
```

After the drop, `foreign_key_info('t')` returns nothing. The same happens with an inline CHECK:

```sql
alter table t add column n integer check (n > 0);
alter table t drop column junk;
insert into t values (1, -5);         -- ACCEPTED — the CHECK is gone
```

and with `alter table … rename column` in place of the drop. Confirmed at `4a3e92d7` under the
memory module; the mechanism is engine-level, so the store module is affected identically.

A foreign key or CHECK declared in `create table` is **not** affected — it survives, because the
module holds it.

## Why

`ALTER TABLE ADD COLUMN` with an inline column-level constraint has three routes today, and only
one of them is complete:

- **UNIQUE** is converted into the equivalent table-level constraint and handed to the module via
  `module.alterTable({ type: 'addConstraint', … })` — the same path `ALTER TABLE ADD CONSTRAINT`
  uses. The module owns it from then on, and (store) persists it.
- **CHECK and FOREIGN KEY** are built directly into schema objects and merged into the *engine
  catalog copy* of the table schema only (`mergedChecks` / `mergedForeignKeys` →
  `enhancedTableSchema` → `schema.addTable`). The module is never told.

Every later structural ALTER asks the module for the new table schema and installs the module's
answer in the catalog verbatim. The module's answer has never heard of these constraints, so they
are dropped on the floor. Nothing logs, nothing errors.

Both module implementations already support the constraint kinds needed
(`MemoryTableManager.addForeignKeyConstraint` / `addCheckConstraint`, and the store's equivalent
arm) — the engine simply does not call them.

## Required behavior

An inline CHECK or `REFERENCES` on an added column must end up **inside the module's schema**, so
it behaves exactly like the same constraint written in `create table`: it survives every
subsequent ALTER, and a store-backed table still has it after a reconnect.

Validation semantics must not regress. Two properties in the current code are load-bearing and
easy to break while reordering:

- **Existing rows are validated before the constraint goes live.** A new foreign key is checked
  against the rows already in the table (gated by `pragma foreign_keys`, MATCH SIMPLE), and an
  inline CHECK on a literal-DEFAULT backfill is checked against the backfilled values. A violation
  drops the just-added column again and restores the original catalog entry — the table must be
  left exactly as it was.
- **The catalog must not yet contain the constraint while its own validation runs.** The optimizer
  treats a declared constraint as a proven invariant and will fold the validating scan away to
  nothing, which makes validation trust the very thing it is checking and admit a violating row.
  The current code sidesteps this by registering an intermediate schema without the new
  constraints (`validationSchema`); any new ordering has to preserve that property. Note that
  the module's own foreign-key validation reads the *live catalog* for planning, so the added
  column has to be in the catalog before the module's `addConstraint` call, while the new
  constraint must not be.

A workable order, if it holds up in implementation: materialize the column in the module →
register the column-only schema in the catalog → run the collation and backfill-CHECK
pre-validations → hand each inline UNIQUE / CHECK / FOREIGN KEY to `module.alterTable(addConstraint)`
(the foreign-key arm does its own existing-row scan) → register the module's final schema. Any
failure from the register point onward takes the existing revert path. This also removes the
engine's duplicate copy of the foreign-key existing-row validation.

## Known side effect to decide on

The engine's own naming for an unnamed inline foreign key is `_fk_<column>`; the module's
(`create table`) naming is `_fk_<table>_<column>`. Routing through the module changes the
auto-generated name that `foreign_key_info` reports for this path. That is arguably the fix — the
two paths should agree — but it is user-visible, so make the choice deliberately and cover it with
a test. Check whether any existing test asserts the `_fk_<column>` form before changing it.

## Testing

`41.4-alter-add-column-constraints.sqllogic` already covers the immediate enforcement; extend it
(or add a sibling) with the survival cases: add the column with an inline CHECK / `REFERENCES`,
then perform an unrelated `drop column` and an unrelated `rename column`, and assert via
`foreign_key_info` / real violating writes that the constraint still enforces. `.sqllogic` means
the store module gets the same coverage under `yarn test:store`, which also exercises the
persistence half.

## TODO

- Add AST-level extractors for inline CHECK and FOREIGN KEY mirroring
  `extractColumnLevelUniqueConstraints` (which returns `AST.TableConstraint`), so all three inline
  kinds can go through the one `addConstraint` call site.
- Rework `runAddColumn`'s ordering per the sketch above; verify the fold-avoidance property still
  holds (a violating existing row must still be caught — assert it with a test, not by reading).
- Delete the now-duplicated engine-side merge (`mergedChecks` / `mergedForeignKeys`,
  `resolvedForeignKeys`) and its parallel validation, once the module owns the constraints.
- Confirm the revert-on-violation path still leaves the table byte-identical (column gone,
  original catalog entry restored, batched events remapped).
- Decide and test the auto-generated foreign-key name change.
- Add the survival coverage described above.
- Update the `ADD COLUMN` paragraph in `docs/sql-ddl.md` — it currently says the inline CHECK / FK
  are "likewise enforced" without noting the path difference; after this change they genuinely
  take the same module path as the inline UNIQUE, so the sentence should say so plainly.
- `yarn test`, `yarn test:store`, `yarn lint`.
