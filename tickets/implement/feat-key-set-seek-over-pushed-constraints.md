---
description: The subquery-driven index lookup currently gives up whenever the same query also filters the table by another indexed column, falling back to reading the whole table. Let the two filters work together instead.
prereq: feat-index-seek-records-pushed-predicate
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/rules/shared/access-leaf.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
difficulty: hard
---

## The gap

`rule-key-set-seek` replaces a semi join over a table scan with a `KeySetSemiJoinNode`,
which materializes the subquery's key set at runtime and — when the set is small —
multi-seeks the target instead of scanning it. It only fires when the target's access leaf
is an *unconstrained every-row walk*:

```sql
delete from big where id in (select id from small)                 -- accelerated
delete from big where status = 'x' and id in (select id from small)
```

The second query is not accelerated when `status` is indexed. The planner has already
turned the scan into a `status` index seek and dropped the `status` predicate from the tree
on the module's promise to enforce it. The rule's `admitLeaf` therefore declines: replacing
that leaf's `FilterInfo` with the key-set multi-seek would silently lose the `status`
filter and return rows that should have been excluded.

(When `status` is *not* indexed the predicate survives as a `Filter` above the leaf, the
rule's peel descends through it, and the acceleration already happens. The gap is specific
to "another indexed column is also filtered".)

## Design

### Keep the seek leaf; re-apply its predicate above the semi join

Do not rebuild the leaf as an unconstrained walk. Admit the `IndexSeekNode` **as the
target, unchanged**, and put a `Filter` carrying its `pushedConstraints` directly above the
new `KeySetSemiJoinNode`:

```
BloomJoin(semi, Project(Filter_user(IndexSeek[status='x'])), keySource)
  →  Project(Filter_user(Filter[status='x'](KeySetSemiJoin(IndexSeek[status='x'], keySource))))
```

This works because `KeySetSemiJoinNode` picks between two runtime branches, and the
rewrite is right for both:

- **Scan branch** (key set too large): `emitSeqScan` runs the leaf's own `FilterInfo`
  untouched, so the `status` seek happens exactly as it does today. The added `Filter` is
  redundant — one extra predicate evaluation per surviving row, no row difference.
- **Seek branch** (key set small): the emitter stamps a `plan=5` multi-seek on the join
  column over the leaf's `FilterInfo`, so the module returns rows by key set and ignores
  `status`. The probe trims non-members; the added `Filter` re-applies `status`. Exact.

The `Filter` goes **directly above the `KeySetSemiJoinNode`**, inside the peeled wrappers —
not above the rebuilt chain. A peeled trivial `Project` may drop columns (`isTrivialProject`
only requires bare column refs, not all of them), and the predicate may name a column the
`Project` does not carry.

Because the scan branch is byte-for-byte today's plan, the rewrite is never a structural
loss — which is what removes the cost question the original ticket flagged. The only cost
question left is the seek-vs-scan threshold, below.

### Fix the break-even baseline

`interpolateBreakEven` currently solves the module's seek-cost line against the module's
**plain full-scan** cost (`probeModuleCosts`' third `ask([])` probe). With a seek leaf the
plan being displaced on the seek branch is not a full scan — it is the `status` seek, which
is far cheaper. Using the scan cost would make seeking look profitable at key counts where
the existing seek already wins.

Replace the third probe with the cost of the plan actually being displaced:

```ts
// The plan the seek branch displaces. A constrained leaf already records the module's
// cost for its own seek; an unconstrained walk has to be asked.
const baselineCost = leaf instanceof IndexSeekNode
	? leaf.filterInfo.indexInfoOutput.estimatedCost
	: ask([]).cost;
```

For an `IndexSeekNode`, `filterInfo.indexInfoOutput.estimatedCost` is `accessPlan.cost`
verbatim — `makeIndexFilterInfo` spreads a base seeded by
`makeFullScanFilterInfo(accessPlan.cost, …)` and never overrides that field. Rename
`interpolateBreakEven`'s `costs.scan` parameter to `baselineCost` accordingly; the existing
arms keep the `ask([])` probe and so keep today's numbers exactly.

Known approximation, worth a `NOTE:` at the site: the comparison charges nothing for the
re-applied predicate's per-row evaluation on the seek branch. It is bounded by the number
of rows the seek returns (≤ key count), so it cannot flip a decision by much.

A `breakEvenKeys < 1` result still declines the whole rewrite, which is now the honest
"the pushed seek beats any key-set seek" answer.

### Gates that must be added for a seek target

`admitLeaf` currently rejects every constrained leaf in one test. Split it: keep today's
acceptance for `SeqScan` / ordering-only `IndexScan`, and add an `IndexSeekNode` arm gated
on all of:

1. **`fi.limit === undefined && fi.offset === undefined`.** A pushed limit/offset is a
   directive the multi-seek would not honour, and unlike a predicate it cannot be
   re-applied by a `Filter` without changing which rows are dropped. (Unreachable today —
   `monotonic-limit-pushdown`'s peel cannot cross a join — but keep the gate.)

2. **`leaf.pushedConstraints` is present and non-empty**, and combining it yields a
   predicate. A seek we cannot describe is a seek we must not displace.

3. **The recorded predicate contains no relational node.** Walk the combined predicate's
   subtree; decline if any child satisfies `isRelationalNode`. This rule runs in
   `PassId.PostOptimization`, so an expression re-inserted here gets no further
   optimization pass — an unphysicalized relational subquery inside it would reach `emit`
   unprepared. Constraint extraction should never produce one, and this gate makes that
   independent of the extractor's behaviour.

4. **The leaf's subtree is not correlated** (`isCorrelatedSubquery(leaf)`, the same test
   `admitJoin` applies to the key source). `rules/join/index-nested-loop.ts` builds
   `IndexSeekNode`s whose seek keys — and therefore whose `pushedConstraints` — reference
   the **outer** side of a nested-loop join. Re-applying such a predicate above the semi
   join would still be *correct*, but the node drains the key source once per outer row,
   turning a linear plan quadratic. Decline.

5. **`leaf.orderingLoadBearing === false`.** `seekPreservesTargetOrder` is false for every
   `IndexSeekNode` (it requires an ordering-only index walk whose index *is* the seek
   index), so a seek target can never reproduce an absorbed `Sort`'s order. This is the
   same doctrine the existing `IndexScanNode` arm applies — one ordering rule, not two —
   and it is why `feat-index-seek-records-pushed-predicate` propagates the flag onto seeks.

The existing type / collation / module-claim / break-even gates are unchanged and apply
to the seek arm identically: they concern the *seek column*, which has nothing to do with
the pushed predicate's column.

### Type and peel changes

- `KeySetTargetNode` (in `key-set-semi-join-node.ts`) becomes
  `SeqScanNode | IndexScanNode | IndexSeekNode`. Update `KeySetSemiJoinNode.withChildren`'s
  `instanceof` guard to match. `seekPreservesTargetOrder` already returns false for a
  non-`IndexScanNode` target — no change, but restate why in its doc.
- `peelToAccessLeaf` in `rules/shared/access-leaf.ts` returns
  `SeqScanNode | IndexScanNode` and must **keep** doing so: `index-nested-loop.ts` shares it
  and relies on an `IndexSeekNode` peeling to `null` (it would otherwise try to re-plan a
  leaf that already has constraints). Add a sibling that includes seeks — e.g.
  `peelToSeekableAccessLeaf` returning `AccessLeafNode | IndexSeekNode` — and implement
  `peelToAccessLeaf` in terms of it by rejecting the seek case. One traversal, two
  admission sets, no behaviour change for the existing caller.

### What does *not* change

- `emitKeySetSemiJoin` and `stampMultiSeek` need no code change. `emitSeqScan` already
  accepts `IndexSeekNode` and already feeds the override hook a `FilterInfo` with the
  seek's `args` resolved. `stampMultiSeek` overwrites `idxStr`, `constraints`, `args`,
  `accessPath`, and every `indexInfoOutput` field a seek differs in — verify this with a
  test rather than by reading (below), and if a field does leak, sanitize inside
  `stampMultiSeek` rather than at the call site.
- The merge-join arm (`key-set-seek-merge`) declines for a seek target via gate 5's
  sibling — `seekPreservesTargetOrder` false — exactly as it does for any leaf that cannot
  reproduce the merge join's propagated order. No new merge behaviour.

### Documentation

Update the decline list in `rule-key-set-seek.ts`'s header comment (it currently names this
ticket as the reason constrained leaves are refused), the `KeySetTargetNode` doc, and the
`key-set-seek` registration comment in `optimizer.ts` ("over a full-scan leaf"). Check
whether `docs/optimizer.md` describes the rule's admission set and update it if so.

## Edge cases & interactions

- **Seek column == pushed column** (`where v = 5 and v in (select id from small)`): the
  key-set seek walks the same index the pushed seek used, and `v = 5` is re-applied above.
  Correct, if pointless; the break-even fix should usually decline it.
- **Row that matches the key set but fails the pushed predicate** must not be emitted. This
  is the whole correctness claim — it needs a runtime test on the *seek* branch
  specifically, not just the scan branch.
- **Row that matches the pushed predicate but is not in the key set** must not be emitted
  (the probe covers this; assert it anyway).
- **Empty key set**: the target is never opened (existing early return). Unchanged, but the
  added `Filter` sits above a node emitting nothing — assert zero rows, no crash.
- **Key set at exactly the break-even count** and **one above it**: the two branches must
  return identical rows. This is the cheapest way to pin that the added `Filter` is right
  on both branches.
- **`COARSER_SAFE` collation leaf**: the seek is already wrapped in a residual `Filter` by
  `rule-select-access-path`, and `pushedConstraints` records the same constraint. The
  rewrite therefore applies it twice. Correct; assert rows, and confirm the peel still
  descends through the pre-existing `Filter`.
- **DELETE / UPDATE targets.** The existing spec covers `delete`/`update` forms; the
  pushed-constraint shape must be covered for both too — a wrongly-dropped predicate here
  deletes rows the user did not ask to delete, which is the worst failure mode this ticket
  can produce.
- **Isolation overlay.** The stamped `accessPath` is `{kind:'index', plan:'multiSeek'}` on
  the pushdown's own index, identical to today, and the emitter still sorts seek keys under
  that index's leading-column collation. The overlay's ascending-merge assumption is
  untouched. No new work, but do not let a "sanitize `stampMultiSeek`" fix disturb it.
- **Store backend.** Whether the rewrite fires depends on what the module advertises
  (`providesOrdering`, `monotonicOn`, `handledFilters`), which differs between the memory
  module and `quereus-store`. Put **plan-shape** assertions in
  `test/optimizer/key-set-seek.spec.ts` (memory only) and put **result-only** cases in
  `test/logic/08.4-key-set-semi-join.sqllogic`, which also runs under `yarn test:store`.
  No plan assertions in the `.sqllogic` file.
- **Memory-module reachability check.** For a single-column secondary index with an
  equality seek, the memory module advertises neither `providesOrdering` (it skips the
  PK-ordering post-pass when a secondary index is used) nor `monotonicOn`
  (`buildMonotonicAdvertisement` returns `{}` when every index column is equality-bound),
  and sort absorption did not run, so `orderingLoadBearing` is false. The motivating query
  therefore fires. A **primary-key** seek does advertise PK ordering but that alone does not
  set `orderingLoadBearing`, so `where pk > 1 and v in (…)` should now fire too — which
  means the existing spec case *"declines when the leaf already carries a pushed
  constraint"* flips from a decline to an acceptance and must be rewritten, not deleted.
  If either of these turns out not to hold when you run it, say so plainly in the handoff
  rather than widening the gates to force it.

## Expected test outcomes

`test/optimizer/key-set-seek.spec.ts` (plan shape, memory module):

- NEW: `select pk from big where s = 'x' and v in (select id from small)` with `s` and `v`
  each singly indexed → exactly one `KeySetSemiJoin`, zero hash joins, the target is the
  `IndexSeek` on `s`'s index, and a `Filter` sits directly between the semi join and its
  parent re-applying `s = 'x'`.
- REWRITE the existing `'declines when the leaf already carries a pushed constraint'` case
  (`where pk > 1 and v in (…)`) into an acceptance case with the same structural
  assertions, and re-point its comment at the new behaviour.
- NEW decline: pushed **limit/offset** on the leaf, if constructible; otherwise state in
  the handoff that the shape is unreachable and the gate is defensive.
- NEW decline: an absorbed-`Sort` seek leaf (`orderingLoadBearing`), if constructible —
  this shares a fixture problem with the prereq ticket; if neither ticket can build one,
  say so once, in this ticket's handoff.
- NEW decline: `breakEvenKeys < 1` — a leaf whose pushed seek is much cheaper than any
  key-set seek keeps the hash semi join. If the memory module's cost model will not produce
  it, note that and move on rather than contriving a module stub.
- EXTEND the `stampMultiSeek` shape-equivalence unit test with an `IndexSeek`-derived base:
  assert the stamped `FilterInfo` is indistinguishable from the literal-IN multi-seek shape
  — no residue in `constraints`, `args`, `idxStr`, `accessPath`,
  `indexInfoOutput.{nConstraint,aConstraint,aConstraintUsage,orderByConsumed}`.

`test/vtab/key-set-semi-join-runtime.spec.ts` (runtime, the correctness core):

- Seek branch forced (tiny key set): a row whose key IS in the set but whose `s` fails the
  pushed predicate must NOT come back. Without the re-applied `Filter` this test fails —
  it is the regression guard for the whole ticket.
- Scan branch forced (key set above break-even): same query, identical rows.
- Scan-count assertion (the spec already has this idiom): the seek branch must read fewer
  target rows than the scan branch for the same query.

`test/logic/08.4-key-set-semi-join.sqllogic` (results, runs under memory and store):

- `select`, `delete`, and `update` forms of `<indexed col> = <value> and <key col> in
  (select …)`, each with a seeded row that matches the key set but fails the extra filter,
  and a row that matches the extra filter but is not in the key set. Both must be absent
  from the result / left untouched by the DML.

Whole-suite: `yarn test` green, `yarn lint` clean. `yarn test:store` is the store-path
check for the `.sqllogic` additions — run it if wall-clock allows; if it would exceed the
runner's idle window, say so in the handoff rather than skipping it silently.

## TODO

### Phase 1 — peel and node types

- Add `peelToSeekableAccessLeaf` to `rules/shared/access-leaf.ts`; re-implement
  `peelToAccessLeaf` on top of it so `index-nested-loop.ts` keeps declining on seeks.
- Widen `KeySetTargetNode` to include `IndexSeekNode`; update
  `KeySetSemiJoinNode.withChildren`'s guard and the type's doc comment.

### Phase 2 — rule

- Split `admitLeaf` into the existing every-row-walk arm and a new `IndexSeekNode` arm
  carrying gates 1–5.
- Thread the combined predicate out of `admitLeaf` (return a small
  `{ leaf, residual?: ScalarPlanNode }` rather than a bare node) using the exported
  `combineResidualExpressions`.
- Replace `probeModuleCosts`' `scan` probe with the displaced-plan baseline; rename
  `interpolateBreakEven`'s parameter and add the approximation `NOTE:`.
- Wrap the new `KeySetSemiJoinNode` in `new FilterNode(leaf.scope, keySetJoin, residual)`
  before `rebuildChain`, only when a residual exists.
- Rewrite the rule header's decline list, the `KeySetTargetNode` doc, the `optimizer.ts`
  registration comment, and `docs/optimizer.md` if it describes the admission set.

### Phase 3 — verify

- Update / add the specs listed above.
- `yarn build`, `yarn test 2>&1 | tee /tmp/t2.log; tail -n 80 /tmp/t2.log`, `yarn lint`.
- Handoff must state: which of the four "if constructible" decline cases you could
  actually build, whether the memory-module reachability claim above held when run, and
  whether `yarn test:store` was run.
