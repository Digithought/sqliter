description: The planner cannot say how many rows a join will produce once the query has been fully optimized, so every row estimate above a join is blank — which makes the join-filter row estimates the planner just learned to compute invisible.
files: packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts
----

## What's wrong

A plan node carries two row counts: a **logical** one (`estimatedRows`, a plain getter available
before optimization) and a **physical** one (`physical.estimatedRows`, computed bottom-up during
the Physical pass from the children's physical properties).

`JoinNode.computePhysical` (`join-node.ts:150-154`) computes its own physical row count by handing
`this.left.estimatedRows` / `this.right.estimatedRows` — the **logical** getters — to
`analyzeJoinKeyCoverage`. By the time that runs, both sides are physical access nodes
(`SeqScan` / `IndexScan` over a `Retrieve`), and `TableAccessNode` defines no `estimatedRows`
getter, so both are `undefined`. The join therefore reports `estimatedRows: undefined`, and every
node above it inherits the blank.

This is the mirror of a problem `FilterNode` already solved for itself: its `computePhysical`
deliberately reads the *physical* child cardinality rather than the logical getter, with a comment
explaining that the logical one is lost after the Retrieve→access-node conversion
(`filter.ts:88-99`). `JoinNode` never got the same treatment.

## Why it matters

`rule-filter-selectivity` now estimates a `where` clause sitting above a join by attributing each
condition to the table its columns come from (see `docs/optimizer.md`, "Filters over a join"). That
estimate is computed correctly and stamped on the node — and then multiplied by nothing, because
the join underneath reports no row count. So the improved estimate cannot influence anything above
the filter: enclosing join ordering, cache advisories, sort costs all still see a blank.

Example:

```sql
analyze orders; analyze regions;
explain select * from orders o join regions r on o.region_id = r.id
where o.status = 'shipped' and r.name = 'EU';
```

Today: the filter above the join carries a correct selectivity (~0.14) and an `estimatedRows` of
nothing at all. Desired: the join reports a row count derived from its inputs, and the filter
reports roughly 14% of it.

## Relationship to other tickets

Closely related to, but distinct from, `debt-access-node-catalog-cardinality`. That ticket is about
the *base* number — a full scan over an analyzed table reporting 0 rows instead of the real count.
This one is about that number surviving upward through a join. Fixing the base count alone will not
help here, because the join reads the logical getter, which stays blank on an access node either
way. Both are needed for a join-filter row estimate to be meaningful, and they are worth doing
together — the second is a small change once the first has produced a real number to propagate.

## Expected fallout

Golden EXPLAIN plans will churn: `estimatedRows` on joins and everything above them goes from
absent to a number. Budget for regenerating the plan snapshots and sanity-checking the new values.
