---
description: The benchmark harness can now run one workload definition against several storage engines, and a benchmark can decline to run and say why instead of failing or vanishing. Nothing measured changed — every existing benchmark still prints the same name.
files:
  - packages/quereus/bench/lib/backends.mjs              # NEW - backend descriptors + expandBackends
  - packages/quereus/bench/workloads/execution.mjs       # NEW - execution workloads + 4 fixtures
  - packages/quereus/bench/workloads/mutation.mjs        # NEW - mutation workloads
  - packages/quereus/bench/suites/execution.bench.mjs    # now a binder
  - packages/quereus/bench/suites/mutation.bench.mjs     # now a binder
  - packages/quereus/bench/lib/discover.mjs              # skip() in the Benchmark typedef + validation
  - packages/quereus/bench/child.mjs                     # skip phase, `skipped` IPC message
  - packages/quereus/bench/run.mjs                       # skipped row, JSON array, ratio-guard handling
  - packages/quereus/bench/lib/compare.mjs               # `skipped` comparison status
  - packages/quereus/test/bench-discovery.spec.ts        # NEW - expandBackends coverage
  - packages/quereus/test/bench-comparison.spec.ts       # skipped-status cases
  - docs/benchmarking.md
difficulty: medium
---

# What landed

Two independent capabilities, both in `packages/quereus/bench/`. Neither changes a
measurement.

## 1. The backend dimension

`bench/lib/backends.mjs` is new. It owns a `BenchBackend` descriptor (`id`, `isDefault`,
`label`, `open()`), the `BACKENDS` array (one element today: `MEMORY_BACKEND`), and
`expandBackends(backends, workloads, bind)`, which turns one workload definition into one
benchmark per backend.

The dimension is a **name suffix**. The default backend publishes the bare name; every
other backend appends `@<id>`:

```
execution/full-scan-10k            the default (memory) module
execution/full-scan-10k@store-mem  the same query on some other module
```

Expansion happens while the suite builds its exported array, so `run.mjs`, `child.mjs`,
`compare.mjs` and `stats.mjs` see a longer flat list and are otherwise untouched. There is
no `--backend` flag — `--filter` is a substring match and already gives both readings.

The `execution` and `mutation` workload definitions moved out of the suite files into
`bench/workloads/`. The suites are now binders. The two suites have **different workload
shapes** on purpose (see *Judgement calls* below).

## 2. `skip()`

A benchmark may declare `skip()`, returning a reason to decline or `null` to run.
Evaluated in the worker, before `setup`, in its own phase. A skipped benchmark keeps its
table row (`skipped — <reason>`), lands in a new top-level `skipped` array in the results
JSON, is in neither `benchmarks` nor `failures`, does not affect the exit code, compares as
a new `skipped` status (never `missing`), and makes a ratio guard naming it report
`not-evaluated` (never `misconfigured`).

# How to validate

```
cd packages/quereus

# 1. Names must be byte-identical to before the refactor — the acceptance check.
node -e "import('./bench/lib/discover.mjs').then(async m => {
  const s = await m.loadSuites();
  for (const b of m.selectBenchmarks(s, null)) console.log(b.fullName);
})"
# Expect exactly the 27 names, in the order below. Compare against the same command
# run on HEAD~ (or against `git stash`-free checkout of the pre-change suite files).

# 2. Full suite, all green.
node bench/run.mjs

# 3. Harness unit tests.
cd ../.. && node --experimental-vm-modules --loader ts-node/esm \
  ./node_modules/mocha/bin/mocha.js "packages/quereus/test/bench-*.spec.ts"
```

The 27 names, in run order — this list is the contract:

```
execution/full-scan-10k              execution/temporal-arith-scan-10k
execution/filtered-scan-index-10k    execution/group-by-10k
execution/order-by-10k               execution/order-by-text-10k
execution/order-by-text-prefix40-10k execution/order-by-text-unicode-10k
execution/group-by-text-10k          execution/distinct-text-10k
execution/text-pk-range-scan-10k     execution/text-pk-point-seek-10k
execution/join-1kx1k                 execution/correlated-subquery
execution/hand-batched-peer-count    mutation/bulk-insert-10k
mutation/single-row-insert-1k        mutation/update-where-1k
mutation/delete-where-100            parser/simple-select
parser/complex-select                parser/wide-select-50cols
parser/insert-values                 planner/simple-scan-plan
planner/join-plan                    planner/aggregate-plan
planner/subquery-plan
```

## Exercising `skip()`

No benchmark in the repo declares `skip()`, so the full suite does not exercise it. To
drive it end to end, drop a throwaway suite in `bench/suites/`, run it, and delete it:

```js
// bench/suites/tmpskip.bench.mjs
export const benchmarks = [
	{ name: 'declines', skip() { return 'no backend here'; },
	  setup() { throw new Error('setup must not run'); }, fn() { throw new Error('fn must not run'); } },
	{ name: 'runs', skip() { return null; }, fn() { let x = 0; for (let i = 0; i < 1e4; i++) x += i; return x; } },
];
export const ratioGuards = [{ name: 'runs', baseline: 'declines', maxRatio: 2 }];
```

`node bench/run.mjs --filter tmpskip/` should print `declines … skipped — no backend here`,
run `runs` normally, exit 0, write `skipped: [{name, reason}]` with an empty `failures`, and
report the guard as `not-evaluated`. That is what was observed. **Delete the file after.**

# What was actually run

| Check | Result |
| --- | --- |
| Benchmark-name diff, before vs after (order-sensitive `diff`) | identical, all 27 |
| `node bench/run.mjs` (full) | 27/27 pass, ratio guard `0.98×` (max 10×), wall-clock **48.3 s** |
| `bench-*.spec.ts` (mocha) | 140 passing |
| `yarn test` (whole monorepo) | pass, 5m12s |
| `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) | exit 0 |
| Filtered runs with counters on, both suites | counters collected for every selected benchmark |
| `skip()` end-to-end via throwaway suite | row, JSON, guard, exit code all as specified |

# Judgement calls a reviewer should weigh

**The two suites have different workload shapes, and the ticket described one.** The
ticket's `Workload` typedef (`fixture` / `sql` / `expectedRows`) fits `execution` and
cannot express `mutation` at all — a mutation benchmark's timed body is a procedure, and
three of the four time a whole database's life rather than a statement over a fixture. So
`workloads/mutation.mjs` defines its own `MutationWorkload`: `{name, lifecycle, populate?,
run, counters}`, where `lifecycle` is `own-database` (binder opens a fresh db per `fn`
call) or `shared-fixture` (`populate` once in `setup`). This follows the ticket's *"a
Workload type that can express everything expresses nothing"* rather than its literal
typedef.

**`single-row-insert-1k` is hand-written, and under the shape above it need not be.** The
ticket said to leave it hand-written; I did. But unlike `join-1kx1k` — which genuinely does
not fit, since it builds two tables and `Workload` carries one `fixture` — this one would
fit `MutationWorkload` cleanly as an `own-database` entry. **Worth a decision now**, because
for a persistent store it is arguably the most interesting write shape (it prices
per-statement commit), and the next ticket will want it. The comment on its entry in
`bench/suites/mutation.bench.mjs` says so.

**Benchmark ORDER was preserved, which the ticket's suggested structure would not have.**
The ticket sketched `[...expandBackends(...), ...handWritten]`, which moves `join-1kx1k`
from 13th to last and `single-row-insert-1k` from 2nd to last. Instead each suite expands in
segments (`QUERY_WORKLOADS`, hand-written, `DECORRELATION_WORKLOADS`), grouped by meaning
rather than by index. Cost: two exported workload arrays per suite instead of one, so a
cross-segment name collision is caught by `loadSuite` rather than by `expandBackends`.
Benefit: the name diff is clean including order, and nobody has to decide whether a reorder
matters. Reviewer may prefer the simpler concatenation — it is a two-line change.

**`filtered-scan-index-10k`'s assertion got stronger.** It asserted `rows.length !== 0`
("Expected some rows"); the `Workload` shape carries an exact `expectedRows`, and the exact
answer is 10 (`val = id*7%1000`, so `val = 42` selects `id ≡ 6 (mod 1000)`). Now asserted as
10. Strictly stronger, no measurement change — but it is a behaviour change to a benchmark's
assertion, and it is the one place I did not simply move code.

**A skipped benchmark's COUNTER verdict is `none`, not `skipped`.** The ticket says to
confirm the comparison reports it "as `skipped`, not `dropped`". The *row status* is
`skipped`. The *counter status* is `none`, joining `failed`/`new`/`missing`/`filtered` —
"not comparable at all". Reusing `CounterStatus.skipped` would have been wrong: it means
"this run was invoked with `--no-counters`", and `printCounterSummary` prints exactly that
sentence when the count is non-zero, which would be a false statement about the run. Both
the code comment and a spec case state this.

**`MEMORY_BACKEND.open` calls `setOption('default_vtab_module', 'memory')`** — setting the
option to the value it already has. Deliberate, per the ticket: the descriptor states its
own claim rather than relying on the engine default. It is one map write against a
benchmark measured in milliseconds, and the full-suite numbers are in family with the
pre-change figures recorded in the suite comments.

# Known gaps

- **No before/after wall-clock pair from one sitting.** The measured "after" is 48.3 s. I
  did not capture a "before" in the same session, so the honest statement is: 48.3 s is
  consistent with the ~48 s the existing `mutation.bench.mjs` header records for a 27-
  benchmark run, and inconsistent with the "roughly 35 seconds" `docs/benchmarking.md`
  claims — but that discrepancy **predates this change** and the doc line was not touched.
  If a reviewer wants the pair, run `node bench/run.mjs` on `HEAD` and on this tree back to
  back.
- **`skip()` has no automated test.** Its plumbing spans `child.mjs` (a forked worker) and
  `run.mjs` (printing, JSON, guards), neither of which any spec drives — the existing
  harness specs only cover the pure modules. It was verified by hand, as above. A spec that
  forks `child.mjs` against a fixture suite is the obvious follow-up; it is a real coverage
  hole, not a tripwire.
- **`compare.mjs`'s `skipped` status is covered; `run.mjs`'s handling of it is not.** The
  table row, the `skipped` JSON array and `checkRatioGuards`'s `not-evaluated` path were
  checked by hand only.
- **No backend other than `memory` exists**, so `expandBackends` producing a suffixed name
  is exercised only by `test/bench-discovery.spec.ts`'s synthetic backends, never by a real
  run. That is the next ticket's job.
- **`join-1kx1k` and `single-row-insert-1k` are not backend-expanded** and will silently
  stay memory-only when a second backend lands, unless someone notices. Each carries a
  comment at its definition site saying so.

# Review focus

- `expandBackends`'s validation set — is anything a malformed backend set could do still
  uncaught? The collision case it handles is within one call; two calls in one suite rely
  on `loadSuite`.
- The `skip()` early-return path in `child.mjs`: it deliberately does **not** run
  `teardown` (nothing was constructed) and exits 0 via the same `finishCleanly()` the
  result path uses.
- `classify()` in `run.mjs` checks `outcome.skipped` **before** the failure and
  empty-result branches; a skipped child exits 0 having sent no result, and would otherwise
  read as a dead child.
- Whether the `execution`/`mutation` workload-shape split is the right seam, or whether one
  of them should bend toward the other.
