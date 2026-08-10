import type { BlockNode } from '../../planner/nodes/block.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { RuntimeValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';

export function emitBlock(plan: BlockNode, ctx: EmissionContext): Instruction {
	// For blocks, our result is the last statement that produces a result relation.
	// A Sink is always void. A ViewMutation is void UNLESS it carries RETURNING — a
	// RETURNING-through-view mutation is relational (its rows are the view-projected
	// post-mutation image), so it IS eligible as the block result.
	const valueIndex = plan.statements.findLastIndex(stmt => {
		if (stmt.nodeType === PlanNodeType.Sink) return false;
		if (stmt.nodeType === PlanNodeType.ViewMutation) return stmt.getType().typeClass === 'relation';
		return true;
	});

	async function run(ctx: RuntimeContext, ...args: RuntimeValue[]): Promise<RuntimeValue> {
		return valueIndex === -1 ? null : args[valueIndex];
	}

	const statements = plan.statements.map(stmt => emitPlanNode(stmt, ctx));

	return {
		params: statements,
		run: asRun(run),
		note: `block(${plan.statements.length} stmts, result idx: ${valueIndex})`
	};
}
