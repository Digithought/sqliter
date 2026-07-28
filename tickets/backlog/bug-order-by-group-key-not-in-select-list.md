description: A grouped query that sorts by the column it grouped on fails with an internal error whenever that column only appears in the output wrapped in an expression — for example grouping by a column and selecting a converted or uppercased version of it.
files:
  - packages/quereus/src/planner/building/select.ts        # ORDER BY resolution against the aggregate output
  - packages/quereus/src/runtime/emit/column-reference.js  # where the failure surfaces (resolveAttribute)
  - packages/quereus/src/runtime/context-helpers.ts        # "No row context found for column" error site
difficulty: medium

----

# `order by <group key>` fails when the select list only exposes the key through an expression

## What happens

Reproduced against the current build (memory module, no plugins):

```sql
create table i (v integer primary key, g text);
insert into i values (1,'a'),(2,'b'),(3,'a');

select cast(v as text) x from i group by v order by v;
-- QuereusError: No row context found for column v. The column reference must be
--               evaluated within the context of its source relation.
select v+0        x from i group by v order by v;      -- same error
select upper(g)   x from i group by g order by g;      -- same error
select cast(v as text) x from i group by v order by v desc;  -- same error
```

Working variants that pin the shape down:

| query | result |
|---|---|
| `select cast(v as text) x from i group by v order by x` | works (sorts by the output alias, not the key) |
| `select cast(v as text) x, count(*) c from i group by v order by v` | works (an aggregate in the select list) |
| `select v x from i group by v order by v` | works (key exposed bare) |
| `select g, count(*) c from i group by g order by g` | works |
| `select cast(v as text) x from i group by v limit 2` | works (no ORDER BY) |

So the failure needs all three: a `GROUP BY`, an `ORDER BY` naming the grouping key
directly, and a select list where that key appears only inside an expression with no
aggregate alongside. Sorting by the *alias* instead is the workaround.

This is standard, valid SQL — the grouping key is always available to `ORDER BY`
whether or not the select list echoes it bare.

## Where it surfaces

The error is thrown from `resolveAttribute` in `src/runtime/context-helpers.ts`,
reached from the column-reference emitter: at run time the sort key's column
reference has no row context, i.e. the plan wired the `ORDER BY` expression to an
attribute that the aggregate node does not actually output. The likely cause is in
ORDER BY resolution during select building — when the grouping key survives into the
output only as an argument of a projected expression, the sort key ends up bound to
the pre-aggregation attribute rather than to the group key the aggregate emits. The
`count(*)` variant working suggests the aggregate node's output attribute set differs
between the aggregate-present and grouping-only shapes.

## Expected behavior

Any expression that is legal in `GROUP BY` is legal in `ORDER BY` of the same query
and sorts by the grouped value, regardless of how (or whether) the select list
projects it. `asc` and `desc` behave the same.

## Notes

- Found while reviewing `numeric-comparator-rejects-bigint`; unrelated to that fix —
  it reproduces on a plain `integer` and a plain `text` column, and predates it.
- No existing test covers this shape, so nothing is currently failing in CI; a
  regression test belongs with the other GROUP BY logic tests.
