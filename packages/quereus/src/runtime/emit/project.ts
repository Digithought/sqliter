import type { ProjectNode } from '../../planner/nodes/project-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row } from '../../common/types.js';
import { type OutputValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitProject(plan: ProjectNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const projectionFuncs = plan.projections.map((projection) => {
		return emitCallFromPlan(projection.node, ctx);
	});

	// Row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>, ...projectionFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// The winner for any attribute IDs shared between the output and source
		// descriptors is whichever context called `context.set` LAST — the
		// `attributeIndex` is last-`set`-wins, not insertion-order-newest-wins.
		// In practice the source's *child* creates and `set`s its own slot for
		// those IDs on first pull — after both slots here — so the child wins and
		// projection evaluation reads the current source row, never the previous
		// output row. We don't re-promote either slot per row, so we never shadow
		// that child (contrast emit/window.ts, which does re-promote and must
		// `demote()` before each pull). See the "source-attr contexts and child
		// pulls" invariant in docs/runtime.md.
		const outputSlot = createRowSlot(rctx, outputRowDescriptor);
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of source) {
				// Set source context for projection evaluation
				sourceSlot.set(sourceRow);
				const outputs: OutputValue[] = [];
				for (const fn of projectionFunctions) {
					// Resolve each column without a per-column microtask hop: `await`
					// only when the sub-program is genuinely a promise (rare). See
					// resolveMaybe in runtime/async-util.ts for the rationale.
					const value = fn(rctx);
					outputs.push(value instanceof Promise ? await value : value);
				}
				const outputRow = outputs as Row;

				// Set output context for downstream column resolution
				outputSlot.set(outputRow);
				yield outputRow;
			}
		} finally {
			sourceSlot.close();
			outputSlot.close();
		}
	}

	return {
		params: [sourceInstruction, ...projectionFuncs],
		run: asRun(run),
		note: `project(${plan.projections.length} cols)`
	};
}
