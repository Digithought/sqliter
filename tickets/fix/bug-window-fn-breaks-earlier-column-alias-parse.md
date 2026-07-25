---
description: In a SELECT that uses a window function (like row_number()), giving an earlier column a short alias without the word "as" makes the query fail to parse.
files: packages/quereus/src/parser/parser.ts
---

# Window function in SELECT list breaks bare (no-`as`) alias on an earlier column

## What happens

When a `select` list contains a window function (`… over (…)`) **and** an
earlier column in the same list uses a *bare* alias — an alias written without
the `as` keyword — the parser rejects the whole statement. The error points at
the earlier alias, not at the window function:

```
Expected statement type (SELECT, INSERT, UPDATE, DELETE, VALUES, CREATE, etc.), got 'cnt'.
```

## Minimal reproductions (all fail)

```sql
select count(*) cnt, row_number() over (order by o.k) rn from o;   -- errors at 'cnt'
select o.k kk,       row_number() over (order by o.k) rn from o;   -- errors at 'kk'
```

## These succeed (isolating the trigger)

```sql
-- No earlier bare alias → fine (window's own bare alias parses):
select o.k, row_number() over (order by o.k) rn from o;
-- Window aliased with `as` → fine:
select o.k, row_number() over (order by o.k) as rn from o;
-- No window function → bare aliases parse fine:
select count(*) cnt, o.k kk from o group by o.k;
```

So the trigger is specifically: **a bare column alias appearing before a window
function in the SELECT list.** Using `as` on the earlier column, or removing the
window function, both make it parse.

## Why this matters

Bare aliases (`expr name` with no `as`) are standard SQL and work everywhere
else in the engine. A user adding a window function to an existing query can hit
a confusing parse error that blames an unrelated, previously-valid column.

## Notes for the fixer

- Purely a **parser** problem — reproduces at parse time, before planning, with
  no aggregates or subqueries required. The window-clause parse path appears to
  disturb how the preceding select-item's optional bare alias is consumed
  (likely a lookahead/backtracking interaction around `over`).
- Discovered incidentally while reviewing
  `fix/order-by-aggregate-subquery-scope-leak`; **unrelated to that fix** (which
  lives in `planner/building/select.ts`). Pre-existing.
- Add coverage: bare-alias + window-function combinations in the parser spec
  (`packages/quereus/test/parser.spec.ts`) and/or a `.sqllogic` case.
