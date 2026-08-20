---
description: Check a set of expected engine work counts into the repository and add one command that re-measures them and fails when they no longer match, so a change that makes the engine do more work is caught the day it lands instead of months later.
files:
  - packages/quereus/bench/gate.mjs                 # NEW - thin entry point
  - packages/quereus/bench/lib/reference.mjs        # NEW - reference file read/write, eligibility, comparison
  - packages/quereus/bench/reference/               # NEW - the checked-in expected counts, one file per suite
  - packages/quereus/bench/lib/compare.mjs          # diffCounters / flattenCounters are reused as-is
  - packages/quereus/bench/lib/discover.mjs         # loadSuites, matchesFilter
  - packages/quereus/bench/lib/environment.mjs      # captureEnvironment - provenance and the dirty-tree report
  - packages/quereus/bench/child.mjs                # the phase/teardown pattern the pass should copy
  - packages/quereus/package.json                   # bench:gate / bench:accept scripts
  - packages/quereus/tsconfig.test.json             # bench/lib/** is inside the type pass; bench/*.mjs is not
  - packages/quereus/test/bench-gate.spec.ts        # NEW - pure-function tests, runs no benchmark
  - docs/benchmarking.md                            # new "Regression gate" section
difficulty: hard
---

# Why

The benchmark harness can already compare two runs, but only if someone hands it a
previous result file. Those files land in `packages/quereus/bench/results/`, which is
gitignored, so they exist only on the machine that produced them. There is no shared
reference point and no command that answers "did this branch make the engine do more
work".

This ticket builds that: a checked-in set of expected work counts, and a command that
re-measures them and fails when they differ.

# What is settled, and what it is settled on

Four design questions were open at plan time. Each was resolved by measurement on this
machine (Windows 11, Node v24.2.0, 12 cores) against the suite as it stands at
`c81ed14f3`. The numbers are recorded here so the implementer does not have to re-derive
them, and so a reviewer can check the reasoning rather than the conclusion.

## 1. Only work counters gate. Nothing about wall-clock does.

Two full 27-benchmark runs minutes apart on an unchanged tree produced two "regressions"
and four "improvements", each with a tight 3-6% within-run spread — a narrow distribution
around a centre that had moved between runs. The existing noise floor is built from
within-run spreads and is blind to that displacement by construction; the limitation is
already recorded at the code site (`noiseFloorPct` in `bench/lib/stats.mjs`) and in
`docs/benchmarking.md` under *Noise floor*.

So the gate does not time anything at all, and does not read `median_ms` from anywhere.
Ratio guards — the one wall-clock measurement that *is* portable, because both halves ran
on the same machine in the same run — are the follow-on ticket's job, not this one's.

## 2. The gate runs every benchmark in ONE process, not one process per benchmark

`bench/run.mjs` forks a worker per benchmark, and that is load-bearing for **timings**:
the instruction interpreter shares call sites across query shapes, so a benchmark's
measured speed depends on which benchmarks ran before it (measured at 0.37x-1.66x for the
same benchmark purely by position).

Work counters are not timings. They are counts of engine work, and nothing about
just-in-time compilation state changes how many instructions execute. That reasoning was
checked rather than assumed: a single-process pass over all 56 counter-declaring
benchmarks produced counter blocks **byte-identical to the forked run's for all 56**
(compared per benchmark against `bench/results/2026-08-19T19-06-31-262Z.json`; zero
differences).

The cost difference is why it matters:

| Mode | Wall-clock |
| --- | --- |
| one forked process per benchmark, counters only | 66.0 s |
| one process for all of them, counters only | 41.8 s / 44.3 s (two runs) |

The ~22 s saved is 75 process forks and 75 imports of `dist/`.

## 3. Runtime budget: ~42 s, measured, and where it goes

The plan ticket set a budget of "well under a minute on the memory backend plus the
in-memory store provider". The measured figure for the whole counters-only pass is
**41.8 s and 44.3 s across two runs** — 56 benchmarks run, 19 skipped (the opt-in LevelDB
rows, which decline in milliseconds). Breakdown from the second run:

| Group | Rows | Wall-clock |
| --- | --- | --- |
| `execution@store-mem` | 15 | 19.5 s |
| `store` (no backend dimension) | 14 | 13.2 s |
| `execution` (memory) | 15 | 5.0 s |
| `mutation@store-mem` | 4 | 3.2 s |
| `mutation` (memory) | 4 | 1.0 s |
| `planner` | 4 | ~0.0 s |

That is inside the budget, so the whole counter-declaring set is the gate's default scope.
The dominant cost is fixture population: an `execution@store-mem` row spends ~600 ms
building its 10 000-row fixture and ~750 ms in the counters pass, which builds a *second*
database over the counting provider and populates it again. If the figure ever has to come
down, sharing one populated counting database across the read-only `execution` workloads is
the lever — record that as a `NOTE:` at the site that drives the pass, not as a ticket.

## 4. Cross-machine exactness: the one known mechanism is excluded mechanically

"Work counters do not vary by machine" is this gate's load-bearing premise, and nothing has
yet compared counter blocks from two different machines. There is one known mechanism by
which it can be false, and it is in the engine: `ruleQuickPickJoinEnumeration`
(`src/planner/rules/join/rule-quickpick-enumeration.ts`) stops enumerating candidate join
orders when either 100 candidates or **100 milliseconds** are used up, whichever comes
first. A slower or busier machine evaluates fewer orderings and can settle on a different
plan — a different plan shape and different counts. It is filed as
`bug-join-order-depends-on-wall-clock` (backlog) and is not this ticket's to fix.

The rule engages only on joins of **three or more relations**, which appear in a plan as
**two or more join nodes**. Every benchmark in the suite today has at most one: a census
over a full results file found `HashJoin: 1` on eight benchmarks and nothing higher.

So the gate refuses to gate on a benchmark whose observed plan carries two or more join
nodes, and says so in its report. Today that excludes nothing, which is the point — it
costs no coverage now and it means the premise cannot quietly become false when someone
adds a three-way-join benchmark.

# Architecture

## Where the code goes

`bench/lib/**` is inside the type pass (`tsconfig.test.json` includes it); `bench/*.mjs` is
not. So `bench/gate.mjs` is a thin entry point — argument parsing and process exit — and
every rule lives in `bench/lib/reference.mjs`, where `checkJs` sees it and a test can
import it.

Reuse, do not reimplement: `flattenCounters` and `diffCounters` (`bench/lib/compare.mjs`)
already define what a counter difference is; `loadSuites` and `matchesFilter`
(`bench/lib/discover.mjs`) already define enumeration and filtering; `captureEnvironment`
(`bench/lib/environment.mjs`) already defines provenance and the dirty-tree tri-state.

## The reference set

One file per suite, `packages/quereus/bench/reference/<suite>.json`, pretty-printed with
tab indentation and **sorted keys**, so a change is a readable diff. `bench/reference/` is
not gitignored (`.gitignore` excludes only `bench/results/`), so no ignore change is
needed.

```json
{
	"suite": "execution",
	"accepted": {
		"commit": "9dd90e02d",
		"date": "2026-08-19T19:06:31.262Z",
		"by": "Nathan Allan <n8owlin@gmail.com>",
		"node": "v24.2.0",
		"platform": "win32",
		"reason": "hash join now probes the build side once per batch instead of once per row"
	},
	"benchmarks": {
		"full-scan-10k": { "gated": true, "counters": { "…": "the block verbatim" } },
		"join-1kx1k": {
			"gated": false,
			"ungatedReason": "plan has 2 or more join nodes; join order is chosen under a wall-clock budget, so these counts are not provably the same on another machine (bug-join-order-depends-on-wall-clock)",
			"counters": { "…": "recorded anyway, so a change is still visible" }
		}
	}
}
```

Sizes measured from a full run: `execution` 27.6 KB, `store` 50.4 KB, `mutation` 13.5 KB,
`planner` 0.6 KB compact — roughly 2x that pretty-printed. Large but unremarkable for git.

`by` comes from `git config user.name` / `user.email`, and is omitted rather than guessed
when git cannot answer — the same defensive treatment `environment.mjs` already gives git.

**Accept rewrites only the files whose benchmark contents actually changed.** A suite whose
counts did not move keeps its old `accepted` block, so git history says when each suite's
expectations last moved and why — which is what a provenance field is for, and what a
blanket rewrite would destroy.

## Gate eligibility is recomputed every run

`gated` in the reference file is documentation of the last accept, never the authority. The
gate recomputes eligibility from **this run's** observed counters:

- Walk the counter block for every nested `plan.nodeTypes` object. Blocks nest: a
  `@store-mem` row reports `{ engine, store }`, and `snapshotStatements` returns a named
  bag of snapshots.
- Sum the values of every key matching `/Join$/` — today `Join`, `NestedLoopJoin`,
  `HashJoin`, `MergeJoin`, `KeySetSemiJoin`, `FanOutLookupJoin`, all from `PlanNodeType`.
- Two or more in any one plan means **not gated**, with the reason above.

Recomputing rather than trusting the file is what stops a benchmark that *becomes* a
three-way join from keeping a stale `gated: true`. The cost is that a benchmark can stop
gating without anyone accepting anything — so every ungated benchmark is **named
individually in the report on every run**, never collapsed into a count.

## Outcomes

Each is reported distinctly; none is ever collapsed into silence.

| Outcome | Meaning | Fails? |
| --- | --- | --- |
| `match` | counters identical to the reference | no |
| `differs` | at least one count differs, benchmark is gate-eligible | **yes** |
| `ungated` | counts recorded, but the plan may be budget-dependent (above) | no |
| `new` | ran, absent from the reference — a prompt to accept | no |
| `missing` | in the reference, produced no result this run | **yes** |
| `skipped` | the benchmark's `skip()` declined (the LevelDB rows) | no |
| `filtered` | excluded by `--filter` | no |
| `failed` | threw during skip / setup / counters / teardown | **yes** |

`missing` fails because the usual cause is a benchmark that threw before reporting. A
rename or a deliberate removal produces it too, so the message must say so: *"if you
renamed or removed it, run `yarn bench:accept`"*.

**No reference file at all, for a suite that produced results, is a failure** — distinct
from `new`. Otherwise deleting `bench/reference/` makes the gate green forever.

## The report

A gated failure has to be actionable without re-running, because in the follow-on ticket
this runs inside a long `yarn check`. For each `differs` benchmark, print every changed
path as `path  before -> after`, capped at 12 lines per benchmark with the elision
**announced** (the same rule and constant `run.mjs` uses for its counter block), and the
full list available under `--json`.

The counts read as facts, not estimates — "this benchmark issued 10 batched storage reads
where the reference has 1" — because they are exact integers. Never a percentage.

The report header states the environment, the commit, whether the working tree is dirty (a
gate run against uncommitted changes is not a clean measurement of a commit and must say
so), and how many benchmarks were skipped, filtered and ungated, and why.

## `--accept`

`yarn bench:accept --reason "<text>"` runs the same pass and writes the reference.

- **`--reason` is required.** A reference set that changes without a recorded reason is a
  reference set nobody trusts. Refuse without it.
- **Refuse on a dirty working tree** unless `--allow-dirty` is passed, because the recorded
  provenance commit would otherwise be a lie. Say which flag lifts it.
- Write atomically (temp file, then rename) — a concurrent gate run must never read half a
  file.
- Print what it changed, per benchmark, in the same `before -> after` form the gate uses.
  The git diff is the deliverable; the printed summary is the explanation.

## The LevelDB opt-in

`gate.mjs` **deletes `QUEREUS_BENCH_LEVELDB` from `process.env` before loading suites**, and
says in its report when it was set. A developer with it exported in their shell must not
silently add ~75 s of disk-bound work to a gate that cannot use the result: those rows are
`informational`, and an advisory number never gates.

# Edge cases & interactions

- **Single-process contamination.** The one risk the forked design did not have. A
  benchmark that leaves a database open, or mutates module-level state its neighbours read,
  changes the next benchmark's counts. Measured clean today (56/56 byte-identical), so ship
  it — with `teardown` run even when a phase throws (copy `child.mjs`'s phase pattern), a
  failing benchmark recorded and the pass continuing, and a `NOTE:` at the site saying what
  the in-process choice rests on and that a counter block differing between `yarn bench` and
  `yarn bench:gate` is the signal it stopped holding.
- **A benchmark that throws mid-pass** must not abort the run: record it as `failed`, run
  its `teardown` best-effort, keep going, fail at the end. A single abort would report every
  later benchmark as `missing`, which is a different and false claim.
- **`--filter` must not manufacture failures.** A filtered-out benchmark is `filtered`, not
  `missing`. Decide it with `matchesFilter`, the existing single definition of what
  `--filter` means — a second substring test would agree until one of them grew a glob.
- **A counter block carrying a non-deterministic value** (a path, a timestamp) would differ
  on every run and read as a permanent regression. Nothing does today. If one appears the
  gate reports it as a difference like any other; the fix belongs to the benchmark.
- **Both directions of "no counters".** A benchmark that declares no `counters()` is not in
  the gate's scope at all and must never appear as `missing`; the reference only ever holds
  benchmarks that declared one.
- **Empty or malformed reference file** — refuse with a usage error naming the file, the way
  `loadBaseline` refuses a shapeless baseline. Never fall back to "no reference, so pass".
- **Two accepts racing**, or an accept racing a gate: the atomic rename covers the reader.
  Two concurrent accepts is last-writer-wins and out of scope; say so in a comment.
- **Line endings.** These files are diffed by humans on Windows and Linux; write `\n` and
  let `.editorconfig` and git handle the rest, exactly as `writeResults` does today.

# Tests

`packages/quereus/test/bench-gate.spec.ts`, alongside the existing
`bench-comparison.spec.ts` and `bench-backends.spec.ts`. **It runs no benchmark** — every
rule below is a pure function over plain objects, which is why they belong in
`bench/lib/reference.mjs`:

- eligibility: one join node is gated; two in one plan is not; two spread across *different*
  nested plans (an `{engine, store}` block, a named statement bag) is not; a block with no
  `plan` at all is gated.
- outcome classification: identical blocks give `match`; one changed integer gives
  `differs`; in-run-not-in-reference gives `new`; in-reference-not-in-run gives `missing`;
  excluded by a filter gives `filtered`, asserted against a filter that excludes it.
- exit rule: `differs` on a gated benchmark, `missing`, and `failed` each fail; `new`,
  `skipped`, `filtered` and `ungated` alone do not.
- a suite that produced results with **no reference file** fails, and is distinguishable in
  the report from a suite whose reference exists and simply lacks this benchmark.
- accept refuses with no `--reason`, and refuses on a dirty tree without `--allow-dirty`.
- accept leaves an unchanged suite's `accepted` block byte-identical.
- the report elides at 12 changed paths per benchmark and says that it did.

# Not in scope

Ratio guards, the `yarn check` wiring, the report-without-failing escape flag, and the
statement of how this relates to `test/performance-sentinels.spec.ts` — all in the
follow-on ticket `bench-gate-ratios-and-check`. Introducing a continuous-integration
service: this project deliberately has none.

# Prior session learnings (investigation only — no code was written)

A previous agent run hit its token budget during discovery. Everything below was read
and verified in that session; trust it and skip straight to writing code.

## Census confirmed against the suites as they stand

Counter-declaring benchmarks: `execution` 15 workloads x 3 backends = 45, `mutation`
4 x 3 = 12, `planner` 4, `store` hot-path rows 14 — 75 total, of which the 19
`@store-leveldb` rows (15 execution + 4 mutation) always skip once the gate deletes
`QUEREUS_BENCH_LEVELDB`. 56 run, matching the ticket's measured figures. `parser` and
the `store` key-encoding / leveldb-read-cost rows declare no `counters()` and are out
of scope entirely.

## The pass shape is settled: skip → setup → counters → teardown, never `fn`

Verified in every suite: no `counters()` depends on the timed loop having run.
Execution memory rows snapshot against the `setup`-built database; counting backends
(`store-mem`) build their own second database *inside* `counters()`; mutation
`own-database` rows open their own; planner uses the `setup` database; store hot-path
rows build a counting database inside `counters()`. So the gate runs each benchmark's
`skip()` → `setup()` → `counters()` → `teardown()` in one process and never calls `fn`.
Copy `child.mjs`'s phase tracking (`let phase = 'setup'` … reassigned per step) and its
best-effort teardown-after-failure block, and its `runCountersPass` JSON round-trip
(`JSON.parse(JSON.stringify(raw))` + plain-object validation) so gate blocks are
byte-identical to what `yarn bench` records.

## Decisions resolved during investigation (adopt unless contradicted)

- **The 12-line elision constant**: `COUNTER_CHANGES_SHOWN = 12` is module-local in
  `run.mjs`. Export it from `reference.mjs` and change `run.mjs` to import it — one
  line, keeps the two literally one constant.
- **skip beats missing**: a reference entry whose benchmark *skipped* this run
  classifies `skipped`, never `missing` — same precedent as `compareRun` adding to
  `seen` before the skip check. The report still names every skipped row and reason.
  (Consequence: an unbuilt store package makes the store-suite rows skip and the gate
  passes; the header's skip count is the visibility.)
- **`--accept` refuses `--filter`** with a usage error: accept always re-measures
  everything (~42 s), avoiding partial-reference merge logic and half-written files.
  A rename/removal is then handled naturally by the full re-measure.
- **Accept on `dirty === 'unknown'`** (outside a git checkout): allow — provenance
  records `unknown`/omitted honestly. Refuse only `dirty === true` without
  `--allow-dirty`.
- **The reference holds only benchmarks that produced counter blocks** — skipped rows
  are never recorded, so the LevelDB rows never appear in any reference file.

## Verified environment facts

- Root `.gitignore` line 26 excludes only `packages/quereus/bench/results/` —
  `bench/reference/` needs no ignore change (confirmed, as the ticket said).
- `tsconfig.test.json` `include` already carries `bench/lib/**/*` — `reference.mjs`
  lands inside the type pass with no config change; `bench/gate.mjs` stays outside.
- Test style to copy: `test/bench-comparison.spec.ts` — chai `expect`, plain-object
  fixtures, direct `.mjs` imports, small builder helpers (`entry`, `row`,
  `counterBlock`). Its `counterBlock` fixture shows the `WorkCounterSnapshot` shape:
  `{ plan: { nodeCount, nodeTypes }, instructions: [...], tables: {...}, totals: {...} }`.

## The ONE unresolved item — check before writing the eligibility walk

The exact return shape of `Statement.getPlanShape()` (planner suite's whole counter
block) was NOT yet confirmed. If `PlanShape` is `{ nodeCount, nodeTypes }` at the
ROOT — i.e. `nodeTypes` NOT nested under a `plan` key — then a walk that looks only
for `plan.nodeTypes` pairs would silently never examine planner-suite blocks (they
would all read as "no plan ⇒ gated", which happens to be the right answer today but
for the wrong reason, and would go quietly wrong the day a planner row gains a
three-way join). Grep `getPlanShape`/`PlanShape` in `src/` first, then write the walk
as: any object member whose value is an object containing a `nodeTypes`
plain-object-of-numbers counts as ONE plan (this catches both `plan: {nodeTypes}`
nested at any depth and a bare `PlanShape` root). Sum `/Join$/` keys per plan; two or
more in any one plan ⇒ ungated.

## TODO

- Add `bench/lib/reference.mjs`: reference file read/write (sorted keys, tab-indented, atomic write), provenance capture, the join-node eligibility rule, outcome classification, and the exit rule — as pure functions over plain objects wherever the input allows
- Add `bench/gate.mjs`: argument parsing (`--filter`, `--json`, `--accept`, `--reason`, `--allow-dirty`), the single-process counters pass, the report, the exit code; delete `QUEREUS_BENCH_LEVELDB` from `process.env` before loading suites and say so when it was set
- Run `teardown` even when a phase throws; record the failure and continue the pass
- Add `bench:gate` and `bench:accept` to `packages/quereus/package.json`
- Generate and commit `bench/reference/*.json` for all four counter-declaring suites, with an `accepted.reason` naming this ticket
- Add `test/bench-gate.spec.ts` covering the cases listed above; run no benchmark from it
- Add the `NOTE:` on the single-process choice, and the `NOTE:` on the fixture-population cost lever
- Write `docs/benchmarking.md` section *Regression gate*: what the reference set is, what gates and what does not, the accept path, the measured ~42 s cost, and why counters and not wall-clock
- Verify with `yarn bench:gate` on a clean tree (expect exit 0), then again after a deliberate one-line change to a plan rule (expect a named, readable difference and exit 1), then revert that change
