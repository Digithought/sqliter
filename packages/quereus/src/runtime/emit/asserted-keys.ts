import type { AssertedKeysNode } from '../../planner/nodes/asserted-keys-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Instruction } from '../types.js';

/**
 * Emitter for AssertedKeysNode - optimized away at runtime.
 *
 * AssertedKeysNode is a planning-time construct that contributes lens-asserted
 * declared-key FDs onto the inlined-view boundary. At runtime the rows are
 * bit-for-bit the source's (attribute IDs preserved), so we simply emit the
 * underlying source directly - mirroring emitAlias. Zero runtime cost.
 */
export function emitAssertedKeys(plan: AssertedKeysNode, ctx: EmissionContext): Instruction {
	return emitPlanNode(plan.source, ctx);
}
