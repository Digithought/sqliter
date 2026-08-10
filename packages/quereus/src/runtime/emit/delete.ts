import type { DeleteNode } from '../../planner/nodes/delete-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitDelete(plan: DeleteNode, ctx: EmissionContext): Instruction {
	// Expand the N-column source row into a flat 2N OLD/NEW row so the downstream
	// ConstraintCheckNode (which is wired after this node) sees the same row layout
	// it does for INSERT/UPDATE. For DELETE the OLD section holds the actual values
	// being removed and the NEW section is all NULL.
	async function* run(_rctx: RuntimeContext, sourceRows: AsyncIterable<Row>): AsyncIterable<Row> {
		const tableSchema = plan.table.tableSchema;
		const colCount = tableSchema.columns.length;

		for await (const sourceRow of sourceRows) {
			const flatRow: Row = new Array(colCount * 2);
			for (let i = 0; i < colCount; i++) {
				flatRow[i] = sourceRow[i] ?? null;
			}
			for (let i = 0; i < colCount; i++) {
				flatRow[colCount + i] = null;
			}
			yield flatRow;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `deletePrep(${plan.table.tableSchema.name})`
	};
}
