import type { LimitOffsetNode } from '../../planner/nodes/limit-offset.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitLimitOffset(plan: LimitOffsetNode, ctx: EmissionContext): Instruction {
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

		// Skip offset rows
		let skipped = 0;
		let emitted = 0;

		for await (const row of sourceRows) {
			if (skipped < offset) {
				skipped++;
				continue;
			}

			if (emitted >= limit) {
				break;
			}

			yield row;
			emitted++;
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
