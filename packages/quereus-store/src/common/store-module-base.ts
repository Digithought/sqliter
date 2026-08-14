/**
 * Module-wide state and storage plumbing shared by every layer of the generic
 * KVStore-backed virtual-table module: the provider handle, the cached store and
 * {@link StoreTable} maps, the single shared transaction coordinator, the
 * serialized catalog-write queue, and the physical-store-name collision guard.
 *
 * Base of the store-module layer chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type { BaseModuleConfig, Database, LensDeploymentSnapshot, SqlValue, TableSchema } from '@quereus/quereus';
import { QuereusError, StatusCode } from '@quereus/quereus';
import type { KVStore, KVStoreProvider } from './kv-store.js';
import { resolveCostProfile, type ResolvedCostProfile } from './cost-profile.js';
import type { StoreEventEmitter } from './events.js';
import { TransactionCoordinator } from './transaction.js';
import { StoreTable } from './store-table.js';
import type { StoreTableConfig } from './store-table-base.js';
import { withImplicitUniqueIndexes } from './implicit-unique-index.js';
import { buildDataStoreName, buildIndexStoreName } from './key-builder.js';

/**
 * Listener the host binds via `StoreModule.setLensDeploymentListener` to
 * forward a logical `apply schema` lens deployment onward (typically to the sync
 * layer's basis-table lifecycle bookkeeping). Kept as a plain callback so
 * `@quereus/store` stays free of a `@quereus/sync` dependency; the worker — which
 * depends on both — wires the two together.
 */
export type LensDeploymentListener = (
	db: Database,
	logicalSchemaName: string,
	snapshot: LensDeploymentSnapshot,
) => void | Promise<void>;

/**
 * Configuration options for StoreModule tables.
 */
export interface StoreModuleConfig extends BaseModuleConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/**
	 * Serialized-byte budget for a single index-build write batch (see
	 * `buildIndexEntries` (store-module-index-build.ts)). Set from the `max_batch_bytes`
	 * module arg; a missing / non-positive value falls back to
	 * {@link DEFAULT_MAX_BATCH_BYTES}. Module-wide, not per-index.
	 */
	maxBatchBytes?: number;
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Default serialized-byte budget for a single index-build write batch. Bounds
 * heap directly: `buildIndexEntries` (store-module-index-build.ts) flushes and starts a fresh
 * batch whenever the accumulated key bytes cross this, so a table larger than
 * memory never buffers its whole index in one batch. A byte budget (rather than a
 * fixed entry count) is used because index entries vary in size, so bytes bound
 * memory more tightly. 8 MiB trades a modest number of extra flushes against peak
 * memory; override per store with `using store (max_batch_bytes = …)`.
 */
export const DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Resolve the index-build batch byte budget from a `max_batch_bytes` module arg.
 * A missing, non-numeric, or non-positive value falls back to
 * {@link DEFAULT_MAX_BATCH_BYTES} — a zero or negative budget must NEVER disable
 * flushing, which would restore the unbounded single-batch behavior this guards
 * against.
 */
function resolveMaxBatchBytes(raw: SqlValue | undefined): number {
	let n: number;
	if (typeof raw === 'number') n = raw;
	else if (typeof raw === 'bigint') n = Number(raw);
	else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
	else return DEFAULT_MAX_BATCH_BYTES;
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_BATCH_BYTES;
	return Math.floor(n);
}

/**
 * Build the set of physical store names this module's data/index stores
 * currently occupy in `schemaName`, mapping each name to a human description
 * of the logical object that owns it (for sited collision messages).
 *
 * Physical store names are built by string concatenation (`{schema}.{table}` /
 * `{schema}.{table}_idx_{index}`) and the `_idx_` delimiter is itself a legal
 * substring of any identifier, so two distinct logical objects (e.g. index
 * `archive` on `t` and a sibling table `t_idx_archive`) can collapse to the
 * same physical name. This set is the authoritative occupancy used by
 * {@link StoreModuleBase.assertStoreNameFree} to reject such a collision at CREATE time.
 *
 * The occupancy is the union of two sources, robust to lazy connection and the
 * isolation wrapper (see the ticket's "Enumeration source" section):
 *   1. `tables` — every store table the owning module touched this session.
 *   2. the target schema's catalog tables whose `vtabModule === owner` and which
 *      are not views — store-backed tables not yet lazily connected.
 * Names embed the schema prefix, so cross-schema entries never collide and no
 * per-schema filter on `tables` is needed. Memory-backed siblings and
 * views own no store in this provider and are excluded (the `=== owner` /
 * `!isView` filter) to avoid false-positive rejects.
 *
 * No self-exclusion: at each guarded call the candidate object is not yet
 * registered (create/createIndex run before the engine adds it) so it cannot
 * self-collide; and for renameTable the renamed table's OWN stores stay in the
 * set deliberately. Any overlap between a name the rename introduces and an
 * own current store is a footprint-swap rename (`t` with index `x` → `t_idx_x`,
 * or table `u_idx_x` with index `x` → `u`) that providers cannot relocate
 * safely — relocation order determines whether a source is clobbered before it
 * is moved — while no benign rename produces such an overlap. Keeping own
 * stores in the set therefore causes no false rejects and keeps the
 * reject-before-any-side-effect guarantee uniform.
 *
 * `owner` is the module instance whose stores these are — the concrete `StoreModule` at
 * the top of the layer chain, which this base layer cannot name without an import cycle.
 * It is a parameter (rather than `this`) purely so the identity check keeps a real type
 * instead of needing a cast; the enumeration itself reads no other module state.
 */
// NOTE: the builders below carry the unpaired-surrogate identifier guard, so this
// enumeration can THROW on an EXISTING schema object, not just on the incoming one —
// an unrelated CREATE/RENAME in the same schema would then fail with a confusing
// "cannot store the identifier ..." error. Unreachable today: `create` throws before
// the table is registered, and a catalog entry written before the guard existed was
// folded to a real U+FFFD character, which passes. If a lone-surrogate-named table ever
// does reach the schema manager by another route, skip such an object here (it occupies
// no store) rather than letting the enumeration throw.
export function collectOccupiedStoreNames(
	tables: Iterable<StoreTable>,
	db: Database,
	schemaName: string,
	owner: object,
): Map<string, string> {
	const names = new Map<string, string>();
	const add = (s: TableSchema) => {
		const dataName = buildDataStoreName(s.schemaName, s.name);
		if (!names.has(dataName)) {
			names.set(dataName, `data store of table '${s.schemaName}.${s.name}'`);
		}
		for (const idx of s.indexes ?? []) {
			const idxName = buildIndexStoreName(s.schemaName, s.name, idx.name);
			if (!names.has(idxName)) {
				names.set(idxName, `index store of index '${idx.name}' on table '${s.schemaName}.${s.name}'`);
			}
		}
	};
	for (const t of tables) {
		add(t.getSchema());
	}
	for (const t of db.schemaManager.getSchemaOrFail(schemaName).getAllTables()) {
		if (t.vtabModule !== owner || t.isView) continue;
		add(t);
	}
	return names;
}

export abstract class StoreModuleBase {
	protected provider: KVStoreProvider;

	protected stores: Map<string, KVStore> = new Map();

	/**
	 * The single transaction coordinator shared by every {@link StoreTable} this
	 * module owns — the unit of cross-table atomicity (see {@link getCoordinator}).
	 * Lives for the module's lifetime: a single table's drop must NOT evict it
	 * (sibling tables still use it); only `StoreModule.closeAll` clears it.
	 */
	protected moduleCoordinator?: TransactionCoordinator;

	protected tables: Map<string, StoreTable> = new Map();

	protected eventEmitter?: StoreEventEmitter;

	/**
	 * Optional listener wired by the host (the worker) to forward a logical
	 * `apply schema` lens deployment to the sync layer's lifecycle bookkeeping.
	 * The store module is the only basis-backing host with both persistence and a
	 * `db` handle, so it is the forwarder; `@quereus/store` must not depend on
	 * `@quereus/sync`, so the listener is a plain callback the worker binds.
	 */
	protected lensDeploymentListener?: LensDeploymentListener;

	/** Unsubscribe thunk for the engine `SchemaChangeNotifier` listener, set on first hook with a `db`. */
	protected schemaListenerUnsub?: () => void;

	/** The `Database` whose notifier we subscribed to. One module instance serves one `Database`. */
	protected subscribedDb?: Database;

	/**
	 * Serialized chain of pending catalog writes triggered by engine schema-change
	 * events (catalog-only tag swaps). `notifyChange` invokes listeners synchronously
	 * and does not await them, so the actual read-compare-write runs here, in order,
	 * and is drained by `closeAll` (and `whenCatalogPersisted`) before the provider closes.
	 */
	protected persistQueue: Promise<unknown> = Promise.resolve();

	/**
	 * The JSON-serialized stale-MV set last enqueued onto {@link persistQueue} (the
	 * `\x00meta\x00stale_mvs` value), or `undefined` when no baseline is established
	 * for the current subscription. The schema-change listener compares each
	 * recomputed set against this so an unrelated `table_modified` (e.g. a tag swap
	 * that changes no MV's staleness) costs no extra fsync. Reset to `undefined`
	 * whenever a fresh `Database` is subscribed (`StoreModuleSchemaSync.ensureSchemaSubscription`) so
	 * a reopened module re-establishes the baseline from the first relevant event (or
	 * the rehydrate tail).
	 */
	protected lastPersistedStaleMvs: string | undefined;

	/**
	 * Whether the provider exposes an atomic cross-store commit domain
	 * ({@link KVStoreProvider.beginAtomicBatch}) — the capability the MV adopt fast
	 * path's gate-5 drop hinges on. Fixed for the provider's lifetime, so cached at
	 * construction (and used as the single gate for both writing AND reading the durable
	 * stale-MV set). Gating the **write** on it is load-bearing for soundness, not just an
	 * fsync saving: only an atomic-capable session — whose commits can never tear a source
	 * from its same-module backing — ever writes the durable set, so the set a later atomic
	 * session reads was necessarily written under that same no-tear guarantee. A persistent
	 * non-atomic provider therefore can never leave a torn-but-"not-stale" set for an atomic
	 * reopen to trust (it writes none); such a store falls back to the clean-shutdown marker.
	 */
	protected readonly atomicProvider: boolean;

	/**
	 * What this provider's backend declares its basic reads to cost, relative to one
	 * sequentially scanned row ({@link KVStoreProvider.costProfile}), with the parity
	 * defaults filled in for whatever it left undeclared.
	 *
	 * Resolved once at construction for the same reason {@link atomicProvider} is: a
	 * profile is a property of the BACKEND and so is fixed for the provider's lifetime,
	 * and the consumer (`StoreModule.getBestAccessPlan` → `computeBestAccessPlan`) runs
	 * per planned query. Resolving here also means a malformed third-party declaration
	 * warns once at module construction rather than once per planned statement.
	 */
	protected readonly costProfile: ResolvedCostProfile;

	constructor(provider: KVStoreProvider, eventEmitter?: StoreEventEmitter) {
		this.provider = provider;
		this.eventEmitter = eventEmitter;
		this.atomicProvider = typeof provider.beginAtomicBatch === 'function';
		this.costProfile = resolveCostProfile(provider.costProfile);
	}

	/**
	 * Get the KVStoreProvider used by this module.
	 */
	getProvider(): KVStoreProvider {
		return this.provider;
	}

	/**
	 * Get the event emitter for this module.
	 */
	getEventEmitter(): StoreEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Get a table by schema and name.
	 */
	getTable(schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		return this.tables.get(tableKey);
	}

	/**
	 * Parse module configuration from vtab args.
	 */
	protected parseConfig(args: Record<string, SqlValue> | undefined): StoreModuleConfig {
		return {
			collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
			// Index-build batch budget; malformed / non-positive clamps to the default
			// so a bad arg can never disable the bounded-memory flush (see resolveMaxBatchBytes).
			maxBatchBytes: resolveMaxBatchBytes(args?.max_batch_bytes),
		};
	}

	// --- Engine schema-change subscription (catalog-only tag persistence) ---

	/**
	 * Get or create a data store for a table.
	 */
	async getStore(schemaName: string, tableName: string, _config: StoreTableConfig): Promise<KVStore> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		let store = this.stores.get(tableKey);
		if (!store) {
			store = await this.provider.getStore(schemaName, tableName);

			if (!store) {
				throw new Error(`Provider.getStore returned null/undefined for ${tableKey}`);
			}

			this.stores.set(tableKey, store);
		}
		return store;
	}

	/**
	 * Get or create an index store for a table.
	 */
	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		return this.provider.getIndexStore(schemaName, tableName, indexName);
	}

	/**
	 * Get or create a stats store for a table.
	 */
	async getStatsStore(schemaName: string, tableName: string): Promise<KVStore> {
		return this.provider.getStatsStore(schemaName, tableName);
	}

	/**
	 * Get (lazily constructing) the SINGLE transaction coordinator shared by every
	 * table this module owns — the unit of cross-table atomicity. Every
	 * {@link StoreTable} attaches to the same instance, so a transaction touching
	 * several of the module's tables commits/rolls back as one all-or-nothing
	 * batch.
	 *
	 * Synchronously constructible: ops are addressed by explicit store handle, so
	 * the coordinator never needs to open a store to be created. This lets callers
	 * that must stay synchronous (e.g. a `BackingHost.connect()`) obtain a working
	 * coordinator before any table's store has been opened.
	 */
	getCoordinator(): TransactionCoordinator {
		if (!this.moduleCoordinator) {
			this.moduleCoordinator = new TransactionCoordinator(
				this.eventEmitter,
				// Re-evaluated per commit (see TransactionCoordinator.atomicBatchFactory)
				// so a provider that gains/loses the capability is always honored.
				() => this.provider.beginAtomicBatch?.(),
			);
		}
		return this.moduleCoordinator;
	}

	/**
	 * Flush the module's buffered writes before a DDL operation that physically
	 * rewrites or relocates storage.
	 *
	 * Such a DDL cannot honor the coordinator's buffer: pending ops are
	 * `(keyBytes, valueBytes, store)` triples computed at DML time under the
	 * PRE-DDL schema, and every physical rewrite (`StoreTable.rekeyRows` /
	 * `migrateRows`, the provider's directory move) reads and writes the COMMITTED
	 * store directly. Replaying stale-schema ops over the rewritten store on the
	 * eventual commit corrupts, loses, or misfiles those rows. So an `ALTER TABLE`
	 * that touches storage is effectively DDL-committing on a store-backed table:
	 * flush NOW, before the first physical read, so the rewrite sees every live row
	 * and there is nothing left to replay afterwards.
	 *
	 * Consequences, both deliberate:
	 * - The coordinator is module-wide, so this commits the WHOLE module
	 *   transaction — every table's pending ops, not just the altered/renamed
	 *   table's — in one all-or-nothing batch. An ALTER cannot half-commit some
	 *   sibling tables.
	 * - Validation running AFTER this point (e.g. `ALTER PRIMARY KEY`'s duplicate-key
	 *   pass — `rekeyRows` pass 1, which must see the flushed rows because a pending
	 *   insert can itself be the duplicate) throws with the enclosing transaction
	 *   already flushed. The store stays unmutated — only the transaction is gone.
	 *   Validation that can read effectively belongs before the call, so the
	 *   transaction survives it — the SET COLLATE PK re-key does exactly that
	 *   (`StoreTable.validateRekeyedPrimaryKey` reads the effective rows, pending
	 *   ops included, before this flush; `rekeyRows` pass 1 is only its backstop).
	 *
	 * Subsequent `commit()` calls on the same coordinator are no-ops
	 * (`inTransaction` is cleared), which keeps the enclosing transaction safe.
	 * The savepoint stack is cleared too, so a later `ROLLBACK TO` / `RELEASE` that
	 * the engine still broadcasts warns and degrades rather than throwing — see
	 * `TransactionCoordinator.rollbackToSavepoint`, which mirrors the memory
	 * module's identical posture.
	 */
	protected async ddlCommitPendingOps(): Promise<void> {
		if (this.moduleCoordinator?.isInTransaction()) {
			await this.moduleCoordinator.commit();
		}
	}

	/**
	 * Append a catalog-persistence task to the serialized `persistQueue`, so successive
	 * mutations (e.g. SET TAGS (a=1) then SET TAGS ()) apply in order and are drained by
	 * `closeAll`/`whenCatalogPersisted` before the provider closes. Errors are
	 * swallowed+logged to mirror `notifyChange`'s own try/catch contract — a listener
	 * rejection must never escape.
	 */
	protected enqueuePersist(work: () => Promise<void>): void {
		this.persistQueue = this.persistQueue
			.then(work)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[StoreModule] Failed to persist catalog DDL after schema change: ${message}`);
			});
	}

	/**
	 * Resolve once all catalog writes queued by async schema-change listeners
	 * (catalog-only tag swaps) have settled. A durability barrier: `closeAll` awaits
	 * it internally; callers/tests that need the persisted catalog current without a
	 * full close can await it directly. Never rejects — queued errors are logged in
	 * the chain.
	 */
	async whenCatalogPersisted(): Promise<void> {
		await this.persistQueue;
	}

	/**
	 * The physical index-store names a table owns for DROP / RENAME TABLE to relocate
	 * or reclaim: the MATERIALIZED index set — every explicit `CREATE INDEX` PLUS the
	 * hidden `_uc_*` realizing each plain UNIQUE. Reading only `getSchema().indexes`
	 * (the engine-facing schema, which carries no `_uc_*`) would strand a `_uc_*` store
	 * on disk after DROP TABLE, and — worse — after RENAME TABLE leave the renamed
	 * table seeking a freshly-created EMPTY `_uc_*` store, silently accepting a
	 * duplicate of a pre-rename row. Prefers the cached StoreTable's own materialized
	 * schema; falls back to materializing the schema-manager copy when the instance is
	 * already gone.
	 */
	protected materializedIndexNames(table: StoreTable | undefined, fallback: TableSchema | undefined): string[] {
		const schema = table
			? table.getMaterializedSchema()
			: (fallback ? withImplicitUniqueIndexes(fallback) : undefined);
		return (schema?.indexes ?? []).map(i => i.name);
	}

	/**
	 * Throws `StatusCode.ERROR` when `candidate` (a physical store name produced by
	 * the key-builder for an object about to be created/renamed) already names an
	 * existing data or index store in `schemaName`. `candidateDesc` describes the
	 * incoming logical object; the message names the candidate physical store and
	 * both conflicting logical objects and is actionable (rename one of them).
	 *
	 * Must run BEFORE any storage side-effect (`getStore` / `getIndexStore` / the
	 * physical relocation): the provider opens/creates the store eagerly, so a
	 * guard that ran after would already have aliased the colliding object's store.
	 *
	 * Callers checking several candidates against the same occupancy (renameTable
	 * checks the new data store plus every relocated index store) pass a
	 * precomputed `occupied` map so the occupancy is collected once, not per call.
	 */
	protected assertStoreNameFree(
		db: Database,
		schemaName: string,
		candidate: string,
		candidateDesc: string,
		occupied?: Map<string, string>,
	): void {
		const occupiedBy = (occupied ?? collectOccupiedStoreNames(this.tables.values(), db, schemaName, this)).get(candidate);
		if (occupiedBy !== undefined) {
			throw new QuereusError(
				`Physical store-name collision: the ${candidateDesc} would map to physical store `
					+ `'${candidate}', which already backs the ${occupiedBy}. These two objects would `
					+ `share one physical store and silently corrupt each other. Rename the table or the `
					+ `colliding index.`,
				StatusCode.ERROR,
			);
		}
	}
}
