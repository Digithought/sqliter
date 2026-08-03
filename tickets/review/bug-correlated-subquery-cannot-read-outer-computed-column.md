---
description: A sub-query inside WHERE or HAVING can now read a calculated column from the surrounding query without the query failing at runtime.
files:
  - packages/quereus/src/planner/analysis/predicate-dependencies.ts            # NEW — shared dependency collector
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts    # canPushAcrossProject rewired (arm A)
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts  # isConjunctPushable rewired (arm B)
  - packages/quereus/test/logic/07.7.8-correlated-ref-to-computed-column.sqllogic      # NEW — row-set guard
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts                 # NEW describe — plan-shape guard, arm A
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts  # NEW describe — plan-shape guard, arm B
  - packages/quereus/test/view-home-schema.spec.ts                             # oracle simplified (line ~1081)
  - packages/quereus/src/planner/cache/correlation-detector.ts                 # reused unchanged
difficulty: medium
---

# Correlated sub-query reading an outer computed column — implemented

## What was wrong

Two predicate-pushdown rules asked "which attributes does this predicate need in
scope?" by walking the predicate's **scalar** tree and stopping at any relational
child. A correlated reference inside an `exists` / `in` / scalar-sub-query operand
lives in exactly that relational subtree, so the answer came back empty. The push
went ahead, the reference landed below the node that defines the attribute it
reads, and the query died with:

```
No row context found for column <c>. The column reference must be evaluated
within the context of its source relation.
```

## What changed

**New file `src/planner/analysis/predicate-dependencies.ts`.** One collector, two
exports:

```ts
export interface PredicateDependencies {
	readonly direct: ReadonlySet<number>;      // the predicate's own scalar column refs
	readonly correlated: ReadonlySet<number>;  // what sub-query operands read from OUTSIDE themselves
}
export function collectPredicateDependencies(expr: ScalarPlanNode): PredicateDependencies;
export function collectPredicateAttributeIds(expr: ScalarPlanNode): Set<number>;  // union
```

The relational half delegates to the pre-existing `collectExternalReferences()` in
`planner/cache/correlation-detector.ts` (unchanged), which walks both
`getChildren()` and `getRelations()` and subtracts every attribute the subtree
defines for itself.

**Arm A — `rule-predicate-pushdown.ts`.** `canPushAcrossProject` now gates on the
union (`collectPredicateAttributeIds`). Local `collectReferencedAttributeIds` /
`walkExpr` deleted; the now-unused `CapabilityDetectors` import dropped.

**Arm B — `rule-aggregate-predicate-pushdown.ts`.** `isConjunctPushable` refuses
any conjunct whose `correlated` set is non-empty, then gates on `direct` exactly
as before. Local `collectReferencedAttributeIds` / `walkScalar` deleted. The
refusal (rather than teaching the rewriter to descend) is deliberate:
`rewriteOutputToSource` skips relational children, so a correlated reference
carried through would keep pointing at the aggregate's *output* attribute id
while the rest of the conjunct got rewritten onto source ids.

**Test-oracle simplification.** `view-home-schema.spec.ts`, describe
"write-through sub-query shadow analysis resolves sources like the plan does",
test "sizes a body sub-query's source up in the home schema…": the oracle was
spelled against the base tables with a comment pointing at this ticket. It is now
the natural read through the view, and the comment is gone.

## Validation

Run from repo root:

- `yarn build` — clean.
- `yarn test` — **8535 passing** in `packages/quereus` (baseline in the ticket was
  8528; +7 = 3 new arm-A its, 3 new arm-B its, 1 new sqllogic file). Every other
  workspace unchanged and green (370, 113, 63, 17, 28, 1291, 648, 52, 31, 34,
  134, 22). Zero failures, zero pending.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).

### The behavioural cases a reviewer should exercise

Row-set coverage: `packages/quereus/test/logic/07.7.8-correlated-ref-to-computed-column.sqllogic`
(note: **07.7.8**, not the 07.7.7 the ticket named — `07.7.7-join-source-scope-shadowing.sqllogic`
already exists).

Section 1 — `gt(id pk, x)` with rows `(1,10) (2,20) (3,0) (4,-5)`, `side(tag pk)`
with one row. `d = x*2`, so `d > 0` is true for ids 1 and 2 only:

```sql
-- used to fail; now returns ids 1, 2
select id from (select id, x * 2 as d from gt) t where exists (select 1 from side where t.d > 0);
select id from (select id, x * 2 as d from gt) t where (select max(t.d) from side) > 0;
-- complement, returns ids 3, 4
select id from (select id, x * 2 as d from gt) t where not exists (select 1 from side where t.d > 0);
-- already worked, must keep working
select id from (select id, x from gt) t where exists (select 1 from side where t.x > 0);
select id from (select id, x * 2 as d from gt) t where t.d in (select 20 union select 40);
select id from (select id, x * 2 as d from gt) t where t.d > 0;
```

Section 2 — `t(id pk, g, v)` grouped into g ∈ {-1 (4 rows), 0 (1), 1 (2), 2 (1)},
`side(n pk)` holding 1, 2, 3:

```sql
-- used to fail; now [{g:1,c:2},{g:2,c:1}]
select g, count(*) as c from t group by g
  having g > 1 or exists (select 1 from side where side.n = g) order by g;
-- used to fail; now [{g:0,c:1},{g:1,c:2},{g:2,c:1}]  (g=-1 has 4 rows, 4 ∉ side)
select g, count(*) as c from t group by g
  having g > 1 or exists (select 1 from side where side.n = count(*)) order by g;
-- used to fail; now [{g:1,c:2},{g:2,c:1}]
select g, count(*) as c from t group by g
  having (case when exists (select 1 from side where side.n = g) then g else 0 end) > 0 order by g;
-- already worked, must keep working
select g, count(*) as c from t group by g having g > 0 order by g;
select g, count(*) as c from t group by g having exists (select 1 from side where side.n = g) order by g;
select g, count(*) as c from t group by g
  having g > 0 and (select max(side.n) from side where side.n = g) is not null order by g;
```

### The plan shapes that are pinned

`test/optimizer/predicate-pushdown.spec.ts`, describe "Predicate push-down across
a computing Project (correlated references)". The helper reads `id` / `parent_id`
off `query_plan()` and walks the relational spine from the sub-select's `ALIAS`
down, so the correlated sub-query's own Project/Filter/scan cannot pollute the
answer. One Project computes `d` and passes `x` through, so the two arms are
genuinely discriminating:

| predicate | spine below ALIAS |
| --- | --- |
| `exists (… t.d > 0)` — correlates to the computed column | `FILTER → PROJECT → INDEXSCAN` |
| `exists (… t.x > 0)` — correlates to a pass-through column | `PROJECT → FILTER → INDEXSCAN` |
| `(select max(t.d) from side) > 0` — scalar sub-query | `FILTER → PROJECT → INDEXSCAN` |

`test/optimizer/rule-aggregate-predicate-pushdown.spec.ts`, describe "conjuncts
carrying a correlated sub-query": the `or`- and `case`-mixing conjuncts keep
exactly one FILTER above the aggregate; plain `having g > 0` on the same table
keeps zero. The third case is what stops the arm-B guard from degrading into a
blanket refusal.

## Known gaps and things worth a second look

- **Arm B's guard is coarser than arm A's.** Arm A distinguishes "the correlation
  targets something below" (push) from "it does not" (refuse). Arm B refuses on
  *any* correlation, including one onto a pushable GROUP BY column. The
  discriminating test there is `g > 0` (no correlation at all), not "correlated
  but safe" — so the arm-B guard would still pass if someone later tightened it
  to a blanket refusal. Recorded as a `NOTE:` at the site; deliberate per the
  ticket, not a follow-up.
- **Arm A refuses grandparent-scope correlations.** If a correlated reference
  targets an attribute from a scope *outside* the Project entirely — neither
  produced nor consumed by it — the push would be safe but is refused, because
  the gate's rule is "must exist below". No test covers this shape (it is a
  refusal, so it costs plan quality, not correctness). `NOTE:` at the site.
- **Neither NOTE quantifies the cost.** "Costs plan quality in shapes nobody has
  measured" is the honest statement; no benchmark was run.
- **Correlation detection is whole-subtree.** `collectExternalReferences` walks
  the entire sub-query subtree on every `isConjunctPushable` / `canPushAcrossProject`
  call, and the rules call it once per conjunct per firing. Fine at current
  predicate sizes; nothing was measured.
- **The sqllogic arm-B statements all carry `order by g`.** Without it the row
  order is the hash aggregate's group-first-seen order, which is deterministic
  today but implementation-coupled. The *unordered* forms — the literal repro —
  are exercised only by the plan-shape specs, which assert shape rather than rows.
- **A sibling oracle was left alone.** The test "resolves a body sub-query's
  source on the definition's declared `with schema` path" (same describe, ~line
  1137) spells its oracle against the base tables in the same style, without a
  comment explaining why. `select id from main.dv where exists (select 1 from sel
  where sel.tag = n) order by id` was checked by hand and now returns the same
  `[{id:1},{id:2}]`, so it could be simplified identically — the ticket named only
  the commented one, so it was left as-is.
- **Store mode not run.** `yarn test:store` was not run; the change is
  planner-only and module-agnostic, but that is an argument, not a measurement.
