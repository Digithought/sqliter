---
description: Our benchmark runner produces numbers that are too noisy and too easily distorted to trust as a regression signal; make each measurement isolated, self-calibrating, and reported with enough context to know whether a change is real.
files:
  - packages/quereus/bench/run.mjs                        # the harness: discovery, timing, table, baseline compare
  - packages/quereus/bench/suites/*.bench.mjs             # the 28 benchmarks it drives
  - packages/quereus/bench/fusion-slope.mjs               # ad-hoc script that documents the JIT-contamination problem
  - docs/architecture.md                                  # section 5 Benchmark Suite - 4 lines, and the count is stale (says 26, actual 28)
difficulty: medium
---

# Why

`yarn bench` is the only tool that tracks engine performance over time, and today a
number it prints cannot be trusted to mean what it appears to mean. Three separate
reasons, each independently sufficient to produce a false regression or hide a real one:

**Every suite runs in one process.** The instruction interpreter's call sites are shared
across query shapes, so whichever shape runs later inherits a polymorphic, de-optimized
dispatch path. This is measured, not theorized: `bench/fusion-slope.mjs` exists precisely
because a single-process A/B reported one expression at 630 ns that measures 210 ns in
isolation - a 3x artifact of run order. That script works around the problem by taking a
mode argument and being invoked twice; the real harness has no such escape.

**Iteration count is fixed at 10 regardless of how long the work takes.** A benchmark
whose median is 40 microseconds and one whose median is 400 ms both get 3 warmups and 10
timed runs. The first is dominated by timer resolution and scheduling noise; the second
wastes four seconds proving something one run already showed.

**Nothing reports how noisy a number was.** The harness prints median, p95, min and max,
then a `--baseline` comparison colors anything past 20% red. It never asks whether the
spread within a single run already exceeds 20% - in which case the delta is noise and the
red is a lie. Nor does it record what machine produced the numbers: the results JSON
captures the commit and the Node version, so two files from two different laptops compare
silently and wrongly.

# What good looks like

A run of `yarn bench` should answer three questions without the reader having to know
anything about the harness: what did each workload cost, how confident should I be in
that number, and is this result comparable to the one I am holding it against.

## Per-benchmark process isolation

Each suite (at minimum) runs in its own child process, so no benchmark's timing depends on
what ran before it. Consider per-benchmark isolation for shapes that share interpreter
call sites - the cost is process startup per benchmark, which at 28 benchmarks is seconds,
not minutes, and it retires an entire class of wrong numbers. The choice between
per-suite and per-benchmark should be made by measuring both against a known case
(`fusion-slope.mjs`'s two ladders are the ready-made fixture: run them inside the harness
and confirm the isolated harness reproduces the ~210 ns figure rather than the ~630 ns
one).

Once this exists, `bench/fusion-slope.mjs` should either fold into the suite as a proper
benchmark or be deleted - it is a workaround for a harness limitation that will no longer
exist. (`debt-bench-per-instruction-scalar-cost` in backlog wants exactly this benchmark
and names process isolation as its blocker.)

## Self-calibrating iteration counts

Replace the fixed `warmup: 3 / iterations: 10` defaults with a target *duration* per
benchmark - run until either a minimum iteration count and a minimum total elapsed time
are both satisfied, or a maximum iteration count is hit. A benchmark may still override
explicitly; the point is that the default adapts. Fast benchmarks get enough samples to
have a stable median; slow ones stop as soon as they are stable.

## Report the spread, and gate on it

Alongside median and p95, compute and print a dispersion measure - relative interquartile
range or coefficient of variation, whichever reads more clearly in the table. Two
consequences:

- A benchmark whose own within-run spread exceeds the regression threshold is **not a
  usable gate**. Print it as such and exclude it from pass/fail rather than letting it
  flap. A benchmark that cannot hold a stable number is a bug in the benchmark.
- When comparing against a baseline, a delta smaller than the combined spread of the two
  runs is reported as "no change", not as a colored percentage. The current flat 20% rule
  fires on noise for the sub-millisecond benchmarks and is far too loose for the
  hundred-millisecond ones.

## Capture the environment

The results JSON should record enough to make comparability decidable: CPU model and core
count, total memory, OS and version, Node version, commit, and whether the working tree
was dirty. When `--baseline` is given and the environments differ materially, say so
loudly at the top of the comparison rather than printing a confident-looking delta table.

## Ergonomics

- `--baseline latest` resolves the most recent file in `bench/results/` - the common case
  today requires the user to paste a timestamped filename.
- `--filter <substring>` runs a subset. Iterating on one benchmark currently means
  waiting through all 28.
- `--json` / machine-readable output on stdout, so a later gate script does not have to
  re-parse the human table.

## Documentation

There is no `docs/benchmarking.md`. Create it: what the suites cover, how to run and
compare, what the numbers mean, what the ratio guards are for, how to add a benchmark,
and which measurements are trustworthy across machines (ratios and counters) versus which
are not (absolute wall-clock). Fix the stale "26 benchmarks" in `docs/architecture.md`
section 5 and point it at the new doc.

# Edge cases & interactions

- **Child-process orchestration must not swallow failures.** A benchmark that throws in a
  child has to surface as a run failure with its stack, not a missing row in the table.
- **Ratio guards span benchmarks.** `checkRatioGuards` compares two benchmarks' medians;
  with process isolation those medians now come from different processes. That is fine -
  and in fact more correct - but the guard evaluation has to happen after collection, in
  the parent, which is where it already lives. Verify the existing guard still passes and
  still *fails* when deliberately broken.
- **Degenerate medians.** The existing guard code handles a zero median explicitly. Any
  new dispersion math needs the same treatment - a benchmark that rounds to 0 ms must not
  produce NaN or Infinity in the spread column.
- **Suite `setup`/`teardown` currently run once per benchmark in one process.** Under
  isolation each child pays setup itself; confirm no suite relies on state established by
  an earlier benchmark in the same file.
- **Results directory is gitignored.** Nothing here changes that; the baseline-artifact
  question is a separate ticket (`bench-regression-gate`).
- **Windows.** Child-process spawning and path handling must work on Windows - the
  primary development machine here is Windows, and `execSync` for the commit hash is
  already the only subprocess call in the harness.

# Not in scope

Adding benchmarks, adding counter-based metrics, benchmarking the store, and wiring a
gate. Each is its own ticket downstream of this one. This ticket makes the existing 28
numbers trustworthy; it does not add a 29th.

## TODO

- Measure per-suite vs per-benchmark process isolation against the fusion-slope fixture; pick and document the choice
- Implement child-process benchmark execution with failure propagation
- Replace fixed warmup/iterations with target-duration calibration, keeping per-benchmark overrides
- Compute and print a dispersion measure; exclude unstable benchmarks from gating and say why
- Make baseline comparison spread-aware; drop the flat 20% rule for a noise-aware one
- Capture machine/OS/memory/dirty-tree in the results JSON; warn on environment mismatch during comparison
- Add `--baseline latest`, `--filter`, `--json`
- Verify the existing ratio guard still passes, and still fails when its twin is deliberately broken
- Write `docs/benchmarking.md`; update `docs/architecture.md` section 5 including the stale benchmark count
- Fold or delete `bench/fusion-slope.mjs`
