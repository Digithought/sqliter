---
description: A table rule written using the "new." or "old." row prefix is invisible to both renaming and dropping a column, so either operation is allowed and afterwards the table can no longer be written to at all.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                  # visitColumnRename, `column` case (~line 1051) — the one site that decides what a column qualifier resolves to
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # assertNoCheckConstraintNamesColumn — inherits the miss as a false accept
  - packages/quereus/src/runtime/emit/alter-table.ts                # runRenameColumn / propagateColumnRename — inherits it as a missed rewrite
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # DROP COLUMN vs. CHECK coverage
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic                  # RENAME COLUMN propagation coverage
  - docs/sql-ddl.md                                                 # § CHECK Constraints documents the new./old. spelling
repro: verified
difficulty: medium
---

# A CHECK written with `new.` / `old.` is invisible to column rename and column drop

## What is broken

A CHECK constraint may name the row being written explicitly, using the reserved `new.` and
`old.` prefixes. `docs/sql-ddl.md` documents this as a supported spelling:

> Unqualified columns name the NEW row (the OLD row for DELETE-only checks); `old.<col>` /
> `new.<col>` reference either row image explicitly.

Neither `ALTER TABLE … RENAME COLUMN` nor `ALTER TABLE … DROP COLUMN` sees a column named that
way. Both operations succeed, and the table is unwritable afterwards.

Verified in-process at commit `1bde504c`:

```sql
-- DROP COLUMN
create table NQ (id integer primary key, a integer, b integer,
                 constraint chk_new check (new.a > 0));
insert into NQ values (1, 5, 6);        -- ok
insert into NQ values (2, -1, 6);       -- CHECK constraint failed: chk_new   (the rule works)
alter table NQ drop column a;           -- ACCEPTED — should be refused
insert into NQ values (3, 7);           -- new.a isn't a column   ← table now unwritable

-- RENAME COLUMN, same root cause
create table RQ (id integer primary key, a integer, constraint chk_r check (new.a > 0));
alter table RQ rename column a to z;    -- accepted, CHECK not rewritten
insert into RQ values (1, 5);           -- new.a isn't a column

-- `old.` in a DELETE-only check fails the same way
create table OQ (id integer primary key, a integer, b integer,
                 constraint chk_old check on delete (old.a > 0));
insert into OQ values (1, 5, 6);
alter table OQ drop column a;           -- ACCEPTED
delete from OQ where id = 1;            -- old.a isn't a column
```

The unqualified spelling of the same rule (`check (a > 0)`) is handled correctly by both
operations — only the explicitly-qualified form is missed.

## Why one root cause covers both operations

`visitColumnRename` in `packages/quereus/src/schema/rename-rewriter.ts` decides whether a
qualified column reference belongs to the table under consideration by resolving the qualifier
against the FROM scopes it has descended — a real table name, or an alias bound by a FROM
clause. `new` and `old` are neither: they are a reserved namespace for the row being written,
which never appears in a FROM clause. The walk therefore concludes the reference is not this
table's and leaves it alone.

That single decision drives both symptoms, because the DROP COLUMN guard added in
`drop-column-guard-check-and-assertion-dependents` is *defined* as "refuse exactly what a
rename would have rewritten" — it runs the same walk. Fixing the walk fixes the rename
propagation and the drop refusal together; fixing either one alone would break that
equivalence.

The same file already contains a narrow precedent for treating `new.` as its own namespace:
`renameNewQualifiedRefs` rewrites `new.<col>` references inside a view's `with inverse`
assignments, on the reasoning that the `new.` qualifier alone decides, since no FROM source
legitimately shadows it. That reasoning applies to a CHECK expression too; it is simply not
wired into the CHECK path.

## Expected behavior

- `alter table T drop column a` is **refused** with `StatusCode.CONSTRAINT`, naming the
  constraint, when any CHECK on `T` names `a` as `new.a` or `old.a` — identically to how the
  unqualified `check (a > 0)` is refused today.
- `alter table T rename column a to z` **rewrites** `new.a` → `new.z` and `old.a` → `old.z`
  inside `T`'s own CHECK expressions, so the constraint keeps enforcing after the rename.
- A `new.` / `old.` reference inside a CHECK on a *different* table is not this table's row
  image and must not be matched — the qualifier is scoped to the constraint's own table.
- Both spellings fold case (`NEW.A`), like every other identifier in the engine.

## Scope notes

- Partial-index predicates cannot use `new.` / `old.` (they describe stored rows, not a row
  being written), so the partial-index guard is unaffected.
- Assertion bodies are ordinary SELECT statements with no row image, so the assertion arm of
  the DROP COLUMN guard is unaffected.
- A generated column's expression cannot use `new.` / `old.` either; that guard resolves
  dependencies by column index, not by walking the AST, so it already catches every spelling.
- Out of scope: the CHECK-on-another-table gap (`bug-drop-column-skips-check-on-another-table`)
  and the cross-schema gap (`bug-rename-not-propagated-across-schemas`) are separate arms with
  their own tickets; this one is only about the qualifier the walk fails to recognize.
