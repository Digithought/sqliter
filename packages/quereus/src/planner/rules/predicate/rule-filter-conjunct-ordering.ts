/**
 * Rule: Filter Conjunct Ordering
 *
 * Reorders the top-level AND conjuncts of a FilterNode predicate so the
 * emitter's conjunct early exit (runtime/emit/filter.ts) skips expensive
 * conjuncts for every row an earlier conjunct already rejects. The sort key is
 * `compareConjunctRank` (`cost/conjunct-cost.ts`): cost tier first, then —
 * within a tier — estimated filtering bought per unit work,
 * `(1 - selectivity) / cost` descending, with plain subtree cost breaking
 * ratio ties.
 *
 * Selectivity comes from the shared per-conjunct estimator
 * (`stats/conjunct-selectivity.ts`), gated on `statsOnlySelectivity` — real
 * statistics only, never the NaiveStatsProvider's fabricated per-nodeType
 * guess, whose numbers differ BY NODE KIND and would reorder conjuncts on no
 * information at all. When no conjunct gets a real estimate the rule sorts
 * with `compareConjunctCost` verbatim — an explicit branch, so a query with no
 * ANALYZE'd statistics orders bit-identically to the cost-only rule.
 *
 * Soundness: SQL AND is commutative under three-valued logic, and a Filter
 * rejects on both `false` and `NULL`, so any permutation of the conjuncts
 * keeps the row set identical. Reordering changes only evaluation COUNTS,
 * which is why the rule refuses when any conjunct's subtree carries a side
 * effect.
 *
 * NOTE (tripwire): "row set identical" is a claim about VALUES, not about
 * thrown errors. A conjunct written after a guard (`v <> 0 and 10 / v > 1`)
 * may run on rows the guard would have rejected once it sorts ahead of the
 * guard. Harmless today — every arithmetic edge quereus defines returns NULL
 * rather than throwing (division by zero included, pinned in
 * test/logic/07.7.4-where-conjunct-ordering.sqllogic), and a cheap guard
 * already sorts first. It only becomes real if a scalar function that THROWS
 * on bad input ships and a query guards it with a conjunct in a more expensive
 * tier (e.g. `exists (...) and parse(x) > 0`). Selectivity adds a SECOND route
 * past a guard: a statistics-strong conjunct can now sort ahead of a cheaper
 * same-tier guard even where cost alone would have kept the guard first. At
 * that point either gate the reorder on a per-function "may raise" trait or
 * tell users to guard with CASE, as PostgreSQL does.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import {
	classifyConjunctCost, compareConjunctCost, compareConjunctRank,
	UNKNOWN_CONJUNCT_SELECTIVITY, type ConjunctCost,
} from '../../cost/conjunct-cost.js';
import { collectColumnOrigins } from '../../util/column-origins.js';
import { estimateConjunctSelectivity } from '../../stats/conjunct-selectivity.js';

const log = createLogger('optimizer:rule:filter-conjunct-ordering');

export function ruleFilterConjunctOrdering(node: PlanNode, context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;

	const conjuncts = splitConjuncts(filter.predicate);
	if (conjuncts.length < 2) return null;

	// Predicates are pure today, but reordering under early exit changes how
	// often each conjunct runs — refuse outright when any conjunct carries a
	// side effect. This guard is what makes sideEffectMode 'safe' honest.
	if (conjuncts.some(c => PlanNodeCharacteristics.subtreeHasSideEffects(c))) return null;

	const costs = conjuncts.map(classifyConjunctCost);
	const selectivities = estimateSelectivities(filter, conjuncts, context);

	// Array.prototype.sort is stable, so equal-key conjuncts keep source order —
	// the determinism requirement.
	let sorted: ReadonlyArray<{ conjunct: ScalarPlanNode; cost: ConjunctCost }>;
	if (selectivities === undefined) {
		// No conjunct got a real estimate (or the provider has none to give):
		// sort with the cost-only comparator verbatim, so the order is
		// bit-identical to the pre-selectivity rule.
		const ranked = conjuncts.map((conjunct, i) => ({ conjunct, cost: costs[i] }));
		sorted = [...ranked].sort((a, b) => compareConjunctCost(a.cost, b.cost));
	} else {
		const ranked = conjuncts.map((conjunct, i) => ({
			conjunct,
			cost: { ...costs[i], selectivity: selectivities[i] ?? UNKNOWN_CONJUNCT_SELECTIVITY },
		}));
		sorted = [...ranked].sort((a, b) => compareConjunctRank(a.cost, b.cost));
	}

	// Already ordered → null. This is not an optimization: it is the fixed point
	// that stops the rewrite loop (an unconditional rebuild would flip conjunct
	// order forever). The key depends only on the node and on `context.stats`,
	// which is stable within one optimize(), so the sort is idempotent.
	if (sorted.every((entry, i) => entry.conjunct === conjuncts[i])) return null;

	// length >= 2, so combineConjuncts cannot return null.
	const reordered = combineConjuncts(sorted.map(entry => entry.conjunct))!;
	log(`Reordered ${conjuncts.length} conjuncts (${selectivities === undefined ? 'cost only' : 'cost + selectivity'})`);

	// Construct directly rather than via withPredicate (which drops selectivity
	// on any predicate change): reordering does not change the conjunct SET, so
	// the estimate stamped by rule-filter-selectivity remains exactly as valid.
	return new FilterNode(filter.scope, filter.source, reordered, undefined, filter.selectivity);
}

/**
 * Per-conjunct selectivities aligned with `conjuncts`, or undefined when the
 * whole filter must fall back to cost-only ordering: the provider implements no
 * `statsOnlySelectivity`, the source exposes no base-column origins (HAVING over
 * an aggregate, a set operation, a `values` clause, …), or no conjunct could be
 * estimated. The provider check comes first so the origins walk — a full pass
 * over the source subtree — is skipped outright for a provider that omits the
 * method.
 *
 * NOTE (tripwire): that short-circuit does NOT help the production
 * `CatalogStatsProvider`, which always implements `statsOnlySelectivity`. A
 * database with nothing ANALYZEd therefore still pays one origins walk per
 * multi-conjunct Filter here, on top of the one `rule-filter-selectivity`
 * already pays. Unmeasured; if it ever profiles hot, memoize the map per pass on
 * OptContext keyed by the source node — the fix noted at that rule.
 */
function estimateSelectivities(
	filter: FilterNode,
	conjuncts: readonly ScalarPlanNode[],
	context: OptContext,
): ReadonlyArray<number | undefined> | undefined {
	if (context.stats.statsOnlySelectivity == null) return undefined;

	const origins = collectColumnOrigins(filter.source);
	if (origins.size === 0) return undefined;

	const estimates = conjuncts.map(c => estimateConjunctSelectivity(c, origins, context));
	return estimates.some(e => e !== undefined) ? estimates : undefined;
}
