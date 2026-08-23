---
description: When two tables are joined, the engine only ever considers using an index on one of them — whichever the query happened to name second. Let it consider both and pick the faster side.
prereq:
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # tryIndexNestedLoop — signature refactor
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # the four-way comparison — add the mirrored candidate
  - packages/quereus/src/planner/nodes/join-node.ts                         # JoinNode constructor / buildAttributes (read-only reference)
  - packages/quereus/src/planner/nodes/join-utils.ts                        # buildJoinAttributes — proves attribute-id stability across a swap
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts     # the earlier rule this compensates for (read-only reference)
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic
  - packages/quereus/test/plan/joins/                                       # golden plan files that may churn
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
difficulty: hard
---

# Elect which side of a join gets the index seek

## The problem, plainly

`rule-join-physical-selection` can replace a full read of a table with one index lookup
per row of the other table (the "index-nested-loop" join). Today it only ever offers that
rewrite to the join's **right** input. Whether a table ends up on the left or the right is
decided long before anything knows which table has a usable index — so on an ordinary
query the engine can read a whole table it had a perfectly good index for.

## What was measured (and how the parent ticket's diagnosis was wrong)

The parent ticket (`feat-index-nested-loop-coverage-gaps`) claimed this shape needed two
separate fixes before it improved. Reproduced in-process against the memory module
(2,000 `txn` rows / 4,000 `entry` rows, 200 entities, `analyze` run):

```sql
create table txn   (id integer primary key, entity_id integer, date text);
create table entry (id integer primary key, txn_id integer, amount real);
create index txn_entity on txn (entity_id, date);
create index entry_txn  on entry (txn_id);

select e.txn_id, sum(e.amount)
  from entry e join txn t on t.id = e.txn_id
 where t.entity_id = ?
 group by e.txn_id;
```

plans as a hash join that reads **all 4,000 `entry` rows**. But the same query with the
two tables named in the other order —

```sql
select e.txn_id, sum(e.amount)
  from txn t join entry e on t.id = e.txn_id
 where t.entity_id = ?
 group by e.txn_id;
```

— already plans, today, as exactly the desired shape:

```
HashAggregate
└─ Join (inner)
   ├─ Alias t → Filter[entity_id = ?] → IndexScan txn USING _primary_   (≈10 rows)
   └─ Alias e → IndexSeek entry USING entry_txn                          (≈2 rows/seek)
```

So **this one change is sufficient for the measured shape**. The pushed-constraint arm
(`feat-index-nested-loop-over-pushed-constraints`) is a separate, genuine win but is *not*
needed to rescue it. The parent ticket's "neither arm alone rescues this shape" claim was
wrong; correct it anywhere a doc repeats it.

Two findings explain why nothing upstream fixes the orientation:

- `rule-join-greedy-commute` is meant to put the smaller input on the left, but its
  row-count arm never fires for table-backed inputs: it reads the **logical**
  `estimatedRows` getter, which `AliasNode` / `RetrieveNode` do not define, so both sides
  read `undefined` → `Infinity` and the comparison `rightRows < leftRows` is always false.
  (Its singleton-functional-dependency arm still works.) Filed as an arm on
  `backlog/bug-row-estimate-conflates-unknown-and-zero`; **do not fix it here.**
- `rule-quickpick-enumeration` returns immediately for fewer than three relations, so a
  two-table join is never reordered there either.

`rule-join-physical-selection` is therefore the only place a two-table join's orientation
can be decided at all, and the only place that has the module's own seek-versus-scan
answers to decide it with.

## The change

Offer the index-nested-loop candidate for **both** orientations and take the cheaper one.

`tryIndexNestedLoop` currently reads `node.left` as the outer and `node.right` as the
inner. Refactor it to take them explicitly:

```ts
export function tryIndexNestedLoop(
	joinType: JoinType,
	outer: RelationalPlanNode,
	inner: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],   // oriented left = outer, right = inner
	outerRows: number,
	context: OptContext,
): IndexNestedLoopCandidate | null
```

Every internal use of `node.right` becomes `inner` (including the `expectedLatencyMs`
read and the side-effect gate) and `node.left` becomes `outer`. The returned `newRight` is
the rebuilt **inner** subtree; rename it `newInner` for honesty.

In `ruleJoinPhysicalSelection`, after the existing call, add the mirrored one:

```ts
const indexNL = tryIndexNestedLoop(joinType, node.left, node.right,
	extracted.equiPairs, leftRows, context);

// Mirrored: seek the LEFT input and drive from the right.
const mirrorEligible = joinType === 'inner'
	&& !node.hasExistenceColumns
	&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.left)
	&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.right);
const mirroredNL = mirrorEligible
	? tryIndexNestedLoop('inner', node.right, node.left,
		extracted.equiPairs.map(p => ({ ...p, leftAttrId: p.rightAttrId, rightAttrId: p.leftAttrId })),
		rightRows, context)
	: null;
```

and add it to the algorithm election alongside `indexNL`. On a mirrored win, rebuild as a
**new** `JoinNode` with the children exchanged, keeping the ON condition and
`usingColumns`:

```ts
new JoinNode(node.scope, node.right, mirroredNL.newInner, 'inner',
	node.condition, node.usingColumns)
```

`withChildren` cannot express the swap — it re-uses the node's own child ordering.

### Why the swap is sound

- **Attribute identity survives.** `buildJoinAttributes` (join-utils.ts) concatenates the
  two sides' `Attribute` objects verbatim when no `preserveAttributeIds` list is given,
  and the `JoinNode` constructor never passes one. The swap changes attribute *order*,
  never attribute *ids*.
- **Order change is harmless to consumers.** Column references resolve by attribute id at
  runtime (`emitColumnReference` → `resolveAttribute(rctx, plan.attributeId, …)`), and
  every positional consumer derives its row descriptor from the *same node's*
  `getAttributes()` at emit time. The hazard the hash-join path documents — advertised
  attribute order disagreeing with the emitted row layout — cannot arise here: the
  nested-loop emitter yields `[...leftRow, ...rightRow]`, and after the swap "left" *is*
  the old right on both sides of that equation.
- **No ordering claim is broken.** `JoinNode.computePhysical` returns no `ordering` field
  at all, so no ancestor `Sort` can have been elided on the strength of the join's
  emission order. Re-verify this when you read the file — it is the load-bearing clause.
- **`usingColumns` is presentational.** Its own doc comment says `condition` is
  authoritative and no consumer re-derives the comparison from the names.
- **Correlation is already excluded.** The rule's `readsColumnsOf` guard, which runs
  before this point, has already refused any join where either side reads the other's
  columns — so neither side depends on being driven second.
- **Idempotence still holds.** After the swap the new right subtree seeks on the new
  left's columns, so `readsColumnsOf(right, left)` is true on the next visit and the rule
  declines.

### What the swap does change: emitted row order

For a query with no `order by`, swapping the drive side changes the order rows come out
in. That is permitted (hash join already does it), but it *will* move rows in tests that
assert an order they never asked for. Expect churn in `test/logic/*.sqllogic` and in the
golden plans under `test/plan/`. Treat each diff as a judgment call: a golden plan that
now shows the cheaper shape should be re-recorded; a sqllogic case whose row order was
incidental should gain an explicit `order by`. **Do not** loosen an assertion that was
deliberately pinning a specific order without saying so in the handoff.

## Edge cases & interactions

- **Both orientations qualify.** Two indexed tables joined on their indexed columns: both
  candidates come back non-null; the cheaper must win and the loser must not be built.
- **Neither qualifies.** Unchanged four-way election; no new plan churn.
- **Non-commutative join types.** `left` / `semi` / `anti` must never mirror — the
  nested-loop emitter installs the *left* row slot, and a mirrored `left` join is a
  `right` join, which drives from the other side. `cross` never reaches here (no
  condition ⇒ no equi pairs).
- **Existence joins** (`exists … as`). Excluded from mirroring: `ExistenceColumnSpec`
  carries a resolved `side` and the flags are appended after both sides, so a swap would
  have to flip and re-derive them. Non-mirrored index-nested-loop on existence joins must
  keep working exactly as today.
- **Side effects on either side.** A write in either subtree forbids the swap (it reorders
  user-visible execution). Mirror the check the hash build/probe swap already makes.
- **Self-join.** `from big a join big b on a.v = b.id` — the two sides are distinct node
  instances; confirm `rebuildChain` on one side cannot reach the other side's leaf.
- **Three-way spine.** A left-deep chain of two joins: the rule fires per join node, and a
  swap at the lower join changes the upper join's left input's attribute order. Assert row
  equality, not column position.
- **`rule-nested-loop-right-cache`** (registered later) wraps an *uncorrelated* right side
  in a `CacheNode`. After a mirrored win the right side is correlated, so it must be
  skipped — same as the existing non-mirrored case.
- **`rule-monotonic-limit-pushdown`** runs immediately after this rule. Confirm a swapped
  join does not change what it pushes (it should not — the join advertises no ordering —
  but confirm rather than assume).
- **Cost-model honesty.** `indexNestedLoopJoinCost(outerRows, rowsPerSeek, latency)` is
  linear in `outerRows`, so the mirrored candidate is only cheap when the *new* outer is
  small. Feed it `rightRows`, not `leftRows`.
- **Un-analyzed tables.** With no statistics both sides collapse to the `|| 100` default
  and the two candidates tie. Make the tie deterministic — prefer the un-swapped
  orientation on an exact tie, so plans do not flip on a coin toss. Do not "fix" the
  unknown-estimate collapse here; it belongs to
  `backlog/bug-row-estimate-conflates-unknown-and-zero`.

## Tests

Plan-shape assertions in `test/optimizer/index-nested-loop.spec.ts`. The file already has
a `correlatedSeekJoins(root)` helper; it looks for a seek in the join's *right* subtree,
which is still the right predicate after a swap.

- The parent/child rollup above, written `from entry e join txn t`, produces a `JoinNode`
  whose left is the filtered `txn` side and whose right contains
  `IndexSeek entry USING entry_txn` — i.e. the plan the reversed spelling already gets.
  This is the headline regression pin.
- Both sides indexed: the orientation with the smaller outer wins, and making the other
  side small flips the chosen orientation.
- `left`, `semi`, `anti` and `exists … as` joins are never mirrored.
- A side carrying a write is never mirrored.
- Applying the rule to its own output changes nothing (idempotence), for the mirrored case
  specifically.
- Exact tie (no `analyze`, both sides at the 100-row default) keeps the un-swapped
  orientation.

Row-level correctness in `test/logic/11.3-index-nested-loop-join.sqllogic`: the rollup
query returns the same rows as the same query forced away from the rewrite, with an
explicit `order by` so the assertion does not depend on drive order.

## TODO

- Read `index-nested-loop.ts` and `rule-join-physical-selection.ts` end to end before
  editing; the correctness argument above leans on comments in both.
- Refactor `tryIndexNestedLoop` to explicit `(joinType, outer, inner, equiPairs,
  outerRows, context)`; rename `newRight` → `newInner`. No behaviour change in this step —
  get the existing `index-nested-loop.spec.ts` green before going further.
- Add the mirrored candidate, its eligibility gates, and the swapped-`JoinNode` rebuild.
- Extend the algorithm election and its log line to name both index-nested-loop candidates
  (`index-nl` and `index-nl-mirrored`) so `optimizer:rule:join-physical-selection` traces
  stay readable.
- Verify empirically that the reproduction above now plans the seek shape; keep the
  measurement in the handoff.
- Run `yarn test` and `yarn test:store` in the foreground. Triage every diff: re-record
  golden plans that legitimately improved, add `order by` where a sqllogic case's row
  order was incidental, and report anything you could not classify.
- `yarn lint`, `yarn typecheck`, `yarn build`, `node scripts/check-docs.mjs`.
- Update `docs/optimizer-joins.md` and `docs/optimizer-rules.md`: the index-nested-loop
  entry currently says only the right side is ever seek-rewritten. Also correct any doc
  claiming `rule-join-greedy-commute` puts the smaller input on the left — its row-count
  arm does not fire for table-backed inputs.
