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
	/** The column the arm touched, for the `column` arms. */
	columnName?: string;
	/** RENAME COLUMN only: the name it had before. */
	oldColumnName?: string;
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
 * The event carries no `ddl`, matching every other auto event (see the NOTE on
 * `emitAutoSchemaEventIfNeeded`), and a rename names only the NEW table —
 * `DatabaseSchemaChangeEvent` has no old-object-name field, and the emitting backends have
 * the identical gap, so parity holds.
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
