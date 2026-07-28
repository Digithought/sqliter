description: A WHERE clause sitting above a join used to get a flat 50% row-count guess; it now estimates each condition against whichever table that condition's columns actually come from, but only when those tables have had ANALYZE run on them.
files: packages/quereus/src/planner/util/column-origins.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/test/optimizer/column-origins.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md
----

## What shipped

`ruleFilterSelectivity` gained a second path for a filter whose source spans several base tables.
Previously `extractTableSchema` returned `undefined` on any join and the rule declined outright,
leaving the flat `DEFAULT_FILTER_SELECTIVITY` of 0.5.

**`planner/util/column-origins.ts`** — `collectColumnOrigins(node)` walks a relational subtree via
`getRelations()` and maps every reachable attribute id back to the base-table column that minted it
(`{ ref, table, columnIndex, columnName }`). Keyed on the `TableReferenceNode` *instance*, not the
`TableSchema`, so the two sides of a self-join stay distinct. Dedupes visited nodes by identity.
Attributes minted above a base table — computed projections, aggregate outputs, `values` rows, join
existence flags — are absent, as are anything under a **row-merging operator** (set operation,
recursive CTE), which forwards one branch's attribute ids over rows drawn from every branch.

**`rule-filter-selectivity.ts`** branches: `singleTableSelectivity` (unchanged behaviour) or
`multiRelationSelectivity`. The latter splits the predicate with `splitConjuncts`, attributes each
conjunct to its origin relation(s), estimates per conjunct, and folds with `combineConjunctive`:

- one origin relation → `context.stats.statsOnlySelectivity(table, conjunct)`
- two origin relations, plain binary comparison with a bare column reference on each side →
  `=` uses `joinSelectivity`, `!=`/`<>` uses `1 - joinSelectivity`, `<` `<=` `>` `>=` use the
  exported constant `CROSS_RELATION_INEQUALITY_SELECTIVITY` (1/3)
- everything else (three+ relations, no column refs, any non-base attribute) → skipped
- no conjunct estimable → return `null`, filter stays unstamped exactly as before

**Statistics gate — multi-relation path only.** `StatsProvider` gained an optional
`statsOnlySelectivity`: the same estimate as `selectivity` but returning `undefined` instead of a
fabricated fallback. `CatalogStatsProvider` implements it (and `selectivity` is now defined in terms
of it); a provider that omits it reads as "no real statistics". The multi-relation path uses it, so a
conjunct counts as known only when real statistics answer it. Cross-relation conjuncts additionally
require `columnStats` for both compared columns. Without a gate the rule would have replaced 0.5 with
NaiveStatsProvider's flat 0.1 on every filter-over-join in the repo. The single-table path is
deliberately NOT gated — it keeps stamping naive numbers as it always has.

`docs/optimizer.md` — attribution model, per-conjunct cases, row-merging opacity, the gate,
`statsOnlySelectivity` in the interface listing, and the simplifications.

## Validation

- `yarn build` — clean
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`) across all packages
- `yarn test` — all green, **7521 passing** in `packages/quereus` (7511 before this review's
  additions), no failures anywhere in the monorepo, no pre-existing failures encountered
- Working tree shows no modified golden plans — zero plan churn, verified by `git status`

## Review findings

### Checked

Read the implement diff (`ee68f515`) before the handoff summary. Traced the new code against
`CatalogStatsProvider`, `NaiveStatsProvider`, `splitConjuncts`, `combineConjunctive`,
`extractTableSchema`, `FilterNode.computePhysical`/`withChildren`, `JoinNode.computePhysical`,
`SetOperationNode.buildAttributes`, `RecursiveCTENode.buildAttributes`, `analyze.ts` (column-stats
key casing), and `analysis/attribute-provenance.ts`. Ran an ad-hoc probe over 13 query shapes
against a live optimized plan rather than reasoning from the source alone — that is what surfaced
the two defects below and both filed tickets.

### Fixed in this pass (minor)

- **Set-operation output was attributed to the left branch.**
  `select * from (select id, cat from o union all select id, cat from r) z where z.cat = 'a'` was
  stamped `1/ndv(o.cat)`. `SetOperationNode` forwards the left branch's attribute ids verbatim while
  carrying rows from both branches, so `collectColumnOrigins` read a merged relation as if it were
  `o` alone. This directly contradicted the module's own documented contract ("attributes minted
  above a base table are deliberately absent"), and the error is unbounded — union a 1-distinct-value
  column with a 1000-distinct-value one and the estimate is off by 1000×. The walk now stops at a
  row-merging operator (`SetOperationNode`, `RecursiveCTENode`) and records nothing beneath it.
  A join whose *other* side is a plain table still estimates that side normally. Two tests added.

- **The statistics gate leaked fabricated numbers.** Two holes, both closed by replacing the
  column-stats-presence check with the new `statsOnlySelectivity`:
  - `where lower(o.cat) = 'x'` over an analyzed table passed the gate (stats exist for `o.cat`) and
    then stamped NaiveStatsProvider's flat 0.1, because the catalog's leaf estimator reads the column
    off a *direct* child of the comparison and finds none. Now unstamped.
  - A bare boolean column conjunct (`where o.flag and …`) stamped the naive `defaultSelectivity` 0.3.
    Now unstamped.
  - Cross-relation `=` could reach `joinSelectivity`'s naive `1/max(rowCount)` when a table had
    `statistics` but no `columnStats` for the compared column; the gate now requires column stats for
    both columns.

  An early attempt gated on "the conjunct has a bare column operand", which regressed
  `NOT (o.cat = 'a')` from 0.75 to unstamped — the provider resolves boolean structure the rule
  cannot see. Putting the honest answer on the provider instead of re-deriving its reach in the rule
  keeps the two from drifting. Three tests added, including one locking the `NOT` case.

- **`countRelations` ran on every filter-over-join to build a disabled log message.** Now behind
  `log.enabled` (the pattern already used in `runtime/scheduler.ts`).

- **Simplification:** `conjunctOrigins` built a `Map<TableReferenceNode, ColumnOrigin[]>` whose array
  values were never read after the gate change. Now `conjunctRelations` returning a
  `Set<TableReferenceNode>`.

### Reviewed and accepted as-is

- **Cross-relation `!=` / `<>` rides on a naive join estimate.** Flagged by the implementer as a
  fabricated number reaching the gated path. It is bounded: `NaiveStatsProvider.joinSelectivity` caps
  at 0.5, so `1 - eq` lands in `[0.5, 1]` — it can only ever *relax* the estimate relative to the 0.5
  default, and the true value for a cross-relation `<>` is near 1, so the bound errs toward the
  truth. Skipping the conjunct instead would leave a filter whose only conjunct is `a.x <> b.y`
  unstamped at 0.5, which is strictly worse. Kept, with the bound now documented at the site and a
  test asserting it.
- **`lower()` on the single-table path** still stamps the naive 0.1 — unchanged, and consistent with
  every other single-table predicate. Only the multi-relation path is gated, by design.

### Filed as new tickets (major)

- `backlog/bug-filter-row-estimate-lost-when-predicate-rewritten` — a filter whose predicate contains
  a subquery comes out of `optimize()` unstamped even though the estimate is computable: something
  after the Physical pass rewrites the predicate and `withChildren` drops the stamp with it. Feeding
  the plan back through `optimize()` a second time stamps it correctly, which proves the value was
  available. Affects the pre-existing single-table path too, not just this ticket's work, and
  contradicts the invariant asserted in `FilterNode.withChildren`'s comment. Not caused by this diff.
- `backlog/bug-single-table-selectivity-credited-to-wrong-relation` — `extractTableSchema` walks
  through *any* single-relation operator, including a recursive CTE and an aggregate, so a filter over
  one is estimated against the statistics of a base table that describes a different row population.
  This is the same class of error fixed above in `collectColumnOrigins`; the two paths now disagree
  about the same question. Pre-existing.

### Tripwires (recorded in code, not ticketed)

- **`joinSelectivity` argument order is unenforceable by test.** The rule passes the table owning the
  conjunct's left child first, as the design requires, but `CatalogStatsProvider` is symmetric today
  (`fkPkSelectivity` tries both directions, the ndv path uses `max`), so swapping the arguments would
  fail nothing. Documented at `equiJoinSelectivity` in `rule-filter-selectivity.ts`. Only matters if
  the provider ever becomes order-sensitive.
- **`collectColumnOrigins` is O(N·subtree) for N stacked filters.** Existing `NOTE:` in the rule,
  with the fix (compute once per pass, cache on `OptContext`) if it ever shows in profiles. Left in
  place; not a concern at current plan sizes.
- **The stamp does not move row counts above a join yet.** `JoinNode.computePhysical` derives
  cardinality from its children's *logical* `estimatedRows` and a physical access node exposes none,
  so the join reports `undefined` rows and `FilterNode.computePhysical` has nothing to multiply.
  Confirmed empirically — every filter-over-join in the probe showed `physical.estimatedRows ===
  undefined`. Already tracked in `backlog/debt-join-rows-from-physical-children` (sibling of
  `debt-access-node-catalog-cardinality`) with a `NOTE:` at the site. **This means the feature is
  correct but not yet load-bearing**; nothing downstream reads the improved number until that ticket
  lands, and nothing here needs to change when it does.

### Test coverage added

Ten new cases beyond the implementer's, closing gaps the handoff listed as untested:

`filter-selectivity.spec.ts` — cross-relation `<>` bound; `NOT` boolean structure inside a conjunct;
function-wrapped column unstamped despite ANALYZE; three-relation conjunct skipped; OR spanning two
relations skipped; set-operation source unstamped; base-table side of a join-with-union still
estimated.

`column-origins.spec.ts` — set operation contributes nothing; join with a set-operation side
attributes only the table side; a table referenced only inside a predicate subquery never enters the
map.

### Not covered

Outer-join NULL-extension asymmetry and the aggregate-between-filter-and-join case remain
documented simplifications with `NOTE:`s at the site and no tests — both are deliberate imprecision
rather than defects, and testing them would only pin down numbers the model does not claim to get
right. A `values` list joined to a table is untested beyond the `values`-only source (which is
covered); the origin map is empty for a `values` source either way, so the behaviour is the same as
the tested case.
