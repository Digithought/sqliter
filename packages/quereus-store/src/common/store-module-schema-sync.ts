/**
 * Keeping the engine's live schema and the persisted catalog in agreement, in both
 * directions: reading the catalog back at open (rehydration), lazily reconnecting a
 * table the engine already knows about, and reacting to the engine's schema-change
 * notifications (catalog-only tag swaps, view/materialized-view DDL upkeep, and the
 * stale-materialized-view set that survives a restart).
 *
 * Third layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type { Database, SchemaChangeEvent as EngineSchemaChangeEvent, TableSchema } from '@quereus/quereus';
import { isMaintainedTable } from '@quereus/quereus';
import { StoreTable } from './store-table.js';
import { buildCatalogKey, classifyCatalogKey, parseMaterializedViewCatalogKey } from './key-builder.js';
import { StoreModuleCatalog } from './store-module-catalog.js';

/**
 * Result of catalog rehydration.
 *
 * `views` / `materializedViews` are additive (existing consumers — e.g.
 * `quoomb-web` — read only `.errors`). Errors from any phase land in `errors`.
 */
export interface RehydrationResult {
	tables: string[];
	indexes: string[];
	views: string[];
	materializedViews: string[];
	errors: RehydrationError[];
}

/**
 * An error encountered while rehydrating a single DDL entry.
 */
export interface RehydrationError {
	ddl: string;
	error: Error;
}

export abstract class StoreModuleSchemaSync extends StoreModuleCatalog {
	/**
	 * Returns the connected StoreTable for `schemaName.tableName`, lazily
	 * reconnecting from the engine's schema registry when absent.
	 *
	 * `renameTable` evicts the old key from `this.tables` and expects the next
	 * `connect()` to repopulate under the new name, but `apply schema` can run
	 * follow-up DDL (ALTER TABLE, CREATE/DROP INDEX) against the new name
	 * without an intervening connect. Mirror connect()'s schemaManager lookup
	 * so that DDL finds the moved table. Safe for the index paths because
	 * SchemaManager calls the module BEFORE mutating the registered table
	 * schema, so the reconnected cache matches what a connected instance holds.
	 */
	protected getOrReconnectTable(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		let table = this.tables.get(tableKey);
		if (!table) {
			const registeredSchema = db.schemaManager.getTable(schemaName, tableName);
			if (registeredSchema) {
				table = new StoreTable(
					db,
					this,
					registeredSchema,
					this.parseConfig(registeredSchema.vtabArgs ?? {}),
					this.eventEmitter,
					true, // isConnected - DDL already exists in storage
				);
				this.tables.set(tableKey, table);
			}
		}
		return table;
	}

	/**
	 * Rehydrate the persisted catalog into the in-memory schema manager, in
	 * dependency order.
	 *
	 * Establishes the engine schema-change subscription up front (so a reopened DB
	 * persists subsequent DDL even when its first post-reopen statement is a view/MV,
	 * which never routes through a module hook — all the lazy subscription points are
	 * table hooks). Then loads every catalog entry once, classifies each by its key
	 * prefix into {tables, views, materialized views}, and imports in three phases:
	 *
	 *   1. **Tables** — `importCatalog` (connect to existing storage; refresh connected
	 *      `StoreTable` schemas).
	 *   2. **Views** — `importCatalog` (engine silent-register; body validation deferred
	 *      to query time, so order among views — and view-over-MV / view-over-view —
	 *      does not matter, and no schema-change event fires → phase 2 writes nothing).
	 *   3. **Materialized views** — `importCatalog` per entry (engine re-materialize:
	 *      rebuilds the memory backing from current source data, re-registers row-time
	 *      maintenance, re-runs the eligibility gate — the same core the create emitter
	 *      uses, but silent: no `materialized_view_added` fires, so phase 3 writes
	 *      nothing back to the catalog). A store-hosted backing that phase 1 already
	 *      rehydrated is **adopted without the refill** when the engine's adopt gates
	 *      pass — see the clean-shutdown marker below.
	 *
	 * **Clean-shutdown marker.** Before anything loads, the reserved
	 * `\x00meta\x00clean_shutdown` catalog entry (written by `StoreModule.closeAll` after
	 * every batch flushed) is consumed: parsed into `{ trusted, staleAtClose }`, then
	 * **deleted immediately** — single-use, so a crash later in this session (or a
	 * second rehydrate without an intervening clean close) is detected at the next open
	 * and every adopt falls back to the always-correct drop+refill, self-healing any
	 * crash-window divergence (coordinated commit is not 2PC across stores). The marker
	 * payload is the JSON set of MVs that were **stale-at-close** (row-time maintenance
	 * detached, so the durable backing may be behind); phase 3 withholds trust per-entry
	 * for those — `trustBackings: trusted && !staleAtClose.has(name)` — so a
	 * stale-at-close MV refills (recomputing content and re-arming maintenance) while
	 * every live-at-close MV keeps the fast path. The one shared `adoptedBackings` set
	 * composes across fixpoint rounds (an upstream MV adopted in round 1 enables its
	 * dependent in round 2, while a refilled — or stale-at-close — upstream is never
	 * added to it, forcing dependents to refill).
	 *
	 * **MV-over-MV ordering** is handled by a fixpoint retry rather than a static topo
	 * sort: an MV's resolved `sourceTables` are computed at import time, not serialized
	 * in the DDL, so they are unavailable before import. Each round passes the names of
	 * every OTHER still-pending MV entry as `pendingDerivations`; the engine defers any
	 * entry whose body reads one (its source already pre-exists as a phase-1 plain
	 * table, so the body would otherwise plan against content the upstream's own import
	 * may be about to replace). The loop repeats while any MV makes progress — robust to
	 * arbitrary nesting depth. A genuinely unbuildable MV — a missing (e.g. memory)
	 * source, or an unresolvable cycle — makes no progress in a round and is recorded in
	 * `errors`.
	 *
	 * Per-entry errors in any phase are collected (not fatal) so one bad object does not
	 * abort the rest.
	 *
	 * Call after `db.registerModule()` (and `db.setDefaultVtabName()` if DDL may lack a
	 * USING clause).
	 */
	async rehydrateCatalog(db: Database): Promise<RehydrationResult> {
		// Subscribe up front: a reopened DB whose first post-reopen DDL is a view/MV
		// would otherwise miss the event (the lazy `ensureSchemaSubscription` points are
		// all table hooks). Done even for an empty catalog. (Documented gap: a brand-new
		// DB — never rehydrated — whose very first DDL is a view still relies on a prior
		// store-table create/connect to establish the subscription.)
		this.ensureSchemaSubscription(db);

		// Capability gate (method presence — matching the coordinator's own gate): an
		// atomic-commit provider commits a source write and its same-module backing in
		// one all-or-nothing batch, so a crash can no longer tear them apart (the
		// crash-divergence window gate 5 historically guarded). In that domain, gate 4
		// alone governs same-module backings and a non-stale backing adopts after a crash
		// too — the LOGICAL-staleness window is closed instead by the durable stale-MV
		// set, which (unlike the clean-shutdown marker) survives a crash. A non-atomic
		// provider never writes the set (see `StoreModuleBase.atomicProvider`), so skip the read.
		const atomic = this.atomicProvider;
		const durableStale = atomic ? await this.readDurableStaleMvSet() : { present: false } as const;

		// Consume the clean-shutdown marker FIRST (before the catalog scan): in the
		// non-atomic domain its presence is the adopt trust basis for this rehydration
		// only, and deleting it immediately makes it single-use. Its payload names the MVs
		// that were stale-at-close. Always consumed for single-use hygiene even in the
		// atomic branch (where its trust bit is ignored in favor of the durable set).
		const { trusted, staleAtClose } = await this.consumeCleanShutdownMarker();

		// Per-entry adopt trust basis, capability-aware:
		// - Atomic domain WITH a durable stale-set on disk → gate 4 alone governs; the
		//   marker is NOT required, so a non-stale backing adopts even after a crash. A
		//   present-but-unparseable stale-set (`stale === null`) refills everything.
		// - Otherwise (non-atomic provider, OR atomic but no stale-set yet — the upgrade
		//   path) → today's marker path, byte-for-byte.
		const trustBacking = (name: string): boolean =>
			atomic && durableStale.present
				? durableStale.stale !== null && !durableStale.stale.has(name)
				: trusted && !staleAtClose.has(name);

		const entries = await this.loadCatalogEntries();
		const result: RehydrationResult = { tables: [], indexes: [], views: [], materializedViews: [], errors: [] };
		if (entries.length === 0) return result;

		const recordError = (ddl: string, e: unknown): void => {
			const error = e instanceof Error ? e : new Error(String(e));
			console.warn(
				`[StoreModule] Failed to rehydrate DDL entry, skipping: ${error.message}\n  DDL: ${ddl.substring(0, 120)}`,
			);
			result.errors.push({ ddl, error });
		};

		// Classify every loaded entry by key prefix. The full-range catalog scan returns
		// table, view, and MV entries intermixed; each must reach the correct phase — a
		// view/MV entry fed to the table-phase importCatalog would fail-loud or mis-handle.
		const tableDDLs: string[] = [];
		const viewDDLs: string[] = [];
		// MV entries retain their qualified `schema.mv` name (derived from the catalog
		// key) so phase 3 can withhold the adopt fast path per-entry for any MV that
		// was stale-at-close.
		const mvEntries: Array<{ name: string; ddl: string }> = [];
		for (const { key, ddl } of entries) {
			switch (classifyCatalogKey(key)) {
				case 'view': { viewDDLs.push(ddl); break; }
				case 'materializedView': { mvEntries.push({ name: parseMaterializedViewCatalogKey(key), ddl }); break; }
				// Meta entries are store-internal, never DDL. (The marker itself was
				// already consumed above; this guards any future meta key.)
				case 'meta': { break; }
				default: { tableDDLs.push(ddl); break; }
			}
		}

		// Phase 1 — tables. Per-entry import isolates a corrupt entry so the rest load.
		for (const ddl of tableDDLs) {
			try {
				const imported = await db.schemaManager.importCatalog([ddl]);
				result.tables.push(...imported.tables);
				result.indexes.push(...imported.indexes);
			} catch (e) {
				recordError(ddl, e);
			}
		}

		// Phase 2 — views (silent register; deferred body validation → order-independent).
		for (const ddl of viewDDLs) {
			try {
				const imported = await db.schemaManager.importCatalog([ddl]);
				result.views.push(...imported.views);
			} catch (e) {
				recordError(ddl, e);
			}
		}

		// Phase 3 — materialized views, dependency-ordered via fixpoint retry (see
		// docstring). One shared adopt ledger across all rounds: adopted upstream
		// backings unlock their dependents' adoption in later rounds.
		const adoptedBackings = new Set<string>();
		let pending = mvEntries;
		while (pending.length > 0) {
			const failed: Array<{ entry: { name: string; ddl: string }; error: unknown }> = [];
			let progressed = false;
			for (const entry of pending) {
				try {
					// Ordering gate (unified model): a dependent's source may already
					// pre-exist as the upstream's phase-1 *plain* table, so its body
					// PLANS before the upstream's own MV entry has imported. Pass the
					// names of every OTHER still-pending MV entry; the engine defers
					// (throws → retried next round) any entry whose body reads one.
					const pendingDerivations = new Set(
						pending.filter(p => p !== entry).map(p => p.name),
					);
					// Trust this backing only when the per-entry capability-aware basis
					// (`trustBacking`) holds: in the atomic domain a non-stale backing is
					// trusted (even after a crash); otherwise a clean shutdown AND not
					// stale-at-close. A withheld MV refills — recomputing content and
					// re-arming maintenance (clearing `stale`) — and is never added to
					// `adoptedBackings`, so the ledger gate forces its MV-over-MV dependents
					// to refill too.
					const imported = await db.schemaManager.importCatalog([entry.ddl], {
						trustBackings: trustBacking(entry.name),
						adoptedBackings,
						pendingDerivations,
					});
					result.materializedViews.push(...imported.materializedViews);
					progressed = true;
				} catch (e) {
					failed.push({ entry, error: e });
				}
			}
			if (!progressed) {
				// No MV built this round → the remaining failures are genuine (missing
				// source, ineligible body, unresolvable cycle). Record them and stop.
				for (const f of failed) recordError(f.entry.ddl, f.error);
				break;
			}
			pending = failed.map(f => f.entry);
		}

		// Refresh each connected StoreTable from the now-current registry. During
		// import, `importTable` connects a StoreTable holding the table-only schema,
		// then `importIndex` appends the index (and its derived UNIQUE constraint) to
		// the SchemaManager's registered schema but NOT to that live StoreTable
		// instance — `importCatalog` deliberately skips module hooks to stay generic,
		// so the store module reconciles here. Without this, DML on a rehydrated table
		// would not maintain its indexes and the derived UNIQUE would not enforce.
		for (const table of this.tables.values()) {
			const current = table.getSchema();
			const fresh = db.schemaManager.getTable(current.schemaName, current.name);
			if (fresh) table.updateSchema(fresh);
		}

		// Recompute the durable stale-MV set from the now-current flags and compare-write
		// it: refilled MVs cleared `stale`, adopted MVs were never stale, so the on-disk
		// entry (which a crash may have left naming an MV this rehydrate just refilled)
		// now reflects post-rehydrate truth — preventing a wasteful re-refill at the next
		// open. Phase 3's `importCatalog` is silent (no schema-change events fire), so the
		// listener never ran this rehydration; this explicit tail write establishes the
		// session baseline (`lastPersistedStaleMvs`). It rides `persistQueue`, drained by
		// the next `closeAll`/`whenCatalogPersisted`. (An optimization, not soundness: a
		// crash before it lands leaves a stale-set that only over-names → a sound refill.)
		this.persistStaleMvSetIfChanged();

		return result;
	}

	/**
	 * Subscribe (once) to the engine's `SchemaChangeNotifier` so catalog-only
	 * mutations that bypass `module.alterTable` — notably `ALTER … SET TAGS` and the
	 * programmatic `setTableTags`/`setColumnTags`/`setConstraintTags` — still re-persist
	 * the table's catalog DDL. Called lazily from the first `create`/`connect`/
	 * `alterTable` hook that hands us a `db`.
	 *
	 * One `StoreModule` instance is assumed to serve one `Database`. A later hook
	 * carrying a *different* `db` keeps the existing subscription (multi-database
	 * sharing of a single module instance is out of scope) and logs.
	 */
	protected ensureSchemaSubscription(db: Database): void {
		if (this.schemaListenerUnsub) {
			if (this.subscribedDb && this.subscribedDb !== db) {
				console.warn(
					'[StoreModule] ensureSchemaSubscription called with a different Database; '
						+ 'keeping the existing subscription (one module instance is assumed to serve one Database).',
				);
			}
			return;
		}
		this.subscribedDb = db;
		// A fresh subscription has no on-disk stale-set baseline yet (this module never
		// wrote one this session); reset so the first relevant event — or the rehydrate
		// tail — re-establishes it rather than comparing against a prior subscription's.
		this.lastPersistedStaleMvs = undefined;
		this.schemaListenerUnsub = db.schemaManager.getChangeNotifier().addListener(this.onEngineSchemaChange);
	}

	/**
	 * Engine schema-change listener. Persists the catalog incrementally for the events
	 * that bypass `module.alterTable` / `module.destroy`:
	 *
	 * - `table_modified` — every catalog-only tag swap (and the redundant follow-up a
	 *   structural ALTER fires). Keeps a connected `StoreTable`'s cached schema consistent
	 *   (SET TAGS does not call `updateSchema`) then read-compare-writes the table bundle.
	 * - `view_added` / `view_modified` / `view_removed` — plain `CREATE`/`ALTER … SET TAGS`/
	 *   `DROP VIEW` (the engine fires these from the runtime emitters).
	 * - `materialized_view_added` / `_modified` / `_refreshed` / `_removed` — MV lifecycle.
	 *   Like `table_modified`, the `_added`/`_modified`/`_refreshed` arms also synchronously
	 *   refresh the connected `StoreTable`'s cached schema so a tag change (e.g.
	 *   `quereus.sync.replicate`) takes effect immediately without reopen.
	 *
	 * Unlike the table path there is **no** catalog-absent self-filter for view/MV
	 * add/remove: one `StoreModule` instance serves one `Database`, so that database's
	 * views/MVs belong in its catalog unconditionally. A MEMORY-hosted maintained table
	 * fires `table_added`/`table_removed`/`table_modified` like any table; those stay
	 * ignored (`table_added`/`table_removed` fall through; its `table_modified` is
	 * catalog-absent → skipped), so only the MV entry persists for it. A STORE-hosted
	 * maintained table additionally persists its own table bundle through the ordinary
	 * store-table machinery (which phase-1 rehydrate connects for the adopt fast path).
	 *
	 * Synchronous by contract (`notifyChange` does not await listeners); every async write
	 * rides `persistQueue`, drained by `closeAll`/`whenCatalogPersisted`.
	 *
	 * After dispatching the event's own catalog persistence, the listener recomputes the
	 * durable stale-MV set and compare-writes it (see {@link persistStaleMvSetIfChanged}).
	 * Because the engine's MV manager subscribes to the same notifier in the `Database`
	 * constructor — before this lazy subscription — its listener runs first, so the
	 * `derivation.stale` flags are already current when this recompute reads them.
	 */
	private onEngineSchemaChange = (event: EngineSchemaChangeEvent): void => {
		this.dispatchSchemaChange(event);
		// Every staleness SET transition is bracketed by an event observed here (a source
		// `table_modified`/`table_removed`, or the synthetic backing-invalidation
		// `table_modified` for an MV-over-MV cascade), and every CLEAR but the no-event
		// rename-restore fires one too — so recompute on each event keeps the durable set
		// current. Enqueued on `persistQueue` AFTER the dispatch above, so the `sync` lands
		// after the event's own source-DDL write is queued (the durability ordering the
		// adopt soundness argument relies on — see `docs/mv-backing-host.md` § Cross-module atomicity).
		this.persistStaleMvSetIfChanged();
	};

	/** Dispatch a single engine schema-change event to its catalog-persistence arm. */
	private dispatchSchemaChange(event: EngineSchemaChangeEvent): void {
		switch (event.type) {
			case 'table_modified': {
				// SET TAGS does not call `table.updateSchema`, so a connected instance's cached
				// schema would otherwise go stale (and a later lazy `saveTableDDL` could re-write
				// tag-less DDL). Persistence below always reads `newObject`, never this cache.
				const tableKey = `${event.schemaName}.${event.objectName}`.toLowerCase();
				const connected = this.tables.get(tableKey);
				if (connected) connected.updateSchema(event.newObject);
				const key = buildCatalogKey(event.schemaName, event.objectName);
				const newObject = event.newObject;
				this.enqueuePersist(() => this.persistCatalogIfChanged(key, newObject));
				return;
			}
			case 'view_added':
			case 'view_modified': {
				const view = event.newObject;
				this.enqueuePersist(() => this.saveViewDDL(view));
				return;
			}
			case 'view_removed': {
				const { schemaName, objectName } = event;
				this.enqueuePersist(() => this.removeViewDDL(schemaName, objectName));
				return;
			}
			case 'materialized_view_added':
			case 'materialized_view_modified':
				// Unified model: the payload is the maintained table itself.
				this.refreshConnectedMaterializedView(event.schemaName, event.objectName, event.newObject);
				return;
			case 'materialized_view_refreshed':
				// DDL is usually unchanged by a REFRESH (body/tags identical) → compare-skip,
				// but re-read tags in case they were updated alongside the refresh.
				this.refreshConnectedMaterializedView(event.schemaName, event.objectName, event.object);
				return;
			case 'materialized_view_removed': {
				const { schemaName, objectName } = event;
				// DROP MAINTAINED detaches catalog-only: the engine has already swapped the
				// catalog entry to a plain (derivation-less) schema before firing this event,
				// but a connected `StoreTable` still caches the maintained schema. The store's
				// `alterTable` reads that cache (`getSchema`), so a following structural ALTER
				// would spread the stale `derivation` onto the rebuilt schema and re-register
				// the table as a materialized view (rejecting the next ALTER). Refresh the cache
				// to the now-plain catalog entry. When the entry is gone entirely (DROP TABLE /
				// DROP MATERIALIZED VIEW), there is nothing to refresh — `destroy` retires it.
				const plain = this.subscribedDb?.schemaManager.getTable(schemaName, objectName);
				if (plain && !isMaintainedTable(plain)) {
					const connected = this.tables.get(`${schemaName}.${objectName}`.toLowerCase());
					if (connected) connected.updateSchema(plain);
				}
				this.enqueuePersist(() => this.removeMaterializedViewDDL(schemaName, objectName));
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Shared MV add/modify/refresh handling. Narrow defensively — a derivation-less
	 * payload would be an engine bug, so skip. Otherwise, mirror `table_modified`:
	 * synchronously refresh a connected `StoreTable`'s cached schema (so a tag change
	 * such as `quereus.sync.replicate` takes effect immediately without reopen) before
	 * enqueuing the catalog DDL persist.
	 */
	private refreshConnectedMaterializedView(schemaName: string, objectName: string, payload: TableSchema): void {
		if (!isMaintainedTable(payload)) return;
		const key = `${schemaName}.${objectName}`.toLowerCase();
		const connected = this.tables.get(key);
		if (connected) connected.updateSchema(payload);
		this.enqueuePersist(() => this.saveMaterializedViewDDL(payload));
	}

	/**
	 * The qualified lowercased `schema.mv` names of every maintained table currently
	 * marked `derivation.stale` — an MV whose row-time maintenance detached mid-session
	 * (a body-relevant `table_modified`/`table_removed` on a source, or a cascade
	 * backing-invalidation), so its durable backing may be behind. The single source of
	 * truth for both the clean-shutdown marker payload and the durable stale-MV set.
	 *
	 * No subscribed db ⇒ the empty set: every path that can mark an MV stale requires a
	 * session in which this module observed the db (a store source create/connect or
	 * `rehydrateCatalog`, both of which subscribe), so a session without `subscribedDb`
	 * never detached any persisted MV's maintenance. Memory-backed MVs that appear here
	 * are harmless — their catalog entries always refill (no phase-1 pre-existing
	 * backing), so withholding trust from them is a no-op.
	 */
	protected computeStaleMvSet(): string[] {
		return this.subscribedDb
			? this.subscribedDb.schemaManager.getAllMaintainedTables()
				.filter(mv => mv.derivation.stale)
				.map(mv => `${mv.schemaName}.${mv.name}`.toLowerCase())
			: [];
	}

	/**
	 * Recompute the durable stale-MV set and, only when it differs from the last value
	 * enqueued this subscription (`StoreModuleBase.lastPersistedStaleMvs`), enqueue a `sync: true`
	 * point-write of it onto `StoreModuleBase.persistQueue`. The compare-skip keeps an unrelated
	 * `table_modified` (a tag swap that changes no MV's staleness) from costing an fsync.
	 *
	 * The recompute reads `derivation.stale` synchronously (the flags are current at
	 * listener-dispatch time); the field is updated synchronously at enqueue time, and
	 * `persistQueue` serializes the writes in order, so the field always names the last
	 * enqueued value. Riding `persistQueue` (rather than a bare `put`) also serializes
	 * this `sync` behind the triggering event's own source-DDL compare-write, so the
	 * stale-set becomes durable no-later-than the source DDL that caused the staleness —
	 * the ordering the adopt soundness argument depends on.
	 */
	private persistStaleMvSetIfChanged(): void {
		// Only an atomic-capable session writes the durable set — it is the sole reader and
		// trust basis (see `StoreModuleBase.atomicProvider`); a non-atomic session's trust basis is the
		// clean-shutdown marker, so writing the set there is both useless and a soundness
		// hazard (it could be trusted by a later atomic reopen). Skip before recomputing.
		if (!this.atomicProvider) return;
		const json = JSON.stringify(this.computeStaleMvSet());
		if (json === this.lastPersistedStaleMvs) return;
		this.lastPersistedStaleMvs = json;
		this.enqueuePersist(() => this.writeDurableStaleMvSet(json));
	}
}
