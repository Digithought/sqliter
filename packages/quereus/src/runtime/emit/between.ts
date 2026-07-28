import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import type { EmissionContext } from "../emission-context.js";
import { effectiveBetweenBoundCollation } from "../../planner/analysis/comparison-collation.js";
import { formatOperandCollationNote, makeOperandComparator } from "./operand-comparator.js";

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
	const lowerCompare = makeOperandComparator(exprLogical, plan.lower.getType().logicalType, lowerCollationFunc);
	const upperCompare = makeOperandComparator(exprLogical, plan.upper.getType().logicalType, upperCollationFunc);

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
		note: `${notPrefix}BETWEEN${formatOperandCollationNote([lowerCollationName, upperCollationName])}`
	};
}
