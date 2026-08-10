description: OR branches on different indexes → UNION ALL rewriting with per-branch index seeks
difficulty: hard
prereq: constraint-extractor, UnionAllNode, cost model
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
----

## Summary

When OR branches reference different indexes (e.g., `WHERE colA = 1 OR colB = 2` with separate indexes on colA and colB), the optimizer should rewrite to `UNION ALL` of per-branch queries with duplicate elimination, enabling each branch to use its own index.

## Use case

Queries with OR conditions spanning separately-indexed columns:
- `WHERE name = 'Alice' OR email = 'alice@example.com'` — name index + email index
- `WHERE category = 'books' OR price < 5` — category index + price range index

Currently these remain as residual filters on a sequential scan because the constraint extractor cannot collapse branches referencing different columns into a single IN constraint.

## Requirements

- Detect OR branches that each reference a different available index
- Rewrite to `UNION ALL` of per-branch sub-queries, each with its own index-seekable predicate
- Insert duplicate elimination (DISTINCT or row-ID dedup) when branches may overlap
- Cost model evaluation: N index seeks + dedup cost vs single scan + residual filter
- Only rewrite when the cost model confirms benefit

## Foundation

The OR branch analysis infrastructure (`flattenOrDisjuncts`, `tryExtractOrBranches`) from the OR predicate support work provides the starting point. Requires `UnionAllNode` insertion capability.
