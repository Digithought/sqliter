---
description: Even with good benchmarks, nothing compares today's numbers against yesterday's unless a person remembers to do it by hand; add a checked-in reference set and a single command that fails when performance gets worse.
prereq: bench-store-micro
files:
  - packages/quereus/bench/run.mjs                  # --baseline compare and the >20% exit-1 rule live here today
  - packages/quereus/bench/results/                 # timestamped output, currently gitignored
  - .gitignore                                      # line 26 excludes bench/results/
  - package.json                                    # `check` script - the full pre-release run the gate joins
  - docs/benchmarking.md                            # created by the harness ticket; documents the policy
  - docs/architecture.md                            # section 5 Benchmark Suite, section 6 Full Run (`yarn check`)
difficulty: medium
---

# Why

The benchmark harness can compare two runs, but only if someone hands it a previous
result file. Those files are written to a gitignored directory, so they exist only on the
machine that produced them and only until someone cleans up. There is no shared reference
point, no history, and no command that answers "did this branch make anything slower".

So in practice performance regressions are found when someone notices something feels
slow, which is the same as saying they are found late.

**Where the gate runs is already settled: `yarn check`.** That script is this project's
full run - documentation check, lint, build, typecheck, the full test suite against both
the memory and store backends, and the three strict-mode passes - and it is what gets run
before a release. There is deliberately no continuous-integration service, and this ticket
does not introduce one. The gate is one more step in the run that already exists.

That choice has a direct design consequence, which is the main thing this ticket has to
get right: **`yarn check` is already long, so the gate must be cheap.** A full timed
benchmark sweep does not belong in it. What belongs in it is the portable, fast half -
the work counters and the within-run ratios, which need no timing stabilization and no
statistical treatment because they are exact. The timed sweep stays a deliberate,
separately-invoked measurement.

# What to build

## A checked-in reference set

A file (or small set of files) in the repository holding the expected values, updated
deliberately by a human as part of a change that legitimately moves them. What goes in it
follows directly from which measurements are portable:

- **Work counters** - exact expected integers. These do not vary by machine, so they are
  checked in as exact values and any difference is a failure until a human says otherwise.
  This is the backbone of the gate.
- **Within-run ratios** - the twin-comparison guards that already exist in the execution
  suite as `ratioGuards`, generalized. A ratio between two benchmarks in the same run
  cancels out machine speed, so a bound on it is portable. Today there is exactly one such
  guard; the gate should make adding them routine and cheap.
- **Absolute wall-clock** - deliberately *not* part of the pass/fail set, or included only
  with order-of-magnitude bounds and a clear statement that they are the weakest signal.
  A checked-in millisecond figure is a promise about hardware that the repository cannot
  keep.

Store the reference set as data, not as prose, and make its provenance visible: which
commit, which environment, when, and by whom it was last accepted.

## Two commands, one of them cheap enough for `yarn check`

`yarn bench:check` (name to settle): run the benchmarks, compare against the checked-in
reference, print a report, exit non-zero on regression. It must be runnable by a developer
with no arguments and no prior result file. Complementary `yarn bench:accept` (or a flag)
updates the reference set from the current run, so accepting an intentional change is a
reviewable diff rather than a hand-edit.

The gating mode - counters and ratios, no timing stabilization - becomes a step in the
root `check` script, alongside `test:full` and the strict passes. Give it a runtime budget
and hold to it: if the fast mode cannot stay well under a minute on the memory backend
plus the in-memory store provider, it does not go in `check`, because a step that makes
the full run noticeably longer is the step people start skipping. Measure and report the
actual added time as part of this work; that number decides what stays in and what gets
demoted to the deliberate sweep.

`yarn check` runs on one developer machine at a time, not a shared runner, which makes the
timing half *more* trustworthy here than it would be in a hosted environment. That is not
a reason to gate on it - the reference set is still shared across machines - but it does
mean the deliberate sweep is worth running before a release, and its output is worth
reading even when the fast gate passes.

## A report a reviewer can act on

For each failure: what changed, by how much, which kind of measurement it was, and how
confident the harness is that it is real. A counter change should read as a hard fact
("this query now makes 3 storage round trips per row instead of 1"), a timing change as
what it is ("18% slower, within-run spread 11%, on a different CPU than the reference").
The report should also say what it *skipped* and why - a gate that silently drops the
benchmarks it could not run is worse than no gate, because it reads as green.

## Decide the relationship with the performance sentinels

`test/performance-sentinels.spec.ts` is a second, older performance-gating mechanism that
runs inside `yarn test` with generous absolute thresholds. Once a real gate exists, the
two should not drift apart. The reconciliation itself is filed separately
(`debt-perf-sentinels-share-bench-workloads`, backlog), but this ticket must at least
state the intended division of labor in `docs/benchmarking.md`: which system is
responsible for what, so the next person does not add the same check twice.

# Edge cases & interactions

- **A gate nobody can pass gets disabled.** If the reference set produces false failures,
  the gate will be routed around within a month. Bias hard toward counters and ratios,
  and toward reporting rather than failing on anything wall-clock.
- **Accepting a regression must be possible and visible.** Sometimes a change is worth
  being slower. The accept path must exist, must produce a diff a reviewer sees, and must
  carry a reason - a reference set that changes without explanation is a reference set
  nobody trusts.
- **Skipped benchmarks.** Unsupported backend, unstable spread, missing from the
  reference - each is a distinct outcome and each must be reported distinctly, never
  collapsed into silence.
- **A new benchmark has no reference entry.** That is not a failure; it is a prompt to
  accept. But a benchmark that *disappears* from a run while still present in the
  reference probably is a failure - it usually means it threw.
- **Dirty working tree.** A gate run against uncommitted changes should say so in the
  report rather than pretending to be a clean measurement of a commit.
- **Runtime budget.** The full suite, especially with a store backend, may take long
  enough to be annoying. The fast subset (counters and ratios only, no timing
  stabilization) is what joins `yarn check`; the full timed run stays a deliberate
  invocation. Measure the added time and state it.
- **`yarn check` ordering.** The gate needs a built `dist/` - the bench suites import from
  it directly - so it must land after `build` in the chain, not before. It also runs after
  `test:full`, which means a failing gate arrives at the end of a long run; the report has
  to be self-contained enough to act on without re-running.
- **A failing gate must not be the thing that blocks a release for a bad reason.** If the
  reference set is stale or the machine is loaded, the person running `check` needs an
  obvious, documented escape that is *visible* - a flag that reports without failing, not
  a quiet edit to the reference set.

# Not in scope

Introducing a continuous-integration service - this project deliberately uses `yarn check`
as its full run and has no CI. Adding benchmarks or metrics; those are the upstream
tickets.

## TODO

- Design the reference-set file format, including provenance metadata
- Decide exactly which measurement kinds are gating and which are informational; document the rule in `docs/benchmarking.md`
- Implement `yarn bench:check` - run, compare, report, exit non-zero on regression
- Implement the accept path so an intentional change is a reviewable diff carrying a reason
- Make the report distinguish counter facts from timing estimates, and report skips explicitly
- Generalize `ratioGuards` so adding a twin-comparison guard is routine; add guards for the shapes most prone to plan-shape regression
- Add a fast counters-and-ratios-only mode; measure its wall-clock cost and wire it into the root `check` script after `build`
- Add a report-without-failing escape flag, and document when to use it
- State the division of labor between the gate and `performance-sentinels.spec.ts`
- Update `docs/architecture.md` sections 5 and 6 to describe the gate and its place in the `check` chain

## Arm added by review of `bench-comparison-and-reporting`

**The wall-clock half of the current comparison cannot be gated on as it stands, and this
is now measured rather than suspected.** Two full 27-benchmark runs, minutes apart, same
commit, same machine, unchanged tree, reported two regressions and four improvements.
Almost every benchmark moved in the *same direction* between the two runs — a run-level
displacement, not per-benchmark noise — and the flagged benchmarks each had a tight 3-6%
within-run spread in *both* runs: a narrow distribution around a centre that had moved.

The noise floor `bench-comparison-and-reporting` shipped is built from within-run spreads,
so it is blind to exactly this. It is a real improvement on the flat 20% rule it replaced,
and it is not sufficient to fail a build on. This ticket's existing instinct — "bias hard
toward counters and ratios, and toward reporting rather than failing on anything
wall-clock" — is the right one, and this is the evidence for it.

If any wall-clock measurement is to gate at all, one of these has to come with it:

- take the median of N repeated runs per benchmark rather than one run's median (the honest
  fix; costs N× wall-clock),
- estimate the between-run displacement and subtract the common-mode shift before judging
  any individual benchmark,
- require a regression to reproduce across two consecutive comparison runs before gating.

The limitation is recorded at the code site (`NOTE:` on `noiseFloorPct` in
`bench/lib/stats.mjs`) and in `docs/benchmarking.md` § *Noise floor*, so nobody has to
rediscover it. It is not a separate ticket because the decision it forces is this ticket's.

## Arm added by review of `bench-counter-suite-passes`

**"Work counters do not vary by machine" is this ticket's load-bearing premise, and it is
currently an assumption rather than a measured fact.** The counters ticket verified
something narrower and should not be read as having settled it: 23 of 27 benchmarks
produced byte-identical counter blocks across three full runs (each benchmark in its own
forked process), but all three runs were the same machine, the same OS, and the same Node
version. Nothing has compared two different machines, and the reference set this ticket
proposes to check into the repository is exactly a cross-machine comparison.

There is a concrete mechanism by which the premise can be false, and it is in the engine
rather than in the harness. **Join-order enumeration is bounded by wall-clock time.**
`ruleQuickPickJoinEnumeration` (`src/planner/rules/join/rule-quickpick-enumeration.ts`)
loops `while (tours < maxTours && elapsed <= timeLimitMs)` with defaults `maxTours: 100`,
`timeLimitMs: 100`, `minTriggerCost: 0`, `enabled: true`
(`src/planner/optimizer-tuning.ts`). Each tour is itself deterministic — what varies is
*how many* tours finish inside 100 ms. A slower or busier machine therefore evaluates
fewer candidate orderings and can settle on a different join order, which is a different
plan, which is a different plan shape and different row counts. The rule only engages on
joins of **three or more relations**, and every join in the current benchmark suite is
two-relation, which is consistent with the three identical runs — the mechanism is real
but the suite does not reach it today.

Two consequences for this ticket:

- A checked-in counter reference is only as portable as the plan that produced it. Either
  the gate has to be scoped to benchmarks whose plans are provably budget-independent, or
  the engine's plan choice has to become reproducible first. The engine-side change is
  filed separately as `bug-join-order-depends-on-wall-clock`; this ticket should not ship
  a cross-machine exactness claim ahead of it.
- The premise deserves one real measurement before the reference set is trusted: the same
  commit, run on two machines that differ in speed, with the counter blocks diffed. Until
  that exists, "does not vary by machine" is a design intention.
