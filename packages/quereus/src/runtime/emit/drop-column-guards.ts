import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { TableSchema } from '../../schema/table.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { columnReferencedInAst, columnReferencedInCheckExpression } from '../../schema/rename-rewriter.js';
import { buildColumnSourceResolver } from './column-source-resolver.js';

/**
 * The two `ALTER TABLE … DROP COLUMN` guards over **expression** dependents that
 * `runDropColumn` does not otherwise see: a CHECK constraint on the table itself,
 * and an assertion whose CHECK body names the column.
 *
 * DROP COLUMN's dependents split in two, and the split is what decides the policy:
 *
 * - **Structural** dependents (a UNIQUE over the dropped column, the table's own FK
 *   using it as a child column) are defined by a *column set*. Losing a column makes
 *   them a different constraint, not a narrower one, so both vtab modules **remove
 *   them with the column**.
 * - **Expression** dependents (a generated column's expression, a partial index's
 *   `WHERE`, and — here — a CHECK expression and an assertion body) are arbitrary
 *   user-authored logic with no narrowed form at all. The only choices are
 *   delete-it-silently and refuse, and the engine **refuses**, `StatusCode.CONSTRAINT`.
 *
 * Refuse is right for these two specifically because it is what the two expression
 * guards already inside `runDropColumn` do (so the function gains no second policy),
 * it is SQLite's position for the whole family, and — for the assertion arm —
 * `assertNoAssertionDependsOn` already chose refuse for the *table* verb over the same
 * assertion. Cascading here would make `drop table f` and `alter table f drop column x`
 * disagree about the same object.
 *
 * Known cost, accepted: an **unnamed** table-level CHECK cannot be dropped
 * (`DROP CONSTRAINT` resolves by name only), so refusing leaves such a column
 * undroppable short of rebuilding the table — again SQLite's position. The refusal
 * message quotes the constraint's expression so the user can at least see what is in
 * the way.
 *
 * Both guards must run **before** `requireVtabModule` / `module.alterTable`, so a
 * refused statement never reaches a persisting module and the table is left untouched
 * rather than reverted.
 */

/**
 * Refuses the drop when one of `tableSchema`'s own CHECK constraints names the column.
 *
 * "Names" is decided by {@link columnReferencedInCheckExpression} — a real rename to a
 * sentinel over a throwaway clone of the body — so the guard refuses exactly the
 * references `ALTER TABLE … RENAME COLUMN` would have rewritten, and the two
 * definitions cannot drift. That scope-awareness is load-bearing rather than
 * decorative: a CHECK may contain a subquery, so a depth-blind name match (what the
 * partial-index guard next door can afford, its predicates admitting no subqueries)
 * would false-refuse `check ((select min(v) from u) >= 0)` when dropping this table's
 * own `v`.
 *
 * Only the constraints on `tableSchema.checkConstraints` at drop time are probed —
 * the user's declared set. Lens- and FK-synthesized entries are attached to a write
 * plan's constraint list, not to the catalog entry this reads.
 */
export function assertNoCheckConstraintNamesColumn(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
): void {
	const resolveColumnInSource = buildColumnSourceResolver(db);
	for (const check of tableSchema.checkConstraints ?? []) {
		if (!columnReferencedInCheckExpression(
			check.expr, tableSchema.name, columnName, tableSchema.schemaName, resolveColumnInSource)) continue;
		// A table-level unnamed CHECK genuinely carries `name: undefined` — the
		// `_check_<table>` spelling `manager.ts` produces is error text, not stored
		// identity — so there is no name to quote and the expression stands in for one.
		const referencedBy = check.name
			? `CHECK constraint '${check.name}'`
			: `the CHECK constraint (${expressionToString(check.expr)})`;
		throw new QuereusError(
			`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by ${referencedBy}`,
			StatusCode.CONSTRAINT,
		);
	}
}

/**
 * Refuses the drop when a live assertion's CHECK body names the column.
 *
 * Blast radius is why this one is worth a guard at all: `AssertionEvaluator`
 * recompiles **every** live assertion on any commit that touched any table, so a
 * single body left naming a dropped column makes every write to the whole database
 * fail — including writes to tables that have nothing to do with the altered one.
 *
 * The walk is the unseeded {@link columnReferencedInAst}: an assertion body names its
 * tables explicitly in its own FROM clauses, so there is no implicit binding to seed
 * (unlike a CHECK). A body that names the table but not the column — `select *`
 * included — is not a reference and does not block the drop.
 *
 * Scope is the altered table's OWN schema, matching `assertNoAssertionDependsOn` and
 * `propagateColumnRenameToAssertions`, and carrying the same documented gap: an
 * assertion living in schema A that names `B.t` explicitly is not caught. Tracked by
 * `bug-rename-not-propagated-across-schemas`.
 */
export function assertNoAssertionNamesColumn(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
): void {
	const schema = db.schemaManager.getSchema(tableSchema.schemaName);
	if (!schema) return;
	const resolveColumnInSource = buildColumnSourceResolver(db);
	for (const assertion of schema.getAllAssertions()) {
		// An assertion with no `checkExpression` has no AST to scan and is skipped,
		// exactly as the rename propagation and `assertNoAssertionDependsOn` skip it.
		const check = assertion.checkExpression;
		if (!check) continue;
		if (!columnReferencedInAst(
			check, tableSchema.name, columnName, tableSchema.schemaName, resolveColumnInSource)) continue;
		throw new QuereusError(
			`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by assertion '${assertion.name}' — drop or redefine the assertion first`,
			StatusCode.CONSTRAINT,
		);
	}
}
