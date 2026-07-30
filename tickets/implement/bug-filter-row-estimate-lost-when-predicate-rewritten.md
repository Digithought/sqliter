description: The query planner works out how many rows a WHERE clause will keep, then throws that number away again when a later step rewrites the condition — so a query with a subquery in its WHERE clause ends up planned with a crude guess. Make the planner work the number out again after the rewrite.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md, docs/optimizer-rules.md
difficulty: medium
----

## Confirmed cause

`FilterNode` carries an optional `selectivity` — the fraction of source rows the `where`
clause is expected to keep. `rule-filter-selectivity` computes it once in the **Physical**
pass and stamps it on the node; `FilterNode.estimatedRows` / `computePhysical` multiply it
into the source cardinality, falling back to the flat `DEFAULT_FILTER_SELECTIVITY` (0.5)
when it is absent.

`FilterNode.withChildren` drops `selectivity` whenever the predicate child is a different
object, on the grounds that the number was computed against the old predicate. The comment
justifying that claims the Physical pass is the last rule-bearing pass over Filters. It is
not. **`scalar-subquery-cache` (PostOptimization, `PlanNodeType.ScalarSubquery`) wraps an
uncorrelated scalar subquery's inner in a `CacheNode`.** PostOptimization is bottom-up, so:

```
ScalarSubquery rewritten (new node)
  → BinaryOpNode.withChildren  → new predicate object
    → FilterNode.withChildren  → predicate !== this.predicate → selectivity dropped
      → then the Filter's own PostOptimization rules run, on an unstamped node
```

Nothing re-stamps afterwards, so the plan handed to emission carries no estimate and every
consumer falls back to 0.5.

### Reproduction (measured, not hypothetical)

Schema/data from the existing `multi-relation filter selectivity` block in
`test/optimizer/filter-selectivity.spec.ts` (tables `o` 100 rows / `r` 20 rows, both
`analyze`d). Reading `selectivity` off the residual `FilterNode` after `getPlan(sql)`:

| query | first `optimize()` | with `scalar-subquery-cache` disabled |
|---|---|---|
| `select * from o join r on o.rid = r.id where o.qty = (select max(qty) from r r2) and o.cat = 'a'` | `undefined` | **0.25** |
| `select * from o where o.qty = (select max(qty) from r r2) and o.cat = 'a'` (upper Filter) | `undefined` | **0.333…** |
| `select * from o where o.qty = 1 and o.cat = 'a'` (no subquery) | 0.144… | 0.144… |

Disabling the one rule via `tuning.disabledRules` restores the stamp in both subquery
cases, which pins the mechanism exactly. The `WHERE o.cat = 'a'` Filter in the second query
keeps its 0.25 — its own predicate contains no subquery, so it is never re-minted.

Confirmed *not* the cause: `filter-conjunct-ordering` (PostOptimization, Filter) already
constructs its result directly with `filter.selectivity` carried across, precisely to avoid
this. It is only ever a victim — by the time it fires, the Filter has already been re-minted
unstamped.

## Fix

Register `ruleFilterSelectivity` a **second time**, in `PassId.PostOptimization`, under a
distinct id (`filter-selectivity-restamp`). Keep the existing `PassId.Physical` registration
untouched — the Physical stamp is what feeds the physical/PostOptimization cost readers
(`join-physical-selection`, `monotonic-limit-pushdown`, `key-set-seek`, the materialization
advisory), so moving stamping later instead of adding to it would degrade those decisions.

Why this works without further change:

- PostOptimization is bottom-up, and `PassManager.finalizeNode` splices rewritten children in
  (dropping the stamp) *before* running the node's own rules — so the re-stamp rule sees the
  freshly re-minted Filter and fires on it.
- `withChildren` mints a new node id and `finalizeNode` does **not** call
  `inheritVisitedRules`, so the applied-rule memo from the Physical firing does not suppress
  the PostOptimization firing.
- The rule's first line (`if (filter.selectivity !== undefined) return null`) makes it a
  no-op on any Filter whose stamp survived — so the second registration costs one declined
  call per surviving Filter and changes nothing on plans that were already correct.
- Both estimation paths read a *physical* source subtree, which they already do today (the
  rule runs in the Physical pass bottom-up, i.e. after `select-access-path` has replaced
  `Retrieve` with access nodes). PostOptimization sources are the same shape or further
  lowered; `extractTableSchema` and `collectColumnOrigins` both walk it.
- `registerManifest` scopes duplicate-id detection per pass and a unit test in
  `test/optimizer/rule-manifest.spec.ts` already pins "same id in two different passes is
  allowed" — but use a distinct id anyway so `disabledRules`, diagnostics and the
  cross-pass applied-rule memo can tell the two firings apart.

Place the new manifest entry at the **start** of the PostOptimization block, with a comment
explaining that it must precede `filter-conjunct-ordering` (which copies the stamp forward)
rather than depend on `applyPassRules`' fixpoint loop to get there.

### Rejected alternative

Making `withChildren` preserve the stamp when the predicate is only *cosmetically* re-minted
(same scalar skeleton, differing only inside relational subtrees). This would be order-
independent, but: `fingerprintExpression` deliberately returns a unique `_SQ:<node id>` for
subquery-bearing nodes, so it cannot be reused; a new "skeleton equality" utility would have
to assert that no selectivity estimator ever reads inside a subquery, which is true of the
single-table path but *not* obviously true of `conjunctRelations` for a **correlated**
subquery (it walks relational children and does resolve outer attribute ids); and it
preserves a stale number rather than re-deriving a correct one. Re-stamping re-derives, so it
cannot be subtly wrong.

## Residual: passes after PostOptimization

`MaterializationAdvisory` (custom-execute pass, order 35, after PostOptimization) walks
`getChildren()` — which includes scalar children — and can therefore wrap a relational node
that sits inside a Filter's predicate (a `CacheNode` on a multi-parent subtree, or the
`materialize` mark on a shared `CTENode`). That would re-mint the predicate and drop the
stamp again, after the re-stamp rule has run.

**No reproduction was found.** The obvious candidate — a CTE referenced from two scalar
subqueries in one `where` — turns out to have nothing to stamp in the first place (traced with
`DEBUG=quereus:optimizer:rule:filter-selectivity`: the rule never fires on that Filter even
in the Physical pass, so the shape is unestimable independently of this bug). Treat it as a
tripwire, not work: leave a `NOTE:` at the new manifest entry saying that a pass after
PostOptimization which re-mints a Filter predicate will lose the stamp again, and that the
fix at that point is to move the re-stamp behind the materialization pass. If the
implementation happens to turn up a query where it does bite, that is a real defect — fix it
rather than noting it.

## Also in scope

- Correct the stale invariant comment in `FilterNode.withChildren` (the "In practice the
  Physical pass is the last rule-bearing pass over Filters, so nothing re-sources a stamped
  one" block). PostOptimization re-mints stamped Filters routinely; say so, and say that the
  re-stamp rule is what recovers the estimate. The tripwire about a *carried* selectivity
  going stale on a source-only re-mint is still valid and should survive the rewrite.
- The header comment of `rule-filter-selectivity.ts` says "Runs in the Physical pass
  (bottom-up)" — update it to describe both registrations and why.
- `docs/optimizer.md` (§ around "Filter row estimates") calls it "the `rule-filter-selectivity`
  Physical-pass rule". Update.
- `docs/optimizer-rules.md` line ~54 describes `filter-conjunct-ordering` as registered
  "after ... `filter-selectivity`, and (bottom-up) `scalar-subquery-cache`" — still true, but
  mention the re-stamp so the ordering story stays complete. Add a catalogue entry for the
  re-stamp registration if the file lists rules by id.

## Not in scope

`optimize()` is not a fixpoint on these queries — re-running it on an already-optimized plan
merges two stacked Filters into one (measured on the single-table reproduction above: the
`Retrieve` → `IndexScan` lowering in the Physical pass leaves `Filter(o.qty = (subquery))`
directly over `Filter(o.cat = 'a')`, a pair `filter-merge` — a Structural rule — never gets
another look at). Filed separately as backlog `debt-optimize-not-fixpoint-stacked-filters`.
Because of it, **do not** write tests that assert "what a second `optimize()` produces" as the
expected first-pass output; assert against directly computed expectations
(`combineConjunctive([...])`, `1/ndv`) the way the existing spec does.

## TODO

- Add the `filter-selectivity-restamp` manifest entry to `RULE_MANIFEST` in
  `packages/quereus/src/planner/optimizer.ts`, at the head of the PostOptimization block,
  `pass: PassId.PostOptimization`, `nodeType: PlanNodeType.Filter`, `phase: 'impl'`,
  `fn: ruleFilterSelectivity`, `sideEffectMode: 'safe'` (same justification as the Physical
  entry: it rebuilds an identical Filter with only an added estimate).
- Add the `NOTE:` tripwire about post-PostOptimization passes at that entry.
- Rewrite the stale invariant comment in `FilterNode.withChildren`.
- Update the header doc-comment of `rule-filter-selectivity.ts`.
- Extend `test/optimizer/filter-selectivity.spec.ts`: in the `multi-relation` block, assert
  the join reproduction comes out stamped at `combineConjunctive([1 / ndv['o.cat']])` (i.e.
  `1 / ndv['o.cat']`, the one estimable conjunct) on the FIRST `optimize()`; add a
  single-table case asserting the upper Filter of
  `select * from o where o.qty = (select max(qty) from r r2) and o.cat = 'a'` is stamped.
  Keep the existing "re-optimizing an already-stamped plan changes nothing" idempotence test
  passing.
- Add a regression assertion that a Filter whose predicate holds no subquery still keeps the
  stamp it got in the Physical pass (guards against the re-stamp registration accidentally
  clobbering rather than filling in).
- Update `docs/optimizer.md` and `docs/optimizer-rules.md` as listed above.
- Validate: `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 80
  /tmp/test.log`, then `yarn lint`. Golden plan JSON under `test/plan/` embeds
  `estimatedRows`; none of the current golden queries contain a subquery predicate, so no
  regeneration is expected — if one moves, verify the new number is the stats-derived estimate
  before regenerating.
