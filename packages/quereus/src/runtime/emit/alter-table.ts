import type { AlterTableNode, AddColumnBackfill, AddColumnCheck } from '../../planner/nodes/alter-table-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { createRowSlot } from '../context-helpers.js';
import { QuereusError } from '../../common/errors.js';
import { type SqlValue, type Row, type SubProgram, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../schema/table.js';
import { buildColumnIndexMap, withGeneratedColumnGraph, requireVtabModule, resolveNamedConstraintClass, validateCollationForType } from '../../schema/table.js';
import { validateForeignKeyCollations, buildForeignKeyConstraintSchema, extractColumnLevelCheckConstraints, extractColumnLevelForeignKeys, extractColumnLevelUniqueConstraints } from '../../schema/constraint-builder.js';
import type * as AST from '../../parser/ast.js';
import type { ColumnDef, Expression, QueryExpr } from '../../parser/ast.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import { quoteIdentifier, expressionToString, astToString } from '../../emit/ast-stringify.js';
import { renameTableInAst, renameColumnInAst, renameColumnInCheckExpression } from '../../schema/rename-rewriter.js';
import type { ResolveColumnInSource } from '../../schema/rename-rewriter.js';
import { assertCatalogObjectPersistable, assertRenameDependentsPersistable } from '../../schema/catalog-persistability.js';
import type { Schema } from '../../schema/schema.js';
import type { Database } from '../../core/database.js';
import { tryFoldLiteral } from '../../parser/utils.js';
import { isTruthy } from '../../util/comparison.js';
import { assertDdlTransactionPolicy } from './ddl-transaction-policy.js';
import { validateAndParse } from '../../types/validation.js';
import {
	snapshotStaleMaterializedViews,
	propagateTableRenameToMaterializedViews,
	propagateColumnRenameToMaterializedViews,
	restoreUnaffectedMaterializedViews,
	attachMaintainedDerivation,
	detachMaintainedDerivation,
} from './materialized-view-helpers.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { inferType } from '../../types/registry.js';

const log = createLogger('runtime:emit:alter-table');

/** A scheduled sub-program resolved to a callback the emitter invokes per row. */

function qualifyTableName(schemaName: string | undefined, tableName: string): string {
	const prefix = (schemaName && schemaName.toLowerCase() !== 'main')
		? `${quoteIdentifier(schemaName)}.`
		: '';
	return `${prefix}${quoteIdentifier(tableName)}`;
}

export function emitAlterTable(plan: AlterTableNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;
	const action = plan.action;

	// An ADD COLUMN with a non-foldable DEFAULT carries a backfill scalar; emit it as a
	// scheduled sub-program so the scheduler resolves it into a callback the run() body
	// evaluates per existing row (via a row slot over the default's row descriptor). When the
	// new column also carries a CHECK, its predicates ride alongside as further callbacks,
	// evaluated per backfilled row against `[...existingRow, backfilledValue]`. Slot order is
	// fixed: backfill first (present whenever checks are), then the checks in order.
	const backfill: AddColumnBackfill | undefined = action.type === 'addColumn' ? action.backfill : undefined;
	const checks: AddColumnCheck | undefined = action.type === 'addColumn' ? action.checks : undefined;
	const params: Instruction[] = [
		...(backfill ? [emitCallFromPlan(backfill.node, ctx)] : []),
		...(checks?.predicates ?? []).map(p => emitCallFromPlan(p.node, ctx)),
	];

	async function run(rctx: RuntimeContext, ...args: unknown[]): Promise<SqlValue> {
		// Strict-policy gate (see ddl-transaction-policy.ts). Every ALTER arm changes a
		// module table's schema in a way that escapes rollback on a non-transactional
		// module — including the catalog-only tag/rename arms and the engine-side
		// schema-only renameColumn fallback — so gate uniformly here, before any
		// dispatch or catalog mutation.
		assertDdlTransactionPolicy(
			rctx.db, requireVtabModule(tableSchema), tableSchema.vtabModuleName,
			`ALTER TABLE ${tableSchema.name} (${action.type})`,
		);

		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchemaOrFail(tableSchema.schemaName);

		// A maintained table's shape is DEFINED by its derivation body — structural
		// ALTERs would desynchronize (and, mechanically, drop the derivation when the
		// module returns a fresh schema). Only rename and the derivation lifecycle
		// verbs (SET MAINTAINED = re-attach, DROP MAINTAINED = detach) remain
		// allowed. Tag actions must go through ALTER MATERIALIZED VIEW: the TABLE
		// verb fires `table_modified`, not `materialized_view_modified`, so the tag
		// edit would never reach the persisted maintained-table catalog entry.
		if (isMaintainedTable(tableSchema)
			&& action.type !== 'renameTable'
			&& action.type !== 'setMaintained'
			&& action.type !== 'dropMaintained') {
			throw new QuereusError(
				action.type === 'setTags' || action.type === 'dropTags'
					? `cannot ALTER TABLE '${tableSchema.name}': it is a materialized view — use ALTER MATERIALIZED VIEW for tags`
					: `cannot ALTER '${tableSchema.name}': it is a materialized view — its shape is defined by the view body (drop and recreate to change it)`,
				StatusCode.ERROR,
			);
		}

		switch (action.type) {
			case 'renameTable':
				return runRenameTable(rctx, tableSchema, schema, action.newName);
			case 'renameColumn':
				return runRenameColumn(rctx, tableSchema, schema, action.oldName, action.newName);
			case 'addColumn': {
				// Slot order set in `params`: backfill callback first (if any), then check callbacks.
				const backfillCb = backfill ? (args[0] as SubProgram) : undefined;
				const checkCbs = (args.slice(backfill ? 1 : 0) as SubProgram[]);
				return runAddColumn(rctx, tableSchema, schema, action.column, backfill, backfillCb, checks, checkCbs);
			}
			case 'dropColumn':
				return runDropColumn(rctx, tableSchema, schema, action.name);
			case 'dropConstraint':
				return runDropConstraint(rctx, tableSchema, schema, action.name);
			case 'renameConstraint':
				return runRenameConstraint(rctx, tableSchema, schema, action.oldName, action.newName);
			case 'alterPrimaryKey':
				return runAlterPrimaryKey(rctx, tableSchema, schema, action.columns);
			case 'alterColumn':
				return runAlterColumn(rctx, tableSchema, schema, action);
			case 'setTags': {
				const target = action.target;
				if (action.mode === 'merge') {
					// ADD TAGS — per-key merge onto the live tag set.
					if (target.kind === 'column') return runMergeColumnTags(rctx, tableSchema, target.columnName, action.tags);
					if (target.kind === 'constraint') return runMergeConstraintTags(rctx, tableSchema, target.constraintName, action.tags);
					return runMergeTableTags(rctx, tableSchema, action.tags);
				}
				// SET TAGS — whole-set replace.
				if (target.kind === 'column') return runSetColumnTags(rctx, tableSchema, target.columnName, action.tags);
				if (target.kind === 'constraint') return runSetConstraintTags(rctx, tableSchema, target.constraintName, action.tags);
				return runSetTableTags(rctx, tableSchema, action.tags);
			}
			case 'dropTags': {
				// DROP TAGS — per-key delete (atomic NOTFOUND if any key absent).
				const target = action.target;
				if (target.kind === 'column') return runDropColumnTags(rctx, tableSchema, target.columnName, action.keys);
				if (target.kind === 'constraint') return runDropConstraintTags(rctx, tableSchema, target.constraintName, action.keys);
				return runDropTableTags(rctx, tableSchema, action.keys);
			}
			case 'setMaintained':
				return runSetMaintained(rctx, tableSchema, schema, action.columns, action.select);
			case 'dropMaintained':
				return runDropMaintained(rctx, tableSchema, schema);
		}
	}

	const note = (() => {
		switch (action.type) {
			case 'renameTable': return `renameTable(${tableSchema.name} -> ${action.newName})`;
			case 'renameColumn': return `renameColumn(${tableSchema.name}.${action.oldName} -> ${action.newName})`;
			case 'addColumn': return `addColumn(${tableSchema.name}.${action.column.name})`;
			case 'dropColumn': return `dropColumn(${tableSchema.name}.${action.name})`;
			case 'dropConstraint': return `dropConstraint(${tableSchema.name}.${action.name})`;
			case 'renameConstraint': return `renameConstraint(${tableSchema.name}.${action.oldName} -> ${action.newName})`;
			case 'alterPrimaryKey': return `alterPrimaryKey(${tableSchema.name} -> [${action.columns.map(c => c.name).join(', ')}])`;
			case 'alterColumn': return `alterColumn(${tableSchema.name}.${action.columnName})`;
			case 'setTags': {
				const t = action.target;
				const where = t.kind === 'column' ? `${tableSchema.name}.${t.columnName}`
					: t.kind === 'constraint' ? `${tableSchema.name}.constraint ${t.constraintName}`
					: tableSchema.name;
				return action.mode === 'merge' ? `mergeTags(${where})` : `setTags(${where})`;
			}
			case 'dropTags': {
				const t = action.target;
				const where = t.kind === 'column' ? `${tableSchema.name}.${t.columnName}`
					: t.kind === 'constraint' ? `${tableSchema.name}.constraint ${t.constraintName}`
					: tableSchema.name;
				return `dropTags(${where})`;
			}
			case 'setMaintained': return `setMaintained(${tableSchema.name})`;
			case 'dropMaintained': return `dropMaintained(${tableSchema.name})`;
		}
	})();

	return {
		params,
		run: asRun(run),
		note,
	};
}

async function runRenameTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	newName: string,
): Promise<SqlValue> {
	const oldName = tableSchema.name;

	// Check for name conflict
	if (schema.getTable(newName)) {
		throw new QuereusError(`Table '${newName}' already exists`, StatusCode.ERROR);
	}

	// Pre-flight, BEFORE the first side effect (`module.renameTable`): every catalog
	// entry this rename would rewrite must still be persistable. Both the rename
	// propagation and the store's catalog write are unfailable (notifier try/catch,
	// then an async persist queue), so without this the statement reports success and
	// the dependent silently diverges from — or vanishes from — the durable catalog.
	if (isMaintainedTable(tableSchema)) {
		// The renamed table is itself a materialized view: its own catalog entry moves
		// (`materialized_view_removed` old → `materialized_view_added` new), so vet the
		// prospective record's new KEY and DDL text. The self-reference rewrite
		// `rewriteTableForTableRename` performs is not applied to the probe — it only
		// substitutes `newName`, which is already under test as the record's own name.
		assertCatalogObjectPersistable(rctx.db, 'materializedView', { ...tableSchema, name: newName });
	}
	assertRenameDependentsPersistable(rctx.db, schema,
		ast => renameTableInAst(ast, oldName, newName, tableSchema.schemaName));

	// Clone schema with new name
	const updatedTableSchema: TableSchema = {
		...tableSchema,
		name: newName,
	};

	// Let the module re-key its internal state and move any physical storage
	// BEFORE we mutate the in-memory catalog, so a module failure leaves the
	// catalog untouched. Modules that don't persist by table name can simply
	// omit the hook.
	const module = requireVtabModule(tableSchema);
	if (module.renameTable) {
		await module.renameTable(rctx.db, tableSchema.schemaName, oldName, newName);
	}

	// Events this transaction already recorded still carry the OLD name; relabel them so
	// the commit delivers every event under the name the table has at delivery. AFTER the
	// module call (a module failure must leave the batch as untouched as the catalog, and
	// the store's `ddlCommitPendingOps` flushes its queued events into our batch DURING
	// that call — those must be in the batch before we walk it), BEFORE the catalog swap,
	// matching where the other ALTER arms call `remapBatchedDataEvents`.
	//
	// NOTE: batched SCHEMA events are deliberately out of scope here. A schema event
	// records a DDL operation, not current state — relabelling `objectName` without
	// rewriting its `ddl` text would produce an incoherent instruction. How a rename
	// crosses the wire to a peer is `fix/sync-schema-migrations-replicate-empty-ddl`.
	rctx.db._getEventEmitter().renameBatchedEvents(tableSchema.schemaName, oldName, newName);

	// The renamed table's own definition can name itself: a self-referencing FK's
	// `referencedTable`, a table-qualified CHECK expression, a table-qualified
	// partial-index predicate. Rewrite those BEFORE the catalog swap and the notify
	// below, so no listener ever observes — or persists — a schema pointing at the
	// vanished old name. `propagateTableRename` runs the same rewrite over every
	// table in the catalog, but only after the notify; it is idempotent, so this
	// call simply makes that pass a no-op for this one table.
	const renamedTableSchema = rewriteTableForTableRename(
		updatedTableSchema, tableSchema.schemaName.toLowerCase(), oldName, newName);

	// Remove old, add new in the catalog
	schema.removeTable(oldName);
	schema.addTable(renamedTableSchema);

	// Snapshot which MVs are stale BEFORE this statement's first schema-change
	// notify: the MV propagation below restores staleness set by this very
	// statement's events, but must never clear a pre-existing flag (the backing
	// may already be behind; only REFRESH can safely clear that).
	const preStaleMvs = snapshotStaleMaterializedViews(rctx.db);

	// Notify schema change
	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: newName,
		oldObject: tableSchema,
		newObject: renamedTableSchema,
	});

	// Propagate the rename into dependent objects (CHECK / FK / partial-index
	// predicates in this and other tables, view and materialized-view bodies).
	// Best-effort AST rewrite — there is no global dependency tracker yet, so we
	// walk the catalog and patch in-place.
	await propagateTableRename(rctx, tableSchema.schemaName, oldName, newName, preStaleMvs);

	// Renaming a MAINTAINED table is an ordinary table rename plus a maintenance
	// re-key: the row-time plan is keyed by `schema.name`, so release the old key
	// and re-register under the new one, then move the persisted MV catalog entry
	// (`materialized_view_removed` old name → `materialized_view_added` new name).
	if (isMaintainedTable(renamedTableSchema)) {
		rctx.db.unregisterMaterializedView(tableSchema.schemaName, oldName);
		rctx.db.registerMaterializedView(renamedTableSchema);
		const notifier = rctx.db.schemaManager.getChangeNotifier();
		notifier.notifyChange({
			type: 'materialized_view_removed',
			schemaName: tableSchema.schemaName,
			objectName: oldName,
			oldObject: tableSchema,
		});
		notifier.notifyChange({
			type: 'materialized_view_added',
			schemaName: tableSchema.schemaName,
			objectName: newName,
			newObject: renamedTableSchema,
		});
	}

	// Second rename phase. `propagateTableRename` above rewrote every dependent object
	// that named `oldName` and (for a persistent module) enqueued their corrective catalog
	// writes. Signal the module to finalize: it may now drop any old-name catalog state,
	// but only once those dependent writes are durable — so no on-disk catalog set ever
	// names a vanished table. A module whose `renameTable` already did all its work (or
	// that keeps no per-name catalog) simply omits the hook.
	await module.finalizeRename?.(rctx.db, tableSchema.schemaName, oldName, newName);

	log('Renamed table %s.%s to %s', tableSchema.schemaName, oldName, newName);
	return null;
}

async function runRenameColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	oldName: string,
	newName: string,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(oldName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${oldName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	const newNameLower = newName.toLowerCase();
	if (oldName.toLowerCase() !== newNameLower && tableSchema.columnIndexMap.has(newNameLower)) {
		throw new QuereusError(`Column '${newName}' already exists in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Pre-flight, BEFORE the first side effect (`module.alterTable`): the rewritten
	// body of every dependent view / materialized view must still be persistable —
	// same unfailable-propagation reasoning as the table-rename arm above. Shares one
	// resolver with `propagateColumnRename` so the two passes cannot drift apart in
	// code; what makes them agree at RUNTIME (the resolver reads the LIVE catalog, and
	// this probe runs pre-mutation while the propagation runs post-) is that
	// `isTableInUnaliasedScope` skips the renamed table itself and probes only OTHER
	// sources, whose column sets this rename does not touch.
	const resolveColumnInSource = buildColumnSourceResolver(rctx.db);
	assertRenameDependentsPersistable(rctx.db, schema, ast => renameColumnInAst(
		ast, tableSchema.name, oldName, newName, tableSchema.schemaName, resolveColumnInSource));

	const existingCol = tableSchema.columns[colIndex];

	// Build a ColumnDef AST for the renamed column (preserving type info)
	const newColumnDef: ColumnDef = {
		name: newName,
		dataType: existingCol.logicalType.name,
		constraints: buildConstraintsFromColumn(existingCol),
	};

	// Call module.alterTable if available (handles data-level changes)
	const module = requireVtabModule(tableSchema);
	let updatedTableSchema: TableSchema;

	if (module.alterTable) {
		updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
			type: 'renameColumn',
			oldName,
			newName,
			newColumnDefAst: newColumnDef,
		});
	} else {
		// Schema-only rename (no data-level changes needed for rename)
		const updatedCols = tableSchema.columns.map((c, i) =>
			i === colIndex ? { ...c, name: newName } : c
		);
		updatedTableSchema = {
			...tableSchema,
			columns: Object.freeze(updatedCols),
			columnIndexMap: buildColumnIndexMap(updatedCols),
		};
	}

	// A rename moves no value and changes no arity, so the batched events' row images are
	// already right — but their `changedColumns` still names the OLD column. Re-derive it
	// against the new names with an identity row map, so no delivered event names a column
	// the table no longer has. (Modules that emit at commit from their own queue read the
	// current schema then, so they need nothing here.)
	await rctx.db._getEventEmitter().remapBatchedDataEvents(
		tableSchema.schemaName, tableSchema.name,
		(row) => row,
		updatedTableSchema.columns.map(c => c.name),
	);

	// Update the schema catalog
	schema.addTable(updatedTableSchema);

	// Snapshot pre-statement MV staleness BEFORE the notify below: the notify's
	// listener marks every dependent MV stale, and the propagation must be able to
	// tell that statement-local staleness (restorable after a successful rewrite)
	// apart from a pre-existing flag (never cleared — only REFRESH may).
	const preStaleMvs = snapshotStaleMaterializedViews(rctx.db);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	// Propagate the rename into dependent objects (CHECK / FK / partial-index
	// predicates in this and other tables, view and materialized-view bodies).
	await propagateColumnRename(rctx, tableSchema.schemaName, tableSchema.name, oldName, newName, preStaleMvs, resolveColumnInSource);

	log('Renamed column %s.%s.%s to %s', tableSchema.schemaName, tableSchema.name, oldName, newName);
	return null;
}

async function runAddColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columnDef: ColumnDef,
	backfill?: AddColumnBackfill,
	backfillCb?: SubProgram,
	checks?: AddColumnCheck,
	checkCbs?: ReadonlyArray<SubProgram>,
): Promise<SqlValue> {
	// Validate column doesn't already exist
	if (tableSchema.columnIndexMap.has(columnDef.name.toLowerCase())) {
		throw new QuereusError(`Column '${columnDef.name}' already exists in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Validate no PK column addition
	if (columnDef.constraints?.some(c => c.type === 'primaryKey')) {
		throw new QuereusError(`Cannot add a PRIMARY KEY column via ALTER TABLE`, StatusCode.ERROR);
	}

	// The DEFAULT was validated at plan-build time through the shared DDL validator
	// (bind params / bare columns / non-determinism rejected; `new.<column>` accepted)
	// and, when it does not fold to a literal, compiled into `backfill` — the default
	// evaluated against the existing row, so `new.<column>` reads that row's sibling.
	const defaultConstraint = columnDef.constraints?.find(c => c.type === 'default');
	// Folded literal default; undefined when there is no default or it does not fold
	// (the latter carries `backfill` instead). Used by the NOT NULL gate below and by
	// the batched-event remap's backfill value.
	const foldedDefault = defaultConstraint?.expr ? tryFoldLiteral(defaultConstraint.expr) : undefined;

	// Call module.alterTable for data + schema update
	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE ADD COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	// NOT NULL without a usable DEFAULT cannot backfill existing rows. A DEFAULT whose
	// folded value is NULL is equivalent to "no DEFAULT" for this purpose. A non-foldable
	// expression default (carried in `backfill`) IS usable — its NOT NULL enforcement is
	// deferred to the post-backfill scan — so it is not rejected here. If the table is
	// non-empty and the default is nullish, reject before mutating any schema or data.
	//
	// A module may opt out of this engine-generic rejection via the
	// `delegatesNotNullBackfill` capability (structurally-total modules that
	// carry pre-existing rows forward and enforce NOT NULL at write time). When
	// it declares the capability, the decision is left entirely to its
	// `alterTable`. Native modules leave it off, so this still fires for them.
	const delegatesBackfill = module.getCapabilities?.().delegatesNotNullBackfill === true;
	const hasNotNull = columnDef.constraints?.some(c => c.type === 'notNull') ?? false;
	if (hasNotNull && !delegatesBackfill && !backfill) {
		const defaultIsNullish = !defaultConstraint?.expr || foldedDefault === null;
		if (defaultIsNullish) {
			await validateNotNullBackfill(rctx, tableSchema, columnDef.name);
		}
	}

	// Synthesize the table-level equivalent of every constraint declared inline on the new
	// column. All three kinds go to the module via `addConstraint` below — the same path
	// `ALTER TABLE ADD CONSTRAINT` uses — so the module owns them exactly as it owns a
	// constraint declared in CREATE TABLE, and they survive every later structural ALTER
	// (which installs the module's returned schema in the catalog verbatim).
	//
	// Extracted BEFORE the column is materialized so a malformed declaration (e.g. a
	// multi-parent-column FK on a single ADD COLUMN) throws while the table is still
	// untouched. Install order within the loop is UNIQUE → CHECK → FK, so a column
	// declaring several kinds reports the cheapest-to-explain violation first; the
	// literal-default CHECK scan runs ahead of the whole loop (see below).
	const inlineChecks = extractColumnLevelCheckConstraints(columnDef);
	const inlineConstraints: AST.TableConstraint[] = [
		...extractColumnLevelUniqueConstraints(columnDef),
		...inlineChecks,
		...extractColumnLevelForeignKeys(columnDef),
	];

	// A non-foldable default backfills each existing row from its own value. Install a row
	// slot over the default's row descriptor; the evaluator the module calls per existing
	// row sets the slot to that row, so the default's `new.<col>` refs resolve to it.
	const rowSlot = backfill ? createRowSlot(rctx, backfill.rowDescriptor) : undefined;
	// When the new column carries a CHECK, install a second slot over the existing columns
	// plus the new column; we evaluate each predicate against `[...existingRow, value]` after
	// computing the backfilled value and throw on a violation, so a CHECK-violating row aborts
	// the ALTER inside the per-row hook — before any tree/batch swap — and the catalog is never
	// mutated (mirrors the NOT NULL per-row path). This supersedes the post-backfill scan,
	// which reads a stale pre-backfill snapshot for the evaluator path.
	const checkSlot = backfill && checks ? createRowSlot(rctx, checks.rowDescriptor) : undefined;
	const checkPredicates = checks?.predicates ?? [];
	const backfillEvaluator = backfill && backfillCb && rowSlot
		? async (row: Row): Promise<SqlValue> => {
			rowSlot.set(row);
			const valueRaw = backfillCb(rctx);
			const value = (valueRaw instanceof Promise ? await valueRaw : valueRaw) as SqlValue;
			if (checkSlot && checkPredicates.length > 0 && checkCbs) {
				checkSlot.set([...row, value]);
				for (let i = 0; i < checkPredicates.length; i++) {
					const resultRaw = checkCbs[i](rctx);
					const result = (resultRaw instanceof Promise ? await resultRaw : resultRaw) as SqlValue;
					// CHECK passes on truthy / NULL; fails otherwise (shared isTruthy semantics, matches write-time).
					if (result !== null && !isTruthy(result)) {
						const pred = checkPredicates[i];
						const hint = pred.exprText ? ` (${pred.exprText})` : '';
						throw new QuereusError(
							`CHECK constraint failed: ${pred.name ?? `_check_${columnDef.name}`}${hint}`,
							StatusCode.CONSTRAINT,
						);
					}
				}
			}
			return value;
		}
		: undefined;

	// The slots are only needed while the module is appending the column (it calls the
	// evaluator per existing row); close them as soon as that returns — before the CHECK
	// scan below re-reads the table — so the backfill's context does not shadow the
	// scan's own row context.
	let updatedTableSchema: TableSchema;
	// Slot the module actually placed the new column at (the module API permits
	// `insertAtIndex`; SQL always appends). Recorded so the revert paths below can apply
	// the inverse event remap.
	let addedColIndex: number | undefined;
	try {
		updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
			type: 'addColumn',
			columnDef,
			backfillEvaluator,
		});

		// Events this transaction already batched for the table still describe the
		// pre-ADD column set; insert the backfilled value at the new slot so a listener
		// at commit pairs value i with column i of the schema current at delivery.
		// Covers the engine auto-event path and the store module (which flushed its
		// queued events into the batch during the ALTER); the memory module's own
		// pending-change log is reshaped inside its alterTable. Must run INSIDE this
		// try: the backfill evaluator closes over rowSlot/checkSlot, which the finally
		// below closes the moment the module returns.
		addedColIndex = updatedTableSchema.columnIndexMap.get(columnDef.name.toLowerCase());
		if (addedColIndex !== undefined) {
			const insertAt = addedColIndex;
			await rctx.db._getEventEmitter().remapBatchedDataEvents(
				tableSchema.schemaName, tableSchema.name,
				async (row) => {
					// oldRow gets the SAME map as newRow: the literal default, or the backfill
					// evaluator applied to the pre-image itself (the evaluator is a function of
					// a row, and the pre-image is a row), falling back to NULL — the honest
					// "column did not exist yet" placeholder, which errs toward REPORTING a
					// change on the new column rather than suppressing one. Rejected: reusing
					// the newRow result for oldRow (makes oldRow[new] === newRow[new] always,
					// so a diffing consumer never syncs the added column); suppressing the
					// pre-ALTER oldRow (silently turns updates into upserts).
					let value: SqlValue = foldedDefault ?? null;
					if (backfillEvaluator) {
						try {
							value = await backfillEvaluator(row);
						} catch {
							// Best-effort: a historical image may fail the evaluator (or its
							// CHECKs) where every live row backfilled cleanly. Never abort
							// the ALTER for an event image.
							value = null;
						}
					}
					return [...row.slice(0, insertAt), value, ...row.slice(insertAt)] as Row;
				},
				updatedTableSchema.columns.map(c => c.name),
			);
		}
	} finally {
		rowSlot?.close();
		checkSlot?.close();
	}

	// The column is materialized; now install the inline constraints. Names of the CHECK /
	// FK ones the module has accepted so far, so a later failure can hand each back to
	// `dropConstraint` before the column itself goes (see {@link revertAddColumn}).
	const installedConstraintNames: string[] = [];
	let finalTableSchema: TableSchema;
	try {
		// Recompute the generated-column dependency graph. If the added column is generated
		// and its expression references an unknown column, or any new generated-column edges
		// form a cycle, this throws — and the revert below undoes the materialization.
		const columnOnlySchema = withGeneratedColumnGraph(updatedTableSchema);

		// Register the COLUMN-ONLY schema before installing any inline constraint. Two
		// properties depend on this ordering, and both are easy to break:
		//
		//  - The module's FK arm validates existing rows with SQL planned against the LIVE
		//    catalog, so the new column has to resolve there. Likewise the CHECK backfill
		//    scan below.
		//  - The new constraint must NOT be live while its own validation runs. The optimizer
		//    trusts a DECLARED constraint as a proven invariant: a declared FK seeds the
		//    inclusion dependency `child.fk ⊆ parent.pk` and folds the validator's own
		//    `not exists` anti-join to EmptyRelation (`ruleAntiJoinFkEmpty`); a declared CHECK
		//    `<p>` seeds a domain constraint that folds the CHECK scan's `where not (<p>)`
		//    away (`ruleFilterContradiction`). Either fold makes validation trust the very
		//    thing it is checking and silently admit a violating row. The module holds each
		//    new constraint in its own cached schema until that constraint's validation
		//    passes, and the catalog only learns of them from `finalTableSchema` below.
		//
		// Pre-existing constraints stay live throughout: they held before this ALTER, so
		// folding against them is sound and preserves the optimizer's reach.
		schema.addTable(columnOnlySchema);

		// Validate the backfilled values against each inline CHECK, for the literal-default
		// path only. A per-row (evaluator) default already enforced its CHECKs inside the
		// backfill hook above — against the freshly-computed value rather than this scan's
		// stale pre-backfill snapshot — and the module enforces NOT NULL there too. Runs
		// before the whole install loop below, so on a column declaring several kinds a
		// CHECK violation is reported ahead of a UNIQUE or FK one.
		if (!backfill && inlineChecks.length > 0) {
			await validateBackfillAgainstChecks(rctx, columnOnlySchema, inlineChecks);
		}

		// Starts as the column-only schema so a column with no inline constraint needs no
		// further work; each accepted constraint replaces it with the module's answer.
		//
		// NOTE: one module round-trip per inline constraint — each takes the module's
		// schema-change latch and, store-backed, writes the table's DDL again. Fine at the
		// counts SQL produces (a column declares 0 or 1 of each kind); if a batched
		// `addConstraint` arm ever appears, or ADD COLUMN becomes hot, hand the whole set
		// over in one call instead.
		let current = columnOnlySchema;
		for (const constraint of inlineConstraints) {
			// A CHECK / FK is dropped by NAME on the revert path, so resolve the name the
			// module will store BEFORE handing the constraint over. UNIQUE needs no entry:
			// an unnamed one has no name to drop by, and the module's own DROP COLUMN
			// prunes a UNIQUE over the dropped column (which CHECK / FK are not).
			let installedName: string | undefined;
			if (constraint.type === 'foreignKey') {
				// Reject a same-rank child/parent collation conflict (which enforcement would
				// raise at the first DML) BEFORE `module.alterTable`, so a rejected ALTER never
				// reaches the module's persistence side effects — mirroring
				// `runAddConstraintViaModule`. Built with the same builder and columnIndexMap
				// the module uses, so the name and column indices are identical to its own.
				const fk = buildForeignKeyConstraintSchema(
					constraint, columnOnlySchema.columnIndexMap, tableSchema.name, tableSchema.schemaName);
				validateForeignKeyCollations(rctx.db, columnOnlySchema, fk);
				installedName = fk.name;
			} else if (constraint.type === 'check') {
				installedName = constraint.name;	// always set by the extractor
			}

			// The module materializes (UNIQUE's covering structure), validates the existing
			// rows as the kind requires (UNIQUE duplicates, pragma-gated MATCH SIMPLE FK
			// orphans) and — store-backed — persists. Thread the returned schema forward so
			// each constraint layers on the last. The module's answer carries no
			// generated-column bookkeeping of its own, so re-derive it each round.
			const withConstraint = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
				type: 'addConstraint',
				constraint,
			});
			current = withGeneratedColumnGraph(withConstraint);
			if (installedName !== undefined) installedConstraintNames.push(installedName);
		}

		finalTableSchema = current;
	} catch (err) {
		await revertAddColumn(rctx, tableSchema, schema, columnDef.name, addedColIndex, installedConstraintNames);
		throw err;
	}

	// Every constraint validated and installed — publish the module's final schema.
	schema.addTable(finalTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: finalTableSchema,
	});

	log('Added column %s to table %s.%s', columnDef.name, tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * Undoes a partially-applied ADD COLUMN, leaving the table exactly as it was: hands each
 * inline CHECK / FK the module already accepted back to `dropConstraint` (newest first),
 * drops the column, un-remaps the batched events, and restores the original catalog entry.
 *
 * The constraints must go before the column: neither built-in module prunes a CHECK / FK
 * over a dropped column, so a stranded one would keep naming a column the table no longer
 * has. (An inline UNIQUE needs no explicit drop — both modules prune a UNIQUE over the
 * dropped column, and an unnamed one has no name to drop by.)
 *
 * Best-effort on the module half: a revert failure is logged, never thrown, so it cannot
 * mask the original violation. Restoring the catalog entry is a no-op when the ALTER failed
 * before registering anything (the original schema is still the live one).
 *
 * NOTE: the hand-back is by NAME, so it assumes a name resolves to the constraint this
 * ALTER installed. A pre-existing constraint can legitimately share an auto-name (nothing
 * rejects `constraint _check_w check (…)` on a table that later gets `add column w …
 * check (…)`; `create table` collides the same way), and today both modules' DROP
 * CONSTRAINT removes every match, which lands on the right end state. If constraint-name
 * resolution ever narrows to a single match, revert must instead identify the installed
 * constraint by identity — otherwise it can drop the pre-existing one and leave ours.
 */
async function revertAddColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: Schema,
	columnName: string,
	addedColIndex: number | undefined,
	installedConstraintNames: ReadonlyArray<string>,
): Promise<void> {
	try {
		const module = requireVtabModule(tableSchema);
		// Unreachable: runAddColumn requires `alterTable` before materializing anything.
		if (!module.alterTable) return;
		for (let i = installedConstraintNames.length - 1; i >= 0; i--) {
			await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
				type: 'dropConstraint',
				constraintName: installedConstraintNames[i],
			});
		}
		await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
			type: 'dropColumn',
			columnName,
		});
		await remapEventsForRevertedAddColumn(rctx, tableSchema, addedColIndex);
	} catch (revertErr) {
		log('Failed to revert ADD COLUMN %s.%s.%s: %s',
			tableSchema.schemaName, tableSchema.name, columnName, (revertErr as Error).message);
	}
	schema.addTable(tableSchema);
}

/**
 * Inverse of {@link runAddColumn}'s batched-event remap, for its revert paths: the
 * just-added column has been dropped from the module again, so the batched events must
 * drop the slot too or they keep describing a column the table no longer has. No-op when
 * the forward remap never ran (`addedColIndex` undefined). Best-effort like the forward
 * remap — never masks the original constraint error.
 */
async function remapEventsForRevertedAddColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	addedColIndex: number | undefined,
): Promise<void> {
	if (addedColIndex === undefined) return;
	await rctx.db._getEventEmitter().remapBatchedDataEvents(
		tableSchema.schemaName, tableSchema.name,
		(row) => row.filter((_, i) => i !== addedColIndex),
		tableSchema.columns.map(c => c.name),
	);
}

/**
 * Runs each new CHECK against the (already-backfilled) existing rows. Relies on the
 * just-registered column-only schema so SQL can resolve the new column while the CHECK
 * itself is not yet declared — declaring it first would let `ruleFilterContradiction`
 * fold this scan's own `not (<check_expr>)` to EmptyRelation. Any row matching
 * `not (<check_expr>)` is a violation and aborts the ALTER.
 */
async function validateBackfillAgainstChecks(
	rctx: RuntimeContext,
	columnOnlySchema: TableSchema,
	newCheckConstraints: ReadonlyArray<AST.TableConstraint>,
): Promise<void> {
	const qualifiedTable = qualifyTableName(columnOnlySchema.schemaName, columnOnlySchema.name);

	for (const cc of newCheckConstraints) {
		// `extractColumnLevelCheckConstraints` skips an expression-less CHECK, so this
		// cannot fire — but silently skipping a constraint we were asked to validate
		// would admit a violating row, so say so loudly rather than `continue`.
		if (!cc.expr) {
			throw new QuereusError(
				`CHECK constraint ${cc.name ? `'${cc.name}' ` : ''}on ALTER TABLE ADD COLUMN has no expression`,
				StatusCode.INTERNAL,
			);
		}
		const checkSql = expressionToString(cc.expr);
		const sql = `select 1 from ${qualifiedTable} where not (${checkSql}) limit 1`;
		const stmt = rctx.db.prepare(sql);
		try {
			let violated = false;
			for await (const _row of stmt._iterateRowsRaw()) {
				violated = true;
				break;
			}
			if (violated) {
				throw new QuereusError(
					`CHECK constraint ${cc.name ? `'${cc.name}' ` : ''}violated by backfilled rows in ALTER TABLE ADD COLUMN on '${columnOnlySchema.name}'`,
					StatusCode.CONSTRAINT,
				);
			}
		} finally {
			await stmt.finalize();
		}
	}
}

/**
 * Rejects ADD COLUMN ... NOT NULL when no usable DEFAULT is supplied and the
 * table already has rows. The pre-mutation form means no rollback is needed —
 * the schema and module state are still untouched at this point.
 */
async function validateNotNullBackfill(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	newColumnName: string,
): Promise<void> {
	const qualifiedTable = qualifyTableName(tableSchema.schemaName, tableSchema.name);
	const stmt = rctx.db.prepare(`select 1 from ${qualifiedTable} limit 1`);
	try {
		for await (const _row of stmt._iterateRowsRaw()) {
			throw new QuereusError(
				`NOT NULL constraint failed for column '${newColumnName}' added to ${tableSchema.schemaName}.${tableSchema.name} — column has no DEFAULT and existing rows cannot be backfilled`,
				StatusCode.CONSTRAINT,
			);
		}
	} finally {
		await stmt.finalize();
	}
}

/**
 * Whether a partial-index predicate names `columnName`. Depth-blind walk over the
 * predicate's object graph, matching `column` / `identifier` nodes by name alone —
 * the parser emits either shape for a bare name depending on context.
 *
 * The table qualifier is IGNORED — matching by bare name alone — which is now moot
 * rather than a deliberate mismatch: `compilePredicate` rejects a foreign `table`
 * qualifier at create time (a self-qualifier binds to the indexed table), so no LIVE
 * predicate can carry one. Every ref this walk sees therefore names the indexed table's
 * own column, and matching on bare name is exactly right. Making the walk
 * qualifier-aware would only guard a case that can no longer occur.
 *
 * NOTE: depth-blind. `compilePredicate` rejects subqueries, so every ref in a live
 * predicate binds to the indexed table. If partial-index predicates ever admit
 * subqueries, an inner ref to a like-named column of another table would
 * false-positively block a legal DROP COLUMN; this walk would then need the scope
 * stack the rename rewriters carry.
 */
function predicateReferencesColumn(expr: Expression, columnName: string): boolean {
	const colLower = columnName.toLowerCase();
	let found = false;
	const visit = (v: unknown): void => {
		if (found || v === null || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		const n = v as Record<string, unknown>;
		if ((n.type === 'column' || n.type === 'identifier')
			&& typeof n.name === 'string' && n.name.toLowerCase() === colLower) {
			found = true;
			return;
		}
		for (const key of Object.keys(n)) {
			if (key === 'loc') continue;
			visit(n[key]);
		}
	};
	visit(expr);
	return found;
}

async function runDropColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columnName: string,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(columnName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${columnName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Validate: can't drop PK column
	if (tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		throw new QuereusError(`Cannot drop PRIMARY KEY column '${columnName}'`, StatusCode.CONSTRAINT);
	}

	// Validate: can't drop last column
	if (tableSchema.columns.length <= 1) {
		throw new QuereusError(`Cannot drop the last column of table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Validate: can't drop a column that any generated column's expression depends on
	if (tableSchema.generatedColumnDependencies) {
		for (const [genIdx, depIndices] of tableSchema.generatedColumnDependencies) {
			if (genIdx === colIndex) continue; // Dropping the gen column itself is allowed
			if (depIndices.includes(colIndex)) {
				const genName = tableSchema.columns[genIdx].name;
				throw new QuereusError(
					`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by generated column '${genName}'`,
					StatusCode.CONSTRAINT,
				);
			}
		}
	}

	// Validate: can't drop a column named by a partial index's WHERE predicate — the
	// index would be left with a predicate that cannot compile. A column used only as
	// an index KEY column is fine: the module narrows the index and drops it outright
	// when no key columns survive.
	for (const idx of tableSchema.indexes ?? []) {
		if (idx.predicate && predicateReferencesColumn(idx.predicate, columnName)) {
			throw new QuereusError(
				`Cannot drop column '${columnName}' from '${tableSchema.name}': it is referenced by the WHERE clause of partial index '${idx.name}'`,
				StatusCode.CONSTRAINT,
			);
		}
	}

	// Call module.alterTable for data + schema update
	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE DROP COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'dropColumn',
		columnName,
	});

	// Events this transaction already batched for the table still carry the pre-drop
	// arity; drop the slot so a listener at commit pairs value i with column i of the
	// schema current at delivery (and `changedColumns` never names the dropped column).
	// Pure slot filter — no failure mode. Covers the engine auto-event path and the
	// store module (which flushed its queued events into the batch during the ALTER);
	// the memory module's own pending-change log is reshaped inside its alterTable.
	await rctx.db._getEventEmitter().remapBatchedDataEvents(
		tableSchema.schemaName, tableSchema.name,
		(row) => row.filter((_, i) => i !== colIndex),
		updatedTableSchema.columns.map(c => c.name),
	);

	// Recompute the generated-column dependency graph against the post-drop
	// column array — old indices in the previous map are invalid.
	const finalSchema = withGeneratedColumnGraph(updatedTableSchema);

	// Update the schema catalog
	schema.addTable(finalSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: finalSchema,
	});

	log('Dropped column %s from table %s.%s', columnName, tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * DROP CONSTRAINT <name> — removes a named table-level constraint (CHECK / UNIQUE
 * / FOREIGN KEY). Resolves the class up front (NOTFOUND / ambiguous surfaced here
 * with a clear error before any module call), rejects dropping a UNIQUE constraint
 * that is the synthesized side of an explicit `CREATE UNIQUE INDEX` (the index is
 * the user's — `DROP INDEX` is the correct primitive), then routes the rewrite
 * through `module.alterTable` so persistent modules re-persist their DDL. The
 * module owns the actual array rewrite and, for a UNIQUE, tearing down the
 * implicit covering index that backs it.
 */
async function runDropConstraint(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	constraintName: string,
): Promise<SqlValue> {
	const constraintClass = resolveNamedConstraintClass(tableSchema, constraintName);
	if (constraintClass === 'unique') {
		rejectDerivedFromIndex(tableSchema, constraintName, 'DROP');
	}

	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE DROP CONSTRAINT`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'dropConstraint',
		constraintName,
	});

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Dropped constraint %s from table %s.%s', constraintName, tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * RENAME CONSTRAINT <old> TO <new> — name-level rename of a named table-level
 * constraint. Resolves the class up front, rejects a no-op / collision (the new
 * name must not already address a constraint), and rejects renaming a UNIQUE
 * derived from an explicit index. Routed through `module.alterTable`.
 */
async function runRenameConstraint(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	oldName: string,
	newName: string,
): Promise<SqlValue> {
	const constraintClass = resolveNamedConstraintClass(tableSchema, oldName);
	if (constraintClass === 'unique') {
		rejectDerivedFromIndex(tableSchema, oldName, 'RENAME');
	}

	// Collision: the new name must not already address an existing named constraint
	// (unless it's a case-only change of the same constraint).
	const oldLower = oldName.toLowerCase();
	const newLower = newName.toLowerCase();
	if (oldLower !== newLower && namedConstraintExists(tableSchema, newName)) {
		throw new QuereusError(
			`Cannot rename constraint to '${newName}': a constraint with that name already exists in table '${tableSchema.name}'`,
			StatusCode.CONSTRAINT,
		);
	}

	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE RENAME CONSTRAINT`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'renameConstraint',
		oldName,
		newName,
	});

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Renamed constraint %s.%s.%s to %s', tableSchema.schemaName, tableSchema.name, oldName, newName);
	return null;
}

/** True when `name` addresses any named CHECK / UNIQUE / FOREIGN KEY constraint. */
function namedConstraintExists(tableSchema: TableSchema, name: string): boolean {
	const lower = name.toLowerCase();
	return (tableSchema.checkConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (tableSchema.uniqueConstraints ?? []).some(c => c.name?.toLowerCase() === lower)
		|| (tableSchema.foreignKeys ?? []).some(c => c.name?.toLowerCase() === lower);
}

/**
 * Rejects DROP/RENAME of a UNIQUE constraint that was synthesized from an explicit
 * `CREATE UNIQUE INDEX` (`derivedFromIndex` set). That constraint is the index's
 * shadow — dropping/renaming it alone would strand the index, so the user must
 * operate on the index (`DROP INDEX`) instead.
 */
function rejectDerivedFromIndex(tableSchema: TableSchema, constraintName: string, op: 'DROP' | 'RENAME'): void {
	const lower = constraintName.toLowerCase();
	const uc = (tableSchema.uniqueConstraints ?? []).find(c => c.name?.toLowerCase() === lower);
	if (uc?.derivedFromIndex) {
		throw new QuereusError(
			`Cannot ${op} CONSTRAINT '${constraintName}' on '${tableSchema.name}': it is backed by index '${uc.derivedFromIndex}' (created via CREATE UNIQUE INDEX). Use DROP INDEX '${uc.derivedFromIndex}' instead.`,
			StatusCode.CONSTRAINT,
		);
	}
}

async function runAlterColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	action: Extract<import('../../planner/nodes/alter-table-node.js').AlterTableAction, { type: 'alterColumn' }>,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(action.columnName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${action.columnName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Guard: at most one of the four attribute changes per statement.
	const populated = [action.setNotNull !== undefined, action.setDataType !== undefined, action.setDefault !== undefined, action.setCollation !== undefined];
	const populatedCount = populated.filter(Boolean).length;
	if (populatedCount !== 1) {
		throw new QuereusError(
			`ALTER COLUMN requires exactly one of SET/DROP NOT NULL, SET DATA TYPE, SET/DROP DEFAULT, SET COLLATE (got ${populatedCount})`,
			StatusCode.INTERNAL,
		);
	}

	// Cannot alter a PRIMARY KEY column's nullability or data type. (SET COLLATE on
	// a PK column IS permitted — the module re-keys the primary structure under the
	// new collation; see runAlterColumn module contract.)
	if (tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		if (action.setNotNull === false) {
			throw new QuereusError(`Cannot DROP NOT NULL on PRIMARY KEY column '${action.columnName}'`, StatusCode.CONSTRAINT);
		}
		if (action.setDataType !== undefined) {
			throw new QuereusError(`Cannot SET DATA TYPE on PRIMARY KEY column '${action.columnName}'`, StatusCode.CONSTRAINT);
		}
	}

	// SET COLLATE: validate the collation against the column's logical type up front
	// (same error shape as CREATE TABLE), so an unknown collation is rejected before
	// any module round-trip / re-sort. The module re-normalizes and applies it.
	if (action.setCollation !== undefined) {
		validateCollationForType(
			action.setCollation, tableSchema.columns[colIndex].logicalType, action.columnName,
			(n) => rctx.db.isCollationRegistered(n),
		);
	}

	// SET DATA TYPE: the column keeps its current collation, so the NEW type has to accept it —
	// otherwise the ALTER mints a column shape CREATE TABLE would refuse and generateTableDDL
	// cannot round-trip (a store-backed table with such a column is silently dropped on rehydrate).
	// Same validator, same error text as CREATE TABLE / SET COLLATE. Rejects uniformly whether the
	// collation was user-declared or inherited from `pragma default_collation`: `collationExplicit`
	// is not persisted, so keying on it would coerce before a reopen and reject after one.
	// Remedy: `SET COLLATE binary` first, then retype.
	if (action.setDataType !== undefined) {
		validateCollationForType(
			tableSchema.columns[colIndex].collation,
			inferType(action.setDataType),
			action.columnName,
			(n) => rctx.db.isCollationRegistered(n),
		);
	}

	// Route a SET DEFAULT through the same DDL validator CREATE TABLE uses, so the
	// stored default is consistent with what INSERT will accept: bind params / bare
	// columns / non-determinism rejected, `new.<column>` accepted (deferred to INSERT
	// time). DROP DEFAULT (`setDefault === null`) needs no validation.
	if (action.setDefault !== undefined && action.setDefault !== null) {
		const hasMutationContext = !!tableSchema.mutationContext && tableSchema.mutationContext.length > 0;
		rctx.db.schemaManager.validateAlterColumnDefault(
			action.setDefault, action.columnName, tableSchema.name, hasMutationContext,
		);
	}

	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'alterColumn',
		columnName: action.columnName,
		setNotNull: action.setNotNull,
		setDataType: action.setDataType,
		setDefault: action.setDefault,
		setCollation: action.setCollation,
	});

	// Events this transaction already batched still carry the PRE-conversion value at
	// the altered column (`SET DATA TYPE`'s normalization, `SET NOT NULL`'s null →
	// DEFAULT backfill); rewrite it so a listener at commit sees the value the
	// committed row holds. The conversion is engine-derivable (the same
	// `validateAndParse` the memory module's converter wraps), so no module-contract
	// change. `SET COLLATE` / `SET DEFAULT` / `DROP NOT NULL` move no stored value and
	// need no remap — in particular the primary-key `SET COLLATE` re-key leaves every
	// event's key and row images valid as-is.
	const eventValueRemap = alterColumnEventValueRemap(tableSchema, colIndex, action);
	if (eventValueRemap) {
		await rctx.db._getEventEmitter().remapBatchedDataEvents(
			tableSchema.schemaName, tableSchema.name,
			(row) => row.map((v, i) => i === colIndex ? eventValueRemap(v) : v) as Row,
			updatedTableSchema.columns.map(c => c.name),
		);
	}

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Altered column %s.%s.%s', tableSchema.schemaName, tableSchema.name, action.columnName);
	return null;
}

/**
 * The per-value map {@link runAlterColumn}'s batched-event remap applies at the altered
 * column, or undefined when the ALTER moves no stored value (SET COLLATE, SET DEFAULT,
 * DROP NOT NULL, an alias retype). The returned function is TOTAL — an unconvertible
 * historical event image keeps its raw value rather than aborting the ALTER; the module
 * already validated every value the transaction can actually SEE, so a failure here is
 * confined to a superseded intermediate image.
 */
function alterColumnEventValueRemap(
	tableSchema: TableSchema,
	colIndex: number,
	action: Extract<import('../../planner/nodes/alter-table-node.js').AlterTableAction, { type: 'alterColumn' }>,
): ((v: SqlValue) => SqlValue) | undefined {
	if (action.setDataType !== undefined) {
		const newLogicalType = inferType(action.setDataType);
		// Alias retype (`varchar(50)` IS TEXT): schema-only, values untouched.
		if (newLogicalType === tableSchema.columns[colIndex].logicalType) return undefined;
		const columnName = tableSchema.columns[colIndex].name;
		return (v) => {
			if (v === null) return v; // retype leaves NULLs untouched, matching the module's conversion
			try {
				return validateAndParse(v, newLogicalType, columnName) as SqlValue;
			} catch {
				// NOTE: the surviving raw value is honest about what the row held, but its
				// JS type no longer matches the column's logical type — the delivered
				// contract is positional (value i belongs to column i), not typed. Only
				// reachable for a superseded intermediate image (e.g. insert 'zzz' →
				// update to '42' → retype to integer delivers oldRow ['zzz']). If a
				// consumer ever type-validates delivered images, revisit: the options are
				// NULL (loses the value) or dropping the image (loses the event).
				return v;
			}
		};
	}
	if (action.setNotNull === true) {
		// SET NOT NULL backfill: null → the folded literal DEFAULT, the same map the
		// module applies. No usable literal default means the module either found no
		// NULLs (nothing to remap) or rejected the ALTER before reaching here.
		const defaultExpr = tableSchema.columns[colIndex].defaultValue;
		const folded = defaultExpr ? tryFoldLiteral(defaultExpr) : undefined;
		if (folded === undefined || folded === null) return undefined;
		return (v) => (v === null ? folded : v);
	}
	return undefined;
}

/**
 * Catalog-only metadata-tag mutations. Tags touch no stored row and no physical
 * layout, so these never call `module.alterTable` — they delegate to the
 * SchemaManager setters, which swap the in-memory schema and fire `table_modified`
 * (so optimizer caches invalidate). This makes SET TAGS succeed even on modules
 * without an `alterTable` hook.
 *
 * NOTE: store-backed modules persist DDL from their own `alterTable`, which this
 * path deliberately bypasses. The generic store module recovers the tag change by
 * subscribing to these `table_modified` events and re-writing its catalog DDL, so
 * table / column / named-constraint tag swaps now survive reconnect for store
 * tables (index and view/MV tag persistence is still pending — see backlog tickets
 * `store-secondary-index-persistence` / `store-view-mv-persistence`).
 */
function runSetTableTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.setTableTags(tableSchema.name, tags, tableSchema.schemaName);
	log('Set tags on table %s.%s', tableSchema.schemaName, tableSchema.name);
	return null;
}

function runSetColumnTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	columnName: string,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.setColumnTags(tableSchema.name, columnName, tags, tableSchema.schemaName);
	log('Set tags on column %s.%s.%s', tableSchema.schemaName, tableSchema.name, columnName);
	return null;
}

function runSetConstraintTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	constraintName: string,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.setConstraintTags(tableSchema.name, constraintName, tags, tableSchema.schemaName);
	log('Set tags on constraint %s.%s.%s', tableSchema.schemaName, tableSchema.name, constraintName);
	return null;
}

// ── ADD TAGS (per-key merge) ──
// Each delegates to the matching SchemaManager merge setter, which reads the
// table's *live* tags at execution time (not the plan-time snapshot), so a
// prepared/reused ADD TAGS or back-to-back ALTERs compose onto the prior result.

function runMergeTableTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.mergeTableTags(tableSchema.name, tags, tableSchema.schemaName);
	log('Merged tags on table %s.%s', tableSchema.schemaName, tableSchema.name);
	return null;
}

function runMergeColumnTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	columnName: string,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.mergeColumnTags(tableSchema.name, columnName, tags, tableSchema.schemaName);
	log('Merged tags on column %s.%s.%s', tableSchema.schemaName, tableSchema.name, columnName);
	return null;
}

function runMergeConstraintTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	constraintName: string,
	tags: Record<string, SqlValue>,
): SqlValue {
	rctx.db.schemaManager.mergeConstraintTags(tableSchema.name, constraintName, tags, tableSchema.schemaName);
	log('Merged tags on constraint %s.%s.%s', tableSchema.schemaName, tableSchema.name, constraintName);
	return null;
}

// ── DROP TAGS (per-key delete) ──
// Each delegates to the matching SchemaManager drop setter, which validates that
// every listed key is present (atomic NOTFOUND) before mutating, again against the
// live tags at execution time.

function runDropTableTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	keys: readonly string[],
): SqlValue {
	rctx.db.schemaManager.dropTableTags(tableSchema.name, keys, tableSchema.schemaName);
	log('Dropped tags on table %s.%s', tableSchema.schemaName, tableSchema.name);
	return null;
}

function runDropColumnTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	columnName: string,
	keys: readonly string[],
): SqlValue {
	rctx.db.schemaManager.dropColumnTags(tableSchema.name, columnName, keys, tableSchema.schemaName);
	log('Dropped tags on column %s.%s.%s', tableSchema.schemaName, tableSchema.name, columnName);
	return null;
}

function runDropConstraintTags(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	constraintName: string,
	keys: readonly string[],
): SqlValue {
	rctx.db.schemaManager.dropConstraintTags(tableSchema.name, constraintName, keys, tableSchema.schemaName);
	log('Dropped tags on constraint %s.%s.%s', tableSchema.schemaName, tableSchema.name, constraintName);
	return null;
}

async function runAlterPrimaryKey(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columns: Array<{ name: string; direction?: 'asc' | 'desc' }>,
): Promise<SqlValue> {
	const newPkDef: PrimaryKeyColumnDefinition[] = columns.map(col => {
		const idx = tableSchema.columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(
				`Column '${col.name}' not found in table '${tableSchema.name}'`,
				StatusCode.ERROR,
			);
		}
		const colSchema = tableSchema.columns[idx];
		if (!colSchema.notNull) {
			throw new QuereusError(
				`Column '${col.name}' must be NOT NULL to participate in PRIMARY KEY`,
				StatusCode.CONSTRAINT,
			);
		}
		return { index: idx, desc: col.direction === 'desc' };
	});

	// Check for duplicate columns
	const seen = new Set<number>();
	for (const pk of newPkDef) {
		if (seen.has(pk.index)) {
			throw new QuereusError(
				`Duplicate column '${tableSchema.columns[pk.index].name}' in PRIMARY KEY definition`,
				StatusCode.ERROR,
			);
		}
		seen.add(pk.index);
	}

	// Try native module re-key first
	const module = requireVtabModule(tableSchema);
	if (module.alterTable) {
		try {
			const schemaChangePk = newPkDef.map(pk => ({ index: pk.index, desc: pk.desc ?? false }));
			const updatedTableSchema = await module.alterTable(
				rctx.db, tableSchema.schemaName, tableSchema.name,
				{ type: 'alterPrimaryKey', newPkColumns: schemaChangePk },
			);
			schema.addTable(updatedTableSchema);
			rctx.db.schemaManager.getChangeNotifier().notifyChange({
				type: 'table_modified',
				schemaName: tableSchema.schemaName,
				objectName: tableSchema.name,
				oldObject: tableSchema,
				newObject: updatedTableSchema,
			});
			log('Altered primary key of %s.%s (native)', tableSchema.schemaName, tableSchema.name);
			return null;
		} catch (e) {
			if (e instanceof QuereusError && e.code === StatusCode.UNSUPPORTED) {
				// Fall through to rebuild
			} else {
				throw e;
			}
		}
	}

	// Rebuild fallback
	await rebuildTableWithNewShape(rctx, tableSchema, schema, tableSchema.columns.map(c => c.name), newPkDef);

	log('Altered primary key of %s.%s (rebuild)', tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * Rebuilds a table with a new column projection and/or primary key.
 * For MemoryTable: builds a new table via the module API and copies rows directly,
 * bypassing SQL execution to avoid transaction-layer isolation issues.
 * For other modules: uses shadow-table SQL approach with DROP+RENAME.
 */
async function rebuildTableWithNewShape(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const module = requireVtabModule(tableSchema);

	if (module instanceof MemoryTableModule) {
		await rebuildMemoryTable(rctx, tableSchema, schema, module, survivingColumns, newPkDef);
	} else {
		await rebuildViaShadowTable(rctx, tableSchema, schema, survivingColumns, newPkDef);
	}

	const finalSchema = schema.getTable(tableName);
	if (finalSchema) {
		rctx.db.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName,
			objectName: tableName,
			oldObject: tableSchema,
			newObject: finalSchema,
		});
	}
}

/**
 * MemoryTable rebuild: builds a new table via module.create() and copies rows
 * directly from the old manager, then swaps in the module and catalog.
 */
async function rebuildMemoryTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	module: MemoryTableModule,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const oldKey = `${schemaName}.${tableName}`.toLowerCase();
	const oldMgr = module.tables.get(oldKey);
	if (!oldMgr) {
		throw new QuereusError(`Table '${tableName}' not found in module`, StatusCode.INTERNAL);
	}

	// Build column index mapping: old column index → new column index
	const survivingIndices: number[] = [];
	const newColumns: import('../../schema/column.js').ColumnSchema[] = [];
	for (const colName of survivingColumns) {
		const oldIdx = tableSchema.columnIndexMap.get(colName.toLowerCase());
		if (oldIdx === undefined) continue;
		survivingIndices.push(oldIdx);
		newColumns.push(tableSchema.columns[oldIdx]);
	}

	// Remap PK indices from old schema to new column order
	const remappedPk: PrimaryKeyColumnDefinition[] = newPkDef.map(pk => {
		const newIdx = survivingIndices.indexOf(pk.index);
		if (newIdx === -1) {
			throw new QuereusError(`PK column index ${pk.index} not in surviving columns`, StatusCode.INTERNAL);
		}
		return { ...pk, index: newIdx };
	});

	// Build new schema
	const newSchema: TableSchema = Object.freeze({
		...tableSchema,
		columns: Object.freeze(newColumns),
		columnIndexMap: buildColumnIndexMap(newColumns),
		primaryKeyDefinition: Object.freeze(remappedPk),
		indexes: Object.freeze([]),
	});

	// Create the new table via the module API (goes directly to base layer)
	const shadowName = `${tableName}__rekey_${Date.now()}`;
	const shadowSchema: TableSchema = Object.freeze({ ...newSchema, name: shadowName });
	await module.create(rctx.db, shadowSchema);
	const shadowMgr = module.tables.get(`${schemaName}.${shadowName}`.toLowerCase());
	if (!shadowMgr) {
		throw new QuereusError(`Shadow table manager not found after create`, StatusCode.INTERNAL);
	}

	try {
		// Copy rows from old table to new, projecting surviving columns
		const rows = oldMgr.scanAllRows();
		for (const oldRow of rows) {
			const newRow = survivingIndices.map(i => oldRow[i]);
			shadowMgr.insertRow(newRow);
		}

		// Swap: remove old, remove shadow, re-register shadow under old name
		module.tables.delete(oldKey);
		module.tables.delete(`${schemaName}.${shadowName}`.toLowerCase());
		shadowMgr.renameTable(tableName);
		module.tables.set(oldKey, shadowMgr);

		// Update catalog
		schema.removeTable(tableName);
		schema.addTable(shadowMgr.tableSchema);

		// The old manager is now orphaned. Any active VirtualTableConnection bound
		// to it (e.g. from a prior insert in this session) is stale and must not be
		// reused against the rebuilt table — a reused-stale + fresh connection pair
		// leaves two candidates registered for the same table name, which trips
		// DeferredConstraintQueue.findConnection at the next commit. Mirror the
		// drop-table path's cleanup (schema/manager.ts dropTable). The orphaned
		// manager and its pending layer are discarded with the old manager, so no
		// rollback is needed; this intentionally bypasses implicit-transaction
		// deferral, exactly as drop table relies on.
		rctx.db.removeConnectionsForTable(schemaName, tableName);
	} catch (e) {
		// Clean up shadow on failure
		try {
			module.tables.delete(`${schemaName}.${shadowName}`.toLowerCase());
		} catch { /* ignore */ }
		throw e;
	}
}

/**
 * Build the shadow-table CREATE TABLE DDL used by the non-memory rebuild path.
 *
 * Nullability is emitted explicitly for every column, matching the "no-db"
 * stance of `generateTableDDL` in ddl-generator.ts: safe under any session's
 * `default_column_nullability` setting. DEFAULT and COLLATE are preserved so
 * the shadow table faithfully mirrors the original schema.
 */
export function buildShadowTableDdl(
	tableSchema: TableSchema,
	shadowName: string,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): string {
	const colDefs: string[] = [];
	for (const colName of survivingColumns) {
		const idx = tableSchema.columnIndexMap.get(colName.toLowerCase());
		if (idx === undefined) continue;
		const col = tableSchema.columns[idx];
		let def = quoteIdentifier(col.name) + ' ' + col.logicalType.name;
		def += col.notNull ? ' not null' : ' null';
		if (col.collation && col.collation !== 'BINARY') def += ` collate ${col.collation}`;
		if (col.defaultValue !== null && col.defaultValue !== undefined) {
			def += ` default ${expressionToString(col.defaultValue)}`;
		}
		colDefs.push(def);
	}

	const pkColNames: string[] = [];
	for (const pk of newPkDef) {
		const colName = tableSchema.columns[pk.index].name;
		let entry = quoteIdentifier(colName);
		if (pk.desc) entry += ' desc';
		pkColNames.push(entry);
	}

	let createDdl = `create table ${qualifyTableName(tableSchema.schemaName, shadowName)} (${colDefs.join(', ')}`;
	createDdl += pkColNames.length > 0
		? `, primary key (${pkColNames.join(', ')}))`
		: `)`;

	if (tableSchema.vtabModuleName) {
		createDdl += ` using ${tableSchema.vtabModuleName}`;
		if (tableSchema.vtabArgs && Object.keys(tableSchema.vtabArgs).length > 0) {
			const args = Object.entries(tableSchema.vtabArgs)
				.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
				.join(', ');
			createDdl += ` (${args})`;
		}
	}

	return createDdl;
}

/**
 * SET MAINTAINED [(cols)] AS <body> — attach a derivation to a plain table, or
 * atomically replace an already-maintained table's derivation (the differ's
 * body-change primitive). All gates, the verify-by-diff reconcile, the
 * catalog/registration flip, the consumer cascade, and the lifecycle event
 * (`materialized_view_added` on fresh attach, `materialized_view_modified` on
 * re-attach) live in the shared {@link attachMaintainedDerivation} core.
 * Resolved against the LIVE table (the build-time schema may be a cached
 * statement's snapshot).
 *
 * The optional `columns` rename list selects the attach mode:
 *  - present ⇒ EXPLICIT: the body outputs are renamed positionally to it, the
 *    list is recorded as `derivation.columns`, and a same-arity name drift
 *    reshapes (renames) the backing in place to the listed names — the differ's
 *    lossless re-attach of an MV-sugar `(a, c)` rename;
 *  - absent ⇒ IMPLICIT: the body's natural names are recorded (undefined), and a
 *    differing derived shape reshapes the backing to follow the body — now also
 *    over a prior-explicit record (the deliberate "go implicit" re-attach).
 * Both pass `allowReshape` (the verb is the reshape-permitting path; create stays
 * strict).
 */
async function runSetMaintained(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columns: ReadonlyArray<string> | undefined,
	select: QueryExpr,
): Promise<SqlValue> {
	const live = schema.getTable(tableSchema.name);
	if (!live) {
		throw new QuereusError(`no such table: ${tableSchema.name}`, StatusCode.ERROR);
	}
	const explicit = columns !== undefined && columns.length > 0;
	// Any omitted-insert defaults ride inside `select` (→ derivation.selectAst).
	await attachMaintainedDerivation(
		rctx.db, live, select,
		/*recordedColumns*/ explicit ? columns : undefined,
		/*positionalRename*/ explicit, /*allowReshape*/ true,
		/*discardBackingOnFailure*/ true,
	);
	log('Attached derivation to table %s.%s', live.schemaName, live.name);
	return null;
}

/**
 * DROP MAINTAINED — detach the table's derivation (see
 * {@link detachMaintainedDerivation}: catalog-only, rows intact, maintenance
 * stops, the table becomes ordinary and user-writable). Allowed on a STALE
 * maintained table too — the flag leaves with the derivation. Resolved against
 * the LIVE table.
 */
async function runDropMaintained(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
): Promise<SqlValue> {
	const live = schema.getTable(tableSchema.name);
	if (!live || !isMaintainedTable(live)) {
		throw new QuereusError(
			`cannot drop maintained on '${tableSchema.name}': it is not a maintained table`,
			StatusCode.ERROR,
		);
	}
	const plain = detachMaintainedDerivation(rctx.db, live);
	// Retire the durable backing store the attach materialized, migrating its
	// rows back into ordinary storage so the detached table stays readable and
	// user-writable. `detachMaintainedDerivation` stays SYNC (catalog-only); the
	// async store retirement rides here, in its sole caller. A no-op for modules
	// that omit the hook (memory detaches catalog-only — one physical storage).
	const module = requireVtabModule(live);
	await module.retireBackingForAttach?.(rctx.db, plain.schemaName, plain.name, plain);
	log('Detached derivation from table %s.%s', live.schemaName, live.name);
	return null;
}

/**
 * Generic rebuild via shadow table SQL for non-memory modules.
 */
async function rebuildViaShadowTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const shadowName = `${tableName}__rekey_${Date.now()}`;
	const qualifiedShadow = qualifyTableName(schemaName, shadowName);
	const qualifiedTable = qualifyTableName(schemaName, tableName);

	const createDdl = buildShadowTableDdl(tableSchema, shadowName, survivingColumns, newPkDef);
	const projection = survivingColumns.map(c => quoteIdentifier(c)).join(', ');

	try {
		await rctx.db._execWithinTransaction(createDdl);
		await rctx.db._execWithinTransaction(
			`insert into ${qualifiedShadow} (${projection}) select ${projection} from ${qualifiedTable}`
		);
		await rctx.db._execWithinTransaction(
			`drop table ${qualifiedTable}`
		);
		await rctx.db._execWithinTransaction(
			`alter table ${qualifiedShadow} rename to ${quoteIdentifier(tableName)}`
		);
	} catch (e) {
		try {
			await rctx.db._execWithinTransaction(
				`drop table if exists ${qualifiedShadow}`
			);
		} catch { /* ignore */ }
		throw e;
	}
}

/**
 * Propagates a table rename into every dependent schema object the catalog
 * knows about: CHECK expressions, FK references, partial-index predicates,
 * view bodies, and materialized-view bodies. Walks every schema (not just the
 * renamed table's home schema) so cross-schema FK references are picked up.
 * View `selectAst` is mutated in place because the planner re-walks it on
 * every reference.
 */
async function propagateTableRename(
	rctx: RuntimeContext,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
	preStaleMvs: ReadonlySet<string>,
): Promise<void> {
	for (const schema of rctx.db.schemaManager._getAllSchemas()) {
		await propagateTableRenameInSchema(rctx.db, schema, renamedSchemaName, oldName, newName, preStaleMvs);
	}
	// After all per-schema rewrites and their cascade events: restore any MV this
	// statement's events marked stale that the rename provably did not affect
	// (e.g. a dependent of another source whose only change was an FK rewrite).
	await restoreUnaffectedMaterializedViews(rctx.db, preStaleMvs);
}

async function propagateTableRenameInSchema(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
	preStaleMvs: ReadonlySet<string>,
): Promise<void> {
	const notifier = db.schemaManager.getChangeNotifier();
	const renamedSchemaLower = renamedSchemaName.toLowerCase();

	for (const table of Array.from(schema.getAllTables())) {
		// Skip the just-renamed table when iterating the home schema; the FK
		// `referencedTable` field on its own FKs (if any self-reference) is
		// still pointing at the old name and needs rewriting too.
		const updated = rewriteTableForTableRename(table, renamedSchemaLower, oldName, newName);
		if (updated !== table) {
			schema.addTable(updated);
			notifier.notifyChange({
				type: 'table_modified',
				schemaName: schema.name,
				objectName: updated.name,
				oldObject: table,
				newObject: updated,
			});
		}
	}

	if (schema.name.toLowerCase() === renamedSchemaLower) {
		for (const view of Array.from(schema.getAllViews())) {
			// The body walk also descends the trailing `with defaults (…)` clause
			// (now stored on `selectAst.defaults`), so a clause-only rewrite — a
			// defaults-expr subquery referencing the renamed table even when the body
			// never names it — flips `bodyChanged` and fires the (single) view_modified.
			const bodyChanged = renameTableInAst(view.selectAst, oldName, newName, renamedSchemaName);
			if (bodyChanged) {
				const updatedView = { ...view, sql: astToString(view.selectAst) };
				schema.addView(updatedView);
				// The rewriter mutated `view.selectAst` (including its defaults clause) in
				// place, so `oldObject` shares the rewritten AST (only `newObject.sql`
				// differs). No consumer reads `oldObject.selectAst`; mirrors the table
				// loop above (no clone).
				notifier.notifyChange({
					type: 'view_modified',
					schemaName: schema.name,
					objectName: updatedView.name,
					oldObject: view,
					newObject: updatedView,
				});
			}
		}

		// Materialized views: same in-place body rewrite as plain views ("MV ≡
		// faster view"), plus the derived-field re-key, row-time re-registration,
		// and staleness discipline the MV record needs. Runs AFTER the view loop
		// so a body reading the renamed table through a view re-plans against the
		// already-rewritten view.
		await propagateTableRenameToMaterializedViews(db, schema, renamedSchemaName, oldName, newName, preStaleMvs);
	}
}

function rewriteTableForTableRename(
	table: TableSchema,
	renamedSchemaLower: string,
	oldName: string,
	newName: string,
): TableSchema {
	const oldLower = oldName.toLowerCase();
	let changed = false;

	const newChecks = table.checkConstraints.map(cc => {
		const rewrote = renameTableInAst(cc.expr, oldName, newName, renamedSchemaLower);
		if (!rewrote) return cc;
		changed = true;
		return { ...cc };
	});

	const newFks = (table.foreignKeys ?? []).map(fk => {
		const fkSchemaLower = (fk.referencedSchema ?? table.schemaName).toLowerCase();
		if (fkSchemaLower !== renamedSchemaLower) return fk;
		if (fk.referencedTable.toLowerCase() !== oldLower) return fk;
		changed = true;
		return { ...fk, referencedTable: newName };
	});

	// Partial-index predicates: the AST is mutated in place, so the derived
	// UNIQUE constraint of a unique partial index (which shares the predicate
	// by reference — see appendIndexToTableSchema) is rewritten with it.
	const newIndexes = (table.indexes ?? []).map(idx => {
		const rewrote = renameTableInAst(idx.predicate, oldName, newName, renamedSchemaLower);
		if (!rewrote) return idx;
		changed = true;
		return { ...idx };
	});

	if (!changed) return table;

	return Object.freeze({
		...table,
		checkConstraints: Object.freeze(newChecks),
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
		indexes: table.indexes ? Object.freeze(newIndexes) : table.indexes,
	});
}

/**
 * The catalog-backed {@link ResolveColumnInSource} the column-rename rewriters consult
 * to keep their unqualified-reference walk scope-aware. Built once per statement and
 * shared by the pre-flight probe in {@link runRenameColumn} and the real propagation
 * below, so the two cannot drift apart. Note it resolves against the LIVE catalog on
 * every call, so sharing it does not by itself freeze the answer between the two passes
 * — see the pre-flight's comment for why they agree anyway.
 */
function buildColumnSourceResolver(db: Database): ResolveColumnInSource {
	return (s, t, col) => {
		const targetSchema = db.schemaManager.getSchema(s);
		const targetTable = targetSchema?.getTable(t);
		return targetTable?.columnIndexMap.has(col.toLowerCase()) ?? false;
	};
}

async function propagateColumnRename(
	rctx: RuntimeContext,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	preStaleMvs: ReadonlySet<string>,
	resolveColumnInSource: ResolveColumnInSource,
): Promise<void> {
	const schemaManager = rctx.db.schemaManager;
	for (const schema of schemaManager._getAllSchemas()) {
		await propagateColumnRenameInSchema(rctx.db, schema, renamedSchemaName, tableName, oldCol, newCol, resolveColumnInSource, preStaleMvs);
	}
	// After all per-schema rewrites and their cascade events: restore any MV this
	// statement's events marked stale that the rename provably did not affect — a
	// body that never names the renamed column, or a `select *` body whose output
	// is a pure name shift (carried onto the live backing by the pass).
	await restoreUnaffectedMaterializedViews(rctx.db, preStaleMvs);
}

async function propagateColumnRenameInSchema(
	db: Database,
	schema: Schema,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolveColumnInSource: ResolveColumnInSource,
	preStaleMvs: ReadonlySet<string>,
): Promise<void> {
	const notifier = db.schemaManager.getChangeNotifier();
	const renamedSchemaLower = renamedSchemaName.toLowerCase();

	for (const table of Array.from(schema.getAllTables())) {
		const updated = rewriteTableForColumnRename(table, renamedSchemaLower, tableName, oldCol, newCol, resolveColumnInSource);
		if (updated !== table) {
			schema.addTable(updated);
			notifier.notifyChange({
				type: 'table_modified',
				schemaName: schema.name,
				objectName: updated.name,
				oldObject: table,
				newObject: updated,
			});
		}
	}

	if (schema.name.toLowerCase() === renamedSchemaLower) {
		for (const view of Array.from(schema.getAllViews())) {
			// The body walk also descends the trailing `with defaults (…)` clause (now
			// on `selectAst.defaults`): the entry `column` (a base column of the view's
			// FROM table, usually projected away) rewrites via the same scope-aware
			// synthetic probe as a `with inverse` target, and the entry exprs rewrite in
			// the FROM frame — so a clause-only change flips `bodyChanged`. The live
			// `resolveColumnInSource` keeps the walk scope-aware so an unqualified ref
			// inside a defaults-expr subquery that binds a like-named column on its own
			// FROM is not false-captured (the differ's inverse reconcile passes the
			// declared-side resolver for parity).
			const bodyChanged = renameColumnInAst(view.selectAst, tableName, oldCol, newCol, renamedSchemaName, resolveColumnInSource);
			if (bodyChanged) {
				const updatedView = { ...view, sql: astToString(view.selectAst) };
				schema.addView(updatedView);
				// The rewriter mutated `view.selectAst` (including its defaults clause) in
				// place, so `oldObject` shares the rewritten AST (only `sql` differs). No
				// consumer reads `oldObject.selectAst`; mirrors the table loop above (no clone).
				notifier.notifyChange({
					type: 'view_modified',
					schemaName: schema.name,
					objectName: updatedView.name,
					oldObject: view,
					newObject: updatedView,
				});
			}
		}

		// Materialized views: same in-place body rewrite as plain views, then the
		// MV-specific tail — backing-column rename for a shifted output name,
		// row-time re-registration, staleness discipline (the listener marked every
		// dependent MV stale during the rename's notify; only statement-local
		// staleness is cleared, per the pre-statement snapshot).
		await propagateColumnRenameToMaterializedViews(db, schema, renamedSchemaName, tableName, oldCol, newCol, preStaleMvs, resolveColumnInSource);
	}
}

function rewriteTableForColumnRename(
	table: TableSchema,
	renamedSchemaLower: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolveColumnInSource: ResolveColumnInSource,
): TableSchema {
	const oldColLower = oldCol.toLowerCase();
	const tableLower = tableName.toLowerCase();
	const isRenamedTable =
		table.schemaName.toLowerCase() === renamedSchemaLower &&
		table.name.toLowerCase() === tableLower;
	let changed = false;

	const newChecks = table.checkConstraints.map(cc => {
		const rewrote = isRenamedTable
			? renameColumnInCheckExpression(cc.expr, tableName, oldCol, newCol, renamedSchemaLower, resolveColumnInSource)
			: renameColumnInAst(cc.expr, tableName, oldCol, newCol, renamedSchemaLower);
		if (!rewrote) return cc;
		changed = true;
		return { ...cc };
	});

	const newFks = (table.foreignKeys ?? []).map(fk => {
		const fkSchemaLower = (fk.referencedSchema ?? table.schemaName).toLowerCase();
		if (fkSchemaLower !== renamedSchemaLower) return fk;
		if (fk.referencedTable.toLowerCase() !== tableLower) return fk;
		if (!fk.referencedColumnNames || fk.referencedColumnNames.length === 0) return fk;
		let touched = false;
		const newRefNames = fk.referencedColumnNames.map(n => {
			if (n.toLowerCase() === oldColLower) {
				touched = true;
				return newCol;
			}
			return n;
		});
		if (!touched) return fk;
		changed = true;
		return { ...fk, referencedColumnNames: Object.freeze(newRefNames) };
	});

	// Partial-index predicates resolve unqualified refs against the indexed
	// table, the same implicit seed CHECK expressions use. As with checks, the
	// AST is mutated in place, so the derived UNIQUE constraint of a unique
	// partial index (sharing the predicate by reference) is rewritten with it.
	//
	// This pass is the only predicate rewrite for the schema-only fallback branch of
	// `runRenameColumn` (a module with no `alterTable` hook), and for any hook module
	// that does not rewrite predicates itself.
	//
	// The memory and store modules both DO rewrite, from inside their own hook, because
	// each must act on the predicate before this pass regains control: the memory module
	// rebuilds its live index structures against the new column list, and the store
	// module persists its DDL bundle (which is also why the store rewrites the CHECK
	// expressions above, via `renameColumnInCheckConstraints`). Both use the same
	// idempotent `renameColumnInIndexPredicates`, so this pass then finds nothing naming
	// `oldCol`, `rewrote` is false, and the table is not needlessly re-registered.
	const newIndexes = (table.indexes ?? []).map(idx => {
		const rewrote = isRenamedTable
			? renameColumnInCheckExpression(idx.predicate, tableName, oldCol, newCol, renamedSchemaLower, resolveColumnInSource)
			: renameColumnInAst(idx.predicate, tableName, oldCol, newCol, renamedSchemaLower);
		if (!rewrote) return idx;
		changed = true;
		return { ...idx };
	});

	if (!changed) return table;

	return Object.freeze({
		...table,
		checkConstraints: Object.freeze(newChecks),
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
		indexes: table.indexes ? Object.freeze(newIndexes) : table.indexes,
	});
}

/**
 * Build a minimal constraints array from an existing ColumnSchema
 * so that the ColumnDef AST accurately represents the column.
 */
function buildConstraintsFromColumn(col: import('../../schema/column.js').ColumnSchema): ColumnDef['constraints'] {
	const constraints: ColumnDef['constraints'] = [];
	if (col.notNull) {
		constraints.push({ type: 'notNull' });
	} else {
		constraints.push({ type: 'null' });
	}
	if (col.primaryKey) {
		constraints.push({ type: 'primaryKey', direction: col.pkDirection });
	}
	if (col.defaultValue) {
		constraints.push({ type: 'default', expr: col.defaultValue });
	}
	if (col.collation && col.collation !== 'BINARY') {
		constraints.push({ type: 'collate', collation: col.collation });
	}
	if (col.generated) {
		constraints.push({
			type: 'generated',
			generated: col.generatedExpr ? { expr: col.generatedExpr, stored: col.generatedStored ?? false } : undefined
		});
	}
	return constraints;
}
