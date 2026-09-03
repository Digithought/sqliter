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

/**
 * ## Data-modifying nodes: rows EMITTED, not rows written
 *
 * Every estimate in this file counts the rows a node puts on its own output
 * stream. For the write family (`InsertNode`, `UpdateNode`, `DeleteNode`,
 * `ConstraintCheckNode`, `DmlExecutorNode`, `ReturningNode`) that stream tracks
 * the source one-for-one — the prep nodes yield one flat OLD/NEW row per source
 * row, the constraint check passes each row through or throws, and
 * `ReturningNode` projects one row per written row — so "rows emitted" and "rows
 * processed" coincide and every member passes its source count through
 * unchanged.
 *
 * The one place the two can part is `DmlExecutorNode`, which yields NOTHING for a
 * row it did not write (`insert or ignore` onto an existing key, `on conflict do
 * nothing`, an update whose row is no longer there). That makes the family's
 * relay an upper bound rather than an exact count for those statements. It is
 * deliberately not modelled: the skip rate is a property of the data, not of the
 * plan, and inventing a discount would be less honest than the bound. Consumers
 * of a write's estimate size buffers and pick strategies, which an upper bound
 * serves correctly.
 *
 * The two readings only diverge at the statement boundary, and that boundary is
 * a different node: a statement with no `returning` is topped by a `SinkNode`,
 * which drains the write stream and reports the single changes-count row
 * (`SinkNode.estimatedRows === 1`). So a consumer reading `estimatedRows` on a
 * DML node is asking "how much work flows through this write pipeline", which is
 * what sort strategy / cache thresholds above it want; a consumer asking "how
 * many rows does this statement hand back" reads the Sink.
 */

/** Largest row estimate the relay will emit; see {@link clampRowEstimate}. */
export const MAX_ROW_ESTIMATE = Number.MAX_SAFE_INTEGER;

/**
 * Normalize a composed row estimate to a finite, non-negative integer.
 *
 * Combinators that multiply (`crossProduct`) can push three large branches past
 * `Number.MAX_SAFE_INTEGER` and on to `Infinity`; consumers do arithmetic on
 * this value (selectivity multiplication, cache thresholds), so an `Infinity` or
 * a fractional count leaks into cost comparisons and EXPLAIN output. Saturate at
 * `MAX_ROW_ESTIMATE` instead — a saturated estimate is still "astronomically
 * large", which is all any consumer does with it. `NaN` cannot survive either:
 * it saturates too, since the only way to produce one here is an overflowed
 * intermediate.
 */
export function clampRowEstimate(rows: number): number {
	if (Number.isNaN(rows)) return MAX_ROW_ESTIMATE;
	if (rows >= MAX_ROW_ESTIMATE) return MAX_ROW_ESTIMATE;
	return Math.max(0, Math.floor(rows));
}

/** The set operations `SetOperationNode` can carry. */
export type SetOperationKind = 'union' | 'unionAll' | 'intersect' | 'except';

/**
 * A set operation's output cardinality as a pure function of its branches' —
 * shared by `SetOperationNode`'s logical `estimatedRows` getter and its
 * `computePhysical` (which feeds it the PHYSICAL branch counts) so the two
 * cannot drift.
 *
 * - `unionAll` — the sum; no rows are removed.
 * - `union` — the true count lies in `max(branches) … sum(branches)` and the
 *   deduplication factor is unknown, so report the **sum**: the honest upper
 *   bound. Narrowing it is the job of whatever proves duplicates exist; a
 *   `Distinct` above the union is what states the tighter claim.
 * - `intersect` — the min; the result is a subset of both branches.
 * - `except` — the left branch's count. The right branch can only remove rows,
 *   so the left count is an upper bound and the result can never go negative.
 *
 * `undefined` propagates from any branch the formula actually reads. `except`
 * reads only the left branch, so an unknown right side does not blank it —
 * the left bound is exactly as sound then as it is with a known right side.
 */
export function setOperationRowsFrom(
	op: SetOperationKind,
	leftRows: number | undefined,
	rightRows: number | undefined,
): number | undefined {
	if (leftRows === undefined) return undefined;
	// The right branch subtracts; it is not an input to the upper bound.
	if (op === 'except') return clampRowEstimate(leftRows);
	if (rightRows === undefined) return undefined;
	if (op === 'intersect') return clampRowEstimate(Math.min(leftRows, rightRows));
	// union / unionAll: sum (see the `union` note above).
	return clampRowEstimate(leftRows + rightRows);
}

/** The combinators `AsyncGatherNode` can carry. */
export type GatherCombinatorKind = 'unionAll' | 'zipByKey' | 'crossProduct';

/**
 * An `AsyncGatherNode`'s output cardinality as a pure function of its branches' —
 * shared by its logical `estimatedRows` getter and its `computePhysical` (which
 * feeds it the PHYSICAL branch counts), the same discipline
 * {@link aggregateRowsFrom} applies to the aggregate family.
 *
 * - `unionAll` — the sum, matching {@link setOperationRowsFrom}: a
 *   PostOptimization rule substitutes a gather for a `union all`, and the two
 *   shapes must not report different counts for the same rows.
 * - `zipByKey` — the max. Distinct keys across branches bound the result at
 *   `max(branches) … sum(branches)`; heavily overlapping keys is the normal case.
 * - `crossProduct` — the product, saturated by {@link clampRowEstimate} so three
 *   large branches cannot emit `Infinity`.
 *
 * Any unknown branch makes the whole result unknown — every branch is an input
 * to all three formulas.
 */
export function gatherRowsFrom(
	kind: GatherCombinatorKind,
	branchRows: readonly (number | undefined)[],
): number | undefined {
	let acc = kind === 'crossProduct' ? 1 : 0;
	for (const rows of branchRows) {
		if (rows === undefined) return undefined;
		switch (kind) {
			case 'unionAll':
				acc += rows;
				break;
			case 'zipByKey':
				acc = Math.max(acc, rows);
				break;
			case 'crossProduct':
				// Saturate every step, not just the result: an overflowed `Infinity`
				// intermediate followed by a provably-empty branch would otherwise
				// multiply out to `NaN`.
				acc = clampRowEstimate(acc * rows);
				break;
		}
	}
	return clampRowEstimate(acc);
}
