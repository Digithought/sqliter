import type { Row, SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import type { AnyVirtualTableModule } from './module.js';

const log = createLogger('vtab:events');
const errorLog = log.extend('error');

/**
 * Attempt to extract a {@link VTableEventEmitter} from a virtual-table module.
 * Returns `undefined` when the module does not expose `getEventEmitter()` or
 * the returned object does not provide at least one of `onDataChange` /
 * `onSchemaChange`. Used by both the database-level event hooking path and
 * the public {@link Table} handle.
 */
export function tryGetEventEmitter(module: AnyVirtualTableModule): VTableEventEmitter | undefined {
	const asSource = module as { getEventEmitter?: () => unknown };
	if (typeof asSource.getEventEmitter !== 'function') return undefined;
	const emitter = asSource.getEventEmitter();
	if (!emitter || typeof emitter !== 'object') return undefined;
	const typed = emitter as { onDataChange?: unknown; onSchemaChange?: unknown };
	if (typeof typed.onDataChange !== 'function' && typeof typed.onSchemaChange !== 'function') return undefined;
	return emitter as VTableEventEmitter;
}

/**
 * Data change event emitted when mutations are committed.
 *
 * Producers owe the key contract in `docs/usage.md` § Subscribing to Data Changes: `key` is
 * projected from the event's own row image, and an `update` never moves a row (a relocating
 * primary-key change is a `delete` at the old key then an `insert` at the new one).
 */
export interface VTableDataChangeEvent {
	/** The type of mutation operation */
	type: 'insert' | 'update' | 'delete';
	/** Schema name containing the table */
	schemaName: string;
	/** Table name */
	tableName: string;
	/** Primary key projected from this event's own image: `newRow` for insert/update, `oldRow` for delete */
	key?: SqlValue[];
	/** Previous row data (for update/delete) */
	oldRow?: Row;
	/** New row data (for insert/update) */
	newRow?: Row;
	/** Column names that changed (for updates) */
	changedColumns?: string[];
	/** True if event originated from sync/remote source */
	remote?: boolean;
}

/**
 * Schema change event emitted when DDL operations complete.
 */
export interface VTableSchemaChangeEvent {
	/** The type of schema operation */
	type: 'create' | 'alter' | 'drop';
	/** The type of object being modified */
	objectType: 'table' | 'index' | 'column';
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
	/** True if event originated from sync/remote source */
	remote?: boolean;
}

export type VTableDataChangeListener = (event: VTableDataChangeEvent) => void;
export type VTableSchemaChangeListener = (event: VTableSchemaChangeEvent) => void;

/**
 * Interface for vtab modules that support mutation and/or schema event hooks.
 * Both data and schema change support are independently optional.
 */
export interface VTableEventEmitter {
	/**
	 * Subscribe to data change events.
	 * @returns Unsubscribe function
	 */
	onDataChange?(listener: VTableDataChangeListener): () => void;

	/**
	 * Check if there are any data change listeners registered
	 */
	hasDataListeners?(): boolean;

	/**
	 * Emit a data change event (typically called by the module on commit)
	 */
	emitDataChange?(event: VTableDataChangeEvent): void;

	/**
	 * Start batching data change events (call at transaction begin if needed)
	 */
	startBatch?(): void;

	/**
	 * Flush batched data change events to listeners (call after successful commit)
	 */
	flushBatch?(): void;

	/**
	 * Discard batched data change events (call on rollback)
	 */
	discardBatch?(): void;

	/**
	 * Subscribe to schema change events.
	 * @returns Unsubscribe function
	 */
	onSchemaChange?(listener: VTableSchemaChangeListener): () => void;

	/**
	 * Check if there are any schema change listeners registered
	 */
	hasSchemaListeners?(): boolean;

	/**
	 * Emit a schema change event
	 */
	emitSchemaChange?(event: VTableSchemaChangeEvent): void;

	/**
	 * Remove all listeners (both data and schema)
	 */
	removeAllListeners?(): void;
}

/**
 * Default implementation of VTableEventEmitter with support for both data and schema events.
 * Can be used directly or extended by module-specific implementations.
 */
export class DefaultVTableEventEmitter implements VTableEventEmitter {
	private dataListeners: Set<VTableDataChangeListener> = new Set();
	private schemaListeners: Set<VTableSchemaChangeListener> = new Set();
	private batchedDataEvents: VTableDataChangeEvent[] = [];
	private isBatching = false;

	onDataChange(listener: VTableDataChangeListener): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	hasDataListeners(): boolean {
		return this.dataListeners.size > 0;
	}

	emitDataChange(event: VTableDataChangeEvent): void {
		if (this.isBatching) {
			this.batchedDataEvents.push(event);
			return;
		}

		for (const listener of this.dataListeners) {
			try {
				listener(event);
			} catch (e) {
				errorLog('Data change listener error on %s.%s (%s): %O',
					event.schemaName, event.tableName, event.type, e);
			}
		}
	}

	startBatch(): void {
		this.isBatching = true;
		this.batchedDataEvents = [];
	}

	flushBatch(): void {
		this.isBatching = false;
		const events = this.batchedDataEvents;
		this.batchedDataEvents = [];

		for (const event of events) {
			for (const listener of this.dataListeners) {
				try {
					listener(event);
				} catch (e) {
					errorLog('Data change listener error on %s.%s (%s): %O',
						event.schemaName, event.tableName, event.type, e);
				}
			}
		}
	}

	discardBatch(): void {
		this.isBatching = false;
		this.batchedDataEvents = [];
	}

	onSchemaChange(listener: VTableSchemaChangeListener): () => void {
		this.schemaListeners.add(listener);
		return () => this.schemaListeners.delete(listener);
	}

	hasSchemaListeners(): boolean {
		return this.schemaListeners.size > 0;
	}

	emitSchemaChange(event: VTableSchemaChangeEvent): void {
		for (const listener of this.schemaListeners) {
			try {
				listener(event);
			} catch (e) {
				errorLog('Schema change listener error on %s %s %s: %O',
					event.type, event.objectType, event.objectName, e);
			}
		}
	}

	removeAllListeners(): void {
		this.dataListeners.clear();
		this.schemaListeners.clear();
		this.batchedDataEvents = [];
		this.isBatching = false;
	}
}

