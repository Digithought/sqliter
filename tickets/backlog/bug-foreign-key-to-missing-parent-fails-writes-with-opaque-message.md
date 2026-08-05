---
description: A foreign key that names a table which does not exist is accepted without complaint, and every later insert into that table then fails with a confusing message that never mentions the missing table.
files:
  - packages/quereus/src/planner/building/foreign-key-builder.ts   # buildChildSideFKChecks — the `if (!parentSchema)` null-guard fallback
  - packages/quereus/src/schema/constraint-builder.ts              # referencedSchema: fk.schema ?? childSchemaName — why an unqualified cross-schema reference lands here
repro: verified
---

# A foreign key pointing at a table that isn't there fails writes opaquely

## What happens

Declaring a foreign key whose parent table does not exist is accepted silently. Every
subsequent insert of a non-NULL value into the referencing column then fails, with a
message that names neither the missing parent nor the fact that one is missing:

```sql
create table GhostC (id integer primary key, c integer references NoSuchParent(refd));
insert into GhostC values (1, 5);
-- CHECK constraint failed: _fk_ghostc_c (NEW.c is null or 0)
```

The quoted text is an internally synthesized expression, not anything the user wrote.
There is no way to read "the table `NoSuchParent` does not exist" out of it.

The same failure arrives by a second, much less obvious route: a foreign key that names
its parent **without a schema qualifier binds to the referencing table's own schema**, not
through the usual table-name search order. So a table in an attached schema referencing a
table in `main` compiles to the same permanently-failing constraint:

```sql
declare schema s2 {}
apply schema s2;
create table XP (pid integer primary key, refd integer unique);      -- lands in main
create table s2.xc (id integer primary key, c integer references XP(refd));   -- binds to s2.XP
insert into XP values (1, 100);
insert into s2.xc values (1, 100);
-- CHECK constraint failed: _fk_xc_c (NEW.c is null or 0)
```

Writing `references main.XP(refd)` works. Nothing at create time hints that the
unqualified spelling meant something different.

Both cases verified in-process against `20f7ad08` plus this review's changes.

## Why it happens

When a child-side foreign key check is built, the parent table is looked up, and if it is
not found the check is compiled into a "every foreign key column IS NULL, otherwise false"
expression — correct MATCH SIMPLE semantics for a key that can never match, but with no
user-visible explanation. The only trace is a `log()` line, which is off by default.

The unqualified-cross-schema case reaches the same place because the schema for an
unqualified parent reference is fixed to the child's own schema when the constraint is
built, so the lookup asks the wrong schema and comes back empty.

## Expected behavior

The user needs to be told which table is missing, and ideally when they declare the key
rather than on their first write. Two things to settle:

- **Where to report.** Reporting at `CREATE TABLE` is the clearest, but forward references
  (declaring the child before the parent) are legal today and are how some scripts are
  written, so a create-time error would be a behavior change worth deciding on
  deliberately. Reporting at write time is strictly safer and still a large improvement.
- **What to say.** Whatever the timing, the message should name the parent table that
  could not be found and the constraint that wanted it — e.g. `foreign key '_fk_ghostc_c'
  on 'GhostC' references table 'NoSuchParent', which does not exist`.

Whether an unqualified parent reference *should* resolve through the normal table search
order (finding `main.XP` from a child in `s2`) is a separate question and probably a "no" —
SQLite does not allow foreign keys across databases either. But if it stays a "no", saying
so out loud is exactly what the improved message would do.

## Not a regression

This predates the DROP COLUMN parent-side guard
(`drop-column-guard-referencing-foreign-keys`); that ticket's review pass found it while
confirming the guard resolves parents the same way enforcement does. The guard's behavior
is *consistent* with this: a key whose parent cannot be resolved constrains nothing, so it
blocks no drop — pinned by § 11 of
`packages/quereus/test/logic/41.10.3-alter-drop-column-referencing-fk.sqllogic`.
