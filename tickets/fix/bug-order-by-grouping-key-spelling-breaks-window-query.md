---
description: A summary query that also uses a window function fails with a confusing internal error if its ORDER BY names one of the summary's own grouping columns with a table name in front of it, or repeats a computed grouping expression.
files:
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — builds sort keys against ShadowScope([projectionScope, selectContext.scope])
  - packages/quereus/src/planner/building/select.ts               # where applyOrderBy is called, and where groupedRedirectContext already lives (~line 245)
  - packages/quereus/src/planner/building/select-aggregates.ts    # redirectToGroupKeys / GroupedRedirectContext — the rewrite the SELECT list and window phase already use
  - packages/quereus/src/runtime/emit/window.ts                   # the buffered path that removes the representative source row
  - packages/quereus/test/logic/07.5-window.sqllogic              # where the coverage belongs; the passing ORDER BY spellings are already pinned there with a pointer to this ticket
difficulty: medium
repro: verified
---

# ORDER BY of a grouped, windowed query binds a grouping key to a column the row does not carry

## What is wrong

A grouped query whose `ORDER BY` names one of its grouping keys works — unless the
query also has a window function *and* the `ORDER BY` spells the key in a way the
query's result columns do not literally publish. Then it dies at run time with an
internal error that names a column the user did read:

```
No row context found for column a. The column reference must be evaluated within the
context of its source relation.
```

Verified on `wg (a text, b text)` holding `('x','1'),('y','2'),('x','3')`, engine built
at c44a01b4:

```sql
-- fails
select a, row_number() over (order by a) as rn from wg group by a order by wg.a;
select a, row_number() over (order by a) as rn from wg group by a order by upper(wg.a);
select wg.a, count(*) c, row_number() over (order by a) rn from wg group by a order by wg.a desc;
select a||'!' k, row_number() over (order by a||'!') rn from wg group by a||'!' order by a||'!';

-- same queries WITHOUT the window function: all fine
select a from wg group by a order by wg.a;                    -- [{"a":"x"},{"a":"y"}]
select a, count(*) c from wg group by a order by upper(wg.a); -- [{"a":"x","c":2},{"a":"y","c":1}]
```

The spellings the projection output scope does hold — the bare key, an `as` alias, an
ordinal — resolve there and work in both shapes.

Verified pre-existing, not caused by the select-list redirect that landed in c44a01b4:
with that redirect disabled and the engine rebuilt, every query above fails identically.

## Why

`applyOrderBy` (`planner/building/select-modifiers.ts`) builds each sort key against
`ShadowScope([projectionScope, selectContext.scope])`. `projectionScope` publishes the
result columns under their output names, so `a`, an alias, and an ordinal all resolve
there. Anything else falls through to `selectContext.scope` — the **pre-aggregate**
select scope — and binds to a base-table attribute. The AggregateNode's output row does
not carry that attribute.

Without a window function the resulting `SortNode` consumes the aggregate's yield
directly, and `emit/aggregate.ts` publishes a representative source row of the current
group around each yield, so the read finds a value and it happens to be the right one.
With a window function the `SortNode` sits above the `WindowNode`, whose buffered path
drains its whole source before yielding anything — every representative-row context is
gone by then, and the read has nothing to resolve against.

This is the same defect, one clause over, that
`complete/3-bug-qualified-group-key-in-select-list-breaks-window-query` removed from the
SELECT list, and `docs/runtime.md` § *Corollary: a published source row reaches only the
adjacent consumer* already states the rule it violates: **plan-time binding must never
depend on the representative source row.**

`HAVING` was checked and is *not* affected: its filter sits directly on the aggregate's
yield, below any window phase, so `having wg.a = 'x'` and `having upper(wg.a) = 'X'`
both work windowed and unwindowed. It still binds to the base attribute, though — right
only because of where it sits.

## Expected behaviour

Every legal spelling of a grouping key in `ORDER BY` returns the same rows whether or
not the query also uses a window function. `order by wg.a`, `order by upper(wg.a)`, and
`order by <the computed grouping expression repeated>` sort by the group's key.

Nothing about which columns are *legal* in a grouped `ORDER BY` should change: an
`ORDER BY` naming a genuinely ungrouped column must still be rejected, with the existing
message, and must not start being silently accepted by a redirect.

## Shape of the fix

The instance fix is small — a grouped query already builds a `GroupedRedirectContext`
in `buildSelectStmt`, and `redirectToGroupKeys` is exactly the rewrite `ORDER BY` needs
— but this is the third consumer of the same seam (SELECT list, window specifications,
now `ORDER BY`), and `HAVING` is a fourth that is correct only by accident of placement.
Prefer the invariant over the instance:

- **One choke point.** Every post-aggregate expression of a grouped query should reach
  the redirect through one call site, rather than each builder remembering to ask.
- **A boundary check that makes the class fail loudly at plan time.** Once a grouped
  query's plan is built, no node above the AggregateNode should reference an
  aggregate-input attribute id that is absent from the aggregate's output.
  `assertGroupedWindowCoverage` already answers exactly this question for one operator,
  off the same context. Applied to the finished plan it would have caught this ORDER BY
  case, the original SELECT-list case, and any future post-aggregate operator, at build
  time with the user-facing GROUP BY message instead of an internal runtime error.
  Note that `HAVING` would have to be redirected too for such a check to pass — which is
  the desired end state anyway.
- The `ORDER BY` redirect must run only on the sort keys that fell through to the
  pre-aggregate scope, and must not disturb the two existing `ORDER BY` placements for
  aggregate queries (`shouldApplyOrderByBeforeProjection` / the pre-aggregate sort path)
  — see the open `backlog/bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate`,
  which is about that placement fork and is a different root cause.

## Coverage

Belongs in `test/logic/07.5-window.sqllogic`, beside the SELECT-list section added by
the prior ticket, which already pins the working `ORDER BY` spellings and carries a
comment pointing here. Each failing query above should be pinned with its window
function and with its non-window twin, so the two cannot drift apart again.
