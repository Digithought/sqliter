import type { RuntimeContext } from '../types.js';

/**
 * Runs one whole DDL statement with its schema events made RETRACTABLE: if `fn` throws,
 * every schema event batched since the call is dropped before the error propagates, so a
 * statement that unwound announces nothing at all.
 *
 * The other half of the "one event per statement, on the success path only" rule. The
 * engine's own auto emits satisfy the rule by construction (they sit at the tail of the
 * catalog mutation, past any throw), but a backend that emits for ITSELF cannot: it emits
 * from inside `module.create` / `module.alterTable` / `module.destroy`, which is not the end
 * of the statement. Two demonstrated leaks:
 *
 *  - `alter table … add column <inline constraint>` installs each constraint through further
 *    module calls; a failure there runs `revertAddColumn` — by which point the module's
 *    announcement, carrying the statement's SQL, already sits in the transaction's batch.
 *  - `create table … maintained as <body>` creates the backing table (announced) and fills it
 *    afterwards; a fill that violates a declared constraint drops the table again, so
 *    subscribers see a create followed by a drop for a statement that did nothing. This one
 *    leaks on the ENGINE's path too, because the drop's own auto emit is a second statement's
 *    worth of announcement inside one failing statement.
 *
 * A syncing peer that re-executed either announcement would diverge from the device where the
 * statement failed.
 *
 * ## The rule
 *
 * **Every DDL statement emitter opens this scope around its `run()` body** — including the
 * ones that raise no schema event today (`create view`, the assertion verbs, the tag arms).
 * The point is that the invariant holds by construction: if one of those ever starts
 * announcing, it cannot reintroduce the class. Check it against the DDL block of
 * `runtime/register.ts`.
 *
 * **The declarative statements (`apply schema` and friends) deliberately do NOT open one.**
 * `emitApplySchema` generates migration DDL and runs each generated statement through
 * `db._execWithinTransaction`. A failure on statement 5 leaves statements 1–4 *applied* —
 * there is no catalog rollback, and inside an explicit transaction the user may still commit.
 * Those four really happened and must stay announced; a scope around the whole apply would
 * retract them. The per-statement rule gives the right answer there for free: each generated
 * sub-statement runs its own emitter, so each opens and spends its own scope.
 *
 * ## Call shape
 *
 * Call it INSIDE the emitter's `run()` — after `assertDdlTransactionPolicy` and
 * `await db._ensureTransaction()`, so the mark is taken with batching already on. Retraction
 * is a no-op without a batch, which is correct: the events were delivered synchronously and
 * nothing can call them back. Placement is not load-bearing for correctness (the watermark is
 * a lifetime-monotonic counter), but keeping it identical everywhere makes the invariant
 * readable.
 *
 * Only the SCHEMA channel is retracted — see
 * {@link DatabaseEventEmitter.discardSchemaEventsSince} for why touching the data channel here
 * would swallow earlier statements' committed writes.
 *
 * NOTE: retraction is the right answer only while a failed statement's catalog change does not
 * OUTLIVE the failure — the same condition the `apply schema` carve-out above turns on. It
 * holds today by placement: every engine auto emit sits at the tail of its catalog mutation
 * (`SchemaManager.createTable` / `createIndex` / `dropIndex` / `dropTable` / `createBackingTable`),
 * and the only post-emit work any DDL emitter still does — `dropMaintainedTable`'s
 * `materialized_view_removed` notify — cannot throw, because `SchemaChangeNotifier.notifyChange`
 * swallows listener errors. If a DDL emitter ever gains work that runs AFTER a catalog change
 * landed and can throw, this scope would un-announce a change the catalog kept; that arm needs
 * the carve-out treatment (its own inner scope, or no scope), not a wider one.
 *
 * NOTE: nothing nests these scopes today (`apply schema` is unwrapped, and the one ALTER arm
 * that runs nested SQL — the ALTER PRIMARY KEY shadow rebuild — does it under
 * `withPublicEventsSuppressed`, so it batches no events at all). If an arm ever did nest one,
 * the outer failure would retract the inner statement's events too, which is the wanted
 * reading: the outer statement unwound, so everything it did announces nothing.
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
