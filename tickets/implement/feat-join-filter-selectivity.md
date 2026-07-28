----
description: A WHERE clause that sits above a join currently gets a fixed 50% row-count guess; make it estimate each condition against whichever table that condition's columns actually come from.
prereq: feat-conjunction-selectivity
files: packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/util/column-origins.ts (new), packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md
difficulty: medium
----

Second half of the filter-selectivity follow-on. `feat-conjunction-selectivity` teaches the stats
provider to decompose boolean predicates over **one** table; this ticket teaches
`rule-filter-selectivity` to handle a filter whose source spans **several** tables.

## The gap

`ruleFilterSelectivity` calls `extractTableSchema(filter.source)` (`key-utils.ts:493`), which
walks single-child wrappers down to a base table and returns `undefined` as soon as it meets a
node with two relational children. A `JoinNode` therefore stops it dead, the rule declines, and
the filter keeps the last-resort `DEFAULT_FILTER_SELECTIVITY` of `0.5`.

This is not a rare shape. `rule-predicate-pushdown` explicitly does **not** push across a join
(`rule-predicate-pushdown.ts:16-17`), so for

```sql
select * from orders o join regions r on o.region_id = r.id
where o.status = 'shipped' and r.name = 'EU'
```

*every* `where` conjunct stays in one `FilterNode` above the join and the whole thing is
estimated at 50%, even when both tables have been analyzed.

## Design

Add a second path to `ruleFilterSelectivity` for the multi-relation case. Split the predicate
into conjuncts, attribute each conjunct to the base table(s) its columns come from, estimate each
one against that table's statistics, and combine with the shared `combineConjunctive` from
`feat-conjunction-selectivity`.

### New module: `planner/util/column-origins.ts`

```ts
export interface ColumnOrigin {
	/** The TableReferenceNode that minted this attribute. Identity — NOT the schema —
	 *  is what distinguishes the two sides of a self-join. */
	readonly ref: TableReferenceNode;
	readonly table: TableSchema;
	readonly columnIndex: number;
	readonly columnName: string;
}

/** Attribute id → originating base-table column, for every base column reachable under `node`. */
export function collectColumnOrigins(node: RelationalPlanNode): Map<number, ColumnOrigin>;
```

Implementation: recurse through `getRelations()`, deduping visited nodes by identity (plan trees
are DAGs — shared CTE instances). At each `TableReferenceNode`, zip `getAttributes()` with
`tableSchema.columns` positionally; the two are 1:1 by construction (see the same zip in
`reference.ts:219-221`).

Attributes minted *above* a base table — computed projections, aggregate outputs, `values` rows —
simply never appear in the map. That is the point: a conjunct referencing one falls into the
"unknown" bucket rather than being mis-attributed by column name.

### `rule-filter-selectivity.ts`: multi-relation path

```
const single = extractTableSchema(filter.source);
if (single) { …existing single-table path, unchanged… }
else        { …new multi-relation path… }
```

Multi-relation path:

1. `const origins = collectColumnOrigins(filter.source);` — if empty, return `null`.
2. `const conjuncts = splitConjuncts(filter.predicate);`
3. For each conjunct, walk its scalar subtree collecting `ColumnReferenceNode.attributeId`s, then
   map those through `origins` to a set of distinct **`ref` identities**:
   - **zero column references**, or **any referenced id missing from `origins`** ⇒ unknown; skip
     the conjunct.
   - **exactly one origin relation** ⇒ `context.stats.selectivity(origin.table, conjunct)`.
   - **exactly two origin relations**, conjunct is a `BinaryOpNode` with a `ColumnReferenceNode`
     on each side ⇒ cross-relation, see below.
   - **three or more** ⇒ skip.
4. If no conjunct produced a number, return `null` — the filter stays unstamped exactly as today.
5. Otherwise `combineConjunctive(known)`, clamp to `[0, 1]`, and mint the stamped `FilterNode`
   the same way the single-table path does.

### Cross-relation conjuncts

A conjunct comparing a column of one table to a column of another (`o.qty > l.qty`,
`a.id = b.id`):

- **`=`** ⇒ `context.stats.joinSelectivity(tableA, tableB, conjunct)`. **Argument order matters**:
  `CatalogStatsProvider.joinSelectivity` reads the column pair via `extractEquiJoinColumns`, which
  takes them from the conjunct's child order, and `fkPkSelectivity` interprets `left`/`right`
  against the tables passed in. Pass the table owning the conjunct's *left* child first. If it
  returns `undefined`, skip the conjunct.
- **`!=` / `<>`** ⇒ `1 - joinSelectivity(...)` when available, else skip.
- **`<` `<=` `>` `>=`** ⇒ a named constant
  `CROSS_RELATION_INEQUALITY_SELECTIVITY = 1 / 3` (the standard uniform-distribution estimate for
  a two-sided inequality; there is no cross-table histogram to do better with). Define it in the
  rule with a comment saying so.
- anything else ⇒ skip.

### Gate: only stamp when real statistics exist

`context.stats.selectivity(table, conjunct)` **always** returns a number for a stats-less table —
`CatalogStatsProvider` falls through to `NaiveStatsProvider`, which answers `0.1` for any
`BinaryOp`. Stamping that would replace `0.5` with `0.1` on essentially every filter-over-join in
the codebase, including the many tests that never run `ANALYZE`, churning plan shapes with no
actual information behind the change.

So the multi-relation path counts a conjunct as *known* only when the backing statistics are
really there:

- single-relation conjunct: require `origin.table.statistics?.columnStats.has(origin.columnName.toLowerCase())`.
- cross-relation conjunct: require `table.statistics` present on **both** tables.

No `StatsProvider` interface change is needed — the check reads `TableSchema.statistics`
directly, the same field `CatalogStatsProvider` gates on.

The single-table path keeps its current behaviour (it may still stamp a naive number); only the
new path is gated. Say why in a comment, because the asymmetry is otherwise surprising.

## Edge cases & interactions

- **Self-join.** `from t a join t b on a.id = b.id where a.age > b.age`: both sides resolve to the
  *same* `TableSchema` object. Distinct-relation counting must therefore key on
  `ColumnOrigin.ref` identity, never on the schema — otherwise the conjunct looks single-table and
  gets estimated against a constant it does not have. The existing spec
  `leaves selectivity unstamped for a multi-table (join) filter source` uses exactly this query;
  it will need updating (see TODO) and is the natural regression anchor.
- **Mixed conjuncts.** `where a.x = 1 and b.y = 2 and a.z > b.z` must estimate all three (two
  single-relation, one cross-relation inequality) and combine once.
- **Outer joins.** A `left`/`right`/`full` join emits NULL-extended rows; a predicate on the
  non-preserved side of a left join is more selective than the base-table fraction suggests, and a
  predicate on the preserved side less so. This ticket ignores join type and applies the base-table
  fraction either way. That is the conventional simplification, but record it as a `NOTE:` comment
  at the attribution site so the next reader does not mistake it for an oversight.
- **Semi/anti-join and existence columns.** `JoinNode.hasExistenceColumns` mints attributes that
  are not base columns; they land outside `origins` and the conjunct is skipped. Confirm this
  rather than assuming it — write a test with an `exists … as` flag in the predicate.
- **Aggregate / project between filter and tables.** `filter(project(join(...)))` where the filter
  references a computed projection: the computed attribute is not in `origins` ⇒ skipped. A filter
  over `aggregate(join(...))` referencing a group key: the group key *does* forward the base
  attribute id, so it will be attributed to the base table even though the aggregate has already
  collapsed rows. The estimate is then applied to post-aggregate cardinality — imprecise but not
  unsound. Note it; do not special-case aggregates in this ticket.
- **Cost of the walk.** `collectColumnOrigins` walks the whole source subtree, and the rule fires
  per `FilterNode` in a bottom-up pass, so a stack of N filters over one large subtree is
  O(N·subtree). Filters over joins are few and the walk is cheap per node. Add a `NOTE:` comment
  saying that if this ever shows up in optimizer profiles, the map should be computed once per
  pass and cached on `OptContext` rather than per filter.
- **Idempotence.** The existing `filter.selectivity !== undefined` guard
  (`rule-filter-selectivity.ts:31`) covers the new path too; re-running the optimizer over a
  stamped plan must be a no-op. Assert it.
- **Empty / degenerate sources.** A join over a `values` list or a CTE with no base table under it
  ⇒ `origins` empty ⇒ return `null`, no stamp, no throw.
- **Physical-pass timing.** The rule runs in `PassId.Physical`, phase `impl`
  (`optimizer.ts:806-816`), *after* the structural pass, so the source subtree is already in its
  final shape and access nodes (`SeqScan`/`IndexScan`/`IndexSeek` over a `Retrieve`) may sit
  between the join and the table references. `collectColumnOrigins` must reach through them —
  verify against a real optimized plan, not just a hand-built one.
- **Estimate propagation.** A smaller stamped selectivity above a join feeds
  `FilterNode.computePhysical` and flows upward, so it can change join ordering
  (`quickpick-join-enumeration`) and access-path choices in enclosing subtrees. This is the
  intended effect, but it is also the main regression surface — `test/plan/golden-plans.spec.ts`,
  `test/plan/join-selection.spec.ts`, and `test/plan/index-selection.spec.ts` are the specs most
  likely to move. The statistics gate above should keep non-`ANALYZE` tests untouched; if
  anything does move, inspect the diff and justify it in the handoff rather than re-baselining.
- **Unique-key override.** `FilterNode.computePhysical` still forces `estimatedRows = 1` when
  equality conjuncts cover a unique key. A stamped join-filter selectivity must not disturb that
  branch.

## TODO

### Phase 1 — attribution helper

- Add `packages/quereus/src/planner/util/column-origins.ts` with `ColumnOrigin` and
  `collectColumnOrigins`, deduping by node identity, with a file doc-comment stating the
  "identity, not schema, distinguishes self-join sides" invariant.
- Unit-test it directly against optimized plans: a two-table join, a self-join (two distinct
  `ref`s sharing one `TableSchema`), a join under a `Project` with a computed column (the computed
  attribute id is absent from the map), and a join over a `values` list (empty map).

### Phase 2 — rule path

- Split `ruleFilterSelectivity` into the existing single-table path and a new multi-relation path;
  keep each in its own small function rather than one branching body.
- Implement conjunct attribution, the single-relation and cross-relation estimators, the
  statistics gate, and combination via `combineConjunctive`.
- Define `CROSS_RELATION_INEQUALITY_SELECTIVITY` as a documented named constant.
- Add the `NOTE:` comments called out under *Edge cases* (outer-join simplification, aggregate
  pass-through, per-filter walk cost).

### Phase 3 — tests

Extend `packages/quereus/test/optimizer/filter-selectivity.spec.ts`.

- Replace the existing `leaves selectivity unstamped for a multi-table (join) filter source` case.
  Keep an unstamped assertion for the **un-analyzed** join (the statistics gate), and add stamped
  assertions for the analyzed one. Do not delete the coverage — retarget it.
- Two analyzed tables joined, `where a.cat = 'x' and b.cat = 'y'` ⇒ stamped
  `combineConjunctive([1/ndv_a_cat, 1/ndv_b_cat])`, and strictly below `DEFAULT_FILTER_SELECTIVITY`.
- Self-join `where a.age > b.age` ⇒ stamped `CROSS_RELATION_INEQUALITY_SELECTIVITY`, and the two
  sides are recognised as distinct relations (assert the value is not the single-table estimate).
- Equi cross-relation conjunct in the `where` (not the `on`) ⇒ stamped from `joinSelectivity`.
- Analyzed join, predicate over a computed projection only ⇒ unstamped.
- Join where only one side is analyzed ⇒ stamped from that side's conjunct alone; the other
  conjunct contributes nothing.
- Re-optimizing an already-stamped plan changes nothing (idempotence).

### Phase 4 — validate & document

- Update `docs/optimizer.md:296`: the join half of the "not yet decomposed" sentence is now stale.
  Describe per-conjunct attribution, the cross-relation cases, the statistics gate, and the
  outer-join simplification.
- `yarn build`, then `yarn lint`, then `yarn test 2>&1 | tee /tmp/join-sel-test.log; tail -n 80
  /tmp/join-sel-test.log`.
