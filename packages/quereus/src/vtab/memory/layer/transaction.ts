import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import { MemoryIndex } from '../index.js';
import type { Row, SqlValue } from '../../../common/types.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer, PkExtractorsAndComparators } from './interface.js';
import { createLogger } from '../../../common/logger.js';
import { createPrimaryKeyFunctions, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';
import type { CollationResolver } from '../../../types/logical-type.js';
import { convertRowAtIndex } from './row-convert.js';

const log = createLogger('vtab:memory:layer:transaction');
const warnLog = log.extend('warn');

let transactionLayerCounter = 1000;

/**
 * Pending change for event emission.
 */
interface PendingChange {
	type: 'insert' | 'update' | 'delete';
	pk: BTreeKeyForPrimary;
	oldRow?: Row;
	newRow?: Row;
}

/**
 * A single structural write this layer made, captured unconditionally (unlike
 * {@link PendingChange}, which records only when change-tracking is enabled).
 * Serves as the replay source when a sibling connection's commit advances the
 * committed head past this layer's fork point and the layer must be rebased —
 * see `MemoryTableManager.commitTransaction`.
 */
export interface OwnWrite {
	type: 'upsert' | 'delete';
	primaryKey: BTreeKeyForPrimary;
	/** New row for an upsert; absent for a delete. */
	newRow?: Row;
}

/**
 * Represents a set of modifications (inserts, updates, deletes) applied
 * on top of a parent Layer using inherited BTrees with copy-on-write semantics.
 * These layers are immutable once committed.
 */
export class TransactionLayer implements Layer {
	private readonly layerId: number;
	public readonly parentLayer: Layer;
	/**
	 * Inherited verbatim from the parent layer: this layer's secondary BTrees are
	 * built over the parent's (`new MemoryIndex(..., parentSecondaryTree)`), so the
	 * child's `compareKeys` must come from the same collation function the parent
	 * ordered those nodes with.
	 */
	public readonly collationResolver: CollationResolver;
	/**
	 * Schema when this layer was started. Replaced when DDL runs inside this layer's own
	 * transaction: by {@link adoptSchema} for additive index/constraint DDL, a secondary-index
	 * re-key from `alter column … set collate`, and index/constraint removal (`drop index` /
	 * `drop constraint`), and by {@link rekeyPrimaryKey} when that collate change lands on a
	 * primary-key column. The column set is identical across every such swap.
	 */
	private tableSchemaAtCreation: TableSchema;

	/**
	 * Derived from {@link tableSchemaAtCreation}'s primary key definition, so the primary
	 * tree, every inherited secondary index, and every scan share one comparator/encoder
	 * set — and one pass of collation resolution. Rebuilt only by {@link rekeyPrimaryKey},
	 * which rebuilds the structures keyed by them in the same call.
	 */
	private pkFunctions: PrimaryKeyFunctions;

	// Primary modifications BTree that inherits from parent
	private primaryModifications: BTree<BTreeKeyForPrimary, Row>;

	// Secondary index BTrees that inherit from parent's indexes
	private secondaryIndexes: Map<string, MemoryIndex>;

	private _isCommitted: boolean = false;
	private _hasModifications: boolean = false;

	/** Pending changes for event emission. Null if tracking disabled. */
	private pendingChanges: PendingChange[] | null = null;

	// NOTE: always-on, one entry per record{Upsert,Delete} call — an ordered
	// list, so repeated writes to the same PK are all retained (last-write-wins is
	// applied at replay by re-deriving each key's effective row on the new head).
	// If a write-heavy transaction ever shows memory pressure from this log,
	// collapse it to a PK-keyed last-write map (only the net per-PK effect is ever
	// replayed).
	/** Always-maintained log of this layer's own structural writes (see {@link OwnWrite}). */
	private readonly ownWrites: OwnWrite[] = [];

	constructor(parent: Layer) {
		this.layerId = transactionLayerCounter++;
		this.parentLayer = parent;
		this.collationResolver = parent.collationResolver;
		const schema = parent.getSchema();
		if (!schema) {
			throw new QuereusError(
				`TransactionLayer: parent layer ${parent.getLayerId()} has no schema. ` +
				'This usually means a savepoint snapshot was created before the overlay was initialised.',
				StatusCode.INTERNAL
			);
		}
		this.tableSchemaAtCreation = schema; // Schema is fixed at creation
		this.pkFunctions = createPrimaryKeyFunctions(schema, this.collationResolver);

		// Initialize primary modifications BTree with parent's primary tree as base
		const { extractFromRow, compare: primaryKeyComparator } = this.pkFunctions;
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary => {
			const result = extractFromRow(value);
			return result;
		};

		const parentPrimaryTree = parent.getModificationTree('primary');

		this.primaryModifications = new BTree(
			btreeKeyFromValue,
			primaryKeyComparator,
			{ base: parentPrimaryTree || undefined } // Use parent's primary tree as base
		);

		// Initialize secondary indexes that inherit from parent's secondary indexes
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
	}

	private initializeSecondaryIndexes(): void {
		const schema = this.tableSchemaAtCreation;
		if (!schema.indexes) return;

		// All layers of a table derive the PK comparator and encoder from the same PK
		// definition, so an inherited entry's `primaryKeys` Map keys stay valid for this
		// layer's value add/remove on each MemoryIndex entry.
		const pkFunctions = this.pkFunctions;

		for (const indexSchema of schema.indexes) {
			const parentSecondaryTree = this.parentLayer.getSecondaryIndexTree?.(indexSchema.name);
			// Create MemoryIndex with inherited BTree
			const memoryIndex = new MemoryIndex(
				indexSchema,
				schema.columns,
				this.collationResolver,
				pkFunctions.compare,
				pkFunctions.encode,
				schema.name,
				parentSecondaryTree || undefined // Use parent's secondary index tree as base
			);
			this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		}
	}

	/**
	 * Adopts a schema change that was applied to the table while THIS layer's transaction
	 * is still open, so the rest of that transaction reads and enforces the new structures.
	 * Three kinds of change reach here:
	 *
	 *  - **Additive** (`create index` / `create unique index` / `add constraint … unique`):
	 *    a name absent from {@link secondaryIndexes} is built and added. Without it, a layer
	 *    created before the DDL keeps its creation-time schema: it has neither the new
	 *    `IndexSchema` (so an index scan raises "Secondary index not found") nor the derived
	 *    `uniqueConstraints` entry (so `checkUniqueConstraints` silently skips it and a
	 *    colliding insert is accepted).
	 *  - **Re-keying** (`alter column … set collate`, or an `alter column … set data type` that
	 *    keeps the physical storage class but moves to a differently-ordering logical type —
	 *    text ↔ timespan, where 'PT1H' and 'PT60M' are one value): an index whose `IndexSchema`
	 *    object is no longer the one this layer holds is REPLACED.
	 *    `BaseLayer.rebuildAllSecondaryIndexes` hands every index a fresh BTree under the new
	 *    comparator, so a layer that kept its old `MemoryIndex` would go on comparing the old way
	 *    over an orphaned tree — and, once it becomes the committed head at commit, would shadow
	 *    the base's rebuilt structures entirely. The retype has no index-column field to change
	 *    (an index column carries no logical type; it reads the column's), so
	 *    `MemoryTableManager.alterColumn` rebuilds the `IndexSchema` objects purely to raise this
	 *    signal — see its `structuresRekeyed` branch.
	 *  - **Removal** (`drop index` / `drop constraint`): an index whose name the new schema no
	 *    longer declares is DROPPED from {@link secondaryIndexes}. Without it the layer keeps the
	 *    derived `uniqueConstraints` entry in its frozen schema and goes on enforcing a constraint
	 *    that no longer exists, and an index scan can still reach the orphaned tree via
	 *    {@link getSecondaryIndexTree}. An empty/undefined `newSchema.indexes` drops all of them.
	 *    Like the additive side, a removal is NOT undone by `rollback to savepoint`: every layer in
	 *    the chain adopts it, so the restored snapshot has the index dropped too (DDL is not
	 *    transactional here — see `feat-ddl-transaction-capability`).
	 *
	 * An index is considered unchanged only when the NEW schema's `IndexSchema` is the very
	 * object the old schema carried. Every DDL path that re-keys rebuilds those objects, and
	 * every additive path preserves them, so identity is the exact discriminator.
	 *
	 * The caller MUST apply this to a whole parent chain oldest-first: each layer builds its
	 * `MemoryIndex` over its parent's tree for that index, so the parent's must already be the
	 * new one. Only the layer's OWN writes are re-indexed — everything below is inherited
	 * copy-on-write, exactly as {@link initializeSecondaryIndexes} does at construction.
	 *
	 * Never applied to a column-set or primary-key change: either would invalidate
	 * {@link pkFunctions} and the primary tree. A PK-column collation change goes to
	 * {@link rekeyPrimaryKey} instead, and `ensureSchemaChangeSafety` raises BUSY when any
	 * connection other than the DDL issuer holds a pending layer.
	 */
	public adoptSchema(newSchema: TableSchema): void {
		const oldSchema = this.tableSchemaAtCreation;
		this.tableSchemaAtCreation = newSchema;

		// Additive + re-key: add an index the layer lacks, replace one the new schema rebuilt.
		for (const indexSchema of newSchema.indexes ?? []) {
			const held = this.secondaryIndexes.get(indexSchema.name);
			const previous = oldSchema.indexes?.find(ix => ix.name === indexSchema.name);
			if (held && previous === indexSchema) continue;

			const parentSecondaryTree = this.parentLayer.getSecondaryIndexTree?.(indexSchema.name);
			const memoryIndex = new MemoryIndex(
				indexSchema,
				newSchema.columns,
				this.collationResolver,
				this.pkFunctions.compare,
				this.pkFunctions.encode,
				newSchema.name,
				parentSecondaryTree || undefined,
			);
			this.reindexOwnWrites(memoryIndex);
			this.secondaryIndexes.set(indexSchema.name, memoryIndex);
		}

		// Removal (`drop index` / `drop constraint`): drop every held index the new schema no
		// longer declares (empty/undefined `newSchema.indexes` drops all). Enforcement stops the
		// moment the frozen schema loses the derived `uniqueConstraints` entry; dropping the
		// orphaned `MemoryIndex` additionally keeps an index scan from reaching it.
		const declared = new Set((newSchema.indexes ?? []).map(ix => ix.name));
		for (const name of [...this.secondaryIndexes.keys()]) {
			if (!declared.has(name)) this.secondaryIndexes.delete(name);
		}
	}

	/**
	 * Adopts a schema change that re-keys the PRIMARY KEY — `alter column … set collate` on a
	 * PK column — applied while THIS layer's transaction is still open. Rebuilds
	 * {@link pkFunctions}, the primary tree, and every secondary index (each of which derives
	 * its `primaryKeyComparator` / `encode` from the PK definition), so nothing this layer owns
	 * survives the ALTER still keyed under the old collation.
	 *
	 * Like {@link adoptSchema}, the caller MUST apply this to a whole parent chain oldest-first
	 * (base layer already re-keyed): the new tree inherits copy-on-write from the parent's new
	 * one, so the parent's must already exist.
	 *
	 * ### Why {@link ownWrites} is rewritten to its net effect
	 *
	 * `ownWrites` is an ordered log that may touch one key repeatedly, and under the new
	 * comparator two keys that were distinct in that log can collapse into one. Replaying it
	 * verbatim would let a later write land on an earlier write's row, or a deletion remove a
	 * row a subsequent upsert had already placed. So the log is REWRITTEN here, in place, to
	 * one entry per key: the layer's effective row (read out of the pre-rekey tree), or a
	 * deletion — deletions first, and a deletion whose key an upsert now occupies is dropped
	 * entirely. The rewritten log is what every later reader of it replays: this method's own
	 * index rebuild, a `create index` later in the same transaction ({@link adoptSchema} →
	 * {@link reindexOwnWrites}), and `MemoryTableManager.commitTransaction`'s rebase.
	 *
	 * Soundness rests on a precondition `MemoryTableManager.validateRekeyedPrimaryKey` enforces
	 * before any of this runs: NO layer in the chain — base included — holds two rows that
	 * collide under the new comparator. Given that, every key here resolves to at most one row
	 * in the parent, so a deletion removes exactly the row this layer removed and an upsert
	 * lands at exactly one key.
	 *
	 * NOTE: the deletion replay assumes a key this layer deleted was a key the PARENT held.
	 * That holds because every DML operation gets its own layer (`MemoryTableConnection`'s
	 * statement savepoints), so no layer both creates and destroys a key. If a single layer
	 * ever does, `rekeyed.find(key)` can land on a *colliding* parent row and delete it: at
	 * that point the deletion needs to verify, under the OLD comparator, that the row it found
	 * is the row it removed.
	 */
	public rekeyPrimaryKey(newSchema: TableSchema): void {
		const preRekeyTree = this.primaryModifications;
		const preRekeyEncode = this.pkFunctions.encode;

		this.tableSchemaAtCreation = newSchema;
		this.pkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);

		const { extractFromRow, compare } = this.pkFunctions;
		const parentPrimaryTree = this.parentLayer.getModificationTree('primary');
		const rekeyed = new BTree<BTreeKeyForPrimary, Row>(
			(value: Row): BTreeKeyForPrimary => extractFromRow(value),
			compare,
			{ base: parentPrimaryTree || undefined },
		);

		// Net per-key effect of this layer's own writes, read out of the pre-rekey tree
		// (`get` traverses the inheritance chain, so it yields the layer's EFFECTIVE row).
		const deletions: BTreeKeyForPrimary[] = [];
		const upserts: Row[] = [];
		const seen = new Set<string>();
		for (const write of this.ownWrites) {
			const encoded = preRekeyEncode(write.primaryKey);
			if (seen.has(encoded)) continue;
			seen.add(encoded);

			const effectiveRow = preRekeyTree.get(write.primaryKey);
			if (effectiveRow === undefined) deletions.push(write.primaryKey);
			else upserts.push(effectiveRow);
		}

		for (const primaryKey of deletions) {
			const path = rekeyed.find(primaryKey);
			if (path.on) rekeyed.deleteAt(path);
		}
		for (const row of upserts) {
			rekeyed.upsert(row);
		}
		this.primaryModifications = rekeyed;

		// A deleted key an upsert has since re-occupied (`update t set v='A' where v='a'` under
		// NOCASE) is no longer a deletion of anything: keeping it would make the log claim both
		// a deletion and an upsert of the same key.
		const survivingDeletions = deletions.filter(primaryKey => rekeyed.get(primaryKey) === undefined);
		this.ownWrites.length = 0;
		for (const primaryKey of survivingDeletions) {
			this.ownWrites.push({ type: 'delete', primaryKey });
		}
		for (const row of upserts) {
			this.ownWrites.push({ type: 'upsert', primaryKey: extractFromRow(row), newRow: row });
		}

		// Every secondary index's key encoding and PK bookkeeping derive from `pkFunctions`,
		// and each inherits the parent's freshly-rebuilt tree — so all of them are rebuilt,
		// including ones the altered column does not appear in.
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
		for (const index of this.secondaryIndexes.values()) {
			this.reindexOwnWrites(index);
		}
	}

	/**
	 * Adopts an `alter column … set data type` / `set not null` backfill conversion applied while
	 * THIS layer's transaction is still open: swaps in the new schema and rewrites the CONVERTED value
	 * into every own-written row at `colIndex`, so the rest of the transaction — and, at commit, the
	 * committed head — read the new value instead of the raw one the transaction wrote. This is what
	 * fills the transaction's OWN pending NULL rows for SET NOT NULL backfill, which live in this
	 * layer, not the base.
	 *
	 * NON-primary-key column, or a key column whose bytes are unchanged. `MemoryTableManager.alterColumn`
	 * rejects a physical retype of a key column before any mutation, and SET NOT NULL leaves the key
	 * bytes intact, so the primary key encoding is unchanged: {@link pkFunctions} and the primary tree
	 * keep their keys, and only the value at `colIndex` moves. (Contrast {@link rekeyPrimaryKey}, which
	 * must rebuild the tree because the keys themselves change.)
	 *
	 * Like {@link adoptSchema} / {@link rekeyPrimaryKey}, the caller MUST apply this oldest-first
	 * (base already converted): the layer's copy-on-write base inherits the parent's already-converted
	 * rows, so only this layer's OWN writes are rewritten here.
	 *
	 * `ownWrites` is collapsed to its net per-key effect (as {@link rekeyPrimaryKey} does) so an
	 * intermediate value a later write overwrote never reaches `convert`, and the rewritten log —
	 * carrying converted values — is what the rebase (`MemoryTableManager.rebaseLayerOntoHead`) and
	 * any later `create index` ({@link reindexOwnWrites}) replay.
	 *
	 * NULL own-values pass through untouched UNLESS `convertNulls` is set (the SET NOT NULL backfill
	 * maps null → DEFAULT). A value that fails to convert is left as-is (not an error): the manager
	 * validated every value in the effective VIEW before calling, so an unconvertible own value here is
	 * one a higher layer has shadowed — it is never read through this layer, and re-converting it would
	 * double-fault a value the transaction cannot see. It matches the base rewrite's same-reasoned skip.
	 */
	public convertColumn(colIndex: number, convert: (v: SqlValue) => SqlValue, newSchema: TableSchema, convertNulls = false): void {
		const preTree = this.primaryModifications;
		this.tableSchemaAtCreation = newSchema;

		// The parent's primary tree has been REPLACED by the conversion (base rebuilt from fresh
		// rows, or a parent layer already converted oldest-first), so this layer's own tree — which
		// derived from the OLD one — must be rebuilt over the parent's NEW tree, exactly as
		// rekeyPrimaryKey does. The PK is unchanged (a key-column retype is rejected upstream), so
		// pkFunctions and the keys stay; only the value at colIndex moves.
		const { extractFromRow, compare } = this.pkFunctions;
		const parentPrimaryTree = this.parentLayer.getModificationTree('primary');
		const rebuilt = new BTree<BTreeKeyForPrimary, Row>(
			(value: Row): BTreeKeyForPrimary => extractFromRow(value),
			compare,
			{ base: parentPrimaryTree || undefined },
		);

		// Net per-key effect of this layer's own writes, read out of the pre-conversion tree. The PK
		// is unchanged, so a key is either finally-deleted or finally-upserted, never both — no key
		// can collapse onto another (unlike rekeyPrimaryKey).
		const seen = new Set<string>();
		const survivingDeletions: BTreeKeyForPrimary[] = [];
		const upserts: Row[] = [];
		for (const write of this.ownWrites) {
			const encoded = this.pkFunctions.encode(write.primaryKey);
			if (seen.has(encoded)) continue;
			seen.add(encoded);

			// `get` traverses the inheritance chain, so this is the layer's EFFECTIVE row:
			// undefined when the layer deleted the key, the layer's own row otherwise.
			const effectiveRow = preTree.get(write.primaryKey);
			if (effectiveRow === undefined) {
				survivingDeletions.push(write.primaryKey);
				continue;
			}
			let newRow = effectiveRow;
			try {
				newRow = convertRowAtIndex(effectiveRow, colIndex, convert, convertNulls);
			} catch {
				// Shadowed unconvertible own value — leave as-is (see method doc).
			}
			upserts.push(newRow);
		}

		for (const primaryKey of survivingDeletions) {
			const path = rebuilt.find(primaryKey);
			if (path.on) rebuilt.deleteAt(path);
		}
		for (const row of upserts) {
			rebuilt.upsert(row);
		}
		this.primaryModifications = rebuilt;

		this.ownWrites.length = 0;
		for (const primaryKey of survivingDeletions) {
			this.ownWrites.push({ type: 'delete', primaryKey });
		}
		for (const row of upserts) {
			this.ownWrites.push({ type: 'upsert', primaryKey: extractFromRow(row), newRow: row });
		}

		// Any secondary index on the column holds keys extracted from the OLD value. Rebuild every
		// index over the parent's freshly-converted trees (matching the base's unconditional rebuild),
		// then re-file this layer's own converted writes.
		this.secondaryIndexes = new Map();
		this.initializeSecondaryIndexes();
		for (const index of this.secondaryIndexes.values()) {
			this.reindexOwnWrites(index);
		}
	}

	/**
	 * Brings a newly-inherited `MemoryIndex` (built over the parent's tree, which
	 * already covers the parent chain's effective rows) up to date with this layer's own
	 * writes: for each primary key this layer touched, drop the parent's entry and add
	 * this layer's effective row, if any. Both operations copy-on-write into this
	 * layer's tree, leaving the parent's entries untouched.
	 *
	 * Driven by {@link ownWrites} (deduplicated by primary key — the log is an ordered
	 * list that may touch one key repeatedly) rather than a full scan, so the cost is
	 * proportional to the transaction's writes, not the table's size.
	 *
	 * The parent's entry is dropped under the PARENT row's own primary key, not under the
	 * key the write names. After {@link rekeyPrimaryKey} the two can differ — a write of
	 * `'A'` resolves, under NOCASE, to a parent row keyed `'a'` — and filing the removal
	 * under the write's key would leave the parent's entry in place, so an index scan would
	 * return the row twice.
	 */
	private reindexOwnWrites(index: MemoryIndex): void {
		const parentPrimaryTree = this.parentLayer.getModificationTree('primary');
		const seen = new Set<string>();

		for (const write of this.ownWrites) {
			const encoded = this.pkFunctions.encode(write.primaryKey);
			if (seen.has(encoded)) continue;
			seen.add(encoded);

			const parentRow = parentPrimaryTree?.get(write.primaryKey);
			if (parentRow !== undefined && index.rowMatchesPredicate(parentRow)) {
				index.removeEntry(index.keyFromRow(parentRow), this.pkFunctions.extractFromRow(parentRow));
			}
			// `get` traverses the inheritance chain, so this is the layer's EFFECTIVE row:
			// undefined when the layer deleted the key, the layer's own row otherwise.
			const ownRow = this.primaryModifications.get(write.primaryKey);
			if (ownRow !== undefined && index.rowMatchesPredicate(ownRow)) {
				index.addEntry(index.keyFromRow(ownRow), this.pkFunctions.extractFromRow(ownRow));
			}
		}
	}

	getLayerId(): number {
		return this.layerId;
	}

	getParent(): Layer {
		return this.parentLayer;
	}

	getSchema(): TableSchema {
		// Return the schema as it was when this transaction started
		return this.tableSchemaAtCreation;
	}

	isCommitted(): boolean {
		return this._isCommitted;
	}

	/** Marks this layer as committed. Should only be done by MemoryTable. */
	markCommitted(): void {
		if (!this._isCommitted) {
			this._isCommitted = true;
			// With inherited BTrees, we don't need to freeze complex change tracking structures
		}
	}

	/**
	 * Enable change tracking for event emission.
	 * Should be called before mutations if there are listeners.
	 */
	enableChangeTracking(): void {
		if (!this.pendingChanges) {
			this.pendingChanges = [];
		}
	}

	/**
	 * Get pending changes for event emission.
	 */
	getPendingChanges(): readonly PendingChange[] {
		return this.pendingChanges ?? [];
	}

	/** This layer's own structural writes, oldest-first — the rebase replay source. */
	getOwnWrites(): readonly OwnWrite[] {
		return this.ownWrites;
	}

	public getPkExtractorsAndComparators(schema: TableSchema): PkExtractorsAndComparators {
		if (schema !== this.tableSchemaAtCreation) {
			warnLog("TransactionLayer.getPkExtractorsAndComparators called with a schema different from its creation schema. Using creation schema.");
		}

		// Use the centralized primary key functions instead of duplicating the logic
		// This ensures consistent handling of empty primary key definitions
		return {
			primaryKeyExtractorFromRow: this.pkFunctions.extractFromRow,
			primaryKeyComparator: this.pkFunctions.compare,
			primaryKeyEncoder: this.pkFunctions.encode
		};
	}

	getModificationTree(indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null {
		if (indexName === 'primary') return this.primaryModifications;
		return null; // Secondary indexes are accessed via getSecondaryIndexTree
	}

	getSecondaryIndexTree(indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null {
		return this.secondaryIndexes.get(indexName)?.data ?? null;
	}

	getSecondaryIndex(indexName: string): MemoryIndex | undefined {
		return this.secondaryIndexes.get(indexName);
	}

	/** Records an insert or update in this transaction layer */
	recordUpsert(primaryKey: BTreeKeyForPrimary, newRowData: Row, oldRowDataIfUpdate?: Row | null): void {
		if (this._isCommitted) throw new QuereusError("Cannot modify a committed layer");

		this._hasModifications = true;
		this.primaryModifications.upsert(newRowData);

		// Always-on replay log (independent of change tracking).
		this.ownWrites.push({ type: 'upsert', primaryKey, newRow: newRowData });

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: oldRowDataIfUpdate ? 'update' : 'insert',
				pk: primaryKey,
				oldRow: oldRowDataIfUpdate ?? undefined,
				newRow: newRowData,
			});
		}

		// Update secondary indexes (honoring partial-index predicates)
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				const newInScope = memoryIndex.rowMatchesPredicate(newRowData);

				if (oldRowDataIfUpdate) { // UPDATE
					const oldInScope = memoryIndex.rowMatchesPredicate(oldRowDataIfUpdate);

					if (!oldInScope && !newInScope) continue;

					if (oldInScope && !newInScope) {
						const oldIndexKey = memoryIndex.keyFromRow(oldRowDataIfUpdate);
						memoryIndex.removeEntry(oldIndexKey, primaryKey);
						continue;
					}

					if (!oldInScope && newInScope) {
						const newIndexKey = memoryIndex.keyFromRow(newRowData);
						memoryIndex.addEntry(newIndexKey, primaryKey);
						continue;
					}

					// Both in scope
					const oldIndexKey = memoryIndex.keyFromRow(oldRowDataIfUpdate);
					const newIndexKey = memoryIndex.keyFromRow(newRowData);

					// If index key changed, remove old and add new
					if (memoryIndex.compareKeys(oldIndexKey, newIndexKey) !== 0) {
						memoryIndex.removeEntry(oldIndexKey, primaryKey);
						memoryIndex.addEntry(newIndexKey, primaryKey);
					} else {
						// Index key is same, but we might need to update the entry
						// With inherited BTrees, the existing entry will be copied on write
						memoryIndex.addEntry(newIndexKey, primaryKey);
					}
				} else { // INSERT
					if (!newInScope) continue;
					const newIndexKey = memoryIndex.keyFromRow(newRowData);
					memoryIndex.addEntry(newIndexKey, primaryKey);
				}
			}
		}
	}

	/** Records a delete in this transaction layer */
	recordDelete(primaryKey: BTreeKeyForPrimary, oldRowDataForIndexes: Row): void {
		if (this._isCommitted) throw new QuereusError("Cannot modify a committed layer");

		this._hasModifications = true;
		// Find the existing entry
		const existingPath = this.primaryModifications.find(primaryKey);
		if (existingPath.on) {
			// Entry exists (locally or inherited) - use deleteAt to remove it
			this.primaryModifications.deleteAt(existingPath);
		}
		// If key doesn't exist, there's nothing to delete - no deletion marker needed
		// Inheritree's copy-on-write semantics handle this properly

		// Always-on replay log (independent of change tracking).
		this.ownWrites.push({ type: 'delete', primaryKey });

		// Track change for event emission
		if (this.pendingChanges) {
			this.pendingChanges.push({
				type: 'delete',
				pk: primaryKey,
				oldRow: oldRowDataForIndexes,
			});
		}

		// Update secondary indexes to remove entries (only if the deleted row was in scope)
		const schema = this.getSchema();
		if (schema.indexes) {
			for (const indexSchema of schema.indexes) {
				const memoryIndex = this.secondaryIndexes.get(indexSchema.name);
				if (!memoryIndex) continue;

				if (!memoryIndex.rowMatchesPredicate(oldRowDataForIndexes)) continue;

				const oldIndexKey = memoryIndex.keyFromRow(oldRowDataForIndexes);
				memoryIndex.removeEntry(oldIndexKey, primaryKey);
			}
		}
	}

	public hasChanges(): boolean {
		return this._hasModifications;
	}

	/**
	 * Detaches this layer's BTrees from their base, making them self-contained.
	 * This should be called when the layer becomes the new effective base.
	 */
	public clearBase(): void {
		this.primaryModifications.clearBase();
		for (const memoryIndex of this.secondaryIndexes.values()) {
			memoryIndex.clearBase();
		}
	}
}
