import type { AlterTableNode, AddColumnBackfill, AddColumnCheck } from '../../planner/nodes/alter-table-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { createRowSlot } from '../context-helpers.js';
import { QuereusError, RelationNotFoundError } from '../../common/errors.js';
import { type SqlValue, type Row, type SubProgram, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../schema/table.js';
import { buildColumnIndexMap, withGeneratedColumnGraph, requireVtabModule, resolveNamedConstraintClass, namedConstraintExists, assertConstraintNameFree, validateCollationForType, columnDefToSchema, collectTableConstraintNames, collectDeclaredConstraintNames } from '../../schema/table.js';
import { validateForeignKeyCollations, buildForeignKeyConstraintSchema, extractColumnLevelCheckConstraints, extractColumnLevelForeignKeys, extractColumnLevelUniqueConstraints } from '../../schema/constraint-builder.js';
import type * as AST from '../../parser/ast.js';
import type { ColumnDef, Expression, QueryExpr } from '../../parser/ast.js';
import { quoteIdentifier, expressionToString, astToString } from '../../emit/ast-stringify.js';
import { renameTableInAst, renameColumnInAst, renameColumnInCheckExpression, renameColumnInColumnExpressions, renameTableInCheckConstraints, renameTableInIndexPredicates, renameTableInColumnExpressions, objectRefKey } from '../../schema/rename-rewriter.js';
import type { ResolveColumnInSource, ResolveObjectRef, TableRenameTarget } from '../../schema/rename-rewriter.js';
import { snapshotObjectRefResolvers, tableRenameTargetsFor, type ObjectRefResolvers } from '../../schema/object-ref-resolver.js';
import type { ColumnSchema } from '../../schema/column.js';
import { assertCatalogObjectPersistable, assertRenameDependentsPersistable } from '../../schema/catalog-persistability.js';
import { assertUniqueConstraintIndexNameFree, assertUniqueConstraintNotDuplicated, assertUniqueConstraintBackingNamesDistinct, uniqueConstraintColumnSetKey, type DeclaredUniqueConstraint } from '../../schema/catalog.js';
import type { Schema } from '../../schema/schema.js';
import type { Database } from '../../core/database.js';
import { isTruthy } from '../../util/comparison.js';
import { assertDdlTransactionPolicy, isExplicitTransactionOpen } from './ddl-transaction-policy.js';
import { buildColumnSourceResolver } from '../../schema/column-source-resolver.js';
import { assertNoColumnExpressionNamesColumn, assertNoCheckConstraintNamesColumn, assertNoAssertionNamesColumn, assertNoForeignKeyReferencesColumn } from './drop-column-guards.js';
import { emitAlterSchemaEvent, withStatementScopedSchemaEvents } from './alter-schema-event.js';
import { foldDefaultToType, validateAndParse } from '../../types/validation.js';
import {
	snapshotStaleMaterializedViews,
	propagateTableRenameToMaterializedViews,
	propagateColumnRenameToMaterializedViews,
	restoreUnaffectedMaterializedViews,
	attachMaintainedDerivation,
	detachMaintainedDerivation,
} from './materialized-view-helpers.js';
import {
	propagateTableRenameToAssertions,
	propagateColumnRenameToAssertions,
} from './assertion-rename-helpers.js';
import { assertColumnRenameCascadePublishable, runColumnRenameCascade } from './column-rename-cascade.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { inferType } from '../../types/registry.js';

const log = createLogger('runtime:emit:alter-table');
const warnLog = log.extend('warn');

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

	// An ADD COLUMN with a per-row value source — a non-foldable DEFAULT, or a GENERATED
	// ALWAYS AS expression — carries a backfill scalar; emit it as a scheduled sub-program
	// so the scheduler resolves it into a callback the run() body evaluates per existing row
	// (via a row slot over the backfill's row descriptor). When the new column also carries a
	// CHECK, its predicates ride alongside as further callbacks, evaluated per backfilled row
	// against `[...existingRow, backfilledValue]`. Slot order is fixed: backfill first
	// (present whenever checks are), then the checks in order — this MUST match
	// `AlterTableNode.addColumnExpressions()` (planner/nodes/alter-table-node.ts), which is
	// the order the optimizer rewrites these children in via getChildren/withChildren.
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

		// Every arm runs under the statement-scoped schema-event scope: an arm that fails
		// after the module call has already let an emitter-backed module announce the
		// statement (it emits from inside `module.alterTable`, not at the statement's end),
		// so the failure path must retract that announcement. See
		// {@link withStatementScopedSchemaEvents} for why this sits at the statement
		// boundary rather than inside any one arm's revert.
		return withStatementScopedSchemaEvents(rctx, async () => {
			switch (action.type) {
				case 'renameTable':
					return runRenameTable(rctx, tableSchema, schema, action.newName, plan.sql);
				case 'renameColumn':
					return runRenameColumn(rctx, tableSchema, schema, action.oldName, action.newName, plan.sql);
				case 'addColumn': {
					// Slot order set in `params`: backfill callback first (if any), then check callbacks.
					const backfillCb = backfill ? (args[0] as SubProgram) : undefined;
					const checkCbs = (args.slice(backfill ? 1 : 0) as SubProgram[]);
					return runAddColumn(rctx, tableSchema, schema, action.column, plan.sql, backfill, backfillCb, checks, checkCbs);
				}
				case 'dropColumn':
					return runDropColumn(rctx, tableSchema, schema, action.name, plan.sql);
				case 'dropConstraint':
					return runDropConstraint(rctx, tableSchema, schema, action.name, plan.sql);
				case 'renameConstraint':
					return runRenameConstraint(rctx, tableSchema, schema, action.oldName, action.newName, plan.sql);
				case 'alterPrimaryKey':
					return runAlterPrimaryKey(rctx, tableSchema, schema, action.columns, plan.sql);
				case 'alterColumn':
					return runAlterColumn(rctx, tableSchema, schema, action, plan.sql);
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
		});
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
	sql: string,
): Promise<SqlValue> {
	const oldName = tableSchema.name;

	// Check for name conflict
	if (schema.getTable(newName)) {
		throw new QuereusError(`Table '${newName}' already exists`, StatusCode.ERROR);
	}

	// Reference resolution for every walk this statement runs, snapshotted BEFORE
	// the first side effect: the propagation below rewrites dependents after the
	// catalog swap, and each reference must resolve the way its body PLANNED —
	// against the pre-rename catalog — or a bare `t` would fall through to a
	// same-named table further down the schema path once `main.t` is gone.
	// `targetFor` pairs that pre-mutation resolution with its post-rename sibling
	// snapshot, per body-owning home schema, so every rewrite can hold its
	// post-condition (a rewritten reference still resolves to the renamed table,
	// schema-qualifying when the bare new name would otherwise re-bind).
	const objectResolvers = snapshotObjectRefResolvers(rctx.db);
	const targetFor = tableRenameTargetsFor(objectResolvers, tableSchema.schemaName, oldName, newName);

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
	assertRenameDependentsPersistable(rctx.db,
		home => ast => renameTableInAst(ast, targetFor(home)),
		t => rewriteTableForTableRename(t, targetFor));

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
		// `sql` marks this call as the statement's own action: an emitter-backed module
		// emits its schema-change event iff it is present (see VirtualTableModule.renameTable).
		await module.renameTable(rctx.db, tableSchema.schemaName, oldName, newName, sql);
	}

	// Events this transaction already recorded still carry the OLD name; relabel them so
	// the commit delivers every event under the name the table has at delivery. AFTER the
	// module call (a module failure must leave the batch as untouched as the catalog, and
	// the store's `ddlCommitPendingOps` flushes its queued events into our batch DURING
	// that call — those must be in the batch before we walk it), BEFORE the catalog swap,
	// matching where the other ALTER arms call `remapBatchedDataEvents`.
	//
	// NOTE: batched SCHEMA events are deliberately out of scope here. A schema event
	// records a DDL operation, not current state — each now carries the statement's own
	// canonical `ddl` text (and, for a rename, `oldObjectName`), so relabelling
	// `objectName` without rewriting that text would produce an incoherent instruction.
	// A consumer replays the schema events in order; the rename is one of them, carrying
	// this very statement's SQL, so earlier events legitimately name the old table.
	rctx.db._getEventEmitter().renameBatchedEvents(tableSchema.schemaName, oldName, newName);

	// Deferred constraint checks this transaction already parked carry evaluators compiled
	// against the OLD name — their scan leaves would connect to a table that no longer
	// exists (or, on a store backend, to an empty one, yielding a FALSE violation). Tell
	// the queue so it re-points those entries and moves the bucket keyed by the table name.
	// Same placement rationale as the event relabel above.
	rctx.db.getDeferredConstraints().notifyTableRename(tableSchema.schemaName, oldName, newName);

	// The renamed table's own definition can name itself: a self-referencing FK's
	// `referencedTable`, a table-qualified CHECK expression, a table-qualified
	// partial-index predicate. Rewrite those BEFORE the catalog swap and the notify
	// below, so no listener ever observes — or persists — a schema pointing at the
	// vanished old name. `propagateTableRename` runs the same rewrite over every
	// table in the catalog, but only after the notify; it is idempotent, so this
	// call simply makes that pass a no-op for this one table.
	const renamedTableSchema = rewriteTableForTableRename(updatedTableSchema, targetFor);

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
	await propagateTableRename(rctx, preStaleMvs, targetFor);

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

	// The public schema-change event, for a module with no emitter of its own — see
	// {@link emitAlterSchemaEvent} for why every arm emits at its tail rather than
	// alongside the module call. `objectName` is the NEW table; `oldObjectName` says
	// what it renamed FROM, so a receiver can tell which of its tables the event is about.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: newName,
		oldObjectName: oldName,
		ddl: sql,
	});

	log('Renamed table %s.%s to %s', tableSchema.schemaName, oldName, newName);
	return null;
}

async function runRenameColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	oldName: string,
	newName: string,
	sql: string,
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
	// body of every dependent view / materialized view — and the rewritten record of
	// every dependent table (its CHECK expressions, the referenced-column list of an FK
	// pointing here, its partial-index predicates) — must still be persistable, on the
	// same unfailable-propagation reasoning as the table-rename arm above. Shares one
	// resolver with `propagateColumnRename` so the two passes cannot drift apart in
	// code; what makes them agree at RUNTIME (the resolver reads the LIVE catalog, and
	// this probe runs pre-mutation while the propagation runs post-) is that
	// `unqualifiedRefBindsTarget` skips the renamed table itself and probes only OTHER
	// sources, whose column sets this rename does not touch.
	const resolveColumnInSource = buildColumnSourceResolver(rctx.db);
	// Reference-resolution snapshot, BEFORE the first side effect — same discipline
	// (and same reasoning) as the table-rename arm above.
	const objectResolvers = snapshotObjectRefResolvers(rctx.db);
	const renamedTableKey = objectRefKey(tableSchema.schemaName, tableSchema.name);
	assertRenameDependentsPersistable(rctx.db,
		// Row-image mode 'none': the probed bodies are view / MV bodies — relations
		// with no written row (their `with inverse` / `with defaults` subtrees
		// self-suppress inside the walker).
		home => ast => renameColumnInAst(
			ast, tableSchema.name, oldName, newName,
			objectResolvers.forHomeSchema(home), renamedTableKey, 'none', resolveColumnInSource),
		t => rewriteTableForColumnRename(
			t, tableSchema.name, oldName, newName, objectResolvers, renamedTableKey, resolveColumnInSource));

	// Pre-flight the CASCADE, still before the first side effect: a dependent view /
	// materialized view whose published names the rename would shift must not end up
	// publishing two columns of the new name (its own `newName` plus the shifted
	// passthrough). The live cascade rewrites bodies in place with no rollback, so
	// the refusal has to land here, while the statement is still a clean no-op.
	assertColumnRenameCascadePublishable(rctx.db,
		{ targetKey: renamedTableKey, tableName: tableSchema.name },
		oldName, newName, objectResolvers, resolveColumnInSource);

	assertRenamedColumnBackingNamesFree(tableSchema, colIndex, oldName, newName);

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
			ddl: sql,
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
	await propagateColumnRename(rctx, tableSchema.name, oldName, newName, preStaleMvs,
		objectResolvers, renamedTableKey, resolveColumnInSource);

	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'column',
		objectName: tableSchema.name,
		columnName: newName,
		oldColumnName: oldName,
		ddl: sql,
	});

	log('Renamed column %s.%s.%s to %s', tableSchema.schemaName, tableSchema.name, oldName, newName);
	return null;
}

/**
 * Refuses a RENAME COLUMN that would move an unnamed UNIQUE constraint's backing
 * structure onto a name an index on the same table already holds.
 *
 * An unnamed UNIQUE is enforced by a structure named `_uc_<covered column names>`,
 * derived from the LIVE column names and never recorded — so renaming a covered
 * column moves that name. This is the same collision the four declaration paths
 * already refuse (ADD CONSTRAINT, ADD COLUMN … unique, RENAME CONSTRAINT, and
 * `SchemaManager.createIndex` from the index side), reached through a rename instead
 * of a declaration. Left unguarded the user's index is silently reclassified as a
 * hidden backing structure: it vanishes from `schema()` / `index_info()`, `DROP INDEX`
 * answers `no such index`, and store-backed its `CREATE INDEX` line is dropped from
 * the persisted catalog entry — after which the constraint's entries are built into
 * that index's store and, on reopen, it stops rejecting duplicates.
 *
 * Placed before `module.alterTable` for the same reason those paths are: the store's
 * `alterTable` persists, so a later throw would leave the damage on disk.
 *
 * Skips a case-only rename entirely: the derived name folds to the constraint's OWN
 * pre-rename structure, which the memory backend materializes as a real index entry
 * and the name-only guard would otherwise read as a collision (the same reason
 * `runRenameConstraint` gates its check on `oldLower !== newLower`).
 *
 * Named and `derivedFromIndex` constraints are unaffected — neither takes a derived
 * name. Two DIFFERENT unnamed constraints deriving one post-rename name is only
 * reachable through duplicate unnamed UNIQUEs and is not this guard's problem.
 *
 * NOTE: name-only, like the declaration guards, so it also refuses the rename when the
 * constraint is realized by a REUSED same-column-set index and therefore has no
 * `_uc_*` structure to move — a legal rename turned away over a name nothing would
 * have claimed. Deliberate: both backends decide reuse internally and at different
 * times, so a reuse-aware check would make them disagree on which renames are legal.
 * The refusal names both objects and is escapable by renaming the index first. If the
 * false refusal ever bites, gate the check on the constraint actually holding a
 * `_uc_*` structure — which means asking the module, not just `tableSchema.indexes`.
 */
function assertRenamedColumnBackingNamesFree(
	tableSchema: TableSchema,
	colIndex: number,
	oldName: string,
	newName: string,
): void {
	if (oldName.toLowerCase() === newName.toLowerCase()) return;
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.name !== undefined || uc.derivedFromIndex !== undefined) continue;
		if (!uc.columns.includes(colIndex)) continue;
		const postRenameColumns = uc.columns.map(i =>
			i === colIndex ? newName : (tableSchema.columns[i]?.name ?? String(i)));
		assertUniqueConstraintIndexNameFree(
			tableSchema,
			undefined,
			postRenameColumns,
			`rename column '${oldName}' to '${newName}' on table '${tableSchema.name}'`,
		);
	}
}

/**
 * Refuses an inline constraint on a new column whose *user-written* name is already taken —
 * by a constraint on the table, or by an earlier inline constraint in the same ADD COLUMN
 * (neither is on `tableSchema` yet). Same within-table rule ADD CONSTRAINT and RENAME
 * CONSTRAINT enforce; see {@link assertConstraintNameFree} for the ordering constraints.
 *
 * Reads the RAW declaration rather than the extracted table constraints: the extractors
 * auto-name an unnamed CHECK `_check_<column>`, and that synthesized name is not user
 * identity — comparing it would refuse two unnamed CHECKs on one new column, which is
 * legal. Only the three classes that occupy a named-constraint array are compared (a name
 * on an inline NOT NULL / DEFAULT / PRIMARY KEY is not stored, so it cannot collide).
 */
function assertInlineConstraintNamesFree(tableSchema: TableSchema, columnDef: ColumnDef): void {
	const seen = new Set<string>();
	for (const declared of columnDef.constraints) {
		if (!declared.name) continue;
		if (declared.type !== 'check' && declared.type !== 'unique' && declared.type !== 'foreignKey') continue;
		assertConstraintNameFree(tableSchema, declared.name, seen);
		seen.add(declared.name.toLowerCase());
	}
}

async function runAddColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columnDef: ColumnDef,
	sql: string,
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
	// A GENERATED ALWAYS AS expression takes the same `backfill` route (always, since a
	// generated column has no `defaultValue` any module could bulk-write), validated at
	// plan-build with the generated-flavoured determinism check.
	const defaultConstraint = columnDef.constraints?.find(c => c.type === 'default');
	// Folded literal default, converted to the new column's declared type — the value a
	// fresh INSERT under the same DEFAULT would store, and the same value each module
	// folds for its own rows. Undefined when there is no default (a generated column
	// included) or it does not fold — those carry `backfill` instead. Used by the NOT NULL
	// gate below and by the batched-event remap's backfill value. An unconvertible literal
	// (`integer default 'abc'`) throws MISMATCH here, before anything is mutated.
	const foldedDefault = foldDefaultToType(defaultConstraint?.expr, inferType(columnDef.dataType), columnDef.name);

	// Call module.alterTable for data + schema update
	const module = requireVtabModule(tableSchema);
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE ADD COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	// NOT NULL without a usable value source cannot backfill existing rows. A DEFAULT whose
	// folded value is NULL is equivalent to "no DEFAULT" for this purpose. A per-row source
	// (carried in `backfill` — a non-foldable expression default or a GENERATED ALWAYS AS
	// expression) IS usable: its NOT NULL enforcement is deferred to the module's per-row
	// backfill, which rejects the ALTER if any row evaluates to NULL. If the table is
	// non-empty and there is no usable source, reject before mutating any schema or data.
	//
	// Mandatoriness is RESOLVED, not read off the statement text: a column is NOT NULL
	// either by an explicit `not null` or by the session `default_column_nullability`
	// (which ships as `not_null`), so `add column x text default null` is a mandatory
	// column with no value for the existing rows and must be refused. `columnDefToSchema`
	// is the same resolver the memory module, the store module and the isolation layer's
	// `deriveAddColumnBackfill` use, so a fourth spelling of the rule cannot drift. It
	// also validates an explicit COLLATE and rejects DEFAULT + GENERATED ALWAYS AS on one
	// column — both previously raised by the module mid-work, now pre-mutation.
	//
	// A module may opt out of this engine-generic rejection via the
	// `delegatesNotNullBackfill` capability (structurally-total modules that
	// carry pre-existing rows forward and enforce NOT NULL at write time). When
	// it declares the capability, the decision is left entirely to its
	// `alterTable`. Native modules leave it off, so this still fires for them.
	const delegatesBackfill = module.getCapabilities?.().delegatesNotNullBackfill === true;
	const defaultNotNull = rctx.db.options.getStringOption('default_column_nullability') === 'not_null';
	const resolvedNotNull = columnDefToSchema(
		columnDef,
		defaultNotNull,
		rctx.db.options.getStringOption('default_collation'),
		(n) => rctx.db.isCollationRegistered(n),
	).notNull;
	if (resolvedNotNull && !delegatesBackfill && !backfill) {
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
	//
	// The CHECK mint disambiguates against the table's existing constraint names
	// plus this column's user-written inline names, so two unnamed CHECKs on the
	// new column (legal — see assertInlineConstraintNamesFree below) mint
	// `_check_<col>` / `_check_<col>_2` exactly as the CREATE TABLE spelling does,
	// and a re-added `_check_<col>` never collides with one already on the table.
	const inlineTakenNames = collectTableConstraintNames(tableSchema);
	for (const declared of collectDeclaredConstraintNames([columnDef], undefined)) inlineTakenNames.add(declared);
	const inlineChecks = extractColumnLevelCheckConstraints(columnDef, inlineTakenNames);
	const inlineConstraints: AST.TableConstraint[] = [
		...extractColumnLevelUniqueConstraints(columnDef),
		...inlineChecks,
		...extractColumnLevelForeignKeys(columnDef),
	];

	// Refused before the column is materialized, so a duplicate name leaves the table
	// completely untouched rather than relying on the revert path.
	assertInlineConstraintNamesFree(tableSchema, columnDef);

	// An inline `unique` builds an implicit backing structure named after the constraint
	// — or `_uc_<column>` when unnamed — so reject before the column is materialized when
	// that name is already an index on this table, or when the declaration merely repeats
	// a UNIQUE the table already carries. The column does not exist yet, so both tests run
	// off the column definition's own name (which is exactly what
	// `extractColumnLevelUniqueConstraints` put in `columns`). Placed here, ahead of
	// `module.alterTable`, so a refused statement leaves the table completely untouched
	// rather than relying on the revert path.
	//
	// Duplicate-first, index-name-second — see the ordering rationale in
	// `runAddConstraintViaModule`. `declaredColumnSets` carries the unnamed sets claimed by
	// earlier inline constraints in THIS statement (`add column c … unique unique`); none
	// of them is on `tableSchema` yet, so the guard cannot see them any other way.
	const inlineUniques: DeclaredUniqueConstraint[] = inlineConstraints
		.filter(c => c.type === 'unique')
		.map(c => ({ name: c.name, columnNames: (c.columns ?? []).map(col => col.name) }));
	const declaredColumnSets = new Set<string>();
	for (const uc of inlineUniques) {
		const operation = `add ${uc.name ? `constraint '${uc.name}'` : 'UNIQUE'} column '${columnDef.name}' to table '${tableSchema.name}'`;
		assertUniqueConstraintNotDuplicated(tableSchema, uc.name, uc.columnNames, operation, declaredColumnSets);
		assertUniqueConstraintIndexNameFree(tableSchema, uc.name, uc.columnNames, operation);
		if (uc.name === undefined) declaredColumnSets.add(uniqueConstraintColumnSetKey(uc.columnNames));
	}

	// Two inline `unique` constraints on the SAME new column can also derive one backing
	// structure name without duplicating each other (`add column c text constraint _uc_c
	// unique unique` — a name and an auto-name that coincide). Neither is on `tableSchema`
	// yet, so the per-constraint guard above cannot see the pair; this compares them against
	// each other. After the loop, so a plain duplicate still reports as a duplicate.
	assertUniqueConstraintBackingNamesDistinct(
		inlineUniques,
		`add column '${columnDef.name}' to table '${tableSchema.name}'`,
	);

	// A per-row backfill derives each existing row's value from that row. Install a row slot
	// over the backfill's row descriptor; the evaluator the module calls per existing row
	// sets the slot to that row, so the expression's `new.<col>` refs (and the bare `<col>`
	// refs a GENERATED ALWAYS AS expression uses) resolve to it.
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
			const evaluated = (valueRaw instanceof Promise ? await valueRaw : valueRaw) as SqlValue;
			// Convert to the new column's declared type BEFORE the CHECK predicates see it,
			// matching the write path (`emitInsert` coerces at the top of the DML pipeline, so
			// constraint checking and storage both see the declared form). `coerceTo` is unset
			// when the expression's static type already IS the column's type — see
			// `AddColumnBackfill.coerceTo` for why re-converting there would be destructive.
			const value = backfill.coerceTo
				? validateAndParse(evaluated, backfill.coerceTo, columnDef.name)
				: evaluated;
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
		// `ddl` marks this call — and only this one — as the statement's own action: the
		// inline-constraint installs below and any revert calls pass none, so an
		// emitter-backed module announces exactly ONE event for the whole statement.
		//
		// That marker settles HOW MANY events a successful statement announces, not whether a
		// failed one announces any: this call is not the end of the statement, so a failure in
		// the inline-constraint installs below leaves this announcement already batched. The
		// statement-scoped retraction wrapped around the whole arm dispatch is what removes it.
		updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
			type: 'addColumn',
			columnDef,
			backfillEvaluator,
			ddl: sql,
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
		// path only. A per-row (evaluator) backfill — non-foldable DEFAULT or GENERATED
		// ALWAYS AS — already enforced its CHECKs inside the backfill hook above, against the
		// freshly-computed value rather than this scan's stale pre-backfill snapshot, and the
		// module enforces NOT NULL there too. Runs
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
			// Deliberately NO `ddl`: this is an engine-internal sub-step of the ADD COLUMN
			// statement, so an emitter-backed module must announce nothing for it — the
			// statement's one event rode the `addColumn` call above.
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

	// ONE event for the whole statement, even when the column declared inline constraints.
	// The install loop above makes a second `module.alterTable(addConstraint)` round-trip per
	// inline constraint; an emitter-backed module now agrees on one event too, because only
	// the `addColumn` call carried `ddl` and a module emits iff it is set. Do not "fix"
	// this into per-constraint events on either path.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'column',
		objectName: tableSchema.name,
		columnName: columnDef.name,
		ddl: sql,
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
 * Every module call here passes no `ddl`, deliberately: an emitter-backed module emits only
 * for a call carrying `ddl`, so the unwinding itself announces nothing. That is the SECOND
 * line of defence, not the only one — the failed statement's own `addColumn` call DID carry
 * `ddl`, and an emitter-backed module already batched an event for it before we got here.
 * What actually keeps a failed ADD COLUMN silent is the statement-scoped retraction the whole
 * arm dispatch runs under (`withStatementScopedSchemaEvents` in `emitAlterTable`'s `run()`),
 * which drops that event as the error propagates.
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
		// The CHECK is SCHEMA-AUTHORED: it belongs to the altered table's own DDL, so a
		// bare relation name inside it means the ALTERED table's schema — not the session
		// path this freshly-prepared validation statement would otherwise inherit. Owning
		// schema ONLY, matching `schemaAuthoredContext` (planner/building/schema-authored-context.ts),
		// which decides the same thing for every CHECK the DML builders compile.
		stmt._schemaPathOverride = [columnOnlySchema.schemaName];
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
 * Rejects ADD COLUMN ... NOT NULL when no usable value source is supplied (no DEFAULT,
 * a DEFAULT folding to NULL, and no per-row backfill) and the table already has rows.
 * The pre-mutation form means no rollback is needed — the schema and module state are
 * still untouched at this point.
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
	sql: string,
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

	// Validate: the remaining dependents `module.alterTable` cannot narrow — a column
	// DEFAULT / generated body, a CHECK constraint, a foreign key in another table pointing
	// AT the column, and an assertion body. All four run before `requireVtabModule` /
	// `module.alterTable`, so a refused drop persists nothing. Ordered by widening blast
	// radius (a column expression → a CHECK → a foreign key → the whole database), so the
	// most locally-explainable violation is the one reported. The first two scan every
	// table in every schema and report a dependent on the ALTERED table first, so their
	// messages for a same-table dependent are unchanged by that widening.
	assertNoColumnExpressionNamesColumn(rctx.db, tableSchema, columnName);
	assertNoCheckConstraintNamesColumn(rctx.db, tableSchema, columnName);
	assertNoForeignKeyReferencesColumn(rctx.db, tableSchema, columnName);
	assertNoAssertionNamesColumn(rctx.db, tableSchema, columnName);

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
		ddl: sql,
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

	// `drop`, not `alter` — the arm removes an object. Matches what an emitter-backed module
	// reports for the same statement.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'drop', objectType: 'column',
		objectName: tableSchema.name,
		columnName,
		ddl: sql,
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
	sql: string,
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
		ddl: sql,
	});

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: tableSchema.name,
		ddl: sql,
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
	sql: string,
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

	// A UNIQUE constraint's implicit backing structure is named after the constraint, so
	// the rename renames that structure too — reject when the new name is already an
	// index on this table (the mirror of `SchemaManager.createIndex`'s refusal). Gated on
	// `oldLower !== newLower` for the same reason the collision check above is: on the
	// memory backend the constraint's OWN backing structure is a materialized index under
	// the old name, which a case-only rename would otherwise match.
	if (constraintClass === 'unique' && oldLower !== newLower) {
		// No columns to pass: the renamed-to name is always a name, so the `_uc_<cols>`
		// auto-name branch is unreachable from here.
		assertUniqueConstraintIndexNameFree(
			tableSchema,
			newName,
			[],
			`rename constraint '${oldName}' to '${newName}' on table '${tableSchema.name}'`,
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
		ddl: sql,
	});

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	// A named constraint is not an `objectType` of its own, so the arm reports the TABLE it
	// reshaped — same as an emitter-backed module does.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: tableSchema.name,
		ddl: sql,
	});

	log('Renamed constraint %s.%s.%s to %s', tableSchema.schemaName, tableSchema.name, oldName, newName);
	return null;
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
	sql: string,
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
		const newLogicalType = inferType(action.setDataType);
		validateCollationForType(
			tableSchema.columns[colIndex].collation,
			newLogicalType,
			action.columnName,
			(n) => rctx.db.isCollationRegistered(n),
		);
		// The column's EXISTING stored default must remain convertible to the NEW type —
		// otherwise the retype mints a column CREATE TABLE would refuse. Same rationale as
		// the collation check above: engine-side and pre-module, so a refusal touches no
		// storage. Remedy: DROP DEFAULT first, then retype — which is what the declarative
		// differ emits when a migration replaces the default alongside the retype.
		//
		// NOTE: an ACCEPTED retype leaves the default's AST in its old-type spelling (`text default '7'`
		// retyped to INTEGER keeps the literal `'7'`, not `7`), so generated DDL is non-canonical even
		// though it re-parses and re-folds to the same value. If a DDL round-trip ever needs canonical
		// defaults (a schema-hash compare across a retype, say), rewrite the AST from this fold's result.
		foldDefaultToType(tableSchema.columns[colIndex].defaultValue, newLogicalType, action.columnName);
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
		// The new default must be convertible to the column's CURRENT logical type — same
		// gate CREATE TABLE runs, engine-side and pre-module so both backends agree and a
		// refusal touches no storage. A non-literal default folds to `undefined` and stays
		// deferred to write time, unchanged.
		foldDefaultToType(action.setDefault, tableSchema.columns[colIndex].logicalType, action.columnName);
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
		ddl: sql,
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

	// All four attribute forms (SET/DROP NOT NULL, SET DATA TYPE, SET/DROP DEFAULT,
	// SET COLLATE) report the same `alter`/`column` shape — the event says which column
	// changed, not which attribute; `ddl` says which attribute, exactly.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'column',
		objectName: tableSchema.name,
		columnName: action.columnName,
		ddl: sql,
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
		// SET NOT NULL backfill: null → the folded-and-CONVERTED literal DEFAULT, the same
		// map the module applies to its rows. No usable literal default means the module
		// either found no NULLs (nothing to remap) or rejected the ALTER before reaching here.
		//
		// NOTE: `foldDefaultToType` throws MISMATCH on an unconvertible literal, and this
		// runs AFTER the module mutated. Unreachable today — every module folds the same
		// DEFAULT through the same helper up front and rejects the ALTER there, so a literal
		// that fails here would already have failed. If a module ever stops folding eagerly,
		// catch here and return undefined rather than aborting a completed ALTER.
		const col = tableSchema.columns[colIndex];
		const folded = foldDefaultToType(col.defaultValue, col.logicalType, col.name);
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
	sql: string,
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

	// Column indices of the key being retired and the one replacing it. Both index the
	// CURRENT column layout — ALTER PRIMARY KEY adds and drops no column — so they are
	// also indices into the batched events' row images, which any earlier ALTER in this
	// transaction has already remapped to that layout.
	const oldPkIndices = tableSchema.primaryKeyDefinition.map(pk => pk.index);
	const newPkIndices = newPkDef.map(pk => pk.index);

	// Try native module re-key first
	const module = requireVtabModule(tableSchema);
	if (module.alterTable) {
		try {
			const schemaChangePk = newPkDef.map(pk => ({ index: pk.index, desc: pk.desc ?? false }));
			const updatedTableSchema = await module.alterTable(
				rctx.db, tableSchema.schemaName, tableSchema.name,
				{ type: 'alterPrimaryKey', newPkColumns: schemaChangePk, ddl: sql },
			);

			// Events this transaction already recorded identify their rows by the RETIRED
			// key; re-derive each from its own row image so the commit delivers every event
			// under the key the table has at delivery. AFTER the module call (a module
			// failure must leave the batch as untouched as the catalog, and the store's
			// `ddlCommitPendingOps` flushes its queued events into our batch DURING that
			// call — those must be in the batch before we walk it), BEFORE the catalog swap,
			// matching where the other ALTER arms call `remapBatchedDataEvents`.
			//
			// NOTE: this sits inside the try whose catch falls through to the rebuild, so an
			// UNSUPPORTED raised BELOW it (only reachable via a `table_modified` listener, as
			// `schema.addTable` raises no UNSUPPORTED) would re-key twice. The second pass is
			// idempotent for every event except a PK-moving update, whose image tie-break no
			// longer recognizes the already-rewritten key. If anything below this line gains
			// a real UNSUPPORTED path, narrow the try to the `module.alterTable` call.
			rctx.db._getEventEmitter().rekeyBatchedDataEvents(
				tableSchema.schemaName, tableSchema.name, oldPkIndices, newPkIndices);

			schema.addTable(updatedTableSchema);
			rctx.db.schemaManager.getChangeNotifier().notifyChange({
				type: 'table_modified',
				schemaName: tableSchema.schemaName,
				objectName: tableSchema.name,
				oldObject: tableSchema,
				newObject: updatedTableSchema,
			});

			// NOTE: inside the try whose catch falls through to the rebuild — same caveat as
			// the re-key above. The emit raises no UNSUPPORTED (the gate either emits or
			// does not), so it cannot itself trigger the fallback.
			emitAlterSchemaEvent(rctx, tableSchema, {
				type: 'alter', objectType: 'table',
				objectName: tableSchema.name,
				ddl: sql,
			});

			log('Altered primary key of %s.%s (native)', tableSchema.schemaName, tableSchema.name);
			return null;
		} catch (e) {
			if (e instanceof QuereusError && e.code === StatusCode.UNSUPPORTED) {
				// Fall through to rebuild. The swallow is the documented protocol
				// (docs/module-authoring.md § `alterPrimaryKey`), but a swallowed error must
				// still leave a trace — this is the only record that the native re-key was
				// attempted and declined.
				warnLog(
					'Module %s declined an in-place re-key of %s.%s (UNSUPPORTED: %s); falling back to a shadow-table rebuild',
					tableSchema.vtabModuleName ?? '<unknown>', tableSchema.schemaName, tableSchema.name, e.message,
				);
			} else {
				throw e;
			}
		}
	}

	// Rebuild fallback. Two preconditions, both refusals rather than repairs — see
	// `rebuildViaShadowTable` for why neither has a correct outcome. Checked here, after the
	// native attempt, so both entry paths into the rebuild (no `alterTable` hook at all; the
	// hook raised UNSUPPORTED) are covered by one check each; a module that raised
	// UNSUPPORTED has by contract mutated nothing, so a refusal here leaves the catalog, the
	// table and the enclosing transaction untouched. Capability first: it is unconditional,
	// so it is the more informative answer when both apply.
	if (!module.renameTable) {
		throw new QuereusError(
			`Module '${tableSchema.vtabModuleName ?? '<unknown>'}' does not support ALTER PRIMARY KEY on table `
				+ `'${tableSchema.name}': it cannot re-key in place (it implements no 'alterTable' hook, or the `
				+ `hook declined), and the engine's fallback rebuild finishes by renaming a shadow table over `
				+ `this one — without 'renameTable' the module would keep the rows under the shadow name and `
				+ `the rebuilt table could not be opened.`,
			StatusCode.UNSUPPORTED,
		);
	}
	// NOTE: refused on every `DdlTransactionality` tier, including a module declaring
	// 'transactional'. None does today; if one appears its DROP + RENAME would roll back
	// together with the row copy, making this refusal over-broad — exempt that tier then, the
	// way `assertDdlTransactionPolicy` already does.
	if (isExplicitTransactionOpen(rctx.db)) {
		throw new QuereusError(
			`ALTER PRIMARY KEY on table '${tableSchema.name}' is not allowed inside an explicit transaction: `
				+ `module '${tableSchema.vtabModuleName ?? '<unknown>'}' cannot re-key in place, so the statement `
				+ `would fall back to a shadow-table rebuild whose DROP + RENAME survives ROLLBACK while its row `
				+ `copy does not — a rollback would leave an empty table and destroy rows committed before this `
				+ `transaction began. COMMIT or ROLLBACK first, then re-issue in autocommit mode.`,
			StatusCode.ERROR,
		);
	}

	await rebuildTableWithNewShape(rctx, tableSchema, schema, tableSchema.columns.map(c => c.name), newPkDef);

	// A DEFENSIVE NO-OP on this path today, not the working re-key the native arm above does.
	// Nothing can be in the batch for this table by now: the rebuild's own events are
	// suppressed (see `rebuildViaShadowTable`), the ALTER statement writes no rows of its own,
	// and the explicit-transaction refusal above rules out earlier same-transaction writes.
	// Kept anyway — it costs one walk of an empty batch, and it is the correct call the moment
	// that transaction guard is loosened; deleting it would quietly make this arm's
	// as-of-delivery `key` guarantee depend on the guard staying exactly as it is. Every column
	// survives the rebuild in order (`survivingColumns` above is the full list), so the indices
	// would still line up with the event images.
	rctx.db._getEventEmitter().rekeyBatchedDataEvents(
		tableSchema.schemaName, tableSchema.name, oldPkIndices, newPkIndices);

	// The rebuild's own four statements are silent (`rebuildViaShadowTable` runs them inside
	// `withPublicEventsSuppressed`, which also swallows the inner RENAME TO arm's event). This
	// emit is OUTSIDE that scope, so the re-key itself reports exactly one `alter`/`table` —
	// the same shape the native branch above reports.
	//
	// NOTE: this arm is the one place where a module WITH its own emitter can end up reporting
	// nothing — it raised UNSUPPORTED instead of emitting, and the gate below then suppresses
	// the engine's fallback because the module registration advertises native support. No such
	// module exists today (memory re-keys in place, the store handles `alterPrimaryKey`
	// natively), so the path is unreachable. If an emitter-backed module ever declines the
	// re-key, teach the gate that a rebuild fallback owns the event regardless of the module's
	// emitter.
	emitAlterSchemaEvent(rctx, tableSchema, {
		type: 'alter', objectType: 'table',
		objectName: tableSchema.name,
		ddl: sql,
	});

	log('Altered primary key of %s.%s (rebuild)', tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * Rebuilds a table with a new column projection and/or primary key, via the
 * shadow-table SQL approach with DROP+RENAME. This is the fallback for a module
 * whose `alterTable` throws `UNSUPPORTED` for `alterPrimaryKey` (or omits the
 * hook); the built-in memory and store modules both re-key in place and never
 * reach it. See `rebuildViaShadowTable` for the two preconditions
 * `runAlterPrimaryKey` checks before calling this.
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

	await rebuildViaShadowTable(rctx, tableSchema, schema, survivingColumns, newPkDef);

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
		throw new RelationNotFoundError(`no such table: ${tableSchema.name}`);
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
 * Generic rebuild via shadow table SQL, for a module without a native
 * `alterPrimaryKey`.
 *
 * Two preconditions the caller (`runAlterPrimaryKey`) enforces, because this rebuild has no
 * correct outcome without them:
 *
 *  - **The module must implement `renameTable`.** The last step renames the shadow table over
 *    the original; a module that files its rows under the table's name and never hears about
 *    the rename keeps them under the shadow name while the catalog says otherwise, and the
 *    rebuilt table cannot be connected at all.
 *  - **No explicit transaction may be open.** The two halves have different transactional
 *    lifetimes: the schema half (DROP + RENAME) escapes ROLLBACK on every
 *    `DdlTransactionality` tier a built-in module reaches, while the row copy is staged in the
 *    transaction and IS undone. A ROLLBACK would therefore keep the new empty table and
 *    discard the copy of the rows it replaced — destroying data committed before the
 *    transaction began. Making the schema half roll back needs transactional DDL no module
 *    offers; making the data half survive would commit part of the user's transaction behind
 *    their back.
 *
 * The four statements are engine scaffolding, not statements the application issued, so the
 * whole rebuild runs with the PUBLIC event channels suppressed — see the scope inside.
 */
async function rebuildViaShadowTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	_schema: import('../../schema/schema.js').Schema,
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

	// The rebuild's statements are ordinary SQL, so without this scope they would raise
	// ordinary notifications describing the scaffolding rather than what the user asked for:
	// the copy announces every existing row as a fresh `insert` (relabelled onto the real
	// table by the trailing rename), and the create/drop pair announces a timestamped table
	// created and the real one dropped. A re-key changes no row and replaces no table, so all
	// of that is wrong. Covers the failure cleanup below too — a shadow table nobody was told
	// about must not announce its own drop.
	//
	// Only the PUBLIC channels are suppressed. The internal catalog change notifier keeps
	// firing throughout (it is what invalidates the optimizer's and the write path's cached
	// schemas), which is why the rebuilt table is immediately plannable under its new key.
	//
	// NOTE: a module whose own emitter defers delivery to its own commit — rather than
	// emitting during the write — can still leak the copy's inserts, because its events
	// arrive after this scope has closed. Conditional, not a live defect: no module that
	// reaches this rebuild behaves that way (memory and the store both re-key in place and
	// never enter it). If one ever does, suppression has to become name-keyed (covering the
	// shadow name as well as the real one) or the events have to be dropped out of the batch
	// after the fact.
	await rctx.db._getEventEmitter().withPublicEventsSuppressed(async () => {
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
	});
}

/**
 * Propagates a table rename into every dependent schema object the catalog knows
 * about: CHECK expressions, FK references, partial-index predicates, view bodies,
 * assertion bodies, and materialized-view bodies. EVERY schema is walked for every
 * object kind — a view / assertion / MV elsewhere over the renamed table is as much a
 * dependent as a cross-schema foreign key, and the per-home-schema resolver is what
 * keeps that from over-matching (see {@link snapshotObjectRefResolvers}). View
 * `selectAst` is mutated in place because the planner re-walks it on every reference.
 *
 * Two global passes, not one combined per-schema pass: the MV pass re-plans each body
 * it rewrites, so every plain VIEW in every schema must already carry the new name
 * before the first MV re-plans — an MV in `main` may read a view in `temp`.
 */
async function propagateTableRename(
	rctx: RuntimeContext,
	preStaleMvs: ReadonlySet<string>,
	targetFor: (homeSchemaName: string) => TableRenameTarget,
): Promise<void> {
	const schemas = Array.from(rctx.db.schemaManager._getAllSchemas());
	for (const schema of schemas) {
		propagateTableRenameInSchema(rctx.db, schema, targetFor);
	}
	for (const schema of schemas) {
		await propagateTableRenameToMaterializedViews(rctx.db, schema, preStaleMvs, targetFor(schema.name));
	}
	// After all per-schema rewrites and their cascade events: restore any MV this
	// statement's events marked stale that the rename provably did not affect
	// (e.g. a dependent of another source whose only change was an FK rewrite).
	await restoreUnaffectedMaterializedViews(rctx.db, preStaleMvs);
}

/** Tables, views and assertions of one schema. Materialized views are a separate
 *  global pass — see {@link propagateTableRename}. */
function propagateTableRenameInSchema(
	db: Database,
	schema: Schema,
	targetFor: (homeSchemaName: string) => TableRenameTarget,
): void {
	const notifier = db.schemaManager.getChangeNotifier();

	for (const table of Array.from(schema.getAllTables())) {
		// The just-renamed table is deliberately NOT skipped: it already carries its
		// new name, but a self-referencing FK's `referencedTable` (and its own CHECK /
		// DEFAULT / index-predicate ASTs) still name the old one and need rewriting.
		const updated = rewriteTableForTableRename(table, targetFor);
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

	// Bodies owned by this schema resolve their unqualified names under ITS home
	// path — one target per schema walked, all over the pre-mutation snapshot. A
	// bare `t` matches only when it RESOLVES to the renamed object's key under that
	// path, so a `temp`-owned body meaning `temp.t` survives a rename of `main.t`.
	const target = targetFor(schema.name);
	for (const view of Array.from(schema.getAllViews())) {
		// The body walk also descends the trailing `with defaults (…)` clause
		// (now stored on `selectAst.defaults`), so a clause-only rewrite — a
		// defaults-expr subquery referencing the renamed table even when the body
		// never names it — flips `bodyChanged` and fires the (single) view_modified.
		const bodyChanged = renameTableInAst(view.selectAst, target);
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

	// Assertions: same in-place body rewrite as plain views, plus a regenerated
	// `violationSql` (the text the commit-time evaluator re-parses). Assertions
	// feed no materialized view, so order against the MV pass is free; sitting
	// next to the view loop keeps the plain schema-level objects together.
	propagateTableRenameToAssertions(db, schema, target);
}

/**
 * Rewrite one table's own definition for a table rename. The three
 * expression-bearing arms — CHECK constraints, partial-index predicates, and
 * column DEFAULT / generated bodies — go through the SAME collection helpers
 * the store module's catalog rewrite calls (`renameTableIn{CheckConstraints,
 * IndexPredicates,ColumnExpressions}`), so the per-arm row-image-context
 * decision (CHECKs and column expressions evaluate against a written row,
 * predicates do not) exists in exactly one place and the engine path and the
 * store path cannot disagree about it. The helpers rewrite in place and
 * report "did anything change", which is all the former hand-rolled loops
 * computed beyond the rewrite — their per-item `{...cc}` / `{...idx}` shallow
 * copies achieved nothing (the ASTs are shared by reference either way;
 * flipping `changed` is what re-registers the table and fires
 * `table_modified`).
 *
 * The FK arm stays hand-rolled: it maps a name field rather than walking an
 * AST, and an unqualified `referencedTable` binds the CHILD table's own
 * schema (never the session path — see `assertNoForeignKeyReferencesColumn`),
 * so the key comparison composes it from `fk.referencedSchema ?? table.schemaName`.
 */
function rewriteTableForTableRename(
	table: TableSchema,
	targetFor: (homeSchemaName: string) => TableRenameTarget,
): TableSchema {
	const target = targetFor(table.schemaName);
	const targetKey = objectRefKey(target.schemaName, target.oldName);
	let changed = false;

	if (renameTableInCheckConstraints(table.checkConstraints, target)) changed = true;

	const newFks = (table.foreignKeys ?? []).map(fk => {
		if (objectRefKey(fk.referencedSchema ?? table.schemaName, fk.referencedTable) !== targetKey) return fk;
		changed = true;
		return { ...fk, referencedTable: target.newName };
	});

	// Partial-index predicates: the AST is mutated in place, so the derived
	// UNIQUE constraint of a unique partial index (which shares the predicate
	// by reference — see appendIndexToTableSchema) is rewritten with it.
	if (renameTableInIndexPredicates(table.indexes, target)) changed = true;

	// Column-level expressions — a DEFAULT (`w integer default ((select min(v) from u))`)
	// and a generated column's body. Unlike the column verb's arm, no seeded/unseeded
	// split: `renameTableInAst` resolves nothing against an implicit owning table, so one
	// entry point covers the renamed table's own self-referencing default and every other
	// table's alike.
	if (renameTableInColumnExpressions(table.columns, target)) changed = true;

	if (!changed) return table;

	return Object.freeze({
		...table,
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
	});
}

/**
 * The column-verb mirror of {@link propagateTableRename} — same all-schema scope for
 * every dependent object kind, same two-global-passes shape per round (views everywhere
 * before the first MV re-plans) — plus the one dimension the table verb does not have:
 * a rewritten view / MV body can SHIFT THE NAME the object publishes (a bare or `*`
 * passthrough of the renamed column), and the objects reading it then need the same
 * rename with the view as the target. The worklist lives in `column-rename-cascade.ts`;
 * each round re-enters the two passes below through the callback (threaded to avoid an
 * import cycle), so every dependent kind is covered at every depth.
 */
async function propagateColumnRename(
	rctx: RuntimeContext,
	tableName: string,
	oldCol: string,
	newCol: string,
	preStaleMvs: ReadonlySet<string>,
	resolvers: ObjectRefResolvers,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): Promise<void> {
	await runColumnRenameCascade(rctx.db, { targetKey, tableName }, oldCol, newCol, preStaleMvs,
		resolvers, resolveColumnInSource, async target => {
			const schemas = Array.from(rctx.db.schemaManager._getAllSchemas());
			for (const schema of schemas) {
				propagateColumnRenameInSchema(rctx.db, schema, target.tableName, oldCol, newCol, resolvers, target.targetKey, resolveColumnInSource);
			}
			for (const schema of schemas) {
				await propagateColumnRenameToMaterializedViews(rctx.db, schema, target.tableName, oldCol, newCol,
					preStaleMvs, resolvers.forHomeSchema(schema.name), target.targetKey, resolveColumnInSource);
			}
		});
	// After the whole cascade (once, not per round) and its events: restore any MV
	// this statement's events marked stale that the rename provably did not affect —
	// a body that never names the renamed column, or a `select *` body whose output
	// is a pure name shift (carried onto the live backing by the pass).
	await restoreUnaffectedMaterializedViews(rctx.db, preStaleMvs);
}

/** Tables, views and assertions of one schema. Materialized views are a separate
 *  global pass — see {@link propagateColumnRename}. */
function propagateColumnRenameInSchema(
	db: Database,
	schema: Schema,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolvers: ObjectRefResolvers,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): void {
	const notifier = db.schemaManager.getChangeNotifier();

	for (const table of Array.from(schema.getAllTables())) {
		const updated = rewriteTableForColumnRename(table, tableName, oldCol, newCol, resolvers, targetKey, resolveColumnInSource);
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

	// Bodies owned by this schema resolve under ITS home path, over the pre-mutation
	// snapshot — same per-schema resolver, and same all-schema scope, as the
	// table-rename loop.
	const resolve = resolvers.forHomeSchema(schema.name);
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
		const bodyChanged = renameColumnInAst(view.selectAst, tableName, oldCol, newCol, resolve, targetKey, 'none', resolveColumnInSource);
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

	// Assertions: same in-place body rewrite as plain views (unseeded walker —
	// an assertion body owns its own FROM scopes), plus a regenerated
	// `violationSql`.
	propagateColumnRenameToAssertions(db, schema, tableName, oldCol, newCol, resolve, targetKey, resolveColumnInSource);
}

function rewriteTableForColumnRename(
	table: TableSchema,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolvers: ObjectRefResolvers,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): TableSchema {
	const oldColLower = oldCol.toLowerCase();
	const resolve = resolvers.forHomeSchema(table.schemaName);
	// Key comparison, so a same-named table in another schema never takes the
	// seeded branch.
	const isRenamedTable = objectRefKey(table.schemaName, table.name) === targetKey;
	let changed = false;

	// Row-image modes: a CHECK is written-row context wherever it lives — 'own'
	// when its image IS the renamed table, 'foreign' when it is another table's
	// (a bare `new.`/`old.` there names THAT table's row, never the renamed one,
	// even for a table literally called `new`).
	const newChecks = table.checkConstraints.map(cc => {
		const rewrote = isRenamedTable
			? renameColumnInCheckExpression(cc.expr, tableName, oldCol, newCol, resolve, targetKey, 'own', resolveColumnInSource)
			: renameColumnInAst(cc.expr, tableName, oldCol, newCol, resolve, targetKey, 'foreign', resolveColumnInSource);
		if (!rewrote) return cc;
		changed = true;
		return { ...cc };
	});

	const newFks = (table.foreignKeys ?? []).map(fk => {
		// An unqualified `referencedTable` binds the CHILD table's own schema
		// (never the session path — see `assertNoForeignKeyReferencesColumn`),
		// hence the composed key rather than the resolver.
		if (objectRefKey(fk.referencedSchema ?? table.schemaName, fk.referencedTable) !== targetKey) return fk;
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
	// Row-image mode 'none' on both arms: a predicate describes rows already
	// stored, so it has no written-row context regardless of which table owns it.
	const newIndexes = (table.indexes ?? []).map(idx => {
		const rewrote = isRenamedTable
			? renameColumnInCheckExpression(idx.predicate, tableName, oldCol, newCol, resolve, targetKey, 'none', resolveColumnInSource)
			: renameColumnInAst(idx.predicate, tableName, oldCol, newCol, resolve, targetKey, 'none', resolveColumnInSource);
		if (!rewrote) return idx;
		changed = true;
		return { ...idx };
	});

	// Column-level expressions — a DEFAULT (`b integer default (new.a + 1)`) and a
	// generated column's body (`g integer generated always as (a + 1)`). Same branch split
	// the checks and predicates use above: the renamed table's own columns take the seeded
	// walk (a generated body's bare `a` binds to the owning table; a default's `new.a`
	// names its row image), any other table's take the unseeded one (it can reach here only
	// through a subquery, whose FROM must bind the ref).
	//
	// Unlike the collections above, no per-item shallow copy: the rewrite is in place and a
	// `ColumnSchema`'s own fields are untouched, so a fresh column object would only make
	// the catalog's array stop being identical to the one the module's rename hook just
	// built and handed back. Flipping `changed` is what re-registers the table and fires
	// `table_modified`, which is all the copies above achieve either.
	const columnsRewritten = isRenamedTable
		? renameColumnInColumnExpressions(table.columns, tableName, oldCol, newCol, resolve, targetKey, resolveColumnInSource)
		: rewriteOtherTableColumnExpressions(table.columns, tableName, oldCol, newCol, resolve, targetKey, resolveColumnInSource);
	if (columnsRewritten) changed = true;

	if (!changed) return table;

	return Object.freeze({
		...table,
		checkConstraints: Object.freeze(newChecks),
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
		indexes: table.indexes ? Object.freeze(newIndexes) : table.indexes,
	});
}

/**
 * The unseeded arm of the column-expression rewrite above, for a table that is NOT the
 * renamed one. `renameColumnInColumnExpressions` is deliberately seeded-only (that is the
 * whole reason it exists), so the other branch walks the two fields directly with
 * {@link renameColumnInAst} — the same entry point the checks and predicates arms use for
 * a foreign table, and for the same reason: an unqualified ref in someone else's default
 * must bind inside its own subquery's FROM, never to this table.
 *
 * `resolveColumnInSource` is as load-bearing here as on the seeded arm, and for the mirror
 * reason: without it the walk cannot tell that an inner FROM source exposes the old name,
 * so a nested `(select (select max(a) from other) from t)` rewrites the INNER `a` — which
 * binds to `other` — and the default silently starts reading a different column. It also
 * keeps this pass in step with the pre-flight persistability probe, which runs the same
 * rewriter with the resolver supplied.
 */
function rewriteOtherTableColumnExpressions(
	columns: ReadonlyArray<ColumnSchema>,
	tableName: string,
	oldCol: string,
	newCol: string,
	resolve: ResolveObjectRef,
	targetKey: string,
	resolveColumnInSource: ResolveColumnInSource,
): boolean {
	let changed = false;
	for (const col of columns) {
		for (const expr of [col.defaultValue, col.generatedExpr]) {
			// 'foreign': another table's DEFAULT / generated body is written-row
			// context whose image is THAT table — a bare `new.`/`old.` there names
			// nothing this rename cares about.
			if (expr && renameColumnInAst(expr, tableName, oldCol, newCol, resolve, targetKey, 'foreign', resolveColumnInSource)) changed = true;
		}
	}
	return changed;
}

/**
 * Build a minimal constraints array from an existing ColumnSchema
 * so that the ColumnDef AST accurately represents the column.
 */
function buildConstraintsFromColumn(col: ColumnSchema): ColumnDef['constraints'] {
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
