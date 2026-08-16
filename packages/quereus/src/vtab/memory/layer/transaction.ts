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
import { convertRowAtIndex, makePrimaryKeyConverter } from './row-convert.js';

const log = createLogger('vtab:memory:layer:transaction');
const warnLog = log.extend('warn');

let transactionLayerCounter = 1000;

/**
 * Pending change for event emission.
 */
export interface PendingChange {
	type: 'insert' | 'update' | 'delete';
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
 * One layer's net own-writes re-derived under a NEW primary key definition (`alter table …
 * alter primary key`), computed without mutation by
 * {@link TransactionLayer.prepareRekeyedPrimaryKeyColumns} and installed by
 * {@link TransactionLayer.installRekeyedPrimaryKeyColumns}. Split into two phases because a
 * net DELETION's new key can only be derived from the row image the PARENT layer holds at
 * the old key ({@link OwnWrite} carries no image for a delete) — and by install time,
 * oldest-first processing has already replaced the parent's tree with one keyed by the new
 * definition, where an old-shaped key means nothing. So every layer's prepare runs against
 * the intact old chain, before the first rebuild anywhere.
 */
export interface PreparedPrimaryKeyRekey {
	/**
	 * The layer's net deletions: `newKey` re-derived from the parent's row image (what the
	 * rebuilt tree is keyed by), `oldKey` as the write recorded it (the replay's identity
	 * check — proof the row `find(newKey)` lands on is the row this layer deleted).
	 */
	deletions: Array<{ newKey: BTreeKeyForPrimary; oldKey: BTreeKeyForPrimary }>;
	/** The layer's net effective rows. A key-column change moves no stored value, so rows pass verbatim. */
	upserts: Row[];
}

/**
 * One layer's net own-writes at the post-ADD/DROP-COLUMN arity, computed fallibly by
 * {@link TransactionLayer.prepareReshapedColumns} and installed infallibly by
 * {@link TransactionLayer.installReshapedColumns} — see those methods for why the
 * two phases are split.
 */
export interface PreparedColumnReshape {
	/** Keys this layer's net effect deletes. Key values are invariant under a column-set change. */
	survivingDeletions: BTreeKeyForPrimary[];
	/** This layer's net effective rows, rewritten to the new column set. */
	upserts: Row[];
	/**
	 * The layer's {@link PendingChange} event log with every row image rewritten to the
	 * new column set, or null when change tracking is disabled. Unlike the own-write
	 * collapse above, the log is NOT deduplicated — every recorded write stays a
	 * separate event, because that is the delivered contract.
	 */
	reshapedPendingChanges: PendingChange[] | null;
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
	 * `drop constraint`); by {@link rekeyPrimaryKey} when that collate change lands on a
	 * primary-key column; by {@link installRekeyedPrimaryKeyColumns} when `alter primary key`
	 * moves the key's column set; and by {@link installReshapedColumns} when `add column` /
	 * `drop column` changes the column set itself. Every swap except the last keeps the
	 * column set identical.
	 */
	private tableSchemaAtCreation: TableSchema;

	/**
	 * Derived from {@link tableSchemaAtCreation}'s primary key definition, so the primary
	 * tree, every inherited secondary index, and every scan share one comparator/encoder
	 * set — and one pass of collation resolution. Rebuilt only by {@link rekeyPrimaryKey},
	 * {@link installRekeyedPrimaryKeyColumns}, and {@link installReshapedColumns}, each of
	 * which rebuilds the structures keyed by them in the same call.
	 */
	private pkFunctions: PrimaryKeyFunctions;

	// Primary modifications BTree that inherits from parent
	private primaryModifications: BTree<BTreeKeyForPrimary, Row>;

	// Secondary index BTrees that inherit from parent's indexes
	private secondaryIndexes: Map<string, MemoryIndex>;

	private _isCommitted: boolean = false;
	private _hasModifications: boolean = false;
	/** How many child layers have derived BTrees from this one — see {@link Layer.noteDerivedChild}. */
	private derivedChildCount = 0;

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

		// Before any tree is built over the parent's: from here on the parent may not be
		// promoted, because `clearBase()` on it would move its `chainVersion()` out from
		// under the snapshot this layer's trees are about to take.
		parent.noteDerivedChild();

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
	 * {@link rekeyPrimaryKey} instead, a column-set change (`add column` / `drop column`) to
	 * {@link prepareReshapedColumns} / {@link installReshapedColumns}, and
	 * `ensureSchemaChangeSafety` raises BUSY when any connection other than the DDL issuer
	 * holds a pending layer.
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
	 * The deletion replay verifies, under the OLD comparator, that the row it finds is the row
	 * it removed (see {@link installNetOwnWrites}'s `deletionTargets`). Without that check a
	 * deletion whose old key collapses onto a DIFFERENT row's new key deletes that other row:
	 * stage an upsert at key `'a'` in one layer, delete the colliding `'A'` from a LATER layer,
	 * and the later layer's replayed deletion lands on the parent's `'a'` — silently removing
	 * the row the transaction just wrote. `validateRekeyedPrimaryKey`'s chain walk refuses any
	 * chain that holds a colliding pair before this method runs, which makes a cross-row land
	 * unreachable today — the verify is insurance, so the replay's own correctness does not
	 * hinge on that caller-side pass staying exactly as conservative as it is.
	 */
	public rekeyPrimaryKey(newSchema: TableSchema): void {
		// The pending-change EVENT log is deliberately NOT rewritten here: a collation
		// change moves only the comparator — every stored value is untouched — so the
		// recorded `oldRow`/`newRow` images stay accurate as-is.
		// (Contrast convertColumn / installReshapedColumns, which do rewrite the log.)
		const preRekeyTree = this.primaryModifications;
		const preRekeyFunctions = this.pkFunctions;
		const preRekeyEncode = preRekeyFunctions.encode;

		this.tableSchemaAtCreation = newSchema;
		this.pkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);

		// Net per-key effect of this layer's own writes, read out of the pre-rekey tree.
		const deletions: BTreeKeyForPrimary[] = [];
		const upserts: Row[] = [];
		for (const { write, effectiveRow } of this.netOwnWriteEffects(preRekeyTree, preRekeyEncode)) {
			if (effectiveRow === undefined) deletions.push(write.primaryKey);
			else upserts.push(effectiveRow);
		}

		// Only the re-key can make a deletion's find() land on a colliding OTHER row, so only
		// this caller passes the old-comparator identity check (see the method doc above).
		this.installNetOwnWrites(deletions, upserts, (deletionKey, foundRow) =>
			preRekeyFunctions.compare(deletionKey, preRekeyFunctions.extractFromRow(foundRow)) === 0);
	}

	/**
	 * Phase 1 of adopting `alter table … alter primary key` — a change of the key's COLUMNS,
	 * where {@link rekeyPrimaryKey} handles only a change of its comparator — applied while
	 * THIS layer's transaction is still open. Computes, without mutating anything, the net
	 * per-key effect of the layer's own writes re-derived under `newPkFunctions`: see
	 * {@link PreparedPrimaryKeyRekey} for each piece and the field docs for why the phases
	 * are split (a deletion's new key comes from the parent's row image, which only the
	 * intact OLD chain can resolve).
	 *
	 * A deletion whose old key resolves to no parent row was a no-op when recorded
	 * (`recordDelete` tolerates a missing key) and is dropped — there is no image to re-key
	 * and nothing for the replay to remove.
	 *
	 * An UPSERT can owe a deletion too. Under the OLD key an upsert shadowed the parent's
	 * row at the same key; under the new definition the two images can land at DIFFERENT
	 * keys — a pending `update t set b = 7` before `alter primary key (a, b)` moves the
	 * row from `(a, 5)` to `(a, 7)` — and replaying only the upsert would leave the
	 * parent's pre-update image visible beside it. So each upsert that shadows a parent
	 * row landing elsewhere also emits a deletion of that parent image's new key.
	 *
	 * Soundness of the per-write collapse rests on the same precondition as
	 * {@link rekeyPrimaryKey}'s: `MemoryTableManager.validateRekeyedPrimaryKey` has proven no
	 * layer's merged view holds two rows that collide under the new definition, so every
	 * surviving deletion's `newKey` is distinct and every upsert lands at exactly one key.
	 */
	public prepareRekeyedPrimaryKeyColumns(newPkFunctions: PrimaryKeyFunctions): PreparedPrimaryKeyRekey {
		const oldFunctions = this.pkFunctions;
		const parentTree = this.parentLayer.getModificationTree('primary');

		const deletions: Array<{ newKey: BTreeKeyForPrimary; oldKey: BTreeKeyForPrimary }> = [];
		const upserts: Row[] = [];
		for (const { write, effectiveRow } of this.netOwnWriteEffects(this.primaryModifications, oldFunctions.encode)) {
			const parentRow = parentTree?.get(write.primaryKey);
			if (effectiveRow !== undefined) {
				upserts.push(effectiveRow);
				// The shadowed parent image, if its new key diverges from the upsert's —
				// see the method doc. Same-key shadows are handled by the replay's upsert.
				if (parentRow !== undefined
					&& newPkFunctions.compare(
						newPkFunctions.extractFromRow(parentRow),
						newPkFunctions.extractFromRow(effectiveRow)) !== 0) {
					deletions.push({ newKey: newPkFunctions.extractFromRow(parentRow), oldKey: write.primaryKey });
				}
				continue;
			}
			if (parentRow === undefined) continue; // deletion of a key that never existed below — a no-op
			deletions.push({ newKey: newPkFunctions.extractFromRow(parentRow), oldKey: write.primaryKey });
		}

		// The pending-change EVENT log needs nothing here: a change records only its row
		// images, and `MemoryTableManager.commitTransaction` projects the delivered `key` out
		// of them through the primary key of the schema current AT DELIVERY. So the re-key of
		// the events is the projection itself, and the images this rewrite leaves untouched
		// (a key-column change moves no stored value) are already the right ones.
		return { deletions, upserts };
	}

	/**
	 * Phase 2 of adopting `alter table … alter primary key`: installs what
	 * {@link prepareRekeyedPrimaryKeyColumns} computed. Swaps in the new schema, rebuilds
	 * {@link pkFunctions}, replays the net own-writes into a tree over the parent's
	 * already-rebuilt one, and rebuilds every secondary index (each embeds the primary key in
	 * its entries). Synchronous and mutation-only. The pending-change event log is untouched —
	 * it stores only row images, and the delivered key is projected from them at commit.
	 *
	 * Like every whole-layer rebuild, the caller MUST apply this oldest-first with the base
	 * already re-keyed: the rebuilt tree inherits copy-on-write from the parent's NEW one.
	 *
	 * The deletion replay verifies the row it finds is the row this layer deleted, by
	 * comparing the found row's OLD key against the deletion's recorded one — the same
	 * insurance {@link rekeyPrimaryKey} buys with its old-comparator check, phrased through
	 * the prepared `oldKey` because here find() runs under a key whose columns the old
	 * comparator cannot read. The old extractor stays valid: a primary-key change moves no
	 * column, so the old key columns still exist in every row.
	 */
	public installRekeyedPrimaryKeyColumns(newSchema: TableSchema, prepared: PreparedPrimaryKeyRekey): void {
		const oldFunctions = this.pkFunctions;
		this.tableSchemaAtCreation = newSchema;
		this.pkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);

		// Every surviving deletion's newKey is distinct (see the prepare doc), so the
		// encoded-key map cannot clobber an entry.
		const oldKeyByNewEncoded = new Map<string, BTreeKeyForPrimary>();
		for (const { newKey, oldKey } of prepared.deletions) {
			oldKeyByNewEncoded.set(this.pkFunctions.encode(newKey), oldKey);
		}
		this.installNetOwnWrites(
			prepared.deletions.map(d => d.newKey),
			prepared.upserts,
			(deletionKey, foundRow) => {
				const oldKey = oldKeyByNewEncoded.get(this.pkFunctions.encode(deletionKey));
				return oldKey !== undefined
					&& oldFunctions.compare(oldKey, oldFunctions.extractFromRow(foundRow)) === 0;
			},
		);
	}

	/**
	 * A fresh primary tree inheriting copy-on-write from the parent's CURRENT one, keyed by this
	 * layer's current {@link pkFunctions}. Callers must have installed the post-DDL `pkFunctions`
	 * first, and the parent must already carry the DDL (every whole-layer rebuild runs oldest-first).
	 */
	private newPrimaryTreeOverParent(): BTree<BTreeKeyForPrimary, Row> {
		const { extractFromRow, compare } = this.pkFunctions;
		return new BTree<BTreeKeyForPrimary, Row>(
			(value: Row): BTreeKeyForPrimary => extractFromRow(value),
			compare,
			{ base: this.parentLayer.getModificationTree('primary') || undefined },
		);
	}

	/**
	 * Shared HEAD of every whole-layer rebuild: each key {@link ownWrites} touched, exactly
	 * once, paired with the layer's EFFECTIVE row at that key — `undefined` when the layer
	 * finally deleted it, the layer's own row otherwise (`get` traverses the inheritance
	 * chain). Collapsing the ordered log to one entry per key is what lets a rebuild replay
	 * the net effect instead of the history; see each caller's doc for why its own rebuild
	 * needs that.
	 *
	 * `tree` and `encode` are passed rather than read off `this` because a re-key consumes
	 * this AFTER swapping {@link pkFunctions}, and must still dedup under the OLD encoding of
	 * the OLD tree.
	 */
	private *netOwnWriteEffects(
		tree: BTree<BTreeKeyForPrimary, Row>,
		encode: (pk: BTreeKeyForPrimary) => string,
	): Generator<{ write: OwnWrite; effectiveRow: Row | undefined }> {
		const seen = new Set<string>();
		for (const write of this.ownWrites) {
			const encoded = encode(write.primaryKey);
			if (seen.has(encoded)) continue;
			seen.add(encoded);
			yield { write, effectiveRow: tree.get(write.primaryKey) };
		}
	}

	/**
	 * Shared tail of the four whole-layer rebuilds — {@link rekeyPrimaryKey},
	 * {@link installRekeyedPrimaryKeyColumns}, {@link convertColumn},
	 * {@link installReshapedColumns}. Each has already swapped in its new
	 * schema (and, where the key changed, its new {@link pkFunctions}) and collapsed
	 * {@link ownWrites} to the net per-key effect passed here; this replays that effect into a
	 * tree built over the parent's fresh one, installs it, rewrites the own-write log to match,
	 * and rebuilds every secondary index.
	 *
	 * Every index is rebuilt unconditionally, not only those over an altered column: each inherits
	 * the parent's freshly-rebuilt tree, and each index's key encoding and PK bookkeeping derive
	 * from `pkFunctions`.
	 *
	 * A deletion an upsert has since re-occupied is dropped from the log — keeping it would make
	 * the log claim both a deletion and an upsert of the same key. Only the two re-keys can
	 * produce that collision (two old keys collapsing under the new comparator, or a shadowed
	 * parent image whose new key another write's row now occupies); where key values are
	 * invariant a key is classified as either a deletion or an upsert, never both, so the filter
	 * is a no-op.
	 *
	 * `deletionTargets` guards each deletion's replay: `find(key)` runs under the NEW key, so a
	 * re-key can land it on a colliding row this layer never removed — a row a PARENT layer
	 * upserted at what is now the same key. Only the two re-keys pass it (each an old-key
	 * identity check on the found row). The column-set rebuild leaves key values untouched, so
	 * find() can only land on the deleted key itself; the value rebuild ({@link convertColumn})
	 * may move a key member's values but replays under a precondition that rules a cross-row
	 * land out (see its doc), and has no image to check against anyway.
	 */
	private installNetOwnWrites(
		deletions: readonly BTreeKeyForPrimary[],
		upserts: readonly Row[],
		deletionTargets?: (deletionKey: BTreeKeyForPrimary, foundRow: Row) => boolean,
	): void {
		const rebuilt = this.newPrimaryTreeOverParent();
		for (const primaryKey of deletions) {
			const path = rebuilt.find(primaryKey);
			if (!path.on) continue;
			if (deletionTargets && !deletionTargets(primaryKey, rebuilt.at(path)!)) continue;
			rebuilt.deleteAt(path);
		}
		for (const row of upserts) {
			rebuilt.upsert(row);
		}
		this.primaryModifications = rebuilt;

		const { extractFromRow } = this.pkFunctions;
		this.ownWrites.length = 0;
		for (const primaryKey of deletions) {
			if (rebuilt.get(primaryKey) === undefined) this.ownWrites.push({ type: 'delete', primaryKey });
		}
		for (const row of upserts) {
			this.ownWrites.push({ type: 'upsert', primaryKey: extractFromRow(row), newRow: row });
		}

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
	 * The key DEFINITION is unchanged — `MemoryTableManager.alterColumn` rejects any retype of a
	 * key column before any mutation, and SET NOT NULL touches no collation or type — so
	 * {@link pkFunctions} stay. The key VALUES may move, though: a SET NOT NULL backfill of a
	 * PRIMARY-KEY member (a key column is nullable whenever the table's identity is its full column
	 * set) rewrites NULL → DEFAULT inside the key. Own rows re-key themselves — the tree extracts
	 * each key from the converted row — but a staged DELETION carries only its OLD key, recorded
	 * when the delete was staged and still encoding the pre-backfill NULL, and the parent's tree it
	 * must be replayed into has already been rebuilt over converted rows where that key no longer
	 * exists (a replay under the old key would land nowhere and RESURRECT the deleted row). So a
	 * deletion's key is re-derived under the same conversion, at the key's position for `colIndex`.
	 * Soundness rests on the precondition `MemoryTableManager.validateRekeyedPrimaryKey` establishes
	 * over the CONVERTED rows before any of this runs: no layer in the chain, base included, holds
	 * two rows that converge under the backfill — so every re-derived deletion key resolves to at
	 * most one row in the parent, the converted image of the very row this layer deleted, and no
	 * `deletionTargets` identity check is needed (nor possible: a deletion carries no image, and
	 * the conversion is not invertible). (Contrast {@link rekeyPrimaryKey}, where the comparator
	 * itself changes and pkFunctions must be rebuilt.)
	 *
	 * Subsumes {@link adoptSchema} for a same-storage-class retype that ALSO moves the comparator
	 * (text → date/timespan): `tableSchemaAtCreation` is swapped to `newSchema` and every secondary
	 * index is rebuilt from scratch against it below, so the layer's structures pick up the new
	 * comparators along with the converted values.
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
		const convertKey = makePrimaryKeyConverter(newSchema, colIndex, convert, convertNulls);

		// The parent's primary tree has been REPLACED by the conversion (base rebuilt from fresh
		// rows, or a parent layer already converted oldest-first), so this layer's own tree — which
		// derived from the OLD one — must be rebuilt over the parent's NEW tree; installNetOwnWrites
		// below does that. The PK DEFINITION is unchanged (a key-column retype is rejected
		// upstream), so pkFunctions stay; the value at colIndex moves, and with it — when colIndex is
		// a key member — the key, so a surviving deletion's key is re-derived (see the method doc).
		// The pre-pass has refused any chain in which two rows converge, so a key is still either
		// finally-deleted or finally-upserted, never both, and no key can collapse onto another
		// (unlike rekeyPrimaryKey). The net per-key effect is read out of the pre-conversion tree.
		const survivingDeletions: BTreeKeyForPrimary[] = [];
		const upserts: Row[] = [];
		for (const { write, effectiveRow } of this.netOwnWriteEffects(preTree, this.pkFunctions.encode)) {
			if (effectiveRow === undefined) {
				survivingDeletions.push(convertKey(write.primaryKey));
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

		this.installNetOwnWrites(survivingDeletions, upserts);

		// Rewrite the pending-change EVENT log's images too, so the events emitted at this
		// table's commit carry the post-conversion values the committed rows hold. Best-effort,
		// per image: the log holds historical images (including superseded intermediate ones the
		// net rewrite above never touches), so an unconvertible value keeps its raw form rather
		// than failing the ALTER. One entry per recorded write is kept — no dedup, unlike the
		// own-write collapse — because every recorded write is a separately delivered event.
		if (this.pendingChanges) {
			this.pendingChanges = this.pendingChanges.map(change => {
				const remapImage = (row: Row | undefined): Row | undefined => {
					if (!row) return row;
					try {
						return convertRowAtIndex(row, colIndex, convert, convertNulls);
					} catch {
						return row;
					}
				};
				return { ...change, oldRow: remapImage(change.oldRow), newRow: remapImage(change.newRow) };
			});
		}
	}

	/**
	 * Computes — without mutating anything — what {@link installReshapedColumns} will install
	 * for an `alter table … add column` / `drop column` applied while THIS layer's transaction
	 * is still open: the net per-key effect of the layer's own writes, with each surviving row
	 * run through `reshapeRow` to the new column set.
	 *
	 * Split from the install (unlike {@link convertColumn}, which mutates in one pass) because
	 * this rewrite can FAIL: an ADD COLUMN with a per-row `default (new.<col>)` expression
	 * evaluates that expression against each pending row, and it can throw — or produce NULL
	 * for a NOT NULL column — on a pending row even when every committed row backfilled cleanly.
	 * The rewrite is async for the same reason (`convertColumn`'s value map is a pure function;
	 * a backfill evaluator is engine-supplied and may await). `MemoryTableManager` therefore runs
	 * every prepare — one per open layer — BEFORE the first mutation anywhere (base included), so
	 * a failure rejects the whole ALTER with every structure untouched; there is no undo for a
	 * half-reshaped layer chain.
	 *
	 * Own writes collapse to one entry per key exactly as {@link convertColumn}'s pass does: a
	 * column-set change leaves every primary key VALUE untouched (ADD introduces a column no key
	 * reads — even when it is inserted ahead of one, which only renumbers the key's *indices*;
	 * dropping a PK column is rejected upstream), so a key is either finally-deleted or
	 * finally-upserted, never both, and no key can collapse onto another.
	 */
	public async prepareReshapedColumns(
		reshapeRow: (row: Row) => Row | Promise<Row>,
		reshapeEventRow: (row: Row) => Row | Promise<Row>,
	): Promise<PreparedColumnReshape> {
		const survivingDeletions: BTreeKeyForPrimary[] = [];
		const upserts: Row[] = [];
		for (const { write, effectiveRow } of this.netOwnWriteEffects(this.primaryModifications, this.pkFunctions.encode)) {
			if (effectiveRow === undefined) {
				survivingDeletions.push(write.primaryKey);
				continue;
			}
			upserts.push(await reshapeRow(effectiveRow));
		}

		// Reshape the pending-change EVENT log alongside — through `reshapeEventRow`, the
		// BEST-EFFORT variant of `reshapeRow`, deliberately the opposite posture: `reshapeRow`
		// rewrites the layer's net effective rows and its failure MUST reject the ALTER, while
		// the log holds historical images (including superseded intermediate ones the net
		// rewrite never touches) that a backfill evaluator can legitimately fail on. The
		// caller supplies a `reshapeEventRow` that falls back rather than throws (ADD COLUMN
		// fills NULL when the evaluator fails); a throw that still escapes leaves that image
		// at the old arity (logged) and never rejects the ALTER. One entry per recorded write
		// is kept — no dedup, unlike the own-write collapse above — because every recorded
		// write is a separately delivered event.
		let reshapedPendingChanges: PendingChange[] | null = null;
		if (this.pendingChanges) {
			reshapedPendingChanges = [];
			for (const change of this.pendingChanges) {
				const next: PendingChange = { ...change };
				try {
					if (change.oldRow) next.oldRow = await reshapeEventRow(change.oldRow);
					if (change.newRow) next.newRow = await reshapeEventRow(change.newRow);
				} catch (e) {
					warnLog('Pending-change reshape failed on %s; leaving image at the old arity: %O',
						this.tableSchemaAtCreation.name, e);
				}
				reshapedPendingChanges.push(next);
			}
		}
		return { survivingDeletions, upserts, reshapedPendingChanges };
	}

	/**
	 * Adopts an `alter table … add column` / `drop column` applied while THIS layer's
	 * transaction is still open, installing what {@link prepareReshapedColumns} computed:
	 * swaps in the new schema, rebuilds the primary tree over the parent's already-reshaped
	 * one, replays the layer's net own-writes at the new arity, and rebuilds every secondary
	 * index. Synchronous and mutation-only — everything fallible ran in the prepare phase.
	 *
	 * {@link pkFunctions} is REBUILT (unlike {@link convertColumn}, which keeps it): a column-set
	 * change can shift the primary key's column *indices* — DROP COLUMN renumbers
	 * `primaryKeyDefinition` past the dropped slot, and an ADD COLUMN placed AHEAD of a key
	 * column (`insertAtIndex`, module-API only) renumbers it past the inserted slot — so the row
	 * extractor changes even though the key *values* do not. Because the values are invariant
	 * under both ADD (the new column is not part of any key, wherever it lands) and DROP
	 * (dropping a PK column is rejected upstream), tree ordering is preserved and the
	 * `primaryKey` values recorded in {@link ownWrites} stay valid — no re-key of the kind
	 * {@link rekeyPrimaryKey} performs is needed, and the prepared deletions apply verbatim.
	 *
	 * Like every other open-layer adoption, the caller MUST apply this to the whole parent
	 * chain oldest-first (base already reshaped): the rebuilt tree inherits copy-on-write from
	 * the parent's NEW tree, so the parent's must already hold rows at the new arity. The
	 * rewritten {@link ownWrites} log — carrying reshaped rows — is what the commit-time rebase
	 * and any later `create index` ({@link reindexOwnWrites}) replay.
	 */
	public installReshapedColumns(newSchema: TableSchema, prepared: PreparedColumnReshape): void {
		this.tableSchemaAtCreation = newSchema;
		this.pkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);

		this.installNetOwnWrites(prepared.survivingDeletions, prepared.upserts);
		// Install the reshaped event log the prepare phase computed (null ⇔ tracking
		// disabled), so the events emitted at this table's commit describe rows in the
		// post-ALTER column set.
		if (prepared.reshapedPendingChanges !== null) {
			this.pendingChanges = prepared.reshapedPendingChanges;
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

	noteDerivedChild(): void {
		this.derivedChildCount++;
	}

	hasDerivedChildren(): boolean {
		return this.derivedChildCount > 0;
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

	/**
	 * Drops the pending-change event log (tracking stays enabled). Called when this
	 * layer's content is drained into the base by ALTER's consolidation
	 * (`MemoryTableManager.consolidateToBaseLayer`): its events were already delivered
	 * when the layer originally committed, but the layer can remain in the DDL
	 * connection's open-transaction parent chain — and once the base becomes the
	 * committed head, the commit-time collection (`collectPendingChanges`) walks that
	 * chain all the way down to the base and would re-deliver them.
	 */
	clearPendingChanges(): void {
		if (this.pendingChanges) this.pendingChanges = [];
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
	 *
	 * ONLY legal while {@link hasDerivedChildren} is false. Dropping the base pointer
	 * removes the base's contribution from each tree's `chainVersion()`, so any tree
	 * already derived from these ones fails its next `checkBase()` with
	 * `MutatedBaseError`; and per inheritree's own contract the detached tree still
	 * shares nodes by identity with its former base, so base-immutability outlives the
	 * call. `MemoryTableManager.tryCollapseLayers` is the only caller and enforces it.
	 */
	public clearBase(): void {
		this.primaryModifications.clearBase();
		for (const memoryIndex of this.secondaryIndexes.values()) {
			memoryIndex.clearBase();
		}
	}
}
