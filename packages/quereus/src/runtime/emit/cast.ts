import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { lenientCast } from '../../types/cast-semantics.js';

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	// The node's own resolved target type — never re-resolve the name here, or the
	// plan can advertise a type the emitter does not produce.
	const logicalType = plan.getType().logicalType;

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		// Shared with emitIn's membership coercion — see lenientCast for the
		// parse/fallback contract and the parse-less-type note.
		return lenientCast(operandValue, logicalType);
	}

	return {
		params: [emitPlanNode(plan.operand, ctx)],
		run: asRun(run),
		note: `cast(${plan.expression.targetType})`
	};
}
