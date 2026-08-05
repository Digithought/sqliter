import type { Database } from '../core/database.js'; // Assuming Database class exists
import type { VirtualTable } from './table.js';

import type { ColumnDef, Expression, TableConstraint } from '../parser/ast.js'; // <-- Add parser AST import
import type { TableSchema, IndexSchema } from '../schema/table.js'; // Add import for TableSchema and IndexSchema
import type { BestAccessPlanRequest, BestAccessPlanResult } from './best-access-plan.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { ModuleCapabilities } from './capabilities.js';
import type { MappingAdvertisement } from './mapping-advertisement.js';
import type { BackingHost } from './backing-host.js';
import type { Schema } from '../schema/schema.js';
import type { ViewSchema } from '../schema/view.js';
import type { LensDeploymentSnapshot } from '../schema/lens.js';
import type { Row, SqlValue } from '../common/types.js';

/**
 * Base interface for module-specific configuration passed to create/connect.
 * Modules should define their own interface extending this if they need options.
 */
export interface BaseModuleConfig {
	/** When true, the module should provide read-only access to the committed (pre-transaction) state */
	_readCommitted?: boolean;
}

/**
 * Declares whether a virtual table module tolerates concurrent calls on a
 * single connection. Consulted by parallel runtime consumers (e.g. fan-out
 * lookup joins) to decide whether sibling branches may share a connection
 * or must serialize.
 *
 * - `'serial'` — runtime must serialize vtab calls per connection. Safe
 *   default for any module that has not been audited; defeats parallelism
 *   for that module.
 * - `'reentrant-reads'` — concurrent `query()` calls on a single
 *   connection are safe; writes (`update()`, savepoint ops, etc.) still
 *   serialize.
 * - `'fully-reentrant'` — no constraint; any operation is safe to
 *   interleave with any other on the same connection.
 */
export type VtabConcurrencyMode = 'serial' | 'reentrant-reads' | 'fully-reentrant';

/**
 * The rows the DDL-issuing connection can currently SEE — committed rows merged with that
 * connection's own uncommitted writes.
 *
 * Supplied only by a wrapper module (today: the isolation layer) that holds those pending rows
 * outside the target module, where the target module cannot reach them. When present, the target
 * module MUST use this stream for every row-CONTENT judgement it makes (UNIQUE duplicate
 * detection, collation-rekey collision detection) and MUST NOT reject the DDL over a duplicate
 * that exists only in its own committed data. Physical structures are still built from the
 * module's own rows — an index entry with no live row behind it is harmless, because every
 * reader resolves an entry back to its live row and drops it if the row is gone.
 *
 * Re-callable: each call returns a fresh stream (a single ALTER may validate more than once).
 * Omitted by the engine's own emitters, which leaves each module on its own effective stream.
 */
export type EffectiveRowSource = () => AsyncIterable<Row>;

/**
 * Assessment result from a module's supports() method indicating
 * whether it can execute a plan subtree and at what cost.
 */
export interface SupportAssessment {
	/** Estimated cost comparable to local evaluation cost */
	cost: number;
	/** Optional context data persisted for the emitter */
	ctx?: unknown;
}

/**
 * Interface defining the methods for a virtual table module implementation.
 * The module primarily acts as a factory for connection-specific VirtualTable instances.
 *
 * @template TTable The specific type of VirtualTable managed by this module.
 * @template TConfig The type defining module-specific configuration options.
 */
export interface VirtualTableModule<
	TTable extends VirtualTable,
	TConfig extends BaseModuleConfig = BaseModuleConfig
> {

	/**
	 * Declares whether the runtime may issue concurrent calls (query, update,
	 * connect, …) against tables owned by this module while another call is
	 * already in flight on the same connection. Read by `ParallelDriver`
	 * consumers (e.g. FanOutLookupJoin) to decide whether sibling branches
	 * may share a connection or must serialize.
	 *
	 * - `'serial'` (default) — runtime serializes vtab calls per connection.
	 *   Safe for any module that has not been audited; defeats parallelism
	 *   for that module.
	 * - `'reentrant-reads'` — concurrent `query()` calls on a single
	 *   connection are safe; writes (`update()`, savepoint ops, etc.)
	 *   continue to serialize.
	 * - `'fully-reentrant'` — no constraint; any operation is safe to
	 *   interleave with any other on the same connection.
	 *
	 * Omit to inherit `'serial'`.
	 */
	readonly concurrencyMode?: VtabConcurrencyMode;

	/**
	 * Optional hint: expected first-row latency in milliseconds for an iterator
	 * opened against tables of this module. Local in-process modules omit this
	 * (treated as 0). Remote / network-backed modules should declare a non-zero
	 * value so the parallel fan-out rule can amortize per-branch latency across
	 * concurrent branches.
	 *
	 * Read by `TableReferenceNode.computePhysical` and propagated through the
	 * subtree via the standard `expectedLatencyMs` max-merge. Consumers must
	 * treat the value as a heuristic; correctness must never depend on it.
	 */
	readonly expectedLatencyMs?: number;

	/**
	 * Declares whether a `query()` iterator opened against a table of this module
	 * sees a STABLE snapshot even if `update()` mutates the same table mid-scan —
	 * i.e. the module is immune to the physical Halloween hazard where a predicate
	 * `DELETE`/`UPDATE` mutates the very structure its own source scan cursor is
	 * still walking.
	 *
	 * The DML executor consults this to decide whether a predicate DELETE/UPDATE
	 * may stream (pull one source row, apply the mutation inline, pull the next
	 * from the same live cursor) or must first fully drain the source match set
	 * into a buffer before applying any write:
	 *
	 * - `true` — the module snapshots reads (e.g. onto an immutable layer), so the
	 *   scan cursor never observes the concurrent write. The executor STREAMS,
	 *   avoiding the O(match-set) buffering spike.
	 * - `false` / omitted (**default**) — the module's scan cursor may cache a path
	 *   into a shared structure that a mid-scan write invalidates (a plain b-tree
	 *   cursor). The executor DRAINS the match set before mutating, so the cursor
	 *   is closed before the first write.
	 *
	 * The false default is **correctness-first**: any durable / third-party store
	 * is safe out of the box (it buffers) and opts into streaming only after it can
	 * prove per-scan snapshot isolation. See `docs/runtime.md` § "DML executor:
	 * read/write phase separation".
	 */
	readonly scanSnapshotIsolation?: boolean;

	/**
	 * Declares that a connection opened with the `_readCommitted` connect option
	 * serves a STABLE, self-consistent snapshot of committed state for the life of
	 * the scan — see `docs/module-authoring.md` § "Committed-Snapshot Reads
	 * (`_readCommitted`)" for the full obligation an out-of-tree module takes on.
	 *
	 * In one sentence: such a connection must serve a state that is consistent as
	 * of some commit boundary at or before the moment the read began, and must keep
	 * serving that same state for the whole scan — across another connection's
	 * commit landing mid-iteration, across concurrent DDL on that table, and across
	 * index-driven access paths (an index-driven plan and a full scan of the same
	 * connection must agree).
	 *
	 * Omit (default `false`) to decline the engine's concurrent committed-read
	 * path; reads against this module then keep taking today's serialized path.
	 * Declining is not a defect — `_readCommitted` on its own still means only
	 * "do not show me the writer's staged rows", which is a weaker promise and is
	 * all several out-of-tree modules implement.
	 *
	 * **Orthogonal to {@link concurrencyMode}.** That enum answers "may the runtime
	 * issue concurrent calls on ONE connection?"; the committed-read path opens its
	 * own separate connection, so intra-connection reentrancy is not what is at
	 * stake. What is at stake is whether the module's shared, cross-connection
	 * state tears while a commit publishes. A `'fully-reentrant'` module can still
	 * publish commits incrementally, so reusing that enum would over-promise.
	 *
	 * **Also distinct from {@link scanSnapshotIsolation} above**, despite the shared
	 * word: that one is about ONE connection's own scan surviving ITS OWN writes
	 * (the Halloween case, which the DML executor resolves by buffering). This one is
	 * about a read connection surviving ANOTHER connection's commit. A module can
	 * hold either without the other.
	 */
	readonly readCommittedSnapshot?: boolean;

	/**
	 * Creates the persistent definition of a virtual table.
	 * Called by CREATE VIRTUAL TABLE to define schema and initialize storage.
	 *
	 * This method is async to allow modules to perform storage initialization
	 * (e.g., creating IndexedDB object stores) before returning. This ensures
	 * the table's storage is ready before any schema change events are processed.
	 *
	 * @param db The database connection
	 * @param tableSchema The schema definition for the table being created
	 * @returns Promise resolving to the new VirtualTable instance
	 * @throws QuereusError on failure
	 */
	create(
		db: Database,
		tableSchema: TableSchema,
	): Promise<TTable>;

	/**
	 * Optional. Creates a materialized-view BACKING table, preferred by
	 * {@link SchemaManager.createBackingTable} over {@link create} when present
	 * (`createBacking?.() ?? create()`). Presence is the capability (mirrors
	 * {@link getBackingHost?}): a durable-backing module routes the backing into
	 * its durable store here instead of building an ordinary relational table, so
	 * the subsequent {@link getBackingHost} resolves a real host. Same
	 * signature/contract as {@link create}; omit ⇒ backings go through
	 * {@link create} (today's behavior).
	 */
	createBacking?(
		db: Database,
		tableSchema: TableSchema,
	): Promise<TTable>;

	/**
	 * Connects to an existing virtual table definition.
	 * Called when the schema is loaded or a connection needs to interact with the table.
	 *
	 * This method is async to allow modules to perform async initialization when connecting
	 * to existing tables (e.g., opening IndexedDB transactions, loading metadata).
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table to connect to
	 * @param options Module-specific configuration options from the original CREATE VIRTUAL TABLE
	 * @param tableSchema Optional table schema when connecting during import (columns, PK, etc.)
	 * @returns Promise resolving to the connection-specific VirtualTable instance
	 * @throws QuereusError on failure
	 */
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: TConfig,
		tableSchema?: TableSchema
	): Promise<TTable>;

	/**
	 * Determines if this module can execute a plan subtree starting at the given node.
	 * Used for query push-down to virtual table modules that support arbitrary queries.
	 *
	 * @param node The root node of the subtree to evaluate
	 * @returns Assessment with cost and optional context, or undefined if not supported
	 */
	supports?(
		node: PlanNode
	): SupportAssessment | undefined;

	/**
	 * Modern, type-safe access planning interface.
	 * Preferred over xBestIndex for new implementations.
	 *
	 * @param db The database connection
	 * @param tableInfo The schema information for the table being planned
	 * @param request Planning request with constraints and requirements
	 * @returns Access plan result describing the chosen strategy
	 */
	getBestAccessPlan?(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult;

	/**
	 * Destroys the underlying persistent representation of the virtual table.
	 * Called by DROP TABLE.
	 *
	 * @param db The database connection
	 * @param pAux Client data passed during module registration
	 * @param moduleName The name the module was registered with
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table being destroyed
	 * @throws QuereusError on failure
	 */
	destroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void>;

	/**
	 * Creates an index on a virtual table.
	 * Called by CREATE INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table
	 * @param indexSchema The schema definition for the index being created
	 * @param rows Optional {@link EffectiveRowSource}. When supplied, the UNIQUE duplicate
	 *   check MUST run over this stream instead of the module's own rows.
	 * @throws QuereusError on failure
	 */
	createIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexSchema: IndexSchema,
		rows?: EffectiveRowSource,
	): Promise<void>;

	/**
	 * Drops an index from a virtual table.
	 * Called by DROP INDEX.
	 *
	 * @param db The database connection
	 * @param schemaName The name of the database schema
	 * @param tableName The name of the virtual table that owns the index
	 * @param indexName The name of the index to drop
	 * @throws QuereusError on failure
	 */
	dropIndex?(
		db: Database,
		schemaName: string,
		tableName: string,
		indexName: string
	): Promise<void>;

	/**
	 * Returns capability flags for this module.
	 * Used for runtime capability discovery.
	 */
	getCapabilities?(): ModuleCapabilities;

	/**
	 * Optional. Returns the logical→basis decompositions this module recognizes
	 * over the given basis schema (see {@link MappingAdvertisement}). A dedicated
	 * module (columnar/EAV/nd-tree) synthesizes them from its own knowledge; a
	 * generic module (memory/store) delegates to the shared tag builder
	 * (`buildAdvertisementsFromTags`) over its tables' reserved
	 * `quereus.lens.decomp.*` tags. Consulted by the lens compiler's resolver
	 * (`schema/lens-compiler.ts`). Omit ⇒ name-match only (today's behavior).
	 *
	 * The method is **module-level given the basis schema** (not per-table): a
	 * module spans many tables and a decomposition spans many relations, so it
	 * returns every decomposition it recognizes and the resolver indexes them.
	 * Presence of the method is the capability — no `ModuleCapabilities` flag.
	 */
	getMappingAdvertisements?(
		db: Database,
		basisSchema: Schema,
	): readonly MappingAdvertisement[];

	/**
	 * Optional. Returns the privileged backing-host surface for a table this
	 * module owns, or undefined when the table is unknown to it. Presence of
	 * the method is the capability (mirrors getMappingAdvertisements): a module
	 * implementing it may host materialized-view backing tables. See
	 * vtab/backing-host.ts for the semantic and cost contract.
	 */
	getBackingHost?(db: Database, schemaName: string, tableName: string): BackingHost | undefined;

	/**
	 * Optional. Materialize a durable backing for an ALREADY-EXISTING ordinary
	 * table that is being attached as maintained (`alter table … set maintained
	 * as <body>` / `create table … maintained`), BEFORE the attach reconcile
	 * resolves the table's backing host via {@link getBackingHost}. A module whose
	 * `getBackingHost` resolves over a SEPARATE durable store (not the live table's
	 * own storage) needs this seam because the engine's attach core only RESOLVES
	 * (never creates) the host on the non-reshape path, so the store must exist by
	 * the time `resolveBackingHost` runs.
	 *
	 * `backingSchema` is the (possibly reshaped) live schema the store must be
	 * sized to — call it AFTER the reshape `preReconcileOps` and `schema.addTable`.
	 * Idempotent: a re-attach over an already-maintained table reuses the existing
	 * store. No-op for modules whose `getBackingHost` already resolves over the
	 * live table (e.g. memory) — they omit the method entirely, so the optional
	 * call is a pure no-op. Omit ⇒ the engine resolves the host as-is (today's
	 * behavior).
	 *
	 * **Late-backing seam vs the replicable gate.** This is the seam the MV
	 * replicable-determinism gate fires BEFORE (the gate runs at
	 * `registerMaterializedView`, ahead of this call). A module materializing its
	 * store late here is therefore fine PROVIDED its `getBackingHost` capability
	 * surface still resolves eagerly — see the eager-resolution invariant on
	 * {@link BackingHost.requiresReplicableDerivations}. A host that both demands
	 * replicable derivations AND defers `getBackingHost` to this call would slip the
	 * gate; the attach core's defensive guard catches that as a loud INTERNAL error.
	 */
	ensureBackingForAttach?(
		db: Database,
		schemaName: string,
		tableName: string,
		backingSchema: TableSchema,
	): Promise<void>;

	/**
	 * Optional. Retire the durable backing when a maintained table is detached
	 * (`alter table … drop maintained`), leaving the table ORDINARY and
	 * user-writable with its current (maintained) rows intact. The counterpart to
	 * {@link ensureBackingForAttach}: a module that migrated the table into a
	 * separate durable store on attach migrates the rows back into ordinary
	 * storage here and drops the store, so subsequent reads/writes route through
	 * the ordinary table surface.
	 *
	 * `plainSchema` is the detached (derivation-less) schema. No-op for modules
	 * with a single physical storage (e.g. memory) — they omit the method. Omit ⇒
	 * detach is catalog-only (today's behavior).
	 */
	retireBackingForAttach?(
		db: Database,
		schemaName: string,
		tableName: string,
		plainSchema: TableSchema,
	): Promise<void>;

	/**
	 * Optional. Discard the durable backing {@link ensureBackingForAttach} freshly
	 * created when a FRESH attach (not a re-attach over an already-maintained table)
	 * FAILS after the store was created (a reconcile / declared-constraint
	 * violation). The table reverts to its original ordinary form; this drops the
	 * just-created store and leaves ordinary storage UNTOUCHED — distinct from
	 * {@link retireBackingForAttach}, which migrates store rows back into ordinary
	 * storage (here the ordinary storage still holds the pre-attach rows and the
	 * store is empty / rolled-back, so a migrate would clobber them).
	 *
	 * Only called for a fresh attach (no prior derivation) whose reconcile did not
	 * commit, AND only from the `alter table … set maintained` verb — NOT from
	 * `create table … maintained`, where the create path's own `dropTable` already
	 * retires the store (a discard there would double-drop). That verb gating lives
	 * on the `discardBackingOnFailure` flag of `attachMaintainedDerivation`, where
	 * the full rationale and the firing condition are documented. No-op for modules
	 * with a single physical storage. Omit ⇒ attach failure is catalog-only rollback
	 * (today's behavior).
	 */
	discardBackingForAttach?(
		db: Database,
		schemaName: string,
		tableName: string,
	): Promise<void>;

	/**
	 * Alter an existing table's structure. Called by ALTER TABLE for
	 * data-affecting changes — every `SchemaChangeInfo` arm: ADD / DROP /
	 * RENAME COLUMN, ADD / DROP / RENAME CONSTRAINT, ALTER COLUMN, ALTER
	 * PRIMARY KEY. RENAME TABLE is schema-only and routes through `renameTable`,
	 * not this method. See docs/module-authoring.md § "Schema Changes
	 * (`SchemaChangeInfo`)" for the per-arm mandate each arm carries.
	 *
	 * Returns the updated TableSchema after the operation. The engine
	 * registers this in the schema catalog.
	 *
	 * If not implemented, the engine rejects data-affecting ALTER operations
	 * (`renameColumn` degrades to an engine-side schema-only rename instead).
	 *
	 * `rows` is an optional {@link EffectiveRowSource}. When supplied, the row-validating
	 * arms (`addConstraint … unique`, `alterColumn … set collate`) MUST judge that stream
	 * rather than the module's own rows.
	 */
	alterTable?(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
		rows?: EffectiveRowSource,
	): Promise<TableSchema>;

	/**
	 * Rename a table. Called by ALTER TABLE ... RENAME TO before the engine
	 * updates the in-memory schema catalog.
	 *
	 * The module is responsible for re-keying any internal handles, moving
	 * physical storage, and updating any persistent catalog entries it owns.
	 * The engine updates the `SchemaManager` after this call returns.
	 *
	 * If not implemented, RENAME TO is treated as a schema-only rename; modules
	 * that persist data keyed by the table name must implement this hook.
	 *
	 * `ddl` carries the statement's canonical, fully-qualified SQL under the same
	 * rule as {@link SchemaChangeInfo}'s `ddl`: set only when this call IS the
	 * statement's action, and an emitter-backed module emits its schema-change
	 * event iff it is set — putting the text (and the old table name, as
	 * `oldObjectName`) on the event. Absent ⇒ engine-internal step ⇒ no event.
	 */
	renameTable?(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
		ddl?: string,
	): Promise<void>;

	/**
	 * Optional second phase of RENAME TABLE, called by the engine at the END of
	 * ALTER TABLE ... RENAME TO — AFTER the engine has propagated the rename into every
	 * dependent object (rewriting CHECK / FK / partial-index predicates in OTHER tables,
	 * plus view and materialized-view bodies) and fired their schema-change events.
	 *
	 * A module that persists its catalog by table name uses this to drop any now-superseded
	 * OLD-name catalog state, but only once those dependent rewrites are durable. Splitting
	 * the old-name removal out of {@link renameTable} (which runs BEFORE propagation) keeps
	 * the durable catalog from ever holding a dependent that names a table already deleted:
	 * a crash in that gap would otherwise strand an un-rehydratable set. Modules that keep no
	 * per-name persistent catalog can omit this hook.
	 */
	finalizeRename?(
		db: Database,
		schemaName: string,
		oldName: string,
		newName: string,
	): Promise<void>;

	/**
	 * Optional. Called once by APPLY SCHEMA before the migration-DDL loop runs,
	 * iff there are migration statements to execute. The module may use this to
	 * open an in-memory overlay/batch that subsequent create/destroy/alter
	 * callbacks (during the loop) join, so the whole APPLY SCHEMA produces a
	 * single substrate commit.
	 *
	 * The hook runs inside the engine's exec() mutex hold, so the batch lives
	 * entirely within one engine-level execution scope.
	 *
	 * Modules that own no tables in `schemaName` should no-op.
	 */
	beginSchemaBatch?(db: Database, schemaName: string): Promise<void>;

	/**
	 * Optional. Called exactly once per successful `beginSchemaBatch`, on both
	 * success (`error` undefined) and failure (`error` is the failure that
	 * aborted the migration loop). On error, the module should discard the
	 * in-flight overlay; on success, it commits.
	 *
	 * Errors thrown from `endSchemaBatch` itself are logged and rethrown only
	 * if no prior loop error exists — if a loop error is being propagated, the
	 * end-batch failure is logged and swallowed so the original cause survives.
	 */
	endSchemaBatch?(db: Database, schemaName: string, error?: unknown): Promise<void>;

	/**
	 * Optional. Fired exactly once per successful `apply schema X` of a
	 * **logical** schema, after the lens layer is fully deployed — every lens
	 * view + slot is registered and the deployment snapshot has been rotated into
	 * the `DeclaredSchemaManager`. Hands every registered module the
	 * {@link LensDeploymentSnapshot} that `deployLogicalSchema` just built for
	 * `logicalSchemaName` (read back from the manager's rotated `current`, never
	 * re-derived), so a module backing the basis can realise / reconcile its
	 * backing relations against the freshly deployed lens (e.g. the Lamina adapter's
	 * deploy → basis-reconcile path; see `docs/lens.md` § Module deployment
	 * notification).
	 *
	 * Firing contract:
	 * - **Once per successful apply.** Fires only when `deployLogicalSchema`
	 *   completed without throwing — the deploy is atomic, so a blocked deploy
	 *   (prover error, etc.) never reaches here. A **physical** `apply schema`
	 *   deploys no lens and never fires it.
	 * - **After deploy, not inside a migration batch.** The logical-apply path runs
	 *   no `beginSchemaBatch`/`endSchemaBatch` migration-DDL loop (that is the
	 *   basis / physical path); the notification fires once the lens catalog
	 *   mutation + snapshot rotation are complete — the logical-apply analogue of
	 *   "after `endSchemaBatch`".
	 * - **Snapshot scoped to the affected schema.** `snapshot` is the deployment of
	 *   `logicalSchemaName` only (its just-rotated `current`). An empty deploy —
	 *   every logical table removed from the declaration — still fires, carrying an
	 *   empty-`tables` snapshot, so a consumer can observe the detach.
	 * - **Every registered module is notified, in registration order.** A module
	 *   that backs none of the basis relations should no-op (mirrors the
	 *   `beginSchemaBatch` "owns no tables ⇒ no-op" contract).
	 * - **Errors propagate.** The lens is already deployed when this fires; a
	 *   notification that throws aborts `apply schema X` with that error so the
	 *   caller learns the module's reconcile failed. The deployed lens is **not**
	 *   rolled back — a subsequent re-apply re-fires the notification.
	 * - **Fires while the exec mutex is held.** `apply schema X` is a statement, so
	 *   this hook is awaited mid-statement. A listener whose reconcile re-enters the
	 *   engine (e.g. `Database.ingestExternalRowChanges`, which re-acquires the same
	 *   mutex) MUST NOT await that re-entrant work inline — it deadlocks on the
	 *   chained mutex. Detect the context via {@link Database._isExecuting} and defer
	 *   the re-entrant work to fire-and-forget (it queues on the mutex and runs the
	 *   instant the apply releases it). The sync layer's basis-lifecycle recorder is
	 *   the reference consumer.
	 *
	 * May be sync or async; the engine awaits the result. Omit ⇒ the module is
	 * never consulted on deploy (today's behavior).
	 */
	notifyLensDeployment?(
		db: Database,
		logicalSchemaName: string,
		snapshot: LensDeploymentSnapshot,
	): void | Promise<void>;

	/**
	 * Optional. Called once by {@link Database.registerModule} when this module is
	 * registered on a database, before any table hook (`create`/`connect`/`alterTable`/…)
	 * can fire. A module that must observe the database from the very first statement —
	 * e.g. a persistent-storage module that persists views, which never route through a
	 * table hook — subscribes to `db.schemaManager.getChangeNotifier()` here rather than
	 * waiting for its first table hook to hand it a `db`.
	 *
	 * Synchronous and side-effect-light by contract: it runs inside `registerModule`, which
	 * is itself synchronous, so an async hook could not be awaited. It is called LAST, after
	 * the module is registered and its events are hooked, so a throw propagates out of
	 * `registerModule` but does NOT unregister the module — do not use it to reject a
	 * registration. Registering the SAME module instance on a second `Database` surfaces
	 * whatever a module does about that here rather than at first table use.
	 * Omit ⇒ never called (today's behavior).
	 */
	onRegister?(db: Database, moduleName: string): void;

	/**
	 * Optional pre-flight veto: throw when this module would be UNABLE to durably
	 * persist the catalog entry for `object`. Consulted over every registered module
	 * by the CREATE VIEW / CREATE MATERIALIZED VIEW / ALTER … SET TAGS paths BEFORE
	 * the object is registered (or, for a materialized view, inside `materializeView`'s
	 * existing rollback arm), so a rejection leaves the statement a clean no-op.
	 *
	 * Why a veto instead of an error on the persist itself: catalog persistence for
	 * views and materialized views is **advisory / fire-and-forget** — it rides the
	 * `SchemaChangeNotifier`, whose listeners are wrapped in try/catch, and a store
	 * module chains the actual write onto an async queue. Neither layer can surface a
	 * failure to the statement, so an unpersistable definition would otherwise appear
	 * to succeed and then vanish on reopen. This hook is the ONE synchronous point where
	 * a module can refuse. See `docs/view-persistence.md`.
	 *
	 * Every registered module gets the veto, and one that would not persist `object` must
	 * no-op: views and materialized views are not owned by any one module the way a table
	 * is, and the `'table'` kind is likewise offered to every module regardless of who owns
	 * the table. Synchronous by contract: the check must be a pure function of the schema
	 * (no IO) — so a module answering for `'table'` must decide ownership from what it
	 * already holds in memory, not by reading its catalog. Omit ⇒ never consulted (today's
	 * behavior).
	 *
	 * Call sites, each ahead of its statement's first side effect: `emitCreateView`
	 * (before `schema.addView`); `materializeView` (inside its existing rollback arm — an
	 * MV's DDL text does not exist until the derivation is attached); the two view/MV SET
	 * TAGS paths in `SchemaManager` (tags ride the persisted DDL); and both ALTER RENAME
	 * arms in `runtime/emit/alter-table.ts`, which reach this through
	 * `assertRenameDependentsPersistable` — the pre-flight scan that offers the
	 * PROSPECTIVE (rewritten-on-a-clone) body of every dependent view / materialized view
	 * and the prospective record of every dependent TABLE (the FK / CHECK / partial-index
	 * rewrites a rename propagates into other tables), plus, for a renamed materialized
	 * view, its own prospective record under the new name.
	 *
	 * `'table'` is a RENAME-propagation kind only: `create table` is not gated here, since
	 * it goes through `module.create`, whose failure already reaches the statement.
	 *
	 * Not covered: a `select *` materialized view's persisted backing COLUMN LIST shifts
	 * under a column rename with no AST change and no persist event, so nothing asks here
	 * (see the `NOTE:` on `restoreUnaffectedMaterializedViews`).
	 */
	assertCatalogObjectPersistable?(
		db: Database,
		kind: CatalogObjectKind,
		object: ViewSchema | TableSchema,
	): void;
}

/**
 * The catalog object classes {@link VirtualTableModule.assertCatalogObjectPersistable}
 * arbitrates. `'view'` carries a {@link ViewSchema}; `'materializedView'` carries the
 * maintained {@link TableSchema} (the unified MV record); `'table'` carries an ordinary
 * {@link TableSchema} — a table whose own catalog entry a RENAME propagation would
 * rewrite (its FKs, CHECK expressions or partial-index predicates name the renamed
 * object). A maintained table is offered under BOTH kinds: a store-hosted materialized
 * view persists an ordinary table bundle alongside its MV entry.
 */
export type CatalogObjectKind = 'view' | 'materializedView' | 'table';

/**
 * Defines the structure for schema change information passed to xAlterSchema
 */
export type SchemaChangeInfo = (
	| {
		type: 'addColumn';
		columnDef: ColumnDef;
		/**
		 * Per-row backfill for a column whose value is a function of its row: a
		 * non-foldable DEFAULT (e.g. `new.<col>`), or a GENERATED ALWAYS AS expression.
		 * Given an existing row, returns that row's value for the new column. Absent for
		 * a literal / NULL default (the module bulk-writes the folded value) and for a
		 * column with neither. The engine builds it from the column's DEFAULT / generated
		 * expression evaluated against the existing row, so a module that appends the new
		 * column should call it per existing row instead of writing a single value.
		 *
		 * Its presence is also what a module's "NOT NULL needs a value source" gate should
		 * key on: an evaluator IS a usable source, and a row it evaluates to NULL is
		 * rejected per row during the backfill.
		 */
		backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
		/**
		 * Insert the new column at this index instead of appending. Undefined (the normal
		 * case, and what SQL `alter table … add column` always produces) means append.
		 * A module that cannot honour a position must reject it rather than silently append.
		 *
		 * There is no SQL syntax for this — it is reachable only from an in-process module
		 * wrapper. The one caller today is the transaction-isolation overlay, which keeps a
		 * private bookkeeping column last and so must insert ahead of it.
		 *
		 * NOTE: the engine's own ADD COLUMN pipeline assumes an append in one place a wrapper
		 * can reach — the per-row context it evaluates a column-level CHECK against is built as
		 * `[...existingRow, value]` (`buildAddColumnChecks` in planner/building/alter-table.ts).
		 * So a wrapper that redirects an *engine-driven* `alter table … add column` to a
		 * non-append position must not rely on a column-level CHECK on that column; it would be
		 * evaluated against the append layout. Applying the change straight to a module (the
		 * isolation overlay's case) never goes near that path.
		 */
		insertAtIndex?: number;
	}
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| {
		/**
		 * DROP CONSTRAINT — remove a named table-level constraint by name. The module
		 * resolves the class (CHECK / UNIQUE / FOREIGN KEY), rewrites its schema, and
		 * returns the updated TableSchema. No row migration is needed (constraints
		 * don't change row shape), though dropping a UNIQUE may also tear down the
		 * secondary index backing it.
		 */
		type: 'dropConstraint';
		constraintName: string;
	}
	| {
		/**
		 * RENAME CONSTRAINT — change a named table-level constraint's name. The module
		 * resolves the class and rewrites its schema (and, for a UNIQUE backed by an
		 * implicit covering index named after the constraint, renames that index too).
		 */
		type: 'renameConstraint';
		oldName: string;
		newName: string;
	}
	| {
		/**
		 * ALTER COLUMN with exactly one attribute change.
		 *
		 * Module contract:
		 *   - setNotNull=true with rows containing NULL → throw CONSTRAINT.
		 *     If a DEFAULT is currently set on the column, the module should
		 *     first backfill NULL values with the default and then tighten.
		 *   - setDataType: schema-only if physical type unchanged; otherwise the
		 *     module must convert each row and throw MISMATCH on loss (narrowing,
		 *     NaN, overflow).
		 *   - setDefault / drop default: schema-only. New inserts pick up the
		 *     new default; existing rows are untouched.
		 *   - setCollation: change the column's collation. A module that re-keys its
		 *     own structures (memory AND the store) must re-key / re-sort any PK / UNIQUE /
		 *     index that orders by the column and re-validate uniqueness under the new
		 *     collation (a set unique under BINARY may collide under NOCASE → throw
		 *     CONSTRAINT). The store keys each PK column under its own collation
		 *     (`StoreTable.pkKeyCollations`) and so physically re-keys the data store +
		 *     rebuilds dependent secondary indexes on a PK-column change, throwing
		 *     CONSTRAINT all-or-nothing on a collision. A module that *cannot* re-key
		 *     (e.g. it enforces the PK physically under a single fixed key collation it
		 *     can't change) may instead negotiate accept-when-consistent /
		 *     reject-when-divergent: apply schema-only when the target equals that fixed
		 *     collation, and throw UNSUPPORTED (sited) when it diverges — never silently
		 *     no-op. Unlike tags, collation is real schema.
		 */
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
		setCollation?: string;
	}
) & {
	/**
	 * Canonical, fully-qualified SQL for the ONE statement this call carries out —
	 * the text a peer re-executes to reproduce it. Set by the engine only for the
	 * call that IS the statement's action (rendered at plan-build time from the
	 * resolved table reference, so the table identifier is schema-qualified
	 * regardless of how the user spelled it).
	 *
	 * ABSENT means "engine-internal sub-step" — the inline-constraint installs and
	 * revert calls of `runAddColumn`, and the materialized-view backing reshapes —
	 * and a module must emit NO schema-change event for that call. The rule an
	 * emitter-backed module owes: emit a schema-change event for an `alterTable`
	 * call **iff** `ddl` is set, and put this text on the event. This is what keeps
	 * one statement = one event (`add column x text unique` is one `addColumn` call
	 * plus one `addConstraint` call, but announces once, with the whole statement's
	 * text). See `docs/module-authoring.md` § Schema Changes.
	 */
	readonly ddl?: string;
};

/**
 * Type alias for the common usage pattern where specific table and config types are not known.
 * Use this for storage scenarios like the SchemaManager where modules of different types are stored together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyVirtualTableModule = VirtualTableModule<any, any>;
