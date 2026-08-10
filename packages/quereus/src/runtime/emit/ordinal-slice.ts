import type { OrdinalSliceNode } from '../../planner/nodes/ordinal-slice-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../planner/nodes/table-access-nodes.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitCallFromPlan } from '../emitters.js';
import { emitSeqScan } from './scan.js';
import type { EmissionContext } from '../emission-context.js';
import type { Row, SqlValue, MaybePromise } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

interface SliceBounds {
	offset: number;
	limit: number;
}

/** Coerce a SqlValue to a non-negative finite integer, clamping invalid input. */
function coerceCount(value: SqlValue, fallback: number): number {
	if (value === null || value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.trunc(n);
}

/**
 * Emit an OrdinalSlice node. The slice's source must be a physical access
 * leaf whose scan supports `FilterInfo.offset`/`FilterInfo.limit` (i.e.,
 * the access plan advertised `supportsOrdinalSeek`). The emitter forwards
 * the resolved offset/limit into the leaf's FilterInfo and then enforces
 * the row cap as a streaming guard so any module that ignores the
 * directive still produces correct results.
 */
export function emitOrdinalSlice(plan: OrdinalSliceNode, ctx: EmissionContext): Instruction {
	const leaf = plan.source;
	if (!(leaf instanceof SeqScanNode || leaf instanceof IndexScanNode || leaf instanceof IndexSeekNode)) {
		throw new QuereusError(
			`OrdinalSlice expects a physical access leaf (SeqScan/IndexScan/IndexSeek) as its source, got ${leaf.nodeType}`,
			StatusCode.INTERNAL,
		);
	}

	// Per-execution bounds, keyed by RuntimeContext so concurrent statements
	// don't collide. The slice's run() resolves offset/limit before iterating
	// the leaf; the leaf's FilterInfo override reads back the same entry.
	const boundsByCtx = new WeakMap<RuntimeContext, SliceBounds>();

	const offsetInstruction = plan.offsetExpr ? emitCallFromPlan(plan.offsetExpr, ctx) : undefined;
	const limitInstruction = plan.limitExpr ? emitCallFromPlan(plan.limitExpr, ctx) : undefined;

	const leafInstruction = emitSeqScan(leaf, ctx, (baseFilterInfo, runtimeCtx, _dynamicArgs) => {
		const bounds = boundsByCtx.get(runtimeCtx);
		if (!bounds) {
			// Slice's run() didn't fire before the leaf's iteration started — the
			// scheduler should always run the leaf as a child of the slice, so
			// this is an emit-time bug.
			throw new QuereusError(
				'OrdinalSlice leaf executed without slice bounds initialization',
				StatusCode.INTERNAL,
			);
		}
		const augmented = { ...baseFilterInfo };
		if (bounds.offset > 0) augmented.offset = bounds.offset;
		if (Number.isFinite(bounds.limit)) augmented.limit = bounds.limit;
		return augmented;
	});

	async function* run(
		runtimeCtx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...args: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {
		// Args order matches getChildren(): [offset?, limit?]
		let argIdx = 0;
		const offsetFn = plan.offsetExpr ? args[argIdx++] : undefined;
		const limitFn = plan.limitExpr ? args[argIdx++] : undefined;

		const offsetValue = offsetFn ? await offsetFn(runtimeCtx) : 0;
		const limitValue = limitFn ? await limitFn(runtimeCtx) : null;

		const bounds: SliceBounds = {
			offset: coerceCount(offsetValue, 0),
			limit: limitValue === null ? Infinity : coerceCount(limitValue, Infinity),
		};
		boundsByCtx.set(runtimeCtx, bounds);

		try {
			if (bounds.limit <= 0) return;

			// Streaming guard: enforce the row cap above the leaf so modules that
			// ignore the FilterInfo offset/limit directive remain correct. When
			// the leaf does honor them, this short-circuit costs nothing extra.
			let emitted = 0;
			for await (const row of sourceRows) {
				yield row;
				if (++emitted >= bounds.limit) break;
			}
		} finally {
			boundsByCtx.delete(runtimeCtx);
		}
	}

	const params: Instruction[] = [leafInstruction];
	if (offsetInstruction) params.push(offsetInstruction);
	if (limitInstruction) params.push(limitInstruction);

	return {
		params,
		run: asRun(run),
		note: `ordinal_slice(${plan.offsetExpr ? 'OFFSET' : ''}${plan.offsetExpr && plan.limitExpr ? ',' : ''}${plan.limitExpr ? 'LIMIT' : ''})`,
	};
}
