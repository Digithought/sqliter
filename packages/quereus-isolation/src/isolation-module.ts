import type { Database, VirtualTableModule, BaseModuleConfig, TableSchema, TableIndexSchema as IndexSchema, ModuleCapabilities, VirtualTable, BestAccessPlanRequest, BestAccessPlanResult, SchemaChangeInfo, Row, SqlValue, Schema, MappingAdvertisement, LensDeploymentSnapshot, VtabConcurrencyMode, VirtualTableConnection, BackingHost, EffectiveRowSource, UpdateResult } from '@quereus/quereus';
import { MemoryTableModule, PhysicalType, QuereusError, StatusCode, tryFoldLiteral, columnDefToSchema, isConstraintViolation } from '@quereus/quereus';
import type { IsolationModuleConfig } from './isolation-types.js';
import { IsolatedTable } from './isolated-table.js';
import { applyOverlayToUnderlying } from './flush.js';
import { makeFullScanFilterInfo } from './filter-info.js';
import { iterateEffectiveRows, makePkKeySerializer } from './overlay-rows.js';

/** Partial-index predicate AST, as `IndexSchema`/`UniqueConstraintSchema` carry it. */
type Predicate = NonNullable<IndexSchema['predicate']>;

let overlayIdCounter = 0;

/**
 * Generates a unique overlay ID for each overlay table instance.
 * Used to avoid name conflicts when multiple overlays exist.
 */
export function generateOverlayId(): number {
	return ++overlayIdCounter;
}

/**
 * Concurrency-mode strength ranking: weakest → strongest.
 * `'serial'` (0) tolerates the least; `'fully-reentrant'` (2) the most.
 * Used by {@link weakerMode} / {@link clampToReentrantReads} to compute the
 * mode `IsolationModule` forwards (see `IsolationModule.concurrencyMode`).
 */
const MODE_RANK: Record<VtabConcurrencyMode, number> = {
	serial: 0,
	'reentrant-reads': 1,
	'fully-reentrant': 2,
};

/**
 * Returns the weaker (lower-rank) of two concurrency modes. A merged read
 * through `IsolationModule` touches BOTH the underlying and the overlay table,
 * so it is only as concurrency-safe as the weaker of the two.
 */
export function weakerMode(a: VtabConcurrencyMode, b: VtabConcurrencyMode): VtabConcurrencyMode {
	return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/**
 * Caps a mode at `'reentrant-reads'`. `IsolationModule`'s own write path
 * (`IsolatedTable.update` → `ensureOverlay`, `setHasChanges`, the multi-step
 * merged-conflict checks, the savepoint sets) mutates shared per-connection
 * state non-atomically, so the wrapper is never `'fully-reentrant'` no matter
 * how reentrant the underlying/overlay are. This is the single place that
 * invariant is enforced.
 */
export function clampToReentrantReads(mode: VtabConcurrencyMode): VtabConcurrencyMode {
	return MODE_RANK[mode] > MODE_RANK['reentrant-reads'] ? 'reentrant-reads' : mode;
}

/**
 * Per-table state tracking the underlying table (shared across all connections).
 */
export interface UnderlyingTableState {
	underlyingTable: VirtualTable;
}

/**
 * Per-connection overlay state for a specific table.
 * Each connection gets its own overlay that persists across IsolatedTable instances.
 */
export interface ConnectionOverlayState {
	overlayTable: VirtualTable;
	hasChanges: boolean;
	/**
	 * The `Database` this overlay was created against — carried so
	 * {@link IsolationModule.releaseOverlayTable} can free the overlay's staging
	 * table on ANY discard path, including {@link IsolationModule.destroy} and
	 * {@link IsolationModule.closeAll}, which sweep overlays across multiple db ids
	 * and so have no single ambient `db` to hand the overlay module's `destroy`.
	 * Set at every real creation site (`ensureOverlay`, the two rebuild builders);
	 * the default `MemoryTableModule` overlay ignores it, but a host-injected
	 * `config.overlay` keyed per-db needs the overlay's OWN db, not the sweeper's.
	 */
	db: Database;
	/**
	 * Set by a cross-connection DDL that left this (foreign) overlay unflushable:
	 * an ALTER that could not migrate it to the post-alter column layout (the overlay
	 * still holds PRE-alter rows, structurally inconsistent with the now-committed
	 * schema), or a DROP TABLE that removed the table it stages rows for. Either way
	 * any data op that would merge or flush it must throw this message. Undefined =
	 * healthy. Cleared only by discarding the overlay (rollback / commit-failure →
	 * rollback).
	 */
	poison?: { message: string };
}

/**
 * Per-ALTER constants for backfilling a freshly added column into staged overlay
 * rows. Precomputed once per `addColumn` (see `deriveAddColumnBackfill`) so the
 * per-row loop only branches on tombstone / evaluator / literal.
 */
interface AddColumnBackfillContext {
	/** The folded literal DEFAULT, or `null` when there is no usable literal default. */
	foldedDefault: SqlValue;
	/** Per-row evaluator for a non-foldable `new.<col>` default; absent for a literal default. */
	evaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
	/** Whether the new column is NOT NULL (enforced on the evaluator path only). */
	newColNotNull: boolean;
	/** New column name, for the NOT NULL error message. */
	newColName: string;
	/** Owning table name, for the NOT NULL error message. */
	tableName: string;
}

/**
 * Per-ALTER constants for an `alter column … set not null` overlay migration (see
 * `deriveSetNotNullBackfill`). Precomputed once so the per-row translate/validate loops only
 * branch on tombstone / has-default. Present only for a NOT NULL *tightening* (`setNotNull: true`)
 * with staged overlays to migrate.
 *
 * NOTE: `alter column … set data type` has the SAME overlay gap — its issuer/foreign overlay
 * rows are not converted here (the underlying's rowSource covers only committed rows), so an
 * accepted retype commits staged rows still holding the OLD physical type. Closing it means
 * hooking a parallel `SetDataTypeBackfillContext` through this exact derive → validate →
 * translate seam. Tracked by `bug-isolation-retype-leaves-staged-rows-unconverted`.
 */
interface SetNotNullBackfillContext {
	/** Zero-based index of the now-NOT-NULL column in the overlay's data columns. */
	colIndex: number;
	/** The folded literal DEFAULT used to backfill staged NULLs; meaningful only when `hasDefault`. */
	foldedDefault: SqlValue;
	/** Whether a usable literal DEFAULT exists — backfill when true, reject the staged NULL when false. */
	hasDefault: boolean;
	/** Column name, for the CONSTRAINT / poison message. */
	colName: string;
	/** Owning table name, for the poison message. */
	tableName: string;
}

/**
 * A module wrapper that adds transaction isolation to any underlying module.
 *
 * The isolation layer intercepts reads and writes:
 * - Writes go to an overlay table (uncommitted changes, per-connection)
 * - Reads merge overlay with underlying data
 * - Commit flushes overlay to underlying
 * - Rollback discards overlay
 *
 * Architecture:
 * - Underlying tables are shared across all connections (one per table)
 * - Overlay tables are per-connection per-table (created lazily on first write)
 * - Each IsolatedTable instance looks up its overlay from connection-scoped storage
 *
 * This provides ACID semantics including:
 * - Read-your-own-writes within a transaction
 * - Read-committed reads of shared state (the underlying table is live and shared
 *   across connections — this is NOT snapshot isolation; another connection's commit
 *   can become visible mid-transaction, and there is no write-write conflict
 *   detection). A stable snapshot, if needed, is the underlying module's job.
 * - Savepoint support via overlay module's transaction support
 */
export class IsolationModule implements VirtualTableModule<IsolatedTable, BaseModuleConfig> {
	readonly underlying: VirtualTableModule<any, any>;
	readonly overlayModule: VirtualTableModule<any, any>;
	readonly tombstoneColumn: string;

	/** Underlying table state per table, keyed by "schemaName.tableName" */
	private readonly underlyingTables = new Map<string, UnderlyingTableState>();

	/**
	 * Per-connection overlay states, keyed by "connectionId:schemaName.tableName".
	 * The connectionId is derived from the database's transaction context.
	 */
	private readonly connectionOverlays = new Map<string, ConnectionOverlayState>();

	/**
	 * Tracks savepoint depths that were created before the overlay existed, per
	 * connection+table.  Keyed identically to connectionOverlays.
	 * When the overlay is created lazily after some savepoints already exist,
	 * its MemoryVirtualTableConnection stack needs to be padded so that
	 * rollbackToSavepoint(depth) looks up the correct stack index.
	 */
	private readonly preOverlaySavepoints = new Map<string, Set<number>>();

	/**
	 * In-flight covering-connection builds, keyed identically to
	 * {@link connectionOverlays} (`<dbId>:<schema>.<table>` via
	 * {@link makeConnectionOverlayKey}). Connection registration is a
	 * per-connection (per-db+table) invariant, not a per-wrapper one, so the memo
	 * lives here — at the layer that spans every `IsolatedTable` wrapper for one
	 * (db, table) — rather than on the wrapper instance.
	 *
	 * `IsolatedTable.ensureConnection()` `await`s the overlay `createConnection()`
	 * / the database `registerConnection()` between its covering-reuse lookup and
	 * the `registeredConnection` set. This module forwards `'reentrant-reads'` (see
	 * {@link concurrencyMode}), so the runtime may drive two concurrent
	 * merged-overlay scans of one table — and it connects a FRESH `IsolatedTable`
	 * per scan (see {@link connect}), so the two scans land on DISTINCT wrapper
	 * instances. A per-wrapper memo cannot coalesce them: both see
	 * `registeredConnection === null`, both miss the existing-covering lookup, both
	 * `registerConnection` — double-registering, which makes
	 * `DeferredConstraintQueue.findConnection()` throw on multiple covering
	 * candidates. Keying the memo per (db, table) coalesces across wrappers: the
	 * first scan to enter creates the build promise; concurrent peers `await` it
	 * and resolve to the SAME covering connection. Typed in
	 * `VirtualTableConnection` terms (not `IsolatedConnection`) to keep this module
	 * free of an `isolated-connection` import; the resolved value is an
	 * `IsolatedConnection`. Mirrors `LaminaTable.connectionInFlight`.
	 */
	private readonly connectionInFlight = new Map<string, Promise<VirtualTableConnection>>();

	/**
	 * Backing-host capability forward (engine `vtab/backing-host.ts`) — assigned in
	 * the constructor ONLY when the underlying module implements it, so method
	 * PRESENCE mirrors the underlying (presence IS the capability; a wrapper around
	 * a capability-less module must not advertise it). A straight delegate is
	 * correct: every backing write is privileged (`applyMaintenance` /
	 * `replaceContents` bypass user DML entirely), so the per-connection overlay
	 * never holds backing rows and the underlying host's pending state is the only
	 * state there is. Mid-transaction `select`s of the MV reach that pending state
	 * through the merged read (empty overlay → underlying reads-own-writes), and at
	 * commit/rollback the backing's IsolatedConnection flushes a no-op empty overlay
	 * while the host's own connection commits/rolls back the underlying pending —
	 * disjoint state, so ordering between the two is immaterial.
	 */
	getBackingHost?: (db: Database, schemaName: string, tableName: string) => BackingHost | undefined;

	/**
	 * Materialized-view backing-create capability forward
	 * (`SchemaManager.createBackingTable` prefers `createBacking?() ?? create()`)
	 * — assigned in the constructor ONLY when the underlying module implements it,
	 * so method PRESENCE mirrors the underlying, exactly like {@link getBackingHost}.
	 * The two MUST be forwarded together: this forward routes the MV backing into
	 * the underlying's durable store via its `createBacking`, so the subsequent
	 * (forwarded) {@link getBackingHost} resolves a real host. Without it, the
	 * wrapper would have no `createBacking`, `createBackingTable` would fall back to
	 * the wrapper's generic {@link create} (an ordinary underlying table), and the
	 * forwarded `getBackingHost` would find no durable host for it. The body mirrors
	 * {@link create} — wrap the underlying table in an `IsolatedTable` and record
	 * underlying state — but builds the underlying via `createBacking`. Backing
	 * writes are privileged and bypass the per-connection overlay (see
	 * {@link getBackingHost}), so the empty-overlay wrapper is correct here too.
	 */
	createBacking?: (db: Database, tableSchema: TableSchema) => Promise<IsolatedTable>;

	/** Attach-lifecycle seam forwards — assigned only when the underlying implements them,
	 *  mirroring presence so the wrapper advertises each capability iff the underlying does.
	 *  Backing writes bypass the per-connection overlay (see {@link getBackingHost}), so
	 *  these are straight delegates with no overlay bookkeeping. */
	ensureBackingForAttach?: (db: Database, schemaName: string, tableName: string, backingSchema: TableSchema) => Promise<void>;
	retireBackingForAttach?: (db: Database, schemaName: string, tableName: string, plainSchema: TableSchema) => Promise<void>;
	discardBackingForAttach?: (db: Database, schemaName: string, tableName: string) => Promise<void>;

	constructor(config: IsolationModuleConfig) {
		this.underlying = config.underlying;
		this.overlayModule = config.overlay ?? new MemoryTableModule();
		this.tombstoneColumn = config.tombstoneColumn ?? '_tombstone';

		const underlyingGetBackingHost = this.underlying.getBackingHost;
		if (underlyingGetBackingHost) {
			this.getBackingHost = (db, schemaName, tableName) =>
				underlyingGetBackingHost.call(this.underlying, db, schemaName, tableName);
		}

		const underlyingCreateBacking = this.underlying.createBacking;
		if (underlyingCreateBacking) {
			this.createBacking = async (db, tableSchema) => {
				const underlyingTable = await underlyingCreateBacking.call(this.underlying, db, tableSchema);
				const state: UnderlyingTableState = { underlyingTable };
				this.setUnderlyingState(tableSchema.schemaName, tableSchema.name, state);
				return new IsolatedTable(db, this, tableSchema.schemaName, tableSchema.name, underlyingTable);
			};
		}

		// The attach seams swap the underlying storage flavor in place (ordinary ⇄
		// durable backing) the way `set/drop maintained` does. `connect()` memoizes
		// the underlying VirtualTable per (schema,table) in `underlyingTables` and
		// re-serves the cached handle, so a bare forward would keep serving the
		// PRE-transition table after the swap (stale rows / evicted handle / stale
		// column layout). After delegating, evict the memoized state — exactly as
		// `destroy()` does — so the next `connect()` re-resolves the fresh flavor
		// from the underlying. Evict only on success: a thrown attach leaves the
		// prior flavor (and its still-valid cache) intact, and the failure-cleanup
		// path is `discardBackingForAttach`, which evicts in its own right.
		//
		// NOTE: these three seams evict `underlyingTables` without touching
		// `connectionOverlays`, unlike `destroy()`. That is safe only because writes to a
		// materialized-view backing table are privileged and bypass the overlay, so no
		// overlay is ever staged against a table that crosses a seam. If a seam ever runs
		// on a table an open transaction has staged writes for, `commitConnectionOverlays`
		// will raise its INTERNAL invariant error — give the seams the same overlay sweep
		// `destroy()` performs.
		const underlyingEnsure = this.underlying.ensureBackingForAttach;
		if (underlyingEnsure) {
			this.ensureBackingForAttach = async (db, schemaName, tableName, backingSchema) => {
				await underlyingEnsure.call(this.underlying, db, schemaName, tableName, backingSchema);
				this.removeUnderlyingState(schemaName, tableName);
			};
		}

		const underlyingRetire = this.underlying.retireBackingForAttach;
		if (underlyingRetire) {
			this.retireBackingForAttach = async (db, schemaName, tableName, plainSchema) => {
				await underlyingRetire.call(this.underlying, db, schemaName, tableName, plainSchema);
				this.removeUnderlyingState(schemaName, tableName);
			};
		}

		const underlyingDiscard = this.underlying.discardBackingForAttach;
		if (underlyingDiscard) {
			this.discardBackingForAttach = async (db, schemaName, tableName) => {
				await underlyingDiscard.call(this.underlying, db, schemaName, tableName);
				this.removeUnderlyingState(schemaName, tableName);
			};
		}
	}

	/**
	 * Forwards a concurrency-mode hint so a host that wraps a reentrant module
	 * in `IsolationModule` keeps the plan-level `concurrencySafe` it would get
	 * registering the underlying directly (read by
	 * `TableReferenceNode.computePhysical` via `getModuleConcurrencyMode`).
	 *
	 * Merged reads touch BOTH the underlying table and the overlay table (a
	 * `MemoryTable` by default, or a host-injected `config.overlay`), so the
	 * forwarded mode is the {@link weakerMode weaker} of the two — a serial
	 * underlying OR a serial custom overlay degrades the whole wrapper to
	 * `'serial'`. The result is then {@link clampToReentrantReads capped} at
	 * `'reentrant-reads'`: `IsolationModule`'s write path is never reentrant.
	 *
	 * A live getter (not a construction-time snapshot): the underlying's mode is
	 * a static module property today, but mirroring `expectedLatencyMs` — whose
	 * value is learned lazily at connect time — keeps both forwards reading live
	 * each plan. Always returns a concrete value (never `undefined`), satisfying
	 * the optional `concurrencyMode?` under `exactOptionalPropertyTypes`.
	 */
	get concurrencyMode(): VtabConcurrencyMode {
		const underlying = this.underlying.concurrencyMode ?? 'serial';
		const overlay = this.overlayModule.concurrencyMode ?? 'serial';
		return clampToReentrantReads(weakerMode(underlying, overlay));
	}

	/**
	 * Forwards the underlying module's first-row-latency planner hint so a cold
	 * `NodeFsProvider` / OPFS install's scan node carries the latency estimate
	 * through the wrapper (read by `TableReferenceNode.computePhysical`, which
	 * only lifts the value when `> 0`). The overlay is an in-memory staging table
	 * with no meaningful latency, so only the underlying contributes.
	 *
	 * Returns `0` (never `undefined`) when the underlying declares none — `0` is
	 * observably identical to omitting the hint, and a concrete value satisfies
	 * the optional `expectedLatencyMs?` under `exactOptionalPropertyTypes`. A
	 * getter, not a stored field: `LaminaModule.expectedLatencyMs` is itself a
	 * getter whose value is learned lazily at connect time, so a construction-time
	 * snapshot would capture a stale `0`.
	 */
	get expectedLatencyMs(): number {
		return this.underlying.expectedLatencyMs ?? 0;
	}

	/**
	 * Gets the underlying table state for a table.
	 */
	getUnderlyingState(schemaName: string, tableName: string): UnderlyingTableState | undefined {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		return this.underlyingTables.get(key);
	}

	/**
	 * Sets underlying table state.
	 */
	private setUnderlyingState(schemaName: string, tableName: string, state: UnderlyingTableState): void {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		this.underlyingTables.set(key, state);
	}

	/**
	 * Removes underlying table state.
	 */
	private removeUnderlyingState(schemaName: string, tableName: string): void {
		const key = `${schemaName}.${tableName}`.toLowerCase();
		this.underlyingTables.delete(key);
	}

	/**
	 * Gets the overlay state for a specific connection and table.
	 */
	getConnectionOverlay(db: Database, schemaName: string, tableName: string): ConnectionOverlayState | undefined {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		return this.connectionOverlays.get(key);
	}

	/**
	 * Sets the overlay state for a specific connection and table.
	 */
	setConnectionOverlay(db: Database, schemaName: string, tableName: string, state: ConnectionOverlayState): void {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		this.connectionOverlays.set(key, state);
	}

	/**
	 * Frees the in-memory staging (overlay) table backing `state` by calling the overlay
	 * module's `destroy`, so its manager entry (and the rows it holds) is removed from the
	 * overlay module's table registry rather than leaking there for the life of the
	 * `Database`. This is the single sink every overlay-discard path funnels through —
	 * without it, `MemoryTableModule.tables` accumulates one dead `_overlay_<table>_<id>`
	 * entry per writing transaction (and one more per rebuild), unbounded.
	 *
	 * `MemoryTableManager.destroy` rolls back the overlay's own pending layer and clears its
	 * connections; a later db-side teardown of the (now-detached) `MemoryVirtualTableConnection`
	 * is tolerated by `MemoryTableManager.disconnect` (`!connection` → no-op), so destroying
	 * here mid-commit/rollback does not throw when the connection is torn down afterwards.
	 *
	 * Defensive on a missing schema: real overlays always carry one (`createOverlaySchema`),
	 * so a schemaless state can only be a malformed/test-fabricated one — skip rather than throw.
	 */
	private async releaseOverlayTable(state: ConnectionOverlayState): Promise<void> {
		const overlaySchema = state.overlayTable.tableSchema;
		if (!overlaySchema) return;
		await this.overlayModule.destroy(
			state.db,
			undefined,
			overlaySchema.vtabModuleName,
			overlaySchema.schemaName,
			overlaySchema.name,
		);
	}

	/**
	 * Removes the overlay state for a specific connection and table, first releasing its
	 * staging table so it does not leak (see {@link releaseOverlayTable}). Async because the
	 * release drives the overlay module's `destroy`; all callers (`clearOverlay`, `alterSchema`)
	 * are already async and `await` it. Called on the rollback / alter-schema / rollback-to-
	 * pre-overlay-savepoint discard paths.
	 */
	async clearConnectionOverlay(db: Database, schemaName: string, tableName: string): Promise<void> {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		const state = this.connectionOverlays.get(key);
		if (!state) return;
		await this.releaseOverlayTable(state);
		this.connectionOverlays.delete(key);
	}

	/**
	 * Returns (creating if absent) the set of savepoint depths that pre-date the overlay
	 * for this connection+table.  Shared across all IsolatedTable instances in the
	 * same connection so that ensureOverlay() on any instance sees the correct set.
	 */
	getPreOverlaySavepoints(db: Database, schemaName: string, tableName: string): Set<number> {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		let set = this.preOverlaySavepoints.get(key);
		if (!set) {
			set = new Set();
			this.preOverlaySavepoints.set(key, set);
		}
		return set;
	}

	/** Removes the pre-overlay savepoint set for a connection+table. */
	clearPreOverlaySavepoints(db: Database, schemaName: string, tableName: string): void {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		this.preOverlaySavepoints.delete(key);
	}

	/**
	 * Returns every key of a connection-scoped map (`<dbId>:<schema>.<table>`, the
	 * shape of {@link connectionOverlays} / {@link preOverlaySavepoints} /
	 * {@link connectionInFlight}) that belongs to `schemaName.tableName`, across ALL
	 * db ids. Those maps embed the db id as a prefix, so a per-table sweep is a suffix
	 * match on `:<schema>.<table>`. Keys are stored lowercased, so the suffix is too.
	 *
	 * The keys are materialized into an array rather than yielded, so callers may
	 * delete or re-key entries while walking the result.
	 */
	private connectionScopedKeys(map: ReadonlyMap<string, unknown>, schemaName: string, tableName: string): string[] {
		const suffix = `:${schemaName}.${tableName}`.toLowerCase();
		const keys: string[] = [];
		for (const key of map.keys()) {
			if (key.endsWith(suffix)) keys.push(key);
		}
		return keys;
	}

	/**
	 * Commits every overlay this db-transaction staged as ONE coordinated two-phase
	 * flush, instead of each table flushing+committing its own underlying
	 * independently. The per-table approach tears a multi-table commit: table A's
	 * underlying `commit()` durably lands (and, for a shared-coordinator
	 * `quereus-store`, flushes *every* pending table) before table B has even
	 * applied, so a failure in B leaves A committed. See the fix ticket and
	 * `quereus-store/README` § "Atomic multi-store commit".
	 *
	 * Phase 1 (apply): for every staged overlay, begin its underlying table and
	 * apply the overlay's rows WITHOUT committing (see {@link applyOverlayToUnderlying}).
	 * For a `quereus-store` underlying, every table's writes accumulate in the
	 * module's single shared coordinator (the first `begin()` opens it; the rest are
	 * idempotent no-ops).
	 *
	 * Phase 2 (commit): once ALL overlays have applied, commit the affected
	 * underlying tables. For `quereus-store` the first `commit()` flushes every
	 * table's ops in one atomic coordinator commit — a single `AtomicBatch.write()`
	 * on a provider that exposes `beginAtomicBatch` — and the rest no-op. For an
	 * underlying with per-table transaction domains (the memory vtab), each table
	 * commits independently.
	 *
	 * On any Phase-1 error, roll back every underlying begun so far and rethrow;
	 * nothing was committed, so the transaction aborts atomically. Because all the
	 * fallible data work (constraint re-checks, injected/IO write errors) happens in
	 * Phase 1 before any commit, a data-driven abort is always clean. Full
	 * crash-atomicity across the commit phase itself is contingent on the underlying
	 * exposing a shared atomic commit domain (see docs/design-isolation-layer.md
	 * § "Commit Failure Recovery").
	 *
	 * A poisoned overlay aborts the whole commit before any apply — mirroring the
	 * per-connection `assertOverlayUsable` check, now with the added benefit that no earlier
	 * table is left committed. The overlay is left intact so the ensuing rollback discards
	 * it. Two DDLs poison: a cross-connection ALTER (rows left in the pre-alter layout) and
	 * a cross-connection DROP TABLE (the table is gone; see {@link destroy}).
	 *
	 * Driven once per db-transaction: the first `IsolatedConnection.commit()` in the
	 * database's commit loop runs this whole flush and clears every overlay, so the
	 * remaining connections find no overlay for their table and this is a no-op — no
	 * explicit "already flushed" latch is needed, the cleared-overlay state guards
	 * itself.
	 *
	 * **Invariant: every staged overlay resolves to an underlying table here, or is
	 * poisoned.** The table-lifecycle hooks are what keep that true — {@link destroy}
	 * discards or poisons the overlays of a dropped table across every connection, and
	 * {@link renameTable} re-connects the underlying under the new name whenever it re-keys
	 * an overlay onto it. The poison check above is the enforcement point: it runs BEFORE
	 * the `underlyingTables` lookup, so a dropped table's surviving foreign overlay raises
	 * its poison message rather than the orphan error below. A miss that is neither resolved
	 * nor poisoned is therefore a layer-invariant violation, not a routine condition, and is
	 * raised as `StatusCode.INTERNAL`: the alternative — dropping the staged rows and letting
	 * the commit report success — is silent data loss. Only a CLEAN overlay
	 * (`hasChanges === false`) may miss harmlessly; it staged nothing, so it is discarded.
	 */
	async commitConnectionOverlays(db: Database): Promise<void> {
		const prefix = `${this.getDbId(db)}:`;
		const entries: { key: string; state: ConnectionOverlayState; underlyingTable: VirtualTable }[] = [];
		/** Clean overlays with no underlying — never applied, but must still be cleared. */
		const orphanedCleanKeys: string[] = [];
		for (const [key, state] of this.connectionOverlays.entries()) {
			if (!key.startsWith(prefix)) continue;
			// A poisoned overlay can neither be flushed nor merged (its rows are in the
			// pre-alter column layout). Abort the whole commit before applying anything;
			// the overlay is left intact so the ensuing rollback discards it (and its
			// poison). A poisoned overlay always has hasChanges === true.
			if (state.poison) {
				throw new QuereusError(state.poison.message, StatusCode.CONSTRAINT);
			}
			// The overlay key is `<dbId>:<schema>.<table>`; the suffix after the dbId is
			// exactly the `underlyingTables` key (both lowercased).
			const underlyingKey = key.slice(prefix.length);
			const underlyingState = this.underlyingTables.get(underlyingKey);
			if (!underlyingState) {
				if (state.hasChanges) {
					throw new QuereusError(
						`Isolation layer: staged overlay '${key}' has no underlying table '${underlyingKey}' to flush. `
						+ `A table-lifecycle hook (destroy / renameTable) failed to keep the overlay and underlying maps in step.`,
						StatusCode.INTERNAL,
					);
				}
				// Staged nothing, so nothing is lost. It never reaches `entries`, so the
				// clear-loop below would not see it — collect it explicitly or it leaks.
				orphanedCleanKeys.push(key);
				continue;
			}
			entries.push({ key, state, underlyingTable: underlyingState.underlyingTable });
		}

		// Phase 1: apply every staged overlay to its underlying WITHOUT committing.
		const applied: VirtualTable[] = [];
		try {
			for (const { state, underlyingTable } of entries) {
				if (!state.hasChanges) continue;
				// Track BEFORE applying: applyOverlayToUnderlying begins the underlying up
				// front, so a mid-apply throw still needs this table in the rollback set.
				applied.push(underlyingTable);
				await applyOverlayToUnderlying(underlyingTable, state.overlayTable, this.tombstoneColumn);
			}
		} catch (error) {
			// Nothing committed yet — roll back every underlying we began so no table is
			// left half-applied, then propagate (the transaction aborts atomically). For a
			// shared-coordinator store the first rollback discards all pending ops and the
			// rest no-op. allSettled mirrors the engine's own rollback-during-abort posture
			// in database-transaction.ts (rollback failures must not mask the original error).
			await Promise.allSettled(applied.map(underlyingTable => underlyingTable.rollback?.()));
			throw error;
		}

		// Phase 2: commit the affected underlyings. For a shared-coordinator store the
		// first commit flushes all tables in one atomic batch and the rest no-op; for
		// per-table domains (memory) each commits independently.
		for (const underlyingTable of applied) {
			await underlyingTable.commit?.();
		}

		// Clear every overlay for this db — the transaction's staged state is now
		// durable (or was empty). Every key cleared here was either applied above
		// (`hasChanges`) or staged nothing; a staged overlay that could not be applied
		// threw INTERNAL before Phase 1 and never reaches this point. Subsequent
		// IsolatedConnection.commit()s in the loop find no overlay and no-op. Pre-overlay
		// savepoint sets are cleared per table by each connection's onConnectionCommit
		// (which also covers a table that has savepoints but never got an overlay).
		for (const { key, state } of entries) {
			await this.releaseOverlayTable(state);
			this.connectionOverlays.delete(key);
		}
		for (const key of orphanedCleanKeys) {
			const state = this.connectionOverlays.get(key);
			if (state) await this.releaseOverlayTable(state);
			this.connectionOverlays.delete(key);
		}
	}

	/**
	 * Coalesces concurrent covering-connection builds for one (db, table) onto a
	 * single in-flight promise, keyed identically to {@link connectionOverlays}
	 * (see {@link connectionInFlight}).
	 *
	 * On a cache hit, returns the existing in-flight build so a concurrent peer
	 * resolves to the SAME covering connection. On a miss, calls `build()` and
	 * stores the returned promise with **no `await` between the `get` and the
	 * `set`** — `build()` runs its synchronous prefix (including the
	 * covering-reuse lookup) and returns at its first `await`, so a second caller
	 * cannot interleave into the synchronous get→set region and always observes
	 * the populated memo. This holds regardless of where the build's internal
	 * `await`s fall or how microtasks order.
	 *
	 * The memo is cleared on settle (fulfil AND reject), identity-guarded so a
	 * later rebuild's promise is never clobbered by an earlier build's clear — a
	 * failed build must let the next read retry.
	 */
	coalesceConnectionBuild(
		db: Database,
		schemaName: string,
		tableName: string,
		build: () => Promise<VirtualTableConnection>,
	): Promise<VirtualTableConnection> {
		const key = this.makeConnectionOverlayKey(db, schemaName, tableName);
		const existing = this.connectionInFlight.get(key);
		if (existing) return existing;

		const inFlight = build();
		this.connectionInFlight.set(key, inFlight);
		const clear = (): void => {
			if (this.connectionInFlight.get(key) === inFlight) this.connectionInFlight.delete(key);
		};
		inFlight.then(clear, clear);
		return inFlight;
	}

	/**
	 * Creates a unique key for connection-scoped overlay storage.
	 * Uses the database instance's identity as the connection identifier.
	 */
	private makeConnectionOverlayKey(db: Database, schemaName: string, tableName: string): string {
		// Use a unique ID from the database instance or its transaction context
		// For now, we use the database's object identity via a WeakMap approach
		// But since we can't easily get a stable ID, we'll use a simple counter
		// that gets assigned to each database instance on first access
		const dbId = this.getDbId(db);
		return `${dbId}:${schemaName}.${tableName}`.toLowerCase();
	}

	/** WeakMap to assign stable IDs to database instances */
	private static dbIdMap = new WeakMap<Database, number>();
	private static nextDbId = 1;

	private getDbId(db: Database): number {
		let id = IsolationModule.dbIdMap.get(db);
		if (id === undefined) {
			id = IsolationModule.nextDbId++;
			IsolationModule.dbIdMap.set(db, id);
		}
		return id;
	}

	/**
	 * Returns capabilities combining underlying module with isolation guarantees.
	 *
	 * `ddlTransactionality` is forwarded verbatim through the spread — the wrapper
	 * NEVER upgrades it. The overlay stages DML outside the underlying module, so an
	 * underlying DDL-commit flushes only module-side ops, leaving overlay writes
	 * behind (the `bug-store-savepoint-ddl-drop-lost-insert` asymmetry). Forwarding
	 * the underlying's (pessimistic) value is the honest choice; only `isolation` /
	 * `savepoints` are augmented, since the wrapper genuinely adds those.
	 */
	getCapabilities(): ModuleCapabilities {
		const underlyingCaps = this.underlying.getCapabilities?.() ?? {};
		return {
			...underlyingCaps,
			isolation: true,
			savepoints: true,
		};
	}

	/**
	 * Forwards mapping-advertisement discovery to the underlying module.
	 *
	 * The lens compiler's advertisement resolver reaches a basis table's
	 * `vtabModule` — which is this wrapper when a memory/store basis is isolated —
	 * and calls the optional `getMappingAdvertisements` hook. A decomposition's
	 * storage/access shape is a property of the underlying basis relations and is
	 * isolation-transparent (the overlay does not change the decomposition shape),
	 * so a straight delegate is correct. Without this forward, `quereus.lens.decomp.*`
	 * tags on isolation-wrapped basis tables are silently dropped and a logical
	 * table over the decomposition fails body compilation with "no basis backing".
	 */
	getMappingAdvertisements(db: Database, basisSchema: Schema): readonly MappingAdvertisement[] {
		return this.underlying.getMappingAdvertisements?.(db, basisSchema) ?? [];
	}

	/**
	 * Forwards APPLY SCHEMA's batch-begin signal to the underlying module.
	 *
	 * APPLY SCHEMA's migration loop fires `beginSchemaBatch`/`endSchemaBatch`
	 * on the *registered* module that owns each table — which is this wrapper
	 * when a basis is isolated. A batching-capable underlying module folds the
	 * whole APPLY SCHEMA into a single substrate commit by opening a batch here
	 * that its subsequent create/destroy/alter callbacks (which IsolationModule
	 * forwards to the underlying) join. Without this forward the underlying is
	 * never reached and silently falls back to per-DDL commits.
	 *
	 * This is a straight delegate to the underlying: APPLY SCHEMA migrations are
	 * DDL against the underlying substrate, not staged data writes, so the
	 * per-connection overlays do not participate. Overlays hold uncommitted
	 * *data* writes inside a user transaction; schema DDL does not route through
	 * them, so there is nothing for the overlay/commit lifecycle to flush as
	 * part of the batch.
	 */
	async beginSchemaBatch(db: Database, schemaName: string): Promise<void> {
		await this.underlying.beginSchemaBatch?.(db, schemaName);
	}

	/**
	 * Forwards APPLY SCHEMA's batch-end signal to the underlying module.
	 * See `beginSchemaBatch` for why a straight delegate is correct.
	 */
	async endSchemaBatch(db: Database, schemaName: string, error?: unknown): Promise<void> {
		await this.underlying.endSchemaBatch?.(db, schemaName, error);
	}

	/**
	 * Forwards APPLY SCHEMA's lens deployment notification to the underlying module.
	 *
	 * A logical `apply schema X` fires `notifyLensDeployment` on the *registered*
	 * module (this wrapper when a basis is isolated), handing it the freshly
	 * deployed `LensDeploymentSnapshot` so a basis-backing module can reconcile its
	 * storage against the new lens. The deployed lens shape is a property of the
	 * declared logical/basis schemas and is isolation-transparent (the overlay does
	 * not change it), so a straight delegate is correct — mirroring the
	 * `getMappingAdvertisements` forward. Without this forward an isolation-wrapped
	 * basis module would silently never hear the deployment.
	 */
	async notifyLensDeployment(db: Database, logicalSchemaName: string, snapshot: LensDeploymentSnapshot): Promise<void> {
		await this.underlying.notifyLensDeployment?.(db, logicalSchemaName, snapshot);
	}

	/**
	 * Delegates access plan selection to the underlying module.
	 * This ensures the query planner knows about indexes and can generate
	 * appropriate FilterInfo for index scans.
	 */
	getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		if (!this.underlying.getBestAccessPlan) {
			// Return a default full scan plan if underlying doesn't implement getBestAccessPlan
			const rows = request.estimatedRows ?? 1000;
			return {
				handledFilters: request.filters.map(() => false),
				rows,
				cost: rows,
			};
		}
		return this.underlying.getBestAccessPlan(db, tableInfo, request);
	}

	/**
	 * Creates a new isolated table wrapping an underlying table.
	 *
	 * The overlay is NOT created here - it's created lazily on first write
	 * by each IsolatedTable instance, and stored in connection-scoped storage.
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<IsolatedTable> {
		// 1. Create the underlying table
		const underlyingTable = await this.underlying.create(db, tableSchema);

		// 2. Store underlying state (overlay is per-connection, created lazily)
		const state: UnderlyingTableState = { underlyingTable };
		this.setUnderlyingState(tableSchema.schemaName, tableSchema.name, state);

		// 3. Return wrapped table (overlay will be created lazily on first write).
		//    Keyed off the schema's own (schemaName, name) — the pair `underlyingTables` uses —
		//    never off the underlying table's self-reported names (see IsolatedTable's ctor doc).
		return new IsolatedTable(db, this, tableSchema.schemaName, tableSchema.name, underlyingTable);
	}

	/**
	 * Connects to an existing isolated table.
	 *
	 * Each connect() call returns a fresh IsolatedTable that shares:
	 * - The underlying table (with all connections)
	 * - The overlay table (with the same connection/transaction context)
	 *
	 * The overlay is created lazily on first write.
	 */
	async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: BaseModuleConfig,
		tableSchema?: TableSchema
	): Promise<IsolatedTable> {
		// Check for existing underlying table
		let state = this.getUnderlyingState(schemaName, tableName);

		if (!state) {
			// No existing underlying - connect to it
			const underlyingTable = await this.underlying.connect(
				db, pAux, moduleName, schemaName, tableName, options, tableSchema
			);

			state = { underlyingTable };
			this.setUnderlyingState(schemaName, tableName, state);
		}

		// When the planner requested a committed-snapshot read (committed.<table>), bypass
		// the per-connection overlay so reads reflect only persisted underlying state.
		const readCommitted = (options as { _readCommitted?: boolean } | undefined)?._readCommitted === true;

		// Return a fresh IsolatedTable instance that will look up its overlay
		// from connection-scoped storage (shared with other instances in same transaction).
		// Pass the connect-time (schemaName, tableName) — the pair `underlyingTables` is keyed
		// by — never the underlying's self-reported names (see IsolatedTable's ctor doc).
		return new IsolatedTable(db, this, schemaName, tableName, state.underlyingTable, readCommitted);
	}

	/**
	 * Destroys the underlying table, then resolves every connection's staged state for it.
	 *
	 * DROP TABLE is not transaction-scoped: the table is gone for *every* connection the
	 * moment this returns, so no overlay staging writes against it can ever be flushed.
	 * What differs is who gets told. Per overlay key matching the dropped table (both maps
	 * are keyed `<dbId>:<schema>.<table>`, so the sweep spans all db ids):
	 *
	 * - **The dropping connection's own overlay** is discarded silently. It issued the DROP;
	 *   there is nobody to notify.
	 * - **A foreign overlay with staged rows** (`hasChanges`) is **poisoned**, not swept.
	 *   Sweeping it let that connection commit against an empty overlay set and report
	 *   success after its rows were thrown away — silent cross-connection data loss. Poison
	 *   makes its next read/write/commit throw `CONSTRAINT` (see
	 *   {@link IsolatedTable.assertOverlayUsable} and the poison check at the head of
	 *   {@link commitConnectionOverlays}, which precedes the `underlyingTables` lookup and so
	 *   raises the poison message rather than the orphan INTERNAL error). An already-poisoned
	 *   overlay keeps its original message — the first cause is the one worth reporting.
	 * - **A foreign overlay with no staged rows** is discarded: it staged nothing, so nothing
	 *   is lost.
	 *
	 * `preOverlaySavepoints` is swept for every matching key whose overlay did NOT survive.
	 * A surviving poisoned overlay keeps its set: `ensureOverlay` padding still consults it,
	 * and the owning connection's `onConnectionRollback` reaps it when its failed commit
	 * rolls back. Without the sweep, an abandoned set outlived the table for the lifetime of
	 * the `Database` (nothing else is keyed to reap it once the table is gone).
	 *
	 * Nothing is discarded or poisoned until the underlying destroy SUCCEEDS. A throwing
	 * `underlying.destroy` means the table still exists, so every connection's staged
	 * writes are still flushable and every map entry must survive untouched — the same
	 * reason {@link renameTable} delegates before mutating its maps.
	 *
	 * NOTE: poison rides on the `ConnectionOverlayState`, not on its rows, so a foreign
	 * connection that later unwinds every staged row past the drop (rollback to a savepoint
	 * taken after the overlay existed) still fails its commit. Deliberately over-strict —
	 * the table is gone either way. If a caller ever needs the clean-unwind case to commit,
	 * re-evaluate the poison on `onConnectionRollbackToSavepoint` rather than special-casing
	 * here.
	 *
	 * NOTE: a connection whose own overlay was already poisoned (by another connection's
	 * ALTER) escapes that poison for this table by dropping it — the own-overlay branch
	 * deletes the state, poison and all. Correct as written: the rows it discards belong to
	 * a table this connection just asked to remove. If poison ever carries a cause that
	 * outlives the table, gate the own-overlay delete on it.
	 *
	 * NOTE: this mutates `connectionOverlays` while a foreign connection may be mid-scan in
	 * `IsolatedTable.query`'s merged branch — that scan will keep merging against an overlay
	 * whose underlying is now destroyed. The module clamps to `'reentrant-reads'`, so no
	 * in-tree host reaches it. If a host ever runs a DROP concurrently with a foreign scan,
	 * the merged iterator needs a per-scan snapshot of the overlay + underlying pair.
	 */
	async destroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		await this.underlying.destroy(db, pAux, moduleName, schemaName, tableName);
		this.removeUnderlyingState(schemaName, tableName);

		const ownKey = this.makeConnectionOverlayKey(db, schemaName, tableName);
		const survivingKeys = new Set<string>();
		for (const key of this.connectionScopedKeys(this.connectionOverlays, schemaName, tableName)) {
			const state = this.connectionOverlays.get(key)!;
			if (key !== ownKey && state.hasChanges) {
				if (!state.poison) {
					state.poison = { message: this.buildDropPoisonMessage(schemaName, tableName) };
				}
				survivingKeys.add(key);
				continue;
			}
			// Own overlay, or a foreign CLEAN one — abandoned here, so free its staging table.
			// A surviving poisoned foreign overlay is intentionally NOT released: it stays
			// installed and is freed later when its owning connection rolls back (which routes
			// through clearConnectionOverlay → releaseOverlayTable).
			await this.releaseOverlayTable(state);
			this.connectionOverlays.delete(key);
		}
		for (const key of this.connectionScopedKeys(this.preOverlaySavepoints, schemaName, tableName)) {
			if (!survivingKeys.has(key)) this.preOverlaySavepoints.delete(key);
		}
	}

	/**
	 * Inserts one staged row into a freshly built overlay, raising on anything but success.
	 *
	 * `MemoryTable.update` RETURNS a `constraint` status rather than throwing it. Every overlay
	 * rebuild loop ignored that return, so a row the new schema forbids was dropped on the floor
	 * and the transaction committed without it — silent data loss, reachable today by
	 * `alter table … add constraint … unique` over pending duplicate rows. Convert it into a
	 * throw; {@link adoptRebuiltOverlay} decides whether that means INTERNAL (the issuer, whose
	 * rows the DDL's own validation pass already accepted) or poison (a foreign connection,
	 * which must roll back).
	 */
	private async insertIntoRebuiltOverlay(
		newOverlayTable: VirtualTable,
		values: SqlValue[],
		tableName: string,
	): Promise<void> {
		// No `onConflict` is passed, so the overlay's memory module cannot answer `ignore`;
		// `UpdateResult` is then exactly `ok | constraint`.
		const result: UpdateResult = await newOverlayTable.update({ operation: 'insert', values, preCoerced: true });
		if (isConstraintViolation(result)) {
			throw new QuereusError(
				`Overlay rebuild on '${tableName}' hit a ${result.constraint} constraint: ${result.message ?? 'no message'}`,
				StatusCode.CONSTRAINT,
			);
		}
	}

	/**
	 * Runs one overlay's rebuild and installs the result, routing a CONSTRAINT failure by who
	 * owns the overlay:
	 *
	 * - **The DDL-issuing connection.** Unreachable: the row source handed to the underlying
	 *   (see {@link issuerEffectiveRows}) judged a superset of exactly these rows and accepted
	 *   them, so a rejection here means validation and migration have drifted. Raise INTERNAL —
	 *   loudly, because the alternative is the silent row loss this guard exists to end.
	 * - **A foreign connection.** Reachable and legitimate: its staged rows may violate a
	 *   constraint another connection just declared. Poison that overlay and leave it
	 *   unmigrated, so its owner errors on its next read/write/commit and rolls back. The
	 *   issuer's DDL proceeds. Mirrors the tier-3 NOT NULL handling in {@link alterTable}.
	 *
	 * A rebuild that throws leaves the OLD overlay installed either way — the new table is
	 * simply discarded.
	 */
	private async adoptRebuiltOverlay(
		key: string,
		oldState: ConnectionOverlayState,
		isIssuer: boolean,
		schemaName: string,
		tableName: string,
		ddlDescription: string,
		rebuild: () => Promise<ConnectionOverlayState>,
	): Promise<void> {
		let rebuilt: ConnectionOverlayState;
		try {
			rebuilt = await rebuild();
		} catch (e) {
			if (!(e instanceof QuereusError) || e.code !== StatusCode.CONSTRAINT) throw e;
			if (isIssuer) {
				throw new QuereusError(
					`Isolation layer: rebuilding the issuing connection's overlay for '${schemaName}.${tableName}' after `
					+ `${ddlDescription} raised: ${e.message}. That DDL's validation pass already judged a superset of these `
					+ `rows and accepted them, so validation and migration have drifted.`,
					StatusCode.INTERNAL,
					e,
				);
			}
			// Poisoned: the OLD overlay stays installed under `key` (unmigrated, unreleased) so
			// its owner errors and rolls back — do NOT release it here.
			oldState.poison = { message: this.buildRebuildPoisonMessage(schemaName, tableName, ddlDescription, e.message) };
			return;
		}
		// Rebuild succeeded: the NEW overlay replaces the OLD one under `key`, so the OLD
		// staging table is abandoned — free it (leak sink). The builders already freed a
		// HALF-built new overlay on their own throw path, so nothing is double-released.
		this.connectionOverlays.set(key, rebuilt);
		await this.releaseOverlayTable(oldState);
	}

	/**
	 * Builds the poison message stamped onto a foreign overlay whose staged rows cannot be
	 * migrated under a constraint another connection's DDL just declared (see
	 * {@link adoptRebuiltOverlay}). Companion to {@link buildAlterPoisonMessage}, which covers
	 * the `addColumn` NOT NULL backfill rejected before the underlying is touched; this one
	 * covers a UNIQUE (or any other) violation raised by the rebuild itself.
	 */
	private buildRebuildPoisonMessage(schemaName: string, tableName: string, ddlDescription: string, cause: string): string {
		return `Another connection's ${ddlDescription} on '${schemaName}.${tableName}' declared a constraint this connection's `
			+ `uncommitted rows violate (${cause}); roll back this transaction.`;
	}

	/**
	 * Builds the poison message stamped onto a foreign overlay whose table was dropped out
	 * from under it (see {@link destroy}). Names the schema.table so the owning connection's
	 * eventual read/write/commit error is self-explanatory. Companion to
	 * {@link buildAlterPoisonMessage}: both poison sources raise the same
	 * `StatusCode.CONSTRAINT` and are told apart by their message, not their code.
	 */
	private buildDropPoisonMessage(schemaName: string, tableName: string): string {
		return `Table '${schemaName}.${tableName}' was dropped by another connection while this connection had uncommitted changes staged for it; roll back this transaction.`;
	}

	/**
	 * Closes all resources held by the underlying module (if it supports closeAll).
	 * Also clears connection overlay state.
	 */
	async closeAll(): Promise<void> {
		// Free every overlay's staging table before dropping the map. The default
		// MemoryTableModule overlay is discarded with this wrapper, but a host-injected
		// SHARED config.overlay would otherwise retain one dead entry per open overlay —
		// each state carries its own db so the release targets the right one.
		for (const state of this.connectionOverlays.values()) {
			await this.releaseOverlayTable(state);
		}
		this.connectionOverlays.clear();
		this.preOverlaySavepoints.clear();
		this.underlyingTables.clear();
		const underlyingWithClose = this.underlying as { closeAll?: () => Promise<void> };
		if (typeof underlyingWithClose.closeAll === 'function') {
			await underlyingWithClose.closeAll();
		}
	}

	/**
	 * The rows the connection owning `overlayState` can SEE — the underlying's committed rows
	 * merged with that overlay's staged writes. Re-callable, as `EffectiveRowSource` requires.
	 *
	 * This is the seam the whole fix turns on: the underlying module validates row-content DDL
	 * (UNIQUE duplicate detection, collation-rekey collisions) against its OWN rows, which under
	 * isolation are the committed rows only. The transaction's pending rows live here, in the
	 * overlay, where the underlying cannot reach them — so we hand them down.
	 *
	 * NOTE: each call re-materializes the overlay and re-scans the underlying. `alter column …
	 * set collate` calls once per UNIQUE constraint covering the altered column, so a table with
	 * many such constraints pays that many scans. If it ever shows up as slow, materialize the
	 * overlay's PK map once per DDL and share it across the calls.
	 */
	private effectiveRowsFor(
		db: Database,
		underlyingTable: VirtualTable,
		overlayState: ConnectionOverlayState,
	): EffectiveRowSource {
		const schema = underlyingTable.tableSchema;
		if (!schema) {
			throw new QuereusError('Isolation layer: underlying table has no schema', StatusCode.INTERNAL);
		}
		const pkIndices = schema.primaryKeyDefinition.map(pkDef => pkDef.index);
		const pkKeyOf = makePkKeySerializer(db, schema);
		const overlayTable = overlayState.overlayTable;
		return () => iterateEffectiveRows(underlyingTable, overlayTable, this.tombstoneColumn, pkIndices, pkKeyOf);
	}

	/**
	 * The row source to hand a row-validating DDL on behalf of the connection issuing it, or
	 * undefined when that connection has nothing staged and the underlying's own rows already
	 * ARE its effective rows.
	 *
	 * **Only the issuing connection's overlay feeds validation.** A foreign connection's
	 * overlay may hold rows that collide with the new constraint; that is its problem when it
	 * commits, exactly as an ordinary concurrent duplicate insert would be. A poisoned issuer
	 * overlay is likewise skipped — its rows are structurally stale, and the connection can
	 * only recover by rolling back.
	 */
	private issuerEffectiveRows(
		db: Database,
		schemaName: string,
		tableName: string,
		underlyingTable: VirtualTable,
	): EffectiveRowSource | undefined {
		const overlayState = this.getConnectionOverlay(db, schemaName, tableName);
		if (!overlayState || overlayState.poison || !overlayState.hasChanges) return undefined;
		return this.effectiveRowsFor(db, underlyingTable, overlayState);
	}

	/**
	 * Creates an index on the underlying table, then rebuilds every per-connection overlay so
	 * the new index (and, for a UNIQUE index, the constraint derived from it) is enforced for
	 * the rest of each open transaction.
	 *
	 * Two things the underlying cannot do for itself:
	 *
	 * 1. **Judge the right rows.** The issuing connection's pending rows are in its overlay,
	 *    invisible to the underlying, so a duplicate it staged would slip past the build and a
	 *    duplicate it deleted would spuriously reject it. {@link issuerEffectiveRows} supplies
	 *    the merged view; the underlying builds its physical structure from its own committed
	 *    rows, which is sound because every reader resolves an index entry back to its live row.
	 * 2. **Enforce the new constraint.** An overlay built before the index knows nothing of it,
	 *    and `IsolatedTable.findMergedUniqueConflict` only scans the underlying — so a pending
	 *    row colliding with another pending row is nobody's job until the overlay itself carries
	 *    the index. Hence the rebuild, which is also what gives a merged secondary-index scan
	 *    later in the transaction an overlay that can serve it.
	 *
	 * We use the stored table instance's createIndex() rather than the module-level method so
	 * that the MemoryTable's local tableSchema property stays in sync. That property is what
	 * ensureOverlay() reads when building the overlay schema.
	 */
	async createIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: IndexSchema,
		rows?: EffectiveRowSource,
	): Promise<void> {
		const state = this.getUnderlyingState(schemaName, tableName);
		// An outer wrapper's row source, if any, already names the effective rows; otherwise
		// build our own from the issuing connection's overlay.
		const rowSource = rows ?? (state ? this.issuerEffectiveRows(db, schemaName, tableName, state.underlyingTable) : undefined);

		if (state?.underlyingTable.createIndex) {
			// Instance-level createIndex keeps MemoryTable.tableSchema fresh
			await state.underlyingTable.createIndex(indexSchema, rowSource);
		} else if (this.underlying.createIndex) {
			await this.underlying.createIndex(db, schemaName, tableName, indexSchema, rowSource);
		} else {
			return; // underlying does not support indexes; nothing was created, nothing to rebuild
		}
		if (!state) return;

		const updatedSchema = this.assertIndexPresent(state.underlyingTable, schemaName, tableName, indexSchema.name);
		await this.rebuildOverlaysForIndexChange(db, schemaName, tableName, updatedSchema, `create index '${indexSchema.name}'`);
	}

	/**
	 * Reads back the underlying table instance's post-`createIndex` schema, asserting it now
	 * carries the new index.
	 *
	 * Both bundled underlyings refresh the instance's cached `tableSchema` (memory through
	 * `MemoryTable.createIndex`, the store through `StoreTable.updateSchema`), and the overlay
	 * rebuild below copies its index/constraint set from it. A third-party underlying that
	 * refreshed only its module-level schema would silently rebuild overlays under the PRE-index
	 * schema, re-opening the very hole this method exists to close — so assert rather than assume.
	 */
	private assertIndexPresent(
		underlyingTable: VirtualTable,
		schemaName: string,
		tableName: string,
		indexName: string,
	): TableSchema {
		const updatedSchema = underlyingTable.tableSchema;
		const present = updatedSchema?.indexes?.some(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (!updatedSchema || !present) {
			throw new QuereusError(
				`Isolation layer: underlying table '${schemaName}.${tableName}' did not refresh its cached tableSchema after `
				+ `creating index '${indexName}'. The per-connection overlays cannot adopt an index the underlying does not `
				+ `report; the underlying module must refresh VirtualTable.tableSchema in createIndex.`,
				StatusCode.INTERNAL,
			);
		}
		return updatedSchema;
	}

	/**
	 * Drops an index on the underlying table.
	 *
	 * Mirrors createIndex: when the underlying VirtualTable exposes an
	 * instance-level dropIndex (e.g. MemoryTable, which forwards to its manager
	 * so MemoryTable.tableSchema stays fresh), prefer that. Otherwise fall back
	 * to the module-level dropIndex (e.g. StoreModule, which refreshes the
	 * StoreTable's cached tableSchema and tears down the index store).
	 *
	 * Any per-connection overlay that already exists for this table is
	 * rebuilt under the post-drop schema, preserving staged rows. A bare
	 * forward to `overlay.dropIndex` is insufficient: when the overlay's
	 * MemoryTable has an active write `TransactionLayer`, its
	 * `tableSchemaAtCreation` is frozen at layer-creation time, so the
	 * synthesized UNIQUE constraint keeps firing inside the overlay's
	 * own UC check on the next write even after the manager's schema is
	 * refreshed. Rebuilding gives the new MemoryTable a fresh
	 * transaction layer that captures the post-drop schema. Overlays
	 * created AFTER this point inherit the post-drop schema from the
	 * underlying at ensureOverlay time.
	 */
	async dropIndex(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string
	): Promise<void> {
		const state = this.getUnderlyingState(schemaName, tableName);
		if (state?.underlyingTable.dropIndex) {
			await state.underlyingTable.dropIndex(indexName);
		} else if (this.underlying.dropIndex) {
			await this.underlying.dropIndex(db, schemaName, tableName, indexName);
		}

		// After the underlying drop, state.underlyingTable.tableSchema reflects the
		// post-drop schema. Rebuild every affected overlay against that schema so
		// the synthesized UC is fully gone from the overlay's transaction layer.
		const updatedSchema = state?.underlyingTable.tableSchema;
		if (!updatedSchema) return;

		await this.rebuildOverlaysForIndexChange(db, schemaName, tableName, updatedSchema, `drop index '${indexName}'`);
	}

	/**
	 * Rebuilds every non-poisoned per-connection overlay of one table under a schema whose
	 * index / constraint set just changed (CREATE INDEX or DROP INDEX). Shared because the two
	 * directions differ only in which structures the new schema carries — the column layout is
	 * identical either way, so staged rows copy verbatim.
	 *
	 * A poisoned overlay (from a cross-connection ALTER, or a DROP TABLE) holds rows in the
	 * pre-alter column layout, narrower/wider than `updatedSchema`. Rebuilding it would copy
	 * layout-mismatched rows AND drop the poison flag (the new state carries none), silently
	 * un-poisoning a connection that must still roll back. Leave it as-is.
	 */
	private async rebuildOverlaysForIndexChange(
		db: Database,
		schemaName: string,
		tableName: string,
		updatedSchema: TableSchema,
		ddlDescription: string,
	): Promise<void> {
		const ownKey = this.makeConnectionOverlayKey(db, schemaName, tableName);
		for (const key of this.connectionScopedKeys(this.connectionOverlays, schemaName, tableName)) {
			const overlayState = this.connectionOverlays.get(key)!;
			if (overlayState.poison) continue;
			await this.adoptRebuiltOverlay(
				key,
				overlayState,
				key === ownKey,
				schemaName,
				tableName,
				ddlDescription,
				() => this.rebuildOverlayForIndexChange(db, overlayState, updatedSchema),
			);
		}
	}

	/**
	 * Rebuilds an overlay table under a post-CREATE/DROP-INDEX schema, preserving staged rows
	 * (including tombstones). Column layout is unchanged by either, so rows copy verbatim — but
	 * the new overlay's index/constraint set is not, so an insert here can legitimately raise
	 * UNIQUE (a foreign connection staged two rows the new index forbids).
	 */
	private async rebuildOverlayForIndexChange(
		db: Database,
		oldState: ConnectionOverlayState,
		updatedSchema: TableSchema,
	): Promise<ConnectionOverlayState> {
		const oldOverlay = oldState.overlayTable;

		const newOverlaySchema = this.createOverlaySchema(updatedSchema);
		const newOverlayTable = await this.overlayModule.create(db, newOverlaySchema);
		const newState: ConnectionOverlayState = { overlayTable: newOverlayTable, hasChanges: oldState.hasChanges, db };

		try {
			if (oldState.hasChanges && oldOverlay.query) {
				for await (const oldRow of oldOverlay.query(makeFullScanFilterInfo())) {
					await this.insertIntoRebuiltOverlay(newOverlayTable, oldRow as SqlValue[], updatedSchema.name);
				}
			}
		} catch (e) {
			// A mid-copy throw (e.g. a UNIQUE the new index forbids) abandons this freshly
			// built overlay: adoptRebuiltOverlay keeps the OLD overlay installed on its throw
			// path and never sees this handle, so free it here or it leaks.
			await this.releaseOverlayTable(newState);
			throw e;
		}

		return newState;
	}

	/**
	 * Delegates ALTER TABLE to the underlying module and migrates any per-connection
	 * overlays to the post-alter schema without discarding staged rows.
	 *
	 * ADD COLUMN  — appends the new column's value to each overlay row's data columns,
	 *               backfilled per row exactly as the committed path does (literal default,
	 *               per-row `new.<col>` evaluator, or NULL); tombstone rows get NULL.
	 * DROP COLUMN — removes the dropped column from each overlay row.
	 * RENAME / ALTER COLUMN — data column indices are unchanged; only schema metadata rotates.
	 *
	 * **Atomicity guarantee.** DDL through Quereus is not transaction-scoped and the
	 * underlying (shared, committed) base auto-commits its mutation immediately —
	 * there is no frame to unwind, and `dropColumn` / type-converting `alterColumn`
	 * are lossy and not invertible, so "revert the underlying on overlay-migration
	 * failure" is not viable. Instead this method **pre-validates** every affected
	 * overlay's backfill (the per-row NOT NULL check and the tombstone-present guard)
	 * BEFORE calling `underlying.alterTable`. A rejection therefore fires while the
	 * underlying, the schema catalog, and every overlay are still untouched, so the
	 * ALTER either fails clean or fully applies — base/catalog can no longer diverge.
	 * This mirrors the engine's pre-mutation `validateNotNullBackfill` in
	 * `runtime/emit/alter-table.ts`.
	 *
	 * **Row-content validation.** The row-validating arms (`add constraint … unique`,
	 * `alter column … set collate`) judge the ISSUING connection's effective rows, not the
	 * underlying's committed ones — see {@link issuerEffectiveRows}. The underlying runs that
	 * check before it mutates anything, so the atomic-abort guarantee above still holds.
	 */
	async alterTable(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		if (!this.underlying.alterTable) {
			throw new QuereusError(
				`Underlying module does not support ALTER TABLE for '${schemaName}.${tableName}'`,
				StatusCode.UNSUPPORTED,
			);
		}

		// Partition affected overlays into the ISSUER's own (the connection that issued
		// the ALTER) and FOREIGN ones (other open connections). The issuer staged both
		// the data and the DDL, so its own un-backfillable overlay aborts the ALTER up
		// front (atomic); a foreign un-backfillable overlay must not — it is poisoned and
		// left for its owning connection to error on, while the issuer's ALTER proceeds.
		// Already-poisoned overlays (own or foreign) are skipped entirely: they hold rows
		// from before an earlier ALTER, stay poisoned, and must not be re-read/migrated.
		const ownKey = this.makeConnectionOverlayKey(db, schemaName, tableName);
		let ownEntry: [string, ConnectionOverlayState] | undefined;
		const foreign: [string, ConnectionOverlayState][] = [];
		for (const key of this.connectionScopedKeys(this.connectionOverlays, schemaName, tableName)) {
			const state = this.connectionOverlays.get(key)!;
			// An already-poisoned overlay (from an earlier ALTER) holds pre-alter rows and must
			// never be re-read or migrated — checked BEFORE the ownKey split so the poisoned
			// connection's OWN later ALTER cannot route its overlay through migration, which
			// would silently clear the poison and rebuild a layout-mismatched overlay. A
			// poisoned connection recovers only by rolling back, regardless of who issues the ALTER.
			if (state.poison) continue;
			if (key === ownKey) {
				ownEntry = [key, state];
			} else {
				foreign.push([key, state]);
			}
		}

		// Overlays we will actually migrate forward (issuer-own first). The shared
		// dropColumn index is probed from one of these, never from a skipped poisoned
		// overlay whose schema may be a stale pre-alter layout.
		const toMigrate = ownEntry ? [ownEntry, ...foreign] : foreign;

		// For dropColumn we need the pre-alter column index, readable from any
		// to-be-migrated overlay's schema.
		let dropColumnIdx: number | undefined;
		if (change.type === 'dropColumn' && toMigrate.length > 0) {
			const overlaySchema = toMigrate[0][1].overlayTable.tableSchema;
			dropColumnIdx = overlaySchema?.columnIndexMap.get(change.columnName.toLowerCase());
		}

		// Build the addColumn backfill context up front (undefined for other change types).
		// Derived purely from `change` + the session nullability option — no post-alter
		// schema needed — so it is valid here, before the underlying is mutated, and the
		// same context drives the post-mutation migration.
		const addColumnCtx = this.deriveAddColumnBackfill(change, db, tableName);

		// Build the setNotNull backfill context (undefined unless this is a NOT NULL tightening
		// with overlays to migrate). The now-NOT-NULL column's index and folded DEFAULT are read
		// from a to-be-migrated overlay's PRE-alter schema — the same layout every migrated overlay
		// shares, and the same source `dropColumnIdx` uses above.
		const setNotNullCtx = this.deriveSetNotNullBackfill(change, toMigrate, tableName);

		// Tier 2: validate the ISSUER's own overlay BEFORE mutating the shared underlying.
		// Any throw here (CONSTRAINT backfill or INTERNAL tombstone guard) propagates while
		// underlying + catalog + every overlay are still untouched — the companion ticket's
		// atomic-abort guarantee, preserved unchanged for the issuer.
		if (ownEntry) {
			await this.validateOverlayMigration(ownEntry[1], addColumnCtx, setNotNullCtx);
		}

		const underlyingState = this.getUnderlyingState(schemaName, tableName);

		// Hand the underlying the issuer's effective rows so its own row-content checks
		// (`add constraint … unique`, `alter column … set collate`) see the transaction's
		// pending rows and skip the ones it has deleted. An outer wrapper's source wins if
		// one was supplied.
		const rowSource = rows ?? (underlyingState
			? this.issuerEffectiveRows(db, schemaName, tableName, underlyingState.underlyingTable)
			: undefined);

		const updated = await this.underlying.alterTable(db, schemaName, tableName, change, rowSource);

		// The cached underlying VirtualTable's `tableSchema` is a construction-time
		// snapshot (e.g. MemoryTable.tableSchema); module-level alterTable rotates the
		// underlying manager's schema but not this instance's field. Refresh it so a
		// freshly-connected IsolatedTable's merged-view UNIQUE check (which reads
		// this.tableSchema.uniqueConstraints / per-column collation) sees the post-alter
		// constraint set. Mirrors the implicit instance refresh dropIndex already gets.
		if (underlyingState) underlyingState.underlyingTable.tableSchema = updated;

		const ddlDescription = `alter table (${change.type})`;

		// Migrate the issuer's own overlay (already validated above). Its NOT NULL /
		// tombstone throw sites are unreachable after pre-validation; so is a UNIQUE
		// rejection, which `rowSource` already judged — {@link adoptRebuiltOverlay} raises
		// INTERNAL if one fires anyway rather than dropping the row.
		if (ownEntry) {
			await this.adoptRebuiltOverlay(
				ownEntry[0], ownEntry[1], true, schemaName, tableName, ddlDescription,
				() => this.migrateOverlayForAlter(db, ownEntry![1], updated, change, dropColumnIdx, addColumnCtx, setNotNullCtx),
			);
		}

		// Tier 3: per FOREIGN overlay, validate then migrate — but a per-row NOT NULL
		// (CONSTRAINT) failure poisons that one overlay instead of aborting the issuer's
		// ALTER, as does a UNIQUE the migration itself raises (its staged rows may violate a
		// constraint the issuer just declared). An INTERNAL failure (e.g. missing tombstone
		// column) is a layer-invariant violation, not a data condition, so it rethrows loud
		// for everyone. Both phases run per overlay, so one bad foreign overlay poisons only
		// itself; healthy peers still migrate.
		for (const [key, oldState] of foreign) {
			try {
				await this.validateOverlayMigration(oldState, addColumnCtx, setNotNullCtx);
			} catch (e) {
				if (e instanceof QuereusError && e.code === StatusCode.CONSTRAINT) {
					oldState.poison = { message: this.buildAlterPoisonMessage(schemaName, tableName, change) };
					continue; // poisoned — do NOT migrate; leave pre-alter rows in place
				}
				throw e;
			}
			await this.adoptRebuiltOverlay(
				key, oldState, false, schemaName, tableName, ddlDescription,
				() => this.migrateOverlayForAlter(db, oldState, updated, change, dropColumnIdx, addColumnCtx, setNotNullCtx),
			);
		}

		return updated;
	}

	/**
	 * Builds the poison message stamped onto a foreign overlay whose backfill could not
	 * satisfy a cross-connection ALTER (see {@link alterTable} tier 3). Names the
	 * schema.table and the offending column so the owning connection's eventual
	 * read/write/commit error is self-explanatory. Poison arises on the addColumn NOT NULL
	 * path (a new NOT-NULL column with no usable default) and the `set not null` tightening
	 * path (a staged NULL with no usable default); other change types never reach here but
	 * are handled defensively.
	 */
	private buildAlterPoisonMessage(schemaName: string, tableName: string, change: SchemaChangeInfo): string {
		if (change.type === 'addColumn') {
			return `ALTER on '${schemaName}.${tableName}' added column '${change.columnDef.name}' (NOT NULL) that this connection's uncommitted row cannot satisfy; roll back this transaction.`;
		}
		if (change.type === 'alterColumn') {
			return `ALTER on '${schemaName}.${tableName}' tightened column '${change.columnName}' to NOT NULL, which this connection's uncommitted row violates; roll back this transaction.`;
		}
		return `ALTER on '${schemaName}.${tableName}' cannot migrate this connection's uncommitted rows; roll back this transaction.`;
	}

	/**
	 * Renames a table through the isolation layer.
	 *
	 * Forwards to the underlying module so it can re-key its handles and move
	 * any physical storage, then re-keys our own tracking maps so subsequent
	 * connect() calls under the new name find the existing underlying state
	 * and any in-flight per-connection overlays.
	 *
	 * Done in this order so a failure in the underlying rename leaves our
	 * internal maps untouched (the engine will not update the schema catalog
	 * if this method throws).
	 *
	 * **Why the underlying is re-connected, not re-keyed.** A rename mid-transaction
	 * moves any staged overlay onto the new name, and `commitConnectionOverlays`
	 * resolves an overlay's underlying by that name. Simply re-keying
	 * `underlyingTables` old→new would be cheaper, but the cached `VirtualTable` may
	 * be dead: `StoreModule.renameTable` closes and re-opens the store, so the stale
	 * handle yields "store is closed". So we evict it and, when an overlay was
	 * carried onto the new name, immediately connect a fresh underlying under that
	 * name — otherwise the transaction commits against a table that is in neither
	 * map, and the overlay's rows vanish (see {@link commitConnectionOverlays}'s
	 * invariant). With no overlay carried over there is nothing to flush, so the
	 * eviction alone is enough and the next `connect()` re-resolves lazily.
	 */
	async renameTable(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void> {
		// Read the catalog entry BEFORE anything mutates: `runtime/emit/alter-table.ts`
		// calls this hook ahead of the catalog swap, so the table is still registered
		// under `oldName` here. It carries the vtab module name / args that
		// `reconnectUnderlyingAfterRename` needs — the hook's own signature has neither.
		const preRenameSchema = db.schemaManager.getTable(schemaName, oldName);

		if (this.underlying.renameTable) {
			await this.underlying.renameTable(db, schemaName, oldName, newName);
		}

		// Drop our cached underlying VirtualTable for the old name. It may have
		// been disconnected by the underlying module (e.g. StoreModule closes
		// and re-opens stores during rename), so reusing it would yield "store
		// is closed" errors.
		this.removeUnderlyingState(schemaName, oldName);

		// Re-key per-connection overlay state, preserving the connection-id prefix so
		// overlays created earlier in an open transaction remain visible under the new
		// name — the commit flush resolves an overlay's underlying by current name.
		const movedOverlays = this.rekeyConnectionScopedMap(this.connectionOverlays, schemaName, oldName, newName);

		// `preOverlaySavepoints` is deliberately NOT re-keyed. The set's own maintainers —
		// the savepoint/commit/rollback callbacks on the already-registered
		// IsolatedConnection — resolve the name the IsolatedTable was constructed with,
		// which stays `oldName` for the life of the transaction. Moving the set to
		// `newName` would strand it: the old-name instance clears a key that no longer
		// exists and the moved set survives into the next transaction, where a matching
		// `rollback to savepoint` depth would wrongly discard the whole overlay.
		// Nothing needs carrying over: the first statement after the rename connects a
		// fresh IsolatedTable under `newName`, whose ensureConnection() registers a new
		// IsolatedConnection, and `Database.registerConnection` replays the active
		// savepoint stack onto it. If no overlay was carried across, that replay rebuilds
		// the depth set under the new name from scratch; if one was, the replay adds
		// nothing (the depths no longer pre-date an overlay) and the overlay's own
		// registered connection already holds a snapshot per active depth, taken when
		// `ensureOverlay` pre-registered it.

		if (movedOverlays > 0) {
			await this.reconnectUnderlyingAfterRename(db, schemaName, newName, preRenameSchema);
		}
	}

	/**
	 * Forward the engine's post-propagation rename finalize to the underlying (see
	 * {@link renameTable} for the two-phase split). The underlying (e.g. `StoreModule`)
	 * uses it to drop the old name's catalog entry only after the cross-table rewrites
	 * `propagateTableRename` enqueued are durable. `IsolationModule` owns no persistent
	 * catalog of its own and already evicted every old-name state in `renameTable`, so
	 * it simply delegates.
	 */
	async finalizeRename(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void> {
		await this.underlying.finalizeRename?.(db, schemaName, oldName, newName);
	}

	/**
	 * Connects a fresh underlying table under the post-rename name and records it in
	 * `underlyingTables`, restoring the "every staged overlay resolves to an underlying"
	 * invariant that {@link renameTable}'s eviction would otherwise break.
	 *
	 * `preRenameSchema` is the catalog's pre-rename `TableSchema`; it is cloned under the
	 * new name so the underlying module sees the same column layout, PK, and vtab args it
	 * was created with.
	 *
	 * NOTE: `pAux` is passed as `undefined`: the aux data the engine hands
	 * `IsolationModule.connect()` belongs to *this* wrapper's registration, not the
	 * underlying's, and both bundled underlyings (`MemoryTableModule`, `StoreModule`)
	 * ignore the parameter — the same assumption `connect()` already relies on when it
	 * forwards its own caller's `pAux` straight through. If a third-party underlying ever
	 * reads `pAux` in `connect()`, `IsolationModule` must capture the underlying's own aux
	 * data at registration and hand it back here.
	 */
	private async reconnectUnderlyingAfterRename(
		db: Database,
		schemaName: string,
		newName: string,
		preRenameSchema: TableSchema | undefined,
	): Promise<void> {
		if (!preRenameSchema) {
			throw new QuereusError(
				`Isolation layer: cannot re-resolve underlying table for renamed '${schemaName}.${newName}' — `
				+ `no catalog entry for the pre-rename name, and a staged overlay depends on it.`,
				StatusCode.INTERNAL,
			);
		}
		const renamedSchema: TableSchema = { ...preRenameSchema, name: newName };
		const underlyingTable = await this.underlying.connect(
			db,
			undefined,
			preRenameSchema.vtabModuleName,
			schemaName,
			newName,
			preRenameSchema.vtabArgs ?? {},
			renamedSchema,
		);
		this.setUnderlyingState(schemaName, newName, { underlyingTable });
	}

	/**
	 * Re-keys all entries of a connection-scoped map (`<dbId>:<schema>.<table>`)
	 * from oldName to newName, leaving entries for other tables untouched.
	 * Returns how many entries moved.
	 */
	private rekeyConnectionScopedMap<V>(
		map: Map<string, V>,
		schemaName: string,
		oldName: string,
		newName: string,
	): number {
		// Length of the LOWERCASED suffix: keys are stored lowercased, and case folding is
		// not always length-preserving (`'İ'.toLowerCase()` is two code units).
		const oldSuffixLength = `:${schemaName}.${oldName}`.toLowerCase().length;
		const newSuffix = `:${schemaName}.${newName}`.toLowerCase();
		const oldKeys = this.connectionScopedKeys(map, schemaName, oldName);
		for (const oldKey of oldKeys) {
			const value = map.get(oldKey)!;
			map.delete(oldKey);
			map.set(`${oldKey.substring(0, oldKey.length - oldSuffixLength)}${newSuffix}`, value);
		}
		return oldKeys.length;
	}

	/**
	 * Rebuilds an overlay table under the post-alter schema, translating each
	 * staged row to the new column layout.
	 *
	 * A row the post-alter schema's constraints reject throws CONSTRAINT out of
	 * {@link insertIntoRebuiltOverlay} rather than being silently discarded; the caller
	 * ({@link adoptRebuiltOverlay}) maps that to INTERNAL or poison.
	 */
	private async migrateOverlayForAlter(
		db: Database,
		oldState: ConnectionOverlayState,
		updatedSchema: TableSchema,
		change: SchemaChangeInfo,
		dropColumnIdx: number | undefined,
		addColumnCtx: AddColumnBackfillContext | undefined,
		setNotNullCtx: SetNotNullBackfillContext | undefined,
	): Promise<ConnectionOverlayState> {
		const oldOverlay = oldState.overlayTable;
		const oldOverlaySchema = oldOverlay.tableSchema;

		const newOverlaySchema = this.createOverlaySchema(updatedSchema);
		const newOverlayTable = await this.overlayModule.create(db, newOverlaySchema);
		const newState: ConnectionOverlayState = { overlayTable: newOverlayTable, hasChanges: oldState.hasChanges, db };

		try {
			if (oldState.hasChanges && oldOverlaySchema && oldOverlay.query) {
				const oldTombstoneIdx = oldOverlaySchema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
				if (oldTombstoneIdx === undefined) {
					throw new QuereusError(`Tombstone column '${this.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
				}
				// `addColumnCtx` (folded literal default, the per-row evaluator, and the new
				// column's NOT NULL flag) was precomputed once per ALTER by the caller and already
				// dry-run validated against these same staged rows; undefined for non-addColumn
				// change types, which append nothing to staged rows.
				for await (const oldRow of oldOverlay.query(makeFullScanFilterInfo())) {
					const addColumnValue = addColumnCtx
						? await this.computeAddColumnValue(addColumnCtx, oldRow, oldTombstoneIdx)
						: undefined;
					const newRow = this.translateOverlayRow(oldRow, oldTombstoneIdx, change, dropColumnIdx, addColumnValue, setNotNullCtx);
					await this.insertIntoRebuiltOverlay(newOverlayTable, newRow, updatedSchema.name);
				}
			}
		} catch (e) {
			// Any throw after create abandons this freshly built overlay (adoptRebuiltOverlay
			// keeps the OLD one installed on its throw path and never holds this handle), so
			// free it here or it leaks.
			await this.releaseOverlayTable(newState);
			throw e;
		}

		return newState;
	}

	/**
	 * Precomputes the per-ALTER constants an `addColumn` overlay backfill needs:
	 * the folded literal DEFAULT (the `tryFoldLiteral` of the DEFAULT expr, or `null`
	 * when there is no DEFAULT or it folds to NULL), the engine-supplied per-row
	 * evaluator (present only for a non-foldable `new.<col>` default), and whether
	 * the new column is NOT NULL. Returns undefined for every non-`addColumn` change
	 * so the row loop appends nothing.
	 *
	 * The new column's nullability is resolved exactly as both underlyings resolve it
	 * (`columnDefToSchema(columnDef, default_column_nullability === 'not_null')`) so the
	 * pre-validation cannot drift from what the underlying will enforce. Because it is
	 * derived purely from `change` + the session option — not the post-alter schema,
	 * which does not exist until `underlying.alterTable` runs — this can be built
	 * BEFORE the irreversible underlying mutation and reused by the migration after.
	 */
	private deriveAddColumnBackfill(
		change: SchemaChangeInfo,
		db: Database,
		tableName: string,
	): AddColumnBackfillContext | undefined {
		if (change.type !== 'addColumn') return undefined;
		const defaultExpr = change.columnDef.constraints?.find(c => c.type === 'default')?.expr;
		// tryFoldLiteral returns undefined for a non-foldable expr and null for one that
		// folds to NULL; collapse both to null (the no-usable-literal default).
		const foldedDefault: SqlValue = defaultExpr ? (tryFoldLiteral(defaultExpr) ?? null) : null;
		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';
		// Thread the session `default_collation` for symmetry with the underlying memory/store
		// ADD COLUMN sites. This site only reads `.notNull`/`.name` off the result (the
		// underlying materializes the real column), so it does not affect collation here — but
		// keeping the call signature identical avoids drift and is correct for any future reader.
		const newColumn = columnDefToSchema(change.columnDef, defaultNotNull, db.options.getStringOption('default_collation'), (n) => db.isCollationRegistered(n));
		return {
			foldedDefault,
			evaluator: change.backfillEvaluator,
			newColNotNull: newColumn.notNull,
			newColName: newColumn.name,
			tableName,
		};
	}

	/**
	 * Precomputes the per-ALTER constants an `alter column … set not null` overlay migration needs:
	 * the now-NOT-NULL column's index and the folded literal DEFAULT (with `hasDefault` gating
	 * backfill vs reject). Returns undefined unless this is a NOT NULL *tightening*
	 * (`setNotNull: true`) with at least one overlay to migrate — a DROP NOT NULL loosens and
	 * needs no staged-row work, and with no overlays there is nothing to backfill or reject.
	 *
	 * `change` for `set not null` carries no default expression, so the DEFAULT is read from the
	 * column's PRE-alter schema (via a to-be-migrated overlay — the same source `dropColumnIdx`
	 * uses, and the same layout every migrated overlay shares). Folded exactly as
	 * {@link deriveAddColumnBackfill} folds its DEFAULT, so backfill and reject decisions here
	 * cannot drift from what the underlying enforces over its committed rows.
	 */
	private deriveSetNotNullBackfill(
		change: SchemaChangeInfo,
		toMigrate: [string, ConnectionOverlayState][],
		tableName: string,
	): SetNotNullBackfillContext | undefined {
		if (change.type !== 'alterColumn' || change.setNotNull !== true) return undefined;
		if (toMigrate.length === 0) return undefined;
		const overlaySchema = toMigrate[0][1].overlayTable.tableSchema;
		if (!overlaySchema) return undefined;
		const colIndex = overlaySchema.columnIndexMap.get(change.columnName.toLowerCase());
		if (colIndex === undefined) return undefined;
		const defaultExpr = overlaySchema.columns[colIndex]?.defaultValue;
		// tryFoldLiteral returns undefined for a non-foldable expr and null for one that folds to
		// NULL; both mean "no usable literal default" — the staged NULL must reject, not backfill.
		const folded = defaultExpr ? tryFoldLiteral(defaultExpr) : undefined;
		const hasDefault = folded !== undefined && folded !== null;
		return {
			colIndex,
			foldedDefault: hasDefault ? folded : null,
			hasDefault,
			colName: change.columnName,
			tableName,
		};
	}

	/**
	 * Dry-runs an overlay's ALTER migration-fallible work without mutating anything,
	 * so the caller can run it for every affected overlay BEFORE the irreversible
	 * `underlying.alterTable` (see {@link alterTable}). It exercises the EXACT code
	 * paths the real migration uses — the tombstone-present guard and, for addColumn,
	 * `computeAddColumnValue` per staged row — so a dry-run pass and the subsequent
	 * migrate pass cannot diverge:
	 *
	 * - A clean overlay (`!hasChanges`) stages no rows, so there is nothing to validate.
	 * - A missing tombstone column throws INTERNAL here, before the underlying is touched.
	 * - For addColumn, each staged row runs through `computeAddColumnValue`: tombstone
	 *   rows short-circuit to `null` (the evaluator never runs), and a NOT-NULL-violating
	 *   evaluated row throws CONSTRAINT here, atomically. Computed values are discarded.
	 *
	 * For `set not null` with NO usable DEFAULT (`setNotNullCtx.hasDefault === false`), a staged
	 * non-tombstone NULL at the now-NOT-NULL column throws CONSTRAINT here — for the issuer this
	 * aborts atomically before the underlying mutates; for a foreign overlay the caller maps it to
	 * poison. With a usable DEFAULT the staged NULLs are backfilled by {@link translateOverlayRow},
	 * so nothing is rejected here.
	 *
	 * Non-addColumn / non-tightening changes (`addColumnCtx === undefined` and no reject-mode
	 * `setNotNullCtx`) only run the tombstone guard; their row translation appends/removes nothing
	 * fallible on data grounds.
	 */
	private async validateOverlayMigration(
		oldState: ConnectionOverlayState,
		addColumnCtx: AddColumnBackfillContext | undefined,
		setNotNullCtx: SetNotNullBackfillContext | undefined,
	): Promise<void> {
		const oldOverlay = oldState.overlayTable;
		const oldOverlaySchema = oldOverlay.tableSchema;
		// Mirror the migrate-loop guard exactly: a clean overlay or one without a queryable
		// schema stages nothing and runs none of the fallible checks.
		if (!(oldState.hasChanges && oldOverlaySchema && oldOverlay.query)) return;

		const oldTombstoneIdx = oldOverlaySchema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (oldTombstoneIdx === undefined) {
			throw new QuereusError(`Tombstone column '${this.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
		}

		if (addColumnCtx) {
			for await (const oldRow of oldOverlay.query(makeFullScanFilterInfo())) {
				// Discard the result — this is validation only. A NOT NULL violation throws here.
				await this.computeAddColumnValue(addColumnCtx, oldRow, oldTombstoneIdx);
			}
			return;
		}

		// SET NOT NULL with no usable DEFAULT: reject a staged NULL the migration could not fill.
		// (With a DEFAULT there is nothing to reject — translateOverlayRow backfills instead.)
		if (setNotNullCtx && !setNotNullCtx.hasDefault) {
			for await (const oldRow of oldOverlay.query(makeFullScanFilterInfo())) {
				if (oldRow[oldTombstoneIdx] === 1) continue; // tombstone: placeholder NULLs, not a row
				if (oldRow[setNotNullCtx.colIndex] === null) {
					throw new QuereusError(
						`column ${setNotNullCtx.colName} contains NULL values`,
						StatusCode.CONSTRAINT,
					);
				}
			}
		}
	}

	/**
	 * Computes one staged row's value for a freshly added column, mirroring the
	 * committed-row backfill (see `base.ts` `recreatePrimaryTreeWithNewColumn` and
	 * `store-module.ts` `migrateRows`):
	 *
	 * - Tombstone rows carry NULL placeholders and their appended value is never read,
	 *   so append `null` and never run the evaluator against them (it could reference
	 *   NULL siblings or spuriously trip the NOT NULL check).
	 * - With a per-row evaluator, derive the value from the existing-columns slice and
	 *   enforce NOT NULL on that path only (a literal/NULL default's nullability is gated
	 *   up-front by the engine, exactly as `base.ts` does).
	 * - Otherwise use the folded literal default.
	 */
	private async computeAddColumnValue(
		ctx: AddColumnBackfillContext,
		oldRow: Row,
		oldTombstoneIdx: number,
	): Promise<SqlValue> {
		if (oldRow[oldTombstoneIdx] === 1) return null;
		if (ctx.evaluator) {
			const data = Array.from(oldRow.slice(0, oldTombstoneIdx)) as SqlValue[];
			const value = await ctx.evaluator(data);
			if (ctx.newColNotNull && value === null) {
				throw new QuereusError(
					`NOT NULL constraint failed: backfilling column '${ctx.tableName}.${ctx.newColName}' produced NULL for a staged row`,
					StatusCode.CONSTRAINT,
				);
			}
			return value;
		}
		return ctx.foldedDefault;
	}

	/**
	 * Translates a single overlay row from the pre-alter to the post-alter column layout.
	 * The tombstone value is preserved in the last position.
	 *
	 * `addColumnValue` is the per-row value the caller computed for an `addColumn`
	 * (via {@link computeAddColumnValue}); it is `undefined` for every other change
	 * type. Keeping the (async) backfill in the caller's loop lets this stay synchronous.
	 *
	 * `setNotNullCtx` (present only for a `set not null` tightening WITH a usable DEFAULT) maps a
	 * staged NULL at the now-NOT-NULL column to that DEFAULT — filling the issuer's own pending
	 * rows, which the underlying's committed-row backfill never touches. Reject-mode contexts (no
	 * DEFAULT) never reach here: {@link validateOverlayMigration} aborts/poisons first.
	 */
	private translateOverlayRow(
		oldRow: Row,
		oldTombstoneIdx: number,
		change: SchemaChangeInfo,
		dropColumnIdx: number | undefined,
		addColumnValue: SqlValue | undefined,
		setNotNullCtx: SetNotNullBackfillContext | undefined,
	): SqlValue[] {
		const tombstoneValue = oldRow[oldTombstoneIdx] as SqlValue;
		const data = Array.from(oldRow.slice(0, oldTombstoneIdx)) as SqlValue[];

		let newData: SqlValue[];
		switch (change.type) {
			case 'addColumn':
				// New column is always appended after existing data columns, backfilled per
				// row by the caller (literal default, per-row evaluator, or NULL).
				newData = [...data, addColumnValue ?? null];
				break;
			case 'dropColumn':
				newData = dropColumnIdx !== undefined
					? [...data.slice(0, dropColumnIdx), ...data.slice(dropColumnIdx + 1)]
					: data;
				break;
			case 'alterColumn':
				// SET NOT NULL backfill (WITH a usable DEFAULT): fill a staged NULL at the
				// now-NOT-NULL column. Tombstones carry placeholder NULLs never read, so leave them.
				// Every other alterColumn attribute (and the no-DEFAULT reject case) leaves data as-is.
				// NOTE: SET DATA TYPE also alters existing values but is NOT converted here — its
				// overlay gap is deferred (see SetNotNullBackfillContext doc).
				newData = (setNotNullCtx && tombstoneValue !== 1)
					? data.map((v, i) => (i === setNotNullCtx.colIndex && v === null ? setNotNullCtx.foldedDefault : v))
					: data;
				break;
			case 'renameColumn':
			case 'alterPrimaryKey':
			case 'addConstraint':
			case 'dropConstraint':
			case 'renameConstraint':
				newData = data;
				break;
			default: {
				const _exhaustive: never = change;
				newData = data;
			}
		}

		return [...newData, tombstoneValue];
	}

	/**
	 * Creates overlay schema from underlying schema.
	 * Adds tombstone column and uses unique name to avoid conflicts.
	 *
	 * Called by IsolatedTable when lazily creating its overlay, and by the two overlay-rebuild
	 * paths (`rebuildOverlayForIndexChange`, `migrateOverlayForAlter`).
	 *
	 * Every copied secondary index — and every copied UNIQUE constraint, including the ones
	 * a UNIQUE index derives — is narrowed to a PARTIAL structure over live rows only
	 * (`<tombstone> = 0`), AND-ed onto whatever partial predicate it already carried. A
	 * tombstone is a deletion marker, not a row, so no uniqueness rule may be evaluated over
	 * it: it carries its row's PK and NULL everywhere else, so a UNIQUE structure whose
	 * columns all sit inside the PK would otherwise see two deleted rows as duplicates.
	 * (Non-PK unique columns escaped only because their tombstone key is NULL and SQL treats
	 * NULLs as distinct.) The overlay's PRIMARY KEY uniqueness is NOT narrowed — it must keep
	 * covering tombstones so a re-insert at a tombstoned PK is detected and converted.
	 *
	 * `IsolatedTable.mergedSecondaryIndexQuery` wants exactly the live overlay rows out of
	 * these indexes, so narrowing them is what it already expects.
	 */
	createOverlaySchema(baseSchema: TableSchema): TableSchema {
		const tombstoneColumn = {
			name: this.tombstoneColumn,
			logicalType: {
				name: 'INTEGER',
				physicalType: PhysicalType.INTEGER,
			},
			notNull: true,
			primaryKey: false,
			pkOrder: 0,
			defaultValue: null,
			collation: 'BINARY',
			generated: false,
		};

		const newColumns = [...baseSchema.columns, tombstoneColumn];
		const newColumnIndexMap = new Map(baseSchema.columnIndexMap);
		newColumnIndexMap.set(this.tombstoneColumn.toLowerCase(), newColumns.length - 1);

		// Use unique ID to avoid conflicts when multiple overlays exist
		const overlayId = generateOverlayId();
		const overlayName = `_overlay_${baseSchema.name}_${overlayId}`;

		const liveOnly = this.liveRowPredicate();

		// A partial-index / UNIQUE predicate copied from the base carries a self-qualifier
		// bound to the base table's name (e.g. `where t.v > 0`). The overlay renames the table
		// to `overlayName`, so that qualifier now names a DIFFERENT table than the overlay's
		// MemoryIndex is scoped to — and `compilePredicate` rejects a foreign qualifier at
		// index-build time (see partial-index-predicate table-qualifier rejection). Rescope the
		// self-qualifier to the overlay name so it stays a self-reference. A foreign qualifier
		// cannot occur here: `compilePredicate` already rejected one when the base index/UNIQUE
		// was created, so every qualifier present is the base name.
		const rescope = (p: Predicate | undefined): Predicate | undefined =>
			p ? rescopePredicateQualifier(p, baseSchema.name, overlayName) : undefined;

		return {
			...baseSchema,
			name: overlayName,
			columns: newColumns,
			columnIndexMap: newColumnIndexMap,
			indexes: baseSchema.indexes?.map(idx => ({ ...idx, predicate: andPredicate(rescope(idx.predicate), liveOnly) })),
			uniqueConstraints: baseSchema.uniqueConstraints?.map(uc => ({ ...uc, predicate: andPredicate(rescope(uc.predicate), liveOnly) })),
		};
	}

	/**
	 * `<tombstoneColumn> = 0` — the partial-structure predicate that scopes an overlay index
	 * or UNIQUE constraint to live rows. Built as an AST rather than parsed from text because
	 * the tombstone column name is host-configurable.
	 *
	 * NOTE: the default overlay is a `MemoryTableModule`, which honors `IndexSchema.predicate`
	 * and `UniqueConstraintSchema.predicate`. A host that injects its own `config.overlay`
	 * module must honor them too, or its overlay will re-enforce uniqueness over tombstones.
	 */
	private liveRowPredicate(): Predicate {
		return {
			type: 'binary',
			operator: '=',
			left: { type: 'column', name: this.tombstoneColumn },
			right: { type: 'literal', value: 0 },
		};
	}
}

function andPredicate(base: Predicate | undefined, extra: Predicate): Predicate {
	return base ? { type: 'binary', operator: 'AND', left: base, right: extra } : extra;
}

/**
 * Deep-clone `pred`, rewriting every column reference whose `table` qualifier names
 * `fromName` (case-insensitive) to `toName`. Depth-blind structural walk — a `column`
 * node is identified by `type === 'column'`; every other node is cloned verbatim. Used
 * to re-anchor a base table's partial-predicate self-qualifier onto the renamed overlay
 * table (see {@link IsolationModule.createOverlaySchema}).
 */
function rescopePredicateQualifier(pred: Predicate, fromName: string, toName: string): Predicate {
	const fromLower = fromName.toLowerCase();
	const clone = (v: unknown): unknown => {
		if (v === null || typeof v !== 'object') return v;
		if (Array.isArray(v)) return v.map(clone);
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			out[k] = clone(val);
		}
		if (out.type === 'column' && typeof out.table === 'string' && out.table.toLowerCase() === fromLower) {
			out.table = toName;
		}
		return out;
	};
	return clone(pred) as Predicate;
}
