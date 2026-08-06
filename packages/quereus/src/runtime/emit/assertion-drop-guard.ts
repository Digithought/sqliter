import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { tableReferencedInAst, objectRefKey } from '../../schema/rename-rewriter.js';
import { buildObjectRefResolver } from '../../schema/object-ref-resolver.js';

/** What the guard calls the object in its error message. */
export type DroppableObjectKind = 'table' | 'view' | 'materialized view';

/**
 * Refuses to drop a table / view / materialized view that a live assertion's
 * CHECK body still names.
 *
 * Policy is **refuse**, not cascade: a cascade would silently delete a user's
 * integrity rule. This is stricter than the nearest precedents — dropping a
 * table under a plain VIEW is allowed and leaves the view broken, and the FK
 * drop guard only refuses when referencing *rows* exist — and the justification
 * is blast radius. A broken view breaks queries of that view; a broken
 * assertion breaks every write to the entire database, because
 * `AssertionEvaluator` recompiles every live assertion on any commit that
 * touched any table. Refusal never traps anyone: `drop assertion <name>` then
 * lets the drop through.
 *
 * "Refers to" is decided by {@link tableReferencedInAst}, the read-only run of
 * the very walker `ALTER TABLE … RENAME` uses to rewrite dependent bodies, so
 * the guard refuses exactly the references a rename would have followed and the
 * two definitions cannot drift. The walk is scope-aware: an assertion whose
 * body merely DECLARES a same-named CTE (`with t as (…) … from t`) or binds the
 * name as a FROM alias does not reference the real table, so it no longer
 * blocks the drop.
 *
 * Scope is the dropped object's OWN schema, matching
 * `propagateTableRenameToAssertions`: an assertion's unqualified names resolve
 * against its own home schema first (`Database._homeSchemaPath`), so an
 * unqualified `t` in an assertion living elsewhere is not necessarily this
 * table. The symmetric gap — an assertion in schema A naming `B.t` explicitly
 * is not caught — is the same one views, materialized views and assertions
 * already share on rename, tracked by `bug-schema-object-dependency-tracking`.
 *
 * Called from the three user-facing DDL emitters (`emitDropTable`,
 * `emitDropView`, `emitDropMaterializedView`) rather than from
 * `SchemaManager.dropTable`, which is also driven by internal rollback and
 * catalog-import cleanup paths that must not be vetoed.
 */
export function assertNoAssertionDependsOn(
	db: Database,
	schemaName: string,
	objectName: string,
	objectKind: DroppableObjectKind,
): void {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) return;
	// Assertions in this schema resolve their unqualified names under its home
	// path; the guard runs before any mutation, so the snapshot is the live state.
	const resolve = buildObjectRefResolver(db, schema.name);
	const targetKey = objectRefKey(schema.name, objectName);
	for (const assertion of schema.getAllAssertions()) {
		// NOTE: an assertion with no `checkExpression` has no AST to scan and is
		// skipped, exactly as the rename propagation skips it. Unreachable today —
		// `SchemaManager.importDDL` accepts only createTable / createIndex /
		// createView / createMaterializedView / alterIndex, so no assertion
		// persistence path exists and every live assertion came from
		// `CREATE ASSERTION`. If a reconstruction path is ever added, this guard
		// needs a re-parse arm or it silently stops protecting those assertions.
		const check = assertion.checkExpression;
		if (!check) continue;
		if (!tableReferencedInAst(check, objectName, resolve, targetKey)) continue;
		// `schema.name` rather than the caller's `schemaName`: DROP emitters pass the
		// name as the user typed it, so `drop table MAIN.t` would otherwise report a
		// schema spelling that appears nowhere in the catalog.
		throw new QuereusError(
			`cannot drop ${objectKind} '${schema.name}.${objectName}': assertion '${assertion.name}' still refers to it — drop or redefine the assertion first`,
			StatusCode.CONSTRAINT,
		);
	}
}
