import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type MaybePromise, type SqlValue } from '../../common/types.js';
import { REPR_STRICT } from '../strict-flags.js';
import { assertConformsToType } from '../strict-representation.js';
import type { EmissionContext } from '../emission-context.js';
import type { ScalarFunctionSchema } from '../../schema/function.js';
import { isScalarFunctionSchema } from '../../schema/function.js';

/**
 * The per-call body of a scalar function call: its emit-time arity assert, its
 * implementation-error wrapping (carrying the call's source location) and its
 * `REPR_STRICT` return-type check, all resolved once here rather than per row.
 *
 * Two consumers read this, exactly as {@link import('./scalar-op.js').ScalarOpSpec} has
 * two: {@link emitScalarFunctionCallDefault} hands it to the scheduler as an
 * `Instruction.run`, and the scalar-fusion compiler (`runtime/scalar-fusion.ts`)
 * composes it directly into a fused closure. Keeping one copy is what stops a fused
 * call and an instruction call from disagreeing on error text or evaluation counts.
 *
 * The return type is `MaybePromise<SqlValue>` because a registered implementation may
 * be async — the scheduler resolves that, while fusion admits only bodies it has
 * *proven* synchronous and guards the remainder. The body is variadic (a `ScalarFunc`
 * is `(...args: SqlValue[])`), which is why it stays off `ScalarOpSpec`, whose
 * `assertSpecArity` requires one declared parameter per operand.
 *
 * Assumes `plan.functionSchema` has already been validated as a scalar function schema
 * by the caller (the entry point {@link emitScalarFunctionCall} checks it before
 * dispatching here directly or via a `customEmitter`'s `defaultEmit`; the fusion arm
 * declines when the check fails and lets the unfused path report it) — this function
 * does not repeat the check.
 */
export function buildScalarFunctionRun(
	plan: ScalarFunctionCallNode,
): (rctx: RuntimeContext, ...args: SqlValue[]) => MaybePromise<SqlValue> {
	const functionName = plan.expression.name.toLowerCase();
	const scalarFunction = plan.functionSchema as ScalarFunctionSchema;

	// Arity is a plan-time fact: the planner resolved this schema by arity, and both
	// consumers evaluate exactly `plan.operands` — so a mismatch here can only be an
	// emitter bug, not a per-call condition. Assert once at emit time instead of
	// re-checking every row.
	if (scalarFunction.numArgs >= 0 && plan.operands.length !== scalarFunction.numArgs) {
		throw new QuereusError(`Internal error: function ${functionName} plan has ${plan.operands.length} operands, expected ${scalarFunction.numArgs}`, StatusCode.INTERNAL);
	}

	// QUEREUS_REPR_STRICT seam: the value a function RETURNS, checked against its
	// schema's declared return type. A UDF's output is one of the two boundaries the
	// engine deliberately does not coerce (docs/types.md § Physical representation), so
	// this is where a drifting implementation is caught. Resolved only when the flag is
	// on — a normal emit does no type lookup for it.
	const reprReturnType = REPR_STRICT ? scalarFunction.returnType.logicalType : undefined;
	const reprWhere = REPR_STRICT
		? `the return value of function ${functionName}(${plan.operands.length})`
		: '';

	return function run(_rctx: RuntimeContext, ...args: Array<SqlValue>): MaybePromise<SqlValue> {
		let result: MaybePromise<SqlValue>;
		try {
			result = scalarFunction.implementation(...args);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(`Function ${functionName} failed: ${message}`, StatusCode.ERROR, error instanceof Error ? error : undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
		}
		// Checked OUTSIDE the try on purpose: inside, a representation violation would be
		// re-reported as "Function <name> failed", hiding the seam its message names.
		if (REPR_STRICT) {
			if (result instanceof Promise) {
				return result.then(value => {
					assertConformsToType(value, reprReturnType!, reprWhere);
					return value;
				});
			}
			assertConformsToType(result, reprReturnType!, reprWhere);
		}
		return result;
	};
}

/**
 * Default emission logic for scalar function calls.
 * This is exported so custom emitters can call it if needed.
 *
 * A thin wrapper over {@link buildScalarFunctionRun}: it emits one instruction param
 * per operand and hands the shared body to the scheduler.
 */
export function emitScalarFunctionCallDefault(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const run = buildScalarFunctionRun(plan);
	const operandExprs = plan.operands.map(operand => emitPlanNode(operand, ctx));

	return createValidatedInstruction(
		operandExprs,
		asRun(run),
		ctx,
		`${plan.expression.name}(${plan.operands.length})`
	);
}

/**
 * Main emitter for scalar function calls.
 * Checks if the function has a custom emitter and uses it, otherwise uses default logic.
 */
export function emitScalarFunctionCall(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionSchema = plan.functionSchema;

	// Validate that it's a scalar function
	if (!isScalarFunctionSchema(functionSchema)) {
		const functionName = plan.expression.name.toLowerCase();
		throw new QuereusError(`Function ${functionName} is not a scalar function`, StatusCode.ERROR);
	}

	// Check if function has a custom emitter
	if (functionSchema.customEmitter) {
		return functionSchema.customEmitter(plan, ctx, emitScalarFunctionCallDefault);
	}

	// Use default emission logic
	return emitScalarFunctionCallDefault(plan, ctx);
}
