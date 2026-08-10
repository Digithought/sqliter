description: A query that sorts by a correlated aggregate subquery (e.g. `order by (select count(*) from c where c.fk = o.k)`) used to re-run the inner query once per row; it is now rewritten to the same one-pass grouped left join the SELECT/WHERE sites already use. Reviewed, tested, and shipped.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic, docs/optimizer-rules.md

# Complete: decorrelate correlated scalar-aggregate subqueries in ORDER BY (Sort anchor)

## What shipped

A fourth match site for the scalar-aggregate decorrelation rule,
`ruleScalarAggDecorrelationSort` (id `scalar-agg-decorrelation-sort`, anchored on
`SortNode`, Structural pass, `sideEffectMode: 'aware'`), sharing the per-subquery
rewrite (`decorrelateOne` / `decorrelateAll`) with the Project / Aggregate /
Filter anchors. A correlated scalar-aggregate subquery in an ORDER BY key —
`order by (select count(*) from c where c.fk = o.k)` — becomes a grouped LEFT
join below the Sort, with the sort key reading the grouped value column and the
result capped by a bare pass-through Project (`capToAttributes`) so the Sort's
output shape is byte-identical (no leaked join columns). The inner table is
scanned once instead of once per outer row.

## Review scope

Reviewed the implement diff (516609c2) plus the earlier commits that built the
rule, with fresh eyes, before reading the handoff. Then reconciled against the
current tree — which had moved on since the handoff was written (see below).

## Review findings

**Checked:** rule correctness (index arithmetic for the substituted value read,
stacked-join layout for multiple subqueries, empty-value CASE guard, LEFT-join
cardinality, the pass-through cap's index/id preservation); registration and
`sideEffectMode`; source hygiene (short shared helpers, single-purpose funcs,
comment clarity); docs accuracy against every touched file; lint; full test
suite.

**Correctness — no defects found.** The Sort rewrite is sound:
- The cap Project indexes the outer columns at `0..n-1` of the join output
  (LEFT join puts the outer on the left), preserving ids/types — verified against
  both the enclosing-Project and bare-`SELECT *` shapes.
- `outerAttrIds` is computed once from the *original* Sort source, so a second
  stacked subquery still correlates only to the true outer, and each
  replacement's value-column index is computed against its own (growing) left
  source — the stacked-join layout `[outer][agg1][agg2]` keeps every earlier
  index valid.
- The scope bail (correlation column projected away → stripping Project → rule
  bails, subquery stays correlated but correct) is real and intentional, pinned
  by a plan-spec test and a `.sqllogic` case.

**Test coverage — one gap filled (minor, fixed in this pass).** The handoff
itself flagged "two *different* correlated subqueries in one ORDER BY" as
untested. Added a plan-spec test
(`decorrelates two distinct correlated subqueries in one ORDER BY (stacked joins)`)
asserting both subqueries dissolve, two grouped aggregates appear, and results
match the correlated baseline. Passes. The other flagged angles are already
covered: the non-NULL empty-value CASE path is exercised by `count(*)` (empty →
0); `total` would take the identical path. The existing sort-anchor scan-count
test (`correlated-scalar-agg-scan-count.spec.ts`) proves the actual N+1
elimination (one child scan vs N with the rule disabled), not just result parity.

**Docs — one stale sentence corrected (minor, fixed in this pass).** The handoff
was written against a tree where an ORDER BY over a GROUP BY aggregate query
threw a spurious "Scalar subquery returned more than one row" (a pre-existing
planner scope-leak). A later triage run (5167519f) **fixed that root cause** in
`planner/building/select.ts` — a nested SELECT no longer inherits its enclosing
query's aggregate context — and re-enabled the GROUP-BY-ORDER-BY cases in
`07.7-scalar-agg-decorrelation.sqllogic` (both correlated and uncorrelated
forms). `docs/optimizer-rules.md` still described that case as "cannot yet be
exercised … tracked in `fix/order-by-aggregate-subquery-scope-leak`", which is
now wrong; updated it to state the scope-leak was fixed and the case is pinned.
The rule-file module header and NOTE only ever documented the
stripping-projection scope, so they needed no change.

**Housekeeping observation (not acted on — not this ticket's files):** because
the triage run already landed the scope-leak fix, the ticket
`fix/order-by-aggregate-subquery-scope-leak` and the entry in
`.pre-existing-known.md` describing it as "in-flight" are now redundant. That
fix ticket is a separate pipeline item; its own run will find the bug already
resolved and the tests green. Left untouched deliberately.

### Tripwires (parked, not queued as tickets)

- **Stripping-projection optimization gap** — correlation column projected away,
  Sort sits above a stripping Project, rule bails to a correct-but-unoptimized
  correlated plan. Parked as a `NOTE:` at the rule site + module-header `SCOPE:`
  note + `docs/optimizer-rules.md`; follow-up is
  `backlog/feat-decorrelate-order-by-subquery-nonselected-column`. Not a defect.
- **Redundant cap Project** — for an ORDER BY already under a SELECT Project the
  `capToAttributes` cap is a pass-through the trivial-project rules cannot fold
  (its source carries more attributes than it outputs). One harmless extra node;
  documented at `capToAttributes`. Only matters if it surfaces in plan-shape
  noise or profiling (conditional).

## Validation

- `yarn workspace @quereus/quereus run test`: **7088 passing, 0 failing**, 13
  pending (7087 + the one test added this pass).
- `yarn workspace @quereus/quereus run lint`: clean (eslint + test-file
  type-check).

## Follow-ups (already filed, unchanged by this review)

- `backlog/feat-decorrelate-order-by-subquery-nonselected-column` — thread the
  grouped value column through a stripping Project so the projected-away
  correlation-column case also decorrelates.
- `fix/order-by-aggregate-subquery-scope-leak` — already resolved by triage run
  5167519f (see the housekeeping observation above); expected to close on its
  own run.
