import type { IndexConstraintOp } from '../../../common/constants.js';
import type { SqlValue } from '../../../common/types.js';
import type { BTreeKey } from '../types.js';
import type { FilterInfo } from '../../filter-info.js';
import type { TableSchema } from '../../../schema/table.js';
import type { IndexColumnSchema, PrimaryKeyColumnDefinition } from '../../../schema/table.js';
import type { IndexConstraint, IndexInfo } from '../../index-info.js';
import { IndexConstraintOp as ActualIndexConstraintOp } from '../../../common/constants.js';
import { normalizeCollationName } from '../../../util/comparison.js';
import { decodeIdxStr } from '../../idx-str.js';
import { PRIMARY_INDEX_NAME } from '../../index-descriptor.js';

/** Describes an equality constraint for a scan plan */
export interface ScanPlanEqConstraint {
	op: IndexConstraintOp.EQ;
	value: BTreeKey; // Can be composite for multi-column EQ
}

/** Describes a range bound for a scan plan */
export interface ScanPlanRangeBound {
	op: IndexConstraintOp.GT | IndexConstraintOp.GE | IndexConstraintOp.LT | IndexConstraintOp.LE;
	value: SqlValue; // Range bounds typically apply to the first column
}

/** Describes a single range for multi-range OR scans */
export interface ScanPlanRange {
	lowerBound?: ScanPlanRangeBound;
	upperBound?: ScanPlanRangeBound;
}

/**
 * Encapsulates the details needed to execute a scan across layers.
 * Derived from IndexInfo during xBestIndex/xFilter.
 */
export interface ScanPlan {
	/** Name of the index to scan ('primary' or secondary index name) */
	indexName: string | 'primary';
	/** Scan direction */
	descending: boolean;
	/** Specific key for an equality scan (used if planType is EQ) */
	equalityKey?: BTreeKey;
	/** Multiple keys for IN-list multi-seek (used instead of equalityKey) */
	equalityKeys?: BTreeKey[];
	/** Equality prefix values for prefix-range scans (plan=7) */
	equalityPrefix?: SqlValue[];
	/**
	 * Per-column collations parallel to {@link equalityPrefix}, used so the
	 * prefix-equality match honours the index column's declared collation rather
	 * than a BINARY compare. Undefined (or an undefined entry) ⇒ BINARY.
	 */
	equalityPrefixCollations?: string[];
	/**
	 * Declared collation of the range-bound column — the leading column for a plain
	 * range, the trailing column for a prefix-range. Threaded into the runtime bound
	 * filter and early-termination (`plan-filter.ts` / `scan-layer.ts`) so a
	 * non-BINARY range seek visits exactly the collation-correct window instead of
	 * under-fetching case/space variants. Undefined ⇒ BINARY.
	 */
	boundCollation?: string;
	/** Lower bound for a range scan (used if planType is RANGE_*) */
	lowerBound?: ScanPlanRangeBound;
	/** Upper bound for a range scan (used if planType is RANGE_*) */
	upperBound?: ScanPlanRangeBound;
	/** Multiple ranges for OR-range multi-seek (plan=6) */
	ranges?: ScanPlanRange[];
	/** The original idxNum from xBestIndex, potentially useful for cursor logic */
	idxNum?: number;
	/** The original idxStr from xBestIndex, potentially useful for debugging */
	idxStr?: string | null;
}

interface IndexSchemaLike {
	name: string;
	columns: ReadonlyArray<IndexColumnSchema | PrimaryKeyColumnDefinition>;
}

type ArgvMap = ReadonlyMap<number, number>;

/** No decoded parameters — shared so the degenerate path allocates nothing. */
const NO_PARAMS: ReadonlyMap<string, string> = new Map();

function parseArgvMappings(raw: string | undefined): Map<number, number> {
	const mappings = new Map<number, number>();
	if (!raw) return mappings;

	const pairPattern = /\[(\d+),(\d+)\]/g;
	let match: RegExpExecArray | null;
	while ((match = pairPattern.exec(raw)) !== null) {
		const queryArgIdx = parseInt(match[1]);
		const constraintArrIdx = parseInt(match[2]);
		mappings.set(queryArgIdx, constraintArrIdx);
	}
	return mappings;
}

function resolveIndexSchema(
	indexName: string | 'primary',
	tableSchema: TableSchema,
): IndexSchemaLike | undefined {
	if (indexName === 'primary') {
		return {
			name: '_primary_',
			columns: tableSchema.primaryKeyDefinition,
		};
	}
	return tableSchema.indexes?.find(idx => idx.name === indexName);
}

function isDescendingScan(params: ReadonlyMap<string, string>, planType: number): boolean {
	return params.get('ordCons') === 'DESC' || planType === 1 || planType === 4;
}

/**
 * Resolves the declared collation of the index column at `position`, normalized,
 * or undefined when there is no index schema (⇒ BINARY at compare time). Both
 * {@link IndexColumnSchema} and {@link PrimaryKeyColumnDefinition} carry an optional
 * `collation`, so this works uniformly for secondary indexes and the primary key.
 */
function resolveColumnCollation(indexSchema: IndexSchemaLike | undefined, position: number): string | undefined {
	const col = indexSchema?.columns[position];
	return col?.collation ? normalizeCollationName(col.collation) : undefined;
}

function findArgValueForColumn(
	columnIndex: number,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	indexInfoOutput: IndexInfo,
): SqlValue | undefined {
	for (const [queryArgIdx, constraintArrIdx] of argvMap) {
		const constraint = indexInfoOutput.aConstraint[constraintArrIdx];
		if (constraint?.iColumn === columnIndex && constraint.op === ActualIndexConstraintOp.EQ) {
			return args[queryArgIdx - 1];
		}
	}
	return undefined;
}

function findConstraintValueForColumn(
	columnIndex: number,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	args: ReadonlyArray<SqlValue>,
): SqlValue | undefined {
	for (const entry of constraints) {
		if (
			entry.constraint.iColumn === columnIndex &&
			entry.constraint.op === ActualIndexConstraintOp.EQ &&
			entry.argvIndex > 0
		) {
			return args[entry.argvIndex - 1];
		}
	}
	return undefined;
}

function buildEqualityKey(
	indexName: string | 'primary',
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
	tableSchema: TableSchema,
): BTreeKey | undefined {
	const isSingleColumnPrimary = indexName === 'primary'
		&& args.length === 1
		&& argvMap.size === 1
		&& tableSchema.primaryKeyDefinition.length <= 1;

	if (isSingleColumnPrimary) return args[0];

	return buildCompositeEqualityKey(indexSchema, argvMap, args, constraints, indexInfoOutput);
}

function buildCompositeEqualityKey(
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
): BTreeKey | undefined {
	const keyParts: SqlValue[] = [];

	for (const colSpec of indexSchema.columns) {
		const argValue = findArgValueForColumn(colSpec.index, argvMap, args, indexInfoOutput);
		if (argValue !== undefined) {
			keyParts.push(argValue);
			continue;
		}

		const constraintValue = findConstraintValueForColumn(colSpec.index, constraints, args);
		if (constraintValue !== undefined) {
			keyParts.push(constraintValue);
			continue;
		}

		return undefined;
	}

	if (keyParts.length === 0) return undefined;
	return keyParts.length === 1 && indexSchema.columns.length === 1
		? keyParts[0]
		: keyParts;
}

function isLowerBoundOp(op: IndexConstraintOp): op is typeof ActualIndexConstraintOp.GT | typeof ActualIndexConstraintOp.GE {
	return op === ActualIndexConstraintOp.GT || op === ActualIndexConstraintOp.GE;
}

function isUpperBoundOp(op: IndexConstraintOp): op is typeof ActualIndexConstraintOp.LT | typeof ActualIndexConstraintOp.LE {
	return op === ActualIndexConstraintOp.LT || op === ActualIndexConstraintOp.LE;
}

function extractRangeBoundsForColumn(
	targetColumnIndex: number,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
): { lowerBound?: ScanPlanRangeBound; upperBound?: ScanPlanRangeBound } {
	let lowerBound: ScanPlanRangeBound | undefined;
	let upperBound: ScanPlanRangeBound | undefined;

	const applyBound = (op: IndexConstraintOp, value: SqlValue) => {
		if (isLowerBoundOp(op)) {
			if (!lowerBound || op === ActualIndexConstraintOp.GT) {
				lowerBound = { value, op };
			}
		} else if (isUpperBoundOp(op)) {
			if (!upperBound || op === ActualIndexConstraintOp.LT) {
				upperBound = { value, op };
			}
		}
	};

	for (const [queryArgIdx, constraintArrIdx] of argvMap) {
		const constraint = indexInfoOutput.aConstraint[constraintArrIdx];
		if (constraint?.iColumn === targetColumnIndex) {
			applyBound(constraint.op, args[queryArgIdx - 1]);
		}
	}

	for (const entry of constraints) {
		if (entry.constraint.iColumn === targetColumnIndex && entry.argvIndex > 0) {
			applyBound(entry.constraint.op, args[entry.argvIndex - 1]);
		}
	}

	return { lowerBound, upperBound };
}

function extractRangeBounds(
	indexSchema: IndexSchemaLike,
	argvMap: ArgvMap,
	args: ReadonlyArray<SqlValue>,
	constraints: ReadonlyArray<{ constraint: IndexConstraint; argvIndex: number }>,
	indexInfoOutput: IndexInfo,
): { lowerBound?: ScanPlanRangeBound; upperBound?: ScanPlanRangeBound } {
	const firstColumn = indexSchema.columns[0];
	if (!firstColumn) return {};
	return extractRangeBoundsForColumn(firstColumn.index, argvMap, args, constraints, indexInfoOutput);
}

export function buildScanPlanFromFilterInfo(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan {
	const { idxNum, idxStr, constraints, args, indexInfoOutput } = filterInfo;

	// An idxStr that names no index (null, `fullscan`, `empty`, or any string this
	// engine never emitted) degenerates to an unbounded primary-key walk — the
	// behaviour this builder has always had for an unparseable idxStr.
	const spec = decodeIdxStr(idxStr);
	const params = spec?.params ?? NO_PARAMS;
	const indexName: string | 'primary' = spec
		? (spec.indexName === PRIMARY_INDEX_NAME ? 'primary' : spec.indexName)
		: 'primary';
	const planType = spec?.plan ?? 0;
	const descending = isDescendingScan(params, planType);
	const argvMap = parseArgvMappings(params.get('argvMap'));
	const indexSchema = resolveIndexSchema(indexName, tableSchema);

	let equalityKey: BTreeKey | undefined;
	let equalityKeys: BTreeKey[] | undefined;
	let lowerBound: ScanPlanRangeBound | undefined;
	let upperBound: ScanPlanRangeBound | undefined;
	let boundCollation: string | undefined;

	const isEqPlan = planType === 2;
	const isMultiSeekPlan = planType === 5;
	const isRangePlan = planType === 3 || planType === 4;
	const isPrefixRangePlan = planType === 7;
	const isMultiRangePlan = planType === 6;

	if (isMultiRangePlan) {
		const rangeCount = parseInt(params.get('rangeCount') ?? '0', 10);
		const rangeOpsStr = params.get('rangeOps') ?? '';
		const rangeOpsList = rangeOpsStr.split(',');
		const ranges: ScanPlanRange[] = [];
		let argIdx = 0;

		for (let i = 0; i < rangeCount; i++) {
			const ops = (rangeOpsList[i] ?? '').split(':');
			const range: ScanPlanRange = {};

			for (const op of ops) {
				if (op === 'gt' || op === 'ge') {
					range.lowerBound = {
						op: op === 'ge' ? ActualIndexConstraintOp.GE : ActualIndexConstraintOp.GT,
						value: args[argIdx],
					};
					argIdx++;
				} else if (op === 'lt' || op === 'le') {
					range.upperBound = {
						op: op === 'le' ? ActualIndexConstraintOp.LE : ActualIndexConstraintOp.LT,
						value: args[argIdx],
					};
					argIdx++;
				}
			}

			ranges.push(range);
		}

		// Every range bounds the leading index column, so they share its collation.
		const boundCollation = resolveColumnCollation(indexSchema, 0);
		return { indexName, descending, ranges, boundCollation, idxNum, idxStr };
	}

	if (isPrefixRangePlan && indexSchema) {
		const prefixLen = parseInt(params.get('prefixLen') ?? '0', 10);
		// Build equality prefix from the first prefixLen columns, tracking each
		// column's collation in parallel so the runtime prefix match honours it.
		const prefix: SqlValue[] = [];
		const equalityPrefixCollations: string[] = [];
		for (let i = 0; i < prefixLen; i++) {
			const colSpec = indexSchema.columns[i];
			if (!colSpec) break;
			const val = findArgValueForColumn(colSpec.index, argvMap, args, indexInfoOutput)
				?? findConstraintValueForColumn(colSpec.index, constraints, args);
			if (val !== undefined) {
				prefix.push(val);
				equalityPrefixCollations.push(resolveColumnCollation(indexSchema, i) ?? 'BINARY');
			}
		}
		// Extract range bounds for the trailing column (the one after the prefix)
		const trailingCol = indexSchema.columns[prefixLen];
		if (trailingCol) {
			({ lowerBound, upperBound } = extractRangeBoundsForColumn(
				trailingCol.index, argvMap, args, constraints, indexInfoOutput,
			));
		}
		const boundCollation = resolveColumnCollation(indexSchema, prefixLen);
		return {
			indexName, descending, equalityPrefix: prefix, equalityPrefixCollations,
			boundCollation, lowerBound, upperBound, idxNum, idxStr,
		};
	} else if (isEqPlan && indexSchema) {
		equalityKey = buildEqualityKey(
			indexName, indexSchema, argvMap, args, constraints, indexInfoOutput, tableSchema,
		);
	} else if (isMultiSeekPlan && indexSchema) {
		// Multi-seek: args are individual lookup keys (single-col) or flattened composite keys
		const inCount = parseInt(params.get('inCount') ?? '0', 10);
		const seekWidth = parseInt(params.get('seekWidth') ?? '1', 10);
		if (inCount > 0 && args.length >= inCount * seekWidth) {
			if (seekWidth === 1) {
				// Single-column: each arg is one key
				equalityKeys = args.slice(0, inCount) as BTreeKey[];
			} else {
				// Composite: group args into composite keys
				equalityKeys = [];
				for (let i = 0; i < inCount; i++) {
					const start = i * seekWidth;
					const key = args.slice(start, start + seekWidth) as SqlValue[];
					equalityKeys.push(key.length === 1 ? key[0] : key);
				}
			}
		}
	} else if (isRangePlan && indexSchema) {
		({ lowerBound, upperBound } = extractRangeBounds(
			indexSchema, argvMap, args, constraints, indexInfoOutput,
		));
		// Range bounds apply to the leading index column (see extractRangeBounds).
		boundCollation = resolveColumnCollation(indexSchema, 0);
	}

	return { indexName, descending, equalityKey, equalityKeys, lowerBound, upperBound, boundCollation, idxNum, idxStr };
}
