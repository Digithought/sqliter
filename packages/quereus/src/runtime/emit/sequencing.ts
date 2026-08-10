import type { SequencingNode } from '../../planner/nodes/sequencing-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitSequencing(plan: SequencingNode, ctx: EmissionContext): Instruction {
	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
		let rowNumber = 1;

		for await (const sourceRow of source) {
			// Append row number to each row
			yield [...sourceRow, rowNumber++] as Row;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `sequencing(${plan.sequenceColumnName})`
	};
}
