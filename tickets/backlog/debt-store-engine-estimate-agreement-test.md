----
description: The storage backend and the query planner each work out how many rows a filter will match, and they are supposed to always agree. Nothing checks that they do, so a future change to one could silently drift from the other.
files:
  - packages/quereus/src/planner/stats/catalog-stats.ts             # the engine's estimator; not exported from the package root
  - packages/quereus/src/index.ts                                   # where an export for it would go
  - packages/quereus-store/src/common/store-module-access-plan.ts   # resolveArmEstimate — the store's copy of the same decisions
  - packages/quereus-store/test/column-statistics-plan.spec.ts      # where the current, weaker pin lives
difficulty: medium
tradeoffs: The two estimators agree today and the existing tests would catch the store drifting from the shared formula helpers, so this buys protection against a future engine-side change only - at the cost of widening the engine's public surface purely for a test.
----

# Nothing enforces the rule the store's estimates depend on

## Background

When a store-backed query filters on an indexed column, two separate pieces of code work out
how many rows will match:

- the query planner's own estimator, for a filter it applies itself;
- the storage backend, when it offers the planner an index-based access path and has to say
  how many rows that path returns.

`store-per-predicate-selectivity` made the backend read the same `ANALYZE`-collected column
statistics the planner reads, under an explicit rule: **the backend's number for a predicate
must be the number the planner would produce for the same predicate.** The two numbers
describe the same set of rows. If they disagree, the planner is comparing two descriptions of
different worlds and can pick a plan on the strength of the discrepancy rather than the data.

## What is missing

Nothing checks the rule holds. The two estimators share the low-level arithmetic helpers, and
the existing tests pin the backend against *those* — so the backend drifting on its own would
be caught. What would not be caught is the **planner** changing which formula it applies to a
predicate shape, leaving the backend behind.

That is not hypothetical. The backend's own source carries a note contemplating exactly one
such change: pricing an equality off the column histogram rather than off the distinct-value
count, to handle skewed columns. If that lands on the planner side alone, every store-backed
equality silently starts advertising a different row count from the filter above it, and no
test fails.

## Expected behavior

One test that runs the same predicate through both estimators and asserts they produce the
same row count — over a table of predicate shapes, so it covers the class rather than one
instance: a single equality, a composite equality prefix, a one-sided range bound, a
two-sided range on one column, and an `IN` list. It should fail if either side changes what
it does for any of those shapes without the other following.

## Why it isn't already there

The planner's estimator is not reachable from a test in the store package: it is not exported
from `@quereus/quereus`, and driving it needs a parsed predicate expression, which a store
test has no cheap way to build. Two routes, and choosing between them is part of the work:

- export the estimator (or a small function wrapping it: predicate + table schema → row
  count) from the engine package, and have the store test call it directly;
- or put the test on the engine side, where building a predicate expression is easy, and have
  it drive the store module's access plan for comparison.

The second keeps the engine's public surface unchanged, which is the reason to prefer it if
it works out; the first is simpler to write.

Also worth confirming while specifying: the two are known to disagree on one spelling today,
deliberately. A range written `v > 10 and v < 20` is estimated more tightly by the backend
than by the planner, which folds the two bounds together as though they were independent.
That gap is recorded at the backend's `rangeBoundSelectivity`, and the planner side of it is
tracked by `feat-multi-column-correlation-stats`. Whatever this test asserts has to either
exclude that spelling or encode the known difference, rather than being written to fail on
it.
