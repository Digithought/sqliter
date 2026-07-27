import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import type { ScalarPlanNode } from '../../planner/nodes/plan-node.js';
import type { AggregateArgBinding, FunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { bindAggregateSchema } from '../../func/registration.js';
import { createTypedComparator, hasSemanticOrdering } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import type { EmissionContext } from '../emission-context.js';

/**
 * Emit-time setup shared by the stream and hash aggregate emitters: both walk the
 * same `{ expression, alias }` aggregate list and need the same per-aggregate
 * pre-resolutions. Everything here runs ONCE per emit — never per row.
 *
 * {@link argComparisonContext} is shared more widely still: the window emitter
 * binds its own registry's comparison-sensitive functions from the same context,
 * so `min(x) over (…)` and the `min(x)` aggregate read the call site identically.
 */

/** One entry of a stream/hash aggregate node's `aggregates` list. */
export type AggregateExpr = { readonly expression: ScalarPlanNode; readonly alias: string };

/** Compares one aggregate's argument values for DISTINCT tracking (scalar for a
 *  single argument, element-wise for several, constant for `count(*)`). */
export type DistinctComparator = (a: SqlValue | SqlValue[], b: SqlValue | SqlValue[]) => number;

/** The declared logical type and resolved collation of one aggregate or window
 *  argument at this call site — the comparison context `bindArgs` (aggregate and
 *  window alike) and DISTINCT tracking all rank under. A missing collation name
 *  stays undefined, which every consumer reads as BINARY. The logical type is
 *  always known here (narrower than {@link AggregateArgBinding}, which allows an
 *  untyped argument), so callers may compare with it directly. */
export function argComparisonContext(
	arg: ScalarPlanNode,
	ctx: EmissionContext,
): Required<Pick<AggregateArgBinding, 'logicalType'>> & AggregateArgBinding {
	const argType = arg.getType();
	return {
		logicalType: argType.logicalType as LogicalType,
		collation: argType.collationName ? ctx.resolveCollation(argType.collationName) : undefined,
	};
}

function argComparator(arg: ScalarPlanNode, ctx: EmissionContext): (a: SqlValue, b: SqlValue) => number {
	const { logicalType, collation } = argComparisonContext(arg, ctx);
	return createTypedComparator(logicalType, collation);
}

/** The aggregate call at `agg`, or an INTERNAL error when the plan holds something else. */
function requireAggregateCall(agg: AggregateExpr): AggregateFunctionCallNode {
	const funcNode = agg.expression;
	if (!(funcNode instanceof AggregateFunctionCallNode)) {
		quereusError(
			`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`,
			StatusCode.INTERNAL
		);
	}
	return funcNode;
}

/**
 * Resolve each aggregate's schema and bind it to its call site's argument types and
 * collations, so a comparison-sensitive aggregate (min/max via
 * {@link import('../../schema/function.js').AggregateFunctionSchema.bindArgs}) steps
 * and merges by the argument's semantic order. Nothing in the per-row path then has
 * to resolve a type or a collation.
 */
export function bindAggregateSchemas(
	aggregates: readonly AggregateExpr[],
	ctx: EmissionContext,
): { schemas: FunctionSchema[]; distinctFlags: boolean[] } {
	const schemas: FunctionSchema[] = [];
	const distinctFlags: boolean[] = [];
	for (const agg of aggregates) {
		const funcNode = requireAggregateCall(agg);
		const funcSchema = funcNode.functionSchema;
		if (!isAggregateFunctionSchema(funcSchema)) {
			quereusError(
				`Function ${funcNode.functionName || 'unknown'} is not an aggregate function`,
				StatusCode.INTERNAL
			);
		}
		schemas.push(bindAggregateSchema(funcSchema, (funcNode.args || []).map(arg => argComparisonContext(arg, ctx))));
		distinctFlags.push(funcNode.isDistinct);
	}
	return { schemas, distinctFlags };
}

/** Pre-resolved typed comparators for DISTINCT aggregate argument tracking. */
export function buildDistinctComparators(
	aggregates: readonly AggregateExpr[],
	ctx: EmissionContext,
): DistinctComparator[] {
	return aggregates.map(agg => {
		const funcNode = agg.expression;
		if (!(funcNode instanceof AggregateFunctionCallNode)) return () => 0;
		const args = funcNode.args || [];
		if (args.length === 1) {
			const cmp = argComparator(args[0], ctx);
			return (a, b) => cmp(a as SqlValue, b as SqlValue);
		}
		if (args.length === 0) return () => 0; // count(*) — nothing to distinguish
		const argComparators = args.map(arg => argComparator(arg, ctx));
		return (a, b) => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];
			for (let i = 0; i < argComparators.length; i++) {
				const cmp = argComparators[i](arrA[i], arrB[i]);
				if (cmp !== 0) return cmp;
			}
			return 0;
		};
	});
}

/**
 * Per-aggregate: may `coerceForAggregate` be skipped for this call site? Skipped when
 * the aggregate never coerces anyway, when every argument is already numeric, or when
 * every argument type carries semantic ordering (TIMESPAN/JSON) — the numeric-string
 * conversion must never run ahead of a type-aware comparator.
 */
export function computeAggregateSkipCoercion(aggregates: readonly AggregateExpr[]): boolean[] {
	return aggregates.map(agg => {
		const funcNode = agg.expression;
		if (!(funcNode instanceof AggregateFunctionCallNode)) return false;
		const funcName = (funcNode.functionName || '').toUpperCase();
		// COUNT, GROUP_CONCAT and JSON_* never coerce their arguments.
		if (funcName === 'COUNT' || funcName === 'GROUP_CONCAT' || funcName.startsWith('JSON_')) return false;
		const args = funcNode.args || [];
		return args.length > 0 && (
			args.every(arg => arg.getType().logicalType.isNumeric)
			|| args.every(arg => hasSemanticOrdering(arg.getType().logicalType as LogicalType))
		);
	});
}
