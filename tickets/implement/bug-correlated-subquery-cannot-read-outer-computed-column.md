---
description: A query fails at runtime when a sub-query inside a WHERE or HAVING clause reads a calculated column from the surrounding query — for example filtering on whether a computed total appears in another table.
files:
  - packages/quereus/src/planner/analysis/predicate-dependencies.ts            # NEW — shared dependency collector
  - packages/quereus/src/planner/cache/correlation-detector.ts                 # collectExternalReferences() — reuse, no change
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts    # canPushAcrossProject (~153) + collectReferencedAttributeIds/walkExpr (~163-182)
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts  # isConjunctPushable (~132) + collectReferencedAttributeIds/walkScalar (~155-172)
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts                 # plan-shape guard, arm A
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts  # plan-shape guard, arm B
  - packages/quereus/test/logic/07.7.6-correlated-predicate-scope.sqllogic     # sibling precedent for the new .sqllogic
  - packages/quereus/test/view-home-schema.spec.ts                             # oracle to simplify once this lands
repro: verified
difficulty: medium
---

# A correlated sub-query cannot read an outer computed column

Two predicate-pushdown rules decide whether a `Filter` may slide below the node
that *computes* a column. Both answer by walking the predicate's scalar tree
only, and both deliberately stop at a relational child. A correlated reference
inside an `exists` / `in` / scalar-sub-query operand lives in exactly that
relational subtree, so neither rule sees it. The push goes ahead, the reference
lands below the node that defines the attribute it reads, and the query dies at
runtime with:

```
No row context found for column <c>. The column reference must be evaluated
within the context of its source relation.
```

Both arms were reproduced on the current tree (`git` clean at `d54586ba`) with
ordinary tables — no views, no schemas, no CTEs.

## Arm A — `Filter` pushed below `Project` (`rule-predicate-pushdown.ts`)

```sql
create table gt (id integer primary key, x integer);
create table side (tag text primary key);
insert into gt values (1, 10), (2, 20);
insert into side values ('one');

-- FAIL: No row context found for column d
select id from (select id, x * 2 as d from gt) t
  where exists (select 1 from side where t.d > 0);

-- FAIL: No row context found for column d
select id from (select id, x * 2 as d from gt) t
  where (select max(t.d) from side) > 0;
```

Observed plan for the first (via `query_plan()`), correlated `t.d` stranded
under the `Project` that mints it:

```
PROJECT(id) → ALIAS(t) → PROJECT(id, x*2 AS d) → FILTER(exists …) → INDEXSCAN gt
```

`canPushAcrossProject` gates the move on "every attribute the predicate
references already exists below the projection". `collectReferencedAttributeIds`
→ `walkExpr` builds that set from scalar children only, so it returns the empty
set here and the gate waves the push through.

These shapes already work and must keep their current plans:

```sql
select id from (select id, x from gt) t where exists (select 1 from side where t.x > 0);
select id from (select id, x * 2 as d from gt) t where t.d in (select 20 union select 40);
select id from (select id, x * 2 as d from gt) t where t.d > 0;
```

## Arm B — conjunct pushed below an aggregate (`rule-aggregate-predicate-pushdown.ts`)

Reachable, and confirmed failing. The ticket's fix-stage predecessor left this
"whether it is reachable was not established"; it is.

```sql
create table t (id integer primary key, g integer, v integer);
create table side (n integer primary key);
insert into t values (1, 1, 10), (2, 1, 20), (3, 2, 30);
insert into side values (1), (2), (3);

-- FAIL: No row context found for column g
select g, count(*) as c from t group by g
  having g > 1 or exists (select 1 from side where side.n = g);

-- FAIL: No row context found for column c
select g, count(*) as c from t group by g
  having g > 1 or exists (select 1 from side where side.n = count(*));

-- FAIL: No row context found for column g
select g, count(*) as c from t group by g
  having (case when exists (select 1 from side where side.n = g) then g else 0 end) > 0;
```

All three are the *same* shape: a single conjunct (an `or`, or a `case`) that
mixes a top-level reference to a pushable GROUP BY column with a correlated
sub-query. `splitConjuncts` cannot break an `or` apart, so the whole thing is
classified together. `isConjunctPushable` sees only `{g}` — pushable — and the
conjunct is pushed below the aggregate.

Arm B has a **second** defect the collector fix alone does not cover:
`rewriteOutputToSource` (line ~193) also skips relational children, so even if
the gate let a correlated conjunct through, the reference inside the sub-query
would keep pointing at the aggregate's *output* attribute id while the rest of
the conjunct got rewritten onto source ids. The correction below refuses such
conjuncts rather than teaching the rewriter to descend.

These aggregate shapes already work and must keep their plans:

```sql
select g, count(*) as c from t group by g having g > 0;
select g, count(*) as c from t group by g having exists (select 1 from side where side.n = g);
select g, count(*) as c from t group by g
  having g > 0 and (select max(side.n) from side where side.n = g) is not null;
```

(The last one works because `and` splits into two conjuncts: `g > 0` pushes on
its own and the correlated half stays above, where decorrelation turns it into a
hash join.)

## Correction

A predicate's dependencies are its own scalar column references **plus**
whatever any sub-query operand reads from outside its own subtree. The second
half already has a helper — `collectExternalReferences(node)` in
`packages/quereus/src/planner/cache/correlation-detector.ts` — which walks both
`getChildren()` and `getRelations()` and subtracts every attribute the subtree
defines for itself. Nothing new needs to be written for the hard part.

Introduce one shared collector and point both rules at it. New file
`packages/quereus/src/planner/analysis/predicate-dependencies.ts`:

```ts
export interface PredicateDependencies {
	/** Attribute IDs referenced directly in the predicate's own scalar tree. */
	readonly direct: ReadonlySet<number>;
	/** Attribute IDs a sub-query operand references from OUTSIDE its own subtree. */
	readonly correlated: ReadonlySet<number>;
}

export function collectPredicateDependencies(expr: ScalarPlanNode): PredicateDependencies;

/** Union of both — the full set of attributes the predicate needs in scope. */
export function collectPredicateAttributeIds(expr: ScalarPlanNode): Set<number>;
```

The walk is the existing `walkExpr` with the relational branch filled in instead
of dropped:

```ts
function walk(expr: ScalarPlanNode, direct: Set<number>, correlated: Set<number>): void {
	if (CapabilityDetectors.isColumnReference(expr)) direct.add(expr.attributeId);
	for (const child of expr.getChildren()) {
		if (isRelationalNode(child)) {
			for (const id of collectExternalReferences(child)) correlated.add(id);
		} else {
			walk(child as ScalarPlanNode, direct, correlated);
		}
	}
}
```

The two kinds are reported separately because the rules need different things:

- **Arm A** gates on the union. Replace the body of
  `collectReferencedAttributeIds` with `collectPredicateAttributeIds`, delete
  the now-unused local `walkExpr`, and drop the `CapabilityDetectors` import if
  nothing else in the file uses it. The gate logic itself is unchanged and its
  existing comment about preserving attribute IDs stays accurate.
- **Arm B** refuses any conjunct with a non-empty `correlated` set, then gates
  on `direct` exactly as today. Delete the local `collectReferencedAttributeIds`
  / `walkScalar`.

### Verified

This exact change was prototyped on the tree during the fix stage and then
reverted so this stage lands it with tests. Under the prototype:

- all five arm-A statements and all six arm-B statements returned correct rows;
- the arm-A plan became `PROJECT → ALIAS → FILTER → PROJECT → INDEXSCAN` (the
  `Filter` stays above the computing `Project`);
- the three working arm-A shapes and three working arm-B shapes kept their exact
  prior plan shapes;
- `yarn test` was fully green (8528 + 370 + 113 + 63 + 17 + 28 + 1291 + 648 + 52
  + 31 + 34 + 134 + 22 passing, zero failures).

### Deliberate conservatism (record as a code comment, not a follow-up ticket)

Both arms now refuse pushes they could in principle allow:

- Arm A refuses when the correlated reference targets an attribute from a
  *grandparent* scope — one that is neither produced nor consumed by the
  `Project` in question, so the push would have been safe. It is refused because
  the gate's rule is "must exist below", and an outer-scope id does not. This
  matches the gate's existing treatment of top-level outer references, so the
  asymmetry is not new.
- Arm B refuses any conjunct carrying a correlation, including one onto a
  pushable GROUP BY column, which would be legal if `rewriteOutputToSource`
  descended into relational children the way `remapOuterRefs` in
  `rule-scalar-agg-decorrelation.ts` does.

Neither is wrong today — they cost plan quality in shapes nobody has measured.
Put a `NOTE:` comment at each site saying what is being given up and what would
buy it back. Do **not** file a follow-up ticket for either.

## TODO

- Add `packages/quereus/src/planner/analysis/predicate-dependencies.ts` with
  `collectPredicateDependencies` / `collectPredicateAttributeIds` as sketched
  above, reusing `collectExternalReferences` from `../cache/correlation-detector.js`.
- Rewire `canPushAcrossProject` in `rule-predicate-pushdown.ts` onto
  `collectPredicateAttributeIds`; remove the local `collectReferencedAttributeIds`
  / `walkExpr` and any import left unused.
- Rewire `isConjunctPushable` in `rule-aggregate-predicate-pushdown.ts` onto
  `collectPredicateDependencies`; refuse when `correlated` is non-empty; remove
  the local `collectReferencedAttributeIds` / `walkScalar`.
- Add the two `NOTE:` comments described under *Deliberate conservatism*.
- Add `packages/quereus/test/logic/07.7.7-correlated-ref-to-computed-column.sqllogic`
  covering all eleven statements above — the five arm-A and six arm-B shapes,
  failing and working alike — with expected rows. Model the header comment on
  `07.7.6-correlated-predicate-scope.sqllogic`, which guards the same class of
  "No row context found" defect.
- Add a plan-shape assertion to `packages/quereus/test/optimizer/predicate-pushdown.spec.ts`
  pinning that the `Filter` stays ABOVE the computing `Project` for the correlated
  case, and stays BELOW it for the pass-through case (so the fix is not a blanket
  refusal).
- Add the mirror assertion to
  `packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts`:
  the `or`-mixing conjunct stays above the aggregate, plain `having g > 0` still
  pushes below it.
- Simplify the oracle in `packages/quereus/test/view-home-schema.spec.ts`,
  describe "write-through sub-query shadow analysis resolves sources like the
  plan does" — it is currently spelled against the base tables with a comment
  pointing at this ticket, because this read shape was the natural oracle and did
  not work. Rewrite it as a read through the view and drop the comment.
- Run `yarn build`, `yarn test`, and `yarn lint` from the repo root.
