/**
 * Rule: Filter Conjunct Ordering
 *
 * Reorders the top-level AND conjuncts of a FilterNode predicate by estimated
 * evaluation cost, cheapest first, so the emitter's conjunct early exit
 * (runtime/emit/filter.ts) skips expensive conjuncts for every row a cheap
 * conjunct already rejects.
 *
 * Soundness: SQL AND is commutative under three-valued logic, and a Filter
 * rejects on both `false` and `NULL`, so any permutation of the conjuncts
 * keeps the row set identical. Reordering changes only evaluation COUNTS,
 * which is why the rule refuses when any conjunct's subtree carries a side
 * effect.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { classifyConjunctCost, compareConjunctCost, type ConjunctCost } from '../../cost/conjunct-cost.js';

const log = createLogger('optimizer:rule:filter-conjunct-ordering');

export function ruleFilterConjunctOrdering(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;

	const conjuncts = splitConjuncts(filter.predicate);
	if (conjuncts.length < 2) return null;

	// Predicates are pure today, but reordering under early exit changes how
	// often each conjunct runs — refuse outright when any conjunct carries a
	// side effect. This guard is what makes sideEffectMode 'safe' honest.
	if (conjuncts.some(c => PlanNodeCharacteristics.subtreeHasSideEffects(c))) return null;

	const ranked: Array<{ conjunct: ScalarPlanNode; cost: ConjunctCost }> =
		conjuncts.map(conjunct => ({ conjunct, cost: classifyConjunctCost(conjunct) }));
	// Array.prototype.sort is stable, so equal-cost conjuncts keep source order —
	// the determinism requirement.
	const sorted = [...ranked].sort((a, b) => compareConjunctCost(a.cost, b.cost));

	// Already ordered → null. This is not an optimization: it is the fixed point
	// that stops the rewrite loop (an unconditional rebuild would flip conjunct
	// order forever).
	if (sorted.every((entry, i) => entry.conjunct === conjuncts[i])) return null;

	// length >= 2, so combineConjuncts cannot return null.
	const reordered = combineConjuncts(sorted.map(entry => entry.conjunct))!;
	log(`Reordered ${conjuncts.length} conjuncts cheapest-first`);

	// Construct directly rather than via withPredicate (which drops selectivity
	// on any predicate change): reordering does not change the conjunct SET, so
	// the estimate stamped by rule-filter-selectivity remains exactly as valid.
	return new FilterNode(filter.scope, filter.source, reordered, undefined, filter.selectivity);
}
