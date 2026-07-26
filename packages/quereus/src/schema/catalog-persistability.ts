import type { Database } from '../core/database.js';
import type { CatalogObjectKind } from '../vtab/module.js';
import type { TableSchema } from './table.js';
import type { ViewSchema } from './view.js';

/**
 * Pre-flight gate run before a view / materialized view is registered in the
 * catalog: asks every registered virtual-table module whether it could durably
 * persist `object`, and lets the first refusal propagate out of the statement.
 *
 * This exists because view/MV catalog persistence is otherwise **advisory**. It
 * runs through `SchemaChangeNotifier`, which wraps each listener in try/catch and
 * only logs, and a store module then chains the write onto an async queue with its
 * own `.catch`. So a definition the store cannot encode (today: an unpaired
 * surrogate in the name, in a column name, or in a string literal in the body)
 * would create successfully, be queryable for the session, and then be silently
 * absent after reopen. Neither swallow layer can be tightened without making an
 * unrelated listener failure abort user DDL — hence a synchronous veto at
 * statement-execution time, on a path whose throw propagates.
 *
 * Call it BEFORE the registering mutation (or inside a caller's existing rollback
 * arm) so a rejection leaves the statement a clean no-op. Modules that would not
 * persist the object no-op; see {@link VirtualTableModule.assertCatalogObjectPersistable}.
 */
export function assertCatalogObjectPersistable(
	db: Database,
	kind: CatalogObjectKind,
	object: ViewSchema | TableSchema,
): void {
	for (const { module } of db.schemaManager.allModules()) {
		module.assertCatalogObjectPersistable?.(db, kind, object);
	}
}
