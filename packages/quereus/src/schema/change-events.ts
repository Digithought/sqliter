import type { TableSchema } from './table.js';
import type { FunctionSchema } from './function.js';
import type { IntegrityAssertionSchema } from './assertion.js';
import type { ViewSchema } from './view.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:change-events');

// ── Base event shapes ──────────────────────────────────────────────

interface SchemaObjectAdded<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	newObject: T;
}

interface SchemaObjectRemoved<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	oldObject: T;
}

interface SchemaObjectModified<Type extends string, T> {
	type: Type;
	schemaName: string;
	objectName: string;
	oldObject: T;
	newObject: T;
}

// ── Table events ───────────────────────────────────────────────────

export type TableAddedEvent = SchemaObjectAdded<'table_added', TableSchema>;
export type TableRemovedEvent = SchemaObjectRemoved<'table_removed', TableSchema>;
export type TableModifiedEvent = SchemaObjectModified<'table_modified', TableSchema>;

// ── Function events ────────────────────────────────────────────────

export type FunctionAddedEvent = SchemaObjectAdded<'function_added', FunctionSchema>;
export type FunctionRemovedEvent = SchemaObjectRemoved<'function_removed', FunctionSchema>;
export type FunctionModifiedEvent = SchemaObjectModified<'function_modified', FunctionSchema>;

// ── Assertion events ───────────────────────────────────────────────

export type AssertionAddedEvent = SchemaObjectAdded<'assertion_added', IntegrityAssertionSchema>;
export type AssertionRemovedEvent = SchemaObjectRemoved<'assertion_removed', IntegrityAssertionSchema>;
export type AssertionModifiedEvent = SchemaObjectModified<'assertion_modified', IntegrityAssertionSchema>;

// ── View events ────────────────────────────────────────────────────

/**
 * Emitted after a plain `CREATE VIEW` / `DROP VIEW` (fired from the runtime
 * emitters, NOT from `Schema.addView`/`removeView`). Scoping the event to the
 * DDL emitters deliberately excludes internally-registered views (lens effective
 * bodies, any other direct `schema.addView` caller) which must NOT be persisted
 * to a store-backed catalog — they are re-derived, not stored. A store catalog
 * subscribes to these to persist/forget a view incrementally. Mirrors how the MV
 * emitters fire `materialized_view_added`/`_removed`.
 */
export type ViewAddedEvent = SchemaObjectAdded<'view_added', ViewSchema>;
export type ViewRemovedEvent = SchemaObjectRemoved<'view_removed', ViewSchema>;

/**
 * Emitted after an in-place change to an existing (non-materialized) view. Two
 * sources fire it: `ALTER VIEW … SET TAGS`, and an `ALTER TABLE/COLUMN RENAME`
 * that rewrites a dependent view's body in place (propagating the new
 * table/column name into `selectAst` + `sql`). Distinct from `view_added`
 * (which a fresh create fires) so a cached write-through plan that recorded a
 * `view` dependency invalidates when the view changes, and so a store-backed
 * catalog re-persists the (re-generated) view DDL — both without re-triggering
 * a persistence re-create.
 */
export type ViewModifiedEvent = SchemaObjectModified<'view_modified', ViewSchema>;

// ── Materialized view events ───────────────────────────────────────
// Keyed by the maintained table's own name (unified model: one `TableSchema`
// carrying a `derivation`); payloads are that table. The channel survives so
// store catalog persistence keeps re-saving the `create materialized view`
// DDL on derivation changes, distinct from the table-bundle channel.

export type MaterializedViewAddedEvent = SchemaObjectAdded<'materialized_view_added', TableSchema>;
export type MaterializedViewRemovedEvent = SchemaObjectRemoved<'materialized_view_removed', TableSchema>;

/**
 * Emitted after an in-place change to an existing materialized view — currently
 * only `ALTER MATERIALIZED VIEW … SET TAGS`. Deliberately **distinct** from
 * `materialized_view_added` (which the MV maintenance manager treats as a
 * re-registration trigger): a tag change must invalidate dependent cached
 * write-through plans WITHOUT re-registering maintenance or rebuilding the
 * backing. No maintenance listener subscribes to this event.
 */
export type MaterializedViewModifiedEvent = SchemaObjectModified<'materialized_view_modified', TableSchema>;

/** Emitted after a successful `REFRESH MATERIALIZED VIEW`. Carries the current schema. */
export interface MaterializedViewRefreshedEvent {
	type: 'materialized_view_refreshed';
	schemaName: string;
	objectName: string;
	object: TableSchema;
}

// ── Module / collation events (name-only payload) ──────────────────

interface SchemaNameEvent<Type extends string> {
	type: Type;
	schemaName: string;
	objectName: string;
}

export type ModuleAddedEvent = SchemaNameEvent<'module_added'>;
export type ModuleRemovedEvent = SchemaNameEvent<'module_removed'>;
export type CollationAddedEvent = SchemaNameEvent<'collation_added'>;
export type CollationRemovedEvent = SchemaNameEvent<'collation_removed'>;

// ── Discriminated union ────────────────────────────────────────────

export type SchemaChangeEvent =
	| TableAddedEvent
	| TableRemovedEvent
	| TableModifiedEvent
	| FunctionAddedEvent
	| FunctionRemovedEvent
	| FunctionModifiedEvent
	| AssertionAddedEvent
	| AssertionRemovedEvent
	| AssertionModifiedEvent
	| ViewAddedEvent
	| ViewRemovedEvent
	| ViewModifiedEvent
	| MaterializedViewAddedEvent
	| MaterializedViewRemovedEvent
	| MaterializedViewModifiedEvent
	| MaterializedViewRefreshedEvent
	| ModuleAddedEvent
	| ModuleRemovedEvent
	| CollationAddedEvent
	| CollationRemovedEvent;

/**
 * Function that handles schema change events.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;

/**
 * Manages schema change listeners and notifications.
 */
export class SchemaChangeNotifier {
	private listeners = new Set<SchemaChangeListener>();

	/**
	 * Adds a schema change listener.
	 * @returns A function to unsubscribe the listener.
	 */
	addListener(listener: SchemaChangeListener): () => void {
		this.listeners.add(listener);
		log('Added schema change listener, total listeners: %d', this.listeners.size);
		return () => this.removeListener(listener);
	}

	/**
	 * Removes a schema change listener.
	 */
	removeListener(listener: SchemaChangeListener): void {
		const removed = this.listeners.delete(listener);
		if (removed) {
			log('Removed schema change listener, total listeners: %d', this.listeners.size);
		}
	}

	/**
	 * Notifies all listeners of a schema change event.
	 */
	notifyChange(event: SchemaChangeEvent): void {
		log('Notifying %d listeners of schema change: %s %s',
			this.listeners.size, event.type, event.objectName);

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				log('Error in schema change listener: %s', error);
			}
		}
	}

	/**
	 * Gets the number of active listeners.
	 */
	getListenerCount(): number {
		return this.listeners.size;
	}

	/**
	 * Clears all listeners.
	 */
	clearListeners(): void {
		const count = this.listeners.size;
		this.listeners.clear();
		log('Cleared all %d schema change listeners', count);
	}
}
