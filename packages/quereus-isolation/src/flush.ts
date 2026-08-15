import type { SqlValue, UpdateResult, RowOp, VirtualTable } from '@quereus/quereus';
import { QuereusError, StatusCode, isConstraintViolation } from '@quereus/quereus';
import { type PkEquals, makePkEquals, probeRowByPk } from './pk-probe.js';
import { type OverlayEntry, collectOverlayEntries } from './overlay-rows.js';

/**
 * Applies every staged overlay row to the underlying table WITHOUT committing.
 *
 * This is the *apply-only* half of the isolation commit flush. It begins a
 * transaction on the underlying table and writes each overlay entry (tombstones
 * as deletes, live rows as insert/update), but deliberately leaves the
 * underlying transaction OPEN. Committing per table here is exactly what tears a
 * multi-table commit (table A durably commits before table B applies), so the
 * commit is factored out to {@link IsolationModule.commitConnectionOverlays},
 * which drives one apply-all pass followed by one commit-all pass across every
 * table the db-transaction touched.
 *
 * Preserves the original per-table flush semantics:
 * - Deletes (tombstones) are applied before inserts/updates so a write colliding
 *   on a secondary UNIQUE with a row being deleted in the same flush sees the
 *   slot freed first. Each PK appears at most once in the overlay, so there is no
 *   same-PK delete-then-insert pair this reordering could invert; sort() is
 *   stable in V8/Node, preserving the original PK order within each group.
 * - Data writes use `preCoerced`/`trustedWrite` (the overlay already coerced and
 *   constraint-checked them in the merged view).
 * - A post-precheck constraint result is a loud INTERNAL error (see
 *   {@link assertFlushWriteOk}), never silently dropped.
 */
export async function applyOverlayToUnderlying(
	underlyingTable: VirtualTable,
	overlayTable: VirtualTable,
	tombstoneColumn: string,
): Promise<void> {
	if (!overlayTable.query) {
		// No overlay rows to read — still begin so the coordinator has a live
		// underlying transaction to commit/roll back consistently with peers.
		await underlyingTable.begin?.();
		return;
	}

	const underlyingSchema = underlyingTable.tableSchema;
	if (!underlyingSchema) {
		throw new QuereusError('Underlying table has no schema', StatusCode.INTERNAL);
	}
	const pkIndices = underlyingSchema.primaryKeyDefinition.map(pkDef => pkDef.index);
	const tableName = underlyingSchema.name;

	// Collect all overlay entries first.
	const overlayEntries = await collectOverlayEntries(overlayTable, tombstoneColumn, pkIndices);

	// Begin the underlying transaction (idempotent for a shared-coordinator store)
	// before applying — and unconditionally, so the coordinator's applied-table set
	// is accurate even for a (degenerate) empty overlay.
	await underlyingTable.begin?.();
	if (overlayEntries.length === 0) return;

	// Deletes before inserts/updates (see doc comment above).
	const ordered = [...overlayEntries].sort((a, b) =>
		(a.isTombstone === b.isTombstone ? 0 : a.isTombstone ? -1 : 1));

	// Resolve insert-vs-update for every live row BEFORE any write of this flush
	// lands. `rowExistsInUnderlying` drives the underlying's PK index, and a
	// module whose read path cannot serve an index-driven scan over its own
	// uncommitted writes fails every probe after the first (lamina's
	// staged-overlay wrapper refuses a compound-index scan once the episode holds
	// staged drafts). Each PK appears at most once in the overlay, so no write in
	// this flush can change another entry's existence answer — hoisting the
	// probes is answer-preserving as well as one fewer read per written row.
	//
	// The equality test is built once per flush: the probe verifies each returned row's
	// key rather than trusting the seek, and that comparison must be the collation-aware
	// / semantic-ordering one the rest of the layer keys rows by.
	const pkEquals = makePkEquals(underlyingSchema, underlyingTable.db.getCollationResolver());
	const existsInUnderlying = new Map<OverlayEntry, boolean>();
	for (const entry of ordered) {
		if (entry.isTombstone) continue;
		existsInUnderlying.set(entry, await rowExistsInUnderlying(underlyingTable, pkIndices, entry.pk, pkEquals));
	}

	for (const entry of ordered) {
		if (entry.isTombstone) {
			const result = await underlyingTable.update({
				operation: 'delete',
				values: undefined,
				oldKeyValues: entry.pk,
			});
			assertFlushWriteOk(result, 'delete', entry.pk, tableName);
		} else {
			// Insert vs update decided by the pre-write probe above.
			if (existsInUnderlying.get(entry) === true) {
				const result = await underlyingTable.update({
					operation: 'update',
					values: entry.dataRow,
					oldKeyValues: entry.pk,
					preCoerced: true,
					trustedWrite: true,
				});
				assertFlushWriteOk(result, 'update', entry.pk, tableName);
			} else {
				const result = await underlyingTable.update({
					operation: 'insert',
					values: entry.dataRow,
					preCoerced: true,
					trustedWrite: true,
				});
				assertFlushWriteOk(result, 'insert', entry.pk, tableName);
			}
		}
	}
}

/**
 * Checks if a row with the given primary key exists in the underlying table.
 *
 * Drives the PK index for an O(log n) lookup where the module can serve one, but
 * verifies the key of every row it gets back — see {@link probeRowByPk}. Believing an
 * unverified first row here classifies a fresh PK as an `update`, which writes against a
 * key that does not exist and silently loses the row.
 */
async function rowExistsInUnderlying(
	underlyingTable: VirtualTable,
	pkIndices: number[],
	pk: SqlValue[],
	pkEquals: PkEquals,
): Promise<boolean> {
	return (await probeRowByPk(underlyingTable, pkIndices, pk, pkEquals)) !== undefined;
}

/**
 * Asserts that an underlying write performed during the commit flush succeeded.
 *
 * The overlay's merged-view pre-checks resolve every constraint before commit, so
 * a `constraint` result here means a real invariant was violated *after* those
 * checks. Historically this result was discarded, silently dropping the colliding
 * write and surfacing as data corruption. Convert it into a loud INTERNAL error;
 * the caller's coordinator rolls back the flush and rethrows.
 */
export function assertFlushWriteOk(result: UpdateResult, operation: RowOp, pk: SqlValue[], tableName: string): void {
	if (isConstraintViolation(result)) {
		throw new QuereusError(
			`Isolation flush ${operation} on '${tableName}' (pk=[${pk.join(', ')}]) hit a ${result.constraint} constraint: ${result.message ?? 'no message'}. The overlay merged-view pre-checks should have resolved this before commit; this indicates an isolation-layer invariant violation.`,
			StatusCode.INTERNAL,
		);
	}
}
