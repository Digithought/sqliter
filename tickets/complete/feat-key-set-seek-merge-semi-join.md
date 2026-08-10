---
description: When a query filters a table by a set of values on its primary key, the engine used to read every row of the big table; it now collects the small set first and looks up only the rows it needs, while still returning them in the right order.
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts
  - docs/optimizer-rules.md
  - docs/optimizer-fd.md
  - docs/optimizer-joins.md
  - docs/optimizer.md
---

# Complete: key-set seek rewrite extended to merge semi joins

## What shipped

`where pk in (select …)` on a table's primary key plans as a **merge** semi
join (both sides walk their primary key), so the existing `rule-key-set-seek` —
anchored on the hash semi join only — never saw the most common IN-subquery
shape and the big table was read in full. Now:

- **`seekPreservesTargetOrder(target, pushdown)`** — an exported predicate next
  to `KeySetSemiJoinNode`. True when the multi-seek's index IS the index the
  target leaf walks (single key column, leaf's advertised order matching that
  key column's direction). Under it both runtime branches — untouched walk and
  multi-seek — emit in the leaf's own key order, because a seek emits a
  subsequence of the walk and a subsequence of an ordered stream is still
  ordered.
- **`KeySetSemiJoinNode.computePhysical`** claims the target's `ordering` and
  `monotonicOn` when that predicate holds, derived per call rather than stored,
  so a leaf rebuilt through `withChildren` cannot leave a stale claim.
  `accessCapabilities` stays dropped. `preservesTargetOrder` shows in EXPLAIN.
- **The `orderingLoadBearing` decline moved** out of `admitLeaf` to after
  `planPushdown` and is now conditioned on `!seekPreservesTargetOrder`, so an
  `order by pk` the walk absorbed no longer blocks the rewrite.
- **`admitJoin` widened** to `BloomJoinNode | MergeJoinNode`, with two
  merge-only gates: the order-preservation predicate must hold, and the key
  source's physical row estimate must not exceed
  `min(pushdown.maxKeys, pushdown.breakEvenKeys)`.
- **New registry entry `key-set-seek-merge`** on `PlanNodeType.MergeJoin` in
  `optimizer.ts`, right after `key-set-seek`.
- Docs updated: `optimizer-rules.md`, `optimizer-fd.md`, `optimizer.md`, and
  (added in review) `optimizer-joins.md`.

## Review findings

Read the implement diff first, then the source, the runtime emitter, the
`MergeJoinNode` / `IndexScanNode` / `access-leaf` code it depends on, and every
doc that mentions the rule. Ran `yarn build`, `yarn lint`, `yarn test`, plus
ad-hoc plan-shape probes over a dozen query shapes the tests did not cover.

### Correctness — nothing found; here is what was actually checked

- **The ordering claim itself.** `seekPreservesTargetOrder` reads
  `IndexScanNode.providesOrdering`, while `computePhysical` claims
  `targetPhysical.ordering`. Confirmed these cannot diverge:
  `IndexScanNode.computePhysical` sets `ordering: this.providesOrdering` and the
  only thing spread over it (`liftAdvertisement`) returns just `monotonicOn` /
  `accessCapabilities`.
- **Reverse index walks.** `IndexDescriptor.reverse` models "this scan walks the
  index backwards". A reversed walk cannot slip past the predicate, because
  `providesOrdering` comes straight from the module's own `providesOrdering`
  claim, so its direction always disagrees with the key column's under a
  reversal — which is exactly the clause the predicate tests. No shipped module
  sets `reverse` on a scan path today; the only reader is
  `quereus-isolation/src/isolated-table.ts`. Left as-is; the predicate's doc
  comment already names this case.
- **`monotonicOn` on a column other than the seek column.** Safe for the same
  subsequence reason, strictness included — dropping rows cannot create a tie.
- **The rebuilt chain.** `rebuildChain` re-roots the peeled `Alias` / trivial
  `Project` / `Filter` above the new node, so the ordering the plan sees at the
  top is those wrappers applied to the leaf's ordering — identical to what the
  merge join produced, since `ProjectNode` remaps ordering column indices and
  `Filter` / `Alias` pass it through. Now pinned by a new test.
- **`preserveAttributeIds`.** Both merge-join producers pass the logical
  `JoinNode`'s attributes, which for `semi` are the left side's — the same set
  `KeySetSemiJoinNode` plus the rebuilt chain produces. No divergence.
- **The registry claim that nothing else anchors on `MergeJoin`.** Verified:
  `PlanNodeType.MergeJoin` appears exactly once in `RULE_MANIFEST`.
- **`index-nested-loop.ts` has its own `orderingLoadBearing` check**, so moving
  the one in `admitLeaf` did not weaken it.
- **Shapes probed by hand, all correct rows and correct order**: `LIMIT` above
  the rewrite; a `WHERE` conjunct peeled into the chain; `distinct`; `order by
  pk desc` over an ascending pk; a second `IN` in the same predicate; a view; a
  CTE key source; a `union` key source; a `group by` key source; a key source
  carrying its own `ORDER BY`; `not in`.

### Minor — fixed in this pass

- **Stale comments the merge arm invalidated.** `KeySetTargetNode`'s doc still
  claimed emission order was "a property nothing above the hash semi join this
  node replaces could have depended on"; `stampMultiSeek`'s `orderByConsumed`
  comment justified clearing the flag with the same now-false premise; three
  more sites said the rule "keeps the hash semi join" on decline. All rewritten
  to the new reality (and `orderByConsumed` re-justified on what is actually
  true: nothing reads it, and direction rides `idxStr` / `accessPath`).
- **"Provably cannot fire" overstated the key-source-size gate.** The gate
  compares an advisory row estimate against a threshold the runtime applies to
  *distinct non-null* keys, so a duplicate-heavy key source can be declined and
  still have seeked. Softened in the rule's header, the inline comment, and
  `docs/optimizer-rules.md`; it is a heuristic in both directions and costs an
  optimization, never a row.
- **`docs/optimizer-joins.md` § Merge Join was never updated** — a reader there
  had no way to learn its semi form can now be rewritten away entirely. Added a
  bullet.
- **Comment reflow** left a mangled paragraph in `admitLeaf`'s doc. Tidied.

### Tests added in review (3, all passing)

The implementer's suite was strong; these close the interaction gaps it left.

- The ordering claim survives the **rebuilt chain** — `and w > 2` peels a
  `Filter` that `rebuildChain` re-roots above the node, and the absorbed
  `order by pk` must still be served with no `Sort`.
- A **`LIMIT` riding the claim** returns the two smallest matching keys, not an
  arbitrary two, with no `Sort` in the plan.
- **`order by pk desc` over an ascending pk** keeps its `Sort` and emits
  descending rows — the end-to-end complement of the synthetic
  direction-mismatch unit test.

### Tripwires recorded (not tickets)

- **Self-cost on the merge arm.** `KeySetSemiJoinNode` charges `hashJoinCost`
  while the `MergeJoinNode` it replaces charged `mergeJoinCost` — 0.8·keys +
  0.4·target vs 0.3·(target+keys), bounded at about 1.33× for a large target.
  Nothing behind PostOptimization's `impl` phase makes a keep-or-drop decision
  on that number today. Parked as a `NOTE:` at the constructor in
  `key-set-semi-join-node.ts`.

### Major — none

No finding warranted a new ticket. The gaps the implementer flagged honestly
(NULL keys unreachable through the merge arm; `not in` never forming an anti
join; ties on a non-unique seek index unconstrained by the claim; the
cost-model-coupled size-decline test) were re-checked and are all accurate
descriptions of structurally unreachable or deliberately-unconstrained
territory, not latent defects.

### Deliberately not pursued

- Sort absorption does not fire through an `Alias`, so
  `select pk from big as b where b.pk in (…) order by b.pk` keeps a `Sort` the
  claim could have served. Pre-existing and unrelated to this diff — the merge
  join left the same `Sort` there before the rewrite existed.
- A merge join whose key source carries an optimizer-inserted `Sort` would keep
  that now-pointless sort after the rewrite. Unreachable in practice: the sort
  cost is inside the merge candidate's own cost, and `monotonic-merge-join`
  never inserts sorts, so the shape does not plan.

## Validation

- `yarn build` (full monorepo) — clean.
- `yarn lint` (root fan-out; quereus eslint + test-file tsc) — clean.
- `yarn test` (root, all workspaces) — quereus **8577 passing / 13 pending /
  0 failing** (8574 → 8577 with the three review tests); isolation 374 passing;
  every other package green.
- `yarn docs:check` fails on `docs/schema.md`'s word-count ratchet. Pre-existing
  and already tracked as `debt-doc-size-ratchet-red-at-head` in
  `tickets/.pre-existing-known.md`; untouched by this ticket, and the two docs
  this pass edited stay under their own ratchets.
- `yarn test:store` was **not** re-run in review. The implementer ran it green
  (8565 passing / 0 failing) at this commit, and the review diff adds no runtime
  behavior — comments, docs, and three memory-backend optimizer tests.
