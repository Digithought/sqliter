# Benchmarking

The benchmark suite lives in `packages/quereus/bench/`. It measures how long the engine
takes to do a fixed amount of work, and — more importantly — tries hard not to report a
difference that is only measurement noise.

Run it from the engine package:

```
cd packages/quereus
yarn bench
```

It is **not** part of `yarn test` or `yarn check`. A full run takes roughly 35 seconds and
is deliberately manual: a benchmark suite inside a test run either slows every test run
down or gets its time target cut until the numbers stop meaning anything.

## What is measured

27 benchmarks across four suites:

| Suite | Benchmarks | What it covers |
| --- | --- | --- |
| `parser` | 4 | Text to AST: a simple select, a complex select, a 50-column select, an insert with values. |
| `planner` | 4 | AST to optimized plan, without executing it: scan, join, aggregate, subquery. |
| `execution` | 15 | Whole queries over a 10 000-row table: full scan, indexed filter, group by, order by, distinct, joins, a correlated subquery and its hand-written equivalent. Seven of the fifteen are text-comparison shapes (`order by` text, unicode text, 40-character shared prefixes, text primary keys) because the `BINARY` collation comparator is the engine's hottest code. |
| `mutation` | 4 | Writes: a 10 000-row bulk insert, 1 000 single-row inserts, an update and a delete over a `where` clause. |

## Running it

| Command | What it does |
| --- | --- |
| `yarn bench` | Runs everything, prints the table, writes a results file. |
| `yarn bench --filter <substring>` | Runs only benchmarks whose `suite/name` contains the substring. `--filter parser/` runs one suite; `--filter order-by` runs the ordering shapes across suites. |
| `yarn bench --baseline <file>` | Compares against a previous results file. |
| `yarn bench --baseline latest` | Compares against the newest file in `bench/results/`, resolved *before* this run writes its own. |
| `yarn bench --json` | Writes the result object to stdout and moves every other line — progress, table, banner, guard output — to stderr. |

`bench/results/` is gitignored and never pruned. Files are named by ISO timestamp with `:`
and `.` replaced, so they sort lexicographically in chronological order; `--baseline latest`
relies on that rather than on file modification times, which a copy or a checkout can
reorder.

### Measuring one commit's cost

To put a number on what a single commit cost, the "before" side must be that commit's
**literal git parent** — `git rev-parse <commit>^` — not the last commit that happened to
touch the same file. `git log -- <path>` skips every commit that did not touch that path,
so using its previous entry as the baseline measures everything that landed in between as
well. That mistake produced 50-80% "improvements" on `parser/` and `planner/` benchmarks
while isolating a change to `emit/scan.ts`, which cannot affect either.

Confirm the isolation before trusting the numbers: `git diff --stat <parent> <commit>`
should show only the files the change touched. Then `yarn build` and `yarn bench` on each
side, back to back in one sitting on one machine — `dist/` is what the suites import, and
the noise floor only covers within-run noise (see below).

## Reading the table

```
Benchmark                           Median      Spread         Min         Max       Delta       Noise
──────────────────────────────────────────────────────────────────────────────────────────────────────
parser/simple-select                4.2 µs        7.0%      4.0 µs      9.1 µs       +0.4%       ±7.8%  no change
parser/insert-values                6.1 µs       28.9%      5.4 µs     21.0 µs       +2.1%      ±30.2%  unstable  not gated
```

- **Median** — the middle timed sample. The median, not the mean: these distributions carry
  garbage-collection and just-in-time-compilation outliers that drag a mean around without
  saying anything about the typical call.
- **Spread** — relative interquartile range, `(p75 - p25) / median`. How much this run's own
  samples disagreed with each other. A row above 20% is marked `unstable`.
- **Min / Max** — the extreme samples. **For a batched benchmark these are batch averages,
  not the fastest and slowest individual calls** (see *Calibration* below); a benchmark
  batching 474 calls per sample cannot report a single call's extremes at all.
- **Delta** — the median against the baseline's, as a percentage. Only present with
  `--baseline`.
- **Noise** — the floor that Delta had to clear to count as a change at all. Also only
  present with `--baseline`.

Two markers may follow a row: `unstable` (this run's own spread was above 20%, or the
benchmark collected too few samples for a spread to be believed) and `pinned` (the
benchmark opted out of calibration — see below).

## Process isolation, and what is portable between machines

**Every benchmark runs in its own process**, forked one at a time by `bench/run.mjs`. This
is not tidiness. The instruction interpreter shares call sites across query shapes, so in a
single shared process whichever shape runs first pays the just-in-time compiler's warm-up
costs and whichever runs later inherits a de-optimized, polymorphic dispatch path. Measured
during the isolation work: the same fourteen benchmarks moved between **0.37x and 1.66x**
— a 2.7x swing on identical code — depending only on their position in the run order.
Isolation removes that variable entirely, at the cost of a process fork per benchmark.

What survives being carried between machines and what does not:

- **Not portable: absolute wall-clock numbers.** A median in milliseconds describes one CPU
  running one build of V8 under one operating system's scheduler. Comparing yesterday's
  laptop number against today's desktop number measures the hardware.
- **Portable: ratios within a single run.** "This query is 26 times slower than its
  hand-written equivalent" holds on any machine, because both halves ran on the same one.
  That is what `ratioGuards` (below) exploit.
- **Portable: the shape of a distribution.** A benchmark whose spread is consistently 3% on
  one machine and 40% on another is telling you about the benchmark, not the machines.

Because absolute timings are not portable, every results file records the machine that
produced it: CPU model, logical core count, total memory, platform, operating-system
release, architecture, Node and V8 versions, the commit, and whether the working tree was
dirty. When `--baseline` is given, the two environment blocks are compared *before* the
table is printed, and a loud banner appears above it if the CPU model, the core count, the
platform, the architecture or the Node major version differ — or if the baseline file
records no environment at all, which is itself something you cannot check.

The banner warns; it never refuses. Comparing across machines on purpose ("does this
regression reproduce on ARM?") is legitimate — it just has to be labelled.

## Calibration

No benchmark definition carries an iteration count. Each worker:

1. Warms `fn` up **by elapsed duration** — about 250 ms of untimed calls — so the timed
   loop measures the optimized code rather than the optimizer.
2. Measures the warmed `fn` to pick an inner **batch size** that puts one timed sample
   safely above clock resolution.
3. Buys as many **samples** as a ~1 second time target affords, between 5 and 500.

So a 4 µs parser call (batch ~250, 500 samples) and a 110 ms bulk insert (batch 1, ~9
samples) both get comparable statistical weight without anyone hand-tuning either. Every
knob is one commented object, `CALIBRATION`, in `bench/lib/calibrate.mjs`.

Batching is why a batched row's Min and Max are batch means, and it is why **`fn` must be
repeatable back-to-back without `setup` running between calls**.

Setting `iterations` or `warmup` on a benchmark pins it out of calibration entirely and
marks it `pinned`. That is an escape hatch for a benchmark whose per-call cost changes as it
runs, where measuring a few warm calls would not represent the rest. A pinned benchmark
collects too few samples for its spread to be trusted, so it is reported as unstable and is
never gated on.

## Noise floor: when a delta is a change

The old rule was a flat 20%: any median more than 20% above the baseline was red. That rule
was wrong in both directions. `execution/group-by-10k` produced medians of 58.22 ms and
65.03 ms in consecutive runs of an unchanged tree — a 12% delta that was entirely noise, in
a run whose own spread was 63%. Meanwhile `execution/distinct-text-10k` reproduces to within
3% across runs, so a real 15% regression there was invisible under the same flat rule.

Each delta is now judged against a floor built from **both** runs' spreads:

```
noiseFloor% = max(5, sqrt(currentSpread² + baselineSpread²))
```

Quadrature, because the two runs' noise is independent — adding them would double-count and
taking the larger would ignore one of them. The 5% minimum stops a benchmark that happened
to report a near-zero spread from gating on 1% deltas, which no wall-clock measurement on a
general-purpose machine supports.

The verdicts:

| Condition | Verdict | Gated? |
| --- | --- | --- |
| `abs(delta) <= noiseFloor` | **no change**, uncolored | no |
| `delta > noiseFloor` and `delta > 10%` | **regression**, red | **yes** |
| `delta < -noiseFloor` and `delta < -10%` | **improvement**, green | no |
| clears the floor but not the 10% minimum | printed with its percentage, plainly | no |

The floor is printed in the `Noise` column beside every delta, so a reader can see *why* a
12% delta was called no change without reading the source.

**A benchmark unstable in either run is never a regression.** Its delta is still printed and
its row still says `not gated`, and the summary counts how many were excluded. A benchmark
that cannot hold a stable number is a bug in the benchmark, not a signal about the engine.
A baseline median that rounds to zero is treated the same way — there is no delta to
compute — rather than emitting `Infinity`.

**What the floor cannot see.** It is built from each run's *own* samples, so it measures
within-run noise and nothing else. A whole run displaced by background load — every
benchmark moving the same direction by a similar amount — still reads as tight, and the
displacement can exceed the floor. Measured while building this: two full 27-benchmark runs
minutes apart on an unchanged tree, on a machine that was also running other work, produced
two gated "regressions" whose spreads were 3-6% in *both* runs. So treat a red result on a
busy machine as a prompt to re-run, not as a verdict, and do not wire this exit code into an
automatic gate until a between-run estimate exists — repeating runs and taking a median of
medians, subtracting the common-mode shift, or requiring a regression to reproduce twice.
That work belongs to the regression-gate ticket, which already plans to gate on work counters
and within-run ratios rather than on wall-clock for exactly this reason.

A results file written before spreads were recorded has its spread assumed to be 20%: the
widest a run could be and still have been called stable, so the assumption can only make the
comparison more forgiving. The banner says how many entries needed the fallback.

## Outcomes that are not deltas

Every benchmark in either run appears in the comparison exactly once, and the run closes
with a count of each outcome. A comparison that silently drops what it could not evaluate
reads as green when it is not.

*Unstable*, *new* and *missing* each get a line per benchmark, because each carries its own
reason. *Filtered* names share one wrapped block instead: they all have the same reason, and
narrowing a 27-benchmark baseline to one suite otherwise printed 23 identical sentences that
pushed the lines a reader had to act on off the top of the screen.

- **new** — in this run, absent from the baseline. Not a failure.
- **missing** — in the baseline, absent from this run: renamed, deleted, or never started.
- **filtered** — in the baseline and excluded by `--filter`. Reported separately from
  *missing* so a narrowed run does not look like a deletion.
- **failed** — the benchmark threw, hung or died this run. Its row reads `FAILED` and the
  run exits non-zero.
- **unstable** — measured, but too noisy in one run or the other to gate on.

## Ratio guards

A suite may export `ratioGuards`: a bound on one benchmark's median against another's,
*within the same run*.

```js
export const ratioGuards = [
	{ name: 'correlated-subquery', baseline: 'hand-batched-peer-count', maxRatio: 10 },
];
```

This catches a plan-shape regression from a single run with no baseline file at all. If
`scalar-agg-decorrelation` stops firing, the correlated form goes N+1 against its
hand-written twin and the ratio spikes, whatever the absolute timings on that machine are.
Ratios are the portable measurement, which is what makes this the strongest gate the suite
has.

A guard naming a benchmark that was not selected is reported as *skipped* when `--filter` is
active (narrowing a run should not make every guard fire) and as a *misconfiguration* — a
failure — when it is not.

## Exit-code contract

`yarn bench` exits non-zero on any of:

- a benchmark failure (threw, timed out after 120 s, or died without reporting),
- a ratio-guard failure or misconfiguration,
- a gated regression, meaning a delta that cleared both the noise floor and the 10% minimum
  on a benchmark that was stable in both runs.

Unstable benchmarks, new benchmarks, missing benchmarks and sub-threshold deltas never
contribute to the exit code.

## `--json`

Under `--json`, stdout carries the result object and nothing else — the human table, the
progress lines, the environment banner and the guard verdicts all move to stderr, and ANSI
colour is suppressed. The object is exactly what is written to `bench/results/`, so a
consumer never has to care which of the two it is reading. It includes `environment`,
`benchmarks`, `failures`, `ratio_guards`, `baseline` and `comparison`.

```
node bench/run.mjs --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(Object.keys(JSON.parse(s))))"
```

Colour is also suppressed whenever the human stream is not an interactive terminal, so a
captured log stays readable.

## Adding a benchmark

Add an entry to the relevant `bench/suites/*.bench.mjs`:

```js
{
	name: 'my-shape-10k',
	async setup() { db = await createPopulatedDb(); },
	async teardown() { await db.close(); db = null; },
	async fn() {
		const rows = await collect(db.eval('select ...'));
		if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
	},
}
```

Requirements:

- **`fn` must be repeatable back-to-back without `setup` between calls.** Calibration will
  batch it, and a benchmark that only works the first time will report the cost of failing.
- **`fn` must assert its own result.** A query that silently returns zero rows is very fast
  and completely meaningless; the row-count check is what stops a broken benchmark from
  reading as an improvement.
- Names must be unique within their suite — `suite/name` is the identity that `--filter`,
  the baseline comparison and the ratio guards all key on. Renaming a benchmark shows up as
  one *missing* and one *new*, which is the intended signal.
- Prefer a shape with a plausible slow counterpart, and give it a `ratioGuards` entry. A
  guard that fires from a single run is worth more than a delta that needs a baseline file
  from the same machine.
- **Drain the result fully if you read work counters from it.** `Statement.getWorkCounters()`
  reports what the execution actually did, so a benchmark that stops early — a `LIMIT`, a
  `break` out of the loop, an abort — leaves a partial `rowsScanned` whose value depends on
  where it stopped. Counts are only reproducible run-to-run once the iterable is exhausted.
  See [runtime.md § Work counters](runtime.md#work-counters-machine-independent-execution-counts).

## Where the code lives

| File | Responsibility |
| --- | --- |
| `bench/run.mjs` | Parent orchestrator: arguments, forking, the table, the comparison output, the exit code. Never runs benchmark work itself. |
| `bench/child.mjs` | Worker: runs exactly one benchmark and reports raw samples over IPC. |
| `bench/lib/calibrate.mjs` | The timing policy — warmup, batch sizing, sample count. Kept out of the worker so `test/bench-calibration.spec.ts` can drive it. |
| `bench/lib/stats.mjs` | Median, percentiles, relative IQR, the summary record, and the noise floor. |
| `bench/lib/compare.mjs` | The cross-run comparison rules, as pure functions over two result objects. |
| `bench/lib/environment.mjs` | Environment capture and the material-difference check. |
| `bench/lib/discover.mjs` | Suite enumeration and the one definition of what `--filter` matches (`matchesFilter`), shared by the parent, the worker and the comparison. |

See also [Architecture § Benchmark Suite](architecture.md#testing-strategy).
