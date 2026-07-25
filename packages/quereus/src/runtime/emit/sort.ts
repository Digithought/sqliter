import type { SortNode } from '../../planner/nodes/sort.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createTypedOrderByComparator } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { withAsyncRowContext } from '../context-helpers.js';

export function emitSort(plan: SortNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Emit sort key instructions and pre-create optimized comparators with resolved collations
	const sortKeyInstructions = plan.sortKeys.map(key => emitCallFromPlan(key.expression, ctx));
	const sortKeyComparators = plan.sortKeys.map(key => {
		const keyType = key.expression.getType();
		const collationName = keyType.collationName || 'BINARY';
		const collationFunc = ctx.resolveCollation(collationName);
		// Semantic-ordering key types (TIMESPAN, JSON) rank by the type's compare;
		// everything else keeps the storage-class + collation fast path. Per-key
		// selection, so composite sorts mix typed and plain keys correctly.
		return createTypedOrderByComparator(keyType.logicalType as LogicalType, key.direction, key.nulls, collationFunc);
	});

	async function* run(
		ctx: RuntimeContext,
		source: AsyncIterable<Row>,
		...sortKeyFunctions: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {

		// Collect all rows with their sort key values
		const rowsWithKeys: Array<{ row: Row; keys: SqlValue[] }> = [];

		for await (const sourceRow of source) {
			const keys = await withAsyncRowContext(ctx, sourceRowDescriptor, () => sourceRow, async () => {
				// Evaluate sort key expressions
				const keyValues: SqlValue[] = [];
				for (const keyFunc of sortKeyFunctions) {
					const result = keyFunc(ctx);
					keyValues.push(await Promise.resolve(result));
				}
				return keyValues;
			});

			rowsWithKeys.push({ row: sourceRow, keys });
		}

		// Sort the collected rows using pre-created optimized comparators
		rowsWithKeys.sort((a, b) => {
			for (let i = 0; i < sortKeyComparators.length; i++) {
				const comparator = sortKeyComparators[i];
				const aValue = a.keys[i];
				const bValue = b.keys[i];

				const comparison = comparator(aValue, bValue);

				if (comparison !== 0) {
					return comparison;
				}
			}
			return 0;
		});

		// Yield sorted rows
		for (const { row } of rowsWithKeys) {
			yield row;
		}
	}

	return {
		params: [sourceInstruction, ...sortKeyInstructions],
		run: asRun(run),
		note: `sort(${plan.sortKeys.length} keys)`
	};
}
