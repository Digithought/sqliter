description: Progressive JIT-inspired query optimization — robust defaults, runtime feedback, tiered investment
difficulty: hard
prereq: optimizer framework, statistics infrastructure, runtime execution, emit layer
files: packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/analysis/expression-fingerprint.ts, packages/quereus/src/runtime/emission-context.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/cache/shared-cache.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, docs/optimizer.md, docs/progressive-optimizer.md
----

Architecture: [docs/progressive-optimizer.md](../../docs/progressive-optimizer.md)

## Motivation

Quereus targets distributed environments where BTree nodes are stored across a DHT. Every query that touches the network is expensive. We cannot afford to "run stats" — ANALYZE-style full scans are out of the question in production. The optimizer must produce good plans with zero pre-collected statistics, improve plans cheaply from execution feedback, and never issue non-essential queries just to support planning.

Traditional stats-first optimization (collect → optimize → execute) fails in this context:
- **Cold start**: No stats available, so plans are guesses
- **Stale stats**: Data changes, stats don't, plans degrade silently
- **Collection cost**: Stats collection itself is expensive I/O against the DHT
- **Distribution skew**: Aggregate stats miss per-value correlations

The strategy: **statistics are hints that improve good plans, not prerequisites without which plans are bad.** The system must have good worst-case performance regardless of available information, then use execution feedback to improve progressively.

## Design Philosophy: JIT-Inspired Progressive Optimization

The JIT compiler analogy: interpret first, profile, then optimize hot paths. For query optimization:

1. **Never block on optimization** — always have a runnable plan immediately
2. **Robust defaults** — heuristic choices that avoid catastrophic plans without any data
3. **Cheap instrumentation** — piggyback on existing pipeline breakers, never add new ones for monitoring
4. **Progressive improvement** — first execution is acceptable, subsequent executions get better
5. **Monotonically improving** — plan quality should only go up over a query's lifetime

The existing streaming-first architecture is well suited — no up-front materialization means problems are detected early, pipeline breakers are natural instrumentation points, and a bad plan can be replaced on next execution without wasting materialized data.

## Optimization Tiers

### Tier 0 — Heuristic Plan (always available, ~0ms overhead)

The "interpreter" tier. No cost model, no stats lookup. Structurally sound decisions that are correct regardless of data distribution:

- **Predicate pushdown** — always reduces work, no cost analysis needed
- **Index seek on equality match** — when an equality predicate exactly matches an available index, use it. This is almost never wrong and avoids the catastrophic full-scan-when-PK-lookup-exists case
- **Hash join over nested loop** for non-trivial inputs — O(n+m) vs O(n×m) worst case
- **Projection pruning** — always reduces intermediate width
- **Subquery decorrelation** — eliminates N+1 patterns when structurally possible

These rules define the **worst-case floor**. Even with zero information, the system avoids the truly bad plans: full cross-products, correlated subquery N+1 loops, scanning when a PK lookup is available.

Tier 0 is appropriate for: DDL, simple lookups, ad-hoc queries, the first execution of any query pattern. The key property is that these transformations are always beneficial — they don't require cost data to make the right call.

### Tier 1 — Cost-Based Plan (current optimizer, uses available stats)

The full multi-pass optimization pipeline. Runs when cached statistics are available (from vtab-supplied stats or prior runtime feedback). This is where join enumeration (QuickPick), access path costing, hash vs. stream aggregate selection, and materialization advisory live.

Key constraint: **never block waiting for stats.** Use whatever's cached. If stats are missing for a particular table or predicate, fall back to Tier 0 heuristics for that decision point. The cost model uses available information to improve on heuristic defaults, but missing data produces a graceful degradation to Tier 0 behavior, not a bad plan.

The current `CatalogStatsProvider → NaiveStatsProvider` fallback chain already embodies this for catalog stats. The adaptive layer extends it with runtime observations.

### Tier 2 — Feedback-Refined Plan (after execution provides reality data)

After executing with a Tier 0/1 plan, runtime cardinality counters reveal actual row counts at instrumented plan nodes. If actual counts diverge significantly from estimates (>10× off), the system updates a runtime stats overlay and marks the plan for re-optimization on next use.

No mid-execution re-planning — just "next time, use better numbers." This is cheap: the re-optimization reuses the existing structural plan and only re-runs physical selection (access path choice, join strategy, aggregate strategy) with updated cardinality inputs.

### Tier 3 — Mid-Execution Adaptation (longer term)

At pipeline breakers (sort, hash build, aggregate), check actual row count against estimate before proceeding. If >10× off, the downstream plan is likely wrong — a nested loop join chosen for an estimated 10-row inner might face 100,000 rows.

Options range from lightweight to ambitious:
- **Lightweight**: Record the misestimate for Tier 2 feedback, but finish current execution with the existing plan
- **Medium**: At certain checkpoints (e.g., between pipeline stages), swap in a different physical operator (e.g., switch from nested loop to hash join)
- **Ambitious**: Pause execution, re-plan the remaining subtree with actual cardinality data, resume

The streaming async architecture (AsyncIterable cursors) makes the medium option feasible — the consumer hasn't committed to anything about the producer's implementation. But this tier is architecturally harder and should wait until Tiers 0-2 prove their value.

## Architecture

### Stats Hierarchy

```
RuntimeStatsOverlay  →  CatalogStatsProvider  →  NaiveStatsProvider
  (from execution)       (from ANALYZE/vtab)      (heuristic defaults)
```

The runtime overlay is an in-memory cache of per-table, per-predicate selectivity observations collected during execution. No persistence needed — it rebuilds naturally from query execution within a session. Module-supplied stats (e.g., MemoryTable's exact BTree metadata) are preferred over runtime observations when available.

The overlay stores:
- Per-table actual row counts (observed at scan output)
- Per-predicate selectivity (filter input/output ratio)
- Per-join output cardinality (join output count / cross-product estimate)

### Query Fingerprint Registry

A Database-level registry that tracks query patterns across Statement instances:

```
Key:   AST structural fingerprint (hash ignoring literal values / parameter bindings)
Value: { executionCount, cumulativeTimeMs, lastEstimatedRows, lastActualRows, currentTier }
```

This drives tier selection:
- First execution of a pattern → Tier 0 (or Tier 1 if vtab stats are cached)
- After N executions or cumulative time threshold → invest in Tier 1 full optimization
- After Tier 1 execution shows >10× cardinality misestimate → Tier 2 feedback + re-optimize

The existing `expression-fingerprint.ts` (used for scalar CSE) provides a foundation for structural hashing of plan/AST nodes.

The registry is bounded (LRU eviction) — embedded processes may run many unique queries and shouldn't accumulate unbounded state.

### Runtime Cardinality Monitors

Instrumentation in the emit layer at **existing** pipeline breakers — no new materialization points:

| Instrumentation Point | Why It's Free | What It Measures |
|---|---|---|
| Sort input | Already materializes all rows | Actual input cardinality |
| Hash join build side | Already materializes into hash table | Build-side cardinality |
| Hash aggregate | Already hashes every input row | Input cardinality, group count |
| Filter output | One counter increment per passing row | Actual selectivity |
| Scan output | One counter increment per yielded row | Table cardinality |

Each counter is a single integer increment per row at a point that already processes every row. Overhead is negligible.

After execution completes (in the `finally` block of `Statement._iterateRowsRawInternal`), counters are compared against plan estimates. Significant divergences update the runtime stats overlay and mark the plan for re-optimization.

### Plan Invalidation

The existing `DependencyTracker` handles **hard invalidation** from schema changes (DDL). The adaptive layer adds **soft invalidation**:

- When the runtime stats overlay is updated for a table, plans depending on that table are marked `needsCompile = true` with a hint to re-optimize rather than rebuild from scratch
- Soft-invalidated plans skip structural passes (predicate pushdown, projection pruning — these are correct regardless of cardinality) and re-run only physical selection with updated stats
- A cooling period prevents plan thrashing — don't re-optimize more than once per N executions of the same fingerprint

### Tier Selection Logic

```
compile(fingerprint):
  entry = registry.getOrCreate(fingerprint)

  if entry.executionCount == 0:
    if vtabStatsAvailable(plan.tables):
      return optimizeFull(plan)        // Tier 1: vtab stats are free, use them
    else:
      return optimizeHeuristic(plan)   // Tier 0: no stats, fast heuristics

  if entry.needsReoptimization:
    return reoptimizePhysical(plan, runtimeOverlay)  // Tier 2: feedback-refined

  if entry.executionCount > TIER1_THRESHOLD && entry.currentTier == 0:
    return optimizeFull(plan)          // Promote to Tier 1 on frequency

  return cachedPlan                    // Reuse existing plan
```

Key detail: vtab-supplied stats (like MemoryTable's exact BTree metadata) are essentially free — no network I/O, no additional queries. When a vtab module provides `getStatistics()`, the system can skip straight to Tier 1 even on first execution. This is important because MemoryTable (local) vs DHT-backed tables have very different stat-collection costs, and the tier system should respect that.

## Interaction with Existing Optimizer

The current multi-pass pipeline (constant folding → structural → physical → post-opt → validation) remains intact — it IS the Tier 1 path. What changes:

1. **Before optimizer**: Tier selection based on fingerprint registry and stats availability
2. **During execution**: Lightweight counters in emit layer at pipeline breakers
3. **After execution**: Feedback collection, stats overlay update, soft invalidation
4. **Optimization entry point**: New "heuristic-only" mode that runs the always-beneficial rule subset (Tier 0), and a "physical-only re-optimize" mode that re-runs physical selection with updated stats (Tier 2)

The PassManager already supports selective pass execution — Tier 0 would run only passes 0-1 (constant folding + structural) plus a stripped-down pass 2 with heuristic-only physical selection. Tier 2 re-optimization would run only pass 2 (physical selection) with the updated stats context.

## Relationship to Other Planned Work

| Ticket | Relationship |
|---|---|
| **Expression properties** (expression-properties-injective-monotone) | Improves Tier 1 plan quality. Better key propagation → better cardinality estimates → less need for Tier 2 correction. |
| **Sargable range rewrites** (optimizations-key-preserving-and-sargable-range-rewrites) | Turns non-indexable predicates into indexable ones. Huge for Tier 0 — the heuristic "use index on equality match" fires more often after range rewrites expose index opportunities. |
| **Covering indexes** (covering-indexes) | Improves physical operator quality. Could benefit from runtime feedback — if an index-only scan is available but the cost model doesn't pick it, runtime counters showing fetch overhead would trigger re-plan. |
| **OR-to-UNION rewriting** (or-to-union-rewriting) | Classic case where stats matter: is N index seeks + dedup cheaper than one scan? Runtime feedback is ideal — try the scan first, measure actual cost, switch to UNION strategy if it was slow. |
| **Materialized views** (materialized-views) | Adaptive refresh scheduling: track query patterns, refresh when a view is both stale and frequently queried. |
| **Aggregate pushdown** (aggregate-pushdown) | Tier 1 rule. Benefits from cardinality feedback — pushing aggregation below a join is only beneficial if the join doesn't reduce cardinality much. |
| **Performance & scalability** (performance-scalability) | Runtime cardinality monitors feed into memory pool sizing, cache threshold decisions, and parallel execution strategies. |

## Implementation Ordering

Ordered by leverage — each step is independently valuable and doesn't require subsequent steps:

### Phase 1: Instrumentation Foundation
- [ ] Runtime cardinality counters in emit layer (sort, hash join build, hash aggregate, filter, scan)
- [ ] Counter collection after execution in `Statement._iterateRowsRawInternal` finally block
- [ ] Per-execution metrics stored on RuntimeContext or returned alongside results
- [ ] Wire into existing `runtime_metrics` option so counters only run when opted in (or always-on if overhead proves negligible)

### Phase 2: Feedback Loop
- [ ] Query fingerprint registry at Database level (AST structural hash, bounded LRU)
- [ ] Runtime stats overlay (StatsProvider implementation wrapping CatalogStatsProvider)
- [ ] Overlay update from cardinality counter divergence (>10× threshold)
- [ ] Soft plan invalidation on overlay update (extend DependencyTracker or parallel mechanism)
- [ ] Cooling period to prevent plan thrashing

### Phase 3: Tiered Optimization
- [ ] Tier 0 heuristic fast-path: identify always-beneficial rule subset, create "heuristic-only" optimization mode in PassManager
- [ ] Tier selection logic in Statement.compile() based on fingerprint registry
- [ ] Tier 2 physical-only re-optimization mode: re-run physical selection pass with runtime overlay stats
- [ ] vtab stats availability check to allow Tier 1 on first execution when stats are free

### Phase 4: Monitoring & Diagnostics
- [ ] Extend OptimizerDiagnostics with tier selection reasoning, cardinality accuracy, re-optimization counts
- [ ] Expose via query_plan() or similar introspection
- [ ] Benchmark: measure overhead of cardinality counters on hot paths (goal: <1% on throughput benchmarks)
- [ ] Benchmark: measure plan quality improvement from feedback loop (e.g., join order correction after first execution)

### Phase 5: Mid-Execution Adaptation (Tier 3, longer term)
- [ ] Checkpoint mechanism at pipeline breakers: compare actual vs estimated before proceeding
- [ ] Operator substitution at checkpoints (e.g., nested loop → hash join)
- [ ] Partial re-planning of remaining subtree with actual cardinality
- [ ] Evaluate feasibility within async streaming architecture (AsyncIterable cursor replacement)

## Key Design Constraints

**Embedded, not server**: No background optimizer thread. No long-lived process accumulating statistics across restarts. The fingerprint registry and runtime overlay are session-scoped in-memory structures that rebuild from execution.

**Distributed storage**: Every I/O operation may traverse the DHT. Stats collection via full table scans is prohibitively expensive. The system must rely on what it can learn from essential query execution, not dedicated stats-collection queries.

**Streaming-first**: The async iterable pipeline means no up-front materialization. Runtime monitors must not add pipeline breakers. Counters piggyback on operations that already touch every row.

**vtab module heterogeneity**: Some modules (MemoryTable) can provide exact stats for free from BTree metadata. Others (DHT-backed, federated) cannot. The tier system must respect this — cheap stats skip to Tier 1, expensive stats stay at Tier 0 until execution feedback provides data.
