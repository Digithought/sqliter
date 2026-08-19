---
description: Timings differ from machine to machine, so a benchmark result from one laptop cannot be compared to another; record counts of the actual work a query does - rows touched, steps run, storage round trips - because those numbers are identical everywhere and a change in them is always a real change.
prereq: bench-harness-measurement-rigor
files:
  - packages/quereus/src/runtime/scheduler.ts             # per-instruction runtimeStats already collected, only debug-logged
  - packages/quereus/src/runtime/types.ts                 # RuntimeContext.enableMetrics, InstructionRun surface
  - packages/quereus/src/core/statement.ts                # where a per-execution snapshot would be exposed
  - packages/quereus/src/core/database.ts                 # runtime_stats / runtime_metrics option (aliases at ~line 297)
  - packages/quereus/bench/run.mjs                        # harness: would report counters beside timings
  - packages/quereus-store/test/index-scan-batching.spec.ts  # CountingKVStore - the existing per-spec version of this idea
difficulty: hard
---

# Why

Every performance number this project produces today is a wall-clock duration. Wall-clock
is the thing users feel, so it has to be measured - but it is also the thing that varies
by machine, by background load, by Node version, and by which shape warmed the JIT first.
That makes it a poor *gate*: a threshold loose enough not to flap is loose enough to miss
a two-fold regression, which is exactly the compromise the existing performance sentinels
describe themselves as making.

There is a second kind of measurement that has none of those problems. How many rows did
a scan yield? How many times did a given step run? How many round trips did the storage
layer take? Those counts are a property of the plan and the data, not of the hardware. On
a correct engine they are *identical* on every machine and every run. A change in one is
never noise - it is always a real behavioral change, which means it can be gated exactly,
with no tolerance band at all.

The pieces already exist, unconnected:

- The scheduler already collects per-instruction `runtimeStats` (`executions`, `in`,
  `out`, `elapsedNs`) whenever metrics mode is on. It is only ever *debug-logged* in
  aggregate, behind `log.enabled`. Nothing can read it programmatically.
- The store package already proves the technique at the storage layer: a `CountingKVStore`
  double counts iterate yields, single gets, and batched `getMany` round trips, and
  `index-scan-batching.spec.ts` asserts on exact round-trip counts because "rows alone
  cannot distinguish a batched resolution from a serial one". That harness is copy-pasted
  into individual specs rather than being a shared, benchmarkable surface.
- The optimizer track wants the same counters for a different reason: the progressive
  optimizer design (`docs/progressive-optimizer.md` section 5) specifies per-operator
  cardinality monitors at pipeline breakers, feeding a runtime stats overlay.

Three consumers, one missing surface.

# What to build

## A readable work-counter snapshot from a statement execution

A caller that opted into metrics should be able to ask, after an execution completes, what
work was done - without parsing a log line. Shape to settle during design, but the
information it must carry:

- **Per-plan-node (or per-instruction, rolled up to node) row counts** - rows in, rows
  out, invocation count. This is what `runtimeStats` already holds; it needs an identity
  that survives back to the plan node so the numbers are interpretable, and a getter.
- **Storage-layer round trips** - how many `query()` / point-read / `getMany` calls the
  execution made, and how many keys those carried. Below the engine this is a virtual
  table concern, which means the counting has to happen at a boundary the engine owns
  (the scan/seek emitters and the vtab call sites) or be contributed by a counting module
  wrapper the bench harness installs. Pick one and say why; a counter that only works for
  one module is worth less than one that works for every module.
- **Plan-shape facts worth pinning** - number of plan nodes, and the presence/absence of
  specific node types. A regression that turns a hash join back into a nested loop shows
  up here as a plan-shape diff long before it shows up as a timing.

Whatever the shape, it must be JSON-serializable, because the bench harness writes it to
the results file beside the timings and a later gate compares two of them.

## Zero cost when off

`enableMetrics` already gates the instrumented scheduler path, and the optimized path is
explicitly documented as having no metrics overhead. That property must survive: the
counters are a diagnostic and benchmark surface, not something every production query
pays for. Confirm with a benchmark, not by inspection - one of the existing execution
benchmarks run with metrics off, before and after, is the check.

## Wire counters into the benchmark harness

Each benchmark optionally declares that it collects counters. The results JSON gains a
counters block per benchmark. The comparison output shows counter deltas as exact
integers with no tolerance - a changed count is always reported, in a distinct column
from the noise-aware timing delta.

## Retire the copy-pasted counting doubles

`CountingKVStore` and its siblings in the store package specs should become one shared
testing utility exported from `@quereus/store/testing` (which already exists as an export
path and already ships the conformance batteries). The specs keep asserting what they
assert; they stop each carrying their own copy of the counter.

# Edge cases & interactions

- **Counter stability is a claim that must be tested, not assumed.** A counter that
  varies run to run is worse than no counter, because it will be gated on. The
  acceptance test is: run the full counter-collecting bench twice in the same process and
  twice in separate processes, and assert every counter is identical across all four.
  Anything that is not stable does not get to be a counter.
- **Sub-program schedulers reset per invocation.** The existing metrics `onStart` resets
  stats for a cached scheduler, and a `NOTE:` at that site records that a correlated
  re-eval's sub-program reports the last invocation, not a cumulative sum. That is fine
  for debug logging and *not* fine for a gate - any rollup must either accumulate across
  invocations or explicitly exclude sub-programs, and say which.
- **`countOutputs` returns 1 for an async iterable** because the size is unknown at that
  point. A row count that reports 1 for every streaming result is not a row count.
  Whatever counts rows must count them where rows are actually produced.
- **Non-determinism in the workload defeats the whole idea.** A benchmark whose counters
  depend on a timestamp, a random value, or iteration order over a hash structure cannot
  be counter-gated. Audit the existing 28 for this and mark the ones that qualify.
- **Concurrency.** The parallel runtime (`ParallelDriver`, `AsyncGatherNode`,
  `FanOutLookupJoinNode`) forks the runtime context. Counters collected under a fork must
  roll up to the parent, and the fork contract test
  (`test/runtime/fork-contract.spec.ts`) pins every context field to a fork policy - a
  new counter field on `RuntimeContext` needs an entry there or that test fails, by
  design.
- **Strict-fork mode.** `QUEREUS_FORK_STRICT=1` throws if a parent context is mutated
  while a fork is being driven. A counter that mutates parent state from a fork will trip
  it. That is the guard working; design the rollup so it does not.

# Not in scope

Gating on the counters, and the store-specific benchmark suite that will be their
largest consumer. Both are downstream tickets. This ticket produces trustworthy counters
and reports them; it does not yet fail a build over one.

## TODO

- Design the counter snapshot shape; settle per-node identity and how storage round trips are attributed
- Expose the snapshot from a completed statement execution; keep the existing debug log working
- Decide and document how vtab-layer round trips are counted so it works for every module, not just memory
- Prove zero overhead when metrics are off, with a before/after benchmark run
- Add counter collection and reporting to the bench harness and results JSON
- Add the stability acceptance test (same counters across repeated and separate-process runs)
- Audit the existing 28 benchmarks for counter-determinism; mark which qualify
- Roll counters up correctly across forked runtime contexts; add the fork-contract entry
- Extract the shared counting KV store into `@quereus/store/testing` and de-duplicate the spec copies
- Document the counter surface in `docs/benchmarking.md` and the runtime docs
