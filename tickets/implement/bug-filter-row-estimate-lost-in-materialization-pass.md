description: The query planner works out how many rows a WHERE clause will keep, but a late planning step can throw that number away again — so some queries are still planned on a crude 50% guess. Add a final re-derivation step at the end of planning so the number always survives.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/rule-manifest.spec.ts, docs/optimizer.md
difficulty: medium
repro: verified
----

## Root cause

`FilterNode.withChildren` (`nodes/filter.ts:265`) carries the stamped `selectivity` forward
only when the predicate child is the **same object**. Any pass that rewrites something inside a
predicate therefore erases the estimate, and `FilterNode.estimatedRows` falls back to the flat
`DEFAULT_FILTER_SELECTIVITY` (0.5).

`rule-filter-selectivity` is registered twice today — `filter-selectivity` (Physical, order 20)
and `filter-selectivity-restamp` (PostOptimization, order 30). The **Materialization** pass
(order 35) runs after both and rebuilds every path on which it marks a `with` clause for shared
materialization or wraps a node in a `CacheNode`. When that path runs through a Filter's
predicate, the stamp is erased with nothing left to restore it.

**The one site that must change: the end of the pass pipeline.** There is no re-derivation point
behind the last plan-mutating pass, so the estimate's survival depends on which pass happens to
touch a predicate last.

## Repro (verified — measured, not inferred)

Fixture: `o` = 100 rows, `ANALYZE`d; `o.qty` has 3 distinct values, `o.rid` has 20. Measured by
dumping every `FilterNode.selectivity` out of `db.getPlan(sql)` on a scratch spec:

| query | upper Filter, today | with the fix |
| --- | --- | --- |
| `with c as (…) select * from o where o.qty = (select max(qty) from c) and o.cat = 'a'` | `0.3333…` | `0.3333…` |
| same, but `with c as materialized (…)` | **`undefined`** | `0.3333…` |
| `with c as (…) select * from o where o.qty = (select max(qty) from c) and o.rid = (select min(qty) from c) and o.cat = 'a'` | **`undefined`** | `0.028867…` |

Row 2 is `1 / ndv['o.qty']` = 1/3 — identical to row 1, which is the point: two spellings of one
query must not disagree. Row 3 combines two estimable conjuncts,
`combineConjunctive([1 / ndv['o.qty'], 1 / ndv['o.rid']])` = `0.05 · √(1/3)` = `0.0288675…`
(the source `fix/` ticket predicted `1 / ndv['o.qty']` for this one — that was wrong; it has two
subquery conjuncts, not one).

Row 3 needs no hint: two references to one `with` clause trip the same materialization mark.

## Chosen fix — a final re-derivation pass

Add a new pass between Materialization (35) and Validation (40) whose job is "re-derive any plan
estimate an earlier pass invalidated", and register `rule-filter-selectivity` in it a third time.

```
ConstantFolding 0 → Structural 10 → Physical 20 → PostOptimization 30
                 → Materialization 35 → FinalEstimates 37 → Validation 40
```

Suggested naming (name the *purpose*, so it is obvious where a future
"must-hold-at-emission" derivation goes):

```ts
// framework/pass.ts
export enum PassId {
  …
  /** Re-derive plan estimates that a later-than-Physical pass invalidated */
  FinalEstimates = 'final-estimates',
  Validation = 'validation',
}

createPass(
  PassId.FinalEstimates,
  'Final Estimates',
  'Re-derive plan estimates invalidated by a later pass rewriting inside a node',
  37,
  TraversalOrder.BottomUp
),
```

```ts
// optimizer.ts RULE_MANIFEST
{
  pass: PassId.FinalEstimates,
  id: 'filter-selectivity-final',
  nodeType: PlanNodeType.Filter,
  phase: 'impl',
  fn: ruleFilterSelectivity,
  sideEffectMode: 'safe',
},
```

**Prototyped and measured.** Exactly these two edits produce the "with the fix" column above.
`extractRowSourceTableSchema` and `collectColumnOrigins` both descend generic single-relation
wrappers, so a `CacheNode` newly sitting under the Filter does not block the walk — the
re-derived number is the same one the Physical pass produced.

### Why this shape and not the other two

- **Carry the stamp through the materialization advisory's own rebuilds.** Sound (the advisory
  only wraps/marks — it never changes predicate semantics) and free, but it closes only the
  materialization instance of the hole. The next pass that rewrites inside a predicate loses the
  stamp again.
- **Make `FilterNode.withChildren` preserve the stamp on a "cosmetic" re-mint.** Rejected by
  `bug-filter-row-estimate-lost-when-predicate-rewritten` and still rejected:
  `fingerprintExpression` deliberately returns a unique value for subquery-bearing nodes, so a
  skeleton-equality test would have to assume no estimator ever reads inside a subquery — not
  true for a correlated one.
- A re-stamp appended inside the materialization pass's own `execute` is the same generality as
  the first option with worse placement.

A dedicated final pass closes the hole for every pass ordered before it, present and future,
which is what the source ticket asked for.

### Cost

One extra bottom-up traversal of the plan per `optimize()`, on top of the six already run. The
rule returns `null` in O(1) on any Filter whose stamp survived (`selectivity !== undefined`), so
the added estimator work is bounded by the Filters still unstamped after PostOptimization — the
ones that were about to be planned on 0.5, plus the permanently-unstampable ones, which now pay
a fourth `collectColumnOrigins` walk (see the existing `NOTE:` in `rule-filter-selectivity.ts`;
that NOTE says three — update the count). Not separately profiled; the full
`test/optimizer/**` suite ran ~5s with and without the prototype.

## Known breakage to fix, not work around

`test/optimizer/filter-selectivity.spec.ts:352` — "leaves that same Filter unstamped when the
re-stamp registration is disabled" fails under the prototype (`expected 0.25 to be undefined`).
It disables only `filter-selectivity-restamp`; the new registration then fills the stamp back in.
It is a **negative control for the PostOptimization registration**, so it must disable both
`filter-selectivity-restamp` and `filter-selectivity-final` and say why in a comment. That was
the only failure across `test/optimizer/**` (1626 passing, 1 failing).

## Guard against the hole re-opening

A runtime assertion in the Validation pass ("a Filter that could be estimated is unstamped")
would have to re-run the estimator to know, which is the re-stamp itself — redundant given the
fix. Use a **static manifest guard** instead: a unit test asserting that no pass ordered *after*
`PassId.FinalEstimates` carries any registered rules, with a failure message pointing at this
ticket. Today `PassId.Validation` has zero manifest entries, so the assertion holds as written;
if someone later adds a rule behind the re-derivation point they get a loud, explanatory failure
and must decide deliberately rather than silently re-opening the hole.

## Adjacent, deliberately not merged

`tickets/backlog/debt-optimizer-rule-order-constraints` proposes declarative `after:`/`before:`
edges on manifest entries and touches the same two files. It is a different root cause (ordering
*within* a pass is prose-only) and is backlog, not open work — leave it alone. If it ever lands,
the static guard above becomes a natural special case of it.

## TODO

- [ ] Add `PassId.FinalEstimates` and its `createPass(…, 37, TraversalOrder.BottomUp)` entry to
      `STANDARD_PASSES` in `planner/framework/pass.ts`, placed between `createMaterializationPass()`
      and the Validation entry.
- [ ] Add the `filter-selectivity-final` entry to `RULE_MANIFEST` in `planner/optimizer.ts`,
      after the PostOptimization block.
- [ ] Delete the `KNOWN GAP:` paragraph on the `filter-selectivity-restamp` manifest entry
      (`optimizer.ts:911-921`) and replace it with a pointer to the third registration.
- [ ] Update the "Registered TWICE" header comment in
      `rules/predicate/rule-filter-selectivity.ts` to describe three registrations and what each
      one recovers; correct the "third time" walk count in the `NOTE:` at `:92-102` to four.
- [ ] Update the `withChildren` comment in `nodes/filter.ts:249-265` — it names
      `filter-selectivity-restamp` as "what recovers the estimate"; the recovery point is now the
      final pass, and that is what makes dropping the stamp safe regardless of which pass
      re-mints.
- [ ] Fix the negative control at `test/optimizer/filter-selectivity.spec.ts:352` to disable both
      re-stamp registrations.
- [ ] Add a positive test: all three repro queries above stamp their upper Filter at the measured
      values, asserting the `materialized` spelling **equals** the plain spelling exactly.
- [ ] Add a negative control for the new registration alone — disable only
      `filter-selectivity-final`, assert the `materialized` spelling's upper Filter is `undefined`
      while the plain spelling is still stamped. This pins the new behaviour to the new mechanism.
- [ ] Add the static manifest guard (no rules registered in any pass ordered after
      `PassId.FinalEstimates`), in `test/optimizer/rule-manifest.spec.ts` or alongside it.
- [ ] Confirm the two existing cases named in the source ticket still pass unchanged: "reads a
      base column through every CTE spelling that only varies the column list" and "re-stamps a
      filter-over-join whose predicate was re-minted by scalar-subquery-cache".
- [ ] `docs/optimizer.md`: add the new pass to the pass list (it currently runs
      `#### Pass 4: Validation` straight after the materialization section — renumber), rewrite
      the two-registrations paragraph at ~line 368 to three, and delete the known-gap paragraph at
      ~line 370.
- [ ] Run `yarn test` and `yarn lint` from the repo root.
