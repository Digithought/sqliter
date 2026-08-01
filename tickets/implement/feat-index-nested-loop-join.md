---
description: When a query joins a small set of rows against a large table on a column that already has an index, make the engine do one quick index lookup per row instead of reading the whole large table.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # where the fourth algorithm is chosen
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts              # NEW — candidate construction
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts      # export selectPhysicalNode for reuse
  - packages/quereus/src/planner/cost/index.ts                                # new indexNestedLoopJoinCost
  - packages/quereus/src/planner/analysis/constraint-extractor.ts             # extractConstraints / createTableInfoFromNode
  - packages/quereus/src/planner/cache/correlation-detector.ts                # isCorrelatedSubquery
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts            # closest precedent — probe + gates + break-even
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts  # already declines correlated right sides
  - packages/quereus/src/runtime/emit/join.ts                                 # nested-loop driver (unchanged)
  - packages/quereus/src/runtime/emit/scan.ts                                 # IndexSeek dynamic seek keys (unchanged)
  - packages/quereus/test/optimizer/                                          # new spec goes here
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
difficulty: hard
---

# Index-nested-loop join: seek the inner side once per outer row

## What ships

A fourth physical join algorithm, chosen inside the existing
`rule-join-physical-selection` alongside nested-loop / hash / merge. When the join's
inner (right) side bottoms out in a plain table walk over a table whose module can
answer an equality seek on the join key, the rule replaces that walk with an
`IndexSeekNode` whose seek keys are **column references into the outer row**. The
node above stays the logical `JoinNode`, so the existing nested-loop emitter drives
it: for each outer row it installs the outer row slot and re-opens the inner
pipeline, and the seek-key expressions resolve through the runtime context by
attribute id.

    Join(inner, s, SeqScan(big))            Join(inner, s, IndexSeek(big, keys=[s.k]))
      ON big.id = s.k              ──▶        ON big.id = s.k
    reads every row of big                   one seek per row of s

Cost goes from "scan the whole inner table" to "one seek per outer row". For SEMI /
ANTI joins the win is largest — the emitter breaks on the first inner match, so a
seek that returns one row ends the inner loop immediately.

## Why this is mostly assembly, not new machinery

Every piece already exists and is already exercised by correlated subqueries:

- `IndexSeekNode` accepts arbitrary `ScalarPlanNode` seek keys, and `emitSeqScan`
  emits them as instruction **params** — re-evaluated on every re-open of the inner
  pipeline (`packages/quereus/src/runtime/emit/scan.ts:175-181`).
- `emitColumnReference` resolves purely by attribute id through the runtime context
  (`resolveAttribute`), so an outer column reference works anywhere inside the inner
  subtree.
- `emitLoopJoin.driveFromLeft` sets the left row slot *before* calling
  `rightCallback(rctx)` (`runtime/emit/join.ts:107-111`), and `emitSeqScan` already
  caches the connected vtab instance per scan site specifically for the
  "NLJ inner re-scan" case (`runtime/emit/scan.ts:78-82`).
- `rule-nested-loop-right-cache` already declines to cache a correlated right side,
  and its header names this exact shape: *"a parameterized/lateral seek produced by
  predicate pushdown"*.
- `extractConstraints` already classifies `inner.col = <outer column ref>` as
  `bindingKind: 'correlated'`, `correlated: true`, carrying the outer expression in
  `valueExpr` (`analysis/constraint-extractor.ts:414-449`).
- `selectPhysicalNode` already turns such a constraint into an `IndexSeekNode` whose
  seek key is the dynamic `valueExpr` (`equalitySeekKey`, and `isLiteralNullEquality`
  deliberately returns false for a dynamic binding).

So the new code is: recognize the shape, probe the module, cost it, and hand the
synthesized constraints to `selectPhysicalNode`.

## Where the decision lives, and why

**Inside `rule-join-physical-selection`, in the PostOptimization pass.**

Considered and rejected: injecting a correlated `Filter` onto the inner branch during
the Structural pass and letting `rule-predicate-pushdown` → `rule-grow-retrieve` →
`rule-select-access-path` produce the seek. That reuses more (it would also fold the
inner side's own `WHERE` into one access plan), but it puts a correlated subtree in
front of `rule-quickpick-join-enumeration` and `rule-join-greedy-commute`, which may
reorder join inputs and move the correlated side into an outer position. Deciding
after all join-order enumeration has finished removes that whole class of hazard.
The cost is the pushed-constraint limitation below, which is mild and parked.

## Structure of the change

### 1. Correlated-side guard in `ruleJoinPhysicalSelection` (do this first)

At the top of the rule, before anything else:

```ts
// A correlated side must keep the nested-loop driver: hash and merge both drain a
// side once, outside any outer row's scope, so a subtree reading outer columns
// would resolve against no row. This is also what makes the index-nested-loop
// rewrite below idempotent — its own output has a correlated right side.
if (isCorrelatedSubquery(node.left) || isCorrelatedSubquery(node.right)) return null;
```

Two jobs: it is the idempotence mechanism for this feature, and it closes a latent
hole — `LATERAL` is a parsed, supported join form (`parser/parser.ts:1261`), so
`join lateral (…) on <equality>` can reach this rule with a correlated right side
today and be converted to a hash join.

**Before adding the guard, probe HEAD** with something like
`select * from t join lateral (select * from u where u.k = t.k) x on x.v = t.v`.
Record in the handoff what HEAD does (runtime error, wrong rows, or the rule already
declining for an unrelated reason). If it is a live defect, say so plainly — do not
claim it silently. If any golden plan changes from the guard alone, re-derive it
rather than regenerating blindly.

### 2. `indexNestedLoopJoinCost` in `planner/cost/index.ts`

```ts
/**
 * Cost for an index-nested-loop join: one index seek per outer row.
 * `rowsPerSeek` is the MODULE's estimate for the equality access plan — selectivity
 * authority stays with the module that owns the index rather than being re-derived
 * from engine-side statistics (same discipline as rule-key-set-seek's break-even).
 * `perSeekLatencyMs` is `inner.physical.expectedLatencyMs`, 0 for every in-process
 * vtab, treated as ms-equivalent cost (same convention as tuning.parallel.branchSetupCost).
 */
export function indexNestedLoopJoinCost(
  outerRows: number, rowsPerSeek: number, perSeekLatencyMs = 0,
): number {
  return outerRows * (
    COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW
    + COST_CONSTANTS.INDEX_SEEK_BASE
    + rowsPerSeek * COST_CONSTANTS.INDEX_SEEK_PER_ROW
    + perSeekLatencyMs
  );
}
```

`INDEX_SEEK_BASE` (0.5) and `INDEX_SEEK_PER_ROW` (0.3) already exist — no new constants.

### 3. `rules/join/index-nested-loop.ts` — candidate construction

One exported entry point, called from `ruleJoinPhysicalSelection` after the equi-pair
extraction and before the existence early-return:

```ts
export interface IndexNestedLoopCandidate {
  /** Rebuilt right subtree with the access leaf replaced by the correlated seek. */
  readonly newRight: RelationalPlanNode;
  /** Engine-currency cost, comparable with nestedLoop/hash/merge in the caller. */
  readonly cost: number;
}

export function tryIndexNestedLoop(
  node: JoinNode,
  equiPairs: readonly EquiJoinPair[],
  outerRows: number,
  context: OptContext,
): IndexNestedLoopCandidate | null;
```

Steps, in order:

**a. Join-type gate.** `inner` / `left` / `semi` / `anti` only. `right` / `full` use
`emitLoopJoin.driveFromRight`, which opens the right cursor as the *outer* loop with
no left slot installed — a correlated inner would resolve against nothing. `cross`
never reaches here (no condition ⇒ no equi pairs).

**b. Purity gate.** Decline when `PlanNodeCharacteristics.subtreeHasSideEffects(node.right)`.
Do **not** gate on determinism: the nested loop already re-executes the inner side per
outer row, so replacing a scan with a seek does not change how often a
non-deterministic inner runs. State that reasoning in the code comment rather than
copying `rule-key-set-seek`'s determinism gate, which exists there because that rule
drains its key source exactly once.

**c. Peel to the access leaf.** Descend `node.right` through `AliasNode`, trivial
`ProjectNode` (every projection a bare `ColumnReferenceNode`), and `FilterNode` to a
`SeqScanNode` or `IndexScanNode`. Anything else ⇒ decline. Same shape as
`rule-key-set-seek`'s `peelToLeaf` — factor a shared helper if the two are identical,
otherwise duplicate deliberately and say why.

**d. Leaf admission.** Require an unconstrained every-row walk:
`filterInfo.accessPath?.kind === 'fullScan'`, or `kind === 'index' && plan === 'scan'`;
plus `filterInfo.constraints.length === 0`, no `limit`, no `offset`. Decline an
`IndexScanNode` with `orderingLoadBearing` (its walk order is carrying an absorbed
`Sort`; a seek emits in seek-key order). Rationale for the constraint check is
identical to `rule-key-set-seek`'s: replacing the leaf's `FilterInfo` would silently
drop predicates the module promised to enforce. Park the widening in
`backlog/feat-index-nested-loop-over-pushed-constraints`.

**e. Type gates per equi pair.** Resolve each pair to (outer attribute, leaf column
index). Decline when the two sides' `logicalType.name` differ, or when either is a
`hasSemanticOrdering` type. Reason: the seek key is passed through verbatim (no cast
is applied to a dynamic `valueExpr`), so a cross-type or semantically-ordered key can
miss rows `=` considers equal — and the ON condition we keep above cannot resurrect a
row the seek never returned. Same two gates as `rule-key-set-seek.resolveSeekColumns`.

**f. Build the seek predicate.** For each pair, a `BinaryOpNode('=', innerColRef,
outerColRef)`, ANDed. `innerColRef` is a `ColumnReferenceNode` over the leaf's
attribute (column index = its position in the leaf's attributes); `outerColRef` is one
over `node.left`'s attribute at its position there. Follow the construction in
`rule-join-physical-selection.createSortForEquiPairs`.

**g. Extract constraints.** `createTableInfoFromNode(leaf.source, key)` then
`extractConstraints(pred, [tableInfo])`. **Assert the orientation held**: every
resulting constraint's `attributeId` must be an *inner* attribute and its
`correlated` flag must be true. If the extractor attributed a constraint to the outer
side, decline. Building the predicate inner-side-first should make this hold; the
assertion is there so a future extractor change fails loudly instead of seeking on the
wrong column.

**h. Probe the module, twice.** Mirror `rule-key-set-seek.probeModuleCosts`: build the
request with the same `columns` mapping (`buildProbeRequest` there is a candidate for
extraction into a shared helper), call `getBestAccessPlan` with the join constraints
and again with no filters, and run `validateAccessPlan` on both. A module that answers
a synthesized probe with an invalid plan is **logged and declined**, never thrown —
the user's own query ran fine before.

Require, in module currency:
- `seekPlan.indexName` and `seekPlan.seekColumnIndexes` non-empty,
- every `seekColumnIndexes` entry covered by one of our equality constraints,
- every corresponding `handledFilters` entry true,
- `seekPlan.cost < scanPlan.cost` **and** `seekPlan.rows < scanPlan.rows` — the module's
  own statement that a seek beats a scan on this table. Comparing module cost to module
  cost keeps the two currencies from mixing (the same discipline `rule-key-set-seek`
  applies).

**i. Build the physical leaf.** Export `selectPhysicalNode` from
`rule-select-access-path.ts` and call it with `(leaf.source, seekPlan, constraints)`.
This is the reuse that pays for the whole design: collation cover (via
`classifyCollationCover` over the real `innerCol = outerCol` source expression, so the
join key's *resolved* comparison collation is what gets checked — the ticket's
collation requirement, satisfied for free), composite seeks, NULL handling, and
`reattachUnconsumedConstraints` all come along.

Then **verify an `IndexSeekNode` actually came back** (the returned subtree's leaf is
an `IndexSeekNode`). `selectPhysicalNode` degrades to a `SeqScan` + residual on a
collation decline and to an `EmptyResultNode` on an impossible predicate; both mean
"no index-nested-loop here" ⇒ decline the candidate and let hash/merge compete.
An `EmptyResultNode` in particular must **not** be adopted — it would be sound only if
we could prove the join key literally NULL, which we cannot at plan time.

**j. Cost.** `indexNestedLoopJoinCost(outerRows, seekPlan.rows ?? 1, latencyMs)` where
`latencyMs = node.right.physical.expectedLatencyMs ?? 0`.

### 4. Wiring in `ruleJoinPhysicalSelection`

- Call `tryIndexNestedLoop` **before** the `node.hasExistenceColumns` early-return.
  Index-NL keeps the logical `JoinNode` and its emitter, and `JoinNode.withChildren`
  threads `existence` and `usingColumns` verbatim, so an `exists … as` join *can* take
  this path — unlike hash/merge, which drop the appended flag column. That is a real
  capability gain over the current early-return; pin it with a test.
- Add `indexNL` to the four-way cost comparison. When it wins, return
  `node.withChildren(node.condition ? [node.left, newRight, node.condition] : [node.left, newRight])`.
- **Keep the ON condition on the join.** It is redundant when the seek is exact, but it
  is the safety net when the seek over-fetches (a `COARSER_SAFE` collation cover, a
  module returning a superset) and it costs one predicate evaluation per emitted row.
  Say so in a comment.
- The three baseline algorithms each scan the inner side once, so add `latencyMs`
  (not `outerRows * latencyMs`) to the hash and merge costs **inside this rule's local
  comparison only** — do not change the shared cost functions. Leave plain nested-loop's
  formula alone; it is the fallback, and if it wins nothing changes. Document this
  asymmetry where the comparison is written.

## Costing decision (the plan ticket's open question, resolved)

**This ships now; it does not need a new statistics effort.** The plan ticket worried
that base-table cardinality is weak, but the input this decision actually turns on is
*inner selectivity* — how many rows one seek returns — and that comes from the module's
own access plan (`seekPlan.rows`), the authority that owns the index. Outer cardinality
uses `node.left.estimatedRows ?? 100`, exactly the same input hash and merge selection
already rely on in this rule, so index-nested-loop is no worse informed than the
alternatives it competes with; the selectivity work in
`complete/debt-access-node-catalog-cardinality` and `complete/feat-join-filter-selectivity`
has already improved that number, and further improvements land here for free.

Pin the crossover with a unit test table so it is reviewable rather than folkloric —
at minimum: (outer 10, inner 100 000, 1 row/seek) ⇒ index-NL; (outer 100 000, inner 5,
1 row/seek) ⇒ hash; (outer 100, inner 100, 100 rows/seek — an unselective "index")
⇒ not index-NL.

## Which side drives (also resolved)

**Right side only.** The nested-loop emitter drives from the left for every join type
this rule admits, and commuting the join here would reshuffle the output row layout
that `[...leftRow, ...rightRow]` depends on. `rule-join-greedy-commute` already runs in
the Structural pass and puts the smaller input on the left, so the large indexed table
lands on the right in the common case. Teaching join-order enumeration about index
availability is parked in `backlog/feat-index-nested-loop-commute-drive-side`.

## Edge cases & interactions

- **Idempotence.** Call the rule directly on its own output; it must return `null` via
  the correlated-side guard. Pass-level fixed point is not sufficient evidence — it
  cannot tell "declined" from "fired and was undone".
- **`right` / `full` joins** never take this path (driver installs no left slot).
- **NULL outer key.** `s.k` is NULL ⇒ the seek key is NULL ⇒ the scan layer's
  `seekKeyHasNull` guard returns no rows ⇒ the outer row is unmatched. INNER drops it,
  LEFT null-pads it, SEMI drops it, ANTI keeps it. Test all four; `null = x` is UNKNOWN,
  so this is the correct answer, not an accident.
- **LEFT join with no inner match** must still null-pad. The seek returning zero rows
  leaves `matched === false`, which is the same path an empty scan takes.
- **SEMI / ANTI** break on the first inner row — assert the seek is what makes this
  cheap, and that ANTI still emits outer rows whose seek came back empty.
- **`exists … as` existence columns** — see wiring above; assert the flag column
  survives and carries the right bit.
- **Collation.** A NOCASE inner column joined to a BINARY outer must not silently
  under-fetch. `MISMATCH_UNSAFE` ⇒ `selectPhysicalNode` returns a scan ⇒ candidate
  declined ⇒ hash join. `COARSER_SAFE` (BINARY predicate over a coarser index) ⇒ seek
  kept, over-fetch trimmed by the retained ON condition. Test both directions.
- **Cross logical types** (INTEGER column vs REAL column) ⇒ decline (gate **e**).
- **Semantic-ordering key types** ('PT1H' ≡ 'PT60M', byte-distinct) ⇒ decline.
- **Composite join key** (two equi pairs, composite index) ⇒ one composite seek. Also
  test the partial case: index covers one of two pair columns, the second stays enforced
  by the retained ON condition.
- **Self-join** (`t a join t b on b.id = a.parent_id`). Two scan sites get distinct
  `scanConnectionKey` symbols, so the inner seek does not share a cursor with the outer
  walk. Test it; this is the shape most likely to expose a slot-lifetime bug.
- **Three-way join** where the outer key comes from the *inner-most* relation of a
  left-deep spine — the outer row slot at the point of the seek is the composite left
  row, and the attribute id must still resolve.
- **Right-side caching.** `rule-nested-loop-right-cache` registers after
  `join-physical-selection` in PostOptimization and declines correlated right sides.
  Assert with a plan test that no `CacheNode` appears above the seek — caching a
  per-outer-row seek would freeze the first outer row's results across all of them.
- **`rule-mutating-subquery-cache`** is also Join-typed and registers earlier in
  PostOptimization; it targets side-effect-bearing right sides, which gate **b**
  already declines. Confirm rather than assume.
- **Module probe volume.** One extra pair of `getBestAccessPlan` calls per qualifying
  equi-join, uncached. Cheap for both shipped modules. Record a `NOTE:` tripwire at the
  probe site (mirroring `rule-key-set-seek`'s) — memoize by (table, seek columns) only
  if a third-party module with an expensive planner shows up in optimization profiles.
- **Golden plan churn.** Every plan where a small outer meets an indexed inner changes
  shape. Re-derive each changed golden, do not regenerate wholesale; a golden that
  changes from `INDEXSCAN`/`HASH JOIN` to `INDEXSEEK` under a nested loop is the
  feature working, but one that loses a predicate is a bug.
- **`optimizeForAnalysis` consumers** (materialized-view maintenance shape reads,
  assertions, change-scope). The join stays a `JoinNode` with its condition intact, so
  these should be unaffected — verify their specs, do not assume.

## Validation

- `yarn workspace @quereus/quereus run test`, then `yarn test`, `yarn typecheck`,
  `yarn lint`, `yarn build`. Stream with `tee`; never silent-redirect.
- `yarn test:store` **is** warranted here: the LevelDB store module answers
  `getBestAccessPlan` differently from the memory module, and this rule's whole
  decision rests on that answer. If it is too slow to run in-ticket, say so explicitly
  in the handoff rather than omitting it silently.
- `docs/optimizer-joins.md` gains the fourth algorithm (when it is chosen, what it
  declines on, why the ON condition is retained). `docs/optimizer-rules.md` gains the
  bullet in registration order.

## TODO

### Phase 1 — guard and cost primitive

- Probe HEAD's behavior for `join lateral … on <equality>`; record the finding
- Add the correlated-side guard to `ruleJoinPhysicalSelection`; re-derive any golden it moves
- Add `indexNestedLoopJoinCost` to `planner/cost/index.ts`
- Export `selectPhysicalNode` from `rule-select-access-path.ts`
- Spec: guard declines hash/merge on a correlated side; cost function crossover table

### Phase 2 — candidate construction

- New `rules/join/index-nested-loop.ts` with `tryIndexNestedLoop` (gates a–j above)
- Factor or deliberately duplicate `peelToLeaf` / `buildProbeRequest` from
  `rule-key-set-seek.ts`; whichever, say why in a comment
- Assert the constraint orientation after `extractConstraints`
- Verify an `IndexSeekNode` came back before adopting the rebuilt subtree

### Phase 3 — wiring

- Call `tryIndexNestedLoop` before the `hasExistenceColumns` early-return
- Four-way cost comparison; local latency terms with the asymmetry documented
- Rebuild via `node.withChildren(...)`, retaining the ON condition

### Phase 4 — tests

- Optimizer spec: fires on small-outer/indexed-inner; declines on
  right/full, side effects, pushed constraints on the leaf, `orderingLoadBearing`,
  cross-type keys, semantic-ordering keys, `MISMATCH_UNSAFE` collation, module
  declining the seek, `seekPlan.cost >= scanPlan.cost`
- Rule-level idempotence (direct call on own output ⇒ `null`)
- Plan test: no `CacheNode` above the correlated seek
- sqllogic: result-equality for INNER / LEFT / SEMI / ANTI, NULL join keys on both
  sides, composite key, partial composite, self-join, three-way spine, `exists … as`
  flag column, NOCASE-vs-BINARY both directions

### Phase 5 — docs

- `docs/optimizer-joins.md`, `docs/optimizer-rules.md`
