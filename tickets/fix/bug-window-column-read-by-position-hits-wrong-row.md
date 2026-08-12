----
description: A query that uses a window function together with a subquery that looks up a value for each row silently returns the wrong number in the window column — the value of the lookup instead of the window result.
files:
  - packages/quereus/src/runtime/emit/array-index.ts              # the root cause: positional read against whatever row context is newest
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowProjections / rewriteWindowFunctions mint the positional reference (~line 278-335)
  - packages/quereus/src/planner/nodes/array-index-node.ts        # the node itself
  - packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts  # the rewrite that inserts a node above the WindowNode and exposes the defect
  - packages/quereus/test/logic/07.5-window.sqllogic              # where the coverage belongs (grouped-window section)
repro: verified
difficulty: medium
----

# A window function's result column is addressed by position, not by identity

## What is broken

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

select k,
       (select min(t.b) from wg t where t.a = k) as c,
       count(*) over () as n
from (select a as k from wg) group by k;
-- actual:   [{"k":"x","c":"1","n":"1"}, {"k":"y","c":"2","n":"2"}]
-- expected: [{"k":"x","c":"1","n":2},   {"k":"y","c":"2","n":2}]
```

There are two groups, so `count(*) over ()` must be `2` on every row. Instead `n`
repeats whatever the correlated subquery produced. No error is raised — the query
returns a plausible-looking wrong answer.

The same shape with `row_number()` gets its numbering swapped:

```sql
select k, (select count(*) from wg t where t.a = k) as c, row_number() over (order by k) as rn
from (select a as k from wg) group by k;
-- actual:   [{"k":"x","c":2,"rn":2},{"k":"y","c":1,"rn":1}]   -- rn is a copy of c
-- expected: [{"k":"x","c":2,"rn":1},{"k":"y","c":1,"rn":2}]
```

and adding `desc` to the window's ORDER BY makes it produce `null` and `0`:

```sql
select a, (select count(*) from wg t where t.a = wg.a) as c, row_number() over (order by a desc) as rn
from wg group by a;
-- actual: [{"a":"y","c":1,"rn":1},{"a":"x","c":0,"rn":null}]
```

Verified by running each of these against a build of `main`. Not caused by, and not
fixed by, `bug-qualified-group-key-in-select-list-breaks-window-query` — the first repro
above uses only a bare grouping key and behaves identically with that change reverted.

## Root cause

A window function's computed value is handed to the projection above it as a
**positional** reference. `buildWindowProjections` (`select-window.ts`) replaces each
`WindowFunctionCallNode` in the select list with an `ArrayIndexNode` carrying the index
of that function's output column on the WindowNode's row, and
`emitArrayIndex` (`runtime/emit/array-index.ts`) resolves it like this:

```ts
const entries = Array.from(ctx.context.entries()).reverse();
for (const [_descriptor, rowGetter] of entries) {
    const row = rowGetter();
    if (Array.isArray(row) && plan.index < row.length) return row[plan.index];
}
```

It takes the **newest** live row context whose row is long enough, and reads slot
`index` from it. The descriptor is deliberately ignored (`_descriptor`) — nothing ties
the read to the WindowNode that minted the index. Every other column reference in the
engine resolves by *attribute id* through `resolveAttribute`, which is exactly the
identity this read lacks.

That is correct only while the WindowNode's own row is the newest live context at the
moment the projection runs. It stops being true as soon as any rewrite puts another
relational operator between the WindowNode and its projection. In the repros above,
`rule-scalar-agg-decorrelation` turns the correlated subquery into a grouped LEFT JOIN
placed above the WindowNode; the inner aggregate's row is newer at projection time, so
`index` lands in *its* row instead.

This is the same class of defect the "source-attr contexts and child pulls" invariant in
`docs/runtime.md` describes, except that the invariant cannot even be stated for a
positional read: recency is the *only* thing it can key off.

## Expected behaviour

A window function's result column resolves to the value that WindowNode computed for the
current row, regardless of what other operators the optimizer places above the
WindowNode, and regardless of how many row contexts happen to be live.

## Interactions to keep in mind

- `findWindowColumnIndex` / `compareWindowSpecs` in the same file match a window function
  to its output column by *name + `JSON.stringify` of the raw AST window spec including
  source locations*. Both carry `NOTE:` comments explaining that the accidental
  location-sensitivity is currently load-bearing: making the comparison structural
  collapses two same-named functions onto one column. Any move to attribute-identity
  addressing has to settle that at the same time — it is the same question ("which
  window output column is this reference?") asked once at build time.
- `ArrayIndexNode` is used only by the window path today; check before changing its
  emitter contract.

## Use cases to cover

- Grouped + windowed + correlated scalar-aggregate subquery in the select list, in each
  of the three shapes above (constant window function, `row_number()` ascending,
  `row_number()` descending).
- The same shapes with an `exists`/`in` correlated subquery, which routes through
  `rule-subquery-decorrelation` instead.
- Ungrouped windowed query with a correlated subquery in the select list (works today —
  it takes the streaming window path — so it is a regression guard, not a new case).
- Two window functions with different specs alongside a decorrelated subquery, so a
  mis-addressed read cannot be masked by both columns holding the same value.
