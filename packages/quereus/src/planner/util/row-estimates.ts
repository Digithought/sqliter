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
// Invariant: a row estimate has exactly two spellings — `undefined` means "nobody
// knows" and a number (including a real 0, from an analyzed empty table) means
// "measured or derived" (see `planner/stats/table-cardinality.ts`). A never-analyzed
// table's scan reports `undefined`, not 0, so this relay may propagate any number it
// sees as a genuine magnitude; consumers apply their own default only on `undefined`.
export function physicalSourceRows(
	childPhysical: PhysicalProperties | undefined,
	source: RelationalPlanNode,
): number | undefined {
	return childPhysical?.estimatedRows ?? source.estimatedRows;
}

/**
 * An aggregate's output cardinality as a pure function of its source's — shared
 * by every aggregate node's logical `estimatedRows` getter and its
 * `computePhysical` (which feeds it the PHYSICAL source count) so the two cannot
 * drift, and by all three aggregate flavours so their only difference is the
 * `groupDivisor` each believes its grouping produces.
 *
 * @param grouped whether the aggregate has a GROUP BY (ungrouped always emits one row)
 * @param groupDivisor rows-per-group assumption for the grouped estimate
 */
export function aggregateRowsFrom(
	sourceRows: number | undefined,
	grouped: boolean,
	groupDivisor: number,
): number | undefined {
	if (sourceRows === undefined) return undefined;

	// No GROUP BY: the whole input folds into exactly one row, whatever comes in
	// (including the unknown sentinel — the count is not a function of the source).
	if (!grouped) return 1;

	// 0 passes through unchanged: it now only ever means a genuinely empty source
	// (never-analyzed is `undefined`, handled above), and 0 rows in ⇒ 0 groups
	// out. Flooring it to 1 would claim a row an empty table cannot produce.
	if (sourceRows === 0) return 0;

	return Math.max(1, Math.floor(sourceRows / groupDivisor));
}
