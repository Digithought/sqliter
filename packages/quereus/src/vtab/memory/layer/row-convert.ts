import type { Row, SqlValue } from '../../../common/types.js';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary } from '../types.js';
import { primaryKeyArity } from '../utils/primary-key.js';

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

/**
 * The key-side twin of {@link convertRowAtIndex}: a mapper that runs a stored PRIMARY KEY through
 * the same per-value conversion, at the position `colIndex` occupies in the key. The identity when
 * `colIndex` is not a key member. Same NULL rule as the row form.
 *
 * Exists for the one place a converted row is NOT available: a transaction layer's staged
 * DELETIONS carry a key and no row image, and the SET NOT NULL backfill of a key member moves the
 * key values (see `TransactionLayer.convertColumn`). Reads the key's shape — scalar for arity 1,
 * tuple otherwise — through {@link primaryKeyArity}, the same fallback the extractor uses.
 */
export function makePrimaryKeyConverter(
	schema: TableSchema,
	colIndex: number,
	convert: (v: SqlValue) => SqlValue,
	convertNulls: boolean,
): (key: BTreeKeyForPrimary) => BTreeKeyForPrimary {
	const keyPos = schema.primaryKeyDefinition.findIndex(def => def.index === colIndex);
	if (keyPos < 0) return key => key;
	const convertValue = (v: SqlValue): SqlValue => (v === null && !convertNulls) ? v : convert(v);
	if (primaryKeyArity(schema) === 1) return key => convertValue(key as SqlValue);
	return (key: BTreeKeyForPrimary): BTreeKeyForPrimary => {
		const tuple = key as SqlValue[];
		const newVal = convertValue(tuple[keyPos]);
		return newVal === tuple[keyPos] ? key : tuple.map((v, i) => i === keyPos ? newVal : v);
	};
}

/** Applies `mapRow` to a synchronous row stream (the memory module's own effective rows). */
export function* mapRows(rows: Iterable<Row>, mapRow: RowMapper): Iterable<Row> {
	for (const row of rows) yield mapRow(row);
}

/** Applies `mapRow` to an async row stream (a wrapper module's `EffectiveRowSource`). */
export async function* mapRowsAsync(rows: AsyncIterable<Row>, mapRow: RowMapper): AsyncIterable<Row> {
	for await (const row of rows) yield mapRow(row);
}
