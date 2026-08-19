---
description: Benchmarks all run in one process, so a workload's measured time depends on which workload ran before it - by as much as a factor of three; give each benchmark its own process so its number means what it says.
files:
  - packages/quereus/bench/run.mjs                        # the harness to split into a parent orchestrator + a worker
  - packages/quereus/bench/fusion-slope.mjs               # ad-hoc two-process workaround; deleted by this ticket
  - packages/quereus/bench/suites/execution.bench.mjs     # 15 benchmarks; also carries one stale NOTE to correct
  - packages/quereus/bench/suites/mutation.bench.mjs      # 4 benchmarks
  - packages/quereus/bench/suites/parser.bench.mjs        # 4 benchmarks
  - packages/quereus/bench/suites/planner.bench.mjs       # 4 benchmarks
  - tickets/backlog/debt-bench-per-instruction-scalar-cost.md  # names this work as its blocker; cross-reference to update
difficulty: medium
---

# Why

`yarn bench` runs all 27 benchmarks in a single Node process. The engine's instruction
interpreter shares call sites across query shapes, so whichever shape runs later inherits
a de-optimized, polymorphic dispatch path — and whichever runs first pays tier-up costs
the later ones do not. The result is that a benchmark's median depends on its position in
the run.

This was measured during planning, not inferred. Fourteen benchmarks from
`execution.bench.mjs` were run twice: once all together in one process (the harness's
current behaviour), once each in a fresh process. Same machine, same commit, same
iteration counts, back to back.

| benchmark (execution/) | shared process | isolated | isolated / shared |
| --- | ---: | ---: | ---: |
| full-scan-10k | 39.16 ms | 14.67 ms | 0.37x |
| distinct-text-10k | 62.38 ms | 40.97 ms | 0.66x |
| temporal-arith-scan-10k | 155.78 ms | 126.89 ms | 0.81x |
| join-1kx1k | 7.88 ms | 6.71 ms | 0.85x |
| filtered-scan-index-10k | 1.04 ms | 0.95 ms | 0.91x |
| group-by-text-10k | 69.17 ms | 66.46 ms | 0.96x |
| order-by-text-unicode-10k | 75.70 ms | 80.34 ms | 1.06x |
| order-by-text-10k | 75.59 ms | 83.00 ms | 1.10x |
| text-pk-point-seek-10k | 0.97 ms | 1.14 ms | 1.17x |
| correlated-subquery | 49.40 ms | 58.24 ms | 1.18x |
| group-by-10k | 39.18 ms | 52.21 ms | 1.33x |
| order-by-10k | 55.40 ms | 80.72 ms | 1.46x |
| text-pk-range-scan-10k | 2.76 ms | 4.29 ms | 1.56x |
| hand-batched-peer-count | 47.57 ms | 78.94 ms | 1.66x |

Two things follow from that table, and they decide the design:

**The distortion reaches 2.7x and runs in both directions.** `full-scan-10k` reads 2.7x
too slow when it shares a process; `hand-batched-peer-count` reads 1.7x too fast, because
in the shared run it immediately follows `correlated-subquery`, which warms the same
paths. Neither error is smaller than a regression anyone would care about.

**Per-suite isolation is not enough.** Every row above comes from a single suite file.
Putting each *suite* in its own process leaves all of this intact. **The unit of isolation
must be the benchmark.**

The cost is affordable. In the same measurement the fourteen shared benchmarks took
16.2 s and the fourteen isolated ones took 25.1 s — about **0.64 s of extra wall-clock per
benchmark**. A full current run of all 27 benchmarks takes 16.1 s, so isolation puts it
near 33 s. (A cold Node start plus `import('dist/src/index.js')` measures 1.6-1.9 s, but
that is a first-touch filesystem cost; subsequent starts amortize to the 0.64 s figure.
`module.enableCompileCache()` was tried and did not help — it measured 1.5-3.4 s and was
noisier.)

# What to build

Split `bench/run.mjs` into a **parent orchestrator** and a **worker**, keeping the harness
in small single-purpose modules rather than one growing file:

```
bench/
  run.mjs        parent: CLI, discovery, orchestration, table, baseline, ratio guards
  child.mjs      worker: runs exactly one benchmark, reports timings over IPC
  lib/
    discover.mjs suite/benchmark enumeration, shared by parent and child
    stats.mjs    median / percentile / rounding
```

## The worker

`child.mjs` takes a suite file name and a benchmark name, imports that suite, finds that
one benchmark, runs `setup` then warmup then timed iterations then `teardown`, and reports
the raw timings back. It runs exactly one benchmark per process and then exits. Nothing
else in the suite is executed.

Timing policy in this ticket stays exactly as it is today (`warmup ?? 3`,
`iterations ?? 10`, per-benchmark overrides honored). Adaptive sampling is the next
ticket; keeping it out here means the isolation change can be evaluated against
before/after numbers that differ in one variable.

## The orchestrator

The parent enumerates suites (importing each suite module for its `benchmarks` array and
`ratioGuards` export), then spawns one child per benchmark, **strictly sequentially**.
Parallel children contend for CPU and would reintroduce a worse version of the problem
this ticket exists to fix; say so in a comment at the spawn site so nobody "optimizes" it.

Use `child_process.fork()` with IPC for the result payload rather than parsing stdout —
the child's stdout and stderr must stay available for diagnostics (a benchmark that logs,
a Node warning, a stack trace) and must be forwarded to the parent's, not swallowed.

The parent never calls a benchmark's `fn`. It only reads metadata. Note this in the module
header: the moment the parent executes benchmark work, the isolation guarantee is gone.

## Failure propagation

A benchmark that throws must surface as a run failure with its stack. Three distinct
failure modes, three distinct reports, none of them a missing table row:

- the child caught an error in `setup` / `fn` / `teardown` — it sends a structured failure
  (message + stack) and exits non-zero;
- the child died without sending a result (out of memory, an in-benchmark `process.exit`,
  a native crash) — the parent reports the exit code and signal plus whatever the child
  wrote to stderr;
- the child produced nothing within a per-benchmark timeout (pick a generous fixed
  ceiling — 120 s is ample against a 16 s full run; a benchmark that needs more is
  misconfigured) — the parent kills it and reports the timeout.

The run continues past a failed benchmark so one bad workload does not hide the rest, and
the harness exits non-zero at the end with a summary of what failed.

## `--filter <substring>`

Runs only benchmarks whose `suite/name` contains the substring. This is not only
ergonomics — the child needs a way to be told "run exactly this one", and the same
selection logic serves both. A `--filter` that matches nothing is an error with a non-zero
exit, never a silent empty run that reads as success.

## Ratio guards stay in the parent

`checkRatioGuards` already runs after collection, in the parent, comparing two benchmarks'
medians. That stays correct — and becomes more correct, since both medians now come from
clean processes. Two things to verify rather than assume:

- the existing guard (`correlated-subquery` vs `hand-batched-peer-count`, `maxRatio: 10`)
  still passes under isolation. Planning measured the isolated ratio at 0.74x and the
  shared ratio at 1.05x, both far inside the bound;
- the guard still **fails** when deliberately broken. Temporarily lower `maxRatio` below
  the observed ratio, confirm the harness reports the failure and exits non-zero, then
  restore it. Do not leave the broken value behind.

Also confirm a guard naming a benchmark excluded by `--filter` reports the existing
"ratio guard misconfigured" failure rather than silently skipping. If `--filter` makes that
fire routinely, guards should be evaluated only when every named benchmark ran and
reported as skipped otherwise — pick one and say which in the code comment.

## Retire `bench/fusion-slope.mjs`

That script exists solely because the harness could not isolate: it takes a mode argument
so its two halves run in separate processes. Isolation is now a property of the harness, so
delete the file. The standing benchmark it should become is already specified in
`debt-bench-per-instruction-scalar-cost` (backlog) — update that ticket's
"Cross-reference" section to say the workaround has been removed and the harness now
isolates every benchmark, so the blocker it names is cleared.

Do **not** add the slope benchmark here. This ticket makes the existing 27 numbers
trustworthy; it does not add a 28th.

## Correct one stale number while here

`execution.bench.mjs` carries a `NOTE:` on `order-by-text-prefix40-10k` claiming it is "by
far the most expensive entry in the suite (~380 ms/iteration, ~4.5 s of the total run)".
Measured on the planning machine it is 74 ms median, behind `temporal-arith-scan-10k` at
114 ms and `bulk-insert-10k` at 187 ms. Correct or drop the claim rather than leaving a
number the next reader will trust.

The suite has **27** benchmarks (execution 15, mutation 4, parser 4, planner 4).
`docs/architecture.md` section 5 says 26. The doc edit belongs to the reporting ticket that
rewrites that section — but do not propagate the wrong count anywhere new.

# Edge cases & interactions

- **A child that fails must not vanish from the table.** A missing row reads as
  "unchanged" to anyone comparing two runs. Failed benchmarks appear in the output marked
  as failed.
- **Suite `setup` / `teardown` already run per benchmark.** In the current harness
  `runBenchmark` calls `bench.setup()` for every benchmark, and each execution-suite
  `setup` builds its own 10k-row database. So per-benchmark isolation adds process startup,
  not setup cost. Confirm by reading each of the four suite files that no benchmark depends
  on state left by an earlier benchmark in the same file — as of today none does
  (`execution.bench.mjs` and `planner.bench.mjs` use a module-level `db` that each `setup`
  reassigns and each `teardown` closes; `parser.bench.mjs` builds its `Parser` at import;
  `mutation.bench.mjs` is self-contained per benchmark).
- **Windows.** This is the primary development machine. `fork()` must be given paths built
  with `node:path` / `pathToFileURL`, never string-concatenated, and must survive a
  checkout path containing spaces. Verify the run end to end on Windows, not just that the
  code looks portable.
- **IPC payloads must be plain JSON.** Send the raw timings array and scalar metadata.
  Anything not structured-cloneable (an Error object's own properties, a class instance)
  silently degrades — serialize errors to `{ message, stack }` explicitly.
- **Interleaved output.** With children forwarding stdout, a benchmark that logs will
  interleave with the parent's progress line. Print the parent's per-benchmark result line
  only after the child exits.
- **Exit-code contract.** Preserve today's behaviour — non-zero on ratio-guard failure and
  on a >20% baseline regression — and add non-zero on any benchmark failure. The regression
  rule itself is replaced two tickets downstream; leave it alone here.
- **Discovery imports `dist`.** The parent pays the ~1.6 s engine import to read suite
  metadata. That is fine because the parent measures nothing, but it means `dist/` must be
  built before `yarn bench` — already true today, since the suites import from it.

# Acceptance

- `yarn bench` completes with all 27 benchmarks reported and the ratio guard passing.
- Isolated `execution/full-scan-10k` lands near 15 ms rather than near 39 ms, reproducing
  the planning measurement — the single clearest signal that isolation took effect.
- Total wall-clock is reported. Expect roughly 33 s (16.1 s today plus ~0.64 s per
  benchmark). If it exceeds 90 s, something other than process startup was added; find it
  before handing off.
- A benchmark made to throw on purpose produces a failure with its stack and a non-zero
  exit, and the other benchmarks still report.

## TODO

- Split `run.mjs` into `run.mjs` (parent), `child.mjs` (worker), and `lib/` modules for discovery and statistics
- Implement `child.mjs`: import one suite, run one benchmark, report raw timings over IPC, exit
- Implement sequential `fork()` orchestration in the parent, with a comment at the spawn site explaining why it must not be parallelized
- Forward child stdout/stderr; print the parent's result line after the child exits
- Propagate the three failure modes distinctly (thrown error, died without result, timed out); continue the run and exit non-zero with a summary
- Add `--filter <substring>` over `suite/name`; error on zero matches
- Keep the current fixed warmup/iterations behaviour unchanged in this ticket
- Verify the ratio guard passes under isolation, and verify it fails when `maxRatio` is deliberately lowered; restore the value
- Decide and comment how guards behave when `--filter` excludes a named benchmark
- Delete `bench/fusion-slope.mjs` and update the cross-reference in `tickets/backlog/debt-bench-per-instruction-scalar-cost.md`
- Correct the stale `order-by-text-prefix40-10k` cost NOTE in `execution.bench.mjs`
- Run the full suite on Windows; record the wall-clock and the isolated `full-scan-10k` median in the review handoff
