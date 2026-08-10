import type { Row } from '../../common/types.js';
import type { CTEReferenceNode } from '../../planner/nodes/cte-reference-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, createValidatedInstruction } from '../emitters.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { createLogger } from '../../common/logger.js';

const logger = createLogger('runtime:cte');

export function emitCTEReference(plan: CTEReferenceNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());
	const attrs = plan.getAttributes();
	const cteAlias = plan.alias || plan.source.cteName;

	logger(`Emitting CTE reference ${cteAlias} with attrs=[${attrs.map(a => a.id).join(',')}]`);

	// Standard CTE reference: Use normal instruction parameter approach
	async function* run(rctx: RuntimeContext, cteResult: AsyncIterable<Row>): AsyncIterable<Row> {
		logger(`Executing CTE reference ${cteAlias}`);
		const slot = createRowSlot(rctx, rowDescriptor);
		try {
			for await (const row of cteResult) {
				slot.set(row);
				yield row;
			}
		} finally {
			slot.close();
		}
	}

	// Emit the underlying CTE
	const cteInstruction = emitPlanNode(plan.source, ctx);

	return createValidatedInstruction(
		[cteInstruction],
		asRun(run),
		ctx,
		`cte_ref(${plan.source.cteName}${plan.alias ? ` AS ${plan.alias}` : ''})`
	);
}
