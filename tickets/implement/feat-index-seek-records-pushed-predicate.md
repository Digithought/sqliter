---
description: When the query planner hands a filter to the storage layer to enforce, it forgets which original condition that filter came from. Record it on the plan node so a later optimization can re-apply the condition if it needs to change how the table is read.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/test/optimizer/pushed-constraints-recorded.spec.ts (new)
difficulty: medium
---

## What this is

`rule-select-access-path` turns a `Retrieve` over a table into a physical access node. When
the storage module claims a WHERE predicate (`handledFilters[i] === true`), the rule folds
that predicate into seek keys on an `IndexSeekNode` and the predicate stops existing as a
`Filter` anywhere in the tree — the module promised to enforce it.

The information that gets lost is *which* original expression each seek key came from. The
node keeps only the low-level encoded form: `filterInfo.constraints` (column index +
operator + argv slot) and `seekKeys` (the bound values). From that you cannot rebuild the
predicate faithfully — in particular you cannot recover the comparison's effective
collation, which is resolved from the original expression's operand types
(`analysis/comparison-collation.ts`), not from the column alone.

Consequence: any later rule that wants to replace an `IndexSeekNode`'s access method must
decline, because it cannot tell what predicate it would be dropping. Two rules decline
today for exactly this reason:

- `rule-key-set-seek` (`feat-key-set-seek-over-pushed-constraints`, the dependent ticket)
- `rules/join/index-nested-loop.ts` (`backlog/feat-index-nested-loop-over-pushed-constraints`)

This ticket adds the record. It changes no plan and no query result on its own; it exists
so the dependent ticket can consume it.

## Design

### Record the planner-level constraint objects, not a rebuilt expression

`IndexSeekNode` gains one new optional field:

```ts
/**
 * The planner-level constraints this seek's keys were built from — the exact
 * `PredicateConstraint` objects `rule-select-access-path` consumed, each carrying its
 * original `sourceExpression`.
 *
 * This node's `FilterInfo` is the ONLY place these predicates are enforced: they were
 * dropped from the tree on the module's promise (`handledFilters`). A rewrite that
 * replaces this node's `FilterInfo` must re-apply them (as a `Filter`) or re-offer them
 * to the module; a rewrite that cannot must decline.
 *
 * Undefined ⇒ this node was built by a path that did not thread the consumed set
 * (never true for `selectPhysicalNode`'s output). An empty array is impossible: a
 * seek exists only because at least one constraint was consumed.
 */
readonly pushedConstraints?: readonly PredicateConstraint[];
```

Constraint objects rather than a pre-combined `ScalarPlanNode` because the two consumers
need different things: the key-set rule needs an AND-combined predicate to re-apply, while
the index-nested-loop rule needs the constraint objects themselves so it can re-ask
`getBestAccessPlan` over the union of old and new constraints. Storing the objects serves
both; combining is a one-line call at the consumer.

Import the type with `import type { PredicateConstraint } from '../analysis/constraint-extractor.js'`
— type-only, so the (real) module cycle `constraint-extractor → nodes/reference → …` is
never created at runtime.

### Also propagate `orderingLoadBearing` onto `IndexSeekNode`

`selectPhysicalNode` takes an `orderingLoadBearing` flag (set when `rule-grow-retrieve`
dropped a `Sort` because this access plan advertised the matching ordering). Today that
flag is forwarded only to the two `IndexScanNode` arms; every `IndexSeekNode` arm drops it
silently. That is inert right now — `rule-key-set-seek` is the flag's only reader and it
cannot target a seek — but it becomes a correctness hazard the moment the dependent ticket
lets it. Add the same `orderingLoadBearing: boolean = false` field to `IndexSeekNode`
(same doc shape as `IndexScanNode`'s) and populate it.

### Where to stamp

Both fields are stamped at one site rather than at the ~8 `new IndexSeekNode(...)` call
sites. `selectPhysicalNode` already ends with:

```ts
const leaf = (…) ? selectPhysicalNodeFromPlan(…) : selectPhysicalNodeLegacy(…);
return reattachUnconsumedConstraints(tableRef, accessPlan, constraints, consumed, leaf);
```

Insert a stamping step between those two lines. The sub-functions may return the seek
already wrapped in a `FilterNode` (the `COARSER_SAFE` collation arm's `finishSeek`), so
the stamper descends through `FilterNode`s to find the seek and rebuilds on the way back
out — the same descend-through-Filter shape `index-nested-loop.ts` already uses:

```ts
/**
 * Record on an IndexSeek leaf what its FilterInfo is enforcing. Descends through the
 * collation-residual Filter the seek arms may wrap it in. A non-seek result (SeqScan
 * after a collation decline, EmptyResult, IndexScan) is returned unchanged.
 */
function stampSeekProvenance(
	node: RelationalPlanNode,
	consumed: ConsumedSet,
	orderingLoadBearing: boolean,
): RelationalPlanNode
```

`IndexSeekNode` gets a small clone helper for this (`withProvenance(constraints, orderingLoadBearing)`)
rather than making callers re-list ten constructor arguments. `withChildren` must carry
both new fields through — it currently reconstructs the node field-by-field.

### What goes into `pushedConstraints`

Exactly the members of the existing `consumed: ConsumedSet` — the constraints this seek
turned into keys or bounds. Deliberately NOT "every constraint with `handledFilters[i] === true`":

- A claimed-but-unconsumed reclaimable constraint is already re-applied above the leaf by
  `reattachUnconsumedConstraints`, so it survives any leaf rewrite on its own.
- A claimed constraint whose op is outside `RECLAIMABLE_OPS` is enforced *nowhere* today
  (see that constant's NOTE — the only live case is the memory module's tautological
  `IS NOT NULL` on a `NOT NULL` column). Dropping the `FilterInfo` loses nothing that the
  `FilterInfo` was holding, so including it would misdescribe the field.

Order: preserve `constraints` order (iterate `constraints.filter(c => consumed.has(c))`
rather than the `Set`'s insertion order) so the recorded list is deterministic across the
index-aware and legacy arms.

### Export the combiner

`combineResidualExpressions` (AND-combines `sourceExpression`s, de-duplicating by identity
so a `BETWEEN`'s two constraints yield one node) is module-private in
`rule-select-access-path.ts`. Export it, alongside the already-exported
`classifyConstraintCover` which `rule-key-set-seek` imports the same way.

## Edge cases & interactions

- **`BETWEEN` yields two constraints sharing one `sourceExpression` node.** Both land in
  `pushedConstraints`; `combineResidualExpressions` collapses them back to the single
  `BetweenNode`. Assert the combined predicate is that one node, not an `AND` of it with
  itself.
- **`OR_RANGE`** carries the whole `OR` expression as its `sourceExpression`. One
  constraint, one recorded expression.
- **Collation decline (`MISMATCH_UNSAFE`)** returns a `SeqScan` (+ residual `Filter`), not
  a seek — nothing is stamped, and the residual above already holds the predicate.
- **`COARSER_SAFE`** returns `Filter(residual)` over the seek. The constraint is recorded
  on the seek *and* re-applied above it. Redundant, not wrong — a consumer that re-applies
  `pushedConstraints` on top produces a doubly-applied predicate, which is correct and
  merely costs an evaluation. Say so in the field's doc.
- **`EmptyResultNode`** (impossible predicate, all-NULL IN list): not an `IndexSeekNode`,
  nothing stamped.
- **`rules/join/index-nested-loop.ts` calls `selectPhysicalNode`** with *synthesized*
  correlated equality constraints (`innerCol = outerCol`). Those get recorded too, and
  their `sourceExpression` references an attribute from the **outer** side of the join.
  That is correct data, but it means `pushedConstraints` is not always safe to re-apply
  in an arbitrary position — the dependent ticket carries the gate for that. Note it in
  the field doc; do not filter them out here.
- **Legacy arms** (`selectPhysicalNodeLegacy`, module without `indexName`/`seekColumnIndexes`):
  PK equality seek and PK range seek both populate `consumed`, so both get stamped by the
  shared site. Cover at least one legacy shape in tests.
- **No EXPLAIN surface change.** Do NOT add either field to `getLogicalAttributes` —
  `test/plan/golden-plans.spec.ts` compares logical attributes and would churn. Tests
  inspect the node object directly.
- **`withChildren` round-trip.** `test/emit-roundtrip-property.spec.ts` and any rule that
  rebuilds a leaf via `withChildren` must not lose the fields; a lost `orderingLoadBearing`
  would silently re-enable a rewrite that should decline.
- **Sort absorbed onto a seek plan.** Try to build a fixture where `rule-grow-retrieve`'s
  sort absorption picks a plan that also carries seek constraints (so `orderingLoadBearing`
  reaches an `IndexSeekNode`). If no SQL produces that shape, keep the propagation anyway
  (it is inert) and say explicitly in the handoff that the path is untested and why.

## Expected test outcomes

New spec `test/optimizer/pushed-constraints-recorded.spec.ts`, using the
`db.getPlan(sql)` + `collectNodes(plan, isIndexSeek)` idiom already used by
`test/optimizer/key-set-seek.spec.ts` and `test/optimizer/secondary-index-access.spec.ts`:

- `where s = 'x'` on a secondary-indexed `s` → one `IndexSeekNode` whose
  `pushedConstraints` has length 1 and whose single `sourceExpression` is the `s = 'x'`
  comparison node.
- `where pk between 2 and 5` → two recorded constraints, one distinct `sourceExpression`
  after combining.
- `where pk in (1, 2, 3)` → the `InNode` recorded (multi-seek arm).
- `where pk < 2 or pk > 8` → the `OR` node recorded (`OR_RANGE` arm; borrow the fixture
  from `test/optimizer/or-multi-range-seek.spec.ts`).
- A legacy-arm PK equality seek → recorded.
- A `MISMATCH_UNSAFE` collation shape (borrow from `test/optimizer/range-seek-collation-bounds.spec.ts`)
  → leaf is a `SeqScan`, no seek to stamp, residual `Filter` present.
- `withChildren` on a stamped seek returns a node carrying both fields.
- Whole-suite regression: `yarn test` green, `yarn lint` clean, and
  `test/plan/golden-plans.spec.ts` unchanged.

## TODO

### Phase 1 — node fields

- Add `pushedConstraints?: readonly PredicateConstraint[]` and `orderingLoadBearing: boolean`
  to `IndexSeekNode`, with docs as above (`import type` for the constraint type).
- Add `IndexSeekNode.withProvenance(pushedConstraints, orderingLoadBearing)` clone helper.
- Carry both fields through `IndexSeekNode.withChildren`.

### Phase 2 — populate

- Add `stampSeekProvenance` to `rule-select-access-path.ts` and call it between the
  `selectPhysicalNode*` dispatch and `reattachUnconsumedConstraints`.
- Build the recorded list as `constraints.filter(c => consumed.has(c))`.
- Export `combineResidualExpressions`.

### Phase 3 — verify

- Write `test/optimizer/pushed-constraints-recorded.spec.ts` per the list above.
- `yarn build`, `yarn test 2>&1 | tee /tmp/t1.log; tail -n 80 /tmp/t1.log`, `yarn lint`.
- Handoff must state plainly whether the "Sort absorbed onto an IndexSeek" path was
  reachable from SQL, and whether any golden plan moved.
