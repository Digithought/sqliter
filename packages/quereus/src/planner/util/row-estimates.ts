/**
 * Row-estimate plumbing shared by `computePhysical` implementations.
 *
 * A relational node carries two row counts:
 *  - the LOGICAL one, the `estimatedRows` getter, available before optimization
 *    and derived from the *logical* children;
 *  - the PHYSICAL one, `physical.estimatedRows`, folded bottom-up during the
 *    Physical pass from the children's already-computed physical properties.
 *
 * The two diverge the moment the optimizer replaces a `Retrieve` subtree with a
 * physical access node (`SeqScan` / `IndexScan` / `IndexSeek`): those declare no
 * `estimatedRows` getter, so every logical getter reading through them yields
 * `undefined` while their physical property holds the real catalog-derived count.
 * A `computePhysical` that estimates from `this.source.estimatedRows` therefore
 * silently loses the count for the rest of the plan.
 */

import type { PhysicalProperties, RelationalPlanNode } from '../nodes/plan-node.js';

/**
 * The source cardinality a `computePhysical` should estimate from: the child's
 * physical row count when it has one, else the child's logical getter.
 *
 * The logical fallback matters for nodes whose child never stamps a physical
 * count (a scalar-subquery relation, a module leaf that declines to estimate) —
 * there the logical getter is the only number available, and it is still the
 * pre-optimization truth.
 */
// NOTE: `SchemaManager` hardcodes `TableSchema.estimatedRows` to 0 at CREATE TABLE,
// so a never-analyzed table's scan reports 0 — a value that means "unknown", not
// "empty" (see the NOTE in `planner/stats/table-cardinality.ts`). That 0 now travels
// much further than it used to: before this relay it died at the first operator that
// read a logical getter, and consumers fell back to their own defaults instead. Any
// consumer that reads a row estimate as a *magnitude* must therefore spell 0 as
// unknown — `rule-cte-optimization` gates on `sourceSize > 0` and had to be taught
// this (its `|| defaultRowEstimate` matches `vtab/memory/module.ts`); threshold
// consumers that floor (the cache threshold's min of 1000) or use a `>` test are
// unaffected. The real fix is distinguishing unknown from empty at the source —
// not clamping here, which would erase a genuinely empty analyzed table.
export function physicalSourceRows(
	childPhysical: PhysicalProperties | undefined,
	source: RelationalPlanNode,
): number | undefined {
	return childPhysical?.estimatedRows ?? source.estimatedRows;
}
