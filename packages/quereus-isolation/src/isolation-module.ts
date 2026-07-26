import type { Database, VirtualTableModule, BaseModuleConfig, TableSchema, TableIndexSchema as IndexSchema, ModuleCapabilities, VirtualTable, BestAccessPlanRequest, BestAccessPlanResult, SchemaChangeInfo, Row, SqlValue, Schema, MappingAdvertisement, LensDeploymentSnapshot, VtabConcurrencyMode, VirtualTableConnection, BackingHost, EffectiveRowSource, UpdateResult } from '@quereus/quereus';
import { MemoryTableModule, PhysicalType, QuereusError, StatusCode, tryFoldLiteral, columnDefToSchema, isConstraintViolation, inferType, validateAndParse } from '@quereus/quereus';
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
	 * Set at every real creation site (`ensureOverlay`, and the ALTER PRIMARY KEY
	 * clean-overlay swap in `replaceOverlayForPrimaryKeyChange`); the default
	 * `MemoryTableModule` overlay ignores it, but a host-injected `config.overlay`
	 * keyed per-db needs the overlay's OWN db, not the sweeper's.
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
 * Per-ALTER constants for an `alter column … set not null` overlay backfill (see
 * `deriveSetNotNullBackfill`). Precomputed once so the per-row validate/backfill loops only
 * branch on tombstone / has-default. Present only for a NOT NULL *tightening* (`setNotNull: true`)
 * with staged overlays to carry forward.
 *
 * `alter column … set data type` rides the same derive → validate seam via
 * {@link SetDataTypeConvertContext}. The two are mutually exclusive: the runtime rejects a
 * multi-attribute `alter column` before it reaches this module.
 */
interface SetNotNullBackfillContext {
	/** Zero-based index of the now-NOT-NULL column in the overlay's data columns. */
	colIndex: number;
	/** The folded literal DEFAULT used to backfill staged NULLs; meaningful only when `hasDefault`. */
	foldedDefault: SqlValue;
	/** Whether a usable literal DEFAULT exists — backfill when true, reject the staged NULL when false. */
	hasDefault: boolean;
	/** Column name, for the CONSTRAINT message. */
	colName: string;
}

/**
 * Per-ALTER constants for an `alter column … set data type` overlay pre-validation (see
 * {@link IsolationModule.deriveSetDataTypeConvert}). Present only when the retype actually
 * rewrites values (the new physical type differs from the old) and there are staged overlays
 * to judge — a metadata-only retype leaves every staged value as it stands.
 *
 * The conversion itself is done by the overlay module when the retype is forwarded through its
 * `alterSchema` ({@link IsolationModule.forwardAlterColumnToOverlay}); this context exists so
 * {@link IsolationModule.validateOverlayMigration} can prove every staged value convertible
 * FIRST — atomically for the issuer, and as the poison-vs-forward gate for a foreign overlay.
 */
interface SetDataTypeConvertContext {
	/** Zero-based index of the retyped column in the overlay's data columns. */
	colIndex: number;
	/** Per-value conversion; throws MISMATCH exactly as the underlying's does. */
	convert: (v: SqlValue) => SqlValue;
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
	 * The INTERNAL raised when the DDL-ISSUING connection's own overlay rejects the change the
	 * DDL just made (routed through {@link applyInPlaceOverlayChange} by the index paths and
	 * every ALTER TABLE forward).
	 *
	 * Unreachable by construction: the row source handed to the underlying (see
	 * {@link issuerEffectiveRows}) judged a superset of exactly these rows and accepted them,
	 * so a rejection here means validation and migration have drifted. Raise loudly — the
	 * alternative is the silent row loss these guards exist to end.
	 */
	private issuerOverlayDriftError(
		schemaName: string,
		tableName: string,
		ddlDescription: string,
		cause: QuereusError,
	): QuereusError {
		return new QuereusError(
			`Isolation layer: applying ${ddlDescription} to the issuing connection's overlay for `
			+ `'${schemaName}.${tableName}' raised: ${cause.message}. That DDL's validation pass already judged a `
			+ `superset of these rows and accepted them, so validation and migration have drifted.`,
			StatusCode.INTERNAL,
			cause,
		);
	}

	/**
	 * Builds the poison message stamped onto a foreign overlay whose staged rows cannot adopt
	 * a constraint another connection's DDL just declared (see
	 * {@link applyInPlaceOverlayChange}). Companion to {@link buildAlterPoisonMessage}, which
	 * covers the data conditions the pre-validation pass rejects before any overlay is touched;
	 * this one covers a UNIQUE (or any other) violation raised by the in-place adoption itself.
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
	 * Creates an index on the underlying table, then hands the same index to every
	 * per-connection overlay so it (and, for a UNIQUE index, the constraint derived from it)
	 * is enforced for the rest of each open transaction.
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
	 *    the index. Forwarding is also what gives a merged secondary-index scan later in the
	 *    transaction an overlay that can serve it.
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
			return; // underlying does not support indexes; nothing was created, nothing to forward
		}
		if (!state) return;

		// Take the index back off the underlying's refreshed schema rather than reusing the
		// caller's object: that is the canonical post-create form (resolved column indices,
		// any normalization the underlying applied), and the overlay's copy is derived from it.
		const updatedSchema = this.assertIndexPresent(state.underlyingTable, schemaName, tableName, indexSchema.name);
		const created = updatedSchema.indexes!.find(idx => idx.name.toLowerCase() === indexSchema.name.toLowerCase())!;
		await this.applyIndexChangeToOverlays(
			db, schemaName, tableName, `create index '${indexSchema.name}'`,
			overlayState => this.createOverlayIndex(overlayState, updatedSchema.name, created),
		);
	}

	/**
	 * Adds one index to an already-open overlay, in the overlay's own flavor (predicate
	 * narrowed to live rows and rescoped onto the overlay's table name — see
	 * {@link createOverlayIndexSchema}).
	 *
	 * A UNIQUE index the overlay's staged rows violate raises `CONSTRAINT` out of
	 * `MemoryTableManager.createIndex`'s pre-validation pass, which
	 * {@link applyIndexChangeToOverlays} routes to INTERNAL (issuer) or poison (foreign).
	 * The pass runs before any mutation, so a rejected overlay is left exactly as it was.
	 *
	 * No-ops when the overlay module has no index support, or when the overlay already
	 * carries an index of that name (an overlay built after the underlying's create already
	 * copied it in through {@link createOverlaySchema}).
	 */
	private async createOverlayIndex(
		overlayState: ConnectionOverlayState,
		baseName: string,
		indexSchema: IndexSchema,
	): Promise<void> {
		const overlayTable = overlayState.overlayTable;
		const overlaySchema = overlayTable.tableSchema;
		if (!overlayTable.createIndex || !overlaySchema) return;
		if (this.schemaHasIndex(overlaySchema, indexSchema.name)) return;
		await overlayTable.createIndex(this.createOverlayIndexSchema(indexSchema, baseName, overlaySchema.name));
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
		const present = updatedSchema && this.schemaHasIndex(updatedSchema, indexName);
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

	/** Case-insensitive "does `schema` declare an index named `indexName`". */
	private schemaHasIndex(schema: TableSchema, indexName: string): boolean {
		const lower = indexName.toLowerCase();
		return schema.indexes?.some(idx => idx.name.toLowerCase() === lower) ?? false;
	}

	/**
	 * Drops an index on the underlying table, then drops it from every per-connection overlay.
	 *
	 * Mirrors createIndex: when the underlying VirtualTable exposes an
	 * instance-level dropIndex (e.g. MemoryTable, which forwards to its manager
	 * so MemoryTable.tableSchema stays fresh), prefer that. Otherwise fall back
	 * to the module-level dropIndex (e.g. StoreModule, which refreshes the
	 * StoreTable's cached tableSchema and tears down the index store).
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

		await this.applyIndexChangeToOverlays(
			db, schemaName, tableName, `drop index '${indexName}'`,
			overlayState => this.dropOverlayIndex(overlayState, indexName),
		);
	}

	/**
	 * Drops one index (and the UNIQUE constraint derived from it) from an already-open
	 * overlay. No-ops when the overlay module has no index support, or when the overlay never
	 * carried the index.
	 */
	private async dropOverlayIndex(overlayState: ConnectionOverlayState, indexName: string): Promise<void> {
		const overlayTable = overlayState.overlayTable;
		const overlaySchema = overlayTable.tableSchema;
		if (!overlayTable.dropIndex || !overlaySchema) return;
		if (!this.schemaHasIndex(overlaySchema, indexName)) return;
		await overlayTable.dropIndex(indexName);
	}

	/**
	 * Applies an index change (CREATE INDEX or DROP INDEX) IN PLACE to every non-poisoned
	 * per-connection overlay of one table.
	 *
	 * In place, not by rebuild. Both paths used to discard the overlay and copy its staged
	 * rows into a fresh `MemoryTable`, which silently destroyed the overlay's savepoint chain:
	 * the copy's first write lazily registers the new overlay's connection, and
	 * `Database.registerConnection` replays `begin()` plus the whole active savepoint stack
	 * BEFORE the copy runs — so every copied row landed ABOVE the replayed savepoint and the
	 * next `rollback to savepoint` discarded rows staged long before that savepoint was taken
	 * (`bug-isolation-index-ddl-rebuild-drops-savepoint-writes`).
	 *
	 * The rebuild was originally forced by a memory-module limitation — an open write
	 * `TransactionLayer` froze its schema at creation, so a bare `overlay.dropIndex` left the
	 * synthesized UNIQUE constraint firing inside the layer. `TransactionLayer.adoptSchema`
	 * now has both an additive and a removal branch, and `MemoryTableManager` calls it for
	 * both index directions, so an open layer adopts the change with its savepoint snapshots
	 * intact.
	 *
	 * CONSTRAINT is routed by who owns the overlay via {@link applyInPlaceOverlayChange},
	 * shared with every ALTER TABLE forward.
	 *
	 * A poisoned overlay is skipped: it holds rows in a pre-ALTER column layout and its owner
	 * must roll back regardless, so there is nothing to keep enforcing for it.
	 */
	private async applyIndexChangeToOverlays(
		db: Database,
		schemaName: string,
		tableName: string,
		ddlDescription: string,
		apply: (overlayState: ConnectionOverlayState) => Promise<void>,
	): Promise<void> {
		const ownKey = this.makeConnectionOverlayKey(db, schemaName, tableName);
		for (const key of this.connectionScopedKeys(this.connectionOverlays, schemaName, tableName)) {
			const overlayState = this.connectionOverlays.get(key)!;
			if (overlayState.poison) continue;
			await this.applyInPlaceOverlayChange(
				key === ownKey, overlayState, schemaName, tableName, ddlDescription,
				() => apply(overlayState),
			);
		}
	}

	/**
	 * Applies one in-place DDL mutation to a single overlay, routing a CONSTRAINT failure
	 * by who owns the overlay: the issuer's own overlay → INTERNAL (its rows were already
	 * judged by the DDL's own validation pass, so a rejection here means validation and
	 * migration have drifted — {@link issuerOverlayDriftError}); a foreign overlay →
	 * poison and leave it untouched so its owner errors and rolls back
	 * ({@link buildRebuildPoisonMessage}). Any non-CONSTRAINT failure is a layer-invariant
	 * violation, not a data condition, and rethrows for everyone.
	 *
	 * Shared by the index paths ({@link applyIndexChangeToOverlays}) and the ALTER TABLE
	 * column-shape forwards ({@link alterTable}), so the two cannot drift on error routing.
	 */
	private async applyInPlaceOverlayChange(
		isIssuer: boolean,
		overlayState: ConnectionOverlayState,
		schemaName: string,
		tableName: string,
		ddlDescription: string,
		apply: () => Promise<void>,
	): Promise<void> {
		try {
			await apply();
		} catch (e) {
			if (!(e instanceof QuereusError) || e.code !== StatusCode.CONSTRAINT) throw e;
			if (isIssuer) throw this.issuerOverlayDriftError(schemaName, tableName, ddlDescription, e);
			overlayState.poison = { message: this.buildRebuildPoisonMessage(schemaName, tableName, ddlDescription, e.message) };
		}
	}

	/**
	 * Delegates ALTER TABLE to the underlying module and carries any per-connection
	 * overlays to the post-alter schema without discarding staged rows.
	 *
	 * Every change type forwards to each overlay IN PLACE — through the overlay's own
	 * `alterSchema` / `createIndex` / ordinary writes — so the overlay's layer chain and
	 * savepoint snapshots survive the ALTER and `rollback to savepoint` keeps
	 * distinguishing rows staged before the savepoint from rows staged after it (see
	 * {@link applyIndexChangeToOverlays} for why the old rebuild — copying staged rows
	 * into a fresh staging table — destroyed that distinction). Per change type:
	 *
	 * - ADD / DROP / RENAME COLUMN: {@link forwardColumnShapeToOverlay}. ADD COLUMN
	 *   backfills each staged row exactly as the committed path does (literal default,
	 *   per-row `new.<col>` evaluator, or NULL); tombstone rows get NULL.
	 * - ALTER COLUMN: {@link forwardAlterColumnToOverlay}. `set data type` / `set collate`
	 *   / `set default` forward straight through (the overlay module converts / re-keys its
	 *   open layers itself); `set not null` is withheld from the overlay and the staged
	 *   live rows' NULLs are backfilled via ordinary overlay writes instead.
	 * - ADD / DROP / RENAME CONSTRAINT: {@link forwardAddConstraintToOverlay} /
	 *   {@link forwardConstraintNameChangeToOverlay}. A UNIQUE lands as a
	 *   tombstone-narrowed unique index; CHECK forwards verbatim; FOREIGN KEY does not
	 *   forward at all.
	 * - ALTER PRIMARY KEY: no overlay can follow (its layer trees are keyed by the old
	 *   primary key) — the issuer with staged rows is rejected before the underlying
	 *   mutates, a foreign overlay with staged rows is poisoned, and a clean overlay is
	 *   swapped for a fresh staging table ({@link replaceOverlayForPrimaryKeyChange}).
	 *
	 * **Atomicity guarantee.** DDL through Quereus is not transaction-scoped and the
	 * underlying (shared, committed) base auto-commits its mutation immediately —
	 * there is no frame to unwind, and `dropColumn` / type-converting `alterColumn`
	 * are lossy and not invertible, so "revert the underlying on overlay-migration
	 * failure" is not viable. Instead this method **pre-validates** every affected
	 * overlay's migration (the per-row NOT NULL check, the per-value retype conversion, and
	 * the tombstone-present guard) BEFORE calling `underlying.alterTable`. A rejection therefore fires while the
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

		// Overlays we will actually migrate forward (issuer-own first). The setNotNull /
		// setDataType contexts below are probed from one of these, never from a skipped
		// poisoned overlay whose schema may be a stale pre-alter layout.
		const toMigrate = ownEntry ? [ownEntry, ...foreign] : foreign;

		// ALTER PRIMARY KEY cannot be carried by any overlay: the staging table's layer
		// trees are keyed by the OLD primary key, a staged tombstone identifies the row it
		// deletes BY that key, and the (memory) overlay module rejects in-place PK
		// alteration. When the ISSUER's own transaction has staged rows, reject up front —
		// before the underlying mutates — so the ALTER fails atomically rather than
		// stranding rows it cannot re-key. Foreign overlays with staged rows are poisoned
		// after the underlying applies, and clean overlays are swapped for a fresh staging
		// table (see replaceOverlayForPrimaryKeyChange).
		if (change.type === 'alterPrimaryKey' && ownEntry?.[1].hasChanges) {
			throw new QuereusError(
				`Cannot alter the primary key of '${schemaName}.${tableName}' while this transaction has uncommitted changes staged for it; commit or roll back first.`,
				StatusCode.UNSUPPORTED,
			);
		}

		// Build the addColumn backfill context up front (undefined for other change types).
		// Derived purely from `change` + the session nullability option — no post-alter
		// schema needed — so it is valid here, before the underlying is mutated, and the
		// same context drives the post-mutation migration.
		const addColumnCtx = this.deriveAddColumnBackfill(change, db, tableName);

		// Build the setNotNull backfill context (undefined unless this is a NOT NULL tightening
		// with overlays to migrate). The now-NOT-NULL column's index and folded DEFAULT are read
		// from a to-be-migrated overlay's PRE-alter schema — the same layout every migrated overlay
		// shares.
		const setNotNullCtx = this.deriveSetNotNullBackfill(change, toMigrate);

		// Build the setDataType conversion context (undefined unless this is a value-rewriting
		// retype with overlays to convert). Read from the same PRE-alter overlay schema as above;
		// `inferType` cannot throw, so deriving it before the underlying mutation is safe.
		const setDataTypeCtx = this.deriveSetDataTypeConvert(change, toMigrate);

		// Tier 2: validate the ISSUER's own overlay BEFORE mutating the shared underlying.
		// Any throw here (CONSTRAINT backfill, MISMATCH conversion, or INTERNAL tombstone guard)
		// propagates while underlying + catalog + every overlay are still untouched — the companion
		// ticket's atomic-abort guarantee, preserved unchanged for the issuer.
		if (ownEntry) {
			await this.validateOverlayMigration(ownEntry[1], addColumnCtx, setNotNullCtx, setDataTypeCtx);
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

		// Carry one overlay to the post-alter schema, IN PLACE, so the overlay's layer
		// chain and savepoint snapshots stay intact (see the method doc for the per-type
		// routes). The `const` re-captures pin each case's narrowed change type for the
		// apply closure.
		const migrateOverlay = async (key: string, state: ConnectionOverlayState, isIssuer: boolean): Promise<void> => {
			switch (change.type) {
				case 'addColumn':
				case 'dropColumn':
				case 'renameColumn':
					await this.applyInPlaceOverlayChange(
						isIssuer, state, schemaName, tableName, ddlDescription,
						() => this.forwardColumnShapeToOverlay(state, change, addColumnCtx),
					);
					break;
				case 'alterColumn': {
					const alterColumnChange = change;
					await this.applyInPlaceOverlayChange(
						isIssuer, state, schemaName, tableName, ddlDescription,
						() => this.forwardAlterColumnToOverlay(state, alterColumnChange, setNotNullCtx),
					);
					break;
				}
				case 'addConstraint': {
					const addConstraintChange = change;
					await this.applyInPlaceOverlayChange(
						isIssuer, state, schemaName, tableName, ddlDescription,
						() => this.forwardAddConstraintToOverlay(state, addConstraintChange, updated),
					);
					break;
				}
				case 'dropConstraint':
				case 'renameConstraint': {
					const nameChange = change;
					await this.applyInPlaceOverlayChange(
						isIssuer, state, schemaName, tableName, ddlDescription,
						() => this.forwardConstraintNameChangeToOverlay(state, nameChange),
					);
					break;
				}
				case 'alterPrimaryKey':
					await this.replaceOverlayForPrimaryKeyChange(key, state, isIssuer, schemaName, tableName, updated, change);
					break;
				default: {
					const _exhaustive: never = change;
				}
			}
		};

		// Migrate the issuer's own overlay (already validated above). Its NOT NULL /
		// tombstone throw sites are unreachable after pre-validation; so is a UNIQUE
		// rejection, which `rowSource` already judged — the CONSTRAINT routing raises
		// INTERNAL if one fires anyway rather than dropping the row.
		if (ownEntry) {
			await migrateOverlay(ownEntry[0], ownEntry[1], true);
		}

		// Tier 3: per FOREIGN overlay, validate then migrate — but a per-row NOT NULL
		// (CONSTRAINT) failure poisons that one overlay instead of aborting the issuer's
		// ALTER, as does a UNIQUE the migration itself raises (its staged rows may violate a
		// constraint the issuer just declared) and an unconvertible staged value under a retype
		// (MISMATCH). Those three are data conditions of ONE connection's uncommitted rows, and
		// the underlying has already been mutated by this point, so rethrowing any of them would
		// abort the issuer's ALTER after the fact — exactly the divergence this tiering exists to
		// prevent. An INTERNAL failure (e.g. missing tombstone column) is a layer-invariant
		// violation, not a data condition, so it rethrows loud for everyone. Both phases run per
		// overlay, so one bad foreign overlay poisons only itself; healthy peers still migrate.
		for (const [key, oldState] of foreign) {
			try {
				await this.validateOverlayMigration(oldState, addColumnCtx, setNotNullCtx, setDataTypeCtx);
			} catch (e) {
				if (e instanceof QuereusError && (e.code === StatusCode.CONSTRAINT || e.code === StatusCode.MISMATCH)) {
					oldState.poison = { message: this.buildAlterPoisonMessage(schemaName, tableName, change) };
					continue; // poisoned — do NOT migrate; leave pre-alter rows in place
				}
				throw e;
			}
			await migrateOverlay(key, oldState, false);
		}

		return updated;
	}

	/**
	 * Builds the poison message stamped onto a foreign overlay whose backfill could not
	 * satisfy a cross-connection ALTER (see {@link alterTable} tier 3). Names the
	 * schema.table and the offending column so the owning connection's eventual
	 * read/write/commit error is self-explanatory. Poison arises on the addColumn NOT NULL
	 * path (a new NOT-NULL column with no usable default), the `set not null` tightening
	 * path (a staged NULL with no usable default), and the `set data type` path (a staged value
	 * that cannot be converted to the new type); other change types never reach here but
	 * are handled defensively.
	 */
	private buildAlterPoisonMessage(schemaName: string, tableName: string, change: SchemaChangeInfo): string {
		if (change.type === 'addColumn') {
			return `ALTER on '${schemaName}.${tableName}' added column '${change.columnDef.name}' (NOT NULL) that this connection's uncommitted row cannot satisfy; roll back this transaction.`;
		}
		if (change.type === 'alterColumn') {
			if (change.setDataType !== undefined) {
				return `ALTER on '${schemaName}.${tableName}' changed the data type of column '${change.columnName}' to ${change.setDataType}, which this connection's uncommitted row cannot be converted to; roll back this transaction.`;
			}
			return `ALTER on '${schemaName}.${tableName}' tightened column '${change.columnName}' to NOT NULL, which this connection's uncommitted row violates; roll back this transaction.`;
		}
		if (change.type === 'alterPrimaryKey') {
			return `ALTER on '${schemaName}.${tableName}' changed the table's primary key, which this connection's uncommitted rows cannot follow; roll back this transaction.`;
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

	// NOTE: the ALTER overlay pre-validation machinery (the three derive* helpers,
	// validateOverlayMigration, buildAlterPoisonMessage, and the per-type forward* helpers below)
	// threads one context parameter per value-rewriting attribute. If a fourth attribute ever
	// needs a context, extract the cluster into its own module and pass a single context object
	// instead of a widening parameter list.

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
	 * column's PRE-alter schema (via a to-be-migrated overlay — the same layout every migrated
	 * overlay shares). Folded exactly as
	 * {@link deriveAddColumnBackfill} folds its DEFAULT, so backfill and reject decisions here
	 * cannot drift from what the underlying enforces over its committed rows.
	 */
	private deriveSetNotNullBackfill(
		change: SchemaChangeInfo,
		toMigrate: [string, ConnectionOverlayState][],
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
		};
	}

	/**
	 * Precomputes the per-ALTER constants an `alter column … set data type` overlay conversion
	 * needs: the retyped column's index and a per-value `convert`. Returns undefined unless this
	 * is a retype with at least one overlay to convert, and undefined for an ALIAS retype (the
	 * new logical type IS the old type object — `inferType` flattens `varchar(50)` to
	 * `TEXT_TYPE`) — both underlyings gate their value rewrite on that exact identity
	 * comparison, so mirroring it here keeps overlay and committed rows moving together should
	 * "what counts as a value-rewriting retype" ever change. A same-storage-class retype between
	 * different types (text → date) DOES convert: staged values are validated and normalized to
	 * the new type's canonical spelling, exactly as the underlyings treat their committed rows.
	 *
	 * `inferType` never throws (an unknown type name falls through SQLite-style affinity rules),
	 * so deriving this BEFORE the underlying mutation is safe. `convert` is the literal mirror of
	 * `MemoryTableManager.alterColumn` / `StoreModule.alterColumnSetDataType`: `validateAndParse`,
	 * rethrowing failure as the same MISMATCH message, so the two legs cannot drift.
	 */
	private deriveSetDataTypeConvert(
		change: SchemaChangeInfo,
		toMigrate: [string, ConnectionOverlayState][],
	): SetDataTypeConvertContext | undefined {
		if (change.type !== 'alterColumn' || change.setDataType === undefined) return undefined;
		if (toMigrate.length === 0) return undefined;
		const overlaySchema = toMigrate[0][1].overlayTable.tableSchema;
		if (!overlaySchema) return undefined;
		const colIndex = overlaySchema.columnIndexMap.get(change.columnName.toLowerCase());
		if (colIndex === undefined) return undefined;
		const oldCol = overlaySchema.columns[colIndex];
		if (!oldCol) return undefined;
		const newLogicalType = inferType(change.setDataType);
		// Alias retype (same logical type object): the underlying rewrites nothing, so neither do we.
		if (newLogicalType === oldCol.logicalType) return undefined;
		const setDataType = change.setDataType;
		const columnName = change.columnName;
		return {
			colIndex,
			convert: (v: SqlValue): SqlValue => {
				try {
					return validateAndParse(v, newLogicalType, columnName) as SqlValue;
				} catch {
					throw new QuereusError(
						`Cannot convert value in '${columnName}' to ${setDataType}`,
						StatusCode.MISMATCH,
					);
				}
			},
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
	 * poison. With a usable DEFAULT the staged NULLs are backfilled by
	 * {@link backfillStagedNotNull}, so nothing is rejected here.
	 *
	 * For `set data type` (`setDataTypeCtx`), every staged non-NULL value is run through the
	 * conversion and the result discarded, so an unconvertible one throws MISMATCH here. For the
	 * ISSUER this is belt-and-braces — the underlying's own pre-mutation pass walks the same rows
	 * via {@link issuerEffectiveRows} — EXCEPT when an outer wrapper supplied `rows`, in which case
	 * this is the only check. For a FOREIGN overlay it is the only pass that ever sees those rows,
	 * and it must run before the migration so a failure becomes poison rather than a half-migrated
	 * overlay.
	 *
	 * Non-addColumn / non-tightening / non-retype changes (`addColumnCtx === undefined`, no
	 * reject-mode `setNotNullCtx`, no `setDataTypeCtx`) only run the tombstone guard; their row
	 * translation appends/removes nothing fallible on data grounds.
	 */
	private async validateOverlayMigration(
		oldState: ConnectionOverlayState,
		addColumnCtx: AddColumnBackfillContext | undefined,
		setNotNullCtx: SetNotNullBackfillContext | undefined,
		setDataTypeCtx: SetDataTypeConvertContext | undefined,
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

		// SET NOT NULL with no usable DEFAULT: reject a staged NULL the forward could not fill.
		// (With a DEFAULT there is nothing to reject — backfillStagedNotNull fills instead.)
		if (setNotNullCtx && !setNotNullCtx.hasDefault) {
			for await (const oldRow of this.stagedLiveRows(oldOverlay, oldTombstoneIdx)) {
				if (oldRow[setNotNullCtx.colIndex] === null) {
					throw new QuereusError(
						`column ${setNotNullCtx.colName} contains NULL values`,
						StatusCode.CONSTRAINT,
					);
				}
			}
			return;
		}

		// SET DATA TYPE: prove every staged value convertible before anything is rewritten. NULLs
		// are left untouched by the conversion (the underlying's `convertNulls` is false for a retype).
		if (setDataTypeCtx) {
			for await (const oldRow of this.stagedLiveRows(oldOverlay, oldTombstoneIdx)) {
				const value = oldRow[setDataTypeCtx.colIndex];
				if (value !== null) setDataTypeCtx.convert(value as SqlValue); // discard — validation only
			}
		}
	}

	/**
	 * The staged rows an overlay holds that represent LIVE data, i.e. every row except the
	 * tombstones — those carry placeholder NULLs at every data column and must never be fed to a
	 * per-value check, which would read a NULL that is not the row's real value.
	 */
	private async *stagedLiveRows(overlay: VirtualTable, tombstoneIdx: number): AsyncIterable<Row> {
		for await (const row of overlay.query!(makeFullScanFilterInfo())) {
			if (row[tombstoneIdx] !== 1) yield row;
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
	 * Forwards one column-shape change (ADD / DROP / RENAME COLUMN) to an already-open
	 * overlay IN PLACE via the overlay's optional `alterSchema`. The overlay module (the
	 * memory module by default) reshapes its open transaction layers with their savepoint
	 * snapshots intact, so `rollback to savepoint` keeps distinguishing rows staged before
	 * the savepoint from rows staged after it — the rebuild path destroyed that
	 * distinction in both directions (see {@link applyIndexChangeToOverlays}).
	 *
	 * A missing `alterSchema` is treated as a no-op, the way the index paths treat a
	 * missing `createIndex` / `dropIndex`.
	 *
	 * `dropColumn` / `renameColumn` forward the caller's change unchanged. `addColumn`
	 * forwards an overlay-flavoured copy — see {@link buildOverlayAddColumnChange}.
	 */
	private async forwardColumnShapeToOverlay(
		overlayState: ConnectionOverlayState,
		change: SchemaChangeInfo,
		addColumnCtx: AddColumnBackfillContext | undefined,
	): Promise<void> {
		const overlayTable = overlayState.overlayTable;
		if (!overlayTable.alterSchema) return;
		// `deriveAddColumnBackfill` returns a context for every addColumn, so the assertion
		// cannot fire when the change type matches.
		const overlayChange = change.type === 'addColumn'
			? this.buildOverlayAddColumnChange(change, addColumnCtx!, overlayTable)
			: change;
		await overlayTable.alterSchema(overlayChange);
	}

	/**
	 * The overlay-flavoured form of one `addColumn` change:
	 *
	 * - `insertAtIndex` = the overlay's current tombstone column index, so the new data
	 *   column lands ahead of the tombstone flag and the flag stays LAST — the layout
	 *   every read/write path of this package assumes. A bare forward would append after
	 *   the flag and every value written to the new column would be dropped on read.
	 * - The column definition is made NULLABLE. The overlay's ADD re-runs the overlay
	 *   module's own NOT NULL validation against a different row population than the
	 *   base's: tombstone rows carry placeholder NULL in every non-PK column, so a
	 *   NOT NULL column the base already accepted would be rejected here. The base's
	 *   NOT NULL is still enforced where it belongs — by the engine's pre-mutation
	 *   `validateNotNullBackfill` and the underlying's own ADD (both judged the issuer's
	 *   effective rows), and per staged row by {@link computeAddColumnValue}'s
	 *   evaluator-path check.
	 * - `backfillEvaluator` receives an OVERLAY row (data columns plus the flag) and
	 *   routes through {@link computeAddColumnValue} — the same helper
	 *   {@link validateOverlayMigration} dry-runs, so validation and forward cannot
	 *   drift: NULL for a tombstone row, else the engine's per-row `new.<col>` evaluator
	 *   over the flag-stripped row, or the folded literal default.
	 */
	private buildOverlayAddColumnChange(
		change: Extract<SchemaChangeInfo, { type: 'addColumn' }>,
		addColumnCtx: AddColumnBackfillContext,
		overlayTable: VirtualTable,
	): SchemaChangeInfo {
		const tombstoneIdx = overlayTable.tableSchema?.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (tombstoneIdx === undefined) {
			throw new QuereusError(`Tombstone column '${this.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
		}
		const constraints = (change.columnDef.constraints ?? []).filter(c => c.type !== 'notNull');
		if (!constraints.some(c => c.type === 'null')) constraints.push({ type: 'null' });
		return {
			...change,
			columnDef: { ...change.columnDef, constraints },
			insertAtIndex: tombstoneIdx,
			backfillEvaluator: (overlayRow: Row) => this.computeAddColumnValue(addColumnCtx, overlayRow, tombstoneIdx),
		};
	}

	/**
	 * Forwards one ALTER COLUMN attribute change to an already-open overlay IN PLACE, with the
	 * NOT NULL attribute deliberately withheld.
	 *
	 * `set data type` / `set collate` / `set default` forward through the overlay's own
	 * `alterSchema`: the overlay module converts / re-keys its open transaction layers with
	 * their savepoint snapshots intact, and NULLs pass a retype untouched, so tombstone rows —
	 * placeholder NULLs at every non-key data column — ride through unharmed.
	 *
	 * `set not null` must NOT forward: the overlay's copy of the column stays nullable.
	 * Tombstone rows carry NULL at every non-PK data column, so the overlay module's own
	 * tightening would backfill a deletion marker's placeholder NULL from the DEFAULT
	 * (corrupting a row that is not a row) or reject it outright when no usable DEFAULT
	 * exists. The base's NOT NULL is enforced where it belongs — by the underlying over the
	 * issuer's effective rows, and per overlay by {@link validateOverlayMigration} — and the
	 * staged LIVE rows' NULLs are filled here via {@link backfillStagedNotNull}. The runtime
	 * admits exactly one attribute per ALTER COLUMN, so a `setNotNull` change carries nothing
	 * else to forward. A missing overlay `alterSchema` is a no-op, as in
	 * {@link forwardColumnShapeToOverlay}.
	 */
	private async forwardAlterColumnToOverlay(
		overlayState: ConnectionOverlayState,
		change: Extract<SchemaChangeInfo, { type: 'alterColumn' }>,
		setNotNullCtx: SetNotNullBackfillContext | undefined,
	): Promise<void> {
		if (change.setNotNull !== undefined) {
			if (change.setNotNull === true && setNotNullCtx?.hasDefault) {
				await this.backfillStagedNotNull(overlayState, setNotNullCtx);
			}
			return;
		}
		if (!overlayState.overlayTable.alterSchema) return;
		await overlayState.overlayTable.alterSchema(change);
	}

	/**
	 * Backfills a `set not null` tightening into an overlay's staged LIVE rows: every
	 * non-tombstone row holding NULL at the tightened column is rewritten with the column's
	 * folded literal DEFAULT through the overlay's ordinary write path, so the overlay's layer
	 * chain and savepoint snapshots stay intact — the overlay-side mirror of the value rewrite
	 * the underlying applies to its committed rows. Tombstone rows are never touched
	 * ({@link stagedLiveRows}).
	 *
	 * Only called with a usable DEFAULT ({@link SetNotNullBackfillContext.hasDefault}); the
	 * no-DEFAULT case rejects (issuer) or poisons (foreign) in {@link validateOverlayMigration}
	 * before any overlay is touched.
	 *
	 * NOTE: these rewrites land in the overlay's CURRENT savepoint frame — each is a normal
	 * staged write. A later `rollback to savepoint` taken BEFORE this ALTER therefore restores
	 * the pre-backfill NULL while the column stays NOT NULL (DDL is not transactional here).
	 * That is the same class of divergence as any rolled-back row violating surviving DDL — a
	 * row un-inserted past an ADD CONSTRAINT, say — tracked by the backlog ticket
	 * `bug-rolled-back-rows-violate-surviving-ddl`, not a new hole opened by this forward.
	 */
	private async backfillStagedNotNull(
		overlayState: ConnectionOverlayState,
		ctx: SetNotNullBackfillContext,
	): Promise<void> {
		const overlay = overlayState.overlayTable;
		const overlaySchema = overlay.tableSchema;
		if (!overlaySchema || !overlay.query) return;
		const tombstoneIdx = overlaySchema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (tombstoneIdx === undefined) {
			throw new QuereusError(`Tombstone column '${this.tombstoneColumn}' missing from overlay schema`, StatusCode.INTERNAL);
		}
		const pkIndices = overlaySchema.primaryKeyDefinition.map(def => def.index);
		// Materialize before writing: the rewrites mutate the overlay's pending layer the
		// scan is reading through.
		const toFill: Row[] = [];
		for await (const row of this.stagedLiveRows(overlay, tombstoneIdx)) {
			if (row[ctx.colIndex] === null) toFill.push(row);
		}
		for (const row of toFill) {
			const values = row.map((v, i) => (i === ctx.colIndex ? ctx.foldedDefault : v)) as SqlValue[];
			// No `onConflict`, so `UpdateResult` is exactly `ok | constraint`. A constraint here
			// (the filled value colliding under a UNIQUE) is a data condition of this overlay's
			// staged rows — thrown as CONSTRAINT for applyInPlaceOverlayChange to route to
			// INTERNAL (issuer, whose merged rows the underlying's own converted-row UNIQUE
			// re-validation already judged) or poison (foreign).
			const result: UpdateResult = await overlay.update({
				operation: 'update',
				values,
				oldKeyValues: pkIndices.map(i => row[i] as SqlValue),
				preCoerced: true,
			});
			if (isConstraintViolation(result)) {
				throw new QuereusError(
					`Backfilling column '${ctx.colName}' in overlay '${overlaySchema.name}' hit a ${result.constraint} constraint: ${result.message ?? 'no message'}`,
					StatusCode.CONSTRAINT,
				);
			}
		}
	}

	/**
	 * Forwards one ADD CONSTRAINT to an already-open overlay, per constraint class:
	 *
	 * - **UNIQUE** is NOT forwarded as a constraint. The AST `TableConstraint` carries no
	 *   partial-predicate field, so a bare forward would enforce uniqueness over tombstone rows
	 *   too — a UNIQUE whose columns sit inside the primary key would see two deleted rows
	 *   (each carrying its PK and placeholder NULLs elsewhere) as duplicates of each other.
	 *   Instead it lands as a tombstone-narrowed **unique index** through the same route CREATE
	 *   INDEX takes ({@link installOverlayUniqueConstraint}).
	 * - **CHECK** forwards verbatim: the overlay module appends it schema-only (no row scan, no
	 *   physical structure). Enforcement is engine-side at DML plan time against the user
	 *   table; the overlay's copy exists so a later DROP / RENAME CONSTRAINT resolves it.
	 * - **FOREIGN KEY** is deliberately NOT forwarded. FK enforcement is engine-side
	 *   (planner-synthesized EXISTS checks) — the overlay never enforces it — and the overlay
	 *   module's ADD arm validates existing child rows through a catalog query by table name,
	 *   which the unregistered `_overlay_*` staging table cannot serve. The presence guard in
	 *   {@link forwardConstraintNameChangeToOverlay} keeps a later DROP / RENAME of the
	 *   unforwarded FK a clean no-op on the overlay.
	 * - **PRIMARY KEY** cannot reach here — both bundled underlyings reject
	 *   `add constraint … primary key` with UNSUPPORTED before any overlay work — so it asserts
	 *   INTERNAL rather than leaving a silent gap for a third-party underlying that accepts it
	 *   (the overlay could not follow; see the alterPrimaryKey handling in {@link alterTable}).
	 */
	private async forwardAddConstraintToOverlay(
		overlayState: ConnectionOverlayState,
		change: Extract<SchemaChangeInfo, { type: 'addConstraint' }>,
		updatedSchema: TableSchema,
	): Promise<void> {
		switch (change.constraint.type) {
			case 'unique':
				await this.installOverlayUniqueConstraint(overlayState, change.constraint, updatedSchema);
				return;
			case 'check':
				if (overlayState.overlayTable.alterSchema) await overlayState.overlayTable.alterSchema(change);
				return;
			case 'foreignKey':
				return;
			case 'primaryKey':
				throw new QuereusError(
					`Isolation layer: the underlying accepted 'add constraint … primary key' on '${updatedSchema.schemaName}.${updatedSchema.name}', which the per-connection overlays cannot follow.`,
					StatusCode.INTERNAL,
				);
		}
	}

	/**
	 * Installs one runtime-added UNIQUE constraint on an overlay as a tombstone-narrowed unique
	 * index (see {@link forwardAddConstraintToOverlay} for why a bare constraint forward is
	 * wrong). Column indices and per-column collations are read from the post-alter underlying
	 * schema — the canonical form, positionally identical to the overlay's data columns (the
	 * tombstone flag is appended last). The index is named `constraint name ?? '_uc_<cols>'`,
	 * the memory module's own covering-index naming rule (`implicitIndexNameFor`), so the
	 * derived UNIQUE the overlay module synthesizes from it resolves under the SAME name a
	 * later DROP / RENAME CONSTRAINT forward carries.
	 *
	 * `MemoryTableManager.createIndex` pre-validates the overlay's effective rows against the
	 * narrowed predicate before any mutation, so a staged duplicate raises CONSTRAINT with the
	 * overlay untouched — routed by the caller to INTERNAL (the issuer, whose merged rows the
	 * underlying already judged via {@link issuerEffectiveRows}) or poison (a foreign overlay).
	 * A missing overlay `createIndex` is a no-op, as in the index paths.
	 */
	private async installOverlayUniqueConstraint(
		overlayState: ConnectionOverlayState,
		constraint: Extract<SchemaChangeInfo, { type: 'addConstraint' }>['constraint'],
		updatedSchema: TableSchema,
	): Promise<void> {
		const overlayTable = overlayState.overlayTable;
		const overlaySchema = overlayTable.tableSchema;
		if (!overlayTable.createIndex || !overlaySchema) return;
		const columns = (constraint.columns ?? []).map(col => {
			const idx = updatedSchema.columnIndexMap.get(col.name.toLowerCase());
			if (idx === undefined) {
				throw new QuereusError(
					`Isolation layer: UNIQUE constraint column '${col.name}' not found on '${updatedSchema.schemaName}.${updatedSchema.name}' after the underlying accepted the constraint.`,
					StatusCode.INTERNAL,
				);
			}
			return idx;
		});
		const indexName = constraint.name ?? `_uc_${columns.map(i => updatedSchema.columns[i].name).join('_')}`;
		if (this.schemaHasIndex(overlaySchema, indexName)) return;
		// A runtime-added UNIQUE carries no partial predicate of its own (the AST has no field
		// for one), so the overlay predicate is exactly the live-rows narrowing.
		await overlayTable.createIndex({
			name: indexName,
			columns: columns.map(i => ({ index: i, collation: updatedSchema.columns[i]?.collation })),
			unique: true,
			predicate: this.overlayPredicate(undefined, updatedSchema.name, overlaySchema.name),
		});
	}

	/**
	 * Forwards DROP / RENAME CONSTRAINT to an already-open overlay, presence-guarded: a
	 * constraint the overlay never carried is skipped silently rather than letting the overlay
	 * module's NOTFOUND abort the issuer's already-applied ALTER. The guard is what makes the
	 * unforwarded classes safe ({@link forwardAddConstraintToOverlay}: FOREIGN KEY always, and
	 * UNIQUE under an overlay module without `createIndex`) — their DROP / RENAME is simply a
	 * no-op on the overlay.
	 *
	 * For a UNIQUE the overlay module drops/renames the constraint AND its covering index in
	 * lock-step — both live under the constraint's name (or the `_uc_<cols>` implicit-name
	 * rule), whether copied at overlay creation ({@link createOverlaySchema}) or installed by
	 * {@link installOverlayUniqueConstraint} — so the base and overlay representations stay
	 * resolvable by one name across the whole constraint lifecycle.
	 */
	private async forwardConstraintNameChangeToOverlay(
		overlayState: ConnectionOverlayState,
		change: Extract<SchemaChangeInfo, { type: 'dropConstraint' | 'renameConstraint' }>,
	): Promise<void> {
		const overlayTable = overlayState.overlayTable;
		const overlaySchema = overlayTable.tableSchema;
		if (!overlayTable.alterSchema || !overlaySchema) return;
		const name = change.type === 'dropConstraint' ? change.constraintName : change.oldName;
		if (!this.schemaHasNamedConstraint(overlaySchema, name)) return;
		await overlayTable.alterSchema(change);
	}

	/** Case-insensitive "does `schema` declare a named constraint of ANY class (CHECK / UNIQUE / FOREIGN KEY)". */
	private schemaHasNamedConstraint(schema: TableSchema, constraintName: string): boolean {
		const lower = constraintName.toLowerCase();
		return (schema.checkConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
			|| (schema.uniqueConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
			|| (schema.foreignKeys ?? []).some(c => c.name?.toLowerCase() === lower);
	}

	/**
	 * Carries one overlay across an ALTER PRIMARY KEY, which no overlay can follow in place:
	 * its layer BTrees are keyed by the OLD primary key, and a staged tombstone identifies the
	 * row it deletes BY that key — under a new key a tombstone's identity columns may be
	 * placeholder NULLs, i.e. garbage. So:
	 *
	 * - An overlay WITH staged rows is either the ISSUER's — unreachable, {@link alterTable}
	 *   rejected it before the underlying mutated, so assert INTERNAL — or FOREIGN, which is
	 *   poisoned exactly like a foreign overlay whose staged values a retype cannot convert.
	 * - A CLEAN overlay stages nothing; it is swapped for a fresh empty staging table built
	 *   from the post-alter schema, so later writes in this transaction key by the new primary
	 *   key. The fresh table's connection registers lazily at its first write, replaying the
	 *   active savepoint stack — correct for a table with no pre-existing staged rows (the
	 *   replay hazard is only ever about rows copied beneath it, and there are none).
	 */
	private async replaceOverlayForPrimaryKeyChange(
		key: string,
		state: ConnectionOverlayState,
		isIssuer: boolean,
		schemaName: string,
		tableName: string,
		updatedSchema: TableSchema,
		change: SchemaChangeInfo,
	): Promise<void> {
		if (state.hasChanges) {
			if (isIssuer) {
				throw new QuereusError(
					`Isolation layer: the issuer's overlay for '${schemaName}.${tableName}' reached alterPrimaryKey migration with staged rows; the pre-mutation guard in alterTable must reject this first.`,
					StatusCode.INTERNAL,
				);
			}
			state.poison = { message: this.buildAlterPoisonMessage(schemaName, tableName, change) };
			return;
		}
		const fresh = await this.overlayModule.create(state.db, this.createOverlaySchema(updatedSchema));
		this.connectionOverlays.set(key, { overlayTable: fresh, hasChanges: false, db: state.db });
		await this.releaseOverlayTable(state);
	}

	/**
	 * Creates overlay schema from underlying schema.
	 * Adds tombstone column and uses unique name to avoid conflicts.
	 *
	 * Called by IsolatedTable when lazily creating its overlay, and by the ALTER PRIMARY KEY
	 * clean-overlay swap (`replaceOverlayForPrimaryKeyChange`). Index DDL and every other ALTER
	 * adopt in place — a new UNIQUE arrives through {@link createOverlayIndexSchema} /
	 * {@link overlayPredicate}, which this method shares.
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

		return {
			...baseSchema,
			name: overlayName,
			columns: newColumns,
			columnIndexMap: newColumnIndexMap,
			indexes: baseSchema.indexes?.map(idx => this.createOverlayIndexSchema(idx, baseSchema.name, overlayName)),
			uniqueConstraints: baseSchema.uniqueConstraints?.map(uc => ({
				...uc,
				predicate: this.overlayPredicate(uc.predicate, baseSchema.name, overlayName),
			})),
		};
	}

	/**
	 * The overlay-flavored form of one base `IndexSchema`: same name and columns, predicate
	 * narrowed to live rows and rescoped onto the overlay's table name (see
	 * {@link overlayPredicate}).
	 *
	 * Shared by {@link createOverlaySchema}, which maps the whole index set when an overlay is
	 * first created, and {@link createIndex}, which hands a single index to an overlay that is
	 * already open — so both produce structurally identical entries, and the UNIQUE constraint
	 * `MemoryTableManager.createIndex` synthesizes from a unique index inherits the same
	 * predicate either way.
	 */
	private createOverlayIndexSchema(idx: IndexSchema, baseName: string, overlayName: string): IndexSchema {
		return { ...idx, predicate: this.overlayPredicate(idx.predicate, baseName, overlayName) };
	}

	/**
	 * `<base predicate, rescoped to the overlay> AND <tombstone> = 0`.
	 *
	 * A partial-index / UNIQUE predicate copied from the base carries a self-qualifier bound to
	 * the base table's name (e.g. `where t.v > 0`). The overlay renames the table to
	 * `overlayName`, so that qualifier now names a DIFFERENT table than the overlay's
	 * MemoryIndex is scoped to — and `compilePredicate` rejects a foreign qualifier at
	 * index-build time (see partial-index-predicate table-qualifier rejection). Rescope the
	 * self-qualifier to the overlay name so it stays a self-reference. A foreign qualifier
	 * cannot occur here: `compilePredicate` already rejected one when the base index/UNIQUE
	 * was created, so every qualifier present is the base name.
	 */
	private overlayPredicate(base: Predicate | undefined, baseName: string, overlayName: string): Predicate {
		const rescoped = base ? rescopePredicateQualifier(base, baseName, overlayName) : undefined;
		return andPredicate(rescoped, this.liveRowPredicate());
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
