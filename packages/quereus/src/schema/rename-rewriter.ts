/**
 * In-place, scope-aware AST rewriters over schema-object expressions: the
 * rename walkers propagate ALTER TABLE RENAME operations into dependent
 * objects (CHECK expressions, view SELECT bodies, etc.), and the
 * self-qualifier strip folds a schema-authored row expression's
 * table-qualified self-references (a CHECK's or a GENERATED ALWAYS AS body's)
 * so the row-context scope it is compiled against can resolve them.
 *
 * The three walkers live in `rename/`, split along their seams — table
 * rename (`rename/table-rename.ts`), column rename
 * (`rename/column-rename.ts`), self-qualifier strip
 * (`rename/self-qualifier-strip.ts`) — over the shared vocabulary in
 * `rename/shared.ts`. This module re-exports the public surface so callers
 * keep one import path.
 */

export type { ResolveColumnInSource, ResolveObjectRef, RowImageContext, TableRenameTarget } from './rename/shared.js';
export { objectRefKey, objectRefKeySchema, singleSchemaObjectRefResolver } from './rename/shared.js';
export {
	renameTableInAst,
	tableReferencedInAst,
	collectTableRefsInAst,
	renameTableInIndexPredicates,
	renameTableInCheckConstraints,
	renameTableInColumnExpressions,
	type TableRenameOpts,
} from './rename/table-rename.js';
export {
	PROBE_COLUMN_NAME,
	renameColumnInAst,
	renameColumnInCheckExpression,
	columnReferencedInAst,
	columnReferencedInCheckExpression,
	renameColumnInIndexPredicates,
	renameColumnInCheckConstraints,
	renameColumnInColumnExpressions,
	bodyExposesRenamedColumn,
	bodyPublishesColumnNamed,
} from './rename/column-rename.js';
export { stripSelfQualifierInSchemaExpression } from './rename/self-qualifier-strip.js';
