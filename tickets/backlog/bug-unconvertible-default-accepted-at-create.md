---
description: You can declare a column's default value as something the column's type cannot hold, and the database accepts it without complaint — the error only appears later, when someone inserts a row that relies on that default. Adding a column now catches this immediately, so the two behave inconsistently.
files:
  - packages/quereus/src/schema/table.ts                            # columnDefToSchema — stores the DEFAULT expr unchecked
  - packages/quereus/src/runtime/emit/create-table.ts               # CREATE TABLE path
  - packages/quereus/src/vtab/memory/layer/alter-column.ts          # setDefault / setDataType arms
  - packages/quereus-store/src/common/store-module-alter-column.ts  # setDefault / setDataType arms
  - packages/quereus/src/types/validation.ts                        # foldDefaultToType — the existing fold+convert check
  - docs/sql-ddl.md                                                 # documents the current asymmetry
difficulty: medium
---

# The problem

A column's DEFAULT is an expression stored in the schema. Nothing checks, at the time
the schema is written, that a *literal* DEFAULT is a value the column's declared type
can actually hold. The mismatch only surfaces much later, at the first INSERT that lets
the default apply — potentially long after the schema was written, in a completely
different part of an application, with an error that points at the INSERT rather than
at the schema.

Three DDL statements currently accept such a DEFAULT. All three were confirmed by
running them (memory module, current `main`):

```sql
-- 1. CREATE TABLE: accepted; only the INSERT fails.
create table a (id integer primary key, n integer default 'abc');
insert into a (id) values (1);
--  → Type conversion failed for column 'n': Cannot convert 'abc' to INTEGER

-- 2. ALTER COLUMN ... SET DEFAULT: accepted; only the INSERT fails.
create table b (id integer primary key, n integer default 5);
alter table b alter column n set default 'abc';
insert into b (id) values (1);
--  → Type conversion failed for column 'n': Cannot convert 'abc' to INTEGER

-- 3. ALTER COLUMN ... SET DATA TYPE: retypes the column but never re-checks the
--    DEFAULT it leaves behind. (With rows present the retype fails on the row values,
--    which masks this; on an empty table it goes straight through.)
create table d (id integer primary key, n text null default 'abc');
alter table d alter column n set data type integer;   -- accepted
insert into d (id) values (1);
--  → Type conversion failed for column 'n': Cannot convert 'abc' to INTEGER
```

# Why now

`ALTER TABLE ... ADD COLUMN` and `ALTER COLUMN ... SET NOT NULL` used to be lax the same
way — worse, actually: they stored the unconverted literal into existing rows. That was
fixed (see `tickets/complete/bug-add-column-default-not-coerced.md`), and both now
**reject** an unconvertible literal DEFAULT with `MISMATCH`, whether or not the table
holds rows.

So the engine is now inconsistent: the same bad DEFAULT is refused when it arrives via
`ADD COLUMN` and accepted when it arrives via `CREATE TABLE`, `SET DEFAULT`, or a
`SET DATA TYPE` that retypes out from under it.

# Expected behaviour

All four paths should agree. The intended direction is **making the lax paths strict**,
not loosening the strict ones — the strict behaviour is what stops a backfill from
writing a value no INSERT could ever produce, and it is what makes the error point at
the statement that introduced the problem.

Concretely: a literal DEFAULT (including a signed numeric like `-5`, which is not a bare
literal in the parse tree) that the column's declared type cannot accept should be
rejected at the point the schema is written, with the same `MISMATCH` error and message
text the equivalent INSERT produces. A non-literal DEFAULT — `(new.<col>)`, a function
call — is not checkable up front and stays as it is.

The check itself already exists and is exported: `foldDefaultToType` in
`packages/quereus/src/types/validation.ts`.

# Why this needs a human decision

This is a **behaviour change for existing schemas**, which is why it is filed here rather
than done inline:

- A stored database whose schema already contains an unconvertible DEFAULT would newly
  fail to reopen (schemas are re-parsed on open), unless reopen is deliberately exempted
  from the check. Someone has to decide whether reopen validates, warns, or is silently
  grandfathered.
- SQLite, the compatibility reference, accepts these DEFAULTs. Diverging is defensible
  given the typed-column design, but it is a divergence and should be a deliberate one.
- `SET DATA TYPE` has a third option beyond accept/reject: it could *convert* the stored
  DEFAULT expression to the new type's canonical form the same way it converts each row's
  value, and only reject when that conversion fails. That is arguably the nicest
  behaviour and is worth considering rather than assuming rejection.

# Use cases

- A developer writes `create table t (n integer default 'abc')`, the statement succeeds,
  and the failure lands weeks later on an unrelated INSERT in production. They should
  have been told at `create table`.
- An application adds a column with `add column n integer default '7'` and separately
  creates the same-shaped table from scratch with `create table … n integer default '7'`.
  Both should behave identically; today only the first validates the default eagerly.
- Retyping a column on an empty table (`set data type`) should not be able to leave the
  schema in a state where every future default-bearing INSERT fails.
