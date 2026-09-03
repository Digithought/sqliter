import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { type TableSchema, type IndexSchema, IndexColumnSchema } from '../../schema/table.js';
import { generateTableDDL, generateDropTableDDL } from '../../schema/ddl-generator.js';
import { MemoryTable } from './table.js';
import type { VirtualTableModule, SchemaChangeInfo, EffectiveRowSource } from '../module.js';
import { MemoryTableManager } from './layer/manager.js';
import type { BackingHost, BackingScanRequest, MaintenanceOp, BackingRowChange } from '../backing-host.js';
import type { VirtualTableConnection } from '../connection.js';
import { MemoryVirtualTableConnection } from './connection.js';
import type { MemoryTableConnection } from './layer/connection.js';
import type { MemoryTableConfig } from './types.js';
import { createMemoryTableLoggers } from './utils/logging.js';
import { AccessPlanBuilder, equalitySeekKeyCount, isMultiValueEquality, nullSafeOrderingPrefixLength, validateAccessPlan } from '../best-access-plan.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, OrderingSpec, PredicateConstraint } from '../best-access-plan.js';
import type { VTableEventEmitter } from '../events.js';
import { alterEventShape } from '../alter-event-shape.js';
import type { ModuleCapabilities } from '../capabilities.js';
import type { MappingAdvertisement } from '../mapping-advertisement.js';
import type { Schema } from '../../schema/schema.js';
import { buildAdvertisementsFromTags } from '../../schema/mapping-advertisement-tags.js';
import { PRIMARY_INDEX_NAME } from '../index-descriptor.js';
import { combineConjunctive } from '../../planner/stats/selectivity-combine.js';
import type { ColumnStatistics, TableStatistics } from '../../planner/stats/catalog-stats.js';

const logger = createMemoryTableLoggers('module');

const EMPTY_COLUMN_SET: ReadonlySet<number> = new Set<number>();

/**
 * Cost per pairwise comparison used to estimate an external sort. Tuned to be
 * commensurate with the access-plan cost units emitted by `AccessPlanBuilder`
 * (e.g. fullscan = rows * 1.0, range scan ≈ rows * 0.5 + 0.3). For 1000 rows
 * a sort costs ≈ 1000 * log2(1000) * 0.1 ≈ 1000 — i.e. comparable to a full
 * scan, which matches the rough heuristic that sorting N rows is on the same
 * order as scanning them once when N is moderate.
 */
const SORT_COST_PER_COMPARISON = 0.1;

/**
 * Per-row cost charged for each unhandled filter when an ordering-only access
 * pattern leaves filters as residual predicates. Mirrors the global
 * FILTER_PER_ROW constant used elsewhere in the cost model.
 */
const RESIDUAL_FILTER_COST_PER_ROW = 0.2;

/**
 * Fraction of the table a single equality seek key is assumed to match when no
 * per-column statistics can answer it.
 *
 * Deliberately the store module's `ARM_SELECTIVITY.eq`
 * (`packages/quereus-store/src/common/store-module-access-plan.ts`) so the two backends
 * price an un-analyzed equality identically. On the un-analyzed 1000-row default it also
 * reproduces the flat 100 rows the physical seek node used to report unconditionally,
 * which is why adopting a real estimate moves almost no plan on an un-analyzed schema.
 */
const EQ_SELECTIVITY_WITHOUT_STATS = 0.1;

/** True when each seek key on this index matches at most one row. */
function isUniqueIndex(index: IndexSchema): boolean {
	// `gatherAvailableIndexes` builds the primary-key pseudo-index without `unique: true`,
	// so the PK is recognised by name rather than by the flag.
	return index.name === PRIMARY_INDEX_NAME || (index.unique ?? false);
}

/**
 * The `ANALYZE`-collected statistics for the table column at `colIdx`, or undefined when
 * the table has none or the column is not covered.
 *
 * `columnStats` is keyed by LOWERCASE COLUMN NAME while this file works in column index,
 * so the lookup goes index → current column name → stats. That direction is what keeps a
 * post-`ANALYZE` `ALTER TABLE` safe: a RENAMED column's current name is absent from the
 * map, and a DROPPED column shifts later indexes onto their own current names — a miss or
 * the right entry, never a neighbour's numbers. Mirrors the store module's `columnStatsFor`.
 */
function columnStatsFor(
	tableInfo: TableSchema,
	stats: TableStatistics,
	colIdx: number,
): ColumnStatistics | undefined {
	const name = tableInfo.columns[colIdx]?.name;
	return name === undefined ? undefined : stats.columnStats.get(name.toLowerCase());
}

/**
 * The fraction of the table ONE equality tuple over `eqCols` is expected to match.
 *
 * Every formula here is the engine's `CatalogStatsProvider.estimateLeaf`: equality is
 * `1 / max(distinctCount, 1)` and the factors combine through the engine's own
 * `combineConjunctive` (damped independence), never a restated product. A seek's
 * advertised row count and the estimate a residual `Filter` above it would carry describe
 * the same row set — two different numbers have the optimizer comparing two different
 * worlds. The store module follows the same rule, so the two backends agree.
 */
function equalityTupleSelectivity(tableInfo: TableSchema, eqCols: readonly number[]): number {
	const stats = tableInfo.statistics;
	// A snapshot taken while the table was EMPTY describes nothing — every `distinctCount`
	// is 0 — and applying it would read `1 / max(0, 1)` as "this equality matches EVERY
	// row". Treated as no statistics at all, as the store module and the engine's own
	// `estimatePredicateSelectivity` both do.
	if (!stats || stats.rowCount <= 0) return EQ_SELECTIVITY_WITHOUT_STATS;

	const factors: number[] = [];
	for (const colIdx of eqCols) {
		const colStats = columnStatsFor(tableInfo, stats, colIdx);
		// One uncovered equality column falls back WHOLESALE rather than mixing a measured
		// factor with the shape constant — again the store module's rule.
		if (!colStats) return EQ_SELECTIVITY_WITHOUT_STATS;
		factors.push(1 / Math.max(colStats.distinctCount, 1));
	}
	return factors.length > 0 ? combineConjunctive(factors) : EQ_SELECTIVITY_WITHOUT_STATS;
}

/**
 * Rows an equality seek is expected to MATCH — which is not the number of seek keys it
 * issues. `inCardinality` counts KEYS (1 for `k = 5`, 3 for `k in (1, 2, 3)`); on a
 * NON-unique index each key matches however many rows share it, so a column with 4
 * distinct values over 2000 rows returns 500 rows for one key.
 *
 * NOTE: this module has no seek-versus-scan veto (the store's `computeBestAccessPlan` has
 * one), so an equality seek matching a large fraction of the table still prices below a
 * full scan — `0.5 + rows * 0.3` against `rows * 1.0`. Harmless while the estimate is the
 * {@link EQ_SELECTIVITY_WITHOUT_STATS} shape constant, and the row count advertised is now
 * honest either way. If a fat seek over an ANALYZEd table ever shows up as a slow plan,
 * the veto is the fix, not a smaller constant.
 *
 * NOTE: `inCardinality` counts the seek keys the module was OFFERED, not the ones the
 * engine will issue — `rule-select-access-path` drops NULL-bearing tuples and collapses
 * duplicates afterwards, so `k in (1, 1, 1)` is priced and estimated as three keys and
 * seeks one. Over-estimating is the safe direction and the cost model has always had the
 * same asymmetry; if a duplicate-heavy or NULL-heavy `IN` ever needs the exact count, the
 * reduction belongs in the module rather than a second copy of it here.
 *
 * NOTE: without per-column statistics the shape constant saturates this estimate at ten
 * seek keys (`10 × 0.1N` is the whole table), which is what makes the ordering comparison
 * in {@link MemoryTableModule.adjustPlanForOrdering} prefer a plain ordered index walk
 * over seek-then-sort from roughly nine keys up. Correct rows either way, and `ANALYZE`
 * resolves it; if a multi-seek with an `ORDER BY` on the seek column shows up as a slow
 * plan on an un-analyzed table, that crossover is where to look.
 */
function estimateEqualityRows(
	tableInfo: TableSchema,
	index: IndexSchema,
	eqCols: readonly number[],
	inCardinality: number,
	estimatedTableSize: number,
): number {
	const perKey = isUniqueIndex(index)
		? 1
		: Math.max(1, Math.floor(estimatedTableSize * equalityTupleSelectivity(tableInfo, eqCols)));
	// A seek cannot return more rows than the table holds.
	//
	// NOTE: the `Math.max(1, …)` floor is now conservative rather than load-bearing. It
	// once guarded the `rows: 0` fold in `rule-select-access-path.selectPhysicalNode`,
	// which folded any fully-handled zero-row access to an `EmptyResultNode`; that fold
	// reads `provablyEmpty` now, so a zero estimate is only an estimate. Kept because
	// dropping it changes what the cost model sees (a 0-row seek prices below every rival
	// and wins plans it should not); revisit if a genuine zero estimate ever needs to
	// reach the cost model.
	return Math.max(1, Math.min(estimatedTableSize, inCardinality * perKey));
}

/**
 * Estimate the cost of an external O(n log n) sort over `rows` rows. Returns
 * 0 for ≤1 rows where no sort is required.
 */
function estimateSortCost(rows: number): number {
	if (rows <= 1) return 0;
	return rows * Math.log2(rows) * SORT_COST_PER_COMPARISON;
}

/**
 * Collect column indexes bound by an equality predicate (`=` or single-value `IN`).
 * These columns are constants for the access plan and don't contribute ordering.
 *
 * A runtime-valued `IN` set never qualifies: `isMultiValueEquality` reports it as
 * multi-valued because its member count is unknown at plan time.
 */
function collectEqualityBoundColumns(filters: readonly PredicateConstraint[]): ReadonlySet<number> {
	const cols = new Set<number>();
	for (const f of filters) {
		if (!f.usable) continue;
		if (equalitySeekKeyCount(f) !== null && !isMultiValueEquality(f)) {
			cols.add(f.columnIndex);
		}
	}
	return cols.size === 0 ? EMPTY_COLUMN_SET : cols;
}

/**
 * The memory module's {@link BackingHost} — the reference implementation of the
 * backing-host capability (see `vtab/backing-host.ts` for the contract). A thin
 * adapter over one {@link MemoryTableManager}, captured **by reference**: a
 * drop+recreate of the same table name builds a fresh manager, so a host (and
 * its `ownsConnection`) is pinned to one backing-table incarnation and never
 * adopts a stale same-name connection from a previous one.
 */
class MemoryBackingHost implements BackingHost {
	constructor(private readonly manager: MemoryTableManager) {}

	ownsConnection(conn: VirtualTableConnection): boolean {
		return conn instanceof MemoryVirtualTableConnection
			&& conn.getMemoryConnection().tableManager === this.manager;
	}

	connect(): VirtualTableConnection {
		const qualifiedName = `${this.manager.schemaName}.${this.manager.tableName}`;
		return new MemoryVirtualTableConnection(qualifiedName, this.manager.connect());
	}

	applyMaintenance(conn: VirtualTableConnection, ops: readonly MaintenanceOp[]): Promise<BackingRowChange[]> {
		return this.manager.applyMaintenanceToLayer(this.unwrap(conn), ops);
	}

	replaceContents(rows: readonly Row[], onDuplicateKey?: () => QuereusError): Promise<void> {
		return this.manager.replaceBaseLayer(rows, onDuplicateKey);
	}

	scanEffective(conn: VirtualTableConnection, req: BackingScanRequest): AsyncIterable<Row> {
		const memConn = this.unwrap(conn);
		// Pending transaction state layered over committed (reads-own-writes),
		// in PK order — the same start-layer choice a `select` from the MV makes.
		return this.manager.scanLayer(memConn.pendingTransactionLayer ?? memConn.readLayer, {
			indexName: 'primary',
			descending: req.descending ?? false,
			equalityPrefix: req.equalityPrefix,
		});
	}

	private unwrap(conn: VirtualTableConnection): MemoryTableConnection {
		if (!this.ownsConnection(conn)) {
			throw new QuereusError(
				`connection '${conn.connectionId}' does not belong to backing table `
					+ `'${this.manager.schemaName}.${this.manager.tableName}' (or to this incarnation of it)`,
				StatusCode.INTERNAL,
			);
		}
		return (conn as MemoryVirtualTableConnection).getMemoryConnection();
	}
}

/**
 * A module that provides in-memory table functionality using BTree (inheritree).
 * Tables created with this module persist only for the lifetime of the
 * database connection.
 */
export class MemoryTableModule implements VirtualTableModule<MemoryTable, MemoryTableConfig> {
	/**
	 * Memory tables snapshot the connection's read layer once at `query()` entry
	 * (`startLayer = pendingTransactionLayer ?? readLayer`) and iterate the
	 * captured layer's BTree. Concurrent `query()` calls on a single connection
	 * therefore see consistent, non-mutating snapshots so long as no writer is
	 * in flight — safe for `'reentrant-reads'`.
	 *
	 * Writes are NOT safe to interleave with reads on the same connection:
	 * `ensureTransactionLayer` only allocates a fresh `TransactionLayer` when
	 * `pendingTransactionLayer` is null. Once a transaction is open, subsequent
	 * writes call `recordUpsert` on the SAME `primaryModifications` BTree that
	 * an in-flight `query()` may be iterating, which would tear the iterator's
	 * tree-walk path. `'fully-reentrant'` would require either fresh-per-write
	 * layers or an in-place-mutation-safe iterator; neither is implemented yet.
	 *
	 * If a future change either (a) makes writes always allocate a fresh layer
	 * (autocommit-only path) or (b) audits that mid-iteration BTree mutation
	 * is iterator-safe, this can be upgraded to `'fully-reentrant'`. Likewise,
	 * an in-place layer collapser would force this back to `'serial'`.
	 */
	readonly concurrencyMode = 'reentrant-reads' as const;

	/**
	 * Memory tables snapshot the connection's read layer once at `query()` entry
	 * and iterate the captured layer's immutable BTree (see `concurrencyMode`
	 * above and `layer/connection.ts`). A `DELETE`/`UPDATE` that mutates the table
	 * mid-scan writes a fresh child layer, leaving the in-flight scan's captured
	 * layer untouched — so the scan cursor never observes its own statement's
	 * writes. That is exactly per-scan snapshot isolation, so the DML executor may
	 * STREAM predicate DELETE/UPDATE against memory tables (no eager buffering).
	 */
	readonly scanSnapshotIsolation = true as const;

	/**
	 * A `_readCommitted` connection on a memory table serves a stable, coherent
	 * committed snapshot for the life of the scan, so it may be read outside the
	 * execution mutex while another connection commits. Audited against four
	 * points — re-verify all four before touching any of them:
	 *
	 * 1. **Commit publishes atomically.** Layers are immutable BTrees and a commit
	 *    hands over by a single assignment to `_currentCommittedLayer`
	 *    (`layer/manager.ts` — `commitTransaction`, `replaceAllRows`, `destroy`,
	 *    `consolidateToBaseLayer`). A reader sees either the pre- or the
	 *    post-commit root, never a mix.
	 * 2. **The read connection is pinned and unregistered.** `_readCommitted`
	 *    creates a fresh manager connection that is never handed to
	 *    `Database.registerConnection` (`table.ts` — `ensureConnection`), so it
	 *    never receives begin/commit/rollback/savepoint broadcasts and never joins
	 *    the writer's transaction. `ensureConnection` is lazy, so its `readLayer`
	 *    pins at the scan's first pull, not at `connect()` — within the obligation,
	 *    which bounds the snapshot at "some commit boundary at or before the read
	 *    began". Every later `query()` on the same instance reuses that connection,
	 *    so two scans of one reader agree.
	 * 3. **`query()` starts from the pinned layer.** `table.ts` reads
	 *    `conn.readLayer` (not `pendingTransactionLayer`) in committed mode, and
	 *    `scanLayerSync` captures the layer's BTree object once at scan start — a
	 *    later whole-tree swap (DDL rebuild, consolidation) leaves the in-flight
	 *    walk on its own tree: stale but coherent, which is the documented
	 *    semantics.
	 * 4. **Collapse cannot strand the pinned layer.** The connection IS in the
	 *    manager's `connections` map, so `isLayerInUse` walks its `readLayer`
	 *    chain and `promoteCommittedHead` refuses to `clearBase()` any layer that
	 *    chain reaches; `MemoryTable.disconnect` releases it after the scan.
	 *
	 * Point 3 is the fragile one, and it rests on a property every DDL path in
	 * `layer/base.ts` currently has: each rebuild REPLACES the tree object
	 * (`rebuildPrimaryTreeFromRows`, `rebuildPrimaryTreeStrict`,
	 * `rebuildAllSecondaryIndexes` — and `MemoryIndex.clear()` itself swaps in a
	 * fresh BTree rather than emptying the live one). A rebuild that ever mutated a
	 * published tree in place would empty the very structure a concurrent
	 * index-driven committed read is walking, and the obligation requires an
	 * index-driven plan and a full scan of one snapshot to agree.
	 */
	readonly readCommittedSnapshot = true as const;

	public readonly tables: Map<string, MemoryTableManager> = new Map();
	private eventEmitter?: VTableEventEmitter;

	constructor(eventEmitter?: VTableEventEmitter) {
		this.eventEmitter = eventEmitter;
	}

	/**
	 * Get the event emitter for this module, if one was provided.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Returns capability flags for this module.
	 * Memory module has built-in isolation and savepoint support.
	 */
	getCapabilities(): ModuleCapabilities {
		return {
			isolation: true,
			savepoints: true,
			persistent: false,
			secondaryIndexes: true,
			rangeScans: true,
			// Schema changes here escape the transaction (they survive rollback), but
			// buffered DML still rolls back normally — the SchemaManager catalog is not
			// transaction-scoped. See docs/memory-table.md § "DDL and transactions".
			ddlTransactionality: 'non-transactional',
		};
	}

	/**
	 * Generic-module mapping advertisements: assembled from the `quereus.lens.decomp.*`
	 * reserved tags on this basis schema's tables. Returns `[]` for a schema with no
	 * such tags (the common case), leaving the lens default mapper on its name-match
	 * path. See `docs/lens.md` § The Default Mapper.
	 */
	getMappingAdvertisements(_db: Database, basisSchema: Schema): readonly MappingAdvertisement[] {
		return buildAdvertisementsFromTags(basisSchema);
	}

	/**
	 * Backing-host capability (see `vtab/backing-host.ts`): resolve the
	 * privileged surface for a table this module owns, or undefined when the
	 * table is unknown to it. The returned host captures the table's CURRENT
	 * {@link MemoryTableManager} by reference, pinning it to this incarnation.
	 */
	getBackingHost(_db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const manager = this.tables.get(`${schemaName}.${tableName}`.toLowerCase());
		return manager ? new MemoryBackingHost(manager) : undefined;
	}

	/**
	 * Creates a new memory table definition
	 */
	async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		// Ensure table doesn't already exist
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
		if (this.tables.has(tableKey)) {
			throw new QuereusError(`Memory table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'.`, StatusCode.ERROR);
		}

		// Create the MemoryTableManager instance with optional event emitter
		const manager = new MemoryTableManager(
			db,
			tableSchema.vtabModuleName,
			tableSchema.schemaName,
			tableSchema.name,
			tableSchema,
			tableSchema.isReadOnly ?? false,
			this.eventEmitter
		);

		// Register the manager
		this.tables.set(tableKey, manager);
		logger.operation('Create Table', tableSchema.name, {
			schema: tableSchema.schemaName,
			readOnly: tableSchema.isReadOnly ?? false
		});

		// Create the MemoryTable instance
		const table = new MemoryTable(db, this, manager);

		// Emit schema change event after table is fully created. The `ddl` is the
		// statement a sync peer re-executes to replicate the create; without it the
		// migration crosses the wire as an empty statement and does nothing. Rendered
		// lazily — optional chaining short-circuits the whole call (arguments
		// included) when no emitter is wired.
		this.eventEmitter?.emitSchemaChange?.({
			type: 'create',
			objectType: 'table',
			schemaName: tableSchema.schemaName,
			objectName: tableSchema.name,
			ddl: generateTableDDL(tableSchema),
		});

		return table;
	}

	/**
	 * Connects to an existing memory table definition
	 */
	async connect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: MemoryTableConfig, _tableSchema?: TableSchema): Promise<MemoryTable> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const existingManager = this.tables.get(tableKey);

		if (!existingManager) {
			throw new QuereusError(`Memory table definition for '${tableName}' not found. Cannot connect.`, StatusCode.INTERNAL);
		}

		logger.operation('Connect Table', tableName, { schema: schemaName });

		// Create a new MemoryTable instance connected to the existing manager
		return new MemoryTable(db, this, existingManager, options._readCommitted);
	}

	/**
	 * Modern, type-safe access planning interface
	 */
	getBestAccessPlan(
		db: Database,
		tableInfo: TableSchema,
		request: BestAccessPlanRequest
	): BestAccessPlanResult {
		logger.debugLog(`[getBestAccessPlan] Planning access for ${tableInfo.name} with ${request.filters.length} filters`);

		// Get table size estimate for cost calculations. An un-analyzed table
		// arrives as `undefined` ("nobody knows"); fall back to a reasonable
		// default to avoid degenerate costs. (`||` also catches an analyzed empty
		// table — a plan over 0 rows is cheap under any default, so that is fine.)
		//
		// NOTE: this default is now the SOLE fallback for an un-analyzed table. Every
		// planner site that builds a `BestAccessPlanRequest` sends `undefined` rather
		// than substituting 1000 of its own, precisely so a module that can size itself
		// gets the chance. This module keeps no live row count, so it cannot — the
		// constant stays. If the in-memory table ever exposes its own size, read it here
		// instead of the constant.
		const estimatedTableSize = request.estimatedRows || 1000;

		// Find the best access strategy
		const bestPlan = this.findBestAccessPlan(tableInfo, request, estimatedTableSize);

		// Validate the plan before returning
		validateAccessPlan(request, bestPlan, tableInfo.vtabModuleName);

		logger.debugLog(`[getBestAccessPlan] Selected plan: ${bestPlan.explains} (cost: ${bestPlan.cost}, rows: ${bestPlan.rows})`);

		// The in-memory scan layer threads each index column's declared collation into
		// the range-bound filter and early-termination (scan-plan → plan-filter /
		// scan-layer), so a non-BINARY range/prefix seek visits the collation-correct
		// window. Advertise this so the access-path collation-cover analysis permits a
		// collation-matched non-BINARY range seek instead of declining to a scan.
		return { ...bestPlan, honorsCollatedRangeBounds: true };
	}

	/**
	 * Find the best access plan for the given request
	 */
	private findBestAccessPlan(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		estimatedTableSize: number
	): BestAccessPlanResult {
		// Pre-pass: IS NULL on NOT NULL column → impossible predicate, empty result
		for (const filter of request.filters) {
			if (filter.op === 'IS NULL') {
				const col = tableInfo.columns[filter.columnIndex];
				if (col?.notNull) {
					// A PROOF, not an estimate: no value satisfies `IS NULL` on a NOT NULL
					// column, whatever the table holds now or after this statement writes to
					// it. `empty()` sets cost/rows/`provablyEmpty` together.
					return AccessPlanBuilder
						.empty(new Array(request.filters.length).fill(true))
						.setExplanation('Empty result (IS NULL on NOT NULL column)')
						.build();
				}
			}
		}

		const availableIndexes = this.gatherAvailableIndexes(tableInfo);
		let bestPlan: BestAccessPlanResult | undefined;

		// Try to find an index-based plan
		for (const index of availableIndexes) {
			const indexPlan = this.evaluateIndexAccess(tableInfo, index, request, estimatedTableSize);
			if (!bestPlan || indexPlan.cost < bestPlan.cost) {
				bestPlan = indexPlan;
			}
		}

		// Fallback to full scan if no index plan found
		if (!bestPlan) {
			bestPlan = AccessPlanBuilder
				.fullScan(estimatedTableSize)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.build();
		}

		// Check if we can satisfy ordering requirements
		if (request.requiredOrdering && request.requiredOrdering.length > 0) {
			bestPlan = this.adjustPlanForOrdering(tableInfo, bestPlan, request, availableIndexes, estimatedTableSize);
		}

		// B-tree scans inherently produce rows in PK order.  Advertise this
		// when there is no explicit ORDER BY so the join rule can pick merge join.
		// When requiredOrdering is present, adjustPlanForOrdering already handled it;
		// adding PK ordering here would incorrectly claim we satisfy a different ORDER BY.
		if (!bestPlan.providesOrdering
			&& !(request.requiredOrdering && request.requiredOrdering.length > 0)
			&& tableInfo.primaryKeyDefinition && tableInfo.primaryKeyDefinition.length > 0
		) {
			const usesSecondaryIndex = bestPlan.indexName && bestPlan.indexName !== PRIMARY_INDEX_NAME;
			if (!usesSecondaryIndex) {
				// This bare advertisement is a claim like any other: a consumer that trusts it
				// (merge join) reads it under the engine's NULLs-FIRST-for-both-directions
				// rule, while the DESC walk emits NULLs LAST. Truncate at the first member a
				// NULL could reach — the store's `buildPkOrderingAdvertisement` gates its twin
				// the same way. Pins are left empty: an equality on a PK member is already
				// visible to the helper as a NULL-excluding entry in `request.filters`.
				const pk = tableInfo.primaryKeyDefinition;
				const claimablePrefix = nullSafeOrderingPrefixLength(
					tableInfo, request, pk, pk.length, EMPTY_COLUMN_SET);
				const pkOrdering: OrderingSpec[] = pk.slice(0, claimablePrefix).map(col => ({
					columnIndex: col.index,
					desc: !!col.desc
				}));
				if (pkOrdering.length > 0) {
					bestPlan = {
						...bestPlan,
						providesOrdering: pkOrdering,
						orderingIndexName: bestPlan.orderingIndexName ?? PRIMARY_INDEX_NAME
					};
				}
			}
		}

		// Prefer plans that fully handle at least one filter over pure full scans when costs tie
		if (request.filters.length > 0 && bestPlan.handledFilters?.some(Boolean) === false) {
			// Small nudge to cost to encourage using any usable index when costs are equal
			bestPlan = { ...bestPlan, cost: bestPlan.cost + 0.01, explains: `${bestPlan.explains} (no filters handled)` };
		}

		// Post-pass: mark tautological IS NOT NULL on NOT NULL columns as handled
		const mergedHandled = [...bestPlan.handledFilters];
		let anyMerged = false;
		for (let i = 0; i < request.filters.length; i++) {
			const filter = request.filters[i];
			if (filter.op === 'IS NOT NULL' && !mergedHandled[i]) {
				const col = tableInfo.columns[filter.columnIndex];
				if (col?.notNull) {
					mergedHandled[i] = true;
					anyMerged = true;
				}
			}
		}
		if (anyMerged) {
			bestPlan = { ...bestPlan, handledFilters: mergedHandled };
		}

		// Advertise monotonicOn / supportsAsofRight when the chosen path is
		// index-style and walks a sorted index. Downstream optimizer rules use
		// these to license rewrites that depend on total-order emit, not just
		// per-row ordering.
		// TODO: supportsOrdinalSeek is deferred for memory-table — the layered
		// store's scan does not cheaply support O(log N) seek to the kth row.
		const advertisement = this.buildMonotonicAdvertisement(tableInfo, bestPlan, request, availableIndexes);
		if (advertisement.monotonicOn) {
			bestPlan = { ...bestPlan, ...advertisement };
		}

		return bestPlan;
	}

	/**
	 * Compute the monotonic-ordering advertisement for a chosen access plan.
	 * Returns an empty object when the path is non-monotonic (multi-IN multi-seek,
	 * OR_RANGE multi-range, or a single-row equality seek).
	 *
	 * Also empty when the leading column is a DESC key a NULL could reach: a
	 * `direction: 'desc'` claim asserts the same physical order `providesOrdering` would,
	 * and this module's DESC walk emits NULLs LAST while the engine's ORDER BY places them
	 * FIRST — see {@link nullSafeOrderingPrefixLength}. `supportsAsofRight` implies
	 * `monotonicOn`, so the two are dropped together.
	 */
	private buildMonotonicAdvertisement(
		tableInfo: TableSchema,
		bestPlan: BestAccessPlanResult,
		request: BestAccessPlanRequest,
		availableIndexes: IndexSchema[],
	): Pick<BestAccessPlanResult, 'monotonicOn' | 'supportsAsofRight'> {
		// Multi-value IN multi-seek visits values in seek-key order (a runtime-valued
		// set included); OR_RANGE concatenates disjoint ranges. Neither emits in
		// monotonic order.
		for (let i = 0; i < bestPlan.handledFilters.length; i++) {
			if (!bestPlan.handledFilters[i]) continue;
			const f = request.filters[i];
			if (isMultiValueEquality(f)) return {};
			if (f.op === 'OR_RANGE') return {};
		}

		// Locate the index being walked. Prefer a filter-side index, else the
		// orderingIndexName (set by adjustPlanForOrdering / the PK-ordering post-pass).
		const indexName = bestPlan.indexName ?? bestPlan.orderingIndexName;
		if (!indexName) return {};
		const usedIndex = availableIndexes.find(idx => idx.name === indexName);
		if (!usedIndex || usedIndex.columns.length === 0) return {};

		// Find the leading non-equality-bound column. Equality-bound columns are
		// constants over the scan and don't contribute to monotonic ordering.
		const equalityBound = collectEqualityBoundColumns(request.filters);
		const trailingNonBound = usedIndex.columns.filter(c => !equalityBound.has(c.index));
		if (trailingNonBound.length === 0) return {}; // single-row equality seek

		const leadingCol = trailingNonBound[0];

		// A nullable DESC leading column walks its NULLs to the END; the engine's ORDER BY
		// wants them FIRST. `equalityBound` is the pinned set the helper needs (a pinned
		// column never reached this point anyway — it was filtered out above).
		if (nullSafeOrderingPrefixLength(tableInfo, request, [leadingCol], 1, equalityBound) === 0) {
			return {};
		}

		// Strict iff the leading non-bound column alone determines uniqueness within
		// the path: a unique index (PK or declared unique) where the leading column
		// is the sole remaining unbound key. (For composite PK with a free leading
		// column, the leading column may have duplicate values across rows.)
		const strict = isUniqueIndex(usedIndex) && trailingNonBound.length === 1;

		// Direction follows the index's natural sort order, but if the planner
		// produced an explicit providesOrdering covering this column, honor that
		// (adjustPlanForOrdering may have selected a descending ORDER BY against
		// an asc index — for that we'd need to reverse-walk the index, which the
		// memory-table scan-plan supports). For now, the index's own desc flag
		// is the single source of truth.
		const direction: 'asc' | 'desc' = leadingCol.desc ? 'desc' : 'asc';

		return {
			monotonicOn: { columnIndex: leadingCol.index, direction, strict },
			supportsAsofRight: true,
		};
	}

	/**
	 * Evaluate access via a specific index
	 */
	private evaluateIndexAccess(
		tableInfo: TableSchema,
		index: IndexSchema,
		request: BestAccessPlanRequest,
		estimatedTableSize: number
	): BestAccessPlanResult {
		const indexCols = index.columns;
		if (indexCols.length === 0) {
			return AccessPlanBuilder.fullScan(estimatedTableSize)
				.setHandledFilters(new Array(request.filters.length).fill(false))
				.build();
		}

		// Check for equality constraints on index columns (prefix matching)
		const equalityMatches = this.findEqualityMatches(indexCols, request.filters);
		if (equalityMatches.matchCount === indexCols.length) {
			// Perfect equality match on all index columns - index seek (or multi-seek for IN)
			const seekCols = indexCols.slice(0, equalityMatches.matchCount).map(c => c.index);
			const { inCardinality, isMultiSeek } = equalityMatches;
			// NOTE: no seek-key cap and no per-seek positioning term here (the store has both:
			// MAX_MULTI_SEEK_KEYS and inCount * its backend's `seekPositioning`), so a large multi-seek over a
			// small memory table prices optimistically. Harmless while every seek-key list is a
			// literal the author typed; if runtime-valued IN sets start arriving with large
			// ceilings, add the positioning term so the two modules stay comparable.
			//
			// COST stays keyed to `inCardinality` — the number of seek KEYS, which is what the
			// work scales with — while `rows` reports what the seek MATCHES. `eqMatch` derives
			// both from one argument, so the row count is overridden separately. Deriving the
			// cost from the matched-row count instead was measured and rejected: it raises a
			// pushed single-key equality seek from 1.8 to 31.5, which moves the baseline
			// `rule-key-set-seek` reads (`filterInfo.indexInfoOutput.estimatedCost`) and stops
			// the key-set rewrite firing at all. Pricing a fat seek honestly is a real and
			// separate question.
			return AccessPlanBuilder
				.eqMatch(inCardinality)
				.setRows(estimateEqualityRows(tableInfo, index, seekCols, inCardinality, estimatedTableSize))
				.setHandledFilters(equalityMatches.handledFilters)
				.setIsSet(!isMultiSeek)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index ${isMultiSeek ? `multi-seek(${inCardinality})` : 'seek'} on ${index.name}`)
				.build();
		}

		// Prefix-equality + trailing-range on composite indexes.
		//
		// NOTE: `findEqualityMatches` counts a multi-value `IN` as a prefix match, but
		// `rule-select-access-path` can only seek a *single-valued* prefix key, so for
		// e.g. `a in (1, 2) and b > 15` it declines to a sequential scan and reattaches
		// both predicates as a residual. Correct, but the cost advertised below is a
		// range scan. If multi-value-IN prefixes with trailing ranges ever show up as
		// slow plans, teach the rule a cross-product prefix-range seek (or stop claiming
		// the trailing range here so the estimate matches the plan).
		if (equalityMatches.matchCount > 0 && equalityMatches.matchCount < indexCols.length) {
			const trailingCol = indexCols[equalityMatches.matchCount];
			const trailingRange = this.findRangeMatch(trailingCol, request.filters);
			if (trailingRange.hasRange) {
				const combinedHandled = equalityMatches.handledFilters.map(
					(eq, i) => eq || trailingRange.handledFilters[i]
				);
				const seekCols = indexCols.slice(0, equalityMatches.matchCount + 1).map(c => c.index);
				const estimatedRows = Math.max(1, Math.floor(estimatedTableSize / 8));
				return AccessPlanBuilder
					.rangeScan(estimatedRows)
					.setHandledFilters(combinedHandled)
					.setIndexName(index.name)
					.setSeekColumns(seekCols)
					.setExplanation(`Index prefix-range scan on ${index.name}`)
					.build();
			}
		}

		// Check for range constraints on first index column
		const rangeMatch = this.findRangeMatch(indexCols[0], request.filters);
		if (rangeMatch.hasRange) {
			const estimatedRangeRows = Math.max(1, Math.floor(estimatedTableSize / 4));
			const seekCols = [indexCols[0].index];
			return AccessPlanBuilder
				.rangeScan(estimatedRangeRows)
				.setHandledFilters(rangeMatch.handledFilters)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index range scan on ${index.name}`)
				.build();
		}

		// Check for OR_RANGE constraint on first index column
		const orRangeMatch = this.findOrRangeMatch(indexCols[0], request.filters);
		if (orRangeMatch) {
			const rangeCount = orRangeMatch.rangeCount;
			const estimatedRangeRows = Math.max(1, Math.floor(estimatedTableSize / (4 * rangeCount)) * rangeCount);
			const seekCols = [indexCols[0].index];
			return AccessPlanBuilder
				.rangeScan(estimatedRangeRows)
				.setHandledFilters(orRangeMatch.handledFilters)
				.setIndexName(index.name)
				.setSeekColumns(seekCols)
				.setExplanation(`Index multi-range scan (${rangeCount} ranges) on ${index.name}`)
				.build();
		}

		// No useful index access - return full scan
		return AccessPlanBuilder.fullScan(estimatedTableSize)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation(`Full scan (index ${index.name} not useful)`)
			.build();
	}

	/**
	 * Find equality matches for index columns (prefix matching).
	 * Handles `=`, single-value `IN`, multi-value `IN`, and a runtime-valued `IN` set as
	 * equality constraints — {@link equalitySeekKeyCount} is the single well-formedness
	 * test, so the four cannot drift apart. Returns the total cardinality (the product of
	 * the per-column seek-key counts) for cost estimation; for a runtime set that count is
	 * its `maxCount` ceiling, the worst case the engine may deliver.
	 *
	 * Claims the FIRST role-filling filter per column, matching the positional pick
	 * `rule-select-access-path` makes — so a request carrying both a runtime set and a
	 * literal `IN` on one column seeks whichever came first in `filters` order, and the
	 * other survives as a residual.
	 *
	 * `isMultiSeek` is NOT `inCardinality > 1`: a runtime set is delivered as a multi-seek
	 * whatever its ceiling, so a `maxCount === 1` set has cardinality 1 yet still walks the
	 * index in seek-key order. {@link isMultiValueEquality} is the authority.
	 */
	private findEqualityMatches(
		indexCols: ReadonlyArray<IndexColumnSchema>,
		filters: readonly PredicateConstraint[]
	): { matchCount: number; handledFilters: boolean[]; inCardinality: number; isMultiSeek: boolean } {
		const handledFilters = new Array(filters.length).fill(false);
		let matchCount = 0;
		let inCardinality = 1;
		let isMultiSeek = false;

		for (const indexCol of indexCols) {
			let foundMatch = false;
			for (let i = 0; i < filters.length; i++) {
				const filter = filters[i];
				if (filter.columnIndex !== indexCol.index || !filter.usable) continue;

				// `=` (whose value may be undefined for parameter bindings — the actual
				// value is supplied at runtime via seek key expressions), a well-formed
				// literal `IN`, or a runtime-valued `IN` set. Anything else is null.
				const keyCount = equalitySeekKeyCount(filter);
				if (keyCount === null) continue;

				handledFilters[i] = true;
				foundMatch = true;
				matchCount++;
				inCardinality *= keyCount;
				if (isMultiValueEquality(filter)) isMultiSeek = true;
				break;
			}
			if (!foundMatch) {
				break; // Can't use remaining index columns
			}
		}

		return { matchCount, handledFilters, inCardinality, isMultiSeek };
	}

	/**
	 * Find range match for a column.
	 *
	 * Claims at most the FIRST lower ('>'/'>=') and the FIRST upper ('<'/'<=') bound,
	 * matching what `rule-select-access-path` actually turns into seek bounds (it picks
	 * per column by position). Claiming a redundant same-side bound as handled would
	 * drop it from the residual filter without ever applying it — `where v > 10 and
	 * v > 30` would wrongly return the `v > 10` rows. Redundant bounds stay unhandled
	 * and survive as a residual `Filter`.
	 */
	private findRangeMatch(
		indexCol: IndexColumnSchema,
		filters: readonly PredicateConstraint[]
	): { hasRange: boolean; handledFilters: boolean[] } {
		const handledFilters = new Array(filters.length).fill(false);
		let hasLower = false;
		let hasUpper = false;

		for (let i = 0; i < filters.length; i++) {
			const filter = filters[i];
			if (filter.columnIndex !== indexCol.index || !filter.usable) continue;
			if (!hasLower && (filter.op === '>' || filter.op === '>=')) {
				handledFilters[i] = true;
				hasLower = true;
			} else if (!hasUpper && (filter.op === '<' || filter.op === '<=')) {
				handledFilters[i] = true;
				hasUpper = true;
			}
		}

		return { hasRange: hasLower || hasUpper, handledFilters };
	}

	/**
	 * Find OR_RANGE match for a column
	 */
	private findOrRangeMatch(
		indexCol: IndexColumnSchema,
		filters: readonly PredicateConstraint[]
	): { handledFilters: boolean[]; rangeCount: number } | null {
		for (let i = 0; i < filters.length; i++) {
			const filter = filters[i];
			if (filter.columnIndex === indexCol.index && filter.usable && filter.op === 'OR_RANGE') {
				const handledFilters = new Array(filters.length).fill(false);
				handledFilters[i] = true;
				const rangeCount = filter.ranges ? filter.ranges.length : 2;
				return { handledFilters, rangeCount };
			}
		}
		return null;
	}

	/**
	 * Adjust plan to account for ordering requirements.
	 *
	 * Compares two competing strategies and returns the cheaper:
	 *
	 *   Plan A: keep the chosen filtering plan. If its index also satisfies the
	 *           required ordering (and the access pattern walks it monotonically),
	 *           claim ordering directly. Otherwise charge an estimated external
	 *           sort cost — the plan is returned unchanged and a `SortNode` will
	 *           be inserted above it by the planner.
	 *
	 *   Plan B: scan an alternative index in its natural order, applying any
	 *           filters that don't seek into it as residuals. Useful when the
	 *           filter index doesn't cover ordering and the table is small or
	 *           the filter is unselective enough that scan-and-filter beats
	 *           seek-and-sort.
	 *
	 * `validateAccessPlan` enforces that whenever a plan claims `providesOrdering`,
	 * its `indexName` (if any) matches `orderingIndexName` — the cross-index
	 * correctness bug is caught at the boundary regardless of which module
	 * emits the plan.
	 */
	private adjustPlanForOrdering(
		tableInfo: TableSchema,
		plan: BestAccessPlanResult,
		request: BestAccessPlanRequest,
		availableIndexes: IndexSchema[],
		estimatedTableSize: number
	): BestAccessPlanResult {
		// Columns bound by an equality predicate are constants for this scan and
		// therefore contribute no ordering information — they can be skipped when
		// aligning an index against the required ordering.
		const equalityCols = collectEqualityBoundColumns(request.filters);

		// Determine whether plan A's existing access pattern can claim the
		// required ordering. It can iff the chosen filter index satisfies the
		// ordering AND the access pattern walks the index monotonically — i.e.,
		// not OR_RANGE (concatenated ranges) and not multi-value IN on an
		// ordering column (visits values in IN-list order).
		const filterIndex = plan.indexName
			? availableIndexes.find(idx => idx.name === plan.indexName)
			: undefined;
		const filterSatisfies = filterIndex
			? this.indexSatisfiesOrdering(tableInfo, request, filterIndex, request.requiredOrdering!, equalityCols)
			: false;

		const orderingColumns = new Set(request.requiredOrdering!.map(o => o.columnIndex));
		const usesOrRange = request.filters.some(
			(f, i) => plan.handledFilters[i] && f.op === 'OR_RANGE'
		);
		const usesMultiInOnOrderedCol = request.filters.some(
			(f, i) => plan.handledFilters[i]
				&& isMultiValueEquality(f)
				&& orderingColumns.has(f.columnIndex)
		);
		const planACanClaimOrdering = filterSatisfies && !usesOrRange && !usesMultiInOnOrderedCol;

		let planA: BestAccessPlanResult;
		let planACost: number;
		if (planACanClaimOrdering) {
			planA = {
				...plan,
				providesOrdering: request.requiredOrdering,
				orderingIndexName: filterIndex!.name,
				explains: `${plan.explains} with ordering from ${filterIndex!.name}`,
			};
			planACost = plan.cost;
		} else {
			planA = plan;
			planACost = plan.cost + estimateSortCost(plan.rows ?? estimatedTableSize);
		}

		// Plan B: cheapest competing plan that walks an ordering-providing
		// index in its natural order (with any unpushable filters becoming
		// residuals). Returns undefined when no such index exists.
		const planB = this.evaluateOrderingOnlyPlans(
			tableInfo, request, availableIndexes, equalityCols, estimatedTableSize
		);

		if (planB && planB.cost < planACost) {
			return planB;
		}
		return planA;
	}

	/**
	 * Evaluate alternative access paths that walk an ordering-providing index
	 * directly. Returns the cheapest such plan, or undefined when no index
	 * satisfies the required ordering.
	 *
	 * For each candidate index whose key suffix satisfies `requiredOrdering`,
	 * we first ask `evaluateIndexAccess` whether the index can also push any
	 * filters as a seek/range. If yes (and the resulting access pattern still
	 * walks monotonically), use that plan; otherwise fall back to a pure
	 * ordering scan over the index. Either way we add residual-filter cost
	 * for filters left unhandled.
	 */
	private evaluateOrderingOnlyPlans(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		availableIndexes: IndexSchema[],
		equalityCols: ReadonlySet<number>,
		estimatedTableSize: number
	): BestAccessPlanResult | undefined {
		let best: BestAccessPlanResult | undefined;
		const orderingColumns = new Set(request.requiredOrdering!.map(o => o.columnIndex));

		for (const index of availableIndexes) {
			if (!this.indexSatisfiesOrdering(tableInfo, request, index, request.requiredOrdering!, equalityCols)) {
				continue;
			}

			// See whether this index can also serve as a filter seek/range.
			const candidate = this.evaluateIndexAccess(tableInfo, index, request, estimatedTableSize);

			// A useful filter pattern that breaks ordering (multi-IN multi-seek — literal
			// or runtime-valued — on an ordering column, or OR_RANGE) cannot claim
			// ordering: a multi-seek visits the index in seek-key order, not column
			// order, so claiming it would elide a Sort the plan needs. Fall back to a
			// pure scan that doesn't push those filters.
			const breaksOrdering = request.filters.some(
				(f, i) => candidate.handledFilters[i]
					&& (
						f.op === 'OR_RANGE'
						|| (isMultiValueEquality(f) && orderingColumns.has(f.columnIndex))
					)
			);

			let basePlan: BestAccessPlanResult;
			if (candidate.indexName === index.name && !breaksOrdering) {
				basePlan = candidate;
			} else {
				// Pure ordering scan over the index — no filters pushed.
				basePlan = AccessPlanBuilder
					.rangeScan(estimatedTableSize)
					.setHandledFilters(new Array(request.filters.length).fill(false))
					.setIndexName(index.name)
					.setExplanation(`Index ordering scan on ${index.name}`)
					.build();
			}

			// Charge per-row residual-filter cost for filters not handled by
			// the chosen access pattern; these remain as a Filter above the leaf.
			const rows = basePlan.rows ?? estimatedTableSize;
			const unhandledCount = basePlan.handledFilters.reduce((n, h) => n + (h ? 0 : 1), 0);
			const residualCost = rows * unhandledCount * RESIDUAL_FILTER_COST_PER_ROW;

			const ordered: BestAccessPlanResult = {
				...basePlan,
				cost: basePlan.cost + residualCost,
				providesOrdering: request.requiredOrdering,
				orderingIndexName: index.name,
				indexName: index.name,
				explains: `${basePlan.explains} with ordering from ${index.name}`,
			};

			if (!best || ordered.cost < best.cost) {
				best = ordered;
			}
		}

		return best;
	}

	/**
	 * Check if an index can satisfy ordering requirements.
	 *
	 * Leading index columns that are bound by equality (and therefore constant
	 * for this scan) are skipped before aligning against the required ordering
	 * keys. The per-column direction comparison still applies to the remaining
	 * (unbound) suffix.
	 *
	 * A match is additionally gated by {@link nullSafeOrderingPrefixLength}: this module's
	 * DESC walk negates the ascending comparator, and NULL is the lowest value, so a DESC
	 * column's NULLs come out LAST — while the engine's ORDER BY places them FIRST for
	 * both directions (`orderByNullResult`, util/comparison.ts). The gate is a plain
	 * boolean here rather than a truncation because both callers claim
	 * `request.requiredOrdering` VERBATIM, all or nothing: one unsafe DESC column anywhere
	 * in the matched key prefix means the whole index declines. Only the prefix actually
	 * consumed by the match is judged — a nullable DESC column sitting BEYOND it is not
	 * part of the claim and must not disqualify the index. The PK pseudo-index
	 * ({@link gatherAvailableIndexes}) flows through here too, so a nullable DESC
	 * primary-key member is covered with no `create index` involved.
	 *
	 * NOTE: `OrderingSpec.nullsFirst` is not compared — nothing in the planner
	 * populates it today, so every required spec leaves it undefined. If NULLS
	 * FIRST/LAST ever reaches requiredOrdering, this must decline the index
	 * unless the placement matches (the store module's
	 * `buildPkOrderingAdvertisement` already does), or the Sort gets elided
	 * against a different NULL placement.
	 */
	private indexSatisfiesOrdering(
		tableInfo: TableSchema,
		request: BestAccessPlanRequest,
		index: IndexSchema,
		requiredOrdering: readonly OrderingSpec[],
		equalityCols: ReadonlySet<number> = EMPTY_COLUMN_SET
	): boolean {
		let i = 0; // pointer into index.columns
		let j = 0; // pointer into requiredOrdering

		// Skip leading equality-bound index columns; they contribute no ordering.
		while (i < index.columns.length && equalityCols.has(index.columns[i].index)) {
			i++;
		}

		while (j < requiredOrdering.length) {
			if (i >= index.columns.length) return false;
			const required = requiredOrdering[j];
			const indexCol = index.columns[i];

			if (required.columnIndex === indexCol.index &&
				required.desc === (indexCol.desc ?? false)) {
				i++;
				j++;
				continue;
			}

			// Allow equality-bound columns interleaved after the matched prefix:
			// they don't break ordering on later columns.
			if (equalityCols.has(indexCol.index)) {
				i++;
				continue;
			}

			return false;
		}

		// `i` is now the number of leading index columns the claim consumed.
		return nullSafeOrderingPrefixLength(tableInfo, request, index.columns, i, equalityCols) === i;
	}

	private gatherAvailableIndexes(tableInfo: TableSchema): IndexSchema[] {
		const availableIndexes: IndexSchema[] = [];

		// Add pseudo-index for primary key
		const pkIndexSchema = {
			name: PRIMARY_INDEX_NAME,
			columns: tableInfo.primaryKeyDefinition
		};
		availableIndexes.push(pkIndexSchema);

		// Add secondary indexes — but exclude partial indexes (those with a WHERE
		// predicate). The planner does not yet check that the query's WHERE
		// implies the partial predicate, so using a partial index for a query
		// it doesn't cover would silently drop matching rows. Treat partial
		// indexes purely as uniqueness enforcers.
		for (const idx of tableInfo.indexes ?? []) {
			if (idx.predicate) continue;
			availableIndexes.push(idx);
		}

		return availableIndexes;
	}

	/**
	 * Destroys a memory table and frees associated resources
	 */
	async destroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (manager) {
			// This will call the manager's destroy method which handles cleaning up resources
			await manager.destroy?.();
			this.tables.delete(tableKey);

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'table',
				schemaName,
				objectName: tableName,
				ddl: generateDropTableDDL(schemaName, tableName),
			});

			logger.operation('Destroy Table', tableName, { schema: schemaName });
		}
	}

	/**
	 * Renames a memory table's internal registration key.
	 * Called by the ALTER TABLE RENAME TO emitter before the schema catalog update.
	 */
	async renameTable(_db: Database, schemaName: string, oldName: string, newName: string, ddl?: string): Promise<void> {
		const oldKey = `${schemaName}.${oldName}`.toLowerCase();
		const newKey = `${schemaName}.${newName}`.toLowerCase();
		const manager = this.tables.get(oldKey);
		if (manager) {
			manager.renameTable(newName);
			this.tables.delete(oldKey);
			this.tables.set(newKey, manager);
		}

		// Emit-iff-`ddl`, same rule as alterTable below: `ddl` set means this call IS the
		// RENAME TO statement's action; absent means an engine-internal step that must
		// announce nothing. No in-tree caller omits it today — the shadow-table rebuild's
		// trailing rename is itself a RENAME TO statement and is silenced by
		// `withPublicEventsSuppressed`, not by this gate.
		if (ddl !== undefined) {
			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'table',
				schemaName,
				objectName: newName,
				oldObjectName: oldName,
				ddl,
			});
		}
	}

	/**
	 * Alters an existing memory table's structure (ADD/DROP/RENAME COLUMN).
	 */
	async alterTable(db: Database, schemaName: string, tableName: string, change: SchemaChangeInfo, rows?: EffectiveRowSource): Promise<TableSchema> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`, StatusCode.ERROR);
		}

		switch (change.type) {
			case 'addColumn':
				await manager.addColumn(change.columnDef, change.backfillEvaluator, change.insertAtIndex);
				break;
			case 'dropColumn':
				await manager.dropColumn(change.columnName);
				break;
			case 'renameColumn':
				if (!change.newColumnDefAst) {
					throw new QuereusError('RENAME COLUMN requires a new column definition AST', StatusCode.INTERNAL);
				}
				await manager.renameColumn(change.oldName, change.newColumnDefAst);
				break;
			case 'alterPrimaryKey':
				await manager.alterPrimaryKey(change.newPkColumns, rows);
				break;
			case 'addConstraint':
				await manager.addConstraint(change.constraint, rows);
				break;
			case 'dropConstraint':
				await manager.dropConstraint(change.constraintName);
				break;
			case 'renameConstraint':
				await manager.renameConstraint(change.oldName, change.newName);
				break;
			case 'alterColumn':
				await manager.alterColumn({
					columnName: change.columnName,
					setNotNull: change.setNotNull,
					setDataType: change.setDataType,
					setDefault: change.setDefault,
					setCollation: change.setCollation,
				}, rows);
				break;
		}

		// ONE event per statement, decided here — the single gate for every arm: emit iff
		// the engine marked this call as the statement's own action (`change.ddl` set), and
		// put that text on the event. Engine-internal sub-steps — the inline-constraint
		// installs and revert calls of the engine's ADD COLUMN, the materialized-view
		// backing reshapes, and any wrapper-driven manager call — arrive with no `ddl` and
		// announce nothing. See `SchemaChangeInfo.ddl`; mirrors the store module's gate.
		if (change.ddl !== undefined) {
			this.eventEmitter?.emitSchemaChange?.({
				...alterEventShape(change),
				schemaName,
				objectName: tableName,
				ddl: change.ddl,
			});
		}

		// NOTE: `manager.tableSchema` is the manager's own cached copy, which ANALYZE's
		// stamp (which lands on the REGISTERED schema) never touched — so a column-level
		// ALTER on this backend returns a schema with no `statistics` and the engine
		// installs that, silently discarding the last ANALYZE. The store backend instead
		// copies its pre-ALTER statistics across (minus whatever `pruneStaleColumnStatistics`
		// drops), so the two backends need a re-ANALYZE at different times. Fail-safe rather
		// than wrong — the planner falls back to its default guesses — and RENAME COLUMN is
		// already exempt (the engine re-keys the pre-ALTER measurements itself; see
		// `carryStatisticsAcrossColumnRename`). Revisit if the difference ever shows up as a
		// plan discrepancy between backends.
		return manager.tableSchema;
	}

	/**
	 * Creates an index on a memory table
	 */
	async createIndex(db: Database, schemaName: string, tableName: string, indexSchema: IndexSchema, rows?: EffectiveRowSource): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot create index.`, StatusCode.ERROR);
		}

		// Delegate to the manager to create the index
		await manager.createIndex(indexSchema, undefined, rows);

		logger.operation('Create Index', indexSchema.name, {
			table: tableName,
			schema: schemaName,
			columns: indexSchema.columns.map(col => `${col.index}${col.desc ? ' DESC' : ''}`)
		});
	}

	/**
	 * Drops an index from a memory table
	 */
	async dropIndex(_db: Database, schemaName: string, tableName: string, indexName: string): Promise<void> {
		const tableKey = `${schemaName}.${tableName}`.toLowerCase();
		const manager = this.tables.get(tableKey);

		if (!manager) {
			throw new QuereusError(`Memory table '${tableName}' not found in schema '${schemaName}'. Cannot drop index.`, StatusCode.ERROR);
		}

		await manager.dropIndex(indexName);

		logger.operation('Drop Index', indexName, {
			table: tableName,
			schema: schemaName,
		});
	}
}
