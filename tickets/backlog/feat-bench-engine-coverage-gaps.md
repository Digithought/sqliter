---
description: The benchmarks cover basic scans, joins, sorting and inserts, but say nothing about many features the engine has shipped since - transactions, constraints, materialized views, writable views, window functions and more - so a change that makes any of them dramatically slower would go unnoticed.
prereq: bench-comparison-and-reporting
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # 16 benchmarks: scans, filters, group by, order by, join, correlated subquery
  - packages/quereus/bench/suites/mutation.bench.mjs    # 4 benchmarks: bulk insert, single-row insert, update, delete
  - packages/quereus/bench/suites/planner.bench.mjs     # 4 benchmarks: plan-only timings
  - packages/quereus/bench/suites/parser.bench.mjs      # 4 benchmarks
  - docs/architecture.md                                # "Recent refinements" - the feature surface with no benchmark coverage
tradeoffs: Each added benchmark is a number someone has to keep green and interpret forever, and several of these features are new enough that their performance is expected to move a lot - a benchmark on a moving target generates noise rather than signal.
---

# Why

The 28 benchmarks were written around the engine's core: parse a statement, plan it, scan
a table, filter it, sort it, group it, join it, insert into it. That was the whole engine
once. It is now a fraction of it.

Features that ship today with no performance coverage whatsoever - listed roughly in
order of how expensive a regression in each would be:

- **Transactions and savepoints.** Commit cost, savepoint nesting, rollback. Every write
  path goes through here.
- **Constraint enforcement.** Row-level CHECK, deferred CHECK evaluated at commit, foreign
  keys with cascade and restrict, and database-wide assertions. The batched foreign-key
  restrict path has a sentinel noting it was roughly 6000 ms before batching and is a
  small fraction of that now - a number that valuable deserves a benchmark, not a comment.
- **Materialized view maintenance.** Maintained synchronously inside the writing
  transaction, with a per-row delta path and a full-rebuild fallback. Which of those two a
  body gets is a cost decision made at plan time; nothing measures whether the fast path
  is actually fast, or whether a body silently fell back to rebuild. A sentinel bounds
  bulk insert with two aggregate views at 12x a plain insert - again, a ratio worth having
  as a first-class benchmark.
- **Writable views and lenses.** Writes routed through a view are rewritten and re-planned
  against base tables. That rewrite is on the write path of anything using the layered
  schema model.
- **Window functions.** Entirely absent from the suite.
- **Recursive common table expressions**, and non-recursive ones with reuse - the caching
  and materialization rules exist specifically to make these fast.
- **Set operations** - union, except, intersect, and the parallel gather path that
  recognizes some of them.
- **Plan cache and prepared-statement reuse.** The planner suite times planning from
  scratch; nothing times the hit path, which is what a repeated query actually pays.
- **The parallel runtime** - the eager-prefetch node, the async gather combinators, the
  fan-out lookup join. Every one of these exists solely to be faster, and none has a
  benchmark proving it is. Timing-based measurement of concurrency is notoriously
  unstable, so these may need the deterministic-counter treatment (peak in-flight, branch
  count) rather than wall-clock.
- **Concurrent committed reads** - the mutex-free read path, whose entire purpose is
  latency under a slow writer.
- **JSON and blob-heavy workloads**, and **large result streaming** - whether a big result
  set streams or quietly materializes is a memory question as much as a speed one
  (see `feat-bench-memory-footprint`).
- **Declarative schema apply** - there is an ad-hoc harness for the no-op re-apply fast
  path and its numbers are quoted in the schema documentation from a single machine.

# How to approach it

Not as one ticket. This is a menu, and whoever picks it up should split it into a few
tickets grouped by what they need - the write-path group (transactions, constraints,
materialized views, view writes) shares fixtures, and the parallel-runtime group needs
counter-based measurement rather than timing.

Prioritize by the same rule the existing suite follows implicitly: benchmark the shapes
where a regression is both plausible and expensive. A feature whose fast path is selected
by a cost decision at plan time (materialized-view maintenance strategy, decorrelation,
streaming aggregation, fan-out join clustering) is the highest-value target, because the
regression mode is not "the code got slower" but "the fast path stopped being chosen" -
which is exactly what a twin-comparison ratio guard detects and a lone absolute timing
does not.
