# Progressive Query Optimization

This document describes the progressive, JIT-inspired query optimization strategy used by Quereus. It assumes familiarity with `docs/optimizer.md` (pass framework, rule system, cost model) and `docs/runtime.md` (instruction emission, scheduler, streaming execution).

The progressive optimizer addresses a fundamental tension: **time spent optimizing vs. time saved executing**, in an environment where statistics collection is itself expensive. Quereus targets distributed deployments where BTree nodes are stored across a DHT — every I/O operation may traverse the network, making full-table scans for statistics collection prohibitively costly. The optimizer must produce good plans with zero pre-collected statistics, then improve plans cheaply using feedback from essential query execution.

---

## 1. Design Principles

| Principle | Implication |
|---|---|
| **Stats are hints, not prerequisites** | Missing statistics produce graceful degradation to heuristics, not bad plans. |
| **Never block on optimization** | Every query has a runnable plan immediately. Optimization improves it, never gates it. |
| **Robust worst-case** | Heuristic defaults avoid catastrophic plans (O(n*m) joins, full scans on PK lookups) without any data. |
| **Cheap instrumentation** | Runtime monitoring piggybacks on existing pipeline breakers. No new materialization points for observation. |
| **Monotonic improvement** | Plan quality only improves over a query's lifetime. Cooling periods prevent thrashing. |
| **Streaming-first** | Consistent with the core architecture: favor pipeline-able operators, detect problems early, replace plans between executions without wasting materialized data. |

---

## 2. Optimization Tiers

The optimizer assigns each query execution an optimization tier based on available information and execution history. Tiers are not mutually exclusive — a query progresses through tiers as information accumulates.

### Tier 0: Heuristic Plan

The baseline tier. No cost model evaluation, no statistics lookup. Applies only transformations that are correct and beneficial regardless of data distribution:

- **Predicate pushdown** — always reduces work
- **Index seek on equality match** — when an equality predicate matches an available index, prefer the seek. Avoids the worst-case scan-when-PK-lookup-exists
- **Hash join over nested loop** for non-trivial inputs — O(n+m) vs O(n*m) worst case
- **Projection pruning** — reduces intermediate row width
- **Subquery decorrelation** — eliminates N+1 execution patterns
- **Filter merge** — consolidates adjacent filters
- **Distinct elimination** — removes DISTINCT when source is already unique

These transformations define the **worst-case floor**. The plan is not optimal, but it avoids catastrophic choices. Tier 0 is the appropriate level for DDL statements, simple lookups, ad-hoc queries, and the first execution of any query pattern where no statistics are cached.

Implementation: the PassManager runs passes 0–1 (constant folding, structural transformations) plus a restricted pass 2 that applies heuristic-only physical selection — index seek for matched equality, hash join for multi-row joins, stream aggregate when input is ordered, hash aggregate otherwise.

### Tier 1: Cost-Based Plan

The full multi-pass optimization pipeline, corresponding to the current optimizer described in `docs/optimizer.md`. This tier runs when cached statistics are available — either from vtab-supplied metadata or from the runtime stats overlay. Every pass executes: constant folding, structural transformations, physical selection, post-optimization, the materialization advisory, final estimates, and validation.

Key constraint: Tier 1 **never blocks waiting for statistics**. It uses whatever is cached at the time of optimization. When stats are missing for a particular table or predicate, the cost model falls back to heuristic defaults for that specific decision, while using available stats everywhere else. This produces a plan that is partially cost-optimized and partially heuristic — strictly better than Tier 0.

Tier selection favors Tier 1 when statistics are already cached at no I/O cost. The tier system respects the cost of stat collection: free stats trigger Tier 1; expensive stats stay at Tier 0 until execution feedback accumulates.

What a module supplies today is narrower than "statistics". `getStatistics()` reports a table's **size**, and both shipped backends report only that: `MemoryTable` reads the primary BTree's node count, `StoreTable` reads its delta-tracked running count. Per-column distinct counts, null counts, min/max and histograms come from `ANALYZE`'s scan, and reach the planner through `TableSchema.statistics` — not from the module. (`MemoryTable` did once derive per-column figures from a sample of up to 1000 values, which made them wrong on any larger table; see `bug-analyze-stats-wrong-past-1000-rows`.) A module that wants a live size in a cost decision between `ANALYZE`s fills in `request.estimatedRows` from `getBestAccessPlan` instead.

### Tier 2: Feedback-Refined Plan

After query execution, runtime cardinality monitors compare actual row counts against plan estimates. When actual counts diverge significantly from estimates (threshold: >10x), the runtime stats overlay is updated and the plan is marked for re-optimization on next use.

Re-optimization is selective: structural passes (predicate pushdown, projection pruning, subquery decorrelation) are skipped because they are correct regardless of cardinality. Only pass 2 (physical selection) re-runs with the updated stats context. This is cheaper than full optimization and targets exactly the decisions that depend on cardinality — access path choice, join strategy, aggregate strategy.

The result is that a query pattern improves automatically across executions. The first execution uses Tier 0/1 estimates. If those prove wrong, the second execution uses actual observed cardinalities. No manual intervention, no ANALYZE, no dedicated stats-collection queries.

### Tier 3: Mid-Execution Adaptation

At pipeline breakers — sort, hash join build, hash aggregate — the actual input row count is known before downstream processing begins. When it diverges >10x from the estimate, the downstream plan is likely suboptimal (e.g., a nested loop chosen for an estimated 10-row inner may face 100,000 rows).

Options, in order of complexity:

1. **Record and continue**: Note the misestimate for Tier 2 feedback. Finish current execution with the existing plan. Cheapest to implement; relies on next-execution correction.
2. **Operator swap**: At the checkpoint, substitute a different physical operator (e.g., switch from nested loop to hash join for the remaining subtree). Feasible because the streaming architecture (`AsyncIterable` cursors) means consumers are decoupled from producer implementation.
3. **Partial re-plan**: Pause, re-plan the remaining subtree with actual cardinality from the checkpoint, resume. Most effective but architecturally complex.

---

## 3. Stats Hierarchy

Statistics flow through a three-layer provider chain:

```
RuntimeStatsOverlay  →  CatalogStatsProvider  →  NaiveStatsProvider
  (execution feedback)    (ANALYZE / vtab)        (heuristic defaults)
```

Each layer implements the `StatsProvider` interface (`src/planner/stats/index.ts`). Queries cascade: if the overlay has an observation for a table/predicate, it is used. Otherwise the catalog provider checks `TableSchema.statistics` (populated by ANALYZE or vtab `getStatistics()`). If nothing is available, naive heuristics apply.

### Runtime Stats Overlay

An in-memory, session-scoped cache of per-table and per-predicate observations collected during execution:

| Observation | Source | Granularity |
|---|---|---|
| Table row count | Scan output counter | Per table |
| Predicate selectivity | Filter input/output ratio | Per table + predicate fingerprint |
| Join output cardinality | Join output counter | Per join + condition fingerprint |

The overlay requires no persistence — it rebuilds naturally from query execution within a session. It is bounded (LRU eviction per table) to prevent unbounded memory growth in embedded environments with many unique queries.

The overlay supplements but does not replace catalog stats. Exact numbers are preferred where they exist — the statistics `ANALYZE` recorded on `TableSchema.statistics`, or a live row count a module reports through `getBestAccessPlan`. The overlay is most valuable for tables where statistics collection is expensive (DHT-backed storage, federated tables) and the only affordable source of cardinality information is the execution itself.

---

## 4. Query Fingerprint Registry

The fingerprint registry is a Database-level structure that tracks query patterns across `Statement` instances. It enables cross-execution learning — two different `Statement` objects executing the same query shape with different parameter values share execution feedback and tier decisions.

```ts
interface FingerprintEntry {
  fingerprint: string;           // AST structural hash (ignoring literals/parameter values)
  executionCount: number;
  cumulativeTimeMs: number;
  lastEstimatedRows: number;     // from plan's PhysicalProperties.estimatedRows
  lastActualRows: number;        // from runtime cardinality counter
  currentTier: 0 | 1 | 2;
  needsReoptimization: boolean;
  lastOptimizedAt: number;       // execution count at last optimization (cooling)
}
```

The fingerprint is a structural hash of the AST that normalizes away literal values and parameter bindings. The existing `expression-fingerprint.ts` module provides the foundation for structural hashing of plan and AST nodes.

### Tier Selection

```
on compile(query):
  entry = registry.getOrCreate(fingerprint(query.ast))

  if entry has cached plan and not entry.needsReoptimization:
    return cached plan

  if entry.needsReoptimization:
    return reoptimizePhysical(entry.cachedPlan, runtimeOverlay)    // Tier 2

  if vtabStatsAvailable(query.tables):
    return optimizeFull(query)                                      // Tier 1

  if entry.executionCount > PROMOTION_THRESHOLD:
    return optimizeFull(query)                                      // promote to Tier 1

  return optimizeHeuristic(query)                                   // Tier 0
```

The registry is bounded by LRU eviction. Embedded processes may execute many unique ad-hoc queries; unbounded accumulation is not acceptable.

### Cooling

After re-optimization, a cooling period prevents thrashing. The plan is not re-evaluated for at least N additional executions of the same fingerprint, even if new feedback arrives. This ensures plan stability while still converging on good plans over time.

---

## 5. Runtime Cardinality Monitors

Lightweight counters are embedded in the emit layer at existing pipeline breakers — points where the operator already touches every row:

| Operator | Why it's free | What it measures |
|---|---|---|
| Sort | Already materializes all input rows | Input cardinality |
| Hash join (build side) | Already materializes into hash table | Build-side cardinality |
| Hash aggregate | Already hashes every input row | Input cardinality, output group count |
| Filter | One counter increment per passing row | Actual selectivity (output / input) |
| Scan (seq/index) | One counter increment per yielded row | Table cardinality for this access path |

Each counter is a single integer increment per row, piggy-backed on an operation that already processes that row. The overhead is negligible — a benchmark target of <1% throughput impact.

Counters are collected after execution completes, in the `finally` block of `Statement._iterateRowsRawInternal`. If the query's fingerprint entry shows the counters diverge >10x from estimates, the runtime stats overlay is updated and `needsReoptimization` is set on the fingerprint entry.

Counters integrate with the existing `runtime_metrics` option. When metrics are enabled, the counters are always active. When disabled, counter overhead is zero — the instrumented code paths are not compiled into the instruction tree.

---

## 6. Plan Invalidation

Plan invalidation is layered:

### Hard Invalidation (schema changes)

The existing `DependencyTracker` in `EmissionContext` records schema dependencies during plan emission — tables, functions, vtab modules, collations. Schema change events (DDL) trigger `needsCompile = true` on affected `Statement` instances, forcing full re-planning from the AST. This mechanism is unchanged.

### Soft Invalidation (stats feedback)

When the runtime stats overlay is updated for a table, plans depending on that table are soft-invalidated. Soft invalidation sets `needsReoptimization` on the fingerprint entry rather than `needsCompile` on individual statements. The next execution of any statement matching that fingerprint re-runs physical selection with updated stats, skipping structural passes.

Soft invalidation is conservative: it only triggers when runtime counters show >10x divergence from estimates, ensuring that minor cardinality variations (well within the noise of heuristic planning) do not cause unnecessary re-optimization.

---

## 7. Integration with the Pass Framework

The progressive optimizer extends the existing multi-pass framework rather than replacing it.

### Heuristic-Only Mode (Tier 0)

A restricted optimization mode that runs:
- **Pass 0**: Constant folding (always beneficial, no stats dependency)
- **Pass 1**: Structural transformations (predicate pushdown, projection pruning, scalar CSE, subquery decorrelation — all correct regardless of cardinality)
- **Pass 2 (restricted)**: Heuristic physical selection only — no cost comparisons, just safe defaults (index seek on equality, hash join for multi-row, hash aggregate for unsorted input)
- **Pass 4**: Validation

Pass 3 (post-optimization: materialization advisory, CTE caching) is skipped — these decisions benefit from cardinality estimates and are not always-beneficial heuristics.

### Physical Re-optimization Mode (Tier 2)

Starts from the existing optimized plan and re-runs only:
- **Pass 2**: Physical selection with the updated stats context (runtime overlay)
- **Pass 3**: Post-optimization (materialization thresholds may change with new cardinality data)
- **Pass 4**: Validation

Structural passes are skipped because predicate pushdown, projection pruning, and CSE are cardinality-independent.

### vtab Stats Availability

**Not yet implemented.** Nothing consults `getStatistics()` during planning today — `ANALYZE` (`runtime/emit/analyze.ts`) is its only caller in the engine, and tier selection does not ask modules what they could answer cheaply. The design below is the intended shape, recorded here so the hook's cost semantics are not lost.

Tier selection should query each table's vtab module for stats availability before choosing a tier. A module that can size itself with no I/O (`MemoryTable` reading its BTree node count, `StoreTable` reading its running count) would allow Tier 1 on first execution; a module that would need I/O (DHT-backed, federated) would not, keeping first execution at Tier 0.

This distinction matters: a query joining a local `MemoryTable` with a DHT-backed table would use Tier 1 stats for the local table and Tier 0 heuristics for the remote table — the best available information for each source without unnecessary I/O.

---

## 8. Key Files

| File | Role |
|---|---|
| `src/planner/framework/pass.ts` | Pass manager, traversal, rule dispatch |
| `src/planner/framework/context.ts` | `OptContext` — carries stats, tuning, visited tracking |
| `src/planner/cost/index.ts` | Cost model functions |
| `src/planner/stats/index.ts` | `StatsProvider` interface |
| `src/planner/stats/catalog-stats.ts` | Catalog stats, histogram support, FK inference |
| `src/planner/analysis/expression-fingerprint.ts` | Structural hashing for CSE (foundation for query fingerprinting) |
| `src/runtime/emission-context.ts` | `EmissionContext`, `DependencyTracker` for plan invalidation |
| `src/runtime/emitters.ts` | Instruction emission dispatch (instrumentation integration point) |
| `src/core/statement.ts` | `Statement` — plan lifecycle, compile, execute, invalidation |
| `src/planner/optimizer.ts` | Optimizer entry point, rule registration |
| `src/planner/optimizer-tuning.ts` | Tuning knobs (depth limits, disabled rules, tour counts) |

## Design decisions

  ---                                                                                                                                                                                                                                                                         
  Decision 1: Query Fingerprinting — What to Hash                                                                                                                                                                                                                             
                                                                                                                                                                                                                                                                              
  The fingerprint determines which executions share feedback. Too narrow and we never learn; too broad and we apply wrong feedback.                                                                                                                                           
                                                                                                                                                                                                                                                                              
  Option A: Fingerprint the AST (post-parse, pre-build)           

  Hash the parsed AST structure, normalizing literals and parameter values to placeholders.

  Pros:
  - Cheapest possible — happens before any planning or optimization work
  - Catches the dominant case: same prepared statement re-executed, or same query text with different parameter values
  - AST is a stable, well-defined structure (SelectStmt with from, where, columns, etc.)
  - Naturally groups parameterized queries — select * from t where id = 1 and select * from t where id = 2 share a fingerprint
  - Simple to implement: recursive visitor over the ~20 AST Statement types, emitting structural tokens, replacing literal values with a placeholder

  Cons:
  - Syntactically different queries that produce identical plans don't share feedback. E.g. select a, b from t vs select b, a from t — different fingerprint, same plan
  - Alias differences (select x as foo vs select x as bar) change the fingerprint unless normalized
  - Whitespace/formatting is already handled (the parser normalizes), but clause ordering in some positions (e.g., JOIN order in FROM) could vary
  - If the plan builder makes structural choices (e.g., view expansion, CTE inlining), the AST doesn't reflect what the optimizer actually sees

  Key tradeoff: Cheapness vs. sharing breadth. The missed-sharing cases (column reorder, alias differences) are uncommon in practice — most real workloads run the same SQL text repeatedly with different parameters.

  Option B: Fingerprint the built plan (post-build, pre-optimize)

  Hash the logical PlanNode tree after the builder runs but before the optimizer transforms it.

  Pros:
  - Captures structural equivalence — view expansion, CTE inlining, and builder normalization are already done
  - Two queries that parse differently but build to the same logical plan share feedback
  - The plan node tree has stable attribute IDs and node types — the fingerprintExpression pattern extends naturally

  Cons:
  - Building is non-trivial work (schema lookups, scope resolution, type inference). We do all of it before checking the cache, defeating the "quick startup" goal
  - The plan tree is richer (60+ node types vs ~20 AST types) — more surface area for the fingerprint function
  - Attribute IDs are assigned fresh per build, so they'd need normalization (positional rather than by ID)
  - Subquery plan nodes already bail to unique IDs in the current fingerprint code (_SQ:${node.id}), so complex queries would get unique fingerprints anyway

  Key tradeoff: Better sharing at the cost of doing the full build before any cache benefit. In the DHT scenario where the build itself may trigger schema lookups, this is a real cost.

  Option C: Fingerprint the SQL text with literal normalization

  Regex or lexer-level replacement of literals with ? placeholders, then hash the normalized text.

  Pros:
  - Absolute cheapest — no parse, no build, just a string operation
  - How PostgreSQL's pg_stat_statements works (proven approach)
  - Trivially cacheable — string hash is O(n) in query length

  Cons:
  - Brittle to formatting: SELECT vs select, extra whitespace, parenthesization differences
  - Doesn't normalize aliases, column order, or semantically equivalent rewrites
  - Requires a lexer-level pass to correctly identify literals vs. identifiers vs. keywords (can't just regex — string literals contain arbitrary text)
  - We already have a parser, so "avoid parsing" is less of a win than in systems where parsing is expensive

  Key tradeoff: Maximum cheapness at the cost of correctness edge cases. Would need a dedicated SQL normalizer/lexer, which is essentially a partial parser.

  My read

  Option A is the sweet spot. The parser already runs before anything else (it's in the Statement constructor). AST fingerprinting adds negligible cost on top of parsing, catches the 95% case (repeated parameterized queries), and avoids the build-before-cache problem of
   Option B. Option C's brittleness isn't worth the marginal speed gain over A.

  The remaining question within Option A: normalize at the AST level or at the toString() level? The AST has a toString() method on each statement. Normalizing literals in the string representation is simpler than a full AST visitor, but misses structural normalization
  (alias differences, etc.). A proper AST visitor is more work but more correct. Given that the primary use case is repeated parameterized queries (where the SQL text is identical except for bound parameter values, which are already ? placeholders), even a simple
  approach works.

  ---
  Decision 2: Counter → Stats Overlay Mapping

  Runtime counters on Instructions measure "N rows flowed here." The StatsProvider interface needs "table X has Y rows" and "predicate P on table X has selectivity S." Bridging this gap requires plan provenance metadata.

  Option A: Attach plan metadata at emit time

  Each emitter already receives the PlanNode. Attach a metadata object to the Instruction during emission: table name, predicate fingerprint, estimated rows. After execution, read back the metadata alongside the actual counter.

  Pros:
  - Clean separation — emitters stamp metadata, the feedback collector reads it
  - The PlanNode is available at emit time, so all information (table schema, predicate nodes, estimates) is accessible
  - No changes to the runtime hot path — metadata is set once at emit time, read once after execution

  Cons:
  - Requires extending the Instruction type with an optional metadata field (small API change)
  - Each emitter that participates in feedback needs to populate the metadata — some implementation effort across ~6 emitters (scan, filter, sort, hash-aggregate, bloom-join, merge-join)
  - The metadata needs to be specific enough for the overlay to key on (table name + predicate fingerprint), which ties the feedback format to the StatsProvider interface

  Key tradeoff: Clean architecture at the cost of touching each participating emitter. The touch is small (3-5 lines per emitter to attach metadata).

  Option B: Walk the plan tree post-execution, match nodes to counters

  After execution, walk the original PlanNode tree alongside the Instruction tree, correlating plan nodes with their instruction counters.

  Pros:
  - No changes to the Instruction type or individual emitters
  - Plan metadata is read from the original plan tree, which is already retained on the Statement

  Cons:
  - The plan tree and instruction tree don't have a guaranteed 1:1 structural correspondence — emitters can flatten, combine, or split nodes. The emitPlanNode dispatch is not a simple isomorphic mapping
  - Fragile: any change to how emitters produce instructions could break the correlation
  - Requires the plan tree to be retained until after execution completes (it currently is, on Statement.plan, but this becomes a harder requirement)

  Key tradeoff: Avoids emit-time changes but introduces a fragile coupling between plan structure and instruction structure.

  Option C: Dedicated feedback channel, separate from Instructions

  Create a FeedbackCollector object that emitters register against directly. During emission, the emitter registers a callback: "when this instruction finishes, report actual rows for table X / predicate P." The collector is passed through EmissionContext.

  Pros:
  - Fully decoupled from Instruction internals — doesn't pollute the runtime type
  - Emitters opt in explicitly — clear which operators participate
  - The collector can aggregate and deduplicate (e.g., two filters on the same table)

  Cons:
  - More moving parts — new type, new lifecycle management, new threading through EmissionContext
  - Callbacks from execution back to the collector need a rendezvous point (after execution completes)
  - Over-engineering risk for what is fundamentally "store a few numbers on a few instructions"

  Key tradeoff: Cleaner separation at the cost of more infrastructure. Likely premature for Phase 1.

  My read

  Option A is the pragmatic choice. The Instruction type already has optional fields (note, runtimeStats, emissionContext). One more optional field for plan provenance metadata is consistent with the existing pattern. The per-emitter work is small and explicit. Option C
   is cleaner in theory but adds machinery that isn't justified until we learn more about what feedback we actually need.

  ---
  Decision 3: Tier 0 Physical Selection — Separate Path vs. Existing Optimizer

  Option A: NaiveStatsProvider IS Tier 0

  Run the existing full optimizer with NaiveStatsProvider as the stats source. No new code path — the "tier" distinction is just which StatsProvider is passed to the OptContext.

  Pros:
  - Zero new optimizer code — the distinction is purely in stats input
  - All existing rules, passes, and cost comparisons still run — battle-tested path
  - NaiveStatsProvider already exists with reasonable defaults (1000 rows, 0.3 selectivity, 0.1 for equality)
  - The cost model with heuristic inputs already produces reasonable plans — hash join is cheaper than nested loop at 1000×1000, index seek is cheaper than seq scan at 0.1 selectivity
  - Tier promotion from 0→1 is just swapping the stats provider, not changing the code path

  Cons:
  - NaiveStatsProvider's defaults may not produce the "robust worst-case" behavior in all scenarios. Example: defaultSelectivity: 0.3 combined with a 1000-row default means an equality predicate estimates 300 rows — might not trigger index seek if the cost model sees it
   as marginal
  - The full optimizer runs every pass, including QuickPick join enumeration, CSE, CTE optimization — overkill for a "quick startup" tier
  - The cost model can make actively bad choices with heuristic inputs. NaiveStatsProvider treats all BinaryOps as 0.1 selectivity regardless of operator — a > comparison gets the same selectivity as =
  - "Tier 0 = existing optimizer with worse stats" means Tier 0 is not actually faster than Tier 1 — just less accurate. The "quick startup" goal isn't served

  Key tradeoff: Simplicity (no new code) vs. the stated goals of quick startup and robust worst-case. If the optimizer is already fast enough that "quick startup" doesn't matter, this is fine. If optimization time is measurable (complex queries with many joins), this
  doesn't help.

  Option B: Restricted pass set for Tier 0

  Run only passes 0-1 (constant folding, structural) plus a restricted pass 2 that skips cost comparisons. Physical selection uses hardcoded heuristics: index seek for equality, hash join for all equi-joins, hash aggregate for unsorted input, stream aggregate for sorted
   input.

  Pros:
  - Actually faster — skips QuickPick, CTE optimization, materialization advisory, CSE
  - Produces predictable worst-case plans — the heuristics never choose nested loop for large inputs, never choose seq scan when an index is available
  - Clear semantic separation: Tier 0 is "always right" heuristics, Tier 1 is "usually better" cost-based
  - PassManager already supports running subsets of passes (needs executeOnly or equivalent, but architecturally trivial)

  Cons:
  - New code: heuristic physical selection rules (or a heuristic mode flag on existing rules)
  - The existing rules mix heuristic fallbacks with cost comparisons internally — ruleSelectAccessPath already falls back to heuristics when stats are missing. Extracting the heuristic path as a standalone mode may require refactoring
  - Two code paths means two sets of behavior to test and maintain
  - Risk of the heuristic path producing plans that are strictly worse than the cost-based path with NaiveStatsProvider — the "always right" claim needs validation

  Key tradeoff: Genuine quick startup and predictable worst-case at the cost of a second physical selection path. The maintenance burden depends on how cleanly the heuristic subset can be extracted from existing rules.

  Option C: Tier 0 = skip physical selection entirely, emit from logical nodes

  Use the logical plan directly, with the emit layer handling the mapping to physical operators at runtime.

  Pros:
  - Absolute fastest planning — no physical selection at all
  - Forces a clean separation between logical and physical layers

  Cons:
  - The emit layer currently expects physical nodes (IndexSeekNode, BloomJoinNode, HashAggregateNode). Emitting from logical nodes would require a parallel set of emitters or a fallback dispatch
  - Massive architectural change — the entire pipeline assumes physical nodes by emit time
  - The "single hierarchy, dual phase" design (logical and physical in the same tree) makes this particularly awkward

  Key tradeoff: Not viable without a major architecture change. Ruling this out.

  My read

  The answer depends on whether optimization time is actually a problem. If Statement.compile() is sub-millisecond for typical queries (which it likely is for <5 tables), then Option A is fine — Tier 0 and Tier 1 are the same speed, the distinction is only about stats
  quality. The "quick startup" goal is served by "don't block on stats collection," not by "optimize faster."

  If optimization time IS measurable (complex queries, many-way joins where QuickPick runs multiple tours), Option B is worth it, but the implementation should be "skip expensive passes" (disable QuickPick, skip CTE optimization, skip materialization advisory) rather
  than "rewrite physical selection." This is achievable via OptimizerTuning — set quickpick.enabled = false, disable specific rules, without a fundamentally new code path.

  So the real Tier 0 might be: existing optimizer with NaiveStatsProvider AND a restricted tuning profile (no QuickPick, no materialization advisory). This is a hybrid of A and B that requires no new code — just a second tuning preset.

  ---
  Decision 4: Statement ↔ Fingerprint Registry Interaction

  Option A: Registry holds metadata only, plan stays on Statement

  The registry stores execution counts, actual cardinalities, tier, and cooling state. Each Statement still owns its own compiled plan. On compile(), the Statement consults the registry for tier selection and feeds runtime overlay data into the optimizer.

  Pros:
  - Minimal coupling — registry is a passive data store, Statement is the active planner
  - No cross-Statement plan sharing (which would require complex lifecycle management — what happens when one Statement is finalized but another shares its plan?)
  - Soft invalidation is simple: set a flag on the registry entry, each Statement checks on next compile()
  - Schema-change hard invalidation stays on Statement (existing mechanism unchanged)

  Cons:
  - Two Statements running the same query shape each compile independently — duplicate optimization work
  - The registry doesn't directly benefit first execution of a query (no cached plan to reuse)
  - "Consults the registry" means the Statement needs access to both the registry and the runtime overlay, adding parameters to the compile path

  Key tradeoff: Simplicity and safety at the cost of not sharing compiled plans across Statements. In the embedded scenario, how common is it to have multiple live Statements for the same query? If the pattern is prepare-once-execute-many (single Statement reused), this
   is a non-issue.

  Option B: Registry holds compiled plans, Statements share them

  The registry caches optimized plans keyed by fingerprint. On compile(), a Statement checks the registry for a cached plan. If found, it reuses it (with validation that schema hasn't changed).

  Pros:
  - Second Statement with the same query shape gets a free compiled plan
  - Optimization work is truly amortized across all users of a query shape

  Cons:
  - Plan lifecycle is now shared — who owns the plan? When does it get GC'd? What if one Statement is finalized but the plan is still in the registry?
  - Plans capture schema snapshots via EmissionContext. A shared plan's snapshot may not match a later Statement's expectations if schema changed between the two
  - The existing schema-change invalidation is per-Statement (event listener sets needsCompile). Shared plans need a different invalidation path — invalidate the registry entry, which then cascades
  - Plans are emitted into Instructions with schema captures (table refs, function refs). Sharing plans means sharing these captures. If the captures reference connection-specific state (vtab instances), sharing breaks
  - Thread safety: if two Statements compile concurrently for the same fingerprint, who wins the race?

  Key tradeoff: Amortized compilation at the cost of significant lifecycle complexity. The shared-state concerns (schema captures, vtab instances, invalidation cascading) are substantial.

  Option C: Registry holds structural plans, physical selection per-Statement

  The registry caches the post-structural-pass plan (after passes 0-1 but before physical selection). Each Statement retrieves this intermediate plan and runs physical selection locally with its own stats context.

  Pros:
  - Structural passes (the deterministic part) are shared — predicate pushdown, CSE, etc. are done once
  - Physical selection (the stats-dependent part) is per-Statement, avoiding the shared-capture problems
  - Soft invalidation for stats changes is natural — re-run physical selection with new overlay
  - Hard invalidation for schema changes clears the registry entry (structural plan is invalid)

  Cons:
  - Requires the PassManager to produce and accept intermediate plans (pause after structural, resume at physical)
  - The intermediate plan format needs to be stable — structural passes must not leave the plan in a state that physical selection can't consume
  - More complex than Option A but less complex than Option B
  - The "skip structural passes" behavior of Tier 2 re-optimization naturally falls out of this design — but it needs the PassManager split that both options require

  Key tradeoff: The most architecturally elegant option, but requires PassManager support for partial execution and a well-defined intermediate plan contract.

  My read

  Option A for Phase 1. The prepare-once-execute-many pattern means cross-Statement plan sharing has low value. The registry's primary job is tracking execution metadata for tier selection and feedback — not caching plans. The Statement already caches its own plan and
  handles invalidation.

  Option C is the right long-term architecture (it cleanly separates the deterministic structural phase from the stats-dependent physical phase), and it falls naturally out of the PassManager selective execution work that Tier 2 already requires. But it doesn't need to
  be built for Phase 1.

  ---
  Decision 5: Counter → Overlay Granularity

  This one wasn't in my original list but emerged from thinking through Decision 2. The StatsProvider interface takes (TableSchema, predicate) as keys. The runtime overlay needs to store observations at a granularity that matches these keys. What granularity?

  Option A: Per-table row count only

  The overlay stores only table → observed row count. No predicate-level selectivity.

  Pros:
  - Simplest possible overlay. One number per table.
  - The most impactful single feedback signal — if the estimated table size is 1000 (naive default) but reality is 10M, the plan is likely wrong everywhere
  - Easy to collect: count at scan output
  - Easy to key: table name is unambiguous

  Cons:
  - Doesn't help with selectivity misestimates. A table with 10M rows and a predicate that filters to 5 rows — knowing the table size helps, but the selectivity (0.0000005) is what really matters for join order and access path selection
  - Doesn't help with join selectivity, which depends on correlation between tables

  Option B: Per-table row count + per-predicate selectivity

  The overlay stores table → row count and (table, predicate_fingerprint) → selectivity.

  Pros:
  - Captures the two most impactful feedback signals
  - Predicate selectivity directly drives access path selection (index seek vs. scan) and join order
  - Predicate fingerprinting already exists (fingerprintExpression)

  Cons:
  - Predicate fingerprints include literal values (by design — they're for CSE dedup). For the overlay, we'd need a normalized fingerprint that replaces literals with type placeholders (e.g., BO:=(CR:123,LI:?) instead of BO:=(CR:123,LI:42))
  - The selectivity observation is per-execution — one data point. It could be an outlier. Needs smoothing (running average, or exponential decay)
  - More keys in the overlay map, more memory, more LRU pressure

  Option C: Full per-operator cardinality

  Store actual row counts at every monitored operator (scan, filter, join, aggregate, sort), keyed by operator + plan position.

  Pros:
  - Maximum information for re-optimization — every cost estimate can be corrected
  - Enables Tier 3 (mid-execution adaptation) where individual operator estimates matter

  Cons:
  - The overlay becomes plan-specific, not table-specific. If the plan changes (different join order), the cached cardinalities don't apply
  - Keying by plan position is fragile — plan structure changes invalidate all cached data
  - Much more data to store and manage
  - Overkill for Phase 1

  My read

  Option A for Phase 1, Option B for Phase 2. Per-table row count is the single highest-leverage feedback signal, requires minimal infrastructure, and is unambiguous to key. Predicate selectivity is the next most valuable signal and can be added once the feedback
  pipeline is proven. Full per-operator cardinality is Tier 3 territory.
