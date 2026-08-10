import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import type { ScalarPlanNode } from '../../planner/nodes/plan-node.js';
import type { AggregateArgBinding, AggregateFunctionSchema } from '../../schema/function.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { bindAggregateSchema } from '../../func/registration.js';
import { createTypedComparator, hasSemanticOrdering } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { StatusCode, type SqlValue, type MaybePromise } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { aggregateCoercesArguments, coerceAggregateValue } from '../../util/coercion.js';
import { emitCallFromPlan } from '../emitters.js';
import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext } from '../types.js';

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
 *
 * The returned `schemas` are already narrowed to {@link AggregateFunctionSchema} (the
 * `isAggregateFunctionSchema` check above throws INTERNAL on mismatch) and `argCounts`
 * captures each call site's argument count — row loops need neither an
 * `instanceof AggregateFunctionCallNode` re-check nor a `isAggregateFunctionSchema`
 * re-check to use `stepFunction` / `finalizeFunction` or to size their argument loop.
 */
export function bindAggregateSchemas(
	aggregates: readonly AggregateExpr[],
	ctx: EmissionContext,
): { schemas: AggregateFunctionSchema[]; distinctFlags: boolean[]; argCounts: number[] } {
	const schemas: AggregateFunctionSchema[] = [];
	const distinctFlags: boolean[] = [];
	const argCounts: number[] = [];
	for (const agg of aggregates) {
		const funcNode = requireAggregateCall(agg);
		const funcSchema = funcNode.functionSchema;
		if (!isAggregateFunctionSchema(funcSchema)) {
			quereusError(
				`Function ${funcNode.functionName || 'unknown'} is not an aggregate function`,
				StatusCode.INTERNAL
			);
		}
		const args = funcNode.args || [];
		schemas.push(bindAggregateSchema(funcSchema, args.map(arg => argComparisonContext(arg, ctx))));
		distinctFlags.push(funcNode.isDistinct);
		argCounts.push(args.length);
	}
	return { schemas, distinctFlags, argCounts };
}

/**
 * Emit one call instruction per aggregate argument, flattened across the aggregate list
 * in declaration order — the order both emitters' row loops slice back out of
 * `groupByAndAggregateArgs` using `argCounts` from {@link bindAggregateSchemas}.
 */
export function emitAggregateArgInstructions(
	aggregates: readonly AggregateExpr[],
	ctx: EmissionContext,
): Instruction[] {
	const instructions: Instruction[] = [];
	for (const agg of aggregates) {
		const funcNode = requireAggregateCall(agg);
		for (const arg of funcNode.args || []) {
			if (!arg) {
				quereusError(
					`Aggregate argument is undefined for function ${funcNode.functionName}`,
					StatusCode.INTERNAL
				);
			}
			instructions.push(emitCallFromPlan(arg, ctx));
		}
	}
	return instructions;
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
 * Per-aggregate value transform, replacing a per-row `coerceForAggregate(value,
 * functionName)` call with a decision made once at emit time. `undefined` means the call
 * site never coerces — the aggregate ignores coercion (COUNT, GROUP_CONCAT, JSON_*, per
 * {@link aggregateCoercesArguments}), every argument is already numeric, or every
 * argument type carries semantic ordering (TIMESPAN/JSON) where the numeric-string
 * conversion must never run ahead of a type-aware comparator. Otherwise the transform is
 * {@link coerceAggregateValue} — the same function `coerceForAggregate` calls once its
 * own routing agrees, so the two paths cannot drift.
 */
export function computeAggregateValueTransforms(
	aggregates: readonly AggregateExpr[],
): Array<((value: SqlValue) => SqlValue) | undefined> {
	return aggregates.map(agg => {
		const funcNode = requireAggregateCall(agg);
		if (!aggregateCoercesArguments(funcNode.functionName || '')) return undefined;
		const args = funcNode.args || [];
		const skip = args.length > 0 && (
			args.every(arg => arg.getType().logicalType.isNumeric)
			|| args.every(arg => hasSemanticOrdering(arg.getType().logicalType as LogicalType))
		);
		return skip ? undefined : coerceAggregateValue;
	});
}

/** One argument/key evaluator: a scalar sub-program bound to a row context. */
type ValueEvaluator = (ctx: RuntimeContext) => MaybePromise<SqlValue>;

/**
 * Evaluate N argument-evaluator closures against the same row context, applying an
 * optional per-value transform, without paying a microtask hop when every closure
 * resolves synchronously (the common case — see `resolveMaybe`, runtime/async-util.ts).
 * Shared by the stream/hash aggregate step loops (grouped and ungrouped) and by GROUP BY
 * key evaluation.
 *
 * Evaluation stays strictly sequential: each closure runs only after the previous one
 * has settled. Sibling scalar sub-programs share one {@link RuntimeContext} — row slots,
 * scan connections and the once-per-execution memo all live on it — and the only
 * supported way to run sub-programs concurrently is against forked contexts
 * (`ParallelDriver.fork`, runtime/parallel-driver.ts). So this must not start argument
 * `j+1` while `j` is still pending; the saving here is the microtask hop, not overlap.
 */
export function evalArgsSync(
	rctx: RuntimeContext,
	fns: readonly ValueEvaluator[],
	transform?: (value: SqlValue) => SqlValue,
): MaybePromise<SqlValue[]> {
	const results = new Array<SqlValue>(fns.length);
	for (let j = 0; j < fns.length; j++) {
		const raw = fns[j](rctx);
		if (raw instanceof Promise) return evalArgsFrom(rctx, fns, transform, results, j, raw);
		results[j] = transform ? transform(raw) : raw;
	}
	return results;
}

/** Async tail of {@link evalArgsSync}: awaits the first pending argument, then the rest in order. */
async function evalArgsFrom(
	rctx: RuntimeContext,
	fns: readonly ValueEvaluator[],
	transform: ((value: SqlValue) => SqlValue) | undefined,
	results: SqlValue[],
	pendingIndex: number,
	pending: Promise<SqlValue>,
): Promise<SqlValue[]> {
	const first = await pending;
	results[pendingIndex] = transform ? transform(first) : first;
	for (let j = pendingIndex + 1; j < fns.length; j++) {
		const raw = await fns[j](rctx);
		results[j] = transform ? transform(raw) : raw;
	}
	return results;
}
