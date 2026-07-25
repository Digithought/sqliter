import type { ScanPlan } from './scan-plan.js';
import type { BTreeKey } from '../types.js';
import type { SqlValue } from '../../../common/types.js';
import type { TableSchema, IndexColumnSchema, PrimaryKeyColumnDefinition } from '../../../schema/table.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { BINARY_COLLATION, compareSqlValuesFast, createTypedComparator } from '../../../util/comparison.js';
import type { CollationResolver } from '../../../types/logical-type.js';

/** Scalar comparator over two SQL values (-1/0/1). */
type ValueComparator = (a: SqlValue, b: SqlValue) => number;

/**
 * The per-column comparators a {@link ScanPlan}'s bound / prefix checks run under.
 * A `ScanPlan` stays plain data (it is logged and compared as such), so the
 * name→function resolution and comparator construction happen once per scan and the
 * result is threaded to every per-row comparison. Resolving inside the row loop
 * would add a registry lookup per row and regress `test/performance-sentinels.spec.ts`.
 *
 * Each comparator is built with the SAME construction the scanned BTree's own key
 * comparator uses — `createTypedComparator(columnLogicalType, collationFunc)`, see
 * `utils/primary-key.ts` and `MemoryIndex` — so the residual bound filter and the
 * early-termination checks agree with the tree's physical order. Diverging here is
 * how range scans silently return empty windows: e.g. a TIMESPAN PK tree is ordered
 * by elapsed time, and filtering its walk with text-order compares excludes every
 * key the seek correctly positioned on.
 */
export interface ResolvedScanComparators {
	/** Parallel to {@link ScanPlan.equalityPrefix}. */
	readonly equalityPrefix: readonly ValueComparator[];
	/** Comparator for the range-bound column (leading column, or the column after the equality prefix). */
	readonly bound: ValueComparator;
}

/**
 * The scanned index's column definitions: the PK definition for the primary tree
 * (falling back to the all-columns synthesized PK exactly as `createPrimaryKeyFunctions`
 * does), or the named secondary index's columns. Undefined when the plan names an
 * index the schema does not know — comparisons then fall back to storage-class +
 * collation ordering, matching the degenerate unbounded walk such plans produce.
 */
function resolveIndexColumns(
	indexName: string | 'primary',
	schema: TableSchema,
): ReadonlyArray<IndexColumnSchema | PrimaryKeyColumnDefinition> | undefined {
	if (indexName === 'primary') {
		return schema.primaryKeyDefinition
			?? schema.columns.map((col, index) => ({ index, collation: col.collation || 'BINARY' }));
	}
	return schema.indexes?.find(idx => idx.name === indexName)?.columns;
}

/**
 * Resolves a plan's declared collation names and the scanned index's column logical
 * types into ready-to-run comparators, once, ahead of the scan. Throws (via the
 * resolver) if the plan names a collation that is not registered — an unresolvable
 * collation is never downgraded to BINARY.
 *
 * NOTE: this runs once per `scanLayer` call, not per row. A plain BINARY plan (the
 * common case) costs one empty array and a couple of closures. If per-scan setup
 * ever shows up on a workload of very many tiny scans, memoize the result on the
 * plan object via a `WeakMap` keyed by `ScanPlan`.
 */
export function resolveScanComparators(
	plan: ScanPlan,
	schema: TableSchema,
	collationResolver: CollationResolver,
): ResolvedScanComparators {
	const indexColumns = resolveIndexColumns(plan.indexName, schema);

	const comparatorAt = (position: number, collationName: string | undefined): ValueComparator => {
		const collationFunc = collationName ? collationResolver(collationName) : BINARY_COLLATION;
		const columnDef = indexColumns?.[position];
		const logicalType = columnDef ? schema.columns[columnDef.index]?.logicalType : undefined;
		// Mirror the tree's key comparator construction exactly (see interface doc).
		return logicalType
			? createTypedComparator(logicalType, collationFunc)
			: (a, b) => compareSqlValuesFast(a, b, collationFunc);
	};

	const equalityPrefix = (plan.equalityPrefix ?? []).map((_, i) =>
		comparatorAt(i, plan.equalityPrefixCollations?.[i]));
	// The range bound applies to the leading index column, or — for a prefix-range
	// plan — to the column immediately after the equality prefix (see scan-plan.ts).
	const bound = comparatorAt(plan.equalityPrefix?.length ?? 0, plan.boundCollation);
	return { equalityPrefix, bound };
}

/**
 * Checks whether a given BTree key satisfies the constraints in a ScanPlan.
 * Handles equality, prefix-range, and simple bound constraints.
 */
export function planAppliesToKey(
	plan: ScanPlan,
	key: BTreeKey,
	keyComparator: (a: BTreeKey, b: BTreeKey) => number,
	comparators: ResolvedScanComparators,
): boolean {
	if (plan.equalityKey != null) {
		return keyComparator(key, plan.equalityKey) === 0;
	}

	// A NULL seek value admits no key: `v <op> NULL` and `v = NULL` are NULL,
	// never true. Reachable when a parameter or correlated value binds NULL at
	// runtime — plan-time literal NULLs never get here (constraint extraction
	// declines range bounds; the access-path rule emits EmptyResult for seeks).
	// Without this, the key comparators rank every key above a NULL bound (key
	// ordering), so `col > ?` bound to NULL would admit every row, and a NULL
	// prefix component would equality-match stored NULL index entries.
	if (plan.lowerBound?.value === null || plan.upperBound?.value === null) return false;
	if (plan.equalityPrefix?.some(v => v === null)) return false;

	// Prefix-range: check prefix equality + trailing column bounds. The prefix and
	// bound compares run under the index columns' typed comparators (resolved once per
	// scan into `comparators`) so a non-BINARY or semantically-ordered seek matches
	// exactly the window the tree's order defines.
	if (plan.equalityPrefix) {
		const keyArr = Array.isArray(key) ? key : [key];
		for (let i = 0; i < plan.equalityPrefix.length; i++) {
			if (comparators.equalityPrefix[i](keyArr[i], plan.equalityPrefix[i]) !== 0) return false;
		}
		const trailingValue = keyArr[plan.equalityPrefix.length];
		// A NULL trailing value never satisfies a range comparison (`NULL <op> v` is
		// NULL, never true), so exclude it when a trailing bound is present. The seek
		// covers the predicate (no residual `Filter` is kept above it), so this filter
		// is what enforces the bound's NULL semantics. `undefined` means the key tuple
		// is shorter than the prefix+1 (column absent), which the bound cannot constrain.
		if (trailingValue === null && (plan.lowerBound || plan.upperBound)) return false;
		if (trailingValue !== undefined && trailingValue !== null) {
			if (plan.lowerBound) {
				const cmp = comparators.bound(trailingValue, plan.lowerBound.value);
				if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
			}
			if (plan.upperBound) {
				const cmp = comparators.bound(trailingValue, plan.upperBound.value);
				if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
			}
		}
		return true;
	}

	const keyForBoundComparison = Array.isArray(key) ? key[0] : key;
	// A NULL bound-column value never satisfies a range comparison (`NULL <op> v` is
	// NULL, never true), so a NULL key is excluded whenever a range bound is present.
	// The seek covers the predicate (the planner drops the residual `Filter`), so this
	// is what enforces the bound's NULL semantics — without it a pure upper-bound seek
	// walks the leading NULL block and yields it. `undefined` (column absent from a
	// short key tuple) stays lenient, as the bound cannot constrain a missing column.
	if (keyForBoundComparison === null && (plan.lowerBound || plan.upperBound)) return false;
	if (plan.lowerBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = comparators.bound(keyForBoundComparison, plan.lowerBound.value);
		if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
	}
	if (plan.upperBound && (keyForBoundComparison !== undefined && keyForBoundComparison !== null)) {
		const cmp = comparators.bound(keyForBoundComparison, plan.upperBound.value);
		if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
	}
	return true;
}
