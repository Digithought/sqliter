/**
 * Conjunct helpers for predicate rewriting.
 *
 * `splitConjuncts` flattens an AND-tree into its individual conjuncts;
 * `combineConjuncts` rebuilds an AND-tree from a list. `splitDisjuncts` is the
 * OR mirror of `splitConjuncts`. Operators that need to partition / push /
 * inspect predicates conjunct-by-conjunct (subquery decorrelation, aggregate
 * predicate pushdown, selectivity estimation, etc.) share these.
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { BinaryOpNode } from '../nodes/scalar.js';

/** Flatten a boolean tree on `operator`; anything else becomes a leaf of the result. */
function splitOn(pred: ScalarPlanNode, operator: 'AND' | 'OR'): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [pred];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === operator) {
			stack.push(n.left, n.right);
		} else {
			result.push(n);
		}
	}
	return result;
}

/** Split an AND-tree into its conjuncts. Non-AND predicates yield a single-element list. */
export function splitConjuncts(pred: ScalarPlanNode): ScalarPlanNode[] {
	return splitOn(pred, 'AND');
}

/** Split an OR-tree into its disjuncts. Non-OR predicates yield a single-element list. */
export function splitDisjuncts(pred: ScalarPlanNode): ScalarPlanNode[] {
	return splitOn(pred, 'OR');
}

/** Combine conjuncts back into a left-associative AND-tree; returns null when empty. */
export function combineConjuncts(conjuncts: ScalarPlanNode[]): ScalarPlanNode | null {
	if (conjuncts.length === 0) return null;
	return conjuncts.reduce((acc, cur) =>
		new BinaryOpNode(
			cur.scope,
			{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
			acc,
			cur
		)
	);
}
