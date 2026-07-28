/**
 * Per-conjunct evaluation-cost classification for WHERE/HAVING conjunct
 * ordering (`rule-filter-conjunct-ordering`).
 *
 * Raw `getTotalCost()` alone misorders conjuncts: a tableless scalar subquery
 * (`(select f())`) costs barely more than a modulo and *less* than a three-term
 * arithmetic expression, yet opens a whole sub-program per row. So conjuncts
 * are ranked on a coarse structural tier first, with subtree cost only as the
 * within-tier tiebreak.
 *
 * Do NOT re-export from cost/index.ts: nodes/filter.ts imports cost/index.ts,
 * and this module imports plan-node + characteristics, so re-exporting here
 * would create an import cycle.
 */

import { PlanNode, isRelationalNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../framework/characteristics.js';

/** How expensive a WHERE conjunct is to evaluate once, coarsest signal first. */
export enum ConjunctCostTier {
	/** Pure, deterministic scalar arithmetic / comparison. */
	Pure = 0,
	/** Contains a non-deterministic (volatile) scalar — e.g. a volatile UDF. */
	Volatile = 1,
	/** Contains a relational descendant — a scalar / IN / EXISTS subquery. */
	Subquery = 2,
}

export interface ConjunctCost {
	tier: ConjunctCostTier;
	/** Whole-subtree cost of the conjunct (`node.getTotalCost()`). */
	subtreeCost: number;
}

/**
 * Classify one conjunct: walk its subtree once (iterative worklist, matching
 * `PlanNodeCharacteristics.subtreeHasSideEffects`) and report the HIGHEST tier
 * found — `Subquery` if any strict descendant is relational, else `Volatile`
 * if any node is non-deterministic, else `Pure`.
 */
export function classifyConjunctCost(node: ScalarPlanNode): ConjunctCost {
	let tier = ConjunctCostTier.Pure;
	const stack: PlanNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current !== node && isRelationalNode(current)) {
			// Highest tier — nothing further to learn, stop walking.
			tier = ConjunctCostTier.Subquery;
			break;
		}
		if (!PlanNodeCharacteristics.isDeterministic(current)) {
			// Keep walking: a relational descendant would still outrank this.
			tier = ConjunctCostTier.Volatile;
		}
		for (const child of current.getChildren()) {
			stack.push(child);
		}
	}
	return { tier, subtreeCost: node.getTotalCost() };
}

/**
 * (tier, subtreeCost) lexicographic. Ties resolve to 0 — callers keep source
 * order for ties via a stable sort.
 */
export function compareConjunctCost(a: ConjunctCost, b: ConjunctCost): number {
	if (a.tier !== b.tier) return a.tier - b.tier;
	return a.subtreeCost - b.subtreeCost;
}
