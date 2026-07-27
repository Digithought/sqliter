/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 * Delegates to focused sub-modules for snapshot, streaming, and change application.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import type {
	SqlValue,
	Row,
	Database,
	KeyNormalizerResolver,
	LensDeploymentSnapshot,
	TransactionCommitBatch,
	DatabaseDataChangeEvent,
	DatabaseSchemaChangeEvent,
} from '@quereus/quereus';
import { QuereusError, StatusCode, SYNC_EVICT_TAG } from '@quereus/quereus';
import type { GetTableSchemaCallback, TransactionCommitSource } from '../create-sync-module.js';
import { HLCManager, type HLC, compareHLC, createHLC, deterministicTxnId, MAX_OPSEQ } from '../clock/hlc.js';
import {
	generateSiteId,
	type SiteId,
	SITE_ID_KEY,
	serializeSiteIdentity,
	deserializeSiteIdentity,
	siteIdEquals,
} from '../clock/site.js';
import { ColumnVersionStore, type ColumnVersionData, deserializeColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore, deserializeTombstone } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { SchemaMigrationStore, deserializeMigration } from '../metadata/schema-migration.js';
import { ChangeLogStore, type ChangeLogEntry } from '../metadata/change-log.js';
import { QuarantineStore } from '../metadata/quarantine.js';
import {
	BasisLifecycleStore,
	classifyBasisLifecycle,
	basisLifecycleRecordChanged,
	splitRelKey,
	parseEvictPolicyTag,
	isEvictable,
	quietSince,
	type BasisTableLifecycleRecord,
	type EvictPolicy,
} from '../metadata/basis-lifecycle.js';
import type { BasisTableLifecycleEvent } from './events.js';
import {
	SYNC_KEY_PREFIX,
	SYNC_METADATA_FORMAT_VERSION,
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	parseSchemaMigrationKey,
	type PkKeying,
} from '../metadata/keys.js';
import { createPkKeyingResolver, type PkKeyingResolver } from '../metadata/pk-identity.js';
import type { SyncManager, SnapshotCheckpoint } from './manager.js';
import type {
	SyncConfig,
	ChangeSet,
	Change,
	ColumnChange,
	RowDeletion,
	ApplyResult,
	Snapshot,
	SchemaMigration,
	SchemaMigrationType,
	SnapshotChunk,
	SnapshotProgress,
	ApplyToStoreCallback,
	DropLocalTableCallback,
	UnknownTableDisposition,
} from './protocol.js';
import { SyncEventEmitterImpl } from './events.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCStateBatch, toError, deleteRowVersionsAndLogEntries } from './sync-context.js';
import { StagedTransactionMetadata } from './staged-transaction-metadata.js';
import { applyChanges as applyChangesImpl, drainHeldChanges as drainHeldChangesImpl, drainReappearedTables } from './change-applicator.js';
import { buildTransactionChangeSets } from './change-grouping.js';
import { getSnapshot as getSnapshotImpl, applySnapshot as applySnapshotImpl } from './snapshot.js';
import {
	getSnapshotStream as getSnapshotStreamImpl,
	applySnapshotStream as applySnapshotStreamImpl,
	getSnapshotCheckpoint as getSnapshotCheckpointImpl,
	resumeSnapshotStream as resumeSnapshotStreamImpl,
} from './snapshot-stream.js';

/**
 * Guard a transaction's running `opSeq` against the uint32 bound. `opSeq` is
 * serialized as a big-endian uint32 in the HLC comparison key, so a fact count
 * exceeding {@link MAX_OPSEQ} would silently wrap and corrupt ordering — throw
 * instead. Practically unreachable (4 billion facts in one transaction); the
 * write side telemeters the throw via an error sync-state event.
 */
export function assertOpSeqInRange(opSeq: number): void {
	if (opSeq > MAX_OPSEQ) {
		throw new QuereusError(
			`Transaction exceeds ${MAX_OPSEQ + 1} facts; opSeq exhausted`,
			StatusCode.ERROR,
		);
	}
}

/**
 * Map an engine schema-change event `(objectType, type)` to the sync
 * {@link SchemaMigrationType} it records, or `undefined` when the combination is
 * not tracked for replication (e.g. column-level or view/trigger objects, or an
 * `alter` on an index). A `'table' alter` is recorded as `alter_column` — the
 * coarse "table definition changed" migration the schema-sync layer replays.
 */
function mapSchemaMigrationType(
	objectType: DatabaseSchemaChangeEvent['objectType'],
	type: DatabaseSchemaChangeEvent['type'],
): SchemaMigrationType | undefined {
	if (objectType === 'table') {
		switch (type) {
			case 'create': return 'create_table';
			case 'drop': return 'drop_table';
			case 'alter': return 'alter_column';
		}
	} else if (objectType === 'index') {
		switch (type) {
			case 'create': return 'add_index';
			case 'drop': return 'drop_index';
		}
	}
	return undefined;
}

/**
 * Implementation of SyncManager.
 *
 * Acts as a coordinator/facade that delegates snapshot, streaming,
 * and change application to focused sub-modules.
 */
export class SyncManagerImpl implements SyncManager, SyncContext {
	readonly kv: KVStore;
	readonly config: SyncConfig;
	readonly hlcManager: HLCManager;
	readonly columnVersions: ColumnVersionStore;
	readonly tombstones: TombstoneStore;
	private readonly peerStates: PeerStateStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly quarantine: QuarantineStore;
	readonly basisLifecycle: BasisLifecycleStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;
	private readonly getTableSchema?: GetTableSchemaCallback;
	/** Reclaim-by-name callback for the eviction sweep; absent ⇒ sweep is a no-op. */
	private readonly dropLocalTable?: DropLocalTableCallback;
	/**
	 * Per-table pk-identity keying resolver (see `metadata/pk-identity.ts`),
	 * threaded into every metadata store so `cv:`/`tb:`/`cl:` keys file under the
	 * row's collation/transform-normalized identity. Raw keying when no
	 * `getTableSchema` oracle was wired (relay-only deployment).
	 */
	private readonly pkKeying: PkKeyingResolver;

	// Tail-promise chain serializing commit recording. Each commit chains onto the
	// prior handler's completion so N+1's dedup reads see N's durable writes,
	// preserving the change-log ordering invariant (docs/sync.md § Transaction-Based
	// Change Grouping). Without this, two rapid commits interleave at the first
	// `await` and a stale change-log entry survives.
	private commitChain: Promise<void> = Promise.resolve();

	// Last basis hash recorded per basis schema (in-memory, advisory). Drives the
	// basis-drift warning in recordLensDeployment — a warning, not durable state.
	private readonly lastBasisHash = new Map<string, string>();

	// Cumulative unknown-table disposition counters (in-memory, observe-only —
	// mirrors the engine's materialized-view collision stats).
	private unknownTableIgnored = 0;
	private unknownTableQuarantined = 0;
	private unknownTableForwarded = 0;
	// Cumulative forwardable changes re-offered through getChangesSince (the
	// store-and-forward relay's outbound activity). Distinct from
	// unknownTableForwarded, which counts apply-time holds: a held entry is held
	// ONCE but relayed possibly MANY times until GC, so this counter grows with
	// relay activity, not with distinct stragglers. Bumped in collectForwardableChanges.
	private unknownTableRelayed = 0;
	private readonly unknownTableByTable = new Map<string, number>();

	private constructor(
		kv: KVStore,
		config: SyncConfig,
		hlcManager: HLCManager,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback,
		dropLocalTable?: DropLocalTableCallback,
		keyNormalizerResolver?: KeyNormalizerResolver,
	) {
		this.kv = kv;
		this.config = config;
		this.hlcManager = hlcManager;
		this.syncEvents = syncEvents;
		this.applyToStore = applyToStore;
		this.getTableSchema = getTableSchema;
		this.dropLocalTable = dropLocalTable;
		this.pkKeying = createPkKeyingResolver(getTableSchema, keyNormalizerResolver);
		this.columnVersions = new ColumnVersionStore(kv, this.pkKeying);
		this.tombstones = new TombstoneStore(kv, config.retentionHorizonMs, this.pkKeying);
		this.peerStates = new PeerStateStore(kv);
		this.changeLog = new ChangeLogStore(kv, this.pkKeying);
		this.schemaMigrations = new SchemaMigrationStore(kv);
		this.quarantine = new QuarantineStore(kv);
		this.basisLifecycle = new BasisLifecycleStore(kv);
	}

	/**
	 * Create a new SyncManager, initializing or loading site identity.
	 *
	 * @param kv - KV store for sync metadata
	 * @param transactionSource - Engine transaction-commit source for local change
	 *   capture (a `Database`, or any `onTransactionCommit` emitter). When provided,
	 *   sync subscribes to `onTransactionCommit` and records CRDT metadata for each
	 *   committed local transaction — one HLC per transaction. Pass `undefined` for a
	 *   relay-only deployment (e.g. a coordinator) that captures no local DML.
	 * @param config - Sync configuration
	 * @param syncEvents - Sync event emitter for UI integration
	 * @param applyToStore - Optional callback for applying remote changes to the store
	 * @param getTableSchema - Optional callback for getting table schema by name
	 * @param dropLocalTable - Optional reclaim-by-name callback for the basis-table
	 *   eviction sweep; when absent (e.g. a relay-only coordinator) the sweep is a no-op.
	 * @param keyNormalizerResolver - Optional collation-name → key-normalizer resolver
	 *   (pass the engine's `db.getKeyNormalizerResolver()`), used to build pk-identity
	 *   keys that agree with the database's row identity. When absent, a built-ins-only
	 *   resolver (BINARY/NOCASE/RTRIM) is used, which throws on custom collation names.
	 */
	static async create(
		kv: KVStore,
		transactionSource: TransactionCommitSource | undefined,
		config: SyncConfig,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback,
		dropLocalTable?: DropLocalTableCallback,
		keyNormalizerResolver?: KeyNormalizerResolver,
	): Promise<SyncManagerImpl> {
		// Load or create site identity
		const siteIdKey = new TextEncoder().encode(SITE_ID_KEY);
		let siteId: SiteId;

		const existingIdentity = await kv.get(siteIdKey);

		// Sync-metadata format gate: per-row records are keyed by pk IDENTITY since
		// format 2 (see SYNC_METADATA_FORMAT_VERSION); older metadata is unreadable
		// under this layout, and writing new-format records beside it would corrupt
		// both. A replica with existing identity but a missing/mismatched version
		// must re-bootstrap from a peer snapshot (docs/sync.md § Metadata format
		// version) — refuse loudly rather than silently mis-keying.
		const formatData = await kv.get(SYNC_KEY_PREFIX.FORMAT_VERSION);
		const storedFormat = formatData ? parseInt(new TextDecoder().decode(formatData), 10) : undefined;
		if (storedFormat === undefined) {
			if (existingIdentity) {
				throw new QuereusError(
					`Sync metadata predates format version ${SYNC_METADATA_FORMAT_VERSION} (pk-identity keys). `
						+ `Clear this replica's sync metadata and re-bootstrap from a peer snapshot (docs/sync.md § Metadata format version).`,
					StatusCode.ERROR,
				);
			}
			await kv.put(SYNC_KEY_PREFIX.FORMAT_VERSION, new TextEncoder().encode(String(SYNC_METADATA_FORMAT_VERSION)));
		} else if (storedFormat !== SYNC_METADATA_FORMAT_VERSION) {
			throw new QuereusError(
				`Sync metadata format version ${storedFormat} does not match this build's ${SYNC_METADATA_FORMAT_VERSION}. `
					+ `Clear this replica's sync metadata and re-bootstrap from a peer snapshot (docs/sync.md § Metadata format version).`,
				StatusCode.ERROR,
			);
		}

		if (existingIdentity) {
			const identity = deserializeSiteIdentity(existingIdentity);
			siteId = identity.siteId;
		} else if (config.siteId) {
			siteId = config.siteId;
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		} else {
			siteId = generateSiteId();
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		}

		// Load HLC state
		const hlcKey = SYNC_KEY_PREFIX.HLC_STATE;
		const hlcData = await kv.get(hlcKey);
		let hlcState: { wallTime: bigint; counter: number } | undefined;
		if (hlcData) {
			const view = new DataView(hlcData.buffer, hlcData.byteOffset, hlcData.byteLength);
			hlcState = {
				wallTime: view.getBigUint64(0, false),
				counter: view.getUint16(8, false),
			};
		}

		const hlcManager = new HLCManager(siteId, hlcState);
		const manager = new SyncManagerImpl(kv, config, hlcManager, syncEvents, applyToStore, getTableSchema, dropLocalTable, keyNormalizerResolver);

		// Capture local changes at the engine transaction boundary: one grouped
		// `onTransactionCommit` batch ⇒ one transaction ⇒ one HLC. The store's
		// per-table emitter is below the transaction boundary and cannot group a
		// multi-table transaction (docs/sync.md § Transaction-Based Change Grouping),
		// so we subscribe here, not there. Omitted for relay-only deployments.
		transactionSource?.onTransactionCommit((batch) => {
			manager.enqueueTransactionCommit(batch);
		});

		return manager;
	}

	// ============================================================================
	// Accessors
	// ============================================================================

	getSiteId(): SiteId {
		return this.hlcManager.getSiteId();
	}

	getCurrentHLC(): HLC {
		return this.hlcManager.now();
	}

	/** See {@link SyncContext.getPkKeying}. */
	getPkKeying(schema: string, table: string): PkKeying {
		return this.pkKeying(schema, table);
	}

	/**
	 * Basis-membership oracle for unknown-table detection. `getTableSchema(s,t)
	 * === undefined` ⇒ the table is outside the local basis. When no oracle was
	 * provided (e.g. a relay-only coordinator), detection is inert: every table
	 * reports in-basis and the store adapter's defensive throw governs.
	 */
	isTableInBasis(schema: string, table: string): boolean {
		return this.getTableSchema ? this.getTableSchema(schema, table) !== undefined : true;
	}

	/**
	 * Current column names for an in-basis table via the `getTableSchema` oracle, or
	 * `undefined` when the table is outside the basis (oracle returns nothing) OR no
	 * oracle was wired. Backs the drain path's basis gate + schema-drift filter (see
	 * {@link SyncContext.getTableColumnNames}). The no-oracle `undefined` makes drain
	 * a clean no-op on a relay-only coordinator, exactly as detection is inert there.
	 */
	getTableColumnNames(schema: string, table: string): readonly string[] | undefined {
		return this.getTableSchema?.(schema, table)?.columns?.map(c => c.name);
	}

	/**
	 * Accumulate unknown-table disposition stats (called by the apply path after a
	 * diverted group is successfully admitted).
	 */
	recordUnknownTable(
		disposition: UnknownTableDisposition,
		schema: string,
		table: string,
		changeCount: number,
	): void {
		if (disposition === 'quarantine') {
			this.unknownTableQuarantined += changeCount;
		} else if (disposition === 'store-and-forward') {
			this.unknownTableForwarded += changeCount;
		} else {
			this.unknownTableIgnored += changeCount;
		}
		// byTable is the union across all dispositions (the per-disposition counters
		// partition it) — accumulated unconditionally, never against `forwarded` alone.
		const key = `${schema}.${table}`;
		this.unknownTableByTable.set(key, (this.unknownTableByTable.get(key) ?? 0) + changeCount);
	}

	getUnknownTableStats(): { ignored: number; quarantined: number; forwarded: number; relayed: number; byTable: Map<string, number> } {
		return {
			ignored: this.unknownTableIgnored,
			quarantined: this.unknownTableQuarantined,
			forwarded: this.unknownTableForwarded,
			relayed: this.unknownTableRelayed,
			byTable: new Map(this.unknownTableByTable),
		};
	}

	// ============================================================================
	// Basis-table lifecycle (legacy-table retirement bookkeeping)
	// ============================================================================

	/**
	 * Record one logical schema's lens deployment over its basis, recomputing the
	 * durable per-basis-table lifecycle classification (`docs/migration.md`
	 * § 2 Converge). See {@link SyncManager.recordLensDeployment}.
	 *
	 * The snapshot is scoped to ONE logical schema, so this schema's directly-mapped
	 * contribution is stored per-schema (`mappedBy`) and the aggregate state ORs all
	 * schemas — a basis table stays `directly-mapped` until the last mapper drops it.
	 * The classification is a pure function of `(snapshot, basis schema)`, both
	 * reachable from `db`: the directly-mapped set is the union of every table
	 * snapshot's `relationBacking` keys (plus deferred surrogate-split members), and
	 * the basis membership / derivation sources come from enumerating the basis
	 * schema's tables.
	 */
	async recordLensDeployment(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): Promise<void> {
		const logical = logicalSchemaName.toLowerCase();

		// This schema's directly-mapped contribution: the union of every table
		// snapshot's basis relations. surrogateMemberKeys mark deferred surrogate-split
		// members that back the table INDIRECTLY — fold them in as referenced so a
		// deferred member is never misclassified as an eviction candidate.
		const directlyMapped = new Set<string>();
		for (const tableSnapshot of snapshot.tables.values()) {
			for (const key of tableSnapshot.relationBacking.keys()) directlyMapped.add(key);
			if (tableSnapshot.surrogateMemberKeys) {
				for (const key of tableSnapshot.surrogateMemberKeys) directlyMapped.add(key);
			}
		}

		// Enumerate the basis schema (the common case is `main`, but the basis may be
		// an attached schema — resolve by name). basisMembership = all table keys;
		// derivationSources = union of every maintained table's sourceTables.
		const basisSchema = db.schemaManager.getSchema(snapshot.basisSchemaName);
		const basisMembership = new Set<string>();
		const derivationSources = new Set<string>();
		const displayName = new Map<string, { schema: string; table: string }>();
		// Snapshot the eviction-policy tag + secondary-index names of each in-basis
		// table NOW: both are gone once the table detaches (its schema + tag vanish),
		// and the eviction sweep needs the index list to reclaim index stores by name.
		const evictPolicyByKey = new Map<string, EvictPolicy>();
		const indexNamesByKey = new Map<string, string[]>();
		if (basisSchema) {
			for (const table of basisSchema.getAllTables()) {
				const key = `${table.schemaName}.${table.name}`.toLowerCase();
				basisMembership.add(key);
				displayName.set(key, { schema: table.schemaName, table: table.name });
				for (const src of table.derivation?.sourceTables ?? []) {
					derivationSources.add(src.toLowerCase());
				}
				const policy = parseEvictPolicyTag(table.tags?.[SYNC_EVICT_TAG] ?? null);
				if (policy !== undefined) evictPolicyByKey.set(key, policy);
				const indexNames = (table.indexes ?? []).map(i => i.name);
				if (indexNames.length > 0) indexNamesByKey.set(key, indexNames);
			}
		} else if (snapshot.basisSchemaName) {
			console.warn(
				`[Sync] recordLensDeployment: basis schema '${snapshot.basisSchemaName}' not found; basis membership treated as empty`,
			);
		}

		// Basis-drift detection: warn (don't silently reclassify) when the basis hash
		// changed out-of-band vs. the last deploy we recorded for this basis.
		const priorHash = this.lastBasisHash.get(snapshot.basisSchemaName);
		if (priorHash !== undefined && priorHash !== snapshot.basisHash) {
			console.warn(
				`[Sync] recordLensDeployment: basis '${snapshot.basisSchemaName}' hash drifted out-of-band `
					+ `(recorded ${priorHash || '∅'}, current ${snapshot.basisHash || '∅'})`,
			);
		}
		this.lastBasisHash.set(snapshot.basisSchemaName, snapshot.basisHash);

		const stored = await this.basisLifecycle.getAll();

		// The universe of basis-relation keys to (re)classify: the current basis +
		// its derivation sources + this schema's directly-mapped set + every stored
		// record. directlyMapped is folded in (beyond the ticket's literal
		// membership/derivation/stored universe) so every relation the lens maps is
		// tracked even in the defensive case where the basis schema can't be resolved
		// — a no-op normally, since a mapped relation is a real basis table. Stored
		// keys keep an empty/detach deploy revisiting tables it no longer maps.
		const keys = new Set<string>([...basisMembership, ...derivationSources, ...directlyMapped, ...stored.keys()]);

		const now = Date.now();
		const batch = this.kv.batch();
		let wroteAny = false;
		const pendingEvents: BasisTableLifecycleEvent[] = [];
		// Tables transitioning detached → present this deploy: a retired table the lens
		// re-maps back into the basis. Its held out-of-basis changes should replay NOW
		// (after the lifecycle records are durable) rather than waiting on the periodic
		// sweep — the lens-redeploy sibling of the inbound-create_table reappearance path.
		const reappeared: Array<{ schema: string; table: string }> = [];

		for (const key of keys) {
			const prior = stored.get(key);

			// OR this schema's contribution into the per-schema mapper set: add when it
			// maps the table now, remove when it no longer does (so the LAST mapper
			// dropping it is what flips the aggregate off directly-mapped).
			const mapped = new Set((prior?.mappedBy ?? []).map(s => s.toLowerCase()));
			if (directlyMapped.has(key)) mapped.add(logical);
			else mapped.delete(logical);
			const mappedBy = [...mapped].sort();

			const derivationSource = derivationSources.has(key);
			const inBasis = basisMembership.has(key);
			const state = classifyBasisLifecycle(mappedBy, derivationSource, inBasis);

			// Stamp mapped-since on entry into directly-mapped (clearing any prior
			// unmapped-since); unmapped-since on exit from it (the retirement hint).
			const wasMapped = prior?.state === 'directly-mapped';
			const isMapped = state === 'directly-mapped';
			let mappedSince = prior?.mappedSince;
			let unmappedSince = prior?.unmappedSince;
			if (isMapped && !wasMapped) {
				mappedSince = now;
				unmappedSince = undefined;
			} else if (!isMapped && wasMapped) {
				unmappedSince = now;
			}

			// Stamp detached-at on entry into detached (the eviction quiet-clock
			// fallback when the table was never directly mapped); clear it on re-attach.
			const wasDetached = prior?.state === 'detached';
			const isDetached = state === 'detached';
			let detachedAt = prior?.detachedAt;
			if (isDetached && !wasDetached) detachedAt = now;
			else if (!isDetached) detachedAt = undefined;

			// Eviction override + index list: while in-basis the tag/index list are
			// authoritative (re-captured each deploy, so a removed tag clears the
			// override); once out of basis they are gone, so carry the prior record's.
			const evictPolicy = inBasis ? evictPolicyByKey.get(key) : prior?.evictPolicy;
			const indexNames = inBasis ? indexNamesByKey.get(key) : prior?.indexNames;

			const display = displayName.get(key)
				?? (prior ? { schema: prior.schema, table: prior.table } : splitRelKey(key));

			const record: BasisTableLifecycleRecord = {
				schema: display.schema,
				table: display.table,
				state,
				mappedBy,
				derivationSource,
				inBasis,
				...(mappedSince !== undefined ? { mappedSince } : {}),
				...(unmappedSince !== undefined ? { unmappedSince } : {}),
				...(detachedAt !== undefined ? { detachedAt } : {}),
				// The dynamic signal is owned by the change applicator — carry through here.
				...(prior?.lastDirectlyMappedWriteAt !== undefined ? { lastDirectlyMappedWriteAt: prior.lastDirectlyMappedWriteAt } : {}),
				...(evictPolicy !== undefined ? { evictPolicy } : {}),
				...(indexNames && indexNames.length > 0 ? { indexNames } : {}),
			};

			if (!prior || basisLifecycleRecordChanged(prior, record)) {
				this.basisLifecycle.put(batch, record);
				wroteAny = true;
			}
			// Emit only on an ACTUAL state change of an already-tracked table — a
			// brand-new table's first classification and an idempotent re-apply emit
			// nothing (a spurious event would mislead the retirement hint).
			if (prior && prior.state !== state) {
				pendingEvents.push({
					schema: record.schema,
					table: record.table,
					previousState: prior.state,
					newState: state,
					at: now,
				});
			}

			// Detached → present (any in-basis state): a previously-retired table this
			// deploy re-mapped back into the basis — its held out-of-basis changes should
			// replay now. Use the precise `detached → present` transition rather than the
			// broader "inBasis newly true": held entries only ever exist for previously
			// out-of-basis tables, so the precise check skips spurious scoped scans for
			// brand-new tables (excluded anyway by the `prior` guard). A cheapness
			// optimization, not a correctness gate — drainHeldChanges' oracle gate makes
			// any over-trigger a harmless no-op.
			if (wasDetached && !isDetached) {
				reappeared.push({ schema: record.schema, table: record.table });
			}
		}

		if (wroteAny) await batch.write();

		// Emit AFTER the records are durable, so a listener that reads back
		// getBasisTableLifecycle() sees the committed transition.
		for (const event of pendingEvents) {
			this.syncEvents.emitBasisTableLifecycle(event);
		}

		// Reactive low-latency drain (sync-drain-reappear-lens-redeploy): a table this
		// deploy re-mapped detached → present may hold out-of-basis changes waiting on it.
		// Replay them as a SEPARATE post-commit apply unit, after the lifecycle batch above
		// is durable and its events have fired, so the oracle (getTableColumnNames) sees the
		// re-attached table and the held changes LWW-resolve against the present basis —
		// instead of waiting up to one periodic-sweep interval. Symmetric with the
		// inbound-create_table path in applyChanges. Advisory: drainReappearedTables logs +
		// swallows any per-table failure, so a drain throw never aborts the deploy (which is
		// itself advisory bookkeeping — the store-module forwarder wraps it in try/catch).
		//
		// RE-ENTRANCY: in production this runs inside the firing `apply schema` statement,
		// which holds the engine exec mutex (the module `notifyLensDeployment` hook is awaited
		// mid-statement). The drain re-enters the engine via `applyToStore` →
		// `db.ingestExternalRowChanges`, which acquires that same mutex — awaiting it inline
		// would deadlock (the statement can't release the mutex until this returns). So when
		// the engine reports it is mid-statement, defer the drain to fire-and-forget: it queues
		// on the mutex and runs the instant `apply schema` commits and releases it (callers
		// observe the drained rows after the capture settle, exactly like the local-change
		// capture). Outside a live statement (e.g. unit tests over a stub store that never
		// touches the engine mutex), await inline so the drain completes before returning.
		if (reappeared.length > 0) {
			if (db._isExecuting?.()) {
				void drainReappearedTables(this, reappeared);
			} else {
				await drainReappearedTables(this, reappeared);
			}
		}
	}

	async getBasisTableLifecycle(): Promise<BasisTableLifecycleRecord[]> {
		return this.basisLifecycle.list();
	}

	/**
	 * Reclaim the local storage of every detached basis table that has been quiet
	 * past its effective retention horizon (`docs/migration.md` § 4 Contract).
	 * Host-driven (like {@link pruneTombstones} / {@link pruneQuarantine}) — the
	 * host schedules it; the library adds no timer. Returns the number of tables
	 * evicted.
	 *
	 * No-op when no `dropLocalTable` reclaim callback is wired (e.g. a relay-only
	 * coordinator with no store). For each evictable record it re-reads the record
	 * and re-checks eligibility immediately before dropping — guarding against a
	 * concurrent re-deploy that re-mapped the table between the scan and the drop —
	 * then drops the storage, emits `onBasisTableEvicted`, and clears the record. A
	 * `dropLocalTable` throw leaves the record in place to retry next sweep (the
	 * drop is idempotent).
	 */
	async evictExpiredBasisTables(now: number = Date.now()): Promise<number> {
		if (!this.dropLocalTable) return 0;

		const records = await this.basisLifecycle.list();
		let evicted = 0;
		for (const candidate of records) {
			if (!isEvictable(candidate, now, this.config)) continue;

			// Re-read + re-check immediately before the drop: a concurrent re-deploy
			// may have re-mapped (and so re-attached) the table since the scan.
			const fresh = await this.basisLifecycle.get(candidate.schema, candidate.table);
			if (!fresh || fresh.state !== 'detached' || !isEvictable(fresh, now, this.config)) continue;

			try {
				await this.dropLocalTable(fresh.schema, fresh.table, fresh.indexNames ?? []);
			} catch (error) {
				// Leave the record; retry next sweep. The drop is idempotent, so a
				// partial reclaim is re-attempted rather than stranded.
				console.warn(
					`[Sync] evictExpiredBasisTables: dropLocalTable failed for '${fresh.schema}.${fresh.table}'; `
						+ `record retained for retry: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			// Storage reclaimed — clear the record (a later re-create starts fresh) and
			// emit AFTER the drop succeeded.
			await this.basisLifecycle.delete(fresh.schema, fresh.table);
			this.syncEvents.emitBasisTableEvicted({
				schema: fresh.schema,
				table: fresh.table,
				at: now,
				quietForMs: now - quietSince(fresh),
			});
			evicted++;
		}
		return evicted;
	}

	// ============================================================================
	// Local change capture (engine transaction boundary)
	// ============================================================================

	/**
	 * Serialize commit recording: chain each commit onto the prior handler's
	 * completion so N+1's dedup reads observe N's durable writes (the change-log
	 * ordering invariant, docs/sync.md § Transaction-Based Change Grouping). The
	 * defensive `.catch` guards the tail: `handleTransactionCommit` already swallows
	 * and telemeters its own errors, but any unexpected throw must not poison the
	 * chain for every subsequent commit. Returns `void` — fire-and-forget from the
	 * engine's perspective; only inter-handler ordering changes.
	 */
	enqueueTransactionCommit(batch: TransactionCommitBatch): void {
		this.commitChain = this.commitChain
			.then(() => this.handleTransactionCommit(batch))
			.catch(error => console.error('[Sync] Commit chain link failed:', error));
	}

	/**
	 * Await the commit-recording tail — resolves once every commit enqueued so far
	 * has fully recorded (through its KV batch write). Test/diagnostic hook for
	 * deterministic draining without a timed sleep.
	 */
	whenCommitsSettled(): Promise<void> {
		return this.commitChain;
	}

	/**
	 * Record CRDT metadata for one committed local transaction.
	 *
	 * Driven by the engine's `onTransactionCommit` group — the authoritative
	 * "one transaction = one HLC" boundary. The clock is ticked exactly **once**;
	 * every fact of the transaction shares that base `(wallTime, counter, siteId)`
	 * and differs only in `opSeq` (a contiguous, 0-based sub-order). DDL is recorded
	 * before DML so migrations sort below the same transaction's data facts
	 * (docs/sync.md § DDL Application Order). All metadata for the transaction —
	 * schema migrations, column versions, tombstones, change-log entries, and the
	 * HLC clock state — lands in a single KV batch.
	 */
	private async handleTransactionCommit(batch: TransactionCommitBatch): Promise<void> {
		try {
			// Capture only LOCAL facts. An all-remote group is a pure sync-apply echo:
			// its metadata was already recorded by the apply path. A mixed group
			// (local + remote in one transaction — unusual) records only its local
			// facts; opSeq is assigned only to recorded facts so they stay contiguous.
			const localSchema = batch.schemaEvents.filter(e => !e.remote);
			const localData = this.filterCapturableDataEvents(
				batch.dataEvents.filter(e => !e.remote),
				localSchema,
			);
			if (localSchema.length === 0 && localData.length === 0) return;

			// ONE tick per committed transaction. tick() returns opSeq 0; the closure
			// below stamps each successive fact with the next opSeq off the same base.
			const base = this.hlcManager.tick();
			const transactionId = deterministicTxnId(base);

			let opSeq = 0;
			const nextHlc = (): HLC => {
				// Throw (telemetered via the catch below) rather than wrap the uint32.
				assertOpSeqInRange(opSeq);
				return createHLC(base.wallTime, base.counter, base.siteId, opSeq++);
			};

			const kvBatch = this.kv.batch();
			const changes: Change[] = [];
			// Read-your-own-writes overlay: everything staged into kvBatch is noted
			// here so a later event of the SAME transaction reads its own staged
			// metadata instead of pre-transaction storage (see
			// staged-transaction-metadata.ts). Lives for this one commit.
			const staged = new StagedTransactionMetadata((schema, table) => this.getPkKeying(schema, table));

			// DDL before DML: migrations take the lowest opSeqs.
			const versionCounters = new Map<string, number>();
			for (const event of localSchema) {
				await this.recordSchemaMigration(kvBatch, event, nextHlc, versionCounters);
			}

			for (const event of localData) {
				await this.recordDataEvent(kvBatch, event, nextHlc, changes, staged);
			}

			// Persist HLC clock state (wallTime/counter only — opSeq is never persisted).
			persistHLCStateBatch(this, kvBatch);

			await kvBatch.write();

			this.syncEvents.emitLocalChange({
				transactionId,
				changes,
				pendingSync: true,
			});
		} catch (error) {
			console.error('[Sync] Error handling transaction commit:', error);
			this.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
		}
	}

	/**
	 * Drop the data events of any table that is no longer in the local basis — the
	 * schema oracle does not know it, typically because this same transaction dropped
	 * it and the schema is already gone by the time the commit group is delivered.
	 * A schemaless table has no sound pk identity (see `metadata/pk-identity.ts`), so
	 * its rows cannot be filed.
	 *
	 * Local capture is therefore best-effort at TABLE granularity: one unknown table
	 * costs only its own rows, never the rest of the transaction (which is what the
	 * handler's top-level catch would do — it aborts recording of every other table's
	 * rows AND the transaction's schema migrations).
	 *
	 * Runs BEFORE the HLC tick, so a transaction whose data is entirely skipped and
	 * that carries no schema events consumes no clock and emits no local change,
	 * mirroring the all-remote echo early-out. Filtering up front also means no event
	 * is ever half-recorded: the throw it replaces could fire *after* a tombstone had
	 * already been staged into the shared `WriteBatch`.
	 *
	 * The gate is basis MEMBERSHIP, not "this transaction dropped the table":
	 * `drop t; create t; insert into t` carries a drop event for `t` yet leaves it in
	 * basis, and its rows must still be captured. `localSchema` is consulted only to
	 * classify the log line — an expected skip reads differently from a table that
	 * vanished for some other reason.
	 *
	 * ONLY the unknown-table case is skipped. Any other keying failure — a pk column
	 * whose collation the wired `keyNormalizerResolver` does not know, say — still
	 * throws out of `recordDataEvent` and fails the transaction loudly; silently
	 * discarding those rows would bury a real misconfiguration.
	 *
	 * A relay-only manager (no `getTableSchema` oracle) reports every table in basis,
	 * so nothing is skipped there.
	 */
	private filterCapturableDataEvents(
		events: DatabaseDataChangeEvent[],
		localSchema: DatabaseSchemaChangeEvent[],
	): DatabaseDataChangeEvent[] {
		// NOTE: one oracle lookup per ROW (a schema-map hit today, and dwarfed by the
		// per-row record work below). If `getTableSchema` ever becomes expensive, memo
		// the verdict per table for the duration of the transaction.
		const skipCounts = new Map<string, number>();
		const kept = events.filter(event => {
			if (this.isTableInBasis(event.schemaName, event.tableName)) return true;
			const tableKey = `${event.schemaName}.${event.tableName}`;
			skipCounts.set(tableKey, (skipCounts.get(tableKey) ?? 0) + 1);
			return false;
		});

		if (skipCounts.size > 0) this.logSkippedTables(skipCounts, localSchema);
		return kept;
	}

	/**
	 * Report skipped tables: ONE line per table with its change count, never one per
	 * row. A table this same transaction dropped is expected and logs informationally;
	 * anything else is a warning — the table vanished for some other reason.
	 */
	private logSkippedTables(
		skipCounts: ReadonlyMap<string, number>,
		localSchema: DatabaseSchemaChangeEvent[],
	): void {
		const droppedHere = new Set(
			localSchema
				.filter(e => e.objectType === 'table' && e.type === 'drop')
				.map(e => `${e.schemaName}.${e.objectName}`),
		);
		// NOTE: the only `console.log` in this package (everything else is warn/error) —
		// an expected skip is not a warning. If the package ever gains a real logger
		// abstraction, this is the call site that wants an `info` level.
		for (const [tableKey, count] of skipCounts) {
			if (droppedHere.has(tableKey)) {
				console.log(`[Sync] Skipped ${count} change(s) for ${tableKey} — table dropped by the same transaction`);
			} else {
				console.warn(`[Sync] Skipped ${count} change(s) for ${tableKey} — table is outside the local basis, so sync pk identity is unresolvable`);
			}
		}
	}

	/**
	 * Record one local schema-change event as a migration. Allocates an `opSeq`
	 * (via `nextHlc`) only when the event maps to a tracked migration, so
	 * unsupported object types consume no sub-order. `versionCounters` carries the
	 * running per-table schema version across this transaction's migrations.
	 */
	private async recordSchemaMigration(
		batch: WriteBatch,
		event: DatabaseSchemaChangeEvent,
		nextHlc: () => HLC,
		versionCounters: Map<string, number>,
	): Promise<void> {
		const migrationType = mapSchemaMigrationType(event.objectType, event.type);
		if (!migrationType) return;

		const { schemaName, objectName, ddl } = event;

		// `alter_column` is the only tracked type that legitimately reaches here with
		// no DDL — create/drop table and add/drop index all carry canonical text (see
		// the store module's emit sites). The migration below still records and still
		// advances the schema version (destructiveness comparison depends on it), but
		// nothing here reaches a peer, so a device that alters a table stays silently
		// diverged unless an operator sees this.
		// See tickets/backlog/feat-sync-replicate-alter-table.md.
		if (migrationType === 'alter_column' && !ddl) {
			console.warn(
				`[Sync] ${schemaName}.${objectName}: recording an ${migrationType} migration with no DDL — `
					+ `this table alteration will NOT reach other synced devices`,
			);
		}

		const counterKey = `${schemaName}.${objectName}`;
		let version = versionCounters.get(counterKey);
		if (version === undefined) {
			version = await this.schemaMigrations.getCurrentVersion(schemaName, objectName);
		}
		version += 1;
		versionCounters.set(counterKey, version);

		this.schemaMigrations.recordMigrationBatch(batch, schemaName, objectName, {
			type: migrationType,
			ddl: ddl || '',
			hlc: nextHlc(),
			schemaVersion: version,
		});
	}

	/**
	 * Record one local data-change event: a tombstone (delete) or the changed
	 * column versions (insert/update). Each recorded fact consumes one `opSeq`.
	 *
	 * All reads of the row's current metadata go overlay-first (`staged`), so a
	 * transaction that touches one row more than once records the same metadata
	 * the equivalent sequence of separate transactions would — and every write
	 * staged into `batch` is noted back into the overlay.
	 */
	private async recordDataEvent(
		batch: WriteBatch,
		event: DatabaseDataChangeEvent,
		nextHlc: () => HLC,
		changes: Change[],
		staged: StagedTransactionMetadata,
	): Promise<void> {
		const { schemaName, tableName, type, oldRow, newRow } = event;
		const pk = event.key;
		if (!pk) {
			console.warn(`[Sync] Missing primary key for ${schemaName}.${tableName} ${type} event — change not tracked`);
			return;
		}

		if (type === 'delete') {
			// Dedupe the change-log delete entry the same way columns are deduped: if a
			// prior tombstone exists for this pk (a delete→reinsert→delete key reuse —
			// staged by this same transaction, or committed), its stale delete entry
			// must go, so at most one delete entry survives per pk with HLC equal to
			// the current tombstone. This keeps collectChangesSince's boundary
			// detection (keyed on the log HLC) in lockstep with grouping (keyed on the
			// resolved tombstone HLC) — see its LOAD-BEARING INVARIANT.
			const existingHlc = staged.tombstoneHlc(schemaName, tableName, pk)
				?? (await this.tombstones.getTombstone(schemaName, tableName, pk))?.hlc;
			if (existingHlc) {
				this.changeLog.deleteEntryBatch(batch, existingHlc, 'delete', schemaName, tableName, pk);
			}

			const hlc = nextHlc();
			// Carry the row's last-known image (the engine `oldRow`) as a best-effort
			// before-image on both the persisted tombstone and the inline change. Copy
			// it so neither aliases the engine's row buffer; absent when the event
			// carried no `oldRow` (relayed/synthesized deletes).
			const priorRow: Row | undefined = oldRow ? [...oldRow] : undefined;
			this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, hlc, priorRow);
			this.changeLog.recordDeletionBatch(batch, hlc, schemaName, tableName, pk);
			// The row's column versions die here, so their change-log entries must die
			// with them — otherwise every deleted row leaves one orphan entry per column
			// behind forever (see deleteRowVersionsAndLogEntries). The cleanup stages
			// into this same `batch`, covering cells the transaction itself staged
			// (batch ordering makes these later removals win), and consults the row's
			// overlay state — captured BEFORE the notes below reset it.
			await deleteRowVersionsAndLogEntries(this, batch, schemaName, tableName, pk, {
				staged: staged.rowState(schemaName, tableName, pk),
			});
			staged.noteRowCleared(schemaName, tableName, pk);
			staged.noteTombstone(schemaName, tableName, pk, hlc);

			const change: RowDeletion = {
				type: 'delete',
				schema: schemaName,
				table: tableName,
				pk,
				hlc,
				...(priorRow !== undefined ? { priorRow } : {}),
			};
			changes.push(change);
		} else if (newRow) {
			await this.recordColumnVersions(batch, schemaName, tableName, pk, oldRow, newRow, nextHlc, changes, staged);
		}
	}

	private async recordColumnVersions(
		batch: WriteBatch,
		schemaName: string,
		tableName: string,
		pk: SqlValue[],
		oldRow: Row | undefined,
		newRow: Row,
		nextHlc: () => HLC,
		changes: Change[],
		staged: StagedTransactionMetadata,
	): Promise<void> {
		// `col_${i}` fallback below is the live path for a RELAY-ONLY manager (no
		// schema oracle at all). An oracle-wired manager can no longer reach here for
		// a table the oracle does not know — filterCapturableDataEvents skipped it.
		const columnNames = this.getTableSchema?.(schemaName, tableName)?.columns?.map(c => c.name);

		for (let i = 0; i < newRow.length; i++) {
			const oldValue = oldRow?.[i];
			const newValue = newRow[i];

			if (!oldRow || oldValue !== newValue) {
				const column = columnNames?.[i] ?? `col_${i}`;

				// Overlay first: a cell this same transaction rewrote reads its staged
				// version (so the staged entry is the one deduped, and the before-image
				// chains correctly); one it deleted reads as absent (a reinsert after a
				// delete records no before-image, exactly like a first write).
				const stagedCell = staged.columnVersion(schemaName, tableName, pk, column);
				const oldVersion: ColumnVersionData | undefined = stagedCell === null
					? undefined                                     // staged as deleted
					: stagedCell ?? await this.columnVersions.getColumnVersion(schemaName, tableName, pk, column);

				if (oldVersion) {
					this.changeLog.deleteEntryBatch(
						batch,
						oldVersion.hlc,
						'column',
						schemaName,
						tableName,
						pk,
						column
					);
				}

				const hlc = nextHlc();
				// Carry the overwritten cell version as a best-effort before-image on
				// both the persisted version and the inline change. Spread only when a
				// prior exists — first writes carry neither field (absent, not undefined).
				const prior = oldVersion
					? { priorHlc: oldVersion.hlc, priorValue: oldVersion.value }
					: undefined;
				const version: ColumnVersionData = { hlc, value: newValue, ...prior };
				this.columnVersions.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version);
				this.changeLog.recordColumnChangeBatch(batch, hlc, schemaName, tableName, pk, column);
				staged.noteColumnVersion(schemaName, tableName, pk, column, version);

				const change: ColumnChange = {
					type: 'column',
					schema: schemaName,
					table: tableName,
					pk,
					column,
					value: newValue,
					hlc,
					...prior,
				};
				changes.push(change);
			}
		}
	}

	// ============================================================================
	// Delta Sync API
	// ============================================================================

	/**
	 * Extract changes for a peer as **one {@link ChangeSet} per source
	 * transaction** (grouped by HLC identity `(wallTime, counter, siteId)`),
	 * bounded at transaction granularity by `config.batchSize`. A transaction is
	 * never split across ChangeSets and two transactions are never merged, so a
	 * consumer that advances `lastSyncHLC = ChangeSet.hlc` always lands on a real
	 * commit boundary (docs/sync.md § Transaction-Based Change Grouping → Read side).
	 */
	async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
		const dataChanges: Change[] = sinceHLC
			? await this.collectChangesSince(peerSiteId, sinceHLC, this.config.batchSize)
			: await this.collectAllChanges(peerSiteId);

		// Fold forwardable held changes (the `store-and-forward` relay's outbound
		// half) into the SAME ChangeSet[] return — no new transport surface. Each
		// keeps its ORIGINAL hlc + siteId, so buildTransactionChangeSets re-forms the
		// straggler's transaction by deterministicTxnId: a forwarded change rejoins any
		// applied part of the same straggler txn (e.g. a txn that wrote both a live and
		// a now-retired-here table), correct by construction.
		//
		// BOUND + ORDERING (verify, no extra code): collectChangesSince early-exits its
		// change-log scan at a transaction cut C; collectForwardableChanges is FULLY
		// scanned (all `> sinceHLC`). buildTransactionChangeSets re-bounds the UNION at
		// batchSize at a transaction boundary M ≤ C. Everything ≤ M from BOTH sources is
		// present (change-log up to C ⊇ ≤ M; forwardable fully scanned ⊇ ≤ M), so the
		// returned prefix is contiguous, advancing the consumer's watermark to M loses
		// nothing, and forwardable entries with HLC in (M, …] are re-collected next round
		// (still `> sinceHLC`). Groups are HLC-ordered, so a forwarded change interleaves
		// with change-log changes in global HLC order — never out of order.
		const forwardable = await this.collectForwardableChanges(peerSiteId, sinceHLC);
		const changes = forwardable.length > 0 ? [...dataChanges, ...forwardable] : dataChanges;

		const schemaMigrations = await this.collectSchemaMigrations(peerSiteId, sinceHLC);

		return buildTransactionChangeSets(
			changes,
			schemaMigrations,
			this.config.batchSize,
			(transactionId, changeCount) => {
				// Oversized transactions are returned whole (never split); telemeter
				// rather than silently chunk so the bound breach is observable.
				console.warn(
					`[Sync] Oversized transaction ${transactionId}: ${changeCount} changes exceed batchSize ${this.config.batchSize}; returned as one ChangeSet`,
				);
			},
		);
	}

	/**
	 * Delta extraction: facts after `sinceHLC`, in change-log (HLC) order, bounded
	 * at **scan time** to whole transactions whose cumulative data-change count
	 * reaches `batchSize`.
	 *
	 * The change-log scan is keyed by `(wallTime, counter, siteId, opSeq)`, so a
	 * transaction's facts arrive contiguously and transactions arrive in commit
	 * order. That lets us stop scanning as soon as enough WHOLE transactions have
	 * accumulated, instead of draining the entire iterator into memory and letting
	 * {@link buildTransactionChangeSets} truncate afterward (the pre-
	 * `sync-getchangessince-bounded-extraction` behavior, where `batchSize` capped
	 * the response but not the scan). The bound here mirrors that grouping step
	 * exactly — whole transactions accumulate until the cumulative data-change count
	 * reaches `batchSize`, never splitting a transaction — so the grouped response
	 * is byte-identical; only the scan footprint shrinks.
	 *
	 * LOAD-BEARING INVARIANT: boundary detection keys off `logEntry.hlc`, but the
	 * grouper keys off the *resolved* version's HLC ({@link resolveLogEntry} returns
	 * `cv.hlc` / `tombstone.hlc`). These agree only when each non-null-resolving log
	 * entry's HLC equals its resolved version's HLC, which holds for BOTH entry types
	 * because each is deduped on overwrite — at most one entry survives per key, and
	 * its HLC equals the current version's:
	 *   - COLUMN: an overwrite deletes the prior `(pk, column)` entry (see
	 *     {@link recordColumnVersions} and `commitChangeMetadata`), so the survivor's
	 *     HLC is the current `cv.hlc`.
	 *   - DELETE: a newer tombstone deletes the prior `pk` delete entry (see
	 *     {@link recordDataEvent} and `commitChangeMetadata`), so a
	 *     delete→reinsert→delete key reuse no longer leaves a stale entry that
	 *     re-attributes to a later tombstone HLC; the survivor's HLC is the current
	 *     `tombstone.hlc`.
	 *
	 * The overwrite dedup above covers entries written across SEPARATE writes/applies
	 * (each later one sees the prior committed version). The apply path additionally
	 * collapses in-batch repeats: two versions of one key inside a single
	 * `applyChanges` call resolve against the SAME pre-batch prior version, so neither
	 * sees the other — `commitChangeMetadata` keeps only the max-HLC winner per key and
	 * writes a single entry, preserving the invariant regardless of how many versions
	 * of a key were batched.
	 *
	 * (Schema migrations are still fully scanned by {@link collectSchemaMigrations};
	 * the `sm:` range is not HLC-ordered, but migrations are few and the grouping
	 * step drops any that sort past the bounded fact watermark.)
	 */
	private async collectChangesSince(
		peerSiteId: SiteId,
		sinceHLC: HLC,
		batchSize: number,
	): Promise<Change[]> {
		const changes: Change[] = [];
		// Data-change count over fully-scanned (whole) transactions. The in-flight
		// transaction's own count is held separately until its boundary is crossed,
		// so it is only folded in once the transaction is known to be complete.
		let completedChangeCount = 0;
		let currentTxnId: string | null = null;
		let currentTxnChangeCount = 0;

		for await (const logEntry of this.changeLog.getChangesSince(sinceHLC)) {
			// A transaction is wholly one site's, so skipping the peer's own facts
			// filters whole transactions cleanly (no half-empty ChangeSet).
			if (siteIdEquals(logEntry.hlc.siteId, peerSiteId)) continue;

			// deterministicTxnId excludes opSeq, so it is exactly the transaction
			// identity. Facts of one transaction are contiguous in the HLC-ordered
			// scan, so a change of id means the prior transaction is complete and can
			// be folded into the bound.
			const txnId = deterministicTxnId(logEntry.hlc);
			if (currentTxnId !== null && txnId !== currentTxnId) {
				completedChangeCount += currentTxnChangeCount;
				// Enough whole transactions accumulated — stop before touching the next
				// one. buildTransactionChangeSets re-applies the same bound, so feeding
				// it this prefix yields the same ChangeSets the full scan would have.
				if (completedChangeCount >= batchSize) break;
				currentTxnChangeCount = 0;
			}
			currentTxnId = txnId;

			const change = await this.resolveLogEntry(logEntry);
			if (!change) continue;
			changes.push(change);
			currentTxnChangeCount++;
		}
		return changes;
	}

	/**
	 * Resolve a change-log entry to the live {@link Change} it references, or
	 * `null` when the underlying column version / tombstone is gone — a stale log
	 * entry (e.g. a column overwritten, or a row deleted after the entry was
	 * written). The authoritative HLC, value AND pk come from the current version
	 * record, not the log key — the key carries only the lossy pk identity.
	 */
	private async resolveLogEntry(logEntry: ChangeLogEntry): Promise<Change | null> {
		if (logEntry.entryType === 'column') {
			const cv = await this.columnVersions.getColumnVersionByIdentity(
				logEntry.schema,
				logEntry.table,
				logEntry.identity,
				logEntry.column!,
			);
			if (!cv) return null;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: logEntry.schema,
				table: logEntry.table,
				pk: cv.pk,
				column: logEntry.column!,
				value: cv.value,
				hlc: cv.hlc,
				// Re-emit the stored before-image (spread only when present), so a
				// receiver/relay forwards the origin's prior chain unchanged.
				...(cv.priorHlc !== undefined ? { priorHlc: cv.priorHlc, priorValue: cv.priorValue } : {}),
			};
			return columnChange;
		}

		const tombstone = await this.tombstones.getTombstoneByIdentity(
			logEntry.schema,
			logEntry.table,
			logEntry.identity,
		);
		if (!tombstone) return null;

		const deletion: RowDeletion = {
			type: 'delete',
			schema: logEntry.schema,
			table: logEntry.table,
			pk: tombstone.pk,
			hlc: tombstone.hlc,
			// Re-emit the stored before-image (spread only when present) so a
			// receiver/relay forwards the origin's last-known row image unchanged.
			...(tombstone.priorRow !== undefined ? { priorRow: tombstone.priorRow } : {}),
		};
		return deletion;
	}

	/**
	 * Full extraction (initial sync / delta-from-zero): every column version and
	 * tombstone not originating from the peer. Ordering is owned by
	 * {@link buildTransactionChangeSets}, so no pre-sort is needed here.
	 *
	 * Unlike {@link collectChangesSince}, this path cannot early-exit at scan time:
	 * the `cv:`/`tb:` scans are keyed by table/pk, NOT by HLC, so transactions are
	 * interleaved arbitrarily and no transaction boundary is reachable without a
	 * full scan + sort. It is left unbounded because it is the from-zero path: a
	 * large initial range is expected to be served by a snapshot rather than this
	 * delta path (docs/sync.md).
	 */
	private async collectAllChanges(peerSiteId: SiteId): Promise<Change[]> {
		const changes: Change[] = [];

		const cvBounds = buildAllColumnVersionsScanBounds();
		for await (const entry of this.kv.iterate(cvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			if (siteIdEquals(cv.hlc.siteId, peerSiteId)) continue;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: parsed.schema,
				table: parsed.table,
				pk: cv.pk,
				column: parsed.column,
				value: cv.value,
				hlc: cv.hlc,
				...(cv.priorHlc !== undefined ? { priorHlc: cv.priorHlc, priorValue: cv.priorValue } : {}),
			};
			changes.push(columnChange);
		}

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const parsed = parseTombstoneKey(entry.key);
			if (!parsed) continue;

			const tombstone = deserializeTombstone(entry.value);
			if (siteIdEquals(tombstone.hlc.siteId, peerSiteId)) continue;

			const deletion: RowDeletion = {
				type: 'delete',
				schema: parsed.schema,
				table: parsed.table,
				pk: tombstone.pk,
				hlc: tombstone.hlc,
				...(tombstone.priorRow !== undefined ? { priorRow: tombstone.priorRow } : {}),
			};
			changes.push(deletion);
		}

		return changes;
	}

	/**
	 * Collect forwardable held changes to re-offer to a peer — the outbound half of
	 * the `store-and-forward` unknown-table disposition. Source is
	 * {@link QuarantineStore.listForwardable}: straggler changes this peer held
	 * because it has retired the table, marked forwardable. Each is re-offered with
	 * its ORIGINAL `hlc` + `siteId` (the straggler's fact, not a new local one) — the
	 * identity that makes the relay loop-free and convergent across hops with NO
	 * per-table peer-membership oracle (none exists): a peer that already holds the
	 * change re-holds it idempotently (HLC-keyed) and the per-peer watermark stops
	 * re-send after one exchange.
	 *
	 * Two filters, mirroring {@link collectChangesSince} / {@link collectAllChanges}:
	 *  - **Echo exclusion** — drop a change whose origin (`change.hlc.siteId`) is the
	 *    peer itself, so a straggler's fact is never echoed back to its own author.
	 *  - **Watermark filter** — when `sinceHLC` is defined (delta path), keep only
	 *    `compareHLC(change.hlc, sinceHLC) > 0`. REQUIRED: the consumer advances its
	 *    per-peer `lastSyncHLC` to `max(returned ChangeSet.hlc)`, so a round that
	 *    returned a forwarded change with HLC ≤ the watermark would REGRESS it and
	 *    trigger a re-scan/re-deliver flood. Filtering `> sinceHLC` keeps the merged
	 *    response a safe contiguous prefix — exactly the change-log contract. When
	 *    `sinceHLC` is undefined (from-zero / {@link collectAllChanges} path) there is
	 *    no lower bound, so all (origin ≠ peer) are kept.
	 *
	 * Accepted limitation (documented intent, not a defect): a straggler whose change
	 * is causally older than the holder's sync recency with a peer (`HLC ≤ sinceHLC`)
	 * is NOT relayed via this delta path — the same scalar-watermark limitation the
	 * base delta layer already has. store-and-forward targets the transitional
	 * uneven-retirement window, where the straggler's writes are recent enough to
	 * exceed holder watermarks; quarantine already prevents write loss outside it.
	 *
	 * Snapshot carve-out: forwardable entries are DELTA-ONLY. The snapshot collectors
	 * scan only `cv:`/`tb:`/`sm:` (never `qt:`), since a snapshot transfers the
	 * offering peer's OWN basis and a forwarded change is for a table that peer does
	 * not have.
	 *
	 * Full horizon-bounded scan (no early-exit), paralleling {@link collectAllChanges}:
	 * the forwardable set is bounded by the retention horizon and is EMPTY — so this
	 * is zero-cost — in the no-straggler case.
	 */
	private async collectForwardableChanges(peerSiteId: SiteId, sinceHLC?: HLC): Promise<Change[]> {
		const held = await this.quarantine.listForwardable();
		const changes: Change[] = [];
		for (const entry of held) {
			const change = entry.change;
			// Echo exclusion: the change's HLC siteId is the straggler origin.
			if (siteIdEquals(change.hlc.siteId, peerSiteId)) continue;
			// Watermark filter on the delta path (see contract above).
			if (sinceHLC && compareHLC(change.hlc, sinceHLC) <= 0) continue;
			changes.push(change);
		}
		// Relay-activity telemetry: a held entry is counted on EVERY getChangesSince
		// that re-offers it (repeatedly until GC), and the batch bound may defer some to
		// a later round (re-counted then) — so this measures relay ACTIVITY, not distinct
		// deliveries (distinct from the apply-time `forwarded` hold count).
		this.unknownTableRelayed += changes.length;
		return changes;
	}

	/**
	 * Collect schema migrations after `sinceHLC` not originating from the peer.
	 * Each migration shares its transaction's base HLC, so the grouping step
	 * rejoins it with that transaction's data facts (or forms a DDL-only ChangeSet).
	 *
	 * The `sm:` range is keyed by `{schema}.{table}:{version}`, not by HLC, so this
	 * scan cannot early-exit the way {@link collectChangesSince} does — it is drained
	 * in full even when the fact side stops early. That is acceptable because
	 * migrations are few, and {@link buildTransactionChangeSets} drops any migration
	 * that sorts past the bounded fact watermark (its DDL-only group falls beyond the
	 * `batchSize` cut), so over-scanning here costs work but never correctness. A
	 * peer with a pathological volume of un-synced DDL is the one case this leaves
	 * unbounded; see the bounded-extraction ticket's handoff.
	 */
	private async collectSchemaMigrations(
		peerSiteId: SiteId,
		sinceHLC?: HLC,
	): Promise<SchemaMigration[]> {
		const schemaMigrations: SchemaMigration[] = [];
		const smBounds = buildAllSchemaMigrationsScanBounds();
		for await (const entry of this.kv.iterate(smBounds)) {
			const parsed = parseSchemaMigrationKey(entry.key);
			if (!parsed) continue;

			const migration = deserializeMigration(entry.value);

			if (sinceHLC && compareHLC(migration.hlc, sinceHLC) <= 0) continue;
			if (siteIdEquals(migration.hlc.siteId, peerSiteId)) continue;

			schemaMigrations.push({
				type: migration.type,
				schema: parsed.schema,
				table: parsed.table,
				ddl: migration.ddl,
				hlc: migration.hlc,
				schemaVersion: migration.schemaVersion,
			});
		}
		return schemaMigrations;
	}

	// ============================================================================
	// Delegated: Change Application
	// ============================================================================

	async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
		return applyChangesImpl(this, changes);
	}

	async drainHeldChanges(schema?: string, table?: string): Promise<number> {
		return drainHeldChangesImpl(this, schema, table);
	}

	async canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean> {
		const peerState = await this.peerStates.getPeerState(peerSiteId);
		if (!peerState) {
			return false;
		}

		// Check if retention horizon covers the requested time range
		const now = Date.now();
		const sinceTime = Number(sinceHLC.wallTime);
		if (now - sinceTime > this.config.retentionHorizonMs) {
			return false;
		}

		return true;
	}

	// ============================================================================
	// Delegated: Non-Streaming Snapshots
	// ============================================================================

	async getSnapshot(): Promise<Snapshot> {
		return getSnapshotImpl(this);
	}

	async applySnapshot(snapshot: Snapshot): Promise<void> {
		return applySnapshotImpl(this, snapshot);
	}

	// ============================================================================
	// Peer State & Maintenance
	// ============================================================================

	async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
		await this.peerStates.setPeerState(peerSiteId, hlc);
	}

	async getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined> {
		const state = await this.peerStates.getPeerState(peerSiteId);
		return state?.lastSyncHLC;
	}

	async updatePeerSentState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
		await this.peerStates.setPeerSentState(peerSiteId, hlc);
	}

	async getPeerSentState(peerSiteId: SiteId): Promise<HLC | undefined> {
		return this.peerStates.getPeerSentState(peerSiteId);
	}

	/**
	 * Drop tombstones past the retention horizon, together with the change-log
	 * `delete` entry each one backs. The entry is only an index pointer at the
	 * tombstone ({@link resolveLogEntry} returns null once the tombstone is gone),
	 * so leaving it would accumulate one dead entry per delete the replica has ever
	 * seen — the delete-side twin of the column cleanup in
	 * {@link deleteRowVersionsAndLogEntries}. Both deletions share this batch.
	 */
	async pruneTombstones(): Promise<number> {
		const now = Date.now();
		let count = 0;
		const batch = this.kv.batch();

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const tombstone = deserializeTombstone(entry.value);

			if (now - tombstone.createdAt > this.config.retentionHorizonMs) {
				batch.delete(entry.key);
				const parsed = parseTombstoneKey(entry.key);
				if (parsed) {
					// Identity-based delete: the parsed key already carries the identity, so
					// no schema (which a since-retired table may no longer have) is needed.
					this.changeLog.deleteEntryByIdentityBatch(batch, tombstone.hlc, 'delete', parsed.schema, parsed.table, parsed.identity);
				} else {
					console.warn('[Sync] Unparseable tombstone key during prune — its change-log entry is left orphaned');
				}
				count++;
			}
		}

		await batch.write();
		return count;
	}

	/**
	 * GC quarantined out-of-basis straggler changes past the retention horizon —
	 * the quarantine sibling of {@link pruneTombstones}, keyed off the same
	 * `retentionHorizonMs`. A held change older than the horizon was already
	 * outside the delivery guarantee.
	 */
	async pruneQuarantine(): Promise<number> {
		const cutoff = Date.now() - this.config.retentionHorizonMs;
		return this.quarantine.pruneOlderThan(cutoff);
	}

	getEventEmitter(): SyncEventEmitterImpl {
		return this.syncEvents;
	}

	// ============================================================================
	// Delegated: Streaming Snapshot API
	// ============================================================================

	async *getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk> {
		yield* getSnapshotStreamImpl(this, chunkSize);
	}

	async applySnapshotStream(
		chunks: AsyncIterable<SnapshotChunk>,
		onProgress?: (progress: SnapshotProgress) => void
	): Promise<void> {
		return applySnapshotStreamImpl(this, chunks, onProgress);
	}

	async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
		return getSnapshotCheckpointImpl(this, snapshotId);
	}

	async *resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {
		yield* resumeSnapshotStreamImpl(this, checkpoint);
	}
}
