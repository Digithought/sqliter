import type { WindowNode } from '../../planner/nodes/window-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { OutputValue, Row, SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { bindWindowSchema, resolveWindowFunction, type WindowFunctionSchema } from '../../schema/window-function.js';
import { argComparisonContext } from './aggregate-setup.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { createTypedComparator, createTypedOrderByComparator, hasSemanticOrdering } from '../../util/comparison.js';
import { hashKeyCollationName } from '../../planner/analysis/comparison-collation.js';
import type { LogicalType } from '../../types/logical-type.js';
import { serializeKeyNullGrouping } from '../../util/key-serializer.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type * as AST from '../../parser/ast.js';
import { createRowSlot, type RowSlot, type ContextInstaller } from '../context-helpers.js';
import { tryExtractNumericLiteral } from '../../util/ast-literal.js';

const log = createLogger('runtime:emit:window');

export function emitWindow(plan: WindowNode, ctx: EmissionContext): Instruction {
	// Resolve + bind each window function's schema ONCE here: the call site's
	// argument types and collations specialize comparison-sensitive windows
	// (min/max via bindArgs) so their step ranks by the argument's semantic order,
	// exactly as the min/max aggregate does. Every execution shape below —
	// the buffered frame walk (computeAggregateFunction), the streaming running
	// aggregate (stepRunningAgg) and the sliding-frame scans — folds through THIS
	// schema, so the physical shapes cannot drift apart. Nothing per-row resolves
	// a type or a collation.
	const functionSchemas = plan.functions.map((func, fi) => {
		const schema = resolveWindowFunction(func.functionName);
		if (!schema) {
			throw new QuereusError(`Window function ${func.functionName} not found`, StatusCode.INTERNAL);
		}
		const argBindings = (plan.functionArguments[fi] ?? []).map(argPlan => argComparisonContext(argPlan, ctx));
		return bindWindowSchema(schema, argBindings);
	});

	// Emit callbacks for partition expressions
	const partitionCallbacks = plan.partitionExpressions.map(exprPlan =>
		emitCallFromPlan(exprPlan, ctx)
	);

	// Emit callbacks for ORDER BY expressions (if any)
	const orderByCallbacks = plan.orderByExpressions.map(exprPlan =>
		emitCallFromPlan(exprPlan, ctx)
	);

	// Emit callbacks for window function arguments (2D: per-function arrays)
	const functionArgCallbacks = plan.functionArguments.map(argPlans =>
		argPlans.map(argPlan => emitCallFromPlan(argPlan, ctx))
	);
	// Track per-function arg counts for callback reconstruction in run()
	const functionArgCounts = plan.functionArguments.map(args => args.length);

	// Create row descriptors
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());

	// Pre-resolve ORDER BY comparators using actual expression types (not hardcoded BINARY).
	// Semantic-ordering types (TIMESPAN, JSON) rank by the type's compare — matching the
	// typed peer-equality comparators below, so ordering and peer detection agree.
	const orderByComparators = plan.orderByExpressions.map((exprPlan, i) => {
		const exprType = exprPlan.getType();
		const collationName = exprType.collationName || 'BINARY';
		const collationFunc = ctx.resolveCollation(collationName);
		const orderClause = plan.windowSpec.orderBy[i];
		return createTypedOrderByComparator(exprType.logicalType as LogicalType, orderClause.direction, orderClause.nulls, collationFunc);
	});

	// Pre-resolve typed equality comparators for ORDER BY (used in ranking functions)
	const orderByEqualityComparators = plan.orderByExpressions.map(exprPlan => {
		const exprType = exprPlan.getType();
		const collationFunc = exprType.collationName ? ctx.resolveCollation(exprType.collationName) : undefined;
		return createTypedComparator(exprType.logicalType as LogicalType, collationFunc);
	});

	// Pre-resolve collation normalizers for partition key serialization
	const partitionKeyNormalizers = plan.partitionExpressions.map(exprPlan => {
		const exprType = exprPlan.getType();
		return ctx.resolveKeyNormalizer(hashKeyCollationName(exprType.collationName, [exprType]));
	});

	// Partition-key canonicalizers for semantic-ordering key types: values the type's
	// compare treats as equal (TIMESPAN 'PT1H' ≡ 'PT60M') must land in one partition,
	// so they serialize via the type's groupKey representative (mirrors GROUP BY in
	// hash-aggregate.ts).
	const partitionKeyCanonicalizers = plan.partitionExpressions.map(exprPlan => {
		const logical = exprPlan.getType().logicalType as LogicalType;
		return hasSemanticOrdering(logical) && logical.groupKey
			? (v: SqlValue) => logical.groupKey!(v)
			: undefined;
	});
	const hasPartitionCanonicalizer = partitionKeyCanonicalizers.some(c => c !== undefined);
	const serializePartitionKey = (values: SqlValue[]): string => {
		const keyValues = hasPartitionCanonicalizer
			? values.map((v, i) => partitionKeyCanonicalizers[i] ? partitionKeyCanonicalizers[i]!(v) : v)
			: values;
		return serializeKeyNullGrouping(keyValues, partitionKeyNormalizers);
	};

	async function* run(
		rctx: RuntimeContext,
		source: AsyncIterable<Row>,
		...callbacks: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		log('Starting window function execution');

		// Extract callbacks in order: partitions, orderBy, function args
		const partitionCallbackList = callbacks.slice(0, partitionCallbacks.length);
		const orderByCallbackList = callbacks.slice(
			partitionCallbacks.length,
			partitionCallbacks.length + orderByCallbacks.length
		);
		// Reconstruct per-function arg callback arrays from flattened list
		const funcArgCallbackGroups: Array<(ctx: RuntimeContext) => OutputValue>[] = [];
		let argOffset = partitionCallbacks.length + orderByCallbacks.length;
		for (const count of functionArgCounts) {
			funcArgCallbackGroups.push(callbacks.slice(argOffset, argOffset + count));
			argOffset += count;
		}

		// Single source slot shared across all partition/sort/ranking/aggregate operations
		// Best-effort installer label for QUEREUS_CONTEXT_STRICT diagnostics (detection ignores it).
		const installer: ContextInstaller = { nodeType: plan.nodeType, id: plan.id };
		const sourceSlot = createRowSlot(rctx, sourceRowDescriptor, installer);
		try {
			if (plan.streaming) {
				// Streaming fast path: source already arrives in
				// [PARTITION BY..., ORDER BY] order, so we walk it once and emit
				// in source order without materializing.
				yield* runStreaming(
					plan, functionSchemas, rctx, source, sourceRowDescriptor,
					partitionCallbackList, orderByCallbackList, funcArgCallbackGroups,
					serializePartitionKey, orderByEqualityComparators,
				);
				return;
			}

			// Buffered path: materialize then partition/sort.
			const allRows: Row[] = [];
			for await (const row of source) {
				allRows.push(row);
			}

			if (plan.windowSpec.partitionBy.length === 0) {
				// No partitioning - process as single partition
				yield* processPartition(
					allRows, plan, functionSchemas, rctx,
					sourceRowDescriptor,
					partitionCallbackList, orderByCallbackList, funcArgCallbackGroups,
					sourceSlot, orderByComparators, orderByEqualityComparators
				);
			} else {
				// With partitioning - group by partition keys
				const partitions = await groupByPartitions(
					allRows, partitionCallbackList, rctx, sourceSlot, serializePartitionKey
				);

				for (const partitionRows of partitions.values()) {
					yield* processPartition(
						partitionRows, plan, functionSchemas, rctx,
						sourceRowDescriptor,
						partitionCallbackList, orderByCallbackList, funcArgCallbackGroups,
						sourceSlot, orderByComparators, orderByEqualityComparators
					);
				}
			}
		} finally {
			sourceSlot.close();
		}
	}

	// Collect all callbacks (flatten per-function arg arrays)
	const allCallbacks = [
		...partitionCallbacks,
		...orderByCallbacks,
		...functionArgCallbacks.flat()
	];

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...allCallbacks],
		run: asRun(run),
		note: `window(${plan.functions.map(f => f.functionName).join(', ')})`
	};
}

async function groupByPartitions(
	rows: Row[],
	partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot,
	serializePartitionKey: (values: SqlValue[]) => string
): Promise<Map<string, Row[]>> {
	const partitions = new Map<string, Row[]>();

	for (const row of rows) {
		sourceSlot.set(row);
		// Sequential evaluation: parallel callbacks that share a plan subtree
		// (e.g. PARTITION BY (SELECT ... FROM cte), (SELECT ... FROM cte))
		// would race on the shared inner-scan RowSlot.
		const partitionValues: SqlValue[] = [];
		for (const callback of partitionCallbacks) {
			// Resolve without a per-row microtask hop (see runtime/async-util.ts).
			const raw = callback(rctx);
			partitionValues.push((raw instanceof Promise ? await raw : raw) as SqlValue);
		}
		const partitionKey = serializePartitionKey(partitionValues);

		if (!partitions.has(partitionKey)) {
			partitions.set(partitionKey, []);
		}
		partitions.get(partitionKey)!.push(row);
	}

	return partitions;
}

async function* processPartition(
	partitionRows: Row[],
	plan: WindowNode,
	functionSchemas: WindowFunctionSchema[],
	rctx: RuntimeContext,
	_sourceRowDescriptor: RowDescriptor,
	_partitionCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	funcArgCallbackGroups: Array<Array<(ctx: RuntimeContext) => OutputValue>>,
	sourceSlot: RowSlot,
	preResolvedOrderByComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	preResolvedEqualityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): AsyncIterable<Row> {
	// Sort rows according to ORDER BY specification
	const sorted = await sortRows(
		partitionRows, plan.windowSpec.orderBy, orderByCallbacks,
		rctx, sourceSlot, preResolvedOrderByComparators
	);
	const sortedRows = sorted.rows;
	const orderByValues = sorted.orderByValues;

	const partitionSize = sortedRows.length;

	// Pre-compute ranking values in a single O(n) pass using cached orderByValues
	const rankings = precomputeRankings(partitionSize, orderByValues, preResolvedEqualityComparators);

	// Process each row in the sorted partition
	for (let currentIndex = 0; currentIndex < sortedRows.length; currentIndex++) {
		const currentRow = sortedRows[currentIndex];
		const outputRow = [...currentRow];

		// Set source context for current row
		sourceSlot.set(currentRow);

		const values: SqlValue[] = [];
		// Compute each window function
		for (let funcIndex = 0; funcIndex < plan.functions.length; funcIndex++) {
			const func = plan.functions[funcIndex];
			const schema = functionSchemas[funcIndex];
			const argCallbacks = funcArgCallbackGroups[funcIndex];

			let value: SqlValue;

			if (schema.kind === 'ranking') {
				value = await computeRankingFunction(
					func.functionName, currentIndex, partitionSize,
					rankings, argCallbacks, rctx
				);
			} else if (schema.kind === 'aggregate') {
				value = await computeAggregateFunction(
					schema, argCallbacks[0] ?? null, sortedRows, currentIndex,
					plan.windowSpec.frame, plan.windowSpec.orderBy.length > 0,
					orderByValues, preResolvedEqualityComparators,
					rctx, sourceSlot
				);
			} else if (schema.kind === 'navigation') {
				value = await computeNavigationFunction(
					func.functionName, sortedRows, currentIndex,
					argCallbacks, rctx, sourceSlot
				);
			} else if (schema.kind === 'value') {
				value = await computeValueFunction(
					func.functionName, sortedRows, currentIndex,
					argCallbacks, plan.windowSpec.frame,
					plan.windowSpec.orderBy.length > 0,
					orderByValues, preResolvedEqualityComparators,
					rctx, sourceSlot
				);
			} else {
				throw new QuereusError(
					`Window function type ${schema.kind} not yet implemented`,
					StatusCode.UNSUPPORTED
				);
			}

			// Restore current row context after helper may have changed it
			sourceSlot.set(currentRow);
			values.push(value);
		}

		// Add computed values to output row
		outputRow.push(...values);

		yield outputRow as Row;
	}
}

/** Result of sorting rows, including pre-evaluated ORDER BY values */
interface SortedPartition {
	rows: Row[];
	/** ORDER BY values for each row (one array of values per row). Empty if no ORDER BY. */
	orderByValues: SqlValue[][];
}

async function sortRows(
	rows: Row[],
	orderBy: AST.OrderByClause[],
	orderByCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot,
	preResolvedComparators: Array<(a: SqlValue, b: SqlValue) => number>
): Promise<SortedPartition> {
	if (orderBy.length === 0) {
		return { rows, orderByValues: rows.map(() => []) };
	}

	// Pre-evaluate ORDER BY values for all rows to avoid async in sort.
	// Sequential outer loop: parallel iterations would race on the shared
	// sourceSlot. Sequential inner loop: parallel callbacks that share a
	// plan subtree would race on the shared inner-scan RowSlot.
	const rowsWithValues: Array<{ row: Row; values: SqlValue[] }> = [];
	for (const row of rows) {
		sourceSlot.set(row);
		const values: SqlValue[] = [];
		for (const callback of orderByCallbacks) {
			// Resolve without a per-row microtask hop (see runtime/async-util.ts).
			const raw = callback(rctx);
			values.push((raw instanceof Promise ? await raw : raw) as SqlValue);
		}
		rowsWithValues.push({ row, values });
	}

	// Now sort using the pre-evaluated values
	rowsWithValues.sort((a, b) => {
		// Compare each ORDER BY expression in sequence
		for (let i = 0; i < orderBy.length; i++) {
			const comparison = preResolvedComparators[i](a.values[i], b.values[i]);
			if (comparison !== 0) {
				return comparison;
			}
		}

		return 0; // All ORDER BY expressions are equal
	});

	return {
		rows: rowsWithValues.map(item => item.row),
		orderByValues: rowsWithValues.map(item => item.values)
	};
}

/** Pre-computed ranking values for all rows in a partition (O(n) single pass) */
interface PrecomputedRankings {
	rank: number[];
	denseRank: number[];
	percentRank: number[];
	cumeDist: number[];
}

/** Single O(n) pass over sorted rows to compute all ranking values */
function precomputeRankings(
	partitionSize: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): PrecomputedRankings {
	const rank = new Array<number>(partitionSize);
	const denseRank = new Array<number>(partitionSize);
	const percentRank = new Array<number>(partitionSize);
	const cumeDist = new Array<number>(partitionSize);

	let denseRankCounter = 0;
	let i = 0;

	while (i < partitionSize) {
		// Find the end of the current peer group
		let j = i;
		while (j + 1 < partitionSize && arePeerRows(orderByValues[j + 1], orderByValues[i], equalityComparators)) {
			j++;
		}

		denseRankCounter++;
		const rankValue = i + 1;
		const cumeDistValue = (j + 1) / partitionSize;
		const percentRankValue = partitionSize <= 1 ? 0 : (rankValue - 1) / (partitionSize - 1);

		for (let k = i; k <= j; k++) {
			rank[k] = rankValue;
			denseRank[k] = denseRankCounter;
			percentRank[k] = percentRankValue;
			cumeDist[k] = cumeDistValue;
		}

		i = j + 1;
	}

	return { rank, denseRank, percentRank, cumeDist };
}

async function computeRankingFunction(
	functionName: string,
	currentIndex: number,
	partitionSize: number,
	rankings: PrecomputedRankings,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext
): Promise<number> {
	switch (functionName.toLowerCase()) {
		case 'row_number':
			return currentIndex + 1;

		case 'rank':
			return rankings.rank[currentIndex];

		case 'dense_rank':
			return rankings.denseRank[currentIndex];

		case 'percent_rank':
			return rankings.percentRank[currentIndex];

		case 'cume_dist':
			return rankings.cumeDist[currentIndex];

		case 'ntile': {
			// Evaluate the bucket count argument
			const nValue = argCallbacks.length > 0
				? await Promise.resolve(argCallbacks[0](rctx)) as SqlValue
				: 1;
			const n = Number(nValue) || 1;
			if (n <= 0) return 1;

			// Divide partition into n roughly equal groups
			const q = Math.floor(partitionSize / n);
			const r = partitionSize % n;
			// First r groups have (q+1) rows, remaining have q rows
			if (currentIndex < r * (q + 1)) {
				return Math.floor(currentIndex / (q + 1)) + 1;
			} else {
				return r + Math.floor((currentIndex - r * (q + 1)) / q) + 1;
			}
		}

		default:
			throw new QuereusError(
				`Ranking function ${functionName} not implemented`,
				StatusCode.UNSUPPORTED
			);
	}
}

async function computeNavigationFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const exprCallback = argCallbacks[0];
	if (!exprCallback) {
		throw new QuereusError(`${functionName} requires at least one argument`, StatusCode.ERROR);
	}

	// Evaluate offset (2nd arg, default 1)
	let offset = 1;
	if (argCallbacks.length >= 2) {
		const offsetValue = await Promise.resolve(argCallbacks[1](rctx));
		offset = Number(offsetValue) || 0;
	}

	// Evaluate default value (3rd arg, default null)
	let defaultValue: SqlValue = null;
	if (argCallbacks.length >= 3) {
		defaultValue = await Promise.resolve(argCallbacks[2](rctx)) as SqlValue;
	}

	const name = functionName.toLowerCase();
	const targetIndex = name === 'lag'
		? currentIndex - offset
		: currentIndex + offset; // 'lead'

	if (targetIndex < 0 || targetIndex >= sortedRows.length) {
		return defaultValue;
	}

	// Evaluate expression on the target row
	sourceSlot.set(sortedRows[targetIndex]);
	return await Promise.resolve(exprCallback(rctx)) as SqlValue;
}

async function computeValueFunction(
	functionName: string,
	sortedRows: Row[],
	currentIndex: number,
	argCallbacks: Array<(ctx: RuntimeContext) => OutputValue>,
	frame: import('../../parser/ast.js').WindowFrame | undefined,
	hasOrderBy: boolean,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const exprCallback = argCallbacks[0];
	if (!exprCallback) {
		throw new QuereusError(`${functionName} requires one argument`, StatusCode.ERROR);
	}

	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy, orderByValues, equalityComparators);
	const name = functionName.toLowerCase();

	let targetIndex: number;
	if (name === 'first_value') {
		targetIndex = frameBounds.start;
	} else {
		// last_value
		targetIndex = frameBounds.end;
	}

	// Handle empty frame
	if (targetIndex < 0 || targetIndex >= sortedRows.length || frameBounds.start > frameBounds.end) {
		return null;
	}

	sourceSlot.set(sortedRows[targetIndex]);
	return await Promise.resolve(exprCallback(rctx)) as SqlValue;
}

async function computeAggregateFunction(
	schema: WindowFunctionSchema,
	argCallback: ((ctx: RuntimeContext) => OutputValue) | null,
	sortedRows: Row[],
	currentIndex: number,
	frame: AST.WindowFrame | undefined,
	hasOrderBy: boolean,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>,
	rctx: RuntimeContext,
	sourceSlot: RowSlot
): Promise<SqlValue> {
	const frameBounds = getFrameBounds(frame, sortedRows.length, currentIndex, hasOrderBy, orderByValues, equalityComparators);

	let accumulator: SqlValue = null;
	let rowCount = 0;

	// Process rows within the frame
	for (let i = frameBounds.start; i <= frameBounds.end; i++) {
		const frameRow = sortedRows[i];
		sourceSlot.set(frameRow);

		let argValue: SqlValue = null;

		// Get argument value if callback exists
		if (argCallback) {
			argValue = await Promise.resolve(argCallback(rctx)) as SqlValue;
		}

		// Apply aggregate step function
		if (schema.step) {
			accumulator = schema.step(accumulator, argValue);
			rowCount++;
		}
	}

	// Apply final function
	return schema.final ? schema.final(accumulator, rowCount) : accumulator;
}

function getFrameBounds(
	frame: AST.WindowFrame | undefined,
	totalRows: number,
	currentIndex: number,
	hasOrderBy: boolean = true,
	orderByValues: SqlValue[][] = [],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number> = []
): { start: number; end: number } {
	if (!frame) {
		if (!hasOrderBy) {
			// No ORDER BY: default frame is entire partition (all rows)
			return { start: 0, end: totalRows - 1 };
		} else {
			// With ORDER BY: default frame is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			// In RANGE mode, CURRENT ROW means all peer rows (same ORDER BY values)
			const lastPeer = findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators);
			return { start: 0, end: lastPeer };
		}
	}

	const isRange = frame.type === 'range';

	let start: number;
	let end: number;

	// Calculate start bound
	if (frame.start.type === 'unboundedPreceding') {
		start = 0;
	} else if (frame.start.type === 'currentRow') {
		start = isRange
			? findFirstPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.start.type === 'preceding') {
		const offset = getFrameOffset(frame.start.value);
		if (isRange) {
			start = findRangeOffsetStart(currentIndex, totalRows, orderByValues, -offset);
		} else {
			start = currentIndex - offset;
		}
	} else if (frame.start.type === 'following') {
		const offset = getFrameOffset(frame.start.value);
		if (isRange) {
			start = findRangeOffsetStart(currentIndex, totalRows, orderByValues, offset);
		} else {
			start = currentIndex + offset;
		}
	} else {
		start = 0;
	}

	// Calculate end bound
	if (frame.end === null) {
		// Single bound frame - end is current row
		end = isRange
			? findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.end.type === 'unboundedFollowing') {
		end = totalRows - 1;
	} else if (frame.end.type === 'currentRow') {
		end = isRange
			? findLastPeer(currentIndex, totalRows, orderByValues, equalityComparators)
			: currentIndex;
	} else if (frame.end.type === 'preceding') {
		const offset = getFrameOffset(frame.end.value);
		if (isRange) {
			end = findRangeOffsetEnd(currentIndex, totalRows, orderByValues, -offset);
		} else {
			end = currentIndex - offset;
		}
	} else if (frame.end.type === 'following') {
		const offset = getFrameOffset(frame.end.value);
		if (isRange) {
			end = findRangeOffsetEnd(currentIndex, totalRows, orderByValues, offset);
		} else {
			end = currentIndex + offset;
		}
	} else {
		end = currentIndex;
	}

	// For ROWS mode, clamp to valid row indices after computing logical bounds.
	// Clamping must happen after both bounds are computed so that frames
	// entirely outside [0, totalRows-1] are detected as empty by the check below.
	if (!isRange) {
		start = Math.max(0, start);
		end = Math.min(totalRows - 1, end);
	}

	// Empty frame when bounds invert
	if (start > end) {
		return { start: currentIndex + 1, end: currentIndex };
	}

	return { start, end };
}

/** Find the first row in the peer group (rows with same ORDER BY values) */
function findFirstPeer(
	currentIndex: number,
	_totalRows: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): number {
	const currentVals = orderByValues[currentIndex];
	let first = currentIndex;
	while (first > 0 && arePeerRows(orderByValues[first - 1], currentVals, equalityComparators)) {
		first--;
	}
	return first;
}

/** Find the last row in the peer group */
function findLastPeer(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): number {
	const currentVals = orderByValues[currentIndex];
	let last = currentIndex;
	while (last < totalRows - 1 && arePeerRows(orderByValues[last + 1], currentVals, equalityComparators)) {
		last++;
	}
	return last;
}

/** Check if two rows have equal ORDER BY values */
function arePeerRows(
	valsA: SqlValue[],
	valsB: SqlValue[],
	equalityComparators: Array<(a: SqlValue, b: SqlValue) => number>
): boolean {
	for (let i = 0; i < equalityComparators.length; i++) {
		if (equalityComparators[i](valsA[i], valsB[i]) !== 0) return false;
	}
	return true;
}

/**
 * For RANGE N PRECEDING/FOLLOWING: find the first row whose ORDER BY value
 * is >= (currentValue + offset). Uses the first ORDER BY expression only
 * (SQL standard requires single ORDER BY for numeric RANGE offsets).
 */
function findRangeOffsetStart(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	offset: number // negative for PRECEDING, positive for FOLLOWING
): number {
	const currentVal = Number(orderByValues[currentIndex][0]);
	if (!Number.isFinite(currentVal)) return currentIndex;
	const targetVal = currentVal + offset;

	// Scan from beginning to find first row >= targetVal
	for (let i = 0; i < totalRows; i++) {
		const rowVal = Number(orderByValues[i][0]);
		if (Number.isFinite(rowVal) && rowVal >= targetVal) {
			return i;
		}
	}
	return totalRows; // No matching row (empty frame start)
}

/**
 * For RANGE N PRECEDING/FOLLOWING: find the last row whose ORDER BY value
 * is <= (currentValue + offset).
 */
function findRangeOffsetEnd(
	currentIndex: number,
	totalRows: number,
	orderByValues: SqlValue[][],
	offset: number
): number {
	const currentVal = Number(orderByValues[currentIndex][0]);
	if (!Number.isFinite(currentVal)) return currentIndex;
	const targetVal = currentVal + offset;

	// Scan from end to find last row <= targetVal
	for (let i = totalRows - 1; i >= 0; i--) {
		const rowVal = Number(orderByValues[i][0]);
		if (Number.isFinite(rowVal) && rowVal <= targetVal) {
			return i;
		}
	}
	return -1; // No matching row (empty frame end)
}

function getFrameOffset(expr: AST.Expression): number {
	// SQL grammar for frame offsets is typically an unsigned integer literal.
	// Quereus currently supports literal numeric offsets and unary +/- on literals.
	const value = tryExtractNumericLiteral(expr);
	if (value === undefined) {
		throw new QuereusError(
			'Window frame offsets must be constant numeric literals',
			StatusCode.UNSUPPORTED
		);
	}

	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new QuereusError(
			`Invalid window frame offset: ${value}. Must be a non-negative integer.`,
			StatusCode.ERROR
		);
	}

	return value;
}

// ============================================================================
// Streaming fast-path emitter
// ============================================================================
//
// Activated when `WindowNode.streaming` is set by `rule-monotonic-window`. The
// source already arrives in `[PARTITION BY..., ORDER BY]` order, so we walk
// it once with O(P) per-partition state instead of buffering and sorting.
//
// Per-row pipeline:
//   1. Compute partition key + ORDER BY values for the current row.
//   2. On partition boundary: flush the trailing peer group (assigns the final
//      RANGE-mode running-aggregate value), flush LEAD's read-ahead buffer
//      with default values, and yield all queued rows.
//   3. On peer-group boundary: assign current accumulator to all RANGE-mode
//      runningAgg slots in the closing peer group.
//   4. Append a queue entry for the current row, with one slot per function.
//   5. Update each function's state and fill slots that can be filled now.
//   6. Yield queue front rows whose slots are all filled.

interface StreamingFunctionContext {
	/** Index in the WindowNode's `functions` / `functionArguments` arrays. */
	readonly fi: number;
	readonly schema: WindowFunctionSchema;
	readonly args: ReadonlyArray<(ctx: RuntimeContext) => OutputValue>;
}

/**
 * Per-row queue entry shared across all functions. `filled[fi]` is true when
 * function `fi`'s output for this row is finalised. When `pending` reaches 0,
 * the entry can be yielded.
 */
interface StreamingRowEntry {
	/** Output row: `[...sourceRow, slot0, slot1, ...]`. */
	row: SqlValue[];
	/** Per-function fill flags. */
	filled: boolean[];
	/** Number of slots still needing fill. When zero, ready to yield. */
	pending: number;
	/** Index in `row` where function slots start (== source column count). */
	funcSlotsStart: number;
}

/** Per-partition mutable state for the streaming emitter. */
interface StreamingPartitionState {
	/** Number of rows seen in this partition (1-based for ranking). */
	rowCount: number;
	/** Number of distinct peer groups seen (for DENSE_RANK). */
	denseRankCounter: number;
	/** RANK value of the current peer group. */
	currentRank: number;
	/** Last row's ORDER BY values, or null at partition start. */
	lastOrderByValues: SqlValue[] | null;
	/**
	 * Queue of pending output rows. Front-of-queue rows are yielded once their
	 * slots are all filled. Bounded by `peer-group-size + max(LEAD offset)`.
	 */
	queue: StreamingRowEntry[];
	/** Per-function state, indexed by function position. */
	funcStates: StreamingFuncState[];
	/** Pending peer group entries needing RANGE-mode runningAgg fill. */
	pendingPeers: StreamingRowEntry[];
}

interface StreamingFuncState {
	mode: import('../../planner/nodes/window-node.js').StreamingWindowFunctionMode;
	/** Ring buffer for LAG: prior `n+1` evaluated arg-values (newest at end). */
	lagBuffer?: SqlValue[];
	/** Pending entries holding back for LEAD. */
	leadQueue?: StreamingRowEntry[];
	/** FIRST_VALUE cache: first row's expr value for this partition. */
	firstValueCached?: { value: SqlValue; cached: boolean };
	/** Running-aggregate accumulator + row count. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	aggAccumulator?: any;
	aggRowCount?: number;
	/** RANGE mode running aggs: pending peer group entries waiting for fill. */
	pendingPeerEntries?: StreamingRowEntry[];
	/** Sliding-frame ring buffer of {argVal, orderByVal0} for rows currently in scope. */
	slidingBuffer?: SlidingBufEntry[];
	/** Partition row index of slidingBuffer[0] (ROWS sliding). */
	slidingHead?: number;
	/** Running { sum, count } accumulator for SUM/COUNT/AVG sliding (ROWS step+unstep). */
	slidingAcc?: { sum: number; count: number };
	/** Partition row index of next ROWS-sliding entry to finalize. */
	slidingNextFinalizeIdx?: number;
	/** ROWS sliding: pending entries awaiting finalization (oldest first). */
	slidingPending?: StreamingRowEntry[];
	/** RANGE sliding: pending entries with metadata. */
	slidingRangePending?: SlidingRangePendingEntry[];
}

/** Per-row entry in a sliding-frame buffer (ROWS or RANGE). */
interface SlidingBufEntry {
	argVal: SqlValue;
	/** Number(orderByValues[0]) — NaN for null/non-numeric. Used by RANGE only. */
	orderByVal0: number;
}

/** Pending entry for a RANGE-sliding function. */
interface SlidingRangePendingEntry {
	entry: StreamingRowEntry;
	/** Numeric ORDER BY value at this entry's row (NaN if non-finite). */
	v_j: number;
	/** Pre-computed `Number.isFinite(v_j)`. */
	isFinite: boolean;
	/** Right edge has been crossed by a later arrival. */
	rightClosed: boolean;
}

function makeFuncState(
	mode: import('../../planner/nodes/window-node.js').StreamingWindowFunctionMode,
): StreamingFuncState {
	const s: StreamingFuncState = { mode };
	switch (mode.kind) {
		case 'lag':
			s.lagBuffer = [];
			break;
		case 'lead':
			s.leadQueue = [];
			break;
		case 'firstValue':
			s.firstValueCached = { value: null, cached: false };
			break;
		case 'runningAgg':
			s.aggAccumulator = null;
			s.aggRowCount = 0;
			s.pendingPeerEntries = [];
			break;
		case 'slidingAgg':
			s.slidingBuffer = [];
			s.slidingHead = 0;
			s.slidingAcc = { sum: 0, count: 0 };
			s.slidingNextFinalizeIdx = 0;
			if (mode.frameMode === 'rows') {
				s.slidingPending = [];
			} else {
				s.slidingRangePending = [];
			}
			break;
		default:
			break;
	}
	return s;
}

function freshPartitionState(
	streamingModes: ReadonlyArray<import('../../planner/nodes/window-node.js').StreamingWindowFunctionMode>,
): StreamingPartitionState {
	return {
		rowCount: 0,
		denseRankCounter: 0,
		currentRank: 0,
		lastOrderByValues: null,
		queue: [],
		funcStates: streamingModes.map(makeFuncState),
		pendingPeers: [],
	};
}

function arePeers(
	a: SqlValue[],
	b: SqlValue[],
	cmps: ReadonlyArray<(a: SqlValue, b: SqlValue) => number>,
): boolean {
	for (let i = 0; i < cmps.length; i++) {
		if (cmps[i](a[i], b[i]) !== 0) return false;
	}
	return true;
}

/**
 * Streaming runner. Processes one row at a time, yielding output rows once
 * their slot values are all finalised.
 */
async function* runStreaming(
	plan: WindowNode,
	functionSchemas: ReadonlyArray<WindowFunctionSchema>,
	rctx: RuntimeContext,
	source: AsyncIterable<Row>,
	sourceRowDescriptor: RowDescriptor,
	partitionCallbacks: ReadonlyArray<(ctx: RuntimeContext) => OutputValue>,
	orderByCallbacks: ReadonlyArray<(ctx: RuntimeContext) => OutputValue>,
	funcArgCallbackGroups: ReadonlyArray<ReadonlyArray<(ctx: RuntimeContext) => OutputValue>>,
	serializePartitionKey: (values: SqlValue[]) => string,
	orderByEqualityComparators: ReadonlyArray<(a: SqlValue, b: SqlValue) => number>,
): AsyncIterable<Row> {
	const streaming = plan.streaming!;
	const funcContexts: StreamingFunctionContext[] = plan.functions.map((_func, fi) => ({
		fi,
		schema: functionSchemas[fi],
		args: funcArgCallbackGroups[fi],
	}));
	const funcCount = plan.functions.length;

	// Frame mode for RANGE-vs-ROWS peer handling on running aggregates.
	// Default frame (with ORDER BY) is RANGE; explicit ROWS UNBOUNDED PRECEDING
	// suppresses peer-buffering.
	const frame = plan.windowSpec.frame;
	const isRangeMode = frame === undefined || frame.type === 'range';

	let curPartitionKey: string | null = null;
	let state: StreamingPartitionState | null = null;

	// We register our own source-attribute getter directly in the rctx context.
	// This bypasses the slot abstraction so we can fully control insertion
	// order. `promote()` delete-then-re-sets the entry, pushing it to the *end*
	// of the map's insertion order so it wins the `attributeIndex` for the
	// source attribute IDs at two moments: (a) while we evaluate our own
	// partition/order-by/arg callbacks against the current row, and (b) at the
	// instant we yield, so a downstream consumer (an outer Window, or a Project)
	// resolves source columns through the *yielded* row.
	//
	// But we must NOT leave that context winning while we pull the *next* source
	// row — see the "source-attr contexts and child pulls" invariant in
	// docs/runtime.md. Our `myDesc` shares the source's attribute IDs, and a
	// streaming child below us (e.g. a residual Filter) updates its own slot by
	// `set(row)` alone, which does not reclaim the index. If we stayed promoted
	// across the pull, the child would read *our* last-yielded row instead of
	// its current row (the same shadowing defect fixed in aggregate.ts). So we
	// `demote()` at the end of each iteration — tear-down-before-pull — letting
	// the deepest child win the index during the pull, then `promote()` again
	// when the next row arrives.
	//
	// Use a fresh descriptor reference (NOT `sourceRowDescriptor`) so we
	// occupy our own map slot rather than co-tenanting Window's outer
	// `sourceSlot` entry.
	const myDesc: RowDescriptor = [];
	for (const k in sourceRowDescriptor) {
		const idx = sourceRowDescriptor[+k];
		if (idx !== undefined) myDesc[+k] = idx;
	}
	const myRef = { current: undefined as Row | undefined };
	const myGetter = () => myRef.current!;
	let myRegistered = false;
	// Best-effort installer label for QUEREUS_CONTEXT_STRICT diagnostics (detection ignores it).
	const installer: ContextInstaller = { nodeType: plan.nodeType, id: plan.id };

	const promote = (row: Row): void => {
		myRef.current = row;
		// Move our entry to the end of the context map by deleting and re-adding.
		// `Map.set` on an existing key only updates the value; it does not move
		// the key. We need re-insertion to win attribute-index rebuilds
		// triggered by upstream `withAsyncRowContext` cycles.
		if (myRegistered) {
			rctx.context.delete(myDesc);
		}
		rctx.context.set(myDesc, myGetter, installer);
		myRegistered = true;
	};

	// Release our source-attr context so the child below reclaims the
	// attributeIndex during the next pull (tear-down-before-pull).
	const demote = (): void => {
		if (myRegistered) {
			rctx.context.delete(myDesc);
			myRegistered = false;
		}
	};

	try {
	for await (const row of source) {
		promote(row);

		// Resolve partition key. Sequential evaluation: parallel callbacks
		// that share a plan subtree would race on the shared inner-scan
		// RowSlot.
		const partitionValues: SqlValue[] = [];
		for (const cb of partitionCallbacks) {
			// Resolve without a per-row microtask hop (see runtime/async-util.ts).
			const rawP = cb(rctx);
			partitionValues.push((rawP instanceof Promise ? await rawP : rawP) as SqlValue);
		}
		const partitionKey = serializePartitionKey(partitionValues);

		// Resolve ORDER BY values (same shared-subtree concern as above).
		const orderByValues: SqlValue[] = [];
		for (const cb of orderByCallbacks) {
			// Resolve without a per-row microtask hop (see runtime/async-util.ts).
			const rawO = cb(rctx);
			orderByValues.push((rawO instanceof Promise ? await rawO : rawO) as SqlValue);
		}

		// Partition boundary: close out the previous partition.
		if (state !== null && partitionKey !== curPartitionKey) {
			yield* finalizePartition(state, funcContexts, isRangeMode, rctx, promote);
			promote(row);
			state = null;
		}

		if (state === null) {
			state = freshPartitionState(streaming.modes);
			curPartitionKey = partitionKey;
		}

		// Peer-group boundary detection (within the current partition).
		const isPeerOfPrev = state.lastOrderByValues !== null &&
			arePeers(orderByValues, state.lastOrderByValues, orderByEqualityComparators);

		// Closing the prior peer group fills RANGE-mode running-agg slots.
		if (state.lastOrderByValues !== null && !isPeerOfPrev) {
			closePeerGroup(state, funcContexts, isRangeMode);
		}

		// Update ranking-related counters BEFORE creating the new entry: row_number
		// and dense_rank are determined at row arrival.
		const rowIndex0Based = state.rowCount; // 0-based position in partition
		state.rowCount++;
		if (!isPeerOfPrev) {
			state.denseRankCounter++;
			state.currentRank = rowIndex0Based + 1;
		}

		// Pre-evaluate args[0] (the value expression) for each function. Done
		// inline because the source slot is set to the current row right now.
		const expr0Values: SqlValue[] = new Array(funcCount).fill(null);
		for (let fi = 0; fi < funcCount; fi++) {
			const fc = funcContexts[fi];
			if (fc.args.length >= 1) {
				expr0Values[fi] = await Promise.resolve(fc.args[0](rctx)) as SqlValue;
			}
		}

		// Numeric form of the leading ORDER BY value, used by RANGE-sliding.
		// SQL NULL must coerce to NaN (not `Number(null) === 0`) so the
		// non-finite-peer-span branch handles it correctly.
		const orderByLead = orderByValues.length > 0 ? orderByValues[0] : null;
		const orderByVal0Num = orderByLead === null ? NaN : Number(orderByLead);

		// Allocate a new queue entry for this row.
		const sourceColCount = (row as SqlValue[]).length;
		const outRow: SqlValue[] = new Array(sourceColCount + funcCount);
		for (let i = 0; i < sourceColCount; i++) outRow[i] = (row as SqlValue[])[i];
		for (let i = 0; i < funcCount; i++) outRow[sourceColCount + i] = null;
		const entry: StreamingRowEntry = {
			row: outRow,
			filled: new Array(funcCount).fill(false),
			pending: funcCount,
			funcSlotsStart: sourceColCount,
		};
		state.queue.push(entry);

		// Per-function update: fill what we can, defer the rest.
		for (let fi = 0; fi < funcCount; fi++) {
			const fs = state.funcStates[fi];
			const fc = funcContexts[fi];
			const argVal = expr0Values[fi];

			switch (fs.mode.kind) {
				case 'rowNumber':
					fillSlot(entry, fi, rowIndex0Based + 1);
					break;
				case 'rank':
					fillSlot(entry, fi, state.currentRank);
					break;
				case 'denseRank':
					fillSlot(entry, fi, state.denseRankCounter);
					break;
				case 'lag':
					await fillLag(entry, fi, fs, fc, argVal, rctx);
					break;
				case 'lead':
					handleLead(entry, fi, fs, argVal);
					break;
				case 'firstValue':
					if (!fs.firstValueCached!.cached) {
						fs.firstValueCached!.value = argVal;
						fs.firstValueCached!.cached = true;
					}
					fillSlot(entry, fi, fs.firstValueCached!.value);
					break;
				case 'lastValue':
					fillSlot(entry, fi, argVal);
					break;
				case 'runningAgg':
					stepRunningAgg(entry, fi, fs, fc, argVal, isRangeMode);
					break;
				case 'slidingAgg':
					handleSlidingArrival(entry, fc, fs, argVal, orderByVal0Num);
					break;
			}
		}

		state.lastOrderByValues = orderByValues;

		// Yield any front-queue entries that are now fully filled.
		// Promote our slot at the yielded row before yielding so downstream
		// attribute resolution sees the yielded row, not the row we're
		// currently processing.
		while (state.queue.length > 0 && state.queue[0].pending === 0) {
			const entry = state.queue.shift()!;
			const yieldedRow = entry.row as Row;
			promote(yieldedRow);
			yield yieldedRow;
		}

		// Tear down our source-attr context before pulling the next source row
		// so a streaming child (e.g. a residual Filter) reclaims the index and
		// reads its current row, not our last-yielded one.
		demote();
	}

	// Source exhausted: flush trailing partition (if any).
	if (state !== null) {
		yield* finalizePartition(state, funcContexts, isRangeMode, rctx, promote);
	}
	} finally {
		if (myRegistered) rctx.context.delete(myDesc);
	}
}

/** Mark slot `fi` of `entry` filled with `value`. Idempotent on already-filled slots. */
function fillSlot(entry: StreamingRowEntry, fi: number, value: SqlValue): void {
	if (entry.filled[fi]) return;
	entry.filled[fi] = true;
	entry.row[entry.funcSlotsStart + fi] = value;
	entry.pending--;
}

async function fillLag(
	entry: StreamingRowEntry,
	fi: number,
	fs: StreamingFuncState,
	fc: StreamingFunctionContext,
	currentArgVal: SqlValue,
	rctx: RuntimeContext,
): Promise<void> {
	const offset = (fs.mode as { kind: 'lag'; offset: number }).offset;
	const buf = fs.lagBuffer!;
	let lagged: SqlValue;
	// LAG with offset 0 returns current row's expr value.
	if (offset === 0) {
		lagged = currentArgVal;
	} else if (buf.length >= offset) {
		// buf holds the last `offset` evaluated arg values prior to this row.
		lagged = buf[buf.length - offset];
	} else {
		// Not enough history: use default if provided, else NULL.
		lagged = await evalLagLeadDefault(fc, rctx);
	}
	fillSlot(entry, fi, lagged);
	// Push current arg value into ring buffer; trim when oversized.
	buf.push(currentArgVal);
	if (buf.length > offset) buf.shift();
}

/** Evaluate a LAG/LEAD's optional default-value argument (args[2]) in the
 *  current source-slot context. Mirrors the buffered emitter, which also
 *  evaluates the default per-row in the current source context. */
async function evalLagLeadDefault(
	fc: StreamingFunctionContext,
	rctx: RuntimeContext,
): Promise<SqlValue> {
	if (fc.args.length < 3) return null;
	return await Promise.resolve(fc.args[2](rctx)) as SqlValue;
}

function handleLead(
	entry: StreamingRowEntry,
	fi: number,
	fs: StreamingFuncState,
	currentArgVal: SqlValue,
): void {
	const offset = (fs.mode as { kind: 'lead'; offset: number }).offset;
	if (offset === 0) {
		fillSlot(entry, fi, currentArgVal);
		return;
	}
	// When this is the offset+1-th entry in the queue, fill the head's lead
	// slot with the current row's expr value.
	const leadQ = fs.leadQueue!;
	if (leadQ.length >= offset) {
		const target = leadQ[leadQ.length - offset];
		fillSlot(target, fi, currentArgVal);
	}
	leadQ.push(entry);
	// Bound to offset+1: once we've filled an entry's slot, we no longer need to
	// keep it referenced.
	if (leadQ.length > offset) leadQ.shift();
}

function stepRunningAgg(
	entry: StreamingRowEntry,
	fi: number,
	fs: StreamingFuncState,
	fc: StreamingFunctionContext,
	argVal: SqlValue,
	isRangeMode: boolean,
): void {
	const schema = fc.schema;
	if (schema.step) {
		fs.aggAccumulator = schema.step(fs.aggAccumulator, argVal);
		fs.aggRowCount = (fs.aggRowCount ?? 0) + 1;
	}

	if (!isRangeMode) {
		// ROWS UNBOUNDED PRECEDING TO CURRENT ROW: each row gets its post-step
		// final value immediately.
		const finalValue = schema.final
			? schema.final(fs.aggAccumulator, fs.aggRowCount ?? 0)
			: (fs.aggAccumulator as SqlValue);
		fillSlot(entry, fi, finalValue);
		return;
	}

	// RANGE mode: defer until peer group closes. Track this entry as part of
	// the open peer group; we'll backfill at close.
	fs.pendingPeerEntries!.push(entry);
}

function closePeerGroup(
	state: StreamingPartitionState,
	funcContexts: ReadonlyArray<StreamingFunctionContext>,
	isRangeMode: boolean,
): void {
	if (!isRangeMode) return;
	for (let fi = 0; fi < funcContexts.length; fi++) {
		const fs = state.funcStates[fi];
		if (fs.mode.kind !== 'runningAgg') continue;
		const schema = funcContexts[fi].schema;
		const value = schema.final
			? schema.final(fs.aggAccumulator, fs.aggRowCount ?? 0)
			: (fs.aggAccumulator as SqlValue);
		const pending = fs.pendingPeerEntries!;
		for (const entry of pending) {
			fillSlot(entry, fi, value);
		}
		pending.length = 0;
	}
}

async function* finalizePartition(
	state: StreamingPartitionState,
	funcContexts: ReadonlyArray<StreamingFunctionContext>,
	isRangeMode: boolean,
	rctx: RuntimeContext,
	promote: (row: Row) => void,
): AsyncIterable<Row> {
	// Close trailing peer group (RANGE running aggs).
	closePeerGroup(state, funcContexts, isRangeMode);
	// Drain LEAD queues with default values for unfilled trailing entries.
	for (let fi = 0; fi < funcContexts.length; fi++) {
		const fs = state.funcStates[fi];
		if (fs.mode.kind !== 'lead') continue;
		const fc = funcContexts[fi];
		const offset = fs.mode.offset;
		if (offset === 0) continue;
		const leadQ = fs.leadQueue!;
		const def = await evalLagLeadDefault(fc, rctx);
		for (const entry of leadQ) {
			if (!entry.filled[fi]) {
				fillSlot(entry, fi, def);
			}
		}
	}
	// Finalize trailing pending entries for sliding-frame functions. Their
	// frames clamp at the partition end; values are computed from the
	// current sliding state.
	for (let fi = 0; fi < funcContexts.length; fi++) {
		const fs = state.funcStates[fi];
		if (fs.mode.kind !== 'slidingAgg') continue;
		finalizeSlidingTrailing(funcContexts[fi], fs);
	}
	// Yield queued entries in order. Promote our slot to each entry's row so
	// downstream attribute resolution sees the correct row.
	for (const entry of state.queue) {
		promote(entry.row as Row);
		yield entry.row as Row;
	}
	state.queue.length = 0;
}

// ============================================================================
// Sliding-frame helpers (slidingAgg mode)
// ============================================================================
//
// Activated when `rule-monotonic-window` recognizes
// `ROWS BETWEEN n PRECEDING AND m FOLLOWING` or
// `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING` (with literal
// non-negative offsets) over the supported aggregates / value functions.
//
// ROWS strategy (per function):
//   - `slidingBuffer` holds {argVal, orderByVal0} for rows with index in
//     [slidingHead, currentRow]; entries fall off the front as they age out
//     of the leftmost-pending entry's frame.
//   - SUM/COUNT/AVG: maintain a `{ sum, count }` accumulator with step+unstep;
//     skip null argVals (matches the schema's null-skipping semantics).
//   - MIN/MAX/FIRST_VALUE/LAST_VALUE: recompute from the buffer slice on each
//     finalize (acceptable for v1 — windows are typically small).
//   - Each pending entry is finalized when row `j + following` arrives
//     (mid-partition) or at partition close (right edge clamps to last row).
//
// RANGE strategy (per function):
//   - Bounds advance by ORDER BY value, not by row offset.
//   - Each pending entry tracks its `v_j` and a `rightClosed` flag flipped on
//     by a later arrival whose value strictly exceeds `v_j + following`.
//   - On finalize: scan the buffer for rows in [v_j - preceding, v_j +
//     following] (finite v_j) or for the contiguous non-finite peer span
//     (non-finite v_j); compute the aggregate by direct scan in v1 (no
//     incremental acc — keeps the code simple and handles non-finite v
//     entries cleanly).

function slidingStepNum(acc: { sum: number; count: number }, argVal: SqlValue): void {
	if (argVal === null) return;
	acc.sum += Number(argVal);
	acc.count += 1;
}

function slidingUnstepNum(acc: { sum: number; count: number }, argVal: SqlValue): void {
	if (argVal === null) return;
	acc.sum -= Number(argVal);
	acc.count -= 1;
}

function slidingFinalAcc(name: string, acc: { sum: number; count: number }): SqlValue {
	switch (name) {
		case 'sum': return acc.count === 0 ? null : acc.sum;
		case 'count': return acc.count;
		case 'avg': return acc.count === 0 ? null : acc.sum / acc.count;
		default: return null;
	}
}

/**
 * MIN/MAX over a sliding-frame buffer slice, folded through the BOUND schema's own
 * step/final rather than a local `<`. Reusing the schema is what keeps the sliding
 * fast path ranking identically to the buffered frame walk — both consume the
 * comparator `bindWindowSchema` installed at emit (semantic ordering for
 * TIMESPAN/JSON arguments, the declared collation for text, storage-class order
 * otherwise). `lo > hi` (empty slice) folds to the empty accumulator ⇒ NULL.
 */
function slidingScanExtremum(
	schema: WindowFunctionSchema,
	buf: SlidingBufEntry[],
	lo: number,
	hi: number,
): SqlValue {
	if (!schema.step) return null;
	let acc: unknown = null;
	let rowCount = 0;
	for (let k = lo; k <= hi; k++) {
		acc = schema.step(acc, buf[k].argVal);
		rowCount++;
	}
	return schema.final ? schema.final(acc, rowCount) : acc as SqlValue;
}

function slidingScanCountNonNull(buf: SlidingBufEntry[], lo: number, hi: number): number {
	let n = 0;
	for (let k = lo; k <= hi; k++) {
		if (buf[k].argVal !== null) n++;
	}
	return n;
}

function slidingScanSum(buf: SlidingBufEntry[], lo: number, hi: number): { sum: number; count: number } {
	let sum = 0, count = 0;
	for (let k = lo; k <= hi; k++) {
		const v = buf[k].argVal;
		if (v === null) continue;
		sum += Number(v);
		count += 1;
	}
	return { sum, count };
}

/** Per-row dispatch for slidingAgg functions. `fc` carries the emit-time-bound
 *  registry schema, consulted by the MIN/MAX scans. */
function handleSlidingArrival(
	entry: StreamingRowEntry,
	fc: StreamingFunctionContext,
	fs: StreamingFuncState,
	argVal: SqlValue,
	orderByVal0Num: number,
): void {
	const m = fs.mode as Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>;
	fs.slidingBuffer!.push({ argVal, orderByVal0: orderByVal0Num });
	if (m.frameMode === 'rows') {
		handleSlidingRowsArrival(entry, fc, fs, m, argVal);
	} else {
		handleSlidingRangeArrival(entry, fc, fs, m, orderByVal0Num);
	}
}

// ----- ROWS sliding -----

function handleSlidingRowsArrival(
	entry: StreamingRowEntry,
	fc: StreamingFunctionContext,
	fs: StreamingFuncState,
	m: Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>,
	argVal: SqlValue,
): void {
	if (m.name === 'sum' || m.name === 'count' || m.name === 'avg') {
		slidingStepNum(fs.slidingAcc!, argVal);
	}
	fs.slidingPending!.push(entry);
	while (fs.slidingPending!.length > m.following) {
		finalizeSlidingRowsEntry(fc, fs, m);
	}
}

function finalizeSlidingRowsEntry(
	fc: StreamingFunctionContext,
	fs: StreamingFuncState,
	m: Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>,
): void {
	const j = fs.slidingNextFinalizeIdx!;
	const targetLeft = Math.max(0, j - m.preceding);
	// Trim left: rows that have aged out of the next-pending entry's frame.
	while (fs.slidingHead! < targetLeft) {
		if (m.name === 'sum' || m.name === 'count' || m.name === 'avg') {
			slidingUnstepNum(fs.slidingAcc!, fs.slidingBuffer![0].argVal);
		}
		fs.slidingBuffer!.shift();
		fs.slidingHead!++;
	}
	const buf = fs.slidingBuffer!;
	const lo = 0;
	const hi = buf.length - 1;
	let value: SqlValue;
	switch (m.name) {
		case 'sum':
		case 'count':
		case 'avg':
			value = slidingFinalAcc(m.name, fs.slidingAcc!);
			break;
		case 'min':
		case 'max':
			value = slidingScanExtremum(fc.schema, buf, lo, hi);
			break;
		case 'first_value':
			value = lo > hi ? null : buf[lo].argVal;
			break;
		case 'last_value':
			value = lo > hi ? null : buf[hi].argVal;
			break;
		default:
			value = null;
	}
	const targetEntry = fs.slidingPending!.shift()!;
	fillSlot(targetEntry, fc.fi, value);
	fs.slidingNextFinalizeIdx!++;
}

// ----- RANGE sliding -----

function handleSlidingRangeArrival(
	entry: StreamingRowEntry,
	fc: StreamingFunctionContext,
	fs: StreamingFuncState,
	m: Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>,
	orderByVal0Num: number,
): void {
	const isFinite = Number.isFinite(orderByVal0Num);
	const pending = fs.slidingRangePending!;
	pending.push({ entry, v_j: orderByVal0Num, isFinite, rightClosed: false });

	// Mark right-closed for any pending entry whose right edge has now been
	// strictly exceeded by this arrival. Walking front-to-back: once an
	// existing entry is right-closed, we can stop (since pending is in
	// arrival order and v's are sorted).
	for (const p of pending) {
		if (p.rightClosed) continue;
		if (!p.isFinite) {
			// Non-finite entry: closes once a finite-v row arrives (the
			// non-finite peer span ends).
			if (isFinite) p.rightClosed = true;
		} else {
			if (isFinite && orderByVal0Num > p.v_j + m.following) p.rightClosed = true;
			// Finite entry followed by a non-finite arrival doesn't close it
			// (might still see more finite rows in the same partition — but
			// since the source is monotonic, finite never follows non-finite
			// in practice).
		}
	}

	while (pending.length > 0 && pending[0].rightClosed) {
		finalizeSlidingRangeEntry(fc, fs, m);
	}
}

/**
 * Find the buffer index range that constitutes the finite-v window
 * [v_j - preceding, v_j + following]. Returns lo > hi for an empty range
 * (shouldn't happen for finite v_j because v_j itself is in scope).
 */
function findRangeWindow(
	buf: SlidingBufEntry[],
	v_j: number,
	preceding: number,
	following: number,
): { lo: number; hi: number } {
	const left = v_j - preceding;
	const right = v_j + following;
	let lo = -1, hi = -1;
	for (let k = 0; k < buf.length; k++) {
		const v = buf[k].orderByVal0;
		if (!Number.isFinite(v)) continue;
		if (v < left) continue;
		if (v > right) break; // buffer is in v-sorted order for finite v
		if (lo < 0) lo = k;
		hi = k;
	}
	return { lo, hi };
}

/**
 * Find the contiguous non-finite peer span around the given pending entry's
 * row in the buffer. The span is the maximal run of consecutive non-finite-v
 * rows in `buf` that includes `entryIdx` (or the latest non-finite row, if
 * the entry has already been shifted out).
 */
function findNonFinitePeerSpan(buf: SlidingBufEntry[]): { lo: number; hi: number } {
	// Find the run that contains the entry. For monotonic input, non-finite
	// rows cluster at edges. We look for any non-finite run.
	let lo = -1, hi = -1;
	for (let k = 0; k < buf.length; k++) {
		if (!Number.isFinite(buf[k].orderByVal0)) {
			if (lo < 0) lo = k;
			hi = k;
		}
	}
	return { lo, hi };
}

function finalizeSlidingRangeEntry(
	fc: StreamingFunctionContext,
	fs: StreamingFuncState,
	m: Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>,
): void {
	const pending = fs.slidingRangePending!;
	const head = pending[0];
	const buf = fs.slidingBuffer!;
	let lo: number, hi: number;
	if (head.isFinite) {
		({ lo, hi } = findRangeWindow(buf, head.v_j, m.preceding, m.following));
	} else {
		({ lo, hi } = findNonFinitePeerSpan(buf));
	}

	let value: SqlValue;
	if (lo < 0 || hi < 0 || lo > hi) {
		// Empty frame: SUM/MIN/MAX/FIRST/LAST return NULL, COUNT returns 0.
		value = m.name === 'count' ? 0 : null;
	} else {
		switch (m.name) {
			case 'sum': {
				const r = slidingScanSum(buf, lo, hi);
				value = r.count === 0 ? null : r.sum;
				break;
			}
			case 'count':
				value = slidingScanCountNonNull(buf, lo, hi);
				break;
			case 'avg': {
				const r = slidingScanSum(buf, lo, hi);
				value = r.count === 0 ? null : r.sum / r.count;
				break;
			}
			case 'min':
			case 'max':
				value = slidingScanExtremum(fc.schema, buf, lo, hi);
				break;
			case 'first_value':
				value = buf[lo].argVal;
				break;
			case 'last_value':
				value = buf[hi].argVal;
				break;
			default:
				value = null;
		}
	}
	fillSlot(head.entry, fc.fi, value);
	pending.shift();

	// Trim buffer rows that no remaining pending entry needs.
	trimSlidingRangeBuffer(fs, m);
}

function trimSlidingRangeBuffer(
	fs: StreamingFuncState,
	m: Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>,
): void {
	const pending = fs.slidingRangePending!;
	const buf = fs.slidingBuffer!;
	if (pending.length === 0) {
		buf.length = 0;
		return;
	}
	// Find the smallest left edge across remaining pending entries. For
	// finite pending entries, left = v_p - preceding. Pending is in arrival
	// (v-sorted) order, so the front entry has the smallest left.
	let minFiniteLeft: number | null = null;
	let anyNonFinitePending = false;
	for (const p of pending) {
		if (p.isFinite) {
			const left = p.v_j - m.preceding;
			if (minFiniteLeft === null || left < minFiniteLeft) minFiniteLeft = left;
		} else {
			anyNonFinitePending = true;
		}
	}
	// Trim front rows that are outside any pending entry's frame.
	while (buf.length > 0) {
		const v0 = buf[0].orderByVal0;
		if (!Number.isFinite(v0)) {
			// Drop leading non-finite rows only if no non-finite pending entry
			// would still need them.
			if (anyNonFinitePending) break;
			buf.shift();
			continue;
		}
		// Finite row: drop if smaller than every pending finite entry's left.
		if (minFiniteLeft === null) {
			// Only non-finite pending entries remain; finite rows aren't in
			// any of their frames.
			buf.shift();
			continue;
		}
		if (v0 < minFiniteLeft) {
			buf.shift();
			continue;
		}
		break;
	}
}

function finalizeSlidingTrailing(fc: StreamingFunctionContext, fs: StreamingFuncState): void {
	const m = fs.mode as Extract<StreamingFuncState['mode'], { kind: 'slidingAgg' }>;
	if (m.frameMode === 'rows') {
		while (fs.slidingPending!.length > 0) {
			finalizeSlidingRowsEntry(fc, fs, m);
		}
	} else {
		while (fs.slidingRangePending!.length > 0) {
			finalizeSlidingRangeEntry(fc, fs, m);
		}
	}
}

