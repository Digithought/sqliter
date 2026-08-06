import type * as AST from '../../parser/ast.js';

/**
 * Vocabulary shared by the three rename/strip walkers in this directory
 * (table rename, column rename, self-qualifier strip): case-insensitive name
 * comparison, schema-qualifier matching, the catalog-resolver callback type,
 * and the collection-rewrite helper their entry points are built on.
 */

export const eq = (a: string | undefined, b: string | undefined): boolean =>
	(a ?? '').toLowerCase() === (b ?? '').toLowerCase();

export const schemaMatches = (
	nodeSchema: string | undefined,
	defaultSchema: string,
): boolean => nodeSchema === undefined || eq(nodeSchema, defaultSchema);

/**
 * Returns whether the named source table has a column matching the renamed
 * column's old name. Implementation looks up the table in the catalog;
 * `schemaName` is the lowercase schema name (already resolved to the
 * default schema when the AST qualifier was undefined). Used by the scope
 * walk to decide whether an inner FROM frame captures an unqualified column
 * ref before the walk reaches an outer binding to the renamed table.
 */
export type ResolveColumnInSource = (
	schemaName: string,
	tableName: string,
	columnName: string,
) => boolean;

/**
 * Apply an in-place expression rewrite across a schema-object collection,
 * skipping items whose expression is absent. Returns whether any item changed.
 *
 * Backs the `rename{Column,Table}In{IndexPredicates,CheckConstraints,ColumnExpressions}`
 * entry points, which differ only in which field they pluck and which walker they
 * run.
 */
export function rewriteEach<T>(
	items: ReadonlyArray<T> | undefined,
	pick: (item: T) => AST.Expression | undefined,
	rewrite: (expr: AST.Expression) => boolean,
): boolean {
	let changed = false;
	for (const item of items ?? []) {
		const expr = pick(item);
		if (expr && rewrite(expr)) changed = true;
	}
	return changed;
}
