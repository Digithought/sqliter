---
description: Adding a column that says "default null" to a table that already has rows quietly leaves those rows blank in a column the engine considers mandatory, and every later row you try to add is then rejected.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # MemoryTableManager.addColumn — the lax gate (~line 1927)
  - packages/quereus-store/src/common/store-module-alter.ts      # StoreModuleBase.alterAddColumn — the stricter gate, for comparison (~line 175)
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAddColumn — the engine-side gate; keys on an EXPLICIT `not null` only
  - packages/quereus/test/optimizer/statistics.spec.ts           # line ~588 relies on the current lax behaviour; will need a one-word edit
difficulty: medium
---

# What happens

By default this engine makes every column mandatory unless you write `null` — the
session option `default_column_nullability` ships as `not_null`, which is the Third
Manifesto stance rather than the SQL-standard one. So in:

```sql
create table t (id integer primary key, name text);
insert into t values (1, 'a');
alter table t add column extra text default null;
```

`extra` is a **mandatory** column. Adding it to a table that already holds a row
should therefore be refused — there is no value to put in that row. Instead the
memory-backed table accepts it and stores NULL:

```
select id, name, extra from t;   -- id=1  name=a  extra=null
select name, "notnull" from table_info('t');
                                 -- id:1  name:1  extra:1   <- extra IS mandatory
insert into t (id, name) values (2, 'b');
                                 -- NOT NULL constraint failed: t.extra
```

So the table ends up holding a row that violates its own declaration, and every
subsequent insert that does not name `extra` is rejected. The user's next move is
almost always confusing: the failing statement is an INSERT, but the mistake was in
an ALTER that reported success.

Verified on `main` at `64d983e6` against a plain memory table — no store, no
transaction, no other constraint involved.

# Why it happens

Three places decide whether an `ADD COLUMN … NOT NULL` has a usable value source for
the rows that already exist, and they disagree:

- `runAddColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`) only looks for
  an **explicit** `not null` in the statement text. The column above gets its
  mandatoriness from the session default, not from the text, so this gate never
  fires.
- `MemoryTableManager.addColumn` uses the column's *resolved* mandatoriness (correct)
  but then asks *which kind of DEFAULT was written* rather than *is there a value to
  write*. `default null` counts as "has a literal default", so the gate steps aside —
  even though the literal in question is NULL.
- `StoreModuleBase.alterAddColumn` (`packages/quereus-store`) asks the right question
  (`notNull && defaultValue === null && !backfillEvaluator`) and, reading the code,
  would reject the same statement. It has never been exercised for this case: the
  store re-run (`yarn test:store`) only re-runs the `.sqllogic` corpus, and the
  statement above lives in a `.spec.ts`.

The result is a real divergence between the two shipped storage modules for the same
SQL, with the memory module on the wrong side of it.

# Expected behaviour

`ALTER TABLE … ADD COLUMN` on a table that already has rows should be **rejected**
whenever the new column is mandatory and nothing supplies a value for those rows —
whether the column is mandatory because the statement says `not null` or because the
session default makes it so, and whether the missing value is "no DEFAULT at all" or
"a DEFAULT that is literally NULL". The rejection must happen before anything is
mutated, as the existing rejections do. On an empty table the same statement stays
legal (there is nothing to backfill), which is what SQLite does too.

`add column … null default null` must keep working: the column is optional there, so
NULL is a legitimate value for the existing rows.

Both storage modules must agree, and the engine-side gate should stop keying on the
statement text alone.

# Scope notes for whoever picks this up

- This surfaced while fixing `bug-add-column-generated-never-backfilled`, which
  touched the same memory gate. That fix deliberately left this behaviour alone —
  tightening it changes which DDL the engine accepts, which is a user-visible call
  that deserves its own change. A `NOTE:` at the gate points here.
- `packages/quereus/test/optimizer/statistics.spec.ts` (~line 588) does
  `ALTER TABLE frozen_test ADD COLUMN extra TEXT DEFAULT null` on a 15-row table
  purely as a way to produce a frozen schema for an ANALYZE test. It is not
  testing this behaviour; spelling the column `extra TEXT NULL DEFAULT null` keeps
  its intent and makes it legal under the tightened rule.
- Worth checking at the same time whether `alter table … alter column … set not null`
  and the declarative `apply schema` route have the same statement-text-only blindness
  to the session nullability default.
