description: Rewrite uncorrelated IN-subquery filters into hash semi-joins so they share the join machinery's optimizations, and let key-set filters be pushed down to storage modules as indexed lookups.
prereq: quereus-in-subquery-set-probe
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/join/, packages/quereus/src/vtab/best-access-plan.ts, docs/optimizer-rules.md
----

## Motivation

`quereus-in-subquery-set-probe` fixes the quadratic `WHERE col IN (SELECT …)`
pathology at the runtime layer: the inner result is materialized once into a lookup
set and probed per outer row. That is the robust worst-case floor (O(K + N log K)
with zero statistics), and it covers IN in *any* expression position, including
projection where three-valued logic is required.

This ticket is the planner-level upgrade on top of that floor, aligned with the
Tier-0 direction in `tickets/backlog/known/2-adaptive-query-optimization.md`
("subquery decorrelation — eliminates N+1 patterns when structurally possible",
"hash join over nested loop"):

1. **Uncorrelated IN → semi-join.** `rule-subquery-decorrelation` currently handles
   only *correlated* EXISTS/IN (`identifyCandidate` gates on
   `isCorrelatedSubquery`). Extending it to uncorrelated IN in **filter position**
   (the equi-condition `outer.col = inner.firstCol` is the whole join predicate)
   moves the shape onto the join spine, where hash/bloom join selection, join
   reordering, FD propagation, and future adaptive-optimizer feedback all apply.
   NULL-semantics caveat: a semi-join is only equivalent to IN under WHERE's
   NULL-is-false collapse — projection-position IN must stay on the set-probe path.

2. **Key-set pushdown to storage.** Once the inner side is a materialized key set,
   the outer access path can consume it: extend the access-plan protocol
   (`getBestAccessPlan`) so a module can accept an IN-set constraint and turn it
   into K indexed seeks instead of a full scan + probe. This is what makes the
   store path match the hand-written "chunked literal IN" rewrite users currently
   resort to, and it is the DELETE/UPDATE analogue of the reported join-key-not-
   pushed gap (external report `tmp/quereus-join-index-perf.md`). Choosing seeks vs
   scan+probe is a genuine cost decision — a natural consumer of runtime cardinality
   feedback (adaptive optimizer Tier 1/2), with scan+probe as the safe default.

## Guardrails

- The semi-join's inner (build) side must not regress to per-outer-row re-execution
  under any cost-model or caching decision — the whole point of the floor is that
  the O(N×K) shape is unreachable regardless of statistics. See
  `bug-cache-threshold-abandon-cliff` for the existing cliff in the nested-loop
  right-side cache.
- The set-probe runtime path from `quereus-in-subquery-set-probe` stays: it serves
  projection-position IN and any filter shape the rewrite declines.
