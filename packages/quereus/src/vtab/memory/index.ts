import { BTree } from 'inheritree';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { createTypedComparator } from '../../util/comparison.js';
import type { CollationResolver } from '../../types/logical-type.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from './types.js';
import type { IndexColumnSchema as IndexColumnSpec } from '../../schema/table.js'; // Renamed for clarity
import type { ColumnSchema } from '../../schema/column.js';
import type { Expression } from '../../parser/ast.js';
import { quereusError } from '../../common/errors.js';
import { compilePredicate, type CompiledPredicate } from './utils/predicate.js';

/** Definition for creating a memory index (matches IndexSchema columns usually) */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<IndexColumnSpec>;
	predicate?: Expression;
}

/** Functions for extracting and comparing index keys */
interface IndexKeyFunctions {
	keyFromRow: (row: Row) => BTreeKeyForIndex;
	compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
}

/** Represents a secondary index within a MemoryTable */
export class MemoryIndex {
	public readonly name: string | undefined;
	public readonly specColumns: ReadonlyArray<IndexColumnSpec>;
	public readonly keyFromRow: (row: Row) => BTreeKeyForIndex;
	public readonly compareKeys: (a: BTreeKeyForIndex, b: BTreeKeyForIndex) => number;
	public data: BTree<BTreeKeyForIndex, MemoryIndexEntry>;
	/** Compiled partial-index predicate. When present, only rows for which
	 *  `evaluate(row) === true` participate in the index. */
	public readonly predicate: CompiledPredicate | undefined;
	private readonly allTableColumnsSchema: ReadonlyArray<ColumnSchema>;
	/**
	 * The table's primary-key comparator (from `createPrimaryKeyFunctions(schema)`),
	 * used to sort each entry's `primaryKeys` on read (see {@link getSortedPrimaryKeys}).
	 * It is per-index — identical for every entry — so it lives here, not duplicated
	 * per entry. A PK-collation change via `ALTER COLUMN … SET COLLATE` forces a full
	 * base rebuild (`rebuildAllSecondaryIndexes` / `rebuildPrimaryTreeStrict`) and, on
	 * every layer of an open transaction, `TransactionLayer.rekeyPrimaryKey` — each
	 * recreating its entries under the new comparator/encoder, so no stale order or
	 * encoding survives an ALTER.
	 */
	private readonly primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;

	/**
	 * The table's lossless PK encoder (from `createPrimaryKeyFunctions(schema)`),
	 * bound to the PK arity. Produces the `Map` key for value-identity dedup of each
	 * entry's `primaryKeys`. Per-index — every layer derives it from the same PK
	 * definition, so an inherited entry's Map keys stay valid for this layer's
	 * add/remove. See `utils/primary-key-encode.ts`.
	 */
	private readonly encode: (pk: BTreeKeyForPrimary) => string;

	/**
	 * Resolves this index's declared column collations against the owning database.
	 * A layer hands down its own resolver, so a child layer's comparator is built
	 * from the same collation function as the parent tree it inherits.
	 */
	private readonly collationResolver: CollationResolver;

	constructor(
		spec: IndexSpec,
		allTableColumnsSchema: ReadonlyArray<ColumnSchema>,
		collationResolver: CollationResolver,
		primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number,
		encode: (pk: BTreeKeyForPrimary) => string,
		tableName: string,
		baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>,
	) {
		this.name = spec.name;
		this.specColumns = Object.freeze(spec.columns.map(c => ({ ...c })));
		this.allTableColumnsSchema = allTableColumnsSchema;
		this.collationResolver = collationResolver;
		this.primaryKeyComparator = primaryKeyComparator;
		this.encode = encode;

		this.validateColumnIndexes(allTableColumnsSchema);

		const keyFunctions = this.createIndexKeyFunctions();
		this.keyFromRow = keyFunctions.keyFromRow;
		this.compareKeys = keyFunctions.compareKeys;

		this.predicate = spec.predicate ? compilePredicate(spec.predicate, allTableColumnsSchema, tableName) : undefined;

		this.data = this.createBTree(baseInheritreeTable);
	}

	/** True when the partial-index predicate is satisfied by `row` (or there is no predicate). */
	rowMatchesPredicate(row: Row): boolean {
		if (!this.predicate) return true;
		return this.predicate.evaluate(row) === true;
	}

	private validateColumnIndexes(allTableColumnsSchema: ReadonlyArray<ColumnSchema>): void {
		const hasInvalidIndex = this.specColumns.some(sc =>
			sc.index < 0 || sc.index >= allTableColumnsSchema.length
		);

		if (hasInvalidIndex) {
			quereusError(`Invalid column index in index '${this.name ?? '(unnamed)'}'.`, StatusCode.INTERNAL);
		}
	}

	private createIndexKeyFunctions(): IndexKeyFunctions {
		if (this.specColumns.length === 1) {
			return this.createSingleColumnKeyFunctions();
		} else {
			return this.createCompositeColumnKeyFunctions();
		}
	}

	private createSingleColumnKeyFunctions(): IndexKeyFunctions {
		const specCol = this.specColumns[0];
		const colSchemaIndex = specCol.index;
		const columnSchema = this.allTableColumnsSchema[colSchemaIndex];
		const descMultiplier = specCol.desc ? -1 : 1;

		// Create type-aware comparator
		const collationFunc = specCol.collation ? this.collationResolver(specCol.collation) : undefined;
		const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			this.validateRowLength(row, colSchemaIndex);
			return row[colSchemaIndex];
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			return typedComparator(a as SqlValue, b as SqlValue) * descMultiplier;
		};

		return { keyFromRow, compareKeys };
	}

	private createCompositeColumnKeyFunctions(): IndexKeyFunctions {
		const localSpecColumns = this.specColumns;

		// Pre-create type-aware comparators for each column
		const comparators = localSpecColumns.map(sc => {
			const columnSchema = this.allTableColumnsSchema[sc.index];
			const collationFunc = sc.collation ? this.collationResolver(sc.collation) : undefined;
			return createTypedComparator(columnSchema.logicalType, collationFunc);
		});

		const keyFromRow = (row: Row): BTreeKeyForIndex => {
			return localSpecColumns.map(sc => {
				this.validateRowLength(row, sc.index);
				return row[sc.index];
			});
		};

		const compareKeys = (a: BTreeKeyForIndex, b: BTreeKeyForIndex): number => {
			const arrA = a as SqlValue[];
			const arrB = b as SqlValue[];

			for (let i = 0; i < localSpecColumns.length; i++) {
				if (i >= arrA.length || i >= arrB.length) {
					return arrA.length - arrB.length;
				}

				const specCol = localSpecColumns[i];
				const comparison = comparators[i](arrA[i], arrB[i]);

				if (comparison !== 0) {
					return specCol.desc ? -comparison : comparison;
				}
			}
			return 0;
		};

		return { keyFromRow, compareKeys };
	}

	private validateRowLength(row: Row, columnIndex: number): void {
		if (columnIndex < 0 || columnIndex >= row.length) {
			quereusError(`Index key col index ${columnIndex} OOB for row len ${row.length}`, StatusCode.INTERNAL);
		}
	}

	private createBTree(baseInheritreeTable?: BTree<BTreeKeyForIndex, MemoryIndexEntry>): BTree<BTreeKeyForIndex, MemoryIndexEntry> {
		return new BTree<BTreeKeyForIndex, MemoryIndexEntry>(
			(entry: MemoryIndexEntry) => entry.indexKey,
			this.compareKeys,
			{ base: baseInheritreeTable }
		);
	}

	/**
	 * Entries created by THIS index instance — safe to mutate in place. An entry
	 * found through the tree but absent here was INHERITED from an ancestor
	 * layer's tree (each TransactionLayer wraps a fresh MemoryIndex around the
	 * parent's BTree as base): only the btree NODES are copy-on-write, the entry
	 * objects (and their `primaryKeys` Maps) are shared, so mutating an inherited
	 * entry's Map writes through to the ancestor — corrupting committed state
	 * when this layer rolls back (a rolled-back insert leaves a phantom PK that
	 * false-rejects later UNIQUE checks; a rolled-back delete strips a live PK
	 * and silently un-enforces UNIQUE). Inherited entries are therefore
	 * copy-on-written via {@link BTree.updateAt}, which lands the replacement in
	 * THIS tree; the cloned container is a `new Map(existing.primaryKeys)` (was a
	 * `slice()` of the sorted array). Owned entries keep the in-place fast path —
	 * a Map set/delete is O(1), so bulk loads and repeated same-key writes within
	 * one layer stay O(1) per entry (the previous sorted-array splice was O(n) on
	 * an out-of-order arrival).
	 */
	private ownedEntries = new WeakSet<MemoryIndexEntry>();

	/**
	 * Per-entry memoized PK-sorted view, rebuilt lazily by {@link getSortedPrimaryKeys}.
	 * Keyed by entry identity (a WeakMap, so it never pins an entry alive and is never
	 * serialized — entries stay pure structured-cloneable data). An owned in-place
	 * mutation invalidates by `delete(entry)` (entry identity is preserved); a
	 * copy-on-write produces a fresh entry object whose cache slot is naturally absent.
	 * The cache is per-MemoryIndex (per layer) and discarded with the layer.
	 */
	private sortedCache = new WeakMap<MemoryIndexEntry, BTreeKeyForPrimary[]>();

	/** Adds a mapping from index key to primary key (O(1) Map set, deduped by encoding) */
	addEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const enc = this.encode(primaryKey);
		const path = this.data.find(indexKey);
		if (path.on) {
			const existingEntry = this.data.at(path)!;
			if (this.ownedEntries.has(existingEntry)) {
				existingEntry.primaryKeys.set(enc, primaryKey);
				this.sortedCache.delete(existingEntry);
				return;
			}
			// Inherited: copy-on-write into this layer's tree (see ownedEntries).
			// Clone the Map before mutating so the ancestor entry is untouched. Keep the
			// stored indexKey bytes (a collation-equal/byte-different new key must not
			// re-key the entry — matching the prior in-place behavior). The fresh entry
			// object has no sortedCache slot, so no stale sorted view survives.
			const primaryKeys = new Map(existingEntry.primaryKeys);
			primaryKeys.set(enc, primaryKey);
			const updated: MemoryIndexEntry = {
				indexKey: existingEntry.indexKey,
				primaryKeys,
			};
			this.ownedEntries.add(updated);
			this.data.updateAt(path, updated);
		} else {
			const newEntry: MemoryIndexEntry = {
				indexKey,
				primaryKeys: new Map([[enc, primaryKey]]),
			};
			this.ownedEntries.add(newEntry);
			this.data.insert(newEntry);
		}
	}

	/** Removes a mapping from index key to primary key (O(1) Map delete by encoding) */
	removeEntry(indexKey: BTreeKeyForIndex, primaryKey: BTreeKeyForPrimary): void {
		const path = this.data.find(indexKey);
		if (!path.on) return;
		const entry = this.data.at(path)!;
		const enc = this.encode(primaryKey);

		if (this.ownedEntries.has(entry)) {
			entry.primaryKeys.delete(enc);
			// If no primary keys remain, remove the entire entry
			if (entry.primaryKeys.size === 0) {
				this.data.deleteAt(path);
			} else {
				this.sortedCache.delete(entry);
			}
			return;
		}

		// Inherited: copy-on-write (see ownedEntries). A delete that empties the
		// entry masks it in this layer's tree; the ancestor's entry is untouched.
		const remaining = new Map(entry.primaryKeys);
		remaining.delete(enc);
		if (remaining.size === 0) {
			this.data.deleteAt(path);
		} else {
			const updated: MemoryIndexEntry = { indexKey: entry.indexKey, primaryKeys: remaining };
			this.ownedEntries.add(updated);
			this.data.updateAt(path, updated);
		}
	}

	/**
	 * Returns the entry's PKs sorted under the PK comparator, memoized per entry.
	 * Scan output must be PK-sorted within each index key (the optimizer never claims
	 * the order, but `quereus-isolation` merges overlay and underlying secondary scans
	 * assuming `(indexKey, PK)` order — an insertion-order Map would break the merge).
	 * The Map stores PKs in insertion order, so this sorts on read; the cache keeps
	 * repeated scans at the original amortized cost.
	 */
	getSortedPrimaryKeys(entry: MemoryIndexEntry): readonly BTreeKeyForPrimary[] {
		let sorted = this.sortedCache.get(entry);
		if (!sorted) {
			sorted = [...entry.primaryKeys.values()].sort(this.primaryKeyComparator);
			this.sortedCache.set(entry, sorted);
		}
		return sorted;
	}

	/** Returns the primary keys for a given index key (defensive copy of the sorted view) */
	getPrimaryKeys(indexKey: BTreeKeyForIndex): BTreeKeyForPrimary[] {
		const entry = this.data.get(indexKey);
		return entry ? this.getSortedPrimaryKeys(entry).slice() : [];
	}

	/**
	 * True when at least one PK is mapped under `indexKey`. O(1) (Map size), so the
	 * build-time UNIQUE check (`populateIndexFromRows`) can probe per row without
	 * sorting the bucket.
	 */
	hasAnyPrimaryKey(indexKey: BTreeKeyForIndex): boolean {
		return (this.data.get(indexKey)?.primaryKeys.size ?? 0) > 0;
	}

	/** Gets the count of unique index values */
	get size(): number {
		return this.data.getCount();
	}

	/** Clears all entries from the index, creating a fresh empty BTree */
	clear(): void {
		this.data = this.createBTree();
	}

	/** Detaches this index's BTree from its base inheritance (used during layer collapse) */
	clearBase(): void {
		this.data.clearBase();
	}
}
