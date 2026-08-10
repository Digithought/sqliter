/**
 * Transaction management for the Database.
 *
 * This module handles transaction lifecycle including:
 * - Explicit transactions (BEGIN/COMMIT/ROLLBACK)
 * - Implicit transactions (autocommit mode)
 * - Savepoint management
 * - Change log tracking for assertion evaluation
 * - Coordinating commits across virtual table connections
 */

import { createLogger } from '../common/logger.js';
import type { Row, SqlValue } from '../common/types.js';
import { encodeKeyTuple, decodeKeyTuple } from '../util/key-tuple-codec.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import type { DatabaseEventEmitter } from './database-events.js';
import type { DeferredConstraintQueue } from '../runtime/deferred-constraint-queue.js';
import type { AssertionViolation } from './database-assertions.js';

const log = createLogger('core:transaction');
const debugLog = log.extend('debug');
const errorLog = log.extend('error');

/**
 * Source of a transaction - explicit (SQL BEGIN) or implicit (autocommit).
 */
export type TransactionSource = 'explicit' | 'implicit';

/**
 * Interface for Database features needed by the TransactionManager.
 * This decouples the manager from the full Database class.
 */
export interface TransactionManagerContext {
	/** Get all active virtual table connections */
	getAllConnections(): VirtualTableConnection[];
	/** Get the database event emitter */
	getEventEmitter(): DatabaseEventEmitter;
	/** Get the deferred constraint queue */
	getDeferredConstraints(): DeferredConstraintQueue;
	/** Run global assertions before commit. When `sink` is supplied (report
	 *  mode), violations are collected into it and the commit proceeds instead
	 *  of throwing on the first violation. */
	runGlobalAssertions(sink?: AssertionViolation[]): Promise<void>;
	/** Run deferred row constraints before commit */
	runDeferredRowConstraints(): Promise<void>;
	/** Fire post-commit watchers (Database.watch). Errors logged, never rolled
	 *  back. Invoked after all connections commit but before the change log
	 *  is cleared. */
	runPostCommitWatchers(): Promise<void>;
}

/**
 * Op kind for a captured row change.
 */
export type CapturedOp = 'insert' | 'update' | 'delete';

/**
 * Captured projection for one row change. PK plus the union of columns any
 * subscription has registered demand for; UPDATEs hold OLD/NEW pairs when a
 * captured column changed value.
 */
interface CapturedRow {
	op: CapturedOp;
	/** Projection of the OLD row (DELETE always, UPDATE when capture-relevant cols changed). */
	oldProjection?: SqlValue[];
	/** Projection of the NEW row (INSERT always, UPDATE when capture-relevant cols changed). */
	newProjection?: SqlValue[];
}

/**
 * Per-table capture specification — which non-PK columns to retain on each row
 * change. PK is always captured implicitly. Used by DeltaExecutor consumers to
 * register projection demand at plan-compile time.
 */
export interface CaptureSpec {
	/** Column indices on the base table (PK columns are always captured implicitly). */
	extraColumns: ReadonlySet<number>;
}

/** A change-log layer maps base table name → PK-tuple JSON → captured row. */
type ChangeLogLayer = Map<string, Map<string, CapturedRow>>;

/**
 * Per-base-table aggregated capture demand. Tracks the union of extraColumns
 * any active subscription has asked for, plus per-spec reference counts so
 * dispose handles correctly remove demand on dispose.
 */
interface TableCaptureDemand {
	/** Active CaptureSpecs (insertion order). */
	specs: Set<CaptureSpec>;
	/** Union of extraColumns across all active specs. */
	union: Set<number>;
}

/**
 * Manages transaction state and lifecycle for a Database instance.
 *
 * Handles both explicit transactions (BEGIN/COMMIT/ROLLBACK) and implicit
 * transactions (autocommit). Coordinates transaction operations across all
 * active virtual table connections.
 */
export class TransactionManager {
	private isAutocommit = true;
	private inTransaction = false;
	private transactionSource: TransactionSource | null = null;

	/** Per-transaction change tracking: base table → PK JSON → CapturedRow */
	private changeLog: ChangeLogLayer = new Map();
	/** Savepoint layers for change tracking */
	private changeLogLayers: ChangeLogLayer[] = [];

	/** Stack of active savepoint names (ordered by creation) */
	private savepointStack: string[] = [];

	/** Per-base-table projection capture demand registered by DeltaExecutor consumers. */
	private captureDemand = new Map<string, TableCaptureDemand>();

	/** Flag to prevent new connections from starting transactions during constraint evaluation */
	private evaluatingDeferredConstraints = false;
	/** Flag indicating we're in a coordinated multi-connection commit */
	private inCoordinatedCommit = false;

	/** Sink the next commit's global-assertion pass collects violations into
	 *  instead of throwing (report mode). Installed by the external-row
	 *  ingestion seam right before its implicit commit and consumed-and-cleared
	 *  by {@link commitTransaction}; null for every ordinary commit. */
	private pendingCommitAssertionSink: AssertionViolation[] | null = null;

	constructor(private readonly ctx: TransactionManagerContext) {}

	// ============================================================================
	// Transaction State Queries
	// ============================================================================

	/** Whether the database is in autocommit mode */
	getAutocommit(): boolean {
		return this.isAutocommit;
	}

	/** Whether a transaction is currently active */
	isInTransaction(): boolean {
		return this.inTransaction;
	}

	/** Get the source of the current transaction, or null if not in a transaction */
	getTransactionSource(): TransactionSource | null {
		return this.transactionSource;
	}

	/**
	 * Install (or clear, with `null`) the sink the NEXT commit's global-assertion
	 * pass collects violations into instead of throwing. The external-row
	 * ingestion seam sets this immediately before its seam-owned implicit commit
	 * and clears it in a finally; {@link commitTransaction} also consumes-and-
	 * clears it, so an ordinary commit is never left in collect mode.
	 */
	setPendingCommitAssertionSink(sink: AssertionViolation[] | null): void {
		this.pendingCommitAssertionSink = sink;
	}

	/** Check if we're in an implicit transaction */
	isImplicitTransaction(): boolean {
		return this.transactionSource === 'implicit';
	}

	/** Check if we should skip auto-beginning transactions on newly registered connections */
	isEvaluatingDeferredConstraints(): boolean {
		return this.evaluatingDeferredConstraints;
	}

	/** Check if we're in a coordinated commit (allows sibling layer validation) */
	isInCoordinatedCommit(): boolean {
		return this.inCoordinatedCommit;
	}

	/**
	 * Current savepoint stack depth (number of active savepoints). Used by
	 * `Database.registerConnection` to replay the active stack onto connections
	 * registered mid-transaction so that subsequent rollback-to / release calls
	 * targeting earlier depths are in-range on the new connection.
	 */
	getActiveSavepointDepth(): number {
		return this.savepointStack.length;
	}

	// ============================================================================
	// Transaction Control
	// ============================================================================

	/**
	 * Begins a transaction on all active connections.
	 * Called by both explicit BEGIN and implicit transaction start.
	 */
	async beginTransaction(source: TransactionSource): Promise<void> {
		if (this.inTransaction) {
			if (source === 'explicit') {
				if (this.transactionSource === 'implicit') {
					// Upgrade implicit to explicit
					debugLog('Upgrading implicit transaction to explicit (BEGIN encountered).');
					this.transactionSource = 'explicit';
					this.clearChangeLog();
					return;
				}
				throw new QuereusError('Cannot begin transaction: already in a transaction', StatusCode.ERROR);
			}
			// Implicit while already in a transaction - no-op
			return;
		}

		debugLog(`Beginning ${source} transaction.`);

		// Start batching events for this transaction
		this.ctx.getEventEmitter().startBatch();

		// Begin transaction on all active connections
		const connections = this.ctx.getAllConnections();
		for (const connection of connections) {
			try {
				await connection.begin();
			} catch (error) {
				errorLog(`Error beginning transaction on connection ${connection.connectionId}: %O`, error);
				throw error;
			}
		}

		this.inTransaction = true;
		this.isAutocommit = false;
		this.transactionSource = source;

		if (source === 'explicit') {
			this.clearChangeLog();
		}
	}

	/**
	 * Commits the current transaction on all connections.
	 * Runs deferred constraints and assertions before committing.
	 */
	async commitTransaction(): Promise<void> {
		if (!this.inTransaction) {
			debugLog('No transaction to commit (already in autocommit mode).');
			return;
		}

		debugLog(`Committing ${this.transactionSource} transaction.`);

		// Snapshot connections before evaluating deferred constraints
		const connectionsToCommit = this.ctx.getAllConnections();

		// Consume the pending report-mode sink read-and-clear: even if this commit
		// fails for another reason (a connection commit error, a deferred row
		// constraint), the NEXT ordinary commit must throw on violation as usual.
		const assertionSink = this.pendingCommitAssertionSink;
		this.pendingCommitAssertionSink = null;

		let commitSucceeded = false;
		try {
			// Evaluate global assertions and deferred row constraints BEFORE
			// committing. With a sink (report mode) a violation is collected and the
			// commit proceeds — derived effects land and watch dispatches; with none
			// (default) the first violation throws into the catch below and rolls
			// back, discarding batched events.
			await this.ctx.runGlobalAssertions(assertionSink ?? undefined);
			await this.ctx.runDeferredRowConstraints();

			// Mark coordinated commit to relax layer validation for sibling layers
			this.inCoordinatedCommit = true;
			try {
				// Commit sequentially to avoid race conditions with layer promotion
				for (const connection of connectionsToCommit) {
					try {
						await connection.commit();
					} catch (error) {
						errorLog(`Error committing transaction on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
				commitSucceeded = true;
			} finally {
				this.inCoordinatedCommit = false;
			}

			// Fire post-commit watchers while the change log is still alive.
			// Errors are swallowed inside the manager — watchers do not roll
			// back the commit.
			try {
				await this.ctx.runPostCommitWatchers();
			} catch (err) {
				errorLog('Post-commit watcher dispatch threw: %O', err);
			}

			// Materialized views are NOT a post-commit consumer: each is row-time
			// maintained synchronously at the DML boundary, so its backing table is
			// already current and committed in lockstep with the source write.
		} catch (e) {
			// On pre-commit assertion failure (or commit error), rollback all connections
			const conns = this.ctx.getAllConnections();
			await Promise.allSettled(conns.map(c => c.rollback()));
			throw e;
		} finally {
			this.inTransaction = false;
			this.isAutocommit = true;
			this.transactionSource = null;
			this.clearChangeLog();

			// Flush or discard batched events based on commit success
			if (commitSucceeded) {
				this.ctx.getEventEmitter().flushBatch();
			} else {
				this.ctx.getEventEmitter().discardBatch();
			}
		}
	}

	/**
	 * Rolls back the current transaction on all connections.
	 */
	async rollbackTransaction(): Promise<void> {
		if (!this.inTransaction) {
			debugLog('No transaction to rollback (already in autocommit mode).');
			return;
		}

		debugLog(`Rolling back ${this.transactionSource} transaction.`);

		// Rollback all active connections
		const connections = this.ctx.getAllConnections();
		const rollbackPromises = connections.map(async (connection) => {
			try {
				await connection.rollback();
			} catch (error) {
				errorLog(`Error rolling back transaction on connection ${connection.connectionId}: %O`, error);
			}
		});

		await Promise.allSettled(rollbackPromises);

		// Discard batched events on rollback
		this.ctx.getEventEmitter().discardBatch();

		this.inTransaction = false;
		this.isAutocommit = true;
		this.transactionSource = null;
		this.clearChangeLog();
	}

	/**
	 * Ensures we're in a transaction. If in autocommit mode, starts an implicit transaction.
	 */
	async ensureTransaction(): Promise<void> {
		if (!this.inTransaction && this.isAutocommit) {
			await this.beginTransaction('implicit');
		}
	}

	/**
	 * Commits if we're in an implicit transaction.
	 */
	async autocommitIfNeeded(): Promise<void> {
		if (this.transactionSource === 'implicit') {
			await this.commitTransaction();
		}
	}

	/**
	 * Rolls back if we're in an implicit transaction (on error).
	 */
	async autorollbackIfNeeded(): Promise<void> {
		if (this.transactionSource === 'implicit') {
			await this.rollbackTransaction();
		}
	}

	/**
	 * Upgrades an implicit transaction to explicit.
	 * Used when SAVEPOINT is encountered.
	 */
	upgradeToExplicitTransaction(): void {
		if (this.transactionSource === 'implicit') {
			debugLog('Upgrading implicit transaction to explicit (savepoint encountered).');
			this.transactionSource = 'explicit';
		}
	}

	// ============================================================================
	// Deferred Constraint Evaluation
	// ============================================================================

	/**
	 * Run deferred row constraints with proper flag management.
	 */
	async runDeferredRowConstraints(): Promise<void> {
		this.evaluatingDeferredConstraints = true;
		try {
			await this.ctx.getDeferredConstraints().runDeferredRows();
		} finally {
			this.evaluatingDeferredConstraints = false;
		}
	}

	// ============================================================================
	// Capture Spec Registration
	// ============================================================================

	/**
	 * Register projection capture demand for a base table. Future record calls
	 * for that table will retain values for the union of registered columns
	 * (PK is always retained implicitly). Returns a dispose handle that removes
	 * this spec from the demand set.
	 */
	registerCaptureSpec(baseTable: string, spec: CaptureSpec): () => void {
		const key = baseTable.toLowerCase();
		let demand = this.captureDemand.get(key);
		if (!demand) {
			demand = { specs: new Set(), union: new Set() };
			this.captureDemand.set(key, demand);
		}
		demand.specs.add(spec);
		for (const c of spec.extraColumns) demand.union.add(c);

		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			const d = this.captureDemand.get(key);
			if (!d) return;
			d.specs.delete(spec);
			if (d.specs.size === 0) {
				this.captureDemand.delete(key);
			} else {
				// Recompute union from remaining specs
				const u = new Set<number>();
				for (const s of d.specs) {
					for (const c of s.extraColumns) u.add(c);
				}
				d.union = u;
			}
		};
	}

	// ============================================================================
	// Change Log Management
	// ============================================================================

	/**
	 * Serialize a tuple of SqlValues for stable Map keying.
	 *
	 * Uses the reversible, type-faithful {@link encodeKeyTuple} codec so a bigint
	 * PK (any integer beyond `Number.MAX_SAFE_INTEGER`) no longer crashes the
	 * write, blobs round-trip, and a JSON-object PK component keeps its canonical
	 * (recursive object-key-sorted) form — reorder-equal objects still coalesce to
	 * one change-log entry. Numeric type identity is preserved (bigint stays
	 * distinct from number); see the codec's NOTE for the coalescing tripwire.
	 */
	private serializeKeyTuple(values: readonly SqlValue[]): string {
		return encodeKeyTuple(values);
	}

	/** The active (top) layer that should receive change records. */
	private activeLayer(): ChangeLogLayer {
		return this.changeLogLayers.length > 0
			? this.changeLogLayers[this.changeLogLayers.length - 1]
			: this.changeLog;
	}

	/** Project a row onto the given column indices. */
	private projectRow(row: Row, columns: readonly number[]): SqlValue[] {
		const out: SqlValue[] = [];
		for (const i of columns) out.push(row[i] as SqlValue);
		return out;
	}

	/**
	 * Build the OLD/NEW projection columns for a base table — PK indices first,
	 * then any registered extraColumns not already in the PK, preserving a
	 * deterministic order. Returns a tuple of indices used for projection.
	 */
	private captureColumnsFor(base: string, pkIndices: readonly number[]): number[] {
		const demand = this.captureDemand.get(base);
		const cols: number[] = [...pkIndices];
		if (demand && demand.union.size > 0) {
			const seen = new Set<number>(pkIndices);
			for (const c of demand.union) {
				if (!seen.has(c)) {
					cols.push(c);
					seen.add(c);
				}
			}
		}
		return cols;
	}

	/**
	 * Merge an incoming op into the active layer with last-write-wins semantics:
	 *  - INSERT after DELETE → UPDATE (rare; same PK reappears with new values)
	 *  - UPDATE after INSERT → INSERT (newProjection updated in place)
	 *  - DELETE after INSERT → drop entry (net no-op)
	 *  - DELETE after UPDATE → DELETE with carrying-over oldProjection from the first OLD
	 *  - INSERT/UPDATE chains preserve the original `oldProjection` so the OLD
	 *    state seen at the start of the layer is never overwritten by later
	 *    intra-layer activity on the same PK.
	 */
	private mergeRecord(base: string, pkKey: string, incoming: CapturedRow): void {
		const layer = this.activeLayer();
		this.mergeRecordInto(layer, base.toLowerCase(), pkKey, incoming);
	}

	/**
	 * Same merge state machine as `mergeRecord`, but writes to an arbitrary
	 * target layer. Used both for normal record paths (via `mergeRecord`) and
	 * for savepoint RELEASE (merging the released layer into its parent), so
	 * the two paths cannot drift.
	 */
	private mergeRecordInto(layer: ChangeLogLayer, lower: string, pkKey: string, incoming: CapturedRow): void {
		let tableMap = layer.get(lower);
		if (!tableMap) {
			tableMap = new Map();
			layer.set(lower, tableMap);
		}
		const existing = tableMap.get(pkKey);
		if (!existing) {
			tableMap.set(pkKey, incoming);
			return;
		}
		const prev = existing.op;
		const next = incoming.op;
		if (prev === 'insert' && next === 'delete') {
			tableMap.delete(pkKey);
			return;
		}
		if (prev === 'insert' && next === 'update') {
			existing.newProjection = incoming.newProjection ?? existing.newProjection;
			return;
		}
		if (prev === 'insert' && next === 'insert') {
			existing.newProjection = incoming.newProjection ?? existing.newProjection;
			return;
		}
		if (prev === 'update' && next === 'update') {
			// Preserve the earliest oldProjection (existing) and pick up the
			// latest newProjection (incoming).
			existing.newProjection = incoming.newProjection ?? existing.newProjection;
			return;
		}
		if (prev === 'update' && next === 'delete') {
			existing.op = 'delete';
			existing.newProjection = undefined;
			return;
		}
		if (prev === 'delete' && next === 'insert') {
			existing.op = 'update';
			existing.newProjection = incoming.newProjection;
			return;
		}
		if (prev === 'delete' && next === 'delete') {
			// Idempotent: a second delete with the same PK can't happen against
			// committed state, but keep the existing oldProjection.
			return;
		}
		// Defensive fallback for any unanticipated combination — replace.
		tableMap.set(pkKey, incoming);
	}

	/** Record an INSERT operation, capturing the new row's projected columns. */
	recordInsert(baseTable: string, newRow: Row, pkIndices: readonly number[]): void {
		const lower = baseTable.toLowerCase();
		const cols = this.captureColumnsFor(lower, pkIndices);
		const pkProjection = this.projectRow(newRow, pkIndices);
		const newProjection = this.projectRow(newRow, cols);
		this.mergeRecord(lower, this.serializeKeyTuple(pkProjection), {
			op: 'insert',
			newProjection,
		});
	}

	/** Record a DELETE operation, capturing the old row's projected columns. */
	recordDelete(baseTable: string, oldRow: Row, pkIndices: readonly number[]): void {
		const lower = baseTable.toLowerCase();
		const cols = this.captureColumnsFor(lower, pkIndices);
		const pkProjection = this.projectRow(oldRow, pkIndices);
		const oldProjection = this.projectRow(oldRow, cols);
		this.mergeRecord(lower, this.serializeKeyTuple(pkProjection), {
			op: 'delete',
			oldProjection,
		});
	}

	/**
	 * Record an UPDATE operation. When the PK changes value, this is recorded
	 * as a DELETE of the old PK followed by an INSERT of the new PK. Otherwise
	 * it is recorded as a single UPDATE with both projections.
	 *
	 * NOTE: "changes value" here is `encodeKeyTuple` identity, which is value-based and
	 * collation-BLIND — deliberately coarser than the data-event contract's relocation test
	 * (`primaryKeyRelocated` in runtime/emit/dml-executor.ts), which asks the primary key's
	 * own comparator. So a case-only rewrite under a `NOCASE` key splits here while the
	 * `onDataChange` channel keeps it one in-place update. Harmless for this log's purpose —
	 * it drives re-evaluation, and naming both key spellings is over-broad, never wrong. If a
	 * consumer ever treats a change-log split as an assertion that the row MOVED, share the
	 * comparator instead of the encoder.
	 */
	recordUpdate(baseTable: string, oldRow: Row, newRow: Row, pkIndices: readonly number[]): void {
		const lower = baseTable.toLowerCase();
		const cols = this.captureColumnsFor(lower, pkIndices);
		const oldPk = this.projectRow(oldRow, pkIndices);
		const newPk = this.projectRow(newRow, pkIndices);
		const oldPkKey = this.serializeKeyTuple(oldPk);
		const newPkKey = this.serializeKeyTuple(newPk);
		const oldProjection = this.projectRow(oldRow, cols);
		const newProjection = this.projectRow(newRow, cols);
		if (oldPkKey === newPkKey) {
			this.mergeRecord(lower, oldPkKey, { op: 'update', oldProjection, newProjection });
		} else {
			// PK changed: delete-then-insert semantics so per-group/per-row
			// dispatch sees both keys.
			this.mergeRecord(lower, oldPkKey, { op: 'delete', oldProjection });
			this.mergeRecord(lower, newPkKey, { op: 'insert', newProjection });
		}
	}

	/** Get the set of changed base tables */
	getChangedBaseTables(): Set<string> {
		const result = new Set<string>();
		const collect = (m: ChangeLogLayer) => {
			for (const [t, rowMap] of m) {
				if (rowMap.size > 0) result.add(t);
			}
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return result;
	}

	/** Gather all changed PK tuples for a base table across layers (back-compat). */
	getChangedKeyTuples(base: string): SqlValue[][] {
		const lower = base.toLowerCase();
		const tuples: SqlValue[][] = [];
		const seen = new Set<string>();
		const collect = (m: ChangeLogLayer): void => {
			const rowMap = m.get(lower);
			if (!rowMap) return;
			for (const pkKey of rowMap.keys()) {
				if (seen.has(pkKey)) continue;
				seen.add(pkKey);
				tuples.push(decodeKeyTuple(pkKey));
			}
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return tuples;
	}

	/**
	 * Return the de-duplicated set of value tuples for the requested columns,
	 * across all layers and ops. For UPDATE, yields both OLD and NEW
	 * projections when any captured column changed value. The supplied
	 * `columnIndices` must be a subset of the registered captureSpec columns
	 * (or PK columns) — values for non-captured columns are not retained.
	 *
	 * Column indices are positions in the base table's column space; this
	 * function translates them into positions inside the cached projection
	 * tuple using the per-base capture column layout (PK first, then extras
	 * in insertion order). To avoid recomputing that layout on each call, the
	 * caller passes the columns it wants and we resolve via the table demand.
	 */
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][] {
		const lower = base.toLowerCase();
		const projectionCols = this.captureColumnsFor(lower, pkIndices);
		const indexByTableCol = new Map<number, number>();
		for (let i = 0; i < projectionCols.length; i++) {
			indexByTableCol.set(projectionCols[i], i);
		}
		// Verify every requested column is captured; if not, the caller didn't
		// register the right spec.
		const projectionIndices: number[] = [];
		for (const c of columnIndices) {
			const idx = indexByTableCol.get(c);
			if (idx === undefined) {
				throw new QuereusError(
					`getChangedTuples: column ${c} on ${base} was not registered for capture`,
					StatusCode.INTERNAL,
				);
			}
			projectionIndices.push(idx);
		}

		const out: SqlValue[][] = [];
		const seen = new Set<string>();
		const emit = (projection: readonly SqlValue[] | undefined): void => {
			if (!projection) return;
			const tuple: SqlValue[] = [];
			for (const i of projectionIndices) tuple.push(projection[i] as SqlValue);
			// Encode-only (never decoded here) — the type-faithful codec also
			// avoids the bigint `JSON.stringify` crash on a captured column value.
			const tkey = encodeKeyTuple(tuple);
			if (seen.has(tkey)) return;
			seen.add(tkey);
			out.push(tuple);
		};
		const collect = (m: ChangeLogLayer): void => {
			const rowMap = m.get(lower);
			if (!rowMap) return;
			for (const rec of rowMap.values()) {
				if (rec.op === 'insert') {
					emit(rec.newProjection);
				} else if (rec.op === 'delete') {
					emit(rec.oldProjection);
				} else {
					// UPDATE: emit OLD and NEW so group-membership transitions are visible.
					emit(rec.oldProjection);
					emit(rec.newProjection);
				}
			}
		};
		collect(this.changeLog);
		for (const layer of this.changeLogLayers) collect(layer);
		return out;
	}

	/** Clear all change tracking */
	clearChangeLog(): void {
		this.changeLog.clear();
		this.changeLogLayers = [];
		this.savepointStack = [];
		this.ctx.getDeferredConstraints().clear();
	}

	// ============================================================================
	// Savepoint Management
	// ============================================================================

	/**
	 * Creates a named savepoint, pushing it onto the stack.
	 * Returns the depth index for use by connections.
	 */
	createSavepoint(name: string): number {
		const depth = this.savepointStack.length;
		this.savepointStack.push(name);
		this.beginSavepointLayer();
		return depth;
	}

	/**
	 * Finds a savepoint by name, returning its stack index.
	 * Throws if the savepoint does not exist.
	 */
	findSavepoint(name: string): number {
		// Search from top of stack to find the most recent savepoint with this name
		for (let i = this.savepointStack.length - 1; i >= 0; i--) {
			if (this.savepointStack[i] === name) return i;
		}
		throw new QuereusError(`No such savepoint: ${name}`, StatusCode.ERROR);
	}

	/**
	 * Releases a named savepoint, merging its layer (and any above it) into the parent.
	 * Per SQL semantics, RELEASE removes the named savepoint and all savepoints
	 * created after it.
	 * Returns the target depth index for connection coordination.
	 */
	releaseSavepoint(name: string): number {
		const index = this.findSavepoint(name);
		const layersToRelease = this.savepointStack.length - index;

		// Release layers from top down to the target, merging each into its parent
		for (let i = 0; i < layersToRelease; i++) {
			this.releaseSavepointLayer();
		}
		this.savepointStack.length = index;
		return index;
	}

	/**
	 * Rolls back to a named savepoint, discarding all layers above it.
	 * Per SQL standard, the savepoint itself is preserved (not consumed) —
	 * it can be rolled back to again or released later.
	 * A fresh layer is created for the preserved savepoint.
	 * Returns the target depth index for connection coordination.
	 */
	rollbackToSavepoint(name: string): number {
		const index = this.findSavepoint(name);
		const layersAbove = this.savepointStack.length - index - 1;

		// Rollback layers above the target savepoint
		for (let i = 0; i < layersAbove; i++) {
			this.rollbackSavepointLayer();
		}
		// Rollback the target savepoint's own layer
		this.rollbackSavepointLayer();
		// Remove savepoints above the target from the name stack
		this.savepointStack.length = index + 1;

		// Re-create a fresh layer for the preserved savepoint
		this.beginSavepointLayer();

		return index;
	}

	// ============================================================================
	// Savepoint Layer Management (internal)
	// ============================================================================

	/** Begin a new savepoint layer for change tracking */
	private beginSavepointLayer(): void {
		this.changeLogLayers.push(new Map());
		this.ctx.getDeferredConstraints().beginLayer();
		this.ctx.getEventEmitter().beginSavepointLayer();
	}

	/** Rollback the current savepoint layer */
	private rollbackSavepointLayer(): void {
		this.changeLogLayers.pop();
		this.ctx.getDeferredConstraints().rollbackLayer();
		this.ctx.getEventEmitter().rollbackSavepointLayer();
	}

	/**
	 * Release the current savepoint layer, merging into the parent through
	 * the same `mergeRecordInto` state machine the record path uses. This
	 * keeps the two paths consistent — in particular, an UPDATE-after-UPDATE
	 * preserves the parent layer's `oldProjection` so per-group dispatch
	 * still sees the row's pre-savepoint state.
	 */
	private releaseSavepointLayer(): void {
		const top = this.changeLogLayers.pop();
		if (!top) return;

		const target = this.changeLogLayers.length > 0
			? this.changeLogLayers[this.changeLogLayers.length - 1]
			: this.changeLog;

		for (const [table, rowMap] of top) {
			for (const [pkKey, rec] of rowMap) {
				this.mergeRecordInto(target, table, pkKey, rec);
			}
		}

		this.ctx.getDeferredConstraints().releaseLayer();
		this.ctx.getEventEmitter().releaseSavepointLayer();
	}
}
