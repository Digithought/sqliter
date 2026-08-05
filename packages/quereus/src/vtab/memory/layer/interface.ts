import type { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Row } from '../../../common/types.js';
import type { MemoryIndex } from '../index.js';
import type { CollationResolver } from '../../../types/logical-type.js';

/**
 * The primary-key functions a layer exposes to its scanners: extraction from a row,
 * ordering, and the lossless encoding used for value-identity keying (dedup sets).
 * All three come from one `createPrimaryKeyFunctions` build, so a caller never has to
 * re-resolve the PK columns' collations to obtain the encoder.
 */
export interface PkExtractorsAndComparators {
	primaryKeyExtractorFromRow: (row: Row) => BTreeKeyForPrimary;
	primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
	primaryKeyEncoder: (pk: BTreeKeyForPrimary) => string;
}

/**
 * Represents a snapshot or a set of changes in the MemoryTable MVCC model.
 * Layers form a chain, starting from a BaseLayer.
 */
export interface Layer {
	/**
	 * Resolves a collation name to its comparison function for the database this
	 * layer's table belongs to (`Database.getCollationResolver()`). Every comparator
	 * built inside the layer stack — primary key, secondary index, scan bound — must
	 * come from here, so a collation registered on the connection is honored and an
	 * unregistered one raises instead of silently byte-ordering.
	 *
	 * A `TransactionLayer` inherits its parent's resolver, so an inherited secondary
	 * BTree and the child's `compareKeys` are always built from the same function.
	 */
	readonly collationResolver: CollationResolver;

	/** Returns the layer ID (unique identifier, potentially timestamp or sequence) */
	getLayerId(): number;

	/** Returns the parent layer in the chain, or null for the BaseLayer */
	getParent(): Layer | null;

	/**
	 * Gets the BTree containing modifications specific to this layer for a given index.
	 * For BaseLayer, this returns the main data BTree.
	 * For TransactionLayer, this returns the inherited BTree for that index.
	 *
	 * @param indexName The name of the secondary index, or 'primary' for the primary key index.
	 * @returns The BTree containing modifications/data for the index in this layer, or null if no modifications exist for that index in this layer.
	 */
	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null;

	/**
	 * Returns the table schema as it existed when this layer was created or relevant.
	 * This is important for interpreting modifications during layer collapse, especially
	 * if schema changes occurred after this layer was created.
	 */
	getSchema(): TableSchema;

	/** Indicates if this layer represents a committed transaction state */
	isCommitted(): boolean;

	/** Helper to get the specific BTree for a secondary index's underlying data */
	getSecondaryIndexTree(indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null;

	/** Returns the MemoryIndex object for a named secondary index, or undefined if none exists */
	getSecondaryIndex(indexName: string): MemoryIndex | undefined;

	/**
	 * This method provides PK extractor and comparator based on a given schema (usually its own)
	 */
	getPkExtractorsAndComparators(schema: TableSchema): PkExtractorsAndComparators;

	/**
	 * Records that a child layer has built its BTrees over this layer's — called by the
	 * `TransactionLayer` constructor before it derives anything from its parent.
	 *
	 * The signal exists so `MemoryTableManager.tryCollapseLayers` can refuse to promote a
	 * layer some other tree is inheriting from: promotion calls `clearBase()`, which drops
	 * the base pointer and so removes the base's contribution from `chainVersion()` —
	 * every already-derived child snapshotted that total at construction, so each one's
	 * next `checkBase()` raises `MutatedBaseError` even though no row moved.
	 */
	noteDerivedChild(): void;

	/**
	 * True once any child layer has built its BTrees over this layer's — see
	 * {@link noteDerivedChild}.
	 *
	 * The count NEVER decrements. There is no layer-destruction hook to decrement from,
	 * and `MemoryTableManager.connections` cannot stand in as a liveness registry: its
	 * `disconnect` removes connections that are still live and are committed later
	 * (`MemoryTable.ensureConnection` reuses exactly such a connection). So the signal has to
	 * live on the layer, and it errs conservatively: collapse fires only on a head that has
	 * *never* had a child derived from it, which is precisely the quiescent case where
	 * detaching it changes no other tree's `chainVersion()`.
	 */
	hasDerivedChildren(): boolean;
}
