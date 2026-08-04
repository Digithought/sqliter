---
description: A grouped query that groups on two or more columns can hand its result columns back in the wrong order, pairing each column name with a different column's value, whenever the query optimizer works out that one grouping column can be derived from another.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts  # the rewrite that shifts output positions
  - packages/quereus/src/planner/building/select-aggregates.ts                      # aggregateOutputIsSelectList — the build-time agreement this breaks
  - docs/sql-select.md                                                              # § 3.3 states the guarantee that is violated
  - docs/materialized-views.md                                                      # § "Group-key reorder" already describes the shift, treating it as the baseline
  - docs/optimizer-rule-families.md                                                 # the MV `group-key-pinned` forgo guard exists only to match this shift
difficulty: medium
repro: verified
---

# A grouped query's output columns get reordered underneath it

## What happens

`docs/sql-select.md` § 3.3 promises that a grouped query's output column order
follows the select list. For a query grouping on two or more plain columns, it
sometimes does not — and because only the order moves, each column *name* ends up
next to a different column's *value*.

Against `create table pk (v integer primary key, g text)` holding
`(1,'a'), (2,'b'), (3,'a')`:

```sql
select g, v, count(*) as c from pk group by g, v;
```

returns columns named `v, g, c` with rows `(1,'a',1), (2,'b',1), (3,'a',1)` — the
first two columns swapped. Written with aliases (`select g as gg, v as vv, …`) the
same query returns `gg, vv, c` in the right order, because the aliases force a
projection above the aggregate.

The same happens without a primary key, driven by a `where` equality instead:

```sql
select a, b, count(*) as c from nk where a = b group by a, b;   -- returns b, a, c
```

and on a join whose two sources share a column name:

```sql
select nk.a, nk.b, nj.a, nj.c, count(*) as c
from nk join nj on nk.a = nj.a
group by nk.a, nk.b, nj.a, nj.c;                                -- returns b, a, c, a, c
```

Verified by running all three (memory tables, current `main`). This is
long-standing behavior, not a regression: neutralizing the
`aggregateOutputIsSelectList` term added by
`bug-grouped-aggregate-only-select-returns-extra-column` reproduces it unchanged.

## Where it comes from

`rule-groupby-fd-simplification` drops a grouping column that is functionally
determined by the surviving ones and re-emits it as a picker `min(<column>)`
aggregate. An aggregate node's output layout is fixed — grouping keys first, then
aggregate results — so a dropped key necessarily moves from its old key position
down into the aggregate block. The rule's own header says so: *"positions may
shift, attribute IDs do not."*

Every consumer that binds by attribute id is fine. Exactly one consumer binds by
position: the statement result itself, when the aggregate node is the query root
with no projection above it. That is why an alias (which forces a projection)
makes the symptom vanish, and why only queries with ≥2 grouping keys are affected
(the rule returns early below that).

## Why it matters beyond the wrong answer

Two other places already bend around this shift rather than treating it as a
defect, and should be revisited together with it:

- `docs/materialized-views.md` § "Group-key reorder" documents the shift as
  something a rewrite must *reproduce* to stay a faithful drop-in.
- The materialized-view rewrite's `group-key-pinned` forgo guard
  (`docs/optimizer-rule-families.md`) exists only so the view path reproduces the
  same reordering the base path produces. If the base path stops reordering, that
  guard is no longer needed and the rewrite can fire on more queries.

## Expected behavior

- A grouped query returns its select-list columns in select-list order, whatever
  the optimizer does with the grouping keys — including when a key is dropped as
  functionally determined.
- The optimization itself should survive in some form; simply never dropping a
  determined key costs plan quality on the common `group by <pk>, <other>` shape,
  where the drop happens not to reorder anything.

## Directions

Three shapes were considered while filing, none chosen:

- Make the rule decline the rewrite when it would permute positions (keep it when
  every dropped key already sits after every surviving one). Cheapest and
  obviously sound; loses the optimization on `group by g, v` where `v` is the key.
- Have the rule restore the original positions with a projection of its own when
  it permutes. Keeps the optimization; adds a plan node and needs care not to
  perturb the incremental-maintenance routing that keys off bare-aggregate plans.
- Force the final projection at build time for any grouped query with ≥2 grouping
  keys. Simplest at the builder, but it re-routes grouped materialized-view bodies
  with two keys from residual-recompute to full-rebuild — see
  `test/incremental/delta-aggregate.spec.ts`. Probably the wrong trade.

## Coverage to add

`test/plan/grouped-projection-shape.spec.ts` and
`test/logic/07.3.2-grouped-select-list-shape.sqllogic` both pin grouped output
shape and are the natural homes; neither has a case with ≥2 grouping keys where
the FD rule fires. All three repro queries above belong there.
