/**
 * Group-atomic admission core for the sync ingress data-apply seam.
 *
 * Centralizes the docs/sync.md § Transactional Integrity During Sync write
 * ordering — **data first → metadata second → abort with no metadata** — that
 * every ingress modality must uphold:
 *   - wire `applyChanges`            (change-applicator.ts)  → `admitGroup`
 *   - non-streaming `applySnapshot`  (snapshot.ts)           → `admitGroup`
 *   - each streaming flush in `applySnapshotStream` (snapshot-stream.ts)
 *                                                            → `applyDataToStore`
 *
 * Streaming keeps its own checkpoint-based consistency model (interleaved
 * metadata/data flushes, resume on a saved checkpoint) and so reuses only the
 * `applyDataToStore` seam — for the same `status:'error'` emission on a
 * whole-batch flush throw — rather than the full `admitGroup` unit.
 */

import type { HLC } from '../clock/hlc.js';
import type {
	ApplyToStoreOptions,
	ApplyToStoreResult,
	DataChangeToApply,
	SchemaChangeToApply,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, throwIfApplyErrors, toError } from './sync-context.js';

/**
 * Data-first half of the admission invariant: apply this unit's data + schema to
 * the store, emit `status:'error'` and rethrow on a whole-batch throw, surface any
 * reported assertion violations, then abort (throw) on any per-change
 * `ApplyToStoreResult.errors` — all BEFORE the caller commits any CRDT metadata.
 * No-op when there is no `applyToStore` callback or nothing to apply.
 *
 * The two failure shapes are mutually exclusive (a throw never reaches
 * `throwIfApplyErrors`), so `status:'error'` is emitted at most once. The
 * violation emit does not touch sync-state, so it cannot affect that invariant.
 *
 * Assertion violations are emitted BEFORE the per-change abort gate. Whenever the
 * seam reports a violation it ran in REPORT mode and the batch already COMMITTED —
 * the violating row's data + derived effects (MV deltas, watch capture) are
 * durably in storage. A later `throwIfApplyErrors` throw blocks only the CRDT-
 * metadata commit; it does NOT roll back those storage writes. So a reported
 * violation is a fact about already-committed data and must be surfaced even when
 * an unrelated per-change error aborts the batch in the same invocation — the two
 * facts are orthogonal: "B's data landed and broke a local invariant" and "the
 * batch can't fully admit because A failed and will retry" are both true.
 *
 * Emitting before the abort closes a permanent-notification-loss gap: were the
 * emit on the success branch only, a mixed batch (per-change error + reported
 * violation) would throw past it, drop the event, and on retry the value-identical
 * row is suppressed → empty seam batch → the assertion is never re-evaluated →
 * the host is never notified about durably-committed violating data. That same
 * value-identical suppression now correctly prevents DOUBLE-notification on retry
 * (B is suppressed, so no second event fires), matching the idempotent-re-apply
 * guarantee. On the pure-success path (no per-change errors) behavior is unchanged.
 */
export async function applyDataToStore(
	ctx: SyncContext,
	dataChanges: DataChangeToApply[],
	schemaChanges: SchemaChangeToApply[],
	options: ApplyToStoreOptions,
): Promise<void> {
	if (!ctx.applyToStore || (dataChanges.length === 0 && schemaChanges.length === 0)) return;

	let result: ApplyToStoreResult;
	try {
		result = await ctx.applyToStore(dataChanges, schemaChanges, options);
	} catch (error) {
		// Emit error state so UI can react. CRDT metadata is NOT committed,
		// allowing the same changes to be re-resolved on the next sync attempt.
		ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
		throw error;
	}

	// Surface any local assertion violations the seam reported. A reported
	// violation means the report-mode seam COMMITTED the violating row (data +
	// derived effects durable); we notify the host once per violated assertion.
	// This runs BEFORE the abort gate below so a co-occurring per-change error
	// cannot drop the notification about data that is already committed.
	if (result.assertionViolations) {
		for (const violation of result.assertionViolations) {
			ctx.syncEvents.emitAssertionViolation({
				assertion: violation.assertion,
				samples: violation.samples,
			});
		}
	}

	// Per-change storage failures (the adapter collects rather than throws) abort
	// the apply identically to a whole-batch throw: emit error + throw, with no
	// metadata committed, so the whole batch re-resolves and re-applies
	// idempotently on the next sync. See throwIfApplyErrors / docs/sync.md.
	throwIfApplyErrors(ctx, result);
}

/**
 * One group-atomic admission unit: data + schema to apply, the CRDT metadata to
 * commit only once that data landed, and the local HLC clock watermark to merge
 * on full-unit success.
 *
 * A "group" is one *admission unit*, not necessarily one source transaction — the
 * wire path admits the whole resolved `ChangeSet[]` as a single all-or-nothing
 * unit (the single per-peer `lastSyncHLC` watermark cannot express a partial
 * commit), and each snapshot path admits its wholesale load as one unit.
 */
export interface AdmissionGroup {
	readonly dataChanges: DataChangeToApply[];
	readonly schemaChanges: SchemaChangeToApply[];
	readonly applyOptions: ApplyToStoreOptions;
	/** Commit this unit's CRDT metadata. Runs ONLY after the data write landed. */
	readonly commitMetadata: () => Promise<void>;
	/**
	 * Local HLC clock watermark to merge in on full-unit success. The per-PEER
	 * `lastSyncHLC` is the transport caller's concern (it differs per modality and
	 * transport) and is deliberately NOT advanced here.
	 */
	readonly watermarkHLC?: HLC;
}

/**
 * Full group-atomic admission: data first → metadata second → advance the local
 * clock watermark, aborting (with no metadata committed) on any data-apply
 * failure. The realization of "apply a transaction group atomically, advance the
 * watermark idempotently".
 */
export async function admitGroup(ctx: SyncContext, group: AdmissionGroup): Promise<void> {
	await applyDataToStore(ctx, group.dataChanges, group.schemaChanges, group.applyOptions);
	await group.commitMetadata();                    // metadata SECOND
	if (group.watermarkHLC) {
		ctx.hlcManager.receive(group.watermarkHLC);    // monotonic merge, idempotent
		await persistHLCState(ctx);
	}
}
