import type { FilterInfo, IndexDescriptor, SqlValue, TableIndexSchema } from '@quereus/quereus';
import { PRIMARY_INDEX_NAME, makeFullScanFilterInfo, makeIndexEqSeekFilterInfo } from '@quereus/quereus';

/**
 * Creates a FilterInfo for a full table scan (no constraints).
 *
 * Shared by the overlay-merge read paths, the ALTER/DROP INDEX overlay
 * migrations, and the commit flush — a single definition keeps the several
 * scan sites from drifting. Delegates to the engine's builder so the overlay
 * scans present the same access path the planner would.
 */
export { makeFullScanFilterInfo };

/**
 * Creates a FilterInfo for a primary key point lookup (equality on all PK
 * columns). Produces O(log n) lookups instead of O(n) full scans.
 *
 * The overlay always names its primary-key index `_primary_`, so the descriptor is
 * built here rather than resolved from a schema.
 */
export function makePkPointLookupFilter(pkIndices: number[], pk: SqlValue[]): FilterInfo {
	const index: IndexDescriptor = {
		name: PRIMARY_INDEX_NAME,
		role: 'primary',
		keyColumns: pkIndices.map(columnIndex => ({ columnIndex, desc: false })),
		unique: true,
	};
	return makeIndexEqSeekFilterInfo(index, pkIndices, pk);
}

/**
 * Creates a FilterInfo for an equality seek over a secondary `index`, binding each of
 * the index's key columns to `newRow`'s value for that column. Produces an O(log n)
 * index lookup for the isolation layer's UNIQUE-conflict check instead of a full scan.
 *
 * The seek values are read in INDEX-KEY order (`index.columns[i].index`), which need
 * not match the UNIQUE constraint's `columns` order — so read off the index, never
 * assume the two arrays agree.
 *
 * The built `constraints` carry an EQ per key column, so a module that ignores the
 * `idxStr` index hint still applies the equalities as a residual filter rather than
 * returning the whole table.
 */
export function makeSecondaryIndexEqSeekFilter(index: TableIndexSchema, newRow: readonly SqlValue[]): FilterInfo {
	const descriptor: IndexDescriptor = {
		name: index.name,
		role: 'secondary',
		keyColumns: index.columns.map(c => ({ columnIndex: c.index, desc: !!c.desc, collation: c.collation })),
		unique: true,
	};
	const seekColumnIndexes = index.columns.map(c => c.index);
	const values = seekColumnIndexes.map(i => newRow[i]);
	return makeIndexEqSeekFilterInfo(descriptor, seekColumnIndexes, values);
}
