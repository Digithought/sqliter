import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import type { ScalarPlanNode } from "../../planner/nodes/plan-node.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering } from "../../util/comparison.js";
import type { CollationFunction, LogicalType } from "../../types/logical-type.js";
import type { EmissionContext } from "../emission-context.js";
import { effectiveBetweenBoundCollation } from "../../planner/analysis/comparison-collation.js";
import { tryTemporalCompare } from "./temporal-arithmetic.js";

export function emitBetween(plan: BetweenNode, ctx: EmissionContext): Instruction {
	// BETWEEN desugars to `expr >= lower AND expr <= upper`; each comparison
	// resolves its collation independently through the shared provenance lattice
	// (explicit COLLATE > declared column collation > defaults — see
	// analysis/comparison-collation.ts), so an explicit COLLATE on a bound wins
	// over the tested column's defaulted collation and vice versa.
	const lowerCollationName = effectiveBetweenBoundCollation(plan.expr, plan.lower);
	const upperCollationName = effectiveBetweenBoundCollation(plan.expr, plan.upper);

	// Pre-resolve a collation function per comparison for optimal performance
	const lowerCollationFunc = ctx.resolveCollation(lowerCollationName);
	const upperCollationFunc = ctx.resolveCollation(upperCollationName);

	const exprLogical = plan.expr.getType().logicalType;
	const lowerCompare = makeBoundComparator(exprLogical, plan.lower, lowerCollationFunc);
	const upperCompare = makeBoundComparator(exprLogical, plan.upper, upperCollationFunc);

	// Cross-category coercion is handled at plan time via explicit CastNodes,
	// so no runtime coercion is needed here.
	function run(ctx: RuntimeContext, value: SqlValue, lowerBound: SqlValue, upperBound: SqlValue): SqlValue {
		if (value === null || lowerBound === null || upperBound === null) return null;

		// NOT BETWEEN is `!(lower <= v <= upper)` = `v < lo (lowerColl) OR v > hi (upperColl)`,
		// which the per-bound negation below preserves.
		const lowerResult = lowerCompare(value, lowerBound);
		const upperResult = upperCompare(value, upperBound);
		const betweenResult = (lowerResult >= 0 && upperResult <= 0);

		return plan.expression.not ? !betweenResult : betweenResult;
	}

	const valueExpr = emitPlanNode(plan.expr, ctx);
	const lowerExpr = emitPlanNode(plan.lower, ctx);
	const upperExpr = emitPlanNode(plan.upper, ctx);

	const notPrefix = plan.expression.not ? 'NOT ' : '';

	return {
		params: [valueExpr, lowerExpr, upperExpr],
		run: asRun(run),
		note: `${notPrefix}BETWEEN${formatBetweenCollationNote(lowerCollationName, upperCollationName)}`
	};
}

/**
 * Comparator for one BETWEEN bound, selecting the SAME path `emitComparisonOp` would
 * select for the desugared `expr >= lower` / `expr <= upper`, so BETWEEN and its
 * desugared form never disagree:
 *  - both sides declare the same semantic-ordering type (TIMESPAN, JSON) ⇒ the type's
 *    compare, matching the operator's typed fast path;
 *  - neither side is temporal and both share a category (numeric/numeric or
 *    textual/textual) ⇒ plain storage-class + collation compare, matching the
 *    operator's same-category fast path. Notably a plain TEXT column holding
 *    duration-shaped text ('PT30M') stays text-ordered here, exactly as `>=` leaves it;
 *  - otherwise ⇒ a runtime duration check first, matching the operator's generic path.
 */
function makeBoundComparator(
	exprLogical: LogicalType,
	boundNode: ScalarPlanNode,
	collationFunc: CollationFunction,
): (v: SqlValue, bound: SqlValue) => number {
	const boundLogical = boundNode.getType().logicalType;
	if (exprLogical === boundLogical && hasSemanticOrdering(exprLogical)) {
		return createTypedComparator(exprLogical, collationFunc);
	}

	const needsTemporalCheck = exprLogical.isTemporal || boundLogical.isTemporal;
	const bothSameCategory = (exprLogical.isNumeric && boundLogical.isNumeric)
		|| (exprLogical.isTextual && boundLogical.isTextual);
	if (!needsTemporalCheck && bothSameCategory) {
		return (v, bound) => compareSqlValuesFast(v, bound, collationFunc);
	}

	return (v, bound) => tryTemporalCompare(v, bound) ?? compareSqlValuesFast(v, bound, collationFunc);
}

/** Build the collation suffix for a BETWEEN note: nothing when both bounds are
 *  BINARY, a single name when they agree, or `lower/upper` when they differ. */
function formatBetweenCollationNote(lowerColl: string, upperColl: string): string {
	if (lowerColl === upperColl) {
		return lowerColl !== 'BINARY' ? ` ${lowerColl}` : '';
	}
	return ` ${lowerColl}/${upperColl}`;
}
