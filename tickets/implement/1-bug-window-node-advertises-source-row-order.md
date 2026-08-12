---
description: A window query that sorts its own rows still tells the rest of the engine the rows arrive in the source's original order, so a later join step trusts that false claim and silently drops most of the answer.
files:
  - packages/quereus/src/planner/nodes/window-node.ts            # computePhysical — the one line to fix (`ordering: sourcePhysical?.ordering`)
  - packages/quereus/src/planner/framework/physical-utils.ts     # extractOrderingFromSortKeys — the helper SortNode already uses
  - packages/quereus/src/planner/nodes/sort.ts                   # computePhysical, the model to copy (~line 78)
  - packages/quereus/src/runtime/emit/window.ts                  # processPartition / groupByPartitions — what the runtime actually emits
  - packages/quereus/test/logic/07.5-window.sqllogic             # where the SQL-level regression pins go
  - packages/quereus/test/optimizer/                             # where a plan-shape assertion would go
  - docs/window-functions.md                                     # § Streaming fast path over MonotonicOn
repro: verified
difficulty: medium
---

# A buffered window node claims its source's row order after reordering the rows

## What is broken

A window function with `order by … desc` sorts its input and emits rows in that
descending order. The plan node nevertheless advertises the *source's* ordering
(ascending) to the optimizer. A consumer that trusts the advertisement — a merge
join, here — walks a descending stream as if it were ascending and stops matching
after the first row.

```sql
create table wg (a text, b text);
insert into wg values ('x','p'),('y','q'),('x','r'),('z','s');

select z.a, z.rn, w2.b
from (select a, row_number() over (order by a desc) as rn from wg group by a) z
join wg w2 on w2.a = z.a
order by z.a, w2.b;
-- actual:   [{"a":"z","rn":1,"b":"s"}]
-- expected: [{"a":"x","rn":3,"b":"p"},{"a":"x","rn":3,"b":"r"},
--            {"a":"y","rn":2,"b":"q"},{"a":"z","rn":1,"b":"s"}]
```

Three of four rows vanish. No error is raised. The plan for the failing query
contains `LEFT MERGE JOIN` / `MERGE JOIN` directly above the `Window` node; forcing
any other join algorithm returns the right answer, which is what identifies the
ordering advertisement as the thing at fault rather than the join.

The same false advertisement is what makes the correlated-subquery shape below
return `c` values of `0`:

```sql
select a, (select count(*) from wg t where t.a = wg.a) as c,
       row_number() over (order by a desc) as rn
from wg group by a;
-- actual: [{"a":"z","c":1,"rn":1},{"a":"y","c":0,"rn":null},{"a":"x","c":0,"rn":null}]
```

Here `rule-scalar-agg-decorrelation` turns the subquery into a LEFT MERGE JOIN over
the window's output, the join loses every row after the first, and the LEFT join's
NULL fill then coalesces `count(*)` to `0`. (The `rn` column in that same result is
a *different*, independent defect — see `bug-window-column-read-by-position-hits-wrong-row`,
which depends on this ticket.)

Verified by running both queries against a build of `main`.

## Root cause

`WindowNode.computePhysical` (`planner/nodes/window-node.ts`, ~line 234) derives
`monotonicOn` carefully across three cases, and then passes `ordering` straight
through from the source without any of that reasoning:

```ts
return {
    estimatedRows: physicalSourceRows(sourcePhysical, this.source),
    ordering: sourcePhysical?.ordering,      // <-- unconditional pass-through
    monotonicOn,
    …
```

`ordering` is the stronger claim of the two — a list of `{ column, desc }` pairs
asserting the exact emit order — and the runtime only honours it in some of the
cases:

| case | what `runtime/emit/window.ts` actually emits | correct `ordering` |
| --- | --- | --- |
| `plan.streaming` set | source order, row pass-through (`runStreaming`) | source's |
| buffered, no PARTITION BY, no ORDER BY | source order (`sortRows` returns rows unchanged) | source's |
| buffered, no PARTITION BY, ORDER BY present | sorted by the window's ORDER BY (`sortRows`) | derived from the window ORDER BY |
| buffered, PARTITION BY present | partitions in first-seen order, sorted within each (`groupByPartitions` → `processPartition`) | none |

Only the first two rows of that table match what the node advertises today.

Note that the `monotonicOn` block immediately above already spells out exactly
these four cases and gets each one right. This is the same reasoning applied to
the wrong-but-adjacent field.

## Expected behaviour

`WindowNode`'s advertised `ordering` describes the order the window emitter
actually yields rows in, for every one of the four cases above. A consumer that
requires an ordering (merge join, sort elision, streaming aggregate, distinct)
either gets a true ordering or gets none and plans accordingly.

## Design

Mirror `SortNode.computePhysical`, which already solves the "sorted by these keys"
half with `extractOrderingFromSortKeys(sortKeys, sourceAttributes)`
(`planner/framework/physical-utils.ts`). That helper takes
`{ expression, direction }[]` and source attributes, returns `Ordering[]`, and
returns `undefined` the moment a key is not a trivial column reference — the
correct conservative answer.

`WindowNode` has both halves already: `orderByExpressions[i]` is the built key
expression and `windowSpec.orderBy[i].direction` its direction. Column indices are
positions in the *source* row, which are also their positions in the window's
output row because the window only appends columns — so the helper's output needs
no shifting.

Take care that `AST.OrderByClause.direction` may be absent; treat anything that is
not `'desc'` as `'asc'`, matching how the existing `monotonicOn` block reads it.

## Interactions to keep in mind

- Making the partitioned case advertise no ordering may cost a plan that currently
  gets one for free (an elided sort, a merge join). That is the point — the claim
  was false. If a plan test pins a shape that only held because of the false
  claim, the test's expectation is what has to change; say so in the handoff.
- `rule-monotonic-window` *reads* `physical.ordering` of a window's **source** to
  decide whether to stream. It does not read the WindowNode's own output ordering,
  so it is not affected — but re-check it, because stacked window nodes make one
  window's output another's source.
- The `monotonicOn` block in the same method is correct and must keep its current
  behaviour; do not fold the two derivations together in a way that changes it.

## TODO

- Derive `ordering` in `WindowNode.computePhysical` per the four cases above:
  streaming → source's; buffered with no PARTITION BY and no ORDER BY → source's;
  buffered with no PARTITION BY and an ORDER BY → `extractOrderingFromSortKeys`
  over `orderByExpressions` + `windowSpec.orderBy` directions against
  `this.source.getAttributes()`; buffered with PARTITION BY → `undefined`.
- Update the comment block above the derivation so it covers `ordering` as well as
  `monotonicOn` — it currently reads as if only `monotonicOn` needed the case split.
- Add SQL-level regression pins in `test/logic/07.5-window.sqllogic`: the merge-join
  repro above, plus an ascending twin that must keep working, plus a
  `partition by`-reordered source feeding an outer `order by`.
- Add a plan-level assertion that a `desc`-ordered window advertises a `desc`
  ordering and a partitioned window advertises none. `query_plan(?)` exposes each
  node's `physical` JSON (see `test/optimizer/attribute-id-stability.spec.ts` for
  the TVF idiom); assert on the `ordering` field of the `Window` row.
- Run `yarn test` and `yarn lint`; fix any plan-shape test whose expectation
  depended on the false ordering, and call each one out in the review handoff.
- Update `docs/window-functions.md` — the § "Streaming fast path over `MonotonicOn`"
  bullet claiming the window "preserves the source's `monotonicOn` on the
  `WindowNode`'s output" should also state, for each of the four cases, what
  ordering the node advertises.
