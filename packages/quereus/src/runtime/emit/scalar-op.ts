import type { SqlValue } from '../../common/types.js';
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
 * NOTE: what a rest signature cannot check is that the body's arity matches
 * `operands.length` — a spec that declares two operands and a body taking one compiles,
 * and the extra value is silently dropped at runtime. `emitLikeOp` deliberately varies
 * its arity between the two paths, so the mismatch is not statically detectable in
 * general. Today the eleven specs are short enough to eyeball; if the set grows or a
 * spec starts computing its operand list conditionally, add a runtime assert in
 * {@link emitScalarOp} comparing `spec.operands.length` to `spec.run.length`.
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
 * children. `emitLikeOp`'s constant-pattern fast path bakes its right operand into the
 * closure and declares one operand; the spec describes what is actually evaluated.
 */
export interface ScalarOpSpec {
	readonly operands: readonly ScalarPlanNode[];
	readonly run: ScalarOpRun;
	readonly note: string;
}

/** Emit a spec as the `Instruction` its emitter returned before this factoring. */
export function emitScalarOp(spec: ScalarOpSpec, ctx: EmissionContext): Instruction {
	return {
		params: spec.operands.map(operand => emitPlanNode(operand, ctx)),
		run: asRun(spec.run),
		note: spec.note,
	};
}
