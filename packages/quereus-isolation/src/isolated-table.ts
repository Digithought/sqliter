import type { CollationFunction, CollationResolver, Database, DatabaseInternal, MaybePromise, Row, SqlValue, TableIndexSchema as IndexSchema, FilterInfo, SchemaChangeInfo, TableSchema, UniqueConstraintSchema, CompiledPredicate, UpdateArgs, VirtualTableConnection, UpdateResult, AccessPath, IndexDescriptor, IndexKeyColumn } from '@quereus/quereus';
import { VirtualTable, compareSqlValues, compareSqlValuesFast, resolveCollationFunctions, BINARY_COLLATION, isUpdateOk, ConflictResolution, compilePredicate, QuereusError, StatusCode, resolveUniqueEnforcementCollations, uniqueEnforcementCollations, normalizeCollationName, serializeRowKey, pkKeyCollationName, retargetFilterInfoIndex, PRIMARY_INDEX_NAME, coerceRowToSchema, IndexConstraintOp, decodeIdxStr } from '@quereus/quereus';
import type { EffectiveRowSource, KeyNormalizerResolver } from '@quereus/quereus';
import type { IsolationModule, ConnectionOverlayState } from './isolation-module.js';
import { IsolatedConnection, type IsolatedTableCallback } from './isolated-connection.js';
import { mergeStreams, createMergeEntry, createTombstone } from './merge-iterator.js';
import type { MergeEntry, MergeConfig } from './merge-types.js';
import { makeFullScanFilterInfo, makePkPointLookupFilter, makeSecondaryIndexEqSeekFilter } from './filter-info.js';

/** Returned when the schema has not been populated yet; never mutated. */
const EMPTY_PK_KEY_SHAPE: { functions: CollationFunction[]; directions: boolean[] } = { functions: [], directions: [] };

/**
 * Information about which index is being scanned.
 */
type IndexScanInfo =
	| { type: 'primary' }
	| { type: 'secondary'; indexName: string; columnIndices: number[]; keyColumns: readonly IndexKeyColumn[]; reverse: boolean };

/**
 * A table wrapper that provides transaction isolation via an overlay.
 *
 * Each IsolatedTable instance accesses a connection-scoped overlay that is:
 * - Created lazily on first write
 * - Shared across all IsolatedTable instances in the same transaction
 * - Stored in the IsolationModule's connection overlay map
 *
 * This provides true per-connection isolation - each connection's uncommitted
 * changes are invisible to other connections, but visible to all queries
 * within the same connection.
 *
 * Reads merge overlay changes with underlying data.
 * Writes go to overlay only until commit.
 */
export class IsolatedTable extends VirtualTable implements IsolatedTableCallback {
	private readonly isolationModule: IsolationModule;
	private readonly underlyingTable: VirtualTable;
	private readonly readCommitted: boolean;

	private registeredConnection: IsolatedConnection | null = null;

	/**
	 * Lazy cache of compiled partial-UNIQUE predicates. Keyed on the
	 * UniqueConstraintSchema object identity — a new constraint object
	 * after CREATE/DROP INDEX produces a fresh compile, and the WeakMap
	 * lets the GC reclaim entries for retired constraints.
	 */
	private readonly predicateCache: WeakMap<UniqueConstraintSchema, CompiledPredicate> = new WeakMap();

	/**
	 * `db.getCollationResolver()`, bound once at connect. Both the overlay/underlying
	 * merge comparators and the UNIQUE conflict checks resolve collation names through
	 * it, so a collation registered with `db.registerCollation` participates instead of
	 * silently degrading to BINARY.
	 *
	 * The overlay's key comparator and the underlying table's must agree, or a staged
	 * row fails to shadow the base row it replaces; both now derive from this one
	 * database registry.
	 */
	private readonly collationResolver: CollationResolver;

	/**
	 * `db.getKeyNormalizerResolver()`, bound once at connect beside {@link collationResolver}
	 * for the same reason: the modified-PK set's key encoding and the comparators above must
	 * agree on which rows are equal, or a staged row fails to shadow the base row it replaces.
	 */
	private readonly keyNormalizerResolver: KeyNormalizerResolver;

	/**
	 * Per-PK-column comparison functions and sort directions, resolved from the PK
	 * columns' declared collations and memoized against the `TableSchema` object
	 * identity — an `alter table` hands this instance a fresh (frozen) schema object,
	 * which invalidates the entry.
	 */
	private pkCollationCache?: { schema: TableSchema; functions: CollationFunction[]; directions: boolean[] };

	/**
	 * Returns the connection-scoped set of savepoint depths that pre-date the overlay.
	 * Stored in IsolationModule (keyed by db+schema+table) so all IsolatedTable instances
	 * for the same connection see the same set — important because each statement creates
	 * a fresh IsolatedTable instance via module.connect(), so instance-local state would
	 * be lost between the createSavepoint callback and the ensureOverlay() call.
	 *
	 * NOTE: keyed by the name this IsolatedTable was *constructed* with, which after a
	 * mid-transaction `alter table … rename to …` is the pre-rename name. Deliberate:
	 * this same instance stays the registered connection's callback object for the rest
	 * of the transaction and clears the set at commit/rollback, so the key must not move
	 * out from under it. A statement after the rename connects a fresh IsolatedTable under
	 * the new name, which builds its own set from `Database.registerConnection`'s savepoint
	 * replay. See `IsolationModule.renameTable`.
	 */
	private get savepointsBeforeOverlay(): Set<number> {
		return this.isolationModule.getPreOverlaySavepoints(this.db, this.schemaName, this.tableName);
	}

	/**
	 * @param schemaName Schema name as supplied to `IsolationModule.create()`/`.connect()` — the
	 *   same identity `IsolationModule.underlyingTables` is keyed by.
	 * @param tableName Bare table name from the same source. These MUST NOT be read off
	 *   `underlyingTable.schemaName` / `.tableName`: `VirtualTable.tableName` is contracted bare,
	 *   but an underlying module that reports a schema-qualified name there (lamina-quereus does,
	 *   using the field as a catalogue key) would key this table's overlay as
	 *   `<dbId>:store.store.widget` while `underlyingTables` holds `store.widget`. The commit
	 *   flush looks the overlay's key up in `underlyingTables`, misses, and silently discards
	 *   every staged row. Keying off the connect-time pair keeps both maps on one identity by
	 *   construction, whatever the underlying self-reports.
	 */
	constructor(
		db: Database,
		module: IsolationModule,
		schemaName: string,
		tableName: string,
		underlyingTable: VirtualTable,
		readCommitted: boolean = false
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, module as any, schemaName, tableName);
		this.isolationModule = module;
		this.underlyingTable = underlyingTable;
		this.readCommitted = readCommitted;
		this.collationResolver = db.getCollationResolver();
		this.keyNormalizerResolver = db.getKeyNormalizerResolver();
		// Schema comes from underlying - may be populated lazily by the underlying module
		this.tableSchema = underlyingTable.tableSchema;
	}

	/**
	 * Gets the tombstone column name from the module.
	 */
	private get tombstoneColumn(): string {
		return this.isolationModule.tombstoneColumn;
	}

	/**
	 * Gets the connection-scoped overlay state, or undefined if no overlay exists yet.
	 */
	private getOverlayState(): ConnectionOverlayState | undefined {
		return this.isolationModule.getConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Throws if this connection's overlay was poisoned by a cross-connection DDL: an ALTER
	 * that could not migrate it (see `IsolationModule.alterTable`), leaving its rows in the
	 * PRE-alter column layout, or a DROP TABLE that removed the table underneath it (see
	 * `IsolationModule.destroy`). Either way it can neither be merged into a read nor
	 * flushed. Called at the data-op chokepoints (write, the merged read branch, and the
	 * commit flush) — never on the committed-snapshot read path, which bypasses the overlay
	 * entirely and stays safe. The connection recovers by rolling back, which discards the
	 * overlay (and its poison).
	 */
	private assertOverlayUsable(): void {
		const state = this.getOverlayState();
		if (state?.poison) {
			throw new QuereusError(state.poison.message, StatusCode.CONSTRAINT);
		}
	}

	/**
	 * Gets the overlay table, or undefined if no overlay exists yet.
	 */
	private get overlayTable(): VirtualTable | undefined {
		return this.getOverlayState()?.overlayTable;
	}

	/**
	 * Gets whether this connection has uncommitted changes.
	 */
	private get hasChanges(): boolean {
		return this.getOverlayState()?.hasChanges ?? false;
	}

	/**
	 * Sets the hasChanges flag in the connection-scoped overlay state.
	 */
	private setHasChanges(value: boolean): void {
		const state = this.getOverlayState();
		if (state) {
			state.hasChanges = value;
		}
	}

	/**
	 * Lazily creates the overlay table on first write.
	 *
	 * The overlay is stored in connection-scoped storage, so it persists
	 * across multiple IsolatedTable instances within the same transaction.
	 *
	 * The schema is obtained from the underlying table at this point,
	 * supporting scenarios where schema is discovered lazily from storage.
	 */
	private async ensureOverlay(): Promise<VirtualTable> {
		// Check if overlay already exists for this connection
		const existingState = this.getOverlayState();
		if (existingState) {
			return existingState.overlayTable;
		}

		// Get schema from underlying table (may have been populated lazily)
		const schema = this.underlyingTable.tableSchema;
		if (!schema || schema.columns.length === 0) {
			throw new Error(
				`Cannot create isolation overlay: underlying table '${this.tableName}' has no schema. ` +
				'Ensure the underlying module provides schema before performing writes.'
			);
		}

		// Update our schema reference in case it was populated lazily
		this.tableSchema = schema;

		// Create overlay schema with tombstone column
		const overlaySchema = this.isolationModule.createOverlaySchema(schema);

		// Create the overlay table.
		// overlaySchema already contains indexes (copied from the base schema by
		// createOverlaySchema), so the overlay's BaseLayer initialises all secondary
		// indexes from the schema during construction.  No explicit createIndex loop
		// is needed, and calling it would throw a "duplicate index" error.
		const overlayTable = await this.isolationModule.overlayModule.create(this.db, overlaySchema);

		// If savepoints were taken before the overlay existed, pre-register the
		// overlay's connection now so MemoryTable.ensureConnection() reuses it
		// instead of creating a fresh one on the first overlay.update() (which
		// would skip the savepoint-stack replay done by Database.registerConnection
		// at this exact call). The replay itself is performed by
		// Database.registerConnection — see registerConnection in database.ts.
		if (this.savepointsBeforeOverlay.size > 0 && overlayTable.createConnection) {
			const preAlignedConn = await overlayTable.createConnection();
			await (this.db as DatabaseInternal).registerConnection(preAlignedConn);
		}

		// Store in connection-scoped storage. `db` rides along so the module can free this
		// overlay's staging table on any discard path (see IsolationModule.releaseOverlayTable).
		const state: ConnectionOverlayState = {
			overlayTable,
			hasChanges: false,
			db: this.db,
		};
		this.isolationModule.setConnectionOverlay(this.db, this.schemaName, this.tableName, state);

		return overlayTable;
	}

	/**
	 * Ensures a connection is registered with the database for transaction coordination.
	 * This is called before any read or write operation.
	 *
	 * Multiple IsolatedTable instances may be created per transaction (one per getVTable()
	 * call in the runtime). Without reuse, each instance would register a fresh
	 * IsolatedConnection, causing DeferredConstraintQueue.findConnection() to find multiple
	 * covering candidates and throw. We therefore reuse the first covering connection
	 * already registered for this table.
	 *
	 * Concurrent first-reads coalesce through the module-level in-flight memo
	 * (`IsolationModule.coalesceConnectionBuild`, keyed per db+table) rather than a
	 * per-instance one: the runtime connects a FRESH `IsolatedTable` per scan, so
	 * two concurrent scans of one table land on distinct instances and only a memo
	 * that spans all wrappers for the (db, table) can collapse them onto one
	 * registered covering connection. The resolved connection is cached in
	 * `registeredConnection` so subsequent reads on THIS instance fast-path — this
	 * is the only place that field is set when the build was coalesced onto another
	 * instance's in-flight promise (that instance's `buildConnection` ran, ours did
	 * not).
	 */
	private async ensureConnection(): Promise<IsolatedConnection> {
		if (this.registeredConnection) return this.registeredConnection;
		const conn = await this.isolationModule.coalesceConnectionBuild(
			this.db,
			this.schemaName,
			this.tableName,
			() => this.buildConnection(),
		) as IsolatedConnection;
		this.registeredConnection = conn;
		return conn;
	}

	/**
	 * Builds (or reuses) the registered connection for this table. Always called
	 * through `IsolationModule.coalesceConnectionBuild` so concurrent callers —
	 * across all `IsolatedTable` instances for this (db, table) — share one build.
	 *
	 * The covering-reuse check stays INSIDE this coalesced body so a connection
	 * registered by another instance between calls (e.g. after the memo cleared on
	 * settle) is still picked up by the next read.
	 * `registeredConnection` is assigned only on the success paths (covering reuse
	 * or a completed `registerConnection`); a thrown `registerConnection` /
	 * overlay `createConnection` leaves it null and rejects the in-flight promise,
	 * which `coalesceConnectionBuild` clears so a later read rebuilds.
	 */
	private async buildConnection(): Promise<IsolatedConnection> {
		// Reuse an existing covering (IsolatedConnection) if one is already registered
		// for this table — avoids accumulating one IsolatedConnection per statement.
		//
		// NOTE: a rename leaves the covering connection registered under the OLD name
		// (StoreModule.renameTable evicts only its own StoreConnections), so a table later
		// created under that freed name adopts that stale connection here. Sound today only
		// because the overlay and underlying maps are keyed by table name rather than by
		// connection, so each table still resolves its own state. If per-connection state
		// ever moves onto IsolatedConnection, retarget the connection across the rename.
		const qualifiedName = `${this.schemaName}.${this.tableName}`;
		const existing = (this.db as DatabaseInternal).getConnectionsForTable(qualifiedName);
		const existingCovering = existing.find((c: VirtualTableConnection) => c.isCovering) as IsolatedConnection | undefined;
		if (existingCovering) {
			this.registeredConnection = existingCovering;
			return existingCovering;
		}

		// Create connection - overlay connection created lazily if needed
		const overlayConn = this.overlayTable
			? await Promise.resolve(this.overlayTable.createConnection?.())
			: undefined;

		const connection = new IsolatedConnection(
			`${this.schemaName}.${this.tableName}`,
			undefined,
			overlayConn,
			this
		);

		// Register connection with the database for transaction management
		await (this.db as DatabaseInternal).registerConnection(connection);
		this.registeredConnection = connection;
		return connection;
	}

	// ==================== Connection Management ====================

	/**
	 * Creates a new isolated connection for transaction support.
	 * The connection includes this table as a callback so commit/rollback
	 * operations properly flush/clear the overlay.
	 */
	createConnection(): MaybePromise<VirtualTableConnection> {
		const underlyingConn = this.underlyingTable.createConnection?.();
		// Overlay connection created lazily - may not exist yet
		const overlayConn = this.overlayTable?.createConnection?.();

		// Handle sync/async connection creation
		if (underlyingConn instanceof Promise || overlayConn instanceof Promise) {
			return this.createConnectionAsync(underlyingConn, overlayConn);
		}

		return new IsolatedConnection(
			`${this.schemaName}.${this.tableName}`,
			underlyingConn,
			overlayConn,
			this  // Include callback for commit/rollback handling
		);
	}

	private async createConnectionAsync(
		underlyingConn: MaybePromise<VirtualTableConnection> | undefined,
		overlayConn: MaybePromise<VirtualTableConnection> | undefined
	): Promise<VirtualTableConnection> {
		const [underlying, overlay] = await Promise.all([
			underlyingConn,
			overlayConn,
		]);
		return new IsolatedConnection(`${this.schemaName}.${this.tableName}`, underlying, overlay, this);
	}

	// ==================== Query Operations ====================

	/**
	 * Query the table, merging overlay with underlying.
	 *
	 * When overlay is empty or doesn't exist, delegates directly to underlying for efficiency.
	 * When overlay has changes, merges both streams using the appropriate key order.
	 *
	 * For primary key scans: merge by PK order
	 * For secondary index scans: merge by (indexKey, PK) order
	 */
	query(filterInfo: FilterInfo): AsyncIterable<Row> {
		if (!this.underlyingTable.query) {
			throw new Error('Underlying table does not support query');
		}

		// Fast path: no overlay or no changes, or a committed-snapshot read — skip overlay.
		// A poisoned overlay always has hasChanges === true, so this path never serves it;
		// a committed.<table> (readCommitted) read reaches here and stays safe — it reads
		// only the underlying and never merges the poisoned overlay.
		if (this.readCommitted || !this.overlayTable || !this.hasChanges) {
			return this.underlyingTable.query(filterInfo);
		}

		// Merged branch: a poisoned overlay cannot be merged (pre-alter row layout, or the
		// table itself is gone) — error before touching it.
		this.assertOverlayUsable();

		// Merge overlay with underlying (with connection ensured)
		return this.mergedQueryWithConnection(filterInfo);
	}

	/**
	 * Wrapper that ensures connection before merging.
	 */
	private async *mergedQueryWithConnection(filterInfo: FilterInfo): AsyncGenerator<Row> {
		await this.ensureConnection();
		yield* this.mergedQuery(filterInfo);
	}

	/**
	 * Performs merged query combining overlay and underlying data.
	 *
	 * For primary key scans: uses position-based merge since both streams share
	 * the same sort order and overlay entries align with underlying rows by PK.
	 *
	 * For secondary index scans: uses PK-exclusion approach because overlay entries
	 * may have different index key values than the underlying rows they shadow
	 * (tombstones have null non-PK columns; updates may change the indexed column).
	 */
	private async *mergedQuery(filterInfo: FilterInfo): AsyncGenerator<Row> {
		const overlay = this.overlayTable;
		if (!overlay) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const indexInfo = this.resolveScanIndex(filterInfo);

		if (indexInfo.type === 'secondary') {
			yield* this.mergedSecondaryIndexQuery(overlay, filterInfo, indexInfo);
			return;
		}

		// Primary key scan - use standard sort-key merge
		const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);
		const overlayStream = this.queryOverlayAsMergeEntries(overlay, overlayFilterInfo, indexInfo);
		const underlyingStream = this.underlyingTable.query!(filterInfo);
		const mergeConfig = this.buildMergeConfig(indexInfo);
		yield* mergeStreams(overlayStream, underlyingStream, mergeConfig);
	}

	/**
	 * Merged query strategy for secondary index scans.
	 *
	 * Instead of position-based merging (which fails when overlay entries have
	 * different index key values than the underlying rows they shadow), this:
	 * 1. Full-scans the overlay ONCE, collecting all modified PKs and the non-tombstone
	 *    data rows that fall inside the query's constraint window
	 * 2. Sorts the collected overlay rows by the scan's (indexKey, PK) sort key
	 * 3. Queries underlying via secondary index, excluding modified PKs, and merges the
	 *    sorted overlay rows in by sort key
	 *
	 * The overlay is deliberately never asked to resolve the query's index name. The
	 * underlying module may drive this scan under an index it minted itself (lamina
	 * mints `_column_<id>_`, `_compound_<name>_`, `_nd_<name>_`, `_intersect_<ids>_`
	 * per plan) — a name no table schema, and therefore no overlay, declares — so
	 * re-issuing the index-named FilterInfo against the overlay would throw
	 * "Secondary index not found". The isolation layer filters and sorts the overlay
	 * delta itself instead.
	 */
	private async *mergedSecondaryIndexQuery(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo & { type: 'secondary' }
	): AsyncGenerator<Row> {
		if (!overlay.query) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Key the modified-PK set with the engine's canonical, bigint-safe,
		// collation-aware encoder — NOT JSON.stringify, which throws on a bigint PK
		// value and ignores collation (a NOCASE PK rewritten 'abc' -> 'ABC' would fail
		// to shadow the underlying 'abc', surfacing both rows). One normalizer per PK
		// column, drawn from `pkKeyCollationName` (the same decision `resolvePkKeyCollations`
		// makes for the store's on-disk PK encoding) via the connection's own resolver, so
		// equal keys under the PK collation encode to identical strings — matching
		// getComparePK/keysEqual and agreeing with `db.registerCollation`.
		//
		// A PK column whose declared type can never hold text takes the identity
		// normalizer regardless of its collation: `serializeRowKey` normalizes only
		// string values, so the collation cannot affect how such a key buckets. Asking
		// the resolver for it would reject `n integer collate mycoll` under a
		// comparator-only collation, which the engine's own hash sites accept (they gate
		// through `hashKeyCollationName`, the same predicate). A text-capable-but-not-
		// `isTextual` column (`any`, `json`, the temporal types) is keyed under `'BINARY'`
		// regardless of its declared collation, since PK equality compares those types
		// through `logicalType.compare`, which ignores collation entirely.
		const pkNormalizers = pkIndices.map(i => {
			const column = this.tableSchema!.columns[i];
			return this.keyNormalizerResolver(pkKeyCollationName(column));
		});

		// Step 1: one full overlay scan collects the modified PKs AND the in-window
		// non-tombstone data rows. The window filter is applied here, unconditionally —
		// whether the engine adds a residual Filter above the isolation scan depends on
		// the underlying's handledFilters, which the isolation layer does not control.
		// NOTE: full-scans the overlay on every merged secondary read. Fine while an
		// overlay holds a single transaction's writes (small); if isolation-write volume
		// ever makes overlays large and this shows up hot, retarget to an overlay index
		// with the same key columns when one exists, keeping this full scan as the
		// fallback for underlying-minted index names no overlay index matches.
		const matchesWindow = this.buildConstraintMatcher(filterInfo);
		const modifiedPKs = new Set<string>();
		const overlayRows: Row[] = [];
		for await (const row of overlay.query(this.createFullScanFilterInfo())) {
			// `!` is safe: PK columns are NOT NULL, so serializeRowKey never returns
			// null here; both sides use the same encoder so they stay consistent.
			modifiedPKs.add(serializeRowKey(row, pkIndices, pkNormalizers)!);
			if (row[tombstoneIndex] !== 1) {
				const dataRow = row.slice(0, tombstoneIndex);
				if (matchesWindow(dataRow)) {
					overlayRows.push(dataRow);
				}
			}
		}

		// Step 2: sort the collected overlay rows by the merge's sort key. The full scan
		// emits in PK order, and the step-3 merge walks overlayRows expecting
		// (indexKey, PK) order — sorting here decouples merge correctness from whatever
		// order the overlay happens to emit.
		const mergeConfig = this.buildMergeConfig(indexInfo);
		const compareSortKey = mergeConfig.compareSortKey ?? mergeConfig.comparePK;
		const extractSortKey = mergeConfig.extractSortKey ?? mergeConfig.extractPK;
		overlayRows.sort((a, b) => compareSortKey(extractSortKey(a), extractSortKey(b)));

		// Step 3: query underlying via secondary index, filter out modified PKs

		// Merge two sorted, disjoint streams
		let oi = 0;
		for await (const underlyingRow of this.underlyingTable.query!(filterInfo)) {
			// `!` is safe for the same reason as the build loop above (PK NOT NULL).
			if (modifiedPKs.has(serializeRowKey(underlyingRow, pkIndices, pkNormalizers)!)) {
				continue; // Skip rows modified in overlay
			}

			// Yield any overlay rows that sort before this underlying row
			while (oi < overlayRows.length) {
				const oKey = extractSortKey(overlayRows[oi]);
				const uKey = extractSortKey(underlyingRow);
				if (compareSortKey(oKey, uKey) <= 0) {
					yield overlayRows[oi++];
				} else {
					break;
				}
			}

			yield underlyingRow;
		}

		// Yield remaining overlay rows
		while (oi < overlayRows.length) {
			yield overlayRows[oi++];
		}
	}

	/**
	 * Determine the order the underlying scan emits, from the planner's typed access path.
	 *
	 * A `fullScan` (or a provably-empty plan) merges by primary key: every underlying module
	 * the isolation layer wraps emits an unbounded scan in primary-key order. That is a
	 * contract on the underlying, not an inference from any string — see
	 * docs/design-isolation-layer.md.
	 *
	 * `role` is authoritative over `name`: a descriptor with `role: 'primary'` IS the table's
	 * primary key however the module named it (an alias like `_primary_1`), so it merges by PK.
	 * An `unresolvedIndex` — a name the engine could not resolve to any index, with no
	 * module-supplied descriptor — cannot yield a comparator, so we fail loudly rather than
	 * silently merge by the wrong sort key.
	 */
	private resolveScanIndex(filterInfo: FilterInfo): IndexScanInfo {
		const path = filterInfo.accessPath;
		if (!path) {
			throw new QuereusError(
				`IsolatedTable '${this.tableName}': FilterInfo carries no accessPath, so the ` +
				`underlying scan's sort order is unknown and the overlay cannot be merged. ` +
				`Build FilterInfo with the engine's makeFullScanFilterInfo/makeIndexEqSeekFilterInfo helpers.`,
				StatusCode.INTERNAL);
		}
		switch (path.kind) {
			case 'fullScan':
			case 'empty':
				return { type: 'primary' };
			case 'index':
				return path.index.role === 'primary'
					? { type: 'primary' }
					: {
						type: 'secondary',
						indexName: path.index.name,
						columnIndices: path.index.keyColumns.map(c => c.columnIndex),
						keyColumns: path.index.keyColumns,
						// A reversed scan (ORDER BY … DESC) emits the underlying stream in
						// reverse of the descriptor's declared key order; the merge must walk
						// its sort key reversed to interleave overlay rows correctly.
						reverse: path.index.reverse === true,
					};
			case 'unresolvedIndex':
				throw new QuereusError(
					`IsolatedTable '${this.tableName}': the underlying module chose index ` +
					`'${path.indexName}', which the engine could not resolve against the table schema. ` +
					`A module that names an index anything other than '_primary_' or a schema index ` +
					`must return an 'indexDescriptor' from getBestAccessPlan (see docs/module-authoring.md).`,
					StatusCode.INTERNAL);
			default: {
				// A new AccessPath kind must extend this switch; never-assignment makes that a
				// compile error rather than a silent `undefined` return that would crash at the
				// `indexInfo.type` read in mergedQuery (noImplicitReturns is off in this package).
				const _exhaustive: never = path;
				throw new QuereusError(
					`IsolatedTable '${this.tableName}': unhandled accessPath kind '${(path as AccessPath).kind}'`,
					StatusCode.INTERNAL);
			}
		}
	}

	/**
	 * Adapts FilterInfo for the overlay table schema (which has an extra tombstone column).
	 * The constraints and index references remain the same since the overlay has matching indexes.
	 *
	 * The one mismatch is the index NAME. The underlying may drive its PK plan under a per-plan
	 * alias (e.g. `_primary_1`) that the overlay MemoryTable does not know — the overlay always
	 * names its PK index `_primary_`. When the access path is the primary key under such an
	 * alias, retarget the FilterInfo's index name to `_primary_` so the overlay re-plans it as a
	 * primary-key scan instead of failing to resolve a non-existent secondary index of that name.
	 * A genuine secondary scan (or the bare `_primary_`) is returned unchanged.
	 */
	private adaptFilterInfoForOverlay(filterInfo: FilterInfo): FilterInfo {
		const path = filterInfo.accessPath;
		if (path?.kind === 'index' && path.index.role === 'primary' && path.index.name !== PRIMARY_INDEX_NAME) {
			return retargetFilterInfoIndex(filterInfo, PRIMARY_INDEX_NAME);
		}
		return filterInfo;
	}

	/**
	 * Builds the window predicate for the overlay side of a merged secondary-index read.
	 *
	 * The overlay is full-scanned there (it cannot resolve an underlying-minted index
	 * name), so every staged row surfaces — including rows outside the query's window.
	 * This predicate re-applies the pushed constraints that the underlying's index seek
	 * enforces on its own stream.
	 *
	 * Interpretation follows the plan kind:
	 * - `scan` pushes no window — everything matches.
	 * - `eqSeek` / `rangeSeek` / `prefixRangeSeek` / `multiSeek` carry one genuine
	 *   (column, op, value) triple per constraint entry. Per-column EQ values form an
	 *   IN set — the planner encodes an IN multi-seek as one EQ constraint per seek
	 *   value on the same column, and a composite IN as its full per-column
	 *   cross-product — so EQ matches when the row equals ANY of the column's values,
	 *   while range bounds all AND together.
	 * - `multiRangeSeek` constraint entries are positional placeholders (every arg is
	 *   stamped GE); the real OR-of-ranges lives in the idxStr `rangeOps` parameters,
	 *   decoded by {@link buildMultiRangeWindowMatcher}.
	 *
	 * Comparisons run under the index key column's collation (falling back to the table
	 * column's, then BINARY) with seek semantics for NULL: a NULL operand or a NULL row
	 * value never matches, mirroring what an index seek returns. Operators the matcher
	 * does not interpret (LIKE, MATCH, ...) are ignored — that can only let through
	 * rows a residual Filter above still removes, never drop rows.
	 */
	private buildConstraintMatcher(filterInfo: FilterInfo): (row: Row) => boolean {
		const path = filterInfo.accessPath;
		// Only 'index' paths reach the merged secondary read (resolveScanIndex gates on
		// the access path first); an ordering-only walk pushes no window.
		if (path?.kind !== 'index' || path.plan === 'scan') {
			return () => true;
		}
		if (path.plan === 'multiRangeSeek') {
			return this.buildMultiRangeWindowMatcher(filterInfo, path.index);
		}

		interface ColumnWindow {
			collation: CollationFunction;
			eqValues: SqlValue[];
			ranges: { op: IndexConstraintOp; value: SqlValue }[];
		}
		const windows = new Map<number, ColumnWindow>();
		const windowFor = (columnIndex: number): ColumnWindow => {
			let window = windows.get(columnIndex);
			if (!window) {
				window = { collation: this.constraintCollation(columnIndex, path.index), eqValues: [], ranges: [] };
				windows.set(columnIndex, window);
			}
			return window;
		};

		for (const { constraint, argvIndex } of filterInfo.constraints) {
			if (argvIndex <= 0) continue;
			const value = filterInfo.args[argvIndex - 1];
			switch (constraint.op) {
				case IndexConstraintOp.EQ:
					windowFor(constraint.iColumn).eqValues.push(value);
					break;
				case IndexConstraintOp.GT:
				case IndexConstraintOp.GE:
				case IndexConstraintOp.LT:
				case IndexConstraintOp.LE:
					windowFor(constraint.iColumn).ranges.push({ op: constraint.op, value });
					break;
				default:
					break; // uninterpreted op — see doc comment
			}
		}

		if (windows.size === 0) return () => true;
		const entries = [...windows.entries()];

		return (row: Row): boolean => {
			for (const [columnIndex, window] of entries) {
				const rowValue = row[columnIndex];
				if (rowValue === null) return false;
				if (window.eqValues.length > 0
					&& !window.eqValues.some(v => v !== null && compareSqlValuesFast(rowValue, v, window.collation) === 0)) {
					return false;
				}
				for (const { op, value } of window.ranges) {
					if (value === null || !satisfiesBound(compareSqlValuesFast(rowValue, value, window.collation), op)) {
						return false;
					}
				}
			}
			return true;
		};
	}

	/**
	 * Window matcher for a `multiRangeSeek` — an OR of ranges over the index's leading
	 * key column. The FilterInfo's constraint entries are positional placeholders for
	 * this plan kind, so the ranges are decoded from the idxStr `rangeCount`/`rangeOps`
	 * parameters exactly as the memory module's scan-plan builder does.
	 */
	private buildMultiRangeWindowMatcher(filterInfo: FilterInfo, index: IndexDescriptor): (row: Row) => boolean {
		const keyColumn = index.keyColumns[0];
		const spec = decodeIdxStr(filterInfo.idxStr);
		if (!keyColumn || !spec) return () => true;

		interface Bound { strict: boolean; value: SqlValue }
		const rangeCount = parseInt(spec.params.get('rangeCount') ?? '0', 10);
		const rangeOpsList = (spec.params.get('rangeOps') ?? '').split(',');
		const { args } = filterInfo;
		const ranges: { lower?: Bound; upper?: Bound }[] = [];
		let argIdx = 0;
		for (let i = 0; i < rangeCount; i++) {
			const range: { lower?: Bound; upper?: Bound } = {};
			for (const op of (rangeOpsList[i] ?? '').split(':')) {
				if (op === 'gt' || op === 'ge') {
					range.lower = { strict: op === 'gt', value: args[argIdx++] };
				} else if (op === 'lt' || op === 'le') {
					range.upper = { strict: op === 'lt', value: args[argIdx++] };
				}
			}
			ranges.push(range);
		}
		if (ranges.length === 0) return () => true;

		const columnIndex = keyColumn.columnIndex;
		const collation = this.constraintCollation(columnIndex, index);
		return (row: Row): boolean => {
			const rowValue = row[columnIndex];
			if (rowValue === null) return false;
			return ranges.some(({ lower, upper }) => {
				if (lower) {
					if (lower.value === null) return false;
					const cmp = compareSqlValuesFast(rowValue, lower.value, collation);
					if (lower.strict ? cmp <= 0 : cmp < 0) return false;
				}
				if (upper) {
					if (upper.value === null) return false;
					const cmp = compareSqlValuesFast(rowValue, upper.value, collation);
					if (upper.strict ? cmp >= 0 : cmp > 0) return false;
				}
				return true;
			});
		};
	}

	/**
	 * Comparison collation for a window-matcher column: the index key column's declared
	 * collation when the column is part of the scanned index (the seek's own window
	 * follows the index collation), else the table column's declared collation, else
	 * BINARY.
	 */
	private constraintCollation(columnIndex: number, index: IndexDescriptor): CollationFunction {
		const name = index.keyColumns.find(kc => kc.columnIndex === columnIndex)?.collation
			?? this.tableSchema?.columns[columnIndex]?.collation;
		return name ? this.collationResolver(name) : BINARY_COLLATION;
	}

	/**
	 * Queries the overlay table and converts rows to MergeEntry format.
	 *
	 * Uses the same FilterInfo as the underlying query so both streams are in the same order.
	 * For secondary index scans, the sort key includes both the index key and primary key.
	 */
	private async *queryOverlayAsMergeEntries(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo
	): AsyncGenerator<MergeEntry> {
		if (!overlay.query) {
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Query overlay with the same filter constraints
		for await (const overlayRow of overlay.query(filterInfo)) {
			const isTombstone = overlayRow[tombstoneIndex] === 1;
			const pk = pkIndices.map(i => overlayRow[i]);

			// Build sort key based on index type
			const sortKey = this.buildSortKey(overlayRow, pkIndices, indexInfo);

			if (isTombstone) {
				yield createTombstone(pk, sortKey);
			} else {
				// Remove the tombstone column from the row before yielding
				const dataRow = overlayRow.slice(0, tombstoneIndex);
				yield createMergeEntry(dataRow, pk, sortKey);
			}
		}
	}

	/**
	 * Builds the sort key for a row based on the index being scanned.
	 *
	 * For primary key scans: sort key is the PK
	 * For secondary index scans: sort key is [indexKeyParts..., pkParts...]
	 */
	private buildSortKey(row: Row, pkIndices: number[], indexInfo: IndexScanInfo): SqlValue[] {
		if (indexInfo.type === 'primary') {
			return pkIndices.map(i => row[i]);
		}

		// Secondary index: combine index key columns with PK columns
		const indexKey = indexInfo.columnIndices.map(i => row[i]);
		const pk = pkIndices.map(i => row[i]);
		return [...indexKey, ...pk];
	}

	/**
	 * Builds the merge configuration using this table's key functions.
	 *
	 * For primary key scans: compare by PK
	 * For secondary index scans: compare by (indexKey, PK) using underlying's comparator
	 *
	 * @param indexInfo Which index is being scanned. Defaults to primary key scan.
	 */
	private buildMergeConfig(indexInfo: IndexScanInfo = { type: 'primary' }): MergeConfig {
		const pkIndices = this.getPrimaryKeyIndices();

		const extractPK = (row: Row) => pkIndices.map(i => row[i]);
		const comparePK = this.getComparePK();

		if (indexInfo.type === 'primary') {
			// Primary key scan - sort key equals PK
			return {
				extractPK,
				comparePK,
				// No need for separate sort key functions - defaults to PK
			};
		}

		// Secondary index scan - sort key is (indexKey, PK)
		const indexColIndices = indexInfo.columnIndices;
		const extractSortKey = (row: Row): SqlValue[] => {
			const indexKey = indexColIndices.map(i => row[i]);
			const pk = pkIndices.map(i => row[i]);
			return [...indexKey, ...pk];
		};

		// Prefer the underlying table's per-column index comparators; when it exposes
		// none for this index (always the case for a module-minted synthetic name),
		// derive them from the descriptor's key columns so a DESC or collated key
		// column still merges in the underlying's emission order rather than a
		// BINARY-ascending guess.
		const indexComparators = this.underlyingTable.getIndexComparator?.(indexInfo.indexName)
			?? this.buildDescriptorComparators(indexInfo.keyColumns);
		const forwardCompareSortKey = this.buildCompareSortKey(indexColIndices.length, comparePK, indexComparators);
		// A reversed scan emits the whole (indexKey, PK) sort key in reverse — including
		// the PK tie-break within an equal index-key group — so negate the entire
		// comparator. That makes the step-2 overlay sort descend and the step-3 merge's
		// `compareSortKey(oKey, uKey) <= 0` walk yield overlay rows while they sort at or
		// before the underlying row under the reversed order.
		const compareSortKey = indexInfo.reverse
			? (a: SqlValue[], b: SqlValue[]) => -forwardCompareSortKey(a, b)
			: forwardCompareSortKey;

		return {
			extractPK,
			comparePK,
			extractSortKey,
			compareSortKey,
		};
	}

	/**
	 * Per-PK-column comparison functions for this table's current schema, resolved
	 * against THIS database's collation registry (so `db.registerCollation` names
	 * participate) rather than the process-global built-in trio.
	 *
	 * A PK column with no declared `COLLATE` resolves to BINARY; a PK definition
	 * shorter than the key being compared (or absent entirely) yields BINARY for the
	 * trailing positions, matching the prior `collation === undefined` behaviour.
	 *
	 * Memoized on the schema object so comparator construction — and the per-call
	 * {@link keysEqual} — never re-resolves per row. Resolution is not retroactive: a
	 * collation registered *after* a comparator was built is not picked up, the same
	 * contract `Database.registerCollation` documents engine-wide.
	 *
	 * NOTE: this is the *comparison* collation only. The store's physical key bytes come
	 * from a separate encoder registry that does not consult the database — see
	 * `fix/bug-store-key-encoder-ignores-database-collations`.
	 */
	private getPkCollations(): CollationFunction[] {
		return this.getPkKeyShape().functions;
	}

	/**
	 * Per-PK-column sort directions (`true` ⇒ DESC), positionally aligned with
	 * {@link getPkCollations}. Only the ordering comparator needs them; `keysEqual`
	 * asks about equality, which direction cannot change.
	 */
	private getPkDirections(): boolean[] {
		return this.getPkKeyShape().directions;
	}

	private getPkKeyShape(): { functions: CollationFunction[]; directions: boolean[] } {
		const schema = this.tableSchema;
		if (!schema) return EMPTY_PK_KEY_SHAPE;
		if (this.pkCollationCache?.schema !== schema) {
			const pkDef = schema.primaryKeyDefinition ?? [];
			this.pkCollationCache = {
				schema,
				functions: resolveCollationFunctions(this.collationResolver, pkDef.map(pk => schema.columns[pk.index]?.collation)),
				directions: pkDef.map(pk => !!pk.desc),
			};
		}
		return this.pkCollationCache;
	}

	/**
	 * Gets the primary key comparator, preferring the underlying table's comparator.
	 */
	private getComparePK(): (a: SqlValue[], b: SqlValue[]) => number {
		// Use underlying table's comparator if available for consistent ordering
		if (this.underlyingTable.comparePrimaryKey) {
			return this.underlyingTable.comparePrimaryKey.bind(this.underlyingTable);
		}

		// Fallback to default comparator. Compare under each PK column's declared
		// collation (e.g. NOCASE), not BINARY, and in its declared direction: the merge
		// aligns overlay and underlying entries by this comparator to decide shadowing,
		// and the underlying store keys rows both collation-aware and DESC-aware. A
		// binary comparator would treat a case-only-updated overlay row ('APPLE') and
		// the underlying row it shadows ('apple') as distinct keys; an ascending one
		// walks a `primary key (k desc)` table against its scan order. Either way both
		// rows surface in a scan instead of the overlay shadowing the underlying.
		const collations = this.getPkCollations();
		const directions = this.getPkDirections();
		return (a: SqlValue[], b: SqlValue[]) => {
			for (let i = 0; i < a.length; i++) {
				const cmp = compareSqlValuesFast(a[i], b[i], collations[i] ?? BINARY_COLLATION);
				if (cmp !== 0) return directions[i] ? -cmp : cmp;
			}
			return 0;
		};
	}

	/**
	 * Per-column comparators derived from an index descriptor's key columns — the
	 * fallback when the underlying exposes no `getIndexComparator` for the index
	 * (always the case for a module-minted synthetic name). Honors each key column's
	 * declared direction and collation so the merge walks the underlying's emission
	 * order.
	 */
	private buildDescriptorComparators(keyColumns: readonly IndexKeyColumn[]): ((a: SqlValue, b: SqlValue) => number)[] {
		return keyColumns.map(kc => {
			const collation = kc.collation ? this.collationResolver(kc.collation) : BINARY_COLLATION;
			return (a: SqlValue, b: SqlValue) => {
				const cmp = compareSqlValuesFast(a, b, collation);
				return kc.desc ? -cmp : cmp;
			};
		});
	}

	/**
	 * Builds a sort key comparator for secondary index scans.
	 *
	 * Compares by index key columns first (using per-column comparators that
	 * incorporate DESC ordering and collation), then by PK columns.
	 */
	private buildCompareSortKey(
		indexKeyLength: number,
		comparePK: (a: SqlValue[], b: SqlValue[]) => number,
		indexComparators?: ((a: SqlValue, b: SqlValue) => number)[]
	): (a: SqlValue[], b: SqlValue[]) => number {
		return (a: SqlValue[], b: SqlValue[]) => {
			// Compare index key portion first
			for (let i = 0; i < indexKeyLength; i++) {
				const cmp = indexComparators?.[i]
					? indexComparators[i](a[i], b[i])
					: compareSqlValues(a[i], b[i]);
				if (cmp !== 0) return cmp;
			}

			// Index keys equal - compare PK portion
			const pkA = a.slice(indexKeyLength);
			const pkB = b.slice(indexKeyLength);
			return comparePK(pkA, pkB);
		};
	}

	/**
	 * Gets the index of the tombstone column in overlay rows.
	 */
	private getTombstoneColumnIndex(overlay: VirtualTable): number {
		const schema = overlay.tableSchema;
		if (!schema) {
			throw new Error('Overlay table has no schema');
		}
		const idx = schema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (idx === undefined) {
			throw new Error(`Tombstone column '${this.tombstoneColumn}' not found in overlay schema`);
		}
		return idx;
	}

	/**
	 * Gets the primary key column indices from the underlying table schema.
	 */
	getPrimaryKeyIndices(): number[] {
		const schema = this.tableSchema;
		if (!schema) return [];
		return schema.primaryKeyDefinition.map(pkDef => pkDef.index);
	}

	/**
	 * Coerce each cell to its declared column logical type before PK extraction and
	 * conflict detection — the same step StoreTable.coerceRow / MemoryTableManager.performInsert
	 * run. Without it, an ON CONFLICT insert whose proposed key is a different storage class than
	 * the stored key (TEXT '1' into an INTEGER key holding 1) probes the underlying with the
	 * un-coerced key, misses the committed row, and stages the proposed row instead of updating
	 * the existing one (bug-store-isolation-upsert-affinity-coerced-pk).
	 */
	private coerceRow(row: Row): Row {
		return coerceRowToSchema(row, this.tableSchema!.columns, `${this.schemaName}.${this.tableName}`);
	}

	// ==================== Write Operations ====================

	/**
	 * Performs INSERT, UPDATE, or DELETE on the overlay.
	 * Changes are not visible to underlying until commit.
	 *
	 * The overlay is created lazily on first write, using schema from the underlying table.
	 */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		// A poisoned overlay (cross-connection ALTER or DROP TABLE) cannot accept further
		// writes — it can never be flushed. Error before staging anything.
		this.assertOverlayUsable();

		// Ensure connection is registered for transaction coordination
		await this.ensureConnection();

		// Lazily create overlay on first write
		const overlay = await this.ensureOverlay();

		// Mark that we have changes
		this.setHasChanges(true);

		const { operation, values, oldKeyValues } = args;
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Coerced only for PK extraction / merged-view conflict detection below — NOT
		// for the overlay write. The overlay (a memory-module table) always re-coerces
		// every cell on its own insert/update unconditionally, so writing the coerced
		// row through would coerce twice. That is a no-op for most logical types, but
		// JSON's `parse` is not idempotent for a JSON-string scalar (`'"hello"'` parses
		// to the native JS string `"hello"`; re-parsing that bare string as JSON throws,
		// since it lacks its own quotes) — double coercion would break any JSON column.
		// Detection instead needs the coerced form: probing the overlay/underlying by an
		// un-coerced PK (e.g. TEXT '1' against a stored INTEGER 1) misses the existing
		// row entirely (bug-store-isolation-upsert-affinity-coerced-pk).
		// NOTE: this coerces the full row on every isolation-layer write, and the overlay
		// coerces it again on its own insert/update — two validateAndParse passes per write
		// (two JSON.parse for JSON columns). Negligible now; if isolation-write throughput or
		// large-JSON rows ever show as hot, thread the coerced row through as pre-coerced.
		const coercedValues = values ? this.coerceRow(values) : values;

		// Resolve the effective PK-level action once so the wrapped overlay vtab
		// agrees with the overlay's decision. Per-UC defaults are applied inside
		// checkMergedUniqueConstraints, since each UC may declare its own action.
		const effectiveOR = args.onConflict ?? resolvePkDefaultConflict(this.tableSchema!);
		const argsForOverlay: UpdateArgs = effectiveOR !== undefined
			? { ...args, onConflict: effectiveOR }
			: args;

		switch (operation) {
			case 'insert': {
				const pkIndices = this.getPrimaryKeyIndices();
				const pk = coercedValues ? pkIndices.map(i => coercedValues[i]) : undefined;
				// Secondary-UNIQUE REPLACE evictions surfaced via `evictedRows`.
				const evicted: Row[] = [];

				// Captured when OR REPLACE displaces a row that lives only in the
				// underlying store — surfaced as `replacedRow` so the DML executor
				// fires ON DELETE cascades for the displaced parent.
				let replacedUnderlyingRow: Row | undefined;

				if (pk) {
					const existingRow = await this.getOverlayRow(overlay, pk);
					if (existingRow && existingRow[tombstoneIndex] === 1) {
						// Convert tombstone to regular row (delete then re-insert same PK).
						// Run the same merged non-PK UNIQUE check the normal insert path runs
						// (~below) before writing — otherwise a revived row that collides on a
						// secondary UNIQUE is flushed with trustedWrite (store skips its re-check),
						// yielding an opaque INTERNAL error at commit or silent corruption.
						// selfPks = [pk] excludes this row's own PK from conflict detection.
						const ucResult = await this.checkMergedUniqueConstraints(
							overlay, coercedValues!, [pk], tombstoneIndex, args.onConflict, evicted);
						if (ucResult !== null) return ucResult;

						const overlayRow = [...(values ?? []), 0];
						const result = await overlay.update({
							operation: 'update',
							values: overlayRow,
							oldKeyValues: pk,
							onConflict: effectiveOR,
						});
						const stripped = this.stripTombstoneFromResult(result, tombstoneIndex);
						return this.attachEvicted(stripped, evicted, tombstoneIndex);
					}

					if (existingRow) {
						// Live row already in overlay for this PK. Resolve against any column-level
						// PK defaultConflict; ABORT/FAIL/ROLLBACK short-circuit with a table-named
						// constraint error, IGNORE/REPLACE fall through to overlay.update().
						const effective = effectiveOR ?? ConflictResolution.ABORT;
						if (effective === ConflictResolution.ABORT
							|| effective === ConflictResolution.FAIL
							|| effective === ConflictResolution.ROLLBACK) {
							return {
								status: 'constraint',
								constraint: 'unique',
								message: `UNIQUE constraint failed: ${this.tableName} PK.`,
								existingRow: existingRow.slice(0, tombstoneIndex) as Row,
							};
						}
					}

					if (!existingRow) {
						// No overlay entry — check underlying for PK conflict
						const pkOutcome = await this.checkMergedPKConflict(overlay, pk, tombstoneIndex, args.onConflict);
						if (pkOutcome.terminating) return pkOutcome.terminating;
						replacedUnderlyingRow = pkOutcome.replacedUnderlyingRow;

						// Check non-PK UNIQUE constraints against merged view
						const ucResult = await this.checkMergedUniqueConstraints(overlay, coercedValues!, [pk], tombstoneIndex, args.onConflict, evicted);
						if (ucResult !== null) return ucResult;
					}
				}

				// Normal insert into overlay with tombstone = 0
				const overlayRow = [...(values ?? []), 0];
				const result = await overlay.update({
					...argsForOverlay,
					values: overlayRow,
				});
				const stripped = this.stripTombstoneFromResult(result, tombstoneIndex);
				return this.attachEvicted(this.attachReplacedUnderlying(stripped, replacedUnderlyingRow), evicted, tombstoneIndex);
			}

			case 'update': {
				// For updates, we need to handle the case where the row exists in:
				// 1. Overlay only (previous insert) - update the overlay row
				// 2. Underlying only - insert into overlay with new values
				// 3. Both (previous update) - update the overlay row

				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (coercedValues ? pkIndices.map(i => coercedValues[i]) : undefined);

				if (!targetPK || !values) {
					throw new Error('UPDATE requires oldKeyValues or values with primary key');
				}

				const existingOverlayRow = await this.getOverlayRow(overlay, targetPK);
				const overlayRow = [...values, 0]; // tombstone = 0
				// Secondary-UNIQUE REPLACE evictions surfaced via `evictedRows`.
				const evicted: Row[] = [];

				if (existingOverlayRow) {
					const newPK = pkIndices.map(i => coercedValues![i]);
					const pkChanged = !this.keysEqual(targetPK, newPK);

					if (pkChanged) {
						// PK is changing: check for conflicts at the new PK, then tombstone the old
						// overlay slot and insert a fresh row at the new PK so the underlying row
						// at targetPK is shadowed (tombstoned) after flush.
						const pkOutcome = await this.checkMergedPKConflict(overlay, newPK, tombstoneIndex, args.onConflict);
						if (pkOutcome.terminating) return pkOutcome.terminating;

						const ucResult = await this.checkMergedUniqueConstraints(overlay, coercedValues!, [targetPK, newPK], tombstoneIndex, args.onConflict, evicted);
						if (ucResult !== null) return ucResult;

						// Remove existing overlay row then insert a tombstone so the underlying
						// row at targetPK is hidden after flush.  Delete-then-insert avoids a
						// same-layer upsert that some BTree implementations may not handle
						// correctly when updating a value inserted in the same transaction.
						await overlay.update({ operation: 'delete', values: undefined, oldKeyValues: targetPK });
						await this.insertTombstoneForPK(overlay, targetPK, tombstoneIndex);
						// Reuse a tombstone already at newPK (a PK freed earlier in this txn)
						// instead of colliding with it — see writeRelocatedRow.
						const result = await this.writeRelocatedRow(overlay, newPK, overlayRow, tombstoneIndex, effectiveOR);
						const stripped = this.stripTombstoneFromResult(result, tombstoneIndex);
						return this.attachEvicted(this.attachReplacedUnderlying(stripped, pkOutcome.replacedUnderlyingRow), evicted, tombstoneIndex);
					}

					// Same PK — update the overlay row in place
					const result = await overlay.update({
						...argsForOverlay,
						values: overlayRow,
						oldKeyValues: targetPK,
					});
					return this.stripTombstoneFromResult(result, tombstoneIndex);
				} else {
					// Insert new overlay row (shadows underlying) — check underlying conflicts first
					const newPK = pkIndices.map(i => coercedValues![i]);
					const pkChanged = !this.keysEqual(targetPK, newPK);

					let replacedUnderlyingRow: Row | undefined;
					if (pkChanged) {
						const pkOutcome = await this.checkMergedPKConflict(overlay, newPK, tombstoneIndex, args.onConflict);
						if (pkOutcome.terminating) return pkOutcome.terminating;
						replacedUnderlyingRow = pkOutcome.replacedUnderlyingRow;
					}

					const selfPks: SqlValue[][] = pkChanged ? [targetPK, newPK] : [targetPK];
					const ucResult = await this.checkMergedUniqueConstraints(overlay, coercedValues!, selfPks, tombstoneIndex, args.onConflict, evicted);
					if (ucResult !== null) return ucResult;

					// For PK-change updates, tombstone the old PK so the underlying row is deleted at flush
					if (pkChanged) {
						await this.insertTombstoneForPK(overlay, targetPK, tombstoneIndex);
					}

					// On a PK-change, reuse a tombstone already at newPK (a PK freed earlier
					// in this txn) instead of colliding with it — see writeRelocatedRow.
					// A same-PK update has no overlay row at newPK (=== targetPK), so the
					// helper's insert path matches the prior behavior.
					const result = pkChanged
						? await this.writeRelocatedRow(overlay, newPK, overlayRow, tombstoneIndex, effectiveOR)
						: await overlay.update({ operation: 'insert', values: overlayRow, onConflict: effectiveOR });
					const stripped = this.stripTombstoneFromResult(result, tombstoneIndex);
					return this.attachEvicted(this.attachReplacedUnderlying(stripped, replacedUnderlyingRow), evicted, tombstoneIndex);
				}
			}

			case 'delete': {
				// For deletes, insert a tombstone into overlay
				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (coercedValues ? pkIndices.map(i => coercedValues[i]) : undefined);

				if (!targetPK) {
					throw new Error('DELETE requires oldKeyValues or values with primary key');
				}

				const existingOverlayRow = await this.getOverlayRow(overlay, targetPK);

				if (existingOverlayRow) {
					if (existingOverlayRow[tombstoneIndex] === 1) {
						// Already deleted, nothing to do — return ok without row so callers
						// (e.g. dml-executor auto-event path) know no actual row was removed.
						return { status: 'ok' };
					}
					// Convert to tombstone by updating the tombstone flag
					const tombstoneRow = [...existingOverlayRow.slice(0, tombstoneIndex), 1];
					await overlay.update({
						operation: 'update',
						values: tombstoneRow,
						oldKeyValues: targetPK,
						onConflict: args.onConflict,
					});
					// Return the pre-deletion row so dml-executor emits the auto change event.
					const deletedRow = existingOverlayRow.slice(0, tombstoneIndex) as SqlValue[];
					return { status: 'ok', row: deletedRow };
				} else {
					// Insert tombstone to shadow underlying row
					// Build a minimal row with PK values and tombstone = 1
					const schema = this.tableSchema;
					if (!schema) throw new Error('No table schema');

					const tombstoneRow: SqlValue[] = new Array(schema.columns.length + 1).fill(null);
					pkIndices.forEach((colIdx, i) => {
						tombstoneRow[colIdx] = targetPK[i];
					});
					tombstoneRow[tombstoneIndex] = 1; // Set tombstone flag

					await overlay.update({
						operation: 'insert',
						values: tombstoneRow,
						onConflict: args.onConflict,
					});
					// Return a minimal placeholder row (PK columns only) so dml-executor
					// recognises the delete as successful and emits the auto change event.
					const placeholderRow: SqlValue[] = new Array(schema.columns.length).fill(null);
					pkIndices.forEach((colIdx, i) => {
						placeholderRow[colIdx] = targetPK[i];
					});
					return { status: 'ok', row: placeholderRow };
				}
			}

			default:
				throw new Error(`Unknown operation: ${operation}`);
		}
	}

	/**
	 * Strips the tombstone column from an overlay update result.
	 */
	private stripTombstoneFromResult(result: UpdateResult, tombstoneIndex: number): UpdateResult {
		if (isUpdateOk(result) && result.row) {
			// `replacedRow` / `evictedRows` from the overlay's memory module also carry
			// the trailing tombstone column (the overlay schema appends it). Slice it off
			// so consumers see rows that match the user-facing schema.
			//
			// `evictedRows` here are evictions the overlay's OWN memory module performed —
			// an intra-statement secondary-UNIQUE REPLACE against a row written earlier in
			// the same statement (it lives in the overlay, not the underlying, so the
			// isolation layer's own `findMergedUniqueConflict` does not see it). They must
			// flow through to the DML executor's eviction pipeline like any other.
			const replacedRow = result.replacedRow
				? (result.replacedRow.slice(0, tombstoneIndex) as Row)
				: undefined;
			const evictedRows = result.evictedRows
				? result.evictedRows.map(r => r.slice(0, tombstoneIndex) as Row)
				: undefined;
			return { status: 'ok', row: result.row.slice(0, tombstoneIndex), replacedRow, evictedRows };
		}
		return result;
	}

	/**
	 * If a REPLACE conflict displaced a row that lives only in the underlying store,
	 * surface it as `replacedRow` on the success result.  The overlay-only path
	 * already carries `replacedRow` (the overlay's memory module emits it natively);
	 * this overrides only when we have a store-side displacement to report.
	 */
	private attachReplacedUnderlying(result: UpdateResult, replacedUnderlyingRow: Row | undefined): UpdateResult {
		if (!replacedUnderlyingRow) return result;
		if (!isUpdateOk(result) || !result.row) return result;
		return { ...result, row: result.row, replacedRow: replacedUnderlyingRow };
	}

	/**
	 * Surface internal REPLACE evictions of **underlying** rows (rows at OTHER PKs the
	 * isolation layer's own merged-view detection displaced via a tombstone) as
	 * `evictedRows`, so the DML executor runs the full delete pipeline for each. The
	 * passed rows come from `findMergedUniqueConflict`, which yields live underlying
	 * rows already in user-facing schema, so the tombstone-column slice is a defensive
	 * no-op. Preserves any `replacedRow` already attached and **merges** with any
	 * `evictedRows` already present (overlay-internal evictions propagated by
	 * {@link stripTombstoneFromResult}) — the two eviction sources are disjoint per
	 * write today (the conflicting row lives in the overlay XOR the underlying) but
	 * merging keeps both correct if that ever changes.
	 */
	private attachEvicted(result: UpdateResult, evicted: Row[], tombstoneIndex: number): UpdateResult {
		if (evicted.length === 0) return result;
		if (!isUpdateOk(result) || !result.row) return result;
		const stripped = evicted.map(r => r.slice(0, tombstoneIndex) as Row);
		const evictedRows = result.evictedRows ? [...result.evictedRows, ...stripped] : stripped;
		return { ...result, evictedRows };
	}

	/**
	 * Gets a row from the overlay by primary key using O(log n) point lookup.
	 */
	private async getOverlayRow(overlay: VirtualTable, pk: SqlValue[]): Promise<Row | undefined> {
		if (!overlay.query) return undefined;

		for await (const row of overlay.query(this.buildPKPointLookupFilter(pk))) {
			return row;
		}
		return undefined;
	}

	/**
	 * Creates a FilterInfo for a full table scan (no constraints).
	 */
	private createFullScanFilterInfo(): FilterInfo {
		return makeFullScanFilterInfo();
	}

	/**
	 * Creates a FilterInfo for a primary key point lookup (equality on all PK columns).
	 * This produces O(log n) lookups instead of O(n) full scans.
	 */
	private buildPKPointLookupFilter(pk: SqlValue[]): FilterInfo {
		return makePkPointLookupFilter(this.getPrimaryKeyIndices(), pk);
	}

	// ==================== Merged-View Conflict Detection ====================

	/**
	 * Returns the compiled predicate for a partial-UNIQUE constraint, or undefined
	 * when the constraint covers the full table. Compilation is memoized per
	 * UniqueConstraintSchema instance so the hot UNIQUE-check path doesn't recompile.
	 */
	private compileFor(uc: UniqueConstraintSchema): CompiledPredicate | undefined {
		if (!uc.predicate) return undefined;
		let compiled = this.predicateCache.get(uc);
		if (!compiled) {
			compiled = compilePredicate(uc.predicate, this.tableSchema!.columns, this.tableSchema!.name);
			this.predicateCache.set(uc, compiled);
		}
		return compiled;
	}

	private keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
		if (a.length !== b.length) return false;
		// Compare under each PK column's declared collation, not BINARY. The underlying
		// store keys rows collation-aware (e.g. a NOCASE text PK), so a case-only PK
		// rewrite ('apple' → 'APPLE') is the SAME logical key. A binary comparison here
		// would mis-classify it as a PK relocation, then resolve the "new" key back to the
		// same physical underlying row and raise a false UNIQUE PK conflict.
		const collations = this.getPkCollations();
		for (let i = 0; i < a.length; i++) {
			if (compareSqlValuesFast(a[i], b[i], collations[i] ?? BINARY_COLLATION) !== 0) return false;
		}
		return true;
	}

	private async getUnderlyingRow(pk: SqlValue[]): Promise<Row | undefined> {
		if (!this.underlyingTable.query) return undefined;
		for await (const row of this.underlyingTable.query(this.buildPKPointLookupFilter(pk))) {
			return row;
		}
		return undefined;
	}

	/**
	 * Writes a relocated row at `newPK` in the overlay for a PK-changing UPDATE.
	 *
	 * If the overlay already holds a **tombstone** at newPK (a PK that was freed
	 * earlier in this same transaction), overwrite it via `operation: 'update'`
	 * rather than `operation: 'insert'` — the overlay is itself a StoreTable whose
	 * insert path treats a tombstone row at the target key as a live PK conflict
	 * and would throw `_overlay_<table> PK`. Overwriting the tombstone is the
	 * logical reuse of the freed PK. This mirrors the plain-INSERT tombstone
	 * conversion (~the `existingRow[tombstoneIndex] === 1` branch in `update`).
	 *
	 * A **live** overlay row at newPK is already rejected upstream by
	 * {@link checkMergedPKConflict} (which returns its terminating constraint
	 * result) and by the existing-overlay-row PK-conflict branch, so reaching here
	 * with a non-tombstone overlay row should not happen; if it ever does, fall
	 * through to insert and let the overlay enforce the genuine conflict.
	 */
	private async writeRelocatedRow(
		overlay: VirtualTable,
		newPK: SqlValue[],
		overlayRow: SqlValue[],
		tombstoneIndex: number,
		effectiveOR: ConflictResolution | undefined,
	): Promise<UpdateResult> {
		const existingAtNewPK = await this.getOverlayRow(overlay, newPK);
		if (existingAtNewPK && existingAtNewPK[tombstoneIndex] === 1) {
			return overlay.update({
				operation: 'update',
				values: overlayRow,
				oldKeyValues: newPK,
				onConflict: effectiveOR,
			});
		}
		return overlay.update({
			operation: 'insert',
			values: overlayRow,
			onConflict: effectiveOR,
		});
	}

	private async insertTombstoneForPK(overlay: VirtualTable, pk: SqlValue[], tombstoneIndex: number): Promise<void> {
		const schema = this.tableSchema;
		if (!schema) throw new Error('No table schema');
		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneRow: SqlValue[] = new Array(schema.columns.length + 1).fill(null);
		pkIndices.forEach((colIdx, i) => { tombstoneRow[colIdx] = pk[i]; });
		tombstoneRow[tombstoneIndex] = 1;
		const existing = await this.getOverlayRow(overlay, pk);
		if (existing) {
			await overlay.update({ operation: 'update', values: tombstoneRow, oldKeyValues: pk });
		} else {
			await overlay.update({ operation: 'insert', values: tombstoneRow });
		}
	}

	/**
	 * Checks if newPK conflicts with an underlying row not already shadowed in the overlay.
	 *
	 * Returns a discriminated outcome:
	 * - `{}` — no conflict (or overlay is authoritative); proceed.
	 * - `{ terminating }` — short-circuit with this UpdateResult (IGNORE / constraint).
	 * - `{ replacedUnderlyingRow }` — REPLACE applied against a row that lives only
	 *   in the underlying store. The caller must surface this row as `replacedRow`
	 *   in the final UpdateResult so the DML executor fires ON DELETE cascades for
	 *   the displaced parent. The overlay still inserts normally; at flush time the
	 *   same-PK collision becomes an UPDATE on the underlying.
	 */
	private async checkMergedPKConflict(
		overlay: VirtualTable,
		newPK: SqlValue[],
		tombstoneIndex: number,
		onConflict?: ConflictResolution,
	): Promise<{ terminating?: UpdateResult; replacedUnderlyingRow?: Row }> {
		const overlayRow = await this.getOverlayRow(overlay, newPK);
		if (overlayRow) return {}; // overlay handles it (tombstone = no conflict; real = overlay enforces)

		const underlyingRow = await this.getUnderlyingRow(newPK);
		if (!underlyingRow) return {};

		// Statement OR > per-constraint default > ABORT.
		const effective = resolveEffective(onConflict, resolvePkDefaultConflict(this.tableSchema!));
		if (effective === ConflictResolution.IGNORE) return { terminating: { status: 'ok', row: undefined } };
		if (effective === ConflictResolution.REPLACE) return { replacedUnderlyingRow: underlyingRow };
		return {
			terminating: {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this.tableName} PK.`,
				existingRow: underlyingRow,
			}
		};
	}

	/**
	 * Finds a row conflicting with `newRow` on `uc.columns` across the MERGED view —
	 * this connection's overlay superimposed on the underlying committed rows —
	 * excluding `selfPks`. For partial UNIQUE, candidates outside the predicate's scope
	 * are skipped.
	 *
	 * The merged view splits cleanly into two disjoint halves, each searched the way it
	 * is cheap to search:
	 *
	 *     merged view  =  (overlay rows)  ∪  (underlying rows with no overlay entry)
	 *
	 * Phase 1 scans the small in-memory overlay; Phase 2 seeks/scans the large
	 * underlying, skipping any candidate whose PK the overlay already owns (Phase 1's
	 * territory, whatever the underlying still says). Together they cover the merged
	 * view exactly once with no row visited twice.
	 *
	 * Phase 1 runs first, so when the constraint was ALREADY violated an overlay-side
	 * conflict is reported in preference to an underlying one. Under a satisfied
	 * constraint at most one conflicting row can exist, so this tie-break only changes
	 * WHICH row is named in that pre-violated case.
	 */
	private async findMergedUniqueConflict(
		overlay: VirtualTable,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		// One comparison collation per constrained column — the index's per-column
		// COLLATE for an index-derived UNIQUE, else the declared column collation.
		// Resolved once, above both candidate scans; both phases compare identically.
		const collations = resolveUniqueEnforcementCollations(this.tableSchema!, uc, this.collationResolver);

		const overlayConflict = await this.findOverlayUniqueConflict(overlay, predicate, newRow, selfPks, tombstoneIndex, uc.columns, collations);
		if (overlayConflict) return overlayConflict;

		return this.findUnderlyingUniqueConflict(overlay, uc, predicate, newRow, selfPks, tombstoneIndex, collations);
	}

	/**
	 * Phase 1 — scan the overlay (this connection's uncommitted write set, small and
	 * in-memory) for a live row conflicting with `newRow`. Tombstones and `selfPks` are
	 * skipped; a matching live overlay row IS the merged row (stripped of the trailing
	 * tombstone column), and its overlay value — not any stale underlying value — is
	 * what the merged view holds for that PK
	 * (isolation-merged-unique-stale-underlying-false-positive).
	 */
	private async findOverlayUniqueConflict(
		overlay: VirtualTable,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
		constrainedCols: ReadonlyArray<number>,
		collations: CollationFunction[],
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		if (!overlay.query) return null;
		const pkIndices = this.getPrimaryKeyIndices();

		for await (const overlayRow of overlay.query(this.createFullScanFilterInfo())) {
			if (overlayRow[tombstoneIndex] === 1) continue; // deletion marker — not a live row
			const pk = pkIndices.map(i => overlayRow[i]);
			if (selfPks.some(self => this.keysEqual(pk, self))) continue;

			const mergedRow = overlayRow.slice(0, tombstoneIndex) as Row;
			if (this.rowMatchesUniqueConstraint(mergedRow, newRow, constrainedCols, collations, predicate)) {
				return { pk, row: mergedRow };
			}
		}
		return null;
	}

	/**
	 * Phase 2 — find an underlying committed row conflicting with `newRow`, skipping
	 * `selfPks` and any PK the overlay already owns (Phase 1's territory). The lookup is
	 * an index seek when {@link canSeekForConstraint} allows it, else the full scan —
	 * either way the per-column match runs, so a module that ignores the index hint and
	 * returns extra rows stays correct. `getOverlayRow` fires only for the candidates the
	 * seek actually returned, so it no longer costs one lookup per underlying row.
	 */
	private async findUnderlyingUniqueConflict(
		overlay: VirtualTable,
		uc: UniqueConstraintSchema,
		predicate: CompiledPredicate | undefined,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
		collations: CollationFunction[],
	): Promise<{ pk: SqlValue[]; row: Row } | null> {
		if (!this.underlyingTable.query) return null;
		const pkIndices = this.getPrimaryKeyIndices();

		const seekIndex = this.canSeekForConstraint(uc);
		const filterInfo = seekIndex
			? makeSecondaryIndexEqSeekFilter(seekIndex, newRow)
			: this.createFullScanFilterInfo();

		for await (const underlyingRow of this.underlyingTable.query(filterInfo)) {
			const pk = pkIndices.map(i => underlyingRow[i]);
			if (selfPks.some(self => this.keysEqual(pk, self))) continue;

			// A PK with any overlay entry (live OR tombstone) belongs to Phase 1, which
			// evaluated the overlay's value for it. Skip here whatever the underlying holds.
			const overlayRow = await this.getOverlayRow(overlay, pk);
			if (overlayRow) continue;

			if (this.rowMatchesUniqueConstraint(underlyingRow, newRow, uc.columns, collations, predicate)) {
				return { pk, row: underlyingRow };
			}
		}
		return null;
	}

	/**
	 * True-match test shared by both merged-check phases so they compare identically:
	 * `candidate` matches `newRow` on every constrained column under that column's
	 * enforcement collation (NULLs never match), and — for a partial UNIQUE — the
	 * predicate holds for `candidate`.
	 *
	 * The per-column collation (the index's per-column COLLATE for an index-derived
	 * UNIQUE, else the declared column collation) enforces a UNIQUE over a collated
	 * column against merged rows through the isolation path
	 * (unique-constraint-honors-column-collation / store-index-derived-unique).
	 */
	private rowMatchesUniqueConstraint(
		candidate: Row,
		newRow: Row,
		constrainedCols: ReadonlyArray<number>,
		collations: CollationFunction[],
		predicate: CompiledPredicate | undefined,
	): boolean {
		const matches = constrainedCols.every((idx, i) => {
			if (newRow[idx] === null || candidate[idx] === null) return false;
			return compareSqlValuesFast(newRow[idx], candidate[idx], collations[i]) === 0;
		});
		if (!matches) return false;
		// Partial UNIQUE: candidate must also be in the predicate's scope to conflict.
		if (predicate && predicate.evaluate(candidate) !== true) return false;
		return true;
	}

	/**
	 * The secondary index Phase 2 may seek for `uc`, or null to fall back to a full scan.
	 *
	 * Seek only when the constraint was synthesized from a `CREATE UNIQUE INDEX`
	 * (`derivedFromIndex` names a live entry in `tableSchema.indexes`) AND every key
	 * column's effective enforcement collation is BINARY.
	 *
	 * NOTE: the BINARY gate is load-bearing, not an optimisation choice. The store's
	 * physical index key bytes come from a separate encoder registry that does NOT
	 * consult the database's collation registry
	 * (backlog/debt-store-index-keys-use-column-collation, see the comment at
	 * getPkKeyShape above). Seeking a NOCASE index for 'B@X' would miss the committed
	 * 'b@x' that the full scan catches, turning this perf fix into a LOST UNIQUE
	 * violation. Widen this gate (to per-column enforcement collations generally) only
	 * once that encoder defect is fixed.
	 */
	private canSeekForConstraint(uc: UniqueConstraintSchema): IndexSchema | null {
		if (!uc.derivedFromIndex) return null;
		const index = this.tableSchema?.indexes?.find(i => i.name === uc.derivedFromIndex);
		if (!index) return null; // DROP INDEX may have retired it before a stale UC object is retired
		// Enforcement collation per constrained column, positionally aligned with the
		// index key columns (appendIndexToTableSchema guarantees the alignment).
		const enforcement = uniqueEnforcementCollations(this.tableSchema!, uc);
		const allBinary = enforcement.every(c => normalizeCollationName(c ?? 'BINARY') === 'BINARY');
		return allBinary ? index : null;
	}

	/**
	 * Checks all non-PK UNIQUE constraints against the merged view.
	 * Returns null when all pass or REPLACE evictions succeed.
	 *
	 * A REPLACE eviction tombstones the conflicting live merged row in the overlay
	 * (so the underlying row is deleted at flush) and pushes that row onto `evicted`
	 * — surfaced to the DML executor via `evictedRows` so it runs the full delete
	 * pipeline (change-tracking, FK cascade, auto-events, and the row-time
	 * covering-MV backing maintenance the isolation layer otherwise never drives).
	 */
	private async checkMergedUniqueConstraints(
		overlay: VirtualTable,
		newRow: Row,
		selfPks: SqlValue[][],
		tombstoneIndex: number,
		onConflict: ConflictResolution | undefined,
		evicted: Row[],
	): Promise<UpdateResult | null> {
		const schema = this.tableSchema;
		const uniqueConstraints = schema?.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return null;

		for (const uc of uniqueConstraints) {
			if (uc.columns.some(idx => newRow[idx] === null)) continue;

			// Partial UNIQUE: a row whose predicate is not unambiguously TRUE is
			// outside the index's scope and contributes nothing to uniqueness.
			const predicate = this.compileFor(uc);
			if (predicate && predicate.evaluate(newRow) !== true) continue;

			const conflict = await this.findMergedUniqueConflict(overlay, uc, predicate, newRow, selfPks, tombstoneIndex);
			if (!conflict) continue;

			// Statement OR > per-UC defaultConflict > ABORT.
			const effective = resolveEffective(onConflict, uc.defaultConflict);
			if (effective === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
			if (effective === ConflictResolution.REPLACE) {
				await this.insertTombstoneForPK(overlay, conflict.pk, tombstoneIndex);
				// Report the eviction. `conflict.row` is the merged row in user-facing
				// schema shape whether it was found overlay-side (Phase 1) or
				// underlying-side (Phase 2). The executor maintains the covering backing.
				evicted.push(conflict.row);
				continue;
			}
			const colNames = uc.columns.map(i => schema!.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${schema!.name} (${colNames})`,
				existingRow: conflict.row,
			};
		}
		return null;
	}

	// ==================== Transaction Lifecycle ====================

	async begin(): Promise<void> {
		await this.underlyingTable.begin?.();
		await this.overlayTable?.begin?.();
	}

	async sync(): Promise<void> {
		await this.underlyingTable.sync?.();
		await this.overlayTable?.sync?.();
	}

	async commit(): Promise<void> {
		// Route through the module coordinator (see onConnectionCommit) so even the
		// table-level commit path performs the atomic apply-all-then-commit-all flush
		// across the whole db-transaction's overlays, rather than committing this
		// table's underlying in isolation (which tears a multi-table commit).
		await this.isolationModule.commitConnectionOverlays(this.db);
	}

	async rollback(): Promise<void> {
		await this.underlyingTable.rollback?.();
		await this.clearOverlay();
	}

	/**
	 * Discards the connection-scoped overlay entirely. The module frees the overlay's
	 * staging table (see IsolationModule.clearConnectionOverlay → releaseOverlayTable) rather
	 * than merely dropping the reference — the overlay module's registry pins the manager, so
	 * a bare reference-drop leaked it for the life of the Database. A fresh overlay is created
	 * lazily via ensureOverlay() on the next write.
	 */
	private async clearOverlay(): Promise<void> {
		await this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	// ==================== Savepoints ====================
	// Overlay savepoints are managed by IsolatedConnection (which forwards
	// to the overlay's own registered connection). The table-level methods
	// only forward to the underlying table to avoid double-savepointing.

	async savepoint(index: number): Promise<void> {
		await this.underlyingTable.savepoint?.(index);
	}

	async release(index: number): Promise<void> {
		await this.underlyingTable.release?.(index);
	}

	async rollbackTo(index: number): Promise<void> {
		await this.underlyingTable.rollbackTo?.(index);
	}

	// ==================== Schema Operations ====================

	async disconnect(): Promise<void> {
		// Don't disconnect overlay or underlying - they're connection-scoped/shared
	}

	async rename(newName: string): Promise<void> {
		await this.underlyingTable.rename?.(newName);
	}

	async alterSchema(changeInfo: SchemaChangeInfo): Promise<void> {
		// DDL bypasses overlay, goes directly to underlying
		await this.underlyingTable.alterSchema?.(changeInfo);
		// Update our schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		// Clear any existing overlay - it will be recreated with new schema on next write
		await this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Index DDL delegates to the module rather than driving the underlying and the overlay
	 * directly. The module owns the full protocol — validating against the issuing
	 * connection's effective rows, then REBUILDING every affected overlay under the new
	 * schema — and a bare `underlying.createIndex()` + `overlay.createIndex()` pair silently
	 * skips both halves. The engine only ever reaches the module-level hook, so these
	 * instance methods exist for a module that wraps `IsolationModule` in turn; routing them
	 * through the module keeps that path on the same protocol.
	 */
	async createIndex(indexInfo: IndexSchema, rows?: EffectiveRowSource): Promise<void> {
		await this.isolationModule.createIndex(this.db, this.schemaName, this.tableName, indexInfo, rows);
		this.tableSchema = this.underlyingTable.tableSchema;
	}

	async dropIndex(indexName: string): Promise<void> {
		await this.isolationModule.dropIndex(this.db, this.schemaName, this.tableName, indexName);
		this.tableSchema = this.underlyingTable.tableSchema;
	}

	// ==================== Internal Helpers ====================

	/**
	 * Gets the underlying table for direct access (testing/debugging).
	 * @internal
	 */
	getUnderlyingTable(): VirtualTable {
		return this.underlyingTable;
	}

	/**
	 * Gets the overlay table for direct access (testing/debugging).
	 * Returns undefined if overlay hasn't been created yet.
	 * @internal
	 */
	getOverlayTable(): VirtualTable | undefined {
		return this.overlayTable;
	}

	/**
	 * Returns whether there are pending uncommitted changes.
	 */
	hasPendingChanges(): boolean {
		return this.hasChanges;
	}

	/**
	 * Gets the tombstone column name.
	 * @internal
	 */
	getTombstoneColumn(): string {
		return this.tombstoneColumn;
	}

	// ==================== IsolatedTableCallback Implementation ====================

	/**
	 * Called by IsolatedConnection when the database commits.
	 * Flushes overlay to underlying and clears overlay.
	 */
	async onConnectionCommit(): Promise<void> {
		// Delegate to the module coordinator, which flushes EVERY overlay this
		// db-transaction staged (not just this table's) in one apply-all-then-commit-all
		// pass and clears them — so a multi-table commit is atomic. The first connection
		// in the database's commit loop performs the whole flush; later connections find
		// their overlay already cleared and this is a no-op. Poison is enforced inside
		// the coordinator (it aborts before any table commits).
		await this.isolationModule.commitConnectionOverlays(this.db);
		// Clear this table's pre-overlay savepoint set. Kept per-connection (rather than
		// inside the coordinator) so a table that took a savepoint before its first write
		// but never got an overlay still has its set cleared here.
		this.isolationModule.clearPreOverlaySavepoints(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Called by IsolatedConnection when the database rolls back.
	 * Clears overlay without flushing.
	 */
	async onConnectionRollback(): Promise<void> {
		await this.clearOverlay();
		this.isolationModule.clearPreOverlaySavepoints(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Called by IsolatedConnection when a savepoint is created.
	 *
	 * When the overlay exists, its own registered MemoryVirtualTableConnection
	 * receives createSavepoint from the database's connection iteration.
	 * Calling overlayTable.savepoint() here too would double-push onto the
	 * same savepointStack, corrupting the depth-to-index mapping.
	 *
	 * When the overlay does NOT exist (savepoint before first write), we
	 * record the depth so that a later rollbackToSavepoint can clear the
	 * overlay if one was created after the savepoint.
	 */
	async onConnectionSavepoint(index: number): Promise<void> {
		if (!this.overlayTable) {
			this.savepointsBeforeOverlay.add(index);
		}
		// If overlay exists, its registered connection handles it
	}

	/**
	 * Called by IsolatedConnection when a savepoint is released.
	 */
	async onConnectionReleaseSavepoint(index: number): Promise<void> {
		this.savepointsBeforeOverlay.delete(index);
		// If overlay exists, its registered connection handles it
	}

	/**
	 * Called by IsolatedConnection when rolling back to a savepoint.
	 *
	 * If the target savepoint was created before the overlay existed,
	 * the overlay's registered connection has no snapshot to restore —
	 * so we clear the overlay entirely, restoring "no uncommitted changes".
	 */
	async onConnectionRollbackToSavepoint(index: number): Promise<void> {
		if (this.savepointsBeforeOverlay.has(index)) {
			// Rolling back to before the overlay existed — discard all overlay changes
			await this.clearOverlay();
			// Remove savepoints above the target (they're implicitly gone)
			for (const depth of [...this.savepointsBeforeOverlay]) {
				if (depth > index) {
					this.savepointsBeforeOverlay.delete(depth);
				}
			}
		}
		// If overlay's registered connection has this savepoint, it handles rollback
	}
}

/** True when a comparator result `cmp` (row value vs bound value) satisfies the range op. */
function satisfiesBound(cmp: number, op: IndexConstraintOp): boolean {
	switch (op) {
		case IndexConstraintOp.GT: return cmp > 0;
		case IndexConstraintOp.GE: return cmp >= 0;
		case IndexConstraintOp.LT: return cmp < 0;
		case IndexConstraintOp.LE: return cmp <= 0;
		default: return true;
	}
}

/**
 * Resolves the per-constraint default conflict action for PK conflicts.
 * Prefers the table-level `PRIMARY KEY (...) ON CONFLICT <action>` clause
 * (the constraint's own declaration) over any column-level `defaultConflict`
 * declared on a PK column (which primarily targets that column's own
 * constraints and only acts as a fallback for PK conflicts).
 *
 * Mirrors the helper of the same name in `quereus/.../layer/manager.ts` — the
 * three-tier rule `statement OR > per-constraint default > ABORT` must agree
 * between the overlay's pre-check and the wrapped vtab's resolver.
 */
function resolvePkDefaultConflict(schema: TableSchema): ConflictResolution | undefined {
	if (schema.primaryKeyDefaultConflict !== undefined) return schema.primaryKeyDefaultConflict;
	for (const def of schema.primaryKeyDefinition) {
		const col = schema.columns[def.index];
		if (col?.defaultConflict !== undefined) return col.defaultConflict;
	}
	return undefined;
}

/**
 * Three-tier conflict-action resolution: statement-level OR > per-constraint
 * default > ABORT.
 */
function resolveEffective(
	stmt: ConflictResolution | undefined,
	perConstraint: ConflictResolution | undefined,
): ConflictResolution {
	return stmt ?? perConstraint ?? ConflictResolution.ABORT;
}
