---
description: The planner used to guess how many rows survive a WHERE or HAVING clause by consulting statistics that described a different set of rows — sometimes even a different column. It now declines to guess in those cases and falls back to its neutral default.
files:
  - packages/quereus/src/planner/util/row-population.ts               # NEW — shared predicate
  - packages/quereus/src/planner/util/key-utils.ts                     # extractRowSourceTableSchema + shared recursion
  - packages/quereus/src/planner/util/column-origins.ts                # now imports the shared isRowMerging
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts         # 8 new tests across two describe blocks
  - docs/optimizer.md                                                  # strict/permissive split; row-merging paragraph
difficulty: medium
---

# Row-population-changing sources no longer feed the single-table estimate

## What was wrong

`rule-filter-selectivity` asked `extractTableSchema` "which base table is under this
filter?" and, on getting an answer, handed the whole predicate to the statistics
provider as if it were a plain single-table filter. That walk descends through *any*
operator with exactly one relational child — including an aggregate and a recursive
CTE, whose output rows are not their source's rows. Both shapes were mis-estimated;
the returned rows were always correct.

**Aggregate.** The provider resolves a column reference by its AST **name**, so the
answer depended on whether the aggregate's alias collided with a base-table column
name — `having qty > 2` gave 0.75 and `having ct > 2` gave 0.10 for the same
`count(*)`.

**Recursive CTE.** `RecursiveCTENode.getRelations()` returns only the base case, so
the walk descended the seed and stamped `1/ndv(seed.column)`, describing neither the
CTE's row count nor its value distribution.

## What shipped

- **`planner/util/row-population.ts`** (new) — `isRowMerging` (set operation,
  recursive CTE, and the unionAll async-gather; see Review findings),
  `isRowRegrouping` (Aggregate / StreamAggregate / HashAggregate), and
  `changesRowPopulation` (either). Decided by `nodeType` against the `PlanNodeType`
  enum, not `instanceof`, so `key-utils.ts` can import it without a cycle.
- **`column-origins.ts`** imports that shared `isRowMerging` instead of keeping a
  private `instanceof`-based copy, so the two callers can no longer drift.
- **`key-utils.ts`** gained `extractRowSourceTableSchema`. Both it and the unchanged
  `extractTableSchema` run over one private `walkToTableSchema(node, strict)`; strict
  declines at `changesRowPopulation` *before* the single-relation descent. The
  permissive walk is byte-for-byte unchanged — FK/key analysis
  (`rule-join-elimination`, `rule-fanout-lookup-join`, `rule-join-key-inference`)
  still uses it.
- **`rule-filter-selectivity.ts`** calls the strict variant. When it declines, control
  falls to `multiRelationSelectivity`, which finds no base-table origin for the
  aggregate output (or an empty origin map for the recursive CTE) and returns
  `undefined` — the Filter keeps `DEFAULT_FILTER_SELECTIVITY` (0.5).
- **`docs/optimizer.md`** — the strict/permissive split before "Boolean
  decomposition", plus the row-merging paragraph now covering the async-gather case.

## Tests

`test/optimizer/filter-selectivity.spec.ts`, two describe blocks. Fixture for the
first: table `o` with 100 rows, `cat` 4 distinct values, `qty` 7 distinct values,
ANALYZEd, with `qty` deliberately sharing its name with the `count(*)` alias.

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/optimizer/filter-selectivity.spec.ts" --colors
```

**"single-table selectivity declines when the source changes the row population"** —
recursive CTE unstamped rather than reading the seed table; the aliased-aggregate pair
(`having qty > 2` vs `having ct > 2`) both unstamped and equal to each other, which is
the assertion that pins the fix; control cases for a pushed-down group key and for
row-preserving wrappers (Project / Sort / LimitOffset / Distinct / **Window**); and
both walks exercised directly on real optimized plans.

**"set-operation attribution survives the async-gather rewrite"** — added by this
review; see below.

## Validation run (review pass, after the changes below)

- `yarn build` — clean.
- `yarn typecheck` — clean.
- `yarn lint` — clean (includes the `tsconfig.test.json --noEmit` pass over specs).
- `yarn test` (repo root, all workspaces) — **0 failing**; `packages/quereus` alone
  8117 passing. No `test/plan/` snapshot diffs and no churn in
  `test/logic/108-cardinality-estimation.sqllogic`.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Review findings

### Fixed in this pass

- **`isRowMerging` missed the async-gather rewrite of `union all` — a verified
  mis-attribution.** `rule-async-gather-union-all` (PostOptimization) *replaces* a
  unionAll `SetOperationNode` with an `AsyncGatherNode` that keeps `children[0]`'s
  attribute ids verbatim (`AsyncGatherNode.buildAttributes`) — identical forwarding,
  identical hazard, but no `SetOperation` node left in the plan for `isRowMerging` to
  recognise. `filter-selectivity-restamp` runs in that same pass and fires bottom-up
  *after* the rewrite, so `collectColumnOrigins` descended into the branches and
  credited the union's output to the first branch's base table. Reproduced against a
  vtab module declaring `expectedLatencyMs = 25` (the gather's cost gate is inert on
  memory vtabs): `select * from (select id, cat from o union all select id, cat from r) z
  where z.cat = 'a'` stamped **0.25 = 1/ndv(o.cat)** while `r.cat` held 40 disjoint
  values. Fixed by adding `AsyncGather` with `combinator.kind === 'unionAll'` to
  `isRowMerging`, read structurally so `row-population.ts` stays a leaf module. The
  gather's other combinators are correctly excluded: `crossProduct` concatenates every
  branch's own ids and `zipByKey` mints fresh ids for merged keys. Regression test:
  new describe block **"set-operation attribution survives the async-gather rewrite"**,
  which also guards its own premise (asserts the gather fired and the `SetOperation` is
  gone) so it cannot silently degrade into a duplicate of the plain set-operation test.
  `changesRowPopulation` is unaffected — a gather exposes ≥2 relations, so the strict
  walk already declined.
- **`Window` was reasoned about but untested** (a stated gap). Added to the
  row-preserving-wrappers case list: a predicate on a column a window function merely
  passes through still reaches `o`'s statistics (0.25). Confirms `Window` is correctly
  absent from `changesRowPopulation`.
- Doc-comments in `column-origins.ts` and the row-merging paragraph in
  `docs/optimizer.md` updated for the gather case.

### Filed as a new ticket

- **`tickets/fix/bug-selectivity-matches-columns-by-name-not-identity`** — the same
  alias-spelling symptom this ticket fixed for aggregates is still live through a plain
  `Project`, at the *column* level rather than the relation level. Verified:
  `select * from (select cat, id * 7 as qty from o) x where x.qty = 3` stamps
  `1/ndv(o.qty)`, and renaming the alias to `zz` yields the flat 0.1 fallback. Same for
  a window function's output aliased `qty`. Root cause is `catalog-stats.ts` resolving
  the filtered column by AST name against the table's `columnStats`; the row-population
  work cannot reach it, because `Project` genuinely preserves the row population and
  excluding it would discard every legitimate estimate for a filter over a subquery.
  Not folded into this pass: the fix touches the provider interface (which receives a
  `TableSchema` and no plan context) and will churn plan snapshots.
- **`bug-fk-alignment-derived-table-indices`** (already in `tickets/implement/`) covers
  the FK-alignment investigation this ticket asked for; the implement stage verified it
  reachable and wrong-rows, and recorded an extra aggregate-in-the-middle repro for that
  ticket's implementer. Confirmed still in flight and **not** edited.

### Tripwires — parked, not ticketed

- **`Distinct` deliberately excluded from `changesRowPopulation`** (implementer's
  decision, upheld). A `distinct`'s output rows are a subset of the base table's rows,
  so the base-table row fraction stays a defensible approximation. Parked as a `NOTE:`
  at the top of `packages/quereus/src/planner/util/row-population.ts`, which also names
  `LimitOffset`, `OrdinalSlice` and the physical access nodes as excluded on the same
  reasoning: if a filter over a `distinct` ever shows a bad estimate, a heavily-skewed
  column is the reason and `Distinct` should join `isRowRegrouping`.

### Checked, no action

- **The permissive walk's three callers** (`rule-join-elimination`,
  `rule-fanout-lookup-join`, `rule-join-key-inference`) all ask "which table does this
  subtree read" for FK/key analysis, which the strict walk would wrongly narrow. Leaving
  them on `extractTableSchema` is correct.
- **`instanceof` → `nodeType` in `column-origins`'s `isRowMerging` is behaviour-
  preserving.** `SetOperationNode` and `RecursiveCTENode` are each the sole class
  carrying their `nodeType`; no subclasses exist.
- **The aggregate node list is complete** — `AggregateNode`, `HashAggregateNode`,
  `StreamAggregateNode` are the only three classes bearing an aggregate `nodeType`, and
  no rule lowers `Distinct` into an aggregate, so the `Distinct` exclusion above is not
  quietly undone elsewhere.
- **The implementer's suggested extra assertion is not writable.** They proposed
  asserting the aggregate filter's `physical.estimatedRows` equals
  `floor(sourceRows * 0.5)`. `HashAggregate` exposes no `estimatedRows`, so the Filter's
  is `undefined` regardless of selectivity — the same gap
  `debt-join-rows-from-physical-children` tracks for joins. `selectivity === undefined`
  is the only observable, which is what the tests assert.
- **The `SetOperation` arm of `isRowMerging` is unreachable from the strict walk**
  (a set operation always exposes two relations, so the single-relation descent already
  declines). It is live and necessary for `collectColumnOrigins`. Harmless as written.
- **`Materialize` / `Cache` / `EagerPrefetch` / `Sequencing` / `Sink` remain
  unclassified**, correctly: each emits one row per input row. Read, not tested — the
  `NOTE:` in `row-population.ts` is the place that has to learn about it if any of them
  ever gains row-reshaping behaviour.
- **The logical `Aggregate` nodeType is included but never exercised** (physical
  selection always produces `HashAggregate` in these plans). Left in for the Structural
  pass registration path; removing it would be a latent hole for no gain.
- **`docs/optimizer.md` is the only doc that describes this machinery**; the other
  `docs/` files that mention `key-utils.ts` (`optimizer-joins.md`,
  `optimizer-retrieve.md`, `optimizer-rule-families.md`) reference FK/key helpers the
  permissive walk still serves unchanged, so they needed no edit.
