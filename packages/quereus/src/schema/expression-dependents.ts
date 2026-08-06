import type * as AST from '../parser/ast.js';
import type { Database } from '../core/database.js';
import type { TableSchema, RowConstraintSchema } from './table.js';
import { expressionToString } from '../emit/ast-stringify.js';
import {
	columnReferencedInAst,
	columnReferencedInCheckExpression,
	tableReferencedInAst,
	objectRefKey,
	type ResolveObjectRef,
	type ResolveColumnInSource,
} from './rename-rewriter.js';
import { buildColumnSourceResolver } from './column-source-resolver.js';
import { snapshotObjectRefResolvers } from './object-ref-resolver.js';

/**
 * The catalog query "which stored, table-attached expressions reference this object?",
 * shared by every DROP guard that has to refuse breaking one.
 *
 * A CHECK constraint, a column DEFAULT and a `GENERATED ALWAYS AS` body may all contain
 * a subquery, so any of them can legitimately name a column or a table belonging to some
 * OTHER table, in some other schema. `ALTER TABLE … RENAME` has always known this — it
 * rewrites those expressions across every table in every schema — while the DROP guards
 * used to scan only the altered table's own constraints and columns. The gap let
 * `alter table t drop column v` and `drop table t` succeed while another table's CHECK
 * still read `t.v`, leaving that table unwritable with an error naming neither the
 * dropped object nor the constraint that broke.
 *
 * Everything here therefore walks the catalog the same way the rename propagation does —
 * ONE {@link snapshotObjectRefResolvers} snapshot, a resolver per OWNING schema, the same
 * scope-aware probes — so "the drop refuses exactly what a rename would have rewritten"
 * holds by construction rather than by comment.
 *
 * **The own-table / other-table probe split is load-bearing.** It mirrors
 * `rewriteTableForColumnRename`'s `isRenamedTable` branch:
 *
 * - On the **probed table itself**, the *seeded* probe
 *   ({@link columnReferencedInCheckExpression}) — a CHECK / DEFAULT there is written
 *   against the row being written and owns the `new.` / `old.` namespace, and an
 *   unqualified name binds the owning table implicitly.
 * - On **any other table**, the *unseeded* probe ({@link columnReferencedInAst}) — that
 *   table's row image is its own columns, not ours, so only an explicit reference
 *   through a subquery counts. Getting this backwards false-refuses on every table that
 *   merely happens to have a like-named column.
 *
 * Partial-index predicates need no arm: the parser rejects a subquery in a partial-index
 * predicate, so such a predicate can only name its own table, and `runDropColumn`'s
 * existing predicate guard covers that case.
 *
 * Views are deliberately NOT probed as *dependents*. Dropping a table or column out from
 * under a plain view stays allowed and breaks the view — the engine's stated asymmetry
 * (see `runtime/emit/assertion-drop-guard.ts`): a broken view breaks queries OF that view,
 * while a broken CHECK makes a whole table unwritable.
 *
 * Known gap, tracked by `expression-guards-follow-view-chains`: these probes see only a
 * DIRECT reference. A CHECK that reads a VIEW whose body reads the dropped object
 * (`check (n < (select max(v) from vv))` over `create view vv as select v from t`) is not
 * matched, so `drop table t` / `alter table t drop column v` is still accepted and still
 * leaves the referencing table unwritable. Closing it needs the reachability closure
 * `assertion-guards-follow-view-chains-and-schemas` builds for the assertion guards; both
 * families should then share it rather than grow a second walk.
 *
 * NOTE: each probe walks every table in every schema, re-walking already-parsed ASTs.
 * DDL is rare and schemas hold handfuls of tables, so this is not worth optimising now;
 * if it ever shows as hot, gate each table on a cheap literal name scan of its stored
 * SQL before paying for the AST walk.
 */

/** A stored, table-attached expression that references a probed object. */
export interface ExpressionDependent {
	/** The table carrying the expression. */
	table: TableSchema;
	/** True when {@link table} IS the probed table (a self-reference), false otherwise. */
	ownTable: boolean;
	/** What to call it in an error: `CHECK constraint 'ck1'`, `the DEFAULT of column 'w'`, … */
	describe: string;
}

/**
 * Which family of stored expressions a column probe walks. The two exist separately
 * because `runDropColumn` reports them through two guards with two different messages,
 * ordered by widening blast radius.
 */
export type ColumnExpressionArm =
	/** CHECK constraint expressions. */
	| 'check'
	/** Column DEFAULT and `GENERATED ALWAYS AS` expressions. */
	| 'columnExpression';

/**
 * The FIRST table in ANY schema whose `arm` expressions name
 * `<tableSchema.schemaName>.<tableSchema.name>.<columnName>`, or `undefined` when none
 * does. The probed table itself is scanned first, so a self-reference is always the one
 * reported and the guards' own-table messages never change spelling because an unrelated
 * schema happens to sort earlier.
 *
 * Only the first hit is returned: every caller is a guard that throws on it, and stopping
 * early keeps the walk off the remaining schemas.
 *
 * Two expressions are skipped on the probed table itself, both deliberately:
 *
 * - The dropped column's **own** DEFAULT / generated body — it goes away with the column,
 *   so a self-naming default (`a integer default (new.a)`) is not something the drop
 *   orphans.
 * - **Every** own-table generated body — `runDropColumn` already refuses off
 *   `generatedColumnDependencies`, the resolved column-index map
 *   `extractGeneratedColumnDependencies` builds, and reporting it twice would only change
 *   which of two messages the user sees. A generated body on ANOTHER table is not covered
 *   by that map and IS reported here.
 */
export function findColumnExpressionDependent(
	db: Database,
	tableSchema: TableSchema,
	columnName: string,
	arm: ColumnExpressionArm,
): ExpressionDependent | undefined {
	const resolvers = snapshotObjectRefResolvers(db);
	const resolveColumnInSource = buildColumnSourceResolver(db.schemaManager);
	const targetKey = objectRefKey(tableSchema.schemaName, tableSchema.name);

	for (const table of tablesProbedTargetFirst(db, targetKey)) {
		const ownTable = objectRefKey(table.schemaName, table.name) === targetKey;
		const names = columnProbe(
			ownTable, tableSchema.name, columnName,
			resolvers.forHomeSchema(table.schemaName), targetKey, resolveColumnInSource);
		const found = arm === 'check'
			? findInChecks(table, names)
			: findInColumnExpressions(table, ownTable, columnName, names);
		if (found) return { table, ownTable, describe: found };
	}
	return undefined;
}

/**
 * The FIRST table in ANY schema whose CHECK / DEFAULT / `GENERATED ALWAYS AS` expressions
 * name `<schemaName>.<objectName>`, or `undefined` when none does.
 *
 * The dropped object itself is skipped: its own CHECKs naming itself vanish with it, so
 * refusing on them would make every self-referencing table undroppable. (The column verb
 * keeps its target in the walk — a column drop leaves the rest of the table behind.)
 *
 * All three arms run with the walker's `rowImageContext`, exactly as
 * `renameTableInCheckConstraints` / `renameTableInColumnExpressions` do: these
 * expressions evaluate against a written row, so a bare `new.` / `old.` qualifier names
 * that row image rather than a table literally called `new`.
 */
export function findTableExpressionDependent(
	db: Database,
	schemaName: string,
	objectName: string,
): ExpressionDependent | undefined {
	const resolvers = snapshotObjectRefResolvers(db);
	const targetKey = objectRefKey(schemaName, objectName);

	for (const table of tablesProbedTargetFirst(db, targetKey)) {
		if (objectRefKey(table.schemaName, table.name) === targetKey) continue;
		const resolve = resolvers.forHomeSchema(table.schemaName);
		const names = (expr: AST.Expression | undefined): boolean =>
			tableReferencedInAst(expr, objectName, resolve, targetKey, { rowImageContext: true });
		const found = findInChecks(table, names) ?? findInColumnExpressions(table, false, undefined, names);
		if (found) return { table, ownTable: false, describe: found };
	}
	return undefined;
}

/**
 * How an error should spell `table` when the object being dropped lives in `homeSchemaName`:
 * bare when the two share a schema, schema-qualified when they do not — the same rule the
 * rest of the engine's messages follow, and the only way a cross-schema refusal names a
 * table the user can actually find.
 */
export function describeDependentTable(table: TableSchema, homeSchemaName: string): string {
	return table.schemaName.toLowerCase() === homeSchemaName.toLowerCase()
		? `'${table.name}'`
		: `'${table.schemaName}.${table.name}'`;
}

/** Whether one stored expression names the probed object. */
type ExpressionProbe = (expr: AST.Expression | undefined) => boolean;

/**
 * Every table in every schema, with the probed table (if it exists) first.
 *
 * Order is not cosmetic: the guards report the FIRST hit, and the own-table messages are
 * the ones users and tests already know. Scanning the target first keeps a self-reference
 * winning over an unrelated schema's.
 *
 * NOTE: past the probed table the order is `_getAllSchemas()` × `getAllTables()` insertion
 * order, so with TWO referencing tables which one the refusal names follows catalog
 * insertion rather than any user-visible rule. Harmless while the message is advisory —
 * every referencing table has to be dealt with anyway. If a caller ever needs to *list*
 * dependents (a `CASCADE` arm, an introspection function), give it a collect-all entry
 * point with a defined order rather than calling this in a loop.
 */
function* tablesProbedTargetFirst(db: Database, targetKey: string): Iterable<TableSchema> {
	const rest: TableSchema[] = [];
	for (const schema of db.schemaManager._getAllSchemas()) {
		for (const table of schema.getAllTables()) {
			if (objectRefKey(table.schemaName, table.name) === targetKey) yield table;
			else rest.push(table);
		}
	}
	yield* rest;
}

/**
 * The column probe for one scanned table — seeded on the probed table itself, unseeded
 * everywhere else. See this module's header for why that split is load-bearing.
 */
function columnProbe(
	ownTable: boolean,
	probedTableName: string,
	columnName: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): ExpressionProbe {
	return expr => ownTable
		? columnReferencedInCheckExpression(
			expr, probedTableName, columnName, resolve, targetKey, resolveColumnInSource)
		: columnReferencedInAst(
			expr, probedTableName, columnName, resolve, targetKey, resolveColumnInSource);
}

/** The first CHECK constraint of `table` the probe matches, described for an error. */
function findInChecks(table: TableSchema, names: ExpressionProbe): string | undefined {
	for (const check of table.checkConstraints ?? []) {
		if (names(check.expr)) return describeCheck(check);
	}
	return undefined;
}

/**
 * The first column DEFAULT / generated body of `table` the probe matches, described for
 * an error. `skipColumnName` is the column being dropped, skipped only on the probed
 * table itself; own-table generated bodies are skipped outright (see
 * {@link findColumnExpressionDependent}).
 */
function findInColumnExpressions(
	table: TableSchema,
	ownTable: boolean,
	skipColumnName: string | undefined,
	names: ExpressionProbe,
): string | undefined {
	const lowerSkip = ownTable ? skipColumnName?.toLowerCase() : undefined;
	for (const col of table.columns) {
		if (lowerSkip !== undefined && col.name.toLowerCase() === lowerSkip) continue;
		if (names(col.defaultValue ?? undefined)) return `the DEFAULT of column '${col.name}'`;
		if (ownTable) continue;
		if (names(col.generatedExpr)) return `the GENERATED expression of column '${col.name}'`;
	}
	return undefined;
}

/**
 * A table-level unnamed CHECK genuinely carries `name: undefined` — the `_check_<table>`
 * spelling `manager.ts` produces is error text, not stored identity — so there is no name
 * to quote and the expression stands in for one. That is also the only handle the user
 * has on it: `DROP CONSTRAINT` resolves by name only, so an unnamed CHECK can only be
 * removed by rebuilding its table.
 */
function describeCheck(check: RowConstraintSchema): string {
	return check.name
		? `CHECK constraint '${check.name}'`
		: `the CHECK constraint (${expressionToString(check.expr)})`;
}
