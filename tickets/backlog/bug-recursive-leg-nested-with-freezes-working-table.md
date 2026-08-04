---
description: A recursive query whose repeating part wraps its self-reference inside a nested named sub-block never advances — it keeps re-reading the first round's rows and eventually fails with "exceeded maximum iteration limit" instead of producing an answer.
files:
  - packages/quereus/src/runtime/emit/recursive-cte.ts   # driveRecursion — the per-iteration loop
  - packages/quereus/src/runtime/emit/cte.ts             # rctx.cteMaterializations buffer
  - packages/quereus/src/runtime/emit/cache.ts           # rctx.cacheStates buffer
  - packages/quereus/src/runtime/types.ts                # RuntimeContext: cteMaterializations, cacheStates
repro: verified
difficulty: hard
---

# A recursive query's repeating part goes stale when its self-reference sits inside a nested `with` block

## What happens

A `with recursive` query works when the repeating (recursive) part reads the recursion
directly, and still works when that read sits inside a plain sub-select. It **breaks** as
soon as the read is moved inside a *nested* `with` block: the recursion produces the same
row forever and the engine eventually gives up.

```sql
-- works — plain sub-select around the self-reference
with recursive r as (
  select 1 as k
  union all
  select n as k from (select k + 1 as n from r where k < 3) y
) select k from r order by k;
-- → 1, 2, 3

-- broken — identical, but the self-reference is inside a nested `with`
with recursive r as (
  select 1 as k
  union all
  select n as k from (with x as (select k + 1 as n from r where k < 3) select n from x) y
) select k from r order by k;
-- → QuereusError: Recursive CTE 'r' exceeded maximum iteration limit (10000)
```

Adding a `limit` to watch the rows go by shows the recursion is frozen on round one:

```sql
with recursive r as (
  select 1 as k
  union all
  select n as k from (with x as (select k + 1 as n from r) select n from x where n < 4) y
  limit 6
) select k from r;
-- → 1, 2, 2, 2, 2, 2      (expected 1, 2, 3)
```

Verified on a clean checkout at `e558a356`, and again with the
`bug-dml-cte-body-cannot-see-sibling-cte` change reverted — the behaviour is identical
either way, so this is **pre-existing** and not caused by that fix.

Explicit `materialized` and `not materialized` hints on the nested block make no
difference, so whichever buffer is doing the freezing is not selected by that hint.

## Why it matters

A recursive query is one of the few shapes where a wrong answer looks like a hang: the
engine spins for 10,000 rounds before erroring, and the error text points at the recursion
limit rather than at the real cause. A user hitting this has no way to tell that moving one
sub-select into a `with` block is what broke it. Nothing about the query is unusual — a
nested `with` inside a bigger query is ordinary style.

## Where the cause lives

Each round of the recursion re-runs the repeating part by calling `recursiveCaseCallback`
again inside the `while` loop of `driveRecursion`
(`packages/quereus/src/runtime/emit/recursive-cte.ts`). The working table for that round is
swapped in and out around the call, so a *direct* read sees the new round's rows.

What does **not** get swapped is the runtime context's per-execution result buffers, which
live for the whole statement:

- `rctx.cteMaterializations` — one buffered row array per CTE, keyed by table descriptor
  (`emit/cte.ts`), and
- `rctx.cacheStates` — one row cache per `CacheNode` (`emit/cache.ts`).

Anything held in those maps is computed on round one and replayed unchanged on every later
round. A block nested inside the repeating part whose body transitively reads the working
table therefore keeps handing back round one's rows, the recursion's set of new rows never
empties, and the iteration guard trips.

The single site that has to change is `driveRecursion`: the per-execution buffers of any
subtree beneath the repeating part must not survive from one round to the next — either
scoped/cleared around each `recursiveCaseCallback(rctx)` call, or keyed so a round number
is part of the key. Deciding which of the two maps (possibly both) needs it, and whether
scoping can be done without discarding buffers that legitimately belong to the enclosing
statement, is the real work here.

`bug-cache-node-stale-across-statement-executions` (in `tickets/complete/`) fixed the
neighbouring case — the same buffers surviving from one *statement execution* to the next.
Its reasoning about buffer lifetime is the right starting point; this ticket is the
iteration-scoped sibling of it.

## Expected behaviour

Wrapping a self-reference in a nested `with` block should not change the answer. Both forms
above should return 1, 2, 3.

If some shape of nested self-reference genuinely cannot be supported, it must be **rejected
at plan time with a clear message** naming the nested block — never allowed to spin to the
iteration limit. (PostgreSQL takes this route: it refuses a recursive reference that appears
inside a subquery, with "recursive reference to query … must not appear within a subquery".)
