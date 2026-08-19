# Benchmarking

The benchmark suite lives in `packages/quereus/bench/`. It measures how long the engine
takes to do a fixed amount of work, and — more importantly — tries hard not to report a
difference that is only measurement noise.

Run it from the engine package:

```
cd packages/quereus
yarn bench
```

It is **not** part of `yarn test` or `yarn check`. A full run takes roughly 100 seconds and
is deliberately manual: a benchmark suite inside a test run either slows every test run
down or gets its time target cut until the numbers stop meaning anything.

## What is measured

46 benchmarks across four suites — 27 *workloads*, of which the 19 in `execution` and
`mutation` are each measured against two storage backends (see below):

| Suite | Benchmarks | What it covers |
| --- | --- | --- |
| `parser` | 4 | Text to AST: a simple select, a complex select, a 50-column select, an insert with values. |
| `planner` | 4 | AST to optimized plan, without executing it: scan, join, aggregate, subquery. |
| `execution` | 30 (15 × 2 backends) | Whole queries over a 10 000-row table: full scan, indexed filter, group by, order by, distinct, joins, a correlated subquery and its hand-written equivalent. Seven of the fifteen are text-comparison shapes (`order by` text, unicode text, 40-character shared prefixes, text primary keys) because the `BINARY` collation comparator is the engine's hottest code. |
| `mutation` | 8 (4 × 2 backends) | Writes: a 10 000-row bulk insert, 1 000 single-row inserts, an update and a delete over a `where` clause. |

### Storage backends, and what a name means

The `execution` and `mutation` suites do not hold queries; they hold *workloads* (in
`bench/workloads/`) and bind each of them to every **backend** — a storage engine the
same workload can be measured against. A workload plus a backend is one benchmark, and
the backend appears in the name:

```
execution/full-scan-10k            the engine's default vtab module
execution/full-scan-10k@store-mem  the same query, some other module
```

**The default backend contributes the bare name.** That rule is what keeps every
benchmark name, every results file already on disk and every `ratioGuards` entry meaning
exactly what it meant before backends existed. A name carrying `@` is a claim that the
row ran on something *other* than the engine's default module; a bare name is the
default.

Two backends exist today. The descriptors and the expansion live in
`bench/lib/backends.mjs`:

| id | what it is | name |
| --- | --- | --- |
| `memory` | the in-process memory vtab module — the engine default | bare (`full-scan-10k`) |
| `store-mem` | `StoreModule` wrapped by the isolation layer, over an in-memory key-value provider | `full-scan-10k@store-mem` |

`store-mem` is the persistent path's performance coverage, and it is exactly the wiring
`yarn test:store` exercises: key encoding, batched row resolution, transaction commit,
index build and catalog rehydration are all code the memory module never runs. Two
choices in it are deliberate:

- **Isolation-wrapped.** `createIsolatedStoreModule` adds read-your-own-writes, rollback
  and savepoints. That is what `yarn test:store` runs and what a deployment runs, so it is
  what the row measures. "What does the wrapper itself cost" is a different question and
  would be a different backend id.
- **In-memory provider, not disk.** It isolates *store-layer* cost from *disk* cost, it is
  deterministic, and it is cheap enough to run on every `yarn bench`. A disk-backed row is
  a separate, opt-in backend.

`store-mem` roughly **doubles `yarn bench`'s wall-clock** — measured at 48 s for 27 rows
before it and 102 s for 46 rows after, on the machine and node version the table header
records. Nothing in it comes close to the 120 s per-benchmark timeout (`BENCH_TIMEOUT_MS`
in `bench/run.mjs`); the slowest single call is ~370 ms.

The store package is imported **lazily**, from one dynamic-import site in
`bench/lib/store-counters.mjs`. The parent process imports every suite file just to
enumerate benchmark names, so a static import there would let an unbuilt
`packages/quereus-store/dist` kill the whole run — parser and planner suites included.
Instead the store rows *skip*, with the reason printed (see
[A benchmark that declines to run](#a-benchmark-that-declines-to-run-skip)). Both `dist/`
directories must be current: `yarn build` builds them in dependency order, and a bench run
against a stale `packages/quereus-store/dist` measures the wrong code just as surely as a
stale `packages/quereus/dist` does.

A backend declines a workload through `BenchBackend.skipWorkload(workload)`, which
`expandBackends` wires into the benchmark's `skip()` so no suite file has to remember to.
When a binder *also* supplies a `skip`, the two compose — the backend is asked first and
its reason wins, then the binder's is consulted — because a backend that cannot load makes
any workload-intrinsic reason moot. `store-mem` declines nothing per workload today: every
workload in both suites was confirmed to run on it and return the row count it asserts,
including the two divergences that looked most likely to bite (the store applies NOCASE to
an undecorated text primary key where memory applies BINARY, and the store's cost model may
validly pick a different join shape — neither changes a result).

There is deliberately **no `--backend` flag**. `--filter` is a plain substring match, so
`--filter @store-mem` already selects one backend across every workload and `--filter
full-scan-10k` already selects one workload across every backend. Expansion is
workload-major, so a workload's readings land on adjacent rows in the table.

**Every entry of both suites is expanded** — neither suite file holds a benchmark object
of its own. That is the invariant worth keeping: a hand-written entry would keep running
on the default backend forever, and nothing would say so when a new backend landed. A
workload that seems not to fit usually needs a richer *fixture* (a fixture is a function
over a database and may build as many tables as it likes), not an exception.

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
- **skipped** — the benchmark declined to run (see below). Distinct from *missing*: it is
  still in the suite, so its baseline entry is not reported as a deletion. It does not
  affect the exit code.

### A benchmark that declines to run: `skip()`

A benchmark may declare a `skip()` alongside `fn`. It returns a **reason** to decline, or
`null` to run:

```js
{
	name: 'full-scan-10k@store-mem',
	async skip() { return (await storeAvailable()) ? null : 'store module is not installed'; },
	// setup / fn / teardown / counters as usual
}
```

It is evaluated in the **worker**, before `setup`, in its own phase — because the reason a
benchmark declines is usually a runtime fact (a module that will not load, a missing
binary, an environment variable), and the parent imports suites for their metadata only. A
`skip()` that *throws* is a benchmark failure in phase `skip`, not a silent run.

A skipped benchmark **keeps its row**, printed as `skipped — <reason>`, and is recorded in
the results JSON under a top-level `skipped` array of `{name, reason}`. It is in neither
`benchmarks` (it produced no numbers) nor `failures` (it did not fail). Being in none of
the three is the one thing it must not be: an absent benchmark reads as *unchanged* to
anyone diffing two runs, which is exactly the wrong claim.

`counters()` never runs on a skipped benchmark, so its counter verdict is `none` — "not
comparable", the same claim a failed or filtered row makes — and never `dropped`, which
would say the benchmark deliberately stopped reporting counts.

## Work counters: exact-count comparison

A benchmark can also report **work counters** — exact counts of plan nodes, instruction
executions and engine-to-module calls, defined in
[Runtime Work Counters](runtime-work-counters.md).
They are judged nothing like a timing:

- **Delta** says "this might be slower" — measurement noise can fake that, so it needs a
  noise floor built from both runs' spreads (above).
- **Counter delta** says "this does different work" — an exact integer, identical on every
  machine and every run of the same plan, so it needs no floor at all.

Different claims, so they never share a column. A counter comparison has **no tolerance and
no minimum delta**: a difference of one is reported, and every difference is listed as
`before -> after` rather than as a percentage.

### Adding a `counters()` pass

A benchmark opts in with a second, untimed entry point, alongside `fn` in the object shown
under *Adding a benchmark* below:

```js
import { snapshotStatement } from '../lib/counters.mjs';

// … then one more member alongside `fn`, in the same benchmark object:
async counters() {
	return snapshotStatement(db, 'select ...');
},
```

`counters()` runs **once, after the timed loop and before `teardown`** — never inside `fn`.
Runtime metrics wrap every streaming operator in a counting generator, so turning them on
inside the timed loop would corrupt the very number the harness exists to measure; a separate
untimed pass keeps the two concerns apart. `snapshotStatement` (one statement) and
`snapshotStatements` (a named sequence — instruction keys are addresses within one program, so
two statements' counts must never be summed under one name) live in `bench/lib/counters.mjs`,
alongside `snapshotPlanShape` for a benchmark that only wants plan-shape facts.

**Drain the result fully before reading its counters** — see the drain requirement under
*Adding a benchmark* above; a partial drain reads as a change in the engine when nothing
changed but the loop.

### Storage round trips: what a `store-mem` row counts

For a store backend the interesting count is not an instruction tally — it is **how many
times the engine went to storage, and with how many keys**. A change that doubled the
round trips behind a secondary-index scan would leave every engine counter untouched.

So a `@store-mem` benchmark's block nests. `engine` is the same `WorkCounterSnapshot` the
bare row reports; `store` is keyed by **built store name** — what the key-value provider is
keyed by, so it is stable across runs and says which physical store the traffic hit:

```json
{
  "engine": { "...": "the usual snapshot" },
  "store": {
    "main.bench_t":                 { "iterateEntries": 0,  "getManyCalls": 1, "getManyKeys": 10, "singleGets": 0 },
    "main.bench_t_idx_bench_t_val": { "iterateEntries": 10, "getManyCalls": 0, "getManyKeys": 0,  "singleGets": 0 }
  }
}
```

That is `filtered-scan-index-10k@store-mem`, and it reads: ten entries pulled from the
secondary index, then **one** batched read carrying ten keys to fetch the rows. If row
resolution ever stopped batching, `getManyCalls` would go to 10 and `singleGets` would take
the keys.

The four counts, which are **not** the raw field names of `CountingKVStore` in
`@quereus/store/testing` — that class's `getMany` deliberately routes every key of a batch
through its own counted `get`, so its `getCount` is not what its name suggests:

| Field | Means |
| --- | --- |
| `iterateEntries` | entries pulled from `iterate()` — a scan's volume |
| `getManyCalls` | batched reads issued: **the round-trip count** |
| `getManyKeys` | keys those batched reads carried |
| `singleGets` | reads that were genuinely one key at a time (`getCount - getManyKeyCount`, derived once, in `bench/lib/store-counters.mjs`) |

**Reads only.** `CountingKVStore` counts `get`/`getMany`/`iterate` and nothing else, so a
write workload's block describes the reads its writes provoked — index maintenance,
uniqueness probes, read-modify-write — never the writes themselves. `bulk-insert-10k@store-mem`
reporting 30 000 `singleGets` for 10 000 inserted rows is three reads per row, and that is a
real, diffable number; it just is not the whole story of what an insert costs.

A store that was opened but never read from stays in the block with four zeros. That is
a different claim from a store that was never opened at all, which is absent — and the
comparison reports an appeared or vanished path exactly as loudly as a changed count.

Two mechanics worth knowing:

- The counters pass builds a **second database**, over a counting provider, so the counting
  wrapper never sits inside a timed number. It costs about a second across all nineteen
  store rows of a ~100 s run.
- Each pass has to say where its *fixture* ends and its *measurement* begins, or a ten-key
  index probe would be buried under ten thousand fixture inserts. The `execution` binder
  does it structurally (fixture, then reset, then the statement); a `mutation` workload does
  it by calling `ctx.beginMeasured()` at its own boundary — a no-op on backends that count
  nothing.

Counter portability across machines is **an assumption, not a fact**: nothing has yet
compared counter blocks from two machines, and plan choice can in principle differ on a
slower one. Store round trips are reported as facts about *this run*; there is no gate on
them.

### Which suites qualify

Whether a benchmark can report counters depends on what it does, not on an arbitrary
per-suite switch:

| Suite | Declares `counters()` | Why |
| --- | --- | --- |
| `execution` | 30 / 30 | Every benchmark runs a statement to completion; `snapshotStatement` reruns the same query untimed. The 15 `@store-mem` rows add a `store` block to it. |
| `mutation` | 8 / 8 | Writes are statements too — same treatment. |
| `planner` | 4 / 4 | `snapshotPlanShape` only. These benchmarks compile a plan and deliberately never execute it, so there is no instruction or table access to count — only plan shape. |
| `parser` | 0 / 4 | Nothing to count: no `Database`, no plan, no runtime. |

### `--no-counters`

`yarn bench --no-counters` skips the untimed pass entirely — timings only, at the cost of
losing the counter columns. The results file can end up with no counters for two different
reasons, and one field tells them apart: `counters_collected` is `false` only when the run
itself was invoked with `--no-counters`; a benchmark that simply declares no `counters()` pass
leaves `counters_collected: true` and is absent only on its own entries.

The flag is read off **this** run, never off the baseline. A run invoked with
`--no-counters` reports every benchmark's counter status as `skipped` rather than
`dropped` — a timings-only run must not read as the whole baseline's counters
disappearing. The other direction is a different verdict: a counter-collecting run
compared against a `--no-counters` *baseline* reports `new` per benchmark, because there
is nothing on the baseline side to have changed from.

### Reading the output

When counter data is available, the table gains a `Counters` column: `same`, `N diff`,
`new`, `dropped`, `skipped`, or `—` when neither side collected any.

Below the table, each `changed` benchmark gets a block listing every differing path as
`before -> after` — capped at `COUNTER_CHANGES_SHOWN` (12) lines per benchmark in the
printed output, with the full uncapped list always in the results JSON under `comparison`.
A `dropped` benchmark gets one line saying the baseline reported counters and this run did
not, and no path list: there is nothing to list against a run that collected none.

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
failure — when it is not. A guard naming a benchmark that failed, or one whose `skip()`
declined to run it, is reported as *not evaluated* and never as a misconfiguration: neither
is a guard naming something that does not exist, and failing the run over a skip would make
every skip a red build.

**Guards name one benchmark each, and that means one backend each.** A bare name in a
`ratioGuards` entry is the default backend's row. Guards are deliberately **not** expanded
across backends: a ratio that holds on the in-memory vtab need not hold on a persistent
store, and a guard that silently multiplies itself across backends is a guard nobody
trusts. A guard that wants to bound a suffixed benchmark spells the suffix out.

**Do not write a cross-backend guard.** Bounding `x@some-backend` against bare `x` prices a
storage engine against an in-process array; the number it would encode is this machine's
ratio between two unrelated things, not a property of either engine. There is no portable
value for `maxRatio` there, so there is no guard to write.

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
`benchmarks`, `failures`, `skipped`, `ratio_guards`, `baseline` and `comparison`.

```
node bench/run.mjs --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(Object.keys(JSON.parse(s))))"
```

Colour is also suppressed whenever the human stream is not an interactive terminal, so a
captured log stays readable.

## Adding a benchmark

`parser` and `planner` still hold benchmark objects directly; add an entry to the relevant
`bench/suites/*.bench.mjs`:

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

For `execution` and `mutation`, add a **workload** instead — the suite file binds it to
every backend for you. An `execution` workload is plain data:

```js
// bench/workloads/execution.mjs, in QUERY_WORKLOADS
{
	name: 'my-shape-10k',
	fixture: 'populated',            // a key of FIXTURES, which populates a db it is handed
	sql: 'select ... from bench_t',  // the ONE statement fn times and counters() snapshots
	expectedRows: 10000,             // asserted by fn
}
```

A `mutation` workload is a small bundle of functions over a `db`, because its timed body
is a procedure rather than a statement. It declares a `lifecycle`: `own-database` when the
timed body is a database's whole life (the binder opens a fresh one per call, since a
table left behind changes what the next call costs), or `shared-fixture` when `populate`
can run once in `setup` because `run` reaches a fixed point.

A fixture never constructs a `Database` — it populates one it is handed. That is what lets
the same definition run on a different storage engine.

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
- **Add a `counters()` pass if the benchmark runs a statement.** It is a second, untimed
  entry point alongside `fn`, and it is what makes a plan change visible without a
  same-machine baseline. See *Work counters* above for the shape and the helpers.
- **Drain the result fully if you read work counters from it.** `Statement.getWorkCounters()`
  reports what the execution actually did, so a benchmark that stops early — a `LIMIT`, a
  `break` out of the loop, an abort — leaves a partial `rowsScanned` whose value depends on
  where it stopped. Counts are only reproducible run-to-run once the iterable is exhausted.
  See [Runtime Work Counters](runtime-work-counters.md).

## Where the code lives

| File | Responsibility |
| --- | --- |
| `bench/run.mjs` | Parent orchestrator: arguments, forking, the table, the comparison output, the exit code. Never runs benchmark work itself. |
| `bench/child.mjs` | Worker: runs exactly one benchmark and reports raw samples over IPC. |
| `bench/lib/calibrate.mjs` | The timing policy — warmup, batch sizing, sample count. Kept out of the worker so `test/bench-calibration.spec.ts` can drive it. |
| `bench/lib/stats.mjs` | Median, percentiles, relative IQR, the summary record, and the noise floor. |
| `bench/lib/compare.mjs` | The cross-run comparison rules, as pure functions over two result objects. |
| `bench/lib/counters.mjs` | Helpers a benchmark's `counters()` pass uses: `snapshotStatement`, `snapshotStatements`, `snapshotPlanShape`. |
| `bench/lib/environment.mjs` | Environment capture and the material-difference check. |
| `bench/lib/discover.mjs` | Suite enumeration and the one definition of what `--filter` matches (`matchesFilter`), shared by the parent, the worker and the comparison. |
| `bench/lib/backends.mjs` | The storage-engine dimension: the `BenchBackend` descriptor, the `BACKENDS` set, and `expandBackends` — one workload × N backends → N benchmarks, named by the bare-name rule, with each backend's `skipWorkload` wired into the benchmark's `skip()`. |
| `bench/lib/store-counters.mjs` | Everything that touches `@quereus/store`, behind the harness's one dynamic import: the plain and counting `store-mem` databases, and the round-trip block they report. |
| `bench/workloads/*.mjs` | What the `execution` and `mutation` suites measure, as data plus fixtures. The suite files are binders over these. |

Harness tests, none of which run a benchmark: `test/bench-calibration.spec.ts` (the timing
policy and the statistics), `test/bench-comparison.spec.ts` (the cross-run rules and the
environment check), `test/bench-backends.spec.ts` (the backend expansion and the naming
rule). `yarn bench` is not part of `yarn test`, so these are the only automated check on
the harness itself.

See also [Architecture § Benchmark Suite](architecture.md#testing-strategy).
