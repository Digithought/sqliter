description: `col IN (SELECT ...)` used to go quadratic (minutes) once the subquery returned more than ~1000 rows; it now builds the subquery result into a lookup set once per query and probes it per row, so it scales linearly.
files: packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts, packages/quereus/test/optimizer/cache-rules.spec.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test/fuzz.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic, docs/runtime-caching.md, docs/optimizer-rules.md, docs/optimizer.md, docs/runtime.md, docs/invariants.md, docs/architecture.md
difficulty: medium
----

## What changed

Uncorrelated `x IN (subquery)` no longer relies on a row cache that could abandon
under a threshold and re-drive the subquery per outer row (the O(N×K) cliff:
reporter saw 141 ms → 22.3 s → 320 s as the inner set grew past ~1000 rows).
Instead `emitIn` materializes the subquery result **once per statement execution**
into a `BTree` lookup set and probes it per outer row — O(K + N·log K) with zero
statistics.

### Runtime — set probe (`runtime/emit/subquery.ts`, `emitIn`)

- New branch in the pure-subquery path, gated on
  `!isCorrelatedSubquery(plan.source) && PlanNodeCharacteristics.isFunctional(plan.source)`
  (uncorrelated + deterministic + read-only). On the first evaluation that needs
  it, drains the source once into a `BTree` keyed under `effectiveInCollation`,
  recording a `hasNull` flag for inner NULLs. Probes per row with the standard
  three-valued result: hit → `true`; miss → `NULL` if the inner had a NULL else
  `false`; condition `NULL` → `NULL` (does **not** force the build).
- Memoized per execution via a new `RuntimeContext.inSetProbes`
  (`Map<symbol, {tree, hasNull}>`), keyed by a symbol minted in the emit-time
  closure — the same reset-per-execution pattern as `cacheStates` / `executionMemo`
  (closure holds only the symbol, never the set). Also wired into
  `ParallelDriver.fork()` and pinned in `fork-contract.spec.ts` as
  `shared-cooperative`.
- Correlated / non-deterministic sources keep the existing streaming (early-exit,
  per-outer-row) path. Impure (DML-bearing) `IN` branch is untouched.

### Planner — retired `rule-in-subquery-cache`

Rule file deleted; `RULE_MANIFEST` entry + import removed from `optimizer.ts`;
`'in-subquery-cache'` dropped from `CACHE_RULES` in `fuzz.spec.ts`; stale
references scrubbed from `pass.ts` / `optimizer.ts` comments and the docs. A row
cache would just double-buffer the value set now.

## Why the fix actually holds (the load-bearing detail to re-verify)

The set probe is driven as a per-outer-row scalar sub-program, so the scheduler
re-produces the `sourceInstruction` value on **every** outer evaluation. This only
avoids re-scanning the source because `scan.ts`'s `run` is an `async function*` —
calling it returns a generator **without** running `module.connect()` /
`table.query()`; the scan opens only on first iteration. After the build
evaluation, every later evaluation creates-but-never-iterates that generator, so
no additional scan/connect occurs. If a future change makes a source emitter open
its scan eagerly (in `run` rather than on first `next()`), this optimization
silently regresses to N opens. The scan-count spec is the tripwire.

## Use cases to validate

- **The regression itself.** `delete from T where fk in (select id from U where
  ...)` at inner size ≫ 1000 must be linear, not quadratic. Covered by the memory
  sentinel `Performance sentinels › IN-subquery set probe` (outer≈10k / inner≈5k,
  SELECT + DELETE, both < 3 s; ran in ~0.6 s — quadratic would be tens of seconds).
- **Scan-count guarantee.** `test/vtab/in-subquery-cache-scan-count.spec.ts`
  (rewritten): the source is scanned exactly once per execution — for a
  match-heavy outer relation, with a leading NULL-condition row, **and regardless
  of `cte.maxCacheThreshold`** (the knob that used to trigger the abandon cliff now
  has no effect), and once per execution across a prepared-statement re-run.
- **Three-valued semantics** (`test/logic/07.7-in-subquery-caching.sqllogic`):
  inner-NULL → NULL not false; empty inner → false; NOT IN with NULLs; IN in
  projection position (three-valued boolean per row).
- **Collation**: NOCASE membership matches the streaming path (both use the same
  `effectiveInCollation`-resolved comparator).
- **Self-referencing DELETE** `delete from t where id in (select id from t where
  ...)` is now a deterministic pre-statement snapshot (materialize-once). Pinned in
  sqllogic. NOTE for the reviewer: pre-fix this shape *diverged* depending on
  whether the cache abandoned — the new behavior is deterministic, which is the
  intended semantics but a behavior change worth a second look.
- **Parameterized-but-uncorrelated subquery** across two executions of one prepared
  statement (`prepared-statement-amortization.spec.ts`): a `?` inside the subquery
  is not correlation, so it takes the set-probe path and rebuilds per execution as
  the bound value changes.
- **UPDATE / DELETE row counts** filtered by `IN (subquery)` (sqllogic).

## Validation performed

- `yarn build` — clean.
- `yarn test` (memory) — **7175 passing, 0 failing**, 13 pending.
- `yarn test:store` (LevelDB store module — the reporter's environment) —
  **7169 passing, 0 failing**, 19 pending.
- `yarn lint` (eslint + test-file typecheck) — clean.

## Known gaps / where the reviewer should push

- **Tests are a floor.** The perf sentinel runs on the **memory** module only. I
  did **not** run the throwaway LevelDB seed-and-time repro harness the ticket
  describes (that's manual/out-of-band); store correctness is covered by
  `test:store` but store-side *timing* is not asserted anywhere.
- **Non-deterministic gate is untested by a dedicated case.** The gate routes a
  `random()`-filtered IN subquery to the streaming path, but I added no sqllogic
  test for it (per-row non-determinism is awkward to assert deterministically). The
  gate is exercised indirectly by the correlated-IN tests staying green; a reviewer
  who wants belt-and-suspenders could add a "streaming path chosen" plan/behavior
  check.
- **`isFunctional` / correlation at emit time.** Correctness rests on
  `isCorrelatedSubquery` treating parameter references as *not* correlation (it only
  inspects `ColumnReference`) and on `physical.readonly` + determinism being final by
  emit time. Both are asserted behaviorally (parameterized test; correlated tests),
  not by a direct unit test of the gate predicate.
- **No cap on set size** (parity with the already-uncapped literal `IN (a,b,…)`
  path). A `NOTE:` tripwire sits at the build site in `subquery.ts`.

## Tripwires recorded (not tickets)

- **Eager CacheNode mode is now dormant.** Removing `rule-in-subquery-cache` left
  `CacheNode.eager` / the `shared-cache.ts` eager-drain branch with **no caller**
  (every other cache rule uses streaming-first). It is correct-but-unused — kept for
  a future short-circuiting cache consumer, else dead code to remove. Parked as a
  `> NOTE:` in `docs/runtime-caching.md` § Eager vs. streaming-first build. Not
  filed as a ticket (cleanup/debt, genuinely conditional).
- **Source-emitter laziness is load-bearing** (see "Why the fix holds" above). The
  reasoning lives in the code comment in `emitIn`'s set-probe branch and the header
  of `in-subquery-cache-scan-count.spec.ts`.

## Out of scope (still valid, do not fold in here)

The ticket's `bug-cache-threshold-abandon-cliff` — the backwards
`min(max(estimatedRows*0.1,1000),…)` threshold in `CachingAnalysis.getCacheThreshold`
that still afflicts `rule-scalar-subquery-cache` and the nested-loop/CTE caches — is
a **separate** ticket and was intentionally left untouched.
