/**
 * Shared helpers for recognizing subqueries embedded in scalar expression trees:
 * the `ScalarSubqueryNode` collect/substitute pair used by the rewrite rules
 * (`rule-fanout-lookup-join`, `rule-scalar-agg-decorrelation`), plus the
 * node-type-agnostic {@link hasRelationalDescendant} test.
 */

import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { ScalarSubqueryNode } from '../nodes/subquery.js';

/**
 * True iff `expr`'s subtree contains a relational descendant — i.e. it embeds a
 * subquery of ANY shape (scalar-subquery, `EXISTS`, `IN (select …)`, …), each of
 * which exposes its relational body via `getChildren()`. Pure scalar operands
 * (column refs, literals, arithmetic, `IN (<value list>)`, direct function calls)
 * have no relational descendant.
 *
 * Detecting the relational child structurally, rather than listing the scalar
 * node types that wrap a subquery, is what makes this safe against new subquery
 * shapes: the list form missed `x in (select …)`, whose `InNode` carries its
 * source relation but reports `PlanNodeType.In`
 * (bug-deferred-subquery-check-reads-stale-state).
 *
 * Callers: CHECK auto-deferral (`planner/building/constraint-builder.ts`), the
 * MV-rewrite residual gate (`query-rewrite-matcher.ts`), and AND/OR
 * short-circuit deferral (`runtime/emit/binary.ts`).
 */
export function hasRelationalDescendant(expr: ScalarPlanNode): boolean {
	const stack: PlanNode[] = [expr];
	while (stack.length) {
		const node = stack.pop()!;
		if (node !== expr && isRelationalNode(node)) return true;
		stack.push(...node.getChildren());
	}
	return false;
}

/**
 * Collect every `ScalarSubqueryNode` reachable in a projection's scalar
 * expression tree, in deterministic pre-order. A recognized subquery is a leaf
 * for this walk: we push it and do NOT descend into its relational body, so a
 * subquery nested *inside* another subquery's correlation predicate remains part
 * of its enclosing branch child rather than being collected separately.
 * (The relational body is filtered out by the `typeClass === 'scalar'` guard
 * regardless, but stopping early keeps the intent explicit.)
 */
export function collectScalarSubqueries(expr: ScalarPlanNode, out: ScalarSubqueryNode[]): void {
	if (expr instanceof ScalarSubqueryNode) {
		out.push(expr);
		return;
	}
	for (const child of expr.getChildren()) {
		if (child.getType().typeClass === 'scalar') {
			collectScalarSubqueries(child as ScalarPlanNode, out);
		}
	}
}

/**
 * Rebuild a projection's scalar expression with each recognized
 * `ScalarSubqueryNode` replaced by its substitute expression, leaving the
 * wrapping expression (`coalesce(<substitute>, 0)`) intact. For a bare-subquery
 * projection the root itself is in the map and is returned directly; for a
 * wrapped subquery the tree is rebuilt via `withChildren` with only the matched
 * inner node substituted. Returns the input unchanged when no descendant is a
 * recognized subquery.
 */
export function substituteSubqueries(
	expr: ScalarPlanNode,
	replacements: ReadonlyMap<ScalarSubqueryNode, ScalarPlanNode>,
): ScalarPlanNode {
	if (expr instanceof ScalarSubqueryNode) {
		return replacements.get(expr) ?? expr;
	}
	const children = expr.getChildren();
	if (children.length === 0) return expr;

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of children) {
		if (child.getType().typeClass === 'scalar') {
			const replaced = substituteSubqueries(child as ScalarPlanNode, replacements);
			newChildren.push(replaced);
			if (replaced !== child) changed = true;
		} else {
			newChildren.push(child);
		}
	}
	if (!changed) return expr;
	return expr.withChildren(newChildren) as ScalarPlanNode;
}
