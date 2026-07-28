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
