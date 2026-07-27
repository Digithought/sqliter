import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { castFallback } from '../../types/cast-semantics.js';

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	// The node's own resolved target type — never re-resolve the name here, or the
	// plan can advertise a type the emitter does not produce.
	const logicalType = plan.getType().logicalType;

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		if (operandValue === null) return null;

		if (logicalType.parse) {
			try {
				return logicalType.parse(operandValue);
			} catch {
				// CAST failures in SQL return 0 for numeric targets, '' for text, etc.
				// This matches SQLite's lenient CAST behavior.
				return castFallback(operandValue, logicalType);
			}
		}

		// NOTE: a type with no `parse` defines no conversion, so the operand passes
		// through while the cast still advertises the target type — the very shape
		// castFallback exists to prevent. Unreachable today: NULL is the only builtin
		// without `parse`, and the parser rejects it as a CAST target. If a plugin
		// ever registers a parse-less type, validate here too.
		return operandValue;
	}

	return {
		params: [emitPlanNode(plan.operand, ctx)],
		run: asRun(run),
		note: `cast(${plan.expression.targetType})`
	};
}
