/**
 * Streaming snapshot operations.
 *
 * Handles chunked snapshot generation, application, and checkpoint
 * management for memory-efficient sync of large databases.
 */

import type { Row, SqlValue } from '@quereus/quereus';
import { bytesEqual } from '@quereus/store';
import type { HLC } from '../clock/hlc.js';
import { assertWithinDrift } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { deserializeColumnVersion } from '../metadata/column-version.js';
import { deserializeTombstone } from '../metadata/tombstones.js';
import {
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllChangeLogScanBounds,
	buildAllSnapshotCheckpointScanBounds,
	buildSnapshotCheckpointKey,
	buildTableColumnVersionScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	parseChangeLogKey,
	encodePkIdentity,
} from '../metadata/keys.js';
import type { SnapshotCheckpoint } from './manager.js';
import {
	SNAPSHOT_WIRE_FORMAT_VERSION,
	type SnapshotChunk,
	type SnapshotProgress,
	type SnapshotHeaderChunk,
	type SnapshotTableStartChunk,
	type SnapshotColumnVersionsChunk,
	type SnapshotTombstoneChunk,
	type SnapshotTableEndChunk,
	type SnapshotSchemaMigrationChunk,
	type SnapshotFooterChunk,
	type ColumnVersionEntry,
	type DataChangeToApply,
	type SchemaMigration,
	migrationObjectKind,
	sortMigrationsByHLC,
	toSchemaChange,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, toError } from './sync-context.js';
import {
	createSnapshotKeyingResolver,
	keepMaxHLC,
	reconcileCell,
	type ReconciledRow,
} from './snapshot-identity.js';
import { applyDataToStore } from './admission.js';

/** Default chunk size for streaming snapshots. */
const DEFAULT_SNAPSHOT_CHUNK_SIZE = 1000;

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

	// Collect migrations up front — the header needs their count anyway, and they must
	// be emitted in causal order rather than `sm:` scan order (see `listAllMigrations`).
	// NOTE: this holds the whole migration set in memory; one record per DDL statement
	// ever run, so it is small next to the row data this same generator streams. If a
	// replica's DDL history ever grows enough to matter, keep an HLC-ordered index over
	// `sm:` and stream from that instead.
	const migrations = await ctx.schemaMigrations.listAllMigrations();
	const migrationCount = migrations.length;

	// Yield header
	const header: SnapshotHeaderChunk = {
		type: 'header',
		siteId,
		hlc,
		snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
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
	for (const migration of migrations) {
		const migrationChunk: SnapshotSchemaMigrationChunk = { type: 'schema-migration', migration };
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
		let entries: ColumnVersionEntry[] = [];
		let entriesWritten = 0;

		for await (const entry of ctx.kv.iterate(tableCvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			// Only the raw pk (the row's address, from the record value) travels; the
			// sender's key identity stays local — the receiver derives its own.
			entries.push({ column: parsed.column, hlc: cv.hlc, value: cv.value, pk: cv.pk });
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
	// key-sorted, so all tombstones for one `(schema, table)` are contiguous: every
	// `tb:` key opens with that pair LENGTH-PREFIXED (`tb:{n}:{schema}{n}:{table}…`),
	// so one table's keys share an exact byte prefix that no other table's key can
	// start with — no interleaving is possible, even between tables named `a` and
	// `a:b`. A fresh chunk starts whenever the table changes or the batch fills.
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

	// Tables whose `table-end` arrived but whose trailing rows may still sit in
	// `pendingDataChanges`. They graduate into `completedTables` only once
	// `applyDataToStore` has returned — a checkpoint naming a table whose last rows
	// are still in memory tells the sender to skip that table on resume, and those
	// rows are then never sent, never reconciled, and never reported.
	let stagedCompletedTables: string[] = [];

	// Pending data to apply to store (batched for efficiency)
	let pendingDataChanges: DataChangeToApply[] = [];
	// Held as full migrations, not `SchemaChangeToApply`, so the flush can re-order
	// them causally instead of trusting the sender's chunk order — DDL replays in
	// list order and `create index` needs its table's `create table` to have run.
	let pendingSchemaMigrations: SchemaMigration[] = [];

	const flushDataToStore = async (): Promise<void> => {
		// A streamed snapshot is a known-complete wholesale load: each flush is a
		// bootstrap flush (the adapter skips the engine seam — no per-flush MV
		// maintenance, no per-row watch capture), converged once by the footer's
		// `bootstrapFinalize` below. Streaming keeps its checkpoint-based model but
		// reuses the shared data-apply seam: a whole-batch throw OR a per-change
		// storage failure emits `status:'error'` and aborts the stream mid-flight,
		// before the footer emits `status:'synced'` / clears the checkpoint — so the
		// checkpoint stays in place and the transfer resumes/retries.
		const schemaChanges = sortMigrationsByHLC(pendingSchemaMigrations).map(toSchemaChange);
		await applyDataToStore(ctx, pendingDataChanges, schemaChanges, { remote: true, bootstrap: true });
		pendingDataChanges = [];
		pendingSchemaMigrations = [];
		completedTables.push(...stagedCompletedTables);
		stagedCompletedTables = [];
	};

	// Process chunks
	let batch = ctx.kv.batch();
	let batchSize = 0;
	const BATCH_FLUSH_SIZE = 1000;

	// The checkpoint record for the apply's CURRENT position. Both save sites — the
	// header-time save that opens the resumable window, and every metadata-batch
	// flush below — build it here so the two cannot drift.
	const buildCheckpointRecord = (id: string, hlc: HLC): SnapshotCheckpoint => ({
		snapshotId: id,
		// NOTE: this is the RECEIVER's site id, but `resumeSnapshotStream` stamps it
		// into the resumed stream's header, where a fresh stream puts the sender's.
		// Inert today (nothing reads `header.siteId`); see the second arm of
		// bug-sync-resume-snapshot-unvalidated-checkpoint before any consumer appears.
		siteId: ctx.getSiteId(),
		hlc,
		// NOTE: nothing reads these two — resume keys off `completedTables` alone.
		// `tablesProcessed` counts `table-end`s, so it can exceed
		// `completedTables.length` while tables are staged; if a resume path ever
		// starts seeking by index, derive it from `completedTables`, not from here.
		lastTableIndex: tablesProcessed,
		lastEntryIndex: entriesProcessed,
		completedTables: [...completedTables],
		entriesProcessed,
		createdAt: Date.now(),
	});

	// Flush the accumulated metadata batch and (on a live transfer) save a resume
	// checkpoint. Shared by the column-version and tombstone chunk handlers so both
	// honor the same BATCH_FLUSH_SIZE bound and checkpoint cadence.
	const flushMetadataBatch = async (): Promise<void> => {
		await batch.write();
		batch = ctx.kv.batch();
		batchSize = 0;

		if (snapshotId && snapshotHLC) {
			await saveSnapshotCheckpoint(ctx, buildCheckpointRecord(snapshotId, snapshotHLC));
		}
	};

	let currentTableSchema: string | undefined;
	let currentTableName: string | undefined;

	// Per-table pk keying, resolved lazily AFTER the table's DDL reached the store
	// (all schema migrations precede table data in the stream; the first
	// `table-start` flushes them, so the table exists by the time its entries
	// arrive).
	const resolveKeying = createSnapshotKeyingResolver(ctx);

	// One table section's cells, keyed by the RECEIVER's derived pk identity —
	// never the sender's grouping (see `reconcileCell`).
	// NOTE: the memory bound is one table's live cells — the bound the
	// pre-reconciliation accumulator already carried, at a higher constant (an
	// HLC per cell, not just its value). If a very wide table ever strains this,
	// reconcile per column-versions chunk rather than per table section.
	const tableRows = new Map<string, ReconciledRow>();

	// Tombstones for the CURRENT tombstone table, keyed by derived identity,
	// greatest HLC per identity. NOTE: flushed when the incoming chunk's
	// (schema, table) changes — correct ONLY because the producer's `tb:` scan is
	// key-sorted, so all tombstone chunks for one table are contiguous in the stream.
	const tombstoneRows = new Map<string, { pk: SqlValue[]; hlc: HLC; priorRow?: Row }>();
	let tombstoneSchema: string | undefined;
	let tombstoneTable: string | undefined;

	const flushTombstones = async (): Promise<void> => {
		if (tombstoneSchema === undefined || tombstoneTable === undefined) return;
		for (const ts of tombstoneRows.values()) {
			// NOTE: the write stamps `createdAt = Date.now()` internally and ignores
			// the sender's `entry.createdAt`, so a bootstrapped tombstone's TTL
			// horizon is re-based to bootstrap time rather than preserved. Acceptable
			// for phase 1 (the tombstone lives a full horizon from bootstrap).
			ctx.tombstones.setTombstoneBatch(batch, tombstoneSchema, tombstoneTable, ts.pk, ts.hlc, ts.priorRow);
			batchSize++;
			if (batchSize >= BATCH_FLUSH_SIZE) {
				await flushMetadataBatch();
			}
		}
		tombstoneRows.clear();
	};

	for await (const chunk of chunks) {
		switch (chunk.type) {
			case 'header': {
				snapshotId = chunk.snapshotId;
				snapshotHLC = chunk.hlc;
				totalTables = chunk.tableCount;

				// Wire-format gate: refuse a snapshot whose stamp is missing or different
				// BEFORE clearing local metadata or applying any chunk — same posture as
				// the `fv:` sync-metadata gate in `SyncManagerImpl.create`. An old
				// serialized snapshot (e.g. the coordinator's S3 store persists chunks at
				// rest) deserialized by newer code would otherwise silently mis-parse
				// entry shapes. Recovery: regenerate the snapshot from a live peer.
				if (chunk.snapshotFormat !== SNAPSHOT_WIRE_FORMAT_VERSION) {
					const error = new Error(
						`Snapshot wire format ${chunk.snapshotFormat ?? '(missing)'} does not match this build's `
							+ `${SNAPSHOT_WIRE_FORMAT_VERSION} — regenerate the snapshot from a live peer`,
					);
					ctx.syncEvents.emitSyncStateChange({ status: 'error', error });
					throw error;
				}

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

				// That clear just wiped the CRDT metadata of every table this apply did not
				// inherit, so ANY OTHER transfer's saved resume position is now stale: it
				// names tables as completed whose local metadata is gone, and resuming it
				// would tell the sender to skip exactly the tables that can no longer be
				// rebuilt. Drop those records here — which also keeps "a checkpoint exists"
				// a faithful answer to "is this replica's data partial?", since the footer
				// clears this apply's own record and leaves nothing behind it.
				await clearOtherSnapshotCheckpoints(ctx, chunk.snapshotId);

				// Open the resumable window the instant local metadata is gone. Both gates
				// above reject WITHOUT touching local state, so a refused snapshot leaves no
				// checkpoint behind; from here on the replica's data is partial until the
				// footer clears this record, and `listSnapshotCheckpoints` is what says so.
				// Without this save, an interruption before the first `flushMetadataBatch`
				// (every 1000 metadata entries) would leave a cleared, half-written replica
				// with nothing recording that a transfer was underway. On a resumed apply
				// this re-saves substantively the same record — harmless.
				await saveSnapshotCheckpoint(ctx, buildCheckpointRecord(chunk.snapshotId, chunk.hlc));
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
				// it here on restore. A stored snapshot from before DDL-first ordering also
				// predates the wire-format stamp, so the header gate above rejects it loudly
				// (recovery: regenerate the snapshot) instead of it failing obscurely here.
				await flushDataToStore();

				currentTable = `${chunk.schema}.${chunk.table}`;
				currentTableSchema = chunk.schema;
				currentTableName = chunk.table;
				totalEntries += chunk.estimatedEntries;
				tableRows.clear();
				break;

			case 'column-versions': {
				// Group cells by the RECEIVER's derived identity — never the sender's.
				// Keying is resolvable here because every schema migration preceded the
				// first `table-start`, whose flush pushed the DDL to the store; a table
				// with no local definition and no migration throws (the same snapshot
				// would fail at the data flush with "Table not found" anyway).
				const keying = resolveKeying(chunk.schema, chunk.table);
				for (const entry of chunk.entries) {
					reconcileCell(tableRows, entry, keying);
					entriesProcessed++;
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
			}

			case 'tombstone': {
				// Tombstones are pure CRDT metadata: there is NO store data for a deleted
				// row, so nothing is pushed to `pendingDataChanges`. Accumulate per
				// (schema, table) keyed by the receiver-derived identity, greatest HLC per
				// identity — a raw-keyed sender may carry two spellings of one deleted row.
				// NOTE: flushing on table change is only correct because the producer's
				// `tb:` scan is key-sorted, so one table's tombstone chunks are contiguous
				// in the stream (see the accumulator's declaration).
				//
				// Push pending DDL (and the last table's un-flushed row tail) first: a
				// fully-deleted table has NO `table-start`, so a stream of only migrations
				// + tombstones would otherwise reach `resolveKeying` before its
				// `create table` ran. Only the FIRST tombstone chunk can have anything
				// pending; later ones no-op (both pending arrays stay empty).
				await flushDataToStore();

				if (chunk.schema !== tombstoneSchema || chunk.table !== tombstoneTable) {
					await flushTombstones();
					tombstoneSchema = chunk.schema;
					tombstoneTable = chunk.table;
				}
				const keying = resolveKeying(chunk.schema, chunk.table);
				for (const entry of chunk.entries) {
					keepMaxHLC(tombstoneRows, encodePkIdentity(entry.pk, keying), {
						pk: entry.pk,
						hlc: entry.hlc,
						...(entry.priorRow !== undefined ? { priorRow: entry.priorRow } : {}),
					});
				}
				break;
			}

			case 'table-end':
				// Write the table's reconciled metadata and rows. Cells were reconciled
				// per (receiver identity, column) by greatest HLC during accumulation, so
				// exactly one cell record, one change-log entry, and one data column
				// survive per cell — collapsed sender spellings resolve by timestamp, not
				// by batch order.
				if (currentTableSchema && currentTableName) {
					for (const row of tableRows.values()) {
						const columns: Record<string, SqlValue> = {};
						for (const [column, cell] of row.cells) {
							columns[column] = cell.value;

							ctx.columnVersions.setColumnVersionBatch(
								batch,
								currentTableSchema,
								currentTableName,
								row.pk,
								column,
								{ hlc: cell.hlc, value: cell.value },
							);
							ctx.changeLog.recordColumnChangeBatch(
								batch,
								cell.hlc,
								currentTableSchema,
								currentTableName,
								row.pk,
								column,
							);

							batchSize++;
							if (batchSize >= BATCH_FLUSH_SIZE) {
								await flushMetadataBatch();
							}
						}

						pendingDataChanges.push({
							type: 'update',
							schema: currentTableSchema,
							table: currentTableName,
							pk: row.pk,
							columns,
						});
						if (pendingDataChanges.length >= DATA_FLUSH_SIZE) {
							await flushDataToStore();
						}
					}
					tableRows.clear();
				}

				tablesProcessed++;
				if (currentTable) {
					stagedCompletedTables.push(currentTable);
				}
				break;

			case 'schema-migration': {
				const migration = chunk.migration;
				pendingSchemaMigrations.push(migration);

				const kind = migrationObjectKind(migration.type);
				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, kind, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, kind, migration.table, {
					type: migration.type,
					// Keep the rename's old name, or this replica's own re-relay/snapshot
					// would ship the rename without it — undecidable downstream.
					...(migration.fromTable !== undefined ? { fromTable: migration.fromTable } : {}),
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
				break;
			}

			case 'footer':
				// Flush the last tombstone table's accumulation (pure metadata; the
				// tombstone section has no closing chunk of its own).
				await flushTombstones();

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
// NOTE: this file is 870 lines. If it grows much further, this section is the
// natural extraction seam — it depends only on `SyncContext` and the `sc:` key
// builders, not on the producer/consumer bodies above.
//
// NOTE: the AT-REST encoding below (wallTime as a decimal string, siteId as a
// number array) is deliberately NOT the wire encoding. The wire form is
// `SerializedSnapshotCheckpoint` in `wire.ts` (both binary fields as base64),
// used by the `resume_snapshot` message. Two encodings for one type is a wart,
// but unifying them is a stored-format migration: existing `sc:` records would
// have to be read under both shapes. If checkpoint storage is ever reworked for
// another reason, fold it onto the wire codec then.

/** Decode one checkpoint record's at-rest bytes. */
function decodeCheckpoint(bytes: Uint8Array): SnapshotCheckpoint {
	const obj = JSON.parse(new TextDecoder().decode(bytes));

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
 * Retrieve a saved checkpoint for an in-progress snapshot.
 */
export async function getSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<SnapshotCheckpoint | undefined> {
	const data = await ctx.kv.get(buildSnapshotCheckpointKey(snapshotId));
	if (!data) return undefined;
	return decodeCheckpoint(data);
}

/**
 * List every saved snapshot checkpoint — the discovery path for a caller that
 * has forgotten (or never held) the `snapshotId` of an interrupted transfer.
 * See {@link import('./manager.js').SyncManager.listSnapshotCheckpoints}.
 */
export async function listSnapshotCheckpoints(ctx: SyncContext): Promise<SnapshotCheckpoint[]> {
	const checkpoints: SnapshotCheckpoint[] = [];
	for await (const entry of ctx.kv.iterate(buildAllSnapshotCheckpointScanBounds())) {
		checkpoints.push(decodeCheckpoint(entry.value));
	}
	return checkpoints;
}

/**
 * Save a checkpoint during a streaming snapshot apply.
 */
async function saveSnapshotCheckpoint(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): Promise<void> {
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
	await ctx.kv.put(buildSnapshotCheckpointKey(checkpoint.snapshotId), new TextEncoder().encode(json));
}

/**
 * Delete every saved checkpoint EXCEPT `keepSnapshotId`'s.
 *
 * Called once per apply, right after `clearExistingMetadata`: at that instant
 * every other transfer's resume position became unusable (see the call site).
 * At most one checkpoint therefore exists at a time, so `listSnapshotCheckpoints`
 * cannot accumulate records and cannot report a complete replica as partial.
 */
async function clearOtherSnapshotCheckpoints(
	ctx: SyncContext,
	keepSnapshotId: string,
): Promise<void> {
	const keep = buildSnapshotCheckpointKey(keepSnapshotId);
	const clearBatch = ctx.kv.batch();
	let staleCount = 0;

	for await (const entry of ctx.kv.iterate(buildAllSnapshotCheckpointScanBounds())) {
		if (bytesEqual(entry.key, keep)) continue;
		clearBatch.delete(entry.key);
		staleCount++;
	}

	if (staleCount > 0) await clearBatch.write();
}

/**
 * Clear a checkpoint — after its snapshot completes successfully, or when a
 * caller abandons a transfer it will not resume.
 */
export async function clearSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<void> {
	await ctx.kv.delete(buildSnapshotCheckpointKey(snapshotId));
}
