/**
 * Database-level event system for unified reactivity.
 *
 * This module provides a centralized event aggregator that collects and broadcasts
 * data and schema change events from all virtual table modules. Events are batched
 * within transactions and emitted after successful commit.
 *
 * Modules that implement their own event emission (detected via getEventEmitter())
 * will have their events forwarded to the database level. For modules without
 * native event support, the engine automatically emits events for local operations.
 */

import { createLogger } from '../common/logger.js';
import type { Row, SqlValue } from '../common/types.js';
import type { VTableDataChangeEvent, VTableSchemaChangeEvent, VTableEventEmitter } from '../vtab/events.js';

const log = createLogger('core:database-events');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Data change event emitted at the database level.
 * Extends VTableDataChangeEvent with module identification.
 */
export interface DatabaseDataChangeEvent {
	/** The type of mutation operation */
	type: 'insert' | 'update' | 'delete';
	/** The module that raised this event */
	moduleName: string;
	/** Schema name containing the table */
	schemaName: string;
	/** Table name */
	tableName: string;
	/** Primary key values */
	key?: SqlValue[];
	/** Previous row data (for update/delete) */
	oldRow?: Row;
	/** New row data (for insert/update) */
	newRow?: Row;
	/** Column names that changed (for updates) */
	changedColumns?: string[];
	/** True if event originated from sync/remote source, false for local changes */
	remote: boolean;
}

/**
 * Schema change event emitted at the database level.
 * Extends VTableSchemaChangeEvent with module identification.
 */
export interface DatabaseSchemaChangeEvent {
	/** The type of schema operation */
	type: 'create' | 'alter' | 'drop';
	/** The type of object being modified */
	objectType: 'table' | 'index' | 'column';
	/** The module that raised this event */
	moduleName: string;
	/** Schema name */
	schemaName: string;
	/** Object name (table name for table/column, index name for index) */
	objectName: string;
	/** Column name (for column operations) */
	columnName?: string;
	/** Old column name (for column rename) */
	oldColumnName?: string;
	/** DDL statement if available */
	ddl?: string;
	/** True if event originated from sync/remote source, false for local changes */
	remote: boolean;
}

/**
 * Materialized-view key-coarsening **collision** event emitted at the database
 * level — the operational complement to the create-time key-coarsening warning
 * (`docs/materialized-views.md` § Coarsened backing keys). Fired from row-time
 * maintenance whenever an upsert under the coarsened backing key K′ replaces a
 * backing row whose **source identity differs** from the incoming row's — i.e.
 * two distinct source-key tuples (`'Bob'` / `'bob'`) merged into one derived row
 * under K′'s coarsened (output) collation, last-writer-win (`docs/migration.md`
 * § Convergence hazards). One event per realized colliding merge, delivered on
 * the commit that realized it (it rides the same transaction batching the
 * data/schema channels use, so a collision inside a rolled-back transaction
 * reports nothing).
 */
export interface MaintenanceCollisionEvent {
	/** Schema name of the maintained (backing) table. */
	schemaName: string;
	/** Maintained (backing) table name. */
	tableName: string;
	/** The coarsened backing key K′ values (from the incoming/new row), in key order. */
	key: SqlValue[];
	/** Names of the weakened K′ column(s) whose values diverged under the source
	 *  (pre-coarsening, stricter) collation — the columns whose coarsening realized
	 *  the merge. */
	weakenedColumns: string[];
	/** The replaced backing row (the losing source identity's prior image). */
	oldRow: Row;
	/** The incoming backing row that won the merge (the new image). */
	newRow: Row;
	/** Reserved: true when the colliding write arrived via the external-change
	 *  ingest seam (peer) rather than local DML. Not threaded through maintenance
	 *  in v1 (see the ticket's Out of scope) — left unset. */
	remote?: boolean;
}

/**
 * The complete, ordered fact set of one committed logical transaction, delivered
 * as a single group on the {@link DatabaseEventEmitter.onTransactionCommit}
 * channel. This is the authoritative "one transaction = one group" boundary the
 * sync layer anchors an HLC to: it spans **all** tables touched by the
 * transaction (every module's emitter feeds the same engine-level batch), so a
 * cross-table commit is never split — unlike a per-table store coordinator, which
 * commits each table separately. See `docs/sync.md` § Transaction-Based Change
 * Grouping.
 *
 * Delivered once from `flushBatch()` (i.e. after a successful commit), never on
 * rollback. The `dataEvents`/`schemaEvents` carry the same
 * {@link DatabaseDataChangeEvent}/{@link DatabaseSchemaChangeEvent} shapes the
 * per-event `onDataChange`/`onSchemaChange` channels deliver — `onTransactionCommit`
 * is purely additive and does not replace them.
 */
export interface TransactionCommitBatch {
	/** All data events of the committed transaction, in flush order (base batch
	 *  then each savepoint layer, in push order — the same order `flushBatch`
	 *  emits per-event). Per-module/per-table arrival order at commit, not global
	 *  DML-interleave order; deterministic and replayable. */
	readonly dataEvents: ReadonlyArray<DatabaseDataChangeEvent>;
	/** All schema events of the committed transaction, in flush order. */
	readonly schemaEvents: ReadonlyArray<DatabaseSchemaChangeEvent>;
}

export type DatabaseDataChangeListener = (event: DatabaseDataChangeEvent) => void;
export type DatabaseSchemaChangeListener = (event: DatabaseSchemaChangeEvent) => void;
export type MaintenanceCollisionListener = (event: MaintenanceCollisionEvent) => void;
export type TransactionCommitListener = (batch: TransactionCommitBatch) => void;

/**
 * Options for subscribing to data change events.
 * Reserved fields for future filtering capabilities, plus pass-through for module-specific options.
 */
export interface DataChangeSubscriptionOptions {
	// Reserved for future unified options:
	// tables?: string[];
	// schemas?: string[];
	// operations?: ('insert' | 'update' | 'delete')[];
	// remoteOnly?: boolean;
	// localOnly?: boolean;

	/** Module-specific options passed through to modules */
	[key: string]: unknown;
}

/**
 * Options for subscribing to schema change events.
 */
export interface SchemaChangeSubscriptionOptions {
	// Reserved for future unified options:
	// objectTypes?: ('table' | 'index' | 'column')[];
	// schemas?: string[];

	/** Module-specific options passed through to modules */
	[key: string]: unknown;
}

/**
 * Internal structure for tracking a pending (batched) data change event
 * along with its source module name.
 */
interface PendingDataEvent {
	moduleName: string;
	event: VTableDataChangeEvent;
}

/**
 * Internal structure for tracking a pending schema change event.
 */
interface PendingSchemaEvent {
	moduleName: string;
	event: VTableSchemaChangeEvent;
}

/** Default maximum number of listeners per event type before a warning is logged. */
const DEFAULT_MAX_LISTENERS = 100;

/**
 * Whether a batched event names `(schemaLower, tableLower)` — the single matching rule
 * every batched-event rewrite (row-shape remap, table-name relabel) applies, on both the
 * data and the maintenance-collision channel. Both operands are compared lowercased, so
 * callers pass already-lowercased names.
 */
function namesTable(
	event: { schemaName: string; tableName: string },
	schemaLower: string,
	tableLower: string,
): boolean {
	return event.schemaName.toLowerCase() === schemaLower
		&& event.tableName.toLowerCase() === tableLower;
}

/**
 * Names of the columns whose values differ between two same-arity row images —
 * the `changedColumns` recomputation for a remapped update event. Same strict
 * (`!==`) comparison the memory module's `computeChangedColumns` uses.
 */
function computeChangedColumnNames(oldRow: Row, newRow: Row, columnNames: readonly string[]): string[] {
	const changed: string[] = [];
	for (let i = 0; i < columnNames.length; i++) {
		if (oldRow[i] !== newRow[i]) changed.push(columnNames[i]);
	}
	return changed;
}

/**
 * Central event emitter for database-level reactivity.
 *
 * Aggregates events from all virtual table modules and broadcasts them to
 * registered listeners. Handles transaction batching - events are collected
 * during a transaction and emitted only after successful commit.
 *
 * Supports savepoint semantics: events within a savepoint are tracked separately
 * and can be discarded on ROLLBACK TO SAVEPOINT or merged on RELEASE.
 */
export class DatabaseEventEmitter {
	private dataListeners = new Set<DatabaseDataChangeListener>();
	private schemaListeners = new Set<DatabaseSchemaChangeListener>();
	private collisionListeners = new Set<MaintenanceCollisionListener>();
	private transactionCommitListeners = new Set<TransactionCommitListener>();
	private maxListeners = DEFAULT_MAX_LISTENERS;

	/** Batched events waiting for commit (base transaction level) */
	private batchedDataEvents: PendingDataEvent[] = [];
	private batchedSchemaEvents: PendingSchemaEvent[] = [];
	private batchedCollisionEvents: MaintenanceCollisionEvent[] = [];

	/** Savepoint layers for event batching - each layer captures events since that savepoint */
	private dataEventLayers: PendingDataEvent[][] = [];
	private schemaEventLayers: PendingSchemaEvent[][] = [];
	private collisionEventLayers: MaintenanceCollisionEvent[][] = [];

	/**
	 * Cumulative count of COMMITTED key-coarsening collisions, keyed by lowercased
	 * qualified `schema.table` of the maintained table. Incremented in
	 * {@link flushBatch} as each batched collision is emitted (or immediately on the
	 * non-batching path) — so the count reflects only collisions that actually
	 * committed, consistent with event delivery, and survives a host that never
	 * subscribed an `onMaintenanceCollision` listener.
	 */
	private collisionCounts = new Map<string, number>();

	/** Whether we're currently in a transaction (batching mode) */
	private isBatching = false;

	/** Map of module emitters we've subscribed to, for cleanup */
	private moduleSubscriptions = new Map<string, { dataUnsub?: () => void; schemaUnsub?: () => void }>();

	/**
	 * Set the maximum number of listeners per event type.
	 * A warning is logged when this limit is exceeded, which typically
	 * indicates a listener leak. Set to 0 to disable the warning.
	 */
	setMaxListeners(n: number): void {
		this.maxListeners = n;
	}

	/**
	 * Get the current maximum listener count.
	 */
	getMaxListeners(): number {
		return this.maxListeners;
	}

	/**
	 * Subscribe to data change events from all modules.
	 * @param listener Callback invoked for each data change event
	 * @param _options Reserved for future filtering options
	 * @returns Unsubscribe function
	 */
	onDataChange(
		listener: DatabaseDataChangeListener,
		_options?: DataChangeSubscriptionOptions
	): () => void {
		this.dataListeners.add(listener);
		this.checkListenerCount('data', this.dataListeners.size);
		log('Added data change listener, total: %d', this.dataListeners.size);
		return () => {
			this.dataListeners.delete(listener);
			log('Removed data change listener, total: %d', this.dataListeners.size);
		};
	}

	/**
	 * Subscribe to schema change events from all modules.
	 * @param listener Callback invoked for each schema change event
	 * @param _options Reserved for future filtering options
	 * @returns Unsubscribe function
	 */
	onSchemaChange(
		listener: DatabaseSchemaChangeListener,
		_options?: SchemaChangeSubscriptionOptions
	): () => void {
		this.schemaListeners.add(listener);
		this.checkListenerCount('schema', this.schemaListeners.size);
		log('Added schema change listener, total: %d', this.schemaListeners.size);
		return () => {
			this.schemaListeners.delete(listener);
			log('Removed schema change listener, total: %d', this.schemaListeners.size);
		};
	}

	/**
	 * Check if there are any data change listeners registered.
	 */
	hasDataListeners(): boolean {
		return this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any schema change listeners registered.
	 */
	hasSchemaListeners(): boolean {
		return this.schemaListeners.size > 0;
	}

	/**
	 * Subscribe to materialized-view key-coarsening collision events
	 * ({@link MaintenanceCollisionEvent}). Events share the data/schema channels'
	 * transaction-batching discipline — delivered after the commit that realized
	 * the merge, dropped on rollback.
	 * @param listener Callback invoked for each committed collision
	 * @returns Unsubscribe function
	 */
	onMaintenanceCollision(listener: MaintenanceCollisionListener): () => void {
		this.collisionListeners.add(listener);
		this.checkListenerCount('collision', this.collisionListeners.size);
		log('Added maintenance-collision listener, total: %d', this.collisionListeners.size);
		return () => {
			this.collisionListeners.delete(listener);
			log('Removed maintenance-collision listener, total: %d', this.collisionListeners.size);
		};
	}

	/**
	 * Check if there are any maintenance-collision listeners registered.
	 */
	hasCollisionListeners(): boolean {
		return this.collisionListeners.size > 0;
	}

	/**
	 * Subscribe to grouped per-transaction commit batches
	 * ({@link TransactionCommitBatch}). Fired **once** per committed logical
	 * transaction, after the per-event {@link onDataChange}/{@link onSchemaChange}
	 * delivery, carrying every data and schema event of that transaction (across
	 * all tables) in flush order — the authoritative grouping boundary for
	 * "one transaction = one group". Never fires on rollback, and never fires for a
	 * transaction that produced no data or schema events (an empty/idle commit).
	 * This is additive: the per-event channels are untouched.
	 * @param listener Callback invoked once per committed transaction
	 * @returns Unsubscribe function
	 */
	onTransactionCommit(listener: TransactionCommitListener): () => void {
		this.transactionCommitListeners.add(listener);
		this.checkListenerCount('transaction-commit', this.transactionCommitListeners.size);
		log('Added transaction-commit listener, total: %d', this.transactionCommitListeners.size);
		return () => {
			this.transactionCommitListeners.delete(listener);
			log('Removed transaction-commit listener, total: %d', this.transactionCommitListeners.size);
		};
	}

	/**
	 * Check if there are any transaction-commit listeners registered.
	 */
	hasTransactionCommitListeners(): boolean {
		return this.transactionCommitListeners.size > 0;
	}

	/**
	 * Whether the engine must collect data-change events for delivery — true when
	 * any per-event {@link onDataChange} listener OR any {@link onTransactionCommit}
	 * listener is registered. A transaction-commit listener needs the grouped data
	 * events, so the auto-event generation gate must open for it too even when no
	 * per-event data listener is subscribed. Consulted by the DML executor's
	 * auto-event gate (see `dml-executor.ts`).
	 */
	needsDataEvents(): boolean {
		return this.dataListeners.size > 0 || this.transactionCommitListeners.size > 0;
	}

	/**
	 * Whether the engine must collect schema-change events for delivery — true when
	 * any per-event {@link onSchemaChange} listener OR any {@link onTransactionCommit}
	 * listener is registered. Companion to {@link needsDataEvents}; consulted by the
	 * schema manager's auto-event gate (see `schema/manager.ts`).
	 */
	needsSchemaEvents(): boolean {
		return this.schemaListeners.size > 0 || this.transactionCommitListeners.size > 0;
	}

	/**
	 * Read-only snapshot of the cumulative committed-collision counter, keyed by
	 * lowercased qualified `schema.table`. A fresh copy each call, so the caller
	 * cannot mutate the live counter.
	 */
	getMaterializedViewCollisionStats(): ReadonlyMap<string, number> {
		return new Map(this.collisionCounts);
	}

	/**
	 * Hook a module's event emitter to forward events to the database level.
	 * Called when a module with native event support is detected.
	 *
	 * @param moduleName The name of the module
	 * @param emitter The module's event emitter
	 */
	hookModuleEmitter(moduleName: string, emitter: VTableEventEmitter): void {
		// Avoid double-subscription
		if (this.moduleSubscriptions.has(moduleName)) {
			return;
		}

		const subs: { dataUnsub?: () => void; schemaUnsub?: () => void } = {};

		// Subscribe to data changes if supported
		if (emitter.onDataChange) {
			subs.dataUnsub = emitter.onDataChange((event) => {
				this.handleModuleDataEvent(moduleName, event);
			});
		}

		// Subscribe to schema changes if supported
		if (emitter.onSchemaChange) {
			subs.schemaUnsub = emitter.onSchemaChange((event) => {
				this.handleModuleSchemaEvent(moduleName, event);
			});
		}

		this.moduleSubscriptions.set(moduleName, subs);
		log('Hooked module emitter: %s', moduleName);
	}

	/**
	 * Unhook a module's event emitter.
	 * Called when a module is unregistered.
	 *
	 * @param moduleName The name of the module
	 */
	unhookModuleEmitter(moduleName: string): void {
		const subs = this.moduleSubscriptions.get(moduleName);
		if (subs) {
			subs.dataUnsub?.();
			subs.schemaUnsub?.();
			this.moduleSubscriptions.delete(moduleName);
			log('Unhooked module emitter: %s', moduleName);
		}
	}

	/**
	 * Warn if the listener count for a category exceeds the configured maximum.
	 */
	private checkListenerCount(category: string, count: number): void {
		if (this.maxListeners > 0 && count > this.maxListeners) {
			warnLog(
				'Possible listener leak: %d %s change listeners registered (max %d). ' +
				'Use setMaxListeners() to increase the limit if this is intentional.',
				count, category, this.maxListeners
			);
		}
	}

	/**
	 * Get the active data event store (top layer or base).
	 */
	private getActiveDataStore(): PendingDataEvent[] {
		return this.dataEventLayers.length > 0
			? this.dataEventLayers[this.dataEventLayers.length - 1]
			: this.batchedDataEvents;
	}

	/**
	 * Get the active schema event store (top layer or base).
	 */
	private getActiveSchemaStore(): PendingSchemaEvent[] {
		return this.schemaEventLayers.length > 0
			? this.schemaEventLayers[this.schemaEventLayers.length - 1]
			: this.batchedSchemaEvents;
	}

	/**
	 * Get the active collision event store (top savepoint layer or base).
	 */
	private getActiveCollisionStore(): MaintenanceCollisionEvent[] {
		return this.collisionEventLayers.length > 0
			? this.collisionEventLayers[this.collisionEventLayers.length - 1]
			: this.batchedCollisionEvents;
	}

	/**
	 * Every data-event store a batched rewrite must walk: the base batch plus each open
	 * savepoint layer. A rewrite touches all of them because a layer's events are still
	 * undelivered — a later RELEASE merges them into the parent and the commit ships them.
	 */
	private allDataEventStores(): PendingDataEvent[][] {
		return [this.batchedDataEvents, ...this.dataEventLayers];
	}

	/** Collision-channel counterpart of {@link allDataEventStores}. */
	private allCollisionEventStores(): MaintenanceCollisionEvent[][] {
		return [this.batchedCollisionEvents, ...this.collisionEventLayers];
	}

	/**
	 * Handle a data change event from a module.
	 * If batching, queue the event; otherwise emit immediately.
	 */
	private handleModuleDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.isBatching) {
			this.getActiveDataStore().push({ moduleName, event });
			log('Batched data event from %s: %s on %s.%s', moduleName, event.type, event.schemaName, event.tableName);
		} else {
			this.emitDataEvent(moduleName, event);
		}
	}

	/**
	 * Handle a schema change event from a module.
	 * Schema events are typically not batched (DDL is usually auto-committed),
	 * but we support batching for consistency.
	 */
	private handleModuleSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.isBatching) {
			this.getActiveSchemaStore().push({ moduleName, event });
			log('Batched schema event from %s: %s %s', moduleName, event.type, event.objectName);
		} else {
			this.emitSchemaEvent(moduleName, event);
		}
	}

	/**
	 * Emit a data change event for a module that doesn't have native event support.
	 * Called by the engine after successful DML operations.
	 *
	 * @param moduleName The module name
	 * @param event The event to emit (will be converted to DatabaseDataChangeEvent)
	 */
	emitAutoDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.isBatching) {
			this.getActiveDataStore().push({ moduleName, event });
			log('Batched auto data event from %s: %s on %s.%s', moduleName, event.type, event.schemaName, event.tableName);
		} else {
			this.emitDataEvent(moduleName, event);
		}
	}

	/**
	 * Emit a schema change event for a module that doesn't have native event support.
	 * Called by the engine after successful DDL operations.
	 *
	 * @param moduleName The module name
	 * @param event The event to emit
	 */
	emitAutoSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.isBatching) {
			this.getActiveSchemaStore().push({ moduleName, event });
		} else {
			this.emitSchemaEvent(moduleName, event);
		}
	}

	/**
	 * Queue a materialized-view key-coarsening collision for delivery. If batching
	 * (inside a transaction/savepoint), the event is captured in the active store
	 * and emitted only on commit (dropped on rollback); otherwise it is emitted —
	 * and counted — immediately. Mirrors {@link emitAutoDataEvent}.
	 */
	queueCollision(event: MaintenanceCollisionEvent): void {
		if (this.isBatching) {
			this.getActiveCollisionStore().push(event);
			log('Batched maintenance-collision event on %s.%s', event.schemaName, event.tableName);
		} else {
			this.emitCollisionEvent(event);
		}
	}

	/**
	 * Count and emit one collision event. The cumulative committed-collision
	 * counter is incremented FIRST (always — even with no listeners, so the count
	 * survives a host that never subscribed), then the event is delivered to each
	 * listener. A throwing listener is isolated so it cannot break emission to the
	 * others or the commit (mirrors {@link emitDataEvent}).
	 */
	private emitCollisionEvent(event: MaintenanceCollisionEvent): void {
		const counterKey = `${event.schemaName}.${event.tableName}`.toLowerCase();
		this.collisionCounts.set(counterKey, (this.collisionCounts.get(counterKey) ?? 0) + 1);

		if (this.collisionListeners.size === 0) return;

		log('Emitting maintenance-collision event on %s.%s (weakened: %s)',
			event.schemaName, event.tableName, event.weakenedColumns.join(', '));

		for (const listener of this.collisionListeners) {
			try {
				listener(event);
			} catch (e) {
				errorLog('Maintenance-collision listener error on %s.%s: %O',
					event.schemaName, event.tableName, e);
			}
		}
	}

	/**
	 * Project a pending data event into the database-level {@link DatabaseDataChangeEvent}
	 * shape delivered to listeners. The single source of truth for the projection,
	 * reused by both the per-event {@link emitDataEvent} path and the grouped
	 * {@link flushBatch} transaction-commit batch so listeners on either channel see
	 * identical shapes.
	 */
	private toDataChangeEvent(moduleName: string, event: VTableDataChangeEvent): DatabaseDataChangeEvent {
		return {
			type: event.type,
			moduleName,
			schemaName: event.schemaName,
			tableName: event.tableName,
			key: event.key,
			oldRow: event.oldRow,
			newRow: event.newRow,
			changedColumns: event.changedColumns,
			remote: event.remote ?? false,
		};
	}

	/**
	 * Project a pending schema event into the database-level {@link DatabaseSchemaChangeEvent}
	 * shape. Companion to {@link toDataChangeEvent}; same dual-use rationale.
	 */
	private toSchemaChangeEvent(moduleName: string, event: VTableSchemaChangeEvent): DatabaseSchemaChangeEvent {
		return {
			type: event.type,
			objectType: event.objectType,
			moduleName,
			schemaName: event.schemaName,
			objectName: event.objectName,
			columnName: event.columnName,
			oldColumnName: event.oldColumnName,
			ddl: event.ddl,
			remote: event.remote ?? false,
		};
	}

	/**
	 * Emit a data event to all listeners.
	 */
	private emitDataEvent(moduleName: string, event: VTableDataChangeEvent): void {
		if (this.dataListeners.size === 0) return;

		const dbEvent = this.toDataChangeEvent(moduleName, event);

		log('Emitting data event: %s on %s.%s (module: %s, remote: %s)',
			dbEvent.type, dbEvent.schemaName, dbEvent.tableName, moduleName, dbEvent.remote);

		for (const listener of this.dataListeners) {
			try {
				listener(dbEvent);
			} catch (e) {
				errorLog('Data change listener error on %s.%s (%s): %O',
					dbEvent.schemaName, dbEvent.tableName, dbEvent.type, e);
			}
		}
	}

	/**
	 * Emit a schema event to all listeners.
	 */
	private emitSchemaEvent(moduleName: string, event: VTableSchemaChangeEvent): void {
		if (this.schemaListeners.size === 0) return;

		const dbEvent = this.toSchemaChangeEvent(moduleName, event);

		log('Emitting schema event: %s %s %s (module: %s, remote: %s)',
			dbEvent.type, dbEvent.objectType, dbEvent.objectName, moduleName, dbEvent.remote);

		for (const listener of this.schemaListeners) {
			try {
				listener(dbEvent);
			} catch (e) {
				errorLog('Schema change listener error on %s %s %s: %O',
					dbEvent.type, dbEvent.objectType, dbEvent.objectName, e);
			}
		}
	}

	/**
	 * Start batching events (called at transaction begin).
	 */
	startBatch(): void {
		this.isBatching = true;
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.batchedCollisionEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		this.collisionEventLayers = [];
		log('Started event batching');
	}

	/**
	 * Flush all batched events to listeners (called after successful commit).
	 * Collects events from all layers (base + savepoint layers) and emits them.
	 */
	flushBatch(): void {
		this.isBatching = false;

		// Collect all events from base and all layers
		const allDataEvents: PendingDataEvent[] = [...this.batchedDataEvents];
		for (const layer of this.dataEventLayers) {
			allDataEvents.push(...layer);
		}

		const allSchemaEvents: PendingSchemaEvent[] = [...this.batchedSchemaEvents];
		for (const layer of this.schemaEventLayers) {
			allSchemaEvents.push(...layer);
		}

		const allCollisionEvents: MaintenanceCollisionEvent[] = [...this.batchedCollisionEvents];
		for (const layer of this.collisionEventLayers) {
			allCollisionEvents.push(...layer);
		}

		// Clear all
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.batchedCollisionEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		this.collisionEventLayers = [];

		log('Flushing %d data events, %d schema events, and %d collision events',
			allDataEvents.length, allSchemaEvents.length, allCollisionEvents.length);

		// Emit schema events first (table creation before data insertion makes logical sense)
		for (const { moduleName, event } of allSchemaEvents) {
			this.emitSchemaEvent(moduleName, event);
		}

		// Then emit data events
		for (const { moduleName, event } of allDataEvents) {
			this.emitDataEvent(moduleName, event);
		}

		// Then count + emit collision events (each increments the cumulative counter,
		// so the count reflects only committed collisions).
		for (const event of allCollisionEvents) {
			this.emitCollisionEvent(event);
		}

		// Finally, deliver the whole committed transaction as a single grouped
		// batch on the additive onTransactionCommit channel. Built from the same
		// allDataEvents/allSchemaEvents projections the per-event path used, so the
		// shapes match. Skipped entirely when no listener is subscribed (avoid the
		// per-commit allocation in the common no-subscriber case) or when the
		// transaction produced no data/schema facts (an empty/idle commit, or one
		// that produced only collisions — collisions keep their own channel).
		if (this.transactionCommitListeners.size > 0 && (allDataEvents.length + allSchemaEvents.length) > 0) {
			this.emitTransactionCommit({
				dataEvents: allDataEvents.map(({ moduleName, event }) => this.toDataChangeEvent(moduleName, event)),
				schemaEvents: allSchemaEvents.map(({ moduleName, event }) => this.toSchemaChangeEvent(moduleName, event)),
			});
		}
	}

	/**
	 * Deliver one grouped {@link TransactionCommitBatch} to each transaction-commit
	 * listener. A throwing listener is isolated so it cannot break delivery to the
	 * others or the commit (mirrors {@link emitDataEvent}).
	 */
	private emitTransactionCommit(batch: TransactionCommitBatch): void {
		log('Emitting transaction-commit batch: %d data events, %d schema events',
			batch.dataEvents.length, batch.schemaEvents.length);

		for (const listener of this.transactionCommitListeners) {
			try {
				listener(batch);
			} catch (e) {
				errorLog('Transaction-commit listener error: %O', e);
			}
		}
	}

	/**
	 * Rewrite the row images of every BATCHED data event for one table, in place, after a
	 * mid-transaction column-set, column-name, or column-value change (`ALTER TABLE
	 * ADD/DROP/RENAME COLUMN`, `ALTER COLUMN … SET DATA TYPE` / `SET NOT NULL` backfill).
	 * Covers {@link batchedDataEvents} and every {@link dataEventLayers} savepoint layer,
	 * so a commit delivers each event's `oldRow`/`newRow` in the schema current at delivery.
	 * No-op when not batching: in autocommit the earlier events were already delivered,
	 * and there is no earlier same-transaction write to fix.
	 *
	 * An event that already carried `changedColumns` gets it re-derived against
	 * `newColumnNames`; one that never carried it keeps it absent, because some modules
	 * (the store) deliberately omit it and leave the per-column diff to the consumer —
	 * synthesizing one only for transactions that happened to ALTER would make the
	 * delivered shape depend on unrelated DDL.
	 *
	 * BEST-EFFORT, unlike the module-side pending-ROW reshape (whose failure must reject
	 * the ALTER): these are historical row images, including superseded intermediate ones
	 * a backfill evaluator or value conversion can legitimately fail on. A `remapRow`
	 * throw leaves that event's image as it was (logged), and never rejects an ALTER
	 * that would otherwise succeed.
	 */
	async remapBatchedDataEvents(
		schemaName: string,
		tableName: string,
		remapRow: (row: Row, which: 'old' | 'new') => Row | Promise<Row>,
		newColumnNames: readonly string[],
	): Promise<void> {
		if (!this.isBatching) return;

		const schemaLower = schemaName.toLowerCase();
		const tableLower = tableName.toLowerCase();
		let remapped = 0;
		for (const store of this.allDataEventStores()) {
			for (const entry of store) {
				const event = entry.event;
				if (!namesTable(event, schemaLower, tableLower)) continue;
				const next: VTableDataChangeEvent = { ...event };
				try {
					if (event.oldRow !== undefined) next.oldRow = await remapRow(event.oldRow, 'old');
				} catch (e) {
					warnLog('remapBatchedDataEvents: oldRow remap failed on %s.%s, leaving image as-is: %O',
						event.schemaName, event.tableName, e);
				}
				try {
					if (event.newRow !== undefined) next.newRow = await remapRow(event.newRow, 'new');
				} catch (e) {
					warnLog('remapBatchedDataEvents: newRow remap failed on %s.%s, leaving image as-is: %O',
						event.schemaName, event.tableName, e);
				}
				if (next.changedColumns) {
					// Both images present at a common arity ⇒ re-derive positionally: a dropped
					// column falls out, an added one can appear, and a RENAME's new name
					// replaces the old. Otherwise (a delete's lone image, or a remap that failed
					// on one side and left it at the old arity) a positional diff is meaningless,
					// so only drop names that no longer exist.
					if (next.oldRow && next.newRow && next.oldRow.length === next.newRow.length) {
						next.changedColumns = computeChangedColumnNames(next.oldRow, next.newRow, newColumnNames);
					} else {
						const valid = new Set(newColumnNames.map(n => n.toLowerCase()));
						next.changedColumns = next.changedColumns.filter(n => valid.has(n.toLowerCase()));
					}
				}
				entry.event = next;
				remapped++;
			}
		}
		if (remapped > 0) {
			log('Remapped %d batched data events on %s.%s after mid-transaction ALTER', remapped, schemaName, tableName);
		}
	}

	/**
	 * Relabel every BATCHED event naming `(schemaName, oldTableName)` to `newTableName`,
	 * in place, after a mid-transaction `ALTER TABLE … RENAME TO`. Covers
	 * {@link batchedDataEvents} and every {@link dataEventLayers} savepoint layer, plus the
	 * collision channel ({@link batchedCollisionEvents} / {@link collisionEventLayers}) —
	 * a maintained table (materialized view) can be renamed too. So a commit delivers each
	 * event under the name the table has at delivery, not the one it had at write time.
	 *
	 * No-op when not batching: in autocommit the earlier events were already delivered under
	 * the name the table had at the time, which is correct.
	 *
	 * Relabelling cannot fail (it moves no value and reads no schema), so unlike
	 * {@link remapBatchedDataEvents} this is synchronous and needs no per-event `try`.
	 * `key` and `changedColumns` are untouched — a rename moves no value and changes no column.
	 *
	 * Batched SCHEMA events are deliberately NOT relabelled; see the call site in
	 * `runtime/emit/alter-table.ts`.
	 */
	renameBatchedEvents(schemaName: string, oldTableName: string, newTableName: string): void {
		if (!this.isBatching) return;

		const schemaLower = schemaName.toLowerCase();
		const oldLower = oldTableName.toLowerCase();
		let relabelled = 0;

		for (const store of this.allDataEventStores()) {
			for (const entry of store) {
				if (!namesTable(entry.event, schemaLower, oldLower)) continue;
				entry.event = { ...entry.event, tableName: newTableName };
				relabelled++;
			}
		}

		for (const store of this.allCollisionEventStores()) {
			for (let i = 0; i < store.length; i++) {
				if (!namesTable(store[i], schemaLower, oldLower)) continue;
				store[i] = { ...store[i], tableName: newTableName };
				relabelled++;
			}
		}

		if (relabelled > 0) {
			log('Relabelled %d batched events from %s.%s to %s after mid-transaction RENAME TO',
				relabelled, schemaName, oldTableName, newTableName);
		}
	}

	/**
	 * Discard all batched events (called on rollback).
	 */
	discardBatch(): void {
		this.isBatching = false;
		const discardedData = this.batchedDataEvents.length + this.dataEventLayers.reduce((sum, layer) => sum + layer.length, 0);
		const discardedSchema = this.batchedSchemaEvents.length + this.schemaEventLayers.reduce((sum, layer) => sum + layer.length, 0);
		const discardedCollision = this.batchedCollisionEvents.length + this.collisionEventLayers.reduce((sum, layer) => sum + layer.length, 0);
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.batchedCollisionEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		this.collisionEventLayers = [];
		log('Discarded %d data events, %d schema events, and %d collision events',
			discardedData, discardedSchema, discardedCollision);
	}

	/**
	 * Begin a new savepoint layer for event batching.
	 * Events after this point will be captured in the new layer.
	 */
	beginSavepointLayer(): void {
		this.dataEventLayers.push([]);
		this.schemaEventLayers.push([]);
		this.collisionEventLayers.push([]);
		log('Started savepoint event layer (depth: %d)', this.dataEventLayers.length);
	}

	/**
	 * Rollback the current savepoint layer, discarding its events.
	 * Called on ROLLBACK TO SAVEPOINT.
	 */
	rollbackSavepointLayer(): void {
		const discardedData = this.dataEventLayers.pop();
		const discardedSchema = this.schemaEventLayers.pop();
		const discardedCollision = this.collisionEventLayers.pop();
		log('Rolled back savepoint event layer, discarded %d data, %d schema, and %d collision events',
			discardedData?.length ?? 0, discardedSchema?.length ?? 0, discardedCollision?.length ?? 0);
	}

	/**
	 * Release the current savepoint layer, merging its events into the parent layer.
	 * Called on RELEASE SAVEPOINT.
	 */
	releaseSavepointLayer(): void {
		const topData = this.dataEventLayers.pop();
		const topSchema = this.schemaEventLayers.pop();

		if (topData && topData.length > 0) {
			// Merge into parent layer or base
			const targetData = this.dataEventLayers.length > 0
				? this.dataEventLayers[this.dataEventLayers.length - 1]
				: this.batchedDataEvents;
			targetData.push(...topData);
		}

		if (topSchema && topSchema.length > 0) {
			const targetSchema = this.schemaEventLayers.length > 0
				? this.schemaEventLayers[this.schemaEventLayers.length - 1]
				: this.batchedSchemaEvents;
			targetSchema.push(...topSchema);
		}

		const topCollision = this.collisionEventLayers.pop();
		if (topCollision && topCollision.length > 0) {
			const targetCollision = this.collisionEventLayers.length > 0
				? this.collisionEventLayers[this.collisionEventLayers.length - 1]
				: this.batchedCollisionEvents;
			targetCollision.push(...topCollision);
		}

		log('Released savepoint event layer, merged %d data, %d schema, and %d collision events',
			topData?.length ?? 0, topSchema?.length ?? 0, topCollision?.length ?? 0);
	}

	/**
	 * Remove all listeners and unhook all modules.
	 * Logs a warning if listeners were still registered, which may indicate
	 * missing cleanup in consumer code.
	 */
	removeAllListeners(): void {
		const dataCount = this.dataListeners.size;
		const schemaCount = this.schemaListeners.size;
		const collisionCount = this.collisionListeners.size;
		const txCommitCount = this.transactionCommitListeners.size;

		if (dataCount > 0 || schemaCount > 0 || collisionCount > 0 || txCommitCount > 0) {
			warnLog(
				'removeAllListeners() called with %d data, %d schema, %d collision, and %d transaction-commit listeners still registered — possible listener leak',
				dataCount, schemaCount, collisionCount, txCommitCount
			);
		}

		this.dataListeners.clear();
		this.schemaListeners.clear();
		this.collisionListeners.clear();
		this.transactionCommitListeners.clear();
		this.batchedDataEvents = [];
		this.batchedSchemaEvents = [];
		this.batchedCollisionEvents = [];
		this.dataEventLayers = [];
		this.schemaEventLayers = [];
		this.collisionEventLayers = [];
		this.collisionCounts.clear();
		this.isBatching = false;

		// Unhook all module emitters
		for (const [, subs] of this.moduleSubscriptions) {
			subs.dataUnsub?.();
			subs.schemaUnsub?.();
		}
		this.moduleSubscriptions.clear();

		log('Removed all listeners and unhooked all modules');
	}

	/**
	 * Check if currently batching events.
	 */
	isBatchingEvents(): boolean {
		return this.isBatching;
	}
}
