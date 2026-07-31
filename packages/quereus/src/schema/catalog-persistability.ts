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
 * A rewrite of a dependent TABLE's schema, returning a NEW record when anything changed
 * and the SAME reference when nothing did — the shape `rewriteTableForTableRename` /
 * `rewriteTableForColumnRename` (both in `runtime/emit/alter-table.ts`) already have.
 */
export type TableRewrite = (table: TableSchema) => TableSchema;

/**
 * Pre-flight gate for `ALTER TABLE … RENAME [COLUMN]`: computes what the rename would
 * make of every dependent catalog entry — view / materialized-view bodies via `rewrite`,
 * plain table records via `rewriteTable` — and vetoes each PROSPECTIVE object through
 * {@link assertCatalogObjectPersistable}, so a rename that would leave a persisted
 * dependent unwritable fails the statement instead of succeeding and losing (or silently
 * diverging from) it.
 *
 * The rename propagation is unfailable by construction — it rides
 * `SchemaChangeNotifier` (try/catch per listener, log only) and then a store module's
 * async persist queue (`.catch`-log) — so, exactly as for CREATE VIEW, a synchronous
 * veto ahead of the first side effect is the only place a refusal can reach the user.
 *
 * Both rewrites mutate ASTs in place, so both arms probe a {@link spineCloneAst} copy: a
 * veto thrown after mutating the LIVE AST would leave a body (or a CHECK expression)
 * naming a table that was never renamed. Every DDL generator reads the AST rather than a
 * cached string, so swapping the clone into a shallow copy of the record is all a
 * prospective render needs. Dependents the rewrite does not touch render identically to
 * what is already persisted and are skipped.
 */
// NOTE: clones and re-renders the body of every view and maintained table in the schema,
// and the rewritable ASTs of every table in EVERY schema, on every `ALTER … RENAME` — and
// the propagation that follows renders each changed one again. DDL is rare and the ASTs
// are small, so this is not worth caching today; if a schema-heavy workload ever shows up
// hot here, gate the clone on a cheap dry-run name scan (or thread the prospective object
// through to the propagation instead of rebuilding it). Costs nothing at all when no
// module can veto (the early return below) — a memory-only database never pays it.
export function assertRenameDependentsPersistable(
	db: Database,
	schema: Schema,
	rewrite: BodyRewrite,
	rewriteTable: TableRewrite,
): void {
	if (!anyModuleCanVeto(db)) return;
	assertRenameDependentViewsPersistable(db, schema, rewrite);
	assertRenameDependentTablesPersistable(db, rewriteTable);
}

/**
 * The view / materialized-view arm of {@link assertRenameDependentsPersistable}.
 *
 * Scoped to a single `Schema` because that is the scope the propagation's own view / MV
 * loops use (see `propagateTableRenameInSchema`) — a dependent in another schema is
 * never rewritten, so it has nothing new to persist.
 */
function assertRenameDependentViewsPersistable(db: Database, schema: Schema, rewrite: BodyRewrite): void {
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

/**
 * The dependent-TABLE arm of {@link assertRenameDependentsPersistable}: a rename rewrites
 * the FK targets, CHECK expressions and partial-index predicates of tables that mention the
 * renamed object, and a store-backed one of those has to re-persist its catalog entry.
 *
 * Walks EVERY schema, not just the renamed object's own, because the propagation's table
 * loop does (`propagateTableRename` iterates `_getAllSchemas()`) — a cross-schema foreign
 * key is rewritten and so must be vetted. That is the one structural difference from the
 * view / MV arm above.
 *
 * The renamed table itself is deliberately left in the scan rather than special-cased. It
 * is probed under its OLD name with any self-references rewritten to the NEW one (table
 * arm) or with its CHECK expressions rewritten (column arm) — either way the probe only
 * ever fires on text carrying the new name, so a veto there is always true; and a table
 * with nothing to rewrite rewrites to the same reference and is skipped. Its own catalog
 * entry stays covered by the module's `renameTable` / `alterTable` guards, as before.
 */
function assertRenameDependentTablesPersistable(db: Database, rewriteTable: TableRewrite): void {
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const table of Array.from(schema.getAllTables())) {
			const probe = cloneTableRewritableAsts(table);
			const rewritten = rewriteTable(probe);
			if (rewritten === probe) continue; // nothing to re-persist
			assertCatalogObjectPersistable(db, 'table', rewritten);
		}
	}
}

/**
 * A shallow copy of `table` whose in-place-rewritable ASTs are {@link spineCloneAst}
 * copies, so a prospective rewrite cannot touch the live catalog. `foreignKeys` needs no
 * clone — that arm of both table rewriters is already copy-on-write (it builds a new `fk`
 * record rather than assigning into the existing one).
 */
function cloneTableRewritableAsts(table: TableSchema): TableSchema {
	return {
		...table,
		checkConstraints: table.checkConstraints.map(cc => ({ ...cc, expr: spineCloneAst(cc.expr) })),
		indexes: table.indexes?.map(idx =>
			idx.predicate ? { ...idx, predicate: spineCloneAst(idx.predicate) } : idx),
	};
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
