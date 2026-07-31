/**
 * Receiver-side row identity for snapshot bootstrap.
 *
 * A snapshot carries only each entry's raw pk (the row's ADDRESS); no pk
 * IDENTITY travels on the wire. Both apply paths — streaming
 * (`snapshot-stream.ts`) and non-streaming (`snapshot.ts`) — therefore derive
 * identity locally and reconcile the result, and they must do it identically:
 * this module is the single definition of both halves.
 *
 * See docs/sync.md § Row identity vs. address.
 */

import type { SqlValue } from '@quereus/quereus';
import { compareHLC, type HLC } from '../clock/hlc.js';
import { encodePkIdentity, joinKeyParts, type PkKeying } from '../metadata/keys.js';
import type { ColumnVersionEntry } from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { toError } from './sync-context.js';

/** Resolve a table's pk keying; see {@link createSnapshotKeyingResolver}. */
export type SnapshotKeyingResolver = (schema: string, table: string) => PkKeying;

/**
 * One row's reconciled cells, keyed by column.
 *
 * `pk` is the row's address to apply: the spelling of the newest write in the
 * row's equivalence class. Any spelling from the class is valid (they collapse
 * to one identity); newest keeps the choice deterministic.
 */
export interface ReconciledRow {
	pk: SqlValue[];
	pkHlc: HLC;
	cells: Map<string, { hlc: HLC; value: SqlValue }>;
}

/**
 * Memoized per-`(schema, table)` keying lookup for one snapshot apply.
 *
 * A resolution failure (no local table definition, and none installed by the
 * snapshot's own DDL) emits `status:'error'` before propagating, for parity with
 * the data-apply failure path.
 */
export function createSnapshotKeyingResolver(ctx: SyncContext): SnapshotKeyingResolver {
	const cache = new Map<string, PkKeying>();
	return (schema, table) => {
		const cacheKey = joinKeyParts(schema, table);
		let keying = cache.get(cacheKey);
		if (!keying) {
			try {
				keying = ctx.getPkKeying(schema, table);
			} catch (error) {
				ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
				throw error;
			}
			cache.set(cacheKey, keying);
		}
		return keying;
	};
}

/** Grouping key for one row across tables — see {@link joinKeyParts}. */
export function tableScopedRowKey(schema: string, table: string, identity: string): string {
	return joinKeyParts(schema, table, identity);
}

/**
 * Merge one snapshot cell into `rows` under the RECEIVER's derived identity.
 *
 * A sender with different keying (e.g. a raw-keyed relay with no schema oracle)
 * can hold several records for what this receiver considers ONE row
 * ('apple'/'APPLE' under `nocase`, 'PT1H'/'PT60M' for TIMESPAN). Keeping the
 * greatest-HLC entry per `(identity, column)` resolves such a collapse by
 * last-writer-wins rather than by chunk order, and leaves exactly one cell
 * record + one change-log entry per surviving cell.
 */
export function reconcileCell(
	rows: Map<string, ReconciledRow>,
	entry: ColumnVersionEntry,
	keying: PkKeying,
): void {
	const identity = encodePkIdentity(entry.pk, keying);
	let row = rows.get(identity);
	if (!row) {
		row = { pk: entry.pk, pkHlc: entry.hlc, cells: new Map() };
		rows.set(identity, row);
	} else if (compareHLC(entry.hlc, row.pkHlc) > 0) {
		row.pk = entry.pk;
		row.pkHlc = entry.hlc;
	}

	const cell = row.cells.get(entry.column);
	if (!cell || compareHLC(entry.hlc, cell.hlc) > 0) {
		row.cells.set(entry.column, { hlc: entry.hlc, value: entry.value });
	}
}

/**
 * Keep the greatest-HLC candidate per key — the tombstone counterpart of
 * {@link reconcileCell} (a tombstone has no columns, so one winner per identity).
 */
export function keepMaxHLC<T extends { readonly hlc: HLC }>(
	winners: Map<string, T>,
	key: string,
	candidate: T,
): void {
	const prev = winners.get(key);
	if (!prev || compareHLC(candidate.hlc, prev.hlc) > 0) {
		winners.set(key, candidate);
	}
}
