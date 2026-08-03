---
description: When a query filters a table by a set of values on its primary key, the engine currently reads every row of the big table and walks it in step with the small one; instead it should collect the small set first and look up only the rows it needs.
prereq: bug-desc-pk-scan-advertises-ascending-order
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - docs/optimizer-rules.md
  - docs/optimizer-fd.md
  - docs/optimizer.md
difficulty: hard
---

# Extend the key-set seek rewrite to merge semi joins

## The gap

`rule-key-set-seek` anchors on `BloomJoinNode` (the physical hash semi join)
only. The most common `IN`-subquery shape — the join key is the target's primary
key — never becomes a hash join on the memory backend. Verified at `ffa64351`:

```
select id from big where id in (select id from small)      -- big(id integer primary key)

  Project
    MergeJoin :: SEMI MERGE JOIN on [0=2]     ordering=[{column:0,desc:false}]
      IndexScan :: big USING _primary_        ordering=[{column:0,desc:false}]  plan=scan
      IndexScan :: small USING _primary_      ordering=[{column:0,desc:false}]  plan=scan
```

Both sides advertise a primary-key walk, so the join becomes a **merge** semi
join before `key-set-seek` ever looks at it, and the rule's `instanceof
BloomJoinNode` guard declines. The merge join still reads every row of `big`.
The same plan appears under `delete from big where id in (select id from small)`.

The memory module *does* accept the runtime-set multi-seek on that key — probed
directly with the same request the rule synthesizes:

```
big.col0 maxCount=2    → handledFilters=[true] indexName=_primary_ seekColumnIndexes=[0] cost=1.1
big.col0 maxCount=1000 → handledFilters=[true] indexName=_primary_ seekColumnIndexes=[0] cost=300.5
big scan               → cost=1000
```

so every gate downstream of the anchor already passes. Only the anchor is
missing.

## Why the merge anchor is not a copy-paste of the hash anchor

`MergeJoinNode.computePhysical` propagates the probe side's `ordering` and
`monotonicOn` upward for `semi` (merge-join-node.ts:113-116, and
`propagateJoinMonotonicOn`'s semi branch returns the left side's entries
verbatim). `KeySetSemiJoinNode` deliberately claims neither. Ancestors recompute
their physical properties after a rewrite — confirmed by the existing hash arm,
where the `Project` above the rewritten join goes from `ordering=[…]` to
`ordering=undefined` — but a `SortNode` that an *earlier* pass already dropped on
the strength of the merge join's order cannot come back. That is a wrong-order
result, not a slow one.

Concretely, `select id from big where id in (select id from small) order by id`
plans today with **no Sort node at all**: the ORDER BY was absorbed into the
`big` primary-key walk (`IndexScanNode.orderingLoadBearing === true`) and rides
up through the merge join. Replacing that merge join with a node that claims no
order strands the query.

So the merge arm must **reproduce the ordering**, not drop it.

## The equivalence that makes it sound

Let `D` be the index the target leaf walks — `leaf.filterInfo.accessPath` is
`{ kind: 'index', index: D, plan: 'scan' }` — and let `O` be the leaf's
`providesOrdering`. The node emits one of two streams, chosen at runtime:

- **scan branch** — the leaf's `FilterInfo` is left untouched, so rows arrive in
  `D`-key order, i.e. `O`.
- **seek branch** — the leaf's `FilterInfo` is replaced with a `plan=5`
  multi-seek on the pushdown's index, with the seek keys sorted under that
  index's leading key column comparator and direction (`emitKeySetSemiJoin`'s
  `seekSign`). The engine-wide multi-seek contract is that rows come back in the
  *scanned structure's own key order*, never in seek-argument order — pinned by
  `test/vtab/multiseek-key-order.spec.ts` and honoured by both backends
  (`memory/layer/scan-layer.ts` `orderSeekKeys`, `quereus-store`'s
  `store-table-scan.ts` disjoint-window merge).

If the pushdown's index **is** `D`, the seek branch emits `D`-key order over a
subset of the rows the scan branch would emit — a subsequence. A subsequence of
a stream ordered by `O` is still ordered by `O`, and a subsequence of a stream
that is monotonic on an attribute is still monotonic on it (strictness included:
dropping rows cannot create a tie). So under that condition both branches satisfy
`O`, and the node may claim `O` — and may equally claim the target's
`monotonicOn` verbatim, which is exactly what `MergeJoinNode` claims for `semi`.

Introduce this as one exported predicate, used by both the rule and the node so
the claim and the gate can never drift:

```ts
/**
 * True when the multi-seek this pushdown describes emits in exactly the target
 * leaf's own walk order, so the node may claim the leaf's `ordering` /
 * `monotonicOn` regardless of which branch the runtime picks.
 */
export function seekPreservesTargetOrder(
    target: KeySetTargetNode,
    pushdown: KeySetPushdown,
): boolean;
```

It must require all of:

- `target instanceof IndexScanNode` (a `SeqScanNode` advertises no ordering at
  all, so there is nothing to preserve and nothing to prove);
- `target.filterInfo.accessPath?.kind === 'index'` and `plan === 'scan'`;
- `target.filterInfo.accessPath.index.name === pushdown.accessPath.index.name`
  — **seek index is the walk index**, the load-bearing clause;
- `pushdown.accessPath.index.keyColumns.length === 1` — see "single key column"
  below;
- `target.providesOrdering` has exactly one entry, whose `column` equals that key
  column's `columnIndex` and whose `desc` equals `keyColumns[0].desc === true`.
  This is what rejects a leaf whose advertised order does not actually describe
  the index's key order.

**Single key column, and why.** Restricting to a one-column index keeps the
proof inside the tested contract: for a composite index the seek would be a
leading-column *prefix* window and "structure key order within a prefix window"
is not pinned by any current test. It costs nothing today — the memory module
already declines a runtime-set `IN` on the leading column of a composite primary
key (probed: `comp(a,b)`, column 0, `handledFilters=[false]`, no index claimed),
and the literal form `where a in (1,2,3)` likewise plans as a full scan plus a
Filter, so the composite case is unreachable through either path. Relax the
clause when a module actually claims a leading-column multi-seek on a composite
index, and pin the prefix-window order first.

## What to change

### 1. `KeySetSemiJoinNode` claims the order when the predicate holds

`computePhysical` currently drops `ordering`, `monotonicOn` and
`accessCapabilities` unconditionally. Change it to:

```ts
...(seekPreservesTargetOrder(this.target, this.pushdown)
    ? { ordering: targetPhysical?.ordering, monotonicOn: targetPhysical?.monotonicOn }
    : {}),
```

Derive it — do not add a constructor flag. A flag would have to be re-validated
in `withChildren` (later PostOptimization rules such as `monotonic-range-access`
do rebuild the leaf), and a stale `true` there is a wrong-order plan. Deriving
from `this.target` and `this.pushdown` every time cannot go stale.

`accessCapabilities` stays dropped: those advertise a leaf's ability to serve a
later pushdown, and this node is not a leaf. Dropping capabilities loses
optimizations, never correctness.

This change applies to **both** arms. A hash semi join whose target happens to
walk the index it seeks is equally entitled to the claim, and the extra property
can only enable optimizations — the proof above never mentions the join
algorithm.

Add `preservesTargetOrder` to `getLogicalAttributes()` so EXPLAIN shows which
way it went.

### 2. Relax the `orderingLoadBearing` decline

`admitLeaf` declines any `IndexScanNode` with `orderingLoadBearing === true` (a
`SortNode` was absorbed into this walk, so its order is the only thing producing
the query's ORDER BY). That decline is now too broad: when
`seekPreservesTargetOrder` holds, the absorbed Sort is still served.

The pushdown is not known inside `admitLeaf`, so move the check: keep
`admitLeaf` structural, and after `planPushdown` returns, decline when
`leaf.orderingLoadBearing && !seekPreservesTargetOrder(leaf, pushdown)`.

This is what makes the headline `order by id` shape work. It does not change the
existing hash-arm behaviour pinned by *"declines when the leaf order absorbed the
Sort (ORDER BY pk)"* in `test/optimizer/key-set-seek.spec.ts` — there the walk
index is `_primary_` and the seek index is `idx_v`, so the predicate is false and
the rule still declines.

### 3. Generalize the anchor

`admitJoin` takes `BloomJoinNode` today. Widen it to `BloomJoinNode |
MergeJoinNode` — both expose `joinType`, `equiPairs`, `residualCondition`, `left`
and `right`, and every existing gate (semi only, exactly one equi-pair, no
residual, uncorrelated / deterministic / side-effect-free key source, no side
effects in the probe chain) reads the same on either.

Then add the two **merge-arm-only** gates in `ruleKeySetSeek`:

- **Must preserve the order.** `MergeJoinNode` propagates the probe side's
  ordering; a replacement that cannot reproduce it strands whatever consumed it.
  Decline unless `seekPreservesTargetOrder(leaf, pushdown)`. (The hash arm needs
  no such gate — `BloomJoinNode` propagates no ordering, so nothing above it can
  have depended on one. That asymmetry is the whole reason this was split out.)

- **Do not trade a streaming operator for an unbounded materialization.** A merge
  semi join streams both sides; `KeySetSemiJoinNode` drains the key source into a
  probe `Set` before opening the target. When the key set will exceed the
  runtime's own seek threshold the pushdown provably cannot fire, so the rewrite
  is pure loss — the same scan the merge join did, plus a set the merge join did
  not build. Decline when the key source's **physical** row estimate is present
  and exceeds `min(pushdown.maxKeys, pushdown.breakEvenKeys)` — the exact
  expression `emitKeySetSemiJoin` uses for its `push` decision.

  Read the estimate from `node.right.physical?.estimatedRows`, **not** from the
  `node.right.estimatedRows` getter: through a physical access node that getter
  reads `undefined` (measured: `undefined` for a bare `IndexScan` key source,
  while `physical.estimatedRows` was populated). Absent estimate ⇒ proceed, the
  same posture the rest of the rule takes toward advisory numbers.

  Be honest in the comment that this guard is inert on the memory backend today
  (that backend's row estimate for a freshly-populated table reads 0), and that
  it exists for modules that report real cardinality.

### 4. Registration

Add a second registry entry in `packages/quereus/src/planner/optimizer.ts`
immediately after the existing `key-set-seek` entry:

```ts
{
    pass: PassId.PostOptimization,
    id: 'key-set-seek-merge',
    nodeType: PlanNodeType.MergeJoin,
    phase: 'impl',
    fn: ruleKeySetSeek,
    sideEffectMode: 'safe',
},
```

Two entries rather than a `nodeType` array: the fan-out form renames rule ids to
`<id>-<nodeType>`, which would rename the existing `key-set-seek` id that trace
output and the comment block reference.

Placement is after both merge-join producers (`monotonic-merge-join` and
`join-physical-selection`, registered earlier in the same pass) and after
`monotonic-limit-pushdown`, matching the existing entry's rationale. Nothing else
in the pass anchors on `MergeJoin` — checked: `eager-prefetch-probe` is
`HashJoin`-only, and `PlanNodeType.MergeJoin` appears nowhere in the rule
registry — so removing a merge join costs no other rewrite.

`planner/mutation/propagate.ts` already classifies `KeySetSemiJoin` alongside
`MergeJoin` and `HashJoin` as `'unsupported-join'`, so DML diagnostics need no
change.

### 5. Docs

Three places describe the rule's shape and must be updated together — the
statements there are currently *unconditional* and become false:

- `docs/optimizer-rules.md` (the `ruleKeySetSeek` bullet): add the merge anchor,
  the ordering claim and its gate, the relaxed `orderingLoadBearing` decline, and
  the key-source-size decline.
- `docs/optimizer-fd.md` (the `KeySetSemiJoinNode` row): it currently says
  `ordering` / `monotonicOn` / `accessCapabilities` are *never* propagated.
  Rewrite to the conditional rule and state the subsequence argument in one line.
- `docs/optimizer.md` ("Where an `IN (SELECT …)` predicate ends up"): it says a
  merge semi join is the end of the line. Say that a merge semi join is now also
  a `key-set-seek` candidate, under the seek-index-is-walk-index condition.

## Edge cases & interactions

- **`orderingLoadBearing` on the target** — the merge arm's headline shape
  (`… order by id`) has it set. Must now be admitted, and the emitted rows must
  actually be ascending. Assert row order, not just plan shape.
- **Descending primary key** — with `primary key (id desc)` the leaf's key column
  is `desc: true` and the multi-seek emits descending
  (`multiseek-key-order.spec.ts`). The gate compares the advertised `desc` against
  the index's, so it admits the case only when the two agree. This is why
  `bug-desc-pk-scan-advertises-ascending-order` is a prereq: until it lands the
  memory backend advertises `desc: false` for a descending walk and the shape
  returns wrong rows before this rule is even reached. Cover it end to end
  (rows *and* order) once the prereq is in.
- **Composite primary key** — `comp(a, b)` with `a in (select …)`: the module
  declines the runtime-set claim, so the rule must leave the merge join alone.
  Assert the decline so a future module change cannot silently enable an
  unproven prefix-window ordering claim.
- **Secondary-index merge join** — `where v in (select …) order by v` walks
  `idx_v` and seeks `idx_v`: same index, non-unique. The ordering claim covers
  only `v`; rows sharing one `v` may come back in a different relative order than
  the plain walk gave. That is within the claim (ties are unconstrained) but pin
  it, because a downstream consumer reading more than it should would show up
  here first.
- **Sort that no leaf can serve** — `… order by w` keeps its `SortNode` above the
  rewritten node. Verify it survives and the rows are correct.
- **Empty key set** — the emitter returns without opening the target. Under the
  merge arm the result is still an empty relation that nominally satisfies any
  ordering. No change needed; assert zero rows.
- **NULL keys on either side** — NULL keys are dropped from the probe set and a
  NULL target key never matches, matching semi-join semantics. Confirm the merge
  arm agrees with the merge join it replaces, including `id in (select …)` where
  the inner yields NULLs.
- **Duplicate keys in the key source** — the probe set dedups; the seek issues
  one window per distinct key. Row output must be identical to the merge join's.
- **Isolation layer** — a stamped multi-seek flows through `quereus-isolation`'s
  merge, which assumes the underlying stream arrives in index-key order (see
  `packages/quereus-isolation/test/key-set-seek-merge.spec.ts`). The new ordering
  claim now *depends* on that merge preserving order, so exercise the merge arm
  with staged inserts, updates and deletes in an open transaction and assert both
  the rows and their order.
- **Persistent store backend** — `quereus-store` declines a runtime-set `IN` on
  its primary key today (`backlog/feat-store-pk-in-list-multiseek`; see the
  `EQ_OPS` / `EQ_OR_IN_OPS` split in `store-module-access-plan.ts`), so the
  headline primary-key shape will keep its merge join there. That is correct, not
  a bug — make sure the `.sqllogic` cases assert *rows*, which must be identical
  on both backends, rather than plan shape, which is not.
- **`delete` / `update` targets** — the headline query is a `delete`. The rewrite
  sits under `Delete` → `ConstraintCheck` → `UpdateExecutor`; confirm the deleted
  row set is exactly right and that `returning` still works.
- **Anti joins** — `not in` / `not exists` plan as merge *anti* joins on this
  shape. The rule gates on `joinType === 'semi'`; assert an anti merge join is
  left alone (the probe cannot resurrect a row an under-fetching seek missed, and
  for anti a missed row is a *spurious* output row).
- **Residual-carrying merge joins** — `monotonic-merge-join` residualizes
  non-driving equi-pairs, so a `MergeJoinNode` can arrive with
  `residualCondition` set and `equiPairs.length === 1`. The existing gate declines
  on any residual; keep it and cover a two-pair `IN`-style shape.
- **Rebuild stability** — after the rewrite, later PostOptimization rules
  (`monotonic-range-access`) may return a new leaf and rebuild this node through
  `withChildren`. The ordering claim is derived, so it re-derives against the new
  leaf; add a test that the claim survives a rebuild that preserves the access
  path and disappears if the access path changes.

## Expected results

- `delete from big where id in (select id from small)` on the memory backend
  reads only the matching rows of `big` when the set is small — observable as a
  `plan=5;inCount=<K>` `idxStr` on `big`'s `query()` through
  `IdxStrCapturingModule`, and a target row count of `K` rather than `N`.
- `select id from big where id in (select id from small) order by id` plans with
  a `KeySetSemiJoinNode`, **no** `SortNode`, and returns ascending rows.
- Every `.sqllogic` case produces byte-identical results on the memory and store
  backends despite the different plans.

## TODO

### Phase 1 — the ordering claim

- Add `seekPreservesTargetOrder(target, pushdown)` next to
  `KeySetSemiJoinNode` (exported), with the five clauses above and a comment
  carrying the subsequence argument.
- Make `KeySetSemiJoinNode.computePhysical` propagate `ordering` and
  `monotonicOn` from the target's physical properties when the predicate holds;
  keep `accessCapabilities` dropped. Surface `preservesTargetOrder` in
  `getLogicalAttributes`.
- Unit-test the predicate directly over synthetic `(leaf, pushdown)` pairs:
  matching index, mismatched index, composite index, ascending vs descending
  agreement and disagreement, `SeqScan` target, non-`scan` access path.
- Existing hash-arm tests must stay green unchanged.

### Phase 2 — the merge anchor

- Move the `orderingLoadBearing` decline out of `admitLeaf` to after
  `planPushdown`, conditioned on `!seekPreservesTargetOrder(leaf, pushdown)`.
- Widen `admitJoin` to `BloomJoinNode | MergeJoinNode`.
- Add the merge-arm-only gates: require `seekPreservesTargetOrder`; decline when
  `node.right.physical?.estimatedRows` exceeds
  `min(pushdown.maxKeys, pushdown.breakEvenKeys)`.
- Register `key-set-seek-merge` on `PlanNodeType.MergeJoin` in `optimizer.ts`,
  immediately after the existing entry, with the placement rationale in the
  comment.

### Phase 3 — tests

- `test/optimizer/key-set-seek.spec.ts`: primary-key `select` / `delete` /
  `update` rewrite; the node's `physical.ordering` and `physical.monotonicOn`
  match what the `MergeJoinNode` claimed before the rewrite; `order by id` plans
  with no Sort; `order by w` keeps its Sort; composite-primary-key decline; anti
  decline; residual decline; key-source-size decline (subclass the counting
  memory module to report a large row estimate, in the style of the existing
  `CostDoctoredModule`).
- `test/vtab/key-set-semi-join-runtime.spec.ts`: through `IdxStrCapturingModule`,
  assert the primary-key merge shape issues `plan=5;inCount=K` on the target and
  pulls `K` rows, and that the emitted order is ascending.
- `packages/quereus-isolation`: extend `key-set-seek-merge.spec.ts` with the
  primary-key merge shape under staged writes; assert rows and order.
- `test/logic/08.4-key-set-semi-join.sqllogic`: primary-key `IN`-subquery
  `select` and `delete`, with `order by` and without, plus duplicate and NULL
  keys — these run on both backends and are the cross-backend equivalence proof.

### Phase 4 — docs and validation

- Update `docs/optimizer-rules.md`, `docs/optimizer-fd.md` and `docs/optimizer.md`
  as described above.
- `yarn build`, `yarn lint`, `yarn test`. Run `yarn test:store` as well — this
  ticket changes which plan the store backend gets for secondary-index merge
  shapes even though the primary-key case still declines there.
