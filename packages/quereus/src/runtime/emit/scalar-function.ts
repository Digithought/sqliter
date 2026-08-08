import type { ScalarFunctionCallNode } from '../../planner/nodes/function.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { ScalarFunctionSchema } from '../../schema/function.js';
import { isScalarFunctionSchema } from '../../schema/function.js';

/**
 * Default emission logic for scalar function calls.
 * This is exported so custom emitters can call it if needed.
 *
 * Assumes `plan.functionSchema` has already been validated as a scalar function
 * schema by the caller (the entry point {@link emitScalarFunctionCall} checks it
 * before dispatching here directly or via a `customEmitter`'s `defaultEmit`) —
 * this function does not repeat the check.
 */
export function emitScalarFunctionCallDefault(plan: ScalarFunctionCallNode, ctx: EmissionContext): Instruction {
	const functionName = plan.expression.name.toLowerCase();
	const scalarFunction = plan.functionSchema as ScalarFunctionSchema;

	// Arity is a plan-time fact: the planner resolved this schema by arity, and
	// `operandExprs` below is built from `plan.operands` — so a mismatch here can
	// only be an emitter bug, not a per-call condition. Assert once at emit time
	// instead of re-checking every row.
	if (scalarFunction.numArgs >= 0 && plan.operands.length !== scalarFunction.numArgs) {
		throw new QuereusError(`Internal error: function ${functionName} plan has ${plan.operands.length} operands, expected ${scalarFunction.numArgs}`, StatusCode.INTERNAL);
	}

	function run(_rctx: RuntimeContext, ...args: Array<SqlValue>): OutputValue {
		try {
			return scalarFunction.implementation(...args);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new QuereusError(`Function ${functionName} failed: ${message}`, StatusCode.ERROR, error instanceof Error ? error : undefined, plan.expression.loc?.start.line, plan.expression.loc?.start.column);
		}
	}

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
