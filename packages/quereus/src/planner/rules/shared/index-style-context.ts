/**
 * Shared index-style context passed between the retrieve rules.
 *
 * `ruleGrowRetrieve` (producer) stashes an `IndexStyleContext` on a
 * `RetrieveNode.moduleCtx` — an intentionally untyped (`unknown`) channel — when
 * an index-style module accepts a pushed-down access plan via `getBestAccessPlan`.
 * `ruleSelectAccessPath` (consumer) later retrieves it to physicalize the access
 * path. Because the channel is untyped, both sides must agree on the exact shape;
 * this module is the single source of truth so the two rules cannot drift.
 *
 * Use {@link isIndexStyleContext} at the retrieval site to validate the shape and
 * narrow `moduleCtx` from `unknown` — never blind-cast.
 *
 * NOTE: once this context is present on a Retrieve, it is the SOLE authority for what
 * the table access applies — `ruleSelectAccessPath` builds the physical leaf from
 * `accessPlan` + `residualPredicate` and never reads `RetrieveNode.source`. Two rules
 * follow from that, and BOTH have been the subject of a rows-silently-widened bug:
 *
 *  1. Rules must not push a predicate into a committed Retrieve's `source`; it would be
 *     silently dropped. Amend this context instead, or leave the Filter above the
 *     Retrieve so `ruleGrowRetrieve` can re-probe the module with it.
 *     (`bug-filter-conjunct-lost-under-index-order`.)
 *  2. A committed context may only be REPLACED by one that enforces a superset of what
 *     it enforced. `ruleGrowRetrieve` can fire a second time on the same Retrieve, and
 *     its re-probe returns a fresh context that replaces this one wholesale — so the
 *     re-probe must request at least the constraints this context already claims
 *     (`originalConstraints`), must carry `residualPredicate` forward, and must not
 *     accept a plan that drops `accessPlan.providesOrdering` when it is load-bearing.
 *     (`bug-primary-key-conjunct-lost-with-correlated-subquery`.)
 */

import type { BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import type { ScalarPlanNode } from '../../nodes/plan-node.js';
import type { PredicateConstraint } from '../../analysis/constraint-extractor.js';

/**
 * Context data stored in `RetrieveNode.moduleCtx` for the index-style fallback.
 * Produced by `ruleGrowRetrieve`, consumed by `ruleSelectAccessPath`.
 */
export interface IndexStyleContext {
	kind: 'index-style';
	/** Access plan the module returned for the pushed-down request. */
	accessPlan: BestAccessPlanResult;
	/**
	 * Predicate the module could not handle, re-applied above the physical leaf.
	 * A residual is always a scalar boolean expression, hence `ScalarPlanNode`.
	 */
	residualPredicate?: ScalarPlanNode;
	/** Constraints extracted from the pushed-down predicate. */
	originalConstraints: PredicateConstraint[];
	/**
	 * True when a SortNode was DROPPED on the strength of this plan's
	 * `providesOrdering` (`trySortAbsorbViaIndexOrdering`): the leaf's emission
	 * order is now the only thing standing between the query and a wrong ORDER
	 * BY. Re-grows must carry it forward, and the physical leaf lifts it as
	 * `IndexScanNode.orderingLoadBearing` so later rewrites that would change
	 * the leaf's emission order (`rule-key-set-seek`) know to decline. Absent /
	 * false ⇒ any advertised ordering is vacuous — nothing consumed it.
	 */
	orderingLoadBearing?: boolean;
}

/**
 * Type guard narrowing an untyped `moduleCtx` to {@link IndexStyleContext}.
 * Validates the discriminant so the consumer never blind-casts across the
 * cross-rule boundary.
 */
export function isIndexStyleContext(ctx: unknown): ctx is IndexStyleContext {
	// NOTE: discriminant-only check; the payload fields (accessPlan/originalConstraints/
	// residualPredicate) are trusted, not deep-validated. Sound today because
	// ruleGrowRetrieve is the sole writer of this channel. If another producer ever
	// stashes a differently-shaped `{ kind: 'index-style' }` object, add field checks here.
	return !!ctx && typeof ctx === 'object' && (ctx as { kind?: string }).kind === 'index-style';
}
