# Optimizer Joins

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Join ordering, physical join algorithm selection, the fan-out lookup join, and the
keys a join propagates. The rule catalog entries these sections expand on live in
[Optimizer Rules](optimizer-rules.md); the runtime contracts for the physical nodes
live in [Runtime](runtime.md).

## Join Optimization with QuickPick

### Overview

Quereus uses the **QuickPick** algorithm (Neumann & Kemper, VLDB 2020) for join order optimization, implemented by `rule-quickpick-enumeration.ts`. This approach treats join ordering as a Traveling Salesman Problem (TSP) and uses random greedy tours to find near-optimal plans with minimal complexity. See [QuickPick Design](quickpick-design.md) for the enumeration internals.

### Why QuickPick?

**Simplicity**: ~200 lines of TypeScript vs thousands for traditional optimizers
- No complex memo structures or dynamic programming tables
- No equivalence classes or group management
- Just a tour generator and a running best plan

**Performance**: Achieves >95% of optimal plan quality with <1% of the time
- Scales linearly with number of joins × number of tours
- Naturally parallelizable (each tour is independent)
- Works well with approximate or missing statistics

**Perfect fit for Quereus**:
- Aligns with the project's lean, readable codebase philosophy
- Handles virtual tables with unknown cardinalities gracefully
- Integrates easily with async architecture
- Provides tunable quality/time tradeoff via `maxTours` parameter

### Algorithm Design

`ruleQuickPickJoinEnumeration` is an ordinary rule — `(node, context) => PlanNode | null`
— that fires on a `JoinNode`. It proceeds in four steps:

1. **Extract the join graph.** `extractJoinGraph` walks the contiguous inner-join region
   below the node, collecting leaf relations and the equi-predicates that connect pairs of
   them. It bails out (returns `null`, so the rule declines) on anything it cannot model,
   and the rule declines outright on fewer than three relations, where enumeration cannot
   beat the plan the builder already produced.
2. **Refuse on side effects.** If any participating relation's subtree carries a write
   (`PlanNodeCharacteristics.subtreeHasSideEffects`), the rule declines: reordering would
   change the user-visible order in which the writes run. See
   [Audit discipline](optimizer.md#audit-discipline-sideeffectmode).
3. **Run greedy tours.** Each tour picks a start relation, then repeatedly appends the
   remaining relation whose resulting left-deep plan costs least, penalizing a candidate
   with no predicate connecting it to the already-chosen set by 10× so cross products lose
   to any connected alternative. Tours run until `maxTours` or `timeLimitMs` is exhausted,
   varying only the start relation (alternating between the two smallest by
   `estimatedRows`). One greedy **bushy** plan — repeatedly merge the cheapest pair of
   components — is built per invocation and compared against the best tour.
4. **Adopt only on a real win.** The best plan replaces the original only if it costs less
   than 90% of the baseline; otherwise the rule declines. Either way, tour count and best
   cost land in `context.diagnostics.quickpick`.

Cost throughout is `PlanNode.getTotalCost()` on the candidate plan — the accumulated
subtree cost, which already reflects the `estimatedRows` reduction a key-covered join
earns from `computePhysical`.

### Integration Points

1. **Multi-pass optimizer framework**: QuickPick runs in the Physical pass (bottom-up)
2. **Cost model**: Uses `PlanNode.getTotalCost()` for join ordering decisions
3. **Rule registration**: Registered as a Physical pass rule,
   `sideEffectMode: 'aware'`
4. **Tuning parameters**: `tuning.quickpick` supplies `enabled`, `maxTours`,
   `timeLimitMs`, and `minTriggerCost`

## Physical Join Algorithm Selection

After join ordering (QuickPick), the optimizer selects a physical join algorithm for each join node. This runs in the PostOptimization pass (after QuickPick in the Physical pass) so the full logical join tree is visible to QuickPick before any physical conversion.

The selection rule (`ruleJoinPhysicalSelection`) extracts equi-join pairs from AND-of-equalities in the ON condition, performs a four-way cost comparison (nested-loop vs hash vs merge vs index-nested-loop), and selects the cheapest physical algorithm. The rule declines outright when either input is correlated: hash and merge drain a side once, outside any outer row's scope, so a correlated side — e.g. a `JOIN LATERAL` subtree reading outer columns — must keep the nested-loop driver. (That guard is also what makes the index-nested-loop rewrite below idempotent: its own output has a correlated right side.)

**Admissibility and tagging in `rules/join/equi-pair-extractor.ts`** decide whether a candidate pair may become a physical key, and with which properties. A physical key compares with no type context, so it must reproduce what the `=` operator says:

- **Agreeing semantic ordering** (`semanticOrderingsAgree`) — an admissibility gate: either neither side declares a semantic-ordering logical type, or both declare the *same* one. A **mixed** pair such as `timespan_col = text_col` is inadmissible: `=` runs its generic path's runtime duration check and matches `'PT1H'` against `'PT60M'`, which a raw-text hash key or merge co-walk does not. Declining rather than canonicalizing is deliberate — merge join needs both inputs physically sorted in its comparator's order, and no single comparator merges "sorted by elapsed time" with "sorted by text". See `docs/types.md` § Semantic ordering.
- **Collation** — tagged per pair, not gated. A pair over differently-collated columns (declared NOCASE vs defaulted BINARY — the default shape of every text FK→PK join on the persistent store, whose PK columns default to the table key collation) **is** extracted; every algorithm resolves the pair's comparison collation through the same symmetric provenance lattice as the scalar `=` (`resolveComparisonCollation`), so a hash key normalizes both sides identically. Each `EquiJoinPair` carries two flags (`planner/nodes/join-utils.ts`):
  - `collationsMatch` — both sides declare the same collation. Merge join is considered **only when every pair is matched** (see the merge bullet below); hash/bloom take every pair.
  - `valueDiscriminating` — the comparison passes only value-equal rows (`isValueDiscriminatingEquality`). The physical join nodes feed **only** these pairs into key coverage, FD/EC, and monotonicity propagation — a NOCASE pair matches `'Bob'` to `'bob'`, so minting a value-equality fact from it would over-claim. Non-discriminating pairs still key the join at runtime.
  - The one collation shape still declined is a same-rank explicit/declared *conflict* (declared NOCASE vs declared RTRIM): extraction leaves it in the residual so the plan-time error surfaces at its own site (`BinaryOpNode.generateType`) rather than from a join rule.

A pair failing the semantic-ordering gate (or carrying a collation conflict) demotes to the join's residual predicate, so the generic nested-loop join evaluates it with the `=` operator's own semantics. This covers `USING` too: `using (c)` is desugared at build time into the `l.c = r.c` condition it means (`buildUsingCondition` in `planner/building/select.ts`), so it reaches this rule as an ordinary ON condition and has a residual like any other join.

### Bloom (Hash) Join

- **Build phase**: Materializes the smaller input into a `Map<string, Row[]>` keyed by serialized equi-join column values
- **Probe phase**: Streams the larger input, probing the hash map for matches
- **Complexity**: O(n + m) vs O(n × m) for nested loop
- **Supports**: INNER, LEFT, SEMI, and ANTI joins with equi-predicates
- **Null handling**: Null keys are never inserted into the hash map (SQL null != null semantics)
- **Collation awareness**: Each equi-pair's key normalizer is resolved through the shared comparison-collation lattice (`resolveComparisonCollation` — explicit > declared > default > BINARY, **symmetric**), so build- and probe-side keys normalize identically and agree with the merge/nested-loop comparators (e.g., NOCASE → toLowerCase, RTRIM → trimEnd). This symmetric resolution is what makes **mismatched-collation pairs** (`collationsMatch: false`) hash-joinable — both sides' keys normalize under the one resolved collation, matching exactly the rows `=` matches. A same-rank explicit/declared conflict reaching the emitter throws as a loud backstop (the extractor declines such pairs).
- **Residual conditions**: Non-equi parts of the ON clause are evaluated as a residual filter after hash lookup
- **Side selection**: For INNER JOINs, the smaller input is the build side; for LEFT/SEMI/ANTI JOINs, the left side is always the probe side to preserve semantics
- **Semi join**: Emits left row on first match, producing at most one output per left row (used for EXISTS decorrelation)
- **Anti join**: Emits left row only when no match is found (used for NOT EXISTS decorrelation)

### Merge Join

Selected when both inputs are already sorted on the equi-join columns (or when sorting + merge is still cheaper than hash join):

- **Algorithm**: Single linear pass over both sorted inputs. Materializes the right side into an array for run detection; streams the left side with a pointer into the right array.
- **Complexity**: O(n + m) when pre-sorted; O(n log n + m log m) when sort is needed
- **Supports**: INNER, LEFT, SEMI, and ANTI joins with equi-predicates
- **Ordering preservation**: Preserves left-side ordering in output (unlike hash join which destroys ordering)
- **Sort insertion**: The optimizer detects existing ascending ordering via `PlanNodeCharacteristics.getOrdering()` and inserts `SortNode`s only when inputs aren't already sorted on the equi-pair columns
- **Duplicate key runs**: Correctly produces cross-product of matching runs when both sides have duplicate key values
- **Null handling**: NULL keys never match (consistent with SQL null != null semantics)
- **Collation awareness**: Each equi-pair's key comparator is resolved through the same shared lattice as bloom/nested-loop. Because the physical ordering property (`PhysicalProperties.ordering`) is collation-blind, merge correctness depends on both inputs being sorted under the resolved collation — so the selection rules (`rule-join-physical-selection` and `rule-monotonic-merge-join`) consider merge **only when every equi-pair has `collationsMatch`** (both sides declare the same collation, making the resolved key collation equal each input's declared sort collation). Any mismatched pair removes merge from the candidate set and hash vs nested-loop compete; merging on just the matched subset of a multi-key join is deliberately not attempted (rare shape, and losing it costs an optimization, never a row).

### Index-Nested-Loop Join

Selected when the join's inner (right) side bottoms out in an unconstrained every-row walk over a table whose module can answer an equality seek on the join key. `rules/join/index-nested-loop.ts` builds the candidate; the four-way comparison in `rule-join-physical-selection` adopts it. The logical `JoinNode` — and therefore the nested-loop emitter — survives; only the right access leaf is replaced with an `IndexSeekNode` whose seek keys are column references into the **outer** row. For each outer row the emitter installs the left row slot and re-opens the inner pipeline, so the seek keys re-resolve per row through the runtime context by attribute id — the same machinery correlated subqueries already exercise.

- **Complexity**: O(n · seek) — one seek per outer row — vs O(n + m) for hash/merge. Wins when the outer side is small and the inner is large with a selective index. Selectivity authority stays with the module: `getBestAccessPlan` is probed twice (with the synthesized join constraints, and with none), and the seek must beat the module's own scan on **both** cost and rows — module currency compared to module currency, the same discipline as `rule-key-set-seek`'s break-even.
- **Supports**: INNER, LEFT, SEMI, and ANTI — the types the emitter drives from the left. SEMI/ANTI benefit most: the emitter breaks on the first inner row, so a one-row seek ends the inner loop immediately. RIGHT/FULL drive from the right with no left slot installed and never take this path. `exists … as` existence joins **can** take it (the flag bit is derived by the surviving nested-loop emitter) — the one physical join algorithm available to them, since hash/merge drop the appended flag column.
- **ON condition retained** on the join: redundant when the seek is exact, but the safety net when the seek over-fetches (a `COARSER_SAFE` collation cover, a module returning a superset). Costs one predicate evaluation per emitted row, not per scanned row.
- **NULL outer key**: the seek key is NULL, the scan layer's NULL-seek guard returns no rows, and the outer row is unmatched — INNER/SEMI drop it, LEFT null-pads it, ANTI keeps it. `NULL = x` is UNKNOWN, so this is the correct answer, not an accident.
- **Declines** (leaving nested-loop / hash / merge to compete): a right side that does not peel through Alias / trivial Project / Filter (`rules/shared/access-leaf.ts`, shared with `rule-key-set-seek`) to an unconstrained leaf — pushed constraints, a pushed limit/offset, or a load-bearing walk order all disqualify; side effects on the right; cross-logical-type or semantic-ordering join keys (a raw-value seek can miss rows `=` considers equal, and the retained ON cannot resurrect a row never returned); a `MISMATCH_UNSAFE` collation cover; the module declining the seek, attaching a `residualFilter`, or costing the seek at or above its own scan. Collation, composite seeks, NULL handling, and residual reattachment are all delegated to the exported `selectPhysicalNode` from `rule-select-access-path` — anything but an `IndexSeekNode` coming back (a scan on a collation decline, an `EmptyResultNode` on an "impossible" predicate) declines the candidate.
- **Determinism is deliberately not gated**: the nested loop already re-executes the inner side per outer row, so replacing a scan with a seek does not change how often a non-deterministic inner runs.
- **Caching**: `rule-nested-loop-right-cache` declines correlated right sides, so the per-outer-row seek is never frozen behind a `CacheNode` (which would replay the first outer row's matches for every row).

**Cost model** (from `src/planner/cost/index.ts`):
- Merge join: `(leftRows + rightRows) × 0.3` + sort costs if needed
- Hash join: `buildRows × 0.8 + probeRows × 0.4`
- Nested loop: `outerRows × 1.0 + outerRows × innerRows × 0.1`
- Index-nested-loop: `outerRows × (1.0 + 0.5 + rowsPerSeek × 0.3 + perSeekLatencyMs)` — `rowsPerSeek` is the module's estimate for the equality access plan

Inner-side first-row latency (`physical.expectedLatencyMs`) is charged once to the hash and merge candidates (each drains the inner side once) and per outer row to index-nested-loop — locally inside the selection rule's comparison, not in the shared cost functions. Plain nested-loop's formula is left alone: it is the no-change fallback.

For a 50×1000 self-join, hash join cost = 1000×0.8 + 50×0.4 = 820 vs nested loop = 50×1.0 + 50×1000×0.1 = 5050.

## Fan-out lookup join (FK→PK + 1:n cross)

`rule-fanout-lookup-join.ts` (Structural pass, registered ahead of `join-elimination`) clusters a Project-rooted set of N per-outer-row branches into one physical `FanOutLookupJoinNode` (see `docs/runtime.md` § FanOutLookupJoinNode for the runtime). A branch is either *at-most-one* (≤1 row per outer row — `atMostOne-left` / `atMostOne-inner`) or *cross* (data-driven 1:n, Cartesian product per outer row — `cross` for INNER/CROSS, `cross-left` for an outer-preserving LEFT 1:n). Three branch kinds are recognized and combined into a single cluster (a chain may mix all three):

**1. Join-spine branches.** A chain of LEFT/INNER/CROSS joins from a common outer where every join's non-preserved side is a parameterized equi-lookup. The recognition primitives are shared with `rule-join-elimination`:

- `isAndOfColumnEqualities` — the ON clause must be an AND of `colRef = colRef` atoms; any residual disqualifies the branch.
- `checkFkPkAlignment` + `lookupCoveringFK` (`util/key-utils.ts`, `util/ind-utils.ts`) — when the join's equi-pairs match an FK on the outer's table referencing the lookup's PK (in the FK's declared positional order), the branch is **at-most-one**. INNER at-most-one branches additionally require a non-null FK and a row-preserving path to the PK table (the same `isRowPreservingPathToTable` guard the join-elim rule uses); an aligned INNER branch that fails this (nullable FK / non-row-preserving) **bails** the whole cluster rather than degrading to cross — FK→PK is still ≤1 match, so the issue is inner-drop semantics, not cardinality.
- **Equi-pair indices are translated to base-table columns first.** Both helpers consume *base-table* column indices, because FK and PK declarations are stored in each table's own column order. The equi-pairs arrive as each side's *output* column positions, and a sub-select between the table and the join renames, reorders, and drops columns — so each side is resolved with `resolveTableColumnMapping` and each index run through `mapColumnsToTable` (`util/ind-utils.ts`) before the comparison. Without the translation an output position silently names a different table column, and the wrong column is accepted as the FK/PK column. A join column with no base-table origin (a computed expression) is untranslatable and **degrades the branch to `cross`** rather than bailing the cluster: `cross` is always sound, so failing to *prove* at-most-one should cost the proof, not the cluster. `rule-join-elimination` performs the same translation but declines the rewrite outright, since it has no sound weaker option.
- When FK→PK alignment is **absent** (no FK, or FK→non-unique) the lookup is data-driven 1:n. An INNER/CROSS join becomes a **cross** branch (inner-drop: an empty branch collapses the outer row). A **LEFT** join becomes a **cross-left** branch — same 1:n product when the branch matches, but an empty branch emits one NULL-padded factor row so the outer row is preserved (LEFT semantics), and the branch's output attributes are nullable-widened (mirroring `atMostOne-left`). Both contribute a 1:n factor gated by the row/product guards below; the cardinality/widening predicates are centralized as `isCrossBranchMode` / `isLeftBranchMode` on `FanOutLookupJoinNode`.
- When a spine is present the outer subtree must resolve to a single base table plus its output→table column map (`resolveTableColumnMapping`) so the FK column indices are well-defined — middle-of-chain joins that don't resolve to a single schema are not eligible. The chain walker descends `.left` until it stops being a join, so the outer is never itself a join and one mapping describes it. `resolveTableColumnMapping` is consulted **only** when there is a spine; pure-subquery clusters skip it.

Each recognized spine branch becomes a `FanOutBranchSpec` whose `child` is the lookup wrapped in a `FilterNode` carrying the original equi-condition.

**Cross-branch memory guard.** A cross branch's 1:n fan-out makes the cluster output the Cartesian product of the outer side and every cross branch (both `cross` and `cross-left` count — a `cross-left` empty match only adds the single preserved NULL row, so it still widens the product), so before clustering the rule applies (in `crossGuardsPass`): (a) skip if any cross branch's lookup estimate exceeds `tuning.parallel.maxCrossBranchRows`; (b) skip if `outer.estimatedRows × Π(cross-branch estimatedRows)` exceeds `tuning.parallel.maxCrossProduct`. **Unknown estimates (`undefined`) are treated as exceeding the cap** so a missing statistic never authorizes an unbounded product; the chain then stays a streaming / re-executing nested-loop join (already memory-safe). At-most-one branches contribute a ×1 factor and are exempt. (Caveat: synthetic memory-vtab leaves resolve `estimatedRows` to `0` rather than `undefined`, so the product guard is permissive there — the cost gate's latency requirement is the primary thing keeping the rule inert on local plans; the product guard bites only against real positive estimates, e.g. vtab-supplied statistics.)

**2. Subquery branches (correlated scalar aggregates).** A correlated scalar-aggregate `ScalarSubqueryNode` found anywhere in a projection's scalar expression tree — bare (`(select count(*) from c where c.fk = o.k)`, `(select json_group_array(...) from l where l.order_id = o.id)`) or wrapped inside a scalar expression (`coalesce((select sum(...) ...), 0)`, `json((select json_group_array(...) ...))`, an arithmetic/`cast` wrapper). A scalar aggregate with no `GROUP BY` emits exactly one row per outer row regardless of how many child rows match (aggregate of the empty set is still one row — `count→0`, `json_group_array→null`), so relationally it is an `atMostOne-left` branch driven per outer row. This **subsumes** the once-proposed `array` branch mode — there is no new `FanOutBranchMode`; the JSON/array shape is whatever the query expresses. Recognition walks each projection with `collectScalarSubqueries` (pre-order, not descending into a subquery's own relational body so a nested inner subquery stays part of its enclosing branch), then gates each candidate with `recognizeSubqueryBranch`:

- the candidate is a `ScalarSubqueryNode` reached anywhere in the projection's scalar tree — multiple wrapped subqueries per projection, and a mix of wrapped + bare, may all cluster (each contributes one wide-row column);
- the subquery must be correlated **and every external reference must resolve against the outer subtree** — `collectExternalReferences(subquery)` must be non-empty and a subset of the outer's attribute IDs. Non-correlated subqueries are constant-per-query and left alone; a subquery correlating to a *sibling spine-branch* attribute is rejected because at runtime the fan-out installs only the outer row's slot before forking, so such a reference would be unresolvable inside the branch;
- beneath pass-through wrappers (Project/Alias/Sort/LimitOffset) the relational root must satisfy `CapabilityDetectors.isAggregating(root) && root.getGroupingKeys().length === 0` — this matches both the logical `AggregateNode` and the physical `StreamAggregate`/`HashAggregate`, so it is robust to pass ordering. A `GROUP BY` subquery (may yield >1 row) is rejected here;
- the subquery's relational root exposes exactly one output column (it is a scalar subquery).

Aggregate nodes advertise exactly their logical GROUP-BY + aggregate schema in both their logical and physical (`StreamAggregate`/`HashAggregate`) forms — source columns needed for HAVING/correlated access flow through the runtime row-descriptor context, never as output columns — so a no-`GROUP-BY` scalar-aggregate subquery root is already single-column. The branch `child` is therefore the subquery root verbatim, with its column-0 attribute (= `valueAttr`) contributing the scalar value to the wide row. The surrounding Project's affected projection is rewritten by `substituteSubqueries`, which rebuilds the scalar tree (via `getChildren`/`withChildren`) replacing only the matched inner `ScalarSubqueryNode`(s) with a `ColumnReferenceNode` into the fan-out's wide row — a bare-subquery projection is swapped wholesale, a wrapped one keeps its wrapping expression (`coalesce(<colref>, 0)`) intact. Correctness comes from the attribute ID (resolved by the row descriptor); the projection keeps its own `attributeId`/`alias`. This is fan-out-targeted recognition, **not** generic decorrelation — the WHERE-clause EXISTS/IN path (`rule-subquery-decorrelation.ts`) is untouched, and decorrelating a scalar aggregate to a build-side hash group-by would defeat the per-row streaming concurrency this rule exists to exploit.

**Cluster layout & runtime.** Spine branches are ordered first (preserving left-deep order), then subquery branches. The outer is the deepest `.left` of the spine, or — with no spine — the bottom relational node beneath the chain wrappers. At runtime, `FanOutLookupJoinNode` installs the outer row's slot on `rctx.context` before forking each branch, so both a spine branch's Filter and a subquery branch's internal correlation predicate resolve their outer-side `ColumnReferenceNode`s through the parent fork's snapshot. Because the branch is driven to its one finalized aggregate row, the `atMostOne-left` zero-row NULL-fill path never fires for a subquery branch — an outer row with no matching children yields the aggregate's empty-set value (`count→0`), not NULL.

**Cost gate.** The rule fires only when
```
(N − concurrencyCap) × max(expectedLatencyMs across branches) > N × tuning.parallel.branchSetupCost
```
where `concurrencyCap = min(tuning.parallel.concurrency, N)`. Practical consequences:

- `expectedLatencyMs == 0` ⇒ no rewrite. Local-only paths (memory vtab, in-process compute) leave the latency field at the default 0, so the gate is inert and `test/plan/`-style memory-vtab goldens never change shape under this rule. The gate becomes meaningful only when a remote-vtab plugin populates `VirtualTableModule.expectedLatencyMs` with a non-zero hint (`TableReferenceNode.computePhysical` reads it; the value propagates as `max(children)` through the subtree).
- `concurrencyCap ≥ N` ⇒ savings clamps to 0 (or negative, treated as 0). Fan-out wins only when concurrency-bound; below that, the nested-loop chain is already an upper bound on wall-clock and a fresh round of branch setup is pure cost.
- `N < tuning.parallel.minBranches` (default 2) ⇒ no rewrite; a single-branch fan-out has no parallelism to exploit. `N` is the **combined** spine + subquery branch count, so a lone correlated subquery with no other branch never clusters.

**Tuning knobs** (`OptimizerTuning.parallel`):

- `minBranches` (default 2) — minimum branch count before clustering is considered.
- `branchSetupCost` (default 1.0) — per-branch fixed overhead in `expectedLatencyMs`-equivalent units (anchored against `COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW`).
- `concurrency` (default 8) — static cap on in-flight branches per outer row, also fed to the constructed `FanOutLookupJoinNode.concurrencyCap`.
- `outerBatchConcurrency` (default 16) — global in-flight budget for a `outerMode: 'batched'` fan-out (shared across all in-flight outer rows, not per row). Consumed at emit time by `runFanOutLookupJoinBatched`; also read by `rule-fanout-batched-outer` as the per-row budget-saturation threshold (see "Fan-out batched outer" below). See `docs/runtime.md` § FanOutLookupJoinNode → Outer execution modes.
- `maxOuterReadAhead` (default 64) — hard clamp on outer rows admitted ahead of the emit frontier in a batched fan-out, bounding the reorder buffer and forked per-row contexts. Also the buffer size `rule-fanout-batched-outer` gives the `EagerPrefetchNode` it wraps the outer in.
- `maxCrossBranchRows` (default 10000) — per-branch row cap for cross (1:n) branches (`cross` / `cross-left`); a cross lookup whose estimate exceeds this stays a nested-loop join. At-most-one branches are exempt.
- `maxCrossProduct` (default 1e6) — whole-product cap for a cross fan-out (`outer × Π cross-branch rows`, including `cross-left`); unknown estimates count as exceeding it.

**Relationship to `join-elimination`.** The fan-out rule runs first. A successful cluster removes all eligible branches from the chain. If the rule abstains (branch count < `minBranches`, or the cost gate rejects), the remaining single-branch joins fall through to `join-elimination`, which can still eliminate them individually when the non-preserved side isn't referenced upstream.

**Out of scope.** Subqueries nested inside a larger scalar expression (`coalesce((subq), 0)`, arithmetic on a subquery) are not recognized — v1 requires the projection node to *be* a `ScalarSubqueryNode` (tracked as backlog `parallel-fanout-aggregate-branch-wrapped-subquery`). The relational 1:n product case is recognized as `cross` (INNER/CROSS) and `cross-left` (LEFT, nullable-widened, outer-preserving on an empty branch) branches (see above). Connection-per-branch acquisition is not implemented — v1 always reuses the outer's connection, and `'serial'`-mode branches serialize through the per-connection lock; correctness is preserved but the parallelism payoff is module-mode-gated. Adaptive concurrency, latency-driven branch ordering, and the tighter per-branch equi-pair FD propagation in `FanOutLookupJoinNode.computePhysical` are all tracked as follow-ups.

## Fan-out batched outer

`rule-fanout-batched-outer.ts` (`PassId.PostOptimization`) flips an already-formed `FanOutLookupJoinNode` from the default `serial` outer mode to `batched` (cross-row pipelined — see `docs/runtime.md` § FanOutLookupJoinNode → Outer execution modes). It is a *post-pass* over the node `rule-fanout-lookup-join` built in `Structural`, not a new recognition path: by PostOptimization, physical-pass selection has finalized leaf `expectedLatencyMs` / `estimatedRows` / `concurrencySafe`, which the cost model reads. The rule matches `PlanNodeType.FanOutLookupJoin`.

**When batched wins.** Batched mode overlaps lookups *across* outer rows, so it pays off only when there are **many outer rows but few branches per row** — the per-row branch count under-saturates the shared global in-flight budget, and admitting more outer rows ahead of the emit frontier is the only way to fill it. All of these must hold:

- **`branchCount < tuning.parallel.outerBatchConcurrency`** — budget under-saturated per row. When one row's branches already meet/exceed the global budget, cross-row admission buys nothing.
- **`max(expectedLatencyMs across branches) >= tuning.parallel.batchedOuterThresholdMs`** (default 25 ms) — the slowest branch must be high-latency. 0 on every memory-vtab leaf, so the rule is **inert by design on local-only plans** (same discipline as `gatherThresholdMs` / `prefetchProbeThresholdMs`); the golden sweep is unaffected.
- **`outer.estimatedRows >= tuning.parallel.batchedOuterMinRows`** (default 256, ≈ 4× `maxOuterReadAhead`) — large outer cardinality so cross-row overlap dominates the reorder-buffer + per-row-fork overhead. An **unknown estimate fails the gate** (never flip on a missing statistic). Single-source relays now carry the leaf's `physical.estimatedRows` upward (`physicalSourceRows`), but not every wrapper does — a CTE reference or a set operation in between stamps nothing — so the rule reads the node's own estimate then descends single-relation pass-throughs to recover the leaf's `physical.estimatedRows`. Synthetic memory-vtab leaves resolve to 0, so the default also keeps the rule inert there independent of the latency gate.
- **`outer.physical.concurrencySafe === true`** — the batched driver pumps the outer concurrently with in-flight branch forks (serial mode never overlapped these), so the outer must be proven safe (mirrors `eager-prefetch-probe` / `async-gather`).

**Cross branches are out of scope.** A node carrying any cross (1:n) branch — `cross` or `cross-left` — is left serial; the streaming-cross + batched combination is owned by `parallel-fanout-lookup-join-cross-mode`. The rule only flips clusters whose branches are all `atMostOne-*`.

**Batched implies prefetch (outer-source isolation).** The batched driver calls `outerIter.next()` *concurrently* with live per-row branch forks. The scheduler runs every instruction against one shared `RuntimeContext`, so a raw outer sub-plan that mutates `rctx.context` during the pump (installing a row slot, etc.) would (a) risk a torn read for any branch reading that entry and (b) throw a strict-fork violation when the fan-out is nested under another fork (so `rctx.context` is strict-wrapped) and the live row forks hold the bump counter. To neutralize both, the rule wraps the outer in an `EagerPrefetchNode` (sized to `maxOuterReadAhead`) when it flips to batched: the prefetch pump runs the outer sub-plan against its *own* forked context (mutations land on the fork, never on the shared `rctx.context` the row forks bump), and the batched pump merely drains the prefetch buffer — a pure buffer read that never touches `rctx.context`. The same buffer also feeds the read-ahead window the batched driver consumes across rows, so prefetch and batched compose rather than duplicate work. The reverse implication does **not** hold — `eager-prefetch-probe` uses `EagerPrefetchNode` independently for hash-join probes. The branch correlations are already safe by construction: `rule-fanout-lookup-join` only clusters branches (spine lookups + correlated scalar-aggregate subqueries) that reference the outer row's attributes, which the batched driver isolates per row in its own boxed slot.

**Pass placement.** The rule sits between `eager-prefetch-probe` and the `async-gather` rules, after physical selection and before `materialization-advisory`, so the `EagerPrefetchNode` the rule inserts is already in place when the advisory walks the tree (it will not re-wrap the outer in a `Cache`). **Idempotence:** after the rewrite `outerMode === 'batched'`, so a second firing returns null.

**Tuning knobs** (`OptimizerTuning.parallel`):

- `outerBatchConcurrency` (default 16) — per-row budget-saturation threshold (`branchCount < outerBatchConcurrency`) and, at emit time, the global in-flight budget.
- `batchedOuterThresholdMs` (default 25) — minimum slowest-branch latency to flip.
- `batchedOuterMinRows` (default 256) — minimum estimated outer rows to flip.
- `maxOuterReadAhead` (default 64) — buffer size for the inserted `EagerPrefetchNode` (and, at emit time, the reorder-buffer clamp).

## Keyed cross/inner (and lateral) product keys

`combineJoinKeys` (logical `RelationType.keys`) and `analyzeJoinKeyCoverage` →
`propagateJoinFds` (physical FDs) both derive keys for joins. For an
`inner`/`cross` join where **neither** side's key is covered by the equi-predicate
(a bare cross join, or an inner join whose predicate touches no key) but **both**
sides advertise a non-empty unique key, the relational product is itself keyed by
the pair `(leftKey, rightKey)`: each `(leftKey-value, rightKey-value)` combination
occurs at most once, because `inner`/`cross` only *removes* `(leftRow, rightRow)`
pairs, never duplicates one. These layers now emit that composite product key
`(leftKey ∪ rightKey-shifted-by-leftColumnCount)`, so `keysOf` surfaces a real
column key for the product (used by DISTINCT elimination, covering proofs, and MV
backing-PK derivation) instead of falling back to all-columns. Full-row set-ness
is *additionally* carried by `RelationType.isSet`.

Policy and gating:

- **One key per node (blow-up containment).** Exactly one product key is emitted:
  the lex-min key from each side — fewest columns, ties broken by lowest
  first-column index — concatenated. This bounds growth to ≤1 new key per join
  node regardless of how many alternative keys each side carries, keeping chained
  joins tractable.
- **Gate.** The product key fires only when (1) the join is `inner`/`cross`,
  (2) neither the right-key-covered nor the left-key-covered survivor branch fired
  (an equi-join that covers one side already yields that side's individual key),
  and (3) both sides have a non-empty key. A ≤1-row side carries only the empty
  key, which already trips a survivor branch and yields `undefined` from the
  lex-min selection, so the ≤1-row case keeps its existing behavior and never
  reaches the product key.

Equi-join (one-side-covered), `left`/`right`/`full` outer, `semi`/`anti`, and the
≤1-row (`∅ → all-cols`) paths are unchanged — the product key is confined to the
previously-empty "both keyed, neither covered" gap.
