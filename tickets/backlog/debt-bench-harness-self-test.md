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
