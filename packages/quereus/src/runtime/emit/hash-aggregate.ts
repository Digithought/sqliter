import type { HashAggregateNode } from '../../planner/nodes/hash-aggregate.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type SqlValue, type Row, type MaybePromise } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { isAggregateFunctionSchema } from '../../schema/function.js';
import { AggregateFunctionCallNode } from '../../planner/nodes/aggregate-function.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { isRelationalNode } from '../../planner/nodes/plan-node.js';
import type { BTree } from 'inheritree';
import { createValueSet } from '../../util/value-set.js';
import { logContextPush, logContextPop } from '../utils.js';
import { coerceForAggregate } from '../../util/coercion.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { AggValue } from '../../func/registration.js';
import { serializeKeyNullGrouping } from '../../util/key-serializer.js';
import { semanticKeyTransform } from '../../util/comparison.js';
import { hashKeyCollationName } from '../../planner/analysis/comparison-collation.js';
import { cloneInitialValue, findSourceRelation, ctxLog } from './aggregate.js';
import { bindAggregateSchemas, buildDistinctComparators, computeAggregateSkipCoercion } from './aggregate-setup.js';
import type { ContextInstaller } from '../context-helpers.js';

interface GroupState {
	groupValues: SqlValue[];
	accumulators: AggValue[];
	distinctTrees: (BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]> | null)[];
	representativeSourceRow: Row;
}

export function emitHashAggregate(plan: HashAggregateNode, ctx: EmissionContext): Instruction {
	const sourceRelation = findSourceRelation(plan.source);

	const sourceAttributes = plan.source.getAttributes();

	const groupSourceRowDescriptor = buildRowDescriptor(sourceAttributes);
	const groupSourceRelationRowDescriptor = sourceRelation !== plan.source
		? buildRowDescriptor(isRelationalNode(sourceRelation) ? sourceRelation.getAttributes() : sourceAttributes)
		: groupSourceRowDescriptor;

	ctxLog('HashAggregate setup: source=%s, sourceRelation=%s', plan.source.nodeType, sourceRelation.nodeType);

	// Best-effort installer label for QUEREUS_CONTEXT_STRICT diagnostics (identifies
	// this operator on the direct context.set()s below; detection ignores it).
	const installer: ContextInstaller = { nodeType: plan.nodeType, id: plan.id };

	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());
	const scanRowDescriptor = buildRowDescriptor(sourceAttributes);

	const combinedRowDescriptor: RowDescriptor = {...outputRowDescriptor};
	sourceAttributes.forEach((attr, index) => {
		if (combinedRowDescriptor[attr.id] === undefined) {
			combinedRowDescriptor[attr.id] = Object.keys(outputRowDescriptor).length + index;
		}
	});

	// Pre-resolve collation normalizers for GROUP BY key serialization
	const keyNormalizers = plan.groupBy.map(expr => {
		const exprType = expr.getType();
		return ctx.resolveKeyNormalizer(hashKeyCollationName(exprType.collationName, [exprType]));
	});

	// Group-key canonicalizers for semantic-ordering key types: values the type's
	// compare treats as equal (TIMESPAN 'PT1H' ≡ 'PT60M') must land in one hash
	// bucket, so they serialize via the type's groupKey representative. The RAW
	// first-seen value stays in groupValues (the emitted representative — which one
	// survives is unspecified, matching DISTINCT).
	const keyCanonicalizers = plan.groupBy.map(expr => semanticKeyTransform(expr.getType().logicalType));
	const hasKeyCanonicalizer = keyCanonicalizers.some(c => c !== undefined);

	const distinctComparators = buildDistinctComparators(plan.aggregates, ctx);
	const aggregateSkipCoercion = computeAggregateSkipCoercion(plan.aggregates);
	const { schemas: aggregateSchemas, distinctFlags: aggregateDistinctFlags } =
		bindAggregateSchemas(plan.aggregates, ctx);

	async function* run(
		ctx: RuntimeContext,
		sourceRows: AsyncIterable<Row>,
		...groupByAndAggregateArgs: Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>
	): AsyncIterable<Row> {

		const numGroupBy = plan.groupBy.length;
		const groupByFunctions = groupByAndAggregateArgs.slice(0, numGroupBy);

		let aggregateArgOffset = numGroupBy;
		const aggregateArgFunctions: Array<Array<(ctx: RuntimeContext) => MaybePromise<SqlValue>>> = [];

		for (const agg of plan.aggregates) {
			const funcNode = agg.expression;
			if (!(funcNode instanceof AggregateFunctionCallNode)) {
				quereusError(
					`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`,
					StatusCode.INTERNAL
				);
			}
			const args = funcNode.args || [];
			const aggregateArgs = groupByAndAggregateArgs.slice(aggregateArgOffset, aggregateArgOffset + args.length);
			aggregateArgFunctions.push(aggregateArgs);
			aggregateArgOffset += args.length;
		}

		function createAccumulators(): AggValue[] {
			return aggregateSchemas.map(schema =>
				cloneInitialValue(isAggregateFunctionSchema(schema) ? schema.initialValue : undefined)
			);
		}

		function createDistinctTrees(): (BTree<SqlValue | SqlValue[], SqlValue | SqlValue[]> | null)[] {
			return aggregateDistinctFlags.map((isDistinct, i) =>
				isDistinct ? createValueSet<SqlValue | SqlValue[]>(distinctComparators[i]) : null
			);
		}

		// No GROUP BY case — identical to stream aggregate (single accumulator, no hash map)
		if (plan.groupBy.length === 0) {
			const accumulators = createAccumulators();
			const distinctTrees = createDistinctTrees();
			let lastSourceRow: Row | null = null;

			for await (const row of sourceRows) {
				lastSourceRow = row;
				ctx.context.set(scanRowDescriptor, () => row, installer);
				logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

				try {
					for (let i = 0; i < plan.aggregates.length; i++) {
						const schema = aggregateSchemas[i];
						const isDistinct = aggregateDistinctFlags[i];

						const funcNode = plan.aggregates[i].expression;
						if (!(funcNode instanceof AggregateFunctionCallNode)) {
							quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
						}
						const args = funcNode.args || [];
						const argFunctions = aggregateArgFunctions[i];

						const skipCoercion = aggregateSkipCoercion[i];
						const argValues: SqlValue[] = [];
						for (let j = 0; j < args.length; j++) {
							const rawValue = await argFunctions[j](ctx);
							const coercedValue = skipCoercion ? rawValue : coerceForAggregate(rawValue, funcNode.functionName || 'unknown');
							argValues.push(coercedValue);
						}

						if (isDistinct) {
							const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
							const existingPath = distinctTrees[i]!.insert(distinctValue);
							if (!existingPath.on) continue;
						}

						if (isAggregateFunctionSchema(schema)) {
							accumulators[i] = schema.stepFunction(accumulators[i], ...argValues);
						}
					}
				} finally {
					logContextPop(scanRowDescriptor, 'scan-row');
					ctx.context.delete(scanRowDescriptor);
				}
			}

			const aggregateRow: SqlValue[] = [];
			for (let i = 0; i < plan.aggregates.length; i++) {
				const schema = aggregateSchemas[i];
				let finalValue: SqlValue;
				if (isAggregateFunctionSchema(schema)) {
					finalValue = schema.finalizeFunction(accumulators[i]);
				} else {
					finalValue = accumulators[i];
				}
				aggregateRow.push(finalValue);
			}

			const fullRow = lastSourceRow ? [...aggregateRow, ...lastSourceRow] : aggregateRow;

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
			return;
		}

		// GROUP BY case — hash aggregate with Map
		const groups = new Map<string, GroupState>();

		// Build phase: iterate all source rows
		for await (const row of sourceRows) {
			ctx.context.set(scanRowDescriptor, () => row, installer);
			logContextPush(scanRowDescriptor, 'scan-row', sourceAttributes);

			try {
				// Evaluate GROUP BY expressions
				const groupValues: SqlValue[] = [];
				for (const groupByFunc of groupByFunctions) {
					groupValues.push(await groupByFunc(ctx));
				}

				// Serialize key using collation-aware serialization (NULLs group together per SQL standard)
				const keyValues = hasKeyCanonicalizer
					? groupValues.map((v, i) => keyCanonicalizers[i] ? keyCanonicalizers[i]!(v) : v)
					: groupValues;
				const key = serializeKeyNullGrouping(keyValues, keyNormalizers);

				// Look up or create group entry
				let group = groups.get(key);
				if (!group) {
					group = {
						groupValues,
						accumulators: createAccumulators(),
						distinctTrees: createDistinctTrees(),
						representativeSourceRow: row,
					};
					groups.set(key, group);
				}

				// Evaluate aggregate arguments and step accumulators
				for (let i = 0; i < plan.aggregates.length; i++) {
					const schema = aggregateSchemas[i];
					const isDistinct = aggregateDistinctFlags[i];

					const funcNode = plan.aggregates[i].expression;
					if (!(funcNode instanceof AggregateFunctionCallNode)) {
						quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
					}
					const args = funcNode.args || [];
					const argFunctions = aggregateArgFunctions[i];

					const skipCoercion = aggregateSkipCoercion[i];
					const argValues: SqlValue[] = [];
					for (let j = 0; j < args.length; j++) {
						const rawValue = await argFunctions[j](ctx);
						const coercedValue = skipCoercion ? rawValue : coerceForAggregate(rawValue, funcNode.functionName || 'unknown');
						argValues.push(coercedValue);
					}

					if (isDistinct) {
						const distinctValue = argValues.length === 1 ? argValues[0] : argValues;
						const existingPath = group.distinctTrees[i]!.insert(distinctValue);
						if (!existingPath.on) continue;
					}

					if (isAggregateFunctionSchema(schema)) {
						group.accumulators[i] = schema.stepFunction(group.accumulators[i], ...argValues);
					}
				}
			} finally {
				logContextPop(scanRowDescriptor, 'scan-row');
				ctx.context.delete(scanRowDescriptor);
			}
		}

		// Emit phase: iterate all groups and yield results
		for (const group of groups.values()) {
			const aggregateRow: SqlValue[] = [];

			// GROUP BY values first
			aggregateRow.push(...group.groupValues);

			// Finalized aggregate values
			for (let i = 0; i < plan.aggregates.length; i++) {
				const schema = aggregateSchemas[i];
				let finalValue: SqlValue;
				if (isAggregateFunctionSchema(schema)) {
					finalValue = schema.finalizeFunction(group.accumulators[i]);
				} else {
					finalValue = group.accumulators[i];
				}
				aggregateRow.push(finalValue);
			}

			// Set up combined context (output + representative source row) for HAVING
			const fullRow = [...aggregateRow, ...group.representativeSourceRow];

			ctx.context.set(scanRowDescriptor, () => group.representativeSourceRow, installer);
			logContextPush(scanRowDescriptor, 'group-rep-row');
			ctx.context.set(combinedRowDescriptor, () => fullRow, installer);
			logContextPush(combinedRowDescriptor, 'output-row-groupby');
			ctx.context.set(groupSourceRowDescriptor, () => group.representativeSourceRow, installer);
			logContextPush(groupSourceRowDescriptor, 'source-row-groupby', sourceAttributes);
			if (sourceRelation !== plan.source) {
				ctx.context.set(groupSourceRelationRowDescriptor, () => group.representativeSourceRow, installer);
				logContextPush(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
			}

			try {
				yield aggregateRow;
			} finally {
				logContextPop(combinedRowDescriptor, 'output-row-groupby');
				ctx.context.delete(combinedRowDescriptor);
				logContextPop(scanRowDescriptor, 'group-rep-row');
				ctx.context.delete(scanRowDescriptor);
				logContextPop(groupSourceRowDescriptor, 'source-row-groupby');
				ctx.context.delete(groupSourceRowDescriptor);
				if (sourceRelation !== plan.source) {
					logContextPop(groupSourceRelationRowDescriptor, 'source-relation-row-groupby');
					ctx.context.delete(groupSourceRelationRowDescriptor);
				}
			}
		}
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	const groupByInstructions = plan.groupBy.map(expr => emitCallFromPlan(expr, ctx));

	const aggregateArgInstructions: Instruction[] = [];
	for (const agg of plan.aggregates) {
		const funcNode = agg.expression;
		if (!(funcNode instanceof AggregateFunctionCallNode)) {
			quereusError(`Expected AggregateFunctionCallNode but got ${funcNode.constructor.name}`, StatusCode.INTERNAL);
		}
		const args = funcNode.args || [];
		for (const arg of args) {
			if (!arg) {
				quereusError(`Aggregate argument is undefined for function ${funcNode.functionName}`, StatusCode.INTERNAL);
			}
			aggregateArgInstructions.push(emitCallFromPlan(arg, ctx));
		}
	}

	return {
		params: [sourceInstruction, ...groupByInstructions, ...aggregateArgInstructions],
		run: asRun(run),
		note: `hash_aggregate(${plan.groupBy.length > 0 ? `GROUP BY ${plan.groupBy.length}` : 'no grouping'}, ${plan.aggregates.length} aggs)`
	};
}
