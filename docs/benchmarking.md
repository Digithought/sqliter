# Benchmarking

The benchmark suite lives in `packages/quereus/bench/`. It measures how long the engine
takes to do a fixed amount of work, and — more importantly — tries hard not to report a
difference that is only measurement noise.

Run it from the engine package:

```
cd packages/quereus
yarn bench
```

It is **not** part of `yarn test` or `yarn check`. A full run takes roughly 150 seconds and
is deliberately manual: a benchmark suite inside a test run either slows every test run
down or gets its time target cut until the numbers stop meaning anything.

## What is measured

73 benchmarks across five suites — 54 entries, of which the 19 in `execution` and
`mutation` are each measured against two storage backends (see below):

| Suite | Benchmarks | What it covers |
| --- | --- | --- |
| `parser` | 4 | Text to AST: a simple select, a complex select, a 50-column select, an insert with values. |
| `planner` | 4 | AST to optimized plan, without executing it: scan, join, aggregate, subquery. |
| `execution` | 30 (15 × 2 backends) | Whole queries over a 10 000-row table: full scan, indexed filter, group by, order by, distinct, joins, a correlated subquery and its hand-written equivalent. Seven of the fifteen are text-comparison shapes (`order by` text, unicode text, 40-character shared prefixes, text primary keys) because the `BINARY` collation comparator is the engine's hottest code. |
| `mutation` | 8 (4 × 2 backends) | Writes: a 10 000-row bulk insert, 1 000 single-row inserts, an update and a delete over a `where` clause. |
| `store` | 27 | The storage layer priced one path at a time, in three groups. Eleven rows call `@quereus/store` key-encoding functions directly, with no database in the picture — the value shapes where a fast path can be lost silently (plain integer, plain text, astral-plane text, JSON, a blob, a `NOCASE` key, a descending key and its ascending control, a four-column composite, a secondary-index key), plus one decode. Fourteen rows drive one storage hot path each — scan, point read, batched multi-key seeks, fetching rows found through a secondary index, commits at four sizes, an index build, a catalog rehydration — through a `Database` over the store module, and assert the exact storage round trips alongside the timing. Two rows price random reads against sequential ones on **real disk**, at the key-value layer with no database above them. See [The `store` suite](#the-store-suite-micro-benchmarks-with-no-backend-dimension). |

### The `store` suite: micro-benchmarks with no backend dimension

`execution` and `mutation` answer "how long does this query take against this storage
engine". That is the right top-level signal and a poor **diagnostic**: a full scan blends
key decoding, iteration, row deserialization and the isolation overlay into one number, so
a regression in any one of them reads as "the scan got slower" with no way to say which.
The `store` suite exists to give the individual pieces their own numbers.

It has three groups, in run order:

- **Key encoding** (11 rows: `data-key-*`, `index-key-*`, `decode-composite-4col`) calls
  `@quereus/store`'s key functions directly — no `Database`, no plan, no storage traffic.
  These rows report no counters, for the same reason `parser` reports none: nothing runs,
  so there is nothing to count.
- **Store hot paths** (14 rows: a full scan, a point read, two multi-key seek widths, four
  index-then-fetch widths, four commit sizes, an index build, a catalog rehydration) drive
  one storage code path each through a `Database` opened over the store module — the
  `openStoreDatabase()` / `openCountingStoreDatabase()` pair in
  `bench/lib/store-counters.mjs`, so the counting wrapper never sits inside a timed
  number. Each reports the same nested `{engine, store}` block a `@store-mem` row does
  (see [Storage round trips](#storage-round-trips-what-a-store-mem-row-counts)), and goes
  one step further: the `counters()` pass **asserts** the expected round-trip counts on the
  table stores it names, so a plan change that moved traffic between stores fails the pass
  loudly instead of shipping a silently different block. (The reserved `__catalog__` /
  `__stats__` blocks are reported but not asserted — see the counters table below.) Expected counts that depend on the row-resolution batch size
  are derived from the imported `ROW_RESOLUTION_BATCH`, never restated, so they move with
  the constant. The four commit sizes (1, 10, 100, 1000) together carry the claim no read
  count can — committing N queued operations costs a *flat* number of write-side round
  trips (`batchWrites` stays at one per touched store while `batchOps` scales with N);
  N = 10 000 was considered and deliberately dropped, because the shape is visible across
  three decades and a fourth would add hundreds of milliseconds per timed call for no
  additional claim.
- **Read cost on real disk** (2 rows: `leveldb-read-cost-20k`, `leveldb-read-cost-200k`) —
  the only rows in the suite that touch a provider with no `Database` above them, and the
  only ones that touch disk. See [Read cost on real
  disk](#read-cost-on-real-disk) below.

The first two groups split at `scan-10k` in the run order; the third follows both.

One thing differs from every other suite, deliberately: **its names carry no `@` suffix.**
The suite is not in the backend dimension. The key half calls store functions directly, so
there is no storage engine to swap underneath it; the hot-path half exists to measure *the*
store module specifically — the same query shapes on the memory vtab are `execution`'s bare
rows, not a missing backend of these. The invariant below — *every* entry of `execution`
and `mutation` is backend-expanded — is untouched; `store` is simply not in the backend
dimension at all.

Its `skip()` is the one place in the repo that hand-writes one — a single
`skipUnlessStoreLoads` shared by every entry — and it returns the same
`storeLoadFailure()` reason the `@store-mem` rows use, so an unbuilt
`packages/quereus-store/dist` skips these rows with a stated reason instead of failing all
twenty-seven with a module-resolution stack trace. The two read-cost rows compose a
*second* reason on top of it — the LevelDB opt-in below — so an unbuilt store package still
wins, being the more fundamental failure.

Every `fn` in the **key-encoding half** builds **1 000 keys per call** (`KEYS_PER_CALL` in
`bench/suites/store.bench.mjs`), one shared constant across every shape so the shapes stay
comparable to each other. A single key build costs on the order of a hundred nanoseconds
and the `await` around `fn` costs a microtask tick, so timing one build per call would
report mostly harness overhead. **Every figure in that half is therefore the cost of 1 000
key builds, not of one** — divide before quoting a per-key number. The hot-path half does
not amortize: its cheapest timed call is a whole statement over a 10 000-row store, well
clear of the scale where harness overhead is a meaningful share of the reading.

Fixture values are built in `setup`, never in `fn`, because calibration batches
sub-millisecond work and an `fn` that allocates its own input measures the allocation. The
assertions are split for the same reason: `setup` round-trips every fixture value through
`decodeCompositeKey(encodeCompositeKey(v))` and throws on a mismatch — that is what stops
the suite from measuring a broken encoder, and it is untimed so it costs nothing — while
`fn` asserts only the total encoded byte length, which is cheap and still catches an
encoder that stopped producing bytes. A full decode inside an encode benchmark's timed body
would cost about as much as the encode and halve the resolution of the thing being
measured. The one dedicated `decode-composite-4col` benchmark does assert value equality on
every column, because there the decode *is* the subject.

The suite adds roughly **51 s** to a default `yarn bench` run — about 16 s of it the key-encoding
half, the rest the hot-path rows and their per-row process forks — on the machine the
results-file header records. The two read-cost rows contribute about 1 s of that, being a
fork and a skip reason each; opted in they cost ~10 s instead.

Two rows exist only as controls and are not interesting on their own:
`data-key-asc-2col` (the uninverted twin of `data-key-desc-2col`, so the cost of the
encoder's DESC bit-inversion is a subtraction rather than a guess) and
`data-key-text-binary` (the twin of `data-key-text-nocase`, whose difference is the key
normalizer). `data-key-text-astral` is deliberately a *superset* of the plain text fixture —
the same string with four astral-plane characters appended — so its delta is attributable,
but it is not a controlled A/B on the surrogate-scan path alone: the astral string is also 8
UTF-16 code units and 16 UTF-8 bytes longer. Two strings cannot match on both counts while
one is astral and the other is not.

`bench/apply-schema-unchanged.mjs` is **not** part of any suite, deliberately and by a
decision recorded at the file itself: it is a decomposition of a no-op `apply schema` into
five internal timings, and the framework measures one `fn` per benchmark. Giving the
applied-state fast path a standing, ratio-guarded benchmark is separate work, parked as
`feat-bench-apply-schema-fastpath-guard`.

#### Read cost on real disk

`leveldb-read-cost-20k` and `leveldb-read-cost-200k` answer one question the rest of the
suite cannot: **on a real disk-backed store, how much more does a random read cost than a
sequential one?** That ratio is exactly what a provider's *cost profile* declares to the
planner (`packages/quereus-store/src/common/cost-profile.ts`), and LevelDB's had never been
measured — it took the framework's parity default instead.

Each row seeds N rows of 200-byte values into a fresh LevelDB temporary directory over
integer keys, then times **three arms** per round against that one dataset:

| arm | what it does | what it stands for |
| --- | --- | --- |
| sequential | a full `iterate()` draining every value | the 1.0 denominator — the cost-profile unit |
| batched | 1 000 random keys through `getMany`, paged at `ROW_RESOLUTION_BATCH` | resolving index entries to rows, and the primary-key multi-seek |
| single-seek | 1 000 *different* random keys, one `iterate({gte, lt, limit: 1})` each | the secondary-index multi-seek, one window per key |

Five properties are deliberate:

- **The arms measure the key-value layer, with no `Database` above them.** The unit a cost
  profile defines is a storage-layer row, and engine overhead lands on both sides of the
  ratio — including it would compress every ratio toward 1.0 and understate the difference
  being measured. It also matches the sibling IndexedDB harness
  (`packages/quereus-plugin-indexeddb/bench/README.md`), which is the only reason the two
  backends' numbers can be read side by side. The cost is that a ratio here is *not* the
  number to declare directly; the engine-inclusive value is smaller and was not measured.
- **All three arms share one benchmark per dataset size, not three.** The harness forks a
  fresh process per benchmark, so three rows would compare three medians taken with three
  different page-cache and block-cache histories. One `fn` call runs one round of all three
  arms in one process, and `teardown` takes the median per arm across rounds.
- **The harness's own median for these rows is the cost of one whole round, and is not the
  interesting number.** The interesting numbers are the per-arm milliseconds and the two
  ratios, which `teardown` prints to stdout. The block lands immediately *above* its table
  row, because `child.mjs` runs `teardown` and only then sends the result.
- **The ratios are printed, not reported as counters.** Counter values are compared with no
  tolerance and no noise floor, because they are exact machine-independent integers. A
  wall-clock ratio is neither, so a counters block would report a "change" on every run.
- **The two sizes do not separate page-cache-cold from page-cache-warm.** There is no
  portable way to drop the OS page cache from Node, and a dataset big enough to exceed a
  modern machine's page cache cannot be seeded inside a benchmark's time budget. What they
  separate is `classic-level`'s own **8 MB block cache**: 20 000 × 200 bytes (~4 MB) fits
  inside it, 200 000 (~40 MB) does not, so the large size's random reads go out to the
  filesystem — which on a warm machine usually means the OS page cache, not the physical
  disk. A claim of "cold" that is really "block-cache-miss, page-cache-hit" would be worse
  than no claim, so it is not made.

Like every disk-backed row, these two are **opt-in and [informational](#informational-rows-reported-never-gated)**:
without `QUEREUS_BENCH_LEVELDB=1` they print the same skip reason `@store-leveldb` rows do,
and they enter no ratio guard and no pass/fail verdict — a disk timing is not a property of
this repository's code. Opted in they cost about 10 s for the pair, the 200k row's own
median being ~1 s per round, well clear of the 120 s per-benchmark timeout.

```bash
QUEREUS_BENCH_LEVELDB=1 node packages/quereus/bench/run.mjs --filter store/leveldb-read-cost
```

The 2026-08-19 result is recorded in `packages/quereus-plugin-leveldb/README.md`
§ *Measured read cost*, with the machine it was taken on and what was decided from it.

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

Three backends exist today. The descriptors and the expansion live in
`bench/lib/backends.mjs`:

| id | what it is | name | gates a build? |
| --- | --- | --- | --- |
| `memory` | the in-process memory vtab module — the engine default | bare (`full-scan-10k`) | yes |
| `store-mem` | `StoreModule` wrapped by the isolation layer, over an in-memory key-value provider | `full-scan-10k@store-mem` | yes |
| `store-leveldb` | the same `StoreModule`, over **LevelDB on a real temporary directory** | `full-scan-10k@store-leveldb` | no — opt-in and [informational](#informational-rows-reported-never-gated) |

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

A suite needing more of the store package's surface **widens that one site** rather than
opening an import of its own. What it hands out today: `openStoreDatabase()` (the plain
timed database — its handle also carries the `provider` it was built over, for a benchmark
whose claim is about what physically landed in a store), `openCountingStoreDatabase()` (the
untimed counters database), and `loadStoreKeyApi()` (the store's key-encoding and
key-building functions, plus `ROW_RESOLUTION_BATCH` — read the constant, never restate
`256`, so an expected round-trip count moves with it). Every name is shape-checked as the
import resolves, so a renamed export becomes a stated skip reason instead of a throw inside
a benchmark's `setup`.

A backend declines a workload through `BenchBackend.skipWorkload(workload)`, which
`expandBackends` wires into the benchmark's `skip()` so no suite file has to remember to.
When a binder *also* supplies a `skip`, the two compose — the backend is asked first and
its reason wins, then the binder's is consulted — because a backend that cannot load makes
any workload-intrinsic reason moot. `store-mem` declines nothing per workload today: every
workload in both suites was confirmed to run on it and return the row count it asserts,
including the two divergences that looked most likely to bite (the store applies NOCASE to
an undecorated text primary key where memory applies BINARY, and the store's cost model may
validly pick a different join shape — neither changes a result).

#### `store-leveldb`: real disk, opt-in and advisory

`store-mem` deliberately measures the store layer with the disk taken out. `store-leveldb`
is the other half: the same isolation-wrapped `StoreModule`, over the LevelDB provider a
Node deployment actually runs.

**It runs only when you ask.**

```bash
QUEREUS_BENCH_LEVELDB=1 yarn workspace @quereus/quereus bench --filter @store-leveldb
yarn workspace @quereus/quereus bench:leveldb          # the same, over every suite
```

Without the variable every `@store-leveldb` row still **prints**, as
`skipped — disk-backed rows are opt-in and advisory — set QUEREUS_BENCH_LEVELDB=1 to run
them`. The variable is read as a human would read it: `0`, `false`, `off`, `no` and the
empty string all mean *no*, so setting it to turn the rows off does not turn them on.

Three properties are deliberate and worth knowing before you read a number:

- **`syncCommits` is left at its default `true`**, which fsyncs every transaction commit.
  That is what a deployment runs, and it is the single biggest term in what these rows
  cost — `single-row-insert-1k@store-leveldb` is a thousand statements and therefore a
  thousand fsync-ed commits. A benchmark that quietly turned it off would measure a
  configuration nobody uses.
- **Every row gets its own fresh temporary directory** under `os.tmpdir()`, never inside
  the working tree — a database under the repo survives `git status` unnoticed and on
  Windows can hold a lock that fails the next `yarn build`. LevelDB takes an exclusive
  directory lock, so per-*call* freshness is a requirement and not a nicety: the
  `own-database` mutation benchmarks open and close a whole store inside every timed call.
- **No storage round-trip counters.** The counting provider wraps an in-memory map, not an
  arbitrary provider, so this backend contributes timings only. Nothing is lost: round-trip
  counts are a property of the store *layer*, and `store-mem` reports them exactly, on
  every run, for free.

**Cleanup has three layers**, because no single one covers every way a run ends
(`bench/lib/tempdir.mjs`):

1. The benchmark's own teardown removes its directory — the normal path.
2. A process-level `exit` hook in the worker covers a throw, and covers the parent
   vanishing.
3. The **parent** sweeps at the end of the run. This layer is not a nicety: `run.mjs`
   `SIGKILL`s a worker that blows the 120 s per-benchmark timeout, and `SIGKILL`s the
   active worker on Ctrl+C — and a killed process runs no handler of any kind, so layer 2
   structurally cannot cover it.

The sweep never deletes by prefix. Every directory carries its owner's PID, and one is
removed only when that PID is force-listed by the parent (which just killed it) or no
longer alive, so two concurrent bench runs cannot delete each other's databases. That also
makes the sweep a **cross-run** backstop: if the parent itself dies without running a
handler — Task Manager, a CI tree-kill, or on Windows any `kill` from another process,
which terminates rather than signalling — the directory survives that run and the *next*
`yarn bench` collects it, because its owner is dead by then. A stale directory therefore
costs some disk until the next run and never reaches a measurement.

**What it costs**, measured on an AMD Ryzen AI 9 HX 370 / NVMe / Windows 11 machine under
node 24.2 — treat the absolute numbers as that machine's, not as a target:

| | wall clock |
| --- | --- |
| the 19-row `@store-leveldb` arm, opted in | 84 s |
| the same 19 rows skipping, on a default run | 9.2 s of a 163 s / 90-benchmark run (92 rows, ~1 s more, since the read-cost rows landed) |
| slowest single row (`mutation/delete-where-100@store-leveldb`) | 1.95 s median, ~14 s of wall clock |
| the 2 [read-cost rows](#read-cost-on-real-disk), opted in | 10.3 s (they share the opt-in but carry no `@` suffix) |

Nothing approaches the 120 s per-benchmark timeout. The 9.2 s a *default* run pays is the
price of the rows printing their skip reason instead of vanishing, and it is roughly
`0.5 s × rows` — a process fork plus a `dist/` import each, because the skip reason is a
runtime fact evaluated in the worker.

`@quereus/plugin-leveldb` is reached through **one lazy import site**
(`bench/lib/leveldb-backend.mjs`), for the same reason `@quereus/store` is: the parent
imports every suite file just to enumerate names, so a static import would let an unbuilt
`packages/quereus-plugin-leveldb/dist` — or a native binding that will not load on this
platform — kill the whole run, parser and planner suites included. Instead the rows skip
with the load error as their reason, and `yarn bench` completes.

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
| `yarn bench:leveldb` | The same as `yarn bench` with `QUEREUS_BENCH_LEVELDB=1`, so the [disk-backed rows](#store-leveldb-real-disk-opt-in-and-advisory) run instead of printing a skip reason. Adds ~85 s and gates nothing. Note `--filter @store-leveldb` reaches only the *backend* rows; the two [read-cost rows](#read-cost-on-real-disk) carry no `@` suffix and are filtered as `store/leveldb-read-cost`. |

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
This is exactly why the [regression gate](#regression-gate) (`yarn bench:gate`) times
nothing at all and gates on work counters instead; the within-run ratio half is the
follow-on ticket `bench-gate-ratios-and-check`.

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

Two exist today, and both decline for the same reason — `@quereus/store` will not load.
One is attached by `expandBackends` from a backend's `skipWorkload` (see
[Storage backends](#storage-backends-and-what-a-name-means)) and covers the `@store-mem`
rows. The other is hand-written once in the `store` suite — one `skipUnlessStoreLoads` shared by
all of its entries, which have no backend dimension to attach one for them; it calls the
same `storeLoadFailure()` and so gives the same reason.

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

### Informational rows: reported, never gated

Some numbers are worth printing and are not worth failing a build over. A row whose timing
is dominated by the machine's disk, filesystem or page cache is measuring something that is
**not a property of this repository's code** — no amount of care in the workload changes
that, and gating on it would make a slow disk look like a regression in the engine.

Such a row is **informational**. The flag is declared on the *backend*, not per benchmark:

```js
export const STORE_LEVELDB_BACKEND = {
	id: 'store-leveldb',
	informational: true,
	// …
};
```

`expandBackends` stamps `informational: true` onto every benchmark that backend produces,
so no suite file has to remember and no future workload can forget. A row on an ordinary
backend carries no such key at all.

What the flag changes, and what it deliberately does not:

- The row prints a cyan **`informational`** marker as a trailing word — the way `unstable`
  and `pinned` print — on measured, skipped and failed rows alike.
- Against a baseline it is compared exactly like any other row, and **its status still says
  `regression`** when the number moved. Suppressing the status would suppress the very
  signal the row exists to give. Only the *gating* changes: the row is never counted toward
  the exit code, and the run prints a yellow line saying how many advisory rows regressed,
  so a red status next to an exit code of 0 reads as policy rather than as a harness bug.
- **No ratio guard may name one.** A guard whose target or baseline is informational is
  reported as `misconfigured` — a failure — and that case is checked *before* every other,
  so it cannot hide behind "not selected by `--filter`". Anchoring a build-gating ratio to
  a disk-dependent number is the mistake this refusal exists to make impossible.
- The results JSON carries a top-level `informational` array of full names, sorted, so a
  gate script can identify advisory rows without parsing names for an `@` suffix.

A benchmark that *fails* on an informational backend still fails the run. That is not an
inconsistency: an advisory number is exempt from gating, but a benchmark that threw, hung
or died is a broken benchmark whichever backend it ran on — and it can only happen on a run
that opted in.

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

That is `filtered-scan-index-10k@store-mem`, and it reads: ten entries pulled from the
secondary index, then **one** batched read carrying ten keys to fetch the rows, and no
writes at all — it is a read workload. If row resolution ever stopped batching,
`getManyCalls` would go to 10 and `singleGets` would take the keys.

The eight counts, which are **not** the raw field names of `CountingKVStore` in
`@quereus/store/testing` — that class's `getMany` deliberately routes every key of a batch
through its own counted `get`, so its `getCount` is not what its name suggests:

| Field | Means |
| --- | --- |
| `iterateEntries` | entries pulled from `iterate()` — a scan's volume |
| `getManyCalls` | batched reads issued: **the read-side round-trip count** |
| `getManyKeys` | keys those batched reads carried |
| `singleGets` | reads that were genuinely one key at a time (`getCount - getManyKeyCount`, derived once, in `bench/lib/store-counters.mjs`) |
| `directPuts` | puts issued one at a time, outside any batch |
| `directDeletes` | deletes issued one at a time, outside any batch |
| `batchWrites` | batch commits issued: **the write-side round-trip count** |
| `batchOps` | put/delete operations those commits carried |

**Both sides.** `CountingKVStore` counts reads (`get`/`getMany`/`iterate`) and writes
(point `put`/`delete`, plus `WriteBatch.write()` commits and the operations they carried),
so a write workload's block says both what its writes COST and what they PROVOKED in reads
— index maintenance, uniqueness probes, read-modify-write. `bulk-insert-10k@store-mem`
reporting 30 000 `singleGets` for 10 000 inserted rows is three reads per row; its
`batchWrites` / `batchOps` are the other half of that story.

The write side answers a question no read count can. Whether committing N queued operations
costs a flat number of round trips or one per operation is a claim about `batchWrites`, and
it cannot be recovered from the read counters by picking a cleverer workload: any workload
that queues N operations also touches N rows, so its read counts are linear in N whatever
the commit path does.

**What `batchWrites` is a fact about.** The counting provider exposes no
`beginAtomicBatch` — its in-memory stores share no commit domain — so the transaction
coordinator takes its per-store fallback: one `WriteBatch` per touched store. A provider
that DOES have a shared commit domain (the LevelDB family) commits the same transaction as
one cross-store atomic write instead. These are the store LAYER's round trips over an
in-memory provider, not a prediction of what a real backend physically issues.

A store that was opened but never touched stays in the block with eight zeros. That is
a different claim from a store that was never opened at all, which is absent — and the
comparison reports an appeared or vanished path exactly as loudly as a changed count.

Two mechanics worth knowing:

- The counters pass builds a **second database**, over a counting provider, so the counting
  wrapper never sits inside a timed number. It costs about a second across all nineteen
  store rows of a ~150 s run.
- Each pass has to say where its *fixture* ends and its *measurement* begins, or a ten-key
  index probe would be buried under ten thousand fixture inserts. The `execution` binder
  does it structurally (fixture, then reset, then the statement); a `mutation` workload does
  it by calling `ctx.beginMeasured()` at its own boundary — a no-op on backends that count
  nothing.

Counter portability across machines is **an assumption, not a fact**: nothing has yet
compared counter blocks from two machines, and plan choice can in principle differ on a
slower one — the one known mechanism is the join-order rule's wall-clock budget, which
engages only on plans with two or more join nodes. The [regression gate](#regression-gate)
(`yarn bench:gate`) gates on these counters, and excludes exactly that mechanism by
refusing to gate any benchmark whose observed plan carries two or more join nodes.

### Which suites qualify

Whether a benchmark can report counters depends on what it does, not on an arbitrary
per-suite switch:

| Suite | Declares `counters()` | Why |
| --- | --- | --- |
| `execution` | 30 / 30 | Every benchmark runs a statement to completion; `snapshotStatement` reruns the same query untimed. The 15 `@store-mem` rows add a `store` block to it. |
| `mutation` | 8 / 8 | Writes are statements too — same treatment. |
| `planner` | 4 / 4 | `snapshotPlanShape` only. These benchmarks compile a plan and deliberately never execute it, so there is no instruction or table access to count — only plan shape. |
| `parser` | 0 / 4 | Nothing to count: no `Database`, no plan, no runtime. |
| `store` | 14 / 25 | The 11 key-encoding rows call store functions directly — no `Database`, nothing to count. The 14 hot-path rows all report a `store` round-trip block over a counting `store-mem` database and **assert** it in the pass: thirteen pin exact per-field integers on the table stores they name, and the catalog-rehydrate row pins "every table store saw nothing", which is the claim reopening makes. The reserved `__catalog__` / `__stats__` blocks are reported but never asserted — their counts are catalog-layout facts, not contracts. Twelve rows also report an `engine` block; the index-build row reports the `store` block only (its timed body is DDL plus verification scans, not one statement), and the catalog-rehydrate row reports what rehydration found instead of engine counts. |

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

## Regression gate

`yarn bench:gate` re-measures every counter-declaring benchmark and fails when any count
differs from the checked-in reference set — so a change that makes the engine do more work
is caught the day it lands, not months later when someone happens to compare two runs.

**Only work counters gate; nothing about wall-clock does.** The
[noise floor](#noise-floor-when-a-delta-is-a-change) is built from within-run spread and is
blind to whole-run displacement by construction, so a timing gate on one machine cannot
tell a regression from background load. Work counters are exact integers that do not
depend on machine speed, so they compare for equality — no floor, no threshold, no re-run.

**The reference set** is one file per suite in `bench/reference/<suite>.json`, checked into
git: the expected counter block per benchmark, plus an `accepted` block recording who
accepted it, at which commit, and why. The files are pretty-printed with sorted keys so a
change is a readable diff — the git history of `bench/reference/` is the log of every
accepted change to how much work the engine does.

**The pass runs every benchmark in one process,** unlike `yarn bench`, which forks a worker
per benchmark. Forking is load-bearing for timings — the interpreter shares call sites
across query shapes, so a benchmark's measured speed depends on what ran before it — but
not for counts: a single-process pass produced counter blocks byte-identical to the forked
run's for all 56 benchmarks, and saves ~22 s of forks and `dist/` imports. The whole pass
takes about 42 s; nothing is timed, so it runs each benchmark's
`skip`/`setup`/`counters`/`teardown` and never the timed loop.

**What gates and what does not.** A benchmark gates only when its observed plan carries at
most one join node. Join order on three or more relations is chosen under a wall-clock
budget (`bug-join-order-depends-on-wall-clock` in the backlog), so those counts are not
provably the same on another machine. The gate recomputes this eligibility from each run's
own counters — the reference file's `gated` flag is documentation, never the authority —
names every ungated benchmark in its report, and still records their counts so a change
stays visible. Today nothing is excluded: no benchmark's plan has two or more join nodes.
The LevelDB rows never gate either: `bench:gate` deletes `QUEREUS_BENCH_LEVELDB` from its
own environment before loading suites, and says in its report when it was set.

**Outcomes.** `differs` (a gated count changed), `missing` (in the reference, produced no
result this run) and `failed` (threw during the pass) fail the run; `match`, `new` (ran,
not yet in the reference), `ungated`, `skipped` and `filtered` do not. A suite that
produced counter blocks but has no reference file fails — as does one whose reference file
exists but records *no benchmarks*, so emptying a file cannot turn a suite into a set of
benign `new` rows — as does a reference file naming a suite that no longer exists.
Deleting or emptying `bench/reference/` cannot make the gate green. (Deleting *part* of a
file still can: from inside one run a removed expectation and a genuinely new benchmark are
the same observation, so the defense there is that `bench/reference/` is checked in and its
diff gets reviewed.) Each
`differs` benchmark prints every changed path as `path  before -> after`, capped at 12
lines per benchmark with the elision announced, and uncapped under `--json` (outcome object
on stdout, human report on stderr — the same routing as `yarn bench`).

**Accepting a change.** When the difference is intentional:

```
yarn bench:accept --reason "hash join now probes the build side once per batch"
```

re-runs the full pass and rewrites only the reference files whose benchmark contents
actually changed, so an untouched suite's `accepted` provenance survives in git history.
`--reason` is required — a reference that changes without a recorded reason is a reference
nobody trusts. Accept refuses on a dirty working tree (the recorded provenance commit would
be a lie) unless `--allow-dirty` is passed, refuses `--filter` (a reference is always a
full re-measure), and refuses to write while any benchmark failed or while a
previously-recorded benchmark skipped this run — an unbuilt `dist/` must not silently erase
a suite's expectations. Writes are atomic (temp file, then rename), so a concurrent gate
run never reads half a file.

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

**A guard naming an [informational](#informational-rows-reported-never-gated) row is a
misconfiguration**, and that is the rule above made mechanical: it fails the run, and it is
checked before the not-selected and declined cases so a `--filter` cannot hide it. A
build-gating ratio anchored to a number that moves with the machine's disk is not a gate.

## Exit-code contract

`yarn bench` exits non-zero on any of:

- a benchmark failure (threw, timed out after 120 s, or died without reporting),
- a ratio-guard failure or misconfiguration,
- a gated regression, meaning a delta that cleared both the noise floor and the 10% minimum
  on a benchmark that was stable in both runs.

Unstable benchmarks, new benchmarks, missing benchmarks, sub-threshold deltas and
[informational](#informational-rows-reported-never-gated) regressions never contribute to
the exit code. An informational benchmark that *failed* still does — an exempt number is
not an exempt benchmark.

**No part of this runs in `yarn check`.** `yarn check` invokes neither `yarn bench` nor
`yarn bench:gate` today; wiring the [regression gate](#regression-gate) into it is the
follow-on ticket `bench-gate-ratios-and-check`. The gate already budgets itself around the
`memory` and `store-mem` backends only, and deletes `QUEREUS_BENCH_LEVELDB` from its own
environment: the LevelDB rows would add roughly 75 s of disk-bound work whose numbers, by
construction, cannot gate anything.

## `--json`

Under `--json`, stdout carries the result object and nothing else — the human table, the
progress lines, the environment banner and the guard verdicts all move to stderr, and ANSI
colour is suppressed. The object is exactly what is written to `bench/results/`, so a
consumer never has to care which of the two it is reading. It includes `environment`,
`benchmarks`, `failures`, `skipped`, `informational`, `ratio_guards`, `baseline` and
`comparison`.

```
node bench/run.mjs --json 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(Object.keys(JSON.parse(s))))"
```

Colour is also suppressed whenever the human stream is not an interactive terminal, so a
captured log stays readable.

## Adding a benchmark

`parser`, `planner` and `store` hold benchmark objects directly; add an entry to the
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
- **A benchmark whose one call is far below a millisecond must amortize inside `fn`**, the
  way the `store` suite does with its shared `KEYS_PER_CALL`. Below that scale the `await`
  around `fn` is a meaningful share of the reading. Say in a comment what the reported
  figure counts, and use one constant across every benchmark meant to be compared.
- **`bench/suites/` is currently OUTSIDE the type pass.** `tsconfig.test.json` includes
  `bench/lib/**` and `bench/workloads/**` but not `bench/suites/**`, so a suite file's own
  `checkJs` errors surface only when the benchmark runs. `store.bench.mjs` was written to
  compile clean under that pass and verified to; three of the other four (`execution`,
  `mutation`, `planner` — `parser` is clean) report 21 mostly implicit-`any` errors, which
  is what stands between here and widening the `include`. Parked as
  `debt-bench-suites-outside-type-pass`. Until
  that is done, a renamed `@quereus/store` export is caught by the annotated resolution in
  `bench/lib/store-counters.mjs` (which *is* checked) rather than at the suite's call site.
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
| `bench/gate.mjs` | The [regression gate](#regression-gate) and accept entry point: arguments, the single-process counters pass, the report, the exit code. |
| `bench/lib/reference.mjs` | The gate's rules — reference file read/write, gate eligibility, outcome classification, accept validation — as pure functions over plain objects. |
| `bench/reference/*.json` | The checked-in expected counter blocks, one file per suite, rewritten only by `yarn bench:accept`. |
| `bench/lib/calibrate.mjs` | The timing policy — warmup, batch sizing, sample count. Kept out of the worker so `test/bench-calibration.spec.ts` can drive it. |
| `bench/lib/stats.mjs` | Median, percentiles, relative IQR, the summary record, and the noise floor. |
| `bench/lib/compare.mjs` | The cross-run comparison rules, as pure functions over two result objects. |
| `bench/lib/counters.mjs` | Helpers a benchmark's `counters()` pass uses: `snapshotStatement`, `snapshotStatements`, `snapshotPlanShape`. |
| `bench/lib/environment.mjs` | Environment capture and the material-difference check. |
| `bench/lib/discover.mjs` | Suite enumeration and the one definition of what `--filter` matches (`matchesFilter`), shared by the parent, the worker and the comparison. |
| `bench/lib/backends.mjs` | The storage-engine dimension: the `BenchBackend` descriptor, the `BACKENDS` set, and `expandBackends` — one workload × N backends → N benchmarks, named by the bare-name rule, with each backend's `skipWorkload` wired into the benchmark's `skip()`. |
| `bench/lib/store-counters.mjs` | Everything that touches `@quereus/store`, behind the harness's one dynamic import: the plain and counting `store-mem` databases, and the round-trip block they report. |
| `bench/lib/leveldb-backend.mjs` | Everything that touches `@quereus/plugin-leveldb`, behind its own dynamic import: the `QUEREUS_BENCH_LEVELDB` opt-in, the skip reason, and the `store-leveldb` database over a temporary directory. |
| `bench/lib/tempdir.mjs` | Fresh-per-call temporary directories for disk-backed rows, and the PID-owned sweep that removes the ones a killed worker could not remove itself. |
| `bench/workloads/*.mjs` | What the `execution` and `mutation` suites measure, as data plus fixtures. The suite files are binders over these. |

Harness tests, none of which run a benchmark: `test/bench-calibration.spec.ts` (the timing
policy and the statistics), `test/bench-comparison.spec.ts` (the cross-run rules and the
environment check), `test/bench-backends.spec.ts` (the backend expansion and the naming
rule), `test/bench-gate.spec.ts` (the gate's eligibility, classification, serialization
and accept-validation rules). Neither `yarn bench` nor `yarn bench:gate` is part of
`yarn test`, so these are the only automated check on the harness itself.

See also [Architecture § Benchmark Suite](architecture.md#testing-strategy).
