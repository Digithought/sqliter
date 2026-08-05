import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { columnReferencedInAst, columnReferencedInCheckExpression } from '../../schema/rename-rewriter.js';
import { buildColumnSourceResolver } from '../../schema/column-source-resolver.js';

/**
 * The `ALTER TABLE … DROP COLUMN` guards over dependents that `runDropColumn` does not
 * otherwise see: the DEFAULT of another column on the table itself, a CHECK constraint on
 * the table itself, an assertion whose CHECK body names the column, and a foreign key in
 * *another* table pointing **at** the column.
 *
 * Whether a dependent is removed with the column or blocks the drop turns on two
 * questions: is it defined by a *column set* or by an *expression*, and does it live on
 * the altered table or somewhere else?
 *
 * - **Structural** dependents **of the altered table** (a UNIQUE over the dropped column,
 *   the table's own FK using it as a child column) are defined by a *column set*. Losing
 *   a column makes them a different constraint, not a narrower one, so both vtab modules
 *   **remove them with the column**.
 * - **Expression** dependents (a generated column's expression, a partial index's
 *   `WHERE`, and — here — a column DEFAULT, a CHECK expression and an assertion body) are
 *   arbitrary user-authored logic with no narrowed form at all. The only choices are
 *   delete-it-silently and refuse, and the engine **refuses**, `StatusCode.CONSTRAINT`.
 * - **Dependents living in another table** — here, a foreign key whose *parent* column is
 *   the one being dropped — refuse regardless of shape. Removing one would silently
 *   weaken a constraint on a table the user did not name in the statement.
 *
 * Refuse is right for all four guards here because it is what the two expression guards
 * already inside `runDropColumn` do (so the function gains no second policy), it is
 * SQLite's position for the whole family, and — for the assertion arm —
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
 * All four guards must run **before** `requireVtabModule` / `module.alterTable`, so a
 * refused statement never reaches a persisting module and the table is left untouched
 * rather than reverted.
 */

/**
 * Refuses the drop when the DEFAULT of some OTHER column on `tableSchema` names the column.
 *
 * A default is evaluated against the row being written, so it names its siblings through
 * the row-image qualifier — `b integer default (new.a + 1)`. Dropping `a` leaves that
 * default uncompilable and the table unable to accept any new row at all, with an error
 * naming a column the user deliberately removed. Refusing keeps the failure attached to
 * the statement that caused it.
 *
 * Decided by {@link columnReferencedInCheckExpression}, the same seeded probe the CHECK
 * guard below uses, and for the same two reasons: the seed owns the `new.` / `old.`
 * row-image namespace a default is written in, and it is scope-**aware**, so a default
 * whose subquery reads a like-named column on another table
 * (`default ((select min(v) from u))`) does not false-refuse dropping this table's own `v`.
 * Sharing the probe with the rename walk is what makes "the drop refuses exactly the
 * references a rename would have rewritten" true — the same equivalence the CHECK guard
 * rests on, case folding (`NEW.A`) and the `"new"`-named-table shadowing edge included.
 *
 * The dropped column's **own** default is skipped: it goes away with the column, so a
 * self-naming default (`a integer default (new.a)`) is not something the drop orphans.
 *
 * The generated-column half of this pair is NOT here — `runDropColumn` already refuses off
 * `generatedColumnDependencies`, the resolved column-index map `extractGeneratedColumnDependencies`
 * builds. Two mechanisms for one policy, but the existing one predates this guard and its map
 * is load-bearing elsewhere (evaluation order), so it stays where it is.
 */
export function assertNoColumnDefaultNamesColumn(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
): void {
	const lowerColumn = columnName.toLowerCase();
	const resolveColumnInSource = buildColumnSourceResolver(db.schemaManager);
	for (const col of tableSchema.columns) {
		if (col.name.toLowerCase() === lowerColumn) continue;
		if (!col.defaultValue) continue;
		if (!columnReferencedInCheckExpression(
			col.defaultValue, tableSchema.name, columnName, tableSchema.schemaName, resolveColumnInSource)) continue;
		throw new QuereusError(
			`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by the DEFAULT of column '${col.name}'`,
			StatusCode.CONSTRAINT,
		);
	}
}

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
 *
 * A CHECK naming the column through the row-image qualifiers — `check (new.a > 0)`,
 * `check on delete (old.a > 0)` — refuses the drop just like the unqualified spelling:
 * the same walk owns that namespace, shadowing edge included, so a CHECK whose subquery
 * reads a real table named `"new"` still does not block dropping this table's own
 * like-named column.
 */
export function assertNoCheckConstraintNamesColumn(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
): void {
	const resolveColumnInSource = buildColumnSourceResolver(db.schemaManager);
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
	const resolveColumnInSource = buildColumnSourceResolver(db.schemaManager);
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

/**
 * Refuses the drop when some foreign key — in any schema, this table's own included —
 * names the column among its **parent** columns.
 *
 * A foreign key stores its parent columns as *names* (`referencedColumnNames`) and
 * re-resolves them against the parent's current shape on every write
 * (`resolveReferencedColumns`, `schema/table.ts`). Dropping a named parent column therefore does not
 * break the altered table at all — it makes the *referencing* table unwritable, with an
 * error naming a column the user deliberately removed somewhere else. Refusing is the
 * only way that failure stays attached to the statement that caused it.
 *
 * The refusal is **not** gated on `pragma foreign_keys`. The pragma decides whether the
 * DML builders emit FK checks, so with it off the breakage is merely latent: the schema
 * is still wrong and turning the pragma on later bricks the child table. The guards
 * already in `runDropColumn` are likewise unconditional.
 *
 * Discovery goes through {@link SchemaManager.getReferencingForeignKeys} — the cached
 * reverse index keyed by referenced `schema.table` that `DROP TABLE`'s parent-side guard
 * already uses — rather than a fresh walk of every foreign key in every schema. Its key
 * is `fk.referencedSchema ?? childTable.schemaName`, and `referencedSchema` is populated
 * at build time from the declaration (`constraint-builder.ts`: `fk.schema ?? childSchemaName`),
 * so the bucket a key lands in is the same parent
 * `planner/building/foreign-key-builder.ts` resolves at enforcement time. That identity is
 * what makes "the guard refuses exactly the drops enforcement would have choked on" true.
 * An unqualified reference binds to the **child's own schema**, not through the session
 * search path — a cross-schema key must qualify its parent (`references main.p(c)`) or it
 * resolves to no parent at all.
 *
 * Two keys are skipped, both deliberately:
 *
 * - One with **no `referencedColumnNames`** (`references Parent` with no column list)
 *   falls back to the parent's primary key, which no name resolution can miss and which
 *   `runDropColumn` already refuses to drop. Not an oversight — there is no name here for
 *   this drop to invalidate.
 * - A **self-referencing key that this same drop removes** — one on the altered table whose
 *   *child* columns include the dropped column (`x integer references t(x)`). The module
 *   removes the whole key as part of the drop, so nothing is left pointing at the missing
 *   name. Refusing there would turn away a legal drop.
 */
export function assertNoForeignKeyReferencesColumn(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
): void {
	const lowerColumn = columnName.toLowerCase();
	const droppedIndex = tableSchema.columnIndexMap.get(lowerColumn);

	for (const { childTable, fk } of db.schemaManager.getReferencingForeignKeys(tableSchema.schemaName, tableSchema.name)) {
		if (!namesParentColumn(fk, lowerColumn)) continue;
		if (dropRemovesKeyOutright(tableSchema, childTable, fk, droppedIndex)) continue;

		const fkName = fk.name ?? `_fk_${childTable.name}`;
		throw new QuereusError(
			`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by foreign key '${fkName}' on table '${childTable.name}'`,
			StatusCode.CONSTRAINT,
		);
	}
}

/**
 * Whether `fk` lists `lowerColumn` (already lowercased) among its declared parent columns.
 * A key with no declared list targets the parent's primary key and matches nothing here —
 * see the second skip in {@link assertNoForeignKeyReferencesColumn}'s doc comment.
 */
function namesParentColumn(fk: ForeignKeyConstraintSchema, lowerColumn: string): boolean {
	const refNames = fk.referencedColumnNames;
	if (!refNames || refNames.length === 0) return false;
	return refNames.some(name => name.toLowerCase() === lowerColumn);
}

/**
 * Whether this drop takes the whole key with it: a **self**-referencing key, on the table
 * being altered, holding the dropped column among its *child* columns. The module removes
 * such a key as part of the drop, so no reference to the missing name survives it.
 */
function dropRemovesKeyOutright(
	tableSchema: TableSchema,
	childTable: TableSchema,
	fk: ForeignKeyConstraintSchema,
	droppedIndex: number | undefined,
): boolean {
	if (droppedIndex === undefined) return false;
	if (childTable.name.toLowerCase() !== tableSchema.name.toLowerCase()) return false;
	if (childTable.schemaName.toLowerCase() !== tableSchema.schemaName.toLowerCase()) return false;
	return fk.columns.includes(droppedIndex);
}
