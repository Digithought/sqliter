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

/**
 * Flatten a boolean tree on `operator`; anything else becomes a leaf of the result.
 *
 * Iterative (an explicit stack, not recursion) so a pathological chain of a few
 * thousand ANDs cannot overflow. `ordered` pushes the right child first so the
 * left child pops first, yielding left-to-right source order.
 */
function splitOn(pred: ScalarPlanNode, operator: 'AND' | 'OR', ordered = false): ScalarPlanNode[] {
	const result: ScalarPlanNode[] = [];
	const stack: ScalarPlanNode[] = [pred];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === operator) {
			if (ordered) {
				stack.push(n.right, n.left);
			} else {
				stack.push(n.left, n.right);
			}
		} else {
			result.push(n);
		}
	}
	return result;
}

/**
 * Split an AND-tree into its conjuncts. Non-AND predicates yield a single-element list.
 *
 * NOTE: the result is **not** in source order — the push-left-then-right stack walk
 * scrambles it (`(select x) = 1 and v = 2` splits to `[v = 2, (select x) = 1]`).
 * Every current caller treats the result as an unordered set, and this ordering is
 * not worth changing under them. An order-sensitive caller (anything that decides
 * *evaluation* order, e.g. the Filter emitter's conjunct early exit) must use
 * {@link splitConjunctsOrdered} instead.
 */
export function splitConjuncts(pred: ScalarPlanNode): ScalarPlanNode[] {
	return splitOn(pred, 'AND');
}

/**
 * Split an AND-tree into its conjuncts in left-to-right source order.
 *
 * Use this wherever the conjunct order is observable — evaluation order, early
 * exit, cost-based reordering — so that "the order the user wrote" is the order
 * the engine starts from. {@link splitConjuncts} is cheaper to reason about only
 * when order is irrelevant; it returns the same set in a scrambled order.
 */
export function splitConjunctsOrdered(pred: ScalarPlanNode): ScalarPlanNode[] {
	return splitOn(pred, 'AND', true);
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
