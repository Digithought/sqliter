import type { UpdateNode } from '../../planner/nodes/update-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { buildRowDescriptor, composeOldNewRow } from '../../util/row-descriptor.js';
import { createRowSlot, withRowContext } from '../context-helpers.js';
import { buildRowCoercion } from '../../types/validation.js';

export function emitUpdate(plan: UpdateNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// Create row descriptor for the source rows (needed for assignment expression evaluation)
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Split assignments into regular and generated
	const regularIndices: number[] = [];
	const generatedIndices: number[] = [];
	plan.assignments.forEach((assign, i) => {
		if (assign.isGenerated) {
			generatedIndices.push(i);
		} else {
			regularIndices.push(i);
		}
	});
	// Pre-calculate assignment column indices
	const assignmentTargetIndices = plan.assignments.map(assign => {
		const colNameLower = assign.targetColumn.name.toLowerCase();
		const tableColIdx = tableSchema.columnIndexMap.get(colNameLower);
		if (tableColIdx === undefined) {
			throw new QuereusError(`Column '${assign.targetColumn.name}' not found in table '${tableSchema.name}' during emitUpdate.`, StatusCode.INTERNAL);
		}
		return tableColIdx;
	});

	// Emit assignment value expressions as callbacks
	const assignmentEvaluators = plan.assignments.map(assign =>
		emitCallFromPlan(assign.value, ctx)
	);

	// Convert the NEW row to declared column types HERE, driven by static types,
	// so constraint checking and the storage layer (told `preCoerced`) see the
	// declared form exactly once. An assigned column's source type is its
	// assignment expression's type; an unassigned column keeps whatever the
	// source relation reports at that position — for the ordinary target-table
	// scan that is the declared column type itself (identity match ⇒ leave
	// alone: the scanned value is already converted, and e.g. JSON conversion
	// is not repeatable — see buildRowCoercion). Never assume "unassigned ⇒
	// converted": a non-scan source (view decomposition, member insert) reports
	// its own types and converts by the same rule.
	//
	// Split across the two assignment phases so a generated column derives from
	// the value that will actually be STORED, not the raw assignment: phase 1
	// converts the regular assignments (and any unassigned cell whose source
	// type differs), phase 2 the generated cells. A generated column left in
	// place by phase 1 still holds its scanned value, which is already in
	// declared form.
	const sourceAttrs = plan.source.getAttributes();
	const regularCellTypes = tableSchema.columns.map((_, i) => sourceAttrs[i]?.type.logicalType);
	for (const i of regularIndices) {
		regularCellTypes[assignmentTargetIndices[i]] = plan.assignments[i].value.getType().logicalType;
	}
	const coerceRegular = buildRowCoercion(regularCellTypes, tableSchema.columns);

	// After phase 1 every non-generated cell is in declared form (identity ⇒
	// skip), so only the generated cells can still need converting.
	const generatedCellTypes = tableSchema.columns.map(column => column.logicalType);
	for (const i of generatedIndices) {
		generatedCellTypes[assignmentTargetIndices[i]] = plan.assignments[i].value.getType().logicalType;
	}
	const coerceGenerated = generatedIndices.length > 0
		? buildRowCoercion(generatedCellTypes, tableSchema.columns)
		: undefined;

	async function* run(rctx: RuntimeContext, sourceRowsIterable: AsyncIterable<Row>, ...assignmentEvaluators: Array<(ctx: RuntimeContext) => SqlValue | Promise<SqlValue>>): AsyncIterable<Row> {
		const slot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const sourceRow of sourceRowsIterable) {
				slot.set(sourceRow);

				// Phase 1: Evaluate regular (non-generated) assignment expressions.
				// Await to support async evaluators (e.g. scalar subqueries) — non-async
				// callbacks return values directly and `await` is a no-op for them.
				let updatedRow: Row = [...sourceRow]; // Copy the original row
				for (const i of regularIndices) {
					const value = await assignmentEvaluators[i](rctx) as SqlValue;
					updatedRow[assignmentTargetIndices[i]] = value;
				}
				if (coerceRegular) updatedRow = coerceRegular(updatedRow);

				// Phase 2: Evaluate generated column expressions against the updated row,
				// now holding the CONVERTED values of the regular assignments (a generated
				// column must derive from what is stored, not from the raw assignment).
				// Generated expressions are validated as deterministic (see
				// validateDeterministicGenerated in update.ts builder), so they cannot
				// contain scalar subqueries and always return synchronously.
				if (generatedIndices.length > 0) {
					withRowContext(rctx, sourceRowDescriptor, () => updatedRow, () => {
						for (const i of generatedIndices) {
							const value = assignmentEvaluators[i](rctx) as SqlValue;
							updatedRow[assignmentTargetIndices[i]] = value;
						}
					});
					if (coerceGenerated) updatedRow = coerceGenerated(updatedRow);
				}

				// Create flat row with OLD (source) and NEW (updated) values for constraint
				// checking. The NEW half is now fully in declared column types; OLD is the
				// scanned row, already in stored form.
				const flatRow = composeOldNewRow(sourceRow, updatedRow, tableSchema.columns.length);

				// Yield the flat row for constraint checking
				// NOTE: UpdateNode only transforms rows - it does NOT execute the actual update
				// The UpdateExecutorNode is responsible for calling vtab.update
				yield flatRow;
			}
		} finally {
			slot.close();
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...assignmentEvaluators],
		run: asRun(run),
		note: `transformUpdateRows(${plan.table.tableSchema.name}, ${plan.assignments.length} cols)`
	};
}
