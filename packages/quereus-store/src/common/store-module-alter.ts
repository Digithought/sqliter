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
	TableSchema,
} from '@quereus/quereus';
import {
	QuereusError,
	StatusCode,
	buildCheckConstraintSchema,
	buildColumnIndexMap,
	buildForeignKeyConstraintSchema,
	buildUniqueConstraintSchema,
	columnDefToSchema,
	renameColumnInCheckConstraints,
	renameColumnInIndexPredicates,
	resolveNamedConstraintClass,
	shiftSchemaIndicesForDrop,
	tryFoldLiteral,
	validateForeignKeyOverExistingRows,
} from '@quereus/quereus';
import { StoreTable } from './store-table.js';
import { withImplicitUniqueIndexes } from './implicit-unique-index.js';
import { buildFullScanBounds } from './key-builder.js';
import { StoreModuleAlterColumn } from './store-module-alter-column.js';
import { rowsFromEntries, validateUniqueOverExistingRows } from './store-module-index-build.js';
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
		// copy, and `StoreModuleIndex.reconcileImplicitUniqueIndexStores` (below) moves the physical
		// stores for any constraint-set change.
		const oldSchema = table.getSchema();
		const defaultNotNull = db.options.getStringOption('default_column_nullability') === 'not_null';

		let updated: TableSchema;
		switch (change.type) {
			case 'addColumn':
				updated = await this.alterAddColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'dropColumn':
				updated = await this.alterDropColumn(schemaName, tableName, table, oldSchema, change);
				break;
			case 'renameColumn':
				updated = await this.alterRenameColumn(db, schemaName, tableName, table, oldSchema, change, defaultNotNull);
				break;
			case 'alterPrimaryKey':
				updated = await this.alterPrimaryKeyChange(db, schemaName, tableName, table, oldSchema, change);
				break;
			case 'addConstraint':
				updated = await this.alterAddConstraint(db, schemaName, tableName, table, oldSchema, change, rows);
				break;
			case 'dropConstraint':
				updated = await this.alterDropConstraint(schemaName, tableName, table, oldSchema, change);
				break;
			case 'renameConstraint':
				updated = await this.alterRenameConstraint(schemaName, tableName, table, oldSchema, change);
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
		await this.reconcileImplicitUniqueIndexStores(db, schemaName, tableName, table, oldSchema);
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
		// `tryFoldLiteral` helper so signed numerics like `-123.0`
		// (a UnaryExpr in the AST) are recognized — matching the
		// memory-mode path and the engine-level ALTER validation.
		let defaultValue: SqlValue = null;
		const defaultConstraint = change.columnDef.constraints?.find(c => c.type === 'default');
		if (defaultConstraint?.expr) {
			const folded = tryFoldLiteral(defaultConstraint.expr);
			if (folded !== undefined) {
				defaultValue = folded;
			}
		}

		// A non-foldable DEFAULT (e.g. `new.<col>`) backfills each existing row from
		// its own value via the engine-supplied evaluator (mirrors the memory path).
		const backfillEvaluator = change.backfillEvaluator;

		// Refuse NOT NULL without a usable DEFAULT on a non-empty table
		// (SQLite-compatible). A per-row evaluator IS usable — its NOT NULL is enforced
		// per row during migration — so it is exempt from this no-default rejection.
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
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** DROP COLUMN arm of {@link alterTable}: drop the column slot, reindex PK / indexes /
	 *  UNIQUE, migrate rows, and persist. Behavior-preserving extraction. */
	private async alterDropColumn(
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
		// generically, by diffing the old and new constraint sets after this arm returns.
		const shifted = shiftSchemaIndicesForDrop(oldSchema, colIndex);

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

		// Update table schema and persist DDL
		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

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

		// A partial index's WHERE clause and a CHECK constraint's expression both
		// still name the OLD column: the engine's `propagateColumnRename` pass runs
		// only after this hook returns. Persisting now would durably write a bundle
		// naming a column the table no longer has, and only the later propagation's
		// `table_modified` event would correct it — a crash in between leaves the
		// catalog un-rehydratable. So rewrite first, in place: each `Expression` is
		// shared by reference with the catalog's `TableSchema` and, for a unique
		// partial index, with the `derivedFromIndex` UNIQUE constraint, so one
		// rewrite covers all holders and makes the later propagation pass a no-op.
		//
		// The rewrites are the first statements in the `try`, and each walks its
		// collection one item at a time, so a throw anywhere — including partway
		// through a walk — must reverse them: restoring `oldSchema` cannot, since the
		// ASTs are shared. Reversing is a no-op wherever nothing names the new column,
		// and the engine has already rejected a rename onto an existing column name,
		// so the reverse pass cannot collide with an expression that legitimately
		// named it.
		const resolveColumnInSource: ResolveColumnInSource = (s, t, col) =>
			db.schemaManager.getSchema(s)?.getTable(t)?.columnIndexMap.has(col.toLowerCase()) ?? false;
		const rewriteColumn = (from: string, to: string): void => {
			renameColumnInIndexPredicates(
				updatedIndexes, tableName, from, to, schemaName, resolveColumnInSource);
			renameColumnInCheckConstraints(
				oldSchema.checkConstraints, tableName, from, to, schemaName, resolveColumnInSource);
		};
		try {
			rewriteColumn(change.oldName, change.newName);

			// Rename is schema-only — no row migration needed
			table.updateSchema(updatedSchema);
			await this.saveTableDDL(updatedSchema);
		} catch (e) {
			rewriteColumn(change.newName, change.oldName);
			throw e;
		}

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

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
	): Promise<TableSchema> {
		const newPkColumns = change.newPkColumns;
		const updatedSchema: TableSchema = {
			...oldSchema,
			primaryKeyDefinition: Object.freeze(
				newPkColumns.map(pk => ({ index: pk.index, desc: pk.desc })),
			),
		};

		// Physical re-key ahead — flush buffered writes so every live row is
		// re-keyed and no stale-schema op replays over the rewritten store.
		// `rekeyRows`' duplicate-key pass runs against the flushed store, so a
		// pending insert that collides under the new PK is caught. See
		// `StoreModuleBase.ddlCommitPendingOps` for the transaction consequences.
		await this.ddlCommitPendingOps();

		// Re-key the data store. Throws CONSTRAINT on duplicates without
		// mutating the store, giving us all-or-nothing semantics for the
		// validation phase.
		await table.rekeyRows(newPkColumns);

		// Secondary index keys embed the PK suffix — clear + rebuild every
		// index against the now-rekeyed data store. Rebuild the MATERIALIZED index list
		// so each implicit `_uc_*` PK suffix is re-encoded too (`updatedSchema` is built
		// off the de-materialized `oldSchema`, so it carries no `_uc_*` on its own).
		await this.rebuildSecondaryIndexes(schemaName, tableName, table, withImplicitUniqueIndexes(updatedSchema), db.getKeyNormalizerResolver());

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** ADD CONSTRAINT arm of {@link alterTable}: validate existing rows as the constraint kind
	 *  (UNIQUE / FOREIGN KEY / CHECK) requires, then persist. Behavior-preserving extraction. */
	private async alterAddConstraint(
		db: Database,
		schemaName: string,
		tableName: string,
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
				rows ? rows() : rowsFromEntries(table.iterateEffectiveEntries(buildFullScanBounds())),
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

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** DROP CONSTRAINT arm of {@link alterTable}: schema-only catalog rewrite dropping a named
	 *  constraint, then persist. Behavior-preserving extraction. */
	private async alterDropConstraint(
		schemaName: string,
		tableName: string,
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

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}

	/** RENAME CONSTRAINT arm of {@link alterTable}: schema-only rename of a named constraint,
	 *  then persist. A renamed named-UNIQUE changes its implicit `_uc_*` index name, so
	 *  `reconcileImplicitUniqueIndexStores` (run after this arm) MOVES the physical store —
	 *  tears down the old-named store and rebuilds the new-named one from effective rows. */
	private async alterRenameConstraint(
		schemaName: string,
		tableName: string,
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

		table.updateSchema(updatedSchema);
		await this.saveTableDDL(updatedSchema);

		this.eventEmitter?.emitSchemaChange({
			type: 'alter',
			objectType: 'table',
			schemaName,
			objectName: tableName,
		});

		return updatedSchema;
	}
}
