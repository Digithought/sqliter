/**
 * Generic KVStore-backed Virtual Table implementation.
 *
 * This is a platform-agnostic table implementation that works with any
 * KVStore implementation (LevelDB, IndexedDB, or custom stores).
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - Stats store: __stats__ - unified store for all table statistics, keyed by {schema}.{table}
 *
 * The class is layered across four files, each adding one job to the one below:
 *   `store-table-base.ts`        - state, store handles, stats, transaction lifecycle
 *   `store-table-scan.ts`        - the read path (predicate -> byte window -> rows)
 *   `store-table-constraints.ts` - secondary-index maintenance + UNIQUE enforcement
 *   `store-table.ts`             - this file: the write path and bulk row maintenance
 */

import {
	ConflictResolution,
	QuereusError,
	StatusCode,
	formatKeyValue,
	rowsValueIdentical,
	type ColumnSchema,
	type TableSchema,
	type Row,
	type SqlValue,
	type UpdateArgs,
	type UpdateResult,
	type BackingRowChange,
} from '@quereus/quereus';

import { bytesEqual, bytesToHex } from './bytes.js';
import {
	buildDataKey,
	buildFullScanBounds,
} from './key-builder.js';
import {
	serializeRow,
	deserializeRow,
} from './serialization.js';
import { resolvePkKeyCollations, resolvePkKeyTransforms } from './pk-key-resolution.js';

import { StoreTableConstraints } from './store-table-constraints.js';

/**
 * Resolves the per-constraint default conflict action for PK conflicts.
 * Prefers the table-level `PRIMARY KEY (...) ON CONFLICT <action>` clause
 * over any column-level `defaultConflict` declared on a PK column.
 *
 * Mirrors the helpers in `quereus/.../layer/manager.ts` and
 * `quereus-isolation/.../isolated-table.ts` — the three-tier precedence
 * `statement OR > per-constraint default > ABORT` must agree across all
 * three implementations.
 */
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
	if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
	for (const def of schema.primaryKeyDefinition) {
		const col = schema.columns[def.index];
		if (col?.defaultConflict !== undefined) return col.defaultConflict;
	}
	return undefined;
}

/**
 * One externally-applied row op against a SOURCE table's committed storage,
 * the input vocabulary of {@link StoreTable.applyExternalRowChanges}. An
 * `upsert` carries the full table row in schema column order (its PK — and thus
 * its data key — is derived from the row, so an upsert can never relocate a
 * row); a `delete` carries the PK values in PK-definition order.
 */
export type ExternalRowOp =
	| { op: 'upsert'; row: Row }
	| { op: 'delete'; pk: SqlValue[] };

/**
 * Generic KVStore-backed virtual table.
 *
 * This class provides the core table functionality shared across all
 * storage backends. Platform-specific behavior is delegated to the
 * StoreTableModule.
 */
export class StoreTable extends StoreTableConstraints {
	/**
	 * Apply a per-row mapping function to every stored row, in place (re-writing
	 * the same key). The mapper may throw QuereusError — propagated to the caller;
	 * the batch is written only after every row maps, so a throw leaves the store
	 * untouched.
	 *
	 * NOTE: reads and writes the COMMITTED store, outside the coordinator. Sound
	 * only because every caller calls `StoreModule.ddlCommitPendingOps` first, so
	 * "committed" is "everything live". A caller that skips that flush would leave
	 * its transaction's pending rows unmapped, and they would replay unconverted
	 * over the rewritten store at commit.
	 */
	async mapRowsAtIndex(
		colIndex: number,
		mapper: (value: SqlValue) => SqlValue,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const oldVal = row[colIndex];
			const newVal = mapper(oldVal);
			if (newVal === oldVal) continue;
			const newRow = row.slice();
			newRow[colIndex] = newVal;
			batch.put(entry.key, serializeRow(newRow as Row));
		}
		await batch.write();
	}

	/**
	 * Closure computing a row's data key under a NEW primary-key definition and
	 * column set — the exact bytes {@link rekeyRows} pass 2 writes. Shared by
	 * `rekeyRows`' two passes and {@link validateRekeyedPrimaryKey}'s probes so a
	 * collision judged by a probe is byte-identical to the key the re-key would
	 * write. Deliberately NOT the `dedupeRowSignature` / `KeyNormalizerResolver`
	 * path the UNIQUE validators use — the two disagree for at least an `any`-typed
	 * PK member, whose key bytes pin BINARY regardless of its declared collation
	 * (pinned by `any-json-pk-binary-key.spec.ts`).
	 *
	 * The transforms matter too: an ALTER PRIMARY KEY onto (or a SET DATA TYPE
	 * creating) a semantic-ordering member must collapse equal spellings, so
	 * 'PT1H'/'PT60M' land on one key and are judged as the duplicate they are.
	 */
	rekeyedKeyComputer(
		newPkDef: ReadonlyArray<{ index: number; desc?: boolean }>,
		newColumns: ReadonlyArray<ColumnSchema> = this.tableSchema!.columns,
	): (row: Row) => Uint8Array {
		const newPkDirections = newPkDef.map(pk => !!pk.desc);
		const newPkCollations = resolvePkKeyCollations(
			newPkDef,
			newColumns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		const newPkTransforms = resolvePkKeyTransforms(newPkDef, newColumns);
		return (row: Row): Uint8Array =>
			buildDataKey(newPkDef.map(pk => row[pk.index]), this.encodeOptions, newPkDirections, newPkCollations, newPkTransforms);
	}

	/**
	 * The store's counterpart of the memory backend's
	 * `MemoryTableManager.validateRekeyedPrimaryKey`: the two throw-only questions a
	 * PK re-key must answer, over two DIFFERENT row sets, BEFORE anything is flushed
	 * or mutated (see docs/memory-table.md §"A collation change on a PRIMARY KEY
	 * column obeys a stricter rule"):
	 *
	 *  1. **Is the change legal?** — over `effectiveRows`, the rows the DDL-issuing
	 *     transaction can SEE (a wrapper's `EffectiveRowSource` when the isolation
	 *     layer holds the transaction's staged rows outside this store, else this
	 *     table's own effective stream). Two rows on one new key here is a duplicate
	 *     a `select` in this transaction would return, so the change is invalid →
	 *     `CONSTRAINT`, naming the colliding key.
	 *  2. **Can the store carry it?** — over this store's COMMITTED rows, the set a
	 *     `rollback` must be able to restore. The data store holds one row per key,
	 *     so a committed pair collapsing onto one new key cannot be represented even
	 *     when the transaction has deleted one of them → `BUSY`, with the memory
	 *     module's "commit/rollback and retry" posture.
	 *
	 * Probe order is what makes the statuses right: the committed probe fires only
	 * when the effective probe passed, i.e. only when the committed rows are NOT a
	 * subset of the effective ones — which happens exactly when a wrapper's
	 * transaction deleted a committed row. Run without a wrapper, effective ⊇
	 * committed, so a committed collision always reports `CONSTRAINT` via the first
	 * probe. Both probes key through {@link rekeyedKeyComputer}, so they and the
	 * re-key agree byte-for-byte.
	 */
	async validateRekeyedPrimaryKey(
		newPkDef: ReadonlyArray<{ index: number; desc?: boolean }>,
		newColumns: ReadonlyArray<ColumnSchema>,
		effectiveRows: AsyncIterable<Row>,
	): Promise<void> {
		const computeNewKey = this.rekeyedKeyComputer(newPkDef, newColumns);

		const seenEffective = new Set<string>();
		for await (const row of effectiveRows) {
			const hex = bytesToHex(computeNewKey(row));
			if (seenEffective.has(hex)) {
				// Mirror the memory module's diagnostic, naming the key from the second
				// (colliding) row's PK values.
				const parts = newPkDef.map(pk => formatKeyValue(row[pk.index]));
				throw new QuereusError(
					`UNIQUE constraint failed: ${this.tableName} primary key collides under the new key definition (key: ${parts.join(', ')})`,
					StatusCode.CONSTRAINT,
				);
			}
			seenEffective.add(hex);
		}

		const store = await this.ensureStore();
		const seenCommitted = new Set<string>();
		for await (const entry of store.iterate(buildFullScanBounds())) {
			const hex = bytesToHex(computeNewKey(deserializeRow(entry.value)));
			if (seenCommitted.has(hex)) {
				throw new QuereusError(
					`Cannot re-key the primary key of table ${this.tableName}: `
					+ `rows this transaction has removed still collide under the new key definition and must survive a rollback. `
					+ `Commit/rollback and retry.`,
					StatusCode.BUSY,
				);
			}
			seenCommitted.add(hex);
		}
	}

	/**
	 * Re-key every stored row under a new primary-key definition.
	 *
	 * Two-pass, signatures-only pass 1: the first pass computes each row's new data
	 * key and retains only a `Set` of key SIGNATURES (hex of the key bytes) to detect
	 * collisions — two distinct old keys collapsing to one new key under a coarser
	 * collation or a narrower PK. On collision we throw `CONSTRAINT` without touching
	 * the store. For `ALTER PRIMARY KEY` this pass is the gate; for `ALTER COLUMN …
	 * SET COLLATE` on a PK member it is only a backstop — that arm has already run
	 * {@link validateRekeyedPrimaryKey}'s two probes before the DDL flush, so a
	 * refusal there leaves the enclosing transaction alive. The second pass RE-SCANS
	 * the same committed store, recomputes each
	 * new key, and batches deletes of displaced old keys + puts of new (key, row)
	 * pairs into ONE atomic batch. Rows whose new key matches the old key are no-ops.
	 *
	 * Holding signatures instead of whole rows halves peak memory: the prior design
	 * retained the entire table in a map AND again in the batch. The re-scan trades
	 * O(rows) CPU (a second iterate + newKey recompute) for not buffering the table
	 * twice. Pass 1 and pass 2 iterate the SAME bounds over the SAME committed store
	 * and see identical rows: nothing writes between them — we are single-threaded
	 * within the ALTER, outside the coordinator, and every caller ran
	 * `StoreModule.ddlCommitPendingOps` first so "committed" is "everything live".
	 *
	 * The final single `batch.write()` is the ONLY thing making the re-key
	 * all-or-nothing — do not chunk-flush it. Its residual peak (the batch still holds
	 * every changed row) is irreducible without breaking atomicity; tracked separately
	 * in `debt-store-atomic-batch-bounded-memory`.
	 *
	 * Only the data store is rewritten — secondary indexes are rebuilt by the
	 * caller (the keys embed the PK suffix, so they must be rebuilt whenever
	 * the PK changes).
	 *
	 * The new key for each row is encoded under `newColumns`'s per-column PK
	 * collations, so this drives BOTH:
	 *   - `ALTER PRIMARY KEY` — the PK *columns* change; `newColumns` defaults to the
	 *     current column set (their collations are unchanged), and
	 *   - `ALTER COLUMN … SET COLLATE` on a PK member — the PK columns stay the same
	 *     but one column's collation changes; the caller passes the post-ALTER
	 *     `updatedSchema.columns` so the new key bytes follow the new collation.
	 * The OLD key is taken verbatim from the stored entry (never re-encoded), so the
	 * old collation is implicit in the existing bytes and need not be supplied.
	 */
	async rekeyRows(
		newPkDef: ReadonlyArray<{ index: number; desc?: boolean }>,
		newColumns: ReadonlyArray<ColumnSchema> = this.tableSchema!.columns,
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();

		// Both passes key rows through this one helper — shared with the SET COLLATE
		// arm's pre-flush probes — so a collision judged anywhere is byte-identical to
		// the key pass 2 writes.
		const computeNewKey = this.rekeyedKeyComputer(newPkDef, newColumns);

		// Pass 1 — collision detection only. Hold one hex signature per new key, never
		// the row or old key. On a repeat, reject before any write; the store is
		// untouched on rejection.
		const seen = new Set<string>();
		for await (const entry of store.iterate(bounds)) {
			const hex = bytesToHex(computeNewKey(deserializeRow(entry.value)));
			if (seen.has(hex)) {
				throw new QuereusError(
					`UNIQUE constraint failed: duplicate primary key on rekey of '${this.schemaName}.${this.tableName}'`,
					StatusCode.CONSTRAINT,
				);
			}
			seen.add(hex);
		}

		// Pass 2 — re-scan and build the single atomic batch. Recompute each new key and
		// only rewrite rows whose key actually moves (`newKey !== oldKey`).
		const batch = store.batch();
		for await (const entry of store.iterate(bounds)) {
			const row = deserializeRow(entry.value);
			const newKey = computeNewKey(row);
			if (!bytesEqual(entry.key, newKey)) {
				batch.delete(entry.key);
				// NOTE: the row VALUE is unchanged, so `serializeRow(row)` reproduces
				// `entry.value` byte-for-byte. We re-serialize rather than reuse
				// `entry.value` to avoid retaining an iterator-owned buffer in the batch.
				// If re-key CPU ever shows up hot, reuse `entry.value` where the backend
				// guarantees the buffer is not reused across iteration.
				batch.put(newKey, serializeRow(row));
			}
		}
		await batch.write();
	}

	/**
	 * Migrate all stored rows from the old column layout to a new one.
	 * The remap array maps newColumnIndex -> oldColumnIndex | -1.
	 * -1 means the column is new (fill with defaultValue).
	 *
	 * `backfill`, when supplied (ADD COLUMN with a non-foldable DEFAULT such as
	 * `new.<col>`), derives the new column's value from each existing row instead of the
	 * single `defaultValue`, and rejects a NULL it produces for a NOT NULL column. The
	 * batch is only written once every row migrates, so a throwing evaluator / NOT NULL
	 * violation leaves the store untouched for the caller's rollback.
	 */
	async migrateRows(
		remap: number[],
		defaultValue: SqlValue,
		backfill?: { evaluator: (row: Row) => SqlValue | Promise<SqlValue>; notNull: boolean; columnName: string },
	): Promise<void> {
		const store = await this.ensureStore();
		const bounds = buildFullScanBounds();
		const batch = store.batch();

		for await (const entry of store.iterate(bounds)) {
			const oldRow = deserializeRow(entry.value);
			let newColumnValue = defaultValue;
			if (backfill) {
				newColumnValue = await backfill.evaluator(oldRow);
				if (backfill.notNull && newColumnValue === null) {
					throw new QuereusError(
						`NOT NULL constraint failed: backfilling column '${this.schemaName}.${this.tableName}.${backfill.columnName}' produced NULL for an existing row`,
						StatusCode.CONSTRAINT,
					);
				}
			}
			const newRow: Row = new Array(remap.length);
			for (let i = 0; i < remap.length; i++) {
				newRow[i] = remap[i] === -1 ? newColumnValue : oldRow[remap[i]];
			}
			batch.put(entry.key, serializeRow(newRow));
		}

		await batch.write();
	}

	/** Perform an update operation (INSERT, UPDATE, DELETE). */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		const store = await this.ensureStore();
		const coordinator = await this.ensureCoordinator();
		const inTransaction = coordinator.isInTransaction();
		const schema = this.tableSchema!;
		const { operation, values, oldKeyValues } = args;

		switch (operation) {
			case 'insert': {
				if (!values) throw new QuereusError('INSERT requires values', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const pk = this.extractPK(coerced);
				const key = this.encodeDataKey(pk);

				// Check for existing row (for conflict handling).
				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// Trusted-flush safety analysis — why this arm diverges from the others.
				// The insert arm's probe stays committed-only on the trusted-flush path,
				// while the update/delete arms below read the effective
				// (pending-over-committed) image UNCONDITIONALLY. That divergence is
				// safe: `flushOverlayToUnderlying` (isolation, isolated-table.ts) wraps
				// the flush in its own coordinator mini-transaction, the overlay holds
				// at most ONE entry per PK, and tombstone deletes are ordered before
				// inserts/updates — so when any flush write probes its own key, no
				// pending op exists at that key yet in the mini-transaction and the
				// effective read equals the committed read on every trusted probe. The
				// committed-only read kept here is therefore NOT a read-correctness
				// requirement but a pinned INTERNAL invariant: the flush routes existing
				// PKs to update, so a row present here is an isolation-layer violation we
				// must surface loudly (store-backing-host-substrate analysis).
				let existingRow: Row | null;
				if (args.trustedWrite) {
					const committed = await store.get(key);
					existingRow = committed ? deserializeRow(committed) : null;
				} else {
					existingRow = await this.readEffectiveRowByKey(key);
				}
				if (args.trustedWrite) {
					// Trusted flush insert: the overlay flush routes existing PKs to
					// update (via rowExistsInUnderlying), so a row already present here
					// is an isolation-layer invariant violation. Fail loudly rather than
					// silently overwrite — the flush try/catch rolls back and rethrows
					// (isolation-merged-unique-stale-underlying-false-positive).
					if (existingRow) {
						throw new QuereusError(
							`Trusted flush insert on '${this.tableName}' hit an existing PK; the overlay flush should route existing PKs to update. This indicates an isolation-layer invariant violation.`,
							StatusCode.INTERNAL,
						);
					}
				} else if (existingRow) {
					if (pkEffective === ConflictResolution.IGNORE) {
						return { status: 'ok', row: undefined };
					}
					if (pkEffective !== ConflictResolution.REPLACE) {
						return {
							status: 'constraint',
							constraint: 'unique',
							message: `UNIQUE constraint failed: ${this.tableName} PK.`,
							existingRow,
						};
					}
				}

				// Enforce non-PK UNIQUE constraints. Pass the original statement-level
				// onConflict so checkUniqueConstraints can resolve each UC's own
				// defaultConflict independently of the PK's default. Secondary-UNIQUE
				// REPLACE evictions accumulate in `evicted` for the executor pipeline.
				// Skipped for trusted flush writes: the overlay already validated the
				// final state and a value-swap cycle cannot pass a row-by-row re-check.
				const evicted: Row[] = [];
				if (!args.trustedWrite) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						[pk],
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				const oldRow = existingRow;
				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(key, serializedRow, store);
				} else {
					await store.put(key, serializedRow);
				}

				// Update secondary indexes. An effective `oldRow` (a pending row at the
				// same PK, evicted under REPLACE) cancels the earlier pending index-put;
				// a commit-batch delete of a never-committed index key is a harmless no-op.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, pk);

				// Track statistics (only count as new if not replacing)
				if (!existingRow) {
					this.trackMutation(+1, inTransaction);
				}

				// Queue or emit event
				if (oldRow) {
					// REPLACE — emit as update
					const updateEvent = {
						type: 'update' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						oldRow,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(updateEvent);
					} else {
						this.eventEmitter?.emitDataChange(updateEvent);
					}
				} else {
					const insertEvent = {
						type: 'insert' as const,
						schemaName: schema.schemaName,
						tableName: schema.name,
						key: pk,
						newRow: coerced,
					};
					if (inTransaction) {
						coordinator.queueEvent(insertEvent);
					} else {
						this.eventEmitter?.emitDataChange(insertEvent);
					}
				}

				return { status: 'ok', row: coerced, replacedRow: oldRow ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'update': {
				if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
				const coerced = args.preCoerced ? values : this.coerceRow(values);
				const oldPk = this.extractPK(oldKeyValues);
				const newPk = this.extractPK(coerced);
				const oldKey = this.encodeDataKey(oldPk);
				const newKey = this.encodeDataKey(newPk);

				// Get old row for index updates. Read the effective
				// (pending-over-committed) image UNCONDITIONALLY — including the trusted
				// flush path — so an old image written earlier in the same transaction is
				// visible. This fixes index cleanup, the `uniqueColumnsChanged` gate, and
				// the event's `oldRow`. Trusted is safe here (see the insert-arm comment):
				// deletes-first ordering + one-entry-per-PK ⇒ effective ≡ committed on a
				// flush write probing its own key.
				const oldRow = await this.readEffectiveRowByKey(oldKey);

				// A PK "change" only relocates the row when the ENCODED key differs.
				// Under a non-binary PK collation (e.g. NOCASE) a case-only rewrite
				// ('apple' → 'APPLE') keeps the same physical key, so it is an in-place
				// update, not a relocation. Comparing raw values via keysEqual would
				// mis-classify it as a move and then false-detect a PK conflict against
				// the row's own existing entry at newKey (== oldKey). The encoded keys
				// are the storage layer's source of truth (mirrors the rekey path above).
				const pkChanged = !bytesEqual(oldKey, newKey);

				// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
				const pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;

				// PK-change UPDATE collides like an INSERT at the new key.
				// Capture the evicted row so it can be reported via `replacedRow`
				// (consumed by the executor for ON DELETE cascade/SET NULL of the
				// row at the new PK). Read the effective (pending-over-committed) image
				// so an evictee written earlier in the same transaction conflicts/evicts
				// rather than being silently overwritten.
				// Skipped for trusted flush writes — the overlay flush never changes a
				// row's PK (oldKeyValues and the row's PK columns are the same overlay
				// entry), so pkChanged is false there; the guard makes the intent explicit.
				let replacedAtNewPk: Row | null = null;
				if (pkChanged && !args.trustedWrite) {
					const existingAtNewRow = await this.readEffectiveRowByKey(newKey);
					if (existingAtNewRow) {
						if (pkEffective === ConflictResolution.IGNORE) {
							return { status: 'ok', row: undefined };
						}
						if (pkEffective !== ConflictResolution.REPLACE) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: `UNIQUE constraint failed: ${this.tableName} PK.`,
								existingRow: existingAtNewRow,
							};
						}
						replacedAtNewPk = existingAtNewRow;
					}
				}

				// Enforce non-PK UNIQUE constraints. For same-PK UPDATE, only check
				// constraints whose covered columns actually changed; pass [oldPk]
				// (= newPk) to skip self. For PK-change UPDATE, treat as relocation:
				// skip both old and new PK so we don't false-conflict against the
				// row we're moving. Pass the original statement-level onConflict so
				// each UC's own defaultConflict can be resolved independently.
				const selfPks: SqlValue[][] = pkChanged ? [oldPk, newPk] : [oldPk];
				// Skip the UNIQUE re-check for trusted flush writes: the overlay
				// merged-view check already validated the final state, and a value-swap
				// cycle cannot pass a row-by-row logical-UNIQUE re-check
				// (isolation-merged-unique-stale-underlying-false-positive).
				const shouldCheckUniques = !args.trustedWrite
					&& (pkChanged || (oldRow ? this.uniqueColumnsChanged(oldRow, coerced) : true));
				// Secondary-UNIQUE REPLACE evictions accumulate for the executor pipeline.
				const evicted: Row[] = [];
				if (shouldCheckUniques) {
					const ucResult = await this.checkUniqueConstraints(
						inTransaction,
						coerced,
						selfPks,
						args.onConflict,
						evicted,
					);
					if (ucResult) return ucResult;
				}

				// When REPLACE evicted a row at the new PK, fully delete it first
				// (data + secondary indexes + row-count + delete event) so its
				// state doesn't leak when we then put the moved row at newPk.
				// Mirrors MemoryTable's `recordDelete(newPK, existingRowAtNewKey)`
				// step in the PK-change-REPLACE path.
				if (replacedAtNewPk) {
					await this.deleteRowAt(inTransaction, newPk, replacedAtNewPk);
				}

				// Delete old key if PK changed
				if (pkChanged) {
					if (inTransaction) {
						coordinator.delete(oldKey, store);
					} else {
						await store.delete(oldKey);
					}
				}

				const serializedRow = serializeRow(coerced);
				if (inTransaction) {
					coordinator.put(newKey, serializedRow, store);
				} else {
					await store.put(newKey, serializedRow);
				}

				// Update secondary indexes. For PK-change UPDATE the old entry lives
				// at oldPk and the new entry must land at newPk; for same-PK UPDATE
				// both halves use the same key.
				await this.updateSecondaryIndexes(inTransaction, oldRow, coerced, oldPk, newPk);

				// Queue or emit event
				const updateEvent = {
					type: 'update' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: newPk,
					oldRow: oldRow || undefined,
					newRow: coerced,
				};
				if (inTransaction) {
					coordinator.queueEvent(updateEvent);
				} else {
					this.eventEmitter?.emitDataChange(updateEvent);
				}

				return { status: 'ok', row: coerced, replacedRow: replacedAtNewPk ?? undefined, evictedRows: evicted.length > 0 ? evicted : undefined };
			}

			case 'delete': {
				if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
				const pk = this.extractPK(oldKeyValues);
				const key = this.encodeDataKey(pk);

				// Get old row for index cleanup. Read the effective
				// (pending-over-committed) image so a row inserted earlier in the same
				// transaction is seen: this fixes index cleanup, the `-1` stats delta
				// (netting an insert+delete to zero), and the event's `oldRow`.
				// `coordinator.delete(key)` cancels a pending put; a commit-batch delete
				// of a never-committed key is a harmless no-op. The trusted flush delete
				// arm does NOT pass `trustedWrite`, but deletes-first ordering +
				// one-entry-per-PK keep effective ≡ committed there too (see insert arm).
				const oldRow = await this.readEffectiveRowByKey(key);

				if (inTransaction) {
					coordinator.delete(key, store);
				} else {
					await store.delete(key);
				}

				// Remove from secondary indexes
				if (oldRow) {
					await this.updateSecondaryIndexes(inTransaction, oldRow, null, pk);
					this.trackMutation(-1, inTransaction);
				}

				// Queue or emit event
				const deleteEvent = {
					type: 'delete' as const,
					schemaName: schema.schemaName,
					tableName: schema.name,
					key: pk,
					oldRow: oldRow || undefined,
				};
				if (inTransaction) {
					coordinator.queueEvent(deleteEvent);
				} else {
					this.eventEmitter?.emitDataChange(deleteEvent);
				}

				return { status: 'ok', row: oldRow || undefined };
			}

			default:
				throw new QuereusError(`Unknown operation: ${operation}`, StatusCode.MISUSE);
		}
	}

	/**
	 * Apply externally-originated row ops directly to this source table's
	 * COMMITTED storage: table-owned data-key put/delete, secondary-index
	 * maintenance, and stats tracking. The index-maintaining counterpart of
	 * `StoreBackingHost.applyMaintenance` (which targets index-less MV backings),
	 * built for trusted replication-style writes.
	 *
	 * Deliberately:
	 *   - emits NO module {@link DataChangeEvent}s — the external writer owns
	 *     emission and the `remote` flag;
	 *   - opens NO coordinator transaction — writes land in committed state
	 *     immediately (`store.put`/`store.delete`, never the coordinator);
	 *   - runs NO constraint validation (PK/UNIQUE/CHECK/FK) — the origin is
	 *     trusted, mirroring the backing-host posture.
	 *
	 * Returns the EFFECTIVE per-op {@link BackingRowChange}s with accurate
	 * before-images (the shape `Database.ingestExternalRowChanges` consumes),
	 * suppressing no-ops to match the normative upsert-suppression contract in
	 * `vtab/backing-host.ts`: a delete of an absent key, and a value-identical
	 * upsert (`rowsValueIdentical` — byte-faithful, collation-UNAWARE, against the
	 * effective existing row) write nothing and report nothing. A collation-equal /
	 * byte-different upsert (e.g. a case-only rewrite under a NOCASE PK) keeps the
	 * SAME data key (key identity is collation-aware) but IS a real update that
	 * replaces the stored bytes and reports `update`.
	 *
	 * Last-writer-wins against any concurrently pending local transaction on this
	 * table: the external write commits to storage at once, and that transaction's
	 * pending batch may overwrite these keys when it commits. This is the same
	 * posture the prior raw-KV sync adapter took — not a regression, now stated.
	 */
	async applyExternalRowChanges(ops: readonly ExternalRowOp[]): Promise<BackingRowChange[]> {
		const changes: BackingRowChange[] = [];
		if (ops.length === 0) return changes;

		// Route through the lazy store-open path so the first external write to a
		// freshly created table persists its DDL exactly like a first vtab write.
		const store = await this.ensureStore();

		for (const op of ops) {
			switch (op.op) {
				case 'delete': {
					const key = this.encodeDataKey(op.pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (!existing) break; // absent key → no storage/index/stats op, nothing reported
					await store.delete(key);
					await this.updateSecondaryIndexes(false, existing, null, op.pk);
					this.trackMutation(-1, false);
					changes.push({ op: 'delete', oldRow: existing });
					break;
				}
				case 'upsert': {
					const pk = this.extractPK(op.row);
					const key = this.encodeDataKey(pk);
					const existing = await this.readEffectiveRowByKey(key);
					if (existing && rowsValueIdentical(existing, op.row)) {
						// Byte-identical to the effective row → a true no-op: no write, no
						// index touch, no stats delta, nothing reported (echo-prevention seam).
						break;
					}
					await store.put(key, serializeRow(op.row));
					// PK derives from the row, so the key never relocates: oldPk == newPk.
					await this.updateSecondaryIndexes(false, existing, op.row, pk);
					if (!existing) this.trackMutation(+1, false);
					changes.push(existing
						? { op: 'update', oldRow: existing, newRow: op.row }
						: { op: 'insert', newRow: op.row });
					break;
				}
				default: {
					// A new ExternalRowOp variant must extend this switch; never-assignment
					// makes that a compile error rather than a silent no-op.
					const exhaustiveCheck: never = op;
					throw new QuereusError(`Unknown external row op: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
				}
			}
		}
		return changes;
	}
}
