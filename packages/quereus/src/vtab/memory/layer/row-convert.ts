import type { Row, SqlValue } from '../../../common/types.js';

/** Replaces the value at one column index of a row with its post-ALTER form. */
export type RowMapper = (row: Row) => Row;

/**
 * One row's worth of the value rewrite an `alter column … set data type` / `set not null`
 * backfill performs: the value at `colIndex` run through `convert`. A NULL passes through
 * untouched UNLESS `convertNulls` is set (the SET NOT NULL backfill maps null → DEFAULT).
 * The row is returned unchanged — same object — when nothing needs converting.
 *
 * Shared by every site that has to agree on what "the converted row" is: the pre-mutation
 * UNIQUE probe, the committed-base rewrite, and each open transaction layer's own-write
 * rewrite. Callers differ only in whether they let a conversion failure propagate; the two
 * rewrite sites keep the row as-is (the value is shadowed and unreadable — see their
 * docstrings), the probe lets it throw.
 */
export function convertRowAtIndex(
	row: Row,
	colIndex: number,
	convert: (v: SqlValue) => SqlValue,
	convertNulls: boolean,
): Row {
	const oldVal = row[colIndex];
	if (oldVal === null && !convertNulls) return row;
	const newVal = convert(oldVal);
	return row.map((v, i) => i === colIndex ? newVal : v) as Row;
}

/** Applies `mapRow` to a synchronous row stream (the memory module's own effective rows). */
export function* mapRows(rows: Iterable<Row>, mapRow: RowMapper): Iterable<Row> {
	for (const row of rows) yield mapRow(row);
}

/** Applies `mapRow` to an async row stream (a wrapper module's `EffectiveRowSource`). */
export async function* mapRowsAsync(rows: AsyncIterable<Row>, mapRow: RowMapper): AsyncIterable<Row> {
	for await (const row of rows) yield mapRow(row);
}
