---
description: All our benchmarks run against the in-memory table implementation, so nothing measures the persistent storage backends that real deployments use; add a benchmark suite that exercises them.
prereq: bench-counter-reporting, store-counting-double-extraction
files:
  - packages/quereus/bench/run.mjs                             # harness; would gain a backend dimension
  - packages/quereus/bench/suites/execution.bench.mjs          # the workloads to re-run against a store backend
  - packages/quereus/bench/suites/mutation.bench.mjs
  - packages/quereus-store/src/common/store-table-scan.ts      # scan/seek/batched row resolution - the hot read path
  - packages/quereus-store/src/common/key-builder.ts           # key encoding - runs per row per index
  - packages/quereus-store/src/common/encoding.ts
  - packages/quereus-store/src/common/transaction.ts           # commit path: op batching into one atomic write
  - packages/quereus-store/src/common/store-module-index-build.ts
  - packages/quereus-plugin-leveldb/src/provider.ts            # the disk-backed backend with no measured numbers
  - packages/quereus-plugin-indexeddb/bench/                   # the one measured backend - the shape to copy
difficulty: medium
---

# Why

Every benchmark in `bench/suites/` constructs a bare `new Database()`, which means every
benchmark measures the in-memory virtual table. Meanwhile `yarn test:store` exists
specifically because the persistent path is different enough to need its own full
correctness run - key encoding, batched row resolution, transaction commit, index build,
and catalog rehydration are all code that the memory table never executes.

So the storage layer, which is where a real deployment spends most of its time, has no
performance coverage whatsoever. A regression that doubles the number of storage round
trips behind a secondary-index scan would pass `yarn bench` unchanged and be caught only
if it happened to break one of the two specs that count round trips by hand.

The gap is visible in what the project already knows it does not know. IndexedDB has real
measured cost numbers because someone built a browser harness for it. LevelDB declares
nothing and silently takes the framework's parity default - "a random read costs about
what a sequential read costs" - a number chosen by assumption and never measured
(`debt-leveldb-cost-profile-measurement`, backlog). The optimizer prices access paths
with those numbers.

# What to build

## The engine workloads, re-run against a store backend

The execution and mutation suites describe workloads (`full-scan-10k`, `group-by-10k`,
`text-pk-range-scan-10k`, `bulk-insert-10k`, `update-where-1k`, ...) that are meaningful
against any backend. Rather than duplicating them, give the harness a **backend
dimension**: the same suite definition runs against the memory vtab and against
`StoreModule` over one or more key-value providers. Results are keyed by backend so the
comparison table can show them side by side, and so a baseline never accidentally
compares a memory number against a store number.

Which providers to run by default is a judgment call the implementer should make and
document. A reasonable default: the in-memory KV provider always (fast, deterministic,
safe to gate on, and it isolates *store-layer* cost from *disk* cost), LevelDB behind a flag or
a separate script (real disk, slow, machine-dependent). The in-memory KV provider is the
important one for regression detection - it makes the store code path measurable without
making the measurement depend on a filesystem.

## Store-layer micro-benchmarks

Workloads that isolate the store's own hot paths, which a whole-query benchmark mixes
together:

- **Key encoding / decoding** - `key-builder.ts` and `encoding.ts` run per row per index.
  Include the cases the correctness suite already treats as hazardous: text keys,
  astral-plane text, JSON keys, collation-affected keys, descending keys.
- **Scan and seek** - sequential iterate throughput, point read, multi-seek, and the
  batched row resolution behind a secondary index (`ROW_RESOLUTION_BATCH`), reported in
  round trips as well as time.
- **Transaction commit** - queueing N operations and committing them as one atomic
  batch, across a range of N. This is where a per-operation cost that should be per-batch
  hides.
- **Index build** - building a secondary index over an existing table, which streams.
- **Catalog rehydration** - reopening a database with a non-trivial schema. The
  declarative-schema no-op re-apply already has an ad-hoc harness
  (`bench/apply-schema-unchanged.mjs`) whose numbers are quoted in `docs/schema.md` from
  "one Windows box"; folding it in gives those numbers a standing home.

## Round trips as the primary metric

Time is secondary here. The number that matters for a storage backend, and the one that
is stable across machines, is *how many times the engine went to storage and with how
many keys*. That is what the counter work upstream of this ticket provides. Every store
benchmark should report round trips alongside its timing, and the round-trip counts are
what a later gate keys on.

## Answer the LevelDB cost-profile question while here

The backlog ticket `debt-leveldb-cost-profile-measurement` describes exactly the
measurement this suite makes routine: sequential milliseconds-per-row versus random
point-read milliseconds-per-row, at a dataset size inside the OS page cache and one well
outside it. If the suite can produce those two ratios, that ticket collapses into
"read the numbers and declare (or deliberately do not declare) a profile". Reference it,
do not duplicate it.

# Edge cases & interactions

- **Disk-backed benchmarks are not reproducible.** OS page cache, filesystem, and disk
  type dominate. Keep them out of any pass/fail gate; report them, flag them as
  informational, and make the cache-warm versus cache-cold distinction explicit rather
  than accidental.
- **Temporary directories must be cleaned up.** A LevelDB benchmark that leaves databases
  behind will silently change the next run's numbers and litter the tree. Fresh directory
  per run, removed in teardown, and never inside the repo working tree.
- **Backend feature differences.** Not every workload is meaningful on every backend, and
  the logic-test corpus already has a `-- requires-capability:` mechanism for exactly this
  problem. A benchmark that a backend cannot run must be *skipped visibly*, never
  silently dropped - a missing row in a comparison table reads as "unchanged".
- **The store path is slower, sometimes much slower.** Adaptive iteration counts (from
  the harness ticket) matter more here than anywhere; a 10k-row bulk insert against
  LevelDB should not run ten times.
- **Isolation wrapper.** `@quereus/isolation` wraps a module and mirrors its capabilities.
  Whether store benchmarks run bare or wrapped changes the numbers; pick one for the
  default suite, document it, and keep the other available.
- **Windows paths.** LevelDB directory handling and cleanup must work on Windows.

# Not in scope

Benchmarking the isolation layer and the sync engine as subjects in their own right
(backlog: `feat-bench-isolation-and-sync-suites`), and the regression gate itself.

## TODO

- Add a backend dimension to the harness so one suite definition runs against multiple modules, with results keyed by backend
- Run the existing execution and mutation workloads against StoreModule over the in-memory KV provider
- Add store-layer micro-benchmarks: key encode/decode, scan, point read, multi-seek, batched row resolution, transaction commit, index build
- Fold `bench/apply-schema-unchanged.mjs` into the suite as the catalog/schema benchmark, or document why it stays ad hoc
- Report storage round trips and key volume alongside timing for every store benchmark
- Add an opt-in LevelDB run with fresh-per-run temp directories and guaranteed cleanup; keep it out of any gate
- Produce the sequential-versus-random ratios the LevelDB cost-profile ticket needs; cross-reference it
- Make unsupported-backend benchmarks skip visibly
- Document the store suite and the backend dimension in `docs/benchmarking.md`
