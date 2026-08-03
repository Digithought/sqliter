import type { CTENode } from '../../planner/nodes/cte-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';

export function emitCTE(plan: CTENode, ctx: EmissionContext): Instruction {
	// Emit the underlying query
	const queryInstruction = emitPlanNode(plan.source, ctx);

	async function* run(rctx: RuntimeContext, queryResult: AsyncIterable<Row>): AsyncIterable<Row> {
		if (!plan.materialize) {
			// Streaming path: single-reference, un-hinted (or NOT MATERIALIZED)
			// CTE — pass rows through so early exit (e.g. LIMIT) never drains
			// the source.
			yield* queryResult;
			return;
		}

		// Shared materialization: every reference to this CTE shares one
		// per-execution buffer keyed by the CTE's stable `tableDescriptor`.
		// NOT the plan id: references usually point at one CTENode instance, but
		// the optimizer may split it into several (the constant-folding pass
		// rebuilds a two-parent node once per parent path), and each copy would
		// then own a private buffer — re-driving the source, which for a
		// data-modifying body means writing twice. The descriptor is threaded
		// through every rebuild, so all copies agree on the key. Mirrors
		// emitRecursiveCTE. Each reference emits its own copy of the source
		// subtree; only the buffer owner ever iterates one.
		const buffers = (rctx.cteMaterializations ??= new Map<typeof plan.tableDescriptor, Promise<Row[]>>());
		let bufferPromise = buffers.get(plan.tableDescriptor);
		if (!bufferPromise) {
			// First reference to run owns the single source drive. Create and
			// store the promise SYNCHRONOUSLY (before any await) so a second
			// reference interleaving under a nested-loop join finds it and
			// awaits instead of driving its own source subtree.
			// NOTE: the drive runs detached — if every consumer is torn down early
			// (e.g. LIMIT above the join), the drain still runs to completion in
			// the background. Bounded by the CTE's row count; if a materialized
			// CTE source ever becomes expensive enough for abandoned drains to
			// matter, thread the statement's abort signal into this loop.
			bufferPromise = (async () => {
				const rows: Row[] = [];
				for await (const row of queryResult) {
					rows.push([...row] as Row);
				}
				return rows;
			})();
			// Pre-attach a no-op rejection handler: if the drive fails after every
			// awaiting reference has detached (early teardown), the stored promise
			// would otherwise surface an unhandled rejection. References that are
			// still awaiting observe the rejection through their own await.
			bufferPromise.catch(() => { /* observed by awaiting references */ });
			buffers.set(plan.tableDescriptor, bufferPromise);
		}

		const rows = await bufferPromise;
		for (const row of rows) {
			// Copy per consumer so a downstream mutator cannot corrupt another
			// reference's (or a replay's) view of the buffer.
			yield [...row] as Row;
		}
	}

	return {
		params: [queryInstruction],
		run: asRun(run),
		note: `cte(${plan.cteName}${plan.materialize ? ', materialized' : ''})`
	};
}
