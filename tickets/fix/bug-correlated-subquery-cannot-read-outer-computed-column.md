---
description: A query fails at runtime when a sub-query inside a WHERE clause reads a calculated column from the surrounding query — for example filtering on whether a computed total appears in another table.
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts   # canPushAcrossProject (~153), collectReferencedAttributeIds / walkExpr (~163-186) — the fix site
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts  # walkScalar (~166) — same shape, second arm to check
  - packages/quereus/src/planner/optimizer.ts                                 # rule registration (~305-315)
repro: verified
difficulty: medium
---

# A correlated sub-query cannot read an outer computed column

A `select` whose `where` clause contains a sub-query, where that sub-query
references a **calculated** column of the surrounding query (one produced by an
expression in a projection rather than read straight off a table), fails at
runtime with:

```
No row context found for column d. The column reference must be evaluated within
the context of its source relation.
```

Reproduced on the current tree with nothing but two ordinary tables — no views,
no schemas, no CTEs:

```sql
create table gt (id integer primary key, x integer);
create table side (tag text primary key);
insert into gt values (1, 10), (2, 20);
insert into side values ('one');

-- fails
select id from (select id, x * 2 as d from gt) t
  where exists (select 1 from side where t.d > 0);

-- also fails (scalar sub-query operand)
select id from (select id, x * 2 as d from gt) t
  where (select max(t.d) from side) > 0;
```

The same shapes succeed the moment the referenced column is a plain
pass-through instead of a calculated one:

```sql
-- works
select id from (select id, x from gt) t where exists (select 1 from side where t.x > 0);
-- works: `t.d` here sits OUTSIDE the sub-query, so nothing is stranded
select id from (select id, x * 2 as d from gt) t where t.d in (select 20 union select 40);
-- works: no sub-query at all
select id from (select id, x * 2 as d from gt) t where t.d > 0;
```

## Root cause

The optimizer's predicate-pushdown rule slides a `Filter` below the `Project`
that computes the column, stranding the reference beneath the only node that
could produce it.

`rulePredicatePushdown` gates that move with `canPushAcrossProject`, which
collects the attributes the predicate references and refuses the push if any of
them does not already exist below the projection. The collector
(`collectReferencedAttributeIds` → `walkExpr`) walks **only scalar children** and
deliberately stops at a relational child:

```ts
function walkExpr(expr: ScalarPlanNode, fn: (n: ScalarPlanNode) => void): void {
	fn(expr);
	for (const c of expr.getChildren()) {
		// Only scalar children
		if (!isRelationalNode(c)) {
			walkExpr(c as any as ScalarPlanNode, fn);
		}
	}
}
```

A correlated reference inside an `exists` / scalar sub-query operand lives in
that operand's **relational** subtree, so the collector never sees it. The gate
therefore observes zero out-of-range attributes, declares the push safe, and
rebuilds `Project(Filter(scan))` where the filter's sub-query still points at an
attribute the projection above it defines. Confirmed on the failing plan:

```
Project(id) ← Alias(t) ← Project(id, d) ← Filter(exists …) ← IndexScan(gt)
```

The gate itself is the right idea and its own comment explains why the rebuild
preserves attribute IDs — the defect is purely the collector's blindness to
correlated references nested in a sub-query operand.

`rule-aggregate-predicate-pushdown.ts` carries a `walkScalar` helper with the
identical "skip relational children" shape feeding its own
`collectReferencedAttributeIds`. Whether it is reachable was not established;
check it as part of this fix rather than assuming either way.

## Expected behavior

Each failing statement above returns the rows its semantics call for
(`[{id:1},{id:2}]` for both, since `x * 2 > 0` holds for every row and `side` is
non-empty). More generally: a predicate carrying a correlated reference to a
column a projection computes must not be pushed below that projection — either
the gate counts those references and refuses, or the push rewrites them into the
defining expression the way the non-sub-query case already ends up correct.

The pass-through and no-sub-query cases listed above must keep their current
plans; this should not become a blanket refusal to push filters across
projections.

## Scope note

Found while implementing `bug-view-write-subquery-shadow-analysis-wrong-schema`,
which needed exactly this read shape as the oracle for a write assertion and had
to spell the oracle against the base tables instead. That test
(`packages/quereus/test/view-home-schema.spec.ts`, describe "write-through
sub-query shadow analysis resolves sources like the plan does") carries a comment
pointing here; when this lands, the oracle can be simplified back to a read
through the view.
