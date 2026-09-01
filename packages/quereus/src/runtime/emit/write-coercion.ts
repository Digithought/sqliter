import type { WriteCoercionNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildCellCoercion } from '../../types/validation.js';
import { emitScalarOp, type ScalarOpSpec } from './scalar-op.js';

export function buildWriteCoercionSpec(plan: WriteCoercionNode): ScalarOpSpec {
	// Write-path semantics, decided once at emit time: convert (or guard, on an
	// identity-matched source) via buildCellCoercion — throws MISMATCH on failure,
	// never nulls like CAST's lenientCast. Undefined means provably nothing to do.
	const coerce = buildCellCoercion(
		plan.operand.getType().logicalType,
		plan.targetType.logicalType,
		plan.columnName,
	);

	function run(
		_runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): SqlValue {
		return coerce ? coerce(operandValue) : operandValue;
	}

	return {
		operands: [plan.operand],
		run,
		note: `writeCoerce(${plan.columnName})`
	};
}

export function emitWriteCoercion(plan: WriteCoercionNode, ctx: EmissionContext): Instruction {
	return emitScalarOp(buildWriteCoercionSpec(plan), ctx);
}
