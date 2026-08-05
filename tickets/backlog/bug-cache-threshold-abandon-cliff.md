description: The row-cache safety threshold is computed so that even a perfectly estimated result abandons the cache, silently degrading scalar subqueries and nested-loop joins from linear to quadratic on larger inputs.
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts, packages/quereus/src/planner/optimizer-tuning.ts
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: Answers stay correct - this is a performance cliff, which is why it is filed below wrong-result - and raising the threshold trades a bounded slowdown for unbounded cache memory when an estimate is badly wrong, which is what the guard exists to prevent.
----

## Problem

`CachingAnalysis.getCacheThreshold` (`planner/framework/characteristics.ts:508`) computes:

```
min(max(estimatedRows * 0.1, 1000), 100000)
```

That threshold is the row count at which `streamWithCache`
(`runtime/cache/shared-cache.ts`) **abandons** the cache and streams every later
evaluation directly from the source — i.e. re-executes the subtree per consumer.

Two defects:

1. **The formula is backwards.** A threshold meant to guard against misestimates
   should tolerate results *larger* than the estimate (e.g. `estimatedRows * 2`).
   `estimatedRows * 0.1` means a result only has to reach 10% of its own accurate
   estimate to abandon — with perfect statistics the cache still fails. Better stats
   (including the planned adaptive-optimizer feedback loop,
   `tickets/backlog/known/2-adaptive-query-optimization.md`) make no difference.

2. **Abandonment is a silent complexity cliff.** Past the threshold, behavior flips
   from O(K) once to O(N×K) — for store-backed tables that is N remote scans. The
   cliff was the root cause of the `IN (subquery)` DELETE pathology (fixed by
   emit-level set materialization in `quereus-in-subquery-set-probe`), but the same
   mechanism still backs `rule-scalar-subquery-cache` and
   `rule-nested-loop-right-cache`, which have the identical failure mode when the
   inner result exceeds ~1000 rows and no stats exist.

Secondary observation: the cached-replay path in `shared-cache.ts` deep-copies every
row on every consumption — O(rows × consumers) allocations. Worth revisiting while in
the file (copy-on-write or freeze instead).

## Expected behavior

- Threshold semantics: a *guard multiple above* the estimate (multiplier ≥ 1, e.g.
  the existing `cacheThresholdMultiplier: 2` tuning value), with a floor for the
  no-stats case that is generous enough not to be the common case (the current 1000
  floor is routinely exceeded by ordinary workloads).
- Exceeding the guard should degrade gracefully (e.g. spill strategy, or keep the
  buffer and log) rather than flipping to per-consumer re-execution — at minimum for
  sources that are expensive to re-drive (store/vtab-backed).
- Abandonment also flips observable semantics for self-referencing statements
  (cached = snapshot, abandoned = live re-read) — whatever replaces it should be
  deterministic.
