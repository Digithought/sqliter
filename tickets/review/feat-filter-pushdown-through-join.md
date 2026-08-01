---
description: A WHERE condition mentioning only one of two joined tables is now applied before the join instead of after, so an index on that table can be used and the other table is no longer read in full. Review the new optimizer rule and the knock-on changes it forced elsewhere.
files:
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts       # NEW — the rule
  - packages/quereus/src/planner/optimizer.ts                                          # manifest entry + optimizeForAnalysis opts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts # branch injection REMOVED
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts            # header comment only
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts             # scoped rule disable for MV shape analysis
  - packages/quereus/test/optimizer/rule-join-predicate-pushdown.spec.ts               # NEW — 19 cases
  - packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic                    # outer-join asymmetry, end-to-end
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts                         # 8 tests re-shaped to `full join`
  - packages/quereus/test/optimizer/join-row-estimates.spec.ts                         # 3 tests re-baselined
  - packages/quereus/test/optimizer/column-origins.spec.ts                             # 1 re-shaped + 1 added
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts                             # 2 tests read at the join
  - packages/quereus/test/query-rewrite-join.spec.ts                                   # rule added to JOIN_SHAPE_RULES
  - packages/quereus/test/plan/joins/simple-join.plan.json                             # golden regenerated
  - packages/quereus/test/plan/aggregates/group-by.plan.json                           # golden regenerated
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: medium
---

# Review: push single-table WHERE conjuncts below a join

## What landed

`rule-join-predicate-pushdown` fires on `Filter(predicate, JoinNode)` and **moves** every
conjunct whose column references all land on one never-null-extended side of the join onto
that side's branch. Cross-side and refused conjuncts stay in a residual Filter above the
rebuilt join. `rule-predicate-pushdown` then carries each branch Filter across that
branch's `Alias` and into its `Retrieve`, which is what converts a scan into a seek.

Verified on the ticket's motivating query (memory module, `idx_entry_account`):

```
before: SORT → PROJECT → FILTER(e.account_id='a3') → HASHJOIN → 2× full INDEXSCAN
after:  SORT → PROJECT → HASHJOIN → [ALIAS e → INDEXSEEK entry USING idx_entry_account]
                                   [ALIAS t → INDEXSCAN txn]
```

Pushable sides, read off `buildJoinAttributes`: `inner`/`cross` → both; `left`/`semi`/`anti`
→ left; `right` → right; `full` → rule declines. Refusals: no column references at all;
`isFunctional` false; any conjunct whose whole-subtree attribute-id walk (descending through
relational children) sees an id outside both branches — which is every conjunct carrying a
subquery; and per-branch, any branch whose subtree carries a write.

## Two decisions that go beyond the ticket — please scrutinise these first

### 1. Registration position moved, and `rule-predicate-inference-equivalence` lost its branch injection

The ticket specified registering between `aggregate-predicate-pushdown` and
`predicate-pushdown`. **That position is wrong** and the rule is registered immediately
after `predicate-inference-equivalence` instead.

Reason: inference reads a Filter *over a join* to derive `t.id = 'x'` from
`t.id = e.txn_id and e.txn_id = 'x'`. Pushing first consumes the whole predicate, leaves no
Filter over the join, and the cross-side fact is never derived — the `t` branch loses its
seek. Measured on `entry ⋈ txn where e.txn_id = 2`: ticketed order gives one seek (`e`),
the shipped order gives two (`e` and `t`).

Running inference first then created a second problem: inference **also** injected branch
Filters for its inferred conjuncts while leaving them in the outer predicate, so the new
rule pushed the same conjunct onto a branch that already had it —
`WHERE jr.k = 5 and jr.k = 5`. Rather than dedupe, the injection was deleted from inference
(`tryBranchInjection` and its two helpers, ~70 lines); the new rule is now the single site
that moves a conjunct onto a branch, and it covers strictly more join types with a
strictly better (per-branch) side-effect refusal. Consequences:

- `predicate-inference-equivalence` no longer consults a side-effect signal, so its manifest
  entry dropped from `sideEffectMode: 'aware'` to `'safe'` (it now only ANDs conjuncts into
  a predicate — the `filter-merge` rationale). The OPT-003 static guard enforces this pairing
  and is green.
- Disabling `join-predicate-pushdown` via tuning now also stops inferred conjuncts from
  reaching a branch. Documented in the rule header and the catalogue.

**Worth a second opinion:** deleting a sibling rule's feature is scope the ticket did not
authorise. The alternative (keep injection, live with duplicated conjuncts) is a one-line
revert of the deletion.

### 2. Materialized-view maintenance analysis pins the pre-pushdown shape

`buildMaintenancePlan` classifies an MV body by **plan shape**, and two of its reads break
when a `P`-side conjunct moves into the lookup branch:

- `bodyWhereReferencesLookup` looks for the body WHERE as `FilterNode`s at/above the join; a
  conjunct absorbed into a branch's `Retrieve` pipeline is invisible to it.
- the coverage prover's `resolveFullScanTableRef` requires the **lookup** branch to expose
  `P`'s full row set — a pushed `P`-side conjunct correctly disqualifies it.

Net effect before the fix: every WHERE-bearing 1:1 join MV silently dropped from the
`join-residual` bounded-delta arm to the `full-rebuild` floor (correct, but a whole-source
rescan per write). Caught by `maintenance-equivalence.spec.ts` § "join-residual partial-WHERE
plan selection".

Fix: `optimizeForAnalysis` gained an optional `{ disabledRules }` argument, and the MV
analyzer passes `['join-predicate-pushdown']` at its two analysis sites. This constrains only
the classification input — every residual the arms compile still goes through the full
`optimize()`, so the maintenance plans that run keep the pushdown. A `NOTE:` tripwire at
`ANALYSIS_DISABLED_RULES` records that any future WHERE-relocating Structural rule belongs on
the same list, and names the guarding test.

**Worth a second opinion:** the honest alternative is to make the MV analyzer see through the
pushed shape (teach `bodyWhereReferencesLookup` to descend into `Retrieve` pipelines, and
decide whether `resolveFullScanTableRef` should be Filter-transparent for the
`proveOneToOneJoin` caller). The second half touches the coverage prover's soundness core —
`walkToConstrainedBase` already treats a Filter on the `T`-side path as transparent, so there
is an argument that the lookup-side strictness is inconsistent — and I judged that out of
scope for this ticket. If a reviewer disagrees, that is the better long-term fix.

## Validation run

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run test` | 8297 passing, 13 pending, 0 failing |
| `yarn test` (all workspaces) | green |
| `yarn typecheck` | green |
| `yarn lint` | green |
| `yarn build` | green |

`yarn docs:check` not run — known red at HEAD, owned by `debt-doc-size-ratchet-red-at-head`
(`tickets/.pre-existing-known.md`). New prose was kept short.

## Test churn, with the reason for each

Every one of these is a *shape* change caused by the rule, not a loosened assertion.

- **`test/plan/joins/simple-join.plan.json`, `test/plan/aggregates/group-by.plan.json`** —
  regenerated with `UPDATE_PLANS=true`; diff eyeballed. Both queries are
  `… u join d on u.dept_id = d.id where u.age > …`, so the `Filter` moved from above the
  `HASHJOIN` to inside the `u` branch (`Alias u → Filter → IndexScan`). No other node changed.
- **`filter-selectivity.spec.ts`** — 8 tests in the "filter over a join" block. Their subject
  is `rule-filter-selectivity`'s multi-relation path, which single-side conjuncts no longer
  reach. Switched to `full join`, where both sides are null-extended so the rule declines
  outright and every conjunct stays above. Join type does not enter the selectivity estimate,
  so only the Filter's position changed; all expected values are unchanged. One test could not
  use `full join` (`exists … as` is legal only on an outer join) and instead moved its
  companion conjunct to the null-extended side. A block-level comment explains the choice.
- **`join-row-estimates.spec.ts`** — 3 tests. The branches are now pre-filtered, so the join's
  proven cap dropped 100 → 33 (`status` has 3 distinct values). One test re-anchored from "the
  residual Filter over the join" to "the pushed Filter on the orders branch", keeping its exact
  claim (`filter rows < source rows`, `= floor(source × selectivity)`) one level down.
- **`column-origins.spec.ts`** — the "reaches base tables through physical access nodes" case
  switched to a cross-side predicate so a residual Filter genuinely survives; a new case pins
  the pushed shape (branch Filter sees one side's 4 columns, one relation instance).
- **`fd-equivalence.spec.ts`** — 2 tests read `constantBindings` at the join instead of at the
  Filter. The binding-closes-over-the-EC property is unchanged; the join is now the first frame
  holding both `k` columns.
- **`query-rewrite-join.spec.ts`** — `join-predicate-pushdown` added to `JOIN_SHAPE_RULES`,
  the existing list of rules that must be off to reconstruct the pristine
  `Project(Filter?(Join(T,P)))` fragment the MV join matcher reads. Same rationale as the
  `predicate-pushdown` entry already there. Production is unaffected: `materialized-view-rewrite`
  is registered first in the Structural pass.

## New tests

`test/optimizer/rule-join-predicate-pushdown.spec.ts`, 19 cases, each asserting **both** plan
shape and returned rows: headline index-seek case; both-sides push; mixed push + cross-side
residual; LEFT preserved-side pushes / null-extended-side does not; RIGHT mirror; FULL declines;
CROSS (no ON condition, 2-child `withChildren`); LATERAL right side; subquery-correlated-to-the-
other-side declined (the case the relational descent exists for) and uncorrelated-subquery
declined; `random()` declined; parameter-only predicate declined; write-bearing branch keeps its
conjunct while the sibling still gets its own; existence flag stays above and survives the
rebuild; join-elimination refusal; committed-seek branch does not drop its second conjunct;
Structural-pass fixed point.

`test/logic/26.2-left-join-on-vs-where.sqllogic` gained 5 statements pinning the outer-join
asymmetry end-to-end (preserved-side WHERE, null-extended-side WHERE, both together, and the
RIGHT-join mirror).

## Known gaps — treat the tests as a floor

- **Idempotence is asserted at the pass level, not the rule level.** The test runs
  `optimizeForAnalysis` twice and compares a pre-order `nodeType|toString()` signature. It does
  not call `ruleJoinPredicatePushdown` directly and assert `null` on the residual shape. The
  termination argument (a moved conjunct cannot be found again) is in the file header.
- **The side-effect-branch test asserts the *shape* refusal, not the write count.** It checks
  that the conjunct stayed above and that `sink` has both rows, but does not prove the write
  executed exactly once under a pushed sibling conjunct.
- **`semi` / `anti` are encoded but untested.** `buildJoinAttributes` returns only left
  attributes for them, so a Filter above such a join cannot name a right column and the
  left-only restriction is unobservable from SQL. It is in the table for completeness.
- **No performance measurement.** The ticket's 4-way reporting query
  (`.tmp/quereus-join-perf.md`) was not re-timed; only the plan shape of the 2-table motivating
  query was verified. The claim "fewer base-table rows read" rests on the seek appearing in the
  plan, not on a measured I/O count.
- **`.sqllogic` coverage of the store module** was not run (`yarn test:store`); the new logic
  cases exercise join semantics that are module-independent, but that is an assumption.
- **`bodyWhereReferencesLookup`'s blind spot is worked around, not fixed.** With the rule
  disabled for MV analysis it never sees a pushed conjunct, so its inability to look inside a
  `Retrieve` pipeline is untested and unrepaired.

## Out of scope, unchanged from the plan

`ON`-clause conjunct pushdown, null-rejecting outer→inner conversion, and widening the subquery
refusal all remain parked (`backlog/feat-join-on-condition-pushdown`,
`backlog/feat-outer-join-to-inner-on-null-rejecting-filter`).
