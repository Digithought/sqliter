description: When deciding which of several WHERE tests to run first, also take into account how many rows each test throws away, not only how expensive it is to run.
files: packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts

## Background

`feat-where-conjunct-cost-ordering` orders the AND-ed tests in a WHERE clause by
how expensive each one is to evaluate, cheapest first, so a costly test is
skipped for rows an earlier test already rejected.

Cost alone is only half the picture. A test that is very cheap but rejects almost
nothing is worth less than a slightly pricier test that rejects almost
everything — because the second one means fewer rows reach whatever comes after
it. The standard rule of thumb ranks each test by how much filtering it buys per
unit of work it costs, roughly `(fraction of rows it rejects) / (cost to run
it)`, and runs the highest-ranked one first.

## Why this is a separate ticket

The engine already estimates, per test, what fraction of rows survive it — that
is what `rule-filter-selectivity` computes when a filter sits over several tables
(it splits the predicate and estimates each part independently). But that path
only fires for multi-table filters, it runs in an earlier optimizer stage than
the ordering rule, and its output is currently folded into one combined number
rather than kept per test.

So the work here is not "change the sort key". It is:

- make per-test selectivity estimates available to the ordering rule (either by
  keeping them alongside the combined number, or by re-deriving them where the
  ordering rule runs),
- extend the single-table path so a single-table filter also gets per-test
  estimates,
- decide what to do when only some tests are estimable (a mix of known and
  unknown selectivities must not produce a worse order than cost-alone),
- keep ordering deterministic and stable when two tests tie.

## Expected behaviour

For a filter combining a cheap-but-weak test with a slightly-pricier-but-strong
one, the strong test should run first — and result sets must be unchanged, since
this only affects evaluation order, never which rows qualify.

There should be a guard against regression: when no useful selectivity estimate
exists, ordering must fall back to exactly today's cost-only order, so plans for
unestimable queries do not churn.
