/**
 * Internal database interfaces for extension packages.
 *
 * These interfaces expose internal methods needed by packages that tightly
 * integrate with Quereus's transaction management (e.g., quereus-isolation,
 * quereus-store). They are not part of the public API and may change.
 *
 * @internal
 */

import type { VirtualTableConnection } from '../vtab/connection.js';
import type { BackingRowChange } from '../vtab/backing-host.js';
import type { Row, SqlValue } from '../common/types.js';
import type { UniqueConstraintSchema } from '../schema/table.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { AssertionViolation } from './database-assertions.js';
import type { CollationResolver, KeyNormalizer, KeyNormalizerResolver } from '../types/logical-type.js';

/**
 * One externally-applied row change to report through
 * {@link DatabaseInternal.ingestExternalRowChanges}. `change` rows are FULL
 * table rows in schema column order; `oldRow` images must be accurate
 * before-images (they key the backing deletes and the capture log). When the
 * same row is changed more than once in a batch, each change's `oldRow` must
 * be the true before-image of *that* change (i.e. the prior change's `newRow`).
 */
export interface ExternalRowChange {
	/** Defaults to the current schema (`schemaManager.getCurrentSchemaName()`). */
	schemaName?: string;
	tableName: string;
	/** The row change: `{ op: 'insert'|'update'|'delete', oldRow?, newRow? }`. */
	change: BackingRowChange;
}

/** Per-call facet selection for {@link DatabaseInternal.ingestExternalRowChanges}. */
export interface IngestExternalChangesOptions {
	/** Row-time covering-structure maintenance over the reported changes (default true). */
	maintainMaterializedViews?: boolean;
	/** Change capture (`_record*`) for the REPORTED rows: feeds `Database.watch`
	 *  post-commit dispatch AND commit-time global-assertion evaluation (default true).
	 *  Does not cover the batch's DERIVED writes — a maintained table driven by
	 *  {@link maintainMaterializedViews} records its own realized deltas regardless
	 *  (see `docs/mv-ingestion.md` § Facets). */
	captureChanges?: boolean;
	/** Parent-side FK actions for update/delete changes: transitive RESTRICT
	 *  enforcement + CASCADE / SET NULL / SET DEFAULT propagation (default FALSE —
	 *  a replication stream usually already carries the origin's cascade effects;
	 *  re-running them would double-apply). */
	applyForeignKeyActions?: boolean;
	/** How a commit-time global-assertion violation over the inbound batch is
	 *  handled (default `'throw'`):
	 *   - `'throw'` — the implicit commit throws and rolls the batch's derived
	 *     effects back (the externally-applied storage rows stay applied);
	 *   - `'report'` — the violation is COLLECTED into the result and the batch
	 *     still commits (derived effects land, watch dispatches). Trust-the-origin:
	 *     the data lands; the caller is notified. Honored ONLY for the seam-owned
	 *     implicit transaction with `captureChanges` on; ignored (assertions fire
	 *     at the owning commit in throw mode) inside an explicit caller transaction
	 *     or with capture off. */
	assertionFailureMode?: 'throw' | 'report';
}

/** Result of {@link DatabaseInternal.ingestExternalRowChanges}. */
export interface IngestExternalChangesResult {
	/** Commit-time global-assertion violations collected under
	 *  `assertionFailureMode: 'report'`. Empty in throw mode, when no assertion
	 *  is violated, when capture is off, or when an explicit caller transaction
	 *  owns the commit (assertions then fire at the caller's commit in throw
	 *  mode). One entry per violated assertion. */
	readonly assertionViolations: AssertionViolation[];
}

/**
 * Internal database methods for virtual table connection management.
 *
 * Extension packages that implement custom virtual tables with transaction
 * support need access to these methods to properly coordinate with the
 * database's transaction lifecycle.
 *
 * @example
 * ```typescript
 * import type { Database, DatabaseInternal } from '@quereus/quereus';
 *
 * class MyTable extends VirtualTable {
 *   private async ensureConnection(): Promise<void> {
 *     const connection = new MyConnection(this.tableName);
 *     const dbInternal = this.db as DatabaseInternal;
 *     await dbInternal.registerConnection(connection);
 *   }
 * }
 * ```
 *
 * @internal
 */
export interface DatabaseInternal {
	/**
	 * Registers an active VirtualTable connection for transaction management.
	 *
	 * When registered, the connection will:
	 * - Receive `begin()` calls if a transaction is already active
	 * - Participate in `commit()` and `rollback()` operations
	 * - Be tracked for the lifetime of the transaction
	 *
	 * @param connection The connection to register
	 */
	registerConnection(connection: VirtualTableConnection): Promise<void>;

	/**
	 * Unregisters an active VirtualTable connection.
	 *
	 * Call this when the connection is no longer needed (e.g., on disconnect).
	 * Note: During implicit transactions, unregistration may be deferred until
	 * the transaction completes.
	 *
	 * @param connectionId The ID of the connection to unregister
	 */
	unregisterConnection(connectionId: string): void;

	/**
	 * Gets an active connection by ID.
	 *
	 * @param connectionId The connection ID to look up
	 * @returns The connection if found, undefined otherwise
	 */
	getConnection(connectionId: string): VirtualTableConnection | undefined;

	/**
	 * Gets all active connections for a specific table.
	 *
	 * Useful for checking if a connection already exists before creating a new one,
	 * enabling connection reuse within a transaction.
	 *
	 * @param tableName The name of the table (with or without schema prefix)
	 * @returns Array of connections for the table
	 */
	getConnectionsForTable(tableName: string): VirtualTableConnection[];

	/**
	 * Removes all active connections for a specific table, bypassing the implicit
	 * transaction deferral that {@link unregisterConnection} honours.
	 *
	 * Use only when the table's connections are definitively stale — on drop, or
	 * after a module rename has DDL-committed and disposed the old incarnation — so
	 * a recreated/renamed same-named table never reuses a dead connection. The
	 * engine calls this from the drop path; modules whose rename is not covered by
	 * the generic rename path (which does not evict) call it themselves.
	 *
	 * @param schemaName The schema of the table
	 * @param tableName The unqualified table name
	 */
	removeConnectionsForTable(schemaName: string, tableName: string): void;

	/**
	 * Removes one active connection by id, bypassing the implicit transaction
	 * deferral that {@link unregisterConnection} honours.
	 *
	 * Use when a module must evict exactly the connections it owns rather than
	 * every connection registered under a table name — a wrapping module (e.g.
	 * the isolation layer) may hold a connection under that same name whose
	 * uncommitted state still has to reach COMMIT.
	 *
	 * @param connectionId The ID of the connection to remove
	 */
	removeConnection(connectionId: string): void;

	/**
	 * Gets all active connections.
	 *
	 * @returns Array of all active connections
	 */
	getAllConnections(): VirtualTableConnection[];

	/**
	 * Resolve the linked, `row-time`, enforcement-ready covering materialized view
	 * for a UNIQUE constraint on `schema.table`, or `undefined` when none applies.
	 *
	 * When present, the source vtab routes the constraint's conflict resolution
	 * through the covering MV's backing table (in preference to its own auto-index /
	 * source scan) — the structure the lens layer makes sole once the auto-index is
	 * retired. Synchronous with an O(1) negative fast path.
	 */
	_findRowTimeCoveringStructure(
		schemaName: string,
		tableName: string,
		uc: UniqueConstraintSchema,
	): MaintainedTableSchema | undefined;

	/**
	 * Point-look up a row-time covering MV's backing table for rows whose backing
	 * columns equal `newRow`'s UNIQUE values, returning the conflicting **source**
	 * PK(s) (excluding `newSourcePk`, the row being written). Reads-own-writes through
	 * the backing table's coordinated connection; the caller validates each candidate
	 * against its live source row and applies IGNORE/ABORT/REPLACE.
	 */
	_lookupCoveringConflicts(
		mv: MaintainedTableSchema,
		uc: UniqueConstraintSchema,
		newRow: Row,
		newSourcePk: readonly SqlValue[],
	): Promise<Array<{ pk: SqlValue[]; row?: Row }>>;

	/**
	 * Synchronously maintain every `row-time` covering structure on `sourceBase`
	 * for one source row-write. Used by a source vtab to keep a covering MV's
	 * backing table consistent for an eviction performed directly on its storage
	 * (which bypasses the DML-executor row-time hook). This is the vtab-internal,
	 * called-from-within-a-statement seam — a host reporting externally-applied
	 * writes from OUTSIDE a statement uses {@link ingestExternalRowChanges},
	 * which must NOT be called from this context (exec-mutex deadlock).
	 */
	_maintainRowTimeCoveringStructures(
		sourceBase: string,
		change: BackingRowChange,
	): Promise<void>;

	/**
	 * Batch ingestion seam for externally-applied row changes: drives the
	 * post-write pipeline (change capture, batch-amortized row-time MV
	 * maintenance, opt-in parent-side FK actions) for writes the caller has
	 * already applied directly to module storage — bypassing the DML executor —
	 * inside the coordinated transaction.
	 *
	 * The seam trusts the origin: it re-validates NOTHING (no CHECK, NOT NULL,
	 * UNIQUE, or child-side FK existence). The reported rows must already be
	 * visible to a vtab read within the active transaction (the residual and
	 * full-rebuild maintenance arms re-read the source through the vtab).
	 * Module data events are NOT emitted — the external writer owns its module
	 * event emission (and the `remote` flag).
	 *
	 * Runs inside the caller's active transaction when one exists; otherwise
	 * begins an implicit transaction it finalizes itself (the batch is its own
	 * autocommit boundary). The batch's derived effects are atomic: a mid-batch
	 * error unwinds all of them via the batch savepoint (the externally-applied
	 * storage rows are NOT unwound by Quereus). Serialized against concurrent
	 * statements via the exec mutex — do NOT call from within statement
	 * execution or vtab callbacks (deadlock); the two-arg
	 * {@link _maintainRowTimeCoveringStructures} covers that context. For the
	 * coarse, no-transaction whole-table watch invalidation alternative, see
	 * `Database.notifyExternalChange`.
	 *
	 * Returns the collected commit-time global-assertion violations (see
	 * {@link IngestExternalChangesResult}); always empty unless
	 * `assertionFailureMode: 'report'` is set and the seam owns the implicit
	 * commit.
	 */
	ingestExternalRowChanges(
		changes: readonly ExternalRowChange[],
		options?: IngestExternalChangesOptions,
	): Promise<IngestExternalChangesResult>;

	/**
	 * The canonical collation resolver for this database — the only supported way for
	 * an extension package to turn a collation name into a comparison function that
	 * honors `db.registerCollation`. Stable identity across calls; reads the live
	 * registry; throws `QuereusError` on an unknown name (never falls back to BINARY).
	 *
	 * Call it at comparator-construction time (index build, cursor setup), not per row.
	 */
	getCollationResolver(): CollationResolver;

	/**
	 * The canonical key-normalizer resolver for this database — the hash-keyed
	 * counterpart of {@link getCollationResolver}, and the only supported way for an
	 * extension package to bucket text keys in a way that honors `db.registerCollation`.
	 * Stable identity; reads the live registry; throws `QuereusError` on an unknown name
	 * or on a comparator-only collation (never guesses a built-in normalizer).
	 *
	 * Call it at key-encoder-construction time, not per row.
	 */
	getKeyNormalizerResolver(): KeyNormalizerResolver;

	/**
	 * Non-throwing probe of the key normalizer registered for `name`. Returns `undefined`
	 * both for an unregistered collation and for one registered with a comparator but no
	 * normalizer — the caller distinguishes the two (see `getCollationResolver`, which
	 * throws `no such collation sequence` for the former).
	 *
	 * Use this where a collation must be VALIDATED without raising on the spot — e.g. a
	 * store module rejecting a collation that cannot key a persisted structure at DDL
	 * time, or a planner guard that must degrade rather than throw. Where an error is the
	 * right answer, use {@link getKeyNormalizerResolver} instead.
	 */
	_getCollationNormalizer(name: string): KeyNormalizer | undefined;

	/**
	 * True iff `name` is registered with a key normalizer asserted ORDER-PRESERVING: for all
	 * strings `x`, `y`, `sign(comparator(x, y))` equals
	 * `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`. Strictly stronger than the
	 * equality partition a bare normalizer promises. False for an unregistered name, a
	 * comparator-only collation, and any custom collation that did not opt in with
	 * `registerCollation(..., { orderPreserving: true })`.
	 *
	 * A store that physically orders rows by normalized key bytes must consult this before
	 * seeking a byte range, or before advertising byte order as collation order; without the
	 * assertion it falls back to a full scan plus a comparator-accurate residual filter.
	 */
	_isCollationOrderPreserving(name: string): boolean;

	/**
	 * True iff `name` names a collation this connection can resolve — a built-in
	 * (BINARY/NOCASE/RTRIM) or one registered via `registerCollation`. The DDL-time
	 * counterpart of {@link getCollationResolver} that returns a boolean instead of
	 * throwing; store/isolation modules pass `(n) => this.db.isCollationRegistered(n)`
	 * into `validateCollationForType` / `columnDefToSchema` to gate an explicit column
	 * COLLATE against the registry with the same rule the engine uses.
	 */
	isCollationRegistered(name: string): boolean;
}
