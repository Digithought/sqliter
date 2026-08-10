import type { EnvelopeScanNode } from '../../planner/nodes/envelope-scan-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createValidatedInstruction } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Emit a scan over the shared-surrogate mutation envelope.
 *
 * The rows are materialized once by the `ViewMutation` emitter and stashed in
 * `rctx.tableContexts` under the node's descriptor; this scan just streams them.
 * Both sibling base inserts of one view insert run with the same `rctx`, so they
 * read the identical envelope rows — the shared key is minted once and threaded.
 */
export function emitEnvelopeScan(plan: EnvelopeScanNode, ctx: EmissionContext): Instruction {
	async function* run(rctx: RuntimeContext): AsyncIterable<Row> {
		const getter = rctx.tableContexts.get(plan.descriptor);
		if (!getter) {
			throw new QuereusError(
				'shared-surrogate mutation envelope not materialized in context before base op',
				StatusCode.INTERNAL,
			);
		}
		yield* getter();
	}

	return createValidatedInstruction([], asRun(run), ctx, `envelopeScan(${plan.attributes.length} cols)`);
}
