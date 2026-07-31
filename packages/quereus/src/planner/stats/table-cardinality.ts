/**
 * Shared base-table row-count helper.
 *
 * Statistics-first: prefer the `ANALYZE`-collected `rowCount` over the static
 * `TableSchema.estimatedRows` field (which `SchemaManager` hardcodes to 0 at
 * CREATE TABLE and never updates). `undefined` means "nobody knows" and must
 * stay `undefined` — callers apply their own fallback (e.g. NaiveStatsProvider's
 * default of 1000); folding that default in here would change every
 * un-analyzed table's cardinality.
 *
 * `TableReferenceNode.estimatedRows` and `CatalogStatsProvider.tableRows` both
 * call this so the logical/physical estimate and the stats-provider estimate
 * cannot drift apart.
 *
 * NOTE: `rowCount` is a snapshot from the last `ANALYZE` — rows written
 * afterwards are invisible until the next one.
 */

import type { TableSchema } from '../../schema/table.js';

export function catalogRowCount(table: TableSchema): number | undefined {
	return table.statistics?.rowCount ?? table.estimatedRows;
}
