---
description: The min() and max() aggregate functions pick the smallest/largest duration by comparing the text of the value, so min of "2 hours" and "90 minutes" wrongly returns "2 hours"; they should compare by what the value means, like sorting and comparisons now do.
prereq: duration-json-semantic-ordering-engine
files:
  - packages/quereus/src/func/builtins/aggregate.ts    # minFunc / maxFunc — BINARY compareSqlValuesFast in step + algebra.merge
  - packages/quereus/src/func/registration.ts          # createAggregateFunction — where a type-context hook would live
  - packages/quereus/src/runtime/emit/aggregate.ts     # stream-aggregate emitter (has arg types at emit time)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # documents the gap; flip mn/mx expectation when fixed
---

# min()/max() must rank by semantic order for TIMESPAN (and JSON) arguments

## Context

The semantic-ordering ruling (docs/types.md "Semantic ordering", landed by
`duration-json-semantic-ordering-engine`) makes ORDER BY, `<`/`>`, DISTINCT/GROUP BY,
and index order rank TIMESPAN by elapsed time and JSON structurally. The built-in
`min`/`max` aggregates were left out: their step and `algebra.merge` functions compare
with `compareSqlValuesFast(..., BINARY_COLLATION)` because aggregate step functions
receive bare runtime values with no declared-type or collation context.

Observable defect (reachable today): with rows `PT2H` and `PT90M` in a TIMESPAN column,
`select min(d)` returns `PT2H` (text minimum) although 90 minutes < 2 hours — while
`order by d limit 1` returns `PT90M`. `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic`
asserts the wrong-but-current behavior with a KNOWN GAP comment; flip that expectation
(`mn=PT0S, mx=P1D`) when fixing.

Collation is a second, older instance of the same gap: `min(t)` on a NOCASE column also
compares BINARY. A fix that threads comparison context into aggregates should cover both.

## Expected behavior

`min`/`max` over a column whose declared logical type has `semanticOrdering` rank by the
type's `compare` (TIMESPAN: elapsed time; JSON: structural), agreeing with `order by ...
limit 1`. The emitters (`emit/aggregate.ts`, `emit/hash-aggregate.ts`) already resolve
per-argument logical types and collations for DISTINCT tracking — the missing piece is a
way to hand a comparator (or the argument's type context) to the aggregate's step/merge
functions. The delta-aggregate `algebra.merge` path must use the same comparator as the
step, or store-maintained materialized-view merges will disagree with direct evaluation.

## Constraints

- The comparator must reach `algebra.merge` too (materialized-view maintenance), not just
  the step function.
- Untyped / ANY arguments keep today's storage-class + BINARY behavior.
