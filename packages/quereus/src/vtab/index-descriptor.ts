/**
 * Typed identity of the index an access plan iterates.
 *
 * The planner records its chosen index twice: as the free-text `FilterInfo.idxStr`
 * wire format (see `idx-str.ts`) and as the structured {@link AccessPath} on
 * `FilterInfo.accessPath`. Consumers that care about *what the index is* — most
 * importantly anything that must merge or compare rows in the scan's emission
 * order — read the structured form. `idxStr` remains the text projection consumed
 * by module runtimes.
 */

import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { BestAccessPlanResult } from './best-access-plan.js';

/** One key column of an index, expressed table-relative. */
export interface IndexKeyColumn {
	/** 0-based index into `TableSchema.columns`. */
	readonly columnIndex: number;
	/** true ⇒ this key column is ordered descending within the index. */
	readonly desc: boolean;
	/** Declared collation name for this key column; undefined ⇒ BINARY. */
	readonly collation?: string;
}

/**
 * Structured identity of the index an access plan iterates.
 *
 * `name` is the module's own name for the index and is what appears in `idxStr`;
 * it may be a per-plan alias that resolves to nothing in the table schema. `role`
 * is therefore authoritative, not the name: a descriptor with `role: 'primary'`
 * IS the table's primary key however it is named.
 */
export interface IndexDescriptor {
	readonly name: string;
	readonly role: 'primary' | 'secondary';
	/** The index's FULL key columns, in index order (not just the seek prefix). */
	readonly keyColumns: readonly IndexKeyColumn[];
	/** true ⇒ a walk of this index yields at most one row per distinct key. */
	readonly unique: boolean;
	/**
	 * true ⇒ the SCAN walks this index in REVERSE of its declared `keyColumns`
	 * order (an `ORDER BY … DESC` over an ascending index). Absent/false ⇒ forward.
	 *
	 * This is the one place scan DIRECTION is modelled structurally, so an
	 * emission-order consumer (the isolation overlay's merged read) can walk the
	 * reversed stream correctly. A module whose `idxStr` already encodes direction
	 * (the in-memory vtab's `ordCons=DESC`) need not set it; a module that carries
	 * direction only in an opaque per-plan index name (lamina) MUST, or the overlay
	 * merges a reversed underlying stream against a forward comparator.
	 */
	readonly reverse?: boolean;
}

/**
 * Which seek/scan strategy the planner chose over an {@link IndexDescriptor}.
 * One-to-one with the `plan=N` codes carried in `idxStr`.
 *
 * Scan DIRECTION is not part of the plan KIND. For the in-memory vtab it rides
 * `idxStr` (the `plan=1` / `plan=4` descending codes and the `ordCons=DESC`
 * parameter its scan-plan builder recognises). A module that carries direction
 * only in an opaque per-plan index name (lamina) instead sets
 * {@link IndexDescriptor.reverse} so an emission-order consumer can still learn
 * the scan is reversed.
 */
export type IndexPlanKind =
	| 'scan'             // plan=0 — ordered walk, no bounds
	| 'eqSeek'           // plan=2
	| 'rangeSeek'        // plan=3
	| 'multiSeek'        // plan=5 (IN list)
	| 'multiRangeSeek'   // plan=6 (OR_RANGE)
	| 'prefixRangeSeek'; // plan=7

/** Structured description of the access path chosen for one table reference. */
export type AccessPath =
	| { readonly kind: 'fullScan' }
	| { readonly kind: 'empty' }
	| { readonly kind: 'index'; readonly index: IndexDescriptor; readonly plan: IndexPlanKind }
	/**
	 * The plan named an index the engine could not resolve, and the module supplied no
	 * `indexDescriptor` for it. Consumers that need the index identity (to merge in scan
	 * order, say) MUST fail loudly rather than guess — an unresolved secondary index
	 * merged as if it were the primary key silently reorders rows.
	 */
	| { readonly kind: 'unresolvedIndex'; readonly indexName: string; readonly plan: IndexPlanKind };

/** The canonical name the engine uses for a table's primary-key index in `idxStr`. */
export const PRIMARY_INDEX_NAME = '_primary_';

/** The name physical plan nodes use for the primary-key index (`IndexScanNode.indexName`). */
export const PRIMARY_PHYSICAL_INDEX_NAME = 'primary';

/** True when `name` is one of the two spellings the engine uses for the primary key. */
export function isPrimaryIndexName(name: string): boolean {
	return name === PRIMARY_INDEX_NAME || name === PRIMARY_PHYSICAL_INDEX_NAME;
}

/**
 * The table's primary key as an {@link IndexDescriptor}, named `_primary_`.
 *
 * Returns undefined for a table with no declared primary key: a descriptor with an
 * empty `keyColumns` describes nothing, and every consumer that would read it wants
 * a full scan instead.
 */
export function primaryKeyDescriptor(tableSchema: TableSchema): IndexDescriptor | undefined {
	const pkCols = tableSchema.primaryKeyDefinition ?? [];
	if (pkCols.length === 0) return undefined;
	return {
		name: PRIMARY_INDEX_NAME,
		role: 'primary',
		keyColumns: pkCols.map(col => ({
			columnIndex: col.index,
			desc: col.desc === true,
			collation: col.collation,
		})),
		unique: true,
	};
}

/**
 * Resolve the structured identity of `indexName` for this plan. Resolution order:
 *   1. `accessPlan.indexDescriptor`, when the module supplied one naming this index.
 *   2. `indexName` is `_primary_` or `primary` ⇒ {@link primaryKeyDescriptor}.
 *   3. Case-insensitive hit in `tableSchema.indexes`.
 *   4. undefined — the caller emits `{ kind: 'unresolvedIndex' }` and logs.
 *
 * `indexName` is taken explicitly rather than read off `accessPlan.indexName`: the
 * ordering-only arm of `rule-select-access-path` walks `accessPlan.orderingIndexName`
 * and the legacy arms hardcode `_primary_`, so the name that lands in `idxStr` is not
 * always `accessPlan.indexName`. The descriptor must describe the index actually walked.
 *
 * There is deliberately no prefix rule: a secondary index genuinely named
 * `_primary_extra` resolves via the schema lookup as `role: 'secondary'`.
 */
export function resolveIndexDescriptor(
	tableSchema: TableSchema,
	accessPlan: BestAccessPlanResult,
	indexName: string,
): IndexDescriptor | undefined {
	const supplied = accessPlan.indexDescriptor;
	if (supplied && supplied.name === indexName) return supplied;

	if (isPrimaryIndexName(indexName)) return primaryKeyDescriptor(tableSchema);

	const lowered = indexName.toLowerCase();
	const schemaIndex = tableSchema.indexes?.find(idx => idx.name.toLowerCase() === lowered);
	if (!schemaIndex) return undefined;

	return {
		name: schemaIndex.name,
		role: 'secondary',
		keyColumns: schemaIndex.columns.map(col => ({
			columnIndex: col.index,
			desc: col.desc === true,
			collation: col.collation,
		})),
		unique: schemaIndex.unique === true,
	};
}

/**
 * Validate a module-supplied {@link IndexDescriptor} against the plan that carries it
 * and the request it answers. Called from `validateAccessPlan`; separated so the rules
 * stay readable.
 *
 * The descriptor must name the index the plan actually drives. That is `indexName` for
 * a seek plan; an ordering-only plan sets `orderingIndexName` alone, so accept either.
 */
export function validateIndexDescriptor(
	descriptor: IndexDescriptor,
	indexName: string | undefined,
	orderingIndexName: string | undefined,
	columnCount: number,
): void {
	const expected = indexName ?? orderingIndexName;
	if (expected === undefined) {
		quereusError(
			`indexDescriptor '${descriptor.name}' supplied but the plan names no index via indexName or orderingIndexName`,
			StatusCode.FORMAT,
		);
	}
	if (descriptor.name !== expected) {
		quereusError(
			`indexDescriptor.name '${descriptor.name}' must equal the plan's index name '${expected}'`,
			StatusCode.FORMAT,
		);
	}
	if (descriptor.keyColumns.length === 0) {
		quereusError(
			`indexDescriptor '${descriptor.name}' must declare at least one key column`,
			StatusCode.FORMAT,
		);
	}
	for (const keyColumn of descriptor.keyColumns) {
		if (keyColumn.columnIndex < 0 || keyColumn.columnIndex >= columnCount) {
			quereusError(
				`Invalid indexDescriptor key column index ${keyColumn.columnIndex}, must be 0-${columnCount - 1}`,
				StatusCode.FORMAT,
			);
		}
	}
}
