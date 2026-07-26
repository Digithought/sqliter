import type { AnyVirtualTableModule, EffectiveRowSource, SchemaChangeInfo } from './module.js';
import type { Database } from '../core/database.js';
import type { TableSchema } from '../schema/table.js';
import type { MaybePromise, Row, SqlValue, CompareFn, UpdateResult } from '../common/types.js';
import type { IndexSchema } from '../schema/table.js';
import type { FilterInfo } from './filter-info.js';
import type { RowOp } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';
import type { VirtualTableConnection } from './connection.js';
import type { PlanNode } from '../planner/nodes/plan-node.js';
import type { VTableEventEmitter } from './events.js';
import type { TableStatistics } from '../planner/stats/catalog-stats.js';

/**
 * Arguments passed to VirtualTable.update() method.
 */
export interface UpdateArgs {
	/** The operation to perform (insert, update, delete) */
	operation: RowOp;
	/** For INSERT/UPDATE, the values to insert/update. For DELETE, undefined */
	values: Row | undefined;
	/** For UPDATE/DELETE, the old key values of the row to modify. Undefined for INSERT */
	oldKeyValues?: Row;
	/** Conflict resolution mode (defaults to ABORT if unspecified) */
	onConflict?: ConflictResolution;
	/** Optional: Deterministic SQL statement that reproduces this mutation (if logMutations is enabled) */
	mutationStatement?: string;
	/**
	 * If true, `values` is already coerced to the table's declared column logical
	 * types (e.g. flushed from an overlay that coerced on write). The vtab may skip
	 * its own coercion pass. Used by the isolation layer's overlay→underlying flush,
	 * and by its delete-tombstone writes (rows built from already-converted stored
	 * values), to avoid double-parsing values that are not idempotent under parse
	 * (e.g. JSON scalar strings).
	 */
	preCoerced?: boolean;
	/**
	 * If true, the caller has already validated all PK/UNIQUE constraints for the
	 * final committed state; the vtab should skip its own constraint re-checks and
	 * just persist the row (plus index/event maintenance). Used only by the
	 * isolation overlay→underlying flush, where the merged-view pre-checks are the
	 * sole authority and a value-swap cycle cannot be applied row-by-row without a
	 * transient duplicate that logical UNIQUE enforcement would wrongly reject.
	 */
	trustedWrite?: boolean;
}

/**
 * Base class representing a virtual table instance.
 * Module implementations should subclass this to provide specific table behavior.
 */
export abstract class VirtualTable {
	public readonly module: AnyVirtualTableModule;
	public readonly db: Database;
	/**
	 * The **bare** table name — never schema-qualified. It is the `tableName` the module's
	 * `create()`/`connect()` was called with, and every consumer that wants the qualified form
	 * composes `` `${schemaName}.${tableName}` `` itself. A module that stores a qualified name
	 * here doubles the schema in each of those compositions:
	 * - `vtab/memory/table.ts` and `quereus-store/src/common/store-table.ts` name the
	 *   `VirtualTableConnection` they register with the database. The engine matches that name
	 *   against `<schema>.<table>` when resolving a connection (see
	 *   `runtime/deferred-constraint-queue.ts`), so a doubled name never matches.
	 * - `quereus-isolation` keys its per-connection overlays by the pair; a mismatch there used
	 *   to discard staged rows at commit (`docs/design-isolation-layer.md` § "Table identity").
	 *
	 * Modules needing a qualified lookup key must derive it, not overload this field.
	 *
	 * NOTE: nothing enforces this at runtime — every in-repo module complies. If third-party
	 * modules start violating it, assert bareness in the constructor rather than hardening
	 * each consumer.
	 */
	public readonly tableName: string;
	/** The schema (database) this table lives in, e.g. `main`. */
	public readonly schemaName: string;
	public errorMessage?: string;
	public tableSchema?: TableSchema;

	/**
	 * When true, the update() method will receive a mutationStatement parameter
	 * containing a deterministic SQL statement that reproduces the mutation.
	 * This enables replication, audit logging, and change data capture.
	 */
	public wantStatements?: boolean;

	constructor(db: Database, module: AnyVirtualTableModule, schemaName: string, tableName: string) {
		this.db = db;
		this.module = module;
		this.schemaName = schemaName;
		this.tableName = tableName;
	}

	/**
	 * Sets an error message for the VTable
	 * @param message The error message string
	 */
	protected setErrorMessage(message: string | undefined): void {
		this.errorMessage = message;
	}

	/**
	 * Disconnects from this virtual table connection instance
	 * Called when the database connection closes or the statement is finalized
	 * @throws QuereusError on failure
	 */
	abstract disconnect(): Promise<void>;

	/**
	 * (Optional) Opens a direct data stream for this virtual table based on filter criteria.
	 * This is an alternative to the cursor-based open/filter/next model.
	 * @param filterInfo Information from getBestAccessPlan and query parameters.
	 * @returns An AsyncIterable yielding Row tuples.
	 * @throws QuereusError on failure
	 */
	query?(filterInfo: FilterInfo): AsyncIterable<Row>;

	/**
	 * Executes a pushed-down plan subtree.
	 * Called when the module indicated support via supports() method.
	 *
	 * @param db The database connection
	 * @param plan The plan node to execute
	 * @param ctx Optional context from supports() assessment
	 * @returns Async iterable of rows resulting from the plan execution
	 */
	executePlan?(
		db: Database,
		plan: PlanNode,
		ctx?: unknown
	): AsyncIterable<Row>;

	/**
	 * Performs an INSERT, UPDATE, or DELETE operation.
	 *
	 * Returns an UpdateResult indicating success or constraint violation:
	 * - `{ status: 'ok', row?: Row }` - Success. The presence of `row` is how the module
	 *   reports that a row was actually written or removed. Omitting it means "no row
	 *   changed" (an UPDATE/DELETE whose key was not found, or a conflict the module
	 *   resolved as IGNORE): the executor then skips the whole post-write pipeline and
	 *   emits nothing downstream — so every module must return `row` on a real write.
	 *   For INSERT/UPDATE, `row` is the row the module actually STORED: the proposed
	 *   `args.values` after the module's own coercion to the declared column logical
	 *   types. A module that coerces MUST return the coerced row, because the DML
	 *   executor reports `row` (not `args.values`) to every post-write consumer —
	 *   RETURNING, change tracking, row-time materialized-view maintenance, FK cascades,
	 *   data-change events. Returning the raw input from a coercing module makes
	 *   RETURNING disagree with a subsequent `select` on the same row. A row whose width
	 *   is not the table's column count makes the executor fall back to `args.values`.
	 *   For DELETE, only the presence of `row` is consulted, never its contents (the OLD
	 *   image comes from the source scan), so a PK-only placeholder is acceptable.
	 * - `{ status: 'constraint', constraint, message?, existingRow? }` - Constraint violation.
	 *   For 'unique' constraints, existingRow contains the conflicting row (enables UPSERT).
	 *
	 * Modules should return constraint violations rather than throwing ConstraintError for
	 * expected violations (unique, check, not_null). This allows the engine to handle
	 * UPSERT and other conflict resolution strategies. Unexpected errors (network, bugs)
	 * should still throw exceptions.
	 *
	 * @param args Arguments object containing operation details and optional mutation statement
	 * @returns UpdateResult indicating success or constraint violation
	 * @throws QuereusError for unexpected failures (not constraint violations)
	 */
	abstract update(args: UpdateArgs): Promise<UpdateResult>;

	/**
	 * (Optional) Creates a new connection for transaction support.
	 * If implemented, this enables proper transaction isolation for this table.
	 * @returns A new VirtualTableConnection instance
	 */
	createConnection?(): MaybePromise<VirtualTableConnection>;

	/**
	 * (Optional) Gets the current connection for this table instance.
	 * Used when the table maintains a single connection internally.
	 * @returns The current VirtualTableConnection instance, if any
	 */
	getConnection?(): VirtualTableConnection | undefined;

	/**
	 * (Optional) Offered an existing, already-registered connection for this table so the
	 * instance can reuse it instead of opening its own. The runtime calls this on a freshly
	 * connected instance when a connection for the same qualified table name is already
	 * registered; it passes the registered VirtualTableConnection and ignores the result.
	 *
	 * The module decides whether to adopt: it should downcast to its own connection type,
	 * reject connections it did not create (instanceof / brand check) and connections whose
	 * backing state no longer matches this instance (e.g. a stale connection from a
	 * dropped-then-recreated table), and silently do nothing when it declines.
	 *
	 * Ownership is NOT transferred: the adopted connection remains owned by the database
	 * connection registry that registered it. Adopting it must not make this instance
	 * responsible for closing it beyond the module's existing disconnect contract. The hook
	 * must be safe to call more than once on the same instance.
	 */
	adoptConnection?(connection: VirtualTableConnection): MaybePromise<void>;

	/**
	 * Begins a transaction on this virtual table
	 */
	begin?(): Promise<void>;

	/**
	 * Syncs changes within the virtual table transaction
	 */
	sync?(): Promise<void>;

	/**
	 * Commits the virtual table transaction
	 */
	commit?(): Promise<void>;

	/**
	 * Rolls back the virtual table transaction
	 */
	rollback?(): Promise<void>;

	/**
	 * Renames the virtual table
	 * @param newName The new name for the table
	 */
	rename?(newName: string): Promise<void>;

	/**
	 * Begins a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	savepoint?(savepointIndex: number): Promise<void>;

	/**
	 * Releases a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	release?(savepointIndex: number): Promise<void>;

	/**
	 * Rolls back to a savepoint
	 * @param savepointIndex The savepoint identifier
	 */
	rollbackTo?(savepointIndex: number): Promise<void>;

	/**
	 * Modifies the schema of this virtual table
	 * @param changeInfo Object describing the schema modification
	 * @throws QuereusError or ConstraintError on failure
	 */
	alterSchema?(changeInfo: SchemaChangeInfo): Promise<void>;

	/**
	 * Creates a secondary index on the virtual table
	 * @param indexInfo The index definition
	 * @param rows Optional {@link EffectiveRowSource} — the rows the DDL-issuing connection
	 *   can see, supplied by a wrapper module that holds pending rows this table cannot
	 *   reach. When present, the UNIQUE duplicate check MUST judge this stream.
	 */
	createIndex?(indexInfo: IndexSchema, rows?: EffectiveRowSource): Promise<void>;

	/**
	 * Drops a secondary index from the virtual table
	 * @param indexName The name of the index to drop
	 */
	dropIndex?(indexName: string): Promise<void>;

	/**
	 * Gets the event emitter for this table, if the module supports mutation/schema events.
	 * @returns Event emitter, or undefined if not supported
	 */
	getEventEmitter?(): VTableEventEmitter | undefined;

	/**
	 * Returns statistics about this table for cost-based optimization.
	 * Modules that can efficiently compute exact or approximate statistics
	 * (row counts, distinct values, histograms) should implement this.
	 * Called by the ANALYZE command or lazily by the optimizer.
	 * @returns Table statistics, or a promise resolving to them
	 */
	getStatistics?(): Promise<TableStatistics> | TableStatistics;

	// --- Isolation Layer Support ---

	/**
	 * Extract primary key values from a row.
	 * Override in subclasses that support isolation layer wrapping.
	 */
	extractPrimaryKey?(row: Row): SqlValue[];

	/**
	 * Compare two rows by primary key.
	 * Override in subclasses that support isolation layer wrapping.
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey?(a: SqlValue[], b: SqlValue[]): number;

	/**
	 * Get primary key column indices.
	 * Override in subclasses that support isolation layer wrapping.
	 */
	getPrimaryKeyIndices?(): number[];

	/**
	 * Get per-column comparator functions for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 * Each comparator incorporates DESC ordering and collation for its column.
	 * @param indexName The name of the index
	 * @returns Array of per-column comparators, or undefined if index doesn't exist
	 */
	getIndexComparator?(indexName: string): CompareFn[] | undefined;
}
