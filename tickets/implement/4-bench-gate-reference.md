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

## RESOLVED: `getPlanShape()` returns a BARE `PlanShape` at the root

Confirmed in `src/runtime/work-counters.ts` (`PlanShape` interface, `computePlanShape`)
and `src/core/statement.ts` (`getPlanShape()`): the shape is `{ nodeCount, nodeTypes }`
with `nodeTypes` a `Record<string, number>` — NOT nested under a `plan` key. So the
planner suite's whole counter block is a bare `PlanShape`, and a walk that only looked
for `plan.nodeTypes` pairs would never examine it. Write the eligibility walk as
planned: any object whose value carries a `nodeTypes` plain-object-of-numbers member
counts as ONE plan (catches both `plan: {nodeTypes}` nested at any depth and the bare
root). Sum keys matching `/Join$/` per plan; two or more in any ONE plan ⇒ ungated.
Do not recurse INTO a matched plan object — nothing nests inside one.

# Session 2 learnings (investigation complete — start writing code immediately)

A second agent run confirmed the last open question (above) and settled the module
design, then hit its token budget before writing code. Nothing below needs re-checking.

## Additional verified facts

- `packages/quereus/tsconfig.json` sets `allowJs: true, checkJs: true, strict: true` —
  `reference.mjs` must carry full JSDoc types in the style of `bench/lib/compare.mjs`
  (typedefs, `@param`/`@returns` on everything) or `yarn lint`'s tsc pass fails.
- `LEVELDB_ENV_VAR = 'QUEREUS_BENCH_LEVELDB'` is already exported from
  `bench/lib/leveldb-backend.mjs` — import it in `gate.mjs`, don't restate the literal.
- `environment.mjs`'s `git()` helper (defensive: never throws, 5 s timeout, cwd pinned
  to the checkout holding the file) is module-private. Export it and use it for
  `git config user.name` / `user.email` in provenance capture — do not write a second
  git wrapper.
- `child.mjs`'s `runCountersPass` (JSON round-trip + plain-object validation) is local
  to `child.mjs`. Move it into `bench/lib/counters.mjs` as an export and import it from
  both `child.mjs` and `gate.mjs` — one definition, and `counters.mjs` has no runtime
  `dist/` import so the parent-side import stays safe.
- `COUNTER_CHANGES_SHOWN = 12` lives at `run.mjs:65`; move to `reference.mjs`, import
  back into `run.mjs`.
- Counter-block nesting shapes, confirmed in the suites: execution/mutation
  `@store-mem` rows return `{ engine: WorkCounterSnapshot, store: {...} }`;
  `snapshotStatements` returns a named bag of snapshots; planner returns a bare
  `PlanShape`; store hot-path rows return snapshots (some with asserted store blocks).

## Settled `bench/lib/reference.mjs` API (pure over plain objects except I/O)

- `COUNTER_CHANGES_SHOWN = 12`; `referencePath(suiteName)` → `bench/reference/<suite>.json`.
- `countJoinNodesPerPlan(counters): number[]` and
  `gateEligibility(counters): {gated:true} | {gated:false, ungatedReason:string}`.
- `OUTCOME_ORDER = ['match','differs','ungated','new','missing','skipped','filtered','failed']`.
- `classifySuite(suiteName, rows, referenceBenchmarks, filter)` — rows shaped
  `{name, fullName, counters?, skipped?:{reason}, failure?:{phase,error}}`. Mirrors
  `compareRun`: add to `seen` first; skipped → `skipped` (beats missing); failure →
  `failed`; absent from reference → `new`; else recompute eligibility from THIS run's
  block, then `diffCounters(reference, observed)` → `match`/`differs`/`ungated` (ungated
  still carries its changes for the report). Leftover reference names → `filtered` via
  `matchesFilter` on `suite/name`, else `missing`.
- `gateFails(outcomes, suitesMissingReference): boolean` — any `differs`/`missing`/
  `failed`, or any suite that produced ≥1 counter block with no reference file.
- `validateAccept({reason, filter, dirty, allowDirty}): string|null` — usage-error
  message or null; refuses empty/absent reason, any `--filter`, `dirty === true`
  without `--allow-dirty`; allows `dirty === 'unknown'`.
- `buildReferenceBenchmarks(rows)` — only rows with counter blocks; entries
  `{gated, ungatedReason?, counters}`, names sorted.
- `nextReference(previous, suite, benchmarks, accepted): {changed, reference}` —
  returns `previous` verbatim when the benchmarks section is deep-equal, so an
  unchanged suite's file is not rewritten at all (satisfies the byte-identical
  `accepted`-block requirement).
- `serializeReference(ref)` — fixed top-level order (`suite`, `accepted`,
  `benchmarks`), deep-sorted keys inside, tab indent, trailing `\n`. Key order never
  affects comparison (diffCounters is path-based).
- `parseReference(text, filePath)` — throws naming the file on malformed/shapeless
  input (the `loadBaseline` precedent); an absent file is a separate outcome.
- `captureAcceptance(reason, environment)` — commit/date/node/platform/reason, plus
  `by` from git config, omitted (never guessed) when git cannot answer.
- `formatChangeLines(changes, cap)` — `path  before -> after` lines with announced
  elision; shared by the gate report and the accept summary.
- Atomic write: temp file beside the target, then `fs.rename` (overwrites on Windows).

## Settled `bench/gate.mjs` decisions (beyond the ticket text)

- Selection = `bench.counters !== undefined` && `matchesFilter`; zero matches → usage
  error (`run.mjs` precedent, `UsageError`-style single line).
- Print one progress line per benchmark — a 42 s silent run reads as a hang.
- **Accept refuses when any benchmark FAILED during the pass**: a reference written
  minus a failing benchmark would classify it `new` on later runs and bury the failure.
- Accept never deletes reference files. A reference file naming a suite that no longer
  exists (orphan) is reported as an error naming the file and fails the gate — a human
  deletes it. This closes the "delete a suite, gate stays green forever" hole; a suite
  whose rows merely all SKIP is untouched by this rule (skip beats missing, and suite
  "produced results" means ≥1 counter block).
- `--json`: outcome object on stdout, human lines on stderr (`run.mjs` routing).
- Both `NOTE:`s land at the pass loop in `gate.mjs`: the single-process premise (56/56
  byte-identical vs forked; a block differing between `yarn bench` and `yarn bench:gate`
  is the signal it stopped holding) and the fixture-population cost lever (share one
  populated counting database across read-only execution workloads if ~42 s must drop).
- package.json: `"bench:gate": "node bench/gate.mjs"`,
  `"bench:accept": "node bench/gate.mjs --accept"`.

# Session 3 learnings (investigation FINISHED — write code, run nothing exploratory)

A third run re-read every file named above and hit its soft budget before writing code.
All prior-session facts held up. Do **not** re-read `run.mjs`, `child.mjs`,
`compare.mjs`, `discover.mjs`, `environment.mjs`, `counters.mjs`,
`leveldb-backend.mjs`, `tsconfig.test.json`, `package.json`, `docs/benchmarking.md`,
or `test/bench-comparison.spec.ts` beyond what an edit itself requires — start with
`Write` on `bench/lib/reference.mjs`.

## New verified facts

- `bench/lib/store-counters.mjs:47` statically imports `../../dist/src/index.js` (the
  ENGINE dist — the lazy import discipline is only about `@quereus/store`). So
  `gate.mjs` importing `LEVELDB_ENV_VAR` from `leveldb-backend.mjs` (whose import chain
  reaches store-counters) is fine in the parent, but the gate needs
  `packages/quereus/dist` built — the same requirement `yarn bench` already has.
- `tempdir.mjs` imports only node builtins. Root `.gitignore` re-confirmed: only
  `packages/quereus/bench/results/` (line 26).
- `counters.mjs`'s existing `dist/` references are JSDoc type-imports only — adding
  `runCountersPass` there keeps it runtime-import-free as planned.

## Two design calls made this session (adopt; flag both in the review handoff)

1. **Eligibility test-bullet ambiguity resolved in favor of the per-plan rule.** The
   test list's "two spread across different nested plans … is not" reads ambiguously;
   the normative rule is stated twice in this ticket ("two or more in any ONE plan ⇒
   ungated") and matches the mechanism — the quickpick budget engages only on 2+ join
   nodes within one plan. So: two plans carrying one join node each ⇒ **gated**. Write
   that test asserting `gated: true`, with a comment explaining why.
2. **Accept must not destroy a reference when rows skip.** Gap in the settled design:
   with `@quereus/store` dist unbuilt, every store-suite row SKIPS under `--accept`;
   `buildReferenceBenchmarks` would return an empty map and `nextReference` would
   rewrite `store.json` to empty — silently deleting all expectations. Close it with a
   pure, tested `validateAcceptAfterPass(measured)` in `reference.mjs`, where
   `measured = [{suiteName, rows, previous}]`: refuse when (a) any row failed (already
   settled), or (b) any SKIPPED row's name has an entry in that suite's previous
   reference — message names the benchmark, the skip reason, and the fix (usually
   `yarn build`). LevelDB rows never have reference entries, so they skip freely.
   Also: run the orphan-reference check (reference file whose name matches no loaded
   suite) BEFORE the ~42 s pass in accept mode and refuse (a human deletes the file);
   gate mode reports orphans at the end and fails.

## Settled gate.mjs driving loop (beyond session 2)

- Iterate ALL loaded suites; a suite is in scope when it has selected counter-declaring
  rows OR a reference file exists. Per suite:
  - no reference + ≥1 counter block produced → add to `missing_references` (fails);
    still classify rows against `{}` so blocks read `new` and skips are named.
  - no reference + rows all skipped/empty → classify (skips named) or skip entirely
    when there are zero rows.
  - reference + zero selected rows → classify with empty rows: filter active →
    entries `filtered`; no filter → `missing` (correct signal for a benchmark whose
    `counters()` was deleted).
- `listReferenceFiles()` = readdir of `bench/reference/`, ENOENT → `[]` (then every
  producing suite lands in missing_references — deleting the dir cannot go green).
- Per-benchmark pass (`runOne`): phase tracking `skip → setup → counters → teardown`;
  best-effort teardown on failure EXCEPT when the failure was in phase `skip` (nothing
  built yet — `child.mjs` precedent); progress line per benchmark with per-bench ms.
- `--json` object: `{ mode, timestamp, environment, leveldb_env_cleared, filter,
  suites: {name: {reference: path|null, outcomes: [...]}}, counts, missing_references,
  orphan_references, failed }`. Human lines to stderr via run.mjs's
  `humanStream`/`useColor` pattern (copy the tiny `ansi` helpers).
- Outcome record shape: `{name, fullName, outcome, note: string|null,
  changes: CounterChange[], ungatedReason?}` — uniform, `changes: []` default.
- Accept printing: per suite, union of old/new benchmark names — added / removed /
  changed (via `diffCounters(old.counters, new.counters)` + `formatChangeLines`);
  unchanged suite prints "unchanged — file left byte-identical".

## Settled validation sequence (run in this order, foreground, no redirection)

1. `yarn build` from repo root (incremental; store + engine dist must be current).
2. Targeted spec while iterating:
   `yarn workspace @quereus/quereus test:single packages/quereus/test/bench-gate.spec.ts`
   (test:single cd's to repo root itself — run it from anywhere).
3. `yarn workspace @quereus/quereus lint` — the tsc test pass is what checks
   `reference.mjs`'s strict JSDoc.
4. `yarn workspace @quereus/quereus bench:accept --allow-dirty --reason "initial reference set (bench-gate-reference ticket)"`
   — the tree is necessarily dirty mid-ticket; `--allow-dirty` exists for exactly this.
   Note in the handoff: the recorded provenance commit predates the harness edits, which
   touch no engine code, so the counts are still that commit's counts.
5. `yarn workspace @quereus/quereus bench:gate` → expect exit 0 (~42 s).
6. Sensitivity check, cheap loop: one-line edit to a planner rule (e.g. make an
   aggregate/subquery rule decline), `yarn workspace @quereus/quereus build`, then
   `yarn bench:gate --filter planner` (planner suite is ~0 s) → expect named readable
   diff + exit 1. Revert the edit, rebuild, run full `bench:gate` once more → exit 0.
7. Full `yarn workspace @quereus/quereus test` once at the end.

## Docs edits beyond the new section

`docs/benchmarking.md` has three now-stale statements to update alongside the new
*Regression gate* section: the counter-portability paragraph ending "there is no gate
on them"; the `yarn check` paragraph's "the regression gate planned on top of it"; and
`compare.mjs`'s comment at the `counterChanges` return ("Failing a run over a changed
count is the regression-gate ticket's job") — point all three at the gate.

## TODO

- Add `bench/lib/reference.mjs`: reference file read/write (sorted keys, tab-indented, atomic write), provenance capture, the join-node eligibility rule, outcome classification, `validateAcceptAfterPass`, and the exit rule — as pure functions over plain objects wherever the input allows
- Add `bench/gate.mjs`: argument parsing (`--filter`, `--json`, `--accept`, `--reason`, `--allow-dirty`), the single-process counters pass, the report, the exit code; delete `QUEREUS_BENCH_LEVELDB` from `process.env` before loading suites and say so when it was set
- Run `teardown` even when a phase throws; record the failure and continue the pass
- Add `bench:gate` and `bench:accept` to `packages/quereus/package.json`
- Generate and commit `bench/reference/*.json` for all four counter-declaring suites, with an `accepted.reason` naming this ticket
- Add `test/bench-gate.spec.ts` covering the cases listed above; run no benchmark from it
- Add the `NOTE:` on the single-process choice, and the `NOTE:` on the fixture-population cost lever
- Write `docs/benchmarking.md` section *Regression gate*: what the reference set is, what gates and what does not, the accept path, the measured ~42 s cost, and why counters and not wall-clock
- Verify with `yarn bench:gate` on a clean tree (expect exit 0), then again after a deliberate one-line change to a plan rule (expect a named, readable difference and exit 1), then revert that change

# Session 4 progress (CODE STARTED — reference.mjs landed; resume by writing gate.mjs)

A fourth run began writing code and hit the soft budget. Everything below is ON DISK
and uncommitted; nothing has been built, linted, or tested yet. Trust the prior
sessions' facts; do not re-derive anything.

## Landed this session (verify nothing, just build on it)

- **`bench/lib/reference.mjs` — COMPLETE.** Implements the whole settled API from
  sessions 2/3 with full strict JSDoc. Final exported surface (read the file for
  signatures before writing gate.mjs, it is the source of truth):
  `COUNTER_CHANGES_SHOWN`, `UNGATED_MULTI_JOIN_REASON`, `OUTCOME_ORDER`,
  `referenceDir`, `referencePath(suiteName)`, `countJoinNodesPerPlan(counters)`,
  `gateEligibility(counters)`, `classifySuite(suiteName, rows, referenceBenchmarks,
  filter)`, `gateFails(outcomes, suitesMissingReference, orphanReferences = [])`,
  `validateAccept({reason, filter, dirty, allowDirty})`,
  `validateAcceptAfterPass(measured)`, `buildReferenceBenchmarks(rows)`,
  `nextReference(previous, suite, benchmarks, accepted)`,
  `captureAcceptance(reason, environment, by)` (`by: string|null`, omitted when null),
  `formatChangeLines(changes, cap?)`, `parseReference(text, filePath)`,
  `serializeReference(reference)`, `listReferenceSuites()`, `loadReference(suiteName)`
  (null on ENOENT, throws naming file on malformed), `writeReference(suiteName,
  reference)` (atomic temp+rename, returns path). Row shape it consumes (`GateRow`):
  `{name, fullName, counters?, skipped?: {reason}, failure?: {phase, error:
  {name?, message?, stack?}}}`.
- **`runCountersPass` moved to `bench/lib/counters.mjs`** (exported), removed from
  `child.mjs`, which now imports it. Param typed `() => unknown | Promise<unknown>`
  (not `object`) so the null/typeof validation survives strict checkJs (TS2367).
- **`git()` exported from `bench/lib/environment.mjs`** (was module-private).
- **`COUNTER_CHANGES_SHOWN` moved out of `run.mjs`** into reference.mjs; `run.mjs` now
  imports it from `./lib/reference.mjs`.
- **`compare.mjs` stale comment updated** at the `counterChanges` return — now points
  at `bench/gate.mjs` and `bench/reference/` (this was one of the three doc-rot fixes;
  the two in `docs/benchmarking.md` remain).

## Remaining TODO (in order)

- Write `bench/gate.mjs` per the settled sessions 2/3 design. All decisions stand.
  Additional drafted details from this session: `VALUE_FLAGS = {--filter, --reason}`,
  `BOOLEAN_FLAGS = {--json, --accept, --allow-dirty}`; refuse `--reason`/`--allow-dirty`
  without `--accept`; delete `process.env[LEVELDB_ENV_VAR]` at top of main() before
  `loadSuites()`, remembering whether it was set for the header + JSON
  (`leveldb_env_cleared`); copy run.mjs's `UsageError`/`humanStream`/`useColor`/`ansi`
  pattern; `runOne(bench)` = child.mjs phase pattern minus `fn` (skip-phase failure
  gets NO teardown; other failures get best-effort teardown; return
  `{counters}|{skipped}|{failure}`); per-suite loop as settled in session 3; accept's
  `by` = `git('git config user.name')` + `git('git config user.email')` combined
  `Name <email>`, either alone if only one answers, null if neither; wrap
  `loadReference` throws into UsageError so malformed refs print one line. Both
  `NOTE:`s (single-process premise + fixture-population lever) go at the pass loop.
- Add scripts to `packages/quereus/package.json`:
  `"bench:gate": "node bench/gate.mjs"`, `"bench:accept": "node bench/gate.mjs --accept"`.
- Write `test/bench-gate.spec.ts` (pure functions only, no benchmark): eligibility
  (one join gated; `{HashJoin:1, NestedLoopJoin:1}` in ONE plan ungated; one join in
  each of two nested plans GATED — per-plan rule, session 3 call #1, comment why; no
  plan at all gated; bare PlanShape root counted), classifySuite outcomes (match /
  differs / new / missing / filtered-with-excluding-filter / skipped-beats-missing /
  failed-with-phase / ungated-recomputed-from-this-run-despite-reference-gated-true,
  changes still carried), gateFails exit rule incl. missing-reference and orphan
  params, validateAccept (4 cases + dirty-unknown allowed), validateAcceptAfterPass
  (failed refuses; skipped-with-previous-entry refuses; skipped-without-entry fine),
  nextReference unchanged-returns-previous-verbatim (test with reordered keys to prove
  deep-equal), serializeReference (tab indent, sorted keys, top-level order, trailing
  newline), parseReference refusals naming the file, formatChangeLines elision at 12
  announced, buildReferenceBenchmarks (sorted, counter-rows only, ungatedReason),
  captureAcceptance omits `by` when null. Copy bench-comparison.spec.ts style.
- Docs (`docs/benchmarking.md`): new `## Regression gate` section (place before
  `## Ratio guards`); update the two remaining stale spots — § Work counters closing
  paragraph ("there is no gate on them") and § Exit-code contract's `yarn check`
  paragraph ("the regression gate planned on top of it"); also the § Noise floor
  closing sentence ("That work belongs to the regression-gate ticket…") — say the
  counter half now exists as `yarn bench:gate`, ratio half is follow-on
  `bench-gate-ratios-and-check`. Add gate.mjs + reference.mjs rows to "Where the code
  lives" table and bench-gate.spec.ts to the harness-tests list.
- Validation sequence exactly as session 3 listed (build → targeted spec → lint →
  `bench:accept --allow-dirty --reason "initial reference set (bench-gate-reference
  ticket)"` → `bench:gate` exit 0 → planner-rule sensitivity check → full test).
- Commit `bench/reference/*.json` (the accept run generates them).
- Then the stage transition: review/ handoff (flag the two session-3 design calls and
  the session-4 `runCountersPass` unknown-typing), delete this ticket.

## Watchpoints for the next agent

- Nothing has compiled since the edits: run the targeted spec + `yarn workspace
  @quereus/quereus lint` EARLY to shake out any strict-JSDoc nits in reference.mjs
  before investing in gate.mjs debugging.
- run.mjs's `USAGE` line was touched during the constant move (spacing restored) —
  no further action, just don't be surprised by the diff.
- reference.mjs imports only `node:fs/promises`, `node:path`, `node:url`,
  `./compare.mjs`, `./discover.mjs` — no dist imports, safe for run.mjs to import.
