---
description: The benchmark runner now gives every benchmark its own process, so a benchmark's number no longer depends on which benchmark ran before it; review the new parent/worker split, its failure handling, and the measurements that show it worked.
files:
  - packages/quereus/bench/run.mjs                        # parent orchestrator (rewritten)
  - packages/quereus/bench/child.mjs                      # NEW — worker, one benchmark per process
  - packages/quereus/bench/lib/discover.mjs               # NEW — suite/benchmark enumeration
  - packages/quereus/bench/lib/stats.mjs                  # NEW — median/percentile/round/summarize
  - packages/quereus/bench/suites/execution.bench.mjs     # stale cost NOTE corrected (comment only)
  - packages/quereus/bench/fusion-slope.mjs               # DELETED — the two-process workaround
  - tickets/backlog/debt-bench-per-instruction-scalar-cost.md  # cross-reference updated: blocker cleared
difficulty: medium
---

# What landed

`bench/run.mjs` was a single process that ran all 27 benchmarks in sequence. It is now a
parent orchestrator that forks one child process per benchmark. Nothing about how a
benchmark is timed changed — same `warmup ?? 3`, same `iterations ?? 10`, same
per-benchmark overrides — so a before/after comparison differs in exactly one variable.

```
bench/
  run.mjs        parent: CLI, orchestration, table, baseline, ratio guards, exit code
  child.mjs      worker: runs exactly ONE benchmark, reports raw timings over IPC, exits
  lib/
    discover.mjs suite/benchmark enumeration, shared by parent and child
    stats.mjs    median / percentile / round / summarize
```

The parent imports suite modules for their metadata (`benchmarks` array, `ratioGuards`) and
never calls a benchmark's `fn` — noted in the module header, because the moment it does the
isolation guarantee is gone. Children are spawned **strictly sequentially**; there is a
comment at the spawn site saying why that must not become a pool.

`child_process.fork()` with IPC carries the result, not stdout parsing. Child stdout and
stderr are piped, forwarded live to the parent's, and stderr is also retained so a child
that dies without sending anything can still be explained. The parent's per-benchmark
result line prints only after the child exits, so a benchmark that logs cannot interleave
into the middle of it.

`--filter <substring>` matches against `suite/name` and selects the benchmarks to run; the
worker uses the same selection logic to be told "run exactly this one". Zero matches is an
error with a non-zero exit, never a silent empty run.

# Measurements taken (Windows 11, node v24.2.0)

Isolation demonstrably took effect. `execution/full-scan-10k` is the clearest signal — the
ticket predicted it would fall from ~39 ms to ~15 ms:

| run | full-scan-10k median | wall-clock |
| --- | ---: | ---: |
| shared process (old harness, run A) | 52.49 ms | — |
| shared process (old harness, run B) | 90.11 ms | — |
| isolated full run 1 (machine busy) | 29.37 ms | 42.0 s |
| isolated full run 2 | 14.28 ms | 34.3 s |
| isolated full run 3 (machine quiet) | 10.96 ms | 23.3 s |
| isolated full run 4 | 21.93 ms | 40.2 s |
| isolated, `--filter execution/full-scan-10k`, x3 | 13.47 / 14.08 / 14.86 ms | ~1.5 s each |

Every full run reported all 27 benchmarks, the ratio guard passed (1.06x, 0.99x, 1.01x,
0.88x against `maxRatio: 10`), and no benchmark failed. Wall-clock 23-42 s against the
ticket's ~33 s estimate and 90 s ceiling.

**Read the absolute numbers with care.** This machine had 141-148 other node processes
alive during part of the work (the ticket runner and sibling agents). Load moves these
numbers by 2-4x in both directions — isolated full run 1 measured
`temporal-arith-scan-10k` at 462 ms where quiet runs put it at 85-118 ms. The relative
shared-vs-isolated result reproduces the planning measurement; the absolute millisecond
values do not pin down to one figure, which is exactly the noise problem
`bench-adaptive-sampling` is queued to address.

# Verification a reviewer can repeat

All of these were run and passed; re-run them rather than trusting this list.

- `node bench/run.mjs` from `packages/quereus` — 27 benchmarks, ratio guard ok, exit 0,
  wall-clock printed.
- `node bench/run.mjs --filter parser/` — reports "selected 4 of 27", runs only those four,
  and prints `ratio guard skipped: … not selected by --filter`.
- `node bench/run.mjs --filter nope-nothing` — errors, exit 1.
- `node bench/run.mjs --nope` — unrecognized-argument error, exit 1. (The old harness
  silently ignored unknown flags. Erroring is new behaviour; flag it if that's unwanted.)
- **Ratio guard fails when broken.** `maxRatio` was temporarily lowered from 10 to 0.5 in
  `execution.bench.mjs` and `--filter execution/` run: it printed
  `ratio guard FAILED: … is 1.2x … (max 0.5x)` and exited 1. The value was restored —
  `git diff` on that file shows only the comment change.
- **Three failure modes, three distinct reports.** Verified with a throwaway suite file
  (since deleted) holding a benchmark that throws in `fn`, one that throws in `setup`, one
  that calls `process.exit(7)`, one that hangs, and two that succeed:
  - thrown in `fn`/`setup` → `FAILED — threw during fn: deliberate`, full stack printed in
    the end-of-run summary;
  - `process.exit(7)` → `FAILED — child exited without a result (code 7, signal none)`,
    with the child's stderr quoted;
  - genuine hang → `FAILED (timeout)`, child SIGKILLed. Verified by temporarily lowering
    `BENCH_TIMEOUT_MS` to 3 s; restored to 120 s.
  - In every case the surviving benchmarks still reported, failed benchmarks kept a row in
    the table marked `FAILED (<kind>)`, and the run exited 1.
- `yarn build` — clean.
- `yarn test` — 9m 2s, all workspaces passing (9665 + 420 + 179 + 89 + 78 + 89 + 1811 + 725
  + 85 + 31 + 34 + 134 + 22), zero failing. No pre-existing failures surfaced.
- `yarn lint` was **not** run. This diff is `.mjs` under `bench/` plus one markdown file;
  `packages/quereus/eslint.config.mjs` matches only `**/*.ts`/`**/*.tsx` and the lint script
  globs `src/**/*.ts` and `test/**/*.ts`, so no linted file changed. Confirm that reasoning
  if you disagree.

# Known gaps and things worth an adversarial look

Treat the tests above as a floor. Specific places to push:

- **Test coverage is manual only.** Every failure-mode check above was done with a
  throwaway suite file that was then deleted. There is no automated test of the harness
  itself, so the next change to `run.mjs` has nothing catching a regression in failure
  propagation, filter matching, or exit codes. That is the largest gap in this ticket. It
  was not filed as a ticket because the reviewer may prefer to just write it inline; if it
  should be tracked, `debt-` in `backlog/` is the right home.
- **The timeout backstop path is untested.** `forkBenchmark` has a second timer that
  resolves 5 s after a SIGKILL if `'close'` never arrives, and an `'error'` handler that
  resolves when `child.pid === undefined`. Both exist because node does not guarantee
  `'close'` follows a spawn failure or a kill, and a missed resolve hangs the whole run
  forever. Neither branch was reachable in testing — reason about them rather than trusting
  them.
- **`p95` is still the max for most benchmarks.** `percentile(arr, 95)` on 10 samples
  indexes the last element. Carried over unchanged from the old harness deliberately; it is
  `bench-adaptive-sampling`'s to fix. Don't file it.
- **Results JSON gained two fields**: `wall_clock_ms`, and a `failures` array. Failed
  benchmarks are deliberately kept OUT of the `benchmarks` map so a failed run cannot be
  mistaken for a fast one by a `--baseline` comparison. Check that suits
  `bench-comparison-and-reporting` downstream.
- **Guard behaviour under `--filter` was a judgment call.** A guard naming an unselected
  benchmark is *skipped* when `--filter` is active and a *misconfiguration failure* when it
  isn't, because otherwise narrowing a run to one benchmark makes every guard fire and
  trains everyone to ignore them. A guard whose benchmark was selected but failed reports
  "not evaluated" without adding a second failure. Rationale is in the `checkRatioGuards`
  doc comment; disagree there if you'd have chosen differently.
- **Startup cost is real but was not isolated.** A filtered single-benchmark run takes
  ~1.5 s wall-clock, most of it node start plus `import('dist/src/index.js')`. The parent
  pays that import once more for discovery. Both were accepted as the price of isolation;
  the numbers above are the evidence it stays affordable.
- **`bench/apply-schema-unchanged.mjs`** is another standalone script in `bench/` that this
  ticket did not touch and was not asked to. It is not part of the suite.

# Tripwires parked in code

- `bench/child.mjs`, at `LINGER_GRACE_MS` — after the result is sent the worker force-exits
  250 ms later if a leaked handle keeps the loop alive. `process.exit` can drop queued
  stdout writes; nothing has been observed truncated, and the note says to drain stdout
  rather than raise the delay if a heavily-logging benchmark ever loses its tail.

# Not done here, on purpose

- No adaptive sampling (`bench-adaptive-sampling`).
- No changes to the `>20%` baseline regression rule (`bench-comparison-and-reporting`).
- No new benchmark — in particular not the scalar-cost slope benchmark that
  `debt-bench-per-instruction-scalar-cost` describes. That ticket's "Cross-reference"
  section was updated to record that its blocker is cleared and `fusion-slope.mjs` is gone.
- `docs/architecture.md` section 5 still says 26 benchmarks. The correct count is **27**
  (execution 15, mutation 4, parser 4, planner 4). That doc edit belongs to
  `bench-comparison-and-reporting`; the wrong count was not propagated anywhere new.
