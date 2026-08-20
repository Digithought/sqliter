---
description: The benchmark runner has no tests of its own, so the only thing proving it reports a broken benchmark correctly is a person running it by hand and reading the output.
files:
  - packages/quereus/bench/lib/discover.mjs   # hardcodes the suites directory — the one seam that must change
  - packages/quereus/bench/run.mjs            # parent: CLI parsing, failure classification, exit codes, ratio guards
  - packages/quereus/bench/child.mjs          # worker: per-phase failure reporting, orphan self-termination
  - packages/quereus/test/                    # where a spec would live (Mocha, `test/**/*.spec.ts`)
difficulty: medium
tradeoffs: The benchmark harness is developer tooling, not shipped engine code, and a self-test costs real seconds on every `yarn test` run for a component whose breakage a developer notices the next time they run `yarn bench` anyway.
---

# Why

`yarn bench` decides whether a performance change is a regression. It reports which
benchmarks failed, why they failed, and whether the run as a whole passed. Nothing checks
that it does any of that correctly.

The behaviour that matters is all about things going wrong: a benchmark that throws, one
that kills its own process, one that never finishes, a flag typed wrong, a comparison file
that cannot be read. Each of these has to fail *loudly and specifically*, because the
alternative — a harness that quietly reports success — is worse than no harness at all.
That is exactly the behaviour with no test behind it.

Every check of these paths so far, across both the implementation and the review of
`bench-process-isolation`, was done the same way: hand-write a throwaway benchmark file
that misbehaves in one specific way, run the harness, read the output, delete the file.
The evidence is real but it lives in a ticket, not in the repository. The next person to
change the runner has nothing that tells them they broke it.

# What is untested today

Grouped by the promise each one makes.

**A broken benchmark fails only itself.** A benchmark that throws, that exits its process
outright, or that hangs forever must be reported with its own distinct explanation, must
leave the surviving benchmarks reporting normally, and must make the whole run exit
non-zero.

**A run that is not the run you asked for is never reported as success.** A filter that
matches nothing, an unknown flag, a flag missing its value, and a comparison file that is
missing or is not a results file must each stop the run with a readable one-line message.

**Comparisons and guards do what they say.** A within-run ratio guard must fail when the
ratio is exceeded and pass when it is not, and must behave sensibly when the benchmarks
it names were filtered out of the run. A comparison against a previous result must flag a
benchmark that got slower.

**Nothing outlives the run.** Every benchmark gets its own process, and none of those
processes may survive the runner exiting or being interrupted.

# The blocker, and it is small

There is no way to point the harness at anything other than the real suites. The suites
directory is computed from the module's own location in `bench/lib/discover.mjs` and is
not a parameter anywhere. So a test has exactly two bad options: write fixture files into
the real `bench/suites/` directory and hope the cleanup runs, or don't test it. Both
manual sessions above took the first one.

Make the suites directory something the caller supplies. That one change is what turns
every item in the list above from "run it by hand and squint" into an ordinary test, and
it is the reason this is filed as one ticket rather than a list of small ones.

# Scope notes

A fixture suite should be trivial and fast — its benchmarks exist to misbehave in a
specific way, not to measure anything, so the whole spec should cost a couple of seconds,
not a couple of minutes. The real suites must stay out of it entirely.

Worth deciding as part of this: whether these tests join `yarn test` (fast feedback, small
constant cost on every run) or sit behind their own script that `yarn check` calls
(no cost day to day, but only runs before a release).

## Arm added by review of `bench-comparison-and-reporting`

**The harness is not covered by the project's *static* checks either, and that gap has
already shipped a broken `yarn lint` once.** The two modules added by
`bench-comparison-and-reporting` landed with 25 type errors, which broke `yarn lint`
outright — `packages/quereus`'s lint script ends in `tsc -p tsconfig.test.json --noEmit`,
and `tsconfig.test.json` includes `bench/lib/**/*` with `checkJs` on. The review fixed
those 25 errors by giving the modules real types.

The rest of the benchmark directory is not covered at all, and that is why nothing caught
it earlier in the same directory:

- `tsconfig.test.json` includes only `bench/lib/**/*`. `bench/run.mjs`, `bench/child.mjs`,
  `bench/apply-schema-unchanged.mjs` and every `bench/suites/*.bench.mjs` are type-checked
  by nothing.
- `packages/quereus`'s eslint glob is `'src/**/*.ts' 'test/**/*.ts'`. **No `.mjs` file
  under `bench/` is linted at all**, including `bench/lib/`.

Measured during the review by widening the include to `bench/**/*.mjs` and running `tsc`:
131 errors, distributed `bench/run.mjs` 72, `bench/suites/execution.bench.mjs` 32,
`bench/apply-schema-unchanged.mjs` 10, `bench/child.mjs` 7, `bench/suites/planner.bench.mjs`
6, `bench/suites/mutation.bench.mjs` 4. Most are missing JSDoc parameter types and untyped
object bags rather than real defects, but they are what makes the directory unable to hold
a check.

The end state is the same invariant either way: **every file under `bench/` is covered by
the same static checks as the rest of the package**, so an unchecked file cannot be added
there again. That is a config change plus the type annotations to clear it, and it pairs
naturally with the behavioural tests this ticket already describes — both are "the harness
that decides whether performance regressed is itself unchecked".

## Arm added by review of `bench-backend-dimension`

**`skip()` — a benchmark declining to run — shipped with no automated test at all.** A
benchmark may now declare `skip()`, returning a reason to decline instead of running. Its
plumbing spans both processes: `bench/child.mjs` evaluates it before `setup` and sends a
`skipped` message; `bench/run.mjs` prints the row, writes a top-level `skipped` array into
the results JSON, and makes a ratio guard naming a skipped benchmark report
*not evaluated* rather than *misconfigured*. Only the pure comparison half
(`bench/lib/compare.mjs`) has specs.

Every one of those paths was verified the same way this ticket already describes: a
throwaway suite dropped into the real `bench/suites/`, run by hand, deleted afterwards.
Same blocker, same fix — a caller-supplied suites directory turns it into an ordinary
test.

**Re-measured static-check coverage**, since the numbers in the arm above are now stale.
`packages/quereus/tsconfig.test.json` includes `bench/lib/**/*` and (as of this review)
`bench/workloads/**/*`. Widening the include to `bench/**/*.mjs` and running
`tsc -p tsconfig.test.json --noEmit` gives 148 errors: `bench/run.mjs` 99,
`bench/suites/planner.bench.mjs` 10, `bench/apply-schema-unchanged.mjs` 10,
`bench/suites/execution.bench.mjs` 9, `bench/child.mjs` 9,
`bench/suites/mutation.bench.mjs` 5. The suite files dropped from 36 errors to 14 when
their workloads moved out, so the remaining gap is smaller than it was. `bench/*.mjs` is
still linted by nothing — `packages/quereus`'s eslint glob is `'src/**/*.ts' 'test/**/*.ts'`.

## Arm added by review of `bench-leveldb-backend`

**The `informational` flag's parent-side half — the part that decides whether a number can
fail a build — has no automated test.** The pure halves do: `expandBackends` stamping the
flag and `compareRun` refusing to gate it are covered by
`test/bench-backends.spec.ts` and `test/bench-comparison.spec.ts`. Everything the *runner*
does with it lives in `bench/run.mjs` and is verified only by a person reading a terminal:

- the cyan `informational` marker on measured, skipped and failed rows,
- the yellow "N informational benchmark(s) regressed — reported, never gated" summary line,
  which is the only thing explaining a red `regression` status next to an exit code of 0,
- **the refusal of a ratio guard that names an advisory row**, reported as `misconfigured`
  and checked before every other guard case so a `--filter` cannot hide it. This one is a
  build gate: if it silently stopped firing, a build-gating ratio could be anchored to a
  disk-dependent number and nothing would say so.

Same blocker as every arm above — a caller-supplied suites directory. The guard refusal in
particular needs a fixture suite that declares a deliberately-bad guard, which is exactly
what cannot be written today without dropping a file into the real `bench/suites/`.

**Also uncovered, and specific to this ticket: `run.mjs`'s signal handler.** It now records
the active worker's PID, `SIGKILL`s it, and sweeps temporary databases before exiting. The
sweep itself is covered as of this review (`test/bench-tempdir.spec.ts`), and the
timeout path exercises the same
`killedWorkerPids` → `SIGKILL` → `sweepBenchTempDirs` sequence — but the handler itself has
never run in any test. Windows cannot deliver `SIGINT` to another process programmatically
(`child.kill('SIGINT')` terminates instead), so closing this needs either a Linux/macOS run
or the same fixture-suite seam.

**Re-measured static-check coverage.** Unchanged in shape and now carrying this ticket's
new code: `bench/run.mjs` gained roughly 110 lines here (PID tracking, the sweep call, the
marker, the guard refusal, the advisory-regression summary) and **is type-checked by
nothing** — `packages/quereus/tsconfig.test.json` still includes only `bench/lib/**/*` and
`bench/workloads/**/*`, and eslint still globs `'src/**/*.ts' 'test/**/*.ts'` only. The two
new modules this ticket added (`bench/lib/leveldb-backend.mjs`, `bench/lib/tempdir.mjs`)
ARE inside the checked include, and that is what caught a real error: `tempdir.mjs` shipped
in commit `9dd90e02d` with `error TS2339: Property 'code' does not exist on type '{}'`,
breaking `yarn lint` outright until the implementer's second commit fixed it. The same
mistake in `run.mjs` would still ship green.

## Arm added by review of `bench-gate-ratio-guards`

**`bench/gate.mjs` has now grown a second, forked pass, and none of it is covered by any
check — static or behavioural.** The ratio-guard *rules* are pure and well covered
(`test/bench-guards.spec.ts`, 35 tests over `bench/lib/guards.mjs`). The *wiring* that
drives them is roughly 250 new lines in `gate.mjs` verified only by a person running the
gate and reading the terminal:

- the per-member fork helper, its 120 s timeout and the 5 s reap backstop after `SIGKILL`,
- the `SIGINT`/`SIGTERM` handlers (same Windows limitation the arm above records for
  `run.mjs`: `child.kill('SIGINT')` terminates rather than delivering the signal),
- the member-fork-failure path — a fork that dies deletes its `allBenchmarks` entry, so the
  guard reads *not evaluated* and a separate counter fails the gate with "guard member
  benchmark(s) failed to run". Nothing has ever exercised it.
- the zero-counter-selection relax: a `--filter` that names only guard members selects no
  counter-declaring benchmark and must run the guard pass instead of refusing. Unreachable
  today (both members of the only guard declare `counters()`), so it is dead code until a
  guard names a benchmark without a counters pass — and it will be first exercised by
  whoever writes that guard, with nothing to tell them if it is wrong.
- `--report-only` / `QUEREUS_BENCH_GATE_REPORT_ONLY`: the exit rule itself is pure and
  tested (`gateExitCode`), but the wiring that folds counter failures, guard failures and
  member failures into the one `failed` flag is not.

**Re-measured static-check coverage**, superseding the numbers in the arms above. Widening
`packages/quereus/tsconfig.test.json`'s `include` by `bench/*.mjs` alone (the entry points;
`bench/suites/**` is `debt-bench-suites-outside-type-pass`'s half) and running
`npx tsc -p <scratch config> --noEmit` from `packages/quereus` gives **180 errors**:
`bench/run.mjs` 91, `bench/gate.mjs` 80, `bench/child.mjs` 9. Every one read during the
review was an annotation gap — `TS7006`/`TS7031` implicit-`any` parameters, `TS2339`
property access on an untyped `object` bag, two `WriteStream` fd-narrowing complaints from
the `--json` stream swap — and none was a real defect. That is the same shape the earlier
arms measured; the count grew because this ticket's code did. eslint still globs
`'src/**/*.ts' 'test/**/*.ts'`, so no `.mjs` under `bench/` is linted at all.
