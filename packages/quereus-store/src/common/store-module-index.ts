/**
 * CREATE INDEX / DROP INDEX over a store-backed table, and the physical index stores
 * they bring into (and out of) existence — including the hidden `_uc_*` stores that
 * back a plain UNIQUE constraint, whose set is reconciled against the schema after
 * every DDL that can change it.
 *
 * Fourth layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type {
	Database,
	EffectiveRowSource,
	KeyNormalizerResolver,
	TableIndexSchema,
	TableSchema,
} from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	appendIndexToTableSchema,
	generateDropIndexDDL,
	generateIndexDDL,
} from '@quereus/quereus';
import { StoreTable } from './store-table.js';
import { findReusableIndexForUnique, implicitUniqueIndexName } from './implicit-unique-index.js';
import { buildFullScanBounds, buildIndexStoreName } from './key-builder.js';
import { StoreModuleSchemaSync } from './store-module-schema-sync.js';
import { DEFAULT_MAX_BATCH_BYTES } from './store-module-base.js';
import { buildIndexEntries, validateUniqueIndexOverRows } from './store-module-index-build.js';

/**
 * Map of `lowercased implicit index name → actual name` for every NON-DERIVED
 * UNIQUE constraint of `schema` that needs a `_uc_*` of its own — the set of
 * `_uc_*` stores that SHOULD exist for that schema. The diff of two such maps
 * drives {@link reconcileImplicitUniqueIndexStores}.
 *
 * Reads `uniqueConstraints` for the NAMES (so it is correct whether or not
 * `schema` is materialized) and `.indexes` for the REUSE decision, exactly as
 * `withImplicitUniqueIndexes` does — the two must agree, or the reconcile would
 * build a store no DML maintains, or tear down one that is still being seeked.
 * A UC realized by an explicit index (`findReusableIndexForUnique`) contributes
 * no entry, which is what makes `create index` / `drop index` over a constrained
 * column a teardown / rebuild transition rather than a no-op.
 */
function implicitUniqueIndexNameMap(schema: TableSchema): Map<string, string> {
	const map = new Map<string, string>();
	for (const uc of schema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		if (findReusableIndexForUnique(schema, uc)) continue;
		const name = implicitUniqueIndexName(schema, uc);
		map.set(name.toLowerCase(), name);
	}
	return map;
}

export abstract class StoreModuleIndex extends StoreModuleSchemaSync {
	/**
	 * Creates an index on a store-backed table.
	 *
	 * `rows` — an {@link EffectiveRowSource} supplied by a wrapper module (the isolation
	 * layer) — replaces this module's own rows as the set the UNIQUE duplicate check judges.
	 * When present the check runs UP FRONT, before `getIndexStore` opens the index-store
	 * directory, so a rejection leaves no directory behind; and `buildIndexEntries` then
	 * populates the physical index from this module's own (committed) rows with its in-pass
	 * dup check disabled. Those two row sets legitimately differ — the wrapper's transaction
	 * may have deleted a committed duplicate — and an index entry with no live row behind it
	 * is harmless (see the entry-resolution note in `buildIndexEntries`).
	 */
	async createIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: TableIndexSchema,
		rows?: EffectiveRowSource,
	): Promise<void> {
		const table = this.getOrReconnectTable(db, schemaName, tableName);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'`,
				StatusCode.NOTFOUND
			);
		}

		// Reject when this new index's physical store name already names an existing
		// store: a sibling table's data store (`{schema}.t_idx_<x>` == sibling table
		// `t_idx_<x>`) or another table's index store (index-vs-index, e.g.
		// `a.b_idx_c` vs `a_idx_b.c` both → `{schema}.a_idx_b_idx_c`). The new index
		// is not yet registered in the schema or the table's cached schema at this
		// point, so the candidate cannot self-collide. Must precede `getIndexStore`,
		// which opens/creates the directory that `buildIndexEntries` then writes into.
		const indexStoreName = buildIndexStoreName(schemaName, tableName, indexSchema.name);
		this.assertStoreNameFree(
			db,
			schemaName,
			indexStoreName,
			`index store of new index '${indexSchema.name}' on table '${schemaName}.${tableName}'`,
		);

		const tableSchema = table.getSchema();
		const keyCollation = (table.getConfig().collation || 'NOCASE').toUpperCase();

		// Reject an index whose key collations cannot key (comparator-only or
		// unregistered names) BEFORE the physical store is created — the same DDL-time
		// check `StoreTableBase.validateKeyCollations` applies to every index at
		// CREATE TABLE / rehydrate, run here up front so a rejection leaves no
		// index-store directory behind (the post-build `updateSchema` would only catch
		// it after the store exists).
		table.assertIndexKeyCollationsCanKey(indexSchema);

		// Wrapper-supplied rows are the judged set. Validate BEFORE `getIndexStore` so a
		// rejection leaves no index-store directory behind, and disable the in-pass dup
		// check below (which would judge this module's committed rows instead).
		if (rows && indexSchema.unique) {
			await validateUniqueIndexOverRows(rows(), tableSchema, indexSchema, db.getKeyNormalizerResolver());
		}

		// Create the index store
		const indexStore = await this.provider.getIndexStore(schemaName, tableName, indexSchema.name);

		// Build index entries for every row the table can currently SEE — committed
		// rows merged with this transaction's pending writes (`iterateEffectiveEntries`).
		// The committed-only stream would leave a row inserted earlier in an open
		// transaction unindexed, and `StoreTable.findUniqueConflictViaIndex` trusts the
		// index to hold every live row: a `CREATE UNIQUE INDEX` would miss a pending
		// duplicate, and a later insert colliding with that pending row would be
		// silently ACCEPTED. Entries written here for rows that a subsequent ROLLBACK
		// discards are harmless: both readers resolve each entry to its live row and
		// drop it when the row is gone or no longer matches (see `scanIndex`).
		//
		// The store is FRESHLY created above, so any build failure — a UNIQUE violation,
		// an IO error, or a mid-stream flush failure now that the build is chunked — must
		// tear the whole store down. Nothing else reclaims it: SchemaManager.createIndex
		// wraps the error but does no teardown, so without this a rejected build leaks a
		// partial/empty index-store directory. Mirrors dropIndex's teardown.
		try {
			await buildIndexEntries(
				table.iterateEffectiveEntries(buildFullScanBounds()),
				indexStore,
				tableSchema,
				indexSchema,
				keyCollation,
				db.getKeyNormalizerResolver(),
				rows !== undefined,
				table.getConfig().maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
			);
		} catch (buildError) {
			// Best-effort teardown: guard it against its own throw so a teardown failure
			// never masks the original build error the caller must see.
			try {
				await this.tearDownIndexStore(schemaName, tableName, table, indexSchema.name);
			} catch (teardownError) {
				console.warn(
					`[StoreModule] failed to tear down index store '${indexSchema.name}' on `
						+ `table '${schemaName}.${tableName}' after a failed CREATE INDEX: ${String(teardownError)}`,
				);
			}
			throw buildError;
		}

		// Refresh the connected table's cached schema so subsequent DML
		// maintains the new index (the engine's schema registry is updated
		// separately by SchemaManager.createIndex, but the StoreTable instance
		// holds its own reference captured at connect time). The shared
		// appendIndexToTableSchema also synthesizes the UNIQUE → derived
		// uniqueConstraint entry so checkUniqueConstraints enforces it; the
		// `derivedFromIndex` tag lets StoreModule.dropIndex filter it back out
		// symmetrically (mirrors SchemaManager.dropIndex / MemoryTableManager.dropIndex).
		const updatedSchema = appendIndexToTableSchema(tableSchema, indexSchema);
		table.updateSchema(updatedSchema);

		// Authoritative catalog write: persist the table's bundle now (including the
		// new index), so the index survives close → reopen even when the table has
		// no rows yet and was never lazily persisted. `markDdlSaved` suppresses the
		// later lazy table-only write on first store access (StoreTable.ddlSaved), so
		// this is the only catalog write the createIndex produces. SchemaManager fires
		// a follow-up `table_modified` whose listener regenerates the SAME bundle and
		// skips (identical) — see persistCatalogIfChanged.
		await this.saveTableDDL(updatedSchema);
		table.markDdlSaved();

		// The new index may now REALIZE a plain UNIQUE over the same columns, which
		// `updateSchema` above has already dropped from the materialized enforcement
		// schema (`findReusableIndexForUnique`). Nothing maintains that `_uc_*` any more,
		// so tear its physical store down — leaving it would rot into a store whose
		// entries no longer track the rows, which a later `DROP INDEX` would hand back to
		// the constraint as if current. A no-op for every index that covers no UNIQUE —
		// which is what keeps the DDL-commit the teardown forces (see
		// {@link reconcileImplicitUniqueIndexStores}) off every ordinary CREATE INDEX.
		await this.reconcileImplicitUniqueIndexStores(db, schemaName, tableName, table, tableSchema);

		// Emit schema change event. `updatedSchema` (not the pre-create
		// `tableSchema`) is the owner the canonical CREATE INDEX renders against —
		// it is only read for the table's qualified name and column names, but
		// passing the post-create schema keeps the rendering consistent with what a
		// receiving peer regenerates when it compares definitions.
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'index',
			schemaName,
			objectName: indexSchema.name,
			ddl: generateIndexDDL(indexSchema, updatedSchema),
		});
	}

	/**
	 * Drops an index on a store-backed table.
	 *
	 * Mirrors createIndex: refreshes the connected StoreTable's cached
	 * tableSchema (removing the index entry and any UNIQUE constraint
	 * synthesized from it, tagged with `derivedFromIndex`), releases the
	 * cached index-store handle, and tears down the underlying index store.
	 */
	async dropIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string,
	): Promise<void> {
		const table = this.getOrReconnectTable(db, schemaName, tableName);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'`,
				StatusCode.NOTFOUND,
			);
		}

		const tableSchema = table.getSchema();
		const lowerIndexName = indexName.toLowerCase();

		// Mirror SchemaManager.dropIndex: strip the index AND any UNIQUE
		// constraint synthesized from it (tagged with `derivedFromIndex` by
		// StoreModule.createIndex). Collapse uniqueConstraints to undefined
		// when empty.
		const updatedIndexes = Object.freeze(
			(tableSchema.indexes ?? []).filter(
				idx => idx.name.toLowerCase() !== lowerIndexName,
			),
		);
		const remainingUniqueConstraints = (tableSchema.uniqueConstraints ?? []).filter(
			uc => uc.derivedFromIndex?.toLowerCase() !== lowerIndexName,
		);
		const updatedSchema: TableSchema = {
			...tableSchema,
			indexes: updatedIndexes,
			uniqueConstraints: remainingUniqueConstraints.length > 0
				? Object.freeze(remainingUniqueConstraints)
				: undefined,
		};
		// Update the cached schema BEFORE tearing down the store so that a
		// failure of the physical drop doesn't leave the schema enforcing an
		// index whose backing store has already been mutated.
		table.updateSchema(updatedSchema);

		// Rewrite the catalog bundle without the dropped index, before the physical
		// teardown — so on reopen the index does not resurrect even if the store
		// delete below fails. `markDdlSaved` keeps the lazy first-access save from
		// re-writing the same bundle. SchemaManager's follow-up `table_modified`
		// regenerates an identical bundle and skips.
		await this.saveTableDDL(updatedSchema);
		table.markDdlSaved();

		// Drop the cached handle on the table side and tear down the underlying KVStore
		// ({@link tearDownIndexStore}).
		//
		// Flush first: the coordinator keys buffered ops on the KVStore HANDLE, so ops
		// this transaction queued against the index being dropped would be replayed into
		// a closed store at commit and throw. Same posture (and same reason) as the
		// teardown in `reconcileImplicitUniqueIndexStores` and the row-rewriting ALTER
		// arms — see `StoreModuleBase.ddlCommitPendingOps`.
		await this.ddlCommitPendingOps();
		await this.tearDownIndexStore(schemaName, tableName, table, indexName);

		// The dropped index may have been the structure REALIZING a plain UNIQUE over its
		// columns; `updateSchema` above has re-materialized that constraint's own `_uc_*`,
		// which has no physical store yet. Build it from the current rows so the very next
		// insert is still enforced by a seek rather than an empty index. Deliberately AFTER
		// the teardown: the build reads the DATA store, so the dropped index's store is
		// dead weight by then. A no-op for every index no UNIQUE was reusing.
		await this.reconcileImplicitUniqueIndexStores(db, schemaName, tableName, table, tableSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'index',
			schemaName,
			objectName: indexName,
			ddl: generateDropIndexDDL(schemaName, indexName),
		});
	}

	/**
	 * Clear and rebuild every secondary index of `schema` against the (already
	 * re-encoded) data store. Secondary-index keys embed the PK suffix, so they must
	 * be rewritten whenever the data-store PK key bytes change — which happens both
	 * on `ALTER PRIMARY KEY` (the PK columns change) and on an `ALTER COLUMN … SET
	 * COLLATE` on a PK member (a PK column's key collation changes). Shared by both
	 * arms so the clear-then-rebuild stays identical. `schema` must already be the
	 * post-ALTER schema (its `primaryKeyDefinition` + column collations drive the new
	 * PK-suffix encoding via {@link buildIndexEntries}). `normalizers` is the owning
	 * connection's `db.getKeyNormalizerResolver()` — see {@link buildIndexEntries}.
	 *
	 * NOTE: reads the data store committed-only and writes the index stores outside the
	 * coordinator. Sound only because every caller calls `StoreModuleBase.ddlCommitPendingOps`
	 * first, so this module's "committed" is "everything live". A caller that skips that
	 * flush would rebuild an index missing its transaction's pending rows.
	 *
	 * `skipDuplicateCheck` suppresses {@link buildIndexEntries}' in-pass UNIQUE check.
	 * Both ALTER COLUMN rebuild callers set it — the value-rewriting / key-transform
	 * arm and the PK re-key arm (`SET COLLATE` on a PK member): each runs a
	 * pre-mutation UNIQUE re-validation that already judged the ISSUING connection's
	 * effective rows (a wrapper's overlay included), and this rebuild sees only THIS
	 * module's committed rows — a set that may retain a row the wrapper's transaction
	 * has deleted, so judging it here would spuriously reject a duplicate pair the
	 * probe correctly accepted (and, worse, reject AFTER the data store was already
	 * re-keyed). Mirrors the memory module's deliberately non-enforcing base rebuild
	 * (the probe is the only guard). `ALTER PRIMARY KEY`'s rebuild still enforces:
	 * that arm has no effective-row UNIQUE probe of its own.
	 */
	protected async rebuildSecondaryIndexes(
		schemaName: string,
		tableName: string,
		table: StoreTable,
		schema: TableSchema,
		normalizers: KeyNormalizerResolver,
		skipDuplicateCheck = false,
	): Promise<void> {
		const keyCollation = (table.getConfig().collation || 'NOCASE').toUpperCase();
		const dataStore = await this.getStore(schemaName, tableName, table.getConfig());
		const maxBatchBytes = table.getConfig().maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
		for (const indexSchema of schema.indexes ?? []) {
			const indexStore = await this.getIndexStore(schemaName, tableName, indexSchema.name);
			// NOTE: this clear pass buffers EVERY existing index key into one batch. It holds
			// only KEYS (no values), so its peak is far below the value-bearing build pass and
			// is left unbounded for now. Chunking it is harder than the build: it deletes from
			// the SAME store it iterates, so a mid-iteration flush risks iterate-while-mutate
			// semantics that differ per provider (LevelDB snapshots its iterator; IndexedDB may
			// not). If the index key set ever dominates memory, chunk this with a snapshot-safe
			// re-seek, not a naive mid-iteration flush.
			const clearBatch = indexStore.batch();
			for await (const entry of indexStore.iterate(buildFullScanBounds())) {
				clearBatch.delete(entry.key);
			}
			await clearBatch.write();
			await buildIndexEntries(
				dataStore.iterate(buildFullScanBounds()),
				indexStore,
				schema,
				indexSchema,
				keyCollation,
				normalizers,
				skipDuplicateCheck,
				maxBatchBytes,
			);
		}
	}

	/**
	 * Build / tear down the physical index stores backing implicit UNIQUE indexes
	 * (`_uc_*`) after a DDL statement, by diffing the implicit-index NAMES the old vs
	 * new schema call for ({@link implicitUniqueIndexNameMap}):
	 *   - a name newly PRESENT (ADD CONSTRAINT UNIQUE, the target half of a
	 *     RENAME CONSTRAINT / rename of an unnamed UC's column, or a DROP INDEX that
	 *     retires the explicit index a UNIQUE was reusing) has its physical store
	 *     populated from this module's effective rows;
	 *   - a name newly ABSENT (DROP CONSTRAINT UNIQUE, the source half of a rename, or
	 *     a CREATE INDEX whose new index now realizes the UNIQUE) has its store torn
	 *     down, so nothing maintains it and a later rebuild does not reopen stale
	 *     entries.
	 *
	 * The SCHEMA entry itself is materialized/removed by `withImplicitUniqueIndexes`
	 * on the caller's `table.updateSchema`; only the physical store needs this. Called
	 * after every ALTER TABLE and after `createIndex` / `dropIndex`, and a no-op
	 * whenever the implicit-index name set is unchanged — the common case, including
	 * every PK / collation / data-type ALTER (whose same-name physical re-encode is
	 * already done by {@link rebuildSecondaryIndexes}) and every CREATE / DROP INDEX
	 * that does not cover a plain UNIQUE's columns.
	 *
	 * `oldSchema` is the pre-DDL schema: its `uniqueConstraints` give the old names and
	 * its `.indexes` the old reuse decisions. Either the engine-facing or the
	 * materialized copy works — `findReusableIndexForUnique` skips a constraint's own
	 * `_uc_*`, so a materialized input yields the same name set.
	 *
	 * NOTE: the build populates from THIS module's own effective rows (committed + this
	 * transaction's pending), never a wrapper's — mirroring `createIndex`. Under the
	 * isolation layer the wrapper's rows are what ADD CONSTRAINT's validation judged;
	 * the physical index legitimately fills from this module's committed rows and an
	 * entry with no live row behind it is harmless (both readers resolve to the live
	 * row). Duplicates were already rejected by `validateUniqueOverExistingRows` (ADD)
	 * or cannot exist (RENAME leaves data unchanged), so the in-pass check is skipped.
	 */
	protected async reconcileImplicitUniqueIndexStores(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
	): Promise<void> {
		// Diff the constraint sets by implicit-index NAME (derived from `uniqueConstraints`,
		// so the engine-facing schemas work directly); resolve the index SHAPE to build from
		// the materialized enforcement schema.
		const newSchema = table.getSchema();
		const newMaterialized = table.getMaterializedSchema();
		const oldNames = implicitUniqueIndexNameMap(oldSchema);
		const newNames = implicitUniqueIndexNameMap(newSchema);

		// Tear down each store whose implicit index no longer exists. A teardown closes
		// and deletes a KVStore handle the module coordinator may still hold buffered ops
		// against (pending ops are keyed on the HANDLE), and the eventual commit would
		// write into the closed store and throw — so flush first, the same DDL-commit
		// posture the row-rewriting ALTER arms take and what this module's declared
		// `ddlTransactionality: 'auto-commit'` promises. Only when something is actually
		// doomed: a pure BUILD writes index entries outside the coordinator and deletes
		// nothing, so it must not force-commit the caller's transaction.
		const doomed = [...oldNames].filter(([lower]) => !newNames.has(lower));
		if (doomed.length > 0) {
			await this.ddlCommitPendingOps();
			for (const [, name] of doomed) {
				await this.tearDownIndexStore(schemaName, tableName, table, name);
			}
		}

		// Build each newly-materialized implicit index's store from effective rows.
		for (const [lower, name] of newNames) {
			if (oldNames.has(lower)) continue;
			const indexSchema = (newMaterialized.indexes ?? []).find(ix => ix.name === name);
			if (!indexSchema) continue; // defensive — name is derived from the same UC set
			// NOTE: no `assertStoreNameFree` here (unlike explicit `createIndex`): the name
			// is engine-derived and deterministic, and the lazy first-write build path in
			// `updateSecondaryIndexes` does not assert either — keep the two consistent.
			// NOTE: no teardown-on-failure wrapper (unlike `createIndex`): an IO error mid-build
			// leaves a partial `_uc_*` store while the constraint schema is already committed, so
			// enforcement could under-report until the store is rebuilt. Tolerated because the
			// build has no in-pass dup check (skipDuplicateCheck below) so the only failure is a
			// genuine IO error — the same non-atomicity `rebuildSecondaryIndexes` documents; a
			// re-run / reopen rebuilds. Add a try/catch teardown if this ever bites.
			const keyCollation = (table.getConfig().collation || 'NOCASE').toUpperCase();
			const indexStore = await this.provider.getIndexStore(schemaName, tableName, name);
			await buildIndexEntries(
				table.iterateEffectiveEntries(buildFullScanBounds()),
				indexStore,
				newSchema,
				indexSchema,
				keyCollation,
				db.getKeyNormalizerResolver(),
				true, // dup rejection already owned by the arm (ADD validates; RENAME is data-preserving)
				table.getConfig().maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
			);
		}
	}

	/**
	 * Close + delete one index's physical store: release the table's cached handle, then
	 * `deleteIndexStore` when the provider implements it (it closes the handle before
	 * removing the directory), else just `closeIndexStore`.
	 *
	 * The single teardown every path shares — `dropIndex`, `createIndex`'s build-failure
	 * rollback, the implicit `_uc_*` reconcile above, and `DROP COLUMN`'s removed-index
	 * pass (`StoreModuleAlter.alterDropColumn`). Each caller owns the surrounding
	 * posture, which deliberately differs: the DDL-commit flush (buffered ops are keyed
	 * on the KVStore HANDLE, so a doomed store's queued ops would replay into a closed
	 * store at commit — see `StoreModuleBase.ddlCommitPendingOps`) and, for
	 * `createIndex`, swallowing a teardown throw so it cannot mask the build error.
	 */
	protected async tearDownIndexStore(
		schemaName: string,
		tableName: string,
		table: StoreTable,
		indexName: string,
	): Promise<void> {
		await table.releaseIndexStore(indexName);
		if (this.provider.deleteIndexStore) {
			await this.provider.deleteIndexStore(schemaName, tableName, indexName);
		} else {
			await this.provider.closeIndexStore(schemaName, tableName, indexName);
		}
	}
}
