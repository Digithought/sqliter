---
description: A WHERE condition that only mentions one of the joined tables is applied after the join instead of before it, so both tables get read in full even when the condition would have narrowed one of them to a handful of rows via an index. Add an optimizer rule that moves such conditions below the join.
files:
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts   # NEW — the rule
  - packages/quereus/src/planner/optimizer.ts                                      # manifest registration
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts        # header comment lists Join as a non-move — update
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts # closest structural precedent (split-and-partition rule)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts # precedent for injecting branch Filters below a JoinNode
  - packages/quereus/src/planner/nodes/join-node.ts                                # JoinNode, JoinType, withChildren, existence specs
  - packages/quereus/src/planner/nodes/join-utils.ts                               # buildJoinAttributes — which side is null-extended per join type
  - packages/quereus/src/planner/analysis/predicate-conjuncts.ts                    # splitConjuncts / combineConjuncts
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts                   # normalizePredicate
  - packages/quereus/src/planner/framework/characteristics.ts                       # subtreeHasSideEffects, isFunctional
  - packages/quereus/test/optimizer/rule-join-predicate-pushdown.spec.ts            # NEW — unit spec
  - packages/quereus/test/plan/joins/simple-join.plan.json                          # golden plan WILL change
  - packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic                 # outer-join semantics guard
  - docs/optimizer-rules.md                                                         # rule catalogue entry
  - docs/optimizer.md                                                               # § "Filters over a join" claims pushdown never crosses a join
difficulty: medium
---

# Push single-table WHERE conjuncts below a join

## Problem, confirmed at HEAD

`rule-predicate-pushdown` slides a `Filter` across `Sort`, `Distinct`, `Alias`, eligible
`Project`, and into a `Retrieve` boundary. Its header lists `Join` under "Non-moves
(requires deeper analysis)" and `tryPushDown` falls through to `return null` for it. So a
conjunct mentioning only one side of a join is evaluated on the join's *output*.

Measured on this repo at HEAD (memory module, `idx_entry_account` on `entry(account_id)`,
plan read out of `query_plan()`):

```sql
select e.id, e.amount, t.date
from entry e join txn t on t.id = e.txn_id
where e.account_id = 'a3'
order by t.date
```

```
SORT → PROJECT → FILTER(e.account_id = 'a3')
                   └── HASHJOIN
                         ├── ALIAS e → INDEXSCAN entry USING _primary_
                         └── ALIAS t → INDEXSCAN txn   USING _primary_
```

Both base tables are scanned end to end. The same predicate on the table alone plans as
`ALIAS e → INDEXSEEK entry USING idx_entry_account`. So the index exists, the access-path
rule would use it, and the only thing standing between the two plans is that the conjunct
never reaches the `entry` branch.

The 4-way reporting query recorded in `.tmp/quereus-join-perf.md` has the same shape:
`where a.entity_id = ? and t.date <= ?` sits above three joins, so all four base tables are
fully scanned.

This is a constant-factor cost, not a complexity-class one. It matters because on a
persistent store every base-table row read is real I/O.

## Design

Add a **new rule** rather than extending `rule-predicate-pushdown`. That rule's shape is
"slide one Filter past one commuting node"; the join case is "split a predicate and
distribute the parts", which is exactly the shape `rule-aggregate-predicate-pushdown`
already has. Keeping them separate leaves `tryPushDown` single-purpose and gives the join
case its own disable switch.

### File and registration

New file `packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts`
exporting `ruleJoinPredicatePushdown`. Manifest entry in `planner/optimizer.ts`, placed
**between** `aggregate-predicate-pushdown` and `predicate-pushdown`:

```ts
{
    pass: PassId.Structural,
    id: 'join-predicate-pushdown',
    nodeType: PlanNodeType.Filter,
    phase: 'rewrite',
    fn: ruleJoinPredicatePushdown,
    // Moves Filter conjuncts below a Join, changing which rows reach each
    // branch. Refuses per-branch when that branch's subtree carries a write.
    sideEffectMode: 'aware',
},
```

Position rationale: pass rules fire in registration order within one top-down sweep, so a
conjunct dropped onto a branch here is picked up by `predicate-pushdown` — which already
knows how to cross the `AliasNode` each join branch carries and land the predicate inside
the branch's `Retrieve` — either later in the same sweep or on the Structural pass's next
fixed-point iteration.

### Which side may receive a conjunct

Read straight off `buildJoinAttributes` (`nodes/join-utils.ts`): a side is safe to receive
a conjunct exactly when that side's columns are **never null-extended** in the output —
filtering it before the join then removes precisely the output rows the conjunct would have
removed after it.

| `joinType` | null-extended side | conjuncts pushable to |
|---|---|---|
| `inner` | neither | left and right |
| `cross` | neither | left and right |
| `left`  | right | left only |
| `right` | left | right only |
| `full`  | both | neither — rule declines |
| `semi`  | n/a (output is left columns) | left only |
| `anti`  | n/a (output is left columns) | left only |

For `semi`/`anti` the point is moot in practice: `buildJoinAttributes` returns only the left
attributes, so a Filter above such a join cannot reference a right column at all. Encode
left-only anyway so the table is exhaustive and the reasoning is local.

### Attribution

Attribute ids are minted per node instance and are stable across the rewrites in this pass,
so side membership is a plain set test — a self-join's two `TableReferenceNode`s carry
distinct ids, and a join's existence-flag (`exists … as`) ids are in neither side's set, so
a conjunct over a flag falls out as un-pushable with no special case.

For each conjunct, collect the attribute ids of **every** `ColumnReferenceNode` in its whole
subtree, *descending through relational children too* (unlike
`rule-aggregate-predicate-pushdown`'s `walkScalar`, which stops at relational nodes). That
descent is load-bearing: a correlated subquery conjunct such as
`exists (select 1 from x where x.a = e.id and x.b = t.id)` has *no* top-level column
reference to `t`, so a scalar-only walk would attribute it to the left side and push it
somewhere `t.id` does not resolve. Descending sees `x`'s own attribute ids as well, which
belong to neither side — so any conjunct carrying a subquery is simply not pushed. That is
conservative (an uncorrelated `e.a = (select max(v) from x)` is also declined) and correct;
widening it is out of scope.

A conjunct with **no** column references at all (`where 1 = 1`, `where :p > 0`) is left
above — pushing it duplicates nothing useful and would make the rule fire on plans it should
leave alone.

### Refusals

- **Non-functional conjunct.** Skip any conjunct where
  `PlanNodeCharacteristics.isFunctional(conjunct)` is false (`deterministic && readonly`;
  both propagate as AND-of-children through `computePhysical`, so this is a whole-subtree
  test). Moving `random() < e.amount` below the join changes how many times it is evaluated.
- **Side-effect-bearing branch.** Before wrapping a branch, check
  `PlanNodeCharacteristics.subtreeHasSideEffects(branch)`; if true, return that branch's
  conjuncts to the residual set rather than declining the whole rewrite (the other branch
  may still be pushable). Same discipline as `tryBranchInjection` in
  `rule-predicate-inference-equivalence`, which refuses outright — per-branch is strictly
  better here and costs nothing.

### Move, do not copy

A pushed conjunct is **removed** from the predicate above. Leaving a redundant copy above
would re-evaluate it per output row for no gain, and — more importantly — would make the
rule non-idempotent: it would find the same pushable conjunct on every visit and rebuild the
plan forever. With a move, a re-visit of the residual Filter finds nothing pushable and
returns `null`, which is the termination argument.

Cardinality estimation does lose the conjunct at the Filter above the join, but it gains it
on the branch, where `rule-filter-selectivity`'s single-table path estimates it *better*
(see `docs/optimizer.md` § "Filters over a join": the multi-relation path exists precisely
because these conjuncts could not be attributed to one relation before).

### Rewrite

No column-index rewriting is needed. A WHERE-clause reference to a join-side column is built
through `registerColumnScope` (`planner/building/select.ts`), which registers each FROM
item's columns under that item's **own** column indices; `buildJoin` then exposes the two
sides through a `MultiScope` without re-indexing. So `ColumnReferenceNode.columnIndex` in the
Filter's predicate is already branch-local, and the runtime resolves by `attributeId`
regardless (`runtime/emit/column-reference.ts`). Move the conjunct nodes verbatim.

Rebuild the join with `join.withChildren([newLeft, newRight, join.condition])` (2 children
when `condition` is undefined) rather than `new JoinNode(...)` — `withChildren` threads
`existence` and `usingColumns` through, which a hand-rolled construction is easy to drop.

### Sketch

```ts
export function ruleJoinPredicatePushdown(node: PlanNode, _ctx: OptContext): PlanNode | null {
    if (!(node instanceof FilterNode)) return null;
    const join = node.source;
    if (!(join instanceof JoinNode)) return null;

    const sides = pushableSides(join.joinType);          // per the table above
    if (sides.size === 0) return null;

    const leftIds  = new Set(join.left.getAttributes().map(a => a.id));
    const rightIds = new Set(join.right.getAttributes().map(a => a.id));

    const conjuncts = splitConjuncts(normalizePredicate(node.predicate));
    // → partition into leftPush / rightPush / residual
    // → per-branch side-effect refusal moves a branch's conjuncts back to residual
    // → nothing pushed ⇒ return null
    // → wrap branches in FilterNode(branch.scope, branch, combineConjuncts(part)!)
    // → newJoin = join.withChildren([...]);
    // → residual.length ? new FilterNode(node.scope, newJoin, combineConjuncts(residual)!) : newJoin
}
```

## Edge cases & interactions

Each of these should be a case in the spec, not just a thought.

- **`left join` with a WHERE on the null-extended side.** `left join t on … where t.date > 'x'`
  must NOT push — pushing keeps null-padded rows that the outer filter drops. Guarded by
  `test/logic/26.2-left-join-on-vs-where.sqllogic`; add a plan-shape assertion too, since a
  results-only test would pass under a wrong-but-lucky data set.
- **`right join` mirror image**, and **`full join` pushes nothing**. `test/logic/90.5.1-right-full-join-read.sqllogic`
  covers the results side.
- **Existence flags.** `join … exists right as m where m` — the flag's attribute id is in
  neither branch's set, so the conjunct stays above. Also verify the rebuilt join still
  carries its `existence` specs (this is what `withChildren` buys); a dropped spec strands
  every upstream reference to the flag's attribute id.
- **Join elimination interaction.** `ruleJoinElimination` may drop a non-preserved side only
  when that side is an unwrapped row-preserving path (`TableReference` / bare `Retrieve` /
  `Alias` / `Sort`). Before this change, `select l.* from l join r on … where r.flag = 1` was
  protected because `r.flag` was demanded above the join; after this change it is protected
  because the `r` branch is now a `Filter`, which is not in that whitelist. Both paths decline
  — assert it, because the reason changed and a future relaxation of the whitelist would turn
  this into a wrong-results bug.
- **Correlated subquery conjunct** (`exists (select 1 from x where x.a = e.id and x.b = t.id)`)
  stays above. This is the case the relational-descent walk exists for.
- **Non-deterministic conjunct** (`random() < e.amount`) stays above.
- **Constant / parameter-only conjunct** (`where :p > 0`) stays above; the rule returns `null`
  when it is the only conjunct.
- **Both sides pushable** (`where e.a = 1 and t.d = 2`) — a Filter lands on each branch and
  **no** Filter survives above the join.
- **Mixed** (`where e.a = 1 and e.x > t.y`) — one branch Filter, cross-side conjunct residual
  above.
- **Idempotence / termination.** Re-running the optimizer on an already-pushed plan must be a
  fixed point. Assert the rule returns `null` on the residual shape (or that a second
  `optimize()` produces an identical plan).
- **Side-effect branch.** A branch whose subtree carries a write keeps its conjuncts above
  while the *other* branch still receives its own.
- **`cross join`** (no `condition`) — `withChildren` gets 2 children, not 3.
- **Lateral join.** `buildJoin` correlates the right side to the left; a conjunct over the
  right side's *output* attributes is still safe to push, and `JoinNode` carries no lateral
  flag to consult. Add a lateral case so this is pinned rather than assumed.
- **Branch already committed to an index-style access path.** The branch Filter lands above
  the `Alias`/`Retrieve`; `rule-predicate-pushdown`'s `isIndexStyleContext` guard (invariant
  OPT-023) then decides whether it enters the pipeline. Nothing new is required here — but a
  case where the branch already has a committed seek should confirm the conjunct is not
  silently dropped.

## Explicitly out of scope

- **Pushing `ON`-clause conjuncts.** A single-side conjunct in the `ON` clause of an inner
  join is pushable by the same argument, and — for outer joins — a conjunct on the
  *null-extended* side is pushable from `ON` (the mirror image of the WHERE rule). Parked as
  `backlog/feat-join-on-condition-pushdown`.
- **Null-rejecting outer→inner conversion.** A null-rejecting WHERE conjunct on the
  null-extended side converts the outer join to an inner one, after which this rule's push
  becomes legal. Separate well-known rewrite; parked as
  `backlog/feat-outer-join-to-inner-on-null-rejecting-filter`.
- **Predicate inference across the join** (deriving `t.id = 'x'` from
  `t.id = e.txn_id and e.txn_id = 'x'`). `rule-predicate-inference-equivalence` already does
  this, and the equi-pair facts it consumes are already gated on value-discriminating
  equality (`extractEquiPairsFromCondition`, ticket `join-collation-gate-blocks-hash-join`,
  landed). Nothing to add.
- **Collation.** This rule moves a conjunct verbatim without reinterpreting any comparison,
  so none of the collation gates that guard *fact extraction* apply. Do not add one; do not
  route the conjunct through `extractConstraints` here (that is `predicate-pushdown`'s job at
  the `Retrieve` boundary, where the module gets to residualize).

## TODO

### Phase 1 — rule

- Add `rule-join-predicate-pushdown.ts` with `ruleJoinPredicatePushdown`, a `pushableSides`
  helper keyed on `JoinType`, an all-subtree column-reference collector, and per-branch
  side-effect refusal. File-header comment must state the null-extension argument and the
  per-join-type table.
- Register `join-predicate-pushdown` in `RULE_MANIFEST` between `aggregate-predicate-pushdown`
  and `predicate-pushdown`, `sideEffectMode: 'aware'`.
- Update the "Non-moves (for now)" header block of `rule-predicate-pushdown.ts` to drop `Join`
  and point at the new rule.

### Phase 2 — tests

- New `packages/quereus/test/optimizer/rule-join-predicate-pushdown.spec.ts` covering every
  bullet in *Edge cases & interactions*. Follow `rule-aggregate-predicate-pushdown.spec.ts`:
  build a real `Database`, read plans through `query_plan(?)`, and assert both the plan shape
  and the returned rows for each case (rows catch semantic breakage the shape assertion
  cannot).
- Headline assertion for the motivating query: the `entry` branch reaches
  `INDEXSEEK entry USING idx_entry_account` and no `FILTER` survives above the `HASHJOIN`.
- Regenerate `test/plan/joins/simple-join.plan.json` — its query is
  `... users u join departments d on u.dept_id = d.id where u.age > 30`, exactly this shape, so
  the golden changes. `UPDATE_PLANS=true` regenerates; eyeball the diff rather than trusting it.
- Add or extend a `.sqllogic` case pairing an outer join with a preserved-side WHERE and a
  null-extended-side WHERE in the same file, so the asymmetry is pinned end-to-end.

### Phase 3 — docs

- `docs/optimizer-rules.md`: catalogue entry for `ruleJoinPredicatePushdown` next to
  `rulePredicatePushdown`, including the per-join-type table.
- `docs/optimizer.md` § "Filters over a join" (around line 391) asserts *"`rule-predicate-pushdown`
  does not push across a join, so every `where` conjunct … stays in one Filter above it"*. That
  premise is now false. The multi-relation selectivity path still matters (cross-side and
  un-pushable conjuncts remain above) — rewrite the sentence, do not delete the paragraph.
- `docs/optimizer-rules.md` line ~40 (`ruleJoinElimination`) — add a sentence on the whitelist
  interaction described above, so the protection is documented rather than incidental.

### Phase 4 — validation

- `yarn workspace @quereus/quereus run test` (streamed: `2>&1 | tee /tmp/q-test.log; tail -n 80 /tmp/q-test.log`).
- `yarn lint` and `yarn typecheck`.
- Expect churn in plan-shape tests beyond the golden above (`test/plan/join-selection.spec.ts`,
  `test/optimizer/join-quickpick.spec.ts`, `filter-selectivity.spec.ts`, `join-row-estimates.spec.ts`
  are the likely candidates — branch row estimates change, which can flip hash-join build/probe
  side). Each such change needs a one-line justification in the review handoff, not a blind
  snapshot update.
- Known pre-existing red at HEAD: `yarn docs:check` word-count ratchet, owned by
  `debt-doc-size-ratchet-red-at-head` (see `tickets/.pre-existing-known.md`). Do not chase it;
  do keep the new prose short.

## Related

- `backlog/feat-index-nested-loop-join` — orthogonal: that one uses an index on the *join* key,
  this one uses an index on a *filter* column.
- `implement/bug-filter-row-estimate-lost-when-predicate-rewritten` — this rule constructs fresh
  `FilterNode`s, so it is another site that benefits from that fix. No ordering dependency.
- `backlog/known/3-advanced-pushdown-phase3` — the broader push-down programme; this is one
  concrete slice of it.
