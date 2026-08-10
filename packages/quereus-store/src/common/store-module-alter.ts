/**
 * ALTER TABLE dispatch and every arm except ALTER COLUMN: add / drop / rename a column,
 * change the primary key, and add / drop / rename a table constraint. Each arm returns
 * the rewritten table schema; the dispatcher owns what is common to all of them
 * (resolving the table, reconciling the implicit UNIQUE index stores afterwards).
 *
 * Sixth layer of the store-module chain:
 *   StoreModuleBase -> StoreModuleCatalog -> StoreModuleSchemaSync -> StoreModuleIndex
 *   -> StoreModuleAlterColumn -> StoreModuleAlter -> StoreModuleRename -> StoreModule
 */

import type {
	ColumnSchema,
	Database,
	EffectiveRowSource,
	ResolveColumnInSource,
	SchemaChangeInfo,
	SqlValue,
	TableIndexSchema,
	TableSchema,
} from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	buildCheckConstraintSchema,
	buildColumnIndexMap,
	buildForeignKeyConstraintSchema,
	buildColumnSourceResolver,
	buildObjectRefResolver,
	buildUniqueConstraintSchema,
	columnDefToSchema,
	foldDefaultToType,
	objectRefKey,
	rekeySchemaPrimaryKey,
	renameColumnInCheckConstraints,
	renameColumnInColumnExpressions,
	renameColumnInIndexPredicates,
	resolveNamedConstraintClass,
	shiftSchemaIndicesForDrop,
	validateForeignKeyOverExistingRows,
} from '@quereus/quereus';
import { StoreTable } from './store-table.js';
import { withImplicitUniqueIndexes } from './implicit-unique-index.js';
import { StoreModuleAlterColumn } from './store-module-alter-column.js';
import { effectiveDdlRows, validateUniqueOverExistingRows } from './store-module-index-build.js';
import { buildColumnRemap, renameColumnInSelfForeignKeys } from './store-module-schema-rewrite.js';

export abstract class StoreModuleAlter extends StoreModuleAlterColumn {
	/**
	 * Alters an existing store table's structure. Resolves the table, captures the
	 * pre-alter schema, and dispatches to the per-change-type `alter*` helper below;
	 * the helper does the arm's work (row migration, physical re-key, constraint
	 * validation, DDL persist) and returns the updated TableSchema for the engine to
	 * register. The shared preamble (schema subscription, reconnect, not-found throw,
	 * `defaultNotNull`) lives here so every arm sees the same resolved state.
	 */
	async alterTable(
		db: Database,
		schemaName: string,
		tableName: string,
		change: SchemaChangeInfo,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		this.ensureSchemaSubscription(db);
		const table = this.getOrReconnectTable(db, schemaName, tableName);

		if (!table) {
			throw new QuereusError(
				`Store table '${tableName}' not found in schema '${schemaName}'. Cannot alter.`,
				StatusCode.ERROR,
			);
		}

		// The engine-facing schema carries no `_uc_*` (the store keeps the materialized
		// enforcement copy internal), so the arms build `updatedSchema` off a clean schema
		// exactly as before this feature; `table.updateSchema` recomputes the enforcement
		// copy, and `StoreModuleIndex.reconcileImplicitUniqueIndexStores` moves the physical
		// stores for any constraint-set change.
		const oldSchema = table.getSchema();
		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';

		let updated: TableSchema;
		switch (change.type) {
			case 'addColumn':
				updated = await this.alterAddColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'dropColumn':
				updated = await this.alterDropColumn(db, schemaName, tableName, table, oldSchema, change);
				break;
			case 'renameColumn':
				updated = await this.alterRenameColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'alterPrimaryKey':
				updated = await this.alterPrimaryKeyChange(db, schemaName, tableName, table, oldSchema, change, rows);
				break;
			case 'addConstraint':
				updated = await this.alterAddConstraint(db, table, oldSchema, change, rows);
				break;
			case 'dropConstraint':
				updated = await this.alterDropConstraint(table, oldSchema, change);
				break;
			case 'renameConstraint':
				updated = await this.alterRenameConstraint(table, oldSchema, change);
				break;
			case 'alterColumn':
				updated = await this.alterColumnChange(db, schemaName, tableName, table, oldSchema, change, rows);
				break;
			default: {
				const _exhaustive: never = change;
				void _exhaustive;
				throw new QuereusError(`Unhandled ALTER TABLE change type '${(change as SchemaChangeInfo).type}'`, StatusCode.INTERNAL);
			}
		}

		// Move the physical `_uc_*` index stores to match the post-ALTER constraint set:
		// the SCHEMA entries were re-materialized by the arm's `table.updateSchema`, but a
		// newly-added constraint's store must be BUILT and a dropped/renamed one's TORN
		// DOWN. `oldSchema` carries the pre-ALTER `uniqueConstraints`; `table.getSchema()`
		// the post-ALTER set. A no-op when the implicit-index name set is unchanged (the
		// common case, incl. PK/collation/type ALTERs whose physical re-encode is already
		// handled by `rebuildSecondaryIndexes`).
		//
		// NOTE: this call sits OUTSIDE the schema-only arms' persist seam
		// (`StoreModuleIndex.adoptAndPersistSchema`), so it opens a window that seam does not
		// close. If the `_uc_*` build/teardown throws here — an IO error — the catalog and the
		// connected table both already carry the post-ALTER constraint set while the engine,
		// which registers only after `alterTable` returns, does not. Unwinding it would mean
		// restoring the cached schema, re-writing the catalog, AND running the inverse of a
		// reconcile that may have half-completed. Not attempted; a re-run of the statement or a
		// reopen rebuilds the store (`reconcileImplicitUniqueIndexStores` already tolerates a
		// partial `_uc_*` build for the same reason).
		await this.reconcileImplicitUniqueIndexStores(db, schemaName, tableName, table, oldSchema);

		// ONE event per statement, decided here — the single gate for every arm: emit iff
		// the engine marked this call as the statement's own action (`change.ddl` set), and
		// put that text on the event. Engine-internal sub-steps — the inline-constraint
		// installs and revert calls of the engine's ADD COLUMN, the materialized-view
		// backing reshapes — arrive with no `ddl` and announce nothing, which is what keeps
		// `add column x text unique` (one addColumn call + one addConstraint call) at
		// exactly one announced event. See `SchemaChangeInfo.ddl`.
		if (change.ddl !== undefined) {
			this.eventEmitter?.emitSchemaChange({
				type: 'alter',
				objectType: 'table',
				schemaName,
				objectName: tableName,
				ddl: change.ddl,
			});
		}
		return updated;
	}

	/**
	 * ADD COLUMN arm of {@link alterTable}: append the new column, eagerly migrate
	 * each row (literal or per-row backfill), and persist. Behavior-preserving
	 * extraction of the former `switch` arm.
	 *
	 * The store always appends. A caller-chosen `insertAtIndex` (module-API only; SQL never
	 * produces one) is rejected unless it names the append position, rather than silently
	 * landing the column somewhere the caller did not ask for.
	 */
	private async alterAddColumn(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'addColumn' }>,
		defaultNotNull: boolean,
	): Promise<TableSchema> {
		if (change.insertAtIndex !== undefined && change.insertAtIndex !== oldSchema.columns.length) {
			throw new QuereusError(
				`Store-backed table '${schemaName}.${tableName}' can only ADD COLUMN at the end `
					+ `(position ${oldSchema.columns.length}), not at position ${change.insertAtIndex}`,
				StatusCode.UNSUPPORTED,
			);
		}

		// Honor the session `default_collation` for an ADD COLUMN that omits an
		// explicit COLLATE, matching the CREATE path so an ADD-COLUMN-ed text column
		// gets the same collation a CREATE-d one would. The persisted DDL re-emits an
		// explicit COLLATE for any non-BINARY collation, so reopen stays stable.
		const newColSchema = columnDefToSchema(change.columnDef, defaultNotNull, db.options.getStringOption('default_collation'), (n) => db.isCollationRegistered(n));

		// Extract default value from column def constraints. Use the shared
		// `foldDefaultToType` helper so signed numerics like `-123.0`
		// (a UnaryExpr in the AST) are recognized AND the folded literal is converted
		// to the new column's declared type — matching the memory-mode path, the
		// isolation overlay, and what a fresh INSERT under the same DEFAULT stores.
		// An unconvertible literal (`integer default 'abc'`) throws MISMATCH here.
		let defaultValue: SqlValue = null;
		const defaultConstraint = change.columnDef.constraints?.find(c => c.type === 'default');
		if (defaultConstraint?.expr) {
			const folded = foldDefaultToType(defaultConstraint.expr, newColSchema.logicalType, newColSchema.name);
			if (folded !== undefined) {
				defaultValue = folded;
			}
		}

		// A per-row value source — a non-foldable DEFAULT (e.g. `new.<col>`) or a
		// `generated always as` expression — backfills each existing row from its own
		// value via the engine-supplied evaluator (mirrors the memory path).
		const backfillEvaluator = change.backfillEvaluator;

		// Refuse NOT NULL without a usable value source on a non-empty table
		// (SQLite-compatible). A per-row evaluator IS usable — its NOT NULL is enforced
		// per row during migration — so it is exempt from this rejection.
		if (newColSchema.notNull && defaultValue === null && !backfillEvaluator) {
			if (await table.hasAnyRows()) {
				throw new QuereusError(
					`Cannot add NOT NULL column '${newColSchema.name}' to non-empty table `
						+ `'${schemaName}.${tableName}' without a DEFAULT value`,
					StatusCode.CONSTRAINT,
				);
			}
		}

		// Build updated schema: append new column
		const updatedColumns: ReadonlyArray<ColumnSchema> = Object.freeze([...oldSchema.columns, newColSchema]);
		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: updatedColumns,
			columnIndexMap: buildColumnIndexMap(updatedColumns),
		};

		// Physical rewrite ahead: flush the module's buffered writes so `migrateRows`
		// (a committed-store scan + batch) sees this transaction's rows and re-encodes
		// them under the new column layout. See `StoreModuleBase.ddlCommitPendingOps`. Placed
		// after every throw-only check above — the NOT NULL rejection reads effectively
		// (`hasAnyRows`) — so a rejected ALTER leaves the enclosing transaction intact.
		await this.ddlCommitPendingOps();

		// Migrate rows: append the new column's value — a single literal default, or a
		// per-row value derived from the existing row when a backfill evaluator is set.
		const remap = buildColumnRemap(
			oldSchema.columns.map(c => c.name),
			updatedColumns.map(c => c.name),
		);
		await table.migrateRows(
			remap,
			defaultValue,
			backfillEvaluator
				? { evaluator: backfillEvaluator, notNull: newColSchema.notNull, columnName: newColSchema.name }
				: undefined,
		);

		// Update table schema (column-only) and persist DDL. Any constraint declared inline
		// on the added column (UNIQUE / CHECK / FOREIGN KEY) arrives as its own follow-up
		// `addConstraint` call from the engine's `runAddColumn`, which is what persists it —
		// so this arm neither installs nor persists them, and the schema it hands back stays
		// column-only.
		//
		// Deliberately the bare pair, NOT `adoptAndPersistSchema`: `migrateRows` above has
		// already re-encoded every row under the new column layout, so restoring the old
		// cached schema on a persist failure would leave the table reading re-encoded rows
		// through the pre-ALTER layout — worse than the divergence it repairs. Same for every
		// other row-rewriting arm (DROP COLUMN, ALTER PRIMARY KEY, ALTER COLUMN); the accepted
		// tradeoff and its real fix are recorded in the `NOTE:` above `rebuildSecondaryIndexes`
		// in `alterDropColumn`.
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		return updatedSchema;
	}

	/** DROP COLUMN arm of {@link alterTable}: drop the column slot, reindex PK / indexes /
	 *  UNIQUE, migrate rows, re-encode or tear down the affected physical index stores,
	 *  and persist. */
	private async alterDropColumn(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'dropColumn' }>,
	): Promise<TableSchema> {
		const colNameLower = change.columnName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.columnName}' not found.`, StatusCode.ERROR);
		}

		// Renumber every position-bearing field over the removed slot — shared with the
		// memory module's `dropColumn`, the mirror of `shiftSchemaIndicesForInsert`. Store-backed
		// UNIQUE is enforced by a full scan over `uniqueConstraints`, so a stranded constraint
		// whose column index dangles past the column array would break the next insert's
		// validation (and the persisted DDL); a foreign key left unshifted would either dangle
		// the same way or silently slide onto an unrelated column and enforce against the parent
		// there. `removedUniqueConstraints` is unused here: unlike the memory module, the store's
		// engine-facing `.indexes` never carries the hidden `_uc_*` covering index for a plain
		// UNIQUE (see `StoreModuleBase.materializedIndexNames`), so there is no by-name exclusion to apply —
		// `StoreModuleIndex.reconcileImplicitUniqueIndexStores` tears down the physical `_uc_*` store
		// generically, by diffing the old and new constraint sets after this arm returns. A *user*
		// `CREATE UNIQUE INDEX` spanning the dropped column is removed from the schema by the helper
		// itself.
		const shifted = shiftSchemaIndicesForDrop(oldSchema, colIndex);

		// Every physical consequence the schema rewrite implies for the `{table}_idx_{name}`
		// stores falls out of one diff — see {@link partitionIndexesByDropFate}. Both inputs
		// are ENGINE-FACING schemas, which carry no `_uc_*` (see
		// `StoreModuleBase.materializedIndexNames`), so the implicit UNIQUE stores stay out of
		// both buckets — they remain owned by `reconcileImplicitUniqueIndexStores`, which runs
		// after this arm returns. A `_uc_*` never narrows anyway: a UNIQUE constraint spanning
		// the dropped column is removed outright and a survivor keeps its whole column set.
		const { removed: removedIndexes, narrowed: narrowedIndexes } =
			partitionIndexesByDropFate(oldSchema.indexes ?? [], shifted.indexes);

		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: shifted.columns,
			columnIndexMap: buildColumnIndexMap(shifted.columns),
			primaryKeyDefinition: shifted.primaryKeyDefinition,
			indexes: shifted.indexes,
			uniqueConstraints: shifted.uniqueConstraints,
			foreignKeys: shifted.foreignKeys,
		};

		// Physical rewrite ahead — flush buffered writes so `migrateRows` re-encodes
		// this transaction's rows too. See `StoreModuleBase.ddlCommitPendingOps`.
		await this.ddlCommitPendingOps();

		// Migrate rows: remove the dropped column slot
		const remap = buildColumnRemap(
			oldSchema.columns.map(c => c.name),
			shifted.columns.map(c => c.name),
		);
		await table.migrateRows(remap, null);

		// Re-encode every narrowed index against the now-re-encoded data store. AFTER
		// `migrateRows`: the rebuild reads the data store and encodes each entry from the
		// NEW column layout. `rebuildSecondaryIndexes` clears and rebuilds every index in
		// the schema it is handed, so a schema whose `.indexes` holds only the narrowed ones
		// keeps the pass off the untouched indexes. A narrowed index is necessarily
		// non-UNIQUE (a UNIQUE one spanning the slot was removed outright), so the build's
		// in-pass duplicate check is never exercised; and the engine rejects a DROP COLUMN
		// whose column is named by a partial index's WHERE clause, so the pass can never
		// meet a predicate over the departed column.
		//
		// NOTE: this widens a failure window the arm already had — `migrateRows` above has
		// already re-encoded the rows outside the coordinator while the catalog still
		// describes the OLD schema, so an IO error anywhere from there to `saveTableDDL`
		// leaves the two diverged until the statement is re-run. Same shape as
		// `alterPrimaryKeyChange` (rekey → rebuild → persist). If either arm ever needs to
		// be crash-safe, the fix is one durable marker covering the whole physical rewrite,
		// not a reordering here.
		if (narrowedIndexes.length > 0) {
			await this.rebuildSecondaryIndexes(
				schemaName,
				tableName,
				table,
				{ ...updatedSchema, indexes: narrowedIndexes },
				db.getKeyNormalizerResolver(),
			);
		}

		// Update table schema and persist DDL. The bare pair, not `adoptAndPersistSchema` —
		// the rows and index stores above are already re-encoded, so a cached-schema restore
		// would misread them (see the accepted-tradeoff `NOTE:` above).
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		// Tear down each removed index's physical store — after the catalog write, for the
		// same reason `dropIndex` orders it that way: the bundle must already omit the index
		// so a failed physical delete cannot resurrect it on reopen.
		//
		// No second `ddlCommitPendingOps()` here (unlike `dropIndex`, which flushes
		// immediately before its own teardown): the flush above already ran, and both
		// `migrateRows` and `rebuildSecondaryIndexes` write straight to their stores outside
		// the coordinator — so no buffered ops have accumulated against the doomed index
		// handles in between, and the teardown cannot strand any at commit.
		for (const removed of removedIndexes) {
			await this.tearDownIndexStore(schemaName, tableName, table, removed.name);
		}

		return updatedSchema;
	}

	/** RENAME COLUMN arm of {@link alterTable}: schema-only rewrite (columns, indexes, self-FK,
	 *  in-place predicate / CHECK AST rewrite) and persist. Behavior-preserving extraction. */
	private async alterRenameColumn(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'renameColumn' }>,
		defaultNotNull: boolean,
	): Promise<TableSchema> {
		if (!change.newColumnDefAst) {
			throw new QuereusError('RENAME COLUMN requires a new column definition AST', StatusCode.INTERNAL);
		}

		const oldNameLower = change.oldName.toLowerCase();
		const colIndex = oldSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);
		if (colIndex === -1) {
			throw new QuereusError(`Column '${change.oldName}' not found.`, StatusCode.ERROR);
		}

		const newColSchema = columnDefToSchema(change.newColumnDefAst, defaultNotNull, 'BINARY', (n) => db.isCollationRegistered(n));
		const updatedColumns = oldSchema.columns.map((c, i) => i === colIndex ? newColSchema : c);
		const updatedIndexes = (oldSchema.indexes || []).map(idx => ({
			...idx,
			columns: idx.columns.map(ic =>
				ic.index === colIndex ? { ...ic, name: change.newName } : ic
			),
		}));

		const updatedSchema: TableSchema = {
			...oldSchema,
			columns: Object.freeze(updatedColumns),
			columnIndexMap: buildColumnIndexMap(updatedColumns),
			indexes: Object.freeze(updatedIndexes),
			// A self-referencing FK names the renamed column in `referencedColumnNames`
			// and is persisted by name; the engine rewrites it only in the post-hook
			// pass. Pure copy — no rollback needed, this schema is only adopted on the
			// success path.
			foreignKeys: renameColumnInSelfForeignKeys(
				oldSchema.foreignKeys, schemaName, tableName, change.oldName, change.newName),
		};

		// A partial index's WHERE clause, a CHECK constraint's expression, and a column's
		// DEFAULT / generated expression all still name the OLD column: the engine's
		// `propagateColumnRename` pass runs only after this hook returns. Persisting now
		// would durably write a bundle naming a column the table no longer has, and only
		// the later propagation's `table_modified` event would correct it — a crash in
		// between leaves the catalog un-rehydratable. So rewrite first, in place: each
		// `Expression` is shared by reference with the catalog's `TableSchema` and, for a
		// unique partial index, with the `derivedFromIndex` UNIQUE constraint, so one
		// rewrite covers all holders and makes the later propagation pass a no-op.
		//
		// The column arm walks `updatedColumns` — the array this hook is about to persist.
		// Its renamed entry is a fresh `ColumnSchema` built from `newColumnDefAst`, but that
		// def carries the SAME expression nodes (`buildConstraintsFromColumn` passes them in
		// by reference and `columnDefToSchema` assigns them straight back), and every other
		// entry is `oldSchema`'s by reference — so this is the same one-rewrite-covers-all
		// story as the two above, reverse pass included. `formatColumnDef` renders BOTH a
		// DEFAULT and a `GENERATED ALWAYS AS` body into the persisted bundle (the latter
		// since `bug-store-reopen-loses-computed-columns` landed), so the arm is
		// load-bearing for both.
		//
		// The rewrites are the first statements in the `try`, and each walks its
		// collection one item at a time, so a throw anywhere — including partway
		// through a walk — must reverse them: restoring `oldSchema` cannot, since the
		// ASTs are shared. Reversing is a no-op wherever nothing names the new column,
		// and the engine has already rejected a rename onto an existing column name,
		// so the reverse pass cannot collide with an expression that legitimately
		// named it.
		// The engine's own propagation pass walks these same shared `Expression` nodes with
		// `buildColumnSourceResolver`, so this hook must use it too: a hand-rolled table-only
		// lookup answers "no" for a VIEW source, and the two walks then disagree about
		// whether an unqualified ref inside a subquery binds the view or the owning table.
		const resolveColumnInSource: ResolveColumnInSource = buildColumnSourceResolver(db);
		// Planner-parity resolution, snapshotted before this hook's first mutation
		// (the engine's catalog swap comes later still). A column rename never moves
		// the table itself, so forward and reverse passes share one target key.
		const resolveRef = buildObjectRefResolver(db, schemaName);
		const tableKey = objectRefKey(schemaName, tableName);
		const rewriteColumn = (from: string, to: string): void => {
			renameColumnInIndexPredicates(
				updatedIndexes, tableName, from, to, resolveRef, tableKey, resolveColumnInSource);
			renameColumnInCheckConstraints(
				oldSchema.checkConstraints, tableName, from, to, resolveRef, tableKey, resolveColumnInSource);
			renameColumnInColumnExpressions(
				updatedColumns, tableName, from, to, resolveRef, tableKey, resolveColumnInSource);
		};
		try {
			rewriteColumn(change.oldName, change.newName);

			// Rename is schema-only — no row migration needed, so the persist seam's
			// cached-schema restore is a complete undo of everything below this line. The two
			// unwinds nest: the seam puts the cached schema back and rethrows, and the catch
			// here then reverses the in-place AST rewrites the restored schema still shares by
			// reference (a schema restore cannot undo those).
			await this.adoptAndPersistSchema(table, updatedSchema);
		} catch (e) {
			rewriteColumn(change.newName, change.oldName);
			throw e;
		}

		return updatedSchema;
	}

	/** ALTER PRIMARY KEY arm of {@link alterTable}: physically re-key the data store, rebuild
	 *  secondary indexes, and persist. Behavior-preserving extraction. */
	private async alterPrimaryKeyChange(
		db: Database,
		schemaName: string,
		tableName: string,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'alterPrimaryKey' }>,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const newPkColumns = change.newPkColumns;
		// Shared with the memory module's native arm: rebuilds `primaryKeyDefinition` AND the
		// per-column `primaryKey` / `pkOrder` flags together, so the DDL this arm persists (and
		// the planner's uniqueness hints) describe the NEW key. Each member also carries its
		// column's collation, which this arm previously dropped — the store keys PK columns
		// under their declared collation (`StoreTable.pkKeyCollations`).
		const updatedSchema: TableSchema = rekeySchemaPrimaryKey(oldSchema, newPkColumns);

		// The two throw-only re-key questions — "is the change legal?" over the rows this
		// transaction can SEE (CONSTRAINT), then "can the store carry it?" over the
		// committed rows a rollback must restore (BUSY) — asked BEFORE the DDL flush below,
		// so either refusal leaves the store, the catalog AND the enclosing transaction
		// untouched. Mirrors the memory backend's `MemoryTableManager.validateRekeyedPrimaryKey`
		// and the SET COLLATE arm's `pkRekeyNeeded` block (store-module-alter-column.ts).
		await table.validateRekeyedPrimaryKey(
			updatedSchema.primaryKeyDefinition,
			updatedSchema.columns,
			effectiveDdlRows(table, rows),
		);

		// Physical re-key ahead — flush buffered writes so every live row is re-keyed and
		// no stale-schema op replays over the rewritten store. Every refusal this arm can
		// make has already run above, reading effectively and throwing without the flush,
		// so a rejected ALTER keeps the transaction alive; `rekeyRows`' own duplicate-key
		// pass is now a backstop, not the gate. See `StoreModuleBase.ddlCommitPendingOps`.
		await this.ddlCommitPendingOps();

		// Re-key the data store. Throws CONSTRAINT on duplicates without mutating the
		// store, giving us all-or-nothing semantics for the validation phase. Handed
		// `updatedSchema.columns` — the same array the probe above keyed through — so the
		// two can never resolve different key collations/transforms for the new key.
		await table.rekeyRows(updatedSchema.primaryKeyDefinition, updatedSchema.columns);

		// Secondary index keys embed the PK suffix — clear + rebuild every
		// index against the now-rekeyed data store. Rebuild the MATERIALIZED index list
		// so each implicit `_uc_*` PK suffix is re-encoded too (`updatedSchema` is built
		// off the de-materialized `oldSchema`, so it carries no `_uc_*` on its own).
		await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver());

		// The bare pair, not `adoptAndPersistSchema` — `rekeyRows` above already re-keyed the
		// data store, so a cached-schema restore would read the new key bytes through the old
		// PK definition (see the accepted-tradeoff `NOTE:` in `alterDropColumn`).
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		return updatedSchema;
	}

	/** ADD CONSTRAINT arm of {@link alterTable}: validate existing rows as the constraint kind
	 *  (UNIQUE / FOREIGN KEY / CHECK) requires, then persist. Behavior-preserving extraction. */
	private async alterAddConstraint(
		db: Database,
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'addConstraint' }>,
		rows?: EffectiveRowSource,
	): Promise<TableSchema> {
		const constraint = change.constraint;
		let updatedSchema: TableSchema;

		if (constraint.type === 'unique') {
			// Validate the existing rows against the new UNIQUE before persisting. The
			// implicit `_uc_*` index that backs enforcement is materialized into the
			// StoreTable schema by `table.updateSchema` below, and its PHYSICAL store is
			// built by `reconcileImplicitUniqueIndexStores` after this arm returns — the
			// validation here runs first, so a CONSTRAINT rejection never leaves a store
			// behind.
			//
			// No `ddlCommitPendingOps()` here (unlike the row-rewriting arms): this
			// writes no rows, and the validation scan already reads effectively, so
			// the transaction survives a CONSTRAINT rejection.
			const uc = buildUniqueConstraintSchema(constraint, oldSchema.columnIndexMap);
			await validateUniqueOverExistingRows(
				effectiveDdlRows(table, rows),
				oldSchema,
				uc,
				db.getKeyNormalizerResolver(),
			);
			updatedSchema = {
				...oldSchema,
				uniqueConstraints: Object.freeze([...(oldSchema.uniqueConstraints ?? []), uc]),
			};
		} else if (constraint.type === 'foreignKey') {
			const fk = buildForeignKeyConstraintSchema(constraint, oldSchema.columnIndexMap, oldSchema.name, oldSchema.schemaName);
			updatedSchema = {
				...oldSchema,
				foreignKeys: Object.freeze([...(oldSchema.foreignKeys ?? []), fk]),
			};
			// Pragma-gated existing-row validation; throws before persistence on an orphan.
			await validateForeignKeyOverExistingRows(db, updatedSchema, fk);
		} else if (constraint.type === 'check') {
			// Schema-only: a CHECK has no physical structure and (matching the
			// engine's prior in-emitter behavior) no existing-row scan. Routing it
			// here — rather than catalog-only — keeps the persisted DDL and the
			// connected-table schema in lock-step so DROP/RENAME CONSTRAINT resolve it.
			const check = buildCheckConstraintSchema(constraint, oldSchema.checkConstraints.length);
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze([...oldSchema.checkConstraints, check]),
			};
		} else {
			throw new QuereusError(
				`Store table ADD CONSTRAINT does not support constraint type '${constraint.type}'`,
				StatusCode.UNSUPPORTED,
			);
		}

		await this.adoptAndPersistSchema(table, updatedSchema);

		return updatedSchema;
	}

	/** DROP CONSTRAINT arm of {@link alterTable}: schema-only catalog rewrite dropping a named
	 *  constraint, then persist. Behavior-preserving extraction. */
	private async alterDropConstraint(
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'dropConstraint' }>,
	): Promise<TableSchema> {
		// Schema-only catalog rewrite. Dropping a UNIQUE removes it from
		// `uniqueConstraints`, so `table.updateSchema` below de-materializes its implicit
		// `_uc_*` index and `reconcileImplicitUniqueIndexStores` (after this arm returns)
		// tears down the now-orphaned physical store — without which a later re-ADD would
		// reopen stale entries. That teardown DDL-commits the module's pending transaction
		// first (a deleted store's buffered ops cannot be replayed at commit — see
		// `StoreModuleIndex.reconcileImplicitUniqueIndexStores`), so this arm is schema-only for the
		// CATALOG but not transaction-neutral. A UNIQUE derived from a CREATE UNIQUE INDEX
		// is rejected upstream (drop the index instead), and has no `_uc_*` anyway.
		const constraintClass = resolveNamedConstraintClass(oldSchema, change.constraintName);
		const lower = change.constraintName.toLowerCase();
		let updatedSchema: TableSchema;
		if (constraintClass === 'check') {
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze(oldSchema.checkConstraints.filter(c => c.name?.toLowerCase() !== lower)),
			};
		} else if (constraintClass === 'foreignKey') {
			const remaining = (oldSchema.foreignKeys ?? []).filter(c => c.name?.toLowerCase() !== lower);
			updatedSchema = { ...oldSchema, foreignKeys: remaining.length > 0 ? Object.freeze(remaining) : undefined };
		} else {
			const remaining = (oldSchema.uniqueConstraints ?? []).filter(c => c.name?.toLowerCase() !== lower);
			updatedSchema = { ...oldSchema, uniqueConstraints: remaining.length > 0 ? Object.freeze(remaining) : undefined };
		}

		await this.adoptAndPersistSchema(table, updatedSchema);

		return updatedSchema;
	}

	/** RENAME CONSTRAINT arm of {@link alterTable}: schema-only rename of a named constraint,
	 *  then persist. A renamed named-UNIQUE changes its implicit `_uc_*` index name, so
	 *  `reconcileImplicitUniqueIndexStores` (run after this arm) MOVES the physical store —
	 *  tears down the old-named store and rebuilds the new-named one from effective rows. */
	private async alterRenameConstraint(
		table: StoreTable,
		oldSchema: TableSchema,
		change: Extract<SchemaChangeInfo, { type: 'renameConstraint' }>,
	): Promise<TableSchema> {
		const constraintClass = resolveNamedConstraintClass(oldSchema, change.oldName);
		const oldLower = change.oldName.toLowerCase();
		let updatedSchema: TableSchema;
		if (constraintClass === 'check') {
			updatedSchema = {
				...oldSchema,
				checkConstraints: Object.freeze(
					oldSchema.checkConstraints.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		} else if (constraintClass === 'foreignKey') {
			updatedSchema = {
				...oldSchema,
				foreignKeys: Object.freeze(
					oldSchema.foreignKeys!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		} else {
			updatedSchema = {
				...oldSchema,
				uniqueConstraints: Object.freeze(
					oldSchema.uniqueConstraints!.map(c => (c.name?.toLowerCase() === oldLower ? { ...c, name: change.newName } : c)),
				),
			};
		}

		await this.adoptAndPersistSchema(table, updatedSchema);

		return updatedSchema;
	}
}

/**
 * Which of `before`'s indexes DROP COLUMN's schema rewrite (`shiftSchemaIndicesForDrop`)
 * left needing physical work, matched by lowercased name against the post-shift `after`:
 *
 *  - `removed` — gone from `after` outright (UNIQUE spanning the dropped column, or a
 *    single-column index whose only column this was). Its store must be torn down,
 *    mirroring `DROP INDEX`: nothing else reclaims it, and a later `CREATE INDEX` of the
 *    same name would ADOPT the stale entries — `getIndexStore` hands back the existing
 *    store, `buildIndexEntries` appends, and `assertStoreNameFree` cannot catch it (it
 *    compares against REGISTERED schema objects, and this index is no longer one), so a
 *    range scan through the reused index yields each row twice. Carries the PRE-shift
 *    entry; only its name is used.
 *  - `narrowed` — survives with a different column COUNT, so its key layout lost one
 *    value ahead of the PK suffix while every pre-existing entry still carries the WIDE
 *    encoding: lookups miss those rows and deletes orphan their entries. Its store must be
 *    re-encoded. Carries the POST-shift entry, which is what the rebuild encodes from.
 *
 * A survivor whose column count is unchanged is in neither bucket: its column INDICES
 * shifted, but it encodes the same values in the same order, so its key bytes do not move.
 */
function partitionIndexesByDropFate(
	before: ReadonlyArray<TableIndexSchema>,
	after: ReadonlyArray<TableIndexSchema>,
): { removed: TableIndexSchema[]; narrowed: TableIndexSchema[] } {
	const survivors = new Map(after.map(ix => [ix.name.toLowerCase(), ix]));
	const removed: TableIndexSchema[] = [];
	const narrowed: TableIndexSchema[] = [];
	for (const old of before) {
		const survivor = survivors.get(old.name.toLowerCase());
		if (!survivor) {
			removed.push(old);
		} else if (survivor.columns.length !== old.columns.length) {
			narrowed.push(survivor);
		}
	}
	return { removed, narrowed };
}
