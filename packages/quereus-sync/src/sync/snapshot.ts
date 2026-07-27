/**
 * Non-streaming snapshot operations.
 *
 * Full in-memory snapshot get/apply for small databases
 * or when streaming is not needed.
 */

import type { SqlValue, Row } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import { assertWithinDrift } from '../clock/hlc.js';
import { deserializeColumnVersion, type ColumnVersion } from '../metadata/column-version.js';
import { deserializeMigration } from '../metadata/schema-migration.js';
import { deserializeTombstone } from '../metadata/tombstones.js';
import {
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	buildAllChangeLogScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	parseSchemaMigrationKey,
} from '../metadata/keys.js';
import type {
	Snapshot,
	SnapshotTombstone,
	SchemaMigration,
	TableSnapshot,
	DataChangeToApply,
	SchemaChangeToApply,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { toError } from './sync-context.js';
import { admitGroup } from './admission.js';

/**
 * Get a full snapshot of all data and schema state.
 */
export async function getSnapshot(ctx: SyncContext): Promise<Snapshot> {
	// Collect all column versions, grouped by table and row
	type RowVersions = Map<string, ColumnVersion>;
	type TableRows = Map<string, RowVersions>;
	type TableEntry = { schema: string; table: string; rows: TableRows };
	const tableData = new Map<string, TableEntry>();

	const cvBounds = buildAllColumnVersionsScanBounds();
	for await (const entry of ctx.kv.iterate(cvBounds)) {
		const parsed = parseColumnVersionKey(entry.key);
		if (!parsed) continue;

		const cv = deserializeColumnVersion(entry.value);
		const tableKey = `${parsed.schema}.${parsed.table}`;
		// The parsed pk IDENTITY groups one row's cells; the raw pk (needed to
		// address the row on the receiver) rides in each cell's record value.
		const rowKey = parsed.identity;

		if (!tableData.has(tableKey)) {
			tableData.set(tableKey, { schema: parsed.schema, table: parsed.table, rows: new Map() });
		}
		const tableRows = tableData.get(tableKey)!.rows;

		if (!tableRows.has(rowKey)) {
			tableRows.set(rowKey, new Map());
		}
		const rowVersions = tableRows.get(rowKey)!;
		rowVersions.set(parsed.column, cv);
	}

	// Build table snapshots
	const tables: TableSnapshot[] = [];
	for (const { schema, table, rows } of tableData.values()) {
		const columnVersions = new Map<string, { hlc: HLC; value: SqlValue; pk: SqlValue[] }>();
		const rowsArray: Row[] = [];

		for (const [rowKey, rowVersionsMap] of rows) {
			const row: Row = Array.from(rowVersionsMap.values()).map(cv => cv.value);
			rowsArray.push(row);

			for (const [column, cv] of rowVersionsMap) {
				const versionKey = `${rowKey}:${column}`;
				columnVersions.set(versionKey, { hlc: cv.hlc, value: cv.value, pk: cv.pk });
			}
		}

		tables.push({
			schema,
			table,
			rows: rowsArray,
			columnVersions,
		});
	}

	// Collect all schema migrations
	const schemaMigrations: SchemaMigration[] = [];
	const smBounds = buildAllSchemaMigrationsScanBounds();
	for await (const entry of ctx.kv.iterate(smBounds)) {
		const parsed = parseSchemaMigrationKey(entry.key);
		if (!parsed) continue;

		const migration = deserializeMigration(entry.value);
		schemaMigrations.push({
			type: migration.type,
			schema: parsed.schema,
			table: parsed.table,
			ddl: migration.ddl,
			hlc: migration.hlc,
			schemaVersion: migration.schemaVersion,
		});
	}

	// Collect all tombstones — a GLOBAL pass (not keyed off `tables`), mirroring the
	// streaming producer: a fully-deleted row has a tombstone but no live
	// column-versions, so its `(schema, table)` may be absent from `tables`. The
	// global scan carries it regardless.
	const tombstones: SnapshotTombstone[] = [];
	for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
		const parsed = parseTombstoneKey(entry.key);
		if (!parsed) continue;

		const ts = deserializeTombstone(entry.value);
		tombstones.push({
			schema: parsed.schema,
			table: parsed.table,
			pk: ts.pk,
			identity: parsed.identity,
			hlc: ts.hlc,
			createdAt: ts.createdAt,
			...(ts.priorRow !== undefined ? { priorRow: ts.priorRow } : {}),
		});
	}

	return {
		siteId: ctx.getSiteId(),
		hlc: ctx.getCurrentHLC(),
		tables,
		schemaMigrations,
		tombstones,
	};
}

/**
 * Apply a full snapshot, replacing all local data.
 */
export async function applySnapshot(
	ctx: SyncContext,
	snapshot: Snapshot,
): Promise<void> {
	// Pre-commit drift validation (mirrors applyChanges / applySnapshotStream): reject a
	// snapshot whose HLC is beyond the drift bound BEFORE clearing or writing anything,
	// so a far-future peer cannot land poison LWW winners. Emit status:'error' first for
	// UI parity with the data-apply failure path.
	try {
		assertWithinDrift(snapshot.hlc.wallTime, BigInt(Date.now()));
	} catch (error) {
		ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
		throw error;
	}

	// PHASE 1: Build data changes from snapshot
	const dataChangesToApply: DataChangeToApply[] = [];
	const schemaChangesToApply: SchemaChangeToApply[] = [];

	for (const migration of snapshot.schemaMigrations) {
		schemaChangesToApply.push({
			type: migration.type,
			schema: migration.schema,
			table: migration.table,
			ddl: migration.ddl,
		});
	}

	for (const tableSnapshot of snapshot.tables) {
		const rowsByPk = new Map<string, Record<string, SqlValue>>();
		// versionKey groups by the (lossy) pk identity; the applicable raw pk is
		// taken from the entries themselves (any one of a row's entries carries it).
		const rowPks = new Map<string, SqlValue[]>();

		for (const [versionKey, cvEntry] of tableSnapshot.columnVersions) {
			const lastColon = versionKey.lastIndexOf(':');
			if (lastColon === -1) continue;

			const rowKey = versionKey.slice(0, lastColon);
			const column = versionKey.slice(lastColon + 1);

			if (!rowsByPk.has(rowKey)) {
				rowsByPk.set(rowKey, {});
				rowPks.set(rowKey, cvEntry.pk);
			}
			rowsByPk.get(rowKey)![column] = cvEntry.value;
		}

		for (const [rowKey, columns] of rowsByPk) {
			dataChangesToApply.push({
				type: 'update',
				schema: tableSnapshot.schema,
				table: tableSnapshot.table,
				pk: rowPks.get(rowKey)!,
				columns,
			});
		}
	}

	// Admit the snapshot as one wholesale all-or-nothing unit: data first (PHASE 2,
	// a bootstrap apply — the adapter skips the engine seam, converged once by the
	// finalize below), then the wholesale metadata replace (PHASE 3), then the
	// clock watermark. A data-apply failure aborts before clearing/rewriting
	// metadata, leaving prior CRDT state intact; the snapshot retries wholesale
	// (idempotent on the store side) and now also emits status:'error'.
	await admitGroup(ctx, {
		dataChanges: dataChangesToApply,
		schemaChanges: schemaChangesToApply,
		applyOptions: { remote: true, bootstrap: true },
		commitMetadata: async () => {
			// Clear existing CRDT metadata and apply new
			const clearBatch = ctx.kv.batch();

			for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) {
				clearBatch.delete(entry.key);
			}
			for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
				clearBatch.delete(entry.key);
			}
			for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds())) {
				clearBatch.delete(entry.key);
			}

			await clearBatch.write();

			// Apply snapshot's column versions and rebuild change log
			const applyBatch = ctx.kv.batch();

			for (const tableSnapshot of snapshot.tables) {
				for (const [versionKey, cvEntry] of tableSnapshot.columnVersions) {
					const lastColon = versionKey.lastIndexOf(':');
					if (lastColon === -1) continue;

					// The versionKey carries the SENDER's pk identity + column. File under
					// that identity verbatim: the receiving table may not exist yet (its
					// schema arrives in this same snapshot), so no local keying can be
					// resolved — and sender and receiver share the replicated schema, so
					// the identities agree.
					const identity = versionKey.slice(0, lastColon);
					const column = versionKey.slice(lastColon + 1);

					ctx.columnVersions.setColumnVersionByIdentityBatch(
						applyBatch,
						tableSnapshot.schema,
						tableSnapshot.table,
						identity,
						cvEntry.pk,
						column,
						{ hlc: cvEntry.hlc, value: cvEntry.value },
					);

					ctx.changeLog.recordColumnChangeByIdentityBatch(
						applyBatch,
						cvEntry.hlc,
						tableSnapshot.schema,
						tableSnapshot.table,
						identity,
						column,
					);
				}
			}

			// Record schema migrations
			for (const migration of snapshot.schemaMigrations) {
				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
			}

			// Re-write the snapshot's tombstones (the clearBatch above wiped the
			// receiver's existing ones). Mirrors the streaming consumer.
			// NOTE: `setTombstoneBatch` stamps `createdAt = Date.now()` internally and
			// ignores the sender's `ts.createdAt`, so a bootstrapped tombstone's TTL
			// horizon re-bases to bootstrap time rather than preserved. Accepted phase-1
			// behavior (the tombstone lives a full horizon from bootstrap).
			for (const ts of snapshot.tombstones) {
				// Sender-identity write, same reasoning as the column versions above.
				ctx.tombstones.setTombstoneByIdentityBatch(applyBatch, ts.schema, ts.table, ts.identity, ts.pk, ts.hlc, ts.priorRow);
			}

			await applyBatch.write();
		},
		watermarkHLC: snapshot.hlc,
	});

	// Converge the bootstrap: PHASE 2 deferred MV maintenance and watch capture
	// (seam skipped), so converge every MV once and coarse-notify each
	// bootstrapped table's watchers. Issued before `status: 'synced'` so a
	// finalize failure aborts the apply (the storage rows are already correct, so
	// a retry's finalize rebuilds cleanly).
	if (ctx.applyToStore) {
		await ctx.applyToStore([], [], {
			remote: true,
			bootstrapFinalize: true,
			bootstrapTables: snapshot.tables.map(t => ({ schema: t.schema, table: t.table })),
		});
	}

	// Emit sync state change
	ctx.syncEvents.emitSyncStateChange({ status: 'synced', lastSyncHLC: snapshot.hlc });
}
