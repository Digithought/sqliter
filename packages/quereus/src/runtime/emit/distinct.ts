import type { DistinctNode } from '../../planner/nodes/distinct-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createSemanticRowComparator, BINARY_COLLATION } from '../../util/comparison.js';
import type { LogicalType } from '../../types/logical-type.js';
import { BTree } from 'inheritree';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitDistinct(plan: DistinctNode, ctx: EmissionContext): Instruction {
	// Create row descriptor for output attributes (same as source since DISTINCT preserves attributes)
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Pre-resolve the row-identity comparator (safe for mixed-type rows). Columns whose
	// declared logical type has semantic ordering (TIMESPAN, JSON) compare through the
	// type's compare so DISTINCT identity agrees with `=` (TIMESPAN 'PT1H' ≡ 'PT60M'
	// collapses to one row); all other columns keep storage-class + collation identity.
	const attributes = plan.getAttributes();
	const collationRowComparator = createSemanticRowComparator(
		attributes.map(attr => attr.type.logicalType as LogicalType),
		attributes.map(attr => attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION)
	);

	async function* run(rctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
		// Create BTree to efficiently track distinct rows using pre-resolved typed comparator
		const distinctTree = new BTree<Row, Row>(
			(row: Row) => row,
			collationRowComparator
		);

		const outputSlot = createRowSlot(rctx, outputRowDescriptor);
		try {
			for await (const sourceRow of source) {
				// Check if we've seen this row before using BTree lookup
				const newPath = distinctTree.insert(sourceRow);

				if (newPath.on) {
					// This is a new distinct row - set up context and yield it
					outputSlot.set(sourceRow);
					yield sourceRow;
				}
			}
		} finally {
			outputSlot.close();
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: 'distinct (btree-optimized)'
	};
}
