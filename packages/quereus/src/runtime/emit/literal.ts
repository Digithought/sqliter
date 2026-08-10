import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import type { LiteralNode } from "../../planner/nodes/scalar.js";
import { safeJsonStringify } from "../../util/serialization.js";
import type { EmissionContext } from "../emission-context.js";
import { emitScalarOp, type ScalarOpSpec } from "./scalar-op.js";

/**
 * Zero-operand spec yielding the literal's value, or `undefined` when the value is an
 * unresolved Promise.
 *
 * The constant-folding pass (planner/analysis/const-pass.ts) parks the result of an
 * *async* fold straight into `LiteralExpr.value` without awaiting it and lets the
 * scheduler resolve it, so a literal's body is `MaybePromise<SqlValue>` in general —
 * which is not a {@link ScalarOpSpec} body. Rather than widen the spec contract for
 * every scalar op, that rare arm has no spec and its consumers fall back: the emitter
 * below builds the Instruction itself, and a fusion consumer must decline to fuse.
 */
export function buildLiteralSpec(plan: LiteralNode): ScalarOpSpec | undefined {
	const value = plan.expression.value;
	if (value instanceof Promise) return undefined;

	return {
		operands: [],
		run: (_rctx: RuntimeContext) => value,
		note: literalNote(value)
	};
}

/** Note text shared by both arms — `safeJsonStringify` of a Promise spells `{}`, as before. */
function literalNote(value: SqlValue | Promise<SqlValue>): string {
	return `literal(${safeJsonStringify(value)})`;
}

export function emitLiteral(plan: LiteralNode, ctx: EmissionContext): Instruction {
	const spec = buildLiteralSpec(plan);
	if (spec) return emitScalarOp(spec, ctx);

	const deferred = plan.expression.value;
	return {
		params: [],
		run: (_rctx: RuntimeContext) => deferred,
		note: literalNote(deferred)
	};
}
