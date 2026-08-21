---
description: When the planner reads rows through an index, it always assumes about a hundred rows come back, however many really do. A read that returns eleven thousand rows is costed as if it returned a hundred, so the planner keeps choosing it over a plain table scan that would be faster.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts   # IndexSeekNode.computePhysical — the min(tableRows || 1000, 100) cap, and the NOTE that predicted this
  - packages/quereus/src/vtab/best-access-plan.ts              # BestAccessPlanResult.rows — the module's own answer, which is discarded
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # selectPhysicalNode — builds the IndexSeekNode from the module's plan
  - packages/quereus/src/planner/util/row-estimates.ts         # physicalSourceRows — how the capped number propagates upward
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts  # estimateRightRows — already works around this by reading filterInfo.indexInfoOutput.estimatedRows
repro: verified
---

# An index seek always claims about 100 rows

## What happens

`IndexSeekNode.computePhysical` sets its row estimate to a constant:

```ts
estimatedRows: Math.min(this.source.estimatedRows || 1000, 100),
```

So every index seek that is not a full primary-key equality reports **100 rows** to
everything above it in the plan, regardless of how many rows it will actually produce. The
code carries a `NOTE` anticipating exactly this: *"If seek cardinality ever drives a bad
plan, derive it from the seek key's own selectivity instead of `min(tableRows, 100)`."*
It does.

Observed on a 20,009-row store-backed table, a range seek matching 11,112 rows:

```
Project rows=100
  IndexSeek rows=100 idx=idx_entry_entity_date      <- actually yields 11,112
```

Every plan inspected during this investigation showed `IndexSeek rows=100`, including seeks
returning 1 row and seeks returning more than half the table. The estimate carries no
information at all.

## The module already answered the question

The virtual-table module returns its own row estimate for the chosen access plan, in
`BestAccessPlanResult.rows`. That answer survives onto the node — it is reachable at
`filterInfo.indexInfoOutput.estimatedRows` — and `computePhysical` ignores it in favour of
the constant.

That this is the right number to use is not speculation: `rule-nested-loop-right-cache`
already reaches past the capped estimate to read `filterInfo.indexInfoOutput.estimatedRows`
directly, precisely because the node's own figure is unusable. One consumer has already
worked around the defect privately; the fix is to stop making them.

## Why it matters

The capped estimate is an input to every cost decision made above the seek — join algorithm
selection, cache admission, sort costing, aggregate cardinality. Two concrete consequences
seen in this investigation:

- A large-fraction range seek is costed as 100 rows against a full scan costed at the real
  table size, so the seek wins even when scanning is measurably faster.
- `rule-join-physical-selection` reads the left side's estimate to choose between hash join
  and index-nested-loop; when that side is an index seek, it is choosing from a constant.

No wrong rows result — this is plan choice only.

## Scope caution

This is a small edit with a wide blast radius: the number it produces feeds the cost model
everywhere, and several golden-plan and plan-shape tests pin plans that were chosen under
the constant. Expect plan snapshots to move, and expect to have to argue that each move is
an improvement rather than re-pinning it silently. The benchmark work-counter gate
(`yarn bench:gate`, reference counts in `bench/reference/`) is the tool for showing what
actually changed.

## TODO

- Use the module's own `rows` answer for the access plan as the seek's row estimate, falling
  back to the current constant only when the module supplied none.
- Keep the existing exact cases that are better than any estimate: a full primary-key
  equality seek still reports 1 row via the singleton functional dependency.
- Decide what an unanalyzed table should report here, and make it agree with the "0 means
  unknown" convention described in `planner/util/row-estimates.ts` rather than inventing a
  third spelling — see `bug-row-estimate-conflates-unknown-and-zero` (backlog), which is the
  ticket for that convention.
- Re-run `yarn bench:gate` and read every counter that moves; a changed work count here is
  the intended signal, not noise.
- Add a plan test asserting the seek's advertised estimate tracks the module's answer across
  a selective seek and a large-fraction range seek on the same table — the two ends the
  constant currently collapses together.
