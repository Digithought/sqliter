/**
 * Row-population predicates.
 *
 * Answers one question: are the rows a node emits *the same rows* its source
 * relation holds, or a different population entirely? Two callers need it —
 * `column-origins.ts` (which attribute ids describe a base-table column) and
 * `key-utils.ts`'s `extractRowSourceTableSchema` (whose statistics describe the
 * rows arriving here) — and they must not drift apart.
 *
 * Decided by `nodeType` rather than `instanceof`: `plan-node-type.ts` is a leaf
 * module, so importing it cannot introduce a cycle into `key-utils.ts` (which is
 * imported from deep inside the node layer).
 *
 * NOTE: `Distinct` is deliberately NOT here. Its output rows are a *subset* of
 * its source's rows, not a different population, so a base-table row fraction
 * stays a defensible approximation. If a filter over a `distinct` ever shows a
 * bad estimate, the reason is a heavily-skewed column — the fraction of *rows*
 * matching a predicate and the fraction of *distinct rows* matching it diverge
 * when values repeat unevenly — and `Distinct` should join `isRowRegrouping`.
 * `LimitOffset`, `OrdinalSlice` and the physical access nodes are excluded for
 * the same reason: subsets, not different populations.
 */

import type { RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';

/**
 * Does this node publish one branch's attribute ids over rows drawn from several
 * branches? Such an id describes no single base-table column: `union all` of a
 * 4-distinct-value column with a 1000-distinct-value one publishes the left
 * branch's id while carrying both distributions.
 */
export function isRowMerging(node: RelationalPlanNode): boolean {
	return node.nodeType === PlanNodeType.SetOperation
		|| node.nodeType === PlanNodeType.RecursiveCTE;
}

/**
 * Does this node emit one row per group rather than one row per input row? The
 * output cardinality is the group count and the output values are aggregates, so
 * the source's per-row statistics describe neither.
 */
export function isRowRegrouping(node: RelationalPlanNode): boolean {
	return node.nodeType === PlanNodeType.Aggregate
		|| node.nodeType === PlanNodeType.StreamAggregate
		|| node.nodeType === PlanNodeType.HashAggregate;
}

/**
 * Either of the above: the rows this node emits are not the source relation's
 * rows, so the source's statistics do not describe them.
 */
export function changesRowPopulation(node: RelationalPlanNode): boolean {
	return isRowMerging(node) || isRowRegrouping(node);
}
