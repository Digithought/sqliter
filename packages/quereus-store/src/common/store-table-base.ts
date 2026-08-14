/**
 * State and storage plumbing shared by every layer of the KVStore-backed virtual
 * table: schema/key-encoding state, store + coordinator handles, statistics,
 * transaction lifecycle, and the effective-read primitives (committed store
 * merged with the coordinator's pending ops) the read and write paths build on.
 *
 * Base of the store-table layer chain:
 *   StoreTableBase -> StoreTableScan -> StoreTableConstraints -> StoreTable
 */

import {
	VirtualTable,
	QuereusError,
	StatusCode,
	hasSemanticOrdering,
	coerceRowToSchema,
	type Database,
	type DatabaseInternal,
	type CollationResolver,
	type TableSchema,
	type TableIndexSchema,
	type Row,
	type SqlValue,
	type ColumnStatistics,
	type TableStatistics,
	type VirtualTableConnection,
	type VirtualTableModule,
} from '@quereus/quereus';

import type { IterateOptions, KVEntry, KVStore } from './kv-store.js';
import { bytesToHex, compareBytes } from './bytes.js';
import type { DataChangeEvent, StoreEventEmitter } from './events.js';
import type { PendingStoreOps, TransactionCoordinator } from './transaction.js';
import { StoreConnection } from './store-connection.js';
import {
	buildDataKey,
	buildFullScanBounds,
	buildPkPrefixBounds,
	buildStatsKey,
} from './key-builder.js';
import {
	deserializeRow,
	serializeStats,
	deserializeStats,
	toPersistedColumnStats,
	type TableStats,
} from './serialization.js';
import { type EncodeOptions, type KeyValueTransform } from './encoding.js';
import { resolveIndexKeyCollations, resolvePkKeyCollations, resolvePkKeyTransforms, resolvePkSemanticEquality, storeSemanticKeyTransform } from './pk-key-resolution.js';
import { withImplicitUniqueIndexes } from './implicit-unique-index.js';

/** Number of mutations before persisting statistics. */
const STATS_FLUSH_INTERVAL = 100;

/** True when `key` falls within the (gte/gt/lte/lt) window of `bounds`. */
function keyWithinBounds(key: Uint8Array, bounds: IterateOptions): boolean {
	if (bounds.gte && compareBytes(key, bounds.gte) < 0) return false;
	if (bounds.gt && compareBytes(key, bounds.gt) <= 0) return false;
	if (bounds.lte && compareBytes(key, bounds.lte) > 0) return false;
	if (bounds.lt && compareBytes(key, bounds.lt) >= 0) return false;
	return true;
}

/**
 * Configuration for a store table.
 */
export interface StoreTableConfig {
	/** Collation for text keys. Default: 'NOCASE'. */
	collation?: 'BINARY' | 'NOCASE';
	/**
	 * Serialized-byte budget for a single index-build write batch (see
	 * `buildIndexEntries` (store-module-index-build.ts)). Parsed from the `max_batch_bytes` module
	 * arg; undefined falls back to the module default.
	 */
	maxBatchBytes?: number;
	/** Additional platform-specific options. */
	[key: string]: unknown;
}

/**
 * Interface for the store module that manages this table.
 * Provides access to stores and coordinators.
 */
export interface StoreTableModule {
	/** Get the data store for a table. */
	getStore(schemaName: string, tableName: string, config: StoreTableConfig): Promise<KVStore>;
	/** Get an index store for a table. */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
	/** Get the stats store for a table. */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
	/**
	 * Get the module's single shared transaction coordinator (one per storage
	 * module, shared by every table — the unit of cross-table atomicity).
	 * Synchronous: ops are addressed by explicit store handle, so obtaining a
	 * coordinator never requires opening storage.
	 */
	getCoordinator(): TransactionCoordinator;
	/** Save table DDL to persistent storage (unconditional put). */
	saveTableDDL(tableSchema: TableSchema): Promise<void>;
	/** Write table DDL only when the persisted entry is absent or differs. */
	persistTableCatalogEntryIfChanged(tableSchema: TableSchema): Promise<void>;
}

/**
 * Storage-facing base of the generic KVStore-backed virtual table.
 *
 * Holds the table's schema-derived key encoding state, its data/index/stats
 * store handles and transaction coordinator, its statistics accounting, and the
 * effective-row reads every higher layer issues. Platform-specific behavior is
 * delegated to the {@link StoreTableModule}.
 *
 * NOTE: `export` here is required, not intentional API surface — `StoreTable extends`
 * this class transitively, so TypeScript cannot emit its declaration unless every base
 * in the chain is nameable (TS4020). The package index deliberately does not re-export
 * this class or the two layers above it; if an API-surface extractor is ever added, it
 * should treat them as internal rather than prompt a re-export.
 */
export abstract class StoreTableBase extends VirtualTable {
	protected storeModule: StoreTableModule;
	protected config: StoreTableConfig;
	protected store: KVStore | null = null;
	protected storeInitPromise: Promise<KVStore> | null = null;
	protected indexStores: Map<string, KVStore> = new Map();
	protected statsStore: KVStore | null = null;
	protected coordinator: TransactionCoordinator | null = null;
	/**
	 * Disposer returned by the coordinator's `registerCallbacks`, captured on the
	 * first {@link attachCoordinator}. Run by {@link dispose} at hard eviction to
	 * deregister this instance's {stats apply/discard} pair from the module-wide
	 * coordinator; null until attached, and nulled again after dispose.
	 */
	private coordinatorDisposer: (() => void) | null = null;
	protected connection: StoreConnection | null = null;
	protected eventEmitter?: StoreEventEmitter;
	protected encodeOptions: EncodeOptions;
	protected pkDirections: boolean[];
	/**
	 * Per-PK-column KEY collation (see {@link resolvePkKeyCollations}). Drives the
	 * physical encoding of every data key and the PK suffix of every secondary-index
	 * key, so a text PK column declared BINARY/NOCASE/RTRIM is keyed under its own
	 * collation rather than one fixed table-level collation. Recomputed on every
	 * {@link updateSchema} (an ALTER COLUMN SET COLLATE on a PK member changes it).
	 */
	protected pkKeyCollations: (string | undefined)[];
	/**
	 * Per-PK-column key-identity value transform (see {@link resolvePkKeyTransforms}).
	 * Threaded alongside {@link pkKeyCollations} into every data-key / PK-suffix /
	 * PK-prefix-bounds encode, so a semantic-ordering PK member (TIMESPAN) keys
	 * semantically-equal spellings to one physical key. Recomputed on every
	 * {@link updateSchema}.
	 */
	protected pkKeyTransforms: (KeyValueTransform | undefined)[];
	/**
	 * Per-PK-column typed EQUALITY comparator for the semantic-ordering members only —
	 * `undefined` for every other member, which `StoreTableConstraints.keysEqual` still compares with
	 * strict `!==` as before. Keeps self-PK exclusion and PK-identity questions in
	 * agreement with the physical key identity above ('PT1H' row IS the 'PT60M' row).
	 */
	protected pkSemanticEquality: (((a: SqlValue, b: SqlValue) => number) | undefined)[];
	/**
	 * `db.getCollationResolver()`, bound once at construction. Every collation-aware
	 * VALUE comparison this table makes — pushed-constraint re-check, UNIQUE conflict
	 * detection — resolves names through it, so a collation registered with
	 * `db.registerCollation` on *this* connection is honored rather than silently
	 * degraded to BINARY by the process-global built-in registry.
	 *
	 * Only the resolver closure is cached: it reads the live registry, so a collation
	 * registered after connect is still visible. Resolved *functions* are hoisted no
	 * further than the comparator or constraint check that resolved them.
	 *
	 * Its key-bytes counterpart, `db.getKeyNormalizerResolver()`, is bound into
	 * {@link encodeOptions} so the names in {@link pkKeyCollations} resolve to the same
	 * per-connection registry.
	 */
	protected readonly collationResolver: CollationResolver;
	protected ddlSaved = false;

	// Statistics tracking
	protected cachedStats: TableStats | null = null;
	protected pendingStatsDelta = 0;
	protected mutationCount = 0;
	protected statsFlushPending = false;

	/**
	 * {@link tableSchema} with a hidden `_uc_*` secondary index materialized per
	 * non-derived UNIQUE constraint that no explicit index already covers (see
	 * {@link withImplicitUniqueIndexes}) — the schema that drives UNIQUE ENFORCEMENT
	 * (`StoreTableConstraints.findIndexForUniqueConstraint`) and physical index MAINTENANCE
	 * (`StoreTableConstraints.updateSecondaryIndexes`).
	 *
	 * Deliberately SEPARATE from the engine-facing {@link tableSchema}: the engine
	 * reads `tableInstance.tableSchema` at CREATE (`SchemaManager.finalizeCreatedTableSchema`)
	 * and the read-query planner reads the registered schema, and NEITHER may see
	 * `_uc_*` (mirrors the memory backend keeping its materialized schema
	 * manager-local; a plain UNIQUE gets no read-side plan from `_uc_*`, only
	 * enforcement). Recomputed alongside `tableSchema` in the constructor and
	 * {@link updateSchema}.
	 */
	protected materializedSchema: TableSchema;

	constructor(
		db: Database,
		storeModule: StoreTableModule,
		tableSchema: TableSchema,
		config: StoreTableConfig,
		eventEmitter?: StoreEventEmitter,
		isConnected = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, storeModule as unknown as VirtualTableModule<any, any>, tableSchema.schemaName, tableSchema.name);
		this.storeModule = storeModule;
		// The engine-facing schema stays NON-materialized (the engine registers it and the
		// read-query planner reads it — neither may see `_uc_*`); the hidden `_uc_*`
		// per-UNIQUE index that lets plain UNIQUE enforce via a point-seek lives only in
		// {@link materializedSchema}.
		this.tableSchema = tableSchema;
		this.materializedSchema = withImplicitUniqueIndexes(tableSchema);
		this.config = config;
		this.eventEmitter = eventEmitter;
		this.collationResolver = db.getCollationResolver();
		this.encodeOptions = {
			collation: config.collation || 'NOCASE',
			normalizers: db.getKeyNormalizerResolver(),
		};
		this.pkDirections = tableSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = resolvePkKeyCollations(
			tableSchema.primaryKeyDefinition,
			tableSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.pkKeyTransforms = resolvePkKeyTransforms(tableSchema.primaryKeyDefinition, tableSchema.columns);
		this.pkSemanticEquality = resolvePkSemanticEquality(tableSchema.primaryKeyDefinition, tableSchema.columns);
		// Validate the MATERIALIZED schema, so a `_uc_*` whose key collations cannot key
		// is rejected up front just like an explicit index would be.
		this.validateKeyCollations(this.materializedSchema, this.pkKeyCollations);
		this.validateSemanticKeyTransforms(this.materializedSchema);
		this.ddlSaved = isConnected;
	}

	/**
	 * Reject, at DDL time, any collation this table's key encoding would need but cannot
	 * use — before a single row is written under bytes the connection cannot reproduce.
	 *
	 * A collation keys a persisted structure only if it carries a KEY NORMALIZER (the
	 * `(s) => string` whose output equality partitions strings exactly as its comparator
	 * does). `db.registerCollation(name, cmp)` with no `{ normalizer }` gives a collation
	 * that can order rows but not key them; an unregistered name gives nothing at all.
	 * Both raise here rather than at the first insert.
	 *
	 * Checked over exactly the collations the key encoding actually uses:
	 *   - every defined `pkKeyCollations` entry (text-capable PK columns);
	 *   - every defined index key collation of every index in the MATERIALIZED schema
	 *     (`resolveIndexKeyCollations` — the index column's COLLATE, else the table
	 *     column's declared collation, else BINARY; hidden `_uc_*` indexes included).
	 *
	 * Two deliberate consequences of validating the actual index key collations rather
	 * than blanket-requiring the table key collation K whenever any index column is
	 * text-capable (the pre-per-column-index-collation behavior):
	 *   - an index column declaring a comparator-only collation is rejected here instead
	 *     of silently keying under K;
	 *   - a table whose K has no normalizer but whose key encoding never uses K (all
	 *     index columns BINARY/type-native, PK needing no K) is no longer unopenable.
	 *
	 * Blast radius: this also fires on catalog rehydration. Reopening a persisted database
	 * from a connection that has not re-registered its custom collation now throws at
	 * CREATE-TABLE-from-catalog rather than silently reading rows under a key layout it
	 * cannot reproduce. See `docs/plugins.md`.
	 *
	 * Takes `pkKeyCollations` rather than reading the field so `updateSchema` can validate
	 * the incoming schema BEFORE it overwrites its own state with it.
	 */
	private validateKeyCollations(schema: TableSchema, pkKeyCollations: ReadonlyArray<string | undefined>): void {
		const names = new Set<string>();
		for (const collation of pkKeyCollations) {
			if (collation !== undefined) names.add(collation);
		}
		for (const index of schema.indexes ?? []) {
			for (const collation of resolveIndexKeyCollations(index, schema.columns)) {
				if (collation !== undefined) names.add(collation);
			}
		}
		this.assertCollationsCanKey(names);
	}

	/**
	 * Throw-only half of {@link validateKeyCollations}: raise unless every name in
	 * `names` resolves to a registered key normalizer.
	 */
	private assertCollationsCanKey(names: Iterable<string>): void {
		const dbInternal = this.db as DatabaseInternal;
		for (const name of names) {
			if (dbInternal._getCollationNormalizer(name)) continue;
			// Unregistered names raise `no such collation sequence: X` from the resolver;
			// reaching past it means the collation exists but is comparator-only.
			this.collationResolver(name);
			throw new QuereusError(
				`collation ${name} cannot key a persisted structure: no key normalizer registered `
					+ `— pass { normalizer } to registerCollation`,
				StatusCode.ERROR,
			);
		}
	}

	/**
	 * Throw-only pre-check for `StoreModuleIndex.createIndex`: reject a NEW index whose
	 * key collations cannot key (comparator-only or unregistered), BEFORE the physical
	 * index store is created — so a rejection leaves no store directory behind even for
	 * an empty table (where the build itself would encode nothing and the later
	 * `updateSchema` validation would fire only after the store exists).
	 */
	assertIndexKeyCollationsCanKey(indexSchema: TableIndexSchema): void {
		const names = new Set<string>();
		for (const collation of resolveIndexKeyCollations(indexSchema, this.tableSchema!.columns)) {
			if (collation !== undefined) names.add(collation);
		}
		this.assertCollationsCanKey(names);
	}

	/**
	 * Reject, at DDL time, a key member whose semantic-ordering logical type has no
	 * store key transform — before a single row is keyed under bytes whose order the
	 * type's `compare` (and so the isolation merge, the memory oracle, and Sort)
	 * disagrees with.
	 *
	 * A semantic-ordering type keys soundly only through an order- and
	 * identity-preserving transform ({@link storeSemanticKeyTransform}: the type's
	 * `groupKey`, or a store-local encoder like JSON's structural one). This gap used
	 * to be undetectable — JSON sat here transform-less for a release, keying in
	 * canonical-text order while every comparator ordered structurally, and the only
	 * symptom was a misaligned overlay merge deep inside a transaction. Unreachable
	 * today (TIMESPAN and JSON are both covered); it exists so the NEXT
	 * semantic-ordering type fails loudly at CREATE TABLE instead.
	 *
	 * Checked over the same materialized schema as {@link validateKeyCollations}:
	 * every PK member and every (explicit or hidden `_uc_*`) index column.
	 *
	 * CAVEAT: this can only check that a transform EXISTS — a `groupKey` that is
	 * identity-faithful but not order-preserving passes undetected, so a new type's
	 * transform still needs its byte order argued against its `compare` (see
	 * json-key.ts for the shape of that argument).
	 */
	private validateSemanticKeyTransforms(schema: TableSchema): void {
		const check = (colIndex: number, member: string): void => {
			const col = schema.columns[colIndex];
			const type = col?.logicalType;
			if (!hasSemanticOrdering(type) || storeSemanticKeyTransform(type) !== undefined) return;
			throw new QuereusError(
				`column ${col?.name ?? String(colIndex)} (${member}): semantic-ordering type `
					+ `${type.name} cannot key a persisted structure: its raw encoding would not `
					+ `reproduce the type's compare order — the type needs an order-preserving `
					+ `groupKey or a store key encoder (see storeSemanticKeyTransform)`,
				StatusCode.ERROR,
			);
		};
		for (const def of schema.primaryKeyDefinition) check(def.index, 'primary key');
		for (const index of schema.indexes ?? []) {
			for (const col of index.columns) check(col.index, `index ${index.name}`);
		}
	}

	/** Get the table configuration. */
	getConfig(): StoreTableConfig {
		return this.config;
	}

	/** Get the table schema (engine-facing, WITHOUT the hidden `_uc_*` indexes). */
	getSchema(): TableSchema {
		return this.tableSchema!;
	}

	/**
	 * Get the enforcement schema — {@link getSchema} plus the hidden `_uc_*`
	 * index materialized per non-derived UNIQUE. Used by the module to resolve the
	 * physical index store to build/tear down during ALTER; never registered with
	 * the engine.
	 */
	getMaterializedSchema(): TableSchema {
		return this.materializedSchema;
	}

	/**
	 * Update the table schema after an ALTER TABLE / CREATE INDEX operation.
	 *
	 * Validates the incoming schema's key collations before adopting any of it, so a
	 * rejection leaves this table on its previous, consistent schema.
	 */
	updateSchema(newSchema: TableSchema): void {
		// `newSchema` is the engine-facing (non-materialized) schema; recompute the
		// enforcement copy alongside it. Validate the MATERIALIZED copy so a `_uc_*`
		// whose key collations cannot key is caught before adoption.
		const materialized = withImplicitUniqueIndexes(newSchema);
		const pkKeyCollations = resolvePkKeyCollations(
			newSchema.primaryKeyDefinition,
			newSchema.columns,
			this.encodeOptions.collation ?? 'NOCASE',
		);
		this.validateKeyCollations(materialized, pkKeyCollations);
		this.validateSemanticKeyTransforms(materialized);
		this.tableSchema = newSchema;
		this.materializedSchema = materialized;
		this.pkDirections = newSchema.primaryKeyDefinition.map(pk => !!pk.desc);
		this.pkKeyCollations = pkKeyCollations;
		this.pkKeyTransforms = resolvePkKeyTransforms(newSchema.primaryKeyDefinition, newSchema.columns);
		this.pkSemanticEquality = resolvePkSemanticEquality(newSchema.primaryKeyDefinition, newSchema.columns);
	}

	/**
	 * Mark the table's DDL as already persisted to the catalog, so the lazy
	 * first-store-access save in {@link initializeStore} is skipped. Called by
	 * `StoreModule.createIndex` / `dropIndex` after they eagerly write the catalog
	 * bundle, so a subsequent INSERT does not redundantly re-persist identical DDL.
	 */
	markDdlSaved(): void {
		this.ddlSaved = true;
	}

	/** Close and forget a cached index-store handle, if any. */
	async releaseIndexStore(indexName: string): Promise<void> {
		const cached = this.indexStores.get(indexName);
		if (!cached) return;
		this.indexStores.delete(indexName);
		try { await cached.close(); } catch { /* close is best-effort */ }
	}

	/**
	 * Returns true if the table has at least one LIVE row — the open transaction's
	 * pending overlay over the committed store. Stops after the first hit.
	 *
	 * Effective (not committed-only) because its one caller, `ADD COLUMN`'s NOT
	 * NULL-without-DEFAULT rejection, must see rows the same transaction inserted:
	 * they are migrated too (the arm DDL-commits before `migrateRows`), and a
	 * committed-only probe would wave them through only to give them a NULL in a
	 * NOT NULL column. Conversely, a pending delete of the last row makes the table
	 * legitimately empty. Reading effectively keeps the check throw-only and
	 * BEFORE the DDL-commit, so a rejection leaves the transaction intact.
	 */
	async hasAnyRows(): Promise<boolean> {
		for await (const _entry of this.iterateEffectiveEntries(buildFullScanBounds())) {
			return true;
		}
		return false;
	}

	/**
	 * Yield the LIVE value of `colIndex` for every row — the open transaction's
	 * pending overlay over the committed store. For throw-only ALTER COLUMN probes
	 * that must run BEFORE the arm's DDL-commit (see `StoreModule.ddlCommitPendingOps`):
	 * they have to see rows this transaction wrote, because those rows are rewritten
	 * too, and a rejection here must leave the transaction intact.
	 */
	async *iterateEffectiveValuesAtIndex(colIndex: number): AsyncIterable<SqlValue> {
		for await (const entry of this.iterateEffectiveEntries(buildFullScanBounds())) {
			yield deserializeRow(entry.value)[colIndex];
		}
	}

	/**
	 * Count the LIVE rows whose column at `colIndex` holds NULL (see
	 * {@link iterateEffectiveValuesAtIndex} for why this reads effectively).
	 * Used by ALTER COLUMN SET NOT NULL to decide whether the tightening is safe.
	 */
	async rowsWithNullAtIndex(colIndex: number): Promise<number> {
		let count = 0;
		for await (const value of this.iterateEffectiveValuesAtIndex(colIndex)) {
			if (value === null) count++;
		}
		return count;
	}

	/**
	 * Ensure the data store is open and DDL is persisted.
	 * Uses a promise-based singleton pattern to prevent race conditions
	 * when multiple concurrent queries access the same table.
	 */
	protected ensureStore(): Promise<KVStore> {
		if (this.store) {
			return Promise.resolve(this.store);
		}

		if (this.storeInitPromise) {
			return this.storeInitPromise;
		}

		this.storeInitPromise = this.initializeStore();
		return this.storeInitPromise;
	}

	/**
	 * Internal method to actually initialize the store.
	 * Only called once per table instance.
	 */
	private async initializeStore(): Promise<KVStore> {
		const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();

		try {
			this.store = await this.storeModule.getStore(this.schemaName, this.tableName, this.config);

			if (!this.store) {
				throw new Error(`getStore returned null/undefined for ${tableKey}`);
			}

			// Catalog backstop on first storage access. The authoritative write happens
			// earlier, off the engine's `table_added` event; this is a COMPARE-write, so for
			// an already-persisted table it reads and skips rather than re-putting identical
			// bytes.
			//
			// It is retained (rather than dropped as redundant) because it is the only place a
			// table whose persisted DDL text is UNENCODABLE — a lone surrogate in a quoted
			// column name, a DEFAULT string literal, a CHECK constant — can raise on the
			// statement: the `table_added` write rides the persist queue, which logs and
			// swallows. The entry is absent there (that write threw), so the compare-write
			// attempts it and the encoding guard throws into the DML that opened the storage.
			if (!this.ddlSaved && this.tableSchema) {
				await this.storeModule.persistTableCatalogEntryIfChanged(this.tableSchema);
				this.ddlSaved = true;
			}

			await this.primeStats();

			return this.store;
		} catch (error) {
			this.storeInitPromise = null;
			throw error;
		}
	}

	/**
	 * Get or create an index store for the given index name.
	 */
	protected async ensureIndexStore(indexName: string): Promise<KVStore> {
		let indexStore = this.indexStores.get(indexName);
		if (!indexStore) {
			indexStore = await this.storeModule.getIndexStore(this.schemaName, this.tableName, indexName);
			this.indexStores.set(indexName, indexStore);
		}
		return indexStore;
	}

	/**
	 * Read the persisted row count into {@link cachedStats} once per table instance,
	 * before any mutation can be tracked against it.
	 *
	 * `trackMutation` / `applyPendingStats` both seed a missing `cachedStats` with
	 * `rowCount: 0` and add their delta to it, so WITHOUT this priming the first write
	 * after a reopen silently restarted the count from zero: a table reopened with 500
	 * persisted rows reported 1 after a single insert, and the next
	 * {@link flushStats} made that durable. Nothing read the count for planning before,
	 * so the loss was invisible; it is not once {@link getKnownRowCount} prices access
	 * plans with it.
	 *
	 * Called from {@link initializeStore}, which every read and write path awaits
	 * before touching storage — so priming precedes the first `trackMutation` without
	 * any caller having to remember it. Costs one extra KV `get` per table per session.
	 *
	 * Statistics are advisory (same posture as `StoreModuleRename`'s stats re-key): a
	 * failure to open or read the stats store warns and leaves the count unknown rather
	 * than failing the storage open that carries the caller's actual query.
	 *
	 * NOTE: on that failure path the pre-fix behaviour returns for this table — the next
	 * `trackMutation` seeds `cachedStats` at 0 and a later {@link flushStats} makes the
	 * restarted count durable, silently discarding the persisted one. Tolerated because a
	 * stats-store read failure is already a storage-level fault and the count is advisory.
	 * If it ever needs to be safe, gate {@link flushStats} on a "primed or genuinely
	 * absent" flag rather than on `cachedStats` being non-null.
	 *
	 * PUBLIC because it is also the SINGLE OWNER of the column-statistics stamp (see
	 * {@link publishPersistedStatistics}): whichever path opens this table first — the
	 * rehydrate reconcile loop calling it directly, or a later first storage access —
	 * runs it exactly once, so a table's persisted `ANALYZE` snapshot reaches the planner
	 * whether or not it happened to be connected during rehydration. It touches only the
	 * stats store, never the data store, so calling it eagerly does not open (or create)
	 * table storage.
	 */
	async primeStats(): Promise<void> {
		if (this.cachedStats) return;
		try {
			const statsStore = await this.ensureStatsStore();
			const statsData = await statsStore.get(buildStatsKey(this.schemaName, this.tableName));
			if (statsData) this.cachedStats = deserializeStats(statsData);
		} catch (e) {
			console.warn(`[StoreModule] Failed to read persisted statistics for '${this.schemaName}.${this.tableName}': ${e instanceof Error ? e.message : String(e)}`);
		}
		this.publishPersistedStatistics();
	}

	/**
	 * The persisted `ANALYZE` snapshot as a {@link TableStatistics}, or undefined when this
	 * table has none on disk (never analyzed, or a record written before column statistics
	 * were persisted at all).
	 *
	 * `rowCount` is the ANALYZE-time count (`TableStats.analyzedRowCount`), NOT the live
	 * delta-tracked one: every estimate the column statistics drive divides by it, so the
	 * two halves have to describe the same moment. A record whose column statistics predate
	 * the `analyzedRowCount` field falls back to the live count — the closest thing it has.
	 *
	 * Synchronous, and answers only from what {@link primeStats} already loaded.
	 */
	getPersistedStatistics(): TableStatistics | undefined {
		const cached = this.cachedStats;
		if (!cached?.columnStats) return undefined;
		return {
			rowCount: cached.analyzedRowCount ?? cached.rowCount,
			columnStats: new Map(Object.entries(cached.columnStats)),
			lastAnalyzed: cached.lastAnalyzed,
		};
	}

	/**
	 * Stamp the just-loaded `ANALYZE` snapshot onto this table's REGISTERED `TableSchema`,
	 * which is where `CatalogStatsProvider` reads statistics from — without it the record
	 * would sit on disk, correctly loaded and never consulted.
	 *
	 * SILENT by design: `schema.addTable` with no `notifyChange`. Phase 3 of
	 * `StoreModuleSchemaSync.rehydrateCatalog` deliberately fires no schema-change events,
	 * and emitting one from inside rehydration would drive the store module's own listener
	 * during its own rehydrate. Nothing is lost — statistics do not participate in plan
	 * invalidation the way DDL does, and the next prepared statement reads the stamped
	 * schema.
	 *
	 * Never OVERWRITES: an already-present `statistics` came from an `ANALYZE` this session
	 * (or a previous stamp), and a disk snapshot must not displace a fresher in-memory one.
	 *
	 * The stamp deliberately does NOT update this instance's own cached `tableSchema`. The
	 * store never reads `statistics` off it — key encoding, constraint enforcement and index
	 * maintenance are all it consults there — and `getBestAccessPlan` is handed the
	 * REGISTERED schema by the engine, which is the copy stamped here.
	 */
	private publishPersistedStatistics(): void {
		const statistics = this.getPersistedStatistics();
		if (!statistics) return;
		const schema = this.db.schemaManager.getSchema(this.schemaName);
		const registered = schema?.getTable(this.tableName);
		if (!schema || !registered || registered.statistics) return;
		schema.addTable({ ...registered, statistics });
	}

	/**
	 * Get or create the stats store.
	 */
	protected async ensureStatsStore(): Promise<KVStore> {
		if (!this.statsStore) {
			this.statsStore = await this.storeModule.getStatsStore(this.schemaName, this.tableName);
		}
		return this.statsStore;
	}

	/**
	 * Resolve + cache the module's shared TransactionCoordinator and hook the
	 * stats lifecycle callbacks, WITHOUT creating or registering a connection.
	 * Synchronous (the coordinator is handle-addressed, never store-opening — see
	 * `StoreTableModule.getCoordinator`), so the backing host's resolution path can
	 * call it eagerly. Attaching matters for reads: `iterateEffective` /
	 * `readEffectiveRowByKey` consult `this.coordinator` for the pending merge, so a
	 * table whose only writer is the privileged backing host (which queues ops on the
	 * module coordinator, never through `update()`) must still hold the
	 * reference for its read paths to be reads-own-writes.
	 *
	 * The coordinator is module-wide, so its commit/rollback callback array holds
	 * one {stats apply/discard} pair per PARTICIPATING table; each table's
	 * `applyPendingStats` early-returns when its own `pendingStatsDelta` is 0, so a
	 * table that did no work contributes nothing. Registers only on first call per
	 * StoreTable instance (the `if (!this.coordinator)` guard); a fresh instance
	 * after drop+recreate re-registers against the shared coordinator. The OLD
	 * instance is not GC'd on its own — its callback closures capture `this` and
	 * stay pinned on the module-wide coordinator until {@link dispose} runs the
	 * captured disposer (called at the genuine eviction sites, see
	 * `StoreModule.tearDownTableStorage` / `renameTable`).
	 */
	attachCoordinator(): TransactionCoordinator {
		if (!this.coordinator) {
			this.coordinator = this.storeModule.getCoordinator();

			this.coordinatorDisposer = this.coordinator.registerCallbacks({
				onCommit: () => this.applyPendingStats(),
				onRollback: () => this.discardPendingStats(),
			});
		}
		return this.coordinator;
	}

	/**
	 * Ensure the coordinator is available and connection is registered.
	 */
	protected async ensureCoordinator(): Promise<TransactionCoordinator> {
		const coordinator = this.attachCoordinator();

		if (!this.connection) {
			this.connection = new StoreConnection(`${this.schemaName}.${this.tableName}`, coordinator);
			await (this.db as DatabaseInternal).registerConnection(this.connection);
		}

		return coordinator;
	}

	/**
	 * Deliver one data-change event: buffered on the coordinator inside a transaction
	 * (fires on commit, discarded on rollback), emitted straight through otherwise.
	 * Every write path routes its event here so the two arms can never drift apart.
	 *
	 * Ordering within a transaction is the coordinator's queue order, which is the order
	 * these calls are made — the event contract's delete-before-insert promise for a
	 * relocating key change rides on that (docs/usage.md § Subscribing to Data Changes).
	 */
	protected emitOrQueueDataChange(inTransaction: boolean, event: DataChangeEvent): void {
		if (inTransaction && this.coordinator) {
			this.coordinator.queueEvent(event);
		} else {
			this.eventEmitter?.emitDataChange(event);
		}
	}

	/** Apply pending stats on commit. */
	protected applyPendingStats(): void {
		if (this.pendingStatsDelta === 0) return;

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}
		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount += Math.abs(this.pendingStatsDelta);
		this.pendingStatsDelta = 0;

		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}

	/** Discard pending stats on rollback. */
	protected discardPendingStats(): void {
		this.pendingStatsDelta = 0;
	}

	/** Flush statistics to the stats store. */
	protected async flushStats(): Promise<void> {
		this.statsFlushPending = false;
		this.mutationCount = 0;

		if (!this.cachedStats) {
			return;
		}

		const statsStore = await this.ensureStatsStore();
		const statsKey = buildStatsKey(this.schemaName, this.tableName);
		await statsStore.put(statsKey, serializeStats(this.cachedStats));
	}

	/** Create a new connection for transaction support. */
	async createConnection(): Promise<VirtualTableConnection> {
		await this.ensureCoordinator();
		return this.connection!;
	}

	/** Get the current connection. */
	getConnection(): VirtualTableConnection | undefined {
		return this.connection ?? undefined;
	}

	/** Extract primary key values from a full row (positioned by column index). */
	protected extractPK(row: Row): SqlValue[] {
		const schema = this.tableSchema!;
		return schema.primaryKeyDefinition.map(pk => row[pk.index]);
	}

	/**
	 * Resolve the PK cells an UPDATE/DELETE's `oldKeyValues` addresses.
	 *
	 * `UpdateArgs.oldKeyValues` is COMPACT — one cell per `primaryKeyDefinition`
	 * entry, in that order — NOT a full row positioned by column index. Every
	 * producer builds it that way (`pkIndices.map(i => row[i])` in the DML
	 * executor and in the isolation flush/overlay), and the memory module's
	 * `buildPrimaryKeyFromValues` asserts exactly this arity.
	 *
	 * Running it through {@link extractPK} instead only coincides when every PK
	 * column sits at the index matching its position in the PK definition. For a
	 * table whose PK is not its leading columns (e.g. a generated stored PK
	 * declared after the columns it derives from) that read lands past the end of
	 * the compact array and yields `undefined`.
	 */
	protected pkFromKeyValues(keyValues: Row): SqlValue[] {
		const pkDef = this.tableSchema!.primaryKeyDefinition;
		if (keyValues.length !== pkDef.length) {
			throw new QuereusError(
				`Key value count mismatch for '${this.tableName}'. Expected ${pkDef.length}, got ${keyValues.length}.`,
				StatusCode.INTERNAL,
			);
		}
		return [...keyValues];
	}

	/**
	 * Coerce each cell in `row` to its declared column logical type.
	 * Mirrors the memory-table path (MemoryTableManager.performInsert/performUpdate)
	 * so INTEGER/REAL affinity is applied and JSON columns are parsed into native
	 * objects before PK extraction, serialization, and index-key construction.
	 */
	protected coerceRow(row: Row): Row {
		return coerceRowToSchema(row, this.tableSchema!.columns, `${this.schemaName}.${this.tableName}`);
	}

	/**
	 * Iterate the effective entry state of this table's data store within
	 * `bounds`: the committed `store.iterate` stream merged with the
	 * coordinator's pending ops for the data store (read-your-own-writes).
	 *
	 * Both inputs are sorted by encoded key bytes, so this is an
	 * order-preserving two-way merge: a pending put wins over a committed entry
	 * at the same key, a pending delete suppresses its committed entry, and
	 * pending puts outside `bounds` are excluded. With no active transaction
	 * (or an empty pending bucket) it degrades to the bare committed iterate.
	 *
	 * The pending side is the module coordinator's bucket for THIS table's data
	 * store handle (`store`) — every data op is queued under that exact handle, so
	 * a sibling table's pending ops (a different data-store handle) never bleed in.
	 */
	protected async *iterateEffective(
		store: KVStore,
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const pending = this.coordinator?.isInTransaction()
			? this.coordinator.getOrderedPendingOps(store)
			: null;
		const iterOptions: IterateOptions = reverse ? { ...bounds, reverse } : bounds;

		if (!pending || (pending.puts.length === 0 && pending.deletes.size === 0)) {
			yield* store.iterate(iterOptions);
			return;
		}

		const puts = pending.puts.filter(p => keyWithinBounds(p.key, bounds));
		if (reverse) puts.reverse();
		// In iteration order, "before" means byte-less for forward and byte-greater
		// for reverse; sign folds the direction into one comparison.
		const sign = reverse ? -1 : 1;
		let putIdx = 0;

		for await (const entry of store.iterate(iterOptions)) {
			// Emit pending puts that precede this committed entry in iteration order.
			while (putIdx < puts.length && sign * compareBytes(puts[putIdx].key, entry.key) < 0) {
				yield puts[putIdx++];
			}
			// Equal keys: the pending put shadows the committed entry.
			if (putIdx < puts.length && compareBytes(puts[putIdx].key, entry.key) === 0) {
				yield puts[putIdx++];
				continue;
			}
			if (pending.deletes.has(bytesToHex(entry.key))) continue;
			yield entry;
		}

		// Pending puts beyond the last committed entry.
		while (putIdx < puts.length) {
			yield puts[putIdx++];
		}
	}

	/**
	 * Read the live row at `pk` — this transaction's pending overlay (a pending
	 * delete ⇒ gone; a pending put ⇒ its value) shadowing the committed store.
	 * Backs `query()`'s point-lookup arm and validates covering-MV conflict
	 * candidates against the source of truth.
	 */
	protected async readLiveRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readEffectiveRowByKey(this.encodeDataKey(pk));
	}

	// ── Backing-host surface ──────────────────────────────────────────────
	// Narrow public surface `StoreBackingHost` (backing-host.ts) drives. Each
	// method addresses the table's CURRENT schema/encoding state, so a host
	// resolved fresh per engine call always keys and merges consistently with
	// the table's own read/write paths.

	/** Encode `pkValues` (in PK-definition order) exactly as the data store keys rows. */
	encodeDataKey(pkValues: SqlValue[]): Uint8Array {
		return buildDataKey(pkValues, this.encodeOptions, this.pkDirections, this.pkKeyCollations, this.pkKeyTransforms);
	}

	/**
	 * Byte bounds covering every data key whose leading PK columns equal
	 * `prefixValues` — encoded under the same per-column DESC directions and key
	 * collations as {@link encodeDataKey}, so seek + early-terminate addresses the
	 * exact slice. An empty prefix yields full-scan bounds.
	 */
	encodePkPrefixBounds(prefixValues: SqlValue[]): { gte: Uint8Array; lt?: Uint8Array } {
		return buildPkPrefixBounds(
			prefixValues,
			this.encodeOptions,
			this.pkDirections.slice(0, prefixValues.length),
			this.pkKeyCollations.slice(0, prefixValues.length),
			this.pkKeyTransforms.slice(0, prefixValues.length),
		);
	}

	/**
	 * This transaction's decision about `key`, without touching the committed store:
	 * `null` for a pending delete, the staged row for a pending put, and `undefined`
	 * when the overlay has nothing to say and the committed store must be read.
	 *
	 * The precedence both effective reads below implement, in one place — a pending
	 * delete must never fall through to a committed value, and a pending put must win
	 * over one.
	 */
	private pendingRowFor(pending: PendingStoreOps | null, key: Uint8Array): Row | null | undefined {
		if (!pending) return undefined;
		const hex = bytesToHex(key);
		if (pending.deletes.has(hex)) return null;
		const overlay = pending.puts.get(hex);
		return overlay ? deserializeRow(overlay.value) : undefined;
	}

	/** Pending ops for THIS table's data store handle — see findUniqueConflict. */
	private pendingDataOps(store: KVStore): PendingStoreOps | null {
		return this.coordinator?.isInTransaction()
			? this.coordinator.getPendingOpsForStore(store)
			: null;
	}

	/**
	 * Effective (pending-over-committed) point read by encoded data key: a pending
	 * delete ⇒ null, a pending put ⇒ its value, else the committed store entry.
	 */
	async readEffectiveRowByKey(key: Uint8Array): Promise<Row | null> {
		const store = await this.ensureStore();
		const overlay = this.pendingRowFor(this.pendingDataOps(store), key);
		if (overlay !== undefined) return overlay;
		const value = await store.get(key);
		return value ? deserializeRow(value) : null;
	}

	/**
	 * Batch twin of {@link readEffectiveRowByKey}: resolve MANY encoded data keys in one
	 * store round trip, applying the same pending-over-committed precedence per key.
	 *
	 * `result[i]` corresponds to `keys[i]` and is null when that key resolves to no row
	 * (absent, or deleted in this transaction). Duplicate keys are read once each and are
	 * fine — nothing here dedups, because the CALLER's ordering and dedup rules differ per
	 * scan shape (see `StoreTableScan`).
	 *
	 * The overlay is resolved BEFORE the batch is issued, so a key this transaction deleted
	 * is never fetched from the committed store and a pending put never pays a round trip.
	 * Only the remainder reaches `getMany`, and their positions are remembered rather than
	 * re-derived so an interleaved overlay hit cannot shift the result.
	 *
	 * The caller owns the batch SIZE — see {@link KVStore.getMany}'s bounded-by-the-caller
	 * note.
	 */
	async readEffectiveRowsByKeys(keys: readonly Uint8Array[]): Promise<(Row | null)[]> {
		if (keys.length === 0) return [];
		const store = await this.ensureStore();
		const pending = this.pendingDataOps(store);

		const rows: (Row | null)[] = new Array(keys.length);
		const missPositions: number[] = [];
		const missKeys: Uint8Array[] = [];
		for (let i = 0; i < keys.length; i++) {
			const overlay = this.pendingRowFor(pending, keys[i]);
			if (overlay !== undefined) {
				rows[i] = overlay;
			} else {
				missPositions.push(i);
				missKeys.push(keys[i]);
			}
		}

		if (missKeys.length > 0) {
			const values = await store.getMany(missKeys);
			for (let j = 0; j < missPositions.length; j++) {
				const value = values[j];
				rows[missPositions[j]] = value ? deserializeRow(value) : null;
			}
		}
		return rows;
	}

	/**
	 * Effective ordered entry scan within `bounds` (see {@link iterateEffective}).
	 * Opens the data store first — which fires the lazy first-access `saveTableDDL`
	 * for a freshly created table, the catalog write a store-backed MV backing
	 * relies on to survive reopen.
	 */
	async *iterateEffectiveEntries(
		bounds: IterateOptions,
		reverse = false,
	): AsyncIterable<KVEntry> {
		const store = await this.ensureStore();
		yield* this.iterateEffective(store, bounds, reverse);
	}

	/** Buffer a privileged row-count delta, applied at coordinator commit (host writes). */
	trackPrivilegedMutation(delta: number): void {
		this.trackMutation(delta, true);
	}

	/**
	 * Reset statistics to an absolute committed row count and flush immediately.
	 * Used by the host's `replaceContents` (create-fill / refresh), where the new
	 * count is exact, replacing any drifted delta-tracked estimate.
	 */
	async resetStats(rowCount: number): Promise<void> {
		this.cachedStats = { rowCount, updatedAt: Date.now() };
		this.pendingStatsDelta = 0;
		this.mutationCount = 0;
		await this.flushStats();
	}

	/**
	 * Open (and cache) the data store, firing the lazy first-access `saveTableDDL`.
	 * Public for the host's `replaceContents`, which writes the store directly.
	 */
	openDataStore(): Promise<KVStore> {
		return this.ensureStore();
	}

	// ── External row-write surface ────────────────────────────────────────
	// Module-side entry point for externally-applied writes to a SOURCE table
	// (the index-maintaining sibling of `StoreBackingHost`, which is for MV
	// BACKING tables and deliberately keeps no indexes). Resolved per call via
	// `StoreModule.getTableForExternalWrite`; addresses the table's CURRENT
	// schema/encoding state so keys and index entries match its own DML paths.

	/**
	 * Effective (pending-over-committed) point read by PK values — the public
	 * read an external writer issues before an upsert to learn the row's current
	 * image. Thin wrapper over the same private point-lookup that backs
	 * `StoreTableScan.query`'s point arm, so an external read merges pending-over-committed
	 * exactly like an engine read does.
	 */
	readRowByPk(pk: SqlValue[]): Promise<Row | null> {
		return this.readLiveRowByPk(pk);
	}

	/**
	 * Begin a table-scoped transaction by ensuring the coordinator is active.
	 *
	 * Used by the isolation layer's flush path, which treats the underlying
	 * write as an independent mini-transaction. Idempotent: if the coordinator
	 * is already in a transaction (e.g. started by a registered connection),
	 * this is a no-op.
	 */
	async begin(): Promise<void> {
		const coordinator = await this.ensureCoordinator();
		coordinator.begin();
	}

	/**
	 * Commits a table-scoped transaction, flushing any buffered writes to the KV store.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async commit(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			await this.coordinator.commit();
		}
	}

	/**
	 * Rolls back a table-scoped transaction, discarding any buffered writes.
	 * No-op if the coordinator is not currently in a transaction.
	 */
	async rollback(): Promise<void> {
		if (this.coordinator?.isInTransaction()) {
			this.coordinator.rollback();
		}
	}

	/** Disconnect from the store. */
	async disconnect(): Promise<void> {
		// Called by Quereus after each scan completes.
		// Do NOT clear the store - it's shared across concurrent queries.
		// Only flush pending stats if there are mutations.
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		// Store remains available for subsequent queries.
		// Use destroy() to fully clean up the table.
	}

	/**
	 * Hard teardown: fully detach this instance from the module-wide coordinator.
	 *
	 * Distinct from the per-scan {@link disconnect} (which only flushes stats and
	 * deliberately keeps the table hooked mid-life). Called ONLY at the genuine
	 * eviction sites — `StoreModule.tearDownTableStorage` (drop / reclaim) and
	 * `renameTable` — where this instance is removed from the module's `tables` map
	 * and will never be used again. It best-effort flushes any buffered stats (the
	 * backing store is about to be deleted / relocated, so this is the last chance,
	 * same posture as the teardown-time `disconnect` it replaces), then runs the
	 * coordinator disposer so this instance's {stats apply/discard} callback pair —
	 * and the `this` its closures capture — is spliced off the shared coordinator's
	 * array rather than pinned for the module's lifetime.
	 *
	 * Idempotent: the disposer is run at most once and both it and the coordinator
	 * reference are nulled, so a double-dispose is a no-op and a re-`attachCoordinator`
	 * after dispose registers a fresh pair instead of double-registering.
	 */
	async dispose(): Promise<void> {
		if (this.mutationCount > 0 && this.store) {
			await this.flushStats();
		}
		this.coordinatorDisposer?.();
		this.coordinatorDisposer = null;
		this.coordinator = null;
	}

	/** Get the current estimated row count. */
	async getEstimatedRowCount(): Promise<number> {
		if (!this.cachedStats) {
			await this.primeStats();
		}
		// Still nothing on disk ⇒ this table has never been counted; report 0.
		return this.cachedStats?.rowCount ?? 0;
	}

	/**
	 * The row count this instance can answer WITHOUT any I/O — `undefined` when no
	 * count has been read or maintained yet (a table nothing has touched this session,
	 * or one that has never been counted at all).
	 *
	 * Synchronous by design: `StoreModule.getBestAccessPlan` is a synchronous engine
	 * callback, so the only count it can price a plan with is one already in memory.
	 * {@link primeStats} is what makes that the common case rather than the rare one —
	 * it loads the persisted count when storage is first opened, which every read and
	 * write path does before it can reach the planner a second time.
	 *
	 * Includes the open transaction's buffered delta, so a statement that reads what
	 * its own transaction just wrote is costed against the size it will actually see.
	 */
	getKnownRowCount(): number | undefined {
		if (!this.cachedStats) return undefined;
		return Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
	}

	/**
	 * The `VirtualTable.getStatistics` contract: this table's SIZE, reported from the
	 * running count the write paths already maintain and persist, in O(1) — no scan.
	 *
	 * Column statistics are deliberately absent, and stay absent even though this table
	 * now HOLDS a persisted per-column snapshot ({@link getPersistedStatistics}).
	 * `ANALYZE` reads a non-empty `columnStats` as "this module answered cheaply, skip the
	 * scan" (see `collectTableStatistics` in `runtime/emit/analyze.ts`), so reporting the
	 * snapshot here would turn every `ANALYZE` into a no-op that re-saves numbers it never
	 * recomputed — a cached snapshot is not an answer to "analyze me". The snapshot reaches
	 * the planner by a different route: {@link primeStats} stamps it onto the registered
	 * `TableSchema` at open.
	 *
	 * The store still computes no distribution of its own — a distinct count or histogram
	 * would cost a full scan of the table or of an index — so an empty `columnStats` also
	 * remains the honest answer for a table nobody has ever analyzed.
	 *
	 * `rowCount` is delta-tracked rather than counted, so it can drift from the true
	 * count if a write path ever mis-accounts; `ANALYZE`'s scan is the reconciliation.
	 *
	 * `lastAnalyzed` is deliberately left unset: the only timestamp this table holds is
	 * `TableStats.updatedAt`, the moment the count last MOVED, which is a different fact
	 * — reporting it here would tell a staleness check the table had been analyzed.
	 */
	async getStatistics(): Promise<TableStatistics> {
		return {
			rowCount: await this.getEstimatedRowCount(),
			columnStats: new Map<string, ColumnStatistics>(),
		};
	}

	/**
	 * The `VirtualTable.saveStatistics` contract: fold the snapshot `ANALYZE` just
	 * collected into this table's `__stats__` record and flush it, so the next open reads
	 * the numbers back instead of planning blind until someone re-runs `ANALYZE`.
	 *
	 * Only the three ANALYZE fields are written. The live `rowCount` is left exactly as the
	 * write paths delta-track it — `ANALYZE`'s exact count lands in `analyzedRowCount`,
	 * which is what pairs with the column statistics. (Reconciling the drifted live count
	 * against the scan is a separate, defensible change; it is not made here, so this hook
	 * cannot alter what any existing caller of `getEstimatedRowCount` sees.)
	 *
	 * Histograms are dropped for columns the store cannot seek on — see
	 * {@link toPersistedColumnStats}, which owns that rule and its size arithmetic.
	 *
	 * Primes first so a table whose storage this session never opened does not overwrite
	 * its persisted row count with a fresh zero. In practice `ANALYZE` has already scanned
	 * through `query()` by the time this runs, so the prime is a no-op guard.
	 */
	async saveStatistics(stats: TableStatistics): Promise<void> {
		await this.primeStats();
		const live = this.cachedStats ?? { rowCount: stats.rowCount, updatedAt: Date.now() };
		this.cachedStats = {
			...live,
			columnStats: toPersistedColumnStats(stats.columnStats, this.tableSchema!),
			analyzedRowCount: stats.rowCount,
			lastAnalyzed: stats.lastAnalyzed ?? Date.now(),
		};
		await this.flushStats();
	}

	/** Track a mutation and schedule lazy stats persistence. */
	protected trackMutation(delta: number, inTransaction = false): void {
		if (inTransaction) {
			// Buffer during transaction - stats will be applied at commit
			this.pendingStatsDelta += delta;
			return;
		}

		if (!this.cachedStats) {
			this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
		}

		this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + delta);
		this.cachedStats.updatedAt = Date.now();
		this.mutationCount++;

		// Schedule lazy flush after threshold
		if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
			this.statsFlushPending = true;
			queueMicrotask(() => this.flushStats());
		}
	}
}
