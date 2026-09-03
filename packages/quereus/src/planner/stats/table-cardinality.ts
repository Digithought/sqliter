/**
 * Shared base-table row-count helper.
 *
 * The catalog knows a table's row count only through `TableSchema.statistics`
 * (populated by `ANALYZE` or VTab reporting). There are exactly two spellings:
 * `undefined` means "nobody knows" and a number — including a real 0 — means
 * "measured". `undefined` must stay `undefined` here: callers apply their own
 * fallback (e.g. NaiveStatsProvider's default of 1000), and folding a default
 * in would change every un-analyzed table's cardinality.
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
	return table.statistics?.rowCount;
}
