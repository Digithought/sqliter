import { IndexConstraintOp } from '../common/constants.js';
import type { SqlValue } from '../common/types.js';
import type { IndexConstraint, IndexInfo } from './index-info.js';
import type { AccessPath, IndexDescriptor } from './index-descriptor.js';
import { encodeIdxStr, makeIdxStrSpec, retargetIdxStr } from './idx-str.js';

/**
 * Structure to pass all necessary filter and planning information
 * to a virtual table's xOpen method when cursors are not used.
 */
export interface FilterInfo {
	/** The index number chosen by xBestIndex (output of xBestIndex) */
	idxNum: number;
	/** The index string chosen by xBestIndex (output of xBestIndex) */
	idxStr: string | null;
	/** Array of WHERE clause constraints (input to xBestIndex/xOpen) */
	constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>;
	/** Values for ?. argvIndex in constraints (input to xOpen) */
	args: ReadonlyArray<SqlValue>;
	/**
	 * The IndexInfo object AFTER xBestIndex has populated its output fields
	 * (aConstraintUsage, orderByConsumed, estimatedCost, estimatedRows, idxFlags).
	 * This is needed by xOpen to understand how constraints were used by the planner.
	 */
	indexInfoOutput: IndexInfo;

	/**
	 * Structured description of the access path this FilterInfo drives — the typed,
	 * validated form of what `idxStr` encodes as text. Populated by
	 * `rule-select-access-path`; consumers should read this rather than parse `idxStr`.
	 *
	 * Absent ⇒ this FilterInfo was hand-built by a caller that declared no access path.
	 * A consumer that needs the access path MUST fail loudly rather than infer one from
	 * `idxStr`; the engine's own builders below always populate it.
	 */
	readonly accessPath?: AccessPath;

	/**
	 * If set, the access plan honors a soft row cap — the vtab should stop
	 * emitting after this many rows. Pushed down by OrdinalSlice / future
	 * limit-pushdown rules. Modules without limit-pushdown support may ignore
	 * this; a downstream slice operator will still enforce the cap.
	 */
	limit?: number;

	/**
	 * If set, the access plan walks its monotonic index and seeks directly
	 * to the kth row in monotonic order before emitting. Only honored when
	 * the chosen access plan advertised `supportsOrdinalSeek`; otherwise the
	 * field must be ignored (a slice operator above will buffer-and-discard).
	 */
	offset?: number;
}

/** The `idxStr` sentinel meaning "no index chosen — walk every row". */
const FULL_SCAN_IDX_STR = 'fullscan';

/** The `idxStr` sentinel meaning "the predicate is unsatisfiable — emit no rows". */
const EMPTY_IDX_STR = 'empty';

/**
 * FilterInfo for a full table scan: no constraints, no index.
 *
 * Shared by the planner's sequential-scan arms, `ANALYZE`'s scan-based statistics
 * collection, and the isolation layer's overlay-merge / migration / commit-flush
 * scans — one definition keeps those sites from drifting.
 */
export function makeFullScanFilterInfo(cost = 1_000_000, rows = 1_000_000): FilterInfo {
	return {
		idxNum: 0,
		idxStr: FULL_SCAN_IDX_STR,
		constraints: [],
		args: [],
		accessPath: { kind: 'fullScan' },
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: FULL_SCAN_IDX_STR,
			orderByConsumed: false,
			estimatedCost: cost,
			estimatedRows: BigInt(rows),
			idxFlags: 0,
		},
	};
}

/**
 * FilterInfo for a provably empty relation (an unsatisfiable predicate). Distinct from
 * {@link makeFullScanFilterInfo} so a consumer can tell "no index" from "no rows".
 */
export function makeEmptyFilterInfo(): FilterInfo {
	return {
		idxNum: 0,
		idxStr: EMPTY_IDX_STR,
		constraints: [],
		args: [],
		accessPath: { kind: 'empty' },
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: [],
			idxNum: 0,
			idxStr: EMPTY_IDX_STR,
			orderByConsumed: false,
			estimatedCost: 0,
			estimatedRows: 0n,
			idxFlags: 0,
		},
	};
}

/**
 * FilterInfo for an equality (point/prefix) seek over `index`: one EQ constraint per
 * entry of `seekColumnIndexes`, bound positionally to `values`.
 *
 * Used by the isolation layer's primary-key point lookups and by any caller that must
 * drive an O(log n) seek instead of a scan.
 */
export function makeIndexEqSeekFilterInfo(
	index: IndexDescriptor,
	seekColumnIndexes: readonly number[],
	values: readonly SqlValue[],
): FilterInfo {
	const constraints = seekColumnIndexes.map((columnIndex, i) => ({
		constraint: { iColumn: columnIndex, op: IndexConstraintOp.EQ, usable: true },
		argvIndex: i + 1,
	}));
	const idxStr = encodeIdxStr(makeIdxStrSpec(index.name, 'eqSeek'));

	return {
		idxNum: 0,
		idxStr,
		constraints,
		args: values,
		accessPath: { kind: 'index', index, plan: 'eqSeek' },
		indexInfoOutput: {
			nConstraint: constraints.length,
			aConstraint: constraints.map(c => c.constraint),
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: 0n,
			aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
			idxNum: 0,
			idxStr,
			orderByConsumed: false,
			estimatedCost: 1,
			estimatedRows: 1n,
			idxFlags: 0,
		},
	};
}

/**
 * Rewrite the index name across `idxStr`, `indexInfoOutput.idxStr`, and
 * `accessPath.index.name` (or `accessPath.indexName` when unresolved).
 *
 * A module may advertise a per-plan alias for an index (`_primary_1`) that a wrapping
 * table's delegate does not know. Retargeting rewrites only the name; `plan`, `nameArg`,
 * and every parameter — including ones this engine does not understand — survive verbatim.
 * A FilterInfo naming no index (full scan / empty) is returned unchanged.
 */
export function retargetFilterInfoIndex(filterInfo: FilterInfo, newIndexName: string): FilterInfo {
	const idxStr = retargetIdxStr(filterInfo.idxStr, newIndexName);
	const outIdxStr = retargetIdxStr(filterInfo.indexInfoOutput.idxStr, newIndexName);
	const accessPath = retargetAccessPath(filterInfo.accessPath, newIndexName);

	if (idxStr === filterInfo.idxStr && outIdxStr === filterInfo.indexInfoOutput.idxStr && accessPath === filterInfo.accessPath) {
		return filterInfo;
	}

	return {
		...filterInfo,
		idxStr,
		...(accessPath ? { accessPath } : {}),
		indexInfoOutput: { ...filterInfo.indexInfoOutput, idxStr: outIdxStr },
	};
}

function retargetAccessPath(accessPath: AccessPath | undefined, newIndexName: string): AccessPath | undefined {
	if (!accessPath) return undefined;
	switch (accessPath.kind) {
		case 'index':
			if (accessPath.index.name === newIndexName) return accessPath;
			return { ...accessPath, index: { ...accessPath.index, name: newIndexName } };
		case 'unresolvedIndex':
			if (accessPath.indexName === newIndexName) return accessPath;
			return { ...accessPath, indexName: newIndexName };
		default:
			return accessPath;
	}
}
