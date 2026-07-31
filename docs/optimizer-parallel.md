# Optimizer Parallel Track

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The planner half of the parallel track: the rules that *recognize* when a plan shape
can be driven concurrently. Execution — `ParallelDriver`, `AsyncGatherNode`,
`EagerPrefetchNode` — is owned by [Runtime](runtime.md). Every rule here refuses to
fire on a side-effect-bearing branch; see
[Optimizer § Parallel-track side-effect refusal](optimizer.md#parallel-track-side-effect-refusal).

## Async gather UNION ALL

`rule-async-gather-union-all.ts` (PostOptimization pass) folds a chain of `SetOperationNode(op='unionAll')` into one N-ary `AsyncGatherNode({ kind: 'unionAll' })` that drives the branches concurrently via the runtime's `ParallelDriver` (see `docs/runtime.md` § AsyncGatherNode). The rule walks the entire tree of unionAll-`SetOperationNode`s (any shape — left-deep, right-deep, balanced) plus any unionAll `AsyncGatherNode`s the rule has already produced on inner sub-chains, flattening them into a single child list.

**Two gates must clear** for the rewrite to fire:

1. **`concurrencySafe` AND across children** — every flattened child must declare `physical.concurrencySafe === true`. Any non-safe branch (mutating subplan, holding a non-reentrant cursor, sitting over a `'serial'` module without a per-branch connection) poisons the rewrite; leave the chain as sequential `SetOperationNode`s. This mirrors the `SetOperationNode` ➜ `AsyncGatherNode` physical-property contract: both drop ordering / FDs / ECs / constant bindings / domain constraints for `unionAll`, but the gather node additionally requires concurrent execution to be safe across all children.

2. **`max(expectedLatencyMs across children) ≥ tuning.parallel.gatherThresholdMs`** — the slowest child must clear the threshold. `expectedLatencyMs` is 0 by default for all in-process / memory-vtab paths (only remote-vtab plugins populate non-zero values via `VirtualTableModule.expectedLatencyMs`), so the rule is **inert by design in local-only configurations**. The default threshold is 25 ms (matches the synthetic high-latency vtab fixture in `test/optimizer/parallel-async-gather.spec.ts`); any positive value satisfies the no-rewrite-on-local invariant the `test/plan/` golden sweep depends on.

**Pass placement.** The rule runs in `PassId.PostOptimization`, **after** physical-pass selection has finalized `expectedLatencyMs` / `concurrencySafe` on the leaves (so the gates have real values to read) and **before** `materialization-advisory` (so any cache the advisory introduces sits *inside* each gather branch — preserving the parallel-drive intent of overlapping high-latency I/O with branch-local compute).

**Attribute IDs.** The gather node inherits the outermost `SetOperationNode`'s attributes via `preserveAttributeIds`. `SetOperationNode.buildAttributes` mirrors the leftmost child's attributes verbatim, so downstream consumers (including `ORDER BY x` references) continue to resolve unchanged across the rewrite.

**Idempotence.** After the rewrite the root node is an `AsyncGatherNode`, not a `SetOperationNode`, so the rule's `node instanceof SetOperationNode` matcher rejects on a second firing. Additionally, the flatten helper absorbs unionAll-`AsyncGatherNode` children — necessary because bottom-up traversal fires the rule on inner sub-chains first; without the absorption, the outer firing would wrap an already-built gather in a second gather.

**Tuning knobs** (`OptimizerTuning.parallel`, shared with the fan-out rule):

- `minBranches` (default 2) — minimum branch count after flattening.
- `concurrency` (default 8) — fed to `AsyncGatherNode.concurrencyCap` (clamped to `Math.min(concurrency, branchCount)`).
- `gatherThresholdMs` (default 25) — minimum slowest-child latency required for the rewrite.

**Relationship to `SetOperationNode.computePhysical`.** Both nodes drop the same set of relational invariants for `unionAll` (ordering, monotonicOn, FDs, ECs, constant bindings, domain constraints). The rewrite is therefore physical-properties-preserving for the consumer; downstream rules see identical properties whether they look at the SetOp tree or the post-rewrite gather.

**Out of scope for v1.** The `crossProduct` combinator is opt-in only (no recognition rule yet); the `zipByKey` combinator has its own recognition rule (see *Async gather ZIP BY KEY* below). The `materialization-advisory`-wraps-a-high-latency-child interaction is not patched here — if the advisory introduces a `CacheNode` over a remote-vtab branch *inside* the gather, the prefetch overlap is partially defeated (the cache materializes serially before the gather sees rows); follow-up if it surfaces in practice. The mixed-branches case (one slow, two local) currently fires the rule on the simple "max-of-children" gate; an adaptive per-branch decision is parked. Sort-above-gather under `QUEREUS_FORK_STRICT=1` trips the strict-fork contract due to a pre-existing interaction between the Sort emitter (mutates parent context) and AsyncGather (keeps forks live during yielding); the optimizer-spec for this rule skips that case under strict-fork and the rest of the suite is strict-fork clean.

## Async gather ZIP BY KEY

`rule-async-gather-zip-by-key.ts` (PostOptimization pass) generalizes the UNION ALL fold to the `zipByKey` combinator. It recognizes a `ProjectNode` over a chain of binary full-outer `JoinNode`s that all equate the **same** key column set across every participating relation, and folds the whole shape into one N-ary `AsyncGatherNode({ kind: 'zipByKey', branchKeyAttrs, outputKeyAttrs })` (a symmetric N-way hash-merge — see `docs/runtime.md` § AsyncGatherNode). Binary `FULL JOIN` has **no runtime lowering of its own**, so this rewrite is its only execution path; a recognized full-outer-on-shared-key query that fails any gate simply stays a `JoinNode(full)` and errors at emit (`FULL JOIN is not supported`), exactly as before the rule existed.

**Recognized shape.** The natural spelling

```sql
select coalesce(a.k, b.k, c.k) as k, a.av, b.bv, c.cv
  from a full outer join b on a.k = b.k
         full outer join c on a.k = c.k
```

builds as `Project[ coalesce(a.k,b.k,c.k) as k, a.av, b.bv, c.cv ]` over a left-deep `Join(full)` chain. The matcher requires:

1. The full-join chain flattens (any nesting) into ≥ `minBranches` branches; each `ON` is a pure conjunction of column-ref equalities (any residual / non-equi conjunct blocks).
2. Those equalities partition the branches' key columns into K equivalence classes ("key positions"), and **every branch contributes exactly one column to every class** (the shared-key precondition — a branch absent from any class would be a cross-product, not a zip).
3. The projection list, **in any order**, expresses: K merged keys (each a `coalesce(...)` whose argument set is exactly one key class's per-branch key attrs), the forwarded non-key column refs it selects (a subset is fine), plus arbitrary additional pure scalar expressions over those outputs (e.g. `coalesce(a.k, b.k) * 10`). The one hard constraint: a branch *key* column may appear **only** inside a recognizing full-group `coalesce` — a bare/partial reference (`select a.k …`) blocks, because the per-branch key is consumed into the single merged key and is unavailable above the gather.

**Reordering Project wrapper.** When the projection happens to be exactly the emitter's canonical order (`[K coalesce calls][branch0 non-key][branch1 non-key]…`), the gather replaces the `Project` outright — the fast path, no wrapper. Otherwise the gather is built in its canonical layout and wrapped in a thin reordering `Project` that reproduces the user's list: each full-group `coalesce` is rewritten to a bare reference to the gather's minted merged-key output (`outputKeyAttrs[i]`), forwarded non-key refs pass through, and any surrounding pure scalar structure is rebuilt around them. The wrapper carries the original `Project`'s output attribute ids, so downstream references stay valid.

**Gates** mirror the UNION ALL rule: `concurrencySafe === true` on every branch; the slowest branch's `expectedLatencyMs ≥ gatherThresholdMs` (inert on memory-vtab plans where it is 0); every branch uncorrelated (`isCorrelatedSubquery` false — the driver forks independent contexts). One extra gate is specific to keyed merge: **every key column at a given key position must declare the same collation across all branches** (binary or not). The runtime comparator derives solely from branch 0's collations, so a disagreement would compare keys under the wrong collation — the rule declines (gracefully; `AsyncGatherNode.validateZipByKey` enforces the same *agreement* invariant and *throws* on a true mismatch). Non-binary collations are fine: the emitter composes the merged key deterministically from the lowest-indexed present branch, matching `coalesce`'s left-to-right pick even when collation-equal keys are byte-distinct (e.g. NOCASE merging `'A'`/`'a'` always yields the branch-0 value, never the arrival-order winner).

**Attribute provenance (Option A).** Each branch keeps its own key attr ids (`branchKeyAttrs[b]`, distinct per branch — provenance-clean), and the gather **mints** the K merged key ids (`outputKeyAttrs`) — which are exactly the ids the `Project` already minted for its `coalesce` outputs (computed expressions → fresh ids, disjoint from all child ids). `preserveAttributeIds` is the `Project`'s full output attribute list, which (because the canonical order matched) equals `[minted keys] ++ [each branch's non-key attrs]`, so downstream references to the coalesced key and the forwarded non-key columns continue to resolve.

**Idempotence.** After the rewrite the matched node is an `AsyncGatherNode`, not a `ProjectNode`, so the `node instanceof ProjectNode` matcher rejects on a second firing.

**Out of scope.** Only symmetric `FULL OUTER` chains are recognized (`LEFT`/`RIGHT` outer chains are asymmetric and not zipByKey). `USING` / `NATURAL` full joins **are** recognized: the builder desugars their equated columns into an explicit `ON` condition (`buildUsingCondition` in `planner/building/select.ts`), so the chain walk — which requires `JoinNode.condition` — sees the same shape the spelled-out ON form produces (pinned by an explicit fold test).

**Tuning knobs** (`OptimizerTuning.parallel`, shared with the UNION ALL and fan-out rules): `minBranches`, `concurrency` (→ `concurrencyCap`), `gatherThresholdMs`.

## Eager-prefetch probe wrap

`rule-eager-prefetch-probe.ts` (PostOptimization pass) wraps the probe (`left`) input of a physical hash join (`BloomJoinNode`, `PlanNodeType.HashJoin`) in an `EagerPrefetchNode` when the build (`right`) side advertises high first-row latency. Note the `BloomJoinNode` convention: **`left` is the probe (streamed) side** and `right` is the build (materialized) side — opposite of the textbook ordering. The buffered prefetch pump then pipelines probe-side reads with the parent emit's per-row work.

**Cost gate.** `node.right.physical.expectedLatencyMs ≥ tuning.parallel.prefetchProbeThresholdMs`. Like the fan-out and gather rules, `expectedLatencyMs` is 0 on every in-process / memory-vtab leaf, so the rule is **inert by design on local-only plans** (the `test/plan/` golden sweep is unaffected). The gate is on the build side specifically: if `left` were the slow one the consumer above the join takes that latency hit regardless, so prefetching it would not change first-row time meaningfully.

**Concurrency gate.** Since the prefetch pump now starts on `run()` (see runtime.md § EagerPrefetchNode), the probe (`left`) subtree iterates **concurrently** with the build's for-await over `right`. If either side sits over a non-reentrant (`'serial'`) cursor, concurrent iteration corrupts state. The rule therefore only fires when **both** `node.left.physical.concurrencySafe === true` and `node.right.physical.concurrencySafe === true` — mirroring `rule-async-gather-union-all`'s strict `=== true` check (wrap only when *proven* safe; `undefined` blocks). Memory-vtab leaves declare `concurrencyMode = 'reentrant-reads'` → `concurrencySafe === true`, so local plans clear this gate (but remain blocked by the cost gate).

**Skip predicates.** The wrap is suppressed when the probe is already pump-driven or pre-materialized: `left` is an `EagerPrefetchNode` (idempotence), a `Cache` (pre-materialized — a prefetch over a cache buys nothing), or an `AsyncGather` (already drives its branches concurrently). Pure-`nodeType` checks; no capability detector.

**Pass placement.** Runs in PostOptimization — after `mutating-subquery-cache` and `asof-strategy-select` (finalizes leaf physical properties incl. `expectedLatencyMs`), and before `cte-optimization` and `materialization-advisory` (so the advisory sees the prefetch-wrapped tree and does not re-wrap the probe in a Cache).

**Tuning knobs** (`OptimizerTuning.parallel`): `prefetchProbeThresholdMs` (default 25 — shares the synthetic high-latency vtab fixture value) and `prefetchBufferSize` (default 64 — mirrors the `EagerPrefetchNode` constructor default).

**Out of scope (follow-on backlog).** A broad cost-driven gate independent of remoteness; merge / nested-loop / asof join shapes; wrapping the build side (consumed once linearly, no benefit); and wrapping arbitrary high-latency subtrees.
