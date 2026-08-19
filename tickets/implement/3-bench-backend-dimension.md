---
description: The benchmark harness can only ever run a workload one way, so the same query cannot be measured against two different storage engines in one run; teach it to run one workload definition several ways, and to say out loud when it skipped one.
files:
  - packages/quereus/bench/lib/discover.mjs                # suite enumeration; the flat work list everything keys on
  - packages/quereus/bench/lib/backends.mjs                # NEW - backend descriptors + expansion helper
  - packages/quereus/bench/workloads/execution.mjs         # NEW - workload data lifted out of execution.bench.mjs
  - packages/quereus/bench/workloads/mutation.mjs          # NEW - same for mutation.bench.mjs
  - packages/quereus/bench/suites/execution.bench.mjs      # becomes a thin binder; names must not change
  - packages/quereus/bench/suites/mutation.bench.mjs       # same
  - packages/quereus/bench/run.mjs                         # skipped rows in the table, in the JSON, and in the guards
  - packages/quereus/bench/child.mjs                       # skip is evaluated in the worker
  - packages/quereus/bench/lib/compare.mjs                 # a skipped benchmark is not a missing one
  - packages/quereus/test/bench-calibration.spec.ts        # existing harness spec - the pattern new harness specs follow
  - docs/benchmarking.md                                   # sections: What is measured, Adding a benchmark, Where the code lives
difficulty: medium
---

# Why

Every benchmark in `bench/suites/` builds a bare `new Database()`, which measures the
in-memory virtual table and nothing else. Measuring the persistent storage path means
running the *same* workload against a different module - and the harness has no way to
express "one workload, several engines".

This ticket adds that, and changes no measurement. It is deliberately the boring half:
after it lands, `yarn bench` prints the numbers it printed before, under the names it
printed before. The store backend itself arrives in `bench-store-workloads`.

# Architecture

## The dimension is a name suffix, expanded inside the suite

`discover.mjs` flattens suites into a work list keyed by `suite/name`, and that string is
the identity `--filter`, the baseline comparison, and `ratioGuards` all key on. So the
backend dimension is simplest expressed as part of the benchmark *name*, materialized
before `discover.mjs` ever sees it:

```
execution/full-scan-10k            <- the default module (memory)
execution/full-scan-10k@store-mem  <- StoreModule over an in-memory key-value provider
```

**The default module contributes the BARE name.** That is the load-bearing rule: every
existing benchmark name, every existing results file, every `ratioGuards` entry and the
whole of `docs/benchmarking.md` keep meaning what they mean. A suffixed name is a claim
that this row ran on something other than the engine's default vtab module.

Because the expansion happens while building the exported `benchmarks` array, nothing
downstream changes: `run.mjs`, `child.mjs`, `compare.mjs` and `stats.mjs` see a longer
flat list and are otherwise untouched. `--filter @store-mem` already selects a whole
backend and `--filter full-scan-10k` already selects one workload across backends - the
existing substring match gives both for free. **Do not add a `--backend` flag.**

## A backend descriptor

`bench/lib/backends.mjs` owns the descriptor and the expansion:

```js
/**
 * @typedef {object} BenchBackend
 * @property {string} id           short id used in the name suffix; the DEFAULT backend's id
 *                                 is never appended (see the bare-name rule above)
 * @property {boolean} [isDefault] exactly one backend per set is the default
 * @property {string} label        one line, for the docs and the table legend
 * @property {() => Promise<BackendHandle>} open
 *
 * @typedef {object} BackendHandle
 * @property {import('../../dist/src/index.js').Database} db
 * @property {() => Promise<void>} close   closes db AND anything the backend registered
 */
```

and

```js
/**
 * One workload definition x N backends -> N Benchmark entries.
 *
 * @param {BenchBackend[]} backends
 * @param {Workload[]} workloads
 * @param {(workload: Workload, backend: BenchBackend) => Benchmark} bind
 * @returns {Benchmark[]}
 */
export function expandBackends(backends, workloads, bind) { /* ... */ }
```

This ticket ships exactly ONE backend - `MEMORY_BACKEND`, `isDefault: true`, whose `open`
is `new Database()` plus `setOption('default_vtab_module', 'memory')`. The array is a
one-element array so that adding the store backend next ticket is a one-line edit rather
than a refactor.

Ordering: `expandBackends` must emit **workload-major** (`full-scan-10k`,
`full-scan-10k@store-mem`, `group-by-10k`, `group-by-10k@store-mem`, ...) so the two
readings of one workload land on adjacent rows in the printed table. That adjacency is the
whole reason for putting both in one suite instead of two.

## Workloads become data

The workload definitions move out of the suite files into `bench/workloads/`, as plain
data plus a populate function:

```js
/**
 * @typedef {object} Workload
 * @property {string} name             the bare benchmark name, e.g. 'full-scan-10k'
 * @property {string} fixture          which shared fixture builds its tables
 * @property {string} sql              the ONE statement `fn` times and `counters()` snapshots
 * @property {number} expectedRows     asserted by `fn` - see docs/benchmarking.md
 */
```

The suite file keeps every existing NOTE comment (they are measurement history, not
decoration) and becomes a binder that turns each `Workload` into the
`setup`/`fn`/`teardown`/`counters` shape the worker already expects. The four existing
fixtures (`createPopulatedDb`, `createTextDb`, `createTemporalDb`, `createTextPkDb`) move
to `bench/workloads/` too and each takes a `BackendHandle`'s `db` rather than constructing
its own `Database`.

Two entries do not fit the single-statement `Workload` shape and **must not be forced into
it**: `execution/join-1kx1k` builds two tables, and `mutation/single-row-insert-1k` runs a
thousand statements. Let the suite file define those by hand alongside the expanded ones -
`expandBackends` returns an array, so `[...expandBackends(...), ...handWritten]` is the
whole story. A `Workload` type that can express everything expresses nothing.

`mutation`'s three own-database benchmarks build their `Database` inside `fn`, not in
`setup` (a table left behind changes what the next call costs). Their binder therefore
calls the backend's `open` per iteration; that is why `open` is a function on the
descriptor rather than a pre-built handle.

## Visible skip

The harness has no way for a benchmark to decline to run. A benchmark either produces a
row or fails, so a backend that cannot run a workload has only two options today: throw
(reads as a broken suite) or be absent from the array (reads as *unchanged* to anyone
diffing two runs). Both are wrong, and the next two tickets need a third answer.

A benchmark may declare:

```js
/**
 * @property {() => string | null | Promise<string|null>} [skip]
 *   a reason to skip, or null to run. Evaluated in the WORKER, before `setup`.
 */
```

Evaluated in the worker, not the parent, because the reason a benchmark skips is usually a
runtime fact (a backend module that will not load, an environment variable, a missing
native binary) and the parent deliberately imports suites for metadata only.

- Worker: `skip()` runs in its own phase before `setup`; a truthy return sends
  `{ type: 'skipped', reason }` and exits 0. `setup`/`fn`/`teardown`/`counters` never run.
- `run.mjs`: a skipped benchmark **keeps its row**, printed as `skipped - <reason>`, and is
  recorded in the results JSON under a new top-level `skipped` array (`{name, reason}`) -
  not under `benchmarks` (it has no numbers) and not under `failures` (it did not fail). It
  does not affect the exit code.
- `compare.mjs`: a new `skipped` status, distinct from `missing` and from `filtered`. A
  baseline entry whose benchmark skipped this run is **not** a deletion. Add it to
  `STATUS_ORDER` and to the summary labels.
- `checkRatioGuards`: a guard naming a skipped benchmark reports `not-evaluated`, the same
  as one naming a failed benchmark - never `misconfigured`, which would fail the run.

# Edge cases & interactions

- **Name collisions and malformed backend sets.** `expandBackends` must reject a backend
  whose `id` produces a name already in the array, and reject a set with zero or two
  defaults. `loadSuite`'s duplicate-name check catches the first case one layer later, but
  its message names a benchmark rather than the backend that caused it.
- **`@` in a name.** `matchesFilter` is a plain substring test, so `@` is safe. Confirm no
  other consumer parses `suite/name` as a structured string before settling on it.
- **Names must be byte-identical after the refactor.** The acceptance check is mechanical:
  capture the benchmark names from `yarn bench --json` before the change and diff against
  after. Any difference is a regression, not a rename.
- **`ratioGuards` reference bare names** (`correlated-subquery` /
  `hand-batched-peer-count`) and must keep working untouched. A guard that wants to bound a
  suffixed benchmark spells the suffix out; **do not** add automatic per-backend guard
  expansion - a ratio that holds on memory need not hold on a store, and a guard that
  silently multiplies itself across backends is a guard nobody trusts.
- **A cross-backend ratio guard is not portable and must not be added.** Bounding
  `x@store-mem` against `x` prices a storage engine against an in-process array; the bound
  would encode this machine's ratio, not a property of the engine. Say so in the docs so
  the next person does not try it.
- **Shared fixtures and mutation.** A workload whose `fn` mutates its fixture breaks
  calibration's back-to-back batching. The existing suite header states this requirement;
  carry it into the `Workload` typedef doc, where the next author will actually meet it.
- **A `skip()` that throws** is a benchmark failure in phase `skip`, not a silent run.
- **`counters()` on a skipped benchmark** never runs, so the entry is absent. Confirm the
  comparison reports that as `skipped`, not `dropped`, against a baseline that had counters.
- **Suite wall-clock.** This ticket adds no benchmarks, so `yarn bench` should stay at
  roughly its current ~35 s. Report the measured before/after in the handoff; a refactor
  that moved it is a refactor that changed something.

# Tests

- `test/bench-discovery.spec.ts` (new, following `test/bench-calibration.spec.ts`, which
  already drives `bench/lib/` directly): `expandBackends` over a synthetic two-backend set
  yields workload-major order, bare names for the default and suffixed names for the rest;
  it rejects zero defaults, two defaults, and a colliding id.
- `compare.mjs` cases: a baseline entry against a skipped run reports `skipped`, not
  `missing`, and lands in the right summary bucket.
- The mechanical name-identity diff described above.

# TODO

- Add `bench/lib/backends.mjs`: the `BenchBackend`/`BackendHandle` typedefs, `MEMORY_BACKEND`, and `expandBackends` with its validation
- Lift the execution and mutation workload definitions and their four fixtures into `bench/workloads/`, keeping every existing NOTE comment with its workload
- Rewrite `execution.bench.mjs` and `mutation.bench.mjs` as binders over `expandBackends`, leaving `join-1kx1k` and `single-row-insert-1k` hand-written
- Verify the exported benchmark names are byte-identical to before, via a before/after `--json` diff
- Add the `skip()` entry point: worker phase, `skipped` IPC message, table row, and a `skipped` array in the results JSON
- Add a `skipped` status to `compare.mjs` (`STATUS_ORDER`, summary labels) and make `checkRatioGuards` treat a skipped benchmark as `not-evaluated`
- Add `test/bench-discovery.spec.ts` and the `compare.mjs` skipped-status cases
- Document the backend dimension, the bare-name rule, the no-cross-backend-guard rule, and `skip()` in `docs/benchmarking.md`
