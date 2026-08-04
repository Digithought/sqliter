import type { SchemaManager } from './manager.js';
import type { ResolveColumnInSource } from './rename-rewriter.js';

/**
 * The catalog-backed {@link ResolveColumnInSource} every scope-aware walk over a
 * schema-object expression consults to tell an unqualified reference that binds to an
 * inner FROM source from one that binds to the table under consideration.
 *
 * Three callers, one definition, so no two of them can disagree about what a name
 * resolves to: `runRenameColumn`'s pre-flight probe and its real propagation, the
 * DROP COLUMN guards in `runtime/emit/drop-column-guards.ts`, and the constraint
 * planner's self-qualifier strip (`planner/building/constraint-builder.ts`).
 *
 * Resolves against the LIVE catalog on every call, so sharing one instance across
 * passes does not by itself freeze the answer between them — see the rename
 * pre-flight's comment for why its two passes agree anyway.
 */
export function buildColumnSourceResolver(schemaManager: SchemaManager): ResolveColumnInSource {
	return (s, t, col) => {
		const targetSchema = schemaManager.getSchema(s);
		const targetTable = targetSchema?.getTable(t);
		return targetTable?.columnIndexMap.has(col.toLowerCase()) ?? false;
	};
}
