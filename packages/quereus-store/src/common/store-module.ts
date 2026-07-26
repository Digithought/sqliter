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
 */

import type {
	Database,
	DatabaseInternal,
	TableSchema,
	TableIndexSchema,
	ForeignKeyConstraintSchema,
	UniqueConstraintSchema,
	VirtualTableModule,
	BaseModuleConfig,
	BestAccessPlanRequest,
	BestAccessPlanResult,
	PredicateConstraint,
	OrderingSpec,
	Row,
	SqlValue,
	ModuleCapabilities,
	SchemaChangeInfo,
	ColumnSchema,
	Schema,
	MappingAdvertisement,
	SchemaChangeEvent as EngineSchemaChangeEvent,
	ViewSchema,
	MaintainedTableSchema,
	BackingHost,
	LensDeploymentSnapshot,
} from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode, buildColumnIndexMap, columnDefToSchema, compilePredicate, inferType, tryFoldLiteral, validateAndParse, buildAdvertisementsFromTags, resolveNamedConstraintClass, validateCollationForType, buildUniqueConstraintSchema, buildForeignKeyConstraintSchema, buildCheckConstraintSchema, validateForeignKeyOverExistingRows, appendIndexToTableSchema, logicalTypeCanHoldText, serializeKey, isMaintainedTable, renameColumnInIndexPredicates, renameTableInIndexPredicates, renameColumnInCheckConstraints, renameTableInCheckConstraints } from '@quereus/quereus';
import type { CompiledPredicate, EffectiveRowSource, KeyNormalizer, KeyNormalizerResolver, ResolveColumnInSource } from '@quereus/quereus';

import type { KVEntry, KVStore, KVStoreProvider } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import { TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import { StoreBackingHost } from './backing-host.js';
import { StoreTable, resolvePkKeyCollations, resolvePkKeyTransforms, resolveIndexKeyTransforms, storeSemanticKeyTransform, columnCanHoldText, keyOrderMatchesCollation, pkOrderPreservingPrefixLength, withImplicitUniqueIndexes, implicitUniqueIndexName, type StoreTableConfig, type StoreTableModule } from './store-table.js';
import {
	buildCatalogKey,
	buildCatalogScanBounds,
	buildDataKey,
	buildDataStoreName,
	buildIndexKey,
	buildIndexStoreName,
	buildFullScanBounds,
	buildStatsKey,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	parseMaterializedViewCatalogKey,
	buildMetaCatalogKey,
	CLEAN_SHUTDOWN_META_NAME,
	STALE_MVS_META_NAME,
	classifyCatalogKey,
} from './key-builder.js';
import { assertNoUnpairedSurrogate } from './encoding.js';
import { deserializeRow } from './serialization.js';
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaintainedTableDDL, generateIndexTagsDDL, isHiddenImplicitIndex, exposedImplicitIndexes } from '@quereus/quereus';

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

/**
 * Listener the host binds via {@link StoreModule.setLensDeploymentListener} to
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
	 * {@link StoreModule.buildIndexEntries}). Set from the `max_batch_bytes`
	 * module arg; a missing / non-positive value falls back to
	 * {@link DEFAULT_MAX_BATCH_BYTES}. Module-wide, not per-index.
	 */
	maxBatchBytes?: number;
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Default serialized-byte budget for a single index-build write batch. Bounds
 * heap directly: {@link StoreModule.buildIndexEntries} flushes and starts a fresh
 * batch whenever the accumulated key bytes cross this, so a table larger than
 * memory never buffers its whole index in one batch. A byte budget (rather than a
 * fixed entry count) is used because index entries vary in size, so bytes bound
 * memory more tightly. 8 MiB trades a modest number of extra flushes against peak
 * memory; override per store with `using store (max_batch_bytes = …)`.
 */
const DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Map of `lowercased implicit index name → actual name` for every NON-DERIVED
 * UNIQUE constraint of `schema` — the set of `_uc_*` stores that SHOULD exist for
 * that constraint set. Derived from `uniqueConstraints` (not `.indexes`), so it is
 * correct whether or not `schema` is materialized; the diff of two such maps drives
 * {@link StoreModule.reconcileImplicitUniqueIndexStores}.
 */
function implicitUniqueIndexNameMap(schema: TableSchema): Map<string, string> {
	const map = new Map<string, string>();
	for (const uc of schema.uniqueConstraints ?? []) {
		if (uc.derivedFromIndex) continue;
		const name = implicitUniqueIndexName(schema, uc);
		map.set(name.toLowerCase(), name);
	}
	return map;
}

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
 * Planner-side constraint operator groups, as `BestAccessPlanRequest.filters` spells
 * them. Kept as one source of truth for the access-plan code below: `getBestAccessPlan`
 * classifies each pushed filter with these, and `tryIndexAccessPlan` claims a filter as
 * handled only when it falls in the group the engine's access-path rule will consume.
 */
const EQ_OPS = ['='] as const;
const LOWER_BOUND_OPS = ['>', '>='] as const;
const UPPER_BOUND_OPS = ['<', '<='] as const;
const RANGE_OPS = [...LOWER_BOUND_OPS, ...UPPER_BOUND_OPS] as readonly string[];

/** One (column, operator-group) slot that the access-path rule fills from a single filter. */
interface SeekRole {
	colIdx: number;
	ops: readonly string[];
}

/**
 * Build `handledFilters` by claiming ONLY the constraints `rule-select-access-path`
 * actually consumes: per seek column the FIRST '=' (equality seek), or the FIRST lower
 * ('>'/'>=') plus the FIRST upper ('<'/'<=') bound, selected by `colConstraints.find(...)`
 * in `request.filters` order.
 *
 * That rule collapses `handledFilters` into a per-COLUMN set, so a redundant same-column,
 * same-role constraint marked handled is neither turned into a seek bound nor kept by
 * `ruleGrowRetrieve` as a residual — its predicate would be LOST (`where v > 10 and v > 30`
 * would wrongly return the `v > 10` rows; `where v = 20 and v = 30` would wrongly return
 * the `v = 20` row). The engine now reattaches such orphans defensively, but a module that
 * over-claims still pays a redundant predicate evaluation per fetched row.
 *
 * Claiming must therefore be POSITIONAL and match the rule's first-match pick: claiming the
 * tighter-but-later duplicate instead would be actively wrong (the rule would still seek on
 * the earlier one). Any later duplicate stays unhandled so it survives in the residual Filter.
 */
function claimFirstPerRole(
	filters: readonly PredicateConstraint[],
	roles: readonly SeekRole[],
): boolean[] {
	const claimed = new Set<number>();
	for (const { colIdx, ops } of roles) {
		const i = filters.findIndex(f => f.columnIndex === colIdx && ops.includes(f.op));
		if (i >= 0) claimed.add(i);
	}
	return filters.map((_f, i) => claimed.has(i));
}

/** The lower-bound + upper-bound roles a single-column range seek on `colIdx` fills. */
function rangeRoles(colIdx: number): SeekRole[] {
	return [{ colIdx, ops: LOWER_BOUND_OPS }, { colIdx, ops: UPPER_BOUND_OPS }];
}

/** The one equality role each seek column of an equality/prefix seek fills. */
function equalityRoles(colIdxs: readonly number[]): SeekRole[] {
	return colIdxs.map(colIdx => ({ colIdx, ops: EQ_OPS }));
}

/**
 * Result of an {@link StoreModule.alterColumnChange} attribute sub-branch: the rewritten
 * column schema plus whether the collation BYTES changed (which gates the existing-row
 * UNIQUE re-validation and the PK physical re-key). A sub-branch returns null instead when
 * the column is already in the desired state, so the caller returns the schema untouched.
 *
 * `valueConvert` is the per-value rewrite this change needs — SET DATA TYPE's physical
 * conversion or SET NOT NULL's null → DEFAULT backfill — returned DEFERRED: the sub-branch
 * mutates nothing, and {@link StoreModule.alterColumnChange} applies the closure via
 * {@link StoreTable.mapRowsAtIndex} only after every throw-only check has passed (including
 * the existing-row UNIQUE re-validation, which judges the CONVERTED values through this same
 * closure), so a rejected ALTER never leaves rewritten values behind a stale declared type.
 * The closure owns its own NULL handling (the data-type conversion passes NULL through; the
 * backfill maps it to the DEFAULT). Secondary index KEY bytes encode the indexed column
 * VALUES, so after applying the rewrite the caller rebuilds every secondary index.
 */
interface AlterColumnAttrChange {
	newCol: ColumnSchema;
	collationChanged: boolean;
	valueConvert?: (v: SqlValue) => SqlValue;
}

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
export class StoreModule implements VirtualTableModule<StoreTable, StoreModuleConfig>, StoreTableModule {
	private provider: KVStoreProvider;
	private stores: Map<string, KVStore> = new Map();
	/**
	 * The single transaction coordinator shared by every {@link StoreTable} this
	 * module owns — the unit of cross-table atomicity (see {@link getCoordinator}).
	 * Lives for the module's lifetime: a single table's drop must NOT evict it
	 * (sibling tables still use it); only {@link closeAll} clears it.
	 */
	private moduleCoordinator?: TransactionCoordinator;
	private tables: Map<string, StoreTable> = new Map();
	private eventEmitter?: StoreEventEmitter;

	/**
	 * Optional listener wired by the host (the worker) to forward a logical
	 * `apply schema` lens deployment to the sync layer's lifecycle bookkeeping.
	 * The store module is the only basis-backing host with both persistence and a
	 * `db` handle, so it is the forwarder; `@quereus/store` must not depend on
	 * `@quereus/sync`, so the listener is a plain callback the worker binds.
	 */
	private lensDeploymentListener?: LensDeploymentListener;

	/** Unsubscribe thunk for the engine `SchemaChangeNotifier` listener, set on first hook with a `db`. */
	private schemaListenerUnsub?: () => void;
	/** The `Database` whose notifier we subscribed to. One module instance serves one `Database`. */
	private subscribedDb?: Database;
	/**
	 * Serialized chain of pending catalog writes triggered by engine schema-change
	 * events (catalog-only tag swaps). `notifyChange` invokes listeners synchronously
	 * and does not await them, so the actual read-compare-write runs here, in order,
	 * and is drained by `closeAll` (and `whenCatalogPersisted`) before the provider closes.
	 */
	private persistQueue: Promise<unknown> = Promise.resolve();

	/**
	 * The JSON-serialized stale-MV set last enqueued onto {@link persistQueue} (the
	 * `\x00meta\x00stale_mvs` value), or `undefined` when no baseline is established
	 * for the current subscription. The schema-change listener compares each
	 * recomputed set against this so an unrelated `table_modified` (e.g. a tag swap
	 * that changes no MV's staleness) costs no extra fsync. Reset to `undefined`
	 * whenever a fresh `Database` is subscribed ({@link ensureSchemaSubscription}) so
	 * a reopened module re-establishes the baseline from the first relevant event (or
	 * the rehydrate tail).
	 */
	private lastPersistedStaleMvs: string | undefined;

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
	private readonly atomicProvider: boolean;

	constructor(provider: KVStoreProvider, eventEmitter?: StoreEventEmitter) {
		this.provider = provider;
		this.eventEmitter = eventEmitter;
		this.atomicProvider = typeof provider.beginAtomicBatch === 'function';
	}

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
	 * {@link getOrReconnectTable} so a rehydrated-but-untouched (or rename-evicted)
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
	 * {@link getOrReconnectTable}. The ownership pre-check keeps the reconnect
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
	 * Get the event emitter for this module.
	 */
	getEventEmitter(): StoreEventEmitter | undefined {
		return this.eventEmitter;
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
	 * Get the KVStoreProvider used by this module.
	 */
	getProvider(): KVStoreProvider {
		return this.provider;
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
	 * {@link assertStoreNameFree} to reject such a collision at CREATE time.
	 *
	 * The occupancy is the union of two sources, robust to lazy connection and the
	 * isolation wrapper (see the ticket's "Enumeration source" section):
	 *   1. `this.tables` — every store table this module touched this session.
	 *   2. the target schema's catalog tables whose `vtabModule === this` and which
	 *      are not views — store-backed tables not yet lazily connected.
	 * Names embed the schema prefix, so cross-schema entries never collide and no
	 * per-schema filter on `this.tables` is needed. Memory-backed siblings and
	 * views own no store in this provider and are excluded (the `=== this` /
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
	 */
	// NOTE: the builders below carry the unpaired-surrogate identifier guard, so this
	// enumeration can THROW on an EXISTING schema object, not just on the incoming one —
	// an unrelated CREATE/RENAME in the same schema would then fail with a confusing
	// "cannot store the identifier ..." error. Unreachable today: `create` throws before
	// the table is registered, and a catalog entry written before the guard existed was
	// folded to a real U+FFFD character, which passes. If a lone-surrogate-named table ever
	// does reach the schema manager by another route, skip such an object here (it occupies
	// no store) rather than letting the enumeration throw.
	private collectOccupiedStoreNames(db: Database, schemaName: string): Map<string, string> {
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
		for (const t of this.tables.values()) {
			add(t.getSchema());
		}
		for (const t of db.schemaManager.getSchemaOrFail(schemaName).getAllTables()) {
			if (t.vtabModule !== this || t.isView) continue;
			add(t);
		}
		return names;
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
	private assertStoreNameFree(
		db: Database,
		schemaName: string,
		candidate: string,
		candidateDesc: string,
		occupied?: Map<string, string>,
	): void {
		const occupiedBy = (occupied ?? this.collectOccupiedStoreNames(db, schemaName)).get(candidate);
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

		// Emit schema change event for table drop
		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'table',
			schemaName,
			objectName: tableName,
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
	private getOrReconnectTable(db: Database, schemaName: string, tableName: string): StoreTable | undefined {
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

		// Wrapper-supplied rows are the judged set. Validate BEFORE `getIndexStore` so a
		// rejection leaves no index-store directory behind, and disable the in-pass dup
		// check below (which would judge this module's committed rows instead).
		if (rows && indexSchema.unique) {
			await this.validateUniqueIndexOverRows(rows(), tableSchema, indexSchema, db.getKeyNormalizerResolver());
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
			await this.buildIndexEntries(
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
				await table.releaseIndexStore(indexSchema.name);
				if (this.provider.deleteIndexStore) {
					await this.provider.deleteIndexStore(schemaName, tableName, indexSchema.name);
				} else {
					await this.provider.closeIndexStore(schemaName, tableName, indexSchema.name);
				}
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

		// Emit schema change event
		this.eventEmitter?.emitSchemaChange({
			type: 'create',
			objectType: 'index',
			schemaName,
			objectName: indexSchema.name,
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

		// Drop the cached handle on the table side and tear down the
		// underlying KVStore. `deleteIndexStore` (if the provider implements
		// it) closes the handle before removing the directory; otherwise we
		// just close it.
		await table.releaseIndexStore(indexName);
		if (this.provider.deleteIndexStore) {
			await this.provider.deleteIndexStore(schemaName, tableName, indexName);
		} else {
			await this.provider.closeIndexStore(schemaName, tableName, indexName);
		}

		this.eventEmitter?.emitSchemaChange({
			type: 'drop',
			objectType: 'index',
			schemaName,
			objectName: indexName,
		});
	}

	/**
	 * Build index entries for all existing rows in a table.
	 *
	 * `dataEntries` is the row stream to index. Callers choose its visibility:
	 * `createIndex` passes the table's EFFECTIVE stream (committed + pending, so
	 * an open transaction's rows are indexed too), while `rebuildSecondaryIndexes`
	 * passes the raw committed stream — it runs immediately after an ALTER has
	 * re-encoded the data store in place, and any pending ops still address the
	 * pre-ALTER key bytes.
	 *
	 * For UNIQUE indexes, performs an in-pass duplicate check (honoring partial
	 * predicates and SQL NULL semantics: multiple NULLs are allowed) and throws
	 * CONSTRAINT before any entries are written. Mirrors the memory module's
	 * populateNewIndex so `CREATE UNIQUE INDEX` over duplicated data fails
	 * atomically. `skipDuplicateCheck` suppresses it: `createIndex` sets it when a
	 * wrapper module supplied the rows to judge, having already validated them (see
	 * {@link validateUniqueIndexOverRows}). Judging `dataEntries` too would reject a
	 * committed duplicate the wrapper's transaction has already deleted.
	 *
	 * `normalizers` MUST be the owning connection's `db.getKeyNormalizerResolver()` —
	 * the same resolver `StoreTable.encodeOptions` carries. A rebuild that resolved
	 * collations any other way would re-encode the PK suffix under different bytes than
	 * the table writes at maintenance time, silently corrupting the index.
	 */
	private async buildIndexEntries(
		dataEntries: AsyncIterable<KVEntry>,
		indexStore: KVStore,
		tableSchema: TableSchema,
		indexSchema: TableIndexSchema,
		keyCollation: string,
		normalizers: KeyNormalizerResolver,
		skipDuplicateCheck = false,
		maxBatchBytes: number = DEFAULT_MAX_BATCH_BYTES,
	): Promise<void> {
		// Index COLUMN values use the table-level key collation K; the PK SUFFIX uses
		// each PK column's own key collation, so the suffix bytes match the data-store
		// keys (and `StoreTable.updateSecondaryIndexes`' maintenance writes) exactly.
		const encodeOptions = { collation: keyCollation, normalizers };
		const pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, keyCollation);
		// Key-identity transforms for both halves, mirroring `StoreTable`'s maintenance
		// writes (`updateSecondaryIndexes` / `encodeDataKey`) — a rebuild that skipped them
		// would re-encode a TIMESPAN member under different bytes than DML writes.
		const pkTransforms = resolvePkKeyTransforms(tableSchema.primaryKeyDefinition, tableSchema.columns);
		const indexTransforms = resolveIndexKeyTransforms(indexSchema, tableSchema.columns);
		const indexDirections = indexSchema.columns.map(col => !!col.desc);

		const predicate: CompiledPredicate | undefined = indexSchema.predicate
			? compilePredicate(indexSchema.predicate, tableSchema.columns, tableSchema.name)
			: undefined;
		// NOTE: `seen` holds one signature per DISTINCT indexed key for the WHOLE build and
		// is NOT bounded by the maxBatchBytes chunking below (that bounds only the write
		// batch). A very large UNIQUE index still spikes memory on this set. Bounding it
		// needs a sort- or store-probe-based dedup (a separate design), not a batch knob.
		const seen: Set<string> | undefined = (indexSchema.unique && !skipDuplicateCheck) ? new Set() : undefined;

		const indexColIndices = indexSchema.columns.map(col => col.index);
		const indexNormalizers = seen
			? indexDedupeNormalizers(tableSchema, indexSchema, normalizers)
			: undefined;

		let batch = indexStore.batch();
		// Serialized key bytes accumulated in the CURRENT batch. Flushed and reset once it
		// crosses maxBatchBytes so a table larger than memory never buffers its whole index.
		let batchBytes = 0;

		for await (const entry of dataEntries) {
			const row = deserializeRow(entry.value);

			// Partial index: skip rows whose predicate is not unambiguously TRUE.
			if (predicate && predicate.evaluate(row) !== true) continue;

			// Extract PK values
			const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);

			// Extract index column values
			const indexValues = indexSchema.columns.map(col => row[col.index]);

			if (seen) {
				// The signature returns null when any indexed column is NULL —
				// SQL UNIQUE allows multiple NULLs, so those rows never collide.
				const keySig = dedupeRowSignature(row, indexColIndices, indexNormalizers!, indexTransforms);
				if (keySig !== null) {
					if (seen.has(keySig)) {
						const colNames = indexSchema.columns
							.map(c => tableSchema.columns[c.index]?.name ?? String(c.index))
							.join(', ');
						throw new QuereusError(
							`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
							StatusCode.CONSTRAINT,
						);
					}
					seen.add(keySig);
				}
			}

			// Build and store index key
			const indexKey = buildIndexKey(
				indexValues,
				pkValues,
				encodeOptions,
				indexDirections,
				pkDirections,
				pkCollations,
				indexTransforms,
				pkTransforms,
			);
			// Index value = the row's encoded DATA key, so an index scan resolves each
			// entry back to its base row via a direct data-store read (see
			// `StoreTable.scanIndex`). Encoded under the same PK directions + per-column
			// PK collations + key transforms as `buildDataKey` / `updateSecondaryIndexes`,
			// so the value byte-matches the data store's key for this row.
			const dataKey = buildDataKey(pkValues, encodeOptions, pkDirections, pkCollations, pkTransforms);
			batch.put(indexKey, dataKey);

			// Bound heap: once the accumulated serialized key bytes cross the budget, flush
			// the batch and start a fresh one. Both callers ITERATE the data store and WRITE
			// the index store — different stores — so a mid-stream flush never mutates the
			// stream being read, and this is safe on every provider. A mid-stream flush
			// failure in `createIndex` is torn down by its try/catch (the whole fresh index
			// store is deleted); in `rebuildSecondaryIndexes` it leaves a partial-but-
			// recoverable index (re-run the rebuild — clear + rebuild is idempotent).
			batchBytes += indexKey.length + dataKey.length;
			if (batchBytes >= maxBatchBytes) {
				await batch.write();
				batch = indexStore.batch();
				batchBytes = 0;
			}
		}

		// Final flush of the residual. May be empty (an empty table, or a build whose last
		// row exactly hit the budget and flushed) — providers accept an empty write.
		await batch.write();
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
	 * coordinator. Sound only because every caller calls {@link ddlCommitPendingOps}
	 * first, so this module's "committed" is "everything live". A caller that skips that
	 * flush would rebuild an index missing its transaction's pending rows.
	 *
	 * `skipDuplicateCheck` suppresses {@link buildIndexEntries}' in-pass UNIQUE check.
	 * The value-rewriting / key-transform ALTER COLUMN arm sets it: its pre-mutation
	 * UNIQUE re-validation already judged the ISSUING connection's effective rows (a
	 * wrapper's overlay included), and this rebuild sees only THIS module's committed
	 * rows — a superset that may retain a row the wrapper's transaction has deleted, so
	 * judging it here would spuriously reject a duplicate pair the probe correctly
	 * accepted. Mirrors the memory module's deliberately non-enforcing base rebuild
	 * (the probe is the only guard).
	 */
	private async rebuildSecondaryIndexes(
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
			await this.buildIndexEntries(
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
	 * Validates `rows` against a UNIQUE constraint, throwing `CONSTRAINT` on the first
	 * duplicate before any schema mutation. Used by `ADD CONSTRAINT UNIQUE` (validate
	 * against the current collation) and by `SET COLLATE` (pass an `updatedSchema` whose
	 * altered column carries the NEW collation, so the dedup is performed under it).
	 * Mirrors the duplicate detection in {@link buildIndexEntries}: a `seen` Set keyed on
	 * a per-column collation-aware signature of the constrained values, with SQL NULL
	 * semantics (a row with any NULL constrained value never counts as a duplicate) and
	 * the partial `predicate` honored.
	 *
	 * `rows` MUST be the rows the DDL-issuing connection can SEE. Ordinarily that is this
	 * table's EFFECTIVE stream (committed rows merged with the open transaction's own
	 * pending puts/deletes — `StoreTable.iterateEffectiveEntries`, adapted by
	 * {@link rowsFromEntries}); when a wrapper module holds the pending rows outside this
	 * module it hands them down as an `EffectiveRowSource` instead. Either way, a
	 * committed-only stream would let a duplicate inserted earlier in the same transaction
	 * slip past validation and land in the table once the transaction commits.
	 *
	 * No index store is written — store UNIQUE enforcement is a full-scan over
	 * `uniqueConstraints` at write time. The signature is built by
	 * {@link dedupeRowSignature} with one normalizer per constrained column, resolved from
	 * `tableSchema.columns[idx].collation` through the connection's
	 * `db.getKeyNormalizerResolver()`, so a per-column collation registered with
	 * `db.registerCollation` is honored (matching write-time `compareSqlValues`
	 * enforcement). A comparator-only collation raises: rows that cannot be bucketed
	 * cannot be deduped. Columns whose declared type can never hold text take the
	 * identity normalizer and so never raise.
	 */
	private async validateUniqueOverExistingRows(
		rows: AsyncIterable<Row>,
		tableSchema: TableSchema,
		uc: UniqueConstraintSchema,
		keyNormalizers: KeyNormalizerResolver,
	): Promise<void> {
		await assertNoDuplicateRows(
			rows,
			tableSchema,
			uc.columns,
			uc.columns.map(idx => {
				const column = tableSchema.columns[idx];
				return keyNormalizers(logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined);
			}),
			uc.predicate ? compilePredicate(uc.predicate, tableSchema.columns, tableSchema.name) : undefined,
		);
	}

	/**
	 * Index-shaped twin of {@link validateUniqueOverExistingRows}, used by
	 * {@link createIndex} when a wrapper module supplies the rows to judge. Dedupes on the
	 * index's own columns under the index column's COLLATE (falling back to the table
	 * column's), so it enforces exactly what `buildIndexEntries`' suppressed in-pass check
	 * would have — over the wrapper's rows instead of this module's committed ones.
	 */
	private async validateUniqueIndexOverRows(
		rows: AsyncIterable<Row>,
		tableSchema: TableSchema,
		indexSchema: TableIndexSchema,
		keyNormalizers: KeyNormalizerResolver,
	): Promise<void> {
		await assertNoDuplicateRows(
			rows,
			tableSchema,
			indexSchema.columns.map(col => col.index),
			indexDedupeNormalizers(tableSchema, indexSchema, keyNormalizers),
			indexSchema.predicate ? compilePredicate(indexSchema.predicate, tableSchema.columns, tableSchema.name) : undefined,
		);
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
	 * - Validation running AFTER this point (e.g. `rekeyRows`' duplicate-key pass,
	 *   which must see pending rows because a pending insert can itself be the
	 *   duplicate) throws with the enclosing transaction already flushed. The store
	 *   stays unmutated — only the transaction is gone. Validation that does NOT
	 *   need pending rows belongs before the call, so the transaction survives it.
	 *
	 * Subsequent `commit()` calls on the same coordinator are no-ops
	 * (`inTransaction` is cleared), which keeps the enclosing transaction safe.
	 * The savepoint stack is cleared too, so a later `ROLLBACK TO` / `RELEASE` that
	 * the engine still broadcasts warns and degrades rather than throwing — see
	 * `TransactionCoordinator.rollbackToSavepoint`, which mirrors the memory
	 * module's identical posture.
	 */
	private async ddlCommitPendingOps(): Promise<void> {
		if (this.moduleCoordinator?.isInTransaction()) {
			await this.moduleCoordinator.commit();
		}
	}

	/**
	 * Alters an existing store table's structure. Resolves the table, captures the
	 * pre-alter schema, and dispatches to the per-change-type `alter*` helper below;
	 * the helper does the arm's work (row migration, physical re-key, constraint
	 * validation, DDL persist) and returns the updated TableSchema for the engine to
	 * register. The shared preamble (schema subscription, reconnect, not-found throw,
	 * `defaultNotNull`) lives here so every arm sees the same resolved state.
	 */
	async alterTable(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		this.ensureSchemaSubscription(db);
		const table = this.getOrReconnectTable(db, schemaName, tableName);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`,
				StatusCode.ERROR,
			);
		}

		// The engine-facing schema carries no `_uc_*` (the store keeps the materialized
		// enforcement copy internal), so the arms build `updatedSchema` off a clean schema
		// exactly as before this feature; `table.updateSchema` recomputes the enforcement
		// copy, and {@link reconcileImplicitUniqueIndexStores} (below) moves the physical
		// stores for any constraint-set change.
		const oldSchema = table.getSchema();
		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';

		let updated: TableSchema;
		switch (change.type) {
			case 'addColumn':
				updated = await this.alterAddColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'dropColumn':
				updated = await this.alterDropColumn(schemaName, tableName, table, oldSchema, change);
				break;
			case 'renameColumn':
				updated = await this.alterRenameColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'alterPrimaryKey':
				updated = await this.alterPrimaryKeyChange(db, schemaName, tableName, table, oldSchema, change);
				break;
			case 'addConstraint':
				updated = await this.alterAddConstraint(db, schemaName, tableName, table, oldSchema, change, rows);
				break;
			case 'dropConstraint':
				updated = await this.alterDropConstraint(schemaName, tableName, table, oldSchema, change);
				break;
			case 'renameConstraint':
				updated = await this.alterRenameConstraint(schemaName, tableName, table, oldSchema, change);
				break;
			case 'alterColumn':
				updated = await this.alterColumnChange(db, schemaName, tableName, table, oldSchema, change, rows);
				break;
			default: {
				const _exhaustive: never = change;
				void _exhaustive;
				throw new QuereusError(`Unhandled ALTER TABLE change type '${(change as SchemaChangeInfo).type}'`, StatusCode.INTERNAL);
			}
		}

		// Move the physical `_uc_*` index stores to match the post-ALTER constraint set:
		// the SCHEMA entries were re-materialized by the arm's `table.updateSchema`, but a
		// newly-added constraint's store must be BUILT and a dropped/renamed one's TORN
		// DOWN. `oldSchema` carries the pre-ALTER `uniqueConstraints`; `table.getSchema()`
		// the post-ALTER set. A no-op when the implicit-index name set is unchanged (the
		// common case, incl. PK/collation/type ALTERs whose physical re-encode is already
		// handled by `rebuildSecondaryIndexes`).
		await this.reconcileImplicitUniqueIndexStores(db, schemaName, tableName, table, oldSchema);
		return updated;
	}

	/**
	 * Build / tear down the physical index stores backing implicit UNIQUE indexes
	 * (`_uc_*`) after an ALTER, by diffing the implicit-index NAMES of the old vs new
	 * constraint sets:
	 *   - a name newly PRESENT (ADD CONSTRAINT UNIQUE, or the target half of a
	 *     RENAME CONSTRAINT / rename of an unnamed UC's column) has its physical store
	 *     populated from this module's effective rows;
	 *   - a name newly ABSENT (DROP CONSTRAINT UNIQUE, or the source half of a rename)
	 *     has its store torn down, so a later re-ADD does not reopen stale entries.
	 *
	 * The SCHEMA entry itself is materialized/removed by `withImplicitUniqueIndexes`
	 * on the arm's `table.updateSchema`; only the physical store needs this. Runs after
	 * every ALTER but is a no-op whenever the implicit-index name set is unchanged
	 * (incl. PK / collation / data-type ALTERs, whose same-name physical re-encode is
	 * already done by {@link rebuildSecondaryIndexes}).
	 *
	 * `oldSchema` carries the pre-ALTER `uniqueConstraints` (its `.indexes` may be
	 * de-materialized — the diff reads `uniqueConstraints`, not `.indexes`).
	 *
	 * NOTE: the build populates from THIS module's own effective rows (committed + this
	 * transaction's pending), never a wrapper's — mirroring `createIndex`. Under the
	 * isolation layer the wrapper's rows are what ADD CONSTRAINT's validation judged;
	 * the physical index legitimately fills from this module's committed rows and an
	 * entry with no live row behind it is harmless (both readers resolve to the live
	 * row). Duplicates were already rejected by `validateUniqueOverExistingRows` (ADD)
	 * or cannot exist (RENAME leaves data unchanged), so the in-pass check is skipped.
	 */
	private async reconcileImplicitUniqueIndexStores(
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

		// Tear down each store whose implicit index no longer exists.
		for (const [lower, name] of oldNames) {
			if (!newNames.has(lower)) {
				await this.tearDownImplicitUniqueIndexStore(schemaName, tableName, table, name);
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
			await this.buildIndexEntries(
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
	private materializedIndexNames(table: StoreTable | undefined, fallback: TableSchema | undefined): string[] {
		const schema = table
			? table.getMaterializedSchema()
			: (fallback ? withImplicitUniqueIndexes(fallback) : undefined);
		return (schema?.indexes ?? []).map(i => i.name);
	}

	/** Close + delete the physical store of an implicit UNIQUE index. Mirrors `dropIndex`. */
	private async tearDownImplicitUniqueIndexStore(
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

	/**
	 * ADD COLUMN arm of {@link alterTable}: append the new column, eagerly migrate
	 * each row (literal or per-row backfill), and persist. Behavior-preserving
	 * extraction of the former `switch` arm.
	 *
	 * The store always appends. A caller-chosen `insertAtIndex` (module-API only; SQL never
	 * produces one) is rejected unless it names the append position, rather than silently
	 * landing the column somewhere the caller did not ask for.
	 */
	private async alterAddColumn(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'addColumn' }>,
		defaultNotNull: boolean,
	): Promise<TableSchema> {
		if (change.insertAtIndex !== undefined && change.insertAtIndex !== oldSchema.columns.length) {
			throw new QuereusError(
				`Store-backed table '${schemaName}.${tableName}' can only ADD COLUMN at the end `
					+ `(position ${oldSchema.columns.length}), not at position ${change.insertAtIndex}`,
				StatusCode.UNSUPPORTED,
			);
		}

		// Honor the session `default_collation` for an ADD COLUMN that omits an
		// explicit COLLATE, matching the CREATE path so an ADD-COLUMN-ed text column
		// gets the same collation a CREATE-d one would. The persisted DDL re-emits an
		// explicit COLLATE for any non-BINARY collation, so reopen stays stable.
		const newColSchema = columnDefToSchema(change.columnDef, defaultNotNull, db.options.getStringOption('default_collation'), (n) => db.isCollationRegistered(n));

		// Extract default value from column def constraints. Use the shared
		// `tryFoldLiteral` helper so signed numerics like `-123.0`
		// (a UnaryExpr in the AST) are recognized — matching the
		// memory-mode path and the engine-level ALTER validation.
		let defaultValue: SqlValue = null;
		const defaultConstraint = change.columnDef.constraints?.find(c => c.type === 'default');
		if (defaultConstraint?.expr) {
			const folded = tryFoldLiteral(defaultConstraint.expr);
			if (folded !== undefined) {
				defaultValue = folded;
			}
		}

		// A non-foldable DEFAULT (e.g. `new.<col>`) backfills each existing row from
		// its own value via the engine-supplied evaluator (mirrors the memory path).
		const backfillEvaluator = change.backfillEvaluator;

		// Refuse NOT NULL without a usable DEFAULT on a non-empty table
		// (SQLite-compatible). A per-row evaluator IS usable — its NOT NULL is enforced
		// per row during migration — so it is exempt from this no-default rejection.
		if (newColSchema.notNull && defaultValue === null && !backfillEvaluator) {
			if (await table.hasAnyRows()) {
				throw new QuereusError(
					`Cannot add NOT NULL column '${newColSchema.name}' to non-empty table `
						+ `'${schemaName}.${tableName}' without a DEFAULT value`,
					StatusCode.CONSTRAINT,
				);
			}
		}

		// Build updated schema: append new column
		const updatedColumns: ReadonlyArray<ColumnSchema> = Object.freeze([...oldSchema.columns, newColSchema]);
		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: updatedColumns,
			columnIndexMap: buildColumnIndexMap(updatedColumns),
		};

		// Physical rewrite ahead: flush the module's buffered writes so `migrateRows`
		// (a committed-store scan + batch) sees this transaction's rows and re-encodes
		// them under the new column layout. See {@link ddlCommitPendingOps}. Placed
		// after every throw-only check above — the NOT NULL rejection reads effectively
		// (`hasAnyRows`) — so a rejected ALTER leaves the enclosing transaction intact.
		await this.ddlCommitPendingOps();

		// Migrate rows: append the new column's value — a single literal default, or a
		// per-row value derived from the existing row when a backfill evaluator is set.
		const remap = buildColumnRemap(
			oldSchema.columns.map(c => c.name),
			updatedColumns.map(c => c.name),
		);
		await table.migrateRows(
			remap,
			defaultValue,
			backfillEvaluator
				? { evaluator: backfillEvaluator, notNull: newColSchema.notNull, columnName: newColSchema.name }
				: undefined,
		);

		// Update table schema (column-only) and persist DDL. Any constraint declared inline
		// on the added column (UNIQUE / CHECK / FOREIGN KEY) arrives as its own follow-up
		// `addConstraint` call from the engine's `runAddColumn`, which is what persists it —
		// so this arm neither installs nor persists them, and the schema it hands back stays
		// column-only.
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** DROP COLUMN arm of {@link alterTable}: drop the column slot, reindex PK / indexes /
	 *  UNIQUE, migrate rows, and persist. Behavior-preserving extraction. */
	private async alterDropColumn(
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'dropColumn' }>,
	): Promise<TableSchema> {
		const colNameLower = change.columnName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
		}

		// Build updated schema: remove column and reindex PK/indexes
		// Filter by original index BEFORE remapping to avoid incorrectly
		// removing columns that remap to the dropped column's position.
		const updatedColumns = oldSchema.columns.filter((_, idx) => idx !== colIndex);
		const updatedPkDef = oldSchema.primaryKeyDefinition
			.filter(def => def.index !== colIndex)
			.map(def => ({
				...def,
				index: def.index > colIndex ? def.index - 1 : def.index,
			}));
		const updatedIndexes = (oldSchema.indexes || [])
			.map(idx => ({
				...idx,
				columns: idx.columns
					.filter(ic => ic.index !== colIndex)
					.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index - 1 : ic.index })),
			}))
			.filter(idx => idx.columns.length > 0);

		// Prune any UNIQUE constraint over the dropped column, mirroring the index
		// filtering above. Store-backed UNIQUE is enforced by a full scan over
		// `uniqueConstraints`, so a stranded constraint whose column index dangles past
		// the column array would break the next insert's validation (and the persisted
		// DDL). A UNIQUE that includes the dropped column is removed outright; remaining
		// constraints have their column indices shifted to track the removed slot. This
		// also covers the engine's ADD COLUMN + inline-UNIQUE revert, which drops the
		// just-added (uniquely-constrained) column.
		const updatedUniqueConstraints = (oldSchema.uniqueConstraints ?? [])
			.filter(uc => !uc.columns.includes(colIndex))
			.map(uc => ({ ...uc, columns: Object.freeze(uc.columns.map(i => i > colIndex ? i - 1 : i)) }));

		// Shift or prune this table's own foreign keys, mirroring the UNIQUE pruning above
		// and the memory module's `dropColumn`. `foreignKeys[].columns` are indices into
		// THIS table, so they renumber over the removed slot; a key that loses ANY of its
		// child columns is removed outright (a key missing a child column is a different
		// constraint against the parent's key, not a narrowed one). Left unshifted, a
		// surviving key's index dangles past the column array or silently slides onto an
		// unrelated column — and `saveTableDDL` below persists whichever it ends up being.
		// `referencedColumnNames` is resolved against the parent by name at enforcement
		// time, so the parent side needs nothing here.
		const updatedForeignKeys = (oldSchema.foreignKeys ?? [])
			.filter(fk => !fk.columns.includes(colIndex))
			.map(fk => ({ ...fk, columns: Object.freeze(fk.columns.map(i => i > colIndex ? i - 1 : i)) }));

		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: Object.freeze(updatedColumns),
			columnIndexMap: buildColumnIndexMap(updatedColumns),
			primaryKeyDefinition: Object.freeze(updatedPkDef),
			indexes: Object.freeze(updatedIndexes),
			uniqueConstraints: updatedUniqueConstraints.length > 0
				? Object.freeze(updatedUniqueConstraints)
				: undefined,
			foreignKeys: updatedForeignKeys.length > 0
				? Object.freeze(updatedForeignKeys)
				: undefined,
		};

		// Physical rewrite ahead — flush buffered writes so `migrateRows` re-encodes
		// this transaction's rows too. See {@link ddlCommitPendingOps}.
		await this.ddlCommitPendingOps();

		// Migrate rows: remove the dropped column slot
		const remap = buildColumnRemap(
			oldSchema.columns.map(c => c.name),
			updatedColumns.map(c => c.name),
		);
		await table.migrateRows(remap, null);

		// Update table schema and persist DDL
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** RENAME COLUMN arm of {@link alterTable}: schema-only rewrite (columns, indexes, self-FK,
	 *  in-place predicate / CHECK AST rewrite) and persist. Behavior-preserving extraction. */
	private async alterRenameColumn(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'renameColumn' }>,
		defaultNotNull: boolean,
	): Promise<TableSchema> {
		if (!change.newColumnDefAst) {
			throw new QuereusError('RENAME COLUMN requires a new column definition AST', StatusCode.INTERNAL);
		}

		const oldNameLower = change.oldName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.oldName}' not found.`, StatusCode.ERROR);
		}

		const newColSchema = columnDefToSchema(change.newColumnDefAst, defaultNotNull, 'BINARY', (n) => db.isCollationRegistered(n));
		const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newColSchema : c);
		const updatedIndexes = (oldSchema.indexes || []).map(idx => ({
			...idx,
			columns: idx.columns.map(ic =>
				ic.index === colIndex ? { ...ic, name: change.newName } : ic
			),
		}));

		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: Object.freeze(updatedColumns),
			columnIndexMap: buildColumnIndexMap(updatedColumns),
			indexes: Object.freeze(updatedIndexes),
			// A self-referencing FK names the renamed column in `referencedColumnNames`
			// and is persisted by name; the engine rewrites it only in the post-hook
			// pass. Pure copy — no rollback needed, this schema is only adopted on the
			// success path.
			foreignKeys: renameColumnInSelfForeignKeys(
				oldSchema.foreignKeys, schemaName, tableName, change.oldName, change.newName),
		};

		// A partial index's WHERE clause and a CHECK constraint's expression both
		// still name the OLD column: the engine's `propagateColumnRename` pass runs
		// only after this hook returns. Persisting now would durably write a bundle
		// naming a column the table no longer has, and only the later propagation's
		// `table_modified` event would correct it — a crash in between leaves the
		// catalog un-rehydratable. So rewrite first, in place: each `Expression` is
		// shared by reference with the catalog's `TableSchema` and, for a unique
		// partial index, with the `derivedFromIndex` UNIQUE constraint, so one
		// rewrite covers all holders and makes the later propagation pass a no-op.
		//
		// The rewrites are the first statements in the `try`, and each walks its
		// collection one item at a time, so a throw anywhere — including partway
		// through a walk — must reverse them: restoring `oldSchema` cannot, since the
		// ASTs are shared. Reversing is a no-op wherever nothing names the new column,
		// and the engine has already rejected a rename onto an existing column name,
		// so the reverse pass cannot collide with an expression that legitimately
		// named it.
		const resolveColumnInSource: ResolveColumnInSource = (s, t, col) =>
			db.schemaManager.getSchema(s)?.getTable(t)?.columnIndexMap.has(col.toLowerCase()) ?? false;
		const rewriteColumn = (from: string, to: string): void => {
			renameColumnInIndexPredicates(
				updatedIndexes, tableName, from, to, schemaName, resolveColumnInSource);
			renameColumnInCheckConstraints(
				oldSchema.checkConstraints, tableName, from, to, schemaName, resolveColumnInSource);
		};
		try {
			rewriteColumn(change.oldName, change.newName);

			// Rename is schema-only — no row migration needed
			table.updateSchema(updatedSchema);
			await this.saveTableDDL(updatedSchema);
		} catch (e) {
			rewriteColumn(change.newName, change.oldName);
			throw e;
		}

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** ALTER PRIMARY KEY arm of {@link alterTable}: physically re-key the data store, rebuild
	 *  secondary indexes, and persist. Behavior-preserving extraction. */
	private async alterPrimaryKeyChange(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'alterPrimaryKey' }>,
	): Promise<TableSchema> {
		const newPkColumns = change.newPkColumns;
		const updatedSchema: TableSchema = {
			...oldSchema,
			primaryKeyDefinition: Object.freeze(
				newPkColumns.map(pk => ({ index: pk.index, desc: pk.desc })),
			),
		};

		// Physical re-key ahead — flush buffered writes so every live row is
		// re-keyed and no stale-schema op replays over the rewritten store.
		// `rekeyRows`' duplicate-key pass runs against the flushed store, so a
		// pending insert that collides under the new PK is caught. See
		// {@link ddlCommitPendingOps} for the transaction consequences.
		await this.ddlCommitPendingOps();

		// Re-key the data store. Throws CONSTRAINT on duplicates without
		// mutating the store, giving us all-or-nothing semantics for the
		// validation phase.
		await table.rekeyRows(newPkColumns);

		// Secondary index keys embed the PK suffix — clear + rebuild every
		// index against the now-rekeyed data store. Rebuild the MATERIALIZED index list
		// so each implicit `_uc_*` PK suffix is re-encoded too (`updatedSchema` is built
		// off the de-materialized `oldSchema`, so it carries no `_uc_*` on its own).
		await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver());

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** ADD CONSTRAINT arm of {@link alterTable}: validate existing rows as the constraint kind
	 *  (UNIQUE / FOREIGN KEY / CHECK) requires, then persist. Behavior-preserving extraction. */
	private async alterAddConstraint(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'addConstraint' }>,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const constraint = change.constraint;
		let updatedSchema: TableSchema;

		if (constraint.type === 'unique') {
			// Validate the existing rows against the new UNIQUE before persisting. The
			// implicit `_uc_*` index that backs enforcement is materialized into the
			// StoreTable schema by `table.updateSchema` below, and its PHYSICAL store is
			// built by `reconcileImplicitUniqueIndexStores` after this arm returns — the
			// validation here runs first, so a CONSTRAINT rejection never leaves a store
			// behind.
			//
			// No `ddlCommitPendingOps()` here (unlike the row-rewriting arms): this
			// writes no rows, and the validation scan already reads effectively, so
			// the transaction survives a CONSTRAINT rejection.
			const uc = buildUniqueConstraintSchema(constraint, oldSchema.columnIndexMap);
			await this.validateUniqueOverExistingRows(
				rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds())),
				oldSchema,
				uc,
				db.getKeyNormalizerResolver(),
			);
			updatedSchema = {
				...oldSchema,
				uniqueConstraints: Object.freeze([...(oldSchema.uniqueConstraints ?? []), uc]),
			};
		} else if (constraint.type === 'foreignKey') {
			const fk = buildForeignKeyConstraintSchema(constraint, oldSchema.columnIndexMap, oldSchema.name, oldSchema.schemaName);
			updatedSchema = {
				...oldSchema,
				foreignKeys: Object.freeze([...(oldSchema.foreignKeys ?? []), fk]),
			};
			// Pragma-gated existing-row validation; throws before persistence on an orphan.
			await validateForeignKeyOverExistingRows(db, updatedSchema, fk);
		} else if (constraint.type === 'check') {
			// Schema-only: a CHECK has no physical structure and (matching the
			// engine's prior in-emitter behavior) no existing-row scan. Routing it
			// here — rather than catalog-only — keeps the persisted DDL and the
			// connected-table schema in lock-step so DROP/RENAME CONSTRAINT resolve it.
			const check = buildCheckConstraintSchema(constraint, oldSchema.checkConstraints.length);
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze([...oldSchema.checkConstraints, check]),
			};
		} else {
			throw new QuereusError(
				`Store table ADD CONSTRAINT does not support constraint type '${constraint.type}'`,
				StatusCode.UNSUPPORTED,
			);
		}

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** DROP CONSTRAINT arm of {@link alterTable}: schema-only catalog rewrite dropping a named
	 *  constraint, then persist. Behavior-preserving extraction. */
	private async alterDropConstraint(
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'dropConstraint' }>,
	): Promise<TableSchema> {
		// Schema-only catalog rewrite. Dropping a UNIQUE removes it from
		// `uniqueConstraints`, so `table.updateSchema` below de-materializes its implicit
		// `_uc_*` index and `reconcileImplicitUniqueIndexStores` (after this arm returns)
		// tears down the now-orphaned physical store — without which a later re-ADD would
		// reopen stale entries. A UNIQUE derived from a CREATE UNIQUE INDEX is rejected
		// upstream (drop the index instead), and has no `_uc_*` anyway.
		const constraintClass = resolveNamedConstraintClass(oldSchema, change.constraintName);
		const lower = change.constraintName.toLowerCase();
		let updatedSchema: TableSchema;
		if (constraintClass === 'check') {
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze(oldSchema.checkConstraints.filter(c => c.name?.toLowerCase() !== lower)),
			};
		} else if (constraintClass === 'foreignKey') {
			const remaining = (oldSchema.foreignKeys ?? []).filter(c => c.name?.toLowerCase() !== lower);
			updatedSchema = { ...oldSchema, foreignKeys: remaining.length > 0 ? Object.freeze(remaining) : undefined };
		} else {
			const remaining = (oldSchema.uniqueConstraints ?? []).filter(c => c.name?.toLowerCase() !== lower);
			updatedSchema = { ...oldSchema, uniqueConstraints: remaining.length > 0 ? Object.freeze(remaining) : undefined };
		}

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** RENAME CONSTRAINT arm of {@link alterTable}: schema-only rename of a named constraint,
	 *  then persist. A renamed named-UNIQUE changes its implicit `_uc_*` index name, so
	 *  `reconcileImplicitUniqueIndexStores` (run after this arm) MOVES the physical store —
	 *  tears down the old-named store and rebuilds the new-named one from effective rows. */
	private async alterRenameConstraint(
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'renameConstraint' }>,
	): Promise<TableSchema> {
		const constraintClass = resolveNamedConstraintClass(oldSchema, change.oldName);
		const oldLower = change.oldName.toLowerCase();
		let updatedSchema: TableSchema;
		if (constraintClass === 'check') {
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze(
					oldSchema.checkConstraints.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		} else if (constraintClass === 'foreignKey') {
			updatedSchema = {
				...oldSchema,
				foreignKeys: Object.freeze(
					oldSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		} else {
			updatedSchema = {
				...oldSchema,
				uniqueConstraints: Object.freeze(
					oldSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		}

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** ALTER COLUMN arm of {@link alterTable}: change one attribute (NOT NULL / data type /
	 *  default / collation), running the physical re-key + existing-row re-validation the
	 *  collation / PK paths require, then persist. Behavior-preserving extraction. */
	private async alterColumnChange(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const colNameLower = change.columnName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
		}
		const oldCol = oldSchema.columns[colIndex];
		// Pull exactly one attribute from the change. Each sub-helper returns the new
		// column schema plus whether the collation bytes changed (`collationChanged` gates
		// the existing-row UNIQUE re-validation and PK re-key below) plus a DEFERRED
		// `valueConvert` closure when the change rewrites stored values — the sub-helper
		// itself mutates nothing. Or null when the column is already in the desired state —
		// preserving the pre-refactor early exits (SET NOT NULL no-op, SET COLLATE
		// already-explicit) that leave the table and any open transaction untouched.
		let attr: AlterColumnAttrChange | null;
		if (change.setNotNull !== undefined) {
			attr = await this.alterColumnSetNotNull(table, oldSchema, oldCol, colIndex, change, rows);
		} else if (change.setDataType !== undefined) {
			attr = await this.alterColumnSetDataType(table, oldSchema, oldCol, colIndex, change);
		} else if (change.setDefault !== undefined) {
			attr = { newCol: { ...oldCol, defaultValue: change.setDefault }, collationChanged: false };
		} else if (change.setCollation !== undefined) {
			attr = this.alterColumnSetCollation(oldCol, change, (n) => db.isCollationRegistered(n));
		} else {
			throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
		}
		if (attr === null) {
			return oldSchema;
		}
		const { newCol, collationChanged, valueConvert } = attr;
		// Named for the PENDING act, not a completed one: the deferred value rewrite (SET DATA
		// TYPE conversion / SET NOT NULL backfill) is applied below, after every throw-only
		// check. Both gates that read this run BEFORE it, while the store still holds the old
		// values.
		const rewritesValues = valueConvert !== undefined;

		const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newCol : c);
		// Mirror the memory module (MemoryTableManager.alterColumn): a per-column
		// collation change propagates into every index column ordering by this
		// column, so a `derivedFromIndex` UNIQUE re-keys its enforcement under the
		// new collation. StoreTable.uniqueEnforcementCollations reads the index's
		// per-column collation, so without this the index entry would stay stale
		// and the derived UNIQUE would keep enforcing the OLD collation after the
		// ALTER. Metadata-only: the store's index KEY bytes use the table-level key
		// collation K (see buildIndexEntries / updateSecondaryIndexes), so no index
		// entry re-encode is required for a non-PK column. An index column with an
		// explicit COLLATE is re-collated too — matching memory, which clobbers it
		// the same way (no surface preserves a differing index COLLATE across an
		// ALTER COLUMN SET COLLATE on its column).
		const updatedIndexes = (collationChanged && oldSchema.indexes)
			? oldSchema.indexes.map(idx => ({
				...idx,
				columns: idx.columns.map(ic =>
					ic.index === colIndex ? { ...ic, collation: newCol.collation } : ic),
			}))
			: oldSchema.indexes;
		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: Object.freeze(updatedColumns),
			columnIndexMap: buildColumnIndexMap(updatedColumns),
			indexes: updatedIndexes ? Object.freeze(updatedIndexes) : updatedIndexes,
		};

		// SET DATA TYPE onto/off a type with a key transform (TIMESPAN's total-seconds
		// groupKey, JSON's structural encoder — see `storeSemanticKeyTransform`)
		// changes the physical KEY BYTES a value encodes to, even when the stored
		// VALUE bytes don't change (text → timespan keeps TEXT physical). Treated
		// exactly like a collation change below: existing-row UNIQUE re-validation
		// (equal-elapsed spellings now collide), a PK re-key when the column is a PK
		// member, and a secondary-index rebuild (index keys encode the column's
		// values). A same-type no-op ALTER never gets here (`inferType` returns the
		// shared type object, so the identity check short-circuits).
		const keyTransformChanged = oldCol.logicalType !== newCol.logicalType
			&& (storeSemanticKeyTransform(oldCol.logicalType) !== undefined
				|| storeSemanticKeyTransform(newCol.logicalType) !== undefined);

		// Existing-row UNIQUE re-validation (Option A, non-PK UNIQUE). Two ways an ALTER
		// COLUMN can make rows that were distinct collide, both judged here BEFORE any
		// mutation/persist so the first collision throws CONSTRAINT and leaves the table
		// unchanged and writable (matches the ADD CONSTRAINT rollback shape):
		//  - SET COLLATE / a key-transform change: the comparators change ('a'/'A' collide
		//    under NOCASE). Re-scan under the NEW collation (`updatedSchema` carries it).
		//  - a value-REWRITING change (`valueConvert`: SET DATA TYPE, or a SET NOT NULL
		//    null → DEFAULT backfill): the comparators are unchanged but the VALUES collapse
		//    ('1'/'01' → 1; two NULLs → the same DEFAULT). The probe judges the CONVERTED
		//    rows — the same closure the deferred rewrite below applies — while the store
		//    still holds the old values. A standalone `create unique index` synthesizes a
		//    `derivedFromIndex` entry in `uniqueConstraints`, so both declaration shapes are
		//    reachable through this walk.
		// The PK is intentionally excluded — it never appears in `uniqueConstraints`;
		// its physical re-key/re-validation is the `pkRekeyNeeded` block below.
		//
		// NOTE: one full row scan per covering constraint, and this gate now fires on the
		// COMMON retype/backfill path, not only on the rare collation/transform ones. Fine
		// while tables covered by several UNIQUE constraints over one column are rare; if a
		// wide-constraint table makes ALTER COLUMN slow, judge all covering constraints in a
		// single pass (one `seen` Set per constraint, one stream).
		if (collationChanged || keyTransformChanged || rewritesValues) {
			const coveringConstraints = (updatedSchema.uniqueConstraints ?? [])
				.filter(uc => uc.columns.includes(colIndex));
			for (const uc of coveringConstraints) {
				// Fresh generator per constraint — an async generator is single-shot. An
				// `EffectiveRowSource` is re-callable for exactly this reason.
				const effectiveRows = rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds()));
				await this.validateUniqueOverExistingRows(
					valueConvert ? convertRowsAtIndex(effectiveRows, colIndex, valueConvert) : effectiveRows,
					updatedSchema,
					uc,
					db.getKeyNormalizerResolver(),
				);
			}
		}

		// SET COLLATE on a PRIMARY KEY member (Option B physical re-key): re-encode
		// every data-store key under the column's new key collation, then rebuild every
		// secondary index (its keys embed the PK suffix). `rekeyRows` validates in a
		// first pass and throws CONSTRAINT on a collision under the new collation WITHOUT
		// mutating the store — so a coarser collation that collapses two distinct PKs
		// (e.g. 'a'/'A' under BINARY→NOCASE) is rejected all-or-nothing, mirroring
		// ALTER PRIMARY KEY. Runs AFTER the non-PK UNIQUE re-validation above so both
		// throw-only checks precede the first store mutation. `updatedSchema.columns`
		// carries the new collation, so the new key bytes follow it.
		const pkRekeyNeeded = (collationChanged || keyTransformChanged)
			&& oldSchema.primaryKeyDefinition.some(def => def.index === colIndex);
		if (pkRekeyNeeded) {
			// Physical re-key ahead — flush buffered writes (see
			// {@link ddlCommitPendingOps}). Deliberately AFTER the non-PK UNIQUE
			// re-validation above: that check reads effectively and throws without
			// needing the flush, so it must keep the transaction alive.
			//
			// NOTE: `rekeyRows` detects PK collisions among THIS module's rows only. When a
			// wrapper module supplied `rows`, its staged rows are not in this store, so a
			// pending row that collides with a committed one under the new collation is
			// caught by neither side — the wrapper's overlay enforces the PK among its own
			// rows, this store among its own. Closing it needs a PK-dedupe pass over `rows`
			// under the new collation here, before the re-key.
			await this.ddlCommitPendingOps();
			await table.rekeyRows(oldSchema.primaryKeyDefinition, updatedSchema.columns);
			// Materialize so the implicit `_uc_*` PK suffix is re-encoded under the new
			// key collation too (`updatedSchema` carries none on its own).
			await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver());
		}

		// Deferred value rewrite (SET DATA TYPE physical conversion / SET NOT NULL DEFAULT
		// backfill): every throw-only check above has passed, so the store mutation is now
		// safe — a rejected ALTER never reaches this point, leaving values, DDL and the
		// transaction untouched. Flush buffered writes first so `mapRowsAtIndex` rewrites this
		// transaction's rows too; unflushed, they would replay under the OLD physical type
		// (see {@link ddlCommitPendingOps}; a re-flush after the PK re-key's own is a no-op).
		//
		// NOTE: `valueConvert` and `pkRekeyNeeded` cannot both be set today, and this ordering
		// depends on that. `valueConvert` comes only from SET DATA TYPE or SET NOT NULL;
		// SET NOT NULL changes neither collation nor logical type, so it never sets
		// `pkRekeyNeeded`, and SET DATA TYPE on a PK member is refused both upstream (every live
		// caller — the engine's ALTER COLUMN emitter, see `runAlterColumn` in
		// runtime/emit/alter-table.ts, and the materialized-view reshape, which declares a
		// key-column retype inexpressible) AND locally, by `alterColumnSetDataType` itself. If a
		// PK-member retype is ever admitted (that local guard removed), this rewrite must move IN
		// FRONT of the `pkRekeyNeeded` block: otherwise `rekeyRows` and its index rebuild encode
		// the PRE-rewrite values and the rebuild below is skipped, leaving keys and indexes
		// disagreeing with the stored values.
		if (valueConvert) {
			await this.ddlCommitPendingOps();
			await table.mapRowsAtIndex(colIndex, valueConvert);
		}

		// The value rewrite above changed stored column values in place (same PK, new value) —
		// and a key-identity transform change re-encodes the column's index-key bytes even with
		// values untouched. Secondary index KEY bytes encode the indexed column VALUES, so any
		// index covering this column still points at the OLD bytes until rebuilt — an
		// index-backed lookup for the new value finds nothing (mirrors the memory module's
		// `valueConvert` rebuild in MemoryTableManager.alterColumn). `rebuildSecondaryIndexes`
		// reads committed-only, so flush buffered writes first — the value rewrite above
		// already did, and the transform-only path (text → timespan: no value rewrite) must
		// too; a re-flush with nothing pending is a no-op. Skipped when the PK re-key above
		// already rebuilt every index, so no double rebuild. Materialize so an implicit `_uc_*`
		// over the rewritten column is rebuilt against the new value bytes too. The rebuild is
		// NON-enforcing (`skipDuplicateCheck`): the UNIQUE re-validation above already judged
		// the issuer's effective rows, and this module's committed rows may retain a row a
		// wrapper's transaction has deleted whose converted value duplicates a survivor —
		// enforcing here would spuriously reject what the probe correctly accepted.
		if ((rewritesValues || keyTransformChanged) && !pkRekeyNeeded) {
			await this.ddlCommitPendingOps();
			await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver(), true);
		}

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/**
	 * SET NOT NULL / DROP NOT NULL sub-branch of {@link alterColumnChange}. Returns the
	 * new column schema, or null when the column is already in the desired nullability
	 * (the pre-refactor `return oldSchema` no-op). Mutates nothing: the NULL-backfill
	 * probe is throw-only, and the backfill itself is returned as a deferred
	 * `valueConvert` (null → DEFAULT) the caller applies only after every throw-only
	 * check — including the UNIQUE re-validation over the backfilled values — has passed.
	 *
	 * `rows` is the wrapper-supplied effective row source (the isolation overlay). When present,
	 * the reject-vs-backfill decision scans it instead of `table.rowsWithNullAtIndex`: behind the
	 * isolation layer the issuer's pending inserts live in the wrapper's overlay, not this store,
	 * so the store's own count would miss them and wrongly accept the ALTER. The committed-store
	 * `mapRowsAtIndex` backfill is unchanged — the overlay-resident pending rows are the isolation
	 * layer's job (its overlay migration), this store only owns its committed rows.
	 */
	private async alterColumnSetNotNull(
		table: StoreTable,
		oldSchema: TableSchema,
		oldCol: ColumnSchema,
		colIndex: number,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
		rows?: EffectiveRowSource,
	): Promise<AlterColumnAttrChange | null> {
		let newCol: ColumnSchema;
		let valueConvert: ((v: SqlValue) => SqlValue) | undefined;
		if (change.setNotNull === true && !oldCol.notNull) {
			// Backfill NULLs from a literal DEFAULT, or throw.
			let defaultLiteral: SqlValue | undefined;
			const expr = oldCol.defaultValue;
			if (expr && (expr as { type?: string }).type === 'literal') {
				defaultLiteral = (expr as { value?: SqlValue }).value ?? null;
			}
			// Decide reject-vs-backfill over the DDL transaction's EFFECTIVE rows. `rows()` (the
			// isolation overlay) sees the issuer's pending inserts; `rowsWithNullAtIndex` (run
			// directly, no wrapper) sees the store's own effective rows. Either way a NULL the
			// transaction can see is backfilled, or rejects the ALTER, like any other row.
			let anyNull: boolean;
			if (rows) {
				anyNull = false;
				for await (const row of rows()) {
					if (row[colIndex] === null) { anyNull = true; break; }
				}
			} else {
				anyNull = (await table.rowsWithNullAtIndex(colIndex)) > 0;
			}
			if (anyNull) {
				if (defaultLiteral === undefined || defaultLiteral === null) {
					// Throw-only, and before the DDL-commit below: the transaction survives.
					throw new QuereusError(
						`column ${change.columnName} contains NULL values`,
						StatusCode.CONSTRAINT,
					);
				}
				const fill = defaultLiteral;
				// Backfill DEFERRED: the caller flushes + `mapRowsAtIndex`es this closure only
				// after its throw-only checks pass. Run directly, that fills the transaction's
				// rows too (the probe saw them). Behind isolation the issuer's overlay-resident
				// NULL rows are filled by the isolation layer's overlay migration, not here —
				// this store never holds them.
				valueConvert = (v) => v === null ? fill : v;
			}
			newCol = { ...oldCol, notNull: true };
		} else if (change.setNotNull === false && oldCol.notNull) {
			if (oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new QuereusError(
					`Cannot DROP NOT NULL on PRIMARY KEY column '${change.columnName}'`,
					StatusCode.CONSTRAINT,
				);
			}
			newCol = { ...oldCol, notNull: false };
		} else {
			return null; // already in desired state
		}
		return { newCol, collationChanged: false, valueConvert };
	}

	/**
	 * SET DATA TYPE sub-branch of {@link alterColumnChange}. Returns the retyped column
	 * schema. Mutates nothing: for every retype between DIFFERENT logical types, a
	 * throw-only convert pass over the live rows proves every value convertible, and the
	 * conversion itself is returned as a deferred `valueConvert` the caller applies only
	 * after every throw-only check — including the UNIQUE re-validation over the converted
	 * values — has passed. Gated on logical-type IDENTITY, not the physical storage class:
	 * `inferType` flattens aliases to the shared type object (`varchar(50)` IS `TEXT_TYPE`),
	 * so an alias retype is schema-only, while a same-class retype (text → date) still
	 * rejects values the new type refuses and rewrites the rest to the new type's
	 * canonical spelling ('2024-06-05T00:00:00Z' → '2024-06-05') — exactly as an INSERT
	 * would have stored them.
	 *
	 * A retype of a PRIMARY KEY member is refused here rather than converted: the rewrite
	 * below is `mapRowsAtIndex`, a payload-only rewrite that reuses `entry.key` verbatim, so
	 * a PK column's physical key bytes would stay encoded under the OLD type while the value
	 * moves to the new one — unfindable by any lookup under the new encoding, and the same
	 * `keyTransformChanged` path in the caller would re-key from the pre-rewrite values before
	 * this rewrite ever ran (see the NOTE above the `valueConvert` block in
	 * {@link alterColumnChange}). Every live SQL caller already refuses this earlier (the
	 * engine's `runAlterColumn` and the materialized-view reshape's inexpressibility check),
	 * so this only guards a direct module call — mirrors the memory backend's carve-out
	 * (`MemoryTableManager.alterColumn`).
	 */
	private async alterColumnSetDataType(
		table: StoreTable,
		oldSchema: TableSchema,
		oldCol: ColumnSchema,
		colIndex: number,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
	): Promise<AlterColumnAttrChange> {
		const newLogicalType = inferType(change.setDataType!);
		let valueConvert: ((v: SqlValue) => SqlValue) | undefined;
		if (newLogicalType !== oldCol.logicalType) {
			if (oldSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new QuereusError(
					`Cannot change the data type of primary key column '${change.columnName}' of table '${oldSchema.name}'.`,
					StatusCode.CONSTRAINT,
				);
			}
			// Conversion required — walk every row and attempt parse.
			const convert = (v: SqlValue): SqlValue => {
				try {
					return validateAndParse(v, newLogicalType, change.columnName) as SqlValue;
				} catch {
					throw new QuereusError(
						`Cannot convert value in '${change.columnName}' to ${change.setDataType}`,
						StatusCode.MISMATCH,
					);
				}
			};
			// Throw-only pass over the LIVE rows, so an unconvertible value this
			// transaction inserted rejects the ALTER with the transaction still intact.
			// The rewrite itself is DEFERRED: the caller flushes + `mapRowsAtIndex`es
			// this closure only after its remaining throw-only checks pass.
			// NOTE: pre-existing gap — this scan reads the store's own effective rows and
			// ignores a wrapper-supplied `rows` stream (unlike the memory module's arm). No
			// hole under isolation: the wrapper's `validateOverlayMigration` converts every
			// staged overlay value itself before the underlying mutates.
			for await (const value of table.iterateEffectiveValuesAtIndex(colIndex)) {
				if (value !== null) convert(value);
			}
			valueConvert = (v) => v === null ? v : convert(v);
		}
		return { newCol: { ...oldCol, logicalType: newLogicalType }, collationChanged: false, valueConvert };
	}

	/**
	 * SET COLLATE sub-branch of {@link alterColumnChange}. Returns the recollated column
	 * schema with `collationChanged` set when the collation bytes actually change (a bare
	 * metadata flip keeps it false), or null when the column is already explicit in the
	 * desired collation (the pre-refactor `return oldSchema` no-op). Synchronous — no
	 * row scan happens here; the caller runs the re-validation / re-key the flag gates.
	 */
	private alterColumnSetCollation(
		oldCol: ColumnSchema,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
		isCollationRegistered: (name: string) => boolean,
	): AlterColumnAttrChange | null {
		// Per-column collation update. PRIMARY KEY uniqueness/ordering is enforced
		// PHYSICALLY in the key bytes under a PER-COLUMN key collation
		// (`StoreTable.pkKeyCollations`), so a PK-column SET COLLATE is honored
		// natively by physically re-keying the data store + rebuilding every
		// secondary index under the new collation (the `isPkColumn` block below),
		// mirroring the memory module's primary re-key. A re-key that would collide
		// under the new collation throws CONSTRAINT before any mutation. For non-PK
		// UNIQUE constraints we re-validate existing rows under the new collation
		// (Option A). Query-layer ORDER BY / `=` / `table_info().collation` pick the
		// new collation up from the column schema once this updated schema re-registers.
		const normalized = validateCollationForType(change.setCollation!, oldCol.logicalType, change.columnName, isCollationRegistered);
		const nameMatches = normalized === (oldCol.collation || 'BINARY');
		if (nameMatches && oldCol.collationExplicit) {
			return null; // already explicit in the desired collation — no scan, no re-key, no re-persist
		}
		// SET COLLATE is a user declaration with the same standing as a
		// CREATE-time COLLATE clause, so mark the collation explicit (rank 2
		// in the comparison lattice) regardless of the column's creation
		// history — including SET COLLATE binary. When only the name matches
		// but the column was not yet explicit (a defaulted collation, or one
		// inherited from session default_collation), flip the flag as a
		// METADATA-ONLY change: the collation bytes are unchanged, so keep
		// collationChanged false to skip rekeyRows / validateUniqueOverExistingRows
		// below while still re-registering the schema and re-persisting DDL.
		// A different name takes the full physical re-key path AND sets the flag.
		return { newCol: { ...oldCol, collation: normalized, collationExplicit: true }, collationChanged: !nameMatches };
	}

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
		const occupied = this.collectOccupiedStoreNames(db, schemaName);
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
		// exist under those names. See {@link ddlCommitPendingOps}.
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

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: newName,
		});
	}

	/**
	 * Second phase of a two-phase RENAME TABLE (see {@link renameTable}). The engine calls
	 * this at the END of ALTER TABLE ... RENAME TO — AFTER its `propagateTableRename` has
	 * rewritten every dependent object that named `oldName` and enqueued their corrective
	 * catalog writes onto {@link persistQueue}. `renameTable` deliberately left `oldName`'s
	 * catalog entry in place; here we drain those dependent writes to durability and only
	 * THEN drop the old entry. During the window both entries coexist on disk, so every
	 * dependent resolves against one of them and every intermediate catalog set rehydrates
	 * into a working database.
	 *
	 * The old-entry delete rides `persistQueue` behind the dependents' already-enqueued
	 * writes (FIFO), so it can only run after them, and the drain below awaits the whole
	 * chain. Errors are swallowed+logged (the {@link enqueuePersist} contract): a failed
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
		return { ...this.computeBestAccessPlan(db, tableInfo, request), honorsCollatedRangeBounds: true };
	}

	private computeBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		const estimatedRows = request.estimatedRows ?? 1000;
		// Table key collation K (default NOCASE). Any K reaching here has a key normalizer:
		// `StoreTable`'s constructor rejects one that cannot key, and a name we cannot resolve
		// to a table falls back to the built-in NOCASE. `||`, not `??`, so an empty-string
		// `config.collation` reads as the default here exactly as it does in
		// `StoreTable.encodeOptions` — the two must agree or `analyzePKAccess` would decline a
		// window `computeBestAccessPlan` already marked handled.
		const tableKeyCollation = (this.getTable(tableInfo.schemaName, tableInfo.name)?.getConfig().collation || 'NOCASE').toUpperCase();

		// Check for primary key equality constraints. Count DISTINCT pinned PK columns:
		// counting raw '=' filters would read `a = 1 and a = 2` on a composite PK (a, b)
		// as "both PK columns pinned", claim both filters handled, then — with no
		// complete PK equality set to seek — degrade to a sequential scan whose residual
		// has already been discarded, returning the whole table.
		const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);
		const pinnedPkColumns = new Set(
			request.filters
				.filter(f => f.columnIndex !== undefined && pkColumns.includes(f.columnIndex) && f.op === '=')
				.map(f => f.columnIndex)
		);

		if (pinnedPkColumns.size === pkColumns.length && pkColumns.length > 0) {
			// Full PK match - point lookup (single row; no monotonic advertisement)
			return AccessPlanBuilder
				.eqMatch(1, 0.1)
				.setHandledFilters(claimFirstPerRole(request.filters, equalityRoles(pkColumns)))
				.setIsSet(true)
				.setIndexName('_primary_')
				.setExplanation('Store primary key lookup')
				.build();
		}

		// Check for range constraints on the leading PK column.
		// The legacy access-path rule (rule-select-access-path.ts) only forwards
		// range bounds for primaryKeyDefinition[0]; ranges on later PK columns
		// are silently dropped if marked handled. So only claim handled=true
		// when the range is on the first PK column.
		//
		// The seek is also declined when the leading PK column's key bytes do not order the
		// way its comparator does (`pkOrderPreservingPrefix === 0`): `StoreTable.analyzePKAccess`
		// declines the byte window under exactly that condition, so claiming the range filters
		// handled here would drop the residual Filter and return the whole table.
		const pkOrderPreservingPrefix = pkOrderPreservingPrefixLength(
			db,
			tableInfo,
			resolvePkKeyCollations(tableInfo.primaryKeyDefinition, tableInfo.columns, tableKeyCollation),
			tableKeyCollation,
		);
		const firstPkColumn = tableInfo.primaryKeyDefinition[0]?.index;
		const hasLeadingPkRange = firstPkColumn !== undefined
			&& pkOrderPreservingPrefix >= 1
			&& request.filters.some(f => f.columnIndex === firstPkColumn && RANGE_OPS.includes(f.op));

		if (hasLeadingPkRange) {
			// Range scan on first PK column. Iteration is by PK key order (see
			// StoreTable.scanPKRange), so we can advertise monotonic emission on
			// the leading PK column. The scan seeks to the window start and
			// early-terminates (StoreTable.buildPKRangeBounds derives the encoded
			// bounds), and the leading-PK order guarantee holds throughout.
			const rangeRows = Math.max(1, Math.floor(estimatedRows * 0.3));
			const plan = AccessPlanBuilder
				.rangeScan(rangeRows, 0.2)
				.setHandledFilters(claimFirstPerRole(request.filters, rangeRoles(firstPkColumn!)))
				.setIndexName('_primary_')
				.setSeekColumns([firstPkColumn!])
				.setExplanation('Store primary key range scan')
				.build();
			return { ...plan, ...this.buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix) };
		}

		// Check for secondary index usage. `StoreTable.query` now implements the
		// secondary-index scan arm (leading-prefix EQ point / leading-column range),
		// so we advertise the index with `indexName` + `seekColumns` and mark the
		// covered filters handled — subject to the collation-safety guard in
		// {@link tryIndexAccessPlan}. A cost-only plan (no seek) is kept as a fallback
		// when no index yields a collation-safe seek, preserving the prior "cheaper
		// cost, filters unhandled, residual retained" behavior.
		const indexes = tableInfo.indexes || [];
		let costOnlyFallback: BestAccessPlanResult | null = null;
		for (const index of indexes) {
			if (index.columns.length === 0) continue;
			const plan = this.tryIndexAccessPlan(db, tableKeyCollation, tableInfo, request, index, estimatedRows);
			if (!plan) continue;
			// A fully-handled seek (indexName + seekColumns set) wins immediately.
			if (plan.seekColumnIndexes && plan.seekColumnIndexes.length > 0) return plan;
			// Otherwise remember the first cost-only advertisement as a fallback.
			if (!costOnlyFallback) costOnlyFallback = plan;
		}
		// NOTE: a cost-only plan carries no PK-order advertisement even though the store still
		// iterates in PK key order for it (`StoreTable.query` full-scans). The range gate makes
		// this arm fire more often — an index range on a BINARY text column of a default-K table
		// now lands here — so `... where v > 'x' order by <pk>` picks up a Sort it did not need.
		// If that shows up as slow, merge `buildPkOrderingAdvertisement(...)` into this return.
		if (costOnlyFallback) return costOnlyFallback;

		// Fallback to full scan. The store iterates rows in PK key order
		// (see StoreTable.query / store.iterate over buildFullScanBounds), so
		// the scan is monotonic on the leading PK column. Advertise that so
		// downstream rules (merge-join, asof-scan) can fire on store-backed
		// tables, matching memory-mode behavior.
		const plan = AccessPlanBuilder
			.fullScan(estimatedRows)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('Store full table scan')
			.build();
		return { ...plan, ...this.buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix) };
	}

	/**
	 * Build the access plan for one secondary index against `request`, or null when
	 * the index is not usable for this predicate.
	 *
	 * Usable = a contiguous leading-prefix EQ on the index columns (an index seek /
	 * point), or a LT/LE/GT/GE range on the LEADING index column. These mirror the
	 * two windows {@link StoreTable.analyzeIndexAccess} can build.
	 *
	 * **Collation-safety guard against under-fetch.** The store's index-column
	 * window is encoded under the table key collation K, but `matchesFilters`
	 * compares under the COLUMN's declared collation. Marking a filter handled drops
	 * the residual Filter, so the K-window must be a guaranteed SUPERSET of the
	 * qualifying rows. That holds only when K is coarser-or-equal to the column's
	 * declared collation. To stay provably safe with minimal logic we mark the
	 * covered filters handled — setting `indexName` + `seekColumns` — only when every
	 * seek column is non-text, OR its declared collation equals K, OR (K = NOCASE
	 * while the column is BINARY, i.e. K strictly coarser). Otherwise we return a
	 * cost-only plan (cheaper cost, filters unhandled, residual retained — correct,
	 * just not sped up). K itself always keys: `StoreTable`'s constructor rejects a
	 * table whose key encoding would need a collation it cannot resolve to a normalizer.
	 *
	 * NOTE: the coarser-K relaxation is sound for EQUALITY only. A RANGE window equates
	 * memcmp of K-normalized bytes with C's comparator order, which a merely coarser K does
	 * not give — under K = NOCASE and C = BINARY, 'K' (U+212A) is `> 'z'` yet keys as 'k',
	 * before 'z'. So the range arm demands `C === K` *and* K's `orderPreserving` assertion,
	 * via the shared {@link keyOrderMatchesCollation}; `StoreTable.analyzeIndexAccess`
	 * declines the same windows, so the two decisions cannot disagree. The cost is that a
	 * default-K (NOCASE) table with an index on a plain BINARY text column loses its index
	 * RANGE seek and falls back to the cost-only plan; EQ seeks are unchanged.
	 */
	private tryIndexAccessPlan(
		db: Database,
		tableKeyCollation: string,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		index: TableIndexSchema,
		estimatedRows: number,
	): BestAccessPlanResult | null {
		// Exclude PARTIAL indexes from access planning: neither the engine nor this
		// module checks that the query's WHERE implies the index predicate, so seeking
		// a partial index for a query it doesn't cover would silently drop the rows the
		// index omits (an out-of-scope predicate returns nothing). Treat partial indexes
		// purely as uniqueness enforcers — the query full-scans + residual instead.
		// Mirrors MemoryTableModule.getAvailableIndexes (`if (idx.predicate) continue`).
		if (index.predicate) return null;

		const indexColIndexes = index.columns.map(c => c.index);

		// Contiguous leading-prefix EQ → point/prefix seek.
		const eqCols: number[] = [];
		for (const colIdx of indexColIndexes) {
			if (!request.filters.some(f => f.columnIndex === colIdx && f.op === '=')) break;
			eqCols.push(colIdx);
		}
		const leadingCol = indexColIndexes[0];
		const hasLeadingRange = request.filters.some(
			f => f.columnIndex === leadingCol && RANGE_OPS.includes(f.op),
		);

		let seekCols: number[];
		let isRange: boolean;
		if (eqCols.length > 0) {
			seekCols = eqCols;
			isRange = false;
		} else if (hasLeadingRange) {
			seekCols = [leadingCol];
			isRange = true;
		} else {
			return null; // this index cannot serve this predicate
		}

		const rows = isRange
			? Math.max(1, Math.floor(estimatedRows * 0.3))
			: Math.max(1, Math.floor(estimatedRows * 0.1));
		const costOnly = (why: string): BestAccessPlanResult =>
			(isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3))
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.setExplanation(`Store index scan on ${index.name} (${why})`)
				.build();

		// The INDEX column's effective comparison collation C — the index column's own
		// COLLATE, else the table column's declared collation. C, not the table column's
		// declared collation, is what matchesFilters compares an index-scan row under and
		// what the planner matched to drop the residual, so the K-window must be a superset
		// relative to C.
		const K = tableKeyCollation;
		const effectiveCollation = (colIdx: number): string => {
			const indexCol = index.columns.find(c => c.index === colIdx);
			return (indexCol?.collation ?? tableInfo.columns[colIdx]?.collation ?? 'BINARY').toUpperCase();
		};

		// EQUALITY: safe to mark handled iff K is coarser-or-equal to C. Exempt only columns
		// that can NEVER hold text — their key bytes are type-native and collation-independent.
		// A bare `isTextual` test wrongly exempts an `ANY` column (no marker, but it stores
		// text as text), which would seek under K, drop the residual, and lose rows.
		const eqSafeToHandle = (colIdx: number): boolean => {
			const col = tableInfo.columns[colIdx];
			if (!columnCanHoldText(col)) return true;
			const C = effectiveCollation(colIdx);
			if (C === K) return true;                               // equal
			if (K === 'NOCASE' && C === 'BINARY') return true;      // K strictly coarser
			return false;
		};

		// RANGE: coarser is not enough — byte order must BE comparator order. See the doc above.
		const rangeSafeToHandle = (colIdx: number): boolean =>
			keyOrderMatchesCollation(db, tableInfo.columns[colIdx], K, effectiveCollation(colIdx));

		if (!seekCols.every(isRange ? rangeSafeToHandle : eqSafeToHandle)) {
			return costOnly('cost-only; key collation may under-fetch');
		}

		// Claim positionally — see {@link claimFirstPerRole}.
		const handledFilters = claimFirstPerRole(
			request.filters,
			isRange ? rangeRoles(leadingCol) : equalityRoles(eqCols),
		);

		return (isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3))
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index ${isRange ? 'range scan' : 'seek'} on ${index.name}`)
			.build();
	}

	/**
	 * Compute the PK-ordering advertisement for a scan-style plan. Returns the
	 * `providesOrdering` / `monotonicOn` / `supportsAsofRight` fields for a plan
	 * whose iteration is driven by the primary-key key order (full scan or PK
	 * range scan).
	 *
	 * `providesOrdering` is set only when it actually matches what the caller
	 * needs:
	 *   - When the request carries `requiredOrdering`, claim it only if the
	 *     requested keys form a prefix of the PK with matching directions.
	 *     Claiming PK order against an `ORDER BY <other column>` would cause
	 *     the absorb-Sort rule to drop the Sort and yield wrong-order rows.
	 *   - When no `requiredOrdering` is present, advertise the full PK
	 *     ordering so downstream rules (merge-join, sort elision after a
	 *     filter) can opportunistically use it.
	 *
	 * `monotonicOn` reflects the access path itself and is independent of any
	 * `requiredOrdering`; it always advertises the leading PK column. Strict
	 * monotonicity is claimed iff the PK is single-column — composite PKs can
	 * repeat values on the leading column.
	 *
	 * Returns an empty object when there is no PK (heap-only table) — without a
	 * leading key column there is no natural emit order.
	 *
	 * Every claim here is about the PHYSICAL key-byte order the store iterates in, but the
	 * consumers of `providesOrdering` / `monotonicOn` reason in the columns' COLLATION order.
	 * `orderPreservingPrefix` (from {@link pkOrderPreservingPrefixLength}) is how many leading
	 * PK members those two orders provably agree on: the advertisement is truncated to that
	 * prefix, and voided entirely when even the leading member disagrees — otherwise the
	 * absorb-Sort rule would elide a Sort and hand the caller byte-ordered rows.
	 */
	private buildPkOrderingAdvertisement(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		orderPreservingPrefix: number,
	): Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName' | 'monotonicOn' | 'supportsAsofRight'> {
		const pk = tableInfo.primaryKeyDefinition;
		if (pk.length === 0 || orderPreservingPrefix === 0) return {};

		const leading = pk[0];
		const monotonicOn = {
			columnIndex: leading.index,
			direction: leading.desc ? 'desc' as const : 'asc' as const,
			strict: pk.length === 1,
		};

		const pkOrdering: OrderingSpec[] = pk.slice(0, orderPreservingPrefix).map(col => ({
			columnIndex: col.index,
			desc: !!col.desc,
		}));

		// Pick the providesOrdering to advertise based on requiredOrdering.
		const required = request.requiredOrdering;
		let providesOrdering: readonly OrderingSpec[] | undefined;
		if (required && required.length > 0) {
			// Only claim ordering when the requested keys form a prefix of the
			// PK with matching directions. nullsFirst is intentionally not
			// matched here — if the request specifies an explicit NULLS
			// FIRST/LAST, leave the Sort in place rather than assume the PK
			// scan's natural NULL placement matches.
			if (required.length > pkOrdering.length) return { monotonicOn, supportsAsofRight: true };
			for (let i = 0; i < required.length; i++) {
				if (required[i].columnIndex !== pkOrdering[i].columnIndex) return { monotonicOn, supportsAsofRight: true };
				if (required[i].desc !== pkOrdering[i].desc) return { monotonicOn, supportsAsofRight: true };
				if (required[i].nullsFirst !== undefined) return { monotonicOn, supportsAsofRight: true };
			}
			providesOrdering = required;
		} else {
			providesOrdering = pkOrdering;
		}

		return {
			providesOrdering,
			orderingIndexName: '_primary_',
			monotonicOn,
			supportsAsofRight: true,
		};
	}

	// --- StoreTableModule interface implementation ---

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
	 * Build the catalog entry for a table: its CREATE TABLE DDL, one
	 * `CREATE [UNIQUE] INDEX` statement per persistable secondary index, and one
	 * `alter index … set tags (…)` statement per exposed implicit index carrying
	 * user tags, newline-joined into a single multi-statement bundle keyed by
	 * `{schema}.{table}`.
	 *
	 * Bundling the indexes into the table's own entry means every existing
	 * re-persist path — `saveTableDDL` (each `alterTable` arm, `renameTable`) and
	 * the `table_modified` listener (`persistCatalogIfChanged`) — carries the
	 * indexes along for free, and `removeTableDDL` drops them with the table. The
	 * bundle is consumed on reopen by `rehydrateCatalog` → `importCatalog`, whose
	 * `parser.parseAll` splits it AST-by-AST (never on `\n`) and imports each
	 * statement in document order, so the table registers before its indexes.
	 *
	 * Both the table DDL and the index DDL are emitted without a `db` arg, keeping
	 * the persistence-safe fully-qualified form. Hidden implicit covering indexes
	 * (the auto-built BTree backing a declared UNIQUE constraint) are excluded —
	 * they are a backing detail that round-trips via the table's UNIQUE constraint,
	 * not as a standalone CREATE INDEX. For store tables `buildTableSchemaFromAST`
	 * synthesizes none of those, so in practice every index is included; the guard
	 * is defensive. A `CREATE UNIQUE INDEX`'s derived UNIQUE constraint is already
	 * excluded from the table DDL by the generator, so it round-trips solely via
	 * its own `CREATE UNIQUE INDEX` line — no doubling.
	 *
	 * An *exposed* implicit index (a non-derived UNIQUE constraint tagged
	 * `quereus.expose_implicit_index = true`, never materialized in store mode)
	 * must NOT get a synthetic `CREATE INDEX` line — re-import would materialize a
	 * real `IndexSchema` and change the store-mode shape. Its user tags
	 * (`UniqueConstraintSchema.exposedIndexTags`) instead ride a trailing
	 * `alter index … set tags` line, which `importDDL` re-applies silently after
	 * the CREATE TABLE in the same entry has registered the constraint. Empty tag
	 * records emit no line, and `exposedImplicitIndexes` returns `[]` for
	 * memory-mode tables (name materialized) and orders descriptors by the
	 * `uniqueConstraints` array, so the bundle stays byte-deterministic — which
	 * the compare-write in `persistCatalogIfChanged` relies on.
	 */
	private buildCatalogEntry(tableSchema: TableSchema): string {
		// `tableSchema` is always the engine-facing schema (no `_uc_*`; the store keeps the
		// materialized enforcement copy internal), so hidden implicit indexes reach here
		// only through the `uniqueConstraints`-driven `isHiddenImplicitIndex` /
		// `exposedImplicitIndexes` paths — never as a materialized `CREATE INDEX`.
		const parts: string[] = [generateTableDDL(tableSchema)];
		for (const idx of tableSchema.indexes ?? []) {
			if (isHiddenImplicitIndex(tableSchema, idx.name)) continue;
			parts.push(generateIndexDDL(idx, tableSchema));
		}
		for (const desc of exposedImplicitIndexes(tableSchema)) {
			if (desc.tags && Object.keys(desc.tags).length > 0) {
				parts.push(generateIndexTagsDDL(tableSchema.schemaName, desc.name, desc.tags));
			}
		}
		return parts.join('\n');
	}

	/**
	 * Encode a bundle of persisted schema text (DDL) for the catalog store.
	 *
	 * Guards the FULL text, not just the object's name: a lone surrogate anywhere in it — a
	 * quoted column name, a `default '…'` string literal, a `check` constraint's string
	 * constant — would otherwise fold to U+FFFD under `TextEncoder` and read back as
	 * different schema text than what was created. This does not rely on the catalog-key
	 * builders' identifier guard having already caught it; it catches it independently.
	 */
	private encodeCatalogDDL(ddl: string): Uint8Array {
		assertNoUnpairedSurrogate(ddl, 'persisted schema text');
		return new TextEncoder().encode(ddl);
	}

	/**
	 * Save table DDL (bundled with its secondary index DDL) to the catalog store.
	 */
	async saveTableDDL(tableSchema: TableSchema): Promise<void> {
		const ddl = this.buildCatalogEntry(tableSchema);
		const catalogKey = buildCatalogKey(tableSchema.schemaName, tableSchema.name);
		const encodedDDL = this.encodeCatalogDDL(ddl);

		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(catalogKey, encodedDDL);
	}

	/**
	 * Load all DDL **values** from the catalog store (keys discarded).
	 * Used to restore persisted tables on startup and by tests asserting persisted DDL.
	 * Note: this returns table, view, AND materialized-view entries intermixed —
	 * {@link rehydrateCatalog} uses {@link loadCatalogEntries} (keys retained) to
	 * classify them. Meta entries (e.g. the clean-shutdown marker) are not DDL
	 * and are filtered out.
	 */
	async loadAllDDL(): Promise<string[]> {
		const catalogStore = await this.provider.getCatalogStore();
		const bounds = buildCatalogScanBounds();
		const decoder = new TextDecoder();
		const ddlStatements: string[] = [];

		for await (const entry of catalogStore.iterate(bounds)) {
			if (classifyCatalogKey(entry.key) === 'meta') continue;
			const ddl = decoder.decode(entry.value);
			ddlStatements.push(ddl);
		}

		return ddlStatements;
	}

	/**
	 * Load every catalog entry as `{ key, ddl }`. Unlike {@link loadAllDDL} (values
	 * only) this retains the key so {@link rehydrateCatalog} can classify each entry
	 * (table / view / materialized view) by its reserved key prefix.
	 */
	private async loadCatalogEntries(): Promise<Array<{ key: Uint8Array; ddl: string }>> {
		const catalogStore = await this.provider.getCatalogStore();
		const decoder = new TextDecoder();
		const entries: Array<{ key: Uint8Array; ddl: string }> = [];
		for await (const entry of catalogStore.iterate(buildCatalogScanBounds())) {
			entries.push({ key: entry.key, ddl: decoder.decode(entry.value) });
		}
		return entries;
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
	 * `\x00meta\x00clean_shutdown` catalog entry (written by {@link closeAll} after
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
		// provider never writes the set (see {@link atomicProvider}), so skip the read.
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
	 * Consume the clean-shutdown marker, deleting it in the same breath (single-use).
	 *
	 * Returns `{ trusted, staleAtClose }`:
	 * - `trusted` — the marker was present AND its payload parsed as a string array.
	 *   Absence (a fresh store, a crash, or a prior rehydrate without an intervening
	 *   {@link closeAll}) yields `false`, so every adopt this session falls back to
	 *   refill.
	 * - `staleAtClose` — the qualified lowercased `schema.mv` names that were
	 *   stale-at-close (written by {@link closeAll}); those MVs refill even under trust.
	 *
	 * Conservative parse: any unparseable / wrong-shape payload (including a legacy
	 * bare `'1'`, which parses to a number, not an array) degrades to
	 * `{ trusted: false, staleAtClose: ∅ }` — refill everything — rather than
	 * trust-everything. The marker is deleted regardless of parse outcome.
	 */
	private async consumeCleanShutdownMarker(): Promise<{ trusted: boolean; staleAtClose: ReadonlySet<string> }> {
		const catalogStore = await this.provider.getCatalogStore();
		const markerKey = buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME);
		const raw = await catalogStore.get(markerKey);
		if (raw === undefined) return { trusted: false, staleAtClose: new Set() };
		// Single-use AND durable-before-session-writes: forcing this delete to stable
		// storage before any of the session's (independently flushed, different-store)
		// data writes can land closes the power-loss window where a persisted data write
		// outlives a lost marker-delete and resurrects a consumed marker. (Backends
		// without a durability knob no-op the hint — losing it is conservative there, and
		// memory has no crash.) See docs/mv-backing-host.md § Cross-module atomicity.
		await catalogStore.delete(markerKey, { sync: true }); // single-use, regardless of parse outcome

		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
				console.warn('[StoreModule] clean-shutdown marker payload is not a string array; refilling all backings.');
				return { trusted: false, staleAtClose: new Set() };
			}
			return { trusted: true, staleAtClose: new Set(parsed) };
		} catch (e) {
			console.warn(
				`[StoreModule] clean-shutdown marker payload did not parse as JSON; refilling all backings: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return { trusted: false, staleAtClose: new Set() };
		}
	}

	/**
	 * Remove DDL from the catalog store when a table is dropped.
	 */
	async removeTableDDL(schemaName: string, tableName: string): Promise<void> {
		const catalogKey = buildCatalogKey(schemaName, tableName);
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(catalogKey);
	}

	/**
	 * Persist a plain view's catalog entry (DDL via `generateViewDDL`), keyed by its
	 * reserved view prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveViewDDL(view: ViewSchema): Promise<void> {
		await this.persistObjectCatalogEntryIfChanged(
			buildViewCatalogKey(view.schemaName, view.name),
			generateViewDDL(view),
		);
	}

	/** Remove a plain view's catalog entry (on DROP VIEW). */
	async removeViewDDL(schemaName: string, viewName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildViewCatalogKey(schemaName, viewName));
	}

	/**
	 * Persist a materialized view's catalog entry (DDL via `generateMaintainedTableDDL`
	 * over the maintained table — the unified record), keyed by its reserved MV
	 * prefix. Compare-write (skip identical) — see
	 * {@link persistObjectCatalogEntryIfChanged}.
	 */
	async saveMaterializedViewDDL(mv: MaintainedTableSchema): Promise<void> {
		await this.persistObjectCatalogEntryIfChanged(
			buildMaterializedViewCatalogKey(mv.schemaName, mv.name),
			generateMaintainedTableDDL(mv),
		);
	}

	/** Remove a materialized view's catalog entry (on DROP MATERIALIZED VIEW). */
	async removeMaterializedViewDDL(schemaName: string, mvName: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.delete(buildMaterializedViewCatalogKey(schemaName, mvName));
	}

	/**
	 * Compare-write a view/MV catalog entry: write only when the entry is absent or its
	 * DDL differs from `newDDL` (skip identical). Unlike the table path's
	 * {@link persistCatalogIfChanged} there is **no** absent→skip self-filter — a view/MV
	 * belongs to this db's catalog unconditionally (one module instance serves one
	 * Database). Skipping identical writes makes any event whose regenerated DDL is
	 * unchanged (e.g. a `materialized_view_refreshed`) a no-op, so a second consecutive
	 * reopen yields identical catalog bytes. (Rehydration itself fires no view/MV events
	 * at all — `importCatalog` is silent.)
	 */
	private async persistObjectCatalogEntryIfChanged(key: Uint8Array, newDDL: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing !== undefined && new TextDecoder().decode(existing) === newDDL) return;
		await catalogStore.put(key, this.encodeCatalogDDL(newDDL));
	}

	/**
	 * Parse module configuration from vtab args.
	 */
	private parseConfig(args: Record<string, SqlValue> | undefined): StoreModuleConfig {
		return {
			collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
			// Index-build batch budget; malformed / non-positive clamps to the default
			// so a bad arg can never disable the bounded-memory flush (see resolveMaxBatchBytes).
			maxBatchBytes: resolveMaxBatchBytes(args?.max_batch_bytes),
		};
	}

	// --- Engine schema-change subscription (catalog-only tag persistence) ---

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
	private ensureSchemaSubscription(db: Database): void {
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
	private computeStaleMvSet(): string[] {
		return this.subscribedDb
			? this.subscribedDb.schemaManager.getAllMaintainedTables()
				.filter(mv => mv.derivation.stale)
				.map(mv => `${mv.schemaName}.${mv.name}`.toLowerCase())
			: [];
	}

	/**
	 * Recompute the durable stale-MV set and, only when it differs from the last value
	 * enqueued this subscription ({@link lastPersistedStaleMvs}), enqueue a `sync: true`
	 * point-write of it onto {@link persistQueue}. The compare-skip keeps an unrelated
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
		// trust basis (see {@link atomicProvider}); a non-atomic session's trust basis is the
		// clean-shutdown marker, so writing the set there is both useless and a soundness
		// hazard (it could be trusted by a later atomic reopen). Skip before recomputing.
		if (!this.atomicProvider) return;
		const json = JSON.stringify(this.computeStaleMvSet());
		if (json === this.lastPersistedStaleMvs) return;
		this.lastPersistedStaleMvs = json;
		this.enqueuePersist(() => this.writeDurableStaleMvSet(json));
	}

	/**
	 * Write the durable stale-MV set (`\x00meta\x00stale_mvs`) with `sync: true`. Unlike
	 * the clean-shutdown marker this entry is persistent current-truth — overwritten as
	 * staleness changes, never deleted — so a crash leaves the last synced value intact.
	 * The `sync` mirrors the marker-consume delete's durability discipline (and carries
	 * the same documented backend caveat: a backend without a durability knob no-ops it).
	 */
	private async writeDurableStaleMvSet(json: string): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		await catalogStore.put(
			buildMetaCatalogKey(STALE_MVS_META_NAME),
			new TextEncoder().encode(json),
			{ sync: true },
		);
	}

	/**
	 * Read + conservative-parse the durable stale-MV set, mirroring
	 * {@link consumeCleanShutdownMarker}'s parse discipline (but READ-only — never
	 * deleted). Returns:
	 * - `{ present: false }` — no entry on disk (a pre-atomic store, or an upgrade where
	 *   the capability was gained but no stale-set has been written yet) → the caller
	 *   falls back to the clean-shutdown marker path.
	 * - `{ present: true, stale }` — the parsed set of qualified `schema.mv` names.
	 * - `{ present: true, stale: null }` — a present but unparseable / wrong-shape payload
	 *   → the caller refills everything (the always-safe posture).
	 */
	private async readDurableStaleMvSet(): Promise<
		{ present: false } | { present: true; stale: ReadonlySet<string> | null }
	> {
		const catalogStore = await this.provider.getCatalogStore();
		const raw = await catalogStore.get(buildMetaCatalogKey(STALE_MVS_META_NAME));
		if (raw === undefined) return { present: false };
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
				console.warn('[StoreModule] durable stale-MV set payload is not a string array; refilling all backings.');
				return { present: true, stale: null };
			}
			return { present: true, stale: new Set(parsed) };
		} catch (e) {
			console.warn(
				`[StoreModule] durable stale-MV set payload did not parse as JSON; refilling all backings: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return { present: true, stale: null };
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
	 * Append a catalog-persistence task to the serialized `persistQueue`, so successive
	 * mutations (e.g. SET TAGS (a=1) then SET TAGS ()) apply in order and are drained by
	 * `closeAll`/`whenCatalogPersisted` before the provider closes. Errors are
	 * swallowed+logged to mirror `notifyChange`'s own try/catch contract — a listener
	 * rejection must never escape.
	 */
	private enqueuePersist(work: () => Promise<void>): void {
		this.persistQueue = this.persistQueue
			.then(work)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				console.warn(`[StoreModule] Failed to persist catalog DDL after schema change: ${message}`);
			});
	}

	/**
	 * Read-compare-write the catalog DDL for a table that just fired `table_modified`.
	 *
	 * - **Absent** catalog entry → the table is not store-backed in this catalog (a
	 *   memory table in the same `db`, or a store table never persisted) → skip. This
	 *   self-filters foreign-module tables without relying on `vtabModule` identity
	 *   (which points at the isolation wrapper when wrapped).
	 * - **Present** but identical DDL → skip (no redundant write). This is what makes a
	 *   structural ALTER — whose own `alterTable` already wrote the final DDL, then fires
	 *   `table_modified` with that same final schema — a no-op here (no double-write).
	 * - **Present** and different DDL → re-persist (the tag swap; or a beneficial
	 *   propagated rewrite of a dependent store table).
	 */
	private async persistCatalogIfChanged(key: Uint8Array, newObject: TableSchema): Promise<void> {
		const catalogStore = await this.provider.getCatalogStore();
		const existing = await catalogStore.get(key);
		if (existing === undefined) return; // not store-backed in this catalog — skip

		// Regenerate the full bundle (table DDL + index DDL + exposed-implicit-index
		// tag DDL): a SET TAGS on an index fires `table_modified` on the OWNING table
		// with the updated index in `tableSchema.indexes` — or, for an exposed
		// implicit index, with the updated `exposedIndexTags` on the originating
		// UNIQUE constraint — so the changed DDL re-persists here with no
		// index-specific plumbing. An identical bundle is what makes a structural
		// ALTER (and the createIndex follow-up event) a no-op — no double-write.
		const newDDL = this.buildCatalogEntry(newObject);
		const existingDDL = new TextDecoder().decode(existing);
		if (existingDDL === newDDL) return; // identical — no redundant write

		await catalogStore.put(key, this.encodeCatalogDDL(newDDL));
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
		// {@link atomicProvider}). Same array as the marker payload, under a separate
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

	/**
	 * Get a table by schema and name.
	 */
	getTable(schemaName: string, tableName: string): StoreTable | undefined {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		return this.tables.get(tableKey);
	}
}

/** Adapts a raw KV entry stream into the row stream the uniqueness validators consume. */
async function* rowsFromEntries(entries: AsyncIterable<KVEntry>): AsyncIterable<Row> {
	for await (const entry of entries) {
		yield deserializeRow(entry.value);
	}
}

/**
 * Read-side wrap for a value-rewriting ALTER COLUMN's pre-mutation UNIQUE probe: each row's
 * value at `colIndex` run through `convert` (the sub-branch's deferred `valueConvert`, which
 * owns its own NULL handling), so the probe judges the POST-alter values while the store
 * still holds the old ones. Mutates nothing — the memory module's `convertRowAtIndex`
 * counterpart. A conversion failure propagates: the setDataType pre-pass already proved
 * every visible value convertible, so a throw here is unreachable, and surfacing it beats
 * probing a stale value that could mask a collision.
 */
async function* convertRowsAtIndex(
	rows: AsyncIterable<Row>,
	colIndex: number,
	convert: (v: SqlValue) => SqlValue,
): AsyncIterable<Row> {
	for await (const row of rows) {
		const newVal = convert(row[colIndex]);
		yield newVal === row[colIndex] ? row : row.map((v, i) => i === colIndex ? newVal : v) as Row;
	}
}

/**
 * Per-column key normalizers for a UNIQUE INDEX dedupe signature, drawing each column's
 * collation from the index column (if it carries one) else the underlying table column —
 * so the signature honors a per-column collation registered on this connection, matching
 * write-time enforcement.
 *
 * A column whose declared type can never hold text takes the identity normalizer regardless
 * of its collation (the signature serializer normalizes only string values), so a comparator-only
 * collation named on an integer column is not rejected here when the engine's own hash sites
 * would accept it.
 */
function indexDedupeNormalizers(
	tableSchema: TableSchema,
	indexSchema: TableIndexSchema,
	keyNormalizers: KeyNormalizerResolver,
): KeyNormalizer[] {
	return indexSchema.columns.map(col => {
		const column = tableSchema.columns[col.index];
		return keyNormalizers(logicalTypeCanHoldText(column.logicalType)
			? (col.collation ?? column.collation)
			: undefined);
	});
}

/**
 * Collation- and identity-aware dedupe signature of `row` over `colIndices`: each value
 * runs through its column's key transform (`storeSemanticKeyTransform` — TIMESPAN's
 * total-seconds `groupKey`, so 'PT1H' and 'PT60M' sign identically; JSON's structural
 * bytes, so reorder-equal objects sign identically) before `serializeKey` applies the
 * per-column normalizer. Returns null when any covered value
 * is NULL (SQL UNIQUE allows multiple NULLs). The build/validate-time twin of the
 * write-time typed compare in `StoreTable.uniqueColumnComparators`.
 */
function dedupeRowSignature(
	row: Row,
	colIndices: readonly number[],
	normalizers: readonly KeyNormalizer[],
	transforms: ReadonlyArray<((v: SqlValue) => SqlValue) | undefined>,
): string | null {
	const values = colIndices.map((c, i) => {
		const v = row[c];
		const transform = transforms[i];
		return transform && v !== null ? transform(v) : v;
	});
	return serializeKey(values, normalizers);
}

/**
 * Throws CONSTRAINT on the first pair of `rows` that share a signature over `columnIndices`.
 *
 * SQL NULL semantics: {@link dedupeRowSignature} returns null when any constrained column is
 * NULL, and such rows never collide. A partial `predicate` restricts the judged set to rows
 * it accepts unambiguously. Shared by {@link StoreModule.validateUniqueOverExistingRows}
 * (constraint columns) and {@link StoreModule.validateUniqueIndexOverRows} (index columns).
 */
async function assertNoDuplicateRows(
	rows: AsyncIterable<Row>,
	tableSchema: TableSchema,
	columnIndices: readonly number[],
	normalizers: readonly KeyNormalizer[],
	predicate: CompiledPredicate | undefined,
): Promise<void> {
	const transforms = columnIndices.map(i => storeSemanticKeyTransform(tableSchema.columns[i]?.logicalType));
	const seen = new Set<string>();
	for await (const row of rows) {
		if (predicate && predicate.evaluate(row) !== true) continue;

		const keySig = dedupeRowSignature(row, columnIndices, normalizers, transforms);
		if (keySig === null) continue;

		if (seen.has(keySig)) {
			const colNames = columnIndices.map(i => tableSchema.columns[i]?.name ?? String(i)).join(', ');
			throw new QuereusError(
				`UNIQUE constraint failed: ${tableSchema.name} (${colNames})`,
				StatusCode.CONSTRAINT,
			);
		}
		seen.add(keySig);
	}
}

/**
 * Reconcile each text PRIMARY KEY column's declared collation at CREATE time.
 *
 * The store now encodes PRIMARY KEY uniqueness/ordering PHYSICALLY with a
 * PER-COLUMN key collation (`StoreTable.pkKeyCollations`, drawn from each PK
 * column's declared `collation`), so ANY declared PK collation is honored
 * natively — an explicit `collate binary` text PK is keyed under BINARY, a
 * `collate nocase` under NOCASE, etc. The only thing this reconcile still does is
 * supply the store's table-level DEFAULT (`keyCollation` = K = `config.collation`,
 * default NOCASE) to a text PK column that declares NO explicit collation, so an
 * implicit-default text PK keeps the store's historical NOCASE-keyed behavior
 * (rather than the engine's BINARY column default). An EXPLICIT collation — even
 * one diverging from K — is left exactly as declared and re-keyed natively.
 *
 * Collation governs key bytes only for text, so only PK members whose logical type
 * is textual are touched (an `integer primary key` keeps its BINARY; temporal
 * text-physical types carry no collation). Non-PK columns are never touched.
 *
 * This is the CREATE path only — the load path (`connect` / rehydrate) does not
 * reconcile; the persisted DDL is the source of truth on reopen, and the column's
 * (BINARY-elided) `COLLATE` clause round-trips the per-column key collation.
 *
 * Returns the schema unchanged when no implicit text PK column needs the default
 * applied; otherwise a new schema with a rebuilt `columns` array + `columnIndexMap`.
 */
function reconcilePkCollations(
	schema: TableSchema,
	keyCollation: string,
): TableSchema {
	const pkIndices = new Set(schema.primaryKeyDefinition.map(def => def.index));
	if (pkIndices.size === 0) return schema;

	let changed = false;
	const newColumns = schema.columns.map((col, idx) => {
		if (!pkIndices.has(idx)) return col;
		// Collation governs key bytes only for text; non-text PK columns (integer,
		// real, blob, …) are encoded type-natively and keep their declared collation.
		if (!col.logicalType.isTextual) return col;
		// An EXPLICIT collation is honored as-declared — the per-column key encoding
		// keys the column under it (Option B physical re-key parity with memory).
		if (col.collationExplicit) return col;
		const declared = (col.collation || 'BINARY').toUpperCase();
		if (declared === keyCollation) return col; // implicit default already == K

		// Implicit default diverges from K (e.g. the engine's BINARY column default
		// under the store's NOCASE K): apply the store's table-level default so an
		// undecorated text PK keeps the store's historical NOCASE-keyed semantics.
		changed = true;
		return { ...col, collation: keyCollation };
	});

	if (!changed) return schema;
	const columns = Object.freeze(newColumns);
	return { ...schema, columns, columnIndexMap: buildColumnIndexMap(columns) };
}

/**
 * Build a column remap array: newColumnIndex -> oldColumnIndex | -1.
 * Maps each column in the new layout to its position in the old layout.
 * -1 means the column is new (fill with default).
 */
function buildColumnRemap(oldColumnNames: string[], newColumnNames: string[]): number[] {
	const oldIndexByName = new Map<string, number>();
	for (let i = 0; i < oldColumnNames.length; i++) {
		oldIndexByName.set(oldColumnNames[i].toLowerCase(), i);
	}
	return newColumnNames.map(name => {
		const oldIdx = oldIndexByName.get(name.toLowerCase());
		return oldIdx !== undefined ? oldIdx : -1;
	});
}

/** Whether `fk` points back at the table that owns it. */
function isSelfForeignKey(
	fk: ForeignKeyConstraintSchema,
	schemaLower: string,
	tableLower: string,
): boolean {
	return (fk.referencedSchema ?? schemaLower).toLowerCase() === schemaLower
		&& fk.referencedTable.toLowerCase() === tableLower;
}

/**
 * Retarget a self-referencing foreign key's `referencedTable` across a rename of
 * the owning table. A pure copy — unlike the CHECK / partial-index rewrites this
 * touches a name field, not a shared AST, so the caller needs no rollback.
 * Returns the input array when nothing self-references.
 */
function retargetSelfForeignKeys(
	fks: ReadonlyArray<ForeignKeyConstraintSchema> | undefined,
	schemaName: string,
	oldName: string,
	newName: string,
): ReadonlyArray<ForeignKeyConstraintSchema> | undefined {
	if (!fks) return fks;
	const schemaLower = schemaName.toLowerCase();
	const oldLower = oldName.toLowerCase();
	let changed = false;
	const next = fks.map(fk => {
		if (!isSelfForeignKey(fk, schemaLower, oldLower)) return fk;
		changed = true;
		return { ...fk, referencedTable: newName };
	});
	return changed ? Object.freeze(next) : fks;
}

/**
 * Rename a column inside a self-referencing foreign key's `referencedColumnNames`
 * (the names the FK resolves to parent-column indices at enforcement time). Pure
 * copy, as in {@link retargetSelfForeignKeys}. The child-side `columns` are
 * indices, unaffected by a rename.
 */
function renameColumnInSelfForeignKeys(
	fks: ReadonlyArray<ForeignKeyConstraintSchema> | undefined,
	schemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
): ReadonlyArray<ForeignKeyConstraintSchema> | undefined {
	if (!fks) return fks;
	const schemaLower = schemaName.toLowerCase();
	const tableLower = tableName.toLowerCase();
	const oldColLower = oldCol.toLowerCase();
	let changed = false;
	const next = fks.map(fk => {
		if (!isSelfForeignKey(fk, schemaLower, tableLower)) return fk;
		if (!fk.referencedColumnNames?.some(n => n.toLowerCase() === oldColLower)) return fk;
		changed = true;
		return {
			...fk,
			referencedColumnNames: Object.freeze(
				fk.referencedColumnNames.map(n => n.toLowerCase() === oldColLower ? newCol : n)),
		};
	});
	return changed ? Object.freeze(next) : fks;
}
