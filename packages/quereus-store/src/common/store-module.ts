/**
 * Generic Store Module for Quereus.
 *
 * A platform-agnostic VirtualTableModule that uses a KVStoreProvider
 * to create StoreTable instances. This enables any storage backend
 * (LevelDB, IndexedDB, React Native, etc.) to be used with the same
 * table implementation.
 *
 * Storage architecture:
 *   - Data store: {schema}.{table} - row data keyed by encoded PK
 *   - Index stores: {schema}.{table}_idx_{name} - one per secondary index
 *   - {prefix}.__stats__ - Unified stats store (row counts for all tables)
 *   - Catalog store: __catalog__ - DDL metadata keyed by {schema}.{table}
 *
 * The class is layered across eight files, each adding one job to the one below:
 *   `store-module-base.ts`         - module state, store handles, coordinator, name collisions
 *   `store-module-catalog.ts`      - the catalog store: DDL entries, shutdown marker, stale-MV set
 *   `store-module-schema-sync.ts`  - rehydration, lazy reconnect, engine schema-change subscription
 *   `store-module-index.ts`        - CREATE / DROP INDEX and the implicit `_uc_*` store reconcile
 *   `store-module-alter-column.ts` - ALTER TABLE ... ALTER COLUMN
 *   `store-module-alter.ts`        - ALTER TABLE dispatch and every other arm
 *   `store-module-rename.ts`       - ALTER TABLE ... RENAME TO (two-phase)
 *   `store-module.ts`              - this file: module lifecycle, capabilities, backing host
 *
 * Three groups read no module state and are free functions instead of layers:
 *   `store-module-access-plan.ts`    - which access path this module advertises
 *   `store-module-index-build.ts`    - index population + UNIQUE validation over a row stream
 *   `store-module-schema-rewrite.ts` - pure schema-to-schema rewrites around DDL
 *
 * A layer may call downward, never upward. Nothing enforces that explicitly — it holds
 * because a base class cannot name a subclass member, so an upward call fails to compile.
 */

import type {
	BackingHost,
	BestAccessPlanRequest,
	BestAccessPlanResult,
	Database,
	LensDeploymentSnapshot,
	MappingAdvertisement,
	ModuleCapabilities,
	Schema,
	SqlValue,
	TableSchema,
	VirtualTableModule,
} from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	buildAdvertisementsFromTags,
	generateDropTableDDL,
	generateTableDDL,
} from '@quereus/quereus';
import { StoreBackingHost } from './backing-host.js';
import { StoreTable } from './store-table.js';
import type { StoreTableModule } from './store-table-base.js';
import {
	CLEAN_SHUTDOWN_META_NAME,
	STALE_MVS_META_NAME,
	buildDataStoreName,
	buildMetaCatalogKey,
} from './key-builder.js';
import { StoreModuleRename } from './store-module-rename.js';
import type { LensDeploymentListener, StoreModuleConfig } from './store-module-base.js';
import { computeBestAccessPlan } from './store-module-access-plan.js';
import { reconcilePkCollations } from './store-module-schema-rewrite.js';

/**
 * Generic store module that works with any KVStoreProvider.
 *
 * Usage:
 * ```typescript
 * import { StoreModule } from '@quereus/store';
 * import { createLevelDBProvider } from '@quereus/store-leveldb';
 *
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const module = new StoreModule(provider);
 * db.registerModule('store', module);
 * ```
 */
export class StoreModule extends StoreModuleRename implements VirtualTableModule<StoreTable, StoreModuleConfig>, StoreTableModule {
	/**
	 * Returns capability flags for this module.
	 *
	 * The base StoreModule does NOT provide transaction isolation: there is no
	 * snapshot isolation and no cross-connection isolation (readers on other
	 * connections see only committed data). Within a transaction, reads through
	 * the table's shared coordinator DO see that transaction's own pending
	 * writes (read-your-own-writes — `StoreTable.query` merges the pending op
	 * view over the committed store). For full isolation, wrap with
	 * IsolationModule:
	 *
	 * ```typescript
	 * import { IsolationModule, MemoryTableModule } from '@quereus/quereus';
	 * import { StoreModule } from '@quereus/store';
	 *
	 * const storeModule = new StoreModule(provider);
	 * const isolatedModule = new IsolationModule({
	 *   underlying: storeModule,
	 *   overlay: new MemoryTableModule(),
	 * });
	 * db.registerModule('store', isolatedModule);
	 * ```
	 */
	getCapabilities(): ModuleCapabilities {
		return {
			isolation: false,
			// Coordinator-buffered ops support savepoint create/release/rollback-to
			// within a transaction (advisory flag — not engine-consulted).
			savepoints: true,
			persistent: true,
			secondaryIndexes: true,
			rangeScans: true,
			// Worst-case summary across this module's DDL. The row-rewriting ALTER arms
			// and renameTable call ddlCommitPendingOps(), which commits the WHOLE module
			// transaction (schema change + every buffered write) at DDL time — a later
			// rollback undoes nothing. Non-committing DDL (create index, add constraint,
			// schema-only arms) is merely non-transactional, but the declared value is
			// the worst case. See docs/store.md § "DDL that implicitly commits".
			ddlTransactionality: 'auto-commit',
		};
	}

	/**
	 * Generic-module mapping advertisements: assembled from the `quereus.lens.decomp.*`
	 * reserved tags on this basis schema's tables. Returns `[]` when the schema has no
	 * such tags, leaving the lens default mapper on its name-match path.
	 * See `docs/lens.md` § The Default Mapper.
	 */
	getMappingAdvertisements(_db: Database, basisSchema: Schema): readonly MappingAdvertisement[] {
		return buildAdvertisementsFromTags(basisSchema);
	}

	/**
	 * Backing-host capability (engine `vtab/backing-host.ts`): resolve the
	 * privileged surface for a store table this module owns, or undefined when the
	 * table is unknown to it. The host binds the CURRENT (StoreTable, coordinator)
	 * pair — `destroy` evicts both maps, so a drop+recreate yields fresh instances
	 * and the returned host is pinned to one backing-table incarnation (the engine
	 * resolves hosts fresh per call, never caching them). Resolution goes through
	 * `StoreModuleSchemaSync.getOrReconnectTable` so a rehydrated-but-untouched (or rename-evicted)
	 * backing still resolves; the ownership pre-check keeps the reconnect fallback
	 * from adopting a registered table owned by a different module (`vtabModule`
	 * must be this StoreModule, or a wrapper — IsolationModule — exposing it as
	 * `underlying`). Attaching the coordinator eagerly makes the shared
	 * StoreTable's read paths merge the host's pending writes (reads-own-writes
	 * for a `select` from the MV mid-transaction).
	 */
	getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const table = this.resolveOwnedTable(db, schemaName, tableName);
		if (!table) return undefined;
		return new StoreBackingHost(table, table.attachCoordinator());
	}

	/**
	 * Resolve a {@link StoreTable} this module owns, reconnecting a
	 * rehydrated-but-untouched (or rename-evicted) table via
	 * `StoreModuleSchemaSync.getOrReconnectTable`. The ownership pre-check keeps the reconnect
	 * fallback from adopting a registered table owned by a DIFFERENT module:
	 * `vtabModule` must be this StoreModule, or a wrapper (IsolationModule)
	 * exposing it as `underlying`. Returns undefined for an unknown/non-owned
	 * table. Shared by {@link getBackingHost} and
	 * {@link getTableForExternalWrite}; neither attaches a coordinator here —
	 * each layers its own pending-state policy on top.
	 */
	private resolveOwnedTable(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		if (!this.tables.has(tableKey)) {
			const registered = db.schemaManager.getTable(schemaName, tableName);
			const wrapper = registered?.vtabModule as { underlying?: unknown } | undefined;
			if (!registered || (registered.vtabModule !== this && wrapper?.underlying !== this)) {
				return undefined;
			}
		}
		return this.getOrReconnectTable(db, schemaName, tableName);
	}

	/**
	 * Resolve the live {@link StoreTable} for an externally-applied write to a
	 * SOURCE table (committed put/delete + secondary-index + stats maintenance via
	 * {@link StoreTable.applyExternalRowChanges}). Returns undefined when the table
	 * is not this module's.
	 *
	 * Resolution goes through {@link resolveOwnedTable} (the shared ownership
	 * pre-check + reconnect fallback). Unlike `getBackingHost` it attaches no
	 * coordinator: external writes target committed storage, and the before-image
	 * read (`readEffectiveRowByKey`) merges any already-attached coordinator's
	 * pending state on its own (none when the table is freshly reconnected).
	 */
	getTableForExternalWrite(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		return this.resolveOwnedTable(db, schemaName, tableName);
	}

	/**
	 * Bind (or clear, with `undefined`) the lens-deployment forwarder. The host
	 * (worker) calls this to route a logical `apply schema`'s deployment to the
	 * sync layer; see {@link notifyLensDeployment}.
	 */
	setLensDeploymentListener(listener: LensDeploymentListener | undefined): void {
		this.lensDeploymentListener = listener;
	}

	/**
	 * Engine `notifyLensDeployment` hook: a logical `apply schema X` fires this on
	 * every registered module once the lens catalog mutation + snapshot rotation
	 * complete (see `VirtualTableModule.notifyLensDeployment`). The store module —
	 * the basis-backing host — forwards the deployment to the bound listener so the
	 * sync layer can update its basis-table lifecycle bookkeeping.
	 *
	 * INVERSION OF THE ENGINE FIRING CONTRACT: the engine documents that a throwing
	 * notification aborts `apply schema X`. We deliberately wrap the listener in
	 * try/catch and SWALLOW (structured-log only) here — lifecycle bookkeeping is
	 * advisory and must never brick a schema apply. A bookkeeping bug is a logged
	 * warning, not a failed deploy.
	 */
	async notifyLensDeployment(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): Promise<void> {
		if (!this.lensDeploymentListener) return;
		try {
			await this.lensDeploymentListener(db, logicalSchemaName, snapshot);
		} catch (e) {
			// Advisory bookkeeping — swallow so a listener bug cannot abort the deploy.
			console.warn(
				`[StoreModule] lens-deployment listener failed for logical schema '${logicalSchemaName}'; `
					+ `lifecycle bookkeeping skipped: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	/**
	 * Creates a new store-backed table.
	 * Called by CREATE TABLE.
	 *
	 * This method eagerly initializes the underlying storage (e.g., IndexedDB object store)
	 * before emitting schema change events. This ensures the storage is ready before any
	 * event handlers (like sync module) try to access it.
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<StoreTable> {
		this.ensureSchemaSubscription(db);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

		if (this.tables.has(tableKey)) {
			throw new QuereusError(
				`Store table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'`,
				StatusCode.ERROR
			);
		}

		const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined);

		// Apply the store's default key collation K to any IMPLICIT-default text PK column
		// (an explicit per-column PK collation is honored natively by the per-column key
		// encoding — see reconcilePkCollations / StoreTable.pkKeyCollations). The reconciled
		// schema is what StoreTable holds and what `finalizeCreatedTableSchema` registers, so
		// an undecorated text PK reports/keys under K rather than the engine BINARY default.
		const keyCollation = (config.collation || 'NOCASE').toUpperCase();
		const reconciledSchema = reconcilePkCollations(tableSchema, keyCollation);

		// Reject when this new table's physical data store name already names an
		// existing store (the only real positive here is data-vs-index: a sibling
		// index store `{schema}.t_idx_<x>` already occupies `{schema}.{thisTable}` —
		// data-vs-data is prevented by engine table-name uniqueness). Must precede
		// `getStore`, which eagerly opens/creates the directory.
		const dataStoreName = buildDataStoreName(tableSchema.schemaName, tableSchema.name);
		this.assertStoreNameFree(
			db,
			tableSchema.schemaName,
			dataStoreName,
			`data store of new table '${tableSchema.schemaName}.${tableSchema.name}'`,
		);

		// Eagerly initialize the store BEFORE creating the table or emitting events.
		// This ensures the underlying storage (e.g., IndexedDB object store) exists
		// before any schema change handlers try to access it.
		const store = await this.provider.getStore(tableSchema.schemaName, tableSchema.name);
		this.stores.set(tableKey, store);

		const table = new StoreTable(
			db,
			this,
			reconciledSchema,
			config,
			this.eventEmitter
			// isConnected defaults to false for newly created tables
		);

		this.tables.set(tableKey, table);

		// Emit schema change event AFTER storage is initialized
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'table',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name,
			ddl: generateTableDDL(reconciledSchema),
		});

		return table;
	}

	/**
	 * Connects to an existing store-backed table.
	 * Called when loading schema from persistent storage.
	 */
	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		options: StoreModuleConfig,
		importedTableSchema?: TableSchema
	): Promise<StoreTable> {
		this.ensureSchemaSubscription(db);
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		// Check if we already have this table connected
		const existing = this.tables.get(tableKey);
		if (existing) {
			return existing;
		}

		// Convert options to Record<string, SqlValue> for vtabArgs
		const vtabArgs: Record<string, SqlValue> = {};
		if (options?.collation !== undefined) vtabArgs.collation = options.collation;
		// `options` is the raw DDL arg record (snake_case keys), so read `max_batch_bytes`,
		// not the parsed `maxBatchBytes` field — the latter is never populated here, which
		// silently dropped a configured budget across reopen. `?? maxBatchBytes` still honors
		// a caller that hands in an already-parsed config.
		const rawMaxBatchBytes = options?.max_batch_bytes ?? options?.maxBatchBytes;
		if (rawMaxBatchBytes !== undefined) vtabArgs.max_batch_bytes = rawMaxBatchBytes as SqlValue;

		// Resolve the table schema:
		// 1. Use importedTableSchema if provided (from catalog import or runtime)
		// 2. Look up from schemaManager (most common case during runtime queries)
		// 3. Fall back to minimal schema (only for cases where table doesn't exist yet)
		let tableSchema: TableSchema;
		if (importedTableSchema) {
			tableSchema = importedTableSchema;
		} else {
			// Try to look up the schema from schemaManager - this is the common runtime case
			const registeredSchema = db.schemaManager.getTable(schemaName, tableName);
			if (registeredSchema) {
				tableSchema = registeredSchema;
			} else {
				// Fallback to minimal schema - should only happen during catalog import
				// when the schema hasn't been registered yet
				tableSchema = {
					name: tableName,
					schemaName: schemaName,
					columns: Object.freeze([]),
					columnIndexMap: new Map(),
					primaryKeyDefinition: [],
					checkConstraints: Object.freeze([]),
					isView: false,
					vtabModuleName: 'store',
					vtabArgs,
					vtabModule: this,
					estimatedRows: 0,
				};
			}
		}

		const config = this.parseConfig(vtabArgs);

		// The load path does NOT reconcile PK collations: a persisted / hand-authored
		// DDL stays loadable as-declared. Physical key bytes are always K-encoded by
		// `StoreTable.encodeOptions`, so a legacy divergent text-PK collation is a
		// stale `table_info` declaration, not a correctness risk. Reconciling the
		// transient `StoreTable` here would be pointless anyway — `importCatalog`'s
		// post-import reconcile loop (`table.updateSchema(fresh)`) immediately
		// overwrites it with the `SchemaManager`-registered schema. A genuine
		// reopen-time migration (an engine import-path hook reconciling the
		// *registered* schema to K) was considered and deliberately not built:
		// only pre-`store-pk-collate-create-time-divergence` data can carry such a
		// DDL, and backwards compatibility is out of scope (AGENTS.md). If legacy
		// migration ever comes into scope, the fix is a module-consulted
		// normalization hook on `importCatalog`/`rehydrateCatalog`.
		const table = new StoreTable(
			db,
			this,
			tableSchema,
			config,
			this.eventEmitter,
			true // isConnected - DDL already exists in storage
		);

		this.tables.set(tableKey, table);
		return table;
	}

	/**
	 * Destroys a store table and its storage.
	 */
	async destroy(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		// Capture the schema BEFORE we drop in-memory references so we can hand the
		// provider the authoritative index list (exact store names) rather than let
		// it prefix-scan `{table}_idx_`, which would also delete a sibling table
		// literally named `{table}_idx_<x>`. Prefer the cached StoreTable's own
		// schema; fall back to the schema manager (mirrors renameTable). If neither
		// yields a schema (already deregistered), fall back to [] — index stores
		// can't be swept by name then, but that is no worse than today for the
		// no-sibling case and strictly safer for the sibling case.
		const table = this.tables.get(tableKey);
		const currentSchema: TableSchema | undefined =
			table?.getSchema() ?? db.schemaManager.getTable(schemaName, tableName);
		// Materialized index list, so the hidden `_uc_*` stores backing plain UNIQUEs are
		// torn down too — the engine-facing `.indexes` omits them and would leak them.
		const indexNames = this.materializedIndexNames(table, currentSchema);

		await this.tearDownTableStorage(schemaName, tableName, indexNames);

		// Emit schema change event for table drop. The `ddl` is what a sync peer
		// re-executes to replicate the drop — a drop with no DDL crosses the wire as
		// an empty statement and silently changes nothing on the receiver.
		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'table',
			schemaName,
			objectName: tableName,
			ddl: generateDropTableDDL(schemaName, tableName),
		});
	}

	/**
	 * Reclaim the local storage of a DETACHED basis table by name — the store-side
	 * target of the sync layer's basis-eviction sweep
	 * (`SyncManager.evictExpiredBasisTables`, `docs/migration.md` § 4 Contract).
	 *
	 * Unlike {@link destroy}, the table is no longer in the engine schema (it was
	 * removed from the basis on detach; only its physical storage lingered), so
	 * there is no `db`/schema to consult and NO schema-change event is emitted — the
	 * engine already saw the detach. The caller (the sync recorder) supplies the
	 * captured secondary-index name list it retained from before detach, because the
	 * table schema (and its index list) is gone: passing the exact names avoids the
	 * provider prefix-scanning `{table}_idx_`, which can clobber a sibling table
	 * literally named `{table}_idx_<x>`.
	 *
	 * Idempotent: any cached handles are evicted and disconnected, then the data /
	 * index / stats stores and the catalog DDL are removed. Storage already gone (a
	 * prior real `drop table` ran `destroy`) is treated as success — the provider's
	 * `deleteTableStores` no-ops on absent stores and `removeTableDDL` no-ops on an
	 * absent key.
	 */
	async reclaimDetachedTable(
		schemaName: string,
		tableName: string,
		indexNames: readonly string[],
	): Promise<void> {
		await this.tearDownTableStorage(schemaName, tableName, indexNames);
	}

	/**
	 * Tear down a table's in-memory handles and physical storage: evict the cached
	 * StoreTable / store / coordinator (synchronously, before any await, so a
	 * concurrent reconnect cannot observe a stale instance mid-teardown), disconnect
	 * the handle, delete the provider's data / index / stats stores (by the exact
	 * index names — never a `{table}_idx_` prefix scan, which could clobber a sibling
	 * table literally named `{table}_idx_<x>`), and remove the catalog DDL.
	 *
	 * Shared by {@link destroy} (live `drop table`) and {@link reclaimDetachedTable}
	 * (post-detach eviction). The caller owns the index-name source (live schema vs.
	 * the captured pre-detach list) and any schema-change event. Idempotent: the
	 * provider no-ops on absent stores and `removeTableDDL` no-ops on an absent key.
	 */
	private async tearDownTableStorage(
		schemaName: string,
		tableName: string,
		indexNames: readonly string[],
	): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();

		const table = this.tables.get(tableKey);
		this.tables.delete(tableKey);
		this.stores.delete(tableKey);
		// NOTE: the coordinator is module-wide and shared by sibling tables, so a
		// single table's teardown must NOT evict the coordinator itself. But the
		// evicted StoreTable's stats-callback pair MUST be deregistered, or its
		// closures (capturing this instance) stay pinned on the shared coordinator
		// for the module's lifetime — a leak bounded by drop/recreate count.
		// table.dispose() both flushes pending stats and runs that disposer.
		if (table) {
			await table.dispose();
		}

		// Delete all stores for this table (data, indexes, stats)
		if (this.provider.deleteTableStores) {
			await this.provider.deleteTableStores(schemaName, tableName, indexNames);
		} else {
			// Fallback: just close the data store
			await this.provider.closeStore(schemaName, tableName);
		}

		// Remove DDL from catalog
		await this.removeTableDDL(schemaName, tableName);
	}

	/**
	 * Modern access planning interface.
	 *
	 * Every plan is stamped with `honorsCollatedRangeBounds`: the store's post-fetch
	 * row filter (`StoreTable.matchesFilters` → `compareValues`) compares each pushed
	 * constraint — including LT/LE/GT/GE range bounds — under the column's declared
	 * collation, so the access path's collation-cover analysis may keep a
	 * collation-matched non-BINARY (NOCASE/RTRIM) PK range/BETWEEN seek instead of
	 * declining to a SeqScan + residual (see `classifyConstraintCover` in
	 * rule-select-access-path.ts). The seek really does narrow: `StoreTable.scanPKRange`
	 * (via `StoreTable.buildPKRangeBounds`) encodes the LT/LE/GT/GE bounds under the
	 * same per-column key collations the data keys use and iterates that
	 * seek-start/early-termination window. The window is a SUPERSET, so the post-fetch
	 * row filter still reproduces the exact collation semantics. (A collation that cannot
	 * key at all never reaches a PK column: `StoreTable`'s constructor rejects it at DDL
	 * time.) Mirrors the memory module's advertisement.
	 *
	 * The seek/ordering claims are additionally gated on the key collation being
	 * ORDER-PRESERVING — byte order and comparator order must coincide, or the seek would
	 * under-fetch and the ordering advertisement would elide a Sort it must not. That gate
	 * needs the connection's collation registry, hence `db` is threaded down.
	 */
	getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		// NOTE: this module does not call `validateAccessPlan` / `validateAccessPlanRequest`,
		// so a malformed request (e.g. a `runtimeSet` whose `maxCount` is not a positive
		// integer) is not rejected at this boundary the way it is for the memory module. It
		// degrades safely instead: `equalitySeekKeyCount` returns null for every malformed
		// shape, so the filter is simply never claimed and survives as a residual. If an
		// engine bug ever needs catching here rather than absorbing, call
		// `validateAccessPlan(request, plan)` on the way out.
		// Table key collation K (default NOCASE). Any K reaching here has a key normalizer:
		// `StoreTable`'s constructor rejects one that cannot key, and a name we cannot resolve
		// to a table falls back to the built-in NOCASE. `||`, not `??`, so an empty-string
		// `config.collation` reads as the default here exactly as it does in
		// `StoreTable.encodeOptions` — the two must agree or `analyzePKAccess` would decline a
		// window `computeBestAccessPlan` already marked handled.
		const tableKeyCollation = (this.getTable(tableInfo.schemaName, tableInfo.name)?.getConfig().collation || 'NOCASE').toUpperCase();
		return { ...computeBestAccessPlan(db, tableInfo, request, tableKeyCollation), honorsCollatedRangeBounds: true };
	}

	/**
	 * Close all stores.
	 */
	async closeAll(): Promise<void> {
		// Capture the stale-at-close MV set BEFORE the unsubscribe block clears
		// `subscribedDb`. Nothing between here and the marker write can change these
		// flags (closeAll only drains the persist queue and disconnects tables).
		// `stale` is in-memory-only runtime state — an MV whose row-time maintenance was
		// detached mid-session (any `table_modified` on a source: an ALTER, even a
		// `create index`) so subsequent source writes never reached its backing. Carrying
		// the names lets the next open exclude exactly those from the adopt fast path.
		//
		// No subscribed db (this module was opened but never rehydrated and never had a
		// store table created/connected) ⇒ the empty set: every path that can mark an MV
		// stale requires a session in which this module observed the db — a store source
		// create/connect (both call `ensureSchemaSubscription`) or `rehydrateCatalog`
		// (subscribes up front) — so a session without `subscribedDb` never detached any
		// persisted MV's maintenance. Memory-backed MVs that appear in the set are
		// harmless: their catalog entries always refill (no phase-1 pre-existing backing),
		// so withholding trust from them is a no-op.
		const staleAtClose = this.computeStaleMvSet();

		// Stop listening first so no new persist work is enqueued mid-close, then drain
		// the queued catalog writes (tag swaps) before the provider closes.
		if (this.schemaListenerUnsub) {
			this.schemaListenerUnsub();
			this.schemaListenerUnsub = undefined;
			this.subscribedDb = undefined;
		}
		await this.persistQueue;

		for (const table of this.tables.values()) {
			await table.disconnect();
		}
		this.tables.clear();
		this.moduleCoordinator = undefined;

		// Every batch has flushed (persist queue drained, tables disconnected):
		// attest the clean shutdown so the next open may take the materialized-view
		// adopt fast path. The marker VALUE is the JSON stale-at-close set (`[]` when
		// nothing is stale) — `rehydrateCatalog` excludes those MVs from the fast path
		// so they refill. Consumed (single-use) by `rehydrateCatalog`. Written LAST,
		// immediately before the provider closes — anything that dies before this line
		// leaves no marker and the next open refills everything.
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(
			buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME),
			new TextEncoder().encode(JSON.stringify(staleAtClose)),
		);

		// Also write the DURABLE stale-MV set (persistent current-truth, NOT single-use) —
		// but ONLY for an atomic provider, the sole reader/truster of it (see
		// `StoreModuleBase.atomicProvider`). Same array as the marker payload, under a separate
		// reserved meta key that the next open READS (never deletes). In the atomic-commit
		// domain this — not the crash-losable marker — is the adopt fast path's
		// logical-staleness exclusion basis, so a clean close (a) corrects any rename-restore
		// drift (the one staleness CLEAR transition that fires no event) and (b) guarantees
		// the entry exists even in a session with no staleness events. `provider.closeAll()`
		// below flushes it.
		if (this.atomicProvider) {
			await catalogStore.put(
				buildMetaCatalogKey(STALE_MVS_META_NAME),
				new TextEncoder().encode(JSON.stringify(staleAtClose)),
			);
		}

		await this.provider.closeAll();
		this.stores.clear();
	}
}
