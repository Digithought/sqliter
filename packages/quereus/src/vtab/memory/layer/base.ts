import { BTree } from 'inheritree';
import type { TableSchema } from '../../../schema/table.js';
import type { BTreeKeyForPrimary, BTreeKeyForIndex, MemoryIndexEntry } from '../types.js';
import type { Layer, PkExtractorsAndComparators } from './interface.js';
import { MemoryIndex } from '../index.js';
import { StatusCode, type Row, type SqlValue } from '../../../common/types.js';
import { type ColumnSchema } from '../../../schema/column.js';
import type { IndexSchema } from '../../../schema/table.js';
import { createPrimaryKeyFunctions, type PrimaryKeyFunctions } from '../utils/primary-key.js';
import { createMemoryTableLoggers } from '../utils/logging.js';
import { QuereusError } from '../../../common/errors.js';
import type { CollationResolver } from '../../../types/logical-type.js';

let baseLayerCounter = 0;
const logger = createMemoryTableLoggers('layer:base');

/** Every row of a primary BTree, ascending by primary key. */
export function* iteratePrimaryRows(tree: BTree<BTreeKeyForPrimary, Row>): Iterable<Row> {
	for (const path of tree.ascending(tree.first())) {
		yield tree.at(path)!;
	}
}

/**
 * Inserts every in-scope row of `rows` into the (freshly-created, empty-or-inherited)
 * `index`, honoring its partial-WHERE predicate — rows for which the predicate is not
 * TRUE are skipped.
 *
 * With `enforceUnique`, raises a CONSTRAINT error on the first duplicate index key
 * among in-scope rows; the caller is expected to discard `index` and roll back any
 * schema change. Duplicate detection runs through the index's own collation-aware
 * comparator (its BTree keys by `compareKeys`), so a value set unique under BINARY but
 * colliding under e.g. NOCASE surfaces here — a raw value signature would miss it.
 * SQL UNIQUE allows multiple NULLs, so a key with any NULL value never counts as a
 * duplicate. `hasAnyPrimaryKey` is O(1) (Map size) so the build stays O(N) —
 * `getPrimaryKeys` would sort the bucket on every row.
 *
 * Parameterizing on a row iterable (rather than reading a fixed tree) is what lets
 * `MemoryTableManager` validate a not-yet-built index against the DDL-issuing
 * connection's EFFECTIVE rows — the committed base overlaid with its open
 * transaction's pending writes — while the base index itself is still populated from
 * committed rows only. See `docs/memory-table.md` § DDL and transactions.
 */
export function populateIndexFromRows(
	rows: Iterable<Row>,
	index: MemoryIndex,
	primaryKeyFromRow: (row: Row) => BTreeKeyForPrimary,
	enforceUnique: boolean,
	tableName: string,
	columns: ReadonlyArray<ColumnSchema>,
): void {
	for (const row of rows) {
		addRowToIndex(row, index, primaryKeyFromRow, enforceUnique, tableName, columns);
	}
}

/**
 * Async-stream twin of {@link populateIndexFromRows}, sharing its per-row body.
 *
 * Needed because an {@link EffectiveRowSource} — the merged view a wrapper module (the
 * isolation layer) hands down for row-validating DDL — is an `AsyncIterable`, while the
 * memory module's own effective rows are a synchronous BTree walk.
 */
export async function populateIndexFromRowsAsync(
	rows: AsyncIterable<Row>,
	index: MemoryIndex,
	primaryKeyFromRow: (row: Row) => BTreeKeyForPrimary,
	enforceUnique: boolean,
	tableName: string,
	columns: ReadonlyArray<ColumnSchema>,
): Promise<void> {
	for await (const row of rows) {
		addRowToIndex(row, index, primaryKeyFromRow, enforceUnique, tableName, columns);
	}
}

/** One row's worth of {@link populateIndexFromRows}; see its docstring for the semantics. */
function addRowToIndex(
	row: Row,
	index: MemoryIndex,
	primaryKeyFromRow: (row: Row) => BTreeKeyForPrimary,
	enforceUnique: boolean,
	tableName: string,
	columns: ReadonlyArray<ColumnSchema>,
): void {
	if (!index.rowMatchesPredicate(row)) return;

	const indexKey = index.keyFromRow(row);
	const primaryKey = primaryKeyFromRow(row);

	if (enforceUnique) {
		const hasNull = index.specColumns.some(c => row[c.index] === null);
		if (!hasNull && index.hasAnyPrimaryKey(indexKey)) {
			const colNames = index.specColumns
				.map(c => columns[c.index]?.name ?? String(c.index))
				.join(', ');
			throw new QuereusError(
				`UNIQUE constraint failed: ${tableName} (${colNames})`,
				StatusCode.CONSTRAINT,
			);
		}
	}

	index.addEntry(indexKey, primaryKey);
}

export class BaseLayer implements Layer {
	private readonly layerId: number;
	public tableSchema: TableSchema;
	public readonly collationResolver: CollationResolver;
	private primaryKeyFunctions!: PrimaryKeyFunctions;
	public primaryTree: BTree<BTreeKeyForPrimary, Row>;
	public readonly secondaryIndexes: Map<string, MemoryIndex>;

	constructor(schema: TableSchema, collationResolver: CollationResolver) {
		this.layerId = baseLayerCounter++;
		this.tableSchema = schema;
		this.collationResolver = collationResolver;
		this.initializePrimaryKeyFunctions();

		// Use the same key extraction pattern as TransactionLayer for consistency
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);
		this.secondaryIndexes = new Map();
		this.rebuildAllSecondaryIndexes();
	}

	public updateSchema(newSchema: TableSchema): void {
		logger.operation('Schema Update', this.tableSchema.name, {
			from: this.tableSchema.name,
			to: newSchema.name
		});
		this.tableSchema = newSchema;
		this.initializePrimaryKeyFunctions();
	}

	private initializePrimaryKeyFunctions(): void {
		this.primaryKeyFunctions = createPrimaryKeyFunctions(this.tableSchema, this.collationResolver);
	}

	/** Builds a `MemoryIndex` for `indexSchema` under this layer's collation resolver and PK functions. */
	private createMemoryIndex(indexSchema: IndexSchema): MemoryIndex {
		return new MemoryIndex(
			indexSchema,
			this.tableSchema.columns,
			this.collationResolver,
			this.primaryKeyFunctions.compare,
			this.primaryKeyFunctions.encode,
			this.tableSchema.name,
		);
	}

	/**
	 * Recreates every secondary index from the committed primary tree under the
	 * CURRENT schema — call {@link updateSchema} first when the index key collation
	 * changed, so each rebuilt `MemoryIndex` re-keys under it.
	 *
	 * Never enforcing, even for a re-keyed UNIQUE structure: base rows are not a
	 * subset of the DDL transaction's effective rows (a duplicate that transaction
	 * DELETED still sits in the base primary tree), so a duplicate check here would
	 * reject a legal change. `MemoryTableManager.alterColumn` validates over the
	 * effective rows before calling this; see {@link addIndexToBase} for why a base
	 * index may hold an entry no live row backs.
	 *
	 * Every index gets a FRESH `MemoryIndex` and BTree, so any layer inheriting the
	 * old trees must be re-pointed at the new ones — that is
	 * `TransactionLayer.adoptSchema`'s replacement path.
	 */
	public rebuildAllSecondaryIndexes(): void {
		this.clearExistingSecondaryIndexes();

		if (!this.hasSecondaryIndexes()) {
			// Drop the structures outright rather than leaving them emptied: an index the
			// schema no longer declares (DROP INDEX, or DROP COLUMN taking the last key
			// column of the table's only index) would otherwise linger in the map and be
			// maintained on every write to the base. `replaceSecondaryIndexes` does the
			// same clear on the non-empty path.
			this.secondaryIndexes.clear();
			return;
		}

		const newIndexes = this.createSecondaryIndexes();
		this.populateSecondaryIndexes(newIndexes);
		this.replaceSecondaryIndexes(newIndexes);
	}

	/**
	 * Rebuild the primary BTree under the *current* primaryKeyFunctions — call
	 * {@link updateSchema} first so they reflect the new key collation. Re-extracts
	 * every row's key with the new functions and detects a primary-key collision —
	 * two rows whose distinct old keys collapse to one under the new comparator
	 * (e.g. a PK-column collation change BINARY→NOCASE) — throwing CONSTRAINT and
	 * leaving the live tree intact for the caller's rollback.
	 *
	 * `MemoryTableManager.validateRekeyedPrimaryKey` proves these rows collision-free
	 * before calling, so the throw is an invariant check rather than the enforcement
	 * path (it is what a caller sees when the base is *not* the whole story — e.g. a
	 * new call site that forgets the pre-pass).
	 *
	 * The tree object is REPLACED, so any layer inheriting the old one must be
	 * re-pointed at the new one — that is `TransactionLayer.rekeyPrimaryKey`.
	 */
	public rebuildPrimaryTreeStrict(): void {
		const oldTree = this.primaryTree;
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);
		const newTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare,
		);
		for (const path of oldTree.ascending(oldTree.first())) {
			const row = oldTree.at(path)!;
			const key = this.primaryKeyFunctions.extractFromRow(row);
			if (newTree.get(key) !== undefined) {
				throw new QuereusError(
					`UNIQUE constraint failed: ${this.tableSchema.name} primary key collides under new collation`,
					StatusCode.CONSTRAINT,
				);
			}
			newTree.insert(row);
		}
		this.primaryTree = newTree;
	}

	/**
	 * Replaces the primary tree with a fresh tree containing exactly `rows`, then
	 * rebuilds all secondary indexes from it. Used when consolidating a committed
	 * transaction layer into the base: `rows` is that layer's merged view (deletes
	 * already applied), so the base must be *replaced* — not unioned — or rows
	 * deleted in the transaction layer would remain physically resident in the base
	 * and resurface in base-direct scans (e.g. UNIQUE index builds).
	 */
	public rebuildPrimaryTreeFromRows(rows: Row[]): void {
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);
		const newTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare,
		);
		for (const row of rows) {
			newTree.insert(row);
		}
		this.primaryTree = newTree;
		this.rebuildAllSecondaryIndexes();
	}

	private clearExistingSecondaryIndexes(): void {
		this.secondaryIndexes.forEach(index => index.clear());
	}

	private hasSecondaryIndexes(): boolean {
		return Boolean(this.tableSchema.indexes && this.tableSchema.indexes.length > 0);
	}

	/**
	 * Constructs (does not populate) a `MemoryIndex` per declared index.
	 *
	 * A construction failure propagates: the caller's schema change fails rather than
	 * silently returning a map missing an index the catalog still advertises (which
	 * surfaces much later as `Secondary index '<name>' not found` when a scan picks
	 * it by name). Callers that change the column list must therefore hand this a
	 * schema whose partial-index predicates already name the surviving columns.
	 *
	 * Duplicate-key tolerance — the one thing the non-strict rebuild is legitimately
	 * lenient about — lives in {@link populateSecondaryIndexes}, not here.
	 */
	private createSecondaryIndexes(): Map<string, MemoryIndex> {
		const newIndexes = new Map<string, MemoryIndex>();

		for (const indexSchema of this.tableSchema.indexes!) {
			newIndexes.set(indexSchema.name, this.createMemoryIndex(indexSchema));
		}

		return newIndexes;
	}

	private populateSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		for (const path of this.primaryTree.ascending(this.primaryTree.first())) {
			const row = this.primaryTree.at(path)!;
			this.addRowToSecondaryIndexes(row, newIndexes);
		}
	}

	private addRowToSecondaryIndexes(row: Row, indexes: Map<string, MemoryIndex>): void {
		const primaryKey = this.primaryKeyFunctions.extractFromRow(row);

		indexes.forEach(index => {
			try {
				if (!index.rowMatchesPredicate(row)) return;
				const indexKey = index.keyFromRow(row);
				index.addEntry(indexKey, primaryKey);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} catch (e: any) {
				logger.error('Re-index Row', this.tableSchema.name, e, { indexName: index.name });
			}
		});
	}

	private replaceSecondaryIndexes(newIndexes: Map<string, MemoryIndex>): void {
		this.secondaryIndexes.clear();
		newIndexes.forEach((idx, name) => this.secondaryIndexes.set(name, idx));
	}

	getLayerId = (): number => this.layerId;
	getParent = (): Layer | null => null;
	getSchema = (): TableSchema => this.tableSchema;
	isCommitted = (): boolean => true;

	getModificationTree = (indexName: string | 'primary'): BTree<BTreeKeyForPrimary, Row> | null =>
		indexName === 'primary' ? this.primaryTree : null;

	getSecondaryIndexTree = (indexName: string): BTree<BTreeKeyForIndex, MemoryIndexEntry> | null =>
		this.secondaryIndexes.get(indexName)?.data ?? null;

	getSecondaryIndex = (indexName: string): MemoryIndex | undefined =>
		this.secondaryIndexes.get(indexName);

	public getPkExtractorsAndComparators(schema: TableSchema): PkExtractorsAndComparators {
		if (schema !== this.tableSchema) {
			logger.warn('PK Extractors', this.tableSchema.name, 'Called with different schema');
		}
		return {
			primaryKeyExtractorFromRow: this.primaryKeyFunctions.extractFromRow,
			primaryKeyComparator: this.primaryKeyFunctions.compare,
			primaryKeyEncoder: this.primaryKeyFunctions.encode
		};
	}

	has = (key: BTreeKeyForPrimary): boolean => {
		const value = this.primaryTree.get(key);
		return value !== undefined;
	};

	/**
	 * @param insertAtIndex Slot the new column occupies in the updated schema — every
	 *   committed row gets its value spliced in there. The manager always passes an explicit
	 *   index (the append position when the caller asked for no particular one).
	 */
	async addColumnToBase(
		newColumnSchema: ColumnSchema,
		defaultValue: SqlValue,
		backfillEvaluator: ((row: Row) => SqlValue | Promise<SqlValue>) | undefined,
		insertAtIndex: number,
	): Promise<void> {
		logger.operation('Add Column', this.tableSchema.name, {
			columnName: newColumnSchema.name,
			defaultValue
		});

		const oldPrimaryTree = this.primaryTree;

		// Reinitialize primary key functions with the updated schema (which already includes the
		// new column, and — for an insert rather than an append — its shifted key indices). The
		// extraction below runs on the already-spliced row, so the two agree.
		this.initializePrimaryKeyFunctions();

		// Create new primary tree with the updated schema and migrate data
		await this.recreatePrimaryTreeWithNewColumn(oldPrimaryTree, newColumnSchema, defaultValue, backfillEvaluator, insertAtIndex);

		this.rebuildAllSecondaryIndexes();
	}

	private async recreatePrimaryTreeWithNewColumn(
		oldTree: BTree<BTreeKeyForPrimary, Row>,
		newColumnSchema: ColumnSchema,
		defaultValue: SqlValue,
		backfillEvaluator: ((row: Row) => SqlValue | Promise<SqlValue>) | undefined,
		insertAtIndex: number,
	): Promise<void> {
		// Use the updated primary key functions for the new tree
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		// Build into a local tree and only swap it in once every row migrates, so a
		// throwing per-row backfill evaluator (or a NOT NULL violation below) leaves the
		// live tree intact for the caller's rollback.
		const newTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		for (const path of oldTree.ascending(oldTree.first())) {
			const oldRow = oldTree.at(path)!;
			// A non-foldable DEFAULT (e.g. `new.<col>`) derives the new column's value from
			// the existing row; a literal/NULL default uses the single folded value.
			const value = backfillEvaluator ? await backfillEvaluator(oldRow) : defaultValue;
			// A per-row default that produces NULL for a NOT NULL column cannot backfill that
			// row; reject before swapping the tree (the caller reverts the column add). This
			// applies only to the per-row evaluator path — a literal/NULL default's nullability
			// is gated up-front by the engine and the manager's pre-check.
			if (backfillEvaluator && newColumnSchema.notNull && value === null) {
				throw new QuereusError(
					`NOT NULL constraint failed: backfilling column '${this.tableSchema.name}.${newColumnSchema.name}' produced NULL for an existing row`,
					StatusCode.CONSTRAINT,
				);
			}
			const newRow = oldRow.slice();
			newRow.splice(insertAtIndex, 0, value);
			newTree.insert(newRow);
		}

		this.primaryTree = newTree;
	}

	async dropColumnFromBase(columnIndexInOldSchema: number): Promise<void> {
		logger.operation('Drop Column', this.tableSchema.name, {
			columnIndex: columnIndexInOldSchema
		});

		const oldPrimaryTree = this.primaryTree;
		this.recreatePrimaryTreeWithoutColumn(oldPrimaryTree, columnIndexInOldSchema);
		await this.rebuildAllSecondaryIndexes();
	}

	private recreatePrimaryTreeWithoutColumn(oldTree: BTree<BTreeKeyForPrimary, Row>, columnIndex: number): void {
		const btreeKeyFromValue = (value: Row): BTreeKeyForPrimary =>
			this.primaryKeyFunctions.extractFromRow(value);

		this.primaryTree = new BTree<BTreeKeyForPrimary, Row>(
			btreeKeyFromValue,
			this.primaryKeyFunctions.compare
		);

		for (const path of oldTree.ascending(oldTree.first())) {
			const oldRow = oldTree.at(path)!;
			const newRow = oldRow.filter((_, idx) => idx !== columnIndex);
			this.primaryTree.insert(newRow);
		}
	}

	async handleColumnRename(): Promise<void> {
		logger.operation('Handle Column Rename', this.tableSchema.name);
		await this.rebuildAllSecondaryIndexes();
	}

	/**
	 * Builds and populates a new secondary index over the COMMITTED rows.
	 *
	 * No duplicate check: uniqueness for `CREATE UNIQUE INDEX` / `ADD CONSTRAINT …
	 * UNIQUE` is validated by `MemoryTableManager` against the DDL-issuing
	 * connection's EFFECTIVE rows before this runs, and the base's rows are not a
	 * subset of those — a duplicate the open transaction has DELETED still sits in
	 * the base primary tree. Checking here would reject that legal build. The base
	 * index is a lookup structure, never an enforcement one: `checkUniqueViaIndex`
	 * re-validates every candidate entry against the live effective row, so an entry
	 * for a row the transaction removed can never manufacture a conflict. See
	 * `docs/memory-table.md` § DDL and transactions.
	 */
	async addIndexToBase(indexSchema: IndexSchema): Promise<void> {
		logger.operation('Add Index', this.tableSchema.name, {
			indexName: indexSchema.name
		});

		const newMemoryIndex = this.createMemoryIndex(indexSchema);
		populateIndexFromRows(
			iteratePrimaryRows(this.primaryTree),
			newMemoryIndex,
			this.primaryKeyFunctions.extractFromRow,
			false,
			this.tableSchema.name,
			this.tableSchema.columns,
		);
		this.secondaryIndexes.set(indexSchema.name, newMemoryIndex);
	}

	async dropIndexFromBase(indexName: string): Promise<void> {
		if (this.secondaryIndexes.delete(indexName)) {
			logger.operation('Drop Index', this.tableSchema.name, { indexName });
		} else {
			logger.warn('Drop Index', this.tableSchema.name, 'Index not found', { indexName });
		}
	}
}
