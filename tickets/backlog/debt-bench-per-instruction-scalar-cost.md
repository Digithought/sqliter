---
description: The benchmarks time whole queries, so there is no way to see how much of a query's time is the engine's per-step bookkeeping versus the actual work; add a benchmark that measures the cost of one extra expression in a query.
files:
  - packages/quereus/bench/suites/execution.bench.mjs   # existing whole-query suite — the new one would sit beside it
  - packages/quereus/bench/run.mjs                      # harness: suite discovery, medians, ratioGuards
  - packages/quereus/src/runtime/scheduler.ts           # the per-instruction cost the benchmark would expose
tradeoffs: One more benchmark to keep green and interpret, measuring an internal implementation cost rather than anything a user experiences — a maintainer could reasonably say the whole-query suites are the numbers that matter.
---

# Benchmark the marginal cost of one scalar instruction

## Why

Every scalar expression in a query becomes one or more `Instruction`s, and each one is
invoked per row through the scheduler. Nobody currently knows what that costs, because
every benchmark in `bench/suites/` times a whole query — a number that mixes storage,
row materialization, async iteration, and instruction dispatch together.

A one-off measurement taken during the `runtime-guarded-comparison-specialization` plan
pass put it at roughly **143 ns per row for a bare column-reference instruction** and
**210-226 ns per row for a comparison or arithmetic expression** (10k-row table, node
24.2, Windows). That single number decided that ticket — it showed the comparison logic
being optimized was ~5 ns inside a ~220 ns envelope. It deserves to be a standing
benchmark rather than a number in an archived ticket.

## What it should measure

The technique that produced those figures, made permanent: time the *same* query shape at
two expression widths and report the slope, so the fixed per-row cost (scan, iteration,
row assembly) cancels out and what remains is the marginal cost of one added expression.

- Projection ladders, not predicates — a predicate can be pushed into the virtual table
  and then measures nothing. `select n from t` vs `select n, n, … from t` (8 wide);
  likewise for a comparison expression, an arithmetic expression, and a plain literal.
- Report the per-expression slope, not just the two endpoints.
- **Each shape needs its own process, or the numbers are wrong.** The instruction
  interpreter's call sites are shared across query shapes, so running several ladders in
  one process makes whichever ran last look 2-3× slower than it is. This was observed, not
  theorized — an early single-process run reported a comparison at 630 ns/instruction that
  measured 210 ns in isolation. The current harness (`bench/run.mjs`) runs every suite in
  one process, so this either needs a child-process mode or a documented single-shape
  invocation.

## Who needs it

`runtime-scalar-expression-fusion` (plan/) exists to remove per-instruction dispatch, and
its entire value proposition is this number moving. Without an isolating benchmark, fusion
can land, work, and show only a few percent on the whole-query suites — indistinguishable
from having done nothing.

## Not in scope

Turning the slope into a `ratioGuards` entry or a regression gate. Establish what the
number is and how stable it is across machines first; a gate on an unstable number is
worse than no gate.

## Cross-reference

The process-isolation blocker named above **is cleared**. `bench-process-isolation` has
landed: `bench/run.mjs` is now a parent orchestrator that forks `bench/child.mjs` once per
benchmark, so every benchmark in the suite already runs in a fresh process. Measurement
during its planning showed per-suite isolation is not enough, because the distortion is
between benchmarks inside one suite file (up to 2.7x) - the unit of isolation is the
benchmark. This benchmark therefore needs no invocation mode of its own: adding the ladders
as ordinary suite entries gets them isolated automatically. `--filter <substring>` runs a
single one by `suite/name` when a shape needs to be looked at on its own.

The ad-hoc `bench/fusion-slope.mjs` this ticket grew out of **has been deleted** by that
same ticket, since its only reason to exist was running its two halves in separate
processes by hand. The two-point ladder technique it demonstrates - time the same query
shape at two expression widths, report the slope so the fixed per-row cost cancels - is
what this benchmark should reimplement inside the suite; read the deleted file out of git
history - `git show 75800d3fb^:packages/quereus/bench/fusion-slope.mjs` (the commit that
deleted it) - if the details are wanted.
