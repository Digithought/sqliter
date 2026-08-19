/**
 * Reactive event types and emitter for schema and data changes.
 */

import type { Row, SqlValue, VTableEventEmitter, VTableSchemaChangeEvent } from '@quereus/quereus';

/**
 * Schema change event types.
 *
 * An ALIAS of the engine's {@link VTableSchemaChangeEvent}, not a re-declaration: the two
 * are one wire shape, and the hand-maintained copy this replaced had drifted narrower than
 * the engine's (no `'column'` object type, no `columnName` / `oldColumnName`), which made
 * the documented per-arm ALTER TABLE shape unrepresentable here. Keep it an alias so the
 * store cannot drift from the contract in `docs/usage.md`
 * § What each `ALTER TABLE` arm reports again.
 */
export type SchemaChangeEvent = VTableSchemaChangeEvent;

/**
 * Data change event types.
 *
 * Producers owe the engine's key contract (`docs/usage.md` § Subscribing to Data Changes):
 * `key` is projected from the event's own row image, and an `update` never moves a row — a
 * relocating primary-key change is a `delete` at the old key then an `insert` at the new one.
 */
export interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  /** Primary key projected from this event's own image: `newRow` for insert/update, `oldRow` for delete. Alias: pk */
  key?: SqlValue[];
  /** Primary key values. Alias: key */
  pk?: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  /** Column names that were changed (for update events). */
  changedColumns?: string[];
  /** True if this event originated from sync (remote replica) or cross-tab. */
  remote?: boolean;
}

/**
 * Event listener types.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;
export type DataChangeListener = (event: DataChangeEvent) => void;

/** Case-insensitive `(schema, object)` scope key — identifiers are case-insensitive engine-wide. */
function remoteScopeKey(schemaName: string, objectName: string): string {
	return `${schemaName.toLowerCase()}:${objectName.toLowerCase()}`;
}

/**
 * Simple event emitter for store events.
 * Implements VTableEventEmitter for compatibility with core vtab event system.
 */
export class StoreEventEmitter implements VTableEventEmitter {
	private schemaListeners: Set<SchemaChangeListener> = new Set();
	private dataListeners: Set<DataChangeListener> = new Set();
	private batchedDataEvents: DataChangeEvent[] = [];
	private isBatching = false;
	/**
	 * Open remote-schema scopes, refcounted per `(schema, object)` key. While a
	 * scope is open, every schema event naming that object is marked remote —
	 * see {@link beginRemoteSchemaScope}.
	 */
	private remoteSchemaScopes: Map<string, number> = new Map();

  /**
   * Subscribe to schema change events.
   * @returns Unsubscribe function.
   */
  onSchemaChange(listener: SchemaChangeListener): () => void {
    this.schemaListeners.add(listener);
    return () => this.schemaListeners.delete(listener);
  }

  /**
   * Subscribe to data change events.
   * @returns Unsubscribe function.
   */
  onDataChange(listener: DataChangeListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /**
   * Emit a schema change event.
   * If a remote-schema scope is open for the named object, the event is marked remote.
   */
  emitSchemaChange(event: SchemaChangeEvent): void {
    if ((this.remoteSchemaScopes.get(remoteScopeKey(event.schemaName, event.objectName)) ?? 0) > 0) {
      event = { ...event, remote: true };
    }

    for (const listener of this.schemaListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Schema change listener error:', e);
      }
    }
  }

  /**
   * Open a remote-schema scope for `(schemaName, objectName)`: until the matching
   * {@link endRemoteSchemaScope}, EVERY schema event naming that object is marked
   * `remote: true` — whether the scoped statement emits zero, one, or several
   * events. Matching never consumes the scope; only the caller's `finally` closes
   * it, so a statement that emits nothing leaves nothing behind. Refcounted, so
   * nested/concurrent scopes over the same object compose.
   *
   * Tradeoff of time-bounded (vs. the old signature-matched, consume-on-match)
   * marking: a CONCURRENT local DDL on the same `(schema, object)`, issued while
   * the scoped statement is in flight, would be mis-marked remote. `Database`
   * serializes statements behind its execution mutex, so that requires a host
   * issuing local DDL on the very table being replicated at that moment. The old
   * scheme had the mirror-image hazard (a concurrent local DDL of the same
   * signature consumed the marker) and additionally leaked or starved whenever a
   * statement's event count was not exactly one.
   */
  beginRemoteSchemaScope(schemaName: string, objectName: string): void {
    const key = remoteScopeKey(schemaName, objectName);
    this.remoteSchemaScopes.set(key, (this.remoteSchemaScopes.get(key) ?? 0) + 1);
  }

  /**
   * Close a scope opened by {@link beginRemoteSchemaScope}. Call from a `finally`
   * so a throwing statement cannot leave the scope open.
   */
  endRemoteSchemaScope(schemaName: string, objectName: string): void {
    const key = remoteScopeKey(schemaName, objectName);
    const current = this.remoteSchemaScopes.get(key);
    if (current === undefined || current <= 1) {
      this.remoteSchemaScopes.delete(key);
    } else {
      this.remoteSchemaScopes.set(key, current - 1);
    }
  }

  /**
   * Emit a data change event.
   * If batching is active, queues the event for later emission.
   */
  emitDataChange(event: DataChangeEvent): void {
    if (this.isBatching) {
      this.batchedDataEvents.push(event);
      return;
    }

    for (const listener of this.dataListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Data change listener error:', e);
      }
    }
  }

  /**
   * Start batching data change events.
   * Events will be queued until flush() or discard() is called.
   */
  startBatch(): void {
    this.isBatching = true;
    this.batchedDataEvents = [];
  }

  /**
   * Flush batched data change events to listeners.
   */
  flushBatch(): void {
    this.isBatching = false;
    const events = this.batchedDataEvents;
    this.batchedDataEvents = [];

    for (const event of events) {
      for (const listener of this.dataListeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('Data change listener error:', e);
        }
      }
    }
  }

  /**
   * Discard batched data change events (e.g., on rollback).
   */
  discardBatch(): void {
    this.isBatching = false;
    this.batchedDataEvents = [];
  }

	/**
	 * Check if there are any listeners registered.
	 */
	hasListeners(): boolean {
		return this.schemaListeners.size > 0 || this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any data listeners registered (VTableEventEmitter compatibility).
	 */
	hasDataListeners(): boolean {
		return this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any schema listeners registered (VTableEventEmitter compatibility).
	 */
	hasSchemaListeners(): boolean {
		return this.schemaListeners.size > 0;
	}

	/**
	 * Remove all listeners.
	 */
	removeAllListeners(): void {
		this.schemaListeners.clear();
		this.dataListeners.clear();
		this.batchedDataEvents = [];
		this.isBatching = false;
	}
}

