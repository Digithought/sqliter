import type { LimitOffsetNode } from '../../planner/nodes/limit-offset.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { PlanNodeCharacteristics } from '../../planner/framework/characteristics.js';
import { type SqlValue, type Row, MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitLimitOffset(plan: LimitOffsetNode, ctx: EmissionContext): Instruction {
	// A LIMIT never truncates a writing source: a DML subtree under this node runs to
	// completion even once the limit is reached, matching the full-drain rule the scalar
	// / IN / EXISTS paths already apply (`emitExists`, `emitScalarSubquery`) and matching
	// PostgreSQL's data-modifying CTEs. Pure sources take the early-stop path instead.
	// One subtree test at emit time, not per row, so a LIMIT over a plain scan pays nothing.
	const drainAfterLimit = PlanNodeCharacteristics.subtreeHasSideEffects(plan.source);

	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...args: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {
		// Determine which args we have
		let limitFn: ((ctx: RuntimeContext) => MaybePromise<SqlValue>) | undefined;
		let offsetFn: ((ctx: RuntimeContext) => MaybePromise<SqlValue>) | undefined;

		let argIndex = 0;
		if (plan.limit) {
			limitFn = args[argIndex++];
		}
		if (plan.offset) {
			offsetFn = args[argIndex++];
		}

		// Evaluate limit and offset
		const limitValue = limitFn ? await limitFn(ctx) : null;
		const offsetValue = offsetFn ? await offsetFn(ctx) : null;

		// Convert to numbers, with defaults
		let limit = limitValue !== null ? Number(limitValue) : Infinity;
		let offset = offsetValue !== null ? Number(offsetValue) : 0;

		// Validate values
		if (limit < 0 || !Number.isFinite(limit)) {
			limit = 0; // No rows if limit is negative or invalid
		}
		if (offset < 0 || !Number.isFinite(offset)) {
			offset = 0; // No offset if negative or invalid
		}

		// A zero (or clamped-to-zero) limit over a pure source must not touch the source
		// at all — entering the loop would pull a row the query can never emit.
		if (limit <= 0 && !drainAfterLimit) {
			return;
		}

		let skipped = 0;
		let emitted = 0;

		for await (const row of sourceRows) {
			if (skipped < offset) {
				skipped++;
				continue;
			}

			if (emitted >= limit) {
				// Only reachable while draining a side-effecting source: swallow the row so
				// the write behind it still happens, but do not emit it.
				// NOTE: the swallowed rows still travel the whole pipeline between the write
				// and this node (projections, filters), so a `LIMIT 1` over a writing source
				// pays for every row, not one. Correct and unavoidable while the write must
				// complete; if an expensive projection over a large DML ever shows up as
				// slow, push the drain down to the mutation node instead of draining here.
				continue;
			}

			// Test the limit AFTER yielding, so the source is never asked for the row past
			// the last one emitted. Testing at the top of the loop costs one extra pull on
			// every limited query (see `ordinal-slice.ts` for the same shape).
			yield row;
			if (++emitted >= limit && !drainAfterLimit) {
				break;
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const limitInstruction = plan.limit ? emitCallFromPlan(plan.limit, ctx) : undefined;
	const offsetInstruction = plan.offset ? emitCallFromPlan(plan.offset, ctx) : undefined;

	const params: Instruction[] = [sourceInstruction];
	if (limitInstruction) params.push(limitInstruction);
	if (offsetInstruction) params.push(offsetInstruction);

	return {
		params,
		run: asRun(run),
		note: `limit_offset(${plan.limit ? 'LIMIT' : ''}${plan.limit && plan.offset ? ',' : ''}${plan.offset ? 'OFFSET' : ''})`
	};
}
