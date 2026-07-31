description: The planner can no longer say how many rows a query produces once the results of two queries are combined (UNION and friends), so every decision above that point falls back to a fixed guess.
files: packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/nodes/cte-reference-node.ts, packages/quereus/src/planner/nodes/delete-node.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/insert-node.ts, packages/quereus/src/planner/nodes/remote-query-node.ts, packages/quereus/src/planner/util/row-estimates.ts
----

## Background

Every plan node carries two row counts: a **logical** one (the `estimatedRows` getter, available
before optimization) and a **physical** one (`physical.estimatedRows`, computed bottom-up during
the optimizer's Physical pass). The physical one is what cost decisions above the node read.

`debt-join-rows-from-physical-children` made the single-source operators and the join family
compute their physical count from their children's *physical* counts, via one shared helper
(`physicalSourceRows` in `planner/util/row-estimates.ts`). Four groups of nodes were left out.

One caution that applies to every site below: a table that has never been `ANALYZE`d reports **0**
rows, and that 0 means *unknown*, not *empty*. Any consumer that reads the new estimate as a
magnitude has to spell that out; the CTE caching rule does not, which is its own ticket
(`bug-cte-cache-gate-reads-unknown-as-empty`). Check consumers, not just producers.

## What is still missing

**Set operations (`union`, `union all`, `intersect`, `except`).** `SetOperationNode` has no
`estimatedRows` getter at all, and its `computePhysical` never stamps one. A query whose results
are combined this way therefore reports no row count from the combine point upward — in either
view. This is the largest of the three gaps: `union all` is common, and everything above it
(sorts, enclosing joins, cache sizing) falls back to a fixed default row count.

**Parallel gather (`AsyncGatherNode`).** This node runs several branches concurrently and merges
them; a PostOptimization rule substitutes it for a `union all` on high-latency plans. It *does*
have a logical `estimatedRows` getter that composes its branches (sum for `unionAll`, max for
`zipByKey`, product for `crossProduct`), but its `computePhysical` never stamps a physical count,
and the getter reads its children's logical getters — which are blank once those children are
physical access nodes. So the composition it already implements never actually produces a number
in an optimized plan.

**Common table expressions (`with … as (…)`).** Found during review of the earlier ticket, and the
same shape as the two above. Neither `CTENode` nor `CTEReferenceNode` declares a row estimate in
either view — no logical getter, no physical stamp — so a query that names a CTE reports no row
count from the reference upward, even though the subquery underneath it now has one. Verified on
`with c as (select id, a from t where a = 1) select * from c x join c y on x.id = y.id`: the
`Project` inside the CTE reports a count, and the `CTE`, `CTEReference` and the join above all
report nothing. A CTE reference emits exactly the rows of the CTE's source, so this is the plain
relay edit; rank it above the data-modifying statements below.

**Data-modifying statements.** `DeleteNode`, `DmlExecutorNode` and `ReturningNode` still relay the
logical getter of their source; `InsertNode` declares no row estimate at all. Lower value than the
two above — a `returning` clause's row count rarely drives a plan choice — but it is the same
one-line change.

`RemoteQueryNode` also declares no estimate in either view. It is a leaf rather than a relay, so it
needs a number chosen (whatever the remote side advertises, else nothing) rather than a relay edit;
mention it here so the sweep does not stop one file short.

## Shape of the fix

Each site is the same edit the earlier ticket applied elsewhere: read the child's physical row
count (`physicalSourceRows(childrenPhysical[i], child)`) rather than the child's logical getter,
and where the node's estimate is a formula over its inputs, keep that formula in one private
method shared by the logical getter and `computePhysical` so the two cannot drift.

`SetOperationNode` additionally needs an estimate *chosen* — it has none today. Sensible starting
points, in the spirit of the existing heuristics: `union all` = sum of both sides; `union` =
sum, since deduplication is not modelled anywhere else either; `intersect` = min; `except` =
the left side. Whatever is chosen should be stated in `docs/optimizer.md` beside the existing
row-estimate notes.

## Expected fallout

Golden EXPLAIN plans covering `union`/`union all` will gain `estimatedRows` entries on the set
operation and everything above it. Regenerate with `UPDATE_PLANS=true yarn test:plans` and
sanity-check the new numbers rather than accepting them blind.
