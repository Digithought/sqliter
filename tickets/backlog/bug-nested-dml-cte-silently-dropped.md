---
description: A named block that inserts, updates or deletes rows does nothing — and reports nothing — when it sits inside a sub-query or a saved view instead of at the start of a statement. The write silently disappears.
files:
  - packages/quereus/src/planner/building/with.ts     # buildCommonTableExpr — where any `with` member is built
  - packages/quereus/src/planner/building/block.ts    # attachUnreferencedDmlCtes — the top-level guarantee, for contrast
  - packages/quereus/src/planner/building/create-view.ts  # view body accepted with a writing member in it
  - packages/quereus/src/planner/building/select.ts   # sub-select / scalar-subquery `with` clause build
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The shapes are unusual (PostgreSQL rejects all of them outright), and choosing between "reject with an error" and "run the write" is a semantics call a maintainer may want to make deliberately rather than under a bug fix.
---

# A writing `with` block outside the top of a statement is silently ignored

## What happens

A `with` block whose body is an `insert` / `update` / `delete` performs its write when the
block sits at the start of a top-level statement — that is now guaranteed whether or not
anything reads the block. Move the same clause anywhere else and the write silently
vanishes: no rows written, no error, the query returns its normal answer.

Verified against the current build:

```sql
create table t (k integer primary key);

-- inside a FROM sub-query: no write, no error
select * from (with c as (insert into t (k) values (1) returning k) select 42 as x) z;
-- → [{"x":42}]   and t stays empty

-- inside a scalar sub-query: same
select (with c as (insert into t (k) values (1) returning k) select 42) as x;
-- → [{"x":42}]   and t stays empty

-- stored in a view body: `create view` accepts it, selecting from the view never writes
create view v as with c as (insert into t (k) values (1) returning k) select 42 as x;
select * from v;
-- → [{"x":42}]   and t stays empty
```

The top-level equivalent (`with c as (insert into t (k) values (1) returning k) select 42
as x`) does write — see `test/logic/13.11-unreferenced-dml-cte.sqllogic`.

A `values` main statement is the one shape already handled well: the parser rejects it
with `WITH clause cannot be used with values statement`. That loud rejection is the model
the other positions should follow.

## Why it matters

A silently skipped write is the worst failure mode a database has: the caller has no
signal, and the missing rows surface much later as inexplicably absent data. This is
exactly the defect that was just fixed for the top-level position; the same defect still
exists one nesting level down, and a user has no way to know the position matters.

The stored-view case is the sharpest: the write is accepted at `create view` time, so the
definition looks supported, and it is then dead forever.

## Expected behaviour

Pick one and apply it consistently at every position:

- **Reject at build time (recommended).** PostgreSQL refuses a data-modifying `with`
  member anywhere except a statement's top level; matching that gives the user a clear
  error naming the offending block, and needs no new runtime machinery. `create view`
  must reject it too, at definition time.
- **Or run it**, on the same terms as the top-level guarantee (exactly once per statement
  execution). This is a bigger commitment: a sub-query can be evaluated once per outer
  row, so "once per execution" has to be defined before it can be implemented — and the
  correlated case is already a known open gap (`docs/runtime-caching.md`, correlated
  data-modifying CTE).

Whichever is chosen, "accepted and silently dropped" must stop being one of the options.

## Where the cause lives

There is one decision that is missing rather than wrong: nothing anywhere records **where**
a `with` member is being built, so no builder can tell a top-level clause from a nested
one. `buildCommonTableExpr` (`planner/building/with.ts`) builds every member the same way
regardless of position, and the write guarantee lives entirely in
`attachUnreferencedDmlCtes` (`planner/building/block.ts`), which by construction only sees
top-level statements. Every nested position — FROM sub-query, scalar sub-query, stored view
body — falls through with no owner.

The fix belongs at that seam: make the position part of what a member is built with (a
build-context flag or an explicit argument), then have `buildCommonTableExpr` reject a
data-modifying member built outside a top-level clause. That single check covers all three
shapes above and any new nesting position added later, instead of one patch per position.
