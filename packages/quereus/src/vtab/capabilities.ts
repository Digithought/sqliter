import type { SqlValue, Row, CompareFn } from '../common/types.js';

/**
 * How a module's DDL (schema-change) statements behave with respect to the
 * enclosing transaction. A single worst-case summary across every DDL statement
 * the module can execute — per-statement detail belongs in the backend docs, not
 * this flag. Severity order (least → most surprising):
 *
 *  - `'transactional'` — the reference semantics: a schema change is part of the
 *    enclosing transaction. The catalog entry and physical structures are buffered
 *    with the transaction, visible to later statements inside it, made durable
 *    atomically with the DML at commit, and discarded whole on `rollback` /
 *    `rollback to savepoint`. No built-in module reaches this tier today.
 *  - `'non-transactional'` — the schema change escapes the transaction (it survives
 *    `rollback`) but buffered DML still rolls back normally. This is the memory
 *    module, and the store's non-committing DDL statements.
 *  - `'auto-commit'` — executing certain DDL commits the module's buffered
 *    transaction at DDL time: the schema change AND every buffered write become
 *    durable immediately, and a later `rollback` undoes nothing. This is the store
 *    module (its row-rewriting ALTER arms and `renameTable` flush pending ops).
 *
 * A module declares its WORST case: the store does both non-transactional and
 * auto-committing DDL, so it declares `'auto-commit'`.
 *
 * Consumed by the `ddl_transaction_policy = 'strict'` gate, which refuses a
 * module-dispatching DDL statement inside an explicit transaction on any module
 * whose tier is not `'transactional'`. See `runtime/emit/ddl-transaction-policy.ts`
 * and docs/module-capabilities.md § "DDL transactionality tiers".
 */
export type DdlTransactionality = 'transactional' | 'non-transactional' | 'auto-commit';

/**
 * Capability flags that modules can advertise to consumers.
 * Used for runtime capability discovery and isolation layer decisions.
 */
export interface ModuleCapabilities {
	// ── Advisory / non-binding flags ──────────────────────────────────────────
	// The five flags below (isolation, savepoints, persistent, secondaryIndexes,
	// rangeScans) are ADVISORY: the engine does NOT consult them to choose a code
	// path. They are asserted only in tests, and the isolation layer augments
	// `isolation` / `savepoints` for its own bookkeeping — nothing reads them as a
	// gate. Toggling one changes no engine behavior. Only `delegatesNotNullBackfill`,
	// `permitsGrandfatheredCheckViolators`, `permitsOrphanedForeignKeyRows`, and
	// `ddlTransactionality` (below) are live capability gates. See
	// docs/module-capabilities.md § "Surface inventory".

	/** Advisory: module provides transaction isolation (read-your-own-writes, snapshot reads). Not engine-consulted. */
	isolation?: boolean;

	/** Advisory: module supports savepoints within transactions. Not engine-consulted. */
	savepoints?: boolean;

	/** Advisory: module persists data across restarts. Not engine-consulted. */
	persistent?: boolean;

	/** Advisory: module supports secondary indexes. Not engine-consulted. */
	secondaryIndexes?: boolean;

	/** Advisory: module supports range scans (not just point lookups). Not engine-consulted. */
	rangeScans?: boolean;

	/**
	 * Module owns ADD-COLUMN NOT-NULL-backfill semantics and opts out of the
	 * engine-generic rejection.
	 *
	 * Default/absent ⇒ the engine rejects `ALTER TABLE … ADD COLUMN <NOT NULL,
	 * no usable DEFAULT>` on a non-empty table before dispatching to the module
	 * (see `validateNotNullBackfill` in `runtime/emit/alter-table.ts`).
	 *
	 * When true, the engine skips that pre-check and delegates the decision to
	 * the module's `alterTable`. Intended for modules that are structurally
	 * total for schema changes — a migration always commits and NOT NULL is
	 * declared on the new schema and enforced at write time going forward,
	 * rather than applied retroactively to pre-existing rows. Such a module must
	 * still perform its own validation in `alterTable` if it wants any.
	 *
	 * Native modules (memory, store) leave this off, so their behavior — and
	 * Quereus's own conformance suite — is unchanged.
	 */
	delegatesNotNullBackfill?: boolean;

	/**
	 * Module may carry rows that violate a currently-declared CHECK constraint
	 * (i.e. `ALTER TABLE … ADD CHECK` against a non-conforming table succeeds
	 * and grandfathers the violator while declaring the CHECK on the new schema
	 * and enforcing it on forward writes).
	 *
	 * Default/absent ⇒ the planner treats declared CHECKs as universal
	 * invariants over the current row set and lifts them into FD / EC /
	 * constant-binding / domain-constraint contributions on the
	 * `TableReferenceNode`'s physical properties. The filter-contradiction
	 * rule (`rules/predicate/rule-filter-contradiction.ts`) and other
	 * consumers then constant-fold WHERE predicates that are unsatisfiable
	 * with the CHECK — sound under the third-manifesto reading where CHECKs
	 * are gate-on-add.
	 *
	 * When true, that lift is skipped for declared CHECKs on this table: the
	 * CHECK is still enforced at write time (the engine's CHECK enforcer is
	 * unchanged) but the planner can no longer prove `count(*) where v <= 0`
	 * folds to `0` from `CHECK (v > 0)` alone, because a grandfathered violator
	 * might satisfy the WHERE. Native modules (memory, store) leave this off,
	 * so their behaviour — and Quereus's own conformance suite — is unchanged.
	 *
	 * Note: assertion-hoist (CREATE ASSERTION) and partial-UNIQUE FDs are
	 * lifted by separate paths and are NOT gated by this flag.
	 */
	permitsGrandfatheredCheckViolators?: boolean;

	/**
	 * Module may carry a row whose declared foreign-key value matches no row in
	 * the referenced parent table (an "orphan"). Typical sources: `ALTER TABLE …
	 * ADD CONSTRAINT … FOREIGN KEY` succeeding against non-conforming rows and
	 * grandfathering them, or a replicated backend deleting a parent row through
	 * a path the engine never sees.
	 *
	 * Default/absent ⇒ the planner treats every declared FK as a hard inclusion
	 * dependency (`child.fk ⊆ parent.pk`): `lookupCoveringFK` and
	 * `seedTableForeignKeyInds` (`planner/util/ind-utils.ts`) produce the
	 * existence claim consumed by INNER join elimination, semi/anti-join FK
	 * folds, the fan-out lookup join's `atMostOne-inner` mode, and the coverage
	 * prover's no-row-loss obligation.
	 *
	 * When true, both producers return the empty answer whenever this module owns
	 * the child OR the parent side of the FK, so no consumer can conclude
	 * existence (≥1 parent match) from the declaration. The at-most-one claim
	 * (`checkFkPkAlignment`) is unaffected — it follows from the parent's key
	 * being unique, not from inclusion — so LEFT/RIGHT join elimination,
	 * `atMostOne-left` fan-out, and key-preservation FDs survive. Write-time FK
	 * enforcement is likewise unchanged. Native modules (memory, store) leave
	 * this off, so their behavior — and Quereus's own conformance suite — is
	 * unchanged. See invariant OPT-059.
	 */
	permitsOrphanedForeignKeyRows?: boolean;

	/**
	 * Declares how this module's DDL behaves inside a transaction — the fourth LIVE
	 * capability gate alongside `delegatesNotNullBackfill`,
	 * `permitsGrandfatheredCheckViolators`, and `permitsOrphanedForeignKeyRows`.
	 * See {@link DdlTransactionality} for the three tiers.
	 *
	 * Default/absent ⇒ `'non-transactional'`. A module must EXPLICITLY claim
	 * `'transactional'`; assuming the clean semantics by default would let every
	 * existing module silently over-promise.
	 *
	 * Read live by the `ddl_transaction_policy = 'strict'` gate: a module-dispatching
	 * DDL statement inside an explicit transaction is refused unless the owning
	 * module's tier is `'transactional'`. Under the default `'permissive'` policy the
	 * flag is not consulted and behavior is unchanged.
	 */
	ddlTransactionality?: DdlTransactionality;
}

/**
 * The slice of a vtab module a planner-side capability gate consults.
 * Structural, so planner/analysis modules needn't depend on `vtab/module.ts` —
 * shared by `planner/analysis/check-extraction.ts` and
 * `planner/util/ind-utils.ts`.
 */
export interface CapabilityProvider {
	getCapabilities?(): ModuleCapabilities;
}

/**
 * Extended interface for tables that can be wrapped by the isolation layer.
 * Provides key extraction and comparison functions needed for merge operations.
 */
export interface IsolationCapableTable {
	/**
	 * Extract primary key values from a full row.
	 * The returned array contains only the PK column values in PK order.
	 */
	extractPrimaryKey(row: Row): SqlValue[];

	/**
	 * Compare two rows by their primary key values.
	 * Must use the module's native key ordering (e.g., binary encoding order for store modules).
	 * @returns negative if a < b, 0 if equal, positive if a > b
	 */
	comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

	/**
	 * Get per-column comparator functions for a specific index.
	 * Used when merging index scans from overlay and underlying tables.
	 * Each comparator incorporates DESC ordering and collation for its column.
	 * @param indexName The name of the index
	 * @returns Array of per-column comparators, or undefined if index doesn't exist
	 */
	getIndexComparator?(indexName: string): CompareFn[] | undefined;

	/**
	 * Get the primary key column indices in the row.
	 * Used to extract PK values from rows.
	 */
	getPrimaryKeyIndices(): number[];
}
