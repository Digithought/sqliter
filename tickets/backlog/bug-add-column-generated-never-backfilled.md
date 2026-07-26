---
description: Adding a computed column to a table that already has rows leaves every one of those rows blank in the new column forever, even though rows inserted afterwards compute it correctly.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts       # runAddColumn — builds a backfill only from a DEFAULT, never from a generated expression
  - packages/quereus/src/planner/building/alter-table.ts   # buildAddColumnBackfill — same
  - packages/quereus/src/schema/table.ts                   # withGeneratedColumnGraph — the generated-column dependency bookkeeping
difficulty: medium
---

# What happens

A **computed column** — one declared `generated always as (<expression>)` — normally
holds the value of its expression for every row. Declaring one in `create table` works;
so does inserting a new row after the fact. But adding one to a table that already has
rows leaves those pre-existing rows holding NULL, permanently. Nothing reports an error.

Reproduced on a plain memory table (no store, no transaction, no constraints involved):

```sql
-- the working case: declared up front
create table ct (id integer primary key, v integer, g integer null generated always as (v * 2));
insert into ct (id, v) values (1, 5);
select * from ct;              -- id=1  v=5  g=10   ✔

-- the broken case: added later
create table at (id integer primary key, v integer);
insert into at values (1, 5);
alter table at add column g integer null generated always as (v * 2);
select * from at;              -- id=1  v=5  g=null ✘   (should be 10)

insert into at (id, v) values (2, 7);
select * from at order by id;  -- id=1 g=null, id=2 g=14  ✘ two rows, two rules
```

# Why it matters

The table ends up holding two populations of rows that disagree about what the column
means: rows that predate the `ALTER` say NULL, rows added after say the computed value.
Anything that filters, aggregates, joins, or indexes on the column silently reads the
wrong answer for the older rows — and there is no error, no warning, and no way to tell
the two populations apart other than by knowing when each row was written. Re-running
the same schema definition does not repair it either, since the column already exists.

# Expected

Adding a computed column should compute it for the rows already in the table, so that
afterwards the column's value is a pure function of the row — identical to what the
same declaration written in `create table` would have produced, and identical to what a
fresh insert produces. Whatever a re-computation cannot honour (an expression that
cannot be evaluated against an existing row, say) should reject the `ALTER` rather than
leave the table half-populated.

# Notes

- Found while reviewing `add-column-inline-check-fk-never-reach-module`; **independent
  of it** — it reproduces with no constraint on the added column at all, and nothing in
  that change touches how a value is computed for the new column.
- The engine already has the machinery: `ALTER TABLE ADD COLUMN` with a per-row
  (expression) `DEFAULT` backfills each existing row through a per-row evaluator handed
  to the module. A generated expression simply never reaches that path — only a
  `DEFAULT` does.
- Worth deciding at the same time what a *virtual* (non-stored) computed column should
  do here, if the engine distinguishes the two, and whether the same gap exists for
  `ALTER TABLE ALTER COLUMN` turning an existing column into a computed one.
