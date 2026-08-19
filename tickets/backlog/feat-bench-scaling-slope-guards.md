---
description: Every benchmark runs at one fixed data size, so a change that makes a query scale badly - fine at ten thousand rows, hopeless at a million - looks identical to no change at all; measure each workload at two sizes and check how the cost grows.
prereq: bench-harness-measurement-rigor
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # every workload is hard-coded at 10k rows
  - packages/quereus/bench/suites/mutation.bench.mjs
  - packages/quereus/bench/run.mjs                      # would need to express a benchmark as a size ladder
  - packages/quereus/bench/fusion-slope.mjs             # ad-hoc two-point ladder - the technique, already used once
  - packages/quereus/test/performance-sentinels.spec.ts # the deep-join-spine sentinel - the same idea as a test
tradeoffs: Doubles or triples benchmark runtime for a class of regression that the project has so far caught by other means, and a slope measured from two points is a blunt instrument that will need a generous bound to avoid flapping.
---

# Why

Ask an engine benchmark "is this slower than it was" and a fixed data size answers well.
Ask it "does this still scale" and a fixed data size cannot answer at all.

The distinction is not academic here. The failure mode this project keeps encountering is
not a constant-factor slowdown - it is a plan shape collapsing into a per-row inner
re-evaluation. The one ratio guard in the whole suite exists because a correlated subquery
that stopped being decorrelated ran its inner count once per outer row, roughly 26x slower.
The correlation-detection sentinel exists because a walk over a deep join spine went
exponential: depth 24 took 267 seconds undeduplicated versus 47 milliseconds deduplicated.
Both are complexity-class regressions. Both were caught by someone constructing a
purpose-built comparison after the fact.

At a single fixed size, a change from linear to quadratic behavior at ten thousand rows is
a modest constant factor - well inside a regression threshold loose enough not to flap.
The same change at a million rows is a hang. The signal that distinguishes them is how
cost grows with size, and nothing currently measures it.

The technique is already in the repository, used once and thrown away:
`bench/fusion-slope.mjs` times the same query shape at two expression widths and reports
the slope, so the fixed per-row cost cancels and only the marginal cost remains. Same idea,
applied to row count instead of expression count.

# What it would look like

A benchmark can declare a **size ladder** instead of a single size - the same workload at
(say) 1k and 10k rows, or 10k and 100k. The harness runs both, reports both, and computes
the growth factor. A guard bounds that factor: a workload asserted to be linear should
cost roughly ten times as much on ten times the data, and a bound of, say, 20x catches the
quadratic collapse while leaving room for cache effects and constant overhead.

Growth factors, like the existing ratio guards, are portable across machines in a way that
absolute timings are not - both points come from the same run on the same hardware, so the
hardware cancels.

Not every workload needs a ladder. The ones that earn it are the ones where a plan-shape
regression is plausible: joins, correlated subqueries, aggregates, DISTINCT, ORDER BY,
anything with a decorrelation or streaming rule behind it, and the mutation paths that
batch (constraint checks, index maintenance, materialized-view maintenance).

# Open questions for whoever picks this up

- Two points or three? Two is cheap and distinguishes linear from quadratic. Three
  distinguishes quadratic from log-linear, which may not be worth the runtime.
- Where does the larger size stop? A 100k-row ladder on every joining workload could
  dominate the suite's runtime. Possibly the ladder runs in a separate, less frequent
  suite than the everyday regression set.
- Does this belong in the benchmark harness or as sentinel-style tests? The existing
  deep-join-spine sentinel is a test, and lives comfortably there. The argument for the
  harness is that growth factors want the same reporting and gating machinery as ratios.
