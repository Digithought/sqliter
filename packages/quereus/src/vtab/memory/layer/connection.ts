import type { Layer } from './interface.js';
import type { TransactionLayer } from './transaction.js';
import type { MemoryTableManager } from './manager.js';
import { createLogger } from '../../../common/logger.js';
import { StatusCode } from '../../../common/types.js';
import { quereusError } from '../../../common/errors.js';

let connectionCounter = 0;
const log = createLogger('vtab:memory:layer:connection');
const warnLog = log.extend('warn');
const debugLog = log;

/**
 * Represents the state of a single connection to a MemoryTable
 * within the layer-based MVCC model.
 */
export class MemoryTableConnection {
	public readonly connectionId: number;
	public readonly tableManager: MemoryTableManager;
	public readLayer: Layer;
	public pendingTransactionLayer: TransactionLayer | null = null;
	public explicitTransaction: boolean = false; // Track if transaction was explicitly started

	/**
	 * Stack of savepoint entries, indexed by depth from TransactionManager.
	 *
	 * Each slot stores:
	 *   - `snapshot`: the immutable savepoint snapshot when a pending layer
	 *     existed at savepoint time (eager path), or `null` if pending was
	 *     null (lazy marker — no eager copy needed).
	 *   - `readLayer`: the connection's readLayer at savepoint creation time,
	 *     used to restore the read view when rolling back to a lazy marker
	 *     that follows an outer eager-swap (otherwise the rollback would
	 *     leave readLayer pointing at the inner snapshot's data).
	 *
	 * Eager path (snapshot != null): `createSavepoint` swaps `readLayer` to
	 * the snapshot and clears `pendingTransactionLayer`, so the next mutation
	 * allocates a fresh pending layer parented on the snapshot. This
	 * preserves the "SELECT iterates an immutable layer while INSERT writes
	 * a fresh child BTree" invariant, fixing mid-transaction halloween in
	 * self-referential INSERT...SELECT.
	 */
	private savepointStack: Array<{ snapshot: TransactionLayer | null; readLayer: Layer; readSnapshot: TransactionLayer | null }> = [];

	/**
	 * The eager savepoint snapshot currently serving as {@link readLayer}, or null when
	 * `readLayer` is a committed layer. Non-null exactly while this connection's
	 * uncommitted writes live in `readLayer` rather than in `pendingTransactionLayer`.
	 *
	 * Cannot be derived from {@link savepointStack}: `RELEASE` pops the entry that holds
	 * the snapshot, but the snapshot stays installed as `readLayer` and its rows stay
	 * uncommitted. See {@link hasOpenWork}.
	 */
	private readSnapshot: TransactionLayer | null = null;

	constructor(manager: MemoryTableManager, initialReadLayer: Layer) {
		this.connectionId = connectionCounter++;
		this.tableManager = manager;
		this.readLayer = initialReadLayer;
	}

	/** Begins a transaction by marking explicitTransaction. The pending layer is created lazily on first mutation */
	begin(): void {
		if (this.pendingTransactionLayer) {
			// Already in transaction – same SQLite semantics: BEGIN is a no-op
			this.explicitTransaction = true; // upgrade auto txn to explicit
			return;
		}

		// Do NOT create a TransactionLayer yet.  It will be created lazily by
		// ensureTransactionLayer() on the first data-mutation, so its parent
		// will always be the then-current committed layer.
		this.explicitTransaction = true;

		debugLog(`Connection %d: BEGIN (lazy layer creation)`, this.connectionId);
	}

	/** Commits the current transaction */
	async commit(): Promise<void> {
		// If readLayer is a swapped savepoint snapshot (eager path), its data
		// must be promoted into the committed chain on commit even when no
		// further mutations created a new pending layer afterwards.
		// commitTransaction handles the lazy pending-layer creation in that
		// case.
		if (this.pendingTransactionLayer
			|| this.readLayer !== this.tableManager.currentCommittedLayer) {
			await this.tableManager.commitTransaction(this);
			// commitTransaction handles updating connection state (readLayer, pendingTransactionLayer)
		}
		// Always clear transaction state: DB-level commit broadcasts hit every
		// connection regardless of whether it had work to do, and the connection
		// must come out of explicit-transaction mode so subsequent autocommit
		// statements work correctly.
		this.clearTransactionState();
	}

	/** Rolls back the current transaction */
	rollback(): void {
		// Reset readLayer to the current committed layer; readLayer may have
		// been swapped to a savepoint snapshot by createSavepoint's eager path.
		this.readLayer = this.tableManager.currentCommittedLayer;

		// Discard any pending layer
		this.pendingTransactionLayer = null;
		// Always clear transaction state: DB-level rollback broadcasts hit every
		// connection regardless of whether it had work to do, and the connection
		// must come out of explicit-transaction mode so subsequent autocommit
		// statements work correctly.
		this.clearTransactionState();

		debugLog(`Connection %d: Rolled back transaction, readLayer reset to ${this.readLayer.getLayerId()}`,
			this.connectionId);
	}

	/** Helper method to clear transaction-related state */
	private clearTransactionState(): void {
		this.savepointStack = [];
		this.readSnapshot = null;
		this.explicitTransaction = false;
	}

	/** Creates a savepoint at the given depth index */
	createSavepoint(depth: number): void {
		if (depth < 0) {
			quereusError(`Invalid savepoint depth: ${depth}. Must be non-negative.`, StatusCode.INTERNAL);
		}

		// Capture readLayer BEFORE any swap so rollback to a later lazy marker
		// can restore the pre-swap view (see the comment on `savepointStack`).
		const savedReadLayer = this.readLayer;
		const savedReadSnapshot = this.readSnapshot;

		// Lazy-snapshot: if no pending layer exists yet, store a null snapshot
		// marker instead of eagerly promoting. The pending layer will be created
		// on first mutation; rolling back to a lazy marker restores the
		// no-pending state with the saved readLayer.
		//
		// Eager-snapshot: promote the existing pending layer to immutable
		// (markCommitted) and reuse it as the snapshot. Data-copying via a
		// fresh layer doesn't survive "delete of inherited row" — the copy
		// iterates the post-delete view (which already excludes the row),
		// so a fresh layer would re-inherit the original entry from the
		// parent BTree. Promoting the layer keeps the BTree's
		// copy-on-write structure (with the cloned-and-spliced leaf)
		// intact.
		let snapshot: TransactionLayer | null = null;
		if (this.pendingTransactionLayer) {
			snapshot = this.pendingTransactionLayer;
			snapshot.markCommitted();
		}
		this.savepointStack.push({ snapshot, readLayer: savedReadLayer, readSnapshot: savedReadSnapshot });

		// Eager-snapshot path: swap the immutable snapshot in as readLayer and
		// drop the now-stale pending layer reference, so the next mutation
		// allocates a fresh pending layer parented on the snapshot. This keeps
		// SELECT iterators reading the snapshot's BTree while INSERTs mutate a
		// different BTree (the new pending's copy-on-write child), matching
		// the autocommit invariant for self-referential INSERT...SELECT.
		if (snapshot) {
			this.readLayer = snapshot;
			this.pendingTransactionLayer = null;
			this.readSnapshot = snapshot;
		}

		// A SAVEPOINT implicitly puts the connection into explicit-transaction mode
		// so that subsequent statements do NOT auto-commit and invalidate the savepoint.
		this.explicitTransaction = true;

		debugLog(`Connection %d: Created savepoint at depth %d (stack size: %d)`,
			this.connectionId, depth, this.savepointStack.length);
	}

	/** Releases savepoints from the top of the stack down to the target depth (exclusive) */
	releaseSavepoint(targetDepth: number): void {
		// Don't short-circuit on missing pendingTransactionLayer: a statement
		// savepoint may have pushed a null marker, and the matching release
		// must still pop it.
		if (targetDepth > this.savepointStack.length) {
			// Setting `Array.length` to a value larger than the current length
			// pads with undefined slots, corrupting subsequent rollback-to /
			// release lookups. Skip with a warning — the most likely cause is a
			// failed savepoint replay during `Database.registerConnection`.
			warnLog(`Connection %d: Release savepoint depth %d out of range (stack size: %d)`,
				this.connectionId, targetDepth, this.savepointStack.length);
			return;
		}
		this.savepointStack.length = targetDepth;
		debugLog(`Connection %d: Released savepoints to depth %d`, this.connectionId, targetDepth);
	}

	/**
	 * Rolls back to a savepoint at the target depth, restoring the transaction layer.
	 * The savepoint is preserved (per SQL standard) so it can be rolled back to again.
	 */
	rollbackToSavepoint(targetDepth: number): void {
		if (targetDepth >= this.savepointStack.length) {
			warnLog(`Connection %d: Savepoint depth %d out of range (stack size: %d)`,
				this.connectionId, targetDepth, this.savepointStack.length);
			return;
		}

		const entry = this.savepointStack[targetDepth];

		if (entry.snapshot === null) {
			// Lazy-snapshot marker: at savepoint creation there was no pending
			// layer. Restore both readLayer (in case an outer eager-swap
			// happened since) and clear pending.
			this.readLayer = entry.readLayer;
			this.pendingTransactionLayer = null;
			this.readSnapshot = entry.readSnapshot;
		} else {
			// Eager-snapshot path: createSavepoint swapped readLayer to the
			// snapshot and dropped pendingTransactionLayer. Restore that exact
			// state on rollback — the next mutation will lazily create a new
			// pending layer parented on the snapshot.
			this.readLayer = entry.snapshot;
			this.pendingTransactionLayer = null;
			this.readSnapshot = entry.snapshot;
		}

		// Remove savepoints above the target, but preserve the target itself
		this.savepointStack.length = targetDepth + 1;

		debugLog(`Connection %d: Rolled back to savepoint depth %d (preserved)`,
			this.connectionId, targetDepth);
	}

	/**
	 * Re-points every LAZY savepoint marker that captured a committed-chain view at
	 * `committedHead`. Called by `MemoryTableManager.ensureSchemaChangeSafety` once a schema
	 * change has drained the committed layers into the base: a marker still naming a drained
	 * layer would, on `rollback to savepoint`, reinstate that layer's PRE-change rows as the
	 * read view — rows in the old column shape under the new schema, which then commit as
	 * permanent corruption.
	 *
	 * Only markers with `readSnapshot === null` move. A non-null `readSnapshot` means the
	 * captured `readLayer` is this connection's OWN eager savepoint snapshot, holding
	 * uncommitted rows that base does not have; re-pointing it would discard them. Those layers
	 * are instead carried across the change by the manager's open-layer adopt/reshape passes.
	 *
	 * Eager entries (`snapshot !== null`) are left alone: their rollback path restores
	 * `entry.snapshot` and never reads `entry.readLayer`.
	 */
	public repointLazySavepointsToCommittedHead(committedHead: Layer): void {
		for (const entry of this.savepointStack) {
			if (entry.readSnapshot !== null) continue;
			if (entry.readLayer === committedHead) continue;
			debugLog(`Connection %d: Re-pointing lazy savepoint marker to the current committed head`, this.connectionId);
			entry.readLayer = committedHead;
		}
	}

	/** Ends savepoint bookkeeping. Only called where the transaction itself is ending. */
	public clearSavepoints(): void {
		this.savepointStack = [];
		this.readSnapshot = null;
	}

	/**
	 * True when this connection holds uncommitted writes for its table — either in a
	 * pending layer, or (after an eager savepoint swapped it into `readLayer`) in an
	 * immutable savepoint snapshot.
	 *
	 * `MemoryTableManager.ensureSchemaChangeSafety` uses this twice: it refuses a schema
	 * change while a connection OTHER than the DDL issuer has open work (those rows are
	 * invisible to the DDL's transaction, so a new constraint cannot be validated against
	 * them), and it leaves the DDL issuer's own read view alone rather than re-pointing it
	 * at the base layer.
	 *
	 * Tracks {@link readSnapshot} rather than scanning {@link savepointStack}: `RELEASE`
	 * pops the entry while leaving the snapshot installed as `readLayer`, so a stack scan
	 * reports "no work" for a connection whose rows are still uncommitted.
	 */
	public hasOpenWork(): boolean {
		return this.pendingTransactionLayer !== null || this.readSnapshot !== null;
	}
}
