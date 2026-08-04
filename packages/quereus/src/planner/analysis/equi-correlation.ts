/**
 * Shared analysis helpers for subquery decorrelation rules: classifying
 * filter conjuncts as simple equi-correlations (`outer.col = inner.col`) and
 * detecting leftover outer references in residual predicates.
 *
 * Used by `rule-subquery-decorrelation` (EXISTS/IN → semi/anti join) and
 * `rule-scalar-agg-decorrelation` (scalar aggregate subquery → grouped left
 * join).
 */

import { isRelationalNode, type PlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Check if a scalar node is a simple equi-join between outer and inner attributes.
 * Matches: outer.col = inner.col (or inner.col = outer.col)
 */
export function isEquiCorrelation(
	node: ScalarPlanNode,
	outerAttrIds: ReadonlySet<number>,
	innerAttrIds: ReadonlySet<number>,
): boolean {
	if (!(node instanceof BinaryOpNode)) return false;
	if (node.expression.operator !== '=') return false;
	if (!(node.left instanceof ColumnReferenceNode) || !(node.right instanceof ColumnReferenceNode)) return false;

	const leftId = node.left.attributeId;
	const rightId = node.right.attributeId;

	return (outerAttrIds.has(leftId) && innerAttrIds.has(rightId)) ||
		   (outerAttrIds.has(rightId) && innerAttrIds.has(leftId));
}

/**
 * Collect attribute IDs defined by a relational subtree.
 *
 * `shouldDescend`, when supplied, prunes the walk: a child it rejects contributes
 * neither its own attributes nor its subtree's. Callers use it to stop at a subtree
 * whose attributes their query could never name — see `buildGroupedWindowContext`
 * (planner/building/select-aggregates.ts) and CTE definitions.
 */
export function collectDefinedAttrIds(
	node: PlanNode,
	shouldDescend?: (child: PlanNode) => boolean,
): Set<number> {
	const ids = new Set<number>();
	function walk(n: PlanNode): void {
		if (isRelationalNode(n)) {
			for (const attr of n.getAttributes()) {
				ids.add(attr.id);
			}
		}
		for (const child of n.getChildren()) {
			if (shouldDescend && !shouldDescend(child)) continue;
			walk(child);
		}
	}
	walk(node);
	return ids;
}

/**
 * Returns true if the plan tree contains any column reference to an
 * attribute id in `attrIds`. Used to detect leftover correlation in
 * residual inner-only predicates (which may include nested subqueries).
 */
export function referencesAnyAttr(node: PlanNode, attrIds: ReadonlySet<number>): boolean {
	if (node instanceof ColumnReferenceNode && attrIds.has(node.attributeId)) {
		return true;
	}
	for (const child of node.getChildren()) {
		if (referencesAnyAttr(child, attrIds)) return true;
	}
	return false;
}
