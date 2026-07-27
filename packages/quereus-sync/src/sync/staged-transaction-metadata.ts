/**
 * Per-transaction staged-metadata overlay for local change capture.
 *
 * `handleTransactionCommit` records one committed engine transaction into a
 * single `WriteBatch`, so every read it performs against committed storage is
 * blind to what the same transaction has already staged. This overlay is the
 * read-your-own-writes companion to that batch: each cell version, tombstone,
 * and row cleanup the transaction stages is noted here, and the capture path
 * consults the overlay BEFORE committed storage. The transaction's event order
 * — which is commit order, the engine's own authority on the row's final state
 * — then decides the recorded metadata, matching what the same statements
 * produce as separate transactions.
 *
 * Rows are keyed by pk IDENTITY (the same {@link encodePkIdentity} the
 * `cv:`/`tb:`/`cl:` storage keys use), so two pk spellings collapse here iff
 * they collide on disk. One instance lives for exactly one
 * `handleTransactionCommit` call.
 */

import type { SqlValue } from '@quereus/quereus';
import type { HLC } from '../clock/hlc.js';
import type { ColumnVersionData } from '../metadata/column-version.js';
import { encodePkIdentity, type PkKeying } from '../metadata/keys.js';

/**
 * A row's staged state, as the delete cleanup consumes it (see
 * `deleteRowVersionsAndLogEntries` in `sync-context.ts`).
 */
export interface StagedRowState {
	/** Cell records this transaction has staged live (column → staged HLC). */
	readonly stagedColumns: ReadonlyMap<string, HLC>;
	/**
	 * True when this transaction already staged removal of every cell record of
	 * the row (a prior same-transaction delete). Cells staged after that removal
	 * appear in {@link stagedColumns}; every other column of the row is staged
	 * as deleted.
	 */
	readonly rowCleared: boolean;
}

interface StagedRow {
	cleared: boolean;
	columns: Map<string, ColumnVersionData>;
	tombstoneHlc?: HLC;
}

export class StagedTransactionMetadata {
	// NOTE: retains one ColumnVersionData — value AND before-image — per staged cell
	// for the life of the transaction, roughly doubling capture's peak footprint (the
	// `changes[]` array already holds one entry per fact). If very large transactions
	// ever pressure memory, note that only `columnVersion()`'s before-image chaining
	// needs the values; the delete cleanup needs nothing but the HLC.
	private readonly rows = new Map<string, StagedRow>();

	constructor(private readonly getPkKeying: (schema: string, table: string) => PkKeying) {}

	/**
	 * `\0`-separated so a dotted identifier cannot collide two tables into one
	 * map slot (the identity itself may contain any character; it comes last).
	 */
	private rowKey(schema: string, table: string, pk: SqlValue[]): string {
		return `${schema}\0${table}\0${encodePkIdentity(pk, this.getPkKeying(schema, table))}`;
	}

	private row(schema: string, table: string, pk: SqlValue[]): StagedRow {
		const key = this.rowKey(schema, table, pk);
		let row = this.rows.get(key);
		if (!row) {
			row = { cleared: false, columns: new Map() };
			this.rows.set(key, row);
		}
		return row;
	}

	/**
	 * The cell version this transaction has staged for `(pk, column)`:
	 * the staged version when it staged one; `null` when it staged the cell's
	 * removal (a row delete not followed by a re-stage of this column);
	 * `undefined` when it staged nothing — fall back to committed storage.
	 */
	columnVersion(schema: string, table: string, pk: SqlValue[], column: string): ColumnVersionData | null | undefined {
		const row = this.rows.get(this.rowKey(schema, table, pk));
		if (!row) return undefined;
		const staged = row.columns.get(column);
		if (staged) return staged;
		return row.cleared ? null : undefined;
	}

	noteColumnVersion(schema: string, table: string, pk: SqlValue[], column: string, version: ColumnVersionData): void {
		this.row(schema, table, pk).columns.set(column, version);
	}

	/**
	 * The HLC of the tombstone this transaction has staged for the row, or
	 * `undefined` when it staged none — fall back to committed storage. (Local
	 * capture never removes a tombstone, so there is no staged-as-deleted state.)
	 */
	tombstoneHlc(schema: string, table: string, pk: SqlValue[]): HLC | undefined {
		return this.rows.get(this.rowKey(schema, table, pk))?.tombstoneHlc;
	}

	noteTombstone(schema: string, table: string, pk: SqlValue[], hlc: HLC): void {
		this.row(schema, table, pk).tombstoneHlc = hlc;
	}

	/**
	 * The row's staged state for the delete cleanup, or `undefined` when this
	 * transaction has staged nothing for the row.
	 */
	rowState(schema: string, table: string, pk: SqlValue[]): StagedRowState | undefined {
		const row = this.rows.get(this.rowKey(schema, table, pk));
		if (!row) return undefined;
		const stagedColumns = new Map<string, HLC>();
		for (const [column, version] of row.columns) stagedColumns.set(column, version.hlc);
		return { stagedColumns, rowCleared: row.cleared };
	}

	/**
	 * Record that removal of ALL the row's cell records — committed and staged —
	 * has been staged (a row delete's cleanup). Later staged cells re-populate
	 * the live set; until then every column of the row reads as deleted.
	 */
	noteRowCleared(schema: string, table: string, pk: SqlValue[]): void {
		const row = this.row(schema, table, pk);
		row.cleared = true;
		row.columns.clear();
	}
}
