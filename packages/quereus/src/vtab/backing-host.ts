/**
 * Backing-host capability: the module-neutral, privileged surface a virtual
 * table module exposes so the engine can host a materialized view's backing
 * table inside it. Resolved per table via
 * {@link VirtualTableModule.getBackingHost} — presence of that method is the
 * capability (mirrors `getMappingAdvertisements`). The memory module is the
 * default and reference implementation (`vtab/memory/module.ts`).
 *
 * ## Cost contract
 *
 * A backing host MUST provide PK-ordered storage with O(log n) keyed
 * upsert / delete / point-lookup AND an ordered prefix-range scan (seek to a
 * leading-PK equality prefix, walk in PK order, early-terminate when the
 * prefix stops matching). This is what keeps every bounded-delta maintenance
 * arm (`delete-by-prefix` included) and the covering-UNIQUE prefix lookup
 * module-agnostic. A module that cannot provide the ordered prefix scan must
 * NOT advertise the capability — the engine does not gate per maintenance arm.
 *
 * NOTE: this obligation is normative but unenforced — nothing checks it at
 * runtime, so a module advertising the capability without the ordered prefix
 * scan degrades silently (correct results, linear cost). Only the in-tree
 * memory and store hosts implement it today. If third-party backing hosts
 * appear, promote this to a shared conformance suite the module runs against
 * (docs/invariants.md MV-015).
 *
 * ## Effective-change reporting
 *
 * Reporting the EFFECTIVE per-row changes from {@link BackingHost.applyMaintenance}
 * is part of the contract, not an optimization: the MV-over-MV cascade routes
 * each returned {@link BackingRowChange} back through `maintainRowTime`, so
 * over- or under-reporting corrupts consumer MVs. Fidelity cuts both ways: an op
 * that changes nothing — a `delete` of an absent key, a **value-identical
 * `upsert`** (see {@link MaintenanceOp}) — reports nothing, so a no-op maintenance
 * write fires no cascade and, for a change-logged (synced) backing, produces no
 * change-log entry (no echo).
 *
 * ## Transactionality
 *
 * `applyMaintenance` writes the connection's PENDING transaction state;
 * commit/rollback ride the registered {@link VirtualTableConnection}'s
 * `begin/commit/rollback/savepoint` surface (already generic), so the backing
 * delta commits/rolls-back in lockstep with the source write under the
 * Database's coordinated commit.
 *
 * ## Read-only to user DML — engine-owned
 *
 * A maintained table's rows are derived; nothing but the privileged surface may
 * write them. This is enforced by the **engine**, not owed by the host module:
 * the planner rewrites user DML naming a maintained table to **write-through**
 * against the body's base source (the three DML builders' view-mutation dispatch
 * + the resolved-schema backstop), and the runtime DML executor carries a
 * READONLY backstop that rejects any mutation plan whose target still carries a
 * derivation (`runtime/emit/dml-executor.ts` `assertNotMaintainedTableTarget`) —
 * the second net catching a plan-time mis-dispatch before it can silently
 * diverge the derived contents. The privileged surface (`applyMaintenance` /
 * `replaceContents` and the reconcile / rehydrate-refill paths) bypasses both by
 * construction: it never routes through the DML executor. A host module
 * therefore implements no user-DML permission check of its own; direct
 * programmatic `update()` calls on the backing by an embedder are the same trust
 * level as holding this privileged surface and are out of engine scope.
 *
 * ## Constraint validation — split by shape
 *
 * Declared CHECK and child-side FK constraints on a maintained table are
 * per-ROW properties and are validated by the **engine** at the maintenance
 * boundary: the attach core's bulk scan over the reconciled contents
 * (create-fill / attach — `validateDeclaredConstraintsOverContents` in
 * `runtime/emit/materialized-view-helpers.ts`) and the per-row derived-row
 * validator over each maintenance delta (`core/derived-row-validator.ts`,
 * applied by the maintenance manager before the cascade). A host module
 * implements none of that itself.
 *
 * Declared secondary (non-PK) UNIQUE constraints are COLLISION-shaped — a
 * property of a pair of rows under the host's own key/collation machinery —
 * and are enforced by the **host**, exactly where its DML UNIQUE enforcement
 * already lives: after applying an `applyMaintenance` batch, the host checks
 * each written (insert/update) image against the batch's final effective
 * contents for a different-PK row matching the constraint (NULLs distinct,
 * partial predicates honored, per-column collations, conflict action forced to
 * ABORT — a derivation write carries no user OR clause and must never evict),
 * throwing the maintained-table-attributed CONSTRAINT error
 * (`maintainedTableUniqueViolationError`). Post-batch is load-bearing: a
 * `replace-all` diff applies upserts before deletes, so a per-op check would
 * false-positive when the derived set moves a unique value between primary
 * keys. Checking only written images is complete because pre-existing contents
 * already satisfied the constraint (DML / ADD CONSTRAINT enforced it), so any
 * colliding pair includes a written image. See the memory host's
 * `enforceSecondaryUniqueOnMaintenance` (reference) and the store host's
 * `StoreTable.enforceSecondaryUniqueForMaintenance`. `replaceContents` remains
 * validation-free (PK identity aside): create/import (`materializeView`) carries
 * MV-sugar backings, which declare no constraints, and the refresh path
 * (`rebuildBacking`) only calls `replaceContents` when the maintained table
 * declares no applicable CHECK/FK — a constraint-bearing refresh instead routes
 * through `applyMaintenance('replace-all')` + the engine's bulk
 * `validateDeclaredConstraintsOverContents` scan (the stale-refresh
 * re-validation path), so `replaceContents` never has constraints to validate.
 *
 * ## Concurrency
 *
 * The engine adds no latching around the privileged surface: each host owns
 * its own concurrency discipline under the {@link VtabConcurrencyMode} its
 * module declares (the memory host's pending layer is private to the
 * connection and mutated synchronously, so it needs none).
 *
 * ## Replicable-determinism requirement
 *
 * {@link BackingHost.requiresReplicableDerivations} is an **opt-in capability
 * declaration** consumed by the engine **only at create**: a host whose backing
 * replicates across peers (the future sync-store) sets it so the create-time MV
 * gate rejects any non-REPLICABLE **function** OR **collation** in the derivation
 * body — a function not asserted bit-identical across platforms/app-versions (see
 * {@link import('../schema/function.js').BaseFunctionSchema.replicable}), or a
 * custom collation whose sort/fold governs derived bytes (comparison / ORDER BY /
 * GROUP BY / DISTINCT / backing key) without being declared `replicable: true`.
 * Both surfaces can diverge derived bytes across peers' platforms, exactly the
 * hazard this class prevents; built-in functions AND built-in collations
 * (`BINARY`/`NOCASE`/`RTRIM`) auto-qualify. The reference hosts (memory, store)
 * leave it `undefined` ⇒ no requirement ⇒ zero behavior change, so this class is
 * inert by default. It is **not** escapable by `pragma nondeterministic_schema` —
 * that lifts the separate, weaker per-database determinism gate; a replicating
 * host's bit-identity requirement cannot be locally waived without breaking
 * convergence.
 */

import type { Row, SqlValue } from '../common/types.js';
import type { QuereusError } from '../common/errors.js';
import type { VirtualTableConnection } from './connection.js';
import type { BTreeKeyForPrimary } from './memory/types.js';

/**
 * A single row-time-maintenance operation applied to an MV backing table's
 * pending transaction state by {@link BackingHost.applyMaintenance}.
 *
 * - `delete-key` removes the row with this full primary key (no-op if absent).
 * - `upsert` replaces the row sharing this row's PK, or inserts when absent.
 *   **Value-identical suppression (normative).** When the new row is value-identical
 *   to the connection's *effective* existing row at that key (pending state layered
 *   over committed — never committed-only), the host MUST write nothing and report
 *   nothing: nothing changed, so reporting no {@link BackingRowChange} is what the
 *   effective-change contract demands, and it is the echo-prevention seam for
 *   change-logged (synced) backings. Value identity is **byte-faithful** — per-column
 *   `compareSqlValues` under BINARY (`util/comparison.ts` `rowsValueIdentical`):
 *   numeric-storage-class tolerant (bigint `5n` ≡ number `5`) but byte-exact for
 *   text. It is deliberately NOT the column collation: a collation-equal /
 *   byte-different upsert (e.g. a case-only rewrite under a NOCASE column) is a real
 *   change that must replace the stored bytes and report an `update` (the column
 *   collation still governs which existing row the upsert *replaces* — key identity —
 *   just not the skip). This is intentionally narrower than `replace-all`'s wholesale
 *   diff below, whose identical-row skip is collation-aware per its own pinned
 *   semantics (`test/vtab/maintenance-replace-all.spec.ts`).
 * - `delete-by-prefix` removes **every** row whose leading PK columns equal
 *   `keyPrefix` (no-op when nothing matches). It replaces a whole prefix-keyed
 *   *slice* — one base row mapping to many backing rows sharing the base-PK
 *   prefix. The backing storage is ordered by the composite PK with the base-PK
 *   columns leading, so the slice is a contiguous range the scan seeks to and
 *   early-terminates on. The lateral-TVF fan-out arm (`'prefix-delete'`) was its
 *   original consumer but now applies a keyed diff over the same prefix range
 *   (`scanEffective` + point ops), so the engine currently produces no
 *   `delete-by-prefix`; it stays in the contract — implemented by both hosts,
 *   pinned by `test/vtab/maintenance-prefix-delete.spec.ts` — for future
 *   prefix-slice consumers (e.g. a fanning-keyed-join arm).
 * - `replace-all` replaces the backing's **entire** pending-effective contents with
 *   `rows`, realized as the minimal keyed diff (by backing PK) against the current
 *   rows: a new key absent from the old set is an `insert`, a present key whose row
 *   differs is an `update`, an identical row at the same key is skipped (no storage
 *   churn, no emitted change), and an old key absent from the new set is a `delete`.
 *   It is the wholesale, **transactional** backing replacement the full-rebuild MV
 *   arm needs — applied to the *pending* transaction state so it commits/rolls-back
 *   in lockstep with the source write, unlike the
 *   {@link BackingHost.replaceContents} CREATE/REFRESH primitive.
 *
 * The point ops (`delete-key`/`upsert`) keep a one-source-row → one-backing-row
 * delta (covering-index, aggregate-residual); `delete-by-prefix` is the
 * one-source-row → N-backing-rows primitive; `replace-all` is the whole-table
 * primitive — see `docs/mv-maintenance.md` § Maintenance (row-time, per-statement) and
 * `docs/incremental-maintenance.md` § prefix-delete / § replace-all.
 */
export type MaintenanceOp =
	| { kind: 'delete-key'; key: BTreeKeyForPrimary }
	| { kind: 'upsert'; row: Row }
	| { kind: 'delete-by-prefix'; keyPrefix: SqlValue[] }
	| { kind: 'replace-all'; rows: Row[] };

/**
 * The *effective* per-row change {@link BackingHost.applyMaintenance} applied
 * to a backing table's pending state — the same `{ op, oldRow?, newRow? }`
 * shape the row-time maintenance hook already consumes for a source write. The
 * host knows each op's before-image (it looks it up to apply the op), so it
 * reports the realized change without the caller re-reading the backing table.
 *
 * This is what drives the **MV-over-MV cascade**: a backing write to MV `B` is itself
 * a row-write that every MV reading `B`'s backing must see, so the cascade routes each
 * `BackingRowChange` back through `maintainRowTime(B.backingBase, change)`. It is the
 * same shape as the inbound source change by design (unify, don't duplicate) — see
 * `core/database-materialized-views.ts` § cascade. The external-change ingestion
 * seam (`Database.ingestExternalRowChanges`) consumes the same shape.
 *
 * A discriminated union over `op`: an `insert` carries only the new image, a `delete`
 * only the old, an `update` both. The maintenance hook narrows on `op` rather than
 * non-null-asserting `oldRow`/`newRow`, so a mis-paired hook site fails at compile time
 * rather than at runtime.
 */
export type BackingRowChange =
	| { op: 'insert'; oldRow?: undefined; newRow: Row }
	| { op: 'delete'; oldRow: Row; newRow?: undefined }
	| { op: 'update'; oldRow: Row; newRow: Row };

/** Scan request for the reads-own-writes effective-state scan. */
export interface BackingScanRequest {
	/** Leading-PK equality values to seek to (the ordered-PK contract);
	 *  omit for a full scan in PK order. */
	equalityPrefix?: SqlValue[];
	descending?: boolean;
}

/**
 * Privileged per-backing-table surface a backing-host module exposes.
 * Resolved via {@link VirtualTableModule.getBackingHost}; one instance per
 * live backing-table incarnation (a drop+recreate yields a NEW host whose
 * ownsConnection rejects the old incarnation's connections).
 */
export interface BackingHost {
	/** True when `conn` is a live connection to THIS backing-table incarnation. */
	ownsConnection(conn: VirtualTableConnection): boolean;
	/** Fresh connection for the current transaction. The caller registers it
	 *  with the Database so coordinated commit/rollback (savepoint-stack replay
	 *  included) covers its pending state in lockstep with the source write. */
	connect(): VirtualTableConnection;
	/** Privileged ordered op application into `conn`'s pending transaction
	 *  state: bypasses user-DML read-only enforcement, keeps secondary-index /
	 *  change-tracking bookkeeping, and returns the EFFECTIVE per-row changes
	 *  realized (the cascade contract — no-op ops yield nothing: a value-identical
	 *  `upsert` writes nothing and reports nothing, see {@link MaintenanceOp};
	 *  `replace-all` yields the minimal keyed diff). Later reads on `conn`
	 *  (scanEffective, point lookups) must observe the applied ops
	 *  (reads-own-writes). Declared secondary UNIQUE constraints are enforced
	 *  post-batch against the final effective contents, throwing the
	 *  maintained-table-attributed CONSTRAINT error on a collision (see
	 *  § Constraint validation above). */
	applyMaintenance(conn: VirtualTableConnection, ops: readonly MaintenanceOp[]): Promise<BackingRowChange[]>;
	/** Atomically replace the COMMITTED contents with `rows` (create-fill /
	 *  refresh). Throws `onDuplicateKey()` (or a generic CONSTRAINT) on a
	 *  duplicate PK among `rows`. Concurrent readers see pre- or post-swap
	 *  state, never partial. */
	replaceContents(rows: readonly Row[], onDuplicateKey?: () => QuereusError): Promise<void>;
	/** Reads-own-writes scan over `conn`'s effective state (pending transaction
	 *  state layered over committed), in PK order, honoring `equalityPrefix`
	 *  as a seek + early-terminate prefix range. */
	scanEffective(conn: VirtualTableConnection, req: BackingScanRequest): AsyncIterable<Row>;
	/** When true, the engine validates at create that every function AND every
	 *  collation in a materialized-view / derivation body hosted here is REPLICABLE
	 *  (declared bit-identical across peers/platforms/app-versions — builtin
	 *  functions and builtin collations `BINARY`/`NOCASE`/`RTRIM` auto-qualify). A
	 *  host whose backing replicates (the sync-store) demands it so a
	 *  platform-dependent UDF or custom collation cannot diverge peers. The collation
	 *  check covers both the body's fold/order/key sites and the backing key's
	 *  declared collations. Absent/false ⇒ no requirement (memory, store) ⇒ zero
	 *  behavior change. NOT escapable by `pragma nondeterministic_schema` — that
	 *  lifts the per-database determinism gate, a separate and weaker concern; a
	 *  replicating host's bit-identity requirement cannot be locally waived without
	 *  breaking convergence.
	 *
	 *  **Eager-resolution invariant (NORMATIVE).** A host that declares this flag
	 *  MUST resolve via {@link VirtualTableModule.getBackingHost} at
	 *  maintenance-plan-build time — i.e. eagerly, BEFORE any
	 *  {@link VirtualTableModule.ensureBackingForAttach}. The replicable gate runs
	 *  at MV registration (`registerMaterializedView`), which on the
	 *  `alter table … set maintained` attach path fires BEFORE the late-backing seam
	 *  (the attach core resolves the host leniently via `tryResolveBackingHost` there
	 *  and skips the gate when no host resolves — sound ONLY because a demanding host
	 *  resolves eagerly). A host MAY materialize its physical/durable store late, but
	 *  its host *capability surface* — the object carrying this flag — must resolve
	 *  eagerly. Violating this (a host that both defers `getBackingHost` to
	 *  `ensureBackingForAttach` AND demands replicable) would let a non-replicable
	 *  body slip the gate; the attach core's defensive guard
	 *  (`attachMaintainedDerivation` in `runtime/emit/materialized-view-helpers.ts`)
	 *  converts that into a loud INTERNAL error rather than a silent
	 *  convergence-breaking hole. */
	readonly requiresReplicableDerivations?: boolean;
}
