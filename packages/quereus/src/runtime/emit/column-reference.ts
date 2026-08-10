import type { ColumnReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { resolveAttribute } from '../context-helpers.js';
import { emitScalarOp, type ScalarOpSpec } from './scalar-op.js';

export function buildColumnReferenceSpec(plan: ColumnReferenceNode): ScalarOpSpec {
	function run(rctx: RuntimeContext): SqlValue {
		return resolveAttribute(rctx, plan.attributeId, plan.expression.name);
	}

	return {
		operands: [],
		run,
		note: `column(${plan.expression.name})`
	};
}

export function emitColumnReference(plan: ColumnReferenceNode, ctx: EmissionContext): Instruction {
	return emitScalarOp(buildColumnReferenceSpec(plan), ctx);
}
