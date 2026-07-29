description: The query planner works out how many rows a WHERE clause will keep, but throws that number away again whenever a later stage rewrites the condition — so queries containing a subquery in their WHERE clause end up planned with a crude guess instead.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts
difficulty: medium
----

## What happens

`FilterNode` carries an optional `selectivity` — the fraction of rows the `where` clause is
expected to keep. It is computed once, during the optimizer's Physical pass, by
`rule-filter-selectivity`, and stored on the node. Everything downstream that needs a row count
reads it; when it is absent, `FilterNode.estimatedRows` falls back to the flat
`DEFAULT_FILTER_SELECTIVITY` of 0.5.

`FilterNode.withChildren` deliberately drops `selectivity` when the predicate changes, on the
grounds that the stored fraction was computed against the old predicate. That is correct in
itself. The comment justifying it asserts:

> In practice the Physical pass is the last rule-bearing pass over Filters, so nothing
> re-sources a stamped one.

That assertion does not hold. Something after the Physical pass rewrites predicates that contain
a subquery, and the stamp goes with it.

## Reproduction

```sql
create table o (id integer primary key, cat text, qty integer, rid integer) using memory;
create table r (id integer primary key, cat text, qty integer) using memory;
-- populate both, then:
analyze o; analyze r;

select * from o join r on o.rid = r.id
 where o.qty = (select max(qty) from r r2) and o.cat = 'a';
```

Optimize that and inspect the residual `FilterNode`: `selectivity` is `undefined`. Feed the
resulting plan back through `db.optimizer.optimize(plan, db)` and the *same* filter, with the
*same* predicate, comes back stamped 0.25. So the estimate was computable all along — the first
pass computed it and a later rewrite discarded it.

The same happens without the join (`select * from o where o.qty = (select max(qty) from r r2)
and o.cat = 'a'`), so this is not specific to the filter-over-join path added by
`feat-join-filter-selectivity`; it is the general single-table path too.

Removing the subquery (`o.qty = 1 and o.cat = 'a'`) stamps correctly on the first pass, which
points at subquery handling — decorrelation, caching, or scalar-subquery materialization — as
the pass that runs after stamping and re-mints the predicate.

## Expected

Any filter the optimizer *can* estimate should come out of `optimize()` stamped, regardless of
whether a later pass rewrote its predicate. Two obvious shapes for a fix, to be weighed by
whoever picks this up:

- run selectivity stamping after the last predicate-rewriting pass, or
- re-stamp when a rewrite invalidates the old value.

Either way the `withChildren` comment quoted above needs correcting: it currently documents an
invariant the pipeline does not have.

## Secondary observation

While reproducing this, note that `optimize()` is not a fixpoint for these queries: re-running
it on an already-optimized plan changes the plan shape as well as the stamp (in the single-table
reproduction above, two stacked filters merge into one on the second pass). That may be a
separate issue or the same one; worth confirming before assuming the second pass is a safe way
to observe "what the first pass should have produced".
