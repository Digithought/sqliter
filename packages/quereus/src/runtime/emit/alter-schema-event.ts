import type { RuntimeContext } from '../types.js';
import type { TableSchema } from '../../schema/table.js';

/**
 * The shape one `ALTER TABLE` arm announces on the public schema channel. `schemaName` and
 * the owning module are not listed: {@link emitAlterSchemaEvent} reads both off the arm's
 * `tableSchema`, and neither can change across an ALTER.
 */
export interface AlterSchemaEventShape {
	/** `drop` for DROP COLUMN — it removes an object; every other arm is `alter`. */
	type: 'alter' | 'drop';
	/** `column` for the per-column arms, `table` for whole-table ones. */
	objectType: 'table' | 'column';
	/** Table name — the NEW one for RENAME TO. */
	objectName: string;
	/** RENAME TO only: the table name it had before. */
	oldObjectName?: string;
	/** The column the arm touched, for the `column` arms. */
	columnName?: string;
	/** RENAME COLUMN only: the name it had before. */
	oldColumnName?: string;
	/** Canonical, fully-qualified SQL of the statement — the node's plan-build
	 *  rendering (`AlterTableNode.sql` / `AddConstraintNode.sql`), so the auto
	 *  path announces the identical text an emitter-backed module does. */
	ddl?: string;
}

/**
 * Raises the public schema-change event for one `ALTER TABLE` arm on the ENGINE's own path —
 * i.e. only when the owning module ships no event emitter of its own and some listener needs
 * the event. Both halves of that decision stay in
 * `SchemaManager.emitAutoSchemaEventIfNeeded`, the single gate every auto event passes
 * through; re-deciding either half here is what opens the double-emit hazard the store
 * package's `database-events.spec.ts` guards against.
 *
 * Every arm calls this at its TAIL — after the catalog swap and the internal
 * `changeNotifier.notifyChange` — deliberately unlike the modules that emit for themselves,
 * which emit from inside `module.alterTable` and so before the engine's catalog swap. An arm
 * that fails after the module call (the ADD COLUMN inline-constraint revert, an
 * `assertRenameDependentsPersistable` refusal) must announce nothing at all: announcing a
 * change that then unwound is worse than the intra-statement ordering drift, and that drift
 * is unobservable — each arm produces exactly one event and delivery is batched to commit.
 *
 * The tail placement gives the engine's own path that silence for free. A module emitting
 * from mid-statement cannot have it for free, so both paths get it from
 * `withStatementScopedSchemaEvents` (`runtime/emit/ddl-event-scope.ts`), which every DDL
 * statement — ALTER included — runs under.
 *
 * Unlike the other auto events (see the NOTE on `emitAutoSchemaEventIfNeeded`), the ALTER
 * ones DO carry `ddl`: the planner renders the statement's canonical, schema-qualified SQL
 * once at plan-build time (`AlterTableNode.sql` / `AddConstraintNode.sql`) and every arm
 * passes it here, so a memory-backed and a store-backed alteration announce the same
 * string — the text a sync peer re-executes. A rename also carries `oldObjectName`, since
 * `objectName` names only the NEW table and a receiver could not otherwise tell which of
 * its tables the event is about.
 */
export function emitAlterSchemaEvent(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	event: AlterSchemaEventShape,
): void {
	rctx.db.schemaManager.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
		...event,
		schemaName: tableSchema.schemaName,
	});
}
