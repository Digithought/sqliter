/**
 * ALTER TABLE ... RENAME TO: the two-phase table rename. The first phase relocates the
 * physical data / index / stats stores and writes the new catalog entry while leaving
 * the old entry in place; the second, called by the engine once every dependent object
 * has been rewritten, drains those dependent catalog writes and only then drops it.
 *
 * Seventh layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type { Database, DatabaseInternal, TableSchema } from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	renameTableInCheckConstraints,
	renameTableInIndexPredicates,
} from '@quereus/quereus';
import { StoreConnection } from './store-connection.js';
import { buildDataStoreName, buildIndexStoreName, buildStatsKey } from './key-builder.js';
import { StoreModuleAlter } from './store-module-alter.js';
import { collectOccupiedStoreNames } from './store-module-base.js';
import { retargetSelfForeignKeys } from './store-module-schema-rewrite.js';

export abstract class StoreModuleRename extends StoreModuleAlter {
	/**
	 * Rename a store-backed table.
	 *
	 * Drops every in-memory reference to the old name (so the coordinator, open
	 * handles, and cached StoreTable instance don't linger with stale paths),
	 * delegates physical storage relocation to the provider, then rewrites the
	 * persistent catalog DDL under the new key. After this returns, the next
	 * access to `newName` will reconnect via `connect()` and open fresh stores
	 * against the moved directories.
	 */
	async renameTable(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
		ddl?: string,
	): Promise<void> {
		const oldKey = `${schemaName}.${oldName}`.toLowerCase();
		const newKey = `${schemaName}.${newName}`.toLowerCase();

		if (this.tables.has(newKey)) {
			throw new QuereusError(
				`Store table '${newName}' already exists in schema '${schemaName}'`,
				StatusCode.ERROR,
			);
		}

		// Capture the current schema BEFORE the guard (and before we drop in-memory
		// references): the guard needs the index list to compute every relocated
		// store name, and the new catalog DDL must reflect the real column set.
		const existing = this.tables.get(oldKey);
		const currentSchema: TableSchema | undefined =
			existing?.getSchema() ?? db.schemaManager.getTable(schemaName, oldName);

		// Authoritative index list (exact store names): the provider relocates
		// exactly these index stores instead of prefix-scanning `{oldName}_idx_`,
		// which would also catch a sibling table named `{oldName}_idx_<x>`.
		// MATERIALIZED, so the hidden `_uc_*` store realizing a plain UNIQUE moves with
		// the table — otherwise the renamed table seeks a fresh EMPTY `_uc_*` and silently
		// accepts a duplicate of a pre-rename row. `currentSchema` itself stays
		// non-materialized: the catalog DDL rewritten below must carry no `_uc_*`.
		const indexNames = this.materializedIndexNames(existing, currentSchema);

		// Reject when ANY physical name the rename introduces — the new data store
		// AND each relocated index store `{schema}.{newName}_idx_{x}` — already
		// names an existing store. E.g. rename some table to `q_idx_archive` while
		// table `q` has index `archive` (both → `{schema}.q_idx_archive`); or rename
		// `t`→`u` while `t` has index `x` and a sibling table is literally named
		// `u_idx_x`, which would relocate `t`'s index onto the sibling's data store.
		// The renamed table's own current stores stay in the occupied set (see
		// collectOccupiedStoreNames): an introduced name can only equal an own store
		// in a footprint-swap rename providers cannot relocate safely. All checks
		// run before the FIRST side effect (the coordinator commit, disconnect, and
		// cache evictions below, then the physical relocation) so a colliding
		// rename is a clean no-op.
		const occupied = collectOccupiedStoreNames(this.tables.values(), db, schemaName, this);
		this.assertStoreNameFree(
			db,
			schemaName,
			buildDataStoreName(schemaName, newName),
			`data store of table '${schemaName}.${newName}' (rename target)`,
			occupied,
		);
		for (const indexName of indexNames) {
			this.assertStoreNameFree(
				db,
				schemaName,
				buildIndexStoreName(schemaName, newName, indexName),
				`index store of index '${indexName}' on table '${schemaName}.${newName}' (rename target)`,
				occupied,
			);
		}

		// Flush buffered writes before the old store's handle is closed: once the
		// on-disk directory moves, prior buffered ops address stores that no longer
		// exist under those names. See `StoreModuleBase.ddlCommitPendingOps`.
		await this.ddlCommitPendingOps();

		// Hard-dispose the evicted handle: flush any lazy stats it was buffering AND
		// deregister its coordinator stats-callback pair (the renamed instance is
		// gone after this — the next connect()/getOrReconnectTable mints a fresh one
		// that re-registers against the shared coordinator). Dispose failures must
		// not block the physical rename.
		if (existing) {
			try {
				await existing.dispose();
			} catch {
				/* ignore — physical rename must proceed */
			}
		}

		this.tables.delete(oldKey);
		this.stores.delete(oldKey);
		// The coordinator is module-wide (flushed above); it is not per-table, so
		// it is not evicted here.

		// Evict the disposed instance's registered engine connections — but ONLY the
		// ones this module created. Unlike drop — where the engine's schema manager
		// calls `removeConnectionsForTable` for us — the generic rename path
		// (`alter-table.ts` renameTableImpl) does NOT, so the store must evict here or
		// a StoreConnection leaks one per rename. Safe for `StoreConnection`s (both the
		// StoreTable-owned DML connection and the StoreBackingHost-owned one): they hold
		// no state of their own, delegating to the module-wide coordinator that the
		// DDL-commit above already flushed, and their owning StoreTable is now disposed.
		//
		// A blanket name-keyed sweep is NOT safe: a wrapping module (the isolation layer)
		// registers its own connection under the same qualified name, and that connection
		// is the only thing that drives its staged overlay to storage at COMMIT. Evicting
		// it silently drops the transaction's writes.
		//
		// NOTE: a rename onto a never-before-used name leaves the wrapper's connection
		// registered under the stale old name (it is not retargeted here). Benign — the
		// commit flush resolves overlays db-wide by their re-keyed names — but a workload
		// that renames one table through many distinct names in a single process
		// accumulates one such connection per name. If that ever matters, retarget the
		// connection's `tableName` across the rename instead of leaving it stale.
		const oldQualified = `${schemaName}.${oldName}`.toLowerCase();
		for (const conn of (db as DatabaseInternal).getAllConnections()) {
			if (conn instanceof StoreConnection && conn.tableName.toLowerCase() === oldQualified) {
				(db as DatabaseInternal).removeConnection(conn.connectionId);
			}
		}

		// Move physical storage (data directory + index directories).
		//
		// NOTE: the relocation runs BEFORE the catalog rewrite below, and nothing undoes it.
		// Any failure after this point — an IO error, or the DDL-text guard in
		// `encodeCatalogDDL` firing on an unpaired surrogate in a column name or a `default`
		// literal — strands the rows under the NEW physical name while the catalog still
		// names the old table, so the table reads as empty with only the raised error as a
		// clue. Harmless for today's validation cases: the store-name guard in
		// `buildDataStoreName` (called above, before any side effect) refuses a bad target
		// name outright, and a table whose DDL text is unpersistable can never have held
		// rows in the first place. If a new post-relocation failure mode appears, the
		// relocation must be undone here or deferred until after the catalog write.
		if (this.provider.renameTableStores) {
			await this.provider.renameTableStores(schemaName, oldName, newName, indexNames);
		}

		// Rewrite persistent catalog under the new name. Write the new DDL first
		// so a crash mid-rename leaves the table discoverable under at least one
		// name rather than neither.
		if (currentSchema) {
			const renamedSchema: TableSchema = {
				...currentSchema,
				name: newName,
				// A self-referencing FK is persisted as `references <oldName>(...)`; after
				// `removeTableDDL` below, that names a table no longer in the catalog. Pure
				// copy — no rollback needed, `renamedSchema` is local to the write.
				foreignKeys: retargetSelfForeignKeys(currentSchema.foreignKeys, schemaName, oldName, newName),
			};
			// A partial index's WHERE clause and a CHECK constraint's expression can each
			// carry a table-qualified self-reference (`where t.b > 0`) still naming the OLD
			// table: `propagateTableRename` runs only after this hook returns, so — exactly
			// as in the `renameColumn` arm of `alterTable` — persisting now would durably
			// write a stale qualifier that only the later propagation event corrects.
			// Rewrite first, in place (each `Expression` is shared with the catalog
			// `TableSchema` and, for a unique partial index, with its derived UNIQUE
			// constraint), which also makes that later pass a no-op for these fields. A
			// throw anywhere in the `try` — including partway through a walk — reverses the
			// rewrites; reversing is a no-op wherever nothing names `newName`. The physical
			// stores have already moved by this point, so the reverse restores only the AST,
			// not the on-disk layout.
			//
			// NOTE: the reverse assumes no expression legitimately named `newName` before
			// the rename. The rename-target guard above makes that true for a real table,
			// and `compilePredicate` now rejects a foreign `table` qualifier at create time,
			// so a live partial-index predicate can only carry a self-qualifier (`where
			// <thisTable>.b > 0`) or a bare reference — never `where <newName>.b > 0` for a
			// different table. The mis-reversal path is therefore unreachable for a live
			// predicate.
			const rewriteTable = (from: string, to: string): void => {
				renameTableInIndexPredicates(currentSchema.indexes, from, to, schemaName);
				renameTableInCheckConstraints(currentSchema.checkConstraints, from, to, schemaName);
			};
			try {
				rewriteTable(oldName, newName);
				await this.saveTableDDL(renamedSchema);
			} catch (e) {
				rewriteTable(newName, oldName);
				throw e;
			}
		}

		// NOTE: the OLD name's catalog entry is deliberately NOT removed here. Deleting it
		// synchronously would drop `oldName` from the catalog BEFORE the engine's post-hook
		// `propagateTableRename` has rewritten — let alone persisted — the OTHER tables /
		// views / MVs that still name `oldName` (a cross-schema FK, a CHECK expression, a
		// dependent view/MV body). A crash in that gap would strand a durable catalog set
		// naming a vanished table, which reopens as a healthy-looking database whose
		// dependents cannot be written to. The removal is deferred to `finalizeRename`,
		// which the engine calls AFTER propagation has made the dependents durable.

		// Migrate the stats entry (unified __stats__ store, keyed by schema.table).
		// The entry is RE-KEYED, not physically moved with the directory: a unified
		// store keys every table's stats under `schema.table` in one store, so the
		// value must be copied from the old key to the new key and the old key
		// dropped. `dispose()` above already flushed any buffered delta to disk under
		// the old key, so the read here sees the current row-count estimate; deleting
		// without copying (the prior behavior) blinded the planner — a freshly-renamed
		// table reported getEstimatedRowCount() === 0 until stats were re-gathered.
		//
		// NOTE: this re-key reaches the old value only when getStatsStore(newName)
		// returns a store that CONTAINS the old key — true for the shipped providers,
		// which all share one unified __stats__ store, and for any provider whose
		// renameTableStores physically relocates a per-table stats store. A provider
		// that kept per-table stats stores and did NOT relocate them in
		// renameTableStores would orphan the old-keyed value out of reach here (the
		// prior delete-only code lost it just the same — no regression). No shipped
		// provider does this; revisit if one ever keeps per-table, non-relocated stats.
		try {
			const statsStore = await this.provider.getStatsStore(schemaName, newName);
			const oldStatsKey = buildStatsKey(schemaName, oldName);
			const statsValue = await statsStore.get(oldStatsKey);
			if (statsValue) {
				// A table with no stats yet (never flushed) returns undefined here —
				// skip the copy so no spurious zero-count entry lands under the new key.
				await statsStore.put(buildStatsKey(schemaName, newName), statsValue);
			}
			await statsStore.delete(oldStatsKey);
		} catch {
			/* stats are advisory — a stats hiccup must never block the rename */
		}

		// Same emit-iff-`ddl` rule as `StoreModuleAlter.alterTable`: `ddl` set means this
		// call IS the RENAME TO statement's action; absent means an engine-internal step
		// (e.g. the shadow-table rebuild's trailing rename) that must announce nothing.
		// `oldObjectName` says what the table renamed FROM — `objectName` names only the
		// new table, and a receiver could not otherwise tell which of its tables moved.
		if (ddl !== undefined) {
			this.eventEmitter?.emitSchemaChange({
				type: 'alter',
				objectType: 'table',
				schemaName,
				objectName: newName,
				oldObjectName: oldName,
				ddl,
			});
		}
	}

	/**
	 * Second phase of a two-phase RENAME TABLE (see {@link renameTable}). The engine calls
	 * this at the END of ALTER TABLE ... RENAME TO — AFTER its `propagateTableRename` has
	 * rewritten every dependent object that named `oldName` and enqueued their corrective
	 * catalog writes onto `StoreModuleBase.persistQueue`. `renameTable` deliberately left `oldName`'s
	 * catalog entry in place; here we drain those dependent writes to durability and only
	 * THEN drop the old entry. During the window both entries coexist on disk, so every
	 * dependent resolves against one of them and every intermediate catalog set rehydrates
	 * into a working database.
	 *
	 * The old-entry delete rides `persistQueue` behind the dependents' already-enqueued
	 * writes (FIFO), so it can only run after them, and the drain below awaits the whole
	 * chain. Errors are swallowed+logged (the `StoreModuleBase.enqueuePersist` contract): a failed
	 * delete leaves the old entry present — a visible, droppable orphan, strictly safer
	 * than a dependent stranded against a vanished table.
	 *
	 * NOTE: full cross-table atomicity — bundling this old-entry delete together with every
	 * dependent rewrite into one `provider.beginAtomicBatch` commit — would eliminate even
	 * the transient two-entry window (and the physical-move orphan `renameTableStores`
	 * leaves), but only on atomic providers, and the dependent set is known only to the
	 * engine post-propagate. That is the atomic-provider hardening path; out of scope here.
	 */
	async finalizeRename(
		_db: Database,
		schemaName: string,
		oldName: string,
		_newName: string,
	): Promise<void> {
		this.enqueuePersist(() => this.removeTableDDL(schemaName, oldName));
		await this.whenCatalogPersisted();
	}
}
