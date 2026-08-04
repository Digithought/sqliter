---
description: A query that only summarizes (e.g. counts rows) and then asks to sort by the summary's own column name fails with "Column not found" instead of returning the single row.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the aggregate phase; decides pre- vs post-aggregate sort
  - packages/quereus/src/planner/building/select.ts              # only the GROUPED branch exposes a projection scope to ORDER BY
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # nearest existing aggregate coverage
repro: verified
---

# `select count(*) as c from t order by c` fails with "Column not found: c"

## What happens

An aggregate query with **no** `GROUP BY` produces exactly one row. Sorting it is
a no-op, but naming one of its own output columns in `ORDER BY` is legal SQL and
SQLite returns the row. Quereus errors:

```sql
create table g (id integer primary key, a text, b text);
insert into g values (1,'p','1'), (2,'p','2'), (3,'q','1');

select count(*) as c from g order by c;
-- QuereusError: Column not found: c
```

Verified by hand at the current HEAD via a scratch mocha spec.

The equivalent expression form works:

```sql
select count(*) as c from g order by count(*);   -- returns {"c":3}
```

and so does the same shape once a `GROUP BY` is present:

```sql
select a, count(*) as c from g group by a order by c;   -- fine
```

So it is specifically the *ungrouped* aggregate query that cannot see its own
select-list aliases from `ORDER BY`.

## Why it looks the way it does

Only the grouped branch of the select builder hands `ORDER BY` a scope over the
final projection's output columns (that is what makes `order by c` work with a
`GROUP BY`). The ungrouped-aggregate branch never builds that scope, so the alias
`c` is looked up in the pre-aggregate scope, where it does not exist.

## Expected behavior

- `select count(*) as c from t order by c` returns the single aggregate row.
- The same for any alias in the select list of an ungrouped aggregate query,
  including several of them (`select count(*) as c, max(a) as m from t order by m`).
- `desc`, `nulls first/last`, and multiple keys are accepted and harmless — there
  is only one row.

## Relationship to other tickets

The *positional* form of the same shape (`select count(*) as c from t order by 1`,
which today errors with "Aggregate function count not allowed in this context")
is handled by `implement/bug-order-by-ordinal-resolves-to-shadowing-alias`,
whose fix makes the aggregate-detection pass see through ordinals. That fix does
**not** cover the alias form above — hence this ticket. If it lands first, retest
this repro before starting: the routing change may or may not have moved it.
