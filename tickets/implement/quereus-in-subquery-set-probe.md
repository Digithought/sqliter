description: Deleting or filtering rows with `col IN (SELECT ...)` becomes catastrophically slow (quadratic) once the subquery returns more than ~1000 rows, because the engine falls back to re-running the subquery for every candidate row; materialize the subquery result once into a lookup set instead.
files: packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/cache/correlation-detector.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/test/optimizer/cache-rules.spec.ts, packages/quereus/test/fuzz.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/optimizer-rules.md, docs/optimizer.md
difficulty: medium
----

## Problem

Reported against `@quereus/quereus` 4.3.2 + IndexedDB store plugin; reproduced on 4.4.0 with the LevelDB store module:

```sql
delete from dt_entry where txn_id in (select id from dt_txn where entity_id = 'e1')
```

| entries deleted | inner subquery rows | time |
|---|---|---|
| 1,000 | 500 | 141 ms |
| 4,000 | 2,000 | 22.3 s |
| 16,000 | 8,000 | 320 s |

Linear below a cliff, quadratic above it. The cliff sits exactly at inner-result size 1,000.

## Root cause (confirmed by repro + debug logs)

The plan itself is correct. An uncorrelated `IN (SELECT ...)` is *not* decorrelated
(`rule-subquery-decorrelation` is correlated-only by design) and instead gets an eager
`CacheNode` wrap from `rule-in-subquery-cache`. Verified present in the DELETE plan on
both memory and store modules. Two defects sit downstream of that:

1. **Threshold cliff.** The cache threshold is
   `min(max(estimatedRows * 0.1, 1000), 100000)`
   (`CachingAnalysis.getCacheThreshold`, `planner/framework/characteristics.ts:508`),
   further capped by `tuning.cte.maxCacheThreshold`. With no stats (every store-backed
   table) the floor is 1,000 rows. When the inner result exceeds it, the eager build
   **abandons the cache permanently for the execution**
   (`runtime/cache/shared-cache.ts` — `cacheAbandoned = true`), and every subsequent
   outer row re-drives the subquery against the store: O(N×K) store scans. Confirmed
   via `DEBUG='*cache*'`: hundreds of "cache abandoned … streaming directly" lines.
   Note the formula is also backwards — with a *perfect* estimate of K rows the
   threshold is K/10, so the cache still abandons (filed separately as
   `bug-cache-threshold-abandon-cliff`).

2. **O(K) probe even when cached.** `emitIn`'s pure-subquery path
   (`runtime/emit/subquery.ts`, `runSubqueryStreaming`) linearly scans the row
   iterable per outer row, and the shared-cache replay deep-copies every cached row
   per consumption. At the reporter's real scale (35k outer × 17.7k inner) that is
   ~300M comparisons plus ~600M row-element copies — minutes even fully cached. So a
   bigger threshold alone cannot fix this.

## Design

Replace the row-cache-plus-linear-scan mechanism with a **materialized lookup set**
built once per execution, probed per row. This is a "Tier 0 robust default" in the
sense of the adaptive-optimizer direction (`tickets/backlog/known/2-adaptive-query-optimization.md`):
the O(K + N log K) bound must hold with **zero statistics** — no stats-derived gating.

### Runtime: set probe in `emitIn`

In the pure-subquery branch of `emitIn` (`runtime/emit/subquery.ts`):

- **Gate**: apply the set-probe path when the source is uncorrelated
  (`isCorrelatedSubquery(plan.source)` from `planner/cache/correlation-detector.ts`
  is false) **and** functional (`PlanNodeCharacteristics.isFunctional(plan.source)` —
  deterministic + read-only). Both are plan-level checks available at emit time.
  Otherwise keep the existing streaming per-evaluation path unchanged (correlated
  sources must re-evaluate per row; non-deterministic sources keep their per-row
  semantics).
- **Build**: on the first evaluation that needs it (condition non-null), drain the
  source once into a `BTree<SqlValue, SqlValue>` keyed with the resolved collation
  comparator (`effectiveInCollation` — exactly like the existing constant value-list
  path in the same file), plus a `hasNull` flag for inner NULLs. A null condition
  returns `null` without forcing the build.
- **Memoize per execution**: mirror the impure-IN branch's `executionMemo` pattern
  (symbol key minted in the emitter closure, state stored on `RuntimeContext`) so the
  probe structure resets between executions of a prepared statement. Widen the memo
  helper or add a parallel map — the existing helpers store `{ value: SqlValue }`;
  this needs `{ tree, hasNull }`.
- **Probe**: condition null → `null`; found in tree → `true`; else
  `hasNull ? null : false`. Identical three-valued semantics to today's streaming
  path and the value-list path.
- **No size cap.** The set holds deduplicated scalar values, strictly less memory
  than the row cache it replaces, and the literal `IN (a, b, …)` path is already
  uncapped — parity. Leave a `NOTE:` tripwire comment about memory if enormous inner
  results ever matter.

### Planner: retire `rule-in-subquery-cache`

With `emitIn` materializing exactly once per execution, the eager `CacheNode` wrap is
redundant (it would double-buffer: row cache + value set). Remove:

- the rule file `planner/rules/cache/rule-in-subquery-cache.ts`,
- its `RULE_MANIFEST` entry in `planner/optimizer.ts`,
- the `'in-subquery-cache'` id from `CACHE_RULES` in `test/fuzz.spec.ts`,
- the stale reference in the `pass.ts` materialization-advisory comment,
- its entry in `docs/optimizer-rules.md`; adjust the "intelligent caching" blurb in
  `docs/optimizer.md` / `docs/architecture.md` if it names IN-subquery caching.

`rule-scalar-subquery-cache` and the nested-loop/CTE cache rules are untouched (their
own threshold cliff is `bug-cache-threshold-abandon-cliff`).

## Edge cases & interactions

- **Inner NULLs**: `x IN (…set containing NULL…)` with no match must yield NULL, not
  false. Existing sqllogic coverage may exist — extend if thin.
- **Empty inner result** → `false` (not NULL).
- **Condition NULL** → NULL, and must not force the build (short-circuit).
- **Collations**: set keyed under `effectiveInCollation` — NOCASE/RTRIM membership
  must match the streaming path's behavior. Test at least NOCASE.
- **Correlated subquery** → gate must route to the streaming path; existing
  correlated-IN tests must stay green.
- **Non-deterministic source** (e.g. `random()`-filtered subquery) → not functional →
  streaming path; per-row re-evaluation semantics preserved.
- **Impure (DML-bearing) subquery** → existing `IN(impure)` branch is untouched.
- **Statement parameters inside the subquery** (`where entity_id = ?`): uncorrelated
  with respect to outer attributes — verify `isCorrelatedSubquery` does not count
  parameter references as correlation, and add a test binding different values across
  two executions of one prepared statement (memo must reset per execution).
- **Self-referencing DML**: `delete from t where x in (select … from t …)` — the set
  is a pre-statement snapshot. Today's behavior *diverges* on this shape depending on
  whether the cache was abandoned (cached = snapshot, abandoned = live re-read);
  materialize-once makes it deterministically snapshot. Pin with a sqllogic test.
- **IN in projection position** (`select x in (select …) from t`) — same emitter
  path, benefits identically; needs the three-valued result (semi-join rewrites could
  not handle this position — the set probe must).
- **Re-execution after writes in the same transaction**: fresh `RuntimeContext` per
  execution → fresh memo → re-drain sees the writes. Confirm no memo leak via the
  emitter closure (closure holds only the symbol, never the state — same rule as
  `emitCache`'s comment block).
- **Plan-shape fallout**: removing the rule drops the `CACHE` node under `In` —
  update `test/optimizer/cache-rules.spec.ts` expectations and any golden plans that
  serialize an IN-subquery shape.

## Validation

- Repro harness (throwaway, for manual verification): seed N txns / 2N entries on the
  LevelDB store module, run the DELETE above at N = 500 / 2,000 / 8,000. Expect
  near-linear scaling (pre-fix: 141 ms / 22.3 s / 320 s).
- Performance sentinel (memory module, generous threshold per existing sentinel
  style): DELETE with inner ≈ 5,000 rows and outer ≈ 10,000 rows must complete well
  under a bound that quadratic behavior would blow through.
- `yarn test` and `yarn test:store` both green; `yarn lint`.

## TODO

- [ ] Set-probe path in `emitIn` pure-subquery branch: gate (uncorrelated + functional), lazy first-eval BTree build with collation comparator + hasNull, per-execution memo, three-valued probe
- [ ] Keep streaming path for correlated / non-functional sources; verify gate routing with existing correlated-IN tests
- [ ] Retire `rule-in-subquery-cache`: rule file, `RULE_MANIFEST` entry, `CACHE_RULES` list in fuzz.spec.ts, `pass.ts` comment
- [ ] Update `test/optimizer/cache-rules.spec.ts` (no CACHE under In; correctness tests stay), plus any golden plan snapshots that change
- [ ] sqllogic tests: inner-NULL semantics, empty set, NOCASE collation, self-referencing DELETE snapshot, parameterized subquery across two executions, DELETE + UPDATE `WHERE col IN (subquery)` row counts
- [ ] Performance sentinel for the DELETE-IN-subquery shape
- [ ] Docs: `docs/optimizer-rules.md`, `docs/optimizer.md` caching blurb; note emit-level IN-set materialization in `docs/runtime.md` if it describes `emitIn`
- [ ] `yarn test`, `yarn test:store`, `yarn lint` green
