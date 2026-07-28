import { VirtualTable } from '../table.js';
import type { AnyVirtualTableModule, EffectiveRowSource, SchemaChangeInfo } from '../module.js';
import type { Database } from '../../core/database.js';
import type { Row, SqlValue, CompareFn, UpdateResult } from '../../common/types.js';
import { type IndexSchema, type TableSchema } from '../../schema/table.js';
import { MemoryTableManager } from './layer/manager.js';
import type { MemoryTableConnection } from './layer/connection.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { FilterInfo } from '../filter-info.js';
import { buildScanPlanFromFilterInfo } from './layer/scan-plan.js';
import type { ColumnDef as ASTColumnDef } from '../../parser/ast.js';
import { createMemoryTableLoggers } from './utils/logging.js';
import { safeJsonStringify } from '../../util/serialization.js';
import type { VirtualTableConnection } from '../connection.js';
import { MemoryVirtualTableConnection } from './connection.js';

import type { VTableEventEmitter } from '../events.js';
import { createTypedComparator } from '../../util/comparison.js';
import { createPrimaryKeyFunctions } from './utils/primary-key.js';
import type { BTreeKeyForPrimary } from './types.js';
import type { TableStatistics, ColumnStatistics } from '../../planner/stats/catalog-stats.js';
import { buildHistogram } from '../../planner/stats/histogram.js';

const logger = createMemoryTableLoggers('table');

/**
 * Represents a connection-specific instance of an in-memory table using the layer-based MVCC model.
 * This class acts as a thin wrapper around the shared MemoryTableManager,
 * holding the connection state.
 */
export class MemoryTable extends VirtualTable {
	/** @internal The shared manager handling layers, schema, and global state */
	public readonly manager: MemoryTableManager;
	/** @internal Connection state specific to this table instance (lazily initialized) */
	private connection: MemoryTableConnection | null = null;
	/** @internal Cached VirtualTableConnection wrapper to avoid re-creation */
	private cachedVtabConnection: MemoryVirtualTableConnection | null = null;
	/** @internal When true, reads from committed (pre-transaction) state only */
	private readonly readCommitted: boolean;
	/** @internal Memoized native PK comparator; see {@link getPrimaryKeyComparator} */
	private pkComparatorCache?: { schema: TableSchema; arity: number; compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number };

	/**
	 * @internal - Use MemoryTableModule.connect or create
	 * Creates a connection-specific instance linked to a manager.
	 */
	constructor(
		db: Database,
		module: AnyVirtualTableModule,
		manager: MemoryTableManager,
		readCommitted?: boolean
	) {
		// Use manager's schema and name for the base class constructor
		super(db, module, manager.schemaName, manager.tableName);
		this.manager = manager;
		this.readCommitted = readCommitted ?? false;
		// Set the tableSchema directly from the manager's current canonical schema
		// This ensures the VirtualTable base class has the correct schema reference.
		this.tableSchema = manager.tableSchema;
	}

	/** Returns the canonical schema from the manager */
	getSchema(): TableSchema | undefined {
		// Always return the potentially updated schema from the manager
		return this.manager.tableSchema;
	}

	/** Checks read-only status via the manager */
	isReadOnly(): boolean {
		// Access readOnly via a public method on the manager
		return this.manager.isReadOnly;
	}

	/** Ensures the connection to the manager is established */
	private async ensureConnection(): Promise<MemoryTableConnection> {
		if (!this.connection) {
			if (this.readCommitted) {
				// Committed-snapshot mode: create a fresh connection but do NOT register
				// it with the database. This connection will always read from the committed
				// layer (currentCommittedLayer) since begin() is never called on it.
				this.connection = this.manager.connect();
				logger.debugLog(`ensureConnection: Created unregistered committed-snapshot connection ${this.connection.connectionId} for table ${this.tableName}`);
			} else {
				// Check if there's already an active connection for this table in the database
				const qualifiedName = `${this.schemaName}.${this.tableName}`;
				const existingConnections = this.db.getConnectionsForTable(qualifiedName);
				const existingMemConn = existingConnections.length > 0 && existingConnections[0] instanceof MemoryVirtualTableConnection
					? (existingConnections[0] as MemoryVirtualTableConnection).getMemoryConnection()
					: null;
				if (existingMemConn && existingMemConn.tableManager === this.manager) {
					this.connection = existingMemConn;
					// Sync readLayer with the manager's current committed state
					// when the connection has no in-flight transactional state.
					// The connection may have been disconnected from the manager
					// (removed from its connections map by a previous scan's finally
					// block) while remaining in the DB's connection registry.  After
					// schema changes like ALTER TABLE ADD COLUMN,
					// ensureSchemaChangeSafety only updates connections still in the
					// manager's map, so this connection may point to an outdated layer.
					//
					// Skip the reset during an active transaction: readLayer may be
					// a savepoint snapshot (eager-swap) holding in-transaction writes
					// that aren't yet in currentCommittedLayer; resetting would lose
					// those writes. An in-transaction schema change (e.g. ALTER TABLE
					// ADD COLUMN, which IS permitted inside an explicit transaction)
					// is not a staleness concern here: ensureSchemaChangeSafety
					// re-points every registered connection — including a detached one
					// reused on this path — at the post-change base layer, so by the
					// time reuse reaches this branch the readLayer is already current.
					if (!this.connection.explicitTransaction
						&& !this.connection.pendingTransactionLayer) {
						this.connection.readLayer = this.manager.currentCommittedLayer;
					}
					logger.debugLog(`ensureConnection: Reused existing connection ${this.connection.connectionId} for table ${this.tableName}`);
				} else {
					// Establish connection state with the manager upon first use
					this.connection = this.manager.connect();

					// Create a VirtualTableConnection wrapper and register it with the database
					const vtabConnection = new MemoryVirtualTableConnection(qualifiedName, this.connection);
					await this.db.registerConnection(vtabConnection);

					logger.debugLog(`ensureConnection: Created and registered new connection ${this.connection.connectionId} for table ${this.tableName}`);
				}
			}
		}
		return this.connection;
	}

	/** Sets an existing connection for this table instance (for transaction reuse) */
	setConnection(memoryConnection: MemoryTableConnection): void {
		logger.debugLog(`Setting connection ${memoryConnection.connectionId} for table ${this.tableName}`);
		this.connection = memoryConnection;
	}

	/**
	 * Adopts an already-registered connection offered by the runtime, reusing it instead of
	 * opening a fresh one. Rejects connections created by another module (instanceof guard)
	 * and connections whose manager no longer matches this instance (a stale connection from
	 * a dropped-then-recreated table). Ownership stays with the registry; safe to call twice.
	 */
	adoptConnection(connection: VirtualTableConnection): void {
		if (!(connection instanceof MemoryVirtualTableConnection)) return;
		const existingMemConn = connection.getMemoryConnection();
		if (existingMemConn.tableManager === this.manager) {
			this.setConnection(existingMemConn);
			logger.debugLog(`Adopted existing connection into VirtualTable for table ${this.tableName}`);
		} else {
			logger.debugLog(`Skipped stale connection adoption for table ${this.tableName} (manager mismatch)`);
		}
	}

	/** Creates a new VirtualTableConnection for transaction support */
	createConnection(): VirtualTableConnection {
		const memoryConnection = this.manager.connect();
		const qualifiedName = `${this.schemaName}.${this.tableName}`;
		return new MemoryVirtualTableConnection(qualifiedName, memoryConnection);
	}

	/** Gets the current connection if this table maintains one internally */
	getConnection(): VirtualTableConnection | undefined {
		if (!this.connection) {
			return undefined;
		}
		if (!this.cachedVtabConnection || this.cachedVtabConnection.getMemoryConnection() !== this.connection) {
			this.cachedVtabConnection = new MemoryVirtualTableConnection(`${this.schemaName}.${this.tableName}`, this.connection);
		}
		return this.cachedVtabConnection;
	}

	/**
	 * Get the event emitter for mutation and schema hooks.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.manager.getEventEmitter();
	}

	/**
	 * Returns statistics for this memory table.
	 * Provides exact row count from BTree metadata, column-level distinct counts,
	 * min/max values, null counts, and optional histograms.
	 */
	getStatistics(): TableStatistics {
		const schema = this.manager.tableSchema;
		if (!schema) {
			return { rowCount: 0, columnStats: new Map() };
		}

		const { rowCount, indexDistinctCounts } = this.manager.getBaseLayerStats();
		const columnStats = new Map<string, ColumnStatistics>();

		// Build a map from column index to secondary index names for distinct counts
		const colIndexToSecondaryIndex = new Map<number, string>();
		for (const idx of schema.indexes ?? []) {
			if (idx.columns.length === 1) {
				colIndexToSecondaryIndex.set(idx.columns[0].index, idx.name);
			}
		}

		for (let colIdx = 0; colIdx < schema.columns.length; colIdx++) {
			const col = schema.columns[colIdx];
			const colName = col.name.toLowerCase();

			// Sample column values for histogram and distinct/null/min/max
			const values = this.manager.sampleColumnValues(colIdx, 1000);

			// Distinct count: use secondary index if available, else count from sample
			let distinctCount: number;
			const secIndexName = colIndexToSecondaryIndex.get(colIdx);
			if (secIndexName && indexDistinctCounts.has(secIndexName)) {
				distinctCount = indexDistinctCounts.get(secIndexName)!;
			} else {
				const distinctSet = new Set(values.map(v => String(v)));
				distinctCount = distinctSet.size;
			}

			// Primary key columns always have distinctCount = rowCount
			const isPkColumn = schema.primaryKeyDefinition.some(pk => pk.index === colIdx);
			if (isPkColumn && rowCount > 0) {
				distinctCount = rowCount;
			}

			// Null count: difference between rowCount and non-null sample (exact for full scan)
			const nullCount = rowCount - values.length;

			const stats: ColumnStatistics = {
				distinctCount,
				nullCount: Math.max(0, nullCount),
				minValue: values.length > 0 ? values[0] : undefined,
				maxValue: values.length > 0 ? values[values.length - 1] : undefined,
			};

			// Build histogram for non-trivial columns (> 10 distinct values)
			if (values.length > 10) {
				const hist = buildHistogram(values, Math.min(100, Math.ceil(values.length / 10)));
				if (hist) {
					stats.histogram = hist;
				}
			}

			columnStats.set(colName, stats);
		}

		return {
			rowCount,
			columnStats,
			lastAnalyzed: Date.now(),
		};
	}

	// Direct async iteration for query execution
	async* query(filterInfo: FilterInfo): AsyncIterable<Row> {
		const conn = await this.ensureConnection();
		logger.debugLog(`query using connection ${conn.connectionId} (pending: ${conn.pendingTransactionLayer?.getLayerId()}, read: ${conn.readLayer.getLayerId()})`);
		const currentSchema = this.manager.tableSchema;
		if (!currentSchema) {
			logger.error('query', this.tableName, 'Table schema is undefined');
			return;
		}
		const plan = buildScanPlanFromFilterInfo(filterInfo, currentSchema);
		logger.debugLog(`query invoked for ${this.tableName} with plan: ${safeJsonStringify(plan)}`);

		// In committed-snapshot mode, always read from the committed layer (readLayer),
		// ignoring any pending transaction layer
		const startLayer = this.readCommitted ? conn.readLayer : (conn.pendingTransactionLayer ?? conn.readLayer);
		logger.debugLog(`query reading from layer ${startLayer.getLayerId()}`);

		// Delegate scanning to the manager, which handles layer recursion.
		// `scanLayerSync` is synchronous (the backing BTree and all per-row filter
		// logic are sync); `query` is already async solely for the awaited
		// `ensureConnection` above, so this is the sole sync→async boundary on the
		// memory-scan hot path — no extra per-layer promise round-trips.
		yield* this.manager.scanLayerSync(startLayer, plan);
	}

	// Note: getBestAccessPlan is handled by the MemoryTableModule, not the table instance.

	/** Performs mutation through the connection's transaction layer */
	async update(args: import('../table.js').UpdateArgs): Promise<UpdateResult> {
		if (this.readCommitted) {
			throw new QuereusError("Cannot modify committed-state snapshot", StatusCode.ERROR);
		}
		const conn = await this.ensureConnection();
		// Delegate mutation to the manager.
		// Note: mutationStatement is ignored by memory table (could be logged if needed)
		return this.manager.performMutation(conn, args.operation, args.values, args.oldKeyValues, args.onConflict, args.preCoerced);
	}

	/** Begins a transaction for this connection */
	async begin(): Promise<void> {
		(await this.ensureConnection()).begin();
	}

	/** Commits this connection's transaction */
	async commit(): Promise<void> {
		// Only commit if a connection has actually been established
		if (this.connection) {
			await this.connection.commit();
		}
	}

	/** Rolls back this connection's transaction */
	async rollback(): Promise<void> {
		// Only rollback if a connection has actually been established
		if (this.connection) {
			this.connection.rollback();
		}
	}

	/** Sync operation (currently no-op for memory table layers) */
	async sync(): Promise<void> {
		// This might trigger background collapse in the manager in the future
		// await this.manager.tryCollapseLayers(); // Optional: trigger collapse on sync?
		return Promise.resolve();
	}

	/** Renames the underlying table via the manager */
	async rename(newName: string): Promise<void> {
		logger.operation('Rename', this.tableName, { newName });
		await this.manager.renameTable(newName);
		// Update this instance's schema reference after rename
		this.tableSchema = this.manager.tableSchema;
	}

	// --- Savepoint operations ---
	async savepoint(savepointIndex: number): Promise<void> {
		const conn = await this.ensureConnection();
		conn.createSavepoint(savepointIndex);
	}

	async release(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to release
		this.connection.releaseSavepoint(savepointIndex);
	}

	async rollbackTo(savepointIndex: number): Promise<void> {
		if (!this.connection) return; // No connection, no savepoints to rollback to
		this.connection.rollbackToSavepoint(savepointIndex);
	}
	// --- End Savepoint operations ---


	/** Handles schema changes via the manager */
	async alterSchema(changeInfo: SchemaChangeInfo, validateOnly = false): Promise<void> {
		// Validate-only dry run (see VirtualTable.alterSchema): supported for exactly the
		// change type that has a caller needing it — the isolation layer pre-flights an
		// `alter column` against a per-connection overlay before the shared underlying
		// mutates irreversibly. Refuse the rest rather than silently validating nothing.
		if (validateOnly && changeInfo.type !== 'alterColumn') {
			throw new QuereusError(
				`MemoryTable.alterSchema: validate-only is supported for 'alterColumn' changes, not '${changeInfo.type}'`,
				StatusCode.UNSUPPORTED,
			);
		}
		const originalManagerSchema = this.manager.tableSchema; // For potential error recovery
		try {
			switch (changeInfo.type) {
				case 'addColumn':
					await this.manager.addColumn(changeInfo.columnDef, changeInfo.backfillEvaluator, changeInfo.insertAtIndex);
					break;
				case 'dropColumn':
					await this.manager.dropColumn(changeInfo.columnName);
					break;
				case 'renameColumn':
					if (!('newColumnDefAst' in changeInfo)) {
						throw new QuereusError('SchemaChangeInfo for renameColumn missing newColumnDefAst', StatusCode.INTERNAL);
					}
					await this.manager.renameColumn(changeInfo.oldName, changeInfo.newColumnDefAst as ASTColumnDef);
					break;
				case 'alterPrimaryKey':
					throw new QuereusError(
						'MemoryTable does not support in-place primary key alteration',
						StatusCode.UNSUPPORTED,
					);
				case 'addConstraint':
					await this.manager.addConstraint(changeInfo.constraint);
					break;
				case 'dropConstraint':
					await this.manager.dropConstraint(changeInfo.constraintName);
					break;
				case 'renameConstraint':
					await this.manager.renameConstraint(changeInfo.oldName, changeInfo.newName);
					break;
				case 'alterColumn':
					await this.manager.alterColumn({
						columnName: changeInfo.columnName,
						setNotNull: changeInfo.setNotNull,
						setDataType: changeInfo.setDataType,
						setDefault: changeInfo.setDefault,
						setCollation: changeInfo.setCollation,
					}, undefined, validateOnly);
					break;
				default: {
					const exhaustiveCheck: never = changeInfo;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					throw new QuereusError(`Unhandled schema change: ${(exhaustiveCheck as any)?.type}`, StatusCode.INTERNAL);
				}
			}
			this.tableSchema = this.manager.tableSchema; // Refresh local schema ref
		} catch (e) {
			logger.error('Schema Change', this.tableName, e);
			// Manager DDL methods should handle reverting their own BaseLayer schema updates on error.
			// Refresh local schema ref to ensure it's consistent with manager after potential error/revert.
			this.tableSchema = originalManagerSchema;
			// It might be safer for manager DDL to not alter its own this.tableSchema until baseLayer op succeeds.
			// And if baseLayer op fails, manager DDL reverts baseLayer.tableSchema.
			// Then here, we always sync from manager: this.tableSchema = this.manager.tableSchema;
			throw e;
		}
	}

	/** Disconnects this connection instance from the manager */
	async disconnect(): Promise<void> {
		if (this.connection) {
			// Manager handles cleanup and potential layer collapse trigger
			await this.manager.disconnect(this.connection.connectionId);
			this.connection = null;
			this.cachedVtabConnection = null;
		}
	}

	/** Returns true if this table is in committed-snapshot (read-only) mode */
	isCommittedSnapshot(): boolean {
		return this.readCommitted;
	}

	// --- Index DDL methods delegate to the manager ---
	async createIndex(indexSchema: IndexSchema, rows?: EffectiveRowSource): Promise<void> {
		logger.operation('Create Index', this.tableName, { indexName: indexSchema.name });
		await this.manager.createIndex(indexSchema, undefined, rows);
		this.tableSchema = this.manager.tableSchema; // Refresh local schema ref
	}

	async dropIndex(indexName: string): Promise<void> {
		logger.operation('Drop Index', this.tableName, { indexName });
		await this.manager.dropIndex(indexName);
		// Update schema reference
		this.tableSchema = this.manager.tableSchema;
	}
	// --- End Index DDL methods ---

	// --- Isolation Layer Support ---

	/**
	 * Extract primary key values from a row.
	 * Returns the PK column values in PK order.
	 */
	extractPrimaryKey(row: Row): SqlValue[] {
		const pkIndices = this.getPrimaryKeyIndices();
		return pkIndices.map(i => row[i]);
	}

	/**
	 * Compare two rows by their primary key values under this table's NATIVE key
	 * ordering — the exact comparator its layer BTrees are keyed by, so DESC
	 * direction, per-column logical-type semantics, and each column's declared
	 * collation (resolved against THIS database's registry) all apply.
	 *
	 * The isolation layer adopts this comparator for its overlay/underlying merge
	 * (`IsolatedTable.getComparePK`). Any disagreement with the table's own scan
	 * order leaves an overlay row failing to shadow the base row it replaces, so
	 * both surface in a scan — hence the delegation rather than a local loop.
	 *
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number {
		const { arity, compare } = this.getPrimaryKeyComparator();
		return arity === 1 ? compare(a[0], b[0]) : compare(a, b);
	}

	/**
	 * The layer BTrees' primary-key comparator, memoized on the `TableSchema` object
	 * identity (an `alter table` installs a fresh frozen schema, invalidating the
	 * entry). `arity` travels with it because a single-column key is a bare
	 * `SqlValue`, not a one-element array (see `BTreeKeyForPrimary`).
	 *
	 * Collation resolution is not retroactive: a `registerCollation` that replaces a
	 * collation after the comparator was built is not picked up, matching the
	 * contract `Database.registerCollation` documents engine-wide.
	 */
	private getPrimaryKeyComparator(): { arity: number; compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number } {
		const schema = this.tableSchema;
		if (!schema) return { arity: 0, compare: () => 0 };
		if (this.pkComparatorCache?.schema !== schema) {
			const { compare } = createPrimaryKeyFunctions(schema, this.db.getCollationResolver());
			this.pkComparatorCache = { schema, arity: schema.primaryKeyDefinition.length, compare };
		}
		return this.pkComparatorCache;
	}

	/**
	 * Get the primary key column indices in the row.
	 * Returns indices based on the table's primary key definition.
	 */
	getPrimaryKeyIndices(): number[] {
		const schema = this.tableSchema;
		if (!schema) return [];
		return schema.primaryKeyDefinition.map(pkDef => pkDef.index);
	}

	/**
	 * Get per-column comparator functions for a specific index.
	 * Each comparator incorporates DESC ordering and collation for its column.
	 */
	getIndexComparator(indexName: string): CompareFn[] | undefined {
		const schema = this.tableSchema;
		if (!schema) return undefined;

		const index = schema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return undefined;

		const collationResolver = this.db.getCollationResolver();
		return index.columns.map(col => {
			const columnSchema = schema.columns[col.index];
			const collationFunc = col.collation ? collationResolver(col.collation) : undefined;
			const typedComparator = createTypedComparator(columnSchema.logicalType, collationFunc);

			if (col.desc) {
				return (a: SqlValue, b: SqlValue): number => -typedComparator(a, b);
			}
			return typedComparator;
		});
	}
	// --- End Isolation Layer Support ---
}

// Helper function (moved from MemoryTableCursor and adapted)
// function buildScanPlanInternal(filterInfo: FilterInfo, tableSchema: TableSchema): ScanPlan { ... MOVED ... }


