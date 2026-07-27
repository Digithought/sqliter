/**
 * Streaming snapshot operations.
 *
 * Handles chunked snapshot generation, application, and checkpoint
 * management for memory-efficient sync of large databases.
 */

import type { SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import { assertWithinDrift } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { deserializeColumnVersion } from '../metadata/column-version.js';
import { deserializeTombstone } from '../metadata/tombstones.js';
import { deserializeMigration } from '../metadata/schema-migration.js';
import {
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	buildAllChangeLogScanBounds,
	buildTableColumnVersionScanBounds,
	parseColumnVersionKey,
	parseSchemaMigrationKey,
	parseTombstoneKey,
	parseChangeLogKey,
} from '../metadata/keys.js';
import type { SnapshotCheckpoint } from './manager.js';
import type {
	SnapshotChunk,
	SnapshotProgress,
	SnapshotHeaderChunk,
	SnapshotTableStartChunk,
	SnapshotColumnVersionsChunk,
	SnapshotTombstoneChunk,
	SnapshotTableEndChunk,
	SnapshotSchemaMigrationChunk,
	SnapshotFooterChunk,
	DataChangeToApply,
	SchemaChangeToApply,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, toError } from './sync-context.js';
import { applyDataToStore } from './admission.js';

/** Default chunk size for streaming snapshots. */
const DEFAULT_SNAPSHOT_CHUNK_SIZE = 1000;

/** Key prefix for snapshot checkpoints. */
const CHECKPOINT_PREFIX = 'sc:';

/**
 * Row changes `applySnapshotStream` accumulates before pushing them to the store.
 *
 * Exported so specs that must exceed this bound (to exercise a mid-table flush)
 * derive their row counts from it rather than restating the literal.
 */
export const DATA_FLUSH_SIZE = 100;

// ============================================================================
// Snapshot Generation
// ============================================================================

/**
 * Options for the shared snapshot streaming generator.
 */
interface StreamSnapshotOptions {
	snapshotId: string;
	siteId: SiteId;
	hlc: HLC;
	chunkSize: number;
	/** Tables to skip (already completed in a resumed transfer). */
	completedTables?: Set<string>;
	/** Initial entry count (for resumed transfers). */
	initialEntryCount?: number;
}

/** Assemble one tombstone chunk for a `(schema, table)` batch of entries. */
function buildTombstoneChunk(
	schema: string,
	table: string,
	entries: Array<SnapshotTombstoneChunk['entries'][number]>,
): SnapshotTombstoneChunk {
	return { type: 'tombstone', schema, table, entries };
}

/**
 * Shared generator that streams snapshot chunks.
 *
 * Both `getSnapshotStream` and `resumeSnapshotStream` delegate here,
 * differing only in initial parameters (skip set, identity source, entry count).
 */
async function* streamSnapshotChunks(
	ctx: SyncContext,
	opts: StreamSnapshotOptions,
): AsyncIterable<SnapshotChunk> {
	const { snapshotId, siteId, hlc, chunkSize, completedTables, initialEntryCount } = opts;
	const completedSet = completedTables ?? new Set<string>();

	// Count tables and migrations for header
	const tableKeys = new Map<string, { schema: string; table: string }>();
	const cvBounds = buildAllColumnVersionsScanBounds();
	for await (const entry of ctx.kv.iterate(cvBounds)) {
		const parsed = parseColumnVersionKey(entry.key);
		if (parsed) tableKeys.set(`${parsed.schema}.${parsed.table}`, { schema: parsed.schema, table: parsed.table });
	}

	let migrationCount = 0;
	const smBounds = buildAllSchemaMigrationsScanBounds();
	for await (const _entry of ctx.kv.iterate(smBounds)) {
		migrationCount++;
	}

	// Yield header
	const header: SnapshotHeaderChunk = {
		type: 'header',
		siteId,
		hlc,
		tableCount: tableKeys.size,
		migrationCount,
		snapshotId,
	};
	yield header;

	// Stream schema migrations BEFORE any table data. The receiver flushes accumulated
	// rows to the store every DATA_FLUSH_SIZE entries, so a table with more rows than
	// that bound would otherwise reach the store before its `create table` did — and on
	// a receiver that does not already have the table, every row in that early flush
	// fails. DDL-first makes the streaming bootstrap work for tables of any size;
	// `applySnapshotStream` depends on this order.
	for await (const entry of ctx.kv.iterate(smBounds)) {
		const parsed = parseSchemaMigrationKey(entry.key);
		if (!parsed) continue;

		const migration = deserializeMigration(entry.value);
		const migrationChunk: SnapshotSchemaMigrationChunk = {
			type: 'schema-migration',
			migration: {
				type: migration.type,
				schema: parsed.schema,
				table: parsed.table,
				ddl: migration.ddl,
				hlc: migration.hlc,
				schemaVersion: migration.schemaVersion,
			},
		};
		yield migrationChunk;
	}

	// Stream each table, skipping completed ones
	let totalEntries = initialEntryCount ?? 0;
	for (const [tableKey, { schema, table }] of tableKeys) {
		if (completedSet.has(tableKey)) continue;

		const tableCvBounds = buildTableColumnVersionScanBounds(schema, table);

		// Yield table start (entry count filled in at table-end)
		const tableStart: SnapshotTableStartChunk = {
			type: 'table-start',
			schema,
			table,
			estimatedEntries: 0,
		};
		yield tableStart;

		// Stream column versions in chunks (single pass per table)
		let entries: Array<[string, HLC, SqlValue, SqlValue[]]> = [];
		let entriesWritten = 0;

		for await (const entry of ctx.kv.iterate(tableCvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			// versionKey groups one row's cells by pk IDENTITY (lossy); the raw pk
			// travels as the tuple's 4th element (from the record value).
			const versionKey = `${parsed.identity}:${parsed.column}`;
			entries.push([versionKey, cv.hlc, cv.value, cv.pk]);
			entriesWritten++;

			if (entries.length >= chunkSize) {
				const chunk: SnapshotColumnVersionsChunk = {
					type: 'column-versions',
					schema,
					table,
					entries,
				};
				yield chunk;
				entries = [];
			}
		}

		// Yield remaining entries
		if (entries.length > 0) {
			const chunk: SnapshotColumnVersionsChunk = {
				type: 'column-versions',
				schema,
				table,
				entries,
			};
			yield chunk;
		}

		// Yield table end
		const tableEnd: SnapshotTableEndChunk = {
			type: 'table-end',
			schema,
			table,
			entriesWritten,
		};
		yield tableEnd;

		totalEntries += entriesWritten;
	}

	// Stream tombstones — a GLOBAL pass over every tombstone (not a per-`tableKeys`
	// pass), batched by `(schema, table)` into `chunkSize` chunks. A row whose columns
	// were all deleted has a tombstone but no live column-versions, so its table may be
	// absent from `tableKeys`; the global pass carries it regardless. The scan is
	// key-sorted, so all tombstones for one `(schema, table)` are contiguous (the
	// `tb:{schema}.{table}:` prefix + `:` separator guarantee no interleaving) — a fresh
	// chunk starts whenever the table changes or the batch fills.
	// NOTE: on a RESUMED transfer this re-emits ALL tombstones regardless of the
	// checkpoint's completed tables (tombstones are not tracked per-table there). The
	// consumer re-writes them idempotently (same key, same bytes) — a deliberate
	// simplification (correctness over minimal bytes), not a bug.
	const tsBounds = buildAllTombstonesScanBounds();
	let tsEntries: Array<SnapshotTombstoneChunk['entries'][number]> = [];
	let tsSchema: string | undefined;
	let tsTable: string | undefined;

	for await (const entry of ctx.kv.iterate(tsBounds)) {
		const parsed = parseTombstoneKey(entry.key);
		if (!parsed) continue;

		// Table boundary: flush the prior table's accumulated entries first.
		if (parsed.schema !== tsSchema || parsed.table !== tsTable) {
			if (tsEntries.length > 0 && tsSchema !== undefined && tsTable !== undefined) {
				yield buildTombstoneChunk(tsSchema, tsTable, tsEntries);
			}
			tsEntries = [];
			tsSchema = parsed.schema;
			tsTable = parsed.table;
		}

		const tombstone = deserializeTombstone(entry.value);
		tsEntries.push({
			pk: tombstone.pk,
			identity: parsed.identity,
			hlc: tombstone.hlc,
			createdAt: tombstone.createdAt,
			...(tombstone.priorRow !== undefined ? { priorRow: tombstone.priorRow } : {}),
		});

		if (tsEntries.length >= chunkSize) {
			yield buildTombstoneChunk(tsSchema, tsTable, tsEntries);
			tsEntries = [];
		}
	}
	if (tsEntries.length > 0 && tsSchema !== undefined && tsTable !== undefined) {
		yield buildTombstoneChunk(tsSchema, tsTable, tsEntries);
	}

	// Yield footer
	const footer: SnapshotFooterChunk = {
		type: 'footer',
		snapshotId,
		totalTables: tableKeys.size,
		totalEntries,
		totalMigrations: migrationCount,
	};
	yield footer;
}

/**
 * Stream a snapshot as chunks for memory-efficient transfer.
 */
export async function* getSnapshotStream(
	ctx: SyncContext,
	chunkSize: number = DEFAULT_SNAPSHOT_CHUNK_SIZE,
): AsyncIterable<SnapshotChunk> {
	yield* streamSnapshotChunks(ctx, {
		snapshotId: crypto.randomUUID(),
		siteId: ctx.getSiteId(),
		hlc: ctx.getCurrentHLC(),
		chunkSize,
	});
}

/**
 * Resume a snapshot transfer from a checkpoint.
 */
export async function* resumeSnapshotStream(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): AsyncIterable<SnapshotChunk> {
	yield* streamSnapshotChunks(ctx, {
		snapshotId: checkpoint.snapshotId,
		siteId: checkpoint.siteId,
		hlc: checkpoint.hlc,
		chunkSize: DEFAULT_SNAPSHOT_CHUNK_SIZE,
		completedTables: new Set(checkpoint.completedTables),
		initialEntryCount: checkpoint.entriesProcessed,
	});
}

// ============================================================================
// Snapshot Application
// ============================================================================

/**
 * Parse the accumulated `schema.table` completed-table keys into the
 * `{ schema, table }` records the `bootstrapFinalize` coarse watch notification
 * consumes.
 *
 * NOTE: `completedTables` is a flat string, persisted verbatim into
 * `SnapshotCheckpoint.completedTables` — on a resumed transfer the original
 * `chunk.schema`/`chunk.table` pair for an earlier-session table is gone, so
 * there is no already-known pair to carry forward here (unlike the other
 * `tableKey`-grouping sites in this module). Splitting on the FIRST dot only
 * correctly recovers a dotted TABLE name; a dotted SCHEMA name is an accepted
 * edge case (schema names are effectively never dotted) — same tradeoff as
 * `buildDataStoreName` in `@quereus/store`'s key-builder.ts.
 */
function parseBootstrapTables(
	completedTables: ReadonlyArray<string>,
): Array<{ schema: string; table: string }> {
	return completedTables.map((key) => {
		const dot = key.indexOf('.');
		if (dot === -1) return { schema: key, table: '' };
		return { schema: key.slice(0, dot), table: key.slice(dot + 1) };
	});
}

/**
 * Clear existing CRDT metadata (column versions, tombstones, change log) ahead
 * of applying a snapshot.
 *
 * `preserveTables` names `schema.table` keys whose metadata must survive — on a
 * resumed transfer the sender skips already-completed tables and never re-emits
 * their metadata, so blanket-clearing would wipe state that is never rewritten.
 * With an empty `preserveTables` this deletes everything, identical to a fresh
 * full apply.
 */
async function clearExistingMetadata(
	ctx: SyncContext,
	preserveTables: ReadonlySet<string>,
): Promise<void> {
	const clearBatch = ctx.kv.batch();

	for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) {
		const parsed = parseColumnVersionKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
		const parsed = parseTombstoneKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds())) {
		const parsed = parseChangeLogKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}

	await clearBatch.write();
}

/**
 * Apply a streamed snapshot, processing chunks as they arrive.
 */
export async function applySnapshotStream(
	ctx: SyncContext,
	chunks: AsyncIterable<SnapshotChunk>,
	onProgress?: (progress: SnapshotProgress) => void,
): Promise<void> {
	let snapshotId: string | undefined;
	let snapshotHLC: HLC | undefined;
	let totalTables = 0;
	let totalEntries = 0;
	let tablesProcessed = 0;
	let entriesProcessed = 0;
	let currentTable: string | undefined;
	const completedTables: string[] = [];

	// Pending data to apply to store (batched for efficiency)
	let pendingDataChanges: DataChangeToApply[] = [];
	let pendingSchemaChanges: SchemaChangeToApply[] = [];

	const flushDataToStore = async (): Promise<void> => {
		// A streamed snapshot is a known-complete wholesale load: each flush is a
		// bootstrap flush (the adapter skips the engine seam — no per-flush MV
		// maintenance, no per-row watch capture), converged once by the footer's
		// `bootstrapFinalize` below. Streaming keeps its checkpoint-based model but
		// reuses the shared data-apply seam: a whole-batch throw OR a per-change
		// storage failure emits `status:'error'` and aborts the stream mid-flight,
		// before the footer emits `status:'synced'` / clears the checkpoint — so the
		// checkpoint stays in place and the transfer resumes/retries.
		await applyDataToStore(ctx, pendingDataChanges, pendingSchemaChanges, { remote: true, bootstrap: true });
		pendingDataChanges = [];
		pendingSchemaChanges = [];
	};

	// Process chunks
	let batch = ctx.kv.batch();
	let batchSize = 0;
	const BATCH_FLUSH_SIZE = 1000;

	// Flush the accumulated metadata batch and (on a live transfer) save a resume
	// checkpoint. Shared by the column-version and tombstone chunk handlers so both
	// honor the same BATCH_FLUSH_SIZE bound and checkpoint cadence.
	const flushMetadataBatch = async (): Promise<void> => {
		await batch.write();
		batch = ctx.kv.batch();
		batchSize = 0;

		if (snapshotId && snapshotHLC) {
			await saveSnapshotCheckpoint(ctx, {
				snapshotId,
				siteId: ctx.getSiteId(),
				hlc: snapshotHLC,
				lastTableIndex: tablesProcessed,
				lastEntryIndex: entriesProcessed,
				completedTables: [...completedTables],
				entriesProcessed,
				createdAt: Date.now(),
			});
		}
	};

	let currentTableSchema: string | undefined;
	let currentTableName: string | undefined;
	const rowColumns = new Map<string, Record<string, SqlValue>>();
	// Raw pk per row-grouping key (the versionKey's identity prefix is lossy, so
	// the applicable pk is taken from the entries themselves).
	const rowPks = new Map<string, SqlValue[]>();

	for await (const chunk of chunks) {
		switch (chunk.type) {
			case 'header': {
				snapshotId = chunk.snapshotId;
				snapshotHLC = chunk.hlc;
				totalTables = chunk.tableCount;

				// Pre-commit drift validation: reject a snapshot whose header HLC is beyond
				// the drift bound BEFORE clearing local metadata or applying any chunk — so a
				// far-future peer cannot wipe the receiver's state or land poison LWW winners.
				// The footer's `receive(snapshotHLC)` then merges a known-in-bound clock. Emit
				// `status:'error'` first for parity with the data-apply failure path.
				try {
					assertWithinDrift(chunk.hlc.wallTime, BigInt(Date.now()));
				} catch (error) {
					ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
					throw error;
				}

				// On a resumed transfer the sender skips tables it already streamed and
				// never re-emits their metadata. Look up the persisted checkpoint (saved
				// under this snapshotId during the prior pass) and preserve those completed
				// tables through the up-front clear; otherwise their column-version /
				// change-log state would be wiped and never rewritten. Seed the local
				// counters from the checkpoint so mid-stream checkpoint saves stay
				// monotonic and progress reporting reflects the full transfer.
				const checkpoint = snapshotId ? await getSnapshotCheckpoint(ctx, snapshotId) : undefined;
				if (checkpoint) {
					completedTables.push(...checkpoint.completedTables);
					tablesProcessed = checkpoint.completedTables.length;
					entriesProcessed = checkpoint.entriesProcessed;
				}
				await clearExistingMetadata(ctx, new Set(completedTables));
				break;
			}

			case 'table-start':
				// The sender emits every schema migration before the first `table-start`,
				// so reaching one means the migration section has ended: push the pending
				// DDL to the store now, ahead of any row that a mid-table DATA_FLUSH_SIZE
				// flush would otherwise deliver to a table that does not exist yet. Later
				// `table-start`s find nothing pending and this is a no-op (`applyDataToStore`
				// returns early when both pending arrays are empty).
				// NOTE: this trusts the CHUNK ORDER, which outlives the sender process — the
				// coordinator gzips a chunk array into S3 (`s3-snapshot-store.ts`) and replays
				// it here on restore, so a snapshot written before DDL-first ordering still
				// fails on a table larger than DATA_FLUSH_SIZE, exactly as before. Acceptable
				// while backwards compat is out of scope; if it ever matters, either
				// re-generate stored snapshots on upgrade or have the receiver buffer all data
				// until the footer — the memory tradeoff the streaming path exists to avoid.
				await flushDataToStore();

				currentTable = `${chunk.schema}.${chunk.table}`;
				currentTableSchema = chunk.schema;
				currentTableName = chunk.table;
				totalEntries += chunk.estimatedEntries;
				rowColumns.clear();
				rowPks.clear();
				break;

			case 'column-versions':
				for (const [versionKey, hlc, value, pk] of chunk.entries) {
					const lastColon = versionKey.lastIndexOf(':');
					if (lastColon === -1) continue;

					const rowKey = versionKey.slice(0, lastColon);
					const column = versionKey.slice(lastColon + 1);

					// Track column (and the row's raw pk) for data application
					if (!rowColumns.has(rowKey)) {
						rowColumns.set(rowKey, {});
						rowPks.set(rowKey, pk);
					}
					rowColumns.get(rowKey)![column] = value;

					// Write CRDT metadata under the SENDER's identity (the rowKey prefix):
					// the receiving table may not exist yet — its schema arrives in this
					// same snapshot — so no local keying can be resolved, and the
					// replicated schema makes both sides' identities agree.
					ctx.columnVersions.setColumnVersionByIdentityBatch(
						batch,
						chunk.schema,
						chunk.table,
						rowKey,
						pk,
						column,
						{ hlc, value },
					);

					ctx.changeLog.recordColumnChangeByIdentityBatch(
						batch,
						hlc,
						chunk.schema,
						chunk.table,
						rowKey,
						column,
					);

					batchSize++;
					entriesProcessed++;

					if (batchSize >= BATCH_FLUSH_SIZE) {
						await flushMetadataBatch();
					}
				}

				if (onProgress && snapshotId) {
					onProgress({
						snapshotId,
						tablesProcessed,
						totalTables,
						entriesProcessed,
						totalEntries,
						currentTable,
					});
				}
				break;

			case 'tombstone':
				// Tombstones are pure CRDT metadata: write each into the same batch as
				// column-versions, honoring the shared BATCH_FLUSH_SIZE / checkpoint path.
				// There is NO store data for a deleted row, so nothing is pushed to
				// `pendingDataChanges`. `clearExistingMetadata` already ran at `header`, so
				// these writes repopulate the just-cleared tombstone space.
				for (const { pk, identity, hlc, priorRow } of chunk.entries) {
					// Sender-identity write (the receiving table may not exist yet — see the
					// column-versions handler).
					// NOTE: the write stamps `createdAt = Date.now()` internally and ignores
					// the sender's `entry.createdAt`, so a bootstrapped tombstone's TTL
					// horizon is re-based to bootstrap time rather than preserved. Acceptable
					// for phase 1 (the tombstone lives a full horizon from bootstrap).
					ctx.tombstones.setTombstoneByIdentityBatch(batch, chunk.schema, chunk.table, identity, pk, hlc, priorRow);

					batchSize++;
					if (batchSize >= BATCH_FLUSH_SIZE) {
						await flushMetadataBatch();
					}
				}
				break;

			case 'table-end':
				// Flush accumulated rows to store
				if (currentTableSchema && currentTableName) {
					for (const [rowKey, columns] of rowColumns) {
						pendingDataChanges.push({
							type: 'update',
							schema: currentTableSchema,
							table: currentTableName,
							pk: rowPks.get(rowKey)!,
							columns,
						});

						if (pendingDataChanges.length >= DATA_FLUSH_SIZE) {
							await flushDataToStore();
						}
					}
					rowColumns.clear();
					rowPks.clear();
				}

				tablesProcessed++;
				if (currentTable) {
					completedTables.push(currentTable);
				}
				break;

			case 'schema-migration': {
				const migration = chunk.migration;
				pendingSchemaChanges.push({
					type: migration.type,
					schema: migration.schema,
					table: migration.table,
					ddl: migration.ddl,
				});

				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
				break;
			}

			case 'footer':
				// Flush remaining data to store
				await flushDataToStore();

				// Flush remaining metadata batch
				if (batchSize > 0) {
					await batch.write();
				}

				// Update HLC
				if (snapshotHLC) {
					ctx.hlcManager.receive(snapshotHLC);
					await persistHLCState(ctx);
				}

				// Converge the bootstrap: the flushes deferred MV maintenance and watch
				// capture, so converge every MV once and coarse-notify each bootstrapped
				// table's watchers. Issued BEFORE clearing the checkpoint — a finalize
				// failure leaves the checkpoint in place so the transfer retries (storage
				// rows are already applied, so the retry's finalize rebuilds cleanly).
				// `completedTables` is the full set even on a resumed transfer (seeded
				// from the checkpoint in the `header` case).
				if (ctx.applyToStore) {
					await ctx.applyToStore([], [], {
						remote: true,
						bootstrapFinalize: true,
						bootstrapTables: parseBootstrapTables(completedTables),
					});
				}

				// Clear checkpoint
				if (snapshotId) {
					await clearSnapshotCheckpoint(ctx, snapshotId);
				}

				// Emit sync state change
				if (snapshotHLC) {
					ctx.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshotHLC });
				}
				break;
		}
	}
}

// ============================================================================
// Checkpoint Management
// ============================================================================
//
// NOTE: the AT-REST encoding below (wallTime as a decimal string, siteId as a
// number array) is deliberately NOT the wire encoding. The wire form is
// `SerializedSnapshotCheckpoint` in `wire.ts` (both binary fields as base64),
// used by the `resume_snapshot` message. Two encodings for one type is a wart,
// but unifying them is a stored-format migration: existing `sc:` records would
// have to be read under both shapes. If checkpoint storage is ever reworked for
// another reason, fold it onto the wire codec then.

/**
 * Retrieve a saved checkpoint for an in-progress snapshot.
 */
export async function getSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<SnapshotCheckpoint | undefined> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
	const data = await ctx.kv.get(key);
	if (!data) return undefined;

	const json = new TextDecoder().decode(data);
	const obj = JSON.parse(json);

	return {
		...obj,
		hlc: {
			wallTime: BigInt(obj.hlc.wallTime),
			counter: obj.hlc.counter,
			siteId: new Uint8Array(obj.hlc.siteId),
			opSeq: obj.hlc.opSeq ?? 0,
		},
		siteId: new Uint8Array(obj.siteId),
	};
}

/**
 * Save a checkpoint during a streaming snapshot apply.
 */
async function saveSnapshotCheckpoint(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): Promise<void> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${checkpoint.snapshotId}`);
	const json = JSON.stringify({
		...checkpoint,
		hlc: {
			wallTime: checkpoint.hlc.wallTime.toString(),
			counter: checkpoint.hlc.counter,
			siteId: Array.from(checkpoint.hlc.siteId),
			opSeq: checkpoint.hlc.opSeq,
		},
		siteId: Array.from(checkpoint.siteId),
	});
	await ctx.kv.put(key, new TextEncoder().encode(json));
}

/**
 * Clear checkpoint after a snapshot completes successfully.
 */
async function clearSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<void> {
	const key = new TextEncoder().encode(`${CHECKPOINT_PREFIX}${snapshotId}`);
	await ctx.kv.delete(key);
}
