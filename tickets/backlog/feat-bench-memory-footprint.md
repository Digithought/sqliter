---
description: Nothing measures how much memory a query uses, so a change that makes the engine hold an entire result in memory instead of streaming it row by row would show up as slightly faster rather than as a problem.
prereq: bench-comparison-and-reporting
files:
  - packages/quereus/bench/run.mjs                          # would collect a memory measure alongside timings
  - packages/quereus/src/runtime/scheduler.ts               # where execution completes and a sample could be taken
  - packages/quereus/src/planner/rules/cache/               # the rules that decide what gets materialized
  - packages/quereus/src/runtime/cache/                     # runtime caching
  - packages/quereus/src/planner/nodes/eager-prefetch-node.ts  # bounded ring buffer - a bound worth pinning
tradeoffs: Heap measurement in a garbage-collected runtime is noisy and easy to misread, and a memory benchmark that flaps will be ignored faster than a timing one - the honest version of this may require forcing collection and accepting a slow, separate suite.
---

# Why

This engine is built around streaming. Cursors are async iterables, results flow row by
row, and a whole family of optimizer rules exists to decide deliberately when something
*should* be materialized - common table expressions, scalar subqueries, hash join build
sides, sorts. The eager-prefetch node pumps rows into an explicitly *bounded* ring buffer
precisely so that latency hiding does not become unbounded buffering.

Every one of those is a memory decision, and none of them is measured. Worse, the failure
direction is disguised: a change that materializes something which used to stream will
often look *faster* in a benchmark, because materialized data is cheap to re-read. The
benchmark reports an improvement while the engine quietly stops being able to handle a
result set larger than memory.

There is also no signal for retention. A cached plan, a statement, or a connection that
holds row data after execution is invisible to every current measurement.

# What would help

Two different measurements, useful for different things:

**Peak memory during a workload.** Sampled around a benchmark run, reported alongside the
timing. The comparison of interest is not the absolute figure but its relationship to the
result size: a query returning ten thousand rows should not have a peak proportional to
ten thousand rows unless it contains an operator that is supposed to materialize. This is
where "did this start materializing" gets caught.

**Retained memory after a workload.** Sampled after the workload completes and references
are dropped, ideally after forcing a collection. A workload whose retained figure grows
run over run is holding something it should not.

Both are noisy in a garbage-collected runtime, which shapes the design: they probably want
their own suite with its own cadence rather than a column in the everyday table, they want
generous bounds, and they may want to run under flags that make collection deterministic
enough to compare.

# The cheaper variant worth considering first

If heap measurement proves too noisy to gate on, a deterministic proxy exists: count the
rows materialized. The work-counter surface (`bench-work-counters`) can report how many
rows each materializing operator held, which is exact, machine independent, and answers
the specific question that matters most - did something that used to stream start
buffering. That does not catch every memory problem, but it catches the one the
architecture is most exposed to, and it can be gated without tolerance.
