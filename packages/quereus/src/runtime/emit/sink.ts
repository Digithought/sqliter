import type { SinkNode } from '../../planner/nodes/sink-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';

export function emitSink(plan: SinkNode, ctx: EmissionContext): Instruction {
	async function run(ctx: RuntimeContext, sourceRows: AsyncIterable<Row>): Promise<number> {
		let rowCount = 0;

		// Consume all rows from the source to trigger side effects
		for await (const _row of sourceRows) {
			++rowCount;
		}

		// Return the count
		return rowCount;
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `sink(${plan.operation})`
	};
}
