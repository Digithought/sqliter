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
 *
 * NOTE: a real 0 (analyzed, empty table) is distinct from `undefined`, but the
 * `estimatedRows || default` spellings in `rule-select-access-path`,
 * `rule-grow-retrieve` and `IndexSeekNode.computePhysical` collapse the two and
 * substitute their default — so an analyzed empty table reaches
 * `getBestAccessPlan` as "unknown" (1000) while a SeqScan over it reports 0.
 * Harmless today (any plan over 0 rows is cheap); switch those to `??` if an
 * empty-table plan ever costs out wrong.
 */

import type { TableSchema } from '../../schema/table.js';

export function catalogRowCount(table: TableSchema): number | undefined {
	return table.statistics?.rowCount ?? table.estimatedRows;
}
