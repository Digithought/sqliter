---
description: A column whose default value is computed from another column stops working the moment that other column is renamed or removed, and the table can no longer accept new rows.
prereq: bug-check-constraint-new-old-qualifier-invisible-to-column-rename
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # rewriteTableForColumnRename (~2318) — rewrites checks, FKs, index predicates; has no columns/defaults loop
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # the three DROP COLUMN guards; none covers a column default
  - packages/quereus/src/schema/table.ts                            # columnDefToSchema — stores the DEFAULT expression as ColumnSchema.defaultValue
  - packages/quereus/src/schema/rename-rewriter.ts                  # renameColumnInCheckExpression — the seeded walk a default rewrite would reuse
  - docs/sql-ddl.md                                                 # §  documents `default (new.<column>)` as the supported spelling
repro: verified
difficulty: medium
---

# A column DEFAULT written with `new.` survives a rename or drop of the column it reads

## What is broken

A column's DEFAULT may read another column of the row being inserted, using the reserved
`new.` row prefix. `docs/sql-ddl.md` documents this as the supported spelling — a *bare*
column reference in a DEFAULT is rejected outright at `CREATE TABLE`, so `new.<column>` is
the only way to write it.

Neither `ALTER TABLE … RENAME COLUMN` nor `ALTER TABLE … DROP COLUMN` sees a column named
that way. Both operations succeed, and the table can no longer accept a row that lets the
default apply.

Verified in-process at `e4217a2f` (memory module):

```
create table D (id integer primary key, a integer, b integer default (new.a + 1))
   -> OK
insert into D (id, a) values (1, 5)
   -> OK
alter table D rename column a to z
   -> OK                                  <- default not rewritten
insert into D (id, z) values (2, 7)
   -> ERR: new.a isn't a column

create table D2 (id integer primary key, a integer, b integer default (new.a + 1))
alter table D2 drop column a
   -> OK                                  <- should be refused
insert into D2 (id) values (3)
   -> ERR: new.a isn't a column
```

## Why this is not the CHECK-constraint ticket

The symptom and the spelling match
`bug-check-constraint-new-old-qualifier-invisible-to-column-rename`, but the code site is
different, so the two cannot be one fix:

- That ticket's site is the qualifier decision inside the rename walk. Once it lands, the
  walk *can* recognise `new.<col>` in an expression evaluated against a row image.
- This ticket's site is that nothing ever hands a column DEFAULT to that walk.
  `rewriteTableForColumnRename` (`alter-table.ts` ~2318) loops over `checkConstraints`,
  `foreignKeys`, and `indexes` — there is no loop over `table.columns` and their
  `defaultValue` expressions at all. And `drop-column-guards.ts` has three guards (own
  CHECK, assertion body, referencing foreign key) — none of them looks at a default.

So a default is missed for *every* spelling the walk could ever recognise, not just this
one; `new.` is simply the only spelling a default is allowed to use, which is why the gap
shows up here.

## Expected behavior

- `alter table T rename column a to z` rewrites `new.a` → `new.z` inside every column
  DEFAULT expression on `T`, so the default keeps evaluating.
- `alter table T drop column a` is **refused** with `StatusCode.CONSTRAINT`, naming the
  column whose default reads the dropped one — matching the policy the existing
  expression-dependent guards already chose (a DEFAULT is arbitrary user-authored logic
  with no narrowed form, so refuse rather than silently delete).
- Case folding (`NEW.A`) and the shadowing edge (a real table literally named `new`
  reachable from a subquery inside the default) behave exactly as the CHECK arm does —
  reuse the same walk rather than adding a second rule.

## What the fix stage still has to settle

- Whether the rewrite belongs in `rewriteTableForColumnRename` alone, or also needs an arm
  in the memory module (`vtab/memory/layer/manager.ts`) and the store module
  (`quereus-store/src/common/store-module-alter.ts`) — both of those rewrite CHECK
  expressions and index predicates from inside their own `alterTable` hook, because each
  must act before the engine pass regains control (the store persists its DDL bundle).
  A default very likely needs the same treatment on the store leg; confirm by reopening a
  store-backed database after a rename.
- Whether `ALTER TABLE … ALTER COLUMN … SET DEFAULT` has a parallel gap.
- Whether a generated column's expression is already covered (it resolves dependencies by
  column index, not by walking the AST, so it probably is) or shares this site.
- Which guard order the new drop-column refusal takes among the existing ones, and what
  the message reads like — the existing guards quote the constraint name or its
  expression.
