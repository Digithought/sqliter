import type { Database } from '../../../core/database.js';
import { type TableSchema, type IndexSchema, type UniqueConstraintSchema, buildColumnIndexMap, columnDefToSchema, resolvePkDefaultConflict, resolveNamedConstraintClass, validateCollationForType } from '../../../schema/table.js';
import { keyParts, type BTreeKeyForPrimary } from '../types.js';
import { BTree } from 'inheritree';
import { StatusCode, type SqlValue, type Row, type UpdateResult } from '../../../common/types.js';
import { BaseLayer, iteratePrimaryRows, populateIndexFromRows, populateIndexFromRowsAsync } from './base.js';
import { TransactionLayer, type OwnWrite, type PreparedColumnReshape } from './transaction.js';
import type { Layer } from './interface.js';
import { MemoryTableConnection } from './connection.js';
import { MemoryVirtualTableConnection } from '../connection.js';
import { QuereusError } from '../../../common/errors.js';
import { ConflictResolution } from '../../../common/constants.js';
import type { ColumnDef as ASTColumnDef, TableConstraint as ASTTableConstraint } from '../../../parser/ast.js';
import { buildUniqueConstraintSchema, buildForeignKeyConstraintSchema, buildCheckConstraintSchema, validateForeignKeyOverExistingRows, maintainedTableUniqueViolationError, formatKeyValue } from '../../../schema/constraint-builder.js';
import { indexEnforcesUnique, uniqueEnforcementCollations, uniqueEnforcementComparators } from '../../../schema/unique-enforcement.js';
import { generateIndexDDL, generateDropIndexDDL } from '../../../schema/ddl-generator.js';
import { compareSqlValues, rowsValueIdentical, normalizeCollationName, comparisonSemanticsDiffer } from '../../../util/comparison.js';
import type { CollationResolver } from '../../../types/logical-type.js';
import type { ScanPlan } from './scan-plan.js';
import type { ColumnSchema } from '../../../schema/column.js';
import { scanLayer as scanLayerImpl } from './scan-layer.js';
import { createPrimaryKeyFunctions, buildPrimaryKeyFromValues, primaryKeyArity, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';
import { tryFoldLiteral } from '../../../parser/utils.js';
import { validateAndParse, coerceRowToSchema } from '../../../types/validation.js';
import type { VTableEventEmitter } from '../../events.js';
import { inferType } from '../../../types/registry.js';
import type { Expression } from '../../../parser/ast.js';
import { compilePredicate } from '../utils/predicate.js';
import { renameColumnInIndexPredicates, type ResolveColumnInSource } from '../../../schema/rename-rewriter.js';
import { MemoryIndex } from '../index.js';
import type { MaintainedTableSchema } from '../../../schema/derivation.js';
import type { MaintenanceOp, BackingRowChange } from '../../backing-host.js';
import type { EffectiveRowSource } from '../../module.js';
import { convertRowAtIndex, mapRows, mapRowsAsync, type RowMapper } from './row-convert.js';

let tableManagerCounter = 0;
const logger = createMemoryTableLoggers('layer:manager');

/**
 * Unified surface for the structure that enforces a UNIQUE constraint. A
 * constraint is logical; its backing structure is optional and may take one of
 * several physical shapes:
 *
 *  - `memory-index` — the synchronously-maintained secondary BTree auto-built per
 *    UNIQUE constraint (reframed as an *implicit* covering structure in the
 *    materialized-view vocabulary).
 *  - `materialized-view` — an explicit, **`row-time`** covering MV whose backing
 *    table is kept consistent synchronously with each source row-write. Now that
 *    row-time write-through MV maintenance exists, {@link MemoryTableManager.findIndexForConstraint}
 *    returns this variant *in preference to* `memory-index` whenever a linked,
 *    non-stale row-time covering MV is present: it makes the MV the live
 *    conflict-resolution path (physical schemas otherwise never reach it, since
 *    the auto-index always exists) and is exactly the structure the lens layer
 *    makes sole once the auto-index is retired. See
 *    `docs/mv-constraints.md` § Covering structures.
 */
export type CoveringStructure =
	| { kind: 'memory-index'; index: MemoryIndex }
	| { kind: 'materialized-view'; view: MaintainedTableSchema };

/** Origin + structure name for a UNIQUE constraint's implicit covering structure. */
export interface ImplicitCoveringStructure {
	/** Name of the secondary index (the synchronously-maintained BTree) that realizes the constraint. */
	indexName: string;
	/** Always `'implicit-from-unique-constraint'` — the auto-built secondary BTree. */
	origin: 'implicit-from-unique-constraint';
}

/** A copy of `items` with `value` inserted at `at` (`at === items.length` ⇒ append). */
function insertValueAt<T>(items: ReadonlyArray<T>, at: number, value: T): T[] {
	const out = items.slice();
	out.splice(at, 0, value);
	return out;
}

/** Index of a column after a new one is inserted at `at`. */
const shiftForInsert = (index: number, at: number): number => index >= at ? index + 1 : index;

/**
 * The index-bearing fields of `schema` renumbered for a column inserted at `at`, to be
 * spread over the schema alongside the new `columns` array. Only reached when `at` is a
 * real insert point (an append leaves every existing index valid), and the mirror image
 * of the shift `dropColumn` performs — except that an insert can never empty an index or
 * a constraint, so none of `dropColumn`'s prune/filter logic has a counterpart here.
 *
 * `checkConstraints` and the manager's implicit covering structures are name/AST-keyed
 * and need nothing. `statistics.columnStats` is keyed by column name. `columnIndexMap` is
 * rebuilt from the new column list by the caller.
 *
 * A foreign key's `columns` are indices into THIS table and always shift. Its
 * `referencedColumns` are NOT touched: every constructor of a foreign key leaves that
 * array empty (`constraint-builder.ts`, `schema/manager.ts`) and enforcement resolves the
 * parent indices on demand from `referencedColumnNames` against the parent's CURRENT
 * schema (`resolveReferencedColumns`) — so even a self-referential key needs no shift here.
 *
 * `derivation.logicalKey` / `derivation.ordering` also hold indices into this table and are
 * NOT shifted, in either direction: they exist only on a maintained table (a materialized
 * view's backing table), whose shape is defined by its body, and the emitter rejects every
 * structural ALTER on one before dispatch.
 */
function shiftSchemaIndicesForInsert(schema: TableSchema, at: number): Partial<TableSchema> {
	const shift = (index: number): number => shiftForInsert(index, at);

	const primaryKeyDefinition = schema.primaryKeyDefinition.map(def => ({ ...def, index: shift(def.index) }));

	const indexes = schema.indexes?.map(idx => ({
		...idx,
		columns: idx.columns.map(ic => ({ ...ic, index: shift(ic.index) })),
	}));

	const uniqueConstraints = schema.uniqueConstraints?.map(uc => ({
		...uc,
		columns: Object.freeze(uc.columns.map(shift)),
	}));

	const foreignKeys = schema.foreignKeys?.map(fk => ({
		...fk,
		columns: Object.freeze(fk.columns.map(shift)),
	}));

	// Generated-column bookkeeping is keyed BY column index and holds column indices.
	// Nothing inside the memory module reads it — the engine recomputes the graph after
	// its own ADD COLUMN — but a wrapper driving this API directly gets the schema back
	// verbatim, so leaving it unshifted would hand out a schema whose generated-column
	// edges point at the wrong columns.
	const generatedColumnDependencies = schema.generatedColumnDependencies
		&& new Map(Array.from(schema.generatedColumnDependencies, ([col, deps]) => [shift(col), deps.map(shift)]));
	const generatedColumnTopoOrder = schema.generatedColumnTopoOrder?.map(shift);

	return {
		primaryKeyDefinition: Object.freeze(primaryKeyDefinition),
		...(indexes && { indexes: Object.freeze(indexes) }),
		...(uniqueConstraints && { uniqueConstraints: Object.freeze(uniqueConstraints) }),
		...(foreignKeys && { foreignKeys: Object.freeze(foreignKeys) }),
		...(generatedColumnDependencies && { generatedColumnDependencies }),
		...(generatedColumnTopoOrder && { generatedColumnTopoOrder: Object.freeze(generatedColumnTopoOrder) }),
	};
}

export class MemoryTableManager {
	public readonly managerId: number;
	public readonly db: Database;
	public readonly schemaName: string;
	private _tableName: string;
	public get tableName() { return this._tableName; }

	private baseLayer: BaseLayer;
	private _currentCommittedLayer: Layer;
	private connections: Map<number, MemoryTableConnection> = new Map();
	public readonly isReadOnly: boolean;
	public tableSchema: TableSchema;

	/**
	 * `db.getCollationResolver()`, bound once. Every comparator this manager or its
	 * layers build — primary key, secondary index, UNIQUE enforcement, scan bounds —
	 * resolves names through it, so a collation registered on *this* database is
	 * honored and one registered on no database raises instead of byte-ordering.
	 */
	private readonly collationResolver: CollationResolver;

	private primaryKeyFunctions!: PrimaryKeyFunctions;

	/**
	 * Implicit covering structures: constraint identity → the auto-index that
	 * realizes it. The physical structure is the synchronously-maintained
	 * secondary BTree; this association lets `findIndexForConstraint` and
	 * introspection speak the materialized-view vocabulary (an `origin`) for the
	 * implicit structure, the same way an explicit covering MV is described.
	 * Keyed by constraint name when present, else by the auto-index name.
	 */
	private readonly implicitCoveringStructures = new Map<string, ImplicitCoveringStructure>();

	/** Optional event emitter for mutation and schema hooks */
	private eventEmitter?: VTableEventEmitter;

	constructor(
		db: Database,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		initialSchema: TableSchema,
		readOnly: boolean = false,
		eventEmitter?: VTableEventEmitter
	) {
		this.managerId = tableManagerCounter++;
		this.db = db;
		this.collationResolver = db.getCollationResolver();
		this.schemaName = schemaName;
		this._tableName = tableName;
		this.tableSchema = initialSchema;
		this.isReadOnly = readOnly;
		this.eventEmitter = eventEmitter;

		// Phase D (docs/lens.md § Departures — Auto-index for unique/PK): the legacy
		// eager auto-index for UNIQUE constraints is a *physical*-schema behavior. A
		// logical schema's UNIQUE contributes only a key/FD to the optimizer and an
		// enforced boundary constraint — it creates NO structure; any covering index
		// is an explicit basis-layer materialized view. Logical tables are never
		// module-backed (a MemoryTableManager is never constructed for one), so this
		// path is already unreachable for them — we gate explicitly regardless, so the
		// separation is enforced at the source rather than relying on that invariant.
		if (!this.isLogicalSchema()) {
			this.ensureUniqueConstraintIndexes();
		}
		this.initializePrimaryKeyFunctions();

		this.baseLayer = new BaseLayer(this.tableSchema, this.collationResolver);
		this._currentCommittedLayer = this.baseLayer;
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema, this.collationResolver);
	}

	/**
	 * One-bit guard on `Schema.kind` (docs/lens.md § Departures): true when this
	 * table belongs to a logical schema. Prefers the table's own `isLogical` flag
	 * and falls back to the owning schema's `kind`, so the gate holds even if a
	 * logical TableSchema were ever (incorrectly) handed to a memory manager.
	 */
	private isLogicalSchema(): boolean {
		if (this.tableSchema.isLogical === true) return true;
		return this.db.schemaManager.getSchema(this.schemaName)?.kind === 'logical';
	}

	/**
	 * Auto-creates secondary indexes for UNIQUE constraints that don't already
	 * have a matching index. This mirrors standard SQL behavior where UNIQUE
	 * constraints imply an index for efficient enforcement.
	 *
	 * Alongside each such index, records an *implicit covering structure*
	 * descriptor in {@link implicitCoveringStructures} (the materialized-view
	 * vocabulary) so the implicit BTree and a future explicit covering MV share
	 * one schema shape. The physical structure is unchanged — observation-
	 * equivalent, zero behavioral difference.
	 */
	private ensureUniqueConstraintIndexes(): void {
		const uniqueConstraints = this.tableSchema.uniqueConstraints;
		if (!uniqueConstraints || uniqueConstraints.length === 0) return;

		const existingIndexes = this.tableSchema.indexes ?? [];
		const newIndexes: IndexSchema[] = [...existingIndexes];
		let added = false;

		for (const uc of uniqueConstraints) {
			// Reuse an existing same-column-set index ONLY when its per-column
			// collations are equivalent to the declared column collations — otherwise
			// it would enforce this non-derived UC under the index's collation rather
			// than the declared one. A collation-mismatched index falls through to a
			// distinct `_uc_*` covering index and coexists as its own constraint.
			const matchingIndex = existingIndexes.find(idx =>
				idx.columns.length === uc.columns.length &&
				idx.columns.every((col, i) => col.index === uc.columns[i]) &&
				this.indexCollationsMatchDeclared(idx, uc)
			);

			let indexName: string;
			if (matchingIndex) {
				indexName = matchingIndex.name;
			} else {
				const colNames = uc.columns.map(i => this.tableSchema.columns[i]?.name ?? String(i));
				indexName = uc.name ?? `_uc_${colNames.join('_')}`;
				newIndexes.push({
					name: indexName,
					// Carry each column's declared collation so the auto-index — and the
					// `checkUniqueViaIndex` path it backs — enforces UNIQUE under the column's
					// collation (e.g. NOCASE) rather than defaulting to BINARY.
					columns: uc.columns.map(colIdx => ({ index: colIdx, collation: this.tableSchema.columns[colIdx]?.collation })),
					predicate: uc.predicate,
				});
				added = true;
			}

			// Reframe the (auto or pre-existing) secondary index as the implicit
			// covering structure realizing this constraint.
			this.implicitCoveringStructures.set(
				uc.name ?? indexName,
				{ indexName, origin: 'implicit-from-unique-constraint' },
			);
		}

		if (added) {
			this.tableSchema = {
				...this.tableSchema,
				indexes: Object.freeze(newIndexes),
			};
		}
	}

	/**
	 * Returns the implicit covering structure realizing the given UNIQUE
	 * constraint, or undefined when none was synthesized. Part of the unified
	 * covering-structure surface the lens layer and introspection consume — the
	 * physical structure is the synchronously-maintained secondary BTree named
	 * {@link ImplicitCoveringStructure.indexName}.
	 */
	getImplicitCoveringStructure(uc: UniqueConstraintSchema): ImplicitCoveringStructure | undefined {
		const indexName = uc.name ?? this.implicitIndexNameFor(uc);
		return this.implicitCoveringStructures.get(indexName);
	}

	/** Conventional auto-index name for an unnamed UNIQUE constraint (mirrors {@link ensureUniqueConstraintIndexes}). */
	private implicitIndexNameFor(uc: UniqueConstraintSchema): string {
		const colNames = uc.columns.map(i => this.tableSchema.columns[i]?.name ?? String(i));
		return `_uc_${colNames.join('_')}`;
	}

	/**
	 * True when a same-column-set index's per-column collations are
	 * collation-equivalent to the constraint's DECLARED column collations.
	 *
	 * Gates REUSE of an existing same-column-set index as a non-derived UNIQUE's
	 * realizing structure. A non-derived (table-level / column) UNIQUE enforces
	 * under the declared column collation, so reusing a finer/coarser-collated
	 * same-column-set index (e.g. a BINARY `create unique index` over a NOCASE
	 * column) would silently enforce under the index's collation instead. When
	 * this returns false the caller builds the distinct `_uc_*` covering index and
	 * lets the user index coexist as an independent constraint (matches SQLite,
	 * where both indexes enforce).
	 *
	 * Positions align because the column SET already matched
	 * (`idx.columns[i]` ↔ `uc.columns[i]`). A plain index column with no explicit
	 * COLLATE has `collation === undefined` and falls back to the declared
	 * collation, so the common case stays reuse-safe.
	 */
	private indexCollationsMatchDeclared(idx: IndexSchema, uc: UniqueConstraintSchema): boolean {
		const columns = this.tableSchema.columns;
		return uc.columns.every((colIdx, i) => {
			const declared = normalizeCollationName(columns[colIdx]?.collation ?? 'BINARY');
			const indexColl = normalizeCollationName(idx.columns[i]?.collation ?? columns[colIdx]?.collation ?? 'BINARY');
			return indexColl === declared;
		});
	}

	/**
	 * Get the event emitter if one was provided.
	 */
	getEventEmitter(): VTableEventEmitter | undefined {
		return this.eventEmitter;
	}

	/**
	 * Compute which columns changed between old and new rows.
	 */
	private computeChangedColumns(oldRow: Row, newRow: Row): string[] {
		const changed: string[] = [];
		const schema = this.tableSchema;

		for (let i = 0; i < schema.columns.length && i < Math.max(oldRow.length, newRow.length); i++) {
			if (oldRow[i] !== newRow[i]) {
				changed.push(schema.columns[i].name);
			}
		}

		return changed;
	}

	private get primaryKeyFromRow() {
		return this.primaryKeyFunctions.extractFromRow;
	}

	private get comparePrimaryKeys() {
		return this.primaryKeyFunctions.compare;
	}

	public get currentCommittedLayer(): Layer {
		return this._currentCommittedLayer;
	}

	/**
	 * Returns committed layer statistics for cost-based optimization.
	 * Provides exact row count and per-index distinct counts without scanning.
	 */
	getBaseLayerStats(): { rowCount: number; indexDistinctCounts: Map<string, number> } {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		const rowCount = tree?.getCount() ?? 0;
		const indexDistinctCounts = new Map<string, number>();
		for (const idx of this.tableSchema?.indexes ?? []) {
			const idxTree = this._currentCommittedLayer.getSecondaryIndexTree?.(idx.name);
			if (idxTree) {
				indexDistinctCounts.set(idx.name, idxTree.getCount());
			}
		}
		return { rowCount, indexDistinctCounts };
	}

	/**
	 * Sample column values from the committed layer for histogram construction.
	 * Returns sorted non-null values for the specified column index.
	 * For tables with <= maxSample rows returns all values; otherwise systematic samples.
	 */
	sampleColumnValues(columnIndex: number, maxSample: number = 1000): SqlValue[] {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		if (!tree) return [];
		const count = tree.getCount();
		const values: SqlValue[] = [];

		if (count === 0) return values;

		const step = count <= maxSample ? 1 : Math.floor(count / maxSample);
		let i = 0;
		for (const path of tree.ascending(tree.first())) {
			if (i % step === 0) {
				const row = tree.at(path);
				if (row) {
					const val = row[columnIndex];
					if (val !== null && val !== undefined) {
						values.push(val);
					}
				}
			}
			i++;
			if (values.length >= maxSample) break;
		}

		values.sort((a, b) => compareSqlValues(a, b));
		return values;
	}

	public connect(): MemoryTableConnection {
		const connection = new MemoryTableConnection(this, this._currentCommittedLayer);
		this.connections.set(connection.connectionId, connection);
		return connection;
	}

	public async disconnect(connectionId: number): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		// If the connection still has an un-committed pending layer, defer
		// disconnect until the layer is either committed or rolled back by the
		// transaction coordinator.  This avoids accidental rollback during
		// implicit transactions.
		if (connection.pendingTransactionLayer && !connection.pendingTransactionLayer.isCommitted()) {
			logger.debugLog(`[Disconnect] Deferring disconnect of connection ${connectionId} while transaction pending for ${this._tableName}`);
			return;
		}

		// No pending changes – safe to remove immediately.
		this.connections.delete(connectionId);

		// Attempt fast layer-collapse in the background (best-effort)
		void this.tryCollapseLayers().catch(err => {
			logger.error('Disconnect', this._tableName, 'Layer collapse failed', err);
		});
	}

	public async commitTransaction(connection: MemoryTableConnection): Promise<void> {
		if (this.isReadOnly) {
			if (connection.pendingTransactionLayer && connection.pendingTransactionLayer.hasChanges()) {
				throw new QuereusError(`Table ${this._tableName} is read-only, cannot commit changes.`, StatusCode.READONLY);
			}
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();
			return;
		}

		// If pending is null but readLayer is a swapped savepoint snapshot
		// AHEAD of the committed chain, wrap an empty pending around it so
		// the snapshot's data lands in the committed chain. "Ahead" means
		// readLayer's parent chain leads back to `_currentCommittedLayer`
		// (i.e., the snapshot was forked off the current committed head).
		// If readLayer is instead a stale ancestor (e.g., the connection was
		// last seeing a TransactionLayer that has since been consolidated into
		// `baseLayer` by ALTER TABLE) or carries an out-of-date schema, leave
		// it alone — committing such a layer would supplant the schema-aware
		// committed head with stale data.
		let refusedSnapshotWrap = false;
		if (!connection.pendingTransactionLayer
			&& connection.readLayer !== this._currentCommittedLayer
			&& connection.readLayer instanceof TransactionLayer) {
			let walker: Layer | null = connection.readLayer.getParent();
			let isAhead = false;
			while (walker) {
				if (walker === this._currentCommittedLayer) {
					isAhead = true;
					break;
				}
				walker = walker.getParent();
			}
			if (isAhead) {
				if (connection.readLayer.getSchema() === this.tableSchema) {
					connection.pendingTransactionLayer = new TransactionLayer(connection.readLayer);
					if (this.eventEmitter?.hasDataListeners?.()) {
						connection.pendingTransactionLayer.enableChangeTracking();
					}
				} else {
					// A snapshot AHEAD of the head whose schema object nonetheless predates the
					// manager's: some schema-mutating arm failed to hand its new TableSchema to
					// the open layers (`adoptSchemaOnOpenLayers` and friends). Refusing the wrap
					// is still the safe call, but it discards every row the transaction staged,
					// so flag it for the warning below rather than let COMMIT report success over
					// a silent data loss.
					refusedSnapshotWrap = true;
				}
			}
		}

		const pendingLayer = connection.pendingTransactionLayer;
		if (!pendingLayer) {
			if (refusedSnapshotWrap) {
				logger.warn('Commit Transaction', this._tableName,
					'Discarding staged rows: savepoint snapshot carries a schema object older than the table\'s. A schema-mutating arm did not adopt its new schema on the open transaction layers.',
					{ schemaName: this.schemaName, connectionId: connection.connectionId });
			}
			// No pending — refresh readLayer to the current committed head so a
			// stale ancestor (post-schema-change) doesn't leak into the next
			// statement's view. (The ordinary read-only / no-writes commit lands
			// here too, which is why the warning above is gated.)
			connection.readLayer = this._currentCommittedLayer;
			return;
		}

		const lockKey = `MemoryTable.Commit:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		logger.debugLog(`[Commit ${connection.connectionId}] Acquired lock for ${this._tableName}`);
		try {
			// Relate the pending layer's chain to the current committed head.
			//
			// Case A — the head is an ancestor of the pending layer: pending forked
			//   off (a descendant of) the current head, so its chain already
			//   contains everything committed so far. Publish it wholesale.
			// Case B — the head advanced past the pending layer's fork point
			//   (a sibling connection committed a disjoint change to the same table
			//   in a coordinated multi-connection commit): pending and head share a
			//   common ancestor — the fork point — that is a *proper* ancestor of
			//   the head. Rebase pending's own writes onto the head so the sibling's
			//   already-committed rows are not discarded (the bug this guards).
			// Case C — no common ancestor reachable: a genuinely stale commit. Roll
			//   back with BUSY outside a coordinated commit (the caller can retry);
			//   inside one, preserve the prior wholesale fallback.
			let headIsAncestorOfPending = false;
			{
				let cur: Layer | null = pendingLayer;
				while (cur) {
					if (cur === this._currentCommittedLayer) { headIsAncestorOfPending = true; break; }
					cur = cur.getParent();
				}
			}

			let committedLayer: TransactionLayer;
			let changes: ReturnType<TransactionLayer['getPendingChanges']>;

			if (headIsAncestorOfPending) {
				// Case A: the un-emitted in-transaction event span ends at the head.
				changes = this.collectPendingChanges(pendingLayer, this._currentCommittedLayer);
				pendingLayer.markCommitted();
				committedLayer = pendingLayer;
			} else {
				// Find the fork point: the deepest layer present in BOTH chains.
				const headChain = this.layerChainSet(this._currentCommittedLayer);
				let forkPoint: Layer | null = pendingLayer.getParent();
				while (forkPoint && !headChain.has(forkPoint)) {
					forkPoint = forkPoint.getParent();
				}

				if (forkPoint) {
					// Schema drift: an ALTER consolidated the head to a different schema
					// since the pending layer forked. Replaying stale-schema rows onto
					// the new-schema head is unsafe — abort with BUSY rather than corrupt
					// the committed head (mirrors the stale-ancestor caution above).
					//
					// NOTE: `adoptSchemaOnOpenLayers` only walks the DDL connection's own chain,
					// so a SIBLING connection's pending layer keeps its creation-time schema
					// object even after a metadata-only change like `RENAME TO` that moves no
					// rows — which would make this arm fire spuriously. Not reachable from SQL
					// today: `renameTable` never calls `ensureSchemaChangeSafety`, and a single
					// Database runs one transaction at a time. If sibling connections ever hold
					// concurrent pending layers over one manager, compare column shape here
					// rather than schema-object identity.
					if (pendingLayer.getSchema() !== this.tableSchema) {
						connection.pendingTransactionLayer = null;
						connection.clearSavepoints();
						logger.warn('Commit Transaction', this._tableName, 'Schema drift under sibling commit, rolling back', { connectionId: connection.connectionId });
						throw new QuereusError(`Commit failed: schema changed under transaction on table ${this._tableName}. Retry.`, StatusCode.BUSY);
					}
					// Case B: rebase. Events come from the same fork-bounded pending-chain
					// span; structural writes are replayed onto the advanced head.
					changes = this.collectPendingChanges(pendingLayer, forkPoint);
					committedLayer = this.rebaseLayerOntoHead(pendingLayer, forkPoint);
				} else if (!this.db._inCoordinatedCommit()) {
					connection.pendingTransactionLayer = null;
					connection.clearSavepoints();
					logger.warn('Commit Transaction', this._tableName, 'Stale commit detected, rolling back', { connectionId: connection.connectionId });
					throw new QuereusError(`Commit failed: concurrent update on table ${this._tableName}. Retry.`, StatusCode.BUSY);
				} else {
					// Case C fallback inside a coordinated commit: no safe rebase target,
					// but aborting would roll back every connection. Preserve the prior
					// wholesale publish.
					changes = this.collectPendingChanges(pendingLayer, this._currentCommittedLayer);
					pendingLayer.markCommitted();
					committedLayer = pendingLayer;
				}
			}

			this._currentCommittedLayer = committedLayer;
			logger.debugLog(`[Commit ${connection.connectionId}] CurrentCommittedLayer set to ${committedLayer.getLayerId()} for ${this._tableName}`);
			connection.readLayer = committedLayer;
			connection.pendingTransactionLayer = null;
			connection.clearSavepoints();

			// Emit data change events after successful commit
			if (changes.length > 0 && this.eventEmitter?.emitDataChange) {
				// The event contract carries the PK as a component array. Derive the stored
				// key's shape from the PK arity, never from `Array.isArray` — a JSON PK whose
				// value is a document like `[1]` is a SCALAR key that happens to be a JS
				// array, and sniffing it would emit `[1]` where the contract wants `[[1]]`.
				// NOTE: on the tuple path this hands listeners the STORED key array itself
				// (`VTableDataChangeEvent.key` is mutable `SqlValue[]`, as it always was).
				// If a listener is ever seen mutating `event.key`, copy here — an in-place
				// edit would re-order the primary tree under the comparator.
				const eventKeyIsTuple = primaryKeyArity(this.tableSchema) !== 1;
				for (const change of changes) {
					const event: import('../../events.js').VTableDataChangeEvent = {
						type: change.type,
						schemaName: this.schemaName,
						tableName: this._tableName,
						key: keyParts(change.pk, eventKeyIsTuple) as SqlValue[],
						oldRow: change.oldRow,
						newRow: change.newRow,
					};

					// Add changedColumns for update events
					if (change.type === 'update' && change.oldRow && change.newRow) {
						event.changedColumns = this.computeChangedColumns(change.oldRow, change.newRow);
					}

					this.eventEmitter.emitDataChange(event);
				}
			}
		} finally {
			release();
			logger.debugLog(`[Commit ${connection.connectionId}] Released lock for ${this._tableName}`);
		}
	}

	/** All layers in `layer`'s parent chain, including `layer` itself. */
	private layerChainSet(layer: Layer): Set<Layer> {
		const chain = new Set<Layer>();
		let cur: Layer | null = layer;
		while (cur) {
			chain.add(cur);
			cur = cur.getParent();
		}
		return chain;
	}

	/**
	 * Collect pending change events from `fromLayer` up to (but not including)
	 * `boundary`, in chronological order (oldest layer first, intra-layer order
	 * preserved). Mirrors the in-transaction event span whose writes are being
	 * committed: savepoint-promoted ancestor layers whose events were never
	 * directly emitted are included; already-committed layers at/below the
	 * boundary are not (their events were emitted when they committed).
	 */
	private collectPendingChanges(fromLayer: Layer, boundary: Layer): ReturnType<TransactionLayer['getPendingChanges']> {
		const eventChunks: ReturnType<TransactionLayer['getPendingChanges']>[] = [];
		let layer: Layer | null = fromLayer;
		while (layer && layer !== boundary) {
			if (layer instanceof TransactionLayer) {
				const events = layer.getPendingChanges();
				if (events.length > 0) eventChunks.push(events);
			}
			layer = layer.getParent();
		}
		// Chunks are newest-layer-first; reverse to chronological order while
		// preserving intra-layer event order.
		return eventChunks.reverse().flat();
	}

	/**
	 * Rebase a pending layer onto the current committed head after a sibling
	 * connection advanced the head past this layer's fork point. Replays the
	 * pending chain's own structural writes (pending + in-transaction ancestors
	 * down to, but not including, `forkPoint`) onto a fresh {@link TransactionLayer}
	 * parented on the head, so the sibling's already-committed rows survive.
	 *
	 * The head becomes the new layer's base, so every row the sibling committed is
	 * inherited automatically; only this branch's own writes are replayed on top.
	 */
	private rebaseLayerOntoHead(pendingLayer: TransactionLayer, forkPoint: Layer): TransactionLayer {
		// Gather own-writes from pendingLayer up to (excluding) the fork point.
		// Chunks are newest-layer-first; reverse so the oldest layer replays first.
		const writeChunks: (readonly OwnWrite[])[] = [];
		let layer: Layer | null = pendingLayer;
		while (layer && layer !== forkPoint) {
			if (layer instanceof TransactionLayer) {
				writeChunks.push(layer.getOwnWrites());
			}
			layer = layer.getParent();
		}
		const ownWrites = writeChunks.reverse().flat();

		const rebased = new TransactionLayer(this._currentCommittedLayer);
		if (this.eventEmitter?.hasDataListeners?.()) {
			rebased.enableChangeTracking();
		}

		for (const write of ownWrites) {
			// Re-derive the effective row at this PK on the NEW head (including
			// earlier replays in this loop) and pass it as the old row, so
			// secondary-index maintenance removes the correct pre-existing entry.
			// NOTE: a primary key OR a secondary-UNIQUE value written by BOTH
			// siblings resolves last-writer-wins to the rebasing writer's row —
			// every non-contended key from both siblings survives. recordUpsert is
			// the raw structural write and does not re-run checkUniqueConstraints, so
			// a UNIQUE collision existing only BETWEEN the two siblings' rows is not
			// detected here. This matches the memory manager's read-your-own-writes
			// model (snapshot-isolation conflict detection lives in quereus-isolation).
			const effective = this.lookupEffectiveRow(write.primaryKey, rebased);
			if (write.type === 'upsert') {
				rebased.recordUpsert(write.primaryKey, write.newRow!, effective);
			} else if (effective) {
				rebased.recordDelete(write.primaryKey, effective);
			}
		}

		rebased.markCommitted();
		return rebased;
	}

	async tryCollapseLayers(): Promise<void> {
		const lockKey = `MemoryTable.Collapse:${this.schemaName}.${this._tableName}`;
		let release: (() => void) | null = null;
		try {
			const acquirePromise = this.db.latches.acquire(lockKey);
			const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)); // Short timeout
			const result = await Promise.race([
				acquirePromise.then(releaseFn => ({ release: releaseFn })),
				timeoutPromise.then(() => ({ release: null }))
			]);
			release = result.release;
			if (!release) {
				logger.debugLog(`[Collapse] Lock busy for ${this._tableName}, skipping.`);
				return;
			}
			logger.debugLog(`[Collapse] Acquired lock for ${this._tableName}`);
			let collapsedCount = 0;
			const maxCollapseIterations = 10; // Prevent infinite loops
			let iterations = 0;

			// Continue collapsing layers as long as it's safe to do so
			while (iterations < maxCollapseIterations &&
			       this._currentCommittedLayer instanceof TransactionLayer &&
			       this._currentCommittedLayer.isCommitted()) {

				const layerToPromote = this._currentCommittedLayer as TransactionLayer;
				const parentLayer = layerToPromote.getParent();
				if (!parentLayer) {
					logger.error('Collapse Layers', this._tableName, 'Committed TransactionLayer has no parent', { layerId: layerToPromote.getLayerId() });
					break;
				}

				// Check if anyone is still using the parent layer or any of its ancestors
				if (this.isLayerInUse(parentLayer)) {
					logger.debugLog(`[Collapse] Parent layer ${parentLayer.getLayerId()} or its ancestors in use. Cannot collapse layer ${layerToPromote.getLayerId()}.`);
					break;
				}

				logger.debugLog(`[Collapse] Promoting layer ${layerToPromote.getLayerId()} to become independent from parent ${parentLayer.getLayerId()} for ${this._tableName}`);

				// With inherited BTrees, "collapsing" means making the transaction layer independent
				// by calling clearBase() on its BTrees, effectively making it the new base data
				layerToPromote.clearBase();

				// Update connections that were reading from the collapsed parent layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === parentLayer) {
						// Update connections to read from the now-independent transaction layer
						conn.readLayer = layerToPromote;
						logger.debugLog(`[Collapse] Connection ${conn.connectionId} updated to read from independent layer ${layerToPromote.getLayerId()}`);
					}
				}

				collapsedCount++;
				iterations++;

				// The layer is now independent, but check if we can collapse further
				// by examining if this layer can be promoted above its (now detached) parent
				logger.debugLog(`[Collapse] Layer ${layerToPromote.getLayerId()} is now independent for ${this._tableName}`);
			}

			if (collapsedCount > 0) {
				logger.operation('Collapse Layers', this._tableName, { collapsedCount, iterations });
			} else {
				logger.debugLog(`[Collapse] No layers collapsed for ${this._tableName}. Current: ${this._currentCommittedLayer.getLayerId()}`);
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			logger.error('Collapse Layers', this._tableName, e);
		} finally {
			if (release) {
				release();
				logger.debugLog(`[Collapse] Released lock for ${this._tableName}`);
			}
		}
	}

	/**
	 * Checks if a layer is currently in use by any connections.
	 * This includes checking if any connection is reading from the layer,
	 * has it as a pending transaction layer, or has it as a savepoint.
	 */
	private isLayerInUse(layer: Layer): boolean {
		for (const conn of this.connections.values()) {
			// Check if connection is reading from this layer
			if (conn.readLayer === layer) {
				return true;
			}

			// Check if connection has this layer as pending transaction
			if (conn.pendingTransactionLayer === layer) {
				return true;
			}

			// Check if connection has this layer in its parent chain
			let currentLayer = conn.pendingTransactionLayer?.getParent();
			while (currentLayer) {
				if (currentLayer === layer) {
					return true;
				}
				if (currentLayer instanceof TransactionLayer) {
					currentLayer = currentLayer.getParent();
				} else {
					break;
				}
			}
		}
		return false;
	}

	// With inherited BTrees, lookupEffectiveRow is much simpler
	public lookupEffectiveRow(primaryKey: BTreeKeyForPrimary, startLayer: Layer): Row | null {
		// With inherited BTrees, a simple get() will traverse the inheritance chain automatically
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(primaryKey);
		return result === undefined ? null : result as Row;
	}

	// Simplified for compatibility, though less relevant with inherited BTrees
	lookupEffectiveValue(key: BTreeKeyForPrimary, indexName: string | 'primary', startLayer: Layer): Row | null {
		if (indexName !== 'primary') {
			logger.error('lookupEffectiveValue', this._tableName, 'Currently only supports primary index for MemoryTableManager');
			return null;
		}
		const primaryTree = startLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		const result = primaryTree.get(key);
		return result === undefined ? null : result;
	}

	public async performMutation(
		connection: MemoryTableConnection,
		operation: 'insert' | 'update' | 'delete',
		values: Row | undefined,
		oldKeyValues?: Row,
		onConflict?: ConflictResolution,
		preCoerced?: boolean
	): Promise<UpdateResult> {
		this.validateMutationPermissions(operation);

		const wasExplicitTransaction = connection.explicitTransaction;
		this.ensureTransactionLayer(connection);

		const targetLayer = connection.pendingTransactionLayer!;

		let result: UpdateResult;

		switch (operation) {
			case 'insert':
				result = await this.performInsert(targetLayer, values, onConflict, preCoerced);
				break;
			case 'update':
				result = await this.performUpdate(targetLayer, values, oldKeyValues, onConflict, preCoerced);
				break;
			case 'delete':
				result = await this.performDelete(targetLayer, oldKeyValues);
				break;
			default: {
				const exhaustiveCheck: never = operation;
				throw new QuereusError(`Unsupported operation: ${exhaustiveCheck}`, StatusCode.INTERNAL);
			}
		}

		// Auto-commit if we weren't already in an explicit transaction
		// Note: We commit even on constraint violations when IGNORE mode, as the row was simply skipped
		if (!wasExplicitTransaction && this.db.getAutocommit()) {
			await this.commitTransaction(connection);
		}

		return result;
	}

	private validateMutationPermissions(_operation: 'insert' | 'update' | 'delete'): void {
		if (this.isReadOnly) {
			throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		}
	}

	private ensureTransactionLayer(connection: MemoryTableConnection): void {
		if (!connection.pendingTransactionLayer) {
			// Lazily create a new TransactionLayer parented on the connection's
			// current readLayer (not the manager's _currentCommittedLayer).
			// In the clean autocommit case the two are identical. After an
			// eager-snapshot savepoint, readLayer is the immutable snapshot
			// containing all in-transaction writes up to that point, so the
			// new pending inherits those rows and reads-your-own-writes still
			// works, while SELECTs iterating the snapshot don't see the new
			// pending's mutations.
			connection.pendingTransactionLayer = new TransactionLayer(connection.readLayer);

			// Enable change tracking if there are data listeners
			if (this.eventEmitter?.hasDataListeners?.()) {
				connection.pendingTransactionLayer.enableChangeTracking();
			}

			// If this method is called from a DML statement outside an explicit BEGIN, the
			// transaction is auto-created (autocommit mode).  Leave explicitTransaction flag as-is.
		}
	}

	private async performInsert(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		onConflict: ConflictResolution | undefined,
		preCoerced?: boolean
	): Promise<UpdateResult> {
		if (!values) {
			throw new QuereusError("INSERT requires values.", StatusCode.MISUSE);
		}

		// Validate and parse values according to column types. Skip when the caller
		// already converted to declared form and says so via preCoerced — the DML
		// executor (whose emitters convert by static type at the top of the pipeline)
		// and the isolation overlay's flush/tombstone writes. JSON conversion is not
		// idempotent, so re-running it can throw or silently change the value. Direct
		// API callers leave the flag unset and this conversion remains their contract.
		// NOTE: skipping it also skips that helper's "too many values" width guard. Every
		// preCoerced caller today builds its row from this same schema's column order
		// (the DML builders project the source into full table-column shape), so the
		// width is structural; if an externally-shaped row ever reaches here preCoerced,
		// hoist the width check out of coerceRowToSchema and run it unconditionally.
		const schema = targetLayer.getSchema();
		const newRowData: Row = preCoerced ? values : coerceRowToSchema(values, schema.columns, `INSERT into ${this._tableName}`);
		const primaryKey = this.primaryKeyFromRow(newRowData);
		const existingRow = this.lookupEffectiveRow(primaryKey, targetLayer);

		if (existingRow !== null) {
			// Resolve PK-conflict action: statement OR > per-constraint default > ABORT.
			const pkAction = onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;
			if (pkAction === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (pkAction === ConflictResolution.REPLACE) {
				targetLayer.recordUpsert(primaryKey, newRowData, existingRow);
				return { status: 'ok', row: newRowData, replacedRow: existingRow };
			}
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} PK.`,
				existingRow: existingRow
			};
		}

		// Check UNIQUE constraints against secondary indexes. Secondary-UNIQUE
		// REPLACE evictions (rows at OTHER PKs) accumulate in `evicted` and are
		// surfaced via `evictedRows` so the DML executor runs the full delete
		// pipeline (change-tracking, row-time MV maintenance, FK cascade, events).
		const evicted: Row[] = [];
		const ucResult = await this.checkUniqueConstraints(targetLayer, schema, newRowData, primaryKey, onConflict, evicted);
		if (ucResult) return ucResult;

		targetLayer.recordUpsert(primaryKey, newRowData, null);
		return { status: 'ok', row: newRowData, evictedRows: evicted.length > 0 ? evicted : undefined };
	}

	private async performUpdate(
		targetLayer: TransactionLayer,
		values: Row | undefined,
		oldKeyValues: Row | undefined,
		onConflict: ConflictResolution | undefined,
		preCoerced?: boolean
	): Promise<UpdateResult> {
		if (!values || !oldKeyValues) {
			throw new QuereusError("UPDATE requires new values and old key values.", StatusCode.MISUSE);
		}

		// Validate and parse values according to column types. Skip when preCoerced
		// (see performInsert).
		const schema = targetLayer.getSchema();
		const newRowData: Row = preCoerced ? values : coerceRowToSchema(values, schema.columns, `UPDATE on ${this._tableName}`);
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) {
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			logger.warn('UPDATE', this._tableName, 'Target row not found', {
				primaryKey: oldKeyValues.join(',')
			});
			return { status: 'ok', row: undefined };
		}

		const newPrimaryKey = this.primaryKeyFromRow(newRowData);
		const isPrimaryKeyChanged = this.comparePrimaryKeys(targetPrimaryKey, newPrimaryKey) !== 0;

		if (isPrimaryKeyChanged) {
			return this.performUpdateWithPrimaryKeyChange(targetLayer, schema, targetPrimaryKey, newPrimaryKey, oldRowData, newRowData, onConflict);
		} else {
			// Check UNIQUE constraints if any constrained columns changed. A
			// secondary-UNIQUE REPLACE evicts the conflicting row(s) at other PKs;
			// surface them via `evictedRows` for the executor's delete pipeline.
			const evicted: Row[] = [];
			if (this.uniqueColumnsChanged(schema, oldRowData, newRowData)) {
				const ucResult = await this.checkUniqueConstraints(targetLayer, schema, newRowData, targetPrimaryKey, onConflict, evicted);
				if (ucResult) return ucResult;
			}
			targetLayer.recordUpsert(targetPrimaryKey, newRowData, oldRowData);
			return { status: 'ok', row: newRowData, evictedRows: evicted.length > 0 ? evicted : undefined };
		}
	}

	private async performUpdateWithPrimaryKeyChange(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		oldPrimaryKey: BTreeKeyForPrimary,
		newPrimaryKey: BTreeKeyForPrimary,
		oldRowData: Row,
		newRowData: Row,
		onConflict: ConflictResolution | undefined
	): Promise<UpdateResult> {
		const existingRowAtNewKey = this.lookupEffectiveRow(newPrimaryKey, targetLayer);

		if (existingRowAtNewKey !== null) {
			const pkAction = onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;
			if (pkAction === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (pkAction === ConflictResolution.REPLACE) {
				// Evict the row currently at the new PK, then move the updated row.
				targetLayer.recordDelete(newPrimaryKey, existingRowAtNewKey);
				targetLayer.recordDelete(oldPrimaryKey, oldRowData);
				targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
				return { status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey };
			}
			// Return constraint violation with existing row
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed on new PK for ${this._tableName}.`,
				existingRow: existingRowAtNewKey
			};
		}

		// Delete old row first, then check UNIQUE constraints at the new position.
		// A secondary-UNIQUE REPLACE at the new position evicts conflicting row(s)
		// at other PKs; surface them via `evictedRows` for the executor pipeline.
		targetLayer.recordDelete(oldPrimaryKey, oldRowData);

		const evicted: Row[] = [];
		const ucResult = await this.checkUniqueConstraints(targetLayer, schema, newRowData, newPrimaryKey, onConflict, evicted);
		if (ucResult) {
			// Rollback the delete if constraint check fails
			targetLayer.recordUpsert(oldPrimaryKey, oldRowData, null);
			return ucResult;
		}

		targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
		return { status: 'ok', row: newRowData, evictedRows: evicted.length > 0 ? evicted : undefined };
	}

	private async performDelete(
		targetLayer: TransactionLayer,
		oldKeyValues: Row | undefined
	): Promise<UpdateResult> {
		if (!oldKeyValues) {
			throw new QuereusError("DELETE requires key values.", StatusCode.MISUSE);
		}

		const schema = targetLayer.getSchema();
		const targetPrimaryKey = buildPrimaryKeyFromValues(oldKeyValues, schema.primaryKeyDefinition);
		const oldRowData = this.lookupEffectiveRow(targetPrimaryKey, targetLayer);

		if (!oldRowData) {
			return { status: 'ok', row: undefined };
		}

		targetLayer.recordDelete(targetPrimaryKey, oldRowData);
		return { status: 'ok', row: oldRowData };
	}

	/**
	 * Returns true if any column covered by a UNIQUE constraint changed between
	 * old and new rows, or if any column referenced by a partial-UNIQUE predicate
	 * changed (which may transition the row into or out of the predicate's scope).
	 *
	 * NOTE: the per-column test is byte-level `compareSqlValues`, not the enforcement
	 * comparator, so it OVER-triggers for a semantic-ordering column: rewriting a
	 * TIMESPAN 'PT1H' to 'PT60M' reports "changed" and re-runs the UNIQUE check, which
	 * then excludes the row's own primary key and passes. Correct — this only gates
	 * whether to re-check — just not minimal. If UPDATE-heavy workloads over
	 * semantic-ordering UNIQUE columns ever show the redundant re-check as hot, route
	 * this through `uniqueEnforcementComparators` too.
	 */
	private uniqueColumnsChanged(schema: TableSchema, oldRow: Row, newRow: Row): boolean {
		if (!schema.uniqueConstraints) return false;
		for (const uc of schema.uniqueConstraints) {
			for (const colIdx of uc.columns) {
				if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
			}
			if (uc.predicate) {
				const covering = this.findIndexForConstraint(this._currentCommittedLayer, uc);
				// For an index the compiled predicate is already on hand; for an MV-covered
				// (or uncovered) constraint, compile the partial predicate ad hoc to learn
				// which columns can transition the row across the predicate's scope.
				const referenced = covering?.kind === 'memory-index'
					? covering.index.predicate?.referencedColumns
					: compilePredicate(uc.predicate, schema.columns, schema.name).referencedColumns;
				if (referenced) {
					for (const colIdx of referenced) {
						if (compareSqlValues(oldRow[colIdx], newRow[colIdx]) !== 0) return true;
					}
				}
			}
		}
		return false;
	}

	/**
	 * Checks all UNIQUE constraints for a new/updated row. Returns an UpdateResult
	 * if a violation is found (or IGNORE suppresses the insert), or null if all pass.
	 * For REPLACE conflicts, the conflicting rows are deleted from the layer and
	 * pushed onto `evicted` so the DML executor can run the full delete pipeline
	 * (change-tracking, row-time MV maintenance, FK cascade, auto-events) for each.
	 */
	private async checkUniqueConstraints(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution | undefined,
		evicted: Row[]
	): Promise<UpdateResult | null> {
		if (!schema.uniqueConstraints) return null;

		for (const uc of schema.uniqueConstraints) {
			const result = await this.checkSingleUniqueConstraint(
				targetLayer, schema, uc, newRowData, newPrimaryKey, onConflict, evicted
			);
			if (result) return result;
		}

		return null;
	}

	private async checkSingleUniqueConstraint(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution | undefined,
		evicted: Row[],
		allowMvCovering = true
	): Promise<UpdateResult | null> {
		// SQL semantics: UNIQUE allows multiple NULLs — skip if any constrained column is NULL
		if (uc.columns.some(colIdx => newRowData[colIdx] === null)) return null;

		// Find the covering structure enforcing this constraint.
		const covering = this.findIndexForConstraint(targetLayer, uc, allowMvCovering);

		// Partial UNIQUE: a row whose predicate is not unambiguously TRUE is outside
		// the structure's scope and contributes nothing to uniqueness. The source-side
		// skip must short-circuit identically regardless of which structure covers the
		// constraint — for the MV path the partial scope is governed by the (aligned)
		// `uc.predicate` (the prover proves the MV's WHERE equivalent to it).
		if (covering?.kind === 'memory-index'
			&& covering.index.predicate
			&& !covering.index.rowMatchesPredicate(newRowData)) {
			return null;
		}
		if (covering?.kind === 'materialized-view'
			&& uc.predicate
			&& compilePredicate(uc.predicate, schema.columns, schema.name).evaluate(newRowData) !== true) {
			return null;
		}

		// Resolve effective action: statement OR > constraint default > ABORT.
		const effective = onConflict ?? uc.defaultConflict ?? ConflictResolution.ABORT;

		if (covering) {
			switch (covering.kind) {
				case 'memory-index':
					return this.checkUniqueViaIndex(targetLayer, schema, uc, covering.index, newRowData, newPrimaryKey, effective, evicted);
				case 'materialized-view':
					return this.checkUniqueViaMaterializedView(targetLayer, schema, uc, covering.view, newRowData, newPrimaryKey, effective, evicted);
				default: {
					const exhaustive: never = covering;
					throw new QuereusError(`Unknown covering structure: ${JSON.stringify(exhaustive)}`, StatusCode.INTERNAL);
				}
			}
		}

		// Fallback: scan primary tree
		return this.checkUniqueByScanning(targetLayer, schema, uc, newRowData, newPrimaryKey, effective, evicted);
	}

	/**
	 * Resolves the {@link CoveringStructure} enforcing a UNIQUE constraint. Prefers
	 * a linked, non-stale row-time covering MV when one is present (the live
	 * enforcement path in v1; the sole structure once the auto-index is
	 * retired — see {@link CoveringStructure}), falling back to the auto-built
	 * `memory-index`. The row-time resolution is a synchronous map lookup with an
	 * O(1) negative fast path, so a non-covered table stays on the index path at
	 * effectively no cost.
	 *
	 * `allowMvCovering = false` skips the MV preference: the maintenance-write
	 * enforcement path ({@link enforceSecondaryUniqueOnMaintenance}) checks rows
	 * THIS table's batch just wrote, and a covering MV over this table is
	 * cascade-maintained only after the batch returns — it lags the batch and
	 * would miss a same-batch colliding pair. The synchronously-maintained
	 * auto-index is exact.
	 */
	private findIndexForConstraint(
		targetLayer: Layer,
		uc: UniqueConstraintSchema,
		allowMvCovering = true
	): CoveringStructure | undefined {
		if (allowMvCovering) {
			const mv = this.db._findRowTimeCoveringStructure(this.schemaName, this._tableName, uc);
			if (mv) return { kind: 'materialized-view', view: mv };
		}

		const schema = targetLayer.getSchema();
		if (!schema.indexes) return undefined;

		// Resolve the constraint's OWN realizing structure BY NAME — never the
		// column-set scan below, which returns the FIRST same-column-set index and
		// (when several differently-collated indexes cover one column-set) would
		// enforce a UC under the wrong index's collation, generating candidates from
		// that index's wrongly-keyed BTree:
		//  - index-derived UNIQUE (`CREATE UNIQUE INDEX`) → its own index name via
		//    `uc.derivedFromIndex` (matches store/isolation's by-name resolution
		//    through `uniqueEnforcementCollations`).
		//  - non-derived UNIQUE (table-level / column) → its own `_uc_*` covering
		//    index via `implicitCoveringStructures`. The realization guard only
		//    reuses a collation-equivalent same-column-set index, so a pre-existing
		//    finer index (e.g. BINARY over a NOCASE column) no longer collapses onto
		//    the constraint; resolving by name is robust to `schema.indexes` order
		//    (the finer index may be listed earlier, having been created first).
		// Both fall through to the column-set scan only when the name does not
		// resolve (defensive).
		if (uc.derivedFromIndex) {
			const index = targetLayer.getSecondaryIndex?.(uc.derivedFromIndex);
			if (index) return { kind: 'memory-index', index };
		} else {
			const own = this.getImplicitCoveringStructure(uc);
			if (own) {
				const index = targetLayer.getSecondaryIndex?.(own.indexName);
				if (index) return { kind: 'memory-index', index };
			}
		}

		// Defensive fallback: match the auto-built `_uc_*` covering index by
		// column-set when the by-name resolution above did not land.
		for (const idx of schema.indexes) {
			if (idx.columns.length === uc.columns.length &&
				idx.columns.every((col, i) => col.index === uc.columns[i])) {
				const index = targetLayer.getSecondaryIndex?.(idx.name);
				return index ? { kind: 'memory-index', index } : undefined;
			}
		}
		return undefined;
	}

	private checkUniqueViaIndex(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		index: MemoryIndex,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution,
		evicted: Row[]
	): UpdateResult | null {
		const indexKey = index.keyFromRow(newRowData);
		const existingPKs = index.getPrimaryKeys(indexKey);
		// The overwhelmingly common insert has no candidate at all; bail before paying
		// for the collation resolves below.
		if (existingPKs.length === 0) return null;

		// Resolve the per-column enforcement collations once, ahead of the candidate loop
		// (which collation governs, and why, is spelled out at the compare below), then
		// build the per-column comparators from them through the shared helper the store
		// and isolation re-validators also use.
		const enforcementCollations = uc.columns.map((col, i) =>
			this.collationResolver(index.specColumns[i]?.collation ?? schema.columns[col].collation ?? 'BINARY'));
		const compares = uniqueEnforcementComparators(schema.columns, uc.columns, enforcementCollations);

		for (const existingPK of existingPKs) {
			if (this.comparePrimaryKeys(newPrimaryKey, existingPK) === 0) continue;

			// Validate the candidate against the live effective row before acting —
			// the same stale-candidate discipline as checkUniqueViaMaterializedView.
			// An index entry's PK can still lag the effective row set *within* a
			// statement (a candidate row deleted/updated internally, or a prior
			// REPLACE eviction whose index removal lands later in the batch), so a
			// candidate whose row is gone, no longer carries the colliding values,
			// or left a partial index's scope is skipped rather than raised as a
			// false conflict (or, worse, REPLACE-evicting an innocent row). The
			// entry now tracks PKs by value (removeEntry drops composite PKs
			// correctly, so it no longer accumulates stale-by-reference members);
			// this live re-check remains as defense-in-depth for that genuine
			// intra-statement lag.
			// Compare under the INDEX's per-column collation (positionally aligned
			// with uc.columns — findIndexForConstraint requires it): the index is
			// the enforcing structure, and an explicit `create unique index …
			// (col collate nocase)` may declare a coarser collation than the
			// column — re-checking under the column's collation would skip the
			// case-variant candidates the index legitimately unifies. A
			// semantic-ordering column (TIMESPAN, JSON) compares through its
			// declared type's `compare` instead, so the re-check agrees with the
			// typed BTree that produced the candidate — without it a 'PT60M' probe
			// found the 'PT1H' row's PK and then discarded it as unequal, and the
			// duplicate was admitted.
			// This is the authoritative LIVE-index source for the per-column
			// enforcement collation. The shared `uniqueEnforcementCollations(schema,
			// uc)` helper (which store/isolation import, and checkUniqueViaMaterializedView
			// uses) resolves the SAME per-column value, but BY NAME via
			// `uc.derivedFromIndex`. `findIndexForConstraint` now ALSO resolves an
			// index-derived UC by that name (the column-set scan is only the
			// non-derived fallback), so the live `index` handle here IS the UC's own
			// index and `index.specColumns[i]?.collation` is the correct per-column
			// collation even when several same-column-set indexes exist with
			// differing collations. The `(schema, uc)` helper signature still has no
			// MemoryIndex handle, so this site keeps the live-handle read — but the
			// two resolutions now agree on the multi-index shape too. The agreement is
			// pinned by test/unique-enforcement-collation.spec.ts (a real divergence
			// is a finding, not a reason to widen the helper).
			const conflictingRow = this.lookupEffectiveRow(existingPK, targetLayer);
			if (!conflictingRow) continue;
			if (!uc.columns.every((col, i) => compares[i](newRowData[col], conflictingRow[col]) === 0)) continue;
			if (index.predicate && !index.rowMatchesPredicate(conflictingRow)) continue;

			// Found a different live row with the same unique key values
			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				targetLayer.recordDelete(existingPK, conflictingRow);
				// Report the eviction so the executor runs its delete pipeline.
				evicted.push(conflictingRow);
				continue; // conflict resolved, keep scanning for further duplicates
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} (${colNames})`,
				existingRow: conflictingRow
			};
		}

		return null;
	}

	/**
	 * Enforce a UNIQUE constraint through its linked `row-time` covering MV's backing
	 * table (mirrors {@link checkUniqueViaIndex}, but the candidates come from the MV
	 * rather than a secondary BTree). The backing scan yields candidate conflicting
	 * source PKs; each is *validated against the live source row* before acting, since
	 * a backing entry can lag a source row deleted/updated internally within the same
	 * statement (e.g. the PK-changing-UPDATE delete below, or a prior REPLACE eviction)
	 * — the row-time hook only fires for DML-executor row writes, not these internal
	 * mutations. A candidate whose source row is gone or no longer matches the UC is
	 * stale and skipped, so a false conflict is never raised.
	 *
	 * On a REPLACE eviction the conflicting **source** row is deleted directly on the
	 * transaction layer and pushed onto `evicted`; the DML executor then runs the full
	 * delete pipeline for it (change-tracking, FK cascade, auto-events, and the
	 * row-time covering-structure maintenance that removes the evicted row's backing
	 * entry — so a later same-UC row in the statement never sees a phantom). The
	 * executor processes the eviction before the writing row's own bookkeeping, so the
	 * backing delete still lands within this statement.
	 */
	private async checkUniqueViaMaterializedView(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		mv: MaintainedTableSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution,
		evicted: Row[]
	): Promise<UpdateResult | null> {
		// Component-array view of the source PK. Shape comes from the PK arity, never
		// from `Array.isArray` — a single-column JSON PK holding a document like `[1]`
		// is a scalar key that is also a JS array (see the `BTreeKey` invariant).
		// A wrong shape here only WIDENS the candidate set (the row fails its own
		// self-exclusion), and the loop below re-excludes self through the real PK
		// comparator — which is why no query result can observe this line.
		const newSourcePk = keyParts(newPrimaryKey, primaryKeyArity(schema) !== 1) as SqlValue[];
		const conflicts = await this.db._lookupCoveringConflicts(mv, uc, newRowData, newSourcePk);
		// Re-validate under each column's enforcement collation — the index's per-column
		// COLLATE for an index-derived UNIQUE, else the declared column collation
		// (uniqueEnforcementCollations) — mirroring checkUniqueViaIndex, the store's
		// findUniqueConflictViaCoveringMv, and the isolation overlay, so all modules agree.
		// The candidate generation (_lookupCoveringConflicts) narrows under the SOURCE
		// column's DECLARED collation, so for a FINER index (e.g. BINARY over a NOCASE
		// column) it returns a superset this filters down correctly; a finer/incomparable
		// index-derived UNIQUE whose declared candidate set could be a subset is declined
		// upstream by findRowTimeCoveringStructure's collation gate, so only BINARY-floor
		// or equal-collation MVs ever reach here.
		// A semantic-ordering column (TIMESPAN, JSON) re-checks through its declared
		// type's `compare` rather than the collation — same rule the index path and both
		// out-of-package re-validators follow, via the shared helper.
		const collations = uniqueEnforcementCollations(schema, uc).map(name => this.collationResolver(name ?? 'BINARY'));
		const compares = uniqueEnforcementComparators(schema.columns, uc.columns, collations);

		for (const conflict of conflicts) {
			const existingPK = buildPrimaryKeyFromValues(conflict.pk, schema.primaryKeyDefinition);
			if (this.comparePrimaryKeys(newPrimaryKey, existingPK) === 0) continue;

			// Validate against the live source row: skip stale backing candidates.
			const conflictingRow = this.lookupEffectiveRow(existingPK, targetLayer);
			if (!conflictingRow) continue;
			if (!uc.columns.every((col, i) => compares[i](newRowData[col], conflictingRow[col]) === 0)) continue;

			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				targetLayer.recordDelete(existingPK, conflictingRow);
				// Report the eviction; the executor maintains the covering backing.
				evicted.push(conflictingRow);
				continue; // conflict resolved, keep scanning for further duplicates
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} (${colNames})`,
				existingRow: conflictingRow
			};
		}

		return null;
	}

	private checkUniqueByScanning(
		targetLayer: TransactionLayer,
		schema: TableSchema,
		uc: UniqueConstraintSchema,
		newRowData: Row,
		newPrimaryKey: BTreeKeyForPrimary,
		onConflict: ConflictResolution,
		evicted: Row[]
	): UpdateResult | null {
		const primaryTree = targetLayer.getModificationTree('primary');
		if (!primaryTree) return null;

		// Compile partial-UNIQUE predicate ad-hoc (cold path: an auto-index normally
		// services this check, so this branch fires only for pathological schemas).
		const predicate = uc.predicate
			? compilePredicate(uc.predicate, schema.columns, schema.name)
			: undefined;

		// One resolve per column, not per scanned row. A semantic-ordering column
		// (TIMESPAN, JSON) compares through its declared type's `compare` instead of the
		// collation — the shared rule across all three backends.
		//
		// NOTE: the collations come from the DECLARED column collation, not from
		// `uniqueEnforcementCollations(schema, uc)` as the index and MV paths use. For an
		// index-derived UNIQUE (`create unique index … collate x`) the two disagree — this
		// path would enforce under the column's collation instead of the index's. Harmless
		// today: this fallback fires only when no covering structure resolves at all, and
		// an index-derived UC always resolves its own index. If a shape ever reaches here
		// with `uc.derivedFromIndex` set, switch this line to the shared resolver.
		const collations = uc.columns.map(colIdx => this.collationResolver(schema.columns[colIdx].collation ?? 'BINARY'));
		const compares = uniqueEnforcementComparators(schema.columns, uc.columns, collations);

		for (const path of primaryTree.ascending(primaryTree.first())) {
			const existingRow = primaryTree.at(path)!;
			const existingPK = this.primaryKeyFromRow(existingRow);
			if (this.comparePrimaryKeys(newPrimaryKey, existingPK) === 0) continue;

			if (predicate && predicate.evaluate(existingRow) !== true) continue;

			const allMatch = uc.columns.every(
				(colIdx, i) => compares[i](newRowData[colIdx], existingRow[colIdx]) === 0
			);
			if (!allMatch) continue;

			if (onConflict === ConflictResolution.IGNORE) {
				return { status: 'ok', row: undefined };
			}
			if (onConflict === ConflictResolution.REPLACE) {
				targetLayer.recordDelete(existingPK, existingRow);
				// Report the eviction so the executor runs its delete pipeline.
				evicted.push(existingRow);
				return null;
			}
			const colNames = uc.columns.map(i => schema.columns[i].name).join(', ');
			return {
				status: 'constraint',
				constraint: 'unique',
				message: `UNIQUE constraint failed: ${this._tableName} (${colNames})`,
				existingRow: existingRow
			};
		}

		return null;
	}

	public renameTable(newName: string): void {
		logger.operation('Rename Table', this._tableName, { newName });
		const renamed = Object.freeze({ ...this.tableSchema, name: newName });

		// Re-key the Database connection registry FIRST, while it still answers to the old
		// name. Every registry lookup below (`adoptSchemaOnOpenLayers` walks
		// `openTransactionLayersOldestFirst` -> `ddlConnection` -> `registeredConnections`)
		// keys on `<schema>.<current name>`, so a sweep run after `_tableName` moves would
		// match nothing and silently no-op.
		this.rekeyRegisteredConnections(this._tableName, newName);

		this._tableName = newName;
		this.tableSchema = renamed;
		this.baseLayer.tableSchema = renamed;

		// Hand the renamed schema to the open transaction's layers, like every other
		// schema-mutating arm. A rename rebuilds no `IndexSchema`, so `adoptSchema` is the
		// right (cheapest) level — each layer keeps its `MemoryIndex` and only swaps the
		// schema pointer; the reshape pair ADD/DROP COLUMN need would be pure overhead.
		// Skipping it leaves an eager savepoint snapshot on its frozen pre-rename schema
		// object, which fails `commitTransaction`'s snapshot-wrap identity check
		// (`readLayer.getSchema() === this.tableSchema`) and drops the transaction's staged
		// rows at COMMIT.
		this.adoptSchemaOnOpenLayers(renamed);

		// Emit schema change event
		this.eventEmitter?.emitSchemaChange?.({
			type: 'alter',
			objectType: 'table',
			schemaName: this.schemaName,
			objectName: newName,
		});
	}

	/** Iterates all committed rows from the current committed layer (for rebuild). */
	scanAllRows(): Row[] {
		const tree = this._currentCommittedLayer.getModificationTree('primary');
		if (!tree) return [];
		const rows: Row[] = [];
		for (const path of tree.ascending(tree.first())) {
			rows.push(tree.at(path)!);
		}
		return rows;
	}

	/** Inserts a row directly into the base layer (for rebuild, bypasses transaction).
	 *  Throws on duplicate primary key. */
	insertRow(row: Row): void {
		const key = this.primaryKeyFunctions.extractFromRow(row);
		const path = this.baseLayer.primaryTree.find(key);
		if (path.on) {
			throw new QuereusError(
				`UNIQUE constraint failed: ${this._tableName} PK.`,
				StatusCode.CONSTRAINT,
			);
		}
		this.baseLayer.primaryTree.insert(row);
	}

	/**
	 * Atomically replaces the entire committed contents with `rows` by building a
	 * fresh {@link BaseLayer} and swapping it in under the SchemaChange latch.
	 * Used to (re)materialize a materialized view: callers run the view body to
	 * completion and hand the result rows here. Concurrent readers do NOT block:
	 * each scan reads a base-layer snapshot captured at start-of-call, so an
	 * in-flight scan keeps the pre-swap base while a fresh scan sees the new base
	 * — never a partial state. The swap itself is a single synchronous assignment
	 * performed under the SchemaChange latch (which serializes swaps with `alter
	 * table` and other refreshes, not with readers).
	 *
	 * Throws on a duplicate primary key among `rows` (the caller rolls back).
	 * Callers may pass `onDuplicateKey` to substitute a purpose-built diagnostic
	 * for the duplicate-PK case (e.g. the materialized-view "must be a set"
	 * message); when omitted, the generic backing-table message is thrown. The
	 * factory only controls the wording — duplicate detection still uses the
	 * btree's collation/desc/composite-correct key comparison.
	 */
	async replaceBaseLayer(
		rows: readonly Row[],
		onDuplicateKey?: () => QuereusError,
	): Promise<void> {
		if (this.isReadOnly) {
			throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		}
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		try {
			// Drain any in-flight transaction layers down to the base so the swap
			// below isn't shadowed by a committed transaction layer ahead of base.
			await this.ensureSchemaChangeSafety();

			const oldBase = this.baseLayer;
			const newBase = new BaseLayer(this.tableSchema, this.collationResolver);
			for (const row of rows) {
				const key = this.primaryKeyFunctions.extractFromRow(row);
				const path = newBase.primaryTree.find(key);
				if (path.on) {
					throw onDuplicateKey
						? onDuplicateKey()
						: new QuereusError(
							`UNIQUE constraint failed: ${this._tableName} PK.`,
							StatusCode.CONSTRAINT,
						);
				}
				newBase.primaryTree.insert(row);
			}
			newBase.rebuildAllSecondaryIndexes();

			this.baseLayer = newBase;
			this._currentCommittedLayer = newBase;

			// Re-point any connection still reading the old base at the new base so
			// the next statement observes refreshed contents.
			for (const conn of this.connections.values()) {
				if (conn.readLayer === oldBase) {
					conn.readLayer = newBase;
				}
			}
		} finally {
			release();
		}
	}

	/**
	 * Privileged **transactional** maintenance write: apply an ordered
	 * {@link MaintenanceOp} batch to a given connection's *pending*
	 * {@link TransactionLayer} (creating it lazily, exactly as a user write would).
	 * The row-time materialized-view maintenance path uses it so a covering
	 * structure's backing table is kept consistent synchronously with each source
	 * row-write — within the same transaction, visible to later reads on this
	 * connection (reads-own-writes), and committed/rolled-back in lockstep with the
	 * source write by the Database's coordinated commit.
	 *
	 * It deliberately bypasses {@link validateMutationPermissions} (which throws
	 * READONLY for MV backing tables) and reuses {@link TransactionLayer.recordUpsert} /
	 * {@link TransactionLayer.recordDelete} so secondary-index and change-tracking
	 * bookkeeping stay correct. No latch is taken: the pending layer is private to
	 * `connection`, only this synchronous path writes it, and the tree mutations are
	 * synchronous — so a multi-row statement's later rows observe earlier rows'
	 * pending writes with no interleaving.
	 *
	 * Declared secondary UNIQUE constraints ARE enforced — post-batch, against the
	 * final effective contents, throwing the maintained-table-attributed
	 * CONSTRAINT error ({@link enforceSecondaryUniqueOnMaintenance}). CHECK / FK
	 * stay engine-validated (see `vtab/backing-host.ts` § Constraint validation).
	 *
	 * Returns the **effective** changes it applied (one {@link BackingRowChange} per
	 * backing row it mutated): a `delete-key` that found a row → `delete`; an `upsert` →
	 * `update` when it replaced an existing row, else `insert`; a `delete-by-prefix` →
	 * one `delete` per matched row; a `replace-all` → the minimal keyed diff between the
	 * new and old contents (insert/update/delete, identical rows skipped). A
	 * `delete-key`/`delete-by-prefix` that matches nothing, an `upsert` whose row is
	 * **value-identical** to the effective existing row (`rowsValueIdentical` — written
	 * nothing, reported nothing; the normative skip in `vtab/backing-host.ts`), or a
	 * `replace-all` whose new contents equal the old — produces nothing. The MV-over-MV
	 * cascade feeds these onward to MVs reading this backing table (see
	 * `database-materialized-views.ts` § cascade).
	 *
	 * Async only because `delete-by-prefix` / `replace-all` reuse the async layer scan to
	 * enumerate the affected (prefix / whole-table) slice; the point ops stay synchronous
	 * within the same pass, so a multi-row statement's later rows still observe earlier
	 * rows' pending writes with no interleaving (no await separates a single op's lookup
	 * from its record).
	 */
	async applyMaintenanceToLayer(connection: MemoryTableConnection, ops: readonly MaintenanceOp[]): Promise<BackingRowChange[]> {
		const changes: BackingRowChange[] = [];
		if (ops.length === 0) return changes;
		this.ensureTransactionLayer(connection);
		const layer = connection.pendingTransactionLayer!;
		for (const op of ops) {
			switch (op.kind) {
				case 'delete-key': {
					const existing = this.lookupEffectiveRow(op.key, layer);
					if (existing) {
						layer.recordDelete(op.key, existing);
						changes.push({ op: 'delete', oldRow: existing });
					}
					break;
				}
				case 'upsert': {
					const key = this.primaryKeyFunctions.extractFromRow(op.row);
					const existing = this.lookupEffectiveRow(key, layer);
					if (existing && rowsValueIdentical(existing, op.row)) {
						// Value-identical against the EFFECTIVE row (pending over committed):
						// nothing changes, so write nothing and report nothing — the
						// skip-identical upsert contract (vtab/backing-host.ts), the point-op
						// analogue of the replace-all diff's identical-row skip. Both skips are
						// byte-faithful (`rowsValueIdentical`, BINARY per column): a collation-equal
						// / byte-different row (a case-only rewrite under NOCASE) is a real change
						// that must re-key the stored bytes — collation governs key identity only.
						break;
					}
					layer.recordUpsert(key, op.row, existing);
					changes.push(existing
						? { op: 'update', oldRow: existing, newRow: op.row }
						: { op: 'insert', newRow: op.row });
					break;
				}
				case 'delete-by-prefix': {
					// Range-scan the primary tree over the half-open interval whose leading
					// PK columns equal `keyPrefix` (the btree orders by the composite PK,
					// base-PK columns leading, so the slice is contiguous; `scanLayer`'s
					// `equalityPrefix` seeks to it and early-terminates on prefix mismatch).
					// Collect the matched rows first, THEN `recordDelete` each — the same
					// per-row bookkeeping (secondary indexes, change tracking) the point
					// `delete-key` arm uses, over a prefix range instead of a point.
					// Collect-then-delete avoids mutating the tree mid-iteration.
					const scanPlan: ScanPlan = { indexName: 'primary', descending: false, equalityPrefix: op.keyPrefix };
					const matched: Array<{ key: BTreeKeyForPrimary; row: Row }> = [];
					for (const row of scanLayerImpl(layer, scanPlan)) {
						matched.push({ key: this.primaryKeyFunctions.extractFromRow(row), row });
					}
					for (const { key, row } of matched) {
						layer.recordDelete(key, row);
						changes.push({ op: 'delete', oldRow: row });
					}
					break;
				}
				case 'replace-all': {
					// Wholesale transactional replacement, realized as the minimal keyed diff
					// (by backing PK) against the layer's current effective rows. Snapshot the
					// old rows FIRST — the same whole-table effective iteration the
					// `delete-by-prefix` arm scopes to a prefix — into a PK-keyed btree, so the
					// diff is computed against a stable before-image regardless of the upserts
					// applied below. Collation governs KEY identity only: keys are compared with
					// the table's PK comparator (honoring PK-column collation), so a new row whose
					// key only differs by collation (e.g. 'apple' vs a stored 'APPLE' under a NOCASE
					// PK) matches its old row and resolves to an `update` — never a spurious insert +
					// delete that would leak secondary-index bookkeeping. VALUE fidelity of a paired
					// row is byte-faithful (`rowsValueIdentical`, below) — one discipline, not two.
					const oldByKey = new BTree<BTreeKeyForPrimary, { key: BTreeKeyForPrimary; row: Row }>(
						e => e.key,
						this.comparePrimaryKeys,
					);
					for (const row of scanLayerImpl(layer, { indexName: 'primary', descending: false })) {
						oldByKey.insert({ key: this.primaryKeyFunctions.extractFromRow(row), row });
					}

					// New-row keys (same PK comparator) for the delete pass's membership test.
					const newKeys = new BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>(
						k => k,
						this.comparePrimaryKeys,
					);

					// Insert/update/skip-identical pass, in new-row order.
					for (const newRow of op.rows) {
						const key = this.primaryKeyFunctions.extractFromRow(newRow);
						newKeys.insert(key);
						const existing = oldByKey.get(key);
						if (!existing) {
							layer.recordUpsert(key, newRow, null);
							changes.push({ op: 'insert', newRow });
						} else if (!rowsValueIdentical(existing.row, newRow)) {
							layer.recordUpsert(key, newRow, existing.row);
							changes.push({ op: 'update', oldRow: existing.row, newRow });
						}
						// else: byte-identical at this key — a true no-op, no emitted change.
						// The skip is byte-faithful (`rowsValueIdentical`): a collation-equal /
						// byte-different paired row (a case-only rewrite under a NOCASE PK) is an
						// `update` that re-keys the stored bytes, matching the point-op upsert skip
						// and the byte-exact maintenance-equivalence oracle.
					}

					// Delete pass: every old key absent from the new set, ascending PK order.
					// `oldByKey` is a private snapshot, not mutated here, so iterating it while
					// `recordDelete` mutates the layer's tree is safe.
					for (const path of oldByKey.ascending(oldByKey.first())) {
						const entry = oldByKey.at(path)!;
						if (newKeys.get(entry.key) !== undefined) continue;
						layer.recordDelete(entry.key, entry.row);
						changes.push({ op: 'delete', oldRow: entry.row });
					}
					break;
				}
				default: {
					// A new MaintenanceOp must extend this switch; never-assignment makes
					// that a compile error rather than a silent no-op.
					const exhaustiveCheck: never = op;
					throw new QuereusError(`Unknown maintenance op: ${JSON.stringify(exhaustiveCheck)}`, StatusCode.INTERNAL);
				}
			}
		}
		await this.enforceSecondaryUniqueOnMaintenance(layer, changes);
		return changes;
	}

	/**
	 * Declared secondary-UNIQUE enforcement for maintenance writes — the
	 * collision-shaped half of the derived-row constraint contract (CHECK / FK
	 * are per-row properties and validate engine-side; see
	 * docs/mv-constraints.md § Derived-row constraint validation). The
	 * privileged surface bypasses the DML constraint pipeline, so without this
	 * the batch above would store two derived rows colliding on a declared
	 * UNIQUE silently.
	 *
	 * Runs POST-batch over the effective changes, never per-op: a `replace-all`
	 * diff applies its upserts before its deletes, so an in-flight per-op check
	 * would false-positive against a row the same batch is about to delete
	 * (e.g. the derived set moved a unique value from one primary key to
	 * another). After the batch the layer holds exactly the final contents, so
	 * checking each WRITTEN image against it is exact — and complete: every
	 * pre-existing row entered through DML / ADD CONSTRAINT / earlier validated
	 * maintenance, so any colliding pair includes at least one written image.
	 * A value-identical upsert the batch skipped emitted no change and cannot
	 * introduce a collision (the table's contents did not change at that key).
	 *
	 * Reuses {@link checkSingleUniqueConstraint} (same-PK exclusion, NULL-pass,
	 * partial-predicate scope, per-column collation, auto-index fast path) with
	 * two maintenance-specific postures: the conflict action is forced to ABORT
	 * (a derivation write carries no user OR clause, and a declared
	 * `on conflict replace`/`ignore` default must not silently evict or drop
	 * derived rows — the eviction would diverge the table from its derivation),
	 * and the covering-MV route is bypassed (see
	 * {@link findIndexForConstraint}'s `allowMvCovering`).
	 *
	 * Zero overhead when the table declares no secondary UNIQUE (every MV-sugar
	 * backing, and most maintained tables): one empty-array check.
	 */
	private async enforceSecondaryUniqueOnMaintenance(
		layer: TransactionLayer,
		changes: readonly BackingRowChange[],
	): Promise<void> {
		const schema = layer.getSchema();
		const ucs = schema.uniqueConstraints;
		if (!ucs || ucs.length === 0 || changes.length === 0) return;

		// ABORT means the IGNORE/REPLACE arms never fire, so nothing ever lands here.
		const noEvict: Row[] = [];
		for (const change of changes) {
			if (change.op === 'delete') continue;
			const newPrimaryKey = this.primaryKeyFromRow(change.newRow);
			for (const uc of ucs) {
				const result = await this.checkSingleUniqueConstraint(
					layer, schema, uc, change.newRow, newPrimaryKey,
					ConflictResolution.ABORT, noEvict, /*allowMvCovering*/ false,
				);
				if (result) {
					const colNames = uc.columns.map(i => schema.columns[i]?.name ?? String(i));
					throw maintainedTableUniqueViolationError(
						this.schemaName, this._tableName,
						uc.name ?? `_uc_${colNames.join('_')}`,
						colNames,
						uc.columns.map(i => change.newRow[i]),
					);
				}
			}
		}
	}

	// --- Schema Operations (simplified with inherited BTrees) ---
	/**
	 * ADD COLUMN. `insertAtIndex` — when supplied — puts the new column at that slot
	 * instead of appending; every existing column at or after it shifts right by one,
	 * and each index-bearing schema field is renumbered to match (see
	 * {@link shiftSchemaIndicesForInsert}). Omitted ⇒ append, which is what SQL
	 * `alter table … add column` always asks for and which leaves the schema rebuild
	 * on exactly the path it took before positions existed.
	 */
	async addColumn(
		columnDefAst: ASTColumnDef,
		backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>,
		insertAtIndex?: number,
	): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			// Get default nullability setting from database options
			const defaultNullability = this.db.options.getStringOption('default_column_nullability');
			const defaultNotNull = defaultNullability === 'not_null';

			// Honor the session `default_collation` for an ADD COLUMN that omits an explicit
			// COLLATE, matching the CREATE path (and the differ's resolved-COLLATE emission) so
			// an ADD-COLUMN-ed text column gets the same collation a CREATE-d one would.
			// resolveDefaultCollation falls non-text types back to BINARY automatically.
			const newColumnSchema = columnDefToSchema(columnDefAst, defaultNotNull, this.db.options.getStringOption('default_collation'), (n) => this.db.isCollationRegistered(n));
			if (this.tableSchema.columns.some(c => c.name.toLowerCase() === newColumnSchema.name.toLowerCase())) {
				throw new QuereusError(`Duplicate column name: ${newColumnSchema.name}`, StatusCode.ERROR);
			}
			let defaultValue: SqlValue = null;
			let defaultIsLiteral = false;
			const defaultConstraint = columnDefAst.constraints.find(c => c.type === 'default');
			if (defaultConstraint && defaultConstraint.expr) {
				const folded = tryFoldLiteral(defaultConstraint.expr);
				if (folded !== undefined) {
					defaultValue = folded;
					defaultIsLiteral = true;
				} else {
					// A non-literal expression default (e.g. `new.<col>`) is written as NULL
					// here; the engine backfills these rows per-row immediately after.
					logger.debugLog(`[Add Column] '${newColumnSchema.name}' default is a non-literal expression; existing rows are backfilled by the engine.`);
				}
			}
			// Check for NOT NULL constraint (could be explicit or from default behavior).
			// Allow NOT NULL without DEFAULT if the table is empty (SQLite-compatible).
			// A non-literal *expression* default (e.g. `new.<col>`) is backfilled per-row by
			// the engine right after this returns, which then enforces NOT NULL on the
			// backfilled values — so don't reject it here as "without a DEFAULT".
			const tableHasRows = this.baseLayer.primaryTree.at(this.baseLayer.primaryTree.first()) !== undefined;
			const hasDefaultExpr = !!(defaultConstraint && defaultConstraint.expr);
			if (newColumnSchema.notNull && defaultValue === null && !defaultIsLiteral && !hasDefaultExpr && tableHasRows) {
				throw new QuereusError(
					`Cannot add NOT NULL column '${newColumnSchema.name}' to non-empty table `
						+ `'${this.schemaName}.${this._tableName}' without a DEFAULT value`,
					StatusCode.CONSTRAINT,
				);
			}
			const appendIndex = this.tableSchema.columns.length;
			const targetIndex = insertAtIndex ?? appendIndex;
			if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > appendIndex) {
				throw new QuereusError(
					`Cannot add column '${newColumnSchema.name}' at position ${insertAtIndex}: `
						+ `expected an integer in [0, ${appendIndex}]`,
					StatusCode.MISUSE,
				);
			}
			const updatedColumnsSchema: ReadonlyArray<ColumnSchema> = Object.freeze(
				insertValueAt(this.tableSchema.columns, targetIndex, newColumnSchema),
			);
			// Appending never invalidates an existing column index, so the append path keeps
			// carrying every index-bearing field through the spread unchanged; only a real
			// insert pays for the renumber.
			const shiftedIndexFields = targetIndex < appendIndex
				? shiftSchemaIndicesForInsert(this.tableSchema, targetIndex)
				: undefined;
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				...shiftedIndexFields,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			});
			// Phase 1 of reaching the open transaction's own pending rows: compute their
			// post-ADD shape before ANY mutation, since the per-row backfill below can throw
			// on a pending row (and there is no undo for a half-reshaped layer chain).
			//
			// The NOT NULL check mirrors the base backfill's per-row check in
			// `BaseLayer.recreatePrimaryTreeWithNewColumn`, extended to pending rows. It is
			// deliberately NOT gated on `backfillEvaluator`, which today makes the
			// literal-default arm redundant: `validateNotNullBackfill`
			// (runtime/emit/alter-table.ts) already rejects NOT NULL without a usable DEFAULT
			// by querying the DDL connection's EFFECTIVE rows — pending ones included — so the
			// only violation that reaches here is a per-row evaluator yielding NULL. Kept
			// ungated so the module enforces its own invariant instead of relying on that gate.
			const reshapePlans = await this.prepareReshapeOnOpenLayers(
				async (row: Row): Promise<Row> => {
					const value = backfillEvaluator ? await backfillEvaluator(row) : defaultValue;
					if (newColumnSchema.notNull && value === null) {
						throw new QuereusError(
							`NOT NULL constraint failed: adding column '${this._tableName}.${newColumnSchema.name}' would leave NULL in a row pending in the open transaction`,
							StatusCode.CONSTRAINT,
						);
					}
					return insertValueAt(row, targetIndex, value) as Row;
				},
				// Event-log variant: same map applied to the log's historical images (oldRow
				// included — the evaluator is a function of a row and the pre-image is a row),
				// but BEST-EFFORT: an image the evaluator (or its CHECKs) rejects gets NULL —
				// the honest "column did not exist yet" placeholder — and the NOT NULL throw
				// above is omitted, so no historical image can abort the ALTER.
				async (row: Row): Promise<Row> => {
					let value = defaultValue;
					if (backfillEvaluator) {
						try {
							value = await backfillEvaluator(row);
						} catch {
							value = null;
						}
					}
					return insertValueAt(row, targetIndex, value) as Row;
				},
			);
			this.baseLayer.updateSchema(finalNewTableSchema);
			// A non-foldable DEFAULT (e.g. `new.<col>`) backfills each existing row from
			// its own value via the engine-supplied evaluator; a literal/NULL default
			// uses the single folded `defaultValue` for every row.
			await this.baseLayer.addColumnToBase(newColumnSchema, defaultValue, backfillEvaluator, targetIndex);
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();
			this.installReshapeOnOpenLayers(finalNewTableSchema, reshapePlans);

			// Emit schema change event.
			// NOTE: the event names the added column but not its position, which is fine while
			// the only non-append caller is an in-process wrapper that rebuilds its view from the
			// post-change schema. An append never invalidates an existing column index; an insert
			// does. If a position ever becomes SQL-reachable, anything that caches a column index
			// across this swap (planner caches, prepared statements, a wrapper's own schema
			// snapshot) needs to learn the insert point — so the event would have to carry it.
			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: newColumnSchema.name,
			});

			logger.operation('Add Column', this._tableName, { columnName: newColumnSchema.name });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Add Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async dropColumn(columnName: string): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${columnName}' not found.`, StatusCode.ERROR);
			if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new QuereusError(`Cannot drop PK column "${columnName}".`, StatusCode.CONSTRAINT);
			}

			const updatedColumnsSchema = this.tableSchema.columns.filter((_, idx) => idx !== colIndex);
			const updatedPkDefinition = this.tableSchema.primaryKeyDefinition.map(def => ({
				...def, index: def.index > colIndex ? def.index - 1 : def.index
			}));
			const updatedPrimaryKeyNames = updatedPkDefinition.map(def => updatedColumnsSchema[def.index]?.name).filter(Boolean) as string[];

			// Prune any UNIQUE constraint over the dropped column. A UNIQUE that includes the
			// dropped column is removed outright (a UNIQUE missing one of its columns is a
			// different, stronger constraint, not a silently-narrowed one); the auto-built
			// covering index it backed is torn down with it (see the index exclusion below).
			// Remaining constraints have their column indices shifted to track the removed slot.
			// Without this, dropping a uniquely-constrained column (including the ADD COLUMN +
			// inline-UNIQUE revert path) would strand a constraint whose column index dangles
			// past the end of the column array.
			const oldUniqueConstraints = this.tableSchema.uniqueConstraints ?? [];
			const droppedUcKeys = oldUniqueConstraints
				.filter(uc => uc.columns.includes(colIndex))
				.map(uc => uc.name ?? this.implicitIndexNameFor(uc));
			const remainingUniqueConstraints = oldUniqueConstraints
				.filter(uc => !uc.columns.includes(colIndex))
				.map(uc => ({ ...uc, columns: Object.freeze(uc.columns.map(i => i > colIndex ? i - 1 : i)) }));

			// Drop the implicit covering index of each removed constraint outright (matched by
			// the same `uc.name ?? '_uc_<cols>'` convention DROP CONSTRAINT uses, so a user
			// index that merely shares columns is left untouched), then shift/prune the rest
			// over the removed slot. A *single*-column covering index collapses to empty and is
			// filtered by the trailing `length > 0` regardless; the explicit name exclusion is
			// what tears down a *multi*-column covering index, which would otherwise survive
			// orphaned — narrowed to its surviving columns — in `index_info` and on every write.
			const droppedCoveringIndexNames = new Set(droppedUcKeys.map(k => k.toLowerCase()));
			const updatedIndexes = (this.tableSchema.indexes || [])
				.filter(idx => !droppedCoveringIndexNames.has(idx.name.toLowerCase()))
				.map(idx => ({
					...idx,
					columns: idx.columns
						.filter(ic => ic.index !== colIndex)
						.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index - 1 : ic.index }))
				})).filter(idx => idx.columns.length > 0);

			// Shift or prune the table's own foreign keys. `foreignKeys[].columns` are indices
			// into THIS table, so they renumber over the removed slot exactly as the PK and the
			// UNIQUE constraints above do. A foreign key that loses ANY of its child columns is
			// removed outright, the same call the UNIQUE pruning makes: a key missing one of its
			// child columns is a different constraint against the parent's key, not a narrowed
			// one. Both halves matter — left unshifted, a surviving key's index either dangles
			// past the end of the column array or, worse, silently slides onto an unrelated
			// column and starts enforcing against the parent there.
			//
			// `referencedColumns` is not touched: enforcement resolves the parent indices on
			// demand from `referencedColumnNames` against the parent's current schema. See
			// `shiftSchemaIndicesForInsert`, the ADD-COLUMN-at-a-position mirror of this block.
			const remainingForeignKeys = (this.tableSchema.foreignKeys ?? [])
				.filter(fk => !fk.columns.includes(colIndex))
				.map(fk => ({ ...fk, columns: Object.freeze(fk.columns.map(i => i > colIndex ? i - 1 : i)) }));

			// NOTE: the generated-column bookkeeping (`generatedColumnDependencies` /
			// `generatedColumnTopoOrder`, also index-keyed) is likewise unshifted, but the
			// engine recomputes it from column names right after this returns
			// (`withGeneratedColumnGraph` in `runDropColumn`), so only a caller driving the
			// module API directly ever observes the stale map.
			//
			// `primaryKey` below is not a TableSchema field at all — nothing reads it.
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedColumnsSchema),
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				primaryKeyDefinition: Object.freeze(updatedPkDefinition),
				primaryKey: Object.freeze(updatedPrimaryKeyNames),
				indexes: Object.freeze(updatedIndexes),
				uniqueConstraints: remainingUniqueConstraints.length > 0
					? Object.freeze(remainingUniqueConstraints)
					: undefined,
				foreignKeys: remainingForeignKeys.length > 0
					? Object.freeze(remainingForeignKeys)
					: undefined,
			});

			// Phase 1 of reaching the open transaction's own pending rows. The rewrite here is
			// a pure filter and cannot throw — the split exists for ADD COLUMN's fallible
			// backfill — but running it before any mutation keeps the two paths uniform. The
			// same filter reshapes the pending-change event log (second arg).
			const dropSlot = (row: Row): Row => row.filter((_, idx) => idx !== colIndex) as Row;
			const reshapePlans = await this.prepareReshapeOnOpenLayers(dropSlot, dropSlot);
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropColumnFromBase(colIndex);
			this.tableSchema = finalNewTableSchema;
			// The covering-structure records for the dropped constraints are now stale —
			// clear them (keys computed against the pre-drop column names above).
			for (const key of droppedUcKeys) this.implicitCoveringStructures.delete(key);
			this.initializePrimaryKeyFunctions();
			this.installReshapeOnOpenLayers(finalNewTableSchema, reshapePlans);

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName,
			});

			logger.operation('Drop Column', this._tableName, { columnName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Drop Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async renameColumn(oldName: string, newColumnDefAst: ASTColumnDef): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		const schemaManager = this.db.schemaManager;
		const resolveColumnInSource: ResolveColumnInSource = (s, t, col) =>
			schemaManager.getSchema(s)?.getTable(t)?.columnIndexMap.has(col.toLowerCase()) ?? false;
		let predicatesRewritten = false;
		try {
			await this.ensureSchemaChangeSafety();
			const oldNameLower = oldName.toLowerCase();
			const newColumnName = newColumnDefAst.name;
			const newNameLower = newColumnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
			if (colIndex === -1) throw new QuereusError(`Column '${oldName}' not found.`, StatusCode.ERROR);
			if (oldNameLower !== newNameLower && this.tableSchema.columns.some((c, i) => i !== colIndex && c.name.toLowerCase() === newNameLower)) {
				throw new QuereusError(`Target name '${newColumnName}' already exists.`, StatusCode.ERROR);
			}

			// Get default nullability setting from database options
			const defaultNullability = this.db.options.getStringOption('default_column_nullability');
			const defaultNotNull = defaultNullability === 'not_null';

			const newColumnSchemaAtIndex = columnDefToSchema(newColumnDefAst, defaultNotNull, 'BINARY', (n) => this.db.isCollationRegistered(n));
			const updatedCols = this.tableSchema.columns.map((c, i) => i === colIndex ? newColumnSchemaAtIndex : c);
			const updatedIndexes = (this.tableSchema.indexes || []).map(idx => ({
				...idx,
				columns: idx.columns.map(ic =>
					ic.index === colIndex ? { ...ic, name: newColumnName } : ic
				)
			}));

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedCols),
				columnIndexMap: buildColumnIndexMap(updatedCols),
				primaryKeyDefinition: Object.freeze(this.tableSchema.primaryKeyDefinition),
				indexes: Object.freeze(updatedIndexes),
			});

			// Rewrite partial-index predicates into the new column name BEFORE the
			// rebuild that `handleColumnRename()` triggers: `createSecondaryIndexes`
			// compiles each predicate against the new column list, so a `WHERE` still
			// naming the old column cannot build.
			//
			// The window is narrow. `ensureSchemaChangeSafety()` above consolidates the
			// transaction layers into the base and rebuilds every secondary index against
			// the OLD column list — an already-rewritten predicate would break that. So
			// the rewrite belongs here and nowhere earlier (in particular, not before the
			// engine calls `module.alterTable`).
			//
			// In place, so the catalog's `TableSchema` and a unique partial index's derived
			// UNIQUE constraint — which share the `Expression` by reference — follow along.
			// `propagateColumnRename` re-runs the same rewrite once the engine regains
			// control and finds nothing left to do.
			// Armed BEFORE the call, not from its return value: the rewrite walks the
			// indexes one at a time, so a throw partway through would otherwise leave the
			// already-rewritten predicates renamed with the flag still false. The reverse
			// pass is a no-op when nothing names `newColumnName`, so arming it eagerly
			// costs nothing when the rewrite finds no predicate to touch.
			predicatesRewritten = true;
			renameColumnInIndexPredicates(
				finalNewTableSchema.indexes, this._tableName, oldName, newColumnName,
				this.schemaName, resolveColumnInSource);

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.handleColumnRename();
			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();
			// The DDL transaction's own layers froze their schema at creation; hand them the
			// renamed one, mirroring `handleColumnRename`'s base-side secondary rebuild —
			// `updatedIndexes` above rebuilt every `IndexSchema` object, which is exactly the
			// identity discriminator `adoptSchema` rebuilds a layer's `MemoryIndex` on.
			//
			// A rename touches neither the column set nor the primary key, so `adoptSchema` is
			// the right level (not the `prepareReshapeOnOpenLayers` / `installReshapeOnOpenLayers`
			// pair `add column` / `drop column` need) — but it is just as mandatory: without it an
			// eager savepoint snapshot keeps its frozen pre-rename schema, fails
			// `commitTransaction`'s snapshot-wrap identity check
			// (`readLayer.getSchema() === this.tableSchema`), and the transaction's staged rows are
			// silently dropped at COMMIT. Covered by
			// `test/logic/41.8-alter-savepoint-staged-rows.sqllogic`.
			this.adoptSchemaOnOpenLayers(finalNewTableSchema);

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: newColumnName,
				oldColumnName: oldName,
			});

			logger.operation('Rename Column', this._tableName, { oldName, newName: newColumnName });
		} catch (e: unknown) {
			// The predicate ASTs are shared with the catalog's TableSchema, so restoring
			// `originalManagerSchema` does not undo the rewrite — run it in reverse. The
			// flag keeps a failure raised *before* the rewrite from un-renaming anything.
			if (predicatesRewritten) {
				renameColumnInIndexPredicates(
					originalManagerSchema.indexes, this._tableName, newColumnDefAst.name, oldName,
					this.schemaName, resolveColumnInSource);
			}
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Rename Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * Apply a single-attribute ALTER COLUMN change (NOT NULL, DEFAULT, DATA TYPE).
	 * The caller supplies exactly one populated change; multi-attribute combinations
	 * are rejected by the runtime before reaching this method.
	 *
	 * `validateOnly` runs everything up to (and including) the pre-mutation validation
	 * passes — the effective-row NULL / conversion scans, the re-keyed UNIQUE probe, and
	 * the primary-key re-key legality/representability passes — and returns before the
	 * first mutation, throwing exactly what the real application would throw. The
	 * isolation layer uses it to pre-flight an overlay's migration before the shared
	 * underlying table mutates irreversibly (see `VirtualTable.alterSchema`).
	 */
	async alterColumn(change: {
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: Expression | null;
		setCollation?: string;
	}, rows?: EffectiveRowSource, validateOnly = false): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		/** The base primary tree `rebuildPrimaryTreeStrict` replaced, for the catch's rollback. */
		let basePrimaryTreeBeforeRekey: BTree<BTreeKeyForPrimary, Row> | null = null;
		try {
			await this.ensureSchemaChangeSafety();

			const colNameLower = change.columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
			if (colIndex === -1) {
				throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
			}
			const oldCol = this.tableSchema.columns[colIndex];
			let newCol: ColumnSchema = oldCol;
			// A collation change re-keys any PK / UNIQUE / index that orders by this
			// column, so it needs the structure re-sort + uniqueness re-validation below.
			let collationChanged = false;
			// Set when a SET DATA TYPE moves to a type that ORDERS values differently
			// (comparisonSemanticsDiffer). Same consequence as a collation change — every
			// structure keyed by the column has to be re-sorted and its uniqueness re-judged —
			// but a separate flag, because the index-column collation propagation and the
			// `pkColumnRekeyed` primary-tree path below belong to SET COLLATE alone. Usually
			// coincides with `valueConvert` (every non-alias retype sets that); the rebuild
			// chains below test `valueConvert` FIRST, whose full-rebuild path subsumes the
			// comparator-only re-sort.
			let comparatorChanged = false;
			// Set to the per-value conversion function when a physical value rewrite is needed:
			// SET DATA TYPE (every non-alias retype — values normalize to the new type's
			// canonical spelling even when the storage class is unchanged) or SET NOT NULL
			// backfill (map null → DEFAULT). Both REPLACE the base primary tree with a
			// freshly-built one (never an in-place mutation, which inheritree forbids while the
			// open transaction's layers derive from it) and convert the transaction's
			// own-written rows in every open layer, after `updateSchema` (see the rebuild
			// section and convertColumnOnOpenLayers).
			let valueConvert: ((v: SqlValue) => SqlValue) | null = null;
			// SET NOT NULL backfill also routes NULL values through `valueConvert`; SET DATA TYPE
			// leaves nulls untouched. Selects the null-including path in convertBaseRows/convertColumn.
			let convertNulls = false;

			if (change.setCollation !== undefined) {
				const normalized = validateCollationForType(change.setCollation, oldCol.logicalType, change.columnName, (n) => this.db.isCollationRegistered(n));
				const nameMatches = normalized === (oldCol.collation || 'BINARY');
				if (nameMatches && oldCol.collationExplicit) {
					return; // already explicit in the desired collation — nothing to do
				}
				// SET COLLATE is a user declaration with the same standing as a
				// CREATE-time COLLATE clause, so mark the collation explicit (rank 2 in
				// the comparison lattice) regardless of the column's creation history —
				// including SET COLLATE binary. When only the name matches but the column
				// was not yet explicit (a defaulted collation, or one inherited from
				// session default_collation), flip the flag as a METADATA-ONLY change:
				// the collation bytes are unchanged, so keep collationChanged false and
				// skip the physical re-sort / re-key / UNIQUE re-validation below. A
				// different name takes the full path AND sets the flag.
				newCol = { ...oldCol, collation: normalized, collationExplicit: true };
				collationChanged = !nameMatches;
			} else if (change.setNotNull !== undefined) {
				if (change.setNotNull === true && !oldCol.notNull) {
					// Tightening: scan the DDL transaction's EFFECTIVE rows for NULLs — committed rows
					// overlaid with this transaction's own pending writes — exactly as the setDataType
					// arm does. A pending NULL the transaction can SEE rejects the ALTER; one only in a
					// row it has DELETED does not block it. `rows` is the wrapper-supplied effective set
					// (the isolation overlay); when absent, effectiveDdlRows() is the layered view.
					const defaultExpr = oldCol.defaultValue;
					const defaultLiteral = defaultExpr ? tryFoldLiteral(defaultExpr) : undefined;

					let anyNull = false;
					if (rows) {
						for await (const row of rows()) {
							if (row[colIndex] === null) { anyNull = true; break; }
						}
					} else {
						for (const row of this.effectiveDdlRows()) {
							if (row[colIndex] === null) { anyNull = true; break; }
						}
					}

					if (anyNull) {
						if (defaultLiteral === undefined || defaultLiteral === null) {
							throw new QuereusError(
								`column ${change.columnName} contains NULL values`,
								StatusCode.CONSTRAINT,
							);
						}
						// Backfill: map null → the folded DEFAULT literal, routed through the SAME
						// base-replacement + open-layer conversion machinery setDataType uses — no
						// logical-type change, no PK re-key, no in-place base mutation. The old in-place
						// `tree.upsert` backfill could not fill the transaction's pending rows (they live
						// in the pending layer, not the base) and mutated a base the open layers derive
						// from — both fixed by the unified path.
						const literal = defaultLiteral;
						valueConvert = (v: SqlValue) => (v === null ? literal : v);
						convertNulls = true;
					}

					newCol = { ...oldCol, notNull: true };
				} else if (change.setNotNull === false && oldCol.notNull) {
					if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
						throw new QuereusError(
							`Cannot DROP NOT NULL on PRIMARY KEY column '${change.columnName}'`,
							StatusCode.CONSTRAINT,
						);
					}
					newCol = { ...oldCol, notNull: false };
				} else {
					// No-op (already in desired state).
					return;
				}
			} else if (change.setDataType !== undefined) {
				const newLogicalType = inferType(change.setDataType);
				// Gate on logical-type IDENTITY, not the physical storage class: `inferType`
				// flattens aliases to the shared type object (`varchar(50)` IS `TEXT_TYPE`,
				// `bigint` IS `INTEGER_TYPE`), so an alias retype is schema-only — no scan, no
				// rewrite, no re-key. Every OTHER retype validates AND normalizes every value,
				// whether or not the storage class changes: a same-class move (text → date)
				// must reject values the new type refuses ('hello') and rewrite the rest to
				// the new type's canonical spelling ('2024-06-05T00:00:00Z' → '2024-06-05'),
				// or the column holds values no INSERT could have produced — unfindable by
				// equality (DATE compares BINARY over the stored text) and invisible to UNIQUE.
				// NOTE: the rewrite is unconditional once the types differ, even when every
				// converted value comes back byte-identical (already-canonical ISO durations on a
				// text → timespan). That costs a full base-tree + secondary-index rebuild here, and
				// a physical rewrite of every row on the store leg. If ALTER on large tables ever
				// shows up as slow, have the convert pre-pass record whether any value actually
				// moved and, when none did, fall through to the comparator-only re-key.
				if (newLogicalType !== oldCol.logicalType) {
					// Retyping a PRIMARY KEY column moves the key bytes (a class change), the
					// tree's ordering (a comparator move), or at minimum the key values'
					// canonical spelling — and neither the base rewrite below nor the
					// transaction-layer conversion re-keys the primary tree. The engine already
					// refuses SET DATA TYPE on any PK column (runtime/emit/alter-table.ts);
					// this guards direct module calls. Reject rather than corrupt — the
					// type-change analogue of the SET COLLATE primary-key carve-out
					// (`alter-collate-pk-in-transaction`).
					if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
						throw new QuereusError(
							`Cannot change the data type of primary key column '${change.columnName}' of table '${this._tableName}'.`,
							StatusCode.CONSTRAINT,
						);
					}

					// Every MemoryIndex builds its comparator from the column's LOGICAL type
					// (`createTypedComparator(columnSchema.logicalType, …)` in vtab/memory/index.ts),
					// so a move to a differently-ordering type (text ↔ timespan: 'PT1H' ≡ 'PT60M';
					// text ↔ date/time/datetime: binary, ignoring the column's collation) re-sorts
					// every structure keyed by the column. Tracked separately from the value rewrite
					// because SET COLLATE shares the re-key machinery without rewriting values.
					comparatorChanged = comparisonSemanticsDiffer(oldCol.logicalType, newLogicalType);

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

					// Validate BEFORE any mutation, over the DDL transaction's EFFECTIVE rows
					// (committed rows overlaid with this transaction's own pending writes): an
					// unconvertible value the transaction can SEE rejects the ALTER, and one only in
					// a row it has DELETED does not block it. A throw here leaves the schema, the base
					// and the transaction untouched. `rows` is the wrapper-supplied effective set (the
					// isolation overlay); when absent, `effectiveDdlRows()` is the layered view.
					if (rows) {
						for await (const row of rows()) {
							const val = row[colIndex];
							if (val !== null) convert(val as SqlValue);
						}
					} else {
						for (const row of this.effectiveDdlRows()) {
							const val = row[colIndex];
							if (val !== null) convert(val as SqlValue);
						}
					}

					// The base rows are converted below, AFTER `updateSchema`, by REPLACING the base
					// primary tree with a fresh one (see the `valueConvert` branch) — never by an
					// in-place mutation, which inheritree forbids while the open transaction's layers
					// derive from that tree (`MutatedBaseError`). `valueConvert` drives both the base
					// replacement and the transaction-layer conversion.
					valueConvert = convert;
				}
				newCol = { ...oldCol, logicalType: newLogicalType };
			} else if (change.setDefault !== undefined) {
				newCol = { ...oldCol, defaultValue: change.setDefault };
			} else {
				throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
			}

			const updatedCols = this.tableSchema.columns.map((c, i) => i === colIndex ? newCol : c);

			// The changes that move the COMPARATOR the structures are keyed by: SET COLLATE
			// (values untouched) and a retype into a differently-ordering type (which, unless it
			// is an alias retype, ALSO rewrites values — `valueConvert` — and its full-rebuild
			// path below subsumes the comparator-only re-sort). Both need fresh IndexSchema
			// objects and, when no rewrite runs, the re-validate / re-sort / adopt sequence.
			const structuresRekeyed = collationChanged || comparatorChanged;

			// Propagate a collation change into every PK-definition entry and index
			// column that orders by this column, so their comparators re-key under it.
			const updatedPkDef = collationChanged
				? this.tableSchema.primaryKeyDefinition.map(def =>
					def.index === colIndex ? { ...def, collation: newCol.collation } : def)
				: this.tableSchema.primaryKeyDefinition;
			// Every re-keying change also REBUILDS the IndexSchema objects, because their identity is
			// the discriminator `TransactionLayer.adoptSchema` uses to decide an open layer's
			// MemoryIndex must be replaced rather than kept (an index it holds under an object the new
			// schema still carries is left alone). SET COLLATE has a field to write — the index
			// column's own collation. A comparator-only retype has none: an index column carries no
			// logical type, it reads the column's from `newSchema.columns`, so the fresh object IS the
			// whole signal. Without it the base rebuilt its trees under the new comparator while the
			// DDL transaction's own layers went on comparing the old way — and shadowed the base's
			// rebuilt trees once the pending layer became the committed head.
			const updatedIndexes = (structuresRekeyed && this.tableSchema.indexes)
				? this.tableSchema.indexes.map(idx => ({
					...idx,
					columns: idx.columns.map(ic =>
						(ic.index === colIndex && collationChanged) ? { ...ic, collation: newCol.collation } : ic),
				}))
				: this.tableSchema.indexes;

			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				columns: Object.freeze(updatedCols),
				columnIndexMap: buildColumnIndexMap(updatedCols),
				primaryKeyDefinition: Object.freeze(updatedPkDef),
				indexes: updatedIndexes ? Object.freeze(updatedIndexes) : updatedIndexes,
			});

			const pkColumnRekeyed = collationChanged && updatedPkDef.some(def => def.index === colIndex);

			// Validate BEFORE any mutation, over the DDL transaction's EFFECTIVE rows: a pair
			// the transaction inserted that collides under the NEW schema must reject the
			// change, and one it has deleted must not block it. A throw here leaves the schema,
			// the base layer and the index map exactly as they were.
			//
			// A value-REWRITING change (`valueConvert`: SET DATA TYPE, or a SET NOT NULL null →
			// DEFAULT backfill) probes the CONVERTED rows — the same per-row conversion the base
			// rewrite below applies — under the NEW schema's comparators, so one call covers both
			// ways an ALTER can collapse two previously-distinct rows: the VALUES converge
			// (`'1'`/`'01'` → 1; two NULLs → one DEFAULT; '2024-06-05T00:00:00Z' → '2024-06-05')
			// and/or the COMPARATOR moves (text → timespan makes 'PT1H'/'PT60M' one value). A
			// same-storage-class retype sets `valueConvert` AND `structuresRekeyed`, so the
			// rewrite arm is tested FIRST — its converted-row probe subsumes the comparator-only
			// one. The rebuild that follows is deliberately non-enforcing, so this is the only
			// guard.
			//
			// The comparator-MOVING arm without a rewrite has one trigger left: SET COLLATE. The
			// values are untouched — hence no `mapRow` — and only the comparator the structures
			// are keyed by moves. `newSchema` carries the new collations, so the probe indexes
			// compare as the rebuilt ones will.
			//
			// The primary key: SET COLLATE on a PK member gets a stricter pre-pass
			// (`validateRekeyedPrimaryKey`): no layer in the chain, base included, may hold a
			// collision. That is what lets every step below succeed unconditionally, and what
			// `TransactionLayer.rekeyPrimaryKey` relies on. The rewrite arm needs no PK pre-pass
			// and cannot shadow one: a retype of a PK column is rejected upstream, the backfill
			// only fires on a column holding NULLs (which a PK member cannot — the engine
			// enforces NOT NULL on every PK member regardless of the declared nullability), and
			// `pkColumnRekeyed` is set only by SET COLLATE, which never sets `valueConvert` — so
			// whenever `pkColumnRekeyed` is true, the `structuresRekeyed` arm still runs.
			// NOTE: if PK members ever become genuinely nullable, the backfill arm gains a PK
			// collision path (two NULL keys → one DEFAULT) and needs `validateRekeyedPrimaryKey`
			// plus a primary-tree re-key of its own.
			if (valueConvert) {
				const convert = valueConvert;
				const nulls = convertNulls;
				await this.validateRekeyedUniqueStructures(
					finalNewTableSchema, colIndex, rows,
					// Unlike `convertBaseRows`, a conversion failure here is NOT swallowed. Every row
					// the probe sees is visible to the transaction, and the setDataType pre-pass above
					// already proved each one convertible, so a throw is unreachable; surfacing it as
					// MISMATCH still beats probing a stale value that could mask a collision.
					row => convertRowAtIndex(row, colIndex, convert, nulls),
				);
			} else if (structuresRekeyed) {
				await this.validateRekeyedUniqueStructures(finalNewTableSchema, colIndex, rows);
				// Unlike the secondary-structure pass above — which only ever judges the effective
				// rows — the PK pass judges TWO row sets: the effective rows (`rows` when a wrapper
				// supplies them) decide whether the change is LEGAL, and this manager's own layer
				// chain decides whether the re-keyed trees can PHYSICALLY carry it. See
				// `validateRekeyedPrimaryKey` for why the sets differ and which status each raises.
				if (pkColumnRekeyed) await this.validateRekeyedPrimaryKey(finalNewTableSchema, rows);
			}

			// Dry run ends here: everything above validates without mutating (the one earlier
			// side effect, ensureSchemaChangeSafety's committed-layer drain, is semantically
			// neutral bookkeeping), and everything below mutates. See the method doc.
			if (validateOnly) return;

			this.baseLayer.updateSchema(finalNewTableSchema);

			// Both arms rebuild the base's structures under the schema `updateSchema` above just
			// swapped in — each MemoryIndex rebuilds its comparator from the CURRENT schema's
			// collation and logical type. The secondary rebuilds are NON-enforcing (the pre-pass
			// above owns uniqueness, and the base's rows are not a subset of the effective rows);
			// the SET COLLATE PK rebuild is strict, since a PK collision cannot be represented at
			// all — the pre-pass has already proved the base collision-free, so the strict
			// rebuild is a live invariant check, not the enforcement path. It runs LAST so its
			// throw leaves the live tree intact for the catch's rollback.
			if (valueConvert) {
				// SET DATA TYPE / SET NOT NULL backfill: convert the committed base rows and REPLACE
				// the primary tree with a fresh one holding them (not an in-place upsert — inheritree
				// forbids mutating a base while the open transaction's layers derive from it).
				// `rebuildPrimaryTreeFromRows` also rebuilds every secondary index from the converted
				// rows under the new comparators, so index-backed lookups see the new values — which
				// is why this arm runs first and subsumes `rebuildAllSecondaryIndexes` when a
				// same-storage-class retype sets `structuresRekeyed` too. The old tree is saved for
				// the catch's rollback, exactly as the PK-rekey path does.
				// NOTE: rebuilds EVERY secondary index, not only those covering the altered column;
				// if a wide-index table ever shows this as slow, filter to indexes whose columns
				// include colIndex. Mirrors the collationChanged path's unconditional rebuild.
				//
				// SET DATA TYPE: a base value that fails to convert is kept as-is — validation over
				// the effective view already rejected any unconvertible value the transaction can SEE,
				// so a surviving one is shadowed by a pending delete/overwrite and is never read back
				// (a ROLLBACK re-exposes it under the new type — DDL is not undone by rollback, the
				// known behavior of `feat-ddl-transaction-capability`).
				// SET NOT NULL (`convertNulls`): null base values are mapped to the DEFAULT literal.
				const convertedBaseRows = this.convertBaseRows(colIndex, valueConvert, convertNulls);
				basePrimaryTreeBeforeRekey = this.baseLayer.primaryTree;
				this.baseLayer.rebuildPrimaryTreeFromRows(convertedBaseRows);
			} else if (structuresRekeyed) {
				this.baseLayer.rebuildAllSecondaryIndexes();
				if (pkColumnRekeyed) {
					basePrimaryTreeBeforeRekey = this.baseLayer.primaryTree;
					this.baseLayer.rebuildPrimaryTreeStrict();
				}
			}

			this.tableSchema = finalNewTableSchema;
			this.initializePrimaryKeyFunctions();

			// The base rebuild handed every secondary index a fresh tree under the new
			// comparator; the DDL transaction's own layers still inherit the old ones and froze
			// the old schema at construction. Re-key them, or the rest of the transaction — and
			// everything after the pending layer becomes the committed head at commit — keeps
			// comparing under the old collation / old logical type.
			//
			// When the altered column is part of the primary key, `rebuildPrimaryTreeStrict` also
			// swapped the base primary tree object out from under those layers' copy-on-write
			// bases and invalidated their `pkFunctions`; `rekeyPrimaryKey` rebuilds both, plus
			// every secondary index (each derives its PK comparator/encoder from the PK
			// definition). Outside a transaction there are no open layers and both are no-ops.
			if (valueConvert) {
				// SET DATA TYPE / SET NOT NULL backfill converted the base above; the DDL
				// transaction's own open layers still froze the old schema and hold their own-written
				// rows unconverted. Swap the schema and convert those values so the rest of the
				// transaction — and the committed head at commit — read the new value. For SET NOT
				// NULL this fills the transaction's OWN pending NULL rows (which live in the pending
				// layer, never reached by the old in-place base upsert). `convertColumn` installs the
				// new schema and rebuilds every one of the layer's secondary indexes from it, so it
				// subsumes `adoptSchema` when a same-storage-class retype moved the comparators too.
				// No-op in autocommit.
				this.convertColumnOnOpenLayers(finalNewTableSchema, colIndex, valueConvert, convertNulls);
			} else if (structuresRekeyed) {
				this.adoptSchemaOnOpenLayers(finalNewTableSchema, pkColumnRekeyed);
			} else {
				// The remaining changes (SET DEFAULT, DROP NOT NULL, a SET NOT NULL that needed no
				// backfill, a retype between aliases of one logical type) touch nothing a layer
				// DERIVES — its index set, its `uniqueConstraints` enforcement and its MemoryIndex
				// comparators all stay put, and DEFAULT application / NOT NULL enforcement happen
				// above the module, off the catalog schema. But the frozen schema OBJECT is itself
				// observable: `commitTransaction` only wraps a swapped-in savepoint snapshot back
				// into the committed chain when `readLayer.getSchema() === this.tableSchema`. Left
				// stale, a `rollback to savepoint` taken across one of these ALTERs restores a
				// snapshot the wrap then skips, and the transaction's staged rows are silently
				// dropped at COMMIT. Adoption is cheap here — every IndexSchema object is carried
				// over unchanged, so `adoptSchema` keeps each layer's MemoryIndex and only swaps
				// the schema reference.
				this.adoptSchemaOnOpenLayers(finalNewTableSchema);
			}

			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'column',
				schemaName: this.schemaName,
				objectName: this._tableName,
				columnName: change.columnName,
			});

			logger.operation('Alter Column', this._tableName, { columnName: change.columnName });
		} catch (e: unknown) {
			// Restore the prior schema and primary tree, then re-key the secondary indexes back
			// to it. Both pre-passes now run before any mutation, so nothing below `updateSchema`
			// is expected to throw; the restores are the safety net for an unexpected one (and
			// for `rebuildPrimaryTreeStrict`'s invariant check, whose precondition
			// `validateRekeyedPrimaryKey` has already established).
			//
			// NOTE: a throw from a pre-pass (or from `setNotNull`'s NULL scan) mutated nothing,
			// so this rebuild only swaps the base's index trees for fresh, content-identical
			// ones — an O(rows) cost on a pure rejection. Harmless (a pending layer keeps
			// reading its orphaned but content-correct copy-on-write base), but if a rejected
			// ALTER on a large table ever shows up as slow, gate the rebuild on a "mutation
			// started" flag set just before `updateSchema`.
			this.baseLayer.updateSchema(originalManagerSchema);
			if (basePrimaryTreeBeforeRekey) this.baseLayer.primaryTree = basePrimaryTreeBeforeRekey;
			this.baseLayer.rebuildAllSecondaryIndexes();
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Alter Column', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async createIndex(newIndexSchemaEntry: IndexSchema, ifNotExistsFromAst?: boolean, rows?: EffectiveRowSource): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			const indexName = newIndexSchemaEntry.name;
			if (this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexName.toLowerCase())) {
				if (!ifNotExistsFromAst) {
					throw new QuereusError(`Index '${indexName}' already exists on table '${this._tableName}'.`, StatusCode.ERROR);
				}
				logger.operation('Create Index', this._tableName, 'Index already exists, IF NOT EXISTS specified. Skipping creation.');
				return;
			}

			for (const iCol of newIndexSchemaEntry.columns) {
				if (iCol.index < 0 || iCol.index >= this.tableSchema.columns.length) {
					throw new QuereusError(`Column index ${iCol.index} for index '${indexName}' is out of bounds for table '${this._tableName}'.`, StatusCode.ERROR);
				}
			}

			// Validate BEFORE any mutation, over the DDL transaction's EFFECTIVE rows — a
			// duplicate the transaction inserted but has not committed must reject the build,
			// and one it has deleted must not. A throw here leaves schema, base layer and
			// index map exactly as they were.
			if (newIndexSchemaEntry.unique) {
				await this.validateUniqueOverEffectiveRows(newIndexSchemaEntry, this.tableSchema, rows);
			}

			const updatedIndexes = Object.freeze([...(this.tableSchema.indexes || []), newIndexSchemaEntry]);
			let updatedUniqueConstraints = this.tableSchema.uniqueConstraints;
			if (newIndexSchemaEntry.unique) {
				const newConstraint: UniqueConstraintSchema = {
					name: newIndexSchemaEntry.name,
					columns: Object.freeze(newIndexSchemaEntry.columns.map(c => c.index)),
					predicate: newIndexSchemaEntry.predicate,
					derivedFromIndex: newIndexSchemaEntry.name,
				};
				updatedUniqueConstraints = Object.freeze([
					...(this.tableSchema.uniqueConstraints ?? []),
					newConstraint
				]);
			}
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: updatedIndexes,
				uniqueConstraints: updatedUniqueConstraints,
			});

			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.addIndexToBase(newIndexSchemaEntry);

			this.tableSchema = finalNewTableSchema;
			// The DDL transaction's own layers froze their schema at creation; hand them the
			// new one so the rest of the transaction scans and enforces the new index.
			this.adoptSchemaOnOpenLayers(finalNewTableSchema);

			// Emit schema change event. The `ddl` is what a sync peer re-executes to
			// replicate the index; rendered against the POST-create schema so it matches
			// what a receiving peer regenerates when comparing definitions.
			this.eventEmitter?.emitSchemaChange?.({
				type: 'create',
				objectType: 'index',
				schemaName: this.schemaName,
				objectName: indexName,
				ddl: generateIndexDDL(newIndexSchemaEntry, finalNewTableSchema),
			});

			logger.operation('Create Index', this._tableName, { indexName });
		} catch (e: unknown) {
			// Restore the prior schema, and drop the index if `addIndexToBase` already landed
			// it — otherwise the base layer's index map would advertise a structure the schema
			// no longer declares. Guarded on the ORIGINAL schema so the "index already exists"
			// arm never tears down the pre-existing index of the same name.
			this.baseLayer.updateSchema(originalManagerSchema);
			const name = newIndexSchemaEntry.name;
			const preexisting = originalManagerSchema.indexes?.some(i => i.name.toLowerCase() === name.toLowerCase()) ?? false;
			if (!preexisting && this.baseLayer.getSecondaryIndex(name)) {
				await this.baseLayer.dropIndexFromBase(name);
			}
			this.tableSchema = originalManagerSchema;
			logger.error('Create Index', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	async dropIndex(indexName: string, ifExists?: boolean): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const indexNameLower = indexName.toLowerCase();
			const indexExists = this.tableSchema.indexes?.some(idx => idx.name.toLowerCase() === indexNameLower);
			if (!indexExists) {
				if (ifExists) {
					logger.operation('Drop Index', this._tableName, 'Index not on table, IF EXISTS. Skipping.');
					return;
				}
				throw new QuereusError(`Index '${indexName}' not on table '${this._tableName}'.`, StatusCode.ERROR);
			}
			// Strip any UNIQUE constraint synthesized from this index alongside
			// the index itself (mirrors SchemaManager.dropIndex). Without this,
			// checkUniqueConstraints would keep enforcing it after DROP INDEX.
			const remainingUniqueConstraints = (this.tableSchema.uniqueConstraints ?? []).filter(
				uc => uc.derivedFromIndex?.toLowerCase() !== indexNameLower
			);
			const finalNewTableSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				indexes: Object.freeze((this.tableSchema.indexes || []).filter(idx => idx.name.toLowerCase() !== indexNameLower)),
				uniqueConstraints: remainingUniqueConstraints.length > 0
					? Object.freeze(remainingUniqueConstraints)
					: undefined,
			});
			this.baseLayer.updateSchema(finalNewTableSchema);
			await this.baseLayer.dropIndexFromBase(indexName);
			this.tableSchema = finalNewTableSchema;
			// The DDL transaction's own layers froze their schema at creation; hand them the new
			// one so the rest of the transaction stops enforcing (and scanning) the dropped index.
			this.adoptSchemaOnOpenLayers(finalNewTableSchema);

			// Emit schema change event
			this.eventEmitter?.emitSchemaChange?.({
				type: 'drop',
				objectType: 'index',
				schemaName: this.schemaName,
				objectName: indexName,
				ddl: generateDropIndexDDL(this.schemaName, indexName),
			});

			logger.operation('Drop Index', this._tableName, { indexName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			logger.error('Drop Index', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * Drops a named table-level constraint (CHECK / UNIQUE / FOREIGN KEY). Schema-
	 * only — constraints don't change row shape — except that dropping a UNIQUE
	 * also tears down the implicit covering index (the auto-built secondary BTree
	 * named `uc.name ?? '_uc_<cols>'`) so introspection / the declarative differ
	 * don't observe an orphaned index. The class is resolved here (NOTFOUND /
	 * ambiguous), so the engine can route through `module.alterTable` uniformly.
	 */
	async dropConstraint(constraintName: string): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const cls = resolveNamedConstraintClass(this.tableSchema, constraintName);
			const lower = constraintName.toLowerCase();
			let newSchema: TableSchema;
			let droppedIndexName: string | undefined;

			if (cls === 'check') {
				newSchema = Object.freeze({
					...this.tableSchema,
					checkConstraints: Object.freeze(
						this.tableSchema.checkConstraints.filter(c => c.name?.toLowerCase() !== lower),
					),
				});
			} else if (cls === 'foreignKey') {
				const remaining = (this.tableSchema.foreignKeys ?? []).filter(c => c.name?.toLowerCase() !== lower);
				newSchema = Object.freeze({
					...this.tableSchema,
					foreignKeys: remaining.length > 0 ? Object.freeze(remaining) : undefined,
				});
			} else {
				// UNIQUE — drop the constraint and its implicit covering index.
				const uc = this.tableSchema.uniqueConstraints!.find(c => c.name?.toLowerCase() === lower)!;
				const idxName = uc.name ?? this.implicitIndexNameFor(uc);
				const idxLower = idxName.toLowerCase();
				const existingIndexes = this.tableSchema.indexes ?? [];
				const keptIndexes = existingIndexes.filter(i => i.name.toLowerCase() !== idxLower);
				if (keptIndexes.length !== existingIndexes.length) droppedIndexName = idxName;
				const remainingUcs = this.tableSchema.uniqueConstraints!.filter(c => c.name?.toLowerCase() !== lower);
				newSchema = Object.freeze({
					...this.tableSchema,
					uniqueConstraints: remainingUcs.length > 0 ? Object.freeze(remainingUcs) : undefined,
					indexes: Object.freeze(keptIndexes),
				});
				this.implicitCoveringStructures.delete(uc.name ?? idxName);
			}

			this.baseLayer.updateSchema(newSchema);
			if (droppedIndexName) await this.baseLayer.dropIndexFromBase(droppedIndexName);
			this.tableSchema = newSchema;
			this.initializePrimaryKeyFunctions();
			// Hand the new schema to the DDL transaction's own frozen layers so a dropped UNIQUE
			// stops enforcing for the rest of it; harmless for CHECK/FK (they re-freeze an
			// equivalent schema, holding no per-layer structure).
			this.adoptSchemaOnOpenLayers(newSchema);

			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'table',
				schemaName: this.schemaName,
				objectName: this._tableName,
			});

			logger.operation('Drop Constraint', this._tableName, { constraintName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Drop Constraint', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * Renames a named table-level constraint. Schema-only, with one caveat: a
	 * UNIQUE whose implicit covering index is named after the constraint has that
	 * index renamed in lock-step (so the index stays recognized as the
	 * constraint's covering structure rather than surfacing as an orphan).
	 */
	async renameConstraint(oldName: string, newName: string): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();
			const cls = resolveNamedConstraintClass(this.tableSchema, oldName);
			const oldLower = oldName.toLowerCase();
			let newSchema: TableSchema;
			let renamedIndex = false;

			if (cls === 'check') {
				newSchema = Object.freeze({
					...this.tableSchema,
					checkConstraints: Object.freeze(
						this.tableSchema.checkConstraints.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: newName } : c)),
					),
				});
			} else if (cls === 'foreignKey') {
				newSchema = Object.freeze({
					...this.tableSchema,
					foreignKeys: Object.freeze(
						this.tableSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: newName } : c)),
					),
				});
			} else {
				// UNIQUE — rename the constraint and, when present, its implicit covering index.
				const uc = this.tableSchema.uniqueConstraints!.find(c => c.name?.toLowerCase() === oldLower)!;
				const oldIdxName = uc.name ?? this.implicitIndexNameFor(uc);
				const oldIdxLower = oldIdxName.toLowerCase();
				const newUcs = this.tableSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: newName } : c));
				let indexes = this.tableSchema.indexes ?? [];
				if (indexes.some(i => i.name.toLowerCase() === oldIdxLower)) {
					indexes = indexes.map(i => (i.name.toLowerCase() === oldIdxLower ? { ...i, name: newName } : i));
					renamedIndex = true;
				}
				newSchema = Object.freeze({
					...this.tableSchema,
					uniqueConstraints: Object.freeze(newUcs),
					indexes: Object.freeze(indexes),
				});
				const rec = this.implicitCoveringStructures.get(uc.name ?? oldIdxName);
				if (rec) {
					this.implicitCoveringStructures.delete(uc.name ?? oldIdxName);
					this.implicitCoveringStructures.set(newName, { ...rec, indexName: renamedIndex ? newName : rec.indexName });
				}
			}

			this.baseLayer.updateSchema(newSchema);
			// A renamed covering index lives under a new key — rebuild secondary indexes
			// from the post-rename schema so the base layer's index map matches.
			if (renamedIndex) this.baseLayer.rebuildAllSecondaryIndexes();
			this.tableSchema = newSchema;
			this.initializePrimaryKeyFunctions();
			// Hand the new schema to the DDL transaction's own frozen layers, as `dropConstraint`
			// does: a renamed covering index has to move under its new key in each layer's index
			// map (the old key is dropped, the new one rebuilt over the parent's already-renamed
			// tree — hence oldest-first), and even the pure schema-only classes (CHECK / FK) must
			// re-freeze the new schema OBJECT, or `commitTransaction`'s snapshot-wrap identity
			// check (`readLayer.getSchema() === this.tableSchema`) skips a savepoint snapshot
			// restored across this ALTER and drops the transaction's staged rows at COMMIT.
			this.adoptSchemaOnOpenLayers(newSchema);

			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'table',
				schemaName: this.schemaName,
				objectName: this._tableName,
			});

			logger.operation('Rename Constraint', this._tableName, { oldName, newName });
		} catch (e: unknown) {
			this.baseLayer.updateSchema(originalManagerSchema);
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Rename Constraint', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * Adds a table-level UNIQUE or FOREIGN KEY constraint to an existing table,
	 * re-validating the current rows against it and failing atomically with
	 * `CONSTRAINT` (no schema mutation) when the data violates it. Mirrors the
	 * latch + `ensureSchemaChangeSafety()` + snapshot/restore scaffolding of
	 * {@link createIndex} / {@link dropConstraint}.
	 *
	 * - UNIQUE builds (or reuses) the implicit covering secondary index; the build
	 *   raises `CONSTRAINT` on the first duplicate among in-scope rows (partial
	 *   predicate + per-column collation honored, NULLs distinct).
	 * - FOREIGN KEY appends the constraint and runs the pragma-gated existing-row
	 *   validation (engine-side enforcement needs no physical structure).
	 * - CHECK appends the constraint (no physical structure, no existing-row scan —
	 *   matching the engine's prior in-emitter behavior); it routes here, rather than
	 *   being applied catalog-only, so the module-cached schema stays in lock-step
	 *   with the catalog and a later `DROP/RENAME CONSTRAINT` resolves it. (The engine
	 *   keeps an engine-side fallback in `runtime/emit/add-constraint.ts` only for
	 *   modules that omit `alterTable` — which cannot DROP/RENAME a constraint anyway.)
	 */
	async addConstraint(constraint: ASTTableConstraint, rows?: EffectiveRowSource): Promise<void> {
		if (this.isReadOnly) throw new QuereusError(`Table '${this._tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		const originalManagerSchema = this.tableSchema;
		try {
			await this.ensureSchemaChangeSafety();

			if (constraint.type === 'unique') {
				await this.addUniqueConstraint(constraint, rows);
			} else if (constraint.type === 'foreignKey') {
				await this.addForeignKeyConstraint(constraint);
			} else if (constraint.type === 'check') {
				this.addCheckConstraint(constraint);
			} else {
				throw new QuereusError(
					`MemoryTable ADD CONSTRAINT does not support constraint type '${constraint.type}'`,
					StatusCode.UNSUPPORTED,
				);
			}

			this.eventEmitter?.emitSchemaChange?.({
				type: 'alter',
				objectType: 'table',
				schemaName: this.schemaName,
				objectName: this._tableName,
			});

			logger.operation('Add Constraint', this._tableName, { type: constraint.type, name: constraint.name });
		} catch (e: unknown) {
			// Restore the prior schema and rebuild secondary indexes (non-strict) so a
			// half-built covering index can't strand the base layer's index map.
			this.baseLayer.updateSchema(originalManagerSchema);
			this.baseLayer.rebuildAllSecondaryIndexes();
			this.tableSchema = originalManagerSchema;
			this.initializePrimaryKeyFunctions();
			logger.error('Add Constraint', this._tableName, e);
			throw e;
		} finally {
			release();
		}
	}

	/**
	 * CHECK arm of {@link addConstraint}. Schema-only: a CHECK has no covering
	 * structure and (matching the engine's prior in-emitter behavior) no existing-row
	 * validation, so this just appends the constraint to the cached schema. Enforcement
	 * is engine-side at INSERT/UPDATE plan time. Runs under the same latch / rollback
	 * scaffolding as the other arms (via {@link addConstraint}).
	 */
	private addCheckConstraint(constraint: ASTTableConstraint): void {
		const check = buildCheckConstraintSchema(constraint, this.tableSchema.checkConstraints.length);
		const newSchema: TableSchema = Object.freeze({
			...this.tableSchema,
			checkConstraints: Object.freeze([...this.tableSchema.checkConstraints, check]),
		});
		this.baseLayer.updateSchema(newSchema);
		this.tableSchema = newSchema;
	}

	/**
	 * UNIQUE arm of {@link addConstraint}. Builds the covering secondary index the
	 * same way {@link ensureUniqueConstraintIndexes} does (validating the DDL
	 * transaction's effective rows via {@link validateUniqueOverEffectiveRows} first),
	 * unless an existing *unique* index already covers the exact columns — in which
	 * case the data is already validated and we only register the covering structure.
	 */
	private async addUniqueConstraint(constraint: ASTTableConstraint, rows?: EffectiveRowSource): Promise<void> {
		const uc = buildUniqueConstraintSchema(constraint, this.tableSchema.columnIndexMap);
		const columns = this.tableSchema.columns;
		const existingIndexes = this.tableSchema.indexes ?? [];

		const appendedUcs = Object.freeze([...(this.tableSchema.uniqueConstraints ?? []), uc]);

		// Reuse: an existing UNIQUE index over the exact columns already guarantees
		// uniqueness, so skip the rebuild. A non-unique index gives no such guarantee
		// — fall through to build-and-validate. The reused index must ALSO be
		// collation-equivalent to the declared column collations: a finer/coarser
		// same-column-set index (e.g. a BINARY `create unique index` over a NOCASE
		// column) enforces under ITS collation, not the declared one, so reusing it
		// would under-enforce this non-derived UNIQUE. A collation mismatch falls
		// through to build the distinct `_uc_*` covering index; the user index keeps
		// enforcing its own (stricter) uniqueness independently (matches SQLite).
		const matchingUniqueIndex = existingIndexes.find(idx =>
			idx.unique &&
			idx.columns.length === uc.columns.length &&
			idx.columns.every((col, i) => col.index === uc.columns[i]) &&
			this.indexCollationsMatchDeclared(idx, uc),
		);

		if (matchingUniqueIndex) {
			// No validation pass: the reused index is UNIQUE, so its own derived constraint
			// has already rejected every colliding row — committed and pending alike.
			const newSchema: TableSchema = Object.freeze({
				...this.tableSchema,
				uniqueConstraints: appendedUcs,
			});
			this.baseLayer.updateSchema(newSchema);
			this.tableSchema = newSchema;
			this.initializePrimaryKeyFunctions();
			this.implicitCoveringStructures.set(
				uc.name ?? matchingUniqueIndex.name,
				{ indexName: matchingUniqueIndex.name, origin: 'implicit-from-unique-constraint' },
			);
			// This arm skips addIndexToBase, but the open transaction's layers still need the
			// new `uniqueConstraints` entry or they will not enforce it.
			this.adoptSchemaOnOpenLayers(newSchema);
			return;
		}

		const colNames = uc.columns.map(i => columns[i]?.name ?? String(i));
		const indexName = uc.name ?? `_uc_${colNames.join('_')}`;
		const indexSchema: IndexSchema = {
			name: indexName,
			// Carry per-column collation so enforcement honors e.g. NOCASE (mirrors
			// ensureUniqueConstraintIndexes). The covering index is NOT flagged unique
			// — insert-time enforcement routes through `uniqueConstraints`.
			columns: uc.columns.map(colIdx => ({ index: colIdx, collation: columns[colIdx]?.collation })),
			predicate: uc.predicate,
		};

		// Validate BEFORE any mutation, over the DDL transaction's EFFECTIVE rows (throws
		// CONSTRAINT on the first in-scope duplicate). The covering index carries no
		// `unique: true` flag, so `addIndexToBase` would not check it anyway — and must
		// not: it populates from committed rows, which may still hold a duplicate this
		// transaction has deleted.
		await this.validateUniqueOverEffectiveRows(indexSchema, this.tableSchema, rows);

		const newSchema: TableSchema = Object.freeze({
			...this.tableSchema,
			uniqueConstraints: appendedUcs,
			indexes: Object.freeze([...existingIndexes, indexSchema]),
		});

		this.baseLayer.updateSchema(newSchema);
		await this.baseLayer.addIndexToBase(indexSchema);
		this.tableSchema = newSchema;
		this.initializePrimaryKeyFunctions();
		this.implicitCoveringStructures.set(
			uc.name ?? indexName,
			{ indexName, origin: 'implicit-from-unique-constraint' },
		);
		this.adoptSchemaOnOpenLayers(newSchema);
	}

	/**
	 * FOREIGN KEY arm of {@link addConstraint}. Validates existing child rows
	 * against the new FK (pragma-gated; throws CONSTRAINT on an orphan), then
	 * appends it to the cached schema. No physical structure — FK enforcement is
	 * engine-side (synthesized EXISTS checks at plan time).
	 */
	private async addForeignKeyConstraint(constraint: ASTTableConstraint): Promise<void> {
		const fk = buildForeignKeyConstraintSchema(
			constraint,
			this.tableSchema.columnIndexMap,
			this._tableName,
			this.schemaName,
		);
		const newSchema: TableSchema = Object.freeze({
			...this.tableSchema,
			foreignKeys: Object.freeze([...(this.tableSchema.foreignKeys ?? []), fk]),
		});

		// Validate BEFORE swapping the cached schema — a throw leaves the table
		// unmodified. The scan only reads (no schema-change latch), so holding our
		// own latch here is safe; ensureSchemaChangeSafety already drained to base.
		await validateForeignKeyOverExistingRows(this.db, newSchema, fk);

		this.baseLayer.updateSchema(newSchema);
		this.tableSchema = newSchema;
		this.initializePrimaryKeyFunctions();
	}

	public async destroy(): Promise<void> {
		const lockKey = `MemoryTable.Destroy:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);
		try {
			for (const connection of this.connections.values()) {
				if (connection.pendingTransactionLayer) connection.rollback();
			}
			this.connections.clear();
			this.baseLayer = new BaseLayer(this.tableSchema, this.collationResolver);
			this._currentCommittedLayer = this.baseLayer;
			logger.operation('Destroy', this._tableName, 'Manager destroyed and data cleared');
		} finally {
			release();
		}
	}

	private async ensureSchemaChangeSafety(): Promise<void> {
		if (this._currentCommittedLayer !== this.baseLayer) {
			logger.warn('Schema Change', this._tableName, 'Transaction layers exist. Attempting to consolidate to base...');

			// For schema changes, we need to consolidate all data into the base layer
			// instead of just promoting layers
			await this.consolidateToBaseLayer();

			if (this._currentCommittedLayer !== this.baseLayer) {
				throw new QuereusError(
					`Cannot perform schema change on table ${this._tableName} while older transaction versions are in use by active connections. Commit/rollback active transactions and retry.`,
					StatusCode.BUSY
				);
			}
		}

		// Consolidation drains COMMITTED layers into the base; a connection's own
		// UNCOMMITTED writes are untouched by it. Those rows are invisible to the DDL's
		// transaction, so a row-validating schema change cannot be checked against them,
		// and the sibling's layers cannot be re-pointed at the new schema. Only the
		// DDL-issuing connection may hold open work — everyone else must land first.
		const ddlConnection = this.ddlConnection();
		for (const connection of this.knownConnections()) {
			if (connection === ddlConnection || !connection.hasOpenWork()) continue;
			throw new QuereusError(
				`Cannot perform schema change on table ${this._tableName} while another connection has uncommitted changes. Commit/rollback active transactions and retry.`,
				StatusCode.BUSY
			);
		}

		// After ensuring we're at the base layer, update all connections to read from the base layer
		// This is necessary because connections might still be reading from promoted/collapsed layers.
		// The DDL issuer's own open transaction is exempt: its read view is a pending layer or an
		// eager savepoint snapshot holding its uncommitted rows, and re-pointing it at the base
		// would silently drop them from every later read in that transaction.
		for (const connection of this.connections.values()) {
			if (connection.readLayer !== this.baseLayer && !connection.hasOpenWork()) {
				logger.debugLog(`[Schema Safety] Updating connection ${connection.connectionId} to read from base layer`);
				connection.readLayer = this.baseLayer;
			}
		}

		// The manager's `connections` map covers only connections still attached to this
		// manager. A connection can be DETACHED from the map (removed by disconnect after an
		// autocommit collapse) while remaining REGISTERED in the Database connection registry —
		// `MemoryTable.ensureConnection` reuses exactly such a connection for a later scan. The
		// loop above misses it, so after an in-transaction schema change (e.g. ALTER TABLE ADD
		// COLUMN, now permitted inside an explicit transaction) it keeps reading a stale
		// pre-change layer carrying the OLD column shape — the materialized-view-source-stale-read
		// bug. A detached connection always has `pendingTransactionLayer === null` (disconnect
		// defers while a pending layer is uncommitted), so this never discards in-flight writes.
		this.repointRegisteredConnections();

		// Re-pointing `readLayer` is not enough: a savepoint taken while a connection held no
		// pending layer stored the layer it was READING as the view to restore. Consolidation
		// has just drained that layer into the base, and the caller is about to reshape the
		// base's rows — so the stored reference is a pre-change snapshot of the committed rows.
		// Left alone, the transaction's `rollback to savepoint` reinstates it and the old column
		// shape commits over the new one.
		//
		// Every connection, not just the re-pointed ones: the DDL issuer is exempt from the
		// sweeps above (its read view holds its own uncommitted rows) but its own lazy markers
		// are just as stale.
		for (const connection of this.knownConnections()) {
			connection.repointLazySavepointsToCommittedHead(this.baseLayer);
		}

		logger.debugLog(`Schema change safety check passed for ${this._tableName}. Current committed layer is base.`);
	}

	/**
	 * Re-point every Database-registered {@link MemoryTableConnection} backed by this
	 * manager (including ones detached from {@link connections}) at the current base layer,
	 * when it carries no uncommitted pending layer. Companion to the `connections`-map sweep
	 * in {@link ensureSchemaChangeSafety}: it closes the gap for a connection that lives in
	 * the Database registry but not in the manager's map.
	 */
	private repointRegisteredConnections(): void {
		for (const mc of this.registeredConnections()) {
			if (mc.hasOpenWork()) continue;
			if (mc.readLayer === this.baseLayer) continue;
			logger.debugLog(`[Schema Safety] Re-pointing registered connection ${mc.connectionId} to base layer`);
			mc.readLayer = this.baseLayer;
		}
	}

	/**
	 * Moves this manager's Database-registered connections from `<schema>.<oldName>` to
	 * `<schema>.<newName>`, for `ALTER TABLE ... RENAME TO`.
	 *
	 * `MemoryVirtualTableConnection.tableName` is set once at registration, and
	 * `Database.getConnectionsForTable` matches on exactly that string — so without this
	 * sweep a rename makes the transaction's own connection invisible to
	 * {@link registeredConnections} and everything built on it: {@link ddlConnection},
	 * {@link knownConnections}, {@link repointRegisteredConnections},
	 * {@link openTransactionLayersOldestFirst}. The visible symptom is a second ALTER in
	 * the same transaction failing with BUSY — {@link ensureSchemaChangeSafety} exempts
	 * `ddlConnection()` from its "nobody else may hold open work" sweep, and with the
	 * registry stale that is `undefined`, so the transaction's own connection is judged a
	 * stranger. `MemoryTable.ensureConnection` would likewise stop reusing it and register
	 * a second connection for the same table.
	 *
	 * Must run BEFORE `_tableName` moves — it looks the connections up under the old name.
	 */
	private rekeyRegisteredConnections(oldName: string, newName: string): void {
		const newQualifiedName = `${this.schemaName}.${newName}`;
		for (const c of this.db.getConnectionsForTable(`${this.schemaName}.${oldName}`)) {
			if (!(c instanceof MemoryVirtualTableConnection)) continue;
			if (c.getMemoryConnection().tableManager !== this) continue;
			c.rename(newQualifiedName);
		}
	}

	/** Every Database-registered {@link MemoryTableConnection} backed by this manager. */
	private *registeredConnections(): Iterable<MemoryTableConnection> {
		const qualifiedName = `${this.schemaName}.${this._tableName}`;
		for (const c of this.db.getConnectionsForTable(qualifiedName)) {
			if (!(c instanceof MemoryVirtualTableConnection)) continue;
			const mc = c.getMemoryConnection();
			if (mc.tableManager !== this) continue;
			yield mc;
		}
	}

	/**
	 * Every connection this manager can see: the ones still attached to {@link connections}
	 * (including unregistered committed-snapshot readers) plus the Database-registered ones,
	 * which may have been detached from the map by a post-autocommit disconnect.
	 */
	private *knownConnections(): Iterable<MemoryTableConnection> {
		const seen = new Set<MemoryTableConnection>();
		for (const mc of this.connections.values()) {
			seen.add(mc);
			yield mc;
		}
		for (const mc of this.registeredConnections()) {
			if (seen.has(mc)) continue;
			seen.add(mc);
			yield mc;
		}
	}

	/**
	 * The connection through which the current DDL statement's transaction runs, if any.
	 *
	 * A statement reaches a memory table through the single Database-registered connection
	 * for it (`MemoryTable.ensureConnection` and `getVTableConnection` both reuse the first
	 * one), so that connection's view IS this statement's transaction. In autocommit with
	 * no prior scan there is no connection at all, and the committed base is the whole story.
	 *
	 * NOTE: takes the FIRST registered connection, matching how both reuse sites pick one.
	 * If the registry ever holds more than one connection per (table, transaction), this
	 * picks arbitrarily — validate against the writer instead, and treat the rest as
	 * siblings.
	 */
	private ddlConnection(): MemoryTableConnection | undefined {
		for (const mc of this.registeredConnections()) return mc;
		return undefined;
	}

	/**
	 * The rows a `select` issued by the DDL statement's own transaction would see: the
	 * committed base overlaid with that connection's uncommitted writes. Degenerates to the
	 * base primary tree when no connection holds open work.
	 *
	 * `pendingTransactionLayer ?? readLayer` is exactly the layer `MemoryTable.query` scans,
	 * and each layer's primary BTree is copy-on-write over its parent's, so one ascending
	 * walk yields the merged view (pending inserts/updates present, pending deletes absent).
	 */
	private effectiveDdlRows(): Iterable<Row> {
		const connection = this.ddlConnection();
		const layer: Layer = connection
			? (connection.pendingTransactionLayer ?? connection.readLayer)
			: this.baseLayer;
		return iteratePrimaryRows(layer.getModificationTree('primary') ?? this.baseLayer.primaryTree);
	}

	/**
	 * The committed base rows for `alter column … set data type` / `set not null` backfill, with the
	 * value at `colIndex` run through `convert`. NULLs pass through untouched UNLESS `convertNulls` is
	 * set (the SET NOT NULL backfill maps null → DEFAULT). A value that fails to convert is kept as-is:
	 * the manager validated every value in the effective VIEW before calling, so a base value that
	 * fails here is one a pending delete/overwrite shadows and no reader can see. The result is a fresh
	 * full row list for {@link BaseLayer.rebuildPrimaryTreeFromRows} — the base primary tree is
	 * REPLACED, never mutated in place (inheritree forbids mutating a tree the open transaction's
	 * layers derive from).
	 */
	private convertBaseRows(colIndex: number, convert: (v: SqlValue) => SqlValue, convertNulls = false): Row[] {
		const out: Row[] = [];
		for (const row of iteratePrimaryRows(this.baseLayer.primaryTree)) {
			try {
				out.push(convertRowAtIndex(row, colIndex, convert, convertNulls));
			} catch {
				out.push(row); // shadowed unconvertible value — keep as-is
			}
		}
		return out;
	}

	/**
	 * Rejects an index/constraint whose uniqueness the DDL transaction's own effective rows
	 * already violate, BEFORE anything is mutated. Builds a throwaway {@link MemoryIndex} —
	 * the collation-aware, partial-predicate-aware key comparator — over those rows and lets
	 * {@link populateIndexFromRows} raise CONSTRAINT on the first duplicate.
	 *
	 * `rows` overrides {@link effectiveDdlRows}. A wrapper module (the isolation layer) holds
	 * the transaction's pending rows outside this manager, so only it can name the rows the
	 * issuing connection actually sees; when it supplies them, they are the judged set and this
	 * manager's own committed rows are ignored. See `vtab/module.ts` {@link EffectiveRowSource}.
	 *
	 * `mapRow` judges the rows in a form they do not yet have on disk: an `alter column` that
	 * REWRITES values passes the per-row conversion here, so the probe sees the post-ALTER
	 * values. Applied to whichever stream is used; the mapping is a read-side wrap and mutates
	 * nothing.
	 */
	private async validateUniqueOverEffectiveRows(
		indexSchema: IndexSchema,
		schema: TableSchema,
		rows?: EffectiveRowSource,
		mapRow?: RowMapper,
	): Promise<void> {
		const probe = new MemoryIndex(
			indexSchema,
			schema.columns,
			this.collationResolver,
			this.primaryKeyFunctions.compare,
			this.primaryKeyFunctions.encode,
			schema.name,
		);
		if (rows) {
			const stream = mapRow ? mapRowsAsync(rows(), mapRow) : rows();
			await populateIndexFromRowsAsync(
				stream,
				probe,
				this.primaryKeyFunctions.extractFromRow,
				true,
				this._tableName,
				schema.columns,
			);
			return;
		}
		const own = this.effectiveDdlRows();
		populateIndexFromRows(
			mapRow ? mapRows(own, mapRow) : own,
			probe,
			this.primaryKeyFunctions.extractFromRow,
			true,
			this._tableName,
			schema.columns,
		);
	}

	/**
	 * `ALTER COLUMN` arm of {@link validateUniqueOverEffectiveRows}: rejects the change when it
	 * makes two of the DDL transaction's effective rows collide under any uniqueness-enforcing
	 * structure that covers the altered column. Runs before anything is mutated, so a rejection
	 * leaves the table and schema untouched and the transaction usable.
	 *
	 * Serves both families of change that can collapse two distinct values onto one:
	 *
	 *  - `SET COLLATE` re-keys the structures under a new comparator; the stored values are
	 *    untouched, so no `mapRow` is passed.
	 *  - a value REWRITE (`SET DATA TYPE`, or a `SET NOT NULL` null → DEFAULT backfill) leaves
	 *    the comparators alone but changes the values; the caller passes a `mapRow` that applies
	 *    the same per-row conversion the base rewrite will, so the probe judges the post-ALTER
	 *    values.
	 *
	 * `newSchema` carries the post-change per-column collations AND logical types, so each probe
	 * index compares exactly as the rebuilt structure will (it matters for e.g. `text → real`).
	 * Indexes that do not mention the column keep their keys and need no re-check.
	 *
	 * NOTE: walks `schema.indexes`, so a UNIQUE constraint covered by a row-time materialized
	 * view rather than its auto-index (`findIndexForConstraint` prefers the MV) is not re-checked
	 * here. The auto-index always exists alongside, so the structure is still validated — but if
	 * an MV-only covering shape ever becomes reachable, this walk must follow it.
	 */
	private async validateRekeyedUniqueStructures(
		newSchema: TableSchema,
		alteredColumnIndex: number,
		rows?: EffectiveRowSource,
		mapRow?: RowMapper,
	): Promise<void> {
		// NOTE: the probe index carries the manager's PRE-change `primaryKeyFunctions` (the new
		// ones cannot exist before the schema swaps). Only the probe's per-entry PK bookkeeping
		// uses them, and every effective row already has a distinct PK under the old encoder, so
		// duplicate detection — which fires on the index key, before any PK is stored — is
		// unaffected. If a probe ever needs to compare PKs semantically, pass the new functions in.
		for (const indexSchema of newSchema.indexes ?? []) {
			if (!indexSchema.columns.some(c => c.index === alteredColumnIndex)) continue;
			if (!indexEnforcesUnique(newSchema, indexSchema)) continue;
			// `rows` is re-callable, so each structure gets a fresh stream.
			await this.validateUniqueOverEffectiveRows(indexSchema, newSchema, rows, mapRow);
		}
	}

	/**
	 * PRIMARY KEY arm of the `alter column … set collate` pre-pass. Runs before anything is
	 * mutated, so a rejection leaves the table, the schema and the transaction untouched.
	 *
	 * Asks two questions, in order, over two DIFFERENT row sets:
	 *
	 *  1. **Is the change legal at all?** — probes the rows the DDL transaction can SEE: the
	 *     wrapper-supplied `rows` when a wrapper module (the isolation layer) holds the
	 *     transaction's pending rows outside this manager, otherwise this manager's own
	 *     layered view ({@link effectiveDdlRows}). A duplicate here is visible to a `select`
	 *     in this transaction, so the change is simply illegal → `CONSTRAINT`, naming the
	 *     colliding key.
	 *  2. **Can the structures physically carry it?** — probes every layer of this manager's
	 *     own chain. The primary tree is a map, not a multi-map, so — unlike a secondary
	 *     index — no tree that a `rollback` / `rollback to savepoint` could restore may hold
	 *     two rows whose keys collapse under the new comparator. A collision confined to
	 *     committed rows the transaction has DELETED is therefore refused by physical
	 *     necessity, not because the data is invalid: the base must keep both rows for a
	 *     rollback, and a base re-keyed under the new collation could not represent the pair
	 *     at all → `BUSY` with the same "commit/rollback and retry" posture as
	 *     {@link ensureSchemaChangeSafety}. The persistent store backend refuses the same
	 *     shape for the same reason (its committed rows equally survive a rollback — see
	 *     `backlog/bug-store-pk-collate-rejects-deleted-row-collision`); accepting it would
	 *     take transaction-scoped DDL (`backlog/feat-transactional-ddl-native-backends`),
	 *     which Quereus does not have.
	 *
	 * The passes judge different sets because a wrapper's effective stream and this manager's
	 * layers genuinely diverge: staged inserts exist only in the stream, deleted committed
	 * rows only in the layers. When `rows` is supplied, the view layer holds the COMMITTED
	 * rows — not a subset of what pass 1 judged — so pass 2 starts AT the view; when `rows`
	 * is absent, pass 1 judged exactly the view's rows and pass 2 starts at its parent.
	 *
	 * Pass 2 is deliberately conservative. The chain holds one immutable layer per statement
	 * boundary (see `MemoryTableConnection.createSavepoint`'s eager path), so it rejects any
	 * transaction that has held a colliding pair at ANY statement boundary — even one whose
	 * final view is clean and whose intermediate layer no savepoint can reach. Narrowing that
	 * would mean re-parenting the view's tree past the unreachable layers, which is exactly the
	 * rebase that savepoint snapshots exist to avoid. The tradeoff is a rare false BUSY on a
	 * statement sequence the user can retry after committing, versus losing a row on rollback.
	 *
	 * This precondition is also what makes `TransactionLayer.rekeyPrimaryKey`'s replay sound:
	 * with no collisions anywhere in the chain, every primary key resolves to at most one row
	 * in each layer under the new comparator.
	 */
	private async validateRekeyedPrimaryKey(newSchema: TableSchema, rows?: EffectiveRowSource): Promise<void> {
		const newPkFunctions = createPrimaryKeyFunctions(newSchema, this.collationResolver);
		const connection = this.ddlConnection();
		const view: Layer = connection
			? (connection.pendingTransactionLayer ?? connection.readLayer)
			: this.baseLayer;

		await this.assertNoPrimaryKeyCollisionInRows(
			rows ? rows() : this.effectiveDdlRows(),
			newPkFunctions,
			primaryKeyArity(newSchema) !== 1,
		);

		// `ensureSchemaChangeSafety` has already drained every committed layer into the base and
		// rejected sibling connections with open work, so this walk covers the transaction's own
		// layers plus the base — every tree a rollback could restore.
		for (let layer: Layer | null = rows ? view : view.getParent(); layer; layer = layer.getParent()) {
			this.assertNoPrimaryKeyCollisionInLayer(layer, newPkFunctions);
		}
	}

	/**
	 * A duplicate-key detector over the new primary key functions: feed it rows, and it returns
	 * the key the moment one repeats. Shared by both arms of {@link validateRekeyedPrimaryKey}
	 * so the async (effective-row) arm and the sync (layer-tree) arm cannot disagree about what
	 * counts as a collision.
	 *
	 * NOTE: the probe holds every row it has seen, because the BTree derives its key from the
	 * stored value — so an ALTER over a large table transiently doubles that table's row
	 * references. If a wide table ever makes this the memory peak, key the probe by the PK
	 * encoding (`primaryKeyFunctions.encode`) into a `Set` instead of by the row.
	 */
	private makePrimaryKeyProbe(pkFunctions: PrimaryKeyFunctions): (row: Row) => BTreeKeyForPrimary | undefined {
		const probe = new BTree<BTreeKeyForPrimary, Row>(
			(row: Row): BTreeKeyForPrimary => pkFunctions.extractFromRow(row),
			pkFunctions.compare,
		);
		return (row: Row): BTreeKeyForPrimary | undefined => {
			const key = pkFunctions.extractFromRow(row);
			if (probe.get(key) !== undefined) return key;
			probe.insert(row);
			return undefined;
		};
	}

	/**
	 * Legality arm of {@link validateRekeyedPrimaryKey}: raises `CONSTRAINT`, naming the key,
	 * when two of the rows the DDL transaction can SEE share a primary key under `pkFunctions`.
	 * Takes a wrapper's merged async stream or this manager's own synchronous layered view.
	 */
	private async assertNoPrimaryKeyCollisionInRows(
		rows: Iterable<Row> | AsyncIterable<Row>,
		pkFunctions: PrimaryKeyFunctions,
		keyIsTuple: boolean,
	): Promise<void> {
		const seen = this.makePrimaryKeyProbe(pkFunctions);
		for await (const row of rows) {
			const key = seen(row);
			if (key === undefined) continue;
			const keyDesc = keyParts(key, keyIsTuple).map(formatKeyValue).join(', ');
			throw new QuereusError(
				`UNIQUE constraint failed: ${this._tableName} primary key collides under new collation (key: ${keyDesc})`,
				StatusCode.CONSTRAINT,
			);
		}
	}

	/**
	 * Representability arm of {@link validateRekeyedPrimaryKey}: raises `BUSY` when two of
	 * `layer`'s physical rows share a primary key under `pkFunctions`. Its rows are ones a
	 * rollback could restore, not ones the transaction can see, so this is never a statement
	 * about the data's validity — hence the retryable status and wording.
	 *
	 * NOTE: O(rows) per layer, so O(layers × rows) for a whole chain — one more full pass than
	 * the base rebuild the caller is about to do anyway. Fine for a statement this rare; if a
	 * deep savepoint stack over a large table ever makes an ALTER slow, note that a layer's rows
	 * differ from its parent's only at the keys it wrote, so the walk can be narrowed to those.
	 */
	private assertNoPrimaryKeyCollisionInLayer(layer: Layer, pkFunctions: PrimaryKeyFunctions): void {
		const tree = layer.getModificationTree('primary');
		if (!tree) return;
		const seen = this.makePrimaryKeyProbe(pkFunctions);
		for (const row of iteratePrimaryRows(tree)) {
			if (seen(row) !== undefined) {
				throw new QuereusError(
					`Cannot change the collation of a primary key column of table ${this._tableName}: `
					+ `rows this transaction has removed still collide under the new collation and must survive a rollback. `
					+ `Commit/rollback and retry.`,
					StatusCode.BUSY,
				);
			}
		}
	}

	/**
	 * Propagates a schema change — a new index and/or UNIQUE constraint, or a set of structures
	 * re-keyed by `alter column … set collate` — into every {@link TransactionLayer} the DDL
	 * connection's open transaction still reads through: its pending layer and every savepoint
	 * snapshot below it, which are exactly the transaction layers on the view layer's parent
	 * chain above the base.
	 *
	 * Without this the transaction would keep enforcing (and scanning) its creation-time schema
	 * for the rest of its life, a `rollback to savepoint` would restore a stale-schema layer,
	 * and at commit the pending layer would become the committed head carrying its stale schema
	 * and structures — shadowing the base's rebuilt ones. Rebasing would achieve the same but
	 * invalidate those snapshots. Applied oldest-first: both
	 * {@link TransactionLayer.adoptSchema} and {@link TransactionLayer.rekeyPrimaryKey} inherit
	 * their parent's already-rebuilt trees.
	 *
	 * `rekeyPrimary` selects the heavier path, for the one change that invalidates a layer's
	 * primary key functions and every structure derived from them: a collation change on a
	 * primary key column.
	 */
	private adoptSchemaOnOpenLayers(newSchema: TableSchema, rekeyPrimary = false): void {
		for (const layer of this.openTransactionLayersOldestFirst()) {
			if (rekeyPrimary) layer.rekeyPrimaryKey(newSchema);
			else layer.adoptSchema(newSchema);
		}
	}

	/**
	 * Converts the altered column's own-written values in every open transaction layer, after
	 * `alter column … set data type` / `set not null` backfill has converted the base. Runs
	 * oldest-first so each layer's copy-on-write base inherits its parent's already-converted rows
	 * and only the layer's OWN writes are rewritten (see {@link TransactionLayer.convertColumn}).
	 * `convertNulls` routes null own-values through `convert` (the SET NOT NULL null → DEFAULT map);
	 * SET DATA TYPE leaves them untouched. No-op in autocommit.
	 *
	 * PRIMARY-KEY columns never reach here — any retype of a key column is rejected before
	 * any mutation, and SET NOT NULL leaves the key bytes unchanged — so the primary tree's keys are
	 * stable and no re-key is needed.
	 */
	private convertColumnOnOpenLayers(newSchema: TableSchema, colIndex: number, convert: (v: SqlValue) => SqlValue, convertNulls = false): void {
		for (const layer of this.openTransactionLayersOldestFirst()) {
			layer.convertColumn(colIndex, convert, newSchema, convertNulls);
		}
	}

	/**
	 * Phase 1 of propagating `add column` / `drop column` into every open transaction layer:
	 * computes each layer's net own-writes rewritten to the new column set, WITHOUT mutating
	 * anything (see {@link TransactionLayer.prepareReshapedColumns}). Runs BEFORE the base is
	 * touched, because `reshapeRow` can throw — ADD COLUMN's per-row backfill evaluates an
	 * engine-supplied `default (new.<col>)` expression against each pending row, and enforces
	 * NOT NULL on the result — and a failure part-way through a mutation pass would leave the
	 * base and the already-visited layers at the new arity with the rest at the old, with no
	 * undo. Failing here instead rejects the ALTER with every structure untouched, exactly like
	 * the pre-mutation validation passes of `alterColumn`.
	 *
	 * The returned plans pin the layer set: {@link installReshapeOnOpenLayers} walks the plans,
	 * not a fresh chain snapshot, so the two phases cannot disagree about which layers exist.
	 * Reading each layer's effective rows here — before the base rebuild — yields the same rows
	 * the single-pass prototype read after it: a layer's pre-reshape tree resolves against the
	 * parent's OLD tree either way (the base rebuild REPLACES the base's tree object; it never
	 * mutates the one the layers inherit from).
	 */
	private async prepareReshapeOnOpenLayers(
		reshapeRow: (row: Row) => Row | Promise<Row>,
		reshapeEventRow: (row: Row) => Row | Promise<Row>,
	): Promise<Array<{ layer: TransactionLayer; prepared: PreparedColumnReshape }>> {
		const plans: Array<{ layer: TransactionLayer; prepared: PreparedColumnReshape }> = [];
		for (const layer of this.openTransactionLayersOldestFirst()) {
			plans.push({ layer, prepared: await layer.prepareReshapedColumns(reshapeRow, reshapeEventRow) });
		}
		return plans;
	}

	/**
	 * Phase 2: installs the prepared reshape into each open transaction layer, oldest-first
	 * (the plans were gathered in that order), after the base has been rebuilt at the new arity
	 * — each layer's rebuilt tree inherits copy-on-write from its parent's NEW one. Synchronous
	 * and mutation-only; everything fallible ran in {@link prepareReshapeOnOpenLayers}.
	 *
	 * Beyond keeping the transaction's own reads correct, this is what makes the
	 * `commitTransaction` snapshot-wrap identity check (`readLayer.getSchema() ===
	 * this.tableSchema`) pass after a `rollback to savepoint`: without it the eager savepoint
	 * snapshot keeps its frozen pre-ALTER schema, the wrap is skipped, and the snapshot's rows
	 * are silently dropped at commit.
	 */
	private installReshapeOnOpenLayers(
		newSchema: TableSchema,
		plans: ReadonlyArray<{ layer: TransactionLayer; prepared: PreparedColumnReshape }>,
	): void {
		for (const { layer, prepared } of plans) {
			layer.installReshapedColumns(newSchema, prepared);
		}
	}

	/**
	 * The DDL connection's open {@link TransactionLayer}s, oldest-first, base excluded — its
	 * pending layer and every savepoint snapshot below it, the layers on the view's parent chain
	 * above the base. Empty in autocommit (no connection, or the view IS the base).
	 *
	 * Schema adoption ({@link adoptSchemaOnOpenLayers}), value conversion
	 * ({@link convertColumnOnOpenLayers}), and column-set reshape
	 * ({@link prepareReshapeOnOpenLayers} / {@link installReshapeOnOpenLayers}) MUST all apply
	 * oldest-first: each layer rebuilds its structures over its parent's, so the parent's must
	 * already be the new/converted/reshaped ones.
	 *
	 * NOTE: the walk takes every TransactionLayer below the view, which normally means the pending
	 * layer and its savepoint snapshots. A committed layer already drained into the base by
	 * `ensureSchemaChangeSafety` can also sit in the chain (the pending layer forked from it before
	 * consolidation); it still shadows the base with its OWN unadapted rows while it remains the
	 * view's copy-on-write base, so it must be adapted too — it cannot be skipped, since a savepoint
	 * snapshot is `markCommitted()` as well. Both callers' per-layer work is idempotent and additive.
	 */
	private openTransactionLayersOldestFirst(): TransactionLayer[] {
		const connection = this.ddlConnection();
		if (!connection) return [];

		const view = connection.pendingTransactionLayer ?? connection.readLayer;
		const chain: TransactionLayer[] = [];
		for (let cur: Layer | null = view; cur && cur !== this.baseLayer; cur = cur.getParent()) {
			if (cur instanceof TransactionLayer) chain.push(cur);
		}
		return chain.reverse();
	}

	/** Consolidates all transaction data into the base layer for schema changes */
	private async consolidateToBaseLayer(): Promise<void> {
		const lockKey = `MemoryTable.Consolidate:${this.schemaName}.${this._tableName}`;
		const release = await this.db.latches.acquire(lockKey);

		try {
			logger.debugLog(`[Consolidate] Acquired lock for ${this._tableName}`);

			// If current committed layer is a transaction layer, we need to merge its data into the base
			if (this._currentCommittedLayer instanceof TransactionLayer && this._currentCommittedLayer.isCommitted()) {
				const transactionLayer = this._currentCommittedLayer as TransactionLayer;

				logger.debugLog(`[Consolidate] Copying data from transaction layer ${transactionLayer.getLayerId()} to base layer for ${this._tableName}`);

				// Copy all data from the transaction layer to the base layer
				await this.copyTransactionDataToBase(transactionLayer);

				// The drained chain's pending-change event logs were already delivered when
				// each layer committed, but the layers can remain in the DDL connection's own
				// open-transaction parent chain. Once the base becomes the committed head, the
				// commit-time collection (`collectPendingChanges`) walks that chain down to
				// the base and would re-deliver them — clear the logs so consolidation is
				// event-neutral. (Savepoint snapshots of the OPEN transaction sit above the
				// committed head, not in this chain, so their un-emitted events are kept.)
				for (let cur: Layer | null = transactionLayer; cur && cur !== this.baseLayer; cur = cur.getParent()) {
					if (cur instanceof TransactionLayer) cur.clearPendingChanges();
				}

				// Force all connections to read from the base layer
				for (const conn of this.connections.values()) {
					if (conn.readLayer === transactionLayer) {
						logger.debugLog(`[Consolidate] Updating connection ${conn.connectionId} from transaction layer to base layer`);
						conn.readLayer = this.baseLayer;
					}
				}

				// Now we can set the base layer as the current committed layer
				this._currentCommittedLayer = this.baseLayer;
				logger.debugLog(`[Consolidate] CurrentCommittedLayer set to base for ${this._tableName}`);
			}
		} finally {
			release();
			logger.debugLog(`[Consolidate] Released lock for ${this._tableName}`);
		}
	}

	/** Copies all data from a transaction layer to the base layer */
	private async copyTransactionDataToBase(transactionLayer: TransactionLayer): Promise<void> {
		const primaryTree = transactionLayer.getModificationTree('primary');
		if (!primaryTree) return;

		// Collect all rows first to avoid modifying the base tree while iterating
		// the inherited BTree (whose parent IS the base tree).
		const allRows: Row[] = [];
		for (const path of primaryTree.ascending(primaryTree.first())) {
			allRows.push(primaryTree.at(path)!);
		}

		logger.debugLog(`[Consolidate] Collected ${allRows.length} rows from transaction layer. Row widths: ${allRows.map(r => r.length).join(',')}`);

		// Replace (do not union into) the base primary tree: `allRows` is the layer's
		// merged view with deletes already applied, so any row deleted in the
		// transaction layer must be physically removed from the base — otherwise a
		// later base-direct scan (e.g. a UNIQUE index build) resurrects it. This also
		// rebuilds the base secondary indexes from the new tree.
		this.baseLayer.rebuildPrimaryTreeFromRows(allRows);
	}

	/**
	 * Sync scan — the hot path (query()/internal maintenance) avoids the async hop.
	 * The backing BTree (inheritree) and all per-row filter/early-term logic are
	 * fully synchronous, so no async boundary belongs here.
	 */
	public scanLayerSync(layer: Layer, plan: ScanPlan): Iterable<Row> {
		return scanLayerImpl(layer, plan);
	}

	/**
	 * Async adapter for external `AsyncIterable<Row>` callers (tests,
	 * `module.scanEffective`, the backing-host). Retained deliberately — do not
	 * delete thinking it is dead; delegates to {@link scanLayerSync}.
	 */
	public async* scanLayer(layer: Layer, plan: ScanPlan): AsyncIterable<Row> {
		yield* this.scanLayerSync(layer, plan);
	}
}

