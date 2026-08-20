---
description: A set of expected engine work counts is now checked into the repository, with one command that re-measures them and fails when they no longer match — reviewed, with a hole in the "you cannot switch this gate off" guarantee closed.
files:
  - packages/quereus/bench/gate.mjs                 # entry point: flags, single-process pass, report, exit code
  - packages/quereus/bench/lib/reference.mjs        # all gate rules as pure functions (inside strict checkJs)
  - packages/quereus/bench/reference/*.json         # checked-in expected counts, one per suite (4 files, 56 entries)
  - packages/quereus/bench/lib/counters.mjs         # runCountersPass shared by child.mjs and gate.mjs
  - packages/quereus/bench/run.mjs                  # now shares the gate's counter-change renderer
  - packages/quereus/test/bench-gate.spec.ts        # 47 tests, pure functions only, runs no benchmark
  - docs/benchmarking.md                            # "Regression gate" section
  - docs/architecture.md                            # counters bullet: `yarn bench` still never gates, `bench:gate` does
difficulty: medium
---

# What shipped

`yarn bench:gate` re-runs every counter-declaring benchmark (56 run, 19 LevelDB rows always
skip) in one process, compares each counter block for exact equality against
`bench/reference/<suite>.json`, and exits non-zero on any difference. `yarn bench:accept
--reason "<why>"` re-measures and rewrites only the reference files whose contents changed,
recording provenance (commit, date, node, platform, git user, reason). Nothing about
wall-clock is measured or gated; that half is `bench-gate-ratios-and-check`, in implement/.

Design detail lives in `docs/benchmarking.md` § *Regression gate*. The implement ticket's
rationale (cost tables, the single-process determinism proof) is in git history of
`tickets/implement/4-bench-gate-reference.md`.

# Review findings

Reviewed the implement diff (`64644950a^..8f2a975a3`, 16 files) before reading the handoff.
Ran lint, the full test suite, the gate itself, and eleven adversarial probes against the
CLI and the reference files.

## Verified, no action

- **Gate works end to end.** Full run: 56 match / 0 differs / 19 skipped / exit 0, 41.3 s —
  reproduces the handoff's claim on this machine.
- **It fails when it should.** Mutating one integer in `bench/reference/planner.json`
  produced `planner/aggregate-plan — 1 count(s) differ / nodeCount 99 -> 8`, exit 1.
- **Every refusal path fires with an actionable message**: `--reason` without `--accept`,
  `--allow-dirty` without `--accept`, `--accept --filter`, an unknown flag, a flag missing
  its value, a filter matching nothing, malformed JSON in a reference file. All exit 1.
- **The `/Join$/` eligibility rule matches the engine.** All six `PlanNodeType` members
  naming a join end in `Join`; no counterexample exists today.
- **The docs' "nothing is excluded today" claim is true.** Every join-bearing reference
  entry (6 in `execution`, 2 in `planner`) carries exactly one `HashJoin`; zero entries are
  recorded ungated.
- **The provenance commit is honest.** `bench/reference/*.json` record commit `a8999c107`,
  two commits behind the branch tip. `git diff a8999c107 HEAD -- packages/quereus/src
  packages/quereus-store packages/quereus-isolation` is empty, so those counts are still
  HEAD's counts. The handoff's suggested remedy — re-run `bench:accept` for cleaner
  provenance — would in fact do nothing: `nextReference` returns the previous file verbatim
  when the benchmark contents are unchanged, so an accept can never refresh provenance
  alone. That is the right design (it keeps each file's `accepted` block meaning "when
  these expectations last moved"); the handoff's note is simply moot.
- **The per-plan join rule (handoff review point 1) is the right reading** and is the one
  that matches the mechanism. Agreed as implemented.

## Found and fixed in this pass

- **The gate could be switched off by emptying a reference file, and reported green.**
  `bench/reference/planner.json` rewritten to `{"suite":"planner","benchmarks":{}}` made all
  four planner benchmarks classify as `new` — a benign outcome — so the gate exited 0. The
  code guarded a *deleted* file but not an *emptied* one, which is the same hole reached by
  a bad merge, a truncated write, or one keystroke of intent. The scope rule that decides
  this lived in `gate.mjs`, outside the type-checked, tested `lib/`, which is also why no
  test caught it. Fixed both halves: the rule is now `referenceIsAbsent` in
  `lib/reference.mjs` with four tests, `gate.mjs` calls it, and the report names which of
  the two conditions tripped. Re-probed: emptied file now exits 1. A *partial* deletion
  still reads as `new` and passes — from inside one run a removed expectation and a new
  benchmark are indistinguishable — so that residue is written down as a `NOTE:` on
  `gateFails` and stated plainly in the docs rather than papered over.
- **`run.mjs` had a second copy of the counter-change renderer.** The implement pass moved
  `COUNTER_CHANGES_SHOWN` into `reference.mjs` and imported it back, but left `run.mjs`
  rendering its own `path  before -> after` lines with its own `fmtCounterValue`. Now both
  call `formatChangeLines`, which grew a `more` option because each caller points at a
  different uncapped list. Verified against a doctored baseline: output is byte-identical
  to before.
- **`docs/architecture.md` still said work counters are "never gated on".** That was true
  before this ticket and is now false. Updated to distinguish `yarn bench` (still advisory,
  deliberately) from `yarn bench:gate`.
- **Nothing bounded the gate's exit.** `child.mjs` force-exits 250 ms after reporting so a
  benchmark that leaked a timer or an open database cannot wedge the run, and `run.mjs`
  kills a child after 120 s. The single-process gate had neither, so one leaked handle would
  hang `yarn bench:gate` forever with no timeout at all. Added the same unref'd force-exit.
  It bounds the exit, not the run — see the tripwire below.
- **A failed accept left litter in a checked-in directory.** `writeReference` wrote
  `<suite>.json.tmp-<pid>` then renamed; a throw in between left the temp file in
  `bench/reference/`, which is not gitignored. Now removed on failure, without masking the
  original error.
- **A byte-order mark made a reference file unreadable** with a mojibake error message —
  reachable by editing one of these files in a Windows editor. `parseReference` now strips a
  leading BOM. Tested.
- **`buildReferenceBenchmarks` re-scanned `rows` per name** (`rows.find` inside a loop over
  sorted names, plus a redundant re-check). Replaced with one sorted pass; behaviour
  identical, covered by the existing tests.
- **The failure banner over-claimed.** "GATE FAILED — the engine does different work" also
  printed for `missing`, `failed`, and an absent reference. Reworded.

## Test coverage added

`test/bench-gate.spec.ts` went 38 → 47. New: the four `referenceIsAbsent` cases; the
harness-bug row that carries no block, no skip and no failure (must be loud, not a match);
BOM tolerance; the `more` option; `absent` rendering for a one-sided path; an empty change
list. All still pure — no test runs a benchmark.

## Tripwires recorded (conditional; not tickets)

- `NOTE:` on `JOIN_KEY` in `lib/reference.mjs` — the join-detection regex rides a naming
  convention the type system does not enforce. A future join node not named `*Join` would
  count as zero joins and keep gating on counts the join-order rule's wall-clock budget can
  move; if one ever lands, the regex has to become an explicit list.
- `NOTE:` on `gateFails` — the absent-reference guard covers a wholly-emptied suite, not a
  partially-edited one; the defense there is that `bench/reference/` is checked in and
  reviewed.
- `NOTE:` on `finishCleanly` in `gate.mjs` — the force-exit bounds the exit, not the pass.
  Nothing can interrupt a benchmark that hangs inside `setup` or `counters()`, where the
  forked runner would kill the child at 120 s. If that ever happens, the honest fix is to
  run the pass in a killable child, not a `Promise.race` that reports a row failed while the
  stuck work keeps running.
- Carried forward from implement, still accurate: the single-process premise and the
  fixture-population cost, both `NOTE:`d at the pass loop in `gate.mjs`.

## Known gaps, deliberately left

- **`gate.mjs` is not type-checked or linted.** `yarn lint` covers `src/**/*.ts`,
  `test/**/*.ts` and (via `tsconfig.test.json`) `bench/lib/**` and `bench/workloads/**`;
  everything at `bench/` root — `run.mjs`, `child.mjs` and now `gate.mjs` — is outside it.
  Measured: adding `bench/gate.mjs` to the type pass produces 43 errors, almost all missing
  JSDoc parameter types. That is a pre-existing convention for this harness, not something
  this ticket introduced, and the implementer's answer — keep every decision rule in
  `lib/`, where the type pass and the spec both reach it — is the right one. This review
  moved one more rule across that line for exactly that reason.
- **Cross-machine counter identity remains an assumption.** No second machine has run the
  gate. The multi-join exclusion removes the one known mechanism
  (`bug-join-order-depends-on-wall-clock`, backlog); the first CI-or-colleague run is the
  real test.
- **Two concurrent accepts are last-writer-wins**, documented at the write site. The atomic
  rename only protects readers.

## No new tickets filed

Every finding resolved inline. Nothing rose to a major finding: the one real defect (the
emptied-reference hole) had a single named site and a two-line invariant that retires the
class, so it was fixed here rather than queued.

# Validation

All on Windows 11, node v24.2.0, at `8f2a975a3` plus this review's changes.

- `yarn workspace @quereus/quereus lint` — clean (includes the strict-checkJs pass over
  `bench/lib/`).
- `yarn workspace @quereus/quereus test` — **9939 passing, 25 pending, 0 failing**.
- `yarn workspace @quereus/quereus bench:gate` — 56 match / 0 differs / exit 0, both before
  and after the changes.
- Eleven CLI and reference-file probes, listed above; the two that must fail now do.
- `yarn bench --filter planner/simple-scan-plan --baseline <doctored>` — the shared renderer
  prints `nodeCount  4242 -> 10`, unchanged from the old inline code.
