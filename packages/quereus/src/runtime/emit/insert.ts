import type { InsertNode } from '../../planner/nodes/insert-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowCoercion } from '../../types/validation.js';

export function emitInsert(plan: InsertNode, ctx: EmissionContext): Instruction {
	// INSERT node only handles data transformations and passes flat rows through.
	// The actual database insert operations are handled by DmlExecutorNode.
	const tableSchema = plan.table.tableSchema;
	const colCount = tableSchema.columns.length;

	// Convert each cell to its declared column type HERE — the top of the DML
	// pipeline — driven by the source expressions' static types, so constraint
	// checking and the storage layer (which is told `preCoerced`) both see the
	// declared form exactly once. The source is already projected into full
	// table-column order (buildExpandedSource), so source attributes align
	// positionally with table columns. A cell whose source type already IS the
	// column's type (e.g. `insert into b select j from a` for a JSON column) is
	// left alone — provided the value in hand also inhabits that type, since the
	// source's announcement is an inference, not a guarantee. See buildRowCoercion.
	//
	// NOTE: on a non-fast-path insert the row-expansion projection has already converted
	// each constrained cell, so this pass usually degrades to a second conformance probe
	// (one storage-class check per cell). Deliberate and not skippable on the strength of
	// the projection's announcement, for the reason above. If cell-conversion probes ever
	// show up in a profile, the fix is a provenance flag saying a cell was converted by a
	// WriteCoercionNode in this same plan — not dropping either pass.
	const sourceAttrs = plan.source.getAttributes();
	const coerceNewRow = buildRowCoercion(
		tableSchema.columns.map((_, i) => sourceAttrs[i]?.type.logicalType),
		tableSchema.columns,
	);

	async function* run(_ctx: RuntimeContext, sourceValue: AsyncIterable<Row>): AsyncIterable<Row> {
		for await (const sourceRow of sourceValue) {
			// Convert source row to flat OLD/NEW format
			// For INSERT: OLD values are all NULL, NEW values are from source
			const flatRow: Row = new Array(colCount * 2);

			// Fill OLD section with NULLs (indices 0..n-1)
			for (let i = 0; i < colCount; i++) {
				flatRow[i] = null;
			}

			// Fill NEW section (indices n..2n-1) with the source values, converted
			// to declared column types where the static source type requires it.
			const newRow = coerceNewRow ? coerceNewRow(sourceRow) : sourceRow;
			for (let colIdx = 0; colIdx < colCount; colIdx++) {
				flatRow[colCount + colIdx] = newRow[colIdx];
			}

			yield flatRow;
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `insertPrep(${plan.table.tableSchema.name})`
	};
}
