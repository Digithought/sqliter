import type { StreamAggregateNode } from '../../planner/nodes/stream-aggregate.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import type { PlanNode, RowDescriptor } from '../../planner/nodes/plan-node.js';
import { isRelationalNode } from '../../planner/nodes/plan-node.js';
import { createTypedComparator } from '../../util/comparison.js';
import { bindAggregateSchemas, buildDistinctComparators, computeAggregateValueTransforms, emitAggregateArgInstructions, evalArgsSync } from './aggregate-setup.js';
import type { LogicalType } from '../../types/logical-type.js';
import type { BTree } from 'inheritree';
import { createValueSet } from '../../util/value-set.js';
import { createLogger } from '../../common/logger.js';
import { logContextPush, logContextPop } from '../utils.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { AggValue, cloneInitialValue } from '../../func/registration.js';
import type { ContextInstaller } from '../context-helpers.js';

export const ctxLog = createLogger('runtime:context');

// Re-exported for the emitters that import it from here (hash-aggregate);
// the implementation lives with `AggValue` in func/registration.ts so the
// planner (scalar-agg decorrelation's plan-time empty-value computation) can
// share the exact runtime cloning path without a planner→runtime import.
export { cloneInitialValue };

/**
 * Find the source relation node that column references should use as their context key.
 * This traverses up the tree to find the original table scan or similar node.
 */
export function findSourceRelation(node: PlanNode): PlanNode {
	// Keep going up until we find a values node
	let current = node;
	while (current) {
		if (current.nodeType === 'Values' || current.nodeType === 'SingleRow') {
			return current;
		}
		// Get the first relational source
		const relations = current.getRelations();
		if (relations.length > 0) {
			current = relations[0];
		} else {
			break;
		}
	}
	return node; // Fallback to the original node
}

export function emitStreamAggregate(plan: StreamAggregateNode, ctx: EmissionContext): Instruction {
	// Find the actual source relation for column references
	const sourceRelation = findSourceRelation(plan.source);

	// Create row descriptors for context
	const sourceAttributes = plan.source.getAttributes();

	// Create separate descriptors for group yielding to avoid conflicts with source row processing
	const groupSourceRowDescriptor = buildRowDescriptor(sourceAttributes);
	const groupSourceRelationRowDescriptor = sourceRelation !== plan.source
		? buildRowDescriptor(isRelationalNode(sourceRelation) ? sourceRelation.getAttributes() : sourceAttributes)
		: groupSourceRowDescriptor;

	ctxLog('StreamAggregate setup: source=%s, sourceRelation=%s', plan.source.nodeType, sourceRelation.nodeType);
	ctxLog('Source attributes: %O', sourceAttributes.map(attr => `${attr.name}(#${attr.id})`));
	if (sourceRelation !== plan.source) {
		const sourceRelationAttributes = isRelationalNode(sourceRelation) ? sourceRelation.getAttributes() : sourceAttributes;
		ctxLog('Source relation attributes: %O', sourceRelationAttributes.map((attr) => `${attr.name}(#${attr.id})`));
	}

	// Best-effort installer label for QUEREUS_CONTEXT_STRICT diagnostics (identifies
	// this operator on the direct context.set()s below; detection ignores it).
	const installer: ContextInstaller = { nodeType: plan.nodeType, id: plan.id };

	// Create output row descriptor for the StreamAggregate's output
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Create scan row descriptor for source relation attributes (for Filter evaluation)
	const scanRowDescriptor = buildRowDescriptor(sourceAttributes);

	// CRITICAL FIX: Create a combined descriptor that includes BOTH output and source attributes
	// This allows correlated subqueries to access original table attributes
	const combinedRowDescriptor: RowDescriptor = {...outputRowDescriptor};
	sourceAttributes.forEach((attr, index) => {
		// Only add if not already present in output (avoid conflicts)
		if (combinedRowDescriptor[attr.id] === undefined) {
			combinedRowDescriptor[attr.id] = Object.keys(outputRowDescriptor).length + index;
		}
	});

	// Pre-resolve typed comparators for GROUP BY key comparison
	const groupKeyComparators = plan.groupBy.map(expr => {
		const exprType = expr.getType();
		const collationFunc = exprType.collationName ? ctx.resolveCollation(exprType.collationName) : undefined;
		return createTypedComparator(exprType.logicalType as LogicalType, collationFunc);
	});
	const groupKeyLen = groupKeyComparators.length;

	function compareGroupKeys(a: SqlValue[], b: SqlValue[]): number {
		for (let i = 0; i < groupKeyLen; i++) {
			const cmp = groupKeyComparators[i](a[i], b[i]);
			if (cmp !== 0) return cmp;
		}
		return 0;
	}

	const distinctComparators = buildDistinctComparators(plan.aggregates, ctx);
	const aggregateValueTransforms = computeAggregateValueTransforms(plan.aggregates);
	const { schemas: aggregateSchemas, distinctFlags: aggregateDistinctFlags, argCounts: aggregateArgCounts } =
		bindAggregateSchemas(plan.aggregates, ctx);

	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...groupByAndAggregateArgs: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {

		// Split the arguments: first N are GROUP BY expressions, rest are aggregate args
		const numGroupBy = plan.groupBy.length;
		const groupByFunctions = groupByAndAggregateArgs.slice(0, numGroupBy);

		// For aggregate arguments, we need to properly index them based on each aggregate's argument count
		let aggregateArgOffset = numGroupBy;
		const aggregateArgFunctions: Array<Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>> = [];

		for (const argCount of aggregateArgCounts) {
			aggregateArgFunctions.push(groupByAndAggregateArgs.slice(aggregateArgOffset, aggregateArgOffset + argCount));
			aggregateArgOffset += argCount;
		}

		// Handle the case with no GROUP BY - aggregate everything into a single group
		if (plan.groupBy.length === 0) {
			// Initialize accumulators for each aggregate
			const accumulators: SqlValue[] = aggregateSchemas.map(schema => cloneInitialValue(schema.initialValue));

			// For DISTINCT aggregates, track unique values using BTree with pre-resolved typed comparators
			const distinctTrees: (BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]> | null)[] = aggregateDistinctFlags.map((isDistinct, i) =>
				isDistinct ? createValueSet<SqlValue | SqlValue[]>(distinctComparators[i]) : null
			);

			// Track the last source row for representative row in combined descriptor
			let lastSourceRow: Row | null = null;

			// Process all rows
			for await (const row of sourceRows) {
				lastSourceRow = row;

				// Set the current row in the runtime context for Filter and aggregate evaluation
				ctx.context.set(scanRowDescriptor, () => row, installer);
				logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

				try {
					// For each aggregate, call its step function
					for (let i = 0; i < plan.aggregates.length; i++) {
						const isDistinct = aggregateDistinctFlags[i];

						// Evaluate the aggregate arguments in the context of the current row
						const argValuesMaybe = evalArgsSync(ctx, aggregateArgFunctions[i], aggregateValueTransforms[i]);
						const argValues = argValuesMaybe instanceof Promise ? await argValuesMaybe : argValuesMaybe;

						// Handle DISTINCT logic using BTree for proper SQL value comparison
						if (isDistinct) {
							const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
							const existingPath = distinctTrees[i]!.insert(distinctValue);
							if (!existingPath.on) {
								// Value already exists, skip this occurrence
								continue;
							}
						}

						// Call the step function
						accumulators[i] = aggregateSchemas[i].stepFunction(accumulators[i], ...argValues);
					}
				} finally {
					// Clean up scan context for this row
					logContextPop(scanRowDescriptor, 'scan-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}

			// Finalize and yield the result
			const aggregateRow: SqlValue[] = [];
			for (let i = 0; i < plan.aggregates.length; i++) {
				aggregateRow.push(aggregateSchemas[i].finalizeFunction(accumulators[i]));
			}

			// Build combined row with aggregate results + representative source row
			const fullRow = lastSourceRow ? [...aggregateRow, ...lastSourceRow] : aggregateRow;

			// Set up combined context for the result row (includes both output and source attributes)
			if (lastSourceRow) {
				ctx.context.set(scanRowDescriptor, () => lastSourceRow, installer);
				logContextPush(scanRowDescriptor, 'aggregate-rep-row');
			}
			ctx.context.set(combinedRowDescriptor, () => fullRow, installer);
			logContextPush(combinedRowDescriptor, 'aggregate-full-row');
			try {
				yield aggregateRow;
			} finally {
				logContextPop(combinedRowDescriptor, 'aggregate-full-row');
				ctx.context.delete(combinedRowDescriptor);
				if (lastSourceRow) {
					logContextPop(scanRowDescriptor, 'aggregate-rep-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}
		} else {
			// Handle GROUP BY case with streaming aggregation
			// Since input is ordered by grouping columns, we can process groups sequentially

			let currentGroupKey: SqlValue[] | null = null;
			let currentGroupValues: SqlValue[] = [];
			let currentSourceRow: Row | null = null; // Track the current group's representative row
			let currentAccumulators: AggValue[] = [];
			let currentDistinctTrees: (BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]> | null)[] = [];
			let cleanupPreviousGroupContext: (() => void) | null = null;

			// Process all rows
			for await (const row of sourceRows) {
				// Set the current row in the runtime context for Filter and GROUP BY evaluation
				ctx.context.set(scanRowDescriptor, () => row, installer);
				logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

				try {
					// Evaluate GROUP BY expressions to determine the group
					const groupValuesMaybe = evalArgsSync(ctx, groupByFunctions);
					const groupValues = groupValuesMaybe instanceof Promise ? await groupValuesMaybe : groupValuesMaybe;

					// Evaluate aggregate function arguments BEFORE checking for group changes
					// This ensures we have the values we need even if we're about to yield the previous group
					const currentRowArgValues: SqlValue[][] = [];
					for (let i = 0; i < plan.aggregates.length; i++) {
						const argValuesMaybe = evalArgsSync(ctx, aggregateArgFunctions[i], aggregateValueTransforms[i]);
						currentRowArgValues.push(argValuesMaybe instanceof Promise ? await argValuesMaybe : argValuesMaybe);
					}

					// Check if we've moved to a new group using proper SQL value comparison
					if (currentGroupKey !== null && compareGroupKeys(currentGroupKey, groupValues) !== 0) {
						// CRITICAL: Save the previous group's representative row before yielding
						const previousGroupSourceRow = currentSourceRow;

						// Yield the previous group's results
						const aggregateRow: SqlValue[] = [];

						// First, add the GROUP BY values
						aggregateRow.push(...currentGroupValues);

						// Then, add the finalized aggregate values
						for (let i = 0; i < plan.aggregates.length; i++) {
							aggregateRow.push(aggregateSchemas[i].finalizeFunction(currentAccumulators[i]));
						}

						// Build combined row with aggregate results + representative source row
						const fullRow = previousGroupSourceRow ? [...aggregateRow, ...previousGroupSourceRow] : aggregateRow;

						// Set up context with the PREVIOUS group's representative row (not the current row)
						if (previousGroupSourceRow) {
							ctx.context.set(scanRowDescriptor, () => previousGroupSourceRow, installer);
							logContextPush(scanRowDescriptor, 'group-rep-row');
						}
						ctx.context.set(combinedRowDescriptor, () => fullRow, installer);
						logContextPush(combinedRowDescriptor, 'output-row-groupby');
						if (previousGroupSourceRow) {
							// Use the previous group's representative row for HAVING evaluation
							// Use separate descriptors to avoid conflicts with source row processing
							ctx.context.set(groupSourceRowDescriptor, () => previousGroupSourceRow!, installer);
							logContextPush(groupSourceRowDescriptor, 'source-row-groupby', sourceAttributes);
							if (sourceRelation !== plan.source) {
								ctx.context.set(groupSourceRelationRowDescriptor, () => previousGroupSourceRow!, installer);
								logContextPush(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
							}
						}

						// Defer context cleanup
						cleanupPreviousGroupContext = () => {
							logContextPop(combinedRowDescriptor, 'output-row-groupby');
							ctx.context.delete(combinedRowDescriptor);
							if (previousGroupSourceRow) {
								logContextPop(scanRowDescriptor, 'group-rep-row');
								ctx.context.delete(scanRowDescriptor);
							}
							if (previousGroupSourceRow) {
								logContextPop(groupSourceRowDescriptor, 'source-row-groupby');
								ctx.context.delete(groupSourceRowDescriptor);
								if (sourceRelation !== plan.source) {
									logContextPop(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
									ctx.context.delete(groupSourceRelationRowDescriptor);
								}
							}
						};

						yield aggregateRow;

						// Tear down the just-yielded group's representative-row context
						// BEFORE pulling the next source row. These descriptors are built
						// from the source's attribute IDs, so leaving them live would shadow
						// a streaming child's own row slot (same attr IDs) when the child
						// evaluates the next row — e.g. a Filter directly below would read
						// the stale representative row instead of its current row.
						if (cleanupPreviousGroupContext) {
							cleanupPreviousGroupContext();
							cleanupPreviousGroupContext = null;
						}

						// Reset for new group
						currentAccumulators = aggregateSchemas.map(schema => cloneInitialValue(schema.initialValue));
						currentDistinctTrees = aggregateDistinctFlags.map((isDistinct, i) =>
							isDistinct ? createValueSet<SqlValue | SqlValue[]>(distinctComparators[i]) : null
						);
						// Set representative row for the new group (which is the current row)
						currentSourceRow = row;
					}

					// Initialize if first group
					if (currentGroupKey === null) {
						currentAccumulators = aggregateSchemas.map(schema => cloneInitialValue(schema.initialValue));
						currentDistinctTrees = aggregateDistinctFlags.map((isDistinct, i) =>
							isDistinct ? createValueSet<SqlValue | SqlValue[]>(distinctComparators[i]) : null
						);
						// Set representative row for the first group
						currentSourceRow = row;
					}

					// Update current group
					currentGroupKey = groupValues;
					currentGroupValues = groupValues;

					// For each aggregate, call its step function using the pre-evaluated arguments
					for (let i = 0; i < plan.aggregates.length; i++) {
						const isDistinct = aggregateDistinctFlags[i];
						const argValues = currentRowArgValues[i];

						// Handle DISTINCT logic using BTree for proper SQL value comparison
						if (isDistinct) {
							const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
							const existingPath = currentDistinctTrees[i]!.insert(distinctValue);
							if (!existingPath.on) {
								// Value already exists, skip this occurrence
								continue;
							}
						}

						// Call the step function
						currentAccumulators[i] = aggregateSchemas[i].stepFunction(currentAccumulators[i], ...argValues);
					}
				} finally {
					// Clean up scan context for this row
					logContextPop(scanRowDescriptor, 'scan-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}

			// Yield the final group if any rows were processed
			if (currentGroupKey !== null) {
				const aggregateRow: SqlValue[] = [];

				// First, add the GROUP BY values
				aggregateRow.push(...currentGroupValues);

				// Then, add the finalized aggregate values
				for (let i = 0; i < plan.aggregates.length; i++) {
					aggregateRow.push(aggregateSchemas[i].finalizeFunction(currentAccumulators[i]));
				}

				// Build combined row with aggregate results + representative source row
				const fullRow = currentSourceRow ? [...aggregateRow, ...currentSourceRow] : aggregateRow;

				// Set up context for final group with correct source row
				if (currentSourceRow) {
					ctx.context.set(scanRowDescriptor, () => currentSourceRow, installer);
					logContextPush(scanRowDescriptor, 'final-group-rep-row');
				}
				ctx.context.set(combinedRowDescriptor, () => fullRow, installer);
				logContextPush(combinedRowDescriptor, 'final-output-row');
				if (currentSourceRow) {
					// Use the final group's representative row for HAVING evaluation
					// Use separate descriptors to avoid conflicts with source row processing
					ctx.context.set(groupSourceRowDescriptor, () => currentSourceRow!, installer);
					logContextPush(groupSourceRowDescriptor, 'final-source-row', sourceAttributes);
					if (sourceRelation !== plan.source) {
						ctx.context.set(groupSourceRelationRowDescriptor, () => currentSourceRow!, installer);
						logContextPush(groupSourceRelationRowDescriptor, 'final-source-relation-row');
					}
				}

				try {
					yield aggregateRow;
				} finally {
					logContextPop(combinedRowDescriptor, 'final-output-row');
					ctx.context.delete(combinedRowDescriptor);
					if (currentSourceRow) {
						logContextPop(scanRowDescriptor, 'final-group-rep-row');
						ctx.context.delete(scanRowDescriptor);
					}
					if (currentSourceRow) {
						logContextPop(groupSourceRowDescriptor, 'final-source-row');
						ctx.context.delete(groupSourceRowDescriptor);
						if (sourceRelation !== plan.source) {
							logContextPop(groupSourceRelationRowDescriptor, 'final-source-relation-row');
							ctx.context.delete(groupSourceRelationRowDescriptor);
						}
					}
				}
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Emit GROUP BY expressions
	const groupByInstructions = plan.groupBy.map(expr => emitCallFromPlan(expr, ctx));

	// Emit aggregate argument expressions
	const aggregateArgInstructions = emitAggregateArgInstructions(plan.aggregates, ctx);

	return {
		params: [sourceInstruction, ...groupByInstructions, ...aggregateArgInstructions],
		run: asRun(run),
		note: `stream_aggregate(${plan.groupBy.length > 0 ? `GROUP BY ${plan.groupBy.length}` : 'no grouping'}, ${plan.aggregates.length} aggs)`
	};
}
