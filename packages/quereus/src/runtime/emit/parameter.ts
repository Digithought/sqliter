import type { ParameterReferenceNode } from '../../planner/nodes/reference.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitScalarOp, type ScalarOpSpec } from './scalar-op.js';

export function buildParameterSpec(plan: ParameterReferenceNode): ScalarOpSpec {
	// The throw stays inside the body: the binding is not known at emit time.
	function run(ctx: RuntimeContext): SqlValue {
		const identifier = plan.nameOrIndex; // This comes from the ParameterReferenceNode instance
		const params = ctx.params;

		if (typeof identifier === 'number') {
			// For ? (anonymous) parameters, identifier is a 1-based index.
			// boundArgs stores numeric keys directly (e.g., { 1: value, 2: value }).
			const key = identifier;
			if (!(key in params)) {
				throw new QuereusError(`Parameter index ${identifier} is out of bounds.`, StatusCode.RANGE);
			}
			return params[key];
		} else if (typeof identifier === 'string') {
			// For named parameters like :name.
			const key = identifier.startsWith(':') ? identifier.substring(1) : identifier;
			if (!(key in params)) {
				throw new QuereusError(`Parameter with name '${key}' not found.`, StatusCode.NOTFOUND);
			}
			return params[key];
		} else {
			// Should not happen given ParameterReferenceNode structure
			throw new QuereusError('Invalid parameter identifier type.', StatusCode.INTERNAL);
		}
	}

	return {
		operands: [],
		run,
		note: `param(${typeof plan.nameOrIndex === 'string' ? plan.nameOrIndex : '#' + plan.nameOrIndex})`
	};
}

export function emitParameterReference(plan: ParameterReferenceNode, ctx: EmissionContext): Instruction {
	return emitScalarOp(buildParameterSpec(plan), ctx);
}
