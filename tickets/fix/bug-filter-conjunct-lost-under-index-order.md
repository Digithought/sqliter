description: A query can silently return every row instead of the matching ones — a WHERE condition on a column is dropped when the query also has a sub-select in its WHERE, sorts by the primary key, and does not select the filtered column.
files: packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts, packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts, packages/quereus/src/planner/nodes/retrieve.ts
difficulty: hard

## What happens

A `WHERE` condition on an ordinary column is silently thrown away, so the query
returns **every** row of the table. No error, no warning — just wrong rows.

Self-contained repro (no user-defined functions, memory tables, default settings):

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 0);

-- correct: returns id 3
select id from o where flag = 0 and (select max(id) from o o2) > 0;

-- WRONG: returns ids 1, 2 and 3 — the `flag = 0` condition is gone
select id from o where flag = 0 and (select max(id) from o o2) > 0 order by id;
```

## What it takes to trigger

All four together. Change any one and the query is correct again:

- Two conditions joined by `and` in the `WHERE`, one of them a plain
  column comparison (`flag = 0`).
- The other condition contains a **sub-select** — a scalar subquery
  (`(select max(id) from o o2) > 0`, `(select random()) <> 0`) or an `exists`.
  A plain function call is not enough: `flag = 0 and random() <> 0` is correct,
  because the two conditions get merged into one filter and stay together.
- An `order by` the table's own index already satisfies — `order by id` on the
  primary key breaks it, `order by id desc` does not.
- The filtered column is **not** in the select list. `select id, flag from o …`
  with the same `where` and `order by` returns the right row.

Not affected: `delete from o where …` with the same predicate deletes the
correct row.

## Why it is worth prioritising

This is a silent wrong-answer bug in ordinary single-table SQL — no exotic
feature, no plugin, no user-defined function required. Anything built on top
(views, sync, incremental maintenance) inherits the wrong row set.

## What is known about the cause

The dropped condition disappears in the **planner**, before the runtime ever
sees it. In the broken plan the emitted program contains only one `filter`
instruction (the sub-select one) reading straight from the index scan; the
`filter(flag = 0)` instruction that is present in the working variants is absent
entirely.

Disabling any **one** of these three optimizer rules makes the query correct
again (via `db.optimizer.updateTuning({ ...db.optimizer.tuning, disabledRules:
new Set(['<rule-id>']) })`):

- `grow-retrieve-Filter`
- `grow-retrieve-Sort`
- `predicate-pushdown`

That points at the path where a `Filter` and a `Sort` are both absorbed into the
same `Retrieve` node and the filter is then handed to the virtual table as a
pushed-down constraint: the plan appears to believe the table access applies
`flag = 0`, the memory table does not, and no residual filter is left behind. The
"filtered column is not selected" condition suggests the columns-used set that
travels with the pushdown is involved. Confirm which of the two — a constraint
wrongly marked handled, or a residual predicate dropped when the Retrieve is
rebuilt — before fixing.

## Expected behaviour

Every one of the four variants above returns the same rows as the same query
without the `order by`. A predicate is either genuinely applied by the table
access or left in a residual `Filter`; it is never both absent from the access
and absent from the plan.

## Regression coverage to add

- The repro above, plus the three near-miss variants (`order by id desc`, no
  `order by`, `select id, flag`) so a future change cannot fix one shape and
  leave the others.
- The same shapes with `exists (…)` and with a non-deterministic scalar
  subquery, which reproduce identically.
- `packages/quereus/test/filter-conjunct-early-exit.spec.ts` has a test
  (`a subquery conjunct is skipped for rows an earlier conjunct rejected`) whose
  `order by id` was removed to dodge this bug; restore it once this lands.
