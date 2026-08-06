import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { findTableExpressionDependent, describeDependentTable } from '../../schema/expression-dependents.js';
import { describeReachPath } from '../../schema/object-dependency-closure.js';
import type { DroppableObjectKind } from './assertion-drop-guard.js';

/**
 * Refuses to drop a table / view / materialized view that another table's stored
 * expression — a CHECK constraint, a column DEFAULT, or a `GENERATED ALWAYS AS` body —
 * can still REACH through a subquery: directly, or through any chain of view /
 * materialized-view bodies.
 *
 * The damage this prevents is the same one `assertNoCheckConstraintNamesColumn` prevents
 * for the column verb, and both verbs resolve at the same missing catalog capability:
 *
 * ```sql
 * create table t (id integer primary key, v integer);
 * create table x (id integer primary key, n integer, check (n < (select max(v) from t)));
 * drop table t;                  -- used to be accepted
 * insert into x values (1, 1);   -- Table 't' not found in schema path: main
 * ```
 *
 * `x` is now unwritable, and the error names neither the dropped table nor the constraint
 * that broke. Refusing keeps the failure attached to the statement that caused it, which
 * is what the whole expression-dependent family already does — and it keeps
 * `drop table t` and `alter table t drop column v` from disagreeing about the same CHECK.
 *
 * Policy is **refuse**, not cascade, on the same reasoning as
 * {@link assertNoAssertionDependsOn}: a cascade would silently delete a user's integrity
 * rule. This is stricter than plain VIEWs, which are deliberately left to break (a broken
 * view breaks queries OF that view; a broken CHECK makes a whole table unwritable). Views
 * are guarded on the DROPPED side rather than the referencing side for that reason: a
 * CHECK subquery may read a view, and dropping that view breaks the referencing table
 * just as thoroughly as dropping a table would, so `DROP VIEW` and
 * `DROP MATERIALIZED VIEW` call this too.
 *
 * Refusal never traps anyone: dropping (or rebuilding) the referencing constraint lets the
 * drop through. Accepted cost, exactly as for the column verb: an **unnamed** table-level
 * CHECK has no name for `DROP CONSTRAINT` to resolve, so a table it names can only be
 * dropped by rebuilding the referencing table. The message quotes such a constraint's
 * expression so the user can at least see what is in the way.
 *
 * Called from the user-facing DDL emitters only (`emitDropTable`, `emitDropView`,
 * `emitDropMaterializedView`) — never from `SchemaManager.dropTable`, which also drives
 * rollback, catalog import and the declarative differ's drop/recreate. Same wiring, and
 * same reason, as {@link assertNoAssertionDependsOn}: a differ convergence that replaces
 * both `t` and `x` must not be vetoed.
 *
 * Not gated on `IF EXISTS`: that clause governs ABSENCE, not dependency. Callers already
 * skip the guard when the object does not exist, since there is then nothing to protect.
 *
 * "Can reach" is decided by {@link findTableExpressionDependent}, which runs the same
 * breadth-first closure over stored bodies ({@link reachableObjects}) that
 * {@link assertNoAssertionDependsOn} does — so a CHECK reading `vv` where
 * `create view vv as select v from t` refuses `drop table t`, and the two guard families
 * cannot disagree about what "reaches" means. The refusal names the chain, because a user
 * told to fix a constraint whose body does not mention the dropped object has nothing to
 * act on otherwise.
 */
export function assertNoExpressionDependsOn(
	db: Database,
	schemaName: string,
	objectName: string,
	objectKind: DroppableObjectKind,
): void {
	const dependent = findTableExpressionDependent(db, schemaName, objectName);
	if (!dependent) return;
	// The catalog's spelling of the schema rather than the caller's: DROP emitters pass the
	// name as the user typed it, so `drop table MAIN.t` would otherwise report a schema
	// spelling that appears nowhere in the catalog. Same rule as `assertNoAssertionDependsOn`.
	const home = db.schemaManager.getSchema(schemaName)?.name ?? schemaName;
	const on = `on table ${describeDependentTable(dependent.table, home)}`;
	throw new QuereusError(
		`cannot drop ${objectKind} '${home}.${objectName}': ${refersTo(dependent, on)} — drop or redefine it first`,
		StatusCode.CONSTRAINT,
	);
}

/**
 * How the refusal describes the reference. A DIRECT one keeps the wording this guard has
 * always used; an indirect one leads with the expression and names the chain, mirroring
 * {@link assertNoAssertionDependsOn}'s split so all four guard families phrase an indirect
 * refusal identically.
 */
function refersTo(dependent: { describe: string; path: ReadonlyArray<string> }, on: string): string {
	return dependent.path.length === 0
		? `it is referenced by ${dependent.describe} ${on}`
		: `${dependent.describe} ${on} reaches it${describeReachPath(dependent.path)}`;
}
