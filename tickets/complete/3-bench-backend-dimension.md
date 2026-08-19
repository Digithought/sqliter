---
description: The benchmark harness can now run one workload definition against several storage engines, and a benchmark can decline to run and say why instead of failing or vanishing. Every existing benchmark still prints the same name, in the same order.
files:
  - packages/quereus/bench/lib/backends.mjs              # backend descriptors + expandBackends
  - packages/quereus/bench/workloads/execution.mjs       # execution workloads + 5 fixtures
  - packages/quereus/bench/workloads/mutation.mjs        # mutation workloads
  - packages/quereus/bench/suites/execution.bench.mjs    # binder, pure expansion
  - packages/quereus/bench/suites/mutation.bench.mjs     # binder, pure expansion
  - packages/quereus/bench/lib/discover.mjs              # skip() in the Benchmark typedef + validation
  - packages/quereus/bench/child.mjs                     # skip phase, `skipped` IPC message
  - packages/quereus/bench/run.mjs                       # skipped row, JSON array, ratio-guard handling
  - packages/quereus/bench/lib/compare.mjs               # `skipped` comparison status
  - packages/quereus/test/bench-backends.spec.ts         # expandBackends coverage
  - packages/quereus/test/bench-comparison.spec.ts       # skipped-status cases
  - packages/quereus/tsconfig.test.json                  # bench/workloads/** now type-checked
  - docs/benchmarking.md
---

# What landed

Two independent capabilities in `packages/quereus/bench/`. Neither changes a measurement.

## 1. The backend dimension

`bench/lib/backends.mjs` owns a `BenchBackend` descriptor (`id`, `isDefault`, `label`,
`open()`), the `BACKENDS` array (one element today: `MEMORY_BACKEND`), and
`expandBackends(backends, workloads, bind)`, which turns one workload definition into one
benchmark per backend.

The dimension is a name suffix. The default backend publishes the bare name; every other
backend appends `@<id>`:

```
execution/full-scan-10k            the default (memory) module
execution/full-scan-10k@store-mem  the same query on some other module
```

Expansion happens while the suite builds its exported array, so `run.mjs`, `child.mjs`,
`compare.mjs` and `stats.mjs` see a longer flat list and are otherwise untouched. There is
no `--backend` flag — `--filter` is a substring match and already gives both readings.

The `execution` and `mutation` workload definitions live in `bench/workloads/`; the suites
are binders. The two suites have deliberately different workload shapes: an `execution`
workload is plain data (`{name, fixture, sql, expectedRows}`); a `mutation` workload is a
small bundle of functions over a `db` plus a `lifecycle` (`own-database` |
`shared-fixture`), because its timed body is a procedure and three of the four time a
whole database's life rather than a statement over a fixture.

**Every entry of both suites goes through `expandBackends`.** Neither suite file holds a
benchmark object of its own — see *Review findings*, where the two hand-written exceptions
were retired.

## 2. `skip()`

A benchmark may declare `skip()`, returning a reason to decline or `null` to run.
Evaluated in the worker, before `setup`, in its own phase. A skipped benchmark keeps its
table row (`skipped — <reason>`), lands in a new top-level `skipped` array in the results
JSON, is in neither `benchmarks` nor `failures`, does not affect the exit code, compares as
a new `skipped` status (never `missing`), and makes a ratio guard naming it report
`not-evaluated` (never `misconfigured`). A skipped row's *counter* verdict is `none`, not
`CounterStatus.skipped` — the latter means the run used `--no-counters`.

# Review findings

## What was checked

- **The acceptance condition, independently.** Extracted the pre-change benchmark names
  from `git show HEAD~1:packages/quereus/bench/suites/{execution,mutation}.bench.mjs` and
  compared against `loadSuites()` on the working tree: all 27 names identical, in identical
  order, both before and after the review's own edits.
- **Behavioural drift in the move.** Diffed every fixture body, every SQL string and every
  batch constant (`BATCH_ROWS`, `BATCH_COUNT`, the `7919` scramble, `PREFIX40`,
  `UNICODE_PREFIX`) between the old suite files and the new workload files. No drift. The
  only behaviour change in the whole diff is `filtered-scan-index-10k`'s assertion
  tightening from "non-zero" to exactly 10, which is correct (`val = id*7%1000`, so
  `val = 42` selects `id ≡ 6 (mod 1000)`).
- **The `skip()` control flow**, read end to end: `child.mjs`'s phase ordering and its
  deliberate absence of `teardown` (nothing was constructed); `classify()` checking
  `outcome.skipped` before the failure and empty-result branches; `checkRatioGuards`
  checking skips before the unselected case; `compareRun` adding a skipped row to `seen`
  so its baseline entry cannot fall through to the `missing` loop. All correct as
  documented.
- **`expandBackends`'s validation set.** Zero/two defaults, duplicate ids, empty set,
  missing `open`, unnamed workload, a binder that names its own benchmark, and the
  workload-name-vs-suffix collision are all rejected with messages that name the backend.
  A collision *across two calls in one suite* is caught by `loadSuite`'s duplicate-name
  check instead — one layer later, worse message, but caught.
- **Lint and tests.** `yarn workspace @quereus/quereus run lint` (eslint +
  `tsc -p tsconfig.test.json --noEmit`) exits 0. The harness specs pass — 138, down from
  140 because two tests of a function this review deleted went with it.
- **Benchmarks actually run.** `node bench/run.mjs --filter join-1kx1k` and
  `--filter mutation/` both green after the changes below, counters collected for every
  selected benchmark. `single-row-insert-1k` at 94 ms, in family with the ~100–120 ms the
  suite comments record.

## Major — fixed in this pass rather than filed

**The "silently memory-only" hole was closed by removing the exception, not by ticketing
the instances.** The handoff listed as a known gap that `execution/join-1kx1k` and
`mutation/single-row-insert-1k` were hand-written, ran on the default backend only, and
"will silently stay memory-only when a second backend lands, unless someone notices."
Nothing downstream owned that: none of `bench-store-workloads`, `bench-store-micro`,
`bench-store-leveldb` or `bench-regression-gate` mentions either name. A ticket per
instance would have left the *shape* — a suite that may contain unexpanded entries — in
place for the next one.

The stated reason `join-1kx1k` "does not fit" was that it builds two tables while
`Workload` carries one `fixture`. That does not follow: a fixture is a function over a
database, and `createPopulatedDb` already builds a table *and* an index. So:

- `createJoinDb` joined `FIXTURES` as `join`, and `join-1kx1k` became an ordinary
  `Workload`, last in `QUERY_WORKLOADS` — which is exactly where it ran before.
- `single-row-insert-1k` became an `own-database` `MutationWorkload`, second in
  `INSERT_WORKLOADS` — again its original position. (The handoff asked for this decision
  explicitly.)
- Both suites' exported arrays are now pure `expandBackends` concatenations. The invariant
  a reader can now rely on: *a benchmark in these suites cannot fail to reach a new
  backend.*
- `defaultBackend()` existed only to serve those two entries and had no remaining caller,
  so it and its two specs were deleted. `BACKENDS.find(b => b.isDefault)` is one line if
  ticket `bench-store-workloads` wants it back.
- `join-1kx1k`'s assertion tightened from "non-zero rows" to exactly 1000 (100 left rows
  × 10 right matches each), matching the treatment `filtered-scan-index-10k` already got.
  Verified by running it.

## Minor — fixed in this pass

- **`bench/workloads/` was outside the package's static checks.** `tsconfig.test.json`
  included `bench/lib/**/*` but not the new directory, and it contained six implicitly-`any`
  parameters — which `AGENTS.md` forbids outright. Added `bench/workloads/**/*` to the
  include and typed the six. The rest of `bench/` is still unchecked; that is the class,
  and it is recorded on `debt-bench-harness-self-test` (below).
- **`teardown` could replace a real failure with a `TypeError`.** `child.mjs` runs
  `teardown` as best-effort cleanup after a `setup` that threw, and `backend.open()` is the
  first thing both binders' `setup` does — so `handle` may be null. Both are now guarded.
- **A mistyped `lifecycle` silently took the `shared-fixture` branch.** `bindMutation` is
  now a `switch` whose default throws, naming the workload and the bad value.
- **`test/bench-discovery.spec.ts` never tested `discover.mjs`.** It tests
  `bench/lib/backends.mjs` and nothing else, while squatting the obvious filename for
  future `discover.mjs` coverage. Renamed to `test/bench-backends.spec.ts`; the mocha glob
  is `test/**/*.spec.ts`, so nothing else changed. `docs/benchmarking.md` updated.
- **Docs.** The paragraph naming the two hand-written entries is now the invariant that
  replaced them.

## Filed — as an arm on an existing ticket, not a new one

**`skip()` has no automated test**, and its plumbing spans a forked worker (`child.mjs`)
and the parent's printing, JSON and guard handling (`run.mjs`) — neither of which any spec
drives. The handoff flagged this honestly as "a real coverage hole, not a tripwire", and it
is: the paths are reachable the moment any benchmark declares `skip()`.

Per *Before you file a ticket*, the site grep found `tickets/backlog/debt-bench-harness-self-test.md`
already claiming `run.mjs`, `child.mjs` and `discover.mjs`, with the same root cause
already named — **the suites directory is computed from the module's own location and is
not a parameter**, so a test can only point the harness at the real suites. Appended as
*Arm added by review of `bench-backend-dimension`* rather than filed fresh, together with
re-measured static-check numbers (the arm from an earlier review quoted 131 `tsc` errors
across `bench/`; it is 148 now, and the suite files dropped from 36 to 14 as their
workloads moved out).

## Tripwire — recorded at the site, not ticketed

The "Work counters collected for N of M benchmark(s)" line in `run.mjs` counts skipped and
failed rows in its denominator, so a run with skips would read as "25 of 27" with no hint
why. Nothing in the repo declares `skip()` today, so it cannot happen yet. `NOTE:` at the
site says to subtract them if skips become routine.

## Considered and declined

- **The `execution` / `mutation` workload-shape split** (the handoff invited a second
  opinion). Kept. The `execution` shape is genuinely plain data and the `mutation` shape
  genuinely cannot be — bending either toward the other produces a type that expresses
  everything and documents nothing, which is the reasoning the plan ticket asked for.
- **The segment structure** (two exported workload arrays per suite rather than one). Kept.
  It costs one extra export and preserves run order exactly; with the hand-written entries
  gone it is now purely a semantic grouping, and both suites' headers say so.
- **`MEMORY_BACKEND.open` setting `default_vtab_module` to the value it already has.**
  Kept, as the plan ticket intended. `setOption` is one registered-option write plus a
  field assignment on the schema manager; against benchmarks measured in tens of
  milliseconds it is not observable. (It *was* worth removing from the timed body of
  `single-row-insert-1k`, where the old code called `defaultBackend(BACKENDS)` — and hence
  re-validated the whole backend set — inside `fn`. Converting it to a workload removed
  that too.)
- **`run.mjs` at 924 lines.** Real, pre-existing, and `debt-oversized-source-files` already
  owns the class. This change added 63 lines to it and none of them are separable.
- **No before/after wall-clock pair.** The handoff is right that this is unfinished, and it
  is unfinishable inside a ticket: it needs two builds measured back to back on an idle
  machine. The related discrepancy — `docs/benchmarking.md` says "roughly 35 seconds", the
  measured full run is ~48 s — predates this change and the line was left alone rather than
  edited on the strength of one dirty-tree measurement.

## Empty categories

No correctness defect was found in the `skip()` plumbing or in `expandBackends` — every
ordering claim the handoff makes about `classify`, `checkRatioGuards` and `compareRun` was
read against the code and holds. No resource leak was found: the binders' `teardown` and
`withFreshDatabase`'s `finally` close every handle, and `withFreshDatabase` is strictly
better than the pre-change bodies, which closed the database on the success path only.
