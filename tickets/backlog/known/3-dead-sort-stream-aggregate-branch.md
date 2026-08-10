description: Sort+StreamAggregate branch in ruleAggregatePhysical is unreachable with current cost constants — consider removing or making testable
difficulty: easy
prereq: none
files:
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts (lines 90-102)
  packages/quereus/src/planner/cost/index.ts
---

## Problem

In `ruleAggregatePhysical`, the else branch at lines 90-102 creates a `SortNode + StreamAggregateNode` when sort+stream is cheaper than hash. With the current cost constants, **hash is always cheaper** for unsorted input, making this branch dead code:

- `sortCost(n) = n · log₂(n) · 2.0` (O(n log n))
- `streamAggregateCost(n, g) = n · 0.1 + g · 1.5`
- `hashAggregateCost(n, g) = n · 0.5 + g · 1.0`

With `g = max(1, floor(n/10))`, sort+stream always exceeds hash cost because the sort's O(n log n) factor dominates. Even for n=1, sort+stream costs 3.6 vs hash's 1.5.

## Options

1. **Remove the branch** — simplify to always pick hash for unsorted input. Cleaner code, higher coverage.
2. **Adjust cost constants** — if sort+stream should sometimes win (e.g., when output needs ordering anyway), tune constants so there's a realistic crossover point.
3. **Add optimizer tuning hooks** — allow tests to override cost constants for deterministic branch testing. This would also benefit other cost-sensitive rules.
4. **Use actual cardinality estimates** — the current `estimatedGroups = floor(inputRows/10)` is a fixed ratio. Using real statistics could create scenarios where sort+stream wins (e.g., very few groups relative to rows, where maintaining sorted output has downstream value).
