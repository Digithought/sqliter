import type { Database } from '../core/database.js';
import { bodyPublishesColumnNamed, objectRefKey } from './rename-rewriter.js';
import type { ResolveColumnInSource, ResolveObjectRef } from './rename-rewriter.js';

/**
 * The catalog-backed {@link ResolveColumnInSource} every scope-aware walk over a
 * schema-object expression consults to tell an unqualified reference that binds to an
 * inner FROM source from one that binds to the table under consideration.
 *
 * One definition for every such walk, so no two of them can disagree about what a
 * name resolves to: `runRenameColumn`'s pre-flight probe and its real propagation,
 * the DROP COLUMN guards (`runtime/emit/drop-column-guards.ts` and
 * `schema/expression-dependents.ts`), the constraint planner's self-qualifier strip
 * (`planner/building/constraint-builder.ts`), the generated-column reference
 * analysis at CREATE TABLE (`schema/manager.ts`) and at ALTER TABLE
 * (`planner/building/alter-table.ts`, `runtime/emit/alter-table.ts`), and the
 * modules' own ALTER re-analysis hooks (`vtab/memory/layer/manager.ts`,
 * `@quereus/store`'s `store-module-alter.ts`).
 *
 * A source may be a TABLE (a maintained table included — its backing columns are
 * real) or a VIEW. A view exposes a column when its explicit column list names it,
 * or — with no list — when its body publishes it ({@link bodyPublishesColumnNamed}:
 * a result-column alias, a bare projection, or a `*` / `t.*` / `a.*` over a source
 * that exposes it — a FROM alias only changes which qualifier names the source, so
 * `select * from t a` publishes exactly what `select * from t` does). The view arm
 * recurses through this same resolver, so a view over a
 * view answers too; views cannot be recursive, so the per-question in-flight set is
 * insurance against a malformed catalog, the same role the visited set plays in
 * `reachableObjects`.
 *
 * Resolves against the LIVE catalog on every call, so sharing one instance across
 * passes does not by itself freeze the answer between them — see the rename
 * pre-flight's comment for why its two passes agree anyway. The view arm's
 * unqualified names likewise resolve LIVE down the view's home schema path
 * ({@link Database._homeSchemaPath}), matching how the view body plans.
 *
 * NOTE: deliberately NO cross-call memo. The rename propagation shares one
 * instance across its pre-flight and its live cascade rounds, and the rounds
 * rewrite view bodies in place — a memoized "does view X expose col?" answer taken
 * before a round would be stale after it. The per-question in-flight set bounds the
 * recursion instead. The one hot-ish caller is `constraint-builder.ts` at
 * plan-build time, where the view arm only runs for a CHECK whose subquery FROMs a
 * view; if that ever profiles hot, add a cross-call memo guarded by a catalog
 * generation counter.
 */
export function buildColumnSourceResolver(db: Database): ResolveColumnInSource {
	const answer = (schemaName: string, sourceName: string, columnName: string, inFlight: Set<string>): boolean => {
		const targetSchema = db.schemaManager.getSchema(schemaName);
		if (!targetSchema) return false;
		const colLower = columnName.toLowerCase();

		const table = targetSchema.getTable(sourceName);
		if (table) return table.columnIndexMap.has(colLower);

		const view = targetSchema.getView(sourceName);
		if (!view) return false;
		if (view.columns && view.columns.length > 0) {
			return view.columns.some(c => c.toLowerCase() === colLower);
		}
		const key = `${objectRefKey(targetSchema.name, view.name)}:${colLower}`;
		if (inFlight.has(key)) return false;
		inFlight.add(key);
		try {
			const recurse: ResolveColumnInSource = (s, t, c) => answer(s, t, c, inFlight);
			return bodyPublishesColumnNamed(view.selectAst, columnName, liveHomePathResolver(db, view.schemaName), recurse);
		} finally {
			inFlight.delete(key);
		}
	};
	return (schemaName, sourceName, columnName) => answer(schemaName, sourceName, columnName, new Set());
}

/**
 * Live {@link ResolveObjectRef} for one home schema — the same resolution rule
 * `snapshotObjectRefResolvers` snapshots (qualified passthrough; unqualified →
 * first home-path schema holding a table or view of the name; miss → home key),
 * answered against the live catalog. Live is right here: this resolver's contract
 * is live answers, and the rename cascade's mid-statement body rewrites change
 * published COLUMNS, never the object names this resolves.
 */
function liveHomePathResolver(db: Database, homeSchemaName: string): ResolveObjectRef {
	return (schema, name) => {
		if (schema !== undefined) return objectRefKey(schema, name);
		for (const pathSchemaName of db._homeSchemaPath(homeSchemaName)) {
			const pathSchema = db.schemaManager.getSchema(pathSchemaName);
			if (!pathSchema) continue;
			if (pathSchema.getTable(name) !== undefined || pathSchema.getView(name) !== undefined) {
				return objectRefKey(pathSchemaName, name);
			}
		}
		return objectRefKey(homeSchemaName, name);
	};
}
