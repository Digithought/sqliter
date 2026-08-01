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
import { DEFAULT_FILTER_SELECTIVITY } from '../nodes/filter.js';

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

/**
 * Selectivity assigned to a conjunct the statistics could not estimate, when at
 * least one sibling conjunct WAS estimated. This is `DEFAULT_FILTER_SELECTIVITY`
 * (0.5) — the engine's one "nobody knows" fraction, the same one
 * `FilterNode.estimatedRows` falls back to — so "no information" is the neutral
 * position: a measured-stronger conjunct (s < 0.5) sorts ahead of unknowns, a
 * measured-weaker one (s > 0.5) behind. With the benefit term constant across a
 * group of unknowns, descending benefit/cost degenerates to ascending cost, so
 * unknowns keep their cost order among themselves.
 */
export const UNKNOWN_CONJUNCT_SELECTIVITY = DEFAULT_FILTER_SELECTIVITY;

/**
 * Divide-by-zero guard only. `PlanNode.estimatedCost` defaults to 0.01 and the
 * leaf scalar nodes cost 1, so no real conjunct has zero subtree cost; the floor
 * keeps a zero from turning the ratio into Infinity. It cannot repair a NaN
 * cost — but `getTotalCost()` sums finite per-node costs, so none arises.
 */
export const MIN_CONJUNCT_COST = 1e-9;

export interface ConjunctRank extends ConjunctCost {
	/**
	 * Estimated fraction of rows the conjunct keeps, from the stats provider's
	 * `statsOnlySelectivity` family; {@link UNKNOWN_CONJUNCT_SELECTIVITY} when
	 * unknown. Clamped to [0, 1] at comparison time, so an out-of-range provider
	 * value cannot produce a negative benefit.
	 */
	selectivity: number;
}

/** Filtering bought per unit of evaluation work: `(1 - selectivity) / cost`. */
function filteringRatio(rank: ConjunctRank): number {
	const sel = Math.min(1, Math.max(0, rank.selectivity));
	return (1 - sel) / Math.max(rank.subtreeCost, MIN_CONJUNCT_COST);
}

/**
 * (tier asc, benefit/cost desc, subtreeCost asc) lexicographic.
 *
 * The tier stays the primary key: raw cost is not comparable ACROSS tiers (see
 * the module doc-comment), so a measured selectivity must never bet against an
 * unmeasured per-row sub-program cost — a strongly-selective `Subquery`-tier
 * conjunct cannot jump ahead of a weakly-selective `Pure` one. Within a tier the
 * conjuncts are the same structural class, cost is comparable, and the ratio is
 * the textbook rank. Ratio ties fall through to plain cost (never a raw ratio
 * difference — a sub-ULP difference must not collapse two distinct keys into a
 * tie); full ties resolve to 0 and callers keep source order via a stable sort.
 */
export function compareConjunctRank(a: ConjunctRank, b: ConjunctRank): number {
	if (a.tier !== b.tier) return a.tier - b.tier;
	const ra = filteringRatio(a);
	const rb = filteringRatio(b);
	if (ra !== rb) return rb - ra;
	return a.subtreeCost - b.subtreeCost;
}
