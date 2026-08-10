import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { objectRefKey } from '../../schema/rename-rewriter.js';
import { assertionReachesHomeSchemaFirst, describeOwnedAssertion } from '../../schema/assertion.js';
import { describeReachPath } from '../../schema/object-dependency-closure.js';

/** What the guard calls the object in its error message. */
export type DroppableObjectKind = 'table' | 'view' | 'materialized view';

/**
 * Refuses to drop a table / view / materialized view that a live assertion's
 * CHECK body can still REACH.
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
 * "Can reach" is decided by {@link reachableObjects}, the breadth-first closure
 * over stored view / materialized-view bodies built on the very walker
 * `ALTER TABLE … RENAME` uses to rewrite dependent bodies. Two consequences,
 * both load-bearing:
 *
 * - A DIRECT reference is refused exactly where a rename would have rewritten
 *   it, so the two definitions cannot drift. The walk is scope-aware: an
 *   assertion whose body merely DECLARES a same-named CTE (`with t as (…) …
 *   from t`) or binds the name as a FROM alias does not reference the real
 *   table and does not block the drop.
 * - An INDIRECT reference — the assertion names a view, whose body names the
 *   dropped object, to any depth — is refused too. Without that, `create view v
 *   as select * from t` plus an assertion over `v` let `drop table t` through
 *   and made every write to the database fail with an error naming neither the
 *   assertion nor the view.
 *
 * Scope is EVERY schema, not the dropped object's own: an assertion in `temp`
 * naming `main.t` explicitly is caught, and so is one whose unqualified `t`
 * resolves down its home path to `main.t`. Each body still resolves its
 * unqualified names under ITS OWN home schema path
 * (`Database._homeSchemaPath`), so an assertion in `temp` whose bare `t` means
 * `temp.t` does not block dropping `main.t`.
 *
 * Called from the three user-facing DDL emitters (`emitDropTable`,
 * `emitDropView`, `emitDropMaterializedView`) rather than from
 * `SchemaManager.dropTable`, which is also driven by internal rollback and
 * catalog-import cleanup paths that must not be vetoed.
 *
 * The scan itself — one snapshot, home schema first, bodiless assertions
 * skipped, one walk per assertion — is
 * {@link assertionReachesHomeSchemaFirst}, shared with the DROP COLUMN verb.
 */
export function assertNoAssertionDependsOn(
	db: Database,
	schemaName: string,
	objectName: string,
	objectKind: DroppableObjectKind,
): void {
	const schema = db.schemaManager.getSchema(schemaName);
	if (!schema) return;
	const targetKey = objectRefKey(schema.name, objectName);

	for (const { owned, reach } of assertionReachesHomeSchemaFirst(db, schema.name)) {
		const namer = reach.namerOf(targetKey);
		if (!namer) continue;
		// `schema.name` rather than the caller's `schemaName`: DROP emitters pass the
		// name as the user typed it, so `drop table MAIN.t` would otherwise report a
		// schema spelling that appears nowhere in the catalog.
		throw new QuereusError(
			`cannot drop ${objectKind} '${schema.name}.${objectName}': assertion `
			+ `${describeOwnedAssertion(owned, schema.name)} ${refersTo(namer.path)}`
			+ ` — drop or redefine the assertion first`,
			StatusCode.CONSTRAINT,
		);
	}
}

/**
 * How the refusal describes the reference. A DIRECT one keeps the wording this
 * guard has always used; an indirect one must name the chain, because a user
 * told to fix an assertion whose body does not mention the dropped object has
 * nothing to act on.
 */
function refersTo(path: ReadonlyArray<string>): string {
	return path.length === 0 ? 'still refers to it' : `reaches it${describeReachPath(path)}`;
}
