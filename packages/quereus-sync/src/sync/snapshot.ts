/**
 * Non-streaming snapshot operations.
 *
 * Full in-memory snapshot get/apply for small databases
 * or when streaming is not needed.
 */

import { assertWithinDrift, compareHLC } from '../clock/hlc.js';
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
	encodePkIdentity,
} from '../metadata/keys.js';
import {
	SNAPSHOT_WIRE_FORMAT_VERSION,
	type Snapshot,
	type SnapshotTombstone,
	type SchemaMigration,
	type TableSnapshot,
	type ColumnVersionEntry,
	type DataChangeToApply,
	type SchemaChangeToApply,
} from './protocol.js';
import { migrationObjectKind } from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { toError } from './sync-context.js';
import {
	createSnapshotKeyingResolver,
	keepMaxHLC,
	reconcileCell,
	tableScopedRowKey,
	type ReconciledRow,
} from './snapshot-identity.js';
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
		const columnVersions: ColumnVersionEntry[] = [];

		for (const rowVersionsMap of rows.values()) {
			for (const [column, cv] of rowVersionsMap) {
				// Flat cell records: only the raw pk travels. The sender's own key
				// identity (the `rows` grouping key) stays local — the receiver derives
				// its own identity from each entry's pk.
				columnVersions.push({ column, hlc: cv.hlc, value: cv.value, pk: cv.pk });
			}
		}

		tables.push({ schema, table, columnVersions });
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
			hlc: ts.hlc,
			createdAt: ts.createdAt,
			...(ts.priorRow !== undefined ? { priorRow: ts.priorRow } : {}),
		});
	}

	return {
		siteId: ctx.getSiteId(),
		hlc: ctx.getCurrentHLC(),
		snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
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
	// Wire-format gate: refuse a snapshot whose stamp is missing or different
	// BEFORE touching any local state — same posture as the `fv:` sync-metadata
	// gate in `SyncManagerImpl.create` and the streaming header gate. Recovery:
	// regenerate the snapshot from a live peer.
	if (snapshot.snapshotFormat !== SNAPSHOT_WIRE_FORMAT_VERSION) {
		const error = new Error(
			`Snapshot wire format ${snapshot.snapshotFormat ?? '(missing)'} does not match this build's `
				+ `${SNAPSHOT_WIRE_FORMAT_VERSION} — regenerate the snapshot from a live peer`,
		);
		ctx.syncEvents.emitSyncStateChange({ status: 'error', error });
		throw error;
	}

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
		// No local keying is resolvable yet — the table may only exist once this
		// same unit's `create table` migration runs, and both go to the store in
		// ONE `applyToStore` call. So no receiver identity can group cells into
		// rows here. Instead: one single-column update per cell, ordered by HLC
		// ascending across the table. The store collapses pk spellings with the
		// same rules the identity uses, so a later write lands last and the data
		// converges to per-cell last-writer-wins — matching the reconciled
		// metadata `commitMetadata` files below.
		// NOTE: this multiplies data changes by column count (O(cells), not
		// O(rows)). Fine for the non-streaming path's small-database contract; if
		// it ever shows up as slow, use the streaming path (which groups rows
		// after DDL lands) rather than optimizing here.
		// NOTE: on a COLLAPSE the stored row keeps the EARLIEST spelling of the pk
		// (the store adapter's row group takes `changes[0].pk`), while the metadata
		// below files the newest — both are valid addresses for the same identity,
		// so lookups and relays agree, but two receivers of one snapshot can show
		// different pk text. If that ever needs to be uniform, resolve the winning
		// spelling here the way `commitMetadata` does.
		const sorted = [...tableSnapshot.columnVersions].sort((a, b) => compareHLC(a.hlc, b.hlc));
		for (const cvEntry of sorted) {
			dataChangesToApply.push({
				type: 'update',
				schema: tableSnapshot.schema,
				table: tableSnapshot.table,
				pk: cvEntry.pk,
				columns: { [cvEntry.column]: cvEntry.value },
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
			// Runs AFTER the data apply, so every snapshot table (including ones the
			// snapshot's own `create table` migration installed) has a resolvable
			// schema — local keying is derivable here.
			const resolveKeying = createSnapshotKeyingResolver(ctx);

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

			// Apply snapshot's column versions and rebuild change log, filed under the
			// RECEIVER's derived identity. A sender with different keying (a raw-keyed
			// relay) can carry several records for what this receiver considers ONE
			// row; reconcile per (identity, column) by greatest HLC so exactly one
			// cell record + one change-log entry survive per cell — last-writer-wins,
			// not entry order.
			const applyBatch = ctx.kv.batch();

			for (const tableSnapshot of snapshot.tables) {
				const keying = resolveKeying(tableSnapshot.schema, tableSnapshot.table);
				const rows = new Map<string, ReconciledRow>();
				for (const cvEntry of tableSnapshot.columnVersions) {
					reconcileCell(rows, cvEntry, keying);
				}

				for (const row of rows.values()) {
					for (const [column, cell] of row.cells) {
						ctx.columnVersions.setColumnVersionBatch(
							applyBatch,
							tableSnapshot.schema,
							tableSnapshot.table,
							row.pk,
							column,
							{ hlc: cell.hlc, value: cell.value },
						);
						ctx.changeLog.recordColumnChangeBatch(
							applyBatch,
							cell.hlc,
							tableSnapshot.schema,
							tableSnapshot.table,
							row.pk,
							column,
						);
					}
				}
			}

			// Record schema migrations
			for (const migration of snapshot.schemaMigrations) {
				const kind = migrationObjectKind(migration.type);
				const schemaVersion = migration.schemaVersion ??
					(await ctx.schemaMigrations.getCurrentVersion(migration.schema, kind, migration.table)) + 1;
				await ctx.schemaMigrations.recordMigration(migration.schema, kind, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
			}

			// Re-write the snapshot's tombstones (the clearBatch above wiped the
			// receiver's existing ones), one per receiver-derived identity, greatest
			// HLC winning — mirrors the streaming consumer's reconciliation.
			// NOTE: `setTombstoneBatch` stamps `createdAt = Date.now()` internally and
			// ignores the sender's `ts.createdAt`, so a bootstrapped tombstone's TTL
			// horizon re-bases to bootstrap time rather than preserved. Accepted phase-1
			// behavior (the tombstone lives a full horizon from bootstrap).
			const tombstoneWinners = new Map<string, SnapshotTombstone>();
			for (const ts of snapshot.tombstones) {
				const keying = resolveKeying(ts.schema, ts.table);
				keepMaxHLC(tombstoneWinners, tableScopedRowKey(ts.schema, ts.table, encodePkIdentity(ts.pk, keying)), ts);
			}
			for (const ts of tombstoneWinners.values()) {
				ctx.tombstones.setTombstoneBatch(applyBatch, ts.schema, ts.table, ts.pk, ts.hlc, ts.priorRow);
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
