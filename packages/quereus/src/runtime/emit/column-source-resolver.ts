import type { Database } from '../../core/database.js';
import type { ResolveColumnInSource } from '../../schema/rename-rewriter.js';

/**
 * The catalog-backed {@link ResolveColumnInSource} the column-rename rewriters consult
 * to keep their unqualified-reference walk scope-aware. Built once per statement and
 * shared by every pass that walks the same statement's dependents — the pre-flight
 * probe and the real propagation in `runRenameColumn`, and the DROP COLUMN guards in
 * `drop-column-guards.ts` — so no two of them can drift apart. Note it resolves
 * against the LIVE catalog on every call, so sharing it does not by itself freeze the
 * answer between passes — see the rename pre-flight's comment for why they agree anyway.
 *
 * Lives in its own module rather than in `alter-table.ts` because the DROP COLUMN
 * guards need it and are themselves imported *by* `alter-table.ts`.
 */
export function buildColumnSourceResolver(db: Database): ResolveColumnInSource {
	return (s, t, col) => {
		const targetSchema = db.schemaManager.getSchema(s);
		const targetTable = targetSchema?.getTable(t);
		return targetTable?.columnIndexMap.has(col.toLowerCase()) ?? false;
	};
}
