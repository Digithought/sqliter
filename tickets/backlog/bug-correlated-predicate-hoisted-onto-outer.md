---
description: Adding an ORDER BY to a query whose EXISTS subquery compares columns of different types makes the query fail with a "no row context" error; without the ORDER BY the same query returns the right rows.
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/src/planner/building/expression.ts   # insertCrossTypeCoercion — why the predicate takes the non-equi shape
difficulty: medium
---

# A correlated subquery's predicate is copied onto the outer relation

## Repro

```sql
create table a (id integer primary key, i integer) using memory;
create table t (id integer primary key, s text)    using memory;
insert into a values (1, 1), (2, 2), (3, 3);
insert into t values (1, '1'), (2, '2');

-- works, returns {1, 2}
select a.id from a where exists (select 1 from t where t.s = a.i);

-- same query plus ORDER BY: fails
select a.id from a where exists (select 1 from t where t.s = a.i) order by a.id;
-- Error: No row context found for column s. The column reference must be evaluated
--        within the context of its source relation.
```

## What the plan shows

```
PROJECT  SELECT a.id
  FILTER  WHERE exists (select 1 from t where t.s = a.i)
    FILTER  WHERE t.s = a.i            <-- the subquery's predicate, sitting over `a`
      INDEXSCAN a
      BINARYOP  cast(null as integer) = a.i
        CAST  CAST(t.s AS INTEGER)
        COLUMNREFERENCE  i
    EXISTS (subquery)
      PROJECT SELECT 1
        FILTER  WHERE t.s = a.i        <-- and still in its correct place too
          INDEXSCAN t
```

The subquery's inner predicate `t.s = a.i` has been **copied onto the outer scan of `a`**,
which has no column `s` — hence the runtime error. The copy in its original position is
still correct; the query would run fine if the duplicate were simply not there.

## Conditions that produce it

- The correlated predicate must fail the decorrelation rule's equi-correlation shape test.
  Here the planner inserts a cross-type coercion (`cast(t.s as integer) = a.i`) because one
  side is TEXT and the other INTEGER, so `isEquiCorrelation` does not recognise it and
  `ruleSubqueryDecorrelation` declines. The same query with matching column types
  (`t.id = a.i`) decorrelates into a semi join and works.
- An `ORDER BY` must be present. Without it the predicate is not copied and the query runs.

So the trigger is roughly: *a correlated conjunct the decorrelation rule declines, plus
whatever plan restructuring the ORDER BY introduces.* Predicate pushdown is the most likely
owner — it must not push or copy a conjunct that references attributes the target relation
does not expose.

## Expected behavior

Both queries return `{1, 2}` — cross-type comparison semantics are not at issue here (the
no-`ORDER BY` form already gets them right). No rule may place a predicate over a relation
that does not define the columns it reads.

## Notes

- Found while planning `feat-uncorrelated-in-semijoin`; unrelated to that ticket's changes
  and not caused by them (reproduces at HEAD with no local modifications).
- The `cast(null as integer)` text in the `BINARYOP` detail line is a separate oddity — the
  node's rendered detail shows a folded NULL while its child `CAST` node over `t.s` is
  intact. Worth confirming whether that is only a formatting artifact or evidence that
  something const-folded a column-dependent CAST.
