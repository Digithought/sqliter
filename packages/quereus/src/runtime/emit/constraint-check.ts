import type { ConstraintCheckNode, NotNullDefaultPlan } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { StatusCode, type SqlValue, type OutputValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { withAsyncRowContext, createRowSlot } from '../context-helpers.js';
import { composeCombinedDescriptor } from '../descriptor-helpers.js';
import {
	buildConstraintMetadata,
	evaluateRowConstraints,
	type NotNullDefaultRuntime,
} from '../row-constraints.js';

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Use the pre-built flat row descriptor from the plan
	const flatRowDescriptor = plan.flatRowDescriptor;

	// Get mutation context from the plan (passed from DML builders)
	const mutationContextValues = plan.mutationContextValues;
	const contextAttributes = plan.contextAttributes;
	const contextDescriptor = plan.contextDescriptor;
	const stmtOR = plan.onConflict;

	// Emit mutation context value evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (mutationContextValues && contextAttributes) {
		for (const attr of contextAttributes) {
			const valueExpr = mutationContextValues.get(attr.name);
			if (!valueExpr) {
				// Invariant: the DML builders fill every declared context slot (a supplied
				// value expression, or a NULL literal for an omitted variable — see
				// planner/building/mutation-context.ts). Skipping one would shift every
				// later value out of alignment with contextDescriptor, so assert instead.
				throw new QuereusError(`Internal: no mutation context evaluator for '${attr.name}'`, StatusCode.INTERNAL);
			}
			contextEvaluatorInstructions.push(emitCallFromPlan(valueExpr, ctx));
		}
	}

	// Emit evaluator instructions for each pre-built constraint expression
	const checkEvaluators = plan.constraintChecks.map(check =>
		emitCallFromPlan(check.expression, ctx)
	);

	// Emit evaluators for NOT NULL DEFAULT substitution (used by REPLACE).
	const notNullDefaultPlans: ReadonlyArray<NotNullDefaultPlan> = plan.notNullDefaults ?? [];
	const notNullDefaultInstructions = notNullDefaultPlans.map(d => emitCallFromPlan(d.defaultNode, ctx));

	// Which substitutions need conversion — the emitters' static-type rule
	// applied to the DEFAULT expression (see NotNullDefaultRuntime.coerceColumn).
	const notNullDefaultCoercions = notNullDefaultPlans.map(d =>
		d.defaultNode.getType().logicalType !== tableSchema.columns[d.columnIndex].logicalType
			? tableSchema.columns[d.columnIndex]
			: undefined);

	const constraintMetadata = buildConstraintMetadata(
		plan.constraintChecks,
		tableSchema,
		flatRowDescriptor,
		contextDescriptor,
		checkEvaluators.map(instruction => instruction.run),
	);

	const scope = { operation: plan.operation, hasNewSection: Boolean(plan.newRowDescriptor) };

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>, ...evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		// Split: first contextEvaluatorInstructions are context evaluators, then constraint
		// evaluators, then NOT NULL DEFAULT evaluators.
		const numContextEvaluators = contextEvaluatorInstructions.length;
		const numConstraintEvaluators = constraintMetadata.length;

		let contextRow: Row | undefined;
		let contextSlot: ReturnType<typeof createRowSlot> | undefined;

		if (numContextEvaluators > 0 && contextDescriptor) {
			const contextEvalFunctions = evaluatorFunctions.slice(0, numContextEvaluators);

			contextRow = [];
			for (const contextEvaluator of contextEvalFunctions) {
				// Resolve without a per-row microtask hop: `await` only when the
				// sub-program is genuinely a promise. See runtime/async-util.ts.
				const raw = contextEvaluator(rctx);
				const value = (raw instanceof Promise ? await raw : raw) as SqlValue;
				contextRow.push(value);
			}

			contextSlot = createRowSlot(rctx, contextDescriptor);
			contextSlot.set(contextRow);
		}

		const constraintEvalFunctions = evaluatorFunctions.slice(
			numContextEvaluators,
			numContextEvaluators + numConstraintEvaluators,
		);
		const defaultEvalFunctions = evaluatorFunctions.slice(numContextEvaluators + numConstraintEvaluators);

		const defaultsRuntime: NotNullDefaultRuntime[] = notNullDefaultPlans.map((d, i) => ({
			columnIndex: d.columnIndex,
			evaluator: defaultEvalFunctions[i],
			coerceColumn: notNullDefaultCoercions[i],
		}));

		// Pre-compute the combined descriptor (constant across rows)
		// NOTE: once `contextRow` exists, the row getter below concatenates it onto every
		// visible row on each lookup. Mutation context attributes are now built from the
		// TABLE's declaration rather than the statement's `with context` clause
		// (planner/building/mutation-context.ts), so that concatenation applies to EVERY
		// write to a context-declaring table, not only the ones carrying an envelope.
		// Cheap at the declaration sizes seen so far; if a bulk envelope-less write into a
		// context-declaring table ever shows up as slow, hoist the concatenation to one
		// pre-sized array reused per row instead of spreading per lookup.
		const combinedDescriptor = contextDescriptor && contextRow
			? composeCombinedDescriptor(contextDescriptor, flatRowDescriptor)
			: flatRowDescriptor;

		try {
			for await (const inputRow of inputRows) {
				let flatRow = inputRow;

				// The row expressions see through `combinedDescriptor`. The getter is
				// called lazily per lookup, so evaluateRowConstraints can swap it mid-row:
				// after a REPLACE NOT NULL DEFAULT substitution, CHECK / FK must read
				// the row AS SUBSTITUTED. The row arrives already converted to declared
				// column types (the DML emitters convert the NEW section up front), so
				// no separate coerced view exists — the substituted row IS what flows
				// downstream.
				let visibleRow: Row = flatRow;

				const evaluation = await withAsyncRowContext(
					rctx,
					combinedDescriptor,
					() => contextRow ? [...contextRow, ...visibleRow] : visibleRow,
					() => evaluateRowConstraints(
						rctx,
						scope,
						tableSchema,
						flatRow,
						constraintMetadata,
						constraintEvalFunctions,
						stmtOR,
						defaultsRuntime,
						contextRow,
						row => { visibleRow = row; },
					),
				);

				if (evaluation.skip) continue;
				if (evaluation.replacedRow) {
					flatRow = evaluation.replacedRow;
				}

				yield flatRow;
			}
		} finally {
			if (contextSlot) {
				contextSlot.close();
			}
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...checkEvaluators, ...notNullDefaultInstructions],
		run: asRun(run),
		note: `constraintCheck(${plan.operation}, ${contextEvaluatorInstructions.length} ctx, ${plan.constraintChecks.length} checks, ${notNullDefaultInstructions.length} defaults)`
	};
}
