# Benchmarking

Bench suite live in `packages/quereus/bench/`. Measure how long engine take to do fixed work, and — more important — try hard not report difference that only measurement noise.

Run from engine package:

```
cd packages/quereus
yarn bench
```

`yarn bench` **not** part of `yarn test` or `yarn check`. Full run ~160 seconds, deliberately manual: bench suite inside test run either slow every test run down or get time target cut until numbers stop meaning anything. Cheap sibling `yarn bench:gate` *does* run inside `yarn check`, measure no absolute timing at all — see [Which check catches what](#which-check-catches-what).

## What is measured

92 benchmarks across five suites — 54 entries, of which 19 in `execution` and `mutation` each measured against three storage backends (see below):

| Suite | Benchmarks | What it covers |
| --- | --- | --- |
| `parser` | 4 | Text to AST: simple select, complex select, 50-column select, insert with values. |
| `planner` | 4 | AST to optimized plan, no execute: scan, join, aggregate, subquery. |
| `execution` | 45 (15 × 3 backends) | Whole queries over 10 000-row table: full scan, indexed filter, group by, order by, distinct, joins, correlated subquery + hand-written twin. Seven of fifteen are text-comparison shapes (`order by` text, unicode text, 40-character shared prefixes, text primary keys) because `BINARY` collation comparator is engine's hottest code. |
| `mutation` | 12 (4 × 3 backends) | Writes: 10 000-row bulk insert, 1 000 single-row inserts, update and delete over `where` clause. |
| `store` | 27 | Storage layer priced one path at a time, three groups. Eleven rows call `@quereus/store` key-encoding functions directly, no database in picture — value shapes where fast path can die silently (plain integer, plain text, astral-plane text, JSON, blob, `NOCASE` key, descending key + ascending control, four-column composite, secondary-index key), plus one decode. Fourteen rows drive one storage hot path each — scan, point read, batched multi-key seeks, fetching rows found through secondary index, commits at four sizes, index build, catalog rehydration — through `Database` over store module, assert exact storage round trips beside timing. Two rows price random reads against sequential on **real disk**, at key-value layer, no database above. See [The `store` suite](#the-store-suite-micro-benchmarks-with-no-backend-dimension). |

### The `store` suite: micro-benchmarks with no backend dimension

`execution` and `mutation` answer "how long this query take against this storage engine". Right top-level signal, poor **diagnostic**: full scan blend key decoding, iteration, row deserialization and isolation overlay into one number, so regression in any one read as "scan got slower" with no way to say which. `store` suite give individual pieces own numbers.

Three groups, run order:

- **Key encoding** (11 rows: `data-key-*`, `index-key-*`, `decode-composite-4col`) call
  `@quereus/store`'s key functions directly — no `Database`, no plan, no storage traffic.
  Report no counters, same reason `parser` report none: nothing runs, nothing to count.
- **Store hot paths** (14 rows: full scan, point read, two multi-key seek widths, four
  index-then-fetch widths, four commit sizes, index build, catalog rehydration) drive
  one storage code path each through `Database` opened over store module — the
  `openStoreDatabase()` / `openCountingStoreDatabase()` pair in
  `bench/lib/store-counters.mjs`, so counting wrapper never sit inside timed
  number. Each report same nested `{engine, store}` block as `@store-mem` row
  (see [Storage round trips](#storage-round-trips-what-a-store-mem-row-counts)), and go
  one step further: `counters()` pass **assert** expected round-trip counts on
  table stores it names, so plan change that moved traffic between stores fail loudly
  instead of shipping silently different block. (Reserved `__catalog__` /
  `__stats__` blocks reported but not asserted — see counters table below.) Expected counts that depend on row-resolution batch size
  derive from imported `ROW_RESOLUTION_BATCH`, never restated, so they move with
  constant. Four commit sizes (1, 10, 100, 1000) together carry claim no read
  count can — committing N queued operations cost *flat* number of write-side round
  trips (`batchWrites` stay one per touched store while `batchOps` scale with N);
  N = 10 000 considered and dropped: shape visible across
  three decades, fourth add hundreds of milliseconds per timed call for no
  extra claim.
- **Read cost on real disk** (2 rows: `leveldb-read-cost-20k`, `leveldb-read-cost-200k`) —
  only rows in suite touching provider with no `Database` above, and only ones
  touching disk. See [Read cost on real
  disk](#read-cost-on-real-disk) below.

First two groups split at `scan-10k` in run order; third follow both.

One thing differ from every other suite, deliberately: **names carry no `@` suffix.**
Suite not in backend dimension. Key half call store functions directly, so
no storage engine to swap underneath; hot-path half exist to measure *the*
store module specifically — same query shapes on memory vtab are `execution`'s bare
rows, not missing backend of these. Invariant below — *every* entry of `execution`
and `mutation` is backend-expanded — untouched; `store` simply not in backend
dimension at all.

Its `skip()` is one place in repo that hand-write one — single
`skipUnlessStoreLoads` shared by every entry — and return same
`storeLoadFailure()` reason `@store-mem` rows use, so unbuilt
`packages/quereus-store/dist` skip these rows with stated reason instead of failing all
twenty-seven with module-resolution stack trace. Two read-cost rows compose
*second* reason on top — LevelDB opt-in below — so unbuilt store package still
win, being more fundamental failure.

Every `fn` in **key-encoding half** build **1 000 keys per call** (`KEYS_PER_CALL` in
`bench/suites/store.bench.mjs`), one shared constant across every shape so shapes stay
comparable. Single key build cost ~hundred nanoseconds
and `await` around `fn` cost microtask tick, so timing one build per call would
report mostly harness overhead. **Every figure in that half is cost of 1 000
key builds, not one** — divide before quoting per-key number. Hot-path half does
not amortize: cheapest timed call is whole statement over 10 000-row store, well
clear of scale where harness overhead matter.

Fixture values built in `setup`, never in `fn`, because calibration batch
sub-millisecond work and `fn` that allocate own input measure the allocation. Assertions
split for same reason: `setup` round-trip every fixture value through
`decodeCompositeKey(encodeCompositeKey(v))` and throw on mismatch — that stop
suite measuring broken encoder, and it untimed so cost nothing — while
`fn` assert only total encoded byte length, cheap and still catch
encoder that stopped producing bytes. Full decode inside encode benchmark's timed body
cost about as much as encode and halve resolution of thing being
measured. One dedicated `decode-composite-4col` benchmark does assert value equality on
every column, because there decode *is* subject.

Suite add ~**51 s** to default `yarn bench` run — ~16 s key-encoding
half, rest hot-path rows and per-row process forks — on machine the
results-file header records. Two read-cost rows contribute ~1 s of that, being
fork and skip reason each; opted in they cost ~10 s.

Two rows exist only as controls, not interesting alone:
`data-key-asc-2col` (uninverted twin of `data-key-desc-2col`, so cost of
encoder's DESC bit-inversion is subtraction not guess) and
`data-key-text-binary` (twin of `data-key-text-nocase`, difference is key
normalizer). `data-key-text-astral` deliberately *superset* of plain text fixture —
same string with four astral-plane characters appended — so delta attributable,
but not controlled A/B on surrogate-scan path alone: astral string also 8
UTF-16 code units and 16 UTF-8 bytes longer. Two strings cannot match both counts while
one astral and other not.

`bench/apply-schema-unchanged.mjs` **not** part of any suite, deliberately, decision
recorded at file itself: it decompose no-op `apply schema` into
five internal timings, and framework measure one `fn` per benchmark. Giving
applied-state fast path standing, ratio-guarded benchmark is separate work, parked as
`feat-bench-apply-schema-fastpath-guard`.

#### Read cost on real disk

`leveldb-read-cost-20k` and `leveldb-read-cost-200k` answer one question rest of
suite cannot: **on real disk-backed store, how much more does random read cost than
sequential?** That ratio is exactly what provider's *cost profile* declare to
planner (`packages/quereus-store/src/common/cost-profile.ts`), and LevelDB's never been
measured — took framework's parity default instead.

Each row seed N rows of 200-byte values into fresh LevelDB temp directory over
integer keys, then time **three arms** per round against that one dataset:

| arm | what it does | what it stands for |
| --- | --- | --- |
| sequential | full `iterate()` draining every value | 1.0 denominator — cost-profile unit |
| batched | 1 000 random keys through `getMany`, paged at `ROW_RESOLUTION_BATCH` | resolving index entries to rows, and primary-key multi-seek |
| single-seek | 1 000 *different* random keys, one `iterate({gte, lt, limit: 1})` each | secondary-index multi-seek, one window per key |

Five properties deliberate:

- **Arms measure key-value layer, no `Database` above.** Unit a cost
  profile define is storage-layer row, and engine overhead land on both sides of
  ratio — including it compress every ratio toward 1.0 and understate difference
  being measured. Also match sibling IndexedDB harness
  (`packages/quereus-plugin-indexeddb/bench/README.md`), only reason two
  backends' numbers readable side by side. Cost: ratio here *not*
  number to declare directly; engine-inclusive value smaller and not measured.
- **All three arms share one benchmark per dataset size, not three.** Harness fork
  fresh process per benchmark, so three rows compare three medians taken with three
  different page-cache and block-cache histories. One `fn` call run one round of all three
  arms in one process, `teardown` take median per arm across rounds.
- **Harness's own median for these rows is cost of one whole round, not the
  interesting number.** Interesting numbers are per-arm milliseconds and two
  ratios, which `teardown` print to stdout. Block land immediately *above* its table
  row, because `child.mjs` run `teardown` then send result.
- **Ratios printed, not reported as counters.** Counter values compared with no
  tolerance and no noise floor, because exact machine-independent integers. Wall-clock ratio is neither, so counters block would report "change" every run.
- **Two sizes do not separate page-cache-cold from page-cache-warm.** No
  portable way to drop OS page cache from Node, and dataset big enough to exceed
  modern machine's page cache cannot be seeded inside benchmark's time budget. What they
  separate: `classic-level`'s own **8 MB block cache**: 20 000 × 200 bytes (~4 MB) fit
  inside, 200 000 (~40 MB) not, so large size's random reads go out to
  filesystem — which on warm machine usually mean OS page cache, not physical
  disk. Claim of "cold" that really "block-cache-miss, page-cache-hit" worse
  than no claim, so not made.

Like every disk-backed row, these two **opt-in and [informational](#informational-rows-reported-never-gated)**:
without `QUEREUS_BENCH_LEVELDB=1` they print same skip reason `@store-leveldb` rows do,
and enter no ratio guard and no pass/fail verdict — disk timing not property of
this repo's code. Opted in they cost ~10 s for pair, 200k row's own
median ~1 s per round, well clear of 120 s per-benchmark timeout.

```bash
QUEREUS_BENCH_LEVELDB=1 node packages/quereus/bench/run.mjs --filter store/leveldb-read-cost
```

2026-08-19 result recorded in `packages/quereus-plugin-leveldb/README.md`
§ *Measured read cost*, with machine it was taken on and what was decided from it.

### Storage backends, and what a name means

`execution` and `mutation` suites hold no queries; they hold *workloads* (in
`bench/workloads/`) and bind each to every **backend** — storage engine the
same workload can be measured against. Workload plus backend is one benchmark, and
backend appear in name:

```
execution/full-scan-10k            the engine's default vtab module
execution/full-scan-10k@store-mem  the same query, some other module
```

**Default backend contribute bare name.** That rule keep every
benchmark name, every results file already on disk and every `ratioGuards` entry meaning
exactly what it meant before backends existed. Name carrying `@` claim row
ran on something *other* than engine's default module; bare name is
default.

Three backends today. Descriptors and expansion live in
`bench/lib/backends.mjs`:

| id | what it is | name | gates a build? |
| --- | --- | --- | --- |
| `memory` | in-process memory vtab module — engine default | bare (`full-scan-10k`) | yes |
| `store-mem` | `StoreModule` wrapped by isolation layer, over in-memory key-value provider | `full-scan-10k@store-mem` | yes |
| `store-leveldb` | same `StoreModule`, over **LevelDB on real temporary directory** | `full-scan-10k@store-leveldb` | no — opt-in and [informational](#informational-rows-reported-never-gated) |

`store-mem` is persistent path's performance coverage, exactly the wiring
`yarn test:store` exercise: key encoding, batched row resolution, transaction commit,
index build and catalog rehydration all code memory module never run. Two
choices deliberate:

- **Isolation-wrapped.** `createIsolatedStoreModule` add read-your-own-writes, rollback
  and savepoints. That what `yarn test:store` run and what deployment run, so
  what row measure. "What wrapper itself cost" is different question and
  would be different backend id.
- **In-memory provider, not disk.** Isolate *store-layer* cost from *disk* cost,
  deterministic, cheap enough to run every `yarn bench`. Disk-backed row is
  separate, opt-in backend.

`store-mem` roughly **double `yarn bench`'s wall-clock** — measured 48 s for 27 rows
before, 102 s for 46 rows after, on machine and node version table header
records. Nothing close to 120 s per-benchmark timeout (`BENCH_TIMEOUT_MS`
in `bench/run.mjs`); slowest single call ~370 ms.

Store package imported **lazily**, from one dynamic-import site in
`bench/lib/store-counters.mjs`. Parent process import every suite file just to
enumerate benchmark names, so static import there let unbuilt
`packages/quereus-store/dist` kill whole run — parser and planner suites included.
Instead store rows *skip*, reason printed (see
[A benchmark that declines to run](#a-benchmark-that-declines-to-run-skip)). Both `dist/`
directories must be current: `yarn build` build them in dependency order, and bench run
against stale `packages/quereus-store/dist` measure wrong code just as surely as
stale `packages/quereus/dist`.

Suite needing more of store package's surface **widen that one site** rather than
opening own import. What it hand out today: `openStoreDatabase()` (plain
timed database — handle also carry `provider` it was built over, for benchmark
whose claim is about what physically landed in store), `openCountingStoreDatabase()` (
untimed counters database), and `loadStoreKeyApi()` (store's key-encoding and
key-building functions, plus `ROW_RESOLUTION_BATCH` — read constant, never restate
`256`, so expected round-trip count move with it). Every name shape-checked as
import resolve, so renamed export become stated skip reason instead of throw inside
benchmark's `setup`.

Backend decline workload through `BenchBackend.skipWorkload(workload)`, which
`expandBackends` wire into benchmark's `skip()` so no suite file must remember.
When binder *also* supply `skip`, two compose — backend asked first and
its reason win, then binder's consulted — because backend that cannot load make
any workload-intrinsic reason moot. `store-mem` decline nothing per workload today: every
workload in both suites confirmed to run on it and return row count it assert,
including two divergences most likely to bite (store apply NOCASE to
undecorated text primary key where memory apply BINARY, and store's cost model may
validly pick different join shape — neither change result).

#### `store-leveldb`: real disk, opt-in and advisory

`store-mem` deliberately measure store layer with disk taken out. `store-leveldb`
is other half: same isolation-wrapped `StoreModule`, over LevelDB provider a
Node deployment actually run.

**Run only when you ask.**

```bash
QUEREUS_BENCH_LEVELDB=1 yarn workspace @quereus/quereus bench --filter @store-leveldb
yarn workspace @quereus/quereus bench:leveldb          # the same, over every suite
```

Without variable every `@store-leveldb` row still **print**, as
`skipped — disk-backed rows are opt-in and advisory — set QUEREUS_BENCH_LEVELDB=1 to run
them`. Variable read as human would read it: `0`, `false`, `off`, `no` and
empty string all mean *no*, so setting it to turn rows off does not turn them on.

Three properties deliberate, worth knowing before reading number:

- **`syncCommits` left at default `true`**, which fsync every transaction commit.
  That what deployment run, and single biggest term in what these rows
  cost — `single-row-insert-1k@store-leveldb` is thousand statements, therefore
  thousand fsync-ed commits. Benchmark that quietly turned it off measure
  configuration nobody use.
- **Every row get own fresh temporary directory** under `os.tmpdir()`, never inside
  working tree — database under repo survive `git status` unnoticed and on
  Windows can hold lock that fail next `yarn build`. LevelDB take exclusive
  directory lock, so per-*call* freshness requirement not nicety:
  `own-database` mutation benchmarks open and close whole store inside every timed call.
- **No storage round-trip counters.** Counting provider wrap in-memory map, not
  arbitrary provider, so this backend contribute timings only. Nothing lost: round-trip
  counts are property of store *layer*, and `store-mem` report them exactly, every run, free.

**Cleanup has three layers**, because no single one cover every way run ends
(`bench/lib/tempdir.mjs`):

1. Benchmark's own teardown remove its directory — normal path.
2. Process-level `exit` hook in worker cover throw, and cover parent
   vanishing.
3. **Parent** sweep at end of run. Not nicety: `run.mjs`
   `SIGKILL` worker that blow 120 s per-benchmark timeout, and `SIGKILL`
   active worker on Ctrl+C — killed process run no handler of any kind, so layer 2
   structurally cannot cover it.

Sweep never delete by prefix. Every directory carry owner's PID, and one
removed only when that PID force-listed by parent (which just killed it) or no
longer alive, so two concurrent bench runs cannot delete each other's databases. That also
make sweep **cross-run** backstop: if parent itself die without running
handler — Task Manager, CI tree-kill, or on Windows any `kill` from another process,
which terminate rather than signal — directory survive that run and *next*
`yarn bench` collect it, because owner dead by then. Stale directory therefore
cost some disk until next run and never reach measurement.

**What it costs**, measured on AMD Ryzen AI 9 HX 370 / NVMe / Windows 11 machine under
node 24.2 — treat absolute numbers as that machine's, not target:

| | wall clock |
| --- | --- |
| the 19-row `@store-leveldb` arm, opted in | 84 s |
| the same 19 rows skipping, on a default run | 9.2 s of a 163 s / 90-benchmark run (92 rows, ~1 s more, since the read-cost rows landed) |
| slowest single row (`mutation/delete-where-100@store-leveldb`) | 1.95 s median, ~14 s of wall clock |
| the 2 [read-cost rows](#read-cost-on-real-disk), opted in | 10.3 s (they share the opt-in but carry no `@` suffix) |

Nothing approach 120 s per-benchmark timeout. 9.2 s a *default* run pay is
price of rows printing skip reason instead of vanishing, roughly
`0.5 s × rows` — process fork plus `dist/` import each, because skip reason is
runtime fact evaluated in worker.

`@quereus/plugin-leveldb` reached through **one lazy import site**
(`bench/lib/leveldb-backend.mjs`), same reason as `@quereus/store`: parent
import every suite file just to enumerate names, so static import let unbuilt
`packages/quereus-plugin-leveldb/dist` — or native binding that will not load on this
platform — kill whole run, parser and planner suites included. Instead rows skip
with load error as reason, and `yarn bench` complete.

Deliberately **no `--backend` flag**. `--filter` is plain substring match, so
`--filter @store-mem` already select one backend across every workload and `--filter
full-scan-10k` already select one workload across every backend. Expansion is
workload-major, so workload's readings land on adjacent rows in table.

**Every entry of both suites expanded** — neither suite file hold benchmark object
of own. That invariant worth keeping: hand-written entry keep running
on default backend forever, and nothing say so when new backend land. Workload
that seem not to fit usually need richer *fixture* (fixture is function
over database, may build as many tables as it like), not exception.

## Running it

| Command | What it does |
| --- | --- |
| `yarn bench` | Run everything, print table, write results file. |
| `yarn bench --filter <substring>` | Run only benchmarks whose `suite/name` contain substring. `--filter parser/` run one suite; `--filter order-by` run ordering shapes across suites. |
| `yarn bench --baseline <file>` | Compare against previous results file. |
| `yarn bench --baseline latest` | Compare against newest file in `bench/results/`, resolved *before* this run write its own. |
| `yarn bench --json` | Write result object to stdout, move every other line — progress, table, banner, guard output — to stderr. |
| `yarn bench:leveldb` | Same as `yarn bench` with `QUEREUS_BENCH_LEVELDB=1`, so [disk-backed rows](#store-leveldb-real-disk-opt-in-and-advisory) run instead of printing skip reason. Add ~85 s, gate nothing. Note `--filter @store-leveldb` reach only *backend* rows; two [read-cost rows](#read-cost-on-real-disk) carry no `@` suffix, filtered as `store/leveldb-read-cost`. |

`bench/results/` gitignored, never pruned. Files named by ISO timestamp with `:`
and `.` replaced, so sort lexicographically in chronological order; `--baseline latest`
rely on that rather than file modification times, which copy or checkout can
reorder.

### Measuring one commit's cost

To put number on what single commit cost, "before" side must be that commit's
**literal git parent** — `git rev-parse <commit>^` — not last commit that happened to
touch same file. `git log -- <path>` skip every commit that did not touch that path,
so using its previous entry as baseline measure everything that landed between too.
That mistake produced 50-80% "improvements" on `parser/` and `planner/` benchmarks
while isolating change to `emit/scan.ts`, which cannot affect either.

Confirm isolation before trusting numbers: `git diff --stat <parent> <commit>`
should show only files change touched. Then `yarn build` and `yarn bench` on each
side, back to back in one sitting on one machine — `dist/` is what suites import, and
noise floor only cover within-run noise (see below).

## Reading the table

```
Benchmark                           Median      Spread         Min         Max       Delta       Noise
──────────────────────────────────────────────────────────────────────────────────────────────────────
parser/simple-select                4.2 µs        7.0%      4.0 µs      9.1 µs       +0.4%       ±7.8%  no change
parser/insert-values                6.1 µs       28.9%      5.4 µs     21.0 µs       +2.1%      ±30.2%  unstable  not gated
```

- **Median** — middle timed sample. Median not mean: these distributions carry
  garbage-collection and just-in-time-compilation outliers that drag mean around without
  saying anything about typical call.
- **Spread** — relative interquartile range, `(p75 - p25) / median`. How much this run's own
  samples disagreed. Row above 20% marked `unstable`.
- **Min / Max** — extreme samples. **For batched benchmark these are batch averages,
  not fastest and slowest individual calls** (see *Calibration* below); benchmark
  batching 474 calls per sample cannot report single call's extremes at all.
- **Delta** — median against baseline's, as percentage. Only present with
  `--baseline`.
- **Noise** — floor Delta had to clear to count as change at all. Also only
  present with `--baseline`.

Two markers may follow row: `unstable` (this run's own spread above 20%, or
benchmark collected too few samples for spread to be believed) and `pinned` (
benchmark opted out of calibration — see below).

## Process isolation, and what is portable between machines

**Every benchmark run in own process**, forked one at time by `bench/run.mjs`. Not
tidiness. Instruction interpreter share call sites across query shapes, so in
single shared process whichever shape run first pay just-in-time compiler's warm-up
cost and whichever run later inherit de-optimized, polymorphic dispatch path. Measured
during isolation work: same fourteen benchmarks moved between **0.37x and 1.66x**
— 2.7x swing on identical code — depending only on position in run order.
Isolation remove that variable entirely, at cost of process fork per benchmark.

What survive being carried between machines and what not:

- **Not portable: absolute wall-clock numbers.** Median in milliseconds describe one CPU
  running one build of V8 under one OS scheduler. Comparing yesterday's
  laptop number against today's desktop number measure hardware.
- **Portable: ratios within single run.** "This query 26 times slower than its
  hand-written equivalent" hold on any machine, because both halves ran on same one.
  That what `ratioGuards` (below) exploit.
- **Portable: shape of distribution.** Benchmark whose spread consistently 3% on
  one machine and 40% on another tell you about benchmark, not machines.

Because absolute timings not portable, every results file record machine that
produced it: CPU model, logical core count, total memory, platform, OS
release, architecture, Node and V8 versions, commit, and whether working tree was
dirty. When `--baseline` given, two environment blocks compared *before*
table printed, and loud banner appear above it if CPU model, core count,
platform, architecture or Node major version differ — or if baseline file
record no environment at all, which itself something you cannot check.

Banner warn; never refuse. Comparing across machines on purpose ("does this
regression reproduce on ARM?") legitimate — just must be labelled.

## Calibration

No benchmark definition carry iteration count. Each worker:

1. Warm `fn` up **by elapsed duration** — ~250 ms untimed calls — so timed
   loop measure optimized code rather than optimizer.
2. Measure warmed `fn` to pick inner **batch size** that put one timed sample
   safely above clock resolution.
3. Buy as many **samples** as ~1 second time target afford, between 5 and 500.

So 4 µs parser call (batch ~250, 500 samples) and 110 ms bulk insert (batch 1, ~9
samples) both get comparable statistical weight without hand-tuning either. Every
knob is one commented object, `CALIBRATION`, in `bench/lib/calibrate.mjs`.

Batching is why batched row's Min and Max are batch means, and why **`fn` must be
repeatable back-to-back without `setup` running between calls**.

Setting `iterations` or `warmup` on benchmark pin it out of calibration entirely and
mark it `pinned`. Escape hatch for benchmark whose per-call cost change as it
run, where measuring few warm calls not represent rest. Pinned benchmark
collect too few samples for spread to be trusted, so reported unstable and
never gated on.

## Noise floor: when a delta is a change

Old rule was flat 20%: any median more than 20% above baseline was red. That rule
wrong both directions. `execution/group-by-10k` produced medians of 58.22 ms and
65.03 ms in consecutive runs of unchanged tree — 12% delta entirely noise, in
run whose own spread was 63%. Meanwhile `execution/distinct-text-10k` reproduce within
3% across runs, so real 15% regression there was invisible under same flat rule.

Each delta now judged against floor built from **both** runs' spreads:

```
noiseFloor% = max(5, sqrt(currentSpread² + baselineSpread²))
```

Quadrature, because two runs' noise independent — adding them double-count and
taking larger ignore one. 5% minimum stop benchmark that happened
to report near-zero spread from gating on 1% deltas, which no wall-clock measurement on
general-purpose machine support.

Verdicts:

| Condition | Verdict | Gated? |
| --- | --- | --- |
| `abs(delta) <= noiseFloor` | **no change**, uncolored | no |
| `delta > noiseFloor` and `delta > 10%` | **regression**, red | **yes** |
| `delta < -noiseFloor` and `delta < -10%` | **improvement**, green | no |
| clears the floor but not the 10% minimum | printed with its percentage, plainly | no |

Floor printed in `Noise` column beside every delta, so reader see *why*
12% delta called no change without reading source.

**Benchmark unstable in either run is never regression.** Delta still printed and
row still say `not gated`, and summary count how many excluded. Benchmark
that cannot hold stable number is bug in benchmark, not signal about engine.
Baseline median that round to zero treated same way — no delta to
compute — rather than emitting `Infinity`.

**What floor cannot see.** Built from each run's *own* samples, so measure
within-run noise and nothing else. Whole run displaced by background load — every
benchmark moving same direction by similar amount — still read tight, and
displacement can exceed floor. Measured while building this: two full 27-benchmark runs
minutes apart on unchanged tree, on machine also running other work, produced
two gated "regressions" whose spreads were 3-6% in *both* runs. So treat red result on
busy machine as prompt to re-run, not verdict, and do not wire this exit code into
automatic gate until between-run estimate exists — repeating runs and taking median of
medians, subtracting common-mode shift, or requiring regression to reproduce twice.
Exactly why [regression gate](#regression-gate) (`yarn bench:gate`) never
compare absolute millisecond figure against anything: it gate on work counters, and
where it time something it divide two medians from *same run* (see
[Ratio guards](#ratio-guards)) — quotient displacement above move both sides of, and
so not move at all.

Results file written before spreads were recorded have spread assumed 20%:
widest a run could be and still be called stable, so assumption only make
comparison more forgiving. Banner say how many entries needed fallback.

## Outcomes that are not deltas

Every benchmark in either run appear in comparison exactly once, and run close
with count of each outcome. Comparison that silently drop what it could not evaluate
read green when it not.

*Unstable*, *new* and *missing* each get line per benchmark, because each carry own
reason. *Filtered* names share one wrapped block instead: all have same reason, and
narrowing 27-benchmark baseline to one suite otherwise printed 23 identical sentences that
pushed lines reader had to act on off top of screen.

- **new** — in this run, absent from baseline. Not failure.
- **missing** — in baseline, absent from this run: renamed, deleted, or never started.
- **filtered** — in baseline and excluded by `--filter`. Reported separately from
  *missing* so narrowed run not look like deletion.
- **failed** — benchmark threw, hung or died this run. Row read `FAILED` and
  run exit non-zero.
- **unstable** — measured, but too noisy in one run or other to gate on.
- **skipped** — benchmark declined to run (see below). Distinct from *missing*:
  still in suite, so baseline entry not reported as deletion. No effect on exit code.

### A benchmark that declines to run: `skip()`

Benchmark may declare `skip()` alongside `fn`. Return **reason** to decline, or
`null` to run:

```js
{
	name: 'full-scan-10k@store-mem',
	async skip() { return (await storeAvailable()) ? null : 'store module is not installed'; },
	// setup / fn / teardown / counters as usual
}
```

Two exist today, both decline for same reason — `@quereus/store` will not load.
One attached by `expandBackends` from backend's `skipWorkload` (see
[Storage backends](#storage-backends-and-what-a-name-means)) and cover `@store-mem`
rows. Other hand-written once in `store` suite — one `skipUnlessStoreLoads` shared by
all entries, which have no backend dimension to attach one for them; it call
same `storeLoadFailure()` so give same reason.

Evaluated in **worker**, before `setup`, in own phase — because reason a
benchmark decline usually runtime fact (module that will not load, missing
binary, environment variable), and parent import suites for metadata only. A
`skip()` that *throw* is benchmark failure in phase `skip`, not silent run.

Skipped benchmark **keep its row**, printed as `skipped — <reason>`, recorded in
results JSON under top-level `skipped` array of `{name, reason}`. In neither
`benchmarks` (produced no numbers) nor `failures` (did not fail). Being in none of
three is one thing it must not be: absent benchmark read as *unchanged* to
anyone diffing two runs, exactly wrong claim.

`counters()` never run on skipped benchmark, so counter verdict is `none` — "not
comparable", same claim failed or filtered row make — and never `dropped`, which
would say benchmark deliberately stopped reporting counts.

### Informational rows: reported, never gated

Some numbers worth printing, not worth failing build over. Row whose timing
dominated by machine's disk, filesystem or page cache measure something
**not property of this repo's code** — no care in workload change
that, and gating on it make slow disk look like regression in engine.

Such row is **informational**. Flag declared on *backend*, not per benchmark:

```js
export const STORE_LEVELDB_BACKEND = {
	id: 'store-leveldb',
	informational: true,
	// …
};
```

`expandBackends` stamp `informational: true` onto every benchmark that backend produce,
so no suite file must remember and no future workload can forget. Row on ordinary
backend carry no such key at all.

What flag change, and what it deliberately not:

- Row print cyan **`informational`** marker as trailing word — way `unstable`
  and `pinned` print — on measured, skipped and failed rows alike.
- Against baseline compared exactly like any other row, and **status still say
  `regression`** when number moved. Suppressing status suppress the very
  signal row exist to give. Only *gating* change: row never counted toward
  exit code, and run print yellow line saying how many advisory rows regressed,
  so red status next to exit code 0 read as policy not harness bug.
- **No ratio guard may name one.** Guard whose target or baseline informational is
  reported `misconfigured` — failure — and that case checked *before* every other,
  so cannot hide behind "not selected by `--filter`". Anchoring build-gating ratio to
  disk-dependent number is mistake this refusal exist to make impossible.
- Results JSON carry top-level `informational` array of full names, sorted, so
  gate script identify advisory rows without parsing names for `@` suffix.

Benchmark that *fail* on informational backend still fail run. Not
inconsistency: advisory number exempt from gating, but benchmark that threw, hung
or died is broken benchmark whichever backend it ran on — and can only happen on run
that opted in.

## Work counters: exact-count comparison

Benchmark can also report **work counters** — exact counts of plan nodes, instruction
executions and engine-to-module calls, defined in
[Runtime Work Counters](runtime-work-counters.md).
Judged nothing like timing:

- **Delta** say "this might be slower" — measurement noise can fake that, so need
  noise floor built from both runs' spreads (above).
- **Counter delta** say "this does different work" — exact integer, identical on every
  machine and every run of same plan, so need no floor at all.

Different claims, so never share column. Counter comparison have **no tolerance and
no minimum delta**: difference of one is reported, every difference listed as
`before -> after` not percentage.

### Adding a `counters()` pass

Benchmark opt in with second, untimed entry point, alongside `fn` in object shown
under *Adding a benchmark* below:

```js
import { snapshotStatement } from '../lib/counters.mjs';

// … then one more member alongside `fn`, in the same benchmark object:
async counters() {
	return snapshotStatement(db, 'select ...');
},
```

`counters()` run **once, after timed loop and before `teardown`** — never inside `fn`.
Runtime metrics wrap every streaming operator in counting generator, so turning them on
inside timed loop corrupt the very number harness exist to measure; separate
untimed pass keep two concerns apart. `snapshotStatement` (one statement) and
`snapshotStatements` (named sequence — instruction keys are addresses within one program, so
two statements' counts must never be summed under one name) live in `bench/lib/counters.mjs`,
alongside `snapshotPlanShape` for benchmark that only want plan-shape facts.

**Drain result fully before reading counters** — see drain requirement under
*Adding a benchmark* above; partial drain read as change in engine when nothing
changed but loop.

### Storage round trips: what a `store-mem` row counts

For store backend interesting count not instruction tally — it **how many
times engine went to storage, and with how many keys**. Change that doubled
round trips behind secondary-index scan leave every engine counter untouched.

So `@store-mem` benchmark's block nest. `engine` is same `WorkCounterSnapshot` the
bare row report; `store` keyed by **built store name** — what key-value provider is
keyed by, so stable across runs and say which physical store traffic hit:

```json
{
  "engine": { "...": "the usual snapshot" },
  "store": {
    "main.bench_t": {
      "iterateEntries": 0, "getManyCalls": 1, "getManyKeys": 10, "singleGets": 0,
      "directPuts": 0, "directDeletes": 0, "batchWrites": 0, "batchOps": 0
    },
    "main.bench_t_idx_bench_t_val": {
      "iterateEntries": 10, "getManyCalls": 0, "getManyKeys": 0, "singleGets": 0,
      "directPuts": 0, "directDeletes": 0, "batchWrites": 0, "batchOps": 0
    }
  }
}
```

That `filtered-scan-index-10k@store-mem`, and it read: ten entries pulled from
secondary index, then **one** batched read carrying ten keys to fetch rows, and no
writes at all — read workload. If row resolution ever stop batching,
`getManyCalls` go to 10 and `singleGets` take keys.

Eight counts, **not** raw field names of `CountingKVStore` in
`@quereus/store/testing` — that class's `getMany` deliberately route every key of batch
through own counted `get`, so `getCount` not what name suggest:

| Field | Means |
| --- | --- |
| `iterateEntries` | entries pulled from `iterate()` — a scan's volume |
| `getManyCalls` | batched reads issued: **the read-side round-trip count** |
| `getManyKeys` | keys those batched reads carried |
| `singleGets` | reads genuinely one key at a time (`getCount - getManyKeyCount`, derived once, in `bench/lib/store-counters.mjs`) |
| `directPuts` | puts issued one at a time, outside any batch |
| `directDeletes` | deletes issued one at a time, outside any batch |
| `batchWrites` | batch commits issued: **the write-side round-trip count** |
| `batchOps` | put/delete operations those commits carried |

**Both sides.** `CountingKVStore` count reads (`get`/`getMany`/`iterate`) and writes
(point `put`/`delete`, plus `WriteBatch.write()` commits and operations they carried),
so write workload's block say both what its writes COST and what they PROVOKED in reads
— index maintenance, uniqueness probes, read-modify-write. `bulk-insert-10k@store-mem`
reporting 30 000 `singleGets` for 10 000 inserted rows is three reads per row; its
`batchWrites` / `batchOps` are other half of story.

Write side answer question no read count can. Whether committing N queued operations
cost flat number of round trips or one per operation is claim about `batchWrites`, and
cannot be recovered from read counters by picking cleverer workload: any workload
that queue N operations also touch N rows, so read counts linear in N whatever
commit path do.

**What `batchWrites` is fact about.** Counting provider expose no
`beginAtomicBatch` — its in-memory stores share no commit domain — so transaction
coordinator take per-store fallback: one `WriteBatch` per touched store. Provider
that DOES have shared commit domain (LevelDB family) commit same transaction as
one cross-store atomic write instead. These are store LAYER's round trips over
in-memory provider, not prediction of what real backend physically issue.

Store opened but never touched stay in block with eight zeros. Different claim
from store never opened at all, which is absent — and comparison report
appeared or vanished path exactly as loudly as changed count.

Two mechanics worth knowing:

- Counters pass build **second database**, over counting provider, so counting
  wrapper never sit inside timed number. Cost ~second across all nineteen
  store rows of ~150 s run.
- Each pass must say where *fixture* end and *measurement* begin, or ten-key
  index probe buried under ten thousand fixture inserts. `execution` binder
  do it structurally (fixture, then reset, then statement); `mutation` workload do
  it by calling `ctx.beginMeasured()` at own boundary — no-op on backends that count
  nothing.

Counter portability across machines is **assumption, not fact**: nothing has yet
compared counter blocks from two machines, and plan choice can in principle differ on
slower one — one known mechanism is join-order rule's wall-clock budget, which
engage only on plans with two or more join nodes. [Regression gate](#regression-gate)
(`yarn bench:gate`) gate on these counters, and exclude exactly that mechanism by
refusing to gate any benchmark whose observed plan carry two or more join nodes.

### Which suites qualify

Whether benchmark can report counters depend on what it do, not arbitrary
per-suite switch:

| Suite | Declares `counters()` | Why |
| --- | --- | --- |
| `execution` | 30 / 30 | Every benchmark run statement to completion; `snapshotStatement` rerun same query untimed. 15 `@store-mem` rows add `store` block. |
| `mutation` | 8 / 8 | Writes are statements too — same treatment. |
| `planner` | 4 / 4 | `snapshotPlanShape` only. These benchmarks compile plan and deliberately never execute, so no instruction or table access to count — only plan shape. |
| `parser` | 0 / 4 | Nothing to count: no `Database`, no plan, no runtime. |
| `store` | 14 / 25 | 11 key-encoding rows call store functions directly — no `Database`, nothing to count. 14 hot-path rows all report `store` round-trip block over counting `store-mem` database and **assert** it in pass: thirteen pin exact per-field integers on table stores they name, catalog-rehydrate row pin "every table store saw nothing", which is claim reopening make. Reserved `__catalog__` / `__stats__` blocks reported but never asserted — counts are catalog-layout facts, not contracts. Twelve rows also report `engine` block; index-build row report `store` block only (timed body is DDL plus verification scans, not one statement), catalog-rehydrate row report what rehydration found instead of engine counts. |

### `--no-counters`

`yarn bench --no-counters` skip untimed pass entirely — timings only, at cost of
losing counter columns. Results file can end with no counters for two different
reasons, one field tell them apart: `counters_collected` is `false` only when run
itself invoked with `--no-counters`; benchmark that simply declare no `counters()` pass
leave `counters_collected: true` and is absent only on own entries.

Flag read off **this** run, never off baseline. Run invoked with
`--no-counters` report every benchmark's counter status as `skipped` rather than
`dropped` — timings-only run must not read as whole baseline's counters
disappearing. Other direction different verdict: counter-collecting run
compared against `--no-counters` *baseline* report `new` per benchmark, because
nothing on baseline side to have changed from.

### Reading the output

When counter data available, table gain `Counters` column: `same`, `N diff`,
`new`, `dropped`, `skipped`, or `—` when neither side collected any.

Below table, each `changed` benchmark get block listing every differing path as
`before -> after` — capped at `COUNTER_CHANGES_SHOWN` (12) lines per benchmark in
printed output, full uncapped list always in results JSON under `comparison`.
`dropped` benchmark get one line saying baseline reported counters and this run did
not, no path list: nothing to list against run that collected none.

## Regression gate

`yarn bench:gate` is automatic half of suite, only half wired into
`yarn check`. Run two passes, fail if either find difference:

1. **Work counters.** Re-measure every counter-declaring benchmark and fail when any count
   differ from checked-in reference set — so change that make engine do more
   work caught day it lands, not months later when someone happen to compare two
   runs.
2. **[Ratio guards](#ratio-guards).** Time only benchmarks a suite's `ratioGuards`
   name, and fail when one benchmark's median exceed declared bound against
   another's *in same run*.

**No absolute wall-clock figure gate anything.**
[Noise floor](#noise-floor-when-a-delta-is-a-change) built from within-run spread and
blind to whole-run displacement, so millisecond gate on one machine cannot tell
regression from background load. What gate instead is machine-portable: work counters,
exact integers compared for equality — no floor, no threshold, no re-run — and
within-run ratios, where machine speed cancel out of quotient.

**Reference set** is one file per suite in `bench/reference/<suite>.json`, checked into
git: expected counter block per benchmark, plus `accepted` block recording who
accepted it, at which commit, and why. Files pretty-printed with sorted keys so
change is readable diff — git history of `bench/reference/` is log of every
accepted change to how much work engine do.

**Counters pass run every benchmark in one process,** unlike `yarn bench`, which fork
worker per benchmark. Forking load-bearing for timings — interpreter share call
sites across query shapes, so benchmark's measured speed depend on what ran before —
but not for counts: single-process pass produced counter blocks byte-identical to
forked run's for all 56 benchmarks, and save ~22 s of forks and `dist/` imports. Nothing
timed in it, so it run each benchmark's `skip`/`setup`/`counters`/`teardown` and never
timed loop.

**Guard pass fork, because it time.** Run after counters pass and only in
gate mode — never under `--accept`, which record reference and reach no verdict. Time
only benchmarks some suite's `ratioGuards` name (8 of 92 rows today), one
per forked worker exactly as `yarn bench` isolate timed benchmark, at reduced
`GATE_CALIBRATION` profile in `bench/lib/calibrate.mjs` — third of manual runner's
timed work per benchmark, which keep pass to seconds. Guard that **fail**
there re-measured once at full `CALIBRATION`, and re-measure decide: fail-then-pass
do not fail run. Busy machine therefore cost wasted re-measure, not false red,
and two measurements print as one verdict not two rows.

**Inside `yarn check`, and what it costs.** Chain run `docs:check → lint → build →
typecheck → bench:gate → test:full → …`. On machine wall-clock figures above come
from, gate add ~35 s: 25 s counters pass, 9 s guard pass across
8 forks, against ~160 s full `yarn bench` cost. Sit **after `typecheck` and
before `test:full`** on purpose: chain is `&&`-chained, `test:full` by far longest
step, and gate need nothing but built `dist/`, which `build` two steps
earlier produced from scratch (root `build` run `yarn clean` first). 35-second step
ahead of long one surface changed work counter in ~minute instead of after
whole test run — do not "tidy" it to end. Dirty tree is normal development
case and gate never refuse it: print dirty-tree banner and gate anyway (only
`bench:accept` refuse, because only accept record provenance commit). Run on own
against stale or absent `dist/`, fail with import error like every other bench
entry point; build first.

**`--report-only`** print every finding and still exit 0; env var
`QUEREUS_BENCH_GATE_REPORT_ONLY` (any value but empty or `0`) do same for callers that
cannot edit command line. Suppress *findings*, never breakage: bad flag,
unreadable reference or suite that will not load still exit non-zero. Two situations
justify it — release branch pinned to deliberately stale reference, and machine too
loaded to trust guard pass on — and it **not** standing setting: gate that
report and never fail is gate nobody read. Refused outright with `--accept`.

**What gates and what does not.** Benchmark gate only when observed plan carry at
most one join node. Join order on three or more relations chosen under wall-clock
budget (`bug-join-order-depends-on-wall-clock` in backlog), so those counts not
provably same on another machine. Gate recompute this eligibility from each run's
own counters — reference file's `gated` flag is documentation, never authority —
name every ungated benchmark in report, and still record counts so change
stay visible. Today nothing excluded: no benchmark's plan have two or more join nodes.
LevelDB rows never gate either: `bench:gate` delete `QUEREUS_BENCH_LEVELDB` from own
environment before loading suites, and say in report when it was set.

**Outcomes.** `differs` (gated count changed), `missing` (in reference, produced no
result this run) and `failed` (threw during pass) fail run; `match`, `new` (ran,
not yet in reference), `ungated`, `skipped` and `filtered` do not. Suite that
produced counter blocks but have no reference file fail — as do one whose reference file
exist but record *no benchmarks*, so emptying file cannot turn suite into set of
benign `new` rows — as do reference file naming suite that no longer exist.
Deleting or emptying `bench/reference/` cannot make gate green. (Deleting *part* of
file still can: from inside one run removed expectation and genuinely new benchmark are
same observation, so defense there is `bench/reference/` checked in and its
diff get reviewed.) Each
`differs` benchmark print every changed path as `path  before -> after`, capped at 12
lines per benchmark with elision announced, uncapped under `--json` (outcome object
on stdout, human report on stderr — same routing as `yarn bench`).

**Accepting a change.** When difference intentional:

```
yarn bench:accept --reason "hash join now probes the build side once per batch"
```

re-run full pass and rewrite only reference files whose benchmark contents
actually changed, so untouched suite's `accepted` provenance survive in git history.
`--reason` required — reference that change without recorded reason is reference
nobody trust. Accept refuse on dirty working tree (recorded provenance commit would
be lie) unless `--allow-dirty` passed, refuse `--filter` (reference always
full re-measure), and refuse to write while any benchmark failed or while
previously-recorded benchmark skipped this run — unbuilt `dist/` must not silently erase
suite's expectations. Writes atomic (temp file, then rename), so concurrent gate
run never read half file.

## Ratio guards

Suite may export `ratioGuards`: bound on one benchmark's median against another's,
*within same run*. Both `yarn bench` and `yarn bench:gate` evaluate them, and gate
run in `yarn check` — so guard here is build gate, not report.

```js
export const ratioGuards = [
	{
		name: 'correlated-subquery',
		baseline: 'hand-batched-peer-count',
		maxRatio: 10,
		note: 'catches `scalar-agg-decorrelation` failing to fire',
	},
];
```

Catch plan-shape regression from single run with no baseline file at all. If
`scalar-agg-decorrelation` stop firing, correlated form go N+1 against
hand-written twin and ratio spike, whatever absolute timings on that machine.
Ratios are portable measurement, which make this strongest gate suite has.

**Fields.** `name` is benchmark under test, `baseline` the one its median
divided by, `maxRatio` largest acceptable quotient. `note` optional but write one
for every guard: sentence saying what guard protect, printed in brackets beside
verdict, so red line say *what broke* rather than only which two rows moved apart.

**`maxRatio` may be below 1.** Natural shape when regression being guarded
against is fast path collapsing into slow path it normally small fraction of:
`filtered-scan-index-10k` sit at ~0.01× `full-scan-10k` and land near 1× if index
selection stop firing, so bound is 0.1× — order of magnitude clear of both.
Verdicts print ratios to two decimals for exactly this reason.

**Names may cross suites.** Bare `name`/`baseline` resolve within declaring suite;
name containing `/` is full `suite/name` and used as written, which is how guard in
one suite bound benchmark in another. Cross-suite name pointing at nothing is
ordinary "not found in this run" misconfiguration — nothing special-case it.

**Shape validated when suite load,** in parent process, before any benchmark
run: `ratioGuards` not array, entry missing `name` or `baseline`, `note`
not string, or `maxRatio` not finite number greater than zero all
throw by name. Last one is two opposite bugs from one typo — `maxRatio: 0` fail every
run unconditionally, `maxRatio: NaN` compare false against everything and pass forever —
neither allowed to reach run. Rule behind all: guard that quietly
never evaluate is guard everyone believe protect them.

**Bound it against what you measured.** Take ratio from real `yarn bench` on
unchanged tree, record in comment beside guard, set `maxRatio` at least 3×
clear. Bounds here order-of-magnitude by design: trip plan-shape collapse,
not warm-up variance. Guard that fire on good day train everyone to ignore gate.

Guard naming benchmark not selected reported *skipped* when `--filter`
active (narrowing run should not make every guard fire) and *misconfiguration* —
failure — when not. Guard naming benchmark that failed, or one whose `skip()`
declined to run it, reported *not evaluated* and never misconfiguration: neither
is guard naming something that not exist, and failing run over skip make
every skip red build.

**Guards name one benchmark each, meaning one backend each.** Bare name in
`ratioGuards` entry is default backend's row. Guards deliberately **not** expanded
across backends: ratio that hold on in-memory vtab need not hold on persistent
store, and guard that silently multiply itself across backends is guard nobody
trust. Guard wanting to bound suffixed benchmark spell suffix out.

**Do not write cross-backend guard.** Bounding `x@some-backend` against bare `x` price
storage engine against in-process array; number it encode is this machine's
ratio between two unrelated things, not property of either engine. No portable
value for `maxRatio` there, so no guard to write.

**Guard naming [informational](#informational-rows-reported-never-gated) row is
misconfiguration**, and that rule above made mechanical: fail run, and
checked before not-selected and declined cases so `--filter` cannot hide it. A
build-gating ratio anchored to number that move with machine's disk not gate.

## Which check catches what

Three separate things in this repo measure speed. Not redundant, and new
check belong in exactly one.

| | Runs in | Measures | Catches |
| --- | --- | --- | --- |
| **Performance sentinels** (`packages/quereus/test/performance-sentinels.spec.ts`) | `yarn test` | absolute milliseconds, 10-50× headroom | order-of-magnitude collapses, on any machine. Only speed check inside test run. |
| **The regression gate** (`yarn bench:gate`) | `yarn check` | exact work counts and within-run ratios — never wall-clock | small changes a 10× threshold cannot see: one more store round trip, one more row visited, plan shape that stopped being chosen. |
| **`yarn bench`** | nothing; manual | absolute timings, spreads, deltas against saved baseline | how fast engine actually is. Only place absolute timings measured; exit code wired into nothing automatic. |

**Where new check goes:** gate, unless it must run inside `yarn test`.

Sentinels **not** replaced by gate, nor merged into it: overlap in
coverage, not in when they run. Two suites do reach similar workloads by different
code, and reconciling that is own piece of work
(`debt-perf-sentinels-share-bench-workloads` in backlog).

## Exit-code contract

`yarn bench` exit non-zero on any of:

- benchmark failure (threw, timed out after 120 s, or died without reporting),
- ratio-guard failure or misconfiguration,
- gated regression, meaning delta that cleared both noise floor and 10% minimum
  on benchmark stable in both runs.

Unstable benchmarks, new benchmarks, missing benchmarks, sub-threshold deltas and
[informational](#informational-rows-reported-never-gated) regressions never contribute to
exit code. Informational benchmark that *failed* still do — exempt number is
not exempt benchmark.

**`yarn check` run `yarn bench:gate`, never `yarn bench`.** Gate's own exit code
is the one chain read: non-zero on differing gated counter, failed or misconfigured
ratio guard, benchmark that threw, or harness error — and zero under
`--report-only` / `QUEREUS_BENCH_GATE_REPORT_ONLY` for everything except that last class.
`yarn bench`'s exit code above stay wired into nothing automatic, because it can turn red
from background load alone.

Both entry points budget around `memory` and `store-mem` backends only; gate
additionally delete `QUEREUS_BENCH_LEVELDB` from own environment, so developer with
it exported get same verdict as anyone else. LevelDB rows add ~75 s of
disk-bound work whose numbers, by construction, cannot gate anything.

## `--json`

Under `--json`, stdout carry result object and nothing else — human table,
progress lines, environment banner and guard verdicts all move to stderr, and ANSI
colour suppressed. Object is exactly what written to `bench/results/`, so
consumer never care which of two it reading. Include `environment`,
`benchmarks`, `failures`, `skipped`, `informational`, `ratio_guards`, `baseline` and
`comparison`.

```
node bench/run.mjs --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(Object.keys(JSON.parse(s))))"
```

Colour also suppressed whenever human stream not interactive terminal, so
captured log stay readable.

## Adding a benchmark

`parser`, `planner` and `store` hold benchmark objects directly; add entry to
relevant `bench/suites/*.bench.mjs`:

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

For `execution` and `mutation`, add **workload** instead — suite file bind it to
every backend for you. `execution` workload is plain data:

```js
// bench/workloads/execution.mjs, in QUERY_WORKLOADS
{
	name: 'my-shape-10k',
	fixture: 'populated',            // a key of FIXTURES, which populates a db it is handed
	sql: 'select ... from bench_t',  // the ONE statement fn times and counters() snapshots
	expectedRows: 10000,             // asserted by fn
}
```

`mutation` workload is small bundle of functions over `db`, because timed body
is procedure not statement. Declare `lifecycle`: `own-database` when
timed body is database's whole life (binder open fresh one per call, since
table left behind change what next call cost), or `shared-fixture` when `populate`
can run once in `setup` because `run` reach fixed point.

Fixture never construct `Database` — populate one it handed. That what let
same definition run on different storage engine.

Requirements:

- **`fn` must be repeatable back-to-back without `setup` between calls.** Calibration will
  batch it, and benchmark that only work first time report cost of failing.
- **`fn` must assert own result.** Query that silently return zero rows is very fast
  and completely meaningless; row-count check stop broken benchmark from
  reading as improvement.
- Names must be unique within suite — `suite/name` is identity `--filter`,
  baseline comparison and ratio guards all key on. Renaming benchmark show up as
  one *missing* and one *new*, intended signal.
- Prefer shape with plausible slow counterpart, give it `ratioGuards` entry. Guard
  that fire from single run worth more than delta needing baseline file
  from same machine.
- **Add `counters()` pass if benchmark run statement.** Second, untimed
  entry point alongside `fn`, and what make plan change visible without
  same-machine baseline. See *Work counters* above for shape and helpers.
- **Benchmark whose one call far below millisecond must amortize inside `fn`**,
  way `store` suite do with shared `KEYS_PER_CALL`. Below that scale `await`
  around `fn` is meaningful share of reading. Say in comment what reported
  figure count, use one constant across every benchmark meant to be compared.
- **`bench/suites/` currently OUTSIDE type pass.** `tsconfig.test.json` include
  `bench/lib/**` and `bench/workloads/**` but not `bench/suites/**`, so suite file's own
  `checkJs` errors surface only when benchmark run. `store.bench.mjs` written to
  compile clean under that pass and verified; three of other four (`execution`,
  `mutation`, `planner` — `parser` clean) report 21 mostly implicit-`any` errors, which
  stand between here and widening `include`. Parked as
  `debt-bench-suites-outside-type-pass`. Until
  done, renamed `@quereus/store` export caught by annotated resolution in
  `bench/lib/store-counters.mjs` (which *is* checked) rather than at suite's call site.
- **Drain result fully if you read work counters from it.** `Statement.getWorkCounters()`
  report what execution actually did, so benchmark that stop early — `LIMIT`,
  `break` out of loop, abort — leave partial `rowsScanned` whose value depend on
  where it stopped. Counts only reproducible run-to-run once iterable exhausted.
  See [Runtime Work Counters](runtime-work-counters.md).

## Where the code lives

| File | Responsibility |
| --- | --- |
| `bench/run.mjs` | Parent orchestrator: arguments, forking, table, comparison output, exit code. Never run benchmark work itself. |
| `bench/child.mjs` | Worker: run exactly one benchmark, report raw samples over IPC. |
| `bench/gate.mjs` | [Regression gate](#regression-gate) and accept entry point: arguments, single-process counters pass, forked [ratio-guard](#ratio-guards) pass, report, exit code. |
| `bench/lib/guards.mjs` | [Ratio-guard](#ratio-guards) rules — member selection, verdict classification, re-measure fold, gate's exit rule, verdict report — as pure functions shared by `run.mjs` and `gate.mjs`, which can never import each other. |
| `bench/lib/reference.mjs` | Gate's rules — reference file read/write, gate eligibility, outcome classification, accept validation — as pure functions over plain objects. |
| `bench/reference/*.json` | Checked-in expected counter blocks, one file per suite, rewritten only by `yarn bench:accept`. |
| `bench/lib/calibrate.mjs` | Timing policy — warmup, batch sizing, sample count. Kept out of worker so `test/bench-calibration.spec.ts` can drive it. |
| `bench/lib/stats.mjs` | Median, percentiles, relative IQR, summary record, noise floor. |
| `bench/lib/compare.mjs` | Cross-run comparison rules, as pure functions over two result objects. |
| `bench/lib/counters.mjs` | Helpers a benchmark's `counters()` pass use: `snapshotStatement`, `snapshotStatements`, `snapshotPlanShape`. |
| `bench/lib/environment.mjs` | Environment capture and material-difference check. |
| `bench/lib/discover.mjs` | Suite enumeration and one definition of what `--filter` match (`matchesFilter`), shared by parent, worker and comparison. |
| `bench/lib/backends.mjs` | Storage-engine dimension: `BenchBackend` descriptor, `BACKENDS` set, `expandBackends` — one workload × N backends → N benchmarks, named by bare-name rule, each backend's `skipWorkload` wired into benchmark's `skip()`. |
| `bench/lib/store-counters.mjs` | Everything touching `@quereus/store`, behind harness's one dynamic import: plain and counting `store-mem` databases, and round-trip block they report. |
| `bench/lib/leveldb-backend.mjs` | Everything touching `@quereus/plugin-leveldb`, behind own dynamic import: `QUEREUS_BENCH_LEVELDB` opt-in, skip reason, `store-leveldb` database over temporary directory. |
| `bench/lib/tempdir.mjs` | Fresh-per-call temporary directories for disk-backed rows, and PID-owned sweep removing ones killed worker could not remove itself. |
| `bench/workloads/*.mjs` | What `execution` and `mutation` suites measure, as data plus fixtures. Suite files are binders over these. |

Harness tests, none run a benchmark: `test/bench-calibration.spec.ts` (timing
policy and statistics), `test/bench-comparison.spec.ts` (cross-run rules and
environment check), `test/bench-backends.spec.ts` (backend expansion and naming
rule), `test/bench-gate.spec.ts` (gate's eligibility, classification, serialization
and accept-validation rules), `test/bench-guards.spec.ts` (ratio-guard rules and
suite-side guard validation). Neither `yarn bench` nor `yarn bench:gate` part of
`yarn test`, so these only automated check on harness itself.

See also [Architecture § Benchmark Suite](architecture.md#testing-strategy).