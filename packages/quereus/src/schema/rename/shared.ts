import type * as AST from '../../parser/ast.js';

/**
 * Vocabulary shared by the three rename/strip walkers in this directory
 * (table rename, column rename, self-qualifier strip): case-insensitive name
 * comparison, planner-parity object-reference resolution (the
 * {@link ResolveObjectRef} callback and its canonical key), the
 * column-resolver callback type, and the collection-rewrite helper their
 * entry points are built on.
 */

export const eq = (a: string | undefined, b: string | undefined): boolean =>
	(a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * Resolves a table / view / materialized-view reference as written in a stored
 * body to its canonical `<schema>.<name>` key (both lowercase) — the same
 * answer the planner would give for that body, i.e. against the owning
 * object's home schema path, NOT against whatever single "default schema" a
 * caller happens to hold. `undefined` only when the resolver cannot be
 * consulted at all; a name that resolves nowhere still yields a stable key
 * (the home schema's) so probe and rewrite stay total.
 *
 * The catalog-backed builder lives in `schema/object-ref-resolver.ts`
 * (`buildObjectRefResolver` / `snapshotObjectRefResolvers`), next to
 * `buildColumnSourceResolver` and for the same reason: the walkers here stay
 * free of catalog imports. {@link singleSchemaObjectRefResolver} below covers
 * the contexts that have no catalog (the schema differ's declared world).
 */
export type ResolveObjectRef = (schema: string | undefined, name: string) => string | undefined;

/** The canonical object key {@link ResolveObjectRef} deals in: `<schema>.<name>`, both lowercase. */
export const objectRefKey = (schemaName: string, objectName: string): string =>
	`${schemaName.toLowerCase()}.${objectName.toLowerCase()}`;

/**
 * The `<schema>` half of a key {@link objectRefKey} built, given the object name
 * it was built from (already lowercase). Split by the KNOWN name's length rather
 * than by a separator scan, because a schema name may itself contain a dot. Kept
 * here next to `objectRefKey` so the key format is known in exactly one file.
 */
export const objectRefKeySchema = (key: string, objectNameLower: string): string =>
	key.slice(0, key.length - objectNameLower.length - 1);

/**
 * {@link ResolveObjectRef} for a world where every unqualified name belongs to
 * exactly one schema: the schema differ's declared catalog (single-schema by
 * construction) and any other context with no live catalog to consult. A
 * qualified name means what it says; an unqualified one keys under
 * `schemaName`. This intentionally reproduces what the old
 * `schemaMatches(nodeSchema, defaultSchema)` equality decided, so the differ's
 * inverse reconcile keeps parity with the store-module forward rewrites (whose
 * catalog-backed resolver gives the same answers for a single-schema catalog).
 */
export function singleSchemaObjectRefResolver(schemaName: string): ResolveObjectRef {
	return (schema, name) => objectRefKey(schema ?? schemaName, name);
}

/**
 * The object being renamed, as one required argument to the table-rename
 * rewrite entry points — bundled rather than positional so no caller can
 * supply the match-time resolution without also answering how the reference
 * will resolve AFTER the rename lands. That second answer is what enforces the
 * rewrite's post-condition: a rewritten reference must still resolve to the
 * renamed object under the walked body's home schema path, or the rewrite adds
 * a schema qualifier (see `renameTableInAst`).
 *
 * Both resolvers must be bound to the WALKED BODY's home schema. The
 * catalog-backed factory is
 * {@link import('../object-ref-resolver.js').tableRenameTargetsFor}; a
 * single-schema world ({@link singleSchemaObjectRefResolver}) passes the same
 * function for both fields, because a bare new name there always resolves back
 * to the one schema and no qualification can ever fire.
 */
export interface TableRenameTarget {
	oldName: string;
	newName: string;
	/** Schema owning the renamed object. The match key is `objectRefKey(schemaName, oldName)`. */
	schemaName: string;
	/** Resolution as the bodies planned it — the pre-mutation snapshot. */
	resolve: ResolveObjectRef;
	/** Resolution as it will be after the rename lands. */
	resolveAfter: ResolveObjectRef;
}

/**
 * What a bare, unbound `new.` / `old.` column qualifier names AT THIS POINT in a
 * rename walk. Three-valued because the domain is: the walk's own target's row
 * image, some OTHER relation's row image, or no written-row context at all.
 * `new` and `old` are not reserved words in this parser (`create table "new"` is
 * legal), so the mode is what disambiguates the two spellings — and it is a
 * property of the POSITION in the tree, not of the walk's entry point: a
 * `with inverse` expression forces `'foreign'` over its subtree regardless of
 * the ambient mode (see `visitColumnRename`'s select arm).
 */
export type RowImageContext =
	/** No written-row context here — `new.x` is an ordinary table reference. */
	| 'none'
	/** Written-row context whose image IS the walk's target table — match it. */
	| 'own'
	/** Written-row context whose image belongs to another relation — ignore it. */
	| 'foreign';

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
