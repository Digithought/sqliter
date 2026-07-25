import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { BetweenNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering } from "../../util/comparison.js";
import type { LogicalType } from "../../types/logical-type.js";
import type { EmissionContext } from "../emission-context.js";
import { effectiveBetweenBoundCollation } from "../../planner/analysis/comparison-collation.js";
import { tryTemporalComparison } from "./temporal-arithmetic.js";

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

	// Per-bound comparator, mirroring emitComparisonOp so BETWEEN stays byte-identical
	// to its desugared `expr >= lower AND expr <= upper`: a shared semantic-ordering
	// logical type (TIMESPAN, JSON) compares through the type's compare; otherwise a
	// runtime temporal check catches duration-vs-text pairs (as the generic comparison
	// path does) before the storage-class + collation compare.
	const exprLogical = plan.expr.getType().logicalType as LogicalType;
	const makeBoundCompare = (boundNode: typeof plan.lower, collationFunc: (a: string, b: string) => number) => {
		const boundLogical = boundNode.getType().logicalType as LogicalType;
		if (exprLogical === boundLogical && hasSemanticOrdering(exprLogical)) {
			return createTypedComparator(exprLogical, collationFunc);
		}
		return (v: SqlValue, bound: SqlValue): number => {
			const geResult = tryTemporalComparison('>=', v, bound);
			if (geResult !== undefined) {
				// Derive the three-way result from two semantic probes.
				return geResult === true ? (tryTemporalComparison('<=', v, bound) === true ? 0 : 1) : -1;
			}
			return compareSqlValuesFast(v, bound, collationFunc);
		};
	};
	const lowerCompare = makeBoundCompare(plan.lower, lowerCollationFunc);
	const upperCompare = makeBoundCompare(plan.upper, upperCollationFunc);

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

/** Build the collation suffix for a BETWEEN note: nothing when both bounds are
 *  BINARY, a single name when they agree, or `lower/upper` when they differ. */
function formatBetweenCollationNote(lowerColl: string, upperColl: string): string {
	if (lowerColl === upperColl) {
		return lowerColl !== 'BINARY' ? ` ${lowerColl}` : '';
	}
	return ` ${lowerColl}/${upperColl}`;
}
