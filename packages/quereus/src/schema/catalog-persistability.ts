import type { Database } from '../core/database.js';
import type * as AST from '../parser/ast.js';
import { spineCloneAst } from '../util/ast-spine-clone.js';
import type { CatalogObjectKind } from '../vtab/module.js';
import { isMaintainedTable } from './derivation.js';
import type { Schema } from './schema.js';
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

/**
 * A rewrite of a view / materialized-view body, applied IN PLACE to the node it is
 * handed, returning whether anything changed — the shape
 * {@link import('./rename-rewriter.js').renameTableInAst} and
 * {@link import('./rename-rewriter.js').renameColumnInAst} already have.
 */
export type BodyRewrite = (ast: AST.QueryExpr) => boolean;

/**
 * Pre-flight gate for `ALTER TABLE … RENAME [COLUMN]`: computes what `rewrite` would
 * make of every view / materialized-view body in `schema` and vetoes the PROSPECTIVE
 * object through {@link assertCatalogObjectPersistable}, so a rename that would leave
 * a persisted dependent unwritable fails the statement instead of succeeding and
 * losing (or silently diverging from) it.
 *
 * The rename propagation is unfailable by construction — it rides
 * `SchemaChangeNotifier` (try/catch per listener, log only) and then a store module's
 * async persist queue (`.catch`-log) — so, exactly as for CREATE VIEW, a synchronous
 * veto ahead of the first side effect is the only place a refusal can reach the user.
 *
 * `rewrite` mutates in place, so each body is rewritten on a {@link spineCloneAst}
 * copy: a veto thrown after mutating the LIVE AST would leave the view body naming a
 * table that was never renamed. Both DDL generators read the AST rather than a cached
 * string, so swapping the clone into a shallow copy of the record is all a prospective
 * render needs. Bodies the rewrite does not touch render identically to what is already
 * persisted and are skipped.
 *
 * Scoped to a single `Schema` because that is the scope the propagation's own view / MV
 * loops use (see `propagateTableRenameInSchema`) — a dependent in another schema is
 * never rewritten, so it has nothing new to persist.
 */
// NOTE: clones and re-renders the body of every view and maintained table in the schema
// on every `ALTER … RENAME`, and the propagation that follows renders each changed one
// again. DDL is rare and bodies are small, so this is not worth caching today; if a
// schema-heavy workload ever shows up hot here, thread the prospective object through to
// the propagation instead of rebuilding it. Costs nothing at all when no module can veto
// (the early return below) — a memory-only database never pays it.
export function assertRenameDependentsPersistable(
	db: Database,
	schema: Schema,
	rewrite: BodyRewrite,
): void {
	if (!anyModuleCanVeto(db)) return;
	for (const view of Array.from(schema.getAllViews())) {
		const selectAst = spineCloneAst(view.selectAst);
		if (!rewrite(selectAst)) continue;
		assertCatalogObjectPersistable(db, 'view', { ...view, selectAst });
	}
	for (const table of Array.from(schema.getAllTables())) {
		if (!isMaintainedTable(table)) continue;
		const selectAst = spineCloneAst(table.derivation.selectAst);
		if (!rewrite(selectAst)) continue;
		assertCatalogObjectPersistable(db, 'materializedView', {
			...table,
			derivation: { ...table.derivation, selectAst },
		});
	}
}

/** Whether any registered module implements the veto hook at all — the same presence
 *  test {@link assertCatalogObjectPersistable} applies per module, hoisted so the scan
 *  can skip its clone-and-render work entirely when nothing could refuse. */
function anyModuleCanVeto(db: Database): boolean {
	for (const { module } of db.schemaManager.allModules()) {
		if (module.assertCatalogObjectPersistable) return true;
	}
	return false;
}
