---
description: The subquery-driven index lookup used to give up whenever the same query also filtered the table by another indexed column; now the two filters cooperate — the lookup keeps the other filter's seek as its target and re-applies that filter above the join.
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/rules/shared/access-leaf.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - docs/optimizer.md
  - docs/optimizer-rules.md
  - docs/optimizer-retrieve.md
difficulty: hard
---

## What shipped

`rule-key-set-seek` admits an `IndexSeekNode` as the key-set semi join's target. The
shape `where s = 'x' and v in (select …)`, with both columns indexed, used to decline
outright because replacing the seek's `FilterInfo` at runtime would silently drop the
predicate the module promised to enforce. The seek is now kept as the target unchanged,
and the predicate recorded in its `pushedConstraints` (stamped by the prereq ticket) is
re-applied as a `Filter` directly above the new `KeySetSemiJoinNode`, inside the peeled
wrappers:

```
HashJoin(semi, Project(IndexSeek[s='x']), keySource)
  →  Project(Filter[s='x'](KeySetSemiJoin(IndexSeek[s='x'], keySource)))
```

The runtime's scan branch runs the leaf's own `FilterInfo` untouched — byte-for-byte the
displaced plan, with the added `Filter` redundant — while its seek branch stamps the
multi-seek over it and the `Filter` supplies the predicate the module was never told
about.

### Code

- **`rules/shared/access-leaf.ts`** — new `peelToSeekableAccessLeaf` (admits
  `IndexSeekNode`); `peelToAccessLeaf` re-expressed on top of it by rejecting the seek
  case, so `index-nested-loop` keeps declining on seeks with zero behaviour change.
- **`nodes/key-set-semi-join-node.ts`** — `KeySetTargetNode` widened to include
  `IndexSeekNode`; `withChildren` guard matches. `seekPreservesTargetOrder` is false for
  every seek (no code change — the existing `instanceof IndexScanNode` test already
  returns false), now documented as such.
- **`rules/access/rule-key-set-seek.ts`** — `admitLeaf` split into the unchanged
  every-row-walk arm and `admitSeekLeaf`, carrying five gates: pushed limit/offset,
  non-empty `pushedConstraints` combining to a predicate, no relational node in that
  predicate, uncorrelated subtree, `orderingLoadBearing === false`. The rule wraps the
  new node in a `FilterNode` when a residual exists. `probeModuleCosts`' third probe is
  now the displaced-plan baseline (`filterInfo.indexInfoOutput.estimatedCost` for a seek,
  `ask([])` for a walk — the walk arm's numbers are unchanged).
- **`optimizer.ts`** — `key-set-seek` registration comment.
- **Docs** — `optimizer.md`, `optimizer-rules.md`, `optimizer-retrieve.md`.
- No emit changes: `emitSeqScan` already accepts `IndexSeekNode` and resolves its seek
  keys into `dynamicArgs` before the `FilterInfoOverride` hook runs, and `stampMultiSeek`
  replaces every field the seek base contributed.

### Break-even epsilon (deviation from the plan, kept)

The memory module prices a k-key runtime-set seek and a k-row literal equality seek with
one formula (`AccessPlanBuilder.eqMatch`: `0.5 + 0.3k`), so a pushed single-row equality
baseline lands exactly on the interpolation line at k = 1. Exact arithmetic gives 1;
IEEE `(0.8 − 1.1) / 0.3` gives −1.0000000000000002, so the floor yielded 0 and the rule
declined. `BREAK_EVEN_EPSILON = 1e-9` restores the tie. Verified this pass: it changes
the existing walk arm only at exact ties, where taking the cost-equal seek is harmless.

## Review findings

Read the implement diff (`3aaefd46`) first, then the handoff. Ran `yarn lint` (clean),
`yarn build` (clean), `yarn test` (**8601 passing / 13 pending** in `packages/quereus`,
all other workspaces green) and `yarn test:store` (**8593 passing / 21 pending**;
the `TransactionCoordinator` savepoint warnings are pre-existing store-mode log noise).
No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

### Verified (no defect found)

- **The re-applied predicate cannot be weaker than what the seek enforces.**
  `rule-select-access-path` stamps `pushedConstraints` from the very `consumed` set the
  seek's `FilterInfo` was built from, and re-attaches everything unconsumed as its own
  `Filter` above the leaf. So "the recorded set fully describes the module's promise" is
  structural, not a convention the rule has to trust.
- **The seek baseline cost is real.** `filterInfo.indexInfoOutput.estimatedCost` is
  `accessPlan.cost` verbatim: the base is `makeFullScanFilterInfo(accessPlan.cost, …)`
  and `makeIndexFilterInfo` spreads it without touching that field. Confirmed by reading
  both, not by trusting the comment.
- **Emit path.** `emitSeqScan` populates `args` from the seek-key instruction params
  *before* calling the override hook, and `stampMultiSeek` overwrites `args`,
  `constraints`, `idxStr`, `accessPath` and the `indexInfoOutput` fields any module
  runtime reads. No seek residue reaches the module on the seek branch; the scan branch
  gets the untouched pushed seek.
- **The new `FilterNode` needs no explicit physicalization.** `PlanNode.physical` is a
  lazy post-order fold, so a node minted during PostOptimization computes on first read.
- **Attribute identity.** `KeySetSemiJoinNode.getAttributes()` returns the target's
  attributes unchanged, so the recorded predicate's column references resolve at the
  `Filter` position without renumbering.
- **The relational-node gate works.** Subquery-bearing scalar nodes (`ScalarSubqueryNode`,
  `InNode`, `ExistsNode`) all expose their relational body through `getChildren()`, which
  is what the gate walks.
- **Widening `KeySetTargetNode` breaks no consumer.** The only other places that name the
  node (`planner/mutation/propagate.ts`, the materialized-view analysis allow-list) switch
  on `PlanNodeType`, not on the target's class.
- **The epsilon is tie restoration, not gate widening.** Reproduced the exact float:
  without it the motivating query declines at a genuine cost tie; with it the tie is
  accepted. Every pre-existing break-even test passes unchanged.
- **The worst-case cost shape does not reach the rule.** `where pk = <lit> and v in
  (select …)` — where the displaced plan reads one row and a key-set seek could read a
  whole non-unique index window — never arrives as a hash semi join: it plans as an
  index-nested-loop over a correlated seek, which this rule does not anchor on. Checked
  by planning it.
- **Gate 4 (correlated seek leaf) is genuinely unreachable from SQL today**, independently
  of the implementer's report: `index-nested-loop` peels only Alias / trivial Project /
  Filter, so it cannot reach an access leaf through a semi-join subtree, and a semi join
  therefore never sees an `index-nested-loop`-minted seek on its probe side. Gate 1
  (pushed limit/offset) is unreachable for the reason the handoff gives. Both stay as
  cheap defensive checks; neither warrants a ticket.

### Fixed in this pass (minor)

- **DRY** — `containsRelationalNode` was an exact re-implementation of the existing
  `hasRelationalDescendant` (`planner/analysis/scalar-subqueries.ts`), same semantics
  including "root excluded". Deleted the local copy, imported the shared helper.
- **Test gap** — every case the implementer added exercised a *single* pushed constraint,
  so `combineResidualExpressions`' AND-combining path and its identity de-duplication
  were both unreached through this rule. Added two cases to
  `test/optimizer/key-set-seek.spec.ts`:
  - `pk > 1 and pk < 4 and v in (…)` — two recorded constraints, predicate arrives as a
    `BinaryOpNode`, and the key set deliberately reaches outside the range so the seek
    branch returns two rows that only the re-applied AND rejects. A strictly stronger
    regression guard than the single-constraint cases.
  - `pk between 2 and 4 and v in (…)` — both constraints share one `sourceExpression`,
    so the de-duplication must yield the single `BetweenNode`, not a doubled predicate.
  Both were verified to work before being written as tests; they pass in memory and
  store mode.
- **Readability** — the seek-leaf entry in the rule header's decline list was a 12-line
  run-on sentence with five comma-separated clauses. Split into five sub-bullets matching
  the five gates.

### Tripwire (recorded, not ticketed)

- With stock memory-module costs an equality-pushed seek target always lands on
  `breakEvenKeys === 1`, so the plan is rewritten but the runtime seek branch fires only
  for a one-key set. That is the module's own verdict — it prices both seeks off the
  seek-key count and knows nothing of how many rows each window holds — and a module that
  prices an equality seek from matched rows (the store does) produces a break-even that
  discriminates. Parked as a `NOTE:` on `BREAK_EVEN_EPSILON` in
  `rules/access/rule-key-set-seek.ts`, the site where the next reader will meet it.

### Checked and clean, with reasons

- **Docs** — read all three changed files plus the sections they cross-reference. The
  `optimizer.md` IN-pipeline paragraph, the `optimizer-rules.md` rule bullet (seek-arm
  gates and the seek-baseline break-even) and the `optimizer-retrieve.md` provenance
  paragraph all match the shipped code. No doc that *should* have changed was missed:
  nothing else in `docs/` describes the key-set rewrite or `pushedConstraints`.
- **Source hygiene** — `rule-key-set-seek.ts` is 638 lines, mid-pack among the rule files
  (`rule-select-access-path.ts` is 1620), so no size finding. Functions are short and
  single-purpose; `admitSeekLeaf` is one gate per guarded return.
- **Resource cleanup / error handling** — unchanged surface. The rule adds no I/O; the
  module probes stay inside the existing `try` that logs and declines rather than failing
  the query.
- **Major findings: none.** No new `fix/`, `plan/` or `backlog/` tickets were filed —
  every finding was either fixed inline or is a conditional recorded as the tripwire
  above.
