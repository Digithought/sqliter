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
 * {@link withStatementScopedSchemaEvents} below, which every ALTER statement runs under.
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

/**
 * Runs one whole `ALTER TABLE` statement with its schema events made RETRACTABLE: if `fn`
 * throws, every schema event batched since the call is dropped before the error propagates,
 * so a statement that unwound announces nothing at all.
 *
 * The other half of the "one event per statement, on the success path only" rule that
 * {@link emitAlterSchemaEvent} implements — hence the shared home. The engine's own arms
 * satisfy the rule by construction (they emit at their tail, past any throw), but a backend
 * that emits for ITSELF cannot: it emits from inside `module.alterTable`, which is not the
 * end of the statement. `ADD COLUMN … <inline constraint>` then installs each constraint
 * through further module calls, and a failure there runs `revertAddColumn` — by which point
 * the module's announcement, carrying the statement's SQL, is already sitting in the
 * transaction's batch. A syncing peer that executed that SQL really would add the column,
 * diverging from the device where the statement failed.
 *
 * Wrapped at the STATEMENT boundary rather than around the ADD COLUMN revert: ADD COLUMN is
 * only the arm with a demonstrated leak, and every other arm has post-module-call work of its
 * own (`propagateTableRename`, `module.finalizeRename`, `propagateColumnRename`, the
 * materialized-view re-registration) that can open the same window later.
 *
 * Call it INSIDE the arm's `run()` — after `assertDdlTransactionPolicy` and
 * `await db._ensureTransaction()`, so the mark is taken with batching already on. Retraction
 * is a no-op without a batch, which is correct: the events were delivered synchronously and
 * nothing can call them back.
 *
 * Only the SCHEMA channel is retracted — see
 * {@link DatabaseEventEmitter.discardSchemaEventsSince} for why touching the data channel
 * here would swallow earlier statements' committed writes.
 *
 * NOTE: nothing nests these scopes today (the one ALTER arm that runs nested SQL —
 * the ALTER PRIMARY KEY shadow rebuild — does it under `withPublicEventsSuppressed`, so it
 * batches no events at all). If an arm ever did nest one, the outer failure would retract the
 * inner statement's events too, which is the wanted reading: the outer statement unwound, so
 * everything it did announces nothing.
 */
export async function withStatementScopedSchemaEvents<T>(
	rctx: RuntimeContext,
	fn: () => Promise<T>,
): Promise<T> {
	const emitter = rctx.db._getEventEmitter();
	const watermark = emitter.beginSchemaEventScope();
	try {
		return await fn();
	} catch (err) {
		emitter.discardSchemaEventsSince(watermark);
		throw err;
	}
}
