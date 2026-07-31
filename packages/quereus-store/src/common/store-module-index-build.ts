/**
 * Standalone index-population and uniqueness-validation helpers: streaming a table's
 * committed rows into a secondary index's physical store in bounded batches, and the
 * duplicate probes that judge a UNIQUE constraint or UNIQUE index against a row stream
 * before it is enforced.
 *
 * Free functions rather than a layer of the store-module chain — none of them reads
 * module state; each takes the stores and schema it needs.
 */

import type {
	CompiledPredicate,
	EffectiveRowSource,
	KeyNormalizer,
	KeyNormalizerResolver,
	Row,
	SqlValue,
	TableIndexSchema,
	TableSchema,
	UniqueConstraintSchema,
} from '@quereus/quereus';
import { QuereusError, StatusCode, compilePredicate, logicalTypeCanHoldText, serializeKey } from '@quereus/quereus';
import type { KVEntry, KVStore } from './kv-store.js';
import {
	resolveIndexKeyCollations,
	resolveIndexKeyTransforms,
	resolvePkKeyCollations,
	resolvePkKeyTransforms,
	storeSemanticKeyTransform,
} from './pk-key-resolution.js';
import { buildDataKey, buildFullScanBounds, buildIndexKey } from './key-builder.js';
import { deserializeRow } from './serialization.js';
import type { StoreTable } from './store-table.js';
// NOTE: this one constant is the only thing tying this file to the module chain (the graph
// stays acyclic — the base layer is a leaf). If these helpers ever need to be usable without
// loading the chain, move `DEFAULT_MAX_BATCH_BYTES` to a constants leaf and have the base
// import it from there instead.
import { DEFAULT_MAX_BATCH_BYTES } from './store-module-base.js';

/**
 * Build index entries for all existing rows in a table.
 *
 * `dataEntries` is the row stream to index. Callers choose its visibility:
 * `createIndex` passes the table's EFFECTIVE stream (committed + pending, so
 * an open transaction's rows are indexed too), while `rebuildSecondaryIndexes`
 * passes the raw committed stream — it runs immediately after an ALTER has
 * re-encoded the data store in place, and any pending ops still address the
 * pre-ALTER key bytes.
 *
 * For UNIQUE indexes, performs an in-pass duplicate check (honoring partial
 * predicates and SQL NULL semantics: multiple NULLs are allowed) and throws
 * CONSTRAINT before any entries are written. Mirrors the memory module's
 * populateNewIndex so `CREATE UNIQUE INDEX` over duplicated data fails
 * atomically. `skipDuplicateCheck` suppresses it: `createIndex` sets it when a
 * wrapper module supplied the rows to judge, having already validated them (see
 * {@link validateUniqueIndexOverRows}). Judging `dataEntries` too would reject a
 * committed duplicate the wrapper's transaction has already deleted.
 *
 * `normalizers` MUST be the owning connection's `db.getKeyNormalizerResolver()` —
 * the same resolver `StoreTable.encodeOptions` carries. A rebuild that resolved
 * collations any other way would re-encode the PK suffix under different bytes than
 * the table writes at maintenance time, silently corrupting the index.
 */
export async function buildIndexEntries(
	dataEntries: AsyncIterable<KVEntry>,
	indexStore: KVStore,
	tableSchema: TableSchema,
	indexSchema: TableIndexSchema,
	keyCollation: string,
	normalizers: KeyNormalizerResolver,
	skipDuplicateCheck = false,
	maxBatchBytes: number = DEFAULT_MAX_BATCH_BYTES,
): Promise<void> {
	// Both halves key per-column: each index COLUMN under its own key collation
	// (`resolveIndexKeyCollations` — index COLLATE ?? table column collation ?? BINARY)
	// and the PK SUFFIX under each PK column's own key collation, so the suffix bytes
	// match the data-store keys — and both halves match
	// `StoreTable.updateSecondaryIndexes`' maintenance writes exactly. Those two call
	// sites are the pair whose drift silently corrupts an index; change one and the
	// other must change with it. `keyCollation` (the table key collation K) remains
	// only as the `EncodeOptions` fallback for entries the resolvers leave undefined.
	const encodeOptions = { collation: keyCollation, normalizers };
	const pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
	const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, keyCollation);
	const indexCollations = resolveIndexKeyCollations(indexSchema, tableSchema.columns);
	// Key-identity transforms for both halves, mirroring `StoreTable`'s maintenance
	// writes (`updateSecondaryIndexes` / `encodeDataKey`) — a rebuild that skipped them
	// would re-encode a TIMESPAN member under different bytes than DML writes.
	const pkTransforms = resolvePkKeyTransforms(tableSchema.primaryKeyDefinition, tableSchema.columns);
	const indexTransforms = resolveIndexKeyTransforms(indexSchema, tableSchema.columns);
	const indexDirections = indexSchema.columns.map(col => !!col.desc);

	const predicate: CompiledPredicate | undefined = indexSchema.predicate
		? compilePredicate(indexSchema.predicate, tableSchema.columns, tableSchema.name)
		: undefined;
	// NOTE: `seen` holds one signature per DISTINCT indexed key for the WHOLE build and
	// is NOT bounded by the maxBatchBytes chunking below (that bounds only the write
	// batch). A very large UNIQUE index still spikes memory on this set. Bounding it
	// needs a sort- or store-probe-based dedup (a separate design), not a batch knob.
	const seen: Set<string> | undefined = (indexSchema.unique && !skipDuplicateCheck) ? new Set() : undefined;

	const indexColIndices = indexSchema.columns.map(col => col.index);
	const indexNormalizers = seen
		? indexDedupeNormalizers(tableSchema, indexSchema, normalizers)
		: undefined;

	let batch = indexStore.batch();
	// Serialized key bytes accumulated in the CURRENT batch. Flushed and reset once it
	// crosses maxBatchBytes so a table larger than memory never buffers its whole index.
	let batchBytes = 0;

	for await (const entry of dataEntries) {
		const row = deserializeRow(entry.value);

		// Partial index: skip rows whose predicate is not unambiguously TRUE.
		if (predicate && predicate.evaluate(row) !== true) continue;

		// Extract PK values
		const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);

		// Extract index column values
		const indexValues = indexSchema.columns.map(col => row[col.index]);

		if (seen) {
			// The signature returns null when any indexed column is NULL —
			// SQL UNIQUE allows multiple NULLs, so those rows never collide.
			const keySig = dedupeRowSignature(row, indexColIndices, indexNormalizers!, indexTransforms);
			if (keySig !== null) {
				if (seen.has(keySig)) {
					const colNames = indexSchema.columns
						.map(c => tableSchema.columns[c.index]?.name ?? String(c.index))
						.join(', ');
					throw new QuereusError(
						`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
						StatusCode.CONSTRAINT,
					);
				}
				seen.add(keySig);
			}
		}

		// Build and store index key
		const indexKey = buildIndexKey(
			{ values: indexValues, directions: indexDirections, collations: indexCollations, transforms: indexTransforms },
			{ values: pkValues, directions: pkDirections, collations: pkCollations, transforms: pkTransforms },
			encodeOptions,
		);
		// Index value = the row's encoded DATA key, so an index scan resolves each
		// entry back to its base row via a direct data-store read (see
		// `StoreTable.scanIndex`). Encoded under the same PK directions + per-column
		// PK collations + key transforms as `buildDataKey` / `updateSecondaryIndexes`,
		// so the value byte-matches the data store's key for this row.
		const dataKey = buildDataKey(pkValues, encodeOptions, pkDirections, pkCollations, pkTransforms);
		batch.put(indexKey, dataKey);

		// Bound heap: once the accumulated serialized key bytes cross the budget, flush
		// the batch and start a fresh one. Both callers ITERATE the data store and WRITE
		// the index store — different stores — so a mid-stream flush never mutates the
		// stream being read, and this is safe on every provider. A mid-stream flush
		// failure in `createIndex` is torn down by its try/catch (the whole fresh index
		// store is deleted); in `rebuildSecondaryIndexes` it leaves a partial-but-
		// recoverable index (re-run the rebuild — clear + rebuild is idempotent).
		batchBytes += indexKey.length + dataKey.length;
		if (batchBytes >= maxBatchBytes) {
			await batch.write();
			batch = indexStore.batch();
			batchBytes = 0;
		}
	}

	// Final flush of the residual. May be empty (an empty table, or a build whose last
	// row exactly hit the budget and flushed) — providers accept an empty write.
	await batch.write();
}

/**
 * Validates `rows` against a UNIQUE constraint, throwing `CONSTRAINT` on the first
 * duplicate before any schema mutation. Used by `ADD CONSTRAINT UNIQUE` (validate
 * against the current collation) and by `SET COLLATE` (pass an `updatedSchema` whose
 * altered column carries the NEW collation, so the dedup is performed under it).
 * Mirrors the duplicate detection in {@link buildIndexEntries}: a `seen` Set keyed on
 * a per-column collation-aware signature of the constrained values, with SQL NULL
 * semantics (a row with any NULL constrained value never counts as a duplicate) and
 * the partial `predicate` honored.
 *
 * `rows` MUST be the rows the DDL-issuing connection can SEE. Ordinarily that is this
 * table's EFFECTIVE stream (committed rows merged with the open transaction's own
 * pending puts/deletes — `StoreTable.iterateEffectiveEntries`, adapted by
 * {@link rowsFromEntries}); when a wrapper module holds the pending rows outside this
 * module it hands them down as an `EffectiveRowSource` instead. Either way, a
 * committed-only stream would let a duplicate inserted earlier in the same transaction
 * slip past validation and land in the table once the transaction commits.
 *
 * No index store is written — store UNIQUE enforcement is a full-scan over
 * `uniqueConstraints` at write time. The signature is built by
 * {@link dedupeRowSignature} with one normalizer per constrained column, resolved from
 * `tableSchema.columns[idx].collation` through the connection's
 * `db.getKeyNormalizerResolver()`, so a per-column collation registered with
 * `db.registerCollation` is honored (matching write-time `compareSqlValues`
 * enforcement). A comparator-only collation raises: rows that cannot be bucketed
 * cannot be deduped. Columns whose declared type can never hold text take the
 * identity normalizer and so never raise.
 */
export async function validateUniqueOverExistingRows(
	rows: AsyncIterable<Row>,
	tableSchema: TableSchema,
	uc: UniqueConstraintSchema,
	keyNormalizers: KeyNormalizerResolver,
): Promise<void> {
	await assertNoDuplicateRows(
		rows,
		tableSchema,
		uc.columns,
		uc.columns.map(idx => {
			const column = tableSchema.columns[idx];
			return keyNormalizers(logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined);
		}),
		uc.predicate ? compilePredicate(uc.predicate, tableSchema.columns, tableSchema.name) : undefined,
	);
}

/**
 * Index-shaped twin of {@link validateUniqueOverExistingRows}, used by
 * `StoreModuleIndex.createIndex` when a wrapper module supplies the rows to judge. Dedupes on the
 * index's own columns under the index column's COLLATE (falling back to the table
 * column's), so it enforces exactly what `buildIndexEntries`' suppressed in-pass check
 * would have — over the wrapper's rows instead of this module's committed ones.
 */
export async function validateUniqueIndexOverRows(
	rows: AsyncIterable<Row>,
	tableSchema: TableSchema,
	indexSchema: TableIndexSchema,
	keyNormalizers: KeyNormalizerResolver,
): Promise<void> {
	await assertNoDuplicateRows(
		rows,
		tableSchema,
		indexSchema.columns.map(col => col.index),
		indexDedupeNormalizers(tableSchema, indexSchema, keyNormalizers),
		indexSchema.predicate ? compilePredicate(indexSchema.predicate, tableSchema.columns, tableSchema.name) : undefined,
	);
}

/** Adapts a raw KV entry stream into the row stream the uniqueness validators consume. */
export async function* rowsFromEntries(entries: AsyncIterable<KVEntry>): AsyncIterable<Row> {
	for await (const entry of entries) {
		yield deserializeRow(entry.value);
	}
}

/**
 * The rows a DDL-issuing connection can SEE, as every pre-mutation probe in the ALTER
 * path needs them: a wrapper module's `EffectiveRowSource` when the isolation layer
 * holds this transaction's staged rows outside the store, else this table's own
 * effective stream (committed rows merged with the module's buffered puts/deletes).
 *
 * One fresh stream per call — an async generator is single-shot, and an
 * `EffectiveRowSource` is re-callable for exactly that reason, so a probe that needs
 * two walks calls this twice.
 */
export function effectiveDdlRows(table: StoreTable, rows?: EffectiveRowSource): AsyncIterable<Row> {
	return rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds()));
}

/**
 * Per-column key normalizers for a UNIQUE INDEX dedupe signature, drawing each column's
 * collation from the index column (if it carries one) else the underlying table column —
 * so the signature honors a per-column collation registered on this connection, matching
 * write-time enforcement.
 *
 * A column whose declared type can never hold text takes the identity normalizer regardless
 * of its collation (the signature serializer normalizes only string values), so a comparator-only
 * collation named on an integer column is not rejected here when the engine's own hash sites
 * would accept it.
 */
function indexDedupeNormalizers(
	tableSchema: TableSchema,
	indexSchema: TableIndexSchema,
	keyNormalizers: KeyNormalizerResolver,
): KeyNormalizer[] {
	return indexSchema.columns.map(col => {
		const column = tableSchema.columns[col.index];
		return keyNormalizers(logicalTypeCanHoldText(column.logicalType)
			? (col.collation ?? column.collation)
			: undefined);
	});
}

/**
 * Collation- and identity-aware dedupe signature of `row` over `colIndices`: each value
 * runs through its column's key transform (`storeSemanticKeyTransform` — TIMESPAN's
 * total-seconds `groupKey`, so 'PT1H' and 'PT60M' sign identically; JSON's structural
 * bytes, so reorder-equal objects sign identically) before `serializeKey` applies the
 * per-column normalizer. Returns null when any covered value
 * is NULL (SQL UNIQUE allows multiple NULLs). The build/validate-time twin of the
 * write-time typed compare in `StoreTable.uniqueColumnComparators`.
 */
function dedupeRowSignature(
	row: Row,
	colIndices: readonly number[],
	normalizers: readonly KeyNormalizer[],
	transforms: ReadonlyArray<((v: SqlValue) => SqlValue) | undefined>,
): string | null {
	const values = colIndices.map((c, i) => {
		const v = row[c];
		const transform = transforms[i];
		return transform && v !== null ? transform(v) : v;
	});
	return serializeKey(values, normalizers);
}

/**
 * Throws CONSTRAINT on the first pair of `rows` that share a signature over `columnIndices`.
 *
 * SQL NULL semantics: {@link dedupeRowSignature} returns null when any constrained column is
 * NULL, and such rows never collide. A partial `predicate` restricts the judged set to rows
 * it accepts unambiguously. Shared by {@link validateUniqueOverExistingRows}
 * (constraint columns) and {@link validateUniqueIndexOverRows} (index columns).
 */
async function assertNoDuplicateRows(
	rows: AsyncIterable<Row>,
	tableSchema: TableSchema,
	columnIndices: readonly number[],
	normalizers: readonly KeyNormalizer[],
	predicate: CompiledPredicate | undefined,
): Promise<void> {
	const transforms = columnIndices.map(i => storeSemanticKeyTransform(tableSchema.columns[i]?.logicalType));
	const seen = new Set<string>();
	for await (const row of rows) {
		if (predicate && predicate.evaluate(row) !== true) continue;

		const keySig = dedupeRowSignature(row, columnIndices, normalizers, transforms);
		if (keySig === null) continue;

		if (seen.has(keySig)) {
			const colNames = columnIndices.map(i => tableSchema.columns[i]?.name ?? String(i)).join(', ');
			throw new QuereusError(
				`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
				StatusCode.CONSTRAINT,
			);
		}
		seen.add(keySig);
	}
}
