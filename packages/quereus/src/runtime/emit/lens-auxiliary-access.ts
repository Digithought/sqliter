import type { LensAuxiliaryAccessNode } from '../../planner/nodes/lens-auxiliary-access-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Instruction } from '../types.js';

/**
 * Emitter for LensAuxiliaryAccessNode - optimized away at runtime.
 *
 * The node is a planning-time marker carrying routable auxiliary-access
 * advertisements to the read-path-selection rule (`rule-lens-auxiliary-access`).
 * When the rule routes, it replaces the marker with an auxiliary-seek ⋈
 * logical-key semi-join, so the marker never reaches emission. When no predicate
 * routes (the degrade case), the marker survives and is bit-for-bit its source
 * (attribute IDs preserved), so we emit the underlying source directly —
 * mirroring emitAlias / emitAssertedKeys. Zero runtime cost.
 */
export function emitLensAuxiliaryAccess(plan: LensAuxiliaryAccessNode, ctx: EmissionContext): Instruction {
	return emitPlanNode(plan.source, ctx);
}
