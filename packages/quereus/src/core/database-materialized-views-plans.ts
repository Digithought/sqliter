/**
 * Materialized-view maintenance — plan types and the manager's decoupling context.
 *
 * The tagged {@link MaintenancePlan} union (one arm per maintenance strategy) plus the
 * shared plan shapes, the per-column {@link BackingProjector}, the coarsening-collision
 * watch column, the per-statement {@link BackingConnectionCache}, and the
 * {@link MaterializedViewManagerContext} the manager runs against. Split out of
 * `database-materialized-views.ts` (its class + orchestration) so the type surface reads
 * on its own; see that file and `docs/mv-maintenance.md` for how each arm is built and
 * applied.
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SqlValue, Row } from '../common/types.js';
import type { CollationFunction, CollationResolver } from '../types/logical-type.js';
import type { PrimaryKeyColumnDefinition } from '../schema/table.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';
import type { MaintenanceSourceStats, MaintenanceStrategy } from '../planner/cost/index.js';
import type { AggregateAlgebra, AggregateFunctionSchema } from '../schema/function.js';
import type { AggValue } from '../func/registration.js';
import type { DerivedRowConstraintValidator } from './derived-row-validator.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { VirtualTableConnection } from '../vtab/connection.js';
import type { CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import type { Database } from './database.js';
import type { DatabaseEventEmitter } from './database-events.js';

/**
 * Database internals the materialized-view manager needs. Mirrors
 * `AssertionEvaluatorContext` / `WatcherManagerContext` — keeps the manager
 * decoupled from the full `Database`.
 */
export interface MaterializedViewManagerContext {
	readonly schemaManager: SchemaManager;
	readonly optimizer: Database['optimizer'];

	/** Database event emitter — the row-time collision telemetry channel
	 *  ({@link MaterializedViewManager.detectAndReportCoarseningCollisions}) queues
	 *  {@link MaintenanceCollisionEvent}s here. Already exposed for the transaction
	 *  manager; reused narrowly. */
	getEventEmitter(): DatabaseEventEmitter;

	/** Name→function collation lookup against the owning database's registry (throws on an
	 *  unregistered name). Every collation-aware comparison the manager makes — key identity,
	 *  UNIQUE self-conflict, coarsening-collision divergence — resolves through this, so a
	 *  collation registered with `db.registerCollation(...)` is honored instead of silently
	 *  degrading to byte comparison. */
	getCollationResolver(): CollationResolver;

	/** Mirrors {@link Database._buildPlan} — the manager passes an MV body's
	 *  home-schema path as the third argument (see {@link Database._homeSchemaPath}). */
	_buildPlan: Database['_buildPlan'];
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	/** Backing-connection resolution for row-time write-through (see {@link MaterializedViewManager.getBackingConnection}). */
	getConnectionsForTable(tableName: string): VirtualTableConnection[];
	registerConnection(connection: VirtualTableConnection): Promise<void>;
}

/**
 * A compiled per-MV maintenance plan — how {@link MaterializedViewManager.applyMaintenancePlan}
 * keeps an MV's backing table consistent with a source row-write. A tagged union over
 * the maintenance strategies the incremental substrate names (the spike's
 * `incremental-maintenance-substrate-spike` design). The builder
 * ({@link MaterializedViewManager.buildMaintenancePlan}) produces four bounded-delta arms:
 * `'inverse-projection'` (the covering-index shape), `'residual-recompute'` (single-source
 * aggregates), `'prefix-delete'` (single-source lateral-TVF fan-out), and `'join-residual'`
 * (the provably-1:1 inner join). Only `'inverse-projection'` is applied **per source row,
 * immediately** — its backing is read mid-statement by covering-UNIQUE enforcement, and its
 * delta is a cheap pure projection. The three **residual** arms accumulate their affected
 * binding keys into the per-statement {@link ResidualKeyBatch} (deduped across the
 * statement's changes) and recompute once per distinct key at the end-of-statement flush.
 * The `'full-rebuild'` floor (the always-correct convergence point for bodies no
 * bounded-delta arm fits) is likewise deferred — marked dirty per row and rebuilt once per
 * statement. Both deferred kinds drain at
 * {@link MaterializedViewManager.flushDeferredMaintenance}.
 */
export type MaintenancePlan =
	| InverseProjectionPlan
	| FullRebuildPlan
	| ResidualRecomputePlan
	| PrefixDeletePlan
	| JoinResidualPlan;

/**
 * One backing primary-key column as a {@link MaintenancePlan} sees it: the btree's declared
 * `(index, direction, collation-name)` triple plus the collation *function* the name resolves
 * to, resolved once when the plan is built (`resolveBackingPkColumns`).
 *
 * The name stays for logging and plan equality; the function is what the per-row key
 * comparisons in `database-materialized-views-apply.ts` call, so they never pay a registry
 * lookup — nor silently fall back to byte comparison — per row.
 */
export interface BackingPkColumn extends PrimaryKeyColumnDefinition {
	/** Resolved comparator for {@link collation}; BINARY when the column declares no COLLATE. */
	readonly collationFn: CollationFunction;
}

/**
 * The three **residual** (key-filtered recompute) arms — every {@link MaintenancePlan}
 * kind except `'inverse-projection'` and `'full-rebuild'`. These are the arms the
 * per-statement {@link ResidualKeyBatch} defers: their affected binding keys accumulate
 * (deduped) during the statement's row loop and each distinct key's residual runs once
 * at the end-of-statement flush ({@link MaterializedViewManager.flushDeferredMaintenance}).
 */
export type ResidualMaintenancePlan = ResidualRecomputePlan | PrefixDeletePlan | JoinResidualPlan;

/**
 * Fields shared by the three residual arms. `fullRebuildScheduler` is the per-statement
 * **degrade-to-rebuild escape**: when the statement's distinct affected-key count makes
 * k residual runs cost more than one whole-body rebuild (`shouldDegradeToRebuild` against
 * {@link MaintenancePlanCommon.sourceStats}), the flush runs this scheduler to completion
 * and applies a single `'replace-all'` diff instead — the stored `chosenStrategy` is
 * unchanged, so a later low-cardinality statement naturally reverts to per-key residuals.
 * Compiled once at registration ({@link buildMaintenancePlan}) exactly like the floor's
 * own `bodyScheduler`; optional defensively (an absent scheduler just skips the demotion).
 */
export interface ResidualArmCommon {
	fullRebuildScheduler?: Scheduler;
}

/**
 * Structural subset of the fields the forward (driving-source) residual-recompute
 * apply path reads — shared by the aggregate {@link ResidualRecomputePlan} and the
 * 1:1-join {@link JoinResidualPlan} so both drive {@link applyForwardResidual}
 * unchanged. For an aggregate the forward key is the group key (`'gk'`); for a join
 * it is the driving table `T`'s PK (`'pk'`).
 */
export interface ForwardResidualPlan {
	mv: MaintainedTableSchema;
	backingSchema: string;
	backingTableName: string;
	/** Cached scheduler for the key-filtered residual (the body with `injectKeyFilter`
	 *  applied on the driving source). Re-run per affected key, bound through the live txn. */
	residualScheduler: Scheduler;
	bindParamPrefix: 'gk' | 'pk';
	/** Source-column indices of the forward binding key (group columns / `T`'s PK columns). */
	bindColumns: number[];
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
	backingPkSourceCols: number[];
}

/**
 * How a single backing output column is derived from the changed source row — a pure
 * per-row (per-statement) function. `'passthrough'` copies a source column (the column
 * permutation that *every* PK / UNIQUE-covered column must use, so the backing key and
 * the inverse-projection conflict map are recoverable); `'expr'` evaluates a
 * deterministic scalar expression over the source row (a non-key derived column —
 * `materialized-view-rowtime-expression-projections`). `eval` is the runtime-compiled
 * evaluator (see {@link compileSourceRowEvaluator}), so a computed backing value is
 * exactly what `select <body>` would produce.
 */
export type BackingProjector =
	| { readonly kind: 'passthrough'; readonly sourceCol: number }
	| { readonly kind: 'expr'; readonly eval: (sourceRow: Row) => SqlValue };

/**
 * One **weakened** column of a coarsened backing key K′, precomputed once at
 * registration for the row-time collision telemetry
 * ({@link MaterializedViewManager.detectAndReportCoarseningCollisions}). Carries the
 * backing column index to read from each {@link BackingRowChange} image, the
 * **source** (pre-coarsening, stricter) collation the divergence test compares
 * under, the **output** (coarsened) collation the backing key enforces, and the
 * column name for the {@link MaintenanceCollisionEvent} payload. Derived from
 * `mv.derivation.coarsenedKey.weakened` (column names) via `mv.columnIndexMap`.
 */
export interface CoarseningWatchColumn {
	/** Backing column index (= body output column index) the weakened K′ column lands at. */
	readonly index: number;
	/** Source key enforcement collation (pre-coarsening); the divergence test compares under it. */
	readonly sourceCollation: string;
	/** {@link sourceCollation} resolved against the database registry, once at registration. */
	readonly sourceCollationFn: CollationFunction;
	/** Output (coarsened) collation the backing key enforces. */
	readonly outputCollation: string;
	/** Backing/output column name (for the event payload's `weakenedColumns`). */
	readonly column: string;
}

/**
 * Common identity + cost-gate fields shared by every {@link MaintenancePlan} arm.
 * `chosenStrategy` / `sourceStats` are set once by the create-time cost gate
 * ({@link buildMaintenancePlan}, via `selectMaintenanceStrategy`) and are not
 * re-evaluated per write, except for the per-statement residual → rebuild demotion
 * (`shouldDegradeToRebuild` against the statement's actual distinct-key count, at
 * the end-of-statement flush).
 */
export interface MaintenancePlanCommon {
	/** The MV this plan maintains. */
	mv: MaintainedTableSchema;
	/** Lowercased `schema.table` of the single source `T`. */
	sourceBase: string;
	backingSchema: string;
	backingTableName: string;
	/** Strategy the cost gate chose: argmin `maintenanceCost` over the body's sound strategies. */
	chosenStrategy: MaintenanceStrategy;
	/** Create-time cost inputs (StatsProvider + forward optimizer), retained so the DML
	 *  boundary can re-cost residual vs. rebuild against the actual changeCardinality. */
	sourceStats: MaintenanceSourceStats;
	/** Compiled declared-CHECK/FK validator over derived row images — present ONLY
	 *  when the maintained table declares ≥1 applicable CHECK or ≥1 FK (the
	 *  zero-overhead gate: MV-sugar backings and constraint-less maintained tables
	 *  carry `undefined` and pay nothing per write). Built once at registration
	 *  ({@link MaterializedViewManager.registerMaterializedView}); applied to each
	 *  insert/update {@link BackingRowChange} before the cascade. */
	derivedRowValidator?: DerivedRowConstraintValidator;
	/** Precomputed weakened-K′-column watch list for row-time collision telemetry —
	 *  present ONLY when `mv.derivation.coarsenedKey` is stamped (the zero-overhead
	 *  gate: a provable-key / refining-lineage-key MV carries `undefined` and pays
	 *  nothing per write — detection short-circuits on this field). Built once at
	 *  registration ({@link MaterializedViewManager.registerMaterializedView} →
	 *  {@link MaterializedViewManager.buildCoarseningWatch}); read by
	 *  {@link MaterializedViewManager.detectAndReportCoarseningCollisions} from both
	 *  the bounded-delta and full-rebuild maintenance arms. */
	coarseningWatch?: ReadonlyArray<CoarseningWatchColumn>;
	/** Backing columns that are BOTH declared NOT NULL AND physical-PK members AND whose
	 *  re-derived body output column is nullable — the exact reachable "NOT-NULL
	 *  ordering-seeded PK over a loosened source" skew. Present ONLY when non-empty (the
	 *  zero-overhead gate: nearly every MV carries `undefined` and pays a single boolean
	 *  check per maintained write — the NOT-NULL/physical-PK set alone is non-empty for
	 *  almost every MV, so the discriminator is the body-nullability term). Precomputed once
	 *  at plan build ({@link MaterializedViewManager.buildMaintenancePlan}). Read by the
	 *  row-time guard in {@link MaterializedViewManager.maintainRowTime} /
	 *  {@link MaterializedViewManager.flushDeferredMaintenance}. The refresh path has its own
	 *  materialized-row equivalent (`assertNoNullInNotNullSeededPk` in
	 *  runtime/emit/materialized-view-helpers.ts). See
	 *  fix/bug-mv-rowtime-null-into-notnull-seeded-pk. */
	nullGuardColumns?: ReadonlyArray<{ readonly index: number; readonly name: string }>;
}

export interface InverseProjectionPlan extends MaintenancePlanCommon {
	readonly kind: 'inverse-projection';
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
	/** `projectors[j]` derives backing output column `j` from the changed source row —
	 *  either a passthrough copy of a source column or a deterministic scalar expression
	 *  over the source row. Every PK / backing-key column is `'passthrough'` (eligibility
	 *  rejects a computed column that lands in the backing key); non-key columns may be
	 *  `'expr'`. {@link MaterializedViewManager.lookupCoveringConflicts} reads only the
	 *  passthrough projectors for its inverse (source↔backing) map. */
	projectors: BackingProjector[];
	/** Partial-WHERE predicate evaluated on a single source row; absent ⇒ every row
	 *  is in scope. A source row contributes a backing row only when this is
	 *  unambiguously TRUE (mirrors partial-UNIQUE / partial-index semantics). */
	predicate?: CompiledPredicate;
}

/**
 * The always-correct **floor**: a body for which no bounded-delta arm is sound is
 * maintained by re-evaluating it in full per writing statement and replacing the backing
 * transactionally (a single `'replace-all'` {@link MaintenanceOp} — a keyed diff against
 * the backing's pending layer, so the delta still commits/rolls-back with the source
 * write and still drives the MV-over-MV cascade). The whole optimized body is compiled
 * once at registration into {@link bodyScheduler}; {@link MaterializedViewManager.applyFullRebuild}
 * runs it to completion against live source state and diffs the result into the backing.
 *
 * Reachability: `buildMaintenancePlan` routes a body here whenever no bounded-delta arm
 * fits ({@link MaterializedViewManager.tryBuildBoundedDeltaArm} returns `null`). It is the
 * one **deferred** arm — marked dirty per source row and rebuilt exactly once at the
 * end-of-statement flush ({@link MaterializedViewManager.flushDeferredMaintenance}), so a bulk
 * write is O(body) not O(rows × body). See `docs/mv-maintenance.md` § Full-rebuild floor.
 */
export interface FullRebuildPlan extends MaintenancePlanCommon {
	readonly kind: 'full-rebuild';
	/** The optimized body compiled once at registration — the **whole** body (no
	 *  `injectKeyFilter`), with the read-side MV rewrite suppressed so it reads its sources,
	 *  not the backing it populates. Re-run to completion per writing statement, bound
	 *  through the live transaction (reads-own-writes), to recompute every backing row. */
	bodyScheduler: Scheduler;
	/** Every source base (lowercased `schema.table`) the body reads — set-op legs, every
	 *  join source, etc. The plan is indexed under each in `rowTimeBySource` (via
	 *  {@link planSourceBases}), so a write to **any** of them triggers a rebuild; missing
	 *  one would leave the MV stale on that source's writes. `sourceBase` (the
	 *  {@link MaintenancePlanCommon} field) holds the first of these for parity. */
	sourceBases: string[];
}

/**
 * The general-body residual-recompute arm: per source change, derive the affected
 * binding key(s) from the changed row, run a key-filtered residual of the body against
 * **live mid-transaction source state**, and apply the keyed diff — upsert the recomputed
 * slice (replacing the old row at the same backing key; a value-identical recompute is
 * suppressed by the host, see vtab/backing-host.ts) or, when the residual returns
 * nothing, delete the emptied key. Wired for the **single-source aggregate** shape
 * (`select g1,… , agg(…) from T [where P] group by g1,…` over bare group columns) by
 * `materialized-view-rowtime-residual-recompute`; the 1:1 row-preserving join shape
 * (`'row'` binding) reuses the same kernel in a follow-on ticket.
 *
 * The residual is the body with a key-equality filter injected on `T`'s
 * `TableReferenceNode` via {@link injectKeyFilter} (parameterized `gk0…` for a group
 * binding, `pk0…` for a row binding), compiled + cached once at registration and run
 * synchronously through the live transaction so the source read is reads-own-writes —
 * the synchronous analogue of `database-assertions.ts`'s residual path.
 *
 * It carries the {@link BindingMode} the spike names as the convergence point (built
 * directly from the body's shape — for an aggregate, the bare GROUP BY columns; NOT
 * via `extractBindings`, whose `'group'` classification additionally requires the group
 * key to cover a source unique key and so reports `'global'` for the common
 * `group by <non-key>` body). The per-statement rebuild demotion rides
 * {@link ResidualArmCommon.fullRebuildScheduler}.
 */
export interface ResidualRecomputePlan extends MaintenancePlanCommon, ResidualArmCommon {
	readonly kind: 'residual-recompute';
	binding: BindingMode;
	/** Delta-aggregate fast path descriptor — present iff EVERY stored aggregate column
	 *  passed the create-time delta eligibility gate ({@link buildDeltaAggregateDescriptor}
	 *  in database-materialized-views-plan-builders.ts). When present, the statement
	 *  accumulation folds per-column accumulator deltas alongside the residual keys and
	 *  the flush maintains each affected group by pure arithmetic on the stored backing
	 *  row (`merge` on insert, `merge(negate(…))` on delete) with zero source reads —
	 *  falling back to the residual per group only where the declared algebra cannot
	 *  prove a retraction observational (see {@link DeltaAggregateColumn.retractionSafe}).
	 *  Absent ⇒ the arm behaves exactly as before (key-filtered residual re-execution).
	 *  The plan `kind` stays `'residual-recompute'` either way; `chosenStrategy` records
	 *  `'delta-aggregate'` when the descriptor is active (cost-strategy decoupling, the
	 *  same pattern as `'prefix-delete'`). */
	delta?: DeltaAggregateDescriptor;
	/** Cached scheduler for the key-filtered residual (the body with `injectKeyFilter`
	 *  applied on `T`). Re-run per affected key tuple, bound through the live transaction. */
	residualScheduler: Scheduler;
	/** Bind-parameter prefix the residual was compiled with: `'gk'` (group) / `'pk'` (row). */
	bindParamPrefix: 'gk' | 'pk';
	/** Source-column indices of the binding key (group columns / row key columns). The
	 *  affected key tuple is `bindColumns.map(c => changedRow[c])`, bound to `${prefix}{i}`. */
	bindColumns: number[];
	/** Backing-table physical primary-key definition (the column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
	/** Source column projected (passthrough) into each backing-PK column, in
	 *  `backingPkDefinition` order. The old backing slice's delete key for a changed row
	 *  `R` is `buildPrimaryKeyFromValues(backingPkSourceCols.map(sc => R[sc]), backingPkDefinition)`. */
	backingPkSourceCols: number[];
}

/**
 * The single-source lateral-TVF fan-out arm: a body of the shape
 * `select T.pk…, …, f.* from T cross join lateral tvf(<args over T>) f`, where each base
 * row of `T` fans out to **N** backing rows (one per row the TVF emits for it). The
 * backing PK is the **composite product key** `(T.pk ∪ tvf-key)` that
 * `optimizer-keyed-cross-product-join-keys` advertises through `keysOf` over the lateral
 * join, with the base PK as its **leading prefix** (asserted at build).
 *
 * Per changed base row, maintenance is a **keyed diff of the recomputed fan-out against
 * the existing effective slice for the base-PK prefix** (read via the host's
 * `scanEffective`, since one base row owns many backing rows sharing the prefix): re-run
 * the TVF fan-out **residual** for that base row, delete only the existing keys the
 * recompute no longer produces, and **upsert** each recomputed row (value-identical
 * upserts are suppressed by the host). An UPDATE diffs both the OLD and NEW base keys
 * (the base PK may move); a DELETE diffs the old slice to all-deletes; an INSERT diffs
 * against an empty slice. This reuses the residual kernel of {@link ResidualRecomputePlan}
 * unchanged — the affected-key derivation, the `injectKeyFilter` residual (pinned to the
 * base `TableReferenceNode` with the `'pk'` prefix), reads-own-writes execution, the cost
 * gate — and differs only in the **prefix-slice** diff (vs point-key) and the **N-row**
 * residual (vs ≤1). The body's WHERE, if any, is part of the residual (so an out-of-scope
 * base row fans out to zero rows), exactly as in the aggregate arm.
 *
 * `chosenStrategy` is `'residual-recompute'` (the shared key-filtered re-execution cost
 * shape — the fan-out factor is unknown at create); `kind` is `'prefix-delete'` (the
 * apply-arm dispatcher).
 */
export interface PrefixDeletePlan extends MaintenancePlanCommon, ResidualArmCommon {
	readonly kind: 'prefix-delete';
	/** Substrate parity (the base-PK 'row' binding); unread by the apply path, which uses
	 *  `bindColumns` / `backingPrefixSourceCols`. */
	binding: BindingMode;
	/** Cached scheduler for the base-PK-keyed residual (the body with `injectKeyFilter`
	 *  applied on `T`, `'pk'` prefix). Re-run per affected base key; fans out to N rows. */
	residualScheduler: Scheduler;
	bindParamPrefix: 'pk';
	/** Source-`T` PK column indices (the base key). The affected key tuple is
	 *  `bindColumns.map(c => changedRow[c])`, bound to `pk{i}`. */
	bindColumns: number[];
	/** Full backing-table physical primary key (base-PK prefix ++ TVF-key tail). */
	backingPkDefinition: ReadonlyArray<BackingPkColumn>;
	/** Number of leading backing-PK columns that form the base-PK prefix (= `bindColumns.length`). */
	basePrefixLength: number;
	/** Source-`T` column projected into each leading (base-prefix) backing-PK column, in
	 *  backing-PK order. The by-prefix delete key for a changed row `R` is
	 *  `backingPrefixSourceCols.map(sc => R[sc])`. */
	backingPrefixSourceCols: number[];
}

/**
 * The 1:1 row-preserving **inner/cross join** arm: a body
 * `select … from T join P on T.fk = P.id` where `T` contributes **exactly one** MV row
 * per governed `T` row (proven by {@link proveOneToOneJoin} — no row loss via NOT-NULL
 * FK→PK referential integrity, no fan-out via `isUnique(T.pk)` at the join frame). The
 * backing is keyed on `T`'s PK (the composite product key `keysOf` advertises across the
 * 1:1 join collapses to `T`'s PK), so each changed `T` row maps to one backing row.
 *
 * Reuses the residual kernel of {@link ResidualRecomputePlan} on its **driving (`T`)**
 * side via {@link ForwardResidualPlan}: a `T`-keyed (`'pk'`) residual recomputes the one
 * joined row for a changed `T` row (run residual → upsert the recomputed row, or delete
 * the key when it returns nothing), identical to a `'row'`-binding aggregate of size 1.
 * `applyForwardResidual` drives it.
 *
 * The **lookup (`P`)** side is the join arm's distinct problem: the MV's `sourceTables`
 * includes `P`, so a write to `P` also fires maintenance, but the forward residual is
 * keyed on `T`'s PK and a `P` row joins *many* `T` rows. This plan therefore carries a
 * **second residual keyed on `P`'s PK** (`lookupResidualScheduler`): for a `P` change it
 * runs `… where P.pk = :pk0` (the body **including** its WHERE) against live state,
 * returning every currently in-scope joined row (each carrying its `T.pk` backing key), and
 * **upserts** each.
 *
 * **WHERE handling — bounded-delta over a partial-WHERE 1:1 join.** A body WHERE is
 * classified at build by which base table(s) its columns reference
 * ({@link MaterializedViewManager.buildJoinResidualPlan}):
 *  - **`T`-only predicate** — no extra machinery. The forward (`T`) residual already injects
 *    + applies the WHERE (an out-of-scope `T` row recomputes to zero residual rows ⇒ its
 *    delete-without-upsert removes the backing row), and a `T`-column predicate cannot move
 *    the membership set `{ T : T.fk = P.pk }`, so the lookup side stays **upsert-only**
 *    (`lookupMembershipResidualScheduler` absent) — sound for the same reason the no-WHERE
 *    arm is.
 *  - **`P`-referencing predicate** (or both sides) — a `P` write can flip a row's WHERE truth
 *    and so add/remove a backing row, which upsert-only could never delete. The lookup side
 *    becomes **delete-capable**: `lookupMembershipResidualScheduler` is the body with
 *    `injectKeyFilter` on `P` but the WHERE **stripped** (membership only). Per affected `P`
 *    key {@link MaterializedViewManager.applyLookupResidual} diffs it against the in-scope
 *    `lookupResidualScheduler` (WHERE retained): membership keys the in-scope recompute no
 *    longer produces are deleted, the in-scope rows are upserted — a keyed diff that converges
 *    the membership both ways without churning the unchanged rows.
 *
 * Still inner/cross only; outer joins and **fanning** (non-1:1) joins continue to fall to the
 * full-rebuild floor. See `docs/incremental-maintenance.md` § join-residual and the soundness
 * note in {@link MaterializedViewManager.applyLookupResidual}.
 */
export interface JoinResidualPlan extends MaintenancePlanCommon, ForwardResidualPlan, ResidualArmCommon {
	readonly kind: 'join-residual';
	/** Substrate parity: the driving `T`'s `'row'`/PK binding. */
	binding: BindingMode;
	bindParamPrefix: 'pk';
	/** Lowercased `schema.table` of the lookup source `P` (distinct from `sourceBase` = `T`). */
	lookupBase: string;
	/** Cached scheduler for the in-scope lookup-keyed residual (the body — WHERE **retained** —
	 *  with `injectKeyFilter` applied on `P`, `'pk'` prefix). Re-run per affected `P` key;
	 *  returns the currently in-scope joined rows to upsert. */
	lookupResidualScheduler: Scheduler;
	/** Delete-capable lookup membership residual (the body with the WHERE **stripped** and
	 *  `injectKeyFilter` on `P`). Present **iff** the body WHERE references `P`: the lookup side
	 *  must then delete the backing key of every currently-referencing `T` row (regardless of
	 *  scope) before re-upserting the in-scope survivors, so a `P` write that flips a row's WHERE
	 *  membership adds/removes its backing row. Absent for a no-WHERE or `T`-only-WHERE body
	 *  (the lookup side is sound upsert-only — membership cannot move on a `P` write). */
	lookupMembershipResidualScheduler?: Scheduler;
	/** Source-`P` PK column indices (the lookup key). The affected key tuple for a `P`
	 *  change is `lookupBindColumns.map(c => changedRow[c])`, bound to `pk{i}`. */
	lookupBindColumns: number[];
	lookupBindParamPrefix: 'pk';
}

/**
 * Per-statement cache of resolved backing {@link VirtualTableConnection}s, keyed by the
 * lowercased backing `schema.table`. Created **once per DML generator run** (one
 * statement) and threaded through the maintenance path so the backing-connection
 * resolution — a scan over *all* the Database's active connections in
 * {@link MaterializedViewManager.getBackingConnection} — is paid once per
 * (statement, backing) instead of once per source row. This amortizes the dominant
 * per-row overhead of a bulk `insert`/`update`/`delete` over a covered table.
 *
 * It is purely a resolution cache: the `'inverse-projection'` arm's per-row ops are still
 * applied **immediately** to the cached connection's pending transaction layer, so a later
 * same-statement row's enforcement scan (`lookupCoveringConflicts`) still observes every
 * earlier row's backing write. The **residual** arms and the **full-rebuild** floor are
 * instead deferred to a single end-of-statement
 * {@link MaterializedViewManager.flushDeferredMaintenance} (tracked in the per-statement
 * {@link ResidualKeyBatch} / dirty set, not this cache) — sound because only an
 * inverse-projection MV can serve as a covering structure, so no enforcement scan depends
 * on a deferred arm's per-row visibility. See `docs/mv-maintenance.md` § Synchronous,
 * transactional, per-statement. Because the cache is scoped to one generator run, the
 * connection it holds cannot be torn down mid-statement; the cold enforcement/eviction
 * paths that omit the cache re-resolve the *same* connection deterministically, so
 * reads-own-writes is unaffected.
 */
export type BackingConnectionCache = Map<string, VirtualTableConnection>;

/**
 * One deduped **forward** (driving-source) affected binding key, as
 * `applyForwardResidual` derives it from a changed source row: `keyTuple` binds the
 * key-filtered residual's parameters, `keyVals` are the backing-PK values (in
 * `backingPkDefinition` order) the recomputed slice is matched on, and `deleteKey` is the
 * prebuilt point-delete key for an emptied slice. Deduped on `canonKeyValues(keyVals)`.
 */
export interface ForwardResidualKey {
	keyTuple: SqlValue[];
	keyVals: SqlValue[];
	deleteKey: BTreeKeyForPrimary;
}

/**
 * One deduped affected **base** key of a `'prefix-delete'` fan-out plan: `keyTuple` binds
 * the base-PK-keyed residual, `prefix` is the slice's leading-backing-PK equality key.
 * Deduped on `canonKeyValues(keyTuple)`.
 */
export interface PrefixDeleteKey {
	keyTuple: SqlValue[];
	prefix: SqlValue[];
}

/**
 * One stored aggregate output column of a delta-maintained aggregate MV, resolved once
 * at plan build from the aggregate call node's registry-resolved function schema. The
 * engine consumes ONLY the declared {@link AggregateAlgebra} plus the schema's
 * step/finalize/initialValue — never an aggregate-name list (docs/invariants.md).
 */
export interface DeltaAggregateColumn {
	/** Backing column index (= body output column index) this aggregate lands at. */
	readonly backingCol: number;
	/** The registry-resolved aggregate schema — carries step/finalize/initialValue —
	 *  bound at plan build to the argument column's comparison context
	 *  (`bindAggregateSchema`), so a comparison-sensitive aggregate (min/max) steps
	 *  and merges by the argument's semantic order, matching direct evaluation. */
	readonly schema: AggregateFunctionSchema;
	/** `schema.algebra` (bound, see above), narrowed: `merge` + `decode` always;
	 *  `negate` for a `'group'` column (absent for a `'tighten'` column). */
	readonly algebra: AggregateAlgebra;
	/** Delta maintenance class this column belongs to:
	 *  - `'group'`: an abelian-group aggregate (count/sum — `merge` + `negate` + `decode`).
	 *    Inserts and deletes both fold arithmetically (`merge` / `merge(negate(…))`).
	 *  - `'tighten'`: a join-semilattice aggregate (min/max, `bit_or`/`bool_or` — `merge`,
	 *    `decode`, but **no** `negate`). An insert `merge`s the new value in cheaply
	 *    (min/max tighten toward the new extreme); a retraction cannot be undone
	 *    arithmetically, so a retracted group falls back to the residual (its
	 *    {@link retractionSafe} is always false, and {@link DeltaAggregateDescriptor.hasTighten}
	 *    routes the whole group to the residual whether or not a row is stored). */
	readonly deltaClass: 'group' | 'tighten';
	/** Source column feeding `step()`; `undefined` for a zero-arg (count(*)-shaped) call. */
	readonly argSourceCol: number | undefined;
	/** True iff this is the zero-arg multiplicity witness (count(*)): its finalized value
	 *  counts the group's rows, so 0 ⇔ the group emptied (delete the backing row). */
	readonly isMultiplicity: boolean;
	/** True when a RETRACTION may be applied through `decode` of the stored value:
	 *  either the algebra declares `decodeExact` (decode is a full inverse), or the
	 *  argument column is declared NOT NULL — then every surviving row contributes, so
	 *  the true contribution count equals the multiplicity and stays positive while the
	 *  backing row exists (sum's absorbing decode witness never spuriously empties).
	 *  A group that accumulated a retraction while ANY column is not retraction-safe is
	 *  re-derived by the residual at flush instead of trusting the arithmetic. A
	 *  `'tighten'` column is never retraction-safe. */
	readonly retractionSafe: boolean;
}

/**
 * The **decomposition-maintained** class of stored aggregate column (the `avg` class):
 * a column whose value is a scalar `combine` over sibling partial aggregates that are
 * THEMSELVES stored, delta-maintained columns of the same MV body — `avg(x) ≡
 * sum(x)/count(x)`, and any UDAF declaring {@link AggregateAlgebra.decompose}. It carries
 * NO independent accumulator (it is derived): at flush its value is
 * `combine([finalized(partial) …])` over its partials' freshly finalized values. Resolved
 * once at plan build (`buildDeltaAggregateDescriptor` — the create-time gate that binds
 * each partial to a stored sibling) and evaluated per affected group at flush
 * ({@link computeDeltaAggregateOps}). `avg` is the first client, not a special case.
 */
export interface DeltaDecomposeColumn {
	/** Backing column index (= body output column index) this decomposed aggregate lands at. */
	readonly backingCol: number;
	/** Index into {@link DeltaAggregateDescriptor.aggColumns} of each partial, in
	 *  `decompose.partials` order — the finalized partial values `combine` consumes. Two
	 *  decompose columns sharing a partial name the same index (the partial is maintained
	 *  once, read by both). */
	readonly partialIndices: readonly number[];
	/** `algebra.decompose.combine`: builds this column's finalized value from its partials'
	 *  finalized values, in `partialIndices` order. Reproduces the aggregate's own finalize
	 *  incl. the empty-group / divide-by-zero case (avg → count 0/NULL ⇒ NULL). */
	readonly combine: (partialValues: readonly SqlValue[]) => SqlValue;
}

/**
 * Create-time descriptor for the delta-aggregate fast path inside a
 * `'residual-recompute'` plan — see {@link ResidualRecomputePlan.delta}. Built by
 * `buildDeltaAggregateDescriptor` only when every stored column qualifies; any gate
 * failure leaves the plan on the plain residual (never an error).
 */
export interface DeltaAggregateDescriptor {
	/** The stored, independently-accumulated aggregate output columns (one per delta-
	 *  maintainable aggregate the body projects). A {@link DeltaDecomposeColumn}'s partials
	 *  are entries here; the decompose column itself is not (it accumulates nothing). */
	readonly aggColumns: readonly DeltaAggregateColumn[];
	/** Decomposition-maintained columns (the `avg` class): each derived at flush from its
	 *  sibling stored partials via `combine`, contributing no independent accumulation.
	 *  Empty for a body with no decompose column. See {@link DeltaDecomposeColumn}. */
	readonly decomposeColumns: readonly DeltaDecomposeColumn[];
	/** Non-aggregate (group-key passthrough) backing columns: each copies the group's
	 *  backing-PK value at position `pkPos` (in `backingPkDefinition` order) into
	 *  backing column `backingCol` — covers a group column projected outside the PK
	 *  (e.g. a duplicate projection of a group column). */
	readonly groupColumns: ReadonlyArray<{ readonly backingCol: number; readonly pkPos: number }>;
	/** Index into {@link aggColumns} of the count(*) multiplicity witness. */
	readonly multiplicityIndex: number;
	/** Total backing column count (the upsert row width). */
	readonly backingColumnCount: number;
	/** True iff every {@link DeltaAggregateColumn.retractionSafe}; when false, a group
	 *  whose statement delta contains any retraction falls back to the residual. */
	readonly retractionSafe: boolean;
	/** True iff any {@link DeltaAggregateColumn} is `'tighten'` (min/max — `merge`, no
	 *  `negate`). Such a column cannot retract arithmetically, so a group that accumulated
	 *  ANY retraction re-derives from the residual whether or not a row is stored (unlike a
	 *  merely not-retraction-safe abelian column, whose no-stored net-fold stays exact). A
	 *  purely group-column descriptor (`false`) never takes the tighten fallback branch. */
	readonly hasTighten: boolean;
	/** Compiled single-source-row body WHERE; a row whose predicate is not
	 *  unambiguously TRUE contributes nothing (mirrors the inverse-projection arm).
	 *  Absent ⇒ every row is in scope. */
	readonly predicate?: CompiledPredicate;
}

/**
 * Per-group accumulated statement delta for a delta-aggregate MV — the value side of
 * {@link ResidualKeyBatchEntry.delta}, keyed (like `forward`) on
 * `canonKeyValues(keyVals)` so the two maps pair up at flush.
 */
export interface DeltaGroupState {
	/** Backing-PK (group key) values, in `backingPkDefinition` order. */
	readonly keyVals: SqlValue[];
	/** Prebuilt point-delete key for an emptied group. */
	readonly deleteKey: BTreeKeyForPrimary;
	/** Net accumulator delta per aggregate column (descriptor `aggColumns` order),
	 *  folded across the statement: `merge`d `step` contributions for inserts,
	 *  `merge`d `negate(step(…))` contributions for deletes. */
	readonly accs: AggValue[];
	/** True once any retraction (delete / update-old-image) contributed — the flush
	 *  falls back to the residual for this group when the descriptor is not
	 *  retraction-safe and a stored row exists. */
	retracted: boolean;
}

/**
 * The per-statement key accumulation for one residual-arm MV — which distinct binding
 * keys this statement's source changes affected, per residual variant. `forward` holds
 * driving-source keys (`'residual-recompute'` group keys; `'join-residual'` `T`-PK keys),
 * `lookup` holds a `'join-residual'` plan's lookup-side (`P`-PK) keys (which run the
 * reverse residual variant at flush), and `prefix` holds a `'prefix-delete'` plan's base
 * keys. Exactly one map is populated for the single-variant arms; a `'join-residual'` MV
 * may accumulate `forward` and `lookup` in one statement (e.g. an FK cascade writing both
 * sides). Each map is keyed on the canonical key bytes (`canonKeyValues`) — the same
 * dedup the per-row appliers do within one change, extended across the whole statement.
 */
export interface ResidualKeyBatchEntry {
	forward: Map<string, ForwardResidualKey>;
	lookup: Map<string, SqlValue[]>;
	prefix: Map<string, PrefixDeleteKey>;
	/** Delta-aggregate accumulation, keyed like `forward` on the canonical group-key
	 *  bytes. Populated ONLY alongside `forward` (the residual keys are always
	 *  accumulated too), so dropping it — {@link deltaPoisoned} — degrades the flush to
	 *  the plain residual with zero information loss. */
	delta?: Map<string, DeltaGroupState>;
	/** Set when a per-row savepoint revert (OR FAIL) invalidated the accumulated
	 *  deltas: the savepoint undid the failing row's source/backing writes, but a JS
	 *  accumulation cannot be unwound, so the net deltas may include a reverted row's
	 *  contribution. The residual keys stay valid (a reverted key recomputes to a
	 *  value-identical row, suppressed), so the flush routes through them instead.
	 *  See `poisonResidualDeltaAccumulations`. */
	deltaPoisoned?: boolean;
}

/**
 * Per-statement deferred-residual key batch, keyed by MV key (lowercased
 * `schema.name`). Created once per DML generator run alongside the
 * {@link BackingConnectionCache} and the deferred full-rebuild set; the residual arms
 * accumulate their affected keys here during the row loop
 * ({@link MaterializedViewManager.maintainRowTime}) and each MV's distinct keys are
 * recomputed exactly once at the end-of-statement
 * {@link MaterializedViewManager.flushDeferredMaintenance}. Owned by the statement:
 * discarded with the statement-savepoint unwind on failure, never carried across
 * statements.
 */
export type ResidualKeyBatch = Map<string, ResidualKeyBatchEntry>;
