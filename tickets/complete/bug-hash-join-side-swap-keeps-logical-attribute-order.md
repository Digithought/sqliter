---
description: A hash join that internally reverses which of its two inputs it processes first now also reports its output columns in that reversed order, so grouped queries above it stop reading the wrong column and return correct totals. Tests and docs pin the rule.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # the fix, in the INNER build/probe swap branch
  - packages/quereus/test/optimizer/hash-join-side-swap.spec.ts               # plan-level invariant: swapped, unswapped, merge, three-table spine
  - packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic             # row equality
  - docs/optimizer-joins.md                                                   # § Bloom (Hash) Join → "Row layout invariant" bullet
  - packages/quereus/src/runtime/emit/bloom-join.ts                           # the emitter the invariant is stated against
  - packages/quereus/src/runtime/emit/hash-aggregate.ts                       # the consumer that surfaced the bug
---

# Hash join side swap now permutes the preserved attributes

## What shipped

One behavioural change, in the INNER-join build/probe swap branch of
`ruleJoinPhysicalSelection`. When the branch flips `probeSource` / `buildSource` and the
equi-pair directions, it now permutes the preserved attribute list with them:

```ts
hashAttrs = [
    ...preserveAttrs.slice(leftAttrs.length),
    ...preserveAttrs.slice(0, leftAttrs.length),
];
```

Same attribute ids, new order. `preserveAttributeIds` only ever promised id stability,
never position stability, so nothing above the join is disturbed — consumers up there
resolve by id, and `select *` is expanded into an explicit `ProjectNode` at build time,
before optimization.

The invariant it restores, in one line:

> A physical join's advertised attribute order **is** its emitted row layout —
> `join.getAttributes()` equals `[...join.left.getAttributes(), ...join.right.getAttributes()]`
> by id, in order.

`getAttributes()` was the last thing on a swapped `BloomJoinNode` still speaking logical
order; `getType()`, `combineJoinKeys` and `computePhysical`'s FD shift were already
probe-then-build.

Non-behavioural, from the implement stage: an invariant comment at the swap site, a
`NOTE:` at the `MergeJoinNode` construction site recording why merge takes
`preserveAttrs` unpermuted, and a "Row layout invariant" bullet plus a side-effect-refusal
clause in `docs/optimizer-joins.md` § Bloom (Hash) Join.

## Validation

- `yarn lint`: clean.
- `yarn test`: **8608 passing, 0 failing, 13 pending** across all workspaces (8607 at the
  end of implement, plus the one spec added in review).
- End-to-end re-check of the original wrong answer, on a plan confirmed to swap:
  `select s.k, sum(b.v) … group by s.k` returns `[{gk:1,sv:40},{gk:2,sv:32}]`.
- `yarn test:store` still **not** run — it is the slow leg and outside the agent-runnable
  window. Unchanged deferral from implement; see Review findings for why the new file is
  expected to hold there.

## Review findings

### Correctness of the fix — checked, no defects found

- **The invariant against every other index-speaking part of `BloomJoinNode`.**
  `getType()` builds from `this.left` / `this.right` via `buildJoinRelationType`;
  `combineJoinKeys` and `computePhysical` take `leftAttrs.length` from `this.left` and
  feed it to `analyzeJoinKeyCoverage` / `propagateJoinFds` / `propagateJoinInds`. All read
  the physical children, so all agree with the permuted attributes. No second site needed
  the same edit.
- **Residual condition evaluation.** `emitBloomJoin` installs two separate per-side row
  slots built from each child's own attributes, so the residual resolves by attribute id
  within a side. Unaffected by the swap in either direction — it was never part of the
  bug and is not part of the fix.
- **Every other physical-join construction site.** `rule-monotonic-merge-join` builds a
  `MergeJoinNode` over the logical children with no swap. `BloomJoinNode.withChildren` /
  `MergeJoinNode.withChildren` carry `preserveAttributeIds` forward but never reorder
  children. `NestedLoopJoinNode` is never constructed — a plain nested loop is the
  surviving logical `JoinNode`.
- **The two logical join-reorder rules.** `rule-join-greedy-commute` and
  `rule-quickpick-enumeration` both swap or reorder join children, and both construct a
  fresh `JoinNode` with **no** preserved attribute list — so their attributes derive from
  the new child order and already satisfied the invariant. Independent evidence that the
  contract this fix adopts is the one the rest of the planner already assumes, not a
  second instance of the same bug.
- **The load-bearing "`select *` does not move" claim, verified rather than reasoned.**
  On a plan confirmed to swap, `select * from s join b on b.k = s.k` returns columns in
  the order `s.id, s.k, b.id, b.k, b.v` — logical left then right. The build-time
  `ProjectNode` expansion holds.

### Fixed inline (minor)

- **The merge-join `NOTE:` added by the diff claimed something nothing tested.** It
  asserts merge is consistent *because* it never swaps. Added a sixth spec case to
  `hash-join-side-swap.spec.ts`: a primary-key join (both inputs already ordered on the
  equi-pair, so merge wins outright), asserting exactly one `MergeJoinNode`, that its left
  side is the logical left, and that the same advertised-order-is-row-layout equality
  holds. The helper and `collectNodes` predicate were widened to cover both physical join
  node types.
- **The permutation's unstated precondition.** `preserveAttrs.slice(leftAttrs.length)`
  assumes `preserveAttrs` is exactly left++right. That is true, and guaranteed by the
  `joinType === 'inner'` test on the branch plus the `hasExistenceColumns` early return
  above it — an existence join appends flag attributes *after* both sides and would need
  them left in place. Added that sentence to the comment rather than a runtime guard: the
  guard would be unreachable, and the gates are what a future editor adding existence
  support needs to read.
- **The sqllogic file can silently stop testing anything.** Every assertion in it is row
  equality, so if a cost constant moves and the swap stops firing, the file keeps passing
  while covering nothing. Added a header `NOTE:` naming the spec's "swap fired" assertion
  as the canary and instructing a future editor to widen the row counts in *both* files,
  not just the one that went red. This is where the implement stage's "cost-model
  fragility of the fixture" concern is parked — the decision is to keep row equality and
  plan shape in their conventional files (matching `11.3-index-nested-loop-join.sqllogic`)
  and make the coupling explicit instead.

### Filed as new tickets — none

No major finding surfaced. The two follow-ups this work produced were both filed during
implement and remain correct as filed:
`tickets/fix/bug-analyze-via-exec-is-a-no-op.md` (reviewed: verified repro, root cause
named at one site, the open decision correctly routed as a choice for the implementer to
state rather than a silent pick) and
`tickets/backlog/debt-physical-node-row-layout-matches-attributes.md`.

The latter was explicitly waiting on which direction this fix took. It has been updated
in place: `prereq:` removed, and a "The direction is now settled" section added stating
the invariant to assert and noting that the new spec covers it only at plan level, for
`BloomJoinNode` / `MergeJoinNode`. It is now unblocked.

### Gaps left open, with reasons

- **The swap's side-effect refusal is untested.** The gate
  (`subtreeHasSideEffects` on either subtree) is pre-existing code that this diff newly
  documented; `parallel-side-effect-refusal.spec.ts` covers the same characteristic API
  for `AsyncGather` and `EagerPrefetch`, but nothing covers this call site. Not closed
  because the shape is not deterministically constructible: it needs a join side carrying
  a write that is *also* the smaller side under live statistics, and a DML subquery does
  not report an analyzable row count. Failure mode if it ever regressed is reordered
  writes plus a lost refusal, not wrong rows. Not filed — it is a pre-existing coverage
  gap on a refusal path, and filing single-missing-test tickets is not worth the board
  depth.
- **`yarn test:store` not run.** The new sqllogic file is pure row equality, and its
  `ANALYZE` assertions check the engine's own `[table, rowCount]` yield (emitted only on
  successful collection, per `runtime/emit/analyze.ts`), which is module-independent — so
  it is expected to hold. That is an expectation, not a measurement; worth a human or CI
  run.
- **`preserveAttrs` is arguably redundant on the hash path now.** For an inner join the
  permuted list is exactly what `buildJoinAttributes` would compute from the swapped
  children given no preserved list at all. Left alone: the explicit list carries the
  logical node's own attribute objects and keeps the hash and merge paths the same shape.
  An observation, not a defect.

### Source hygiene

`rule-join-physical-selection.ts` is 312 lines with a ~240-line rule function, and the
comment-to-code ratio in the swap branch is high — but both are pre-existing properties of
the file, and the density matches every other branch in it. Not changed; changing it here
would bury a five-line behavioural fix in a refactor diff.
