description: Added and verified automated guards that catch a query-optimizer regression where a subquery re-runs once per row (an "N+1 scan"), so that class of performance bug can't slip through CI unnoticed again.
files: packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/bench/suites/execution.bench.mjs, packages/quereus/bench/run.mjs, docs/todo.md
difficulty: medium

# Complete: plan-quality regression guards

## What shipped

Three guards against the "N+1 scan" optimizer regression class — a correlated
scalar-aggregate subquery
(`select p.id, (select count(*) from c where c.pid = p.id) from p`) re-scanning
the inner table once per outer row instead of decorrelating into one grouped
join. The `scalar-agg-decorrelation` rule fixes the plan shape; nothing asserted
scan economy before this.

1. **Primary always-on guard** (`yarn test`) —
   `test/vtab/correlated-scalar-agg-scan-count.spec.ts`. Reuses
   `CountingMemoryModule` (`USING countmem()`), which counts every `query()` open
   keyed by lowercased table name. Enabled run asserts `scanCounts.get('c') === 1`;
   disabled run (`disabledRules: {'scalar-agg-decorrelation'}`) asserts `=== N`
   (N=4) so the harness provably observes the N+1. Both assert result correctness
   including the empty-child row (`p.id=4 → n=0`, not NULL).
2. **Secondary guard** (`yarn bench`, not in `yarn test`) —
   `execution.bench.mjs` adds `hand-batched-peer-count` (explicit grouped-join
   twin of `correlated-subquery`) and a `ratioGuards` export; `run.mjs`
   `checkRatioGuards()` compares medians and `process.exit(1)` on breach or
   unknown-benchmark misconfig. `maxRatio` = loose 10× (order-of-magnitude).
3. **Docs sweep** — `docs/todo.md` narrowed the stale "Subquery Optimization"
   entry to the remaining uncovered shapes and annotated the Phase-4 `ApplyNode`
   framing.

## Review findings

Adversarial pass over the implement diff (commit `cee173e9`), read fresh before
the handoff. Verdict: **clean — no inline fixes, no new tickets.**

**Checked & confirmed:**
- **Correctness (spec):** ran the new spec in isolation — **2 passing**. Traced
  the API surface it depends on: `db.optimizer.tuning` (public field,
  `optimizer.ts:1129`), `updateTuning` (full replace, `:1143`), `disabledRules`
  (`OptimizerTuning`, `optimizer-tuning.ts:93`). The disabled test spreads
  `...before` into a fresh object and restores in `finally`, so it does not
  mutate shared `DEFAULT_TUNING` — no cross-test pollution.
- **Rule id accuracy:** `scalar-agg-decorrelation` is registered
  (`optimizer.ts:555`); the sibling `-aggregate` variant (`:573`) targets the
  Aggregate-argument shape, which the test SQL (Project-site) does not hit, so
  disabling only the one rule genuinely produces the N+1. `subquery-decorrelation`
  (`:534`, referenced in the docs edit) also exists.
- **Bench twin equivalence:** `correlated-subquery` and `hand-batched-peer-count`
  return identical 100-row results over `bench_t` (every `a.label` exists in the
  grouped subquery, so `coalesce(g.cnt,0)` never actually coalesces). Guard
  direction is correct: a broken rule makes the declarative side slow → ratio
  spikes.
- **`checkRatioGuards` math:** exercised all four branches in isolation —
  pass (0.60×) → 0 failures, fail (26×) → 1, missing-benchmark misconfig → 1,
  degenerate both-medians-0 → 0 (returns ratio 1, no NaN/Infinity). The
  `exit(1)` gate is `failures > 0`. **This closes the implementer's flagged gap**
  (see tripwire below) for the function logic.
- **Docs:** re-read `docs/todo.md` edits against the actual rule ids — accurate
  and no longer stale.
- **Lint:** `yarn lint` (eslint + `tsc -p tsconfig.test.json`) **EXIT=0**.
- **Full suite:** `node test-runner.mjs` — **7063 passing, 13 pending, EXIT=0**.

**Minor (not fixed — cosmetic only):**
- Ticket `files:` header named `packages/quereus/docs/todo.md`; the real file is
  repo-root `docs/todo.md` (what was edited). No `packages/quereus/docs/` exists.
  Corrected in this ticket's header. No code impact.
- `checkRatioGuards` misconfig branch reports only the first missing benchmark
  when both are absent. Harmless — still counts a failure and exits non-zero.

**Empty categories (explicit):**
- **New tickets (major):** none — no defect or missing capability surfaced that
  warrants follow-up work.
- **Error handling / resource cleanup:** nothing to fix — spec closes its `db` in
  `afterEach`; bench benchmarks close in `teardown`; the disabled-rule test
  restores tuning in `finally`.
- **Backend coverage gap:** the scan-count spec is memory-vtab only, but it
  guards a backend-agnostic plan-shape property (scan count), so `test:store`
  would add no signal. Deliberately not added — not a finding.

## Tripwire parked

The bench ratio-guard **failure path is not run by any CI** — `yarn bench` is not
part of `yarn test`, so the `exit(1)`-on-breach path only executes when a human
runs the bench. This review de-risked the *function logic* by exercising every
branch in isolation (above), but the full-bench wiring + actual process exit
code remain unexercised by an automated job. This is conditional (only matters if
the bench itself regresses), not a latent defect — recorded here and next to
`ratioGuards` in `execution.bench.mjs` via the existing intent comment. Not
filed as a ticket; a self-failing bench entry would be CI noise.

## Validation performed (this review)

- New spec in isolation: **2 passing**.
- `checkRatioGuards` branch harness: pass/fail/misconfig/degenerate all correct.
- `yarn lint`: **EXIT=0**.
- `node test-runner.mjs` (full suite): **7063 passing, 13 pending, EXIT=0**.
