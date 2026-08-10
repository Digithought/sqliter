import { StatusCode, type SqlValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { ScalarPlanNode } from '../../planner/nodes/plan-node.js';
import { emitPlanNode } from '../emitters.js';
import type { EmissionContext } from '../emission-context.js';

/**
 * The synchronous body of one scalar operation: it receives the runtime context plus
 * one already-evaluated value per declared operand, and returns a plain value.
 *
 * A fixed-arity body (`(ctx, v1: SqlValue, v2: SqlValue) => SqlValue`) assigns to this
 * rest signature directly — no `asRun`-style cast is needed, and every declared param
 * and the return stay checked against `SqlValue`.
 *
 * What a rest signature cannot check is that the body's arity matches `operands.length`
 * — a spec declaring two operands with a body taking one compiles, and the extra value
 * is silently dropped at runtime. `buildLikeOpSpec` varies both together between its two
 * paths, so the pairing is not statically detectable in general; {@link assertSpecArity}
 * checks it at emit time instead.
 *
 * Deliberately NOT widened to `OutputValue`. A spec body that could return a Promise
 * would be unusable by the fusion consumer described on {@link ScalarOpSpec}, so an
 * emitter whose body is genuinely async keeps building its own `Instruction` instead
 * of being forced through here.
 */
export type ScalarOpRun = (ctx: RuntimeContext, ...args: SqlValue[]) => SqlValue;

/**
 * Emit-time description of one scalar node's evaluation: the operand plan nodes whose
 * values it consumes, and the synchronous body that combines them.
 *
 * Two consumers read this. {@link emitScalarOp} emits each operand as an `Instruction`
 * param and hands the body to the scheduler as the instruction's `run` — today's
 * behavior. The scalar-fusion compiler instead composes each operand's own fused
 * closure into a direct call, with no scheduler and no per-row allocation. Both must
 * agree exactly, which is why the body lives here and not inside either one.
 *
 * `operands` is the list that becomes `Instruction.params` — NOT the plan node's
 * children. `buildLikeOpSpec`'s constant-pattern fast path bakes its right operand into the
 * closure and declares one operand; the spec describes what is actually evaluated.
 */
export interface ScalarOpSpec {
	readonly operands: readonly ScalarPlanNode[];
	readonly run: ScalarOpRun;
	readonly note: string;
}

/**
 * Emit-time guard that a spec's body takes exactly one parameter per declared operand,
 * plus the leading context. A mismatch is an emitter bug, not a per-row condition, and
 * it is otherwise silent: the scheduler spreads `params.length` args into a body that
 * ignores the tail, and a fused call would drop the same values.
 *
 * NOTE: a body with a rest signature (`(ctx, ...args)`) or a defaulted parameter reports
 * a `Function.length` that stops short, so it trips this. No spec is variadic today —
 * `buildScalarFunctionRun` (emit/scalar-function.ts), the one variadic scalar body,
 * deliberately stays off `ScalarOpSpec` and is composed by the fusion compiler without
 * this guard. A future variadic spec needs an explicit opt-out here, not a weakened
 * check for everyone.
 *
 * Exported for the scalar-fusion compiler (runtime/scalar-fusion.ts), which composes
 * spec bodies without going through {@link emitScalarOp} and needs the same guard.
 */
export function assertSpecArity(spec: ScalarOpSpec): void {
	const expected = spec.operands.length + 1;
	if (spec.run.length !== expected) {
		throw new QuereusError(
			`Internal error: scalar op '${spec.note}' declares ${spec.operands.length} operand(s) `
			+ `but its body takes ${spec.run.length - 1}`,
			StatusCode.INTERNAL);
	}
}

/** Emit a spec as the `Instruction` its emitter returned before this factoring. */
export function emitScalarOp(spec: ScalarOpSpec, ctx: EmissionContext): Instruction {
	assertSpecArity(spec);
	return {
		params: spec.operands.map(operand => emitPlanNode(operand, ctx)),
		run: asRun(spec.run),
		note: spec.note,
	};
}
