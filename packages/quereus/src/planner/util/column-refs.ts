/**
 * Column-reference walks over scalar plan subtrees.
 *
 * Lives here rather than in `analysis/constraint-extractor.ts` so that
 * `planner/nodes/` can import it as a *value*: the runtime cycle
 * `constraint-extractor → nodes/reference → …` is real, and this module
 * deliberately depends on nothing but the node-type enum.
 */

import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { ColumnReferenceNode } from '../nodes/reference.js';

/**
 * Collect the attributeIds of every ColumnReference in a scalar subtree.
 * Walking into children (rather than only unwrapping a top-level Cast) reaches
 * references nested inside arithmetic, function calls, casts, etc. — e.g.
 * `outer.id + 1`, `coalesce(outer.id, 0)`, `cast(outer.id + 1 as integer)`.
 */
export function collectColumnRefAttributeIds(node: ScalarPlanNode): number[] {
	const ids: number[] = [];
	const stack: ScalarPlanNode[] = [node];
	while (stack.length) {
		const n = stack.pop()!;
		if (n.nodeType === PlanNodeType.ColumnReference) {
			ids.push((n as unknown as ColumnReferenceNode).attributeId);
		}
		for (const c of n.getChildren()) {
			stack.push(c as unknown as ScalarPlanNode);
		}
	}
	return ids;
}
