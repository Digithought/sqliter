/**
 * External row-change ingestion — the batch driver behind
 * `Database.ingestExternalRowChanges`.
 *
 * A write applied directly to module storage (sync-inbound replication, a
 * host's direct row store) bypasses the DML executor and therefore the
 * post-write pipeline: (1) change capture (`_record*` → `Database.watch`
 * post-commit dispatch + commit-time global assertions), (2) row-time MV
 * maintenance, (3) parent-side FK actions. This driver replays exactly those
 * facets — selected per call — over a caller-reported, ordered batch of
 * changes, inside the coordinated transaction. The batch is the external
 * analogue of one DML statement: it mirrors `runWithStatementSavepoints` and
 * the DML generators' per-statement amortization (one
 * {@link BackingConnectionCache}, one deferred full-rebuild set, one residual
 * key batch, one savepoint-broadcast scope per batch). See
 * `docs/mv-ingestion.md` § External row-change ingestion for the full
 * contract (facet semantics, trust boundary, transaction & visibility rules).
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { Row } from '../common/types.js';
import type { TableSchema } from '../schema/table.js';
import type { BackingRowChange } from '../vtab/backing-host.js';
import type { BackingConnectionCache, ResidualKeyBatch } from './database-materialized-views.js';
import type { Database } from './database.js';
import type { ExternalRowChange, IngestExternalChangesOptions, IngestExternalChangesResult } from './database-internal.js';
import type { AssertionViolation } from './database-assertions.js';
import {
	executeForeignKeyActionsAndLens,
} from '../runtime/foreign-key-actions.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('core:external-changes');

/**
 * Module-scope counter producing unique batch-savepoint names, mirroring the
 * DML executor's `stmtSavepointCounter`: names must be unique within the
 * TransactionManager's savepoint stack, and an FK-cascade DML nested inside
 * the batch opens its own statement savepoints inside the batch savepoint.
 */
let externalBatchCounter = 0;

/**
 * Resolve and memoize the {@link TableSchema} for one reported change. The
 * memo is per-batch: resolution is deterministic while the exec mutex is held
 * (no DDL can interleave), so one lookup per distinct (schema, table) pair
 * serves the whole batch.
 */
function resolveTableSchema(
	db: Database,
	memo: Map<string, TableSchema>,
	item: ExternalRowChange,
): TableSchema {
	const schemaName = item.schemaName ?? db.schemaManager.getCurrentSchemaName();
	const memoKey = `${schemaName}.${item.tableName}`.toLowerCase();
	const cached = memo.get(memoKey);
	if (cached) return cached;
	const tableSchema = db._findTable(item.tableName, schemaName);
	if (!tableSchema) {
		throw new QuereusError(
			`ingestExternalRowChanges: table '${schemaName}.${item.tableName}' not found`,
			StatusCode.NOTFOUND,
		);
	}
	memo.set(memoKey, tableSchema);
	return tableSchema;
}

/** Reject a missing or mis-sized row image — the rows must be FULL table rows
 *  in schema column order. Presence is part of the SHAPE contract (the trust
 *  boundary covers semantics, not malformed reports): without it a JS caller's
 *  missing image surfaces as a TypeError deep inside capture/maintenance. */
function assertRowShape(
	tableSchema: TableSchema,
	row: Row | undefined,
	which: 'oldRow' | 'newRow',
	op: string,
): void {
	if (row === undefined) {
		throw new QuereusError(
			`ingestExternalRowChanges: ${which} is required for op '${op}'`,
			StatusCode.MISUSE,
		);
	}
	if (row.length !== tableSchema.columns.length) {
		throw new QuereusError(
			`ingestExternalRowChanges: ${which} arity ${row.length} does not match `
				+ `'${tableSchema.schemaName}.${tableSchema.name}' column count ${tableSchema.columns.length}`,
			StatusCode.MISUSE,
		);
	}
}

/** Validate one reported change's shape: a recognized `op` carrying the images
 *  that op requires (insert: new, delete: old, update: both), each a full table
 *  row. The {@link BackingRowChange} union enforces this at compile time; this
 *  is the runtime mirror for JS callers. */
function assertChangeShape(tableSchema: TableSchema, change: BackingRowChange): void {
	switch (change.op) {
		case 'insert':
			assertRowShape(tableSchema, change.newRow, 'newRow', change.op);
			break;
		case 'delete':
			assertRowShape(tableSchema, change.oldRow, 'oldRow', change.op);
			break;
		case 'update':
			assertRowShape(tableSchema, change.oldRow, 'oldRow', change.op);
			assertRowShape(tableSchema, change.newRow, 'newRow', change.op);
			break;
		default:
			throw new QuereusError(
				`ingestExternalRowChanges: unknown op '${(change as { op: string }).op}'`,
				StatusCode.MISUSE,
			);
	}
}

/**
 * Run one ingestion batch. The caller (`Database.ingestExternalRowChanges`)
 * has already checked the database is open; everything else — exec-mutex
 * serialization, transaction/savepoint lifecycle, facet dispatch, deferred
 * flush, implicit-transaction finalization — lives here.
 */
export async function ingestExternalRowChangeBatch(
	db: Database,
	changes: readonly ExternalRowChange[],
	options?: IngestExternalChangesOptions,
): Promise<IngestExternalChangesResult> {
	// Empty batch: a true no-op — no transaction begin, no savepoint.
	if (changes.length === 0) return { assertionViolations: [] };

	const captureChanges = options?.captureChanges ?? true;
	const maintainMaterializedViews = options?.maintainMaterializedViews ?? true;
	const applyForeignKeyActions = options?.applyForeignKeyActions ?? false;
	const assertionFailureMode = options?.assertionFailureMode ?? 'throw';

	// Serialize against concurrent statements for the whole batch: FK-action
	// cascades re-enter the DML pipeline via _execWithinTransaction (the
	// already-holding-the-mutex variant), and the batch's savepoint scope must
	// not interleave with another statement's.
	const releaseMutex = await db._acquireExecMutex();
	// Trust-the-origin apply path: skip parent-side FK RESTRICT enforcement for the whole
	// batch (the origin already enforced it at its own commit; re-enforcing here would wedge
	// the sync stream). Set BEFORE the change loop so every nested cascade DML and
	// MV-maintenance FK pass observes it too. The mutex is held, so no concurrent statement
	// sees the flag; the `finally` restores the prior value even on a non-RESTRICT throw, so
	// a later normal statement re-enforces RESTRICT. Only armed when the FK-actions facet is
	// on — with it off no FK action fires and the flag must stay clear.
	const priorSuppress = applyForeignKeyActions ? db._setFkRestrictSuppressed(true) : false;
	try {
		// Run inside the caller's active transaction when one exists; otherwise
		// begin an implicit one this call finalizes itself. Holding the mutex
		// means no statement is mid-flight, so an implicit transaction observed
		// below was necessarily started here.
		await db._ensureTransaction();

		const savepointName = `__external_batch_${externalBatchCounter++}`;
		try {
			// Batch atomicity for the DERIVED effects (backing writes, cascade
			// DML, capture entries): all of the batch's pipeline effects apply
			// or none. The externally-applied storage rows are the caller's.
			await db._createSavepointBroadcast(savepointName);

			// Per-batch amortization, exactly as one DML statement amortizes
			// per-row maintenance: one backing-connection resolution per backing,
			// one rebuild per full-rebuild MV per batch, one residual recompute
			// per distinct affected key per residual-arm MV per batch.
			const cache: BackingConnectionCache = new Map();
			const deferred = new Set<string>();
			const residualBatch: ResidualKeyBatch = new Map();
			const tableMemo = new Map<string, TableSchema>();

			for (const item of changes) {
				const tableSchema = resolveTableSchema(db, tableMemo, item);
				const { change } = item;
				assertChangeShape(tableSchema, change);

				// Derived from the RESOLVED schema — byte-identical to the DML
				// executor's key, so capture/watch matching gets executor parity.
				const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;
				const pkIndices = tableSchema.primaryKeyDefinition.map(d => d.index);

				// Facets in DML-executor order: capture, then MV maintenance,
				// then FK actions.
				if (captureChanges) {
					switch (change.op) {
						case 'insert': db._recordInsert(tableKey, change.newRow, pkIndices); break;
						case 'delete': db._recordDelete(tableKey, change.oldRow, pkIndices); break;
						case 'update': db._recordUpdate(tableKey, change.oldRow, change.newRow, pkIndices); break;
					}
				}

				if (maintainMaterializedViews && db._hasRowTimeCoveringStructures(tableKey)) {
					await db._maintainRowTimeCoveringStructures(tableKey, change, cache, deferred, residualBatch);
				}

				// Parent-side FK actions: update/delete only (inserts have no
				// parent-side actions; child-side existence is deliberately NOT
				// checked - trust boundary). The call runs with lensRouted =
				// false: an external change is a physical basis write.
				//
				// Trust-the-origin: parent-side RESTRICT is NOT enforced on apply.
				// The `_fkRestrictSuppressed` flag set above for the batch makes
				// every nested cascade DML and MV-maintenance FK pass skip its
				// RESTRICT pre-check too (and there is no top-level RESTRICT call
				// here - it would no-op under the flag anyway). The origin already
				// enforced RESTRICT at its own commit; re-enforcing it here would
				// throw -> no metadata commit -> re-resolve -> re-apply the
				// identical batch -> throw forever, wedging the stream. Only the
				// non-RESTRICT actions (cascade / set-null / set-default) propagate,
				// at every cascade depth. A replica-only RESTRICT invariant is, by
				// design, not enforced on apply; express it as a global assertion
				// (detect-and-notify) if the receiver must be notified.
				//
				// Cross-change order-independence: the store adapter writes
				// every table's rows to storage BEFORE making this seam call,
				// so the cascade DML re-reads the fully-merged post-write state
				// regardless of which change appears first in `changes`. This
				// makes realistic shapes (single parent mutation, multiple
				// independent parent mutations, parent + direct child write)
				// order-independent. The two exotic limitations no ordering
				// fixes: (E) the cascade outcome on a child shared by two parent
				// mutations may depend on which cascade fires first; (F) diverging
				// actions (cascade-delete vs. set-null) on a shared child. Both are
				// handled by keeping applyForeignKeyActions off (default) or by a
				// global assertion.
				if (applyForeignKeyActions && change.op !== 'insert') {
					await executeForeignKeyActionsAndLens(
						db, tableSchema, change.op, change.oldRow, change.newRow);
				}
			}

			// Batch boundary: drain the deferred maintenance (residual key batch +
			// full-rebuild set) AFTER every change has been applied (each
			// recompute/rebuild reads the whole batch) and BEFORE the savepoint
			// release (a failed flush unwinds the batch).
			if (deferred.size > 0 || residualBatch.size > 0) {
				await db._flushDeferredMaintenance(deferred, residualBatch, cache);
			}
			await db._releaseSavepointBroadcast(savepointName);
		} catch (e) {
			log('batch %s failed, unwinding derived effects: %O', savepointName, e);
			await db._rollbackAndReleaseSavepointBroadcast(savepointName);
			if (db._isImplicitTransaction()) {
				await db._rollbackTransaction();
			}
			throw e;
		}

		// The batch is its own autocommit boundary, like one exec statement;
		// watch dispatch fires here. Inside an explicit caller transaction this
		// is a no-op — dispatch waits for the caller's commit.
		if (db._isImplicitTransaction()) {
			// Report mode is honored ONLY when the seam owns the commit (this
			// implicit branch) AND capture is on (assertions don't run with capture
			// off). Install a sink so a violation is collected and the batch still
			// commits — derived effects land, watch dispatches. The finally clears
			// the pending sink even if the commit throws for a NON-assertion reason
			// (connection error, deferred row constraint), so a subsequent commit is
			// never silently put into collect mode.
			if (assertionFailureMode === 'report' && captureChanges) {
				const sink: AssertionViolation[] = [];
				try {
					db._setPendingCommitAssertionSink(sink);
					await db._commitTransaction();
				} finally {
					db._setPendingCommitAssertionSink(null);
				}
				return { assertionViolations: sink };
			}
			await db._commitTransaction();
		}
		// Throw mode, capture-off report mode, or an explicit caller transaction
		// (assertions fire at the caller's commit in throw mode): nothing collected.
		return { assertionViolations: [] };
	} finally {
		// Restore the prior RESTRICT-suppression value (save-and-restore, never a blind
		// reset to false, so any future nesting restores correctly). Runs even on a
		// non-RESTRICT mid-batch throw (a cascade DML tripping CHECK / NOT NULL / a
		// connection error), so a subsequent normal statement re-enforces RESTRICT.
		if (applyForeignKeyActions) db._setFkRestrictSuppressed(priorSuppress);
		releaseMutex();
	}
}
