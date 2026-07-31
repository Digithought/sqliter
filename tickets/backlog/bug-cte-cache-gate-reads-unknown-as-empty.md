description: Whether the planner keeps a copy of a WITH-clause result in memory currently depends on whether someone has run the statistics-gathering command, not on whether copying it would help — and once statistics exist it starts making copies nobody asked for.
files: packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/test/optimizer/plan-shape-decisions.spec.ts, packages/quereus/test/plan/cte-materialization.spec.ts
repro: verified
----

## What goes wrong

A `with … as (…)` clause names a subquery. When the same name is used more than once, computing it
once and keeping the rows is worth doing; when it is used once, keeping them is wasted memory.

`ruleCteOptimization` decides this from a row-count estimate alone:

```ts
const sourceSize = PlanNodeCharacteristics.estimatesRows(source);
const shouldCache = (
    cteNode.materializationHint === 'materialized' ||
    (sourceSize > 0 && sourceSize < context.tuning.cte.maxSizeForCaching)
) && !isAlreadyCached;
```

Two things are wrong with that gate.

**It reads "unknown" as "empty".** A table that has never had `analyze` run on it reports **0**
rows — `SchemaManager` hardcodes `TableSchema.estimatedRows` to 0 when the table is created, and 0
is the engine's spelling of *we have no idea*, not *this table is empty* (`vtab/memory/module.ts`
reads the same field as `request.estimatedRows || 1000` for exactly this reason). So `sourceSize > 0`
is false for every un-analyzed database, and the caching decision is made by whether a maintenance
command has been run rather than by anything about the query.

**It never looks at how many times the name is used.** Once a real estimate does arrive, the gate
passes for *every* CTE in range, including single-use ones — which two existing specs say should be
inlined, not cached (`plan-shape-decisions.spec.ts` "CTE referenced once is inlined (no CACHE
node)" and `cte-materialization.spec.ts` "does not produce a CACHE node for single-use CTE"). Those
specs pass today only because the estimate happens to be 0.

Observed, on a 3-row `items` table with `using memory`:

| query | before `analyze` | after `analyze` |
|---|---|---|
| `with cte as (select id, val from items where val >= 20) select * from cte` | 0 CACHE nodes | **1 CACHE node** |
| the same CTE referenced twice in a self-join | 0 CACHE nodes | 2 CACHE nodes |

The first row is the bug in its clearest form: running `analyze` adds a cache that two specs
assert should not be there. (Those specs never run `analyze`, so they stay green.)

## Second-guessing the multi-reference case too

Even where the cache does appear, it may be the wrong mechanism. A separate pass —
`materialization-advisory` — already marks a multiply-referenced CTE for a shared per-execution
buffer. The rule's own in-code NOTE says that when both fire, the rows are buffered twice:
"Correct but a wasted buffer." So the answer for the multi-reference case may be *no* CacheNode
here at all, leaving materialization to the advisory pass. That is the design question this ticket
has to settle before touching the gate.

## Expected behaviour

Whatever is decided, the caching decision must not depend on whether `analyze` has been run. That
means: distinguish "no estimate" from "an estimate of zero rows" at this site, and decide caching
from how many times the CTE is referenced (plus the explicit `materialized` / `not materialized`
hints) rather than from size alone — with size retained only as an upper bound on what is worth
buffering.

## Notes for whoever picks this up

- A one-line `|| defaultRowEstimate` on `sourceSize` is **not** the fix; it was tried during review
  and it caches single-reference CTEs, failing both specs named above.
- Expect plan-shape churn. Add a spec that runs `analyze` and asserts the CTE plan shape is
  unchanged by it — the absence of that assertion is why this went unnoticed.
