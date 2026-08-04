---
description: A table whose computed column's formula spells a sibling column with the table name in front of it (mytable.price instead of price) is created without complaint, but every insert into it then fails — leaving a table that can never hold a row.
files:
  - packages/quereus/src/planner/building/insert.ts        # createGeneratedColumnProjection (~line 224) — registers bare column names only
  - packages/quereus/src/planner/building/alter-table.ts   # ~line 295-330 — the ADD COLUMN backfill build, fails the same way
  - packages/quereus/src/planner/building/update.ts        # ~line 150-240 — the UPDATE path, which DOES accept the qualified form
  - packages/quereus/src/schema/table.ts                   # extractGeneratedColumnDependencies — the CREATE-time check that lets it through
repro: verified
difficulty: easy
---

# A generated column that qualifies its own table's column can never be written

## What goes wrong

`create table` accepts a `generated always as (…)` expression that refers to a sibling column
with the table name spelled in front of it. Every subsequent `insert` into that table fails,
so the table can never hold a row:

```sql
create table z (
  id integer primary key,
  a  integer,
  g  integer generated always as (z.a * 2) stored
);
-- accepted

insert into z (id, a) values (1, 1);
-- Error: z.a isn't a column
```

`alter table z add column h integer generated always as (z.a + 1)` fails identically.

Removing the `z.` prefix makes everything work. Nothing warns the author at declaration time,
and the error, when it finally arrives, names a column that plainly exists and points at the
insert rather than at the declaration.

## Why it happens

Three different code paths build a generated column's expression, and they do not agree on
which names are in scope:

| path | own-table-qualified `t.c` |
|---|---|
| `CREATE TABLE` / `ALTER TABLE` declaration-time dependency check | accepted |
| `UPDATE` recompute (`planner/building/update.ts`) | accepted |
| `on conflict … do update` recompute (`planner/building/insert.ts`) | accepted |
| **`INSERT` computation** (`createGeneratedColumnProjection`, `planner/building/insert.ts`) | **rejected** |
| **`ALTER TABLE ADD COLUMN` backfill** (`planner/building/alter-table.ts`) | **rejected** |

The two rejecting paths register only the bare column name in the scope they build for the
expression; the accepting ones register the qualified form as well (or get it from an aliased
scope). So the declaration check and the write paths disagree about what a valid generated
expression looks like.

## Expected behaviour

One rule, applied everywhere. `t.c` inside a generated column expression on table `t` means
the same thing as bare `c` — the row's own value — and should resolve on every path: CREATE,
INSERT, UPDATE, `on conflict … do update`, and the ADD COLUMN backfill.

(The alternative — rejecting the qualified form at declaration time — would be worse: the
qualified spelling is the documented workaround for the *other-table* case described in
`bug-generated-column-subquery-column-refs-misread`, so authors are actively steered toward
qualifying names inside these expressions.)

Whichever way it lands, a table that `create table` accepts must be insertable.

## Use cases to exercise

- `create table` + `insert` + `update` + `on conflict … do update` on a generated column
  written with its own table's qualifier, all producing the same values as the bare spelling.
- A generated column chained off another generated column, one of them qualified.
- `alter table … add column … generated always as (t.c …)` backfilling an already-populated
  table.
- Schema-qualified spelling (`main.t.c`), which today's accepting paths do not register
  either — decide and pin whether it resolves or is a clean declaration-time error.
- A genuinely unknown qualified name (`nosuch.c`) must still be an error, and preferably one
  raised at declaration time rather than at first write.

## Found by

Review of `bug-upsert-do-update-ignores-generated-columns`, while writing a test that used the
qualified spelling to exercise that ticket's new recompute scope. The upsert path handled it;
the INSERT that set up the test did not.
