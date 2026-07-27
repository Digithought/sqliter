/**
 * Materialized-view maintenance — **plan builders**. The cost-gated builder that compiles
 * an MV body into a {@link MaintenancePlan} (the bounded-delta arms plus the full-rebuild
 * floor) and the residual-compile / source-stats helpers they share. Extracted from
 * database-materialized-views.ts as free functions over {@link MaterializedViewManagerContext};
 * the sole caller in the manager is `registerMaterializedView` → {@link buildMaintenancePlan}.
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { BlockNode } from '../planner/nodes/block.js';
import { type PlanNode, type RowDescriptor, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { AggregateFunctionCallNode } from '../planner/nodes/aggregate-function.js';
import { isAggregateFunctionSchema } from '../schema/function.js';
import type { AggregateDecomposition } from '../schema/function.js';
import { bindAggregateSchema } from '../func/registration.js';
import { PhysicalType, type LogicalType } from '../types/logical-type.js';
import { checkDeterministic } from '../planner/validation/determinism-validator.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { Scheduler } from '../runtime/scheduler.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
import { keysOf } from '../planner/util/fd-utils.js';
import { deriveCoarsenedBackingKey, resolveValuePreservingSourceCol } from '../planner/analysis/coarsened-key.js';
import { proveOneToOneJoin } from '../planner/analysis/coverage-prover.js';
import { CapabilityDetectors } from '../planner/framework/characteristics.js';
import {
	selectMaintenanceStrategy,
	isFullRebuildPathological,
	seqScanCost,
	filterCost,
	projectCost,
	type MaintenanceSourceStats,
	type MaintenanceStrategy,
} from '../planner/cost/index.js';
import { tryResolveBackingHost } from '../runtime/emit/materialized-view-helpers.js';
import { compilePredicate, type CompiledPredicate } from '../vtab/memory/utils/predicate.js';
import type { MaintainedTableSchema } from '../schema/derivation.js';
import type { TableSchema } from '../schema/table.js';
import type { Database } from './database.js';
import type * as AST from '../parser/ast.js';
import {
	findNonReplicableFunction,
	findNonReplicableCollation,
	findNonDeterministic,
	normalizeCollation,
	isBinaryCollation,
	findAggregate,
	containsNodeType,
	containsAnyJoin,
	countNodeType,
	countJoins,
	findTableFunctionCall,
	collectTableRefs,
	collectProducingExprs,
	resolveTransitiveSourceCol,
	bodyWhereReferencesLookup,
	bodyWhereIsNonDeterministic,
	relationalAttributes,
	rootRelationalNode,
	cannotMaterialize,
	nonReplicableDerivationError,
	nonReplicableCollationDerivationError,
	isSingleRowEvaluable,
	compileSourceRowEvaluator,
	type AggregateLike,
} from './database-materialized-views-analysis.js';
import type {
	MaterializedViewManagerContext,
	MaintenancePlan,
	FullRebuildPlan,
	BackingProjector,
	BackingPkColumn,
	DeltaAggregateColumn,
	DeltaAggregateDescriptor,
	DeltaDecomposeColumn,
} from './database-materialized-views-plans.js';
import type { CollationResolver } from '../types/logical-type.js';
import { BINARY_COLLATION } from '../util/comparison.js';

/** Fallback source row estimate when the StatsProvider has no count (mirrors the
 *  optimizer's naive default). Only feeds the create-time maintenance cost gate. */
const DEFAULT_SOURCE_ROWS = 1000;

/** Create-time estimate of the fraction of changes to a **tighten-only** (min/max) delta
 *  aggregate that retract (a delete / update-old-image) and so re-derive their group from
 *  the key-filtered residual instead of pure arithmetic. Feeds the `'delta-aggregate'` cost
 *  blend ({@link maintenanceCost}); kept well below 1 so an insert-dominated body still
 *  prefers the delta arm, yet non-zero so a tighten body costs more than a pure-group one. */
const DELTA_TIGHTEN_FALLBACK_RATIO = 0.25;

/**
 * Snapshot a backing table's physical primary key as the maintenance plans consume it: the
 * declared `(index, desc, collation)` triple plus the collation comparator that name resolves
 * to on this database. Every arm builds its `backingPkDefinition` through here, so the per-row
 * key comparisons in `database-materialized-views-apply.ts` never do a registry lookup — and
 * never silently degrade a custom collation to byte order.
 *
 * NOTE: this freezes the comparator into the plan. Re-registering a collation name with
 * `db.registerCollation(...)` after the plan was built leaves the plan on the old comparator
 * until the MV is re-registered — which any schema change does, but a bare `registerCollation`
 * does not. Same exposure as index comparators, which resolve once at table open; if that ever
 * needs fixing, fix it for both.
 *
 * NOTE: `resolver` throws on an unregistered collation name. Unreachable today — the memory
 * module rejects the backing `create` first — so this never converts a working `create
 * materialized view` into an error. If a backing host is ever added that tolerates an
 * unregistered name on a key column, this becomes the first site to throw, at plan-build time.
 */
function resolveBackingPkColumns(backing: TableSchema, resolver: CollationResolver): BackingPkColumn[] {
	return backing.primaryKeyDefinition.map(d => ({
		index: d.index,
		desc: d.desc,
		collation: d.collation,
		collationFn: d.collation ? resolver(d.collation) : BINARY_COLLATION,
	}));
}

/**
 * Build the row-time maintenance plan for an MV — **cost-gated, with a floor, never a
 * shape allowlist**. The builder tries to match a bounded-delta arm by shape
 * ({@link tryBuildBoundedDeltaArm}); a body that matches **none** falls through to the
 * always-correct {@link buildFullRebuildPlan} floor (re-evaluate the whole body, replace
 * the backing transactionally). **No body is rejected for its shape.** Only five
 * create-time rejections remain, all non-shape (docs/invariants.md MV-006):
 *  - a **non-deterministic** body without `pragma nondeterministic_schema` — a hard reject
 *    in the matched arm (so the arm-specific determinism diagnostic survives) or, for a
 *    body matching no arm, in the floor's whole-body determinism check;
 *  - a **bag** (no provable unique key) — the floor's `keysOf` reject (a duplicate-producing
 *    body usually fails the set contract earlier, at create-fill);
 *  - a body with **no relational output**;
 *  - a body that **reads no source table** (`select 42`) — the floor's `sourceBases` reject;
 *    there is no source to index the plan under and no write that could dirty it;
 *  - a **full-rebuild-only body over a source past the size threshold**
 *    ({@link isFullRebuildPathological}, the `materialized_view_rebuild_row_threshold` option).
 *
 * The single source may itself be another MV's backing table (an MV-over-MV body):
 * `building/select.ts` rewrites a reference to `mv1` into a `TableReference` against
 * `mv1`'s backing table, so the source base is `mv1`'s backing base and the same checks
 * evaluate against the (keyed `memory`) backing schema unchanged. A write to `mv1` then
 * drives `mv2` via the cascade in {@link maintainRowTime}.
 *
 * Eligibility is a *cost choice* among the body's structurally-sound strategies
 * ({@link selectMaintenanceStrategy}): the bounded-delta arms are preferred by the argmin
 * cost gate, and full-rebuild is selected exactly when no bounded-delta arm is sound (an
 * empty sound set resolves to the floor) — so an existing eligible shape is unaffected.
 */
export function buildMaintenancePlan(ctx: MaterializedViewManagerContext, mv: MaintainedTableSchema): MaintenancePlan {
	const db = ctx as unknown as Database;
	// Analyze the MV's own body to compile maintenance; suppress the read-side
	// rewrite so the body stays over its SOURCE table, not re-pointed at this
	// MV's backing (which the maintenance plan is what keeps consistent).
	const analyzed = db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
		const { plan } = ctx._buildPlan([mv.derivation.selectAst as AST.Statement]);
		return ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;
	});

	// Replicable-determinism gate — host-conditional, inert by default. A backing host
	// whose backing replicates across peers (the sync-store) sets
	// `requiresReplicableDerivations` so a platform-dependent UDF or collation cannot
	// diverge peers. Checked here — after `analyzed`, before arm selection — so it applies
	// regardless of which maintenance arm wins, over the SAME analyzed plan the determinism
	// gate walks (nested calls, WHERE / GROUP BY / aggregate-arg / TVF-arg positions all
	// reached). It sits NEXT TO, not in place of, the determinism gate: the two are
	// orthogonal, so this is NOT lifted by `pragma nondeterministic_schema`. A memory/store
	// host leaves the flag undefined ⇒ this block is skipped ⇒ zero behavior change.
	// Idempotent (same body ⇒ same verdict), so it is also desirable on re-register /
	// catalog import: a tampered catalog cannot smuggle a non-replicable body past a
	// demanding host. Two gates of the same shape: a non-replicable FUNCTION (which the
	// body walk's function-bearing nodes carry) and a non-replicable COLLATION (which rides
	// each scalar node's resolved type plus the backing key's declared collations).
	// Resolve the host LENIENTLY: at the create-time gate registration of an
	// `alter table … set maintained` attach, a module that materializes its durable
	// backing late (lamina's `ensureBackingForAttach`, after this gate) has no host
	// yet. The host is used here ONLY for the host-conditional, default-inert
	// `requiresReplicableDerivations` gate — a host that sets it (the synced-store
	// flavor) always exists by plan-build time, so skipping the gate when the host
	// is absent never lets a non-replicable body slip past. The reconcile resolves
	// the host for real, and the maintenance arms re-resolve it per use.
	const host = tryResolveBackingHost(db, mv);
	if (host?.requiresReplicableDerivations) {
		const offendingFn = findNonReplicableFunction(analyzed);
		if (offendingFn) throw nonReplicableDerivationError(mv.name, offendingFn);
		const offendingCollation = findNonReplicableCollation(analyzed, mv, db);
		if (offendingCollation) throw nonReplicableCollationDerivationError(mv.name, offendingCollation);
	}

	// Try a bounded-delta arm; a shape that fits none falls through to the floor.
	const boundedDelta = tryBuildBoundedDeltaArm(ctx, mv, analyzed);
	// A residual arm additionally carries the whole-body scheduler — the per-statement
	// degrade-to-rebuild escape: when a statement's distinct affected-key count makes k
	// residual runs cost more than one rebuild (`shouldDegradeToRebuild`), the flush runs
	// this and applies a single `'replace-all'` diff instead. Compiled here (not per arm
	// builder) so the three residual arms share one compilation site; inverse-projection
	// never degrades (always the cheapest arm) and the floor has its own bodyScheduler.
	// NOTE: adds one whole-body optimize+emit per residual-MV (re)registration; if
	// registration latency ever matters (e.g. bulk catalog import), compile this lazily
	// on the first degrade instead.
	if (boundedDelta && boundedDelta.kind !== 'inverse-projection' && boundedDelta.kind !== 'full-rebuild') {
		boundedDelta.fullRebuildScheduler = compileWholeBodyScheduler(ctx, analyzed);
	}
	const plan = boundedDelta ?? buildFullRebuildPlan(ctx, mv, analyzed);
	// Precompute the NOT-NULL ordering-seeded PK skew guard once, here at plan build —
	// which `alter … drop not null` re-runs (it recompiles the row-time plan live), so the
	// guarded set is recomputed at exactly the moment the skew can appear. Gated to
	// non-empty so the field stays `undefined` (zero per-write cost) for the common case.
	const guarded = computeNullGuardColumns(mv, analyzed);
	plan.nullGuardColumns = guarded.length > 0 ? guarded : undefined;
	return plan;
}

/**
 * Backing columns that would silently store a NULL into a declared-NOT-NULL physical-PK
 * column if the source loosened — the reachable "NOT-NULL ordering-seeded PK over a
 * loosened source" skew, precomputed for the row-time guard
 * ({@link MaterializedViewManager.maintainRowTime}). A backing column `i` is guarded when
 * it is (1) declared NOT NULL, (2) a physical-PK member, AND (3) its re-derived body output
 * column `i` is now nullable. Backing column `i` corresponds 1:1 to body output column `i`
 * (`deriveBackingShape` builds the backing column list positionally from the body's output),
 * and `deriveBackingShape`'s own `notNull = type.nullable === false` derivation means the
 * body-nullability term agrees with the backing declaration by construction.
 *
 * The body-nullability term (3) is the real discriminator: the NOT-NULL/physical-PK set
 * alone is non-empty for almost every MV (the logical-key PK column is normally the NOT-NULL
 * source PK), so guarding on (1)+(2) only would scan essentially every maintained write.
 * (3) is true only for the rare loosened-source skew, so the returned set — hence
 * `plan.nullGuardColumns` — is empty (the field stays `undefined`) for the common case. A
 * physical-PK column declared *nullable* (a nullable-source ordering column) fails (1) and is
 * never guarded — it self-consistently stores NULL and must keep working.
 */
function computeNullGuardColumns(
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
): Array<{ readonly index: number; readonly name: string }> {
	const root = rootRelationalNode(analyzed);
	if (!root) return [];
	const bodyColumns = root.getType().columns;
	const pkIndices = new Set(mv.primaryKeyDefinition.map(d => d.index));
	const guarded: Array<{ readonly index: number; readonly name: string }> = [];
	for (let i = 0; i < mv.columns.length; i++) {
		const col = mv.columns[i];
		if (col.notNull !== true) continue;          // nullable-declared PK column stays permitted
		if (!pkIndices.has(i)) continue;             // physical-PK member only
		const bodyCol = bodyColumns[i];
		if (bodyCol && bodyCol.type.nullable !== false) { // body now yields nullable
			guarded.push({ index: i, name: col.name });
		}
	}
	return guarded;
}

/**
 * Route the analyzed body to the matching bounded-delta arm, or return `null` when its
 * shape fits **no** bounded-delta arm (the caller then builds the full-rebuild floor).
 * Each arm builder likewise returns `null` on a sub-shape mismatch and falls through
 * here. The arms keep only **determinism** as a hard reject (so their arm-specific
 * determinism diagnostic survives — see the individual builders); every other mismatch
 * is a `null` fall-through. Bag / no-output / size rejects live in the floor.
 */
export function tryBuildBoundedDeltaArm(ctx: MaterializedViewManagerContext, mv: MaintainedTableSchema, analyzed: BlockNode): MaintenancePlan | null {
	// A body that reads no source table has no bounded-delta arm → floor (which rejects
	// a sourceless body). (A self-join / TVF fan-out surfaces ≥2 refs or a TVF node.)
	const tableRefs = [...collectTableRefs(analyzed).values()];
	if (tableRefs.length === 0) return null;

	// Shapes no bounded-delta arm models — a window function reads across the partition,
	// set ops / recursive CTEs / DISTINCT / row caps are out of the bounded-delta model.
	// They are NOT rejected: a deterministic, keyed such body is maintained by the floor.
	if (containsNodeType(analyzed, PlanNodeType.Window)) return null;
	if (containsNodeType(analyzed, PlanNodeType.Distinct)) return null;
	if (containsNodeType(analyzed, PlanNodeType.SetOperation)) return null;
	if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) return null;
	if (mv.derivation.selectAst.type === 'select' && (mv.derivation.selectAst.limit !== undefined || mv.derivation.selectAst.offset !== undefined)) {
		return null;
	}

	const tableRef = tableRefs[0];
	const sourceSchema = tableRef.tableSchema;
	const sourceBase = `${sourceSchema.schemaName}.${sourceSchema.name}`.toLowerCase();

	// Single base source `T` joined to ONE lateral table-valued function — a fan-out
	// body (each base row produces N backing rows) → the prefix-delete arm. Routed
	// *before* the generic join branch below, because a lateral fan-out surfaces BOTH a
	// Join and a TableFunctionCall. A multi-base TVF body falls to the floor.
	if (containsNodeType(analyzed, PlanNodeType.TableFunctionCall)) {
		if (tableRefs.length !== 1) return null;
		return buildLateralTvfPrefixDeletePlan(ctx, mv, analyzed, tableRef, sourceBase);
	}

	// Any join → the provably-1:1 join-residual arm. A fanning (non-1:1) join, an outer
	// join, a >2-source join, an aggregate over a join, or a partial WHERE returns `null`
	// from the builder → floor. (The lateral-TVF fan-out above is matched first because
	// it also surfaces a join node.)
	if (containsAnyJoin(analyzed)) {
		return buildJoinResidualPlan(ctx, mv, analyzed, tableRefs);
	}
	// A non-join multi-source body (e.g. a WHERE-subquery over a second table) has no
	// bounded-delta arm → floor.
	if (tableRefs.length > 1) return null;

	// Single-source aggregate (`group by` over bare columns) → residual-recompute arm.
	// Each changed source row belongs to exactly one group; maintenance recomputes that
	// group's backing row from live state. A scalar aggregate (no GROUP BY) falls to the
	// floor.
	const aggregate = findAggregate(analyzed);
	if (aggregate) {
		return buildAggregateResidualPlan(ctx, mv, analyzed, tableRef, sourceBase, aggregate);
	}

	// The covering-index shape → inverse-projection arm (the default single-source arm).
	return buildInverseProjectionPlan(ctx, mv, analyzed, tableRef, sourceBase);
}

/**
 * Build an `'inverse-projection'` plan for the covering-index shape: a single
 * row-preserving source `T` with a primary key, a linear
 * `TableReference → optional Filter → Project → optional Sort` body, a projection that
 * resolves every source PK column (and every backing-key column) to a **passthrough**
 * source column — non-key columns may instead be a **deterministic scalar expression**
 * over the source row — and a partial WHERE evaluable on a single source row. Returns
 * `null` on any **shape** mismatch (the caller falls through to the full-rebuild floor);
 * a **non-deterministic** computed column is the one hard reject (its arm-specific
 * determinism diagnostic must survive rather than fall through to the floor's generic one).
 */
export function buildInverseProjectionPlan(
	ctx: MaterializedViewManagerContext,
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
	tableRef: TableReferenceNode,
	sourceBase: string,
): MaintenancePlan | null {
	const db = ctx as unknown as Database;
	const sourceSchema = tableRef.tableSchema;

	const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
	if (sourcePkCols.length === 0) return null; // source has no PK → floor

	const backing = ctx._findTable(mv.name, mv.schemaName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}

	// Projection classification: each backing output column is either a passthrough
	// source column (a pure permutation entry) or a deterministic scalar expression
	// over the single source row. A passthrough makes maintenance a column copy; an
	// expression column evaluates `project(sourceRow)` via the runtime (still a pure
	// per-row function — O(log n), no body re-execution). PK / backing-key columns
	// must stay passthrough (the backing key and the inverse-projection conflict map
	// depend on it); non-key columns may be computed.
	//
	// "Passthrough" is value-preserving lineage (`resolveValuePreservingSourceCol`):
	// a bare column reference, OR one wrapped in `collate` / a no-op `cast` — those
	// wrappers copy the source VALUE verbatim, so the column-copy maintenance is
	// exact. This is what lets the collation-weakening migration shape (`select b
	// collate nocase as b from t`) register here with its coarsened backing key:
	// the per-row upsert is keyed under the backing PK's (output) collation, so a
	// colliding source row last-write-wins into the shared backing row, and a
	// delete of one colliding sibling removes the shared row (the documented
	// anomaly — docs/materialized-views.md § Coarsened backing keys).
	const sourceAttrToCol = new Map<number, number>();
	const sourceDescriptor: RowDescriptor = [];
	tableRef.getAttributes().forEach((a, i) => {
		sourceAttrToCol.set(a.id, i);
		sourceDescriptor[a.id] = i;
	});
	const producingByAttrId = collectProducingExprs(analyzed);
	const rootAttrs = relationalAttributes(analyzed);
	if (!rootAttrs) return null; // no relational output → floor (which hard-rejects it)

	const projectors: BackingProjector[] = [];
	for (let outCol = 0; outCol < rootAttrs!.length; outCol++) {
		const attr = rootAttrs![outCol];
		const sourceCol = attr ? resolveValuePreservingSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
		if (sourceCol !== undefined) {
			projectors.push({ kind: 'passthrough', sourceCol });
			continue;
		}
		// Computed column: a deterministic scalar over the source row. A
		// non-deterministic producer is a HARD reject (the arm-specific determinism
		// diagnostic must survive — so `random()` fails on *determinism*, not by silently
		// falling to a still-rejected floor); a deterministic-but-unsupported *shape*
		// (no resolvable producer, a subquery / cross-row reference, an async form)
		// returns `null` → the floor.
		const colName = attr?.name ?? `#${outCol}`;
		const producing = attr ? producingByAttrId.get(attr.id) : undefined;
		if (!producing) return null;
		const det = checkDeterministic(producing);
		if (!det.valid) {
			throw cannotMaterialize(mv.name,
				`it projects a non-deterministic expression column '${colName}' (${det.expression}); `
					+ `a row-time backing value must be reproducible from the source row`);
		}
		if (!isSingleRowEvaluable(producing, sourceDescriptor)) return null;
		let evalFn: (row: Row) => SqlValue;
		try {
			evalFn = compileSourceRowEvaluator(db, producing, sourceDescriptor);
		} catch {
			return null; // not row-time maintainable as a single-row scalar → floor
		}
		projectors.push({ kind: 'expr', eval: evalFn });
	}

	// Every source PK column must be projected as a passthrough column so the backing
	// key is a deterministic identity of the source row that `lookupCoveringConflicts`
	// can invert. A PK column produced only via an expression (or not at all) breaks
	// that recovery.
	const passthroughSourceCols = new Set(
		projectors.flatMap(p => p.kind === 'passthrough' ? [p.sourceCol] : []),
	);
	for (const pk of sourcePkCols) {
		if (!passthroughSourceCols.has(pk)) return null; // PK not passthrough-projected → floor
	}

	const backingPkDefinition = resolveBackingPkColumns(backing, ctx.getCollationResolver());

	// A computed column may never land in the backing primary key: the btree keys on
	// it and `lookupCoveringConflicts` recovers the source PK from it, both of which
	// require a passthrough source-column identity.
	for (const d of backingPkDefinition) {
		if (projectors[d.index]?.kind !== 'passthrough') return null; // computed backing-key col → floor
	}

	// Partial WHERE must be evaluable on a single source row (no subqueries /
	// cross-row references). `compilePredicate` throws on unsupported forms; an
	// unsupported WHERE shape falls to the floor.
	//
	// No owning-table name is passed (lenient qualifier handling), deliberately: the
	// view body may reference the source through a FROM alias, not the source table's
	// own name, so validating against `sourceSchema.name` would wrongly reject a legal
	// aliased body — and this site FLOORS to full-rebuild on any throw rather than
	// erroring, turning a false rejection into a silent maintenance regression.
	// NOTE: to make MV WHERE strict, thread the alias set from the view's FROM into
	// this builder (not currently available here) and validate against it.
	let predicate: CompiledPredicate | undefined;
	const bodyWhere = mv.derivation.selectAst.type === 'select' ? mv.derivation.selectAst.where : undefined;
	if (bodyWhere) {
		try {
			predicate = compilePredicate(bodyWhere, sourceSchema.columns);
		} catch {
			return null; // WHERE not evaluable on a single source row → floor
		}
	}

	// ── Cost gate (incremental-maintenance-cost-gate) ──
	// The covering-index shape's only structurally-sound maintenance strategy is
	// 'inverse-projection' (O(1) per changed row); 'full-rebuild' is the floor for bodies
	// this arm did NOT match (reached via the `null` fall-through above), so it is not a
	// competitor here. Eligibility is thus a cost choice among the sound strategies (argmin
	// maintenanceCost); for this shape it resolves to inverse-projection while recording the
	// choice + the cost inputs the runtime reuses.
	const soundStrategies: MaintenanceStrategy[] = ['inverse-projection'];
	const sourceStats = estimateMaintenanceStats(ctx, sourceSchema, projectors.length, predicate !== undefined);
	// Create-time change-cardinality estimate: ~1% of the source per statement (typical OLTP).
	const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
	const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);

	// Defensive: this arm's sound set is exactly ['inverse-projection']. A different choice
	// would mean the set grew without the corresponding apply-arm — fail loud rather than
	// register an unexecutable plan.
	if (chosenStrategy !== 'inverse-projection') {
		throw new QuereusError(
			`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
			StatusCode.INTERNAL,
		);
	}

	return {
		kind: 'inverse-projection',
		mv,
		sourceBase,
		backingSchema: mv.schemaName,
		backingTableName: mv.name,
		chosenStrategy,
		sourceStats,
		backingPkDefinition,
		projectors,
		predicate,
	};
}

/**
 * Build a `'residual-recompute'` plan for a single-source aggregate body
 * (`select g1,…, agg(…) from T [where P] group by g1,…` over **bare** group columns),
 * or return `null` on a shape mismatch (the caller falls through to the full-rebuild
 * floor). Each changed source row belongs to exactly one group `(g1,…)`; maintaining the
 * MV means recomputing that group's backing row from live state — delete the old slice,
 * run the group-keyed residual, upsert the recomputed slice (zero rows when the group
 * emptied). See {@link ResidualRecomputePlan} and `docs/incremental-maintenance.md`
 * § residual-recompute.
 *
 * A **non-deterministic** group/aggregate expression is the one hard reject (the
 * arm-specific determinism diagnostic must survive); every other mismatch — a scalar
 * aggregate, a computed group key, a backing key that is not the group key — returns
 * `null` → the floor.
 *
 * NOTE: the group binding is derived **directly** from the aggregate node's bare GROUP
 * BY columns, not via `extractBindings`. `analyzeRowSpecific`'s `'group'` classification
 * additionally requires the group key to cover a *source* unique key (so it reports
 * `'global'` for the common `group by <non-key>` body), which is the wrong test here —
 * the backing is keyed by the group key regardless of whether it is a source key.
 */
export function buildAggregateResidualPlan(
	ctx: MaterializedViewManagerContext,
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
	tableRef: TableReferenceNode,
	sourceBase: string,
	aggregate: AggregateLike,
): MaintenancePlan | null {
	// A scalar aggregate (no GROUP BY) is one global row keyed by the empty key — no
	// bounded-delta group binding, so it falls to the floor.
	if (aggregate.groupBy.length === 0) return null;

	// Map T's output attributes to source column indices. T is a bare
	// `TableReferenceNode`, so output-column index == source-column index.
	const sourceAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
	const producingByAttrId = collectProducingExprs(analyzed);

	// Transitive provenance: chase output-attr → producing ColumnReference chains
	// (Project-over-Aggregate adds a hop the single-hop `resolveSourceCol` cannot
	// follow) until landing on a T source column, or `undefined`.
	const resolveToSourceCol = (attrId: number): number | undefined =>
		resolveTransitiveSourceCol(attrId, sourceAttrToCol, producingByAttrId);

	// Each GROUP BY expression must be a bare source column (a computed group key has
	// no source-column index to bind / key the backing on) → otherwise the floor.
	const groupColumns: number[] = [];
	for (const expr of aggregate.groupBy) {
		if (!(expr instanceof ColumnReferenceNode)) return null;
		const sourceCol = sourceAttrToCol.get((expr as ColumnReferenceNode).attributeId);
		if (sourceCol === undefined) return null;
		groupColumns.push(sourceCol);
	}

	// Determinism: a residual must reproduce exactly what `select <body>` returns, so a
	// volatile group/aggregate expression (random()/now()/volatile UDF) is a HARD reject.
	for (const expr of aggregate.groupBy) {
		const det = checkDeterministic(expr);
		if (!det.valid) throw cannotMaterialize(mv.name, `it groups by a non-deterministic expression (${det.expression})`);
	}
	for (const agg of aggregate.aggregates) {
		const det = checkDeterministic(agg.expression);
		if (!det.valid) throw cannotMaterialize(mv.name, `it aggregates a non-deterministic expression (${det.expression})`);
	}

	// Backing table + its physical PK. The aggregate's group-key FD
	// (`propagateAggregateFds`) makes the group key the backing key (via `keysOf`).
	const backing = ctx._findTable(mv.name, mv.schemaName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const backingPkDefinition = resolveBackingPkColumns(backing, ctx.getCollationResolver());

	// Map each backing-PK column back to the source group column it projects, so a
	// changed row's old backing-slice delete key can be built. Every backing-PK column
	// MUST resolve to a GROUP BY source column — else the backing key is not the group
	// key and point-keyed delete+upsert would be unsound → fall to the floor.
	const rootAttrs = relationalAttributes(analyzed);
	if (!rootAttrs) return null;
	const groupColumnSet = new Set(groupColumns);
	const backingPkSourceCols: number[] = [];
	for (const d of backingPkDefinition) {
		const attr = rootAttrs[d.index];
		const sourceCol = attr ? resolveToSourceCol(attr.id) : undefined;
		if (sourceCol === undefined || !groupColumnSet.has(sourceCol)) return null;
		backingPkSourceCols.push(sourceCol);
	}

	// Compile + cache the group-keyed residual once (the body with `g1 = :gk0 AND …`
	// injected on T). Re-run per affected group key against the live transaction.
	const relKey = `${sourceBase}#${tableRef.id ?? 'unknown'}`;
	const residualScheduler = compileResidual(ctx, analyzed, relKey, groupColumns, 'gk');
	if (!residualScheduler) return null; // could not parameterize the residual → floor

	// Delta-aggregate fast path: build the descriptor when EVERY stored aggregate
	// column is delta-maintainable by its declared algebra (see the builder below).
	// `undefined` on any gate failure — the arm then stays a plain residual, unchanged.
	const delta = buildDeltaAggregateDescriptor(
		mv, analyzed, tableRef, groupColumns, backingPkDefinition, backingPkSourceCols,
		rootAttrs, sourceAttrToCol, producingByAttrId, ctx.getCollationResolver(),
	);

	// ── Cost gate ──
	// The residual is the structurally-sound incremental arm for an aggregate body;
	// 'full-rebuild' is the always-correct floor for shapes where the residual is NOT
	// sound, so (as with inverse-projection) it is not a competitor here. When the delta
	// descriptor built, 'delta-aggregate' joins the sound set — an O(1)-per-change
	// arithmetic RMW, strictly cheaper than the per-group residual under the cost model,
	// so the argmin picks it. The descriptor is attached only when the gate chose it
	// (cost-strategy decoupling: `kind` stays 'residual-recompute' either way).
	const soundStrategies: MaintenanceStrategy[] = delta
		? ['delta-aggregate', 'residual-recompute']
		: ['residual-recompute'];
	const hasPredicate = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
	const sourceStats = estimateMaintenanceStats(ctx, tableRef.tableSchema, backing.columns.length, hasPredicate);
	// A tighten-only (min/max) column re-derives a retracted group from the residual, so the
	// delta arm's cost is no longer pure arithmetic — feed the create-time expected-rescan
	// fraction into the `'delta-aggregate'` cost blend (maintenanceCost). A tighten body then
	// costs strictly more than a pure-group body but, for this insert-dominated estimate, still
	// below the always-residual arm, so the argmin keeps the delta arm.
	if (delta?.hasTighten) sourceStats.deltaTightenFallbackRatio = DELTA_TIGHTEN_FALLBACK_RATIO;
	const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
	const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
	if (!soundStrategies.includes(chosenStrategy)) {
		throw new QuereusError(
			`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
			StatusCode.INTERNAL,
		);
	}

	return {
		kind: 'residual-recompute',
		mv,
		sourceBase,
		backingSchema: mv.schemaName,
		backingTableName: mv.name,
		chosenStrategy,
		sourceStats,
		binding: { kind: 'group', groupColumns: [...groupColumns] },
		residualScheduler,
		bindParamPrefix: 'gk',
		bindColumns: groupColumns,
		backingPkDefinition,
		backingPkSourceCols,
		delta: chosenStrategy === 'delta-aggregate' ? delta : undefined,
	};
}

/**
 * Build the {@link DeltaAggregateDescriptor} for a single-source aggregate body, or
 * return `undefined` when any column fails the delta eligibility gate (the arm then
 * stays a plain residual — a gate failure is never an error). Function-generic by
 * construction: every judgment reads the aggregate call node's registry-resolved
 * schema and its DECLARED {@link AggregateAlgebra} — never an aggregate-name list.
 *
 * The gate, per stored backing column:
 *  - a **group-key passthrough** column must resolve (transitively) to a GROUP BY
 *    source column that also backs a backing-PK position (so its flush value is the
 *    group key itself);
 *  - a directly **delta-maintainable aggregate** column must be a plain call (`agg(x)` /
 *    `agg()` — no DISTINCT, FILTER, ORDER BY, multi-arg) whose declared algebra has
 *    `merge` + `negate` + `decode`, with a **bare source column** argument (the delta
 *    steps the raw value);
 *  - **exact value domain**: the aggregate's declared return type is INTEGER-physical
 *    (count-shaped — exact regardless of argument), OR its argument column's static
 *    type is INTEGER-physical (integer sum). A REAL/NUMERIC/TEXT sum drifts under
 *    repeated add/subtract and would diverge byte-exactly from the live re-evaluation
 *    the oracle compares against — such a column disqualifies the whole MV (residual);
 *  - a **tighten-only** column (min/max, and any UDAF whose merge is a join-semilattice
 *    like `bit_or`/`bool_or`) — a plain call declaring `merge` + `decode` but NO `negate`
 *    — is admitted with `deltaClass: 'tighten'`. It needs no exact-value-domain gate
 *    (merge is idempotent selection, not accumulating arithmetic → no drift) and is never
 *    retraction-safe: an insert `merge`s the new value in cheaply, but a retracted group
 *    re-derives wholesale from the residual (via the descriptor's `hasTighten`) rather
 *    than trusting the arithmetic;
 *  - a **decomposition-maintained** column (the avg class) — a plain call whose algebra
 *    declares `decompose` (a scalar formula over sibling partials, e.g. avg ≡ sum/count)
 *    but is not itself directly maintainable — is admitted only when EVERY partial it
 *    names ({@link resolveDecomposePartial}) is also stored as a sibling column of this
 *    same body and is itself delta-maintainable. It carries no independent accumulation;
 *    at flush its value is `combine([finalized(partial) …])`. If any partial is missing
 *    or not delta-maintainable the whole MV falls to residual (avg is the first client of
 *    this class, not a special case);
 *  - any other column shape (a constant, an expression over the group key, …) fails.
 *
 * Whole-body requirements:
 *  - **no post-aggregate filter** (HAVING, or an outer WHERE over the aggregate
 *    output): such a filter breaks the arithmetic invariant "stored row == the
 *    group's full accumulator" — a filtered-out group has contributions but no
 *    stored row, so a later delta would rebuild it from the identity and understate
 *    the aggregate. The residual re-evaluates the filter per group and stays exact;
 *  - a **count(*) multiplicity witness** — a zero-arg delta-maintainable column with
 *    `decodeExact` (its stored value must reconstruct exactly, since it decides group
 *    emptiness under retraction). Without it, emptiness cannot be told from an
 *    all-NULL sum;
 *  - **BINARY collations** on every backing-PK (group key) column: the flush's stored-
 *    row read is the host's `scanEffective` equality-prefix seek, whose prefix compare
 *    is binary (scan-layer.ts). Unlike the prefix-delete arm there is no source-PK
 *    uniqueness collapsing collation classes to one byte form here, so a non-BINARY
 *    group key could miss a collation-equal / byte-different stored row — residual
 *    instead;
 *  - a body WHERE (if any) must compile to a single-source-row predicate
 *    (`compilePredicate`) so per-row contributions can be scoped exactly.
 *
 * Per-column `retractionSafe` (see {@link DeltaAggregateColumn}) is recorded rather
 * than gated: a not-retraction-safe descriptor still serves the bulk-insert fast path,
 * and the flush re-derives only the retracted groups through the residual.
 */
export function buildDeltaAggregateDescriptor(
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
	tableRef: TableReferenceNode,
	groupColumns: readonly number[],
	backingPkDefinition: ReadonlyArray<BackingPkColumn>,
	backingPkSourceCols: readonly number[],
	rootAttrs: ReadonlyArray<{ id: number } | undefined>,
	sourceAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
	collationResolver: CollationResolver,
): DeltaAggregateDescriptor | undefined {
	const sourceSchema = tableRef.tableSchema;
	const groupColumnSet = new Set(groupColumns);

	// Post-aggregate filter gate: a Filter whose subtree contains the aggregate is a
	// HAVING (or an outer WHERE over the aggregate output). It breaks the arithmetic
	// invariant "stored row == the group's full accumulator" — a filtered-out group has
	// contributions but no stored row, so a later delta would rebuild it from the
	// identity and understate the aggregate. (The body WHERE sits BELOW the aggregate —
	// its Filter subtree contains no aggregate node — and stays delta-eligible via the
	// compiled scope predicate below.)
	if (hasFilterAboveAggregate(analyzed)) return undefined;

	// Binary-collation gate on the backing PK (the flush's binary equality-prefix read).
	for (const d of backingPkDefinition) {
		if (!isBinaryCollation(d.collation)) return undefined;
	}

	// Body WHERE → single-row scope predicate (contributions outside it are dropped,
	// mirroring the residual's own WHERE). An uncompilable WHERE shape → residual.
	let predicate: CompiledPredicate | undefined;
	const bodyWhere = mv.derivation.selectAst.type === 'select' ? mv.derivation.selectAst.where : undefined;
	if (bodyWhere) {
		try {
			predicate = compilePredicate(bodyWhere, sourceSchema.columns);
		} catch {
			return undefined;
		}
	}

	// Chase an output attr's producing chain to its terminal (non-ColumnReference)
	// expression — the aggregate call node for an aggregate output column.
	const resolveTerminalProducing = (attrId: number): ScalarPlanNode | undefined => {
		const seen = new Set<number>();
		let cur = attrId;
		while (!seen.has(cur)) {
			seen.add(cur);
			const expr = producingByAttrId.get(cur);
			if (expr instanceof ColumnReferenceNode) { cur = expr.attributeId; continue; }
			return expr;
		}
		return undefined;
	};

	const aggColumns: DeltaAggregateColumn[] = [];
	const groupOut: Array<{ readonly backingCol: number; readonly pkPos: number }> = [];
	// Decomposition-maintained columns (the avg class), collected raw here and bound to
	// their sibling stored partials in a second pass below — the partials may project
	// before OR after the decompose column, so they cannot be resolved inline.
	const pendingDecompose: Array<{ readonly backingCol: number; readonly argSourceCol: number | undefined; readonly decomposition: AggregateDecomposition }> = [];
	for (let outCol = 0; outCol < rootAttrs.length; outCol++) {
		const attr = rootAttrs[outCol];
		if (!attr) return undefined;
		const sourceCol = resolveTransitiveSourceCol(attr.id, sourceAttrToCol, producingByAttrId);
		if (sourceCol !== undefined) {
			// Group-key passthrough: its flush value is the group key at the matching
			// backing-PK position (covers duplicate projections of a group column).
			if (!groupColumnSet.has(sourceCol)) return undefined;
			const pkPos = backingPkSourceCols.indexOf(sourceCol);
			if (pkPos < 0) return undefined;
			groupOut.push({ backingCol: outCol, pkPos });
			continue;
		}
		const producing = resolveTerminalProducing(attr.id);
		if (!(producing instanceof AggregateFunctionCallNode)) return undefined;
		// Plain call only: DISTINCT folds duplicates (delta cannot), FILTER/ORDER BY
		// change the contribution set, multi-arg has no single raw value to step.
		if (producing.isDistinct || producing.filter || (producing.orderBy && producing.orderBy.length > 0)) return undefined;
		if (producing.args.length > 1) return undefined;
		const unboundSchema = producing.functionSchema;
		if (!isAggregateFunctionSchema(unboundSchema)) return undefined;
		// A bare source column argument (both classes below step / decompose over the raw
		// value); a zero-arg (count(*)-shaped) call carries none.
		//
		// Bind the schema to the argument's comparison context ONCE here at plan build:
		// the BOUND schema/algebra are what the delta arm executes (step at statement
		// accumulation, merge/decode/finalize at flush — database-materialized-views-
		// apply.ts), so store maintenance ranks by the same comparator as direct
		// evaluation (min/max over TIMESPAN/JSON/collated text).
		// Soundness note: the flush's decode reconstructs an accumulator from the STORED
		// backing value and merges it against step contributions from SOURCE rows. For
		// min/max the backing column's type is inferReturnType(argType) = argType, so one
		// binding covers both sides. An aggregate whose result type differed from its
		// argument type would need two bindings — none exists today that is both
		// delta-maintainable and comparison-sensitive; state the assumption rather than
		// generalizing for it.
		let argSourceCol: number | undefined;
		let schema = bindAggregateSchema(unboundSchema, []);
		if (producing.args.length === 1) {
			const arg = producing.args[0];
			if (!(arg instanceof ColumnReferenceNode)) return undefined; // bare column args only
			argSourceCol = resolveTransitiveSourceCol(arg.attributeId, sourceAttrToCol, producingByAttrId);
			if (argSourceCol === undefined) return undefined;
			const argType = arg.getType();
			schema = bindAggregateSchema(unboundSchema, [{
				logicalType: argType.logicalType as LogicalType,
				collation: argType.collationName ? collationResolver(argType.collationName) : undefined,
			}]);
		}
		const algebra = schema.algebra;
		// Class routing — declaration-driven, never an aggregate-name list:
		//  - **directly delta-maintainable** (`merge` + `negate` (retraction) + `decode` —
		//    the backing stores finalized values, not accumulators): accumulate it as an
		//    ordinary partial;
		//  - else a **decomposition-maintained** column whose value is a formula over
		//    sibling partials (`algebra.decompose`, e.g. avg ≡ sum/count) — deferred to the
		//    pass below that binds each partial to a stored sibling; it accumulates nothing;
		//  - anything else disqualifies the whole MV → residual.
		if (algebra?.negate && algebra.decode) {
			// Exact numeric domain: an INTEGER-physical declared result (count-shaped — the
			// accumulator never holds a float) or an INTEGER-physical argument column
			// (integer sum). Anything else may drift under repeated add/subtract.
			// NOTE: if a REAL-domain sum ever needs the fast path, it needs compensated
			// (Kahan) accumulation or a periodic-rescan discipline — a design change, not a
			// relaxation of this gate.
			const resultExact = schema.returnType.logicalType.physicalType === PhysicalType.INTEGER;
			const argExact = argSourceCol !== undefined
				&& sourceSchema.columns[argSourceCol]?.logicalType.physicalType === PhysicalType.INTEGER;
			if (!resultExact && !argExact) return undefined;
			const retractionSafe = algebra.decodeExact === true
				|| (argSourceCol !== undefined && sourceSchema.columns[argSourceCol]?.notNull === true);
			aggColumns.push({
				backingCol: outCol,
				schema,
				algebra,
				deltaClass: 'group',
				argSourceCol,
				isMultiplicity: producing.args.length === 0,
				retractionSafe,
			});
			continue;
		}
		// Tighten-only (join-semilattice): `merge` + `decode` but NO `negate` — min/max, and
		// any UDAF whose merge is idempotent selection (bit_or/bool_or). An insert `merge`s the
		// new value in cheaply (min/max tighten toward the new extreme); a retraction cannot be
		// undone arithmetically, so a retracted group falls back to the residual
		// (retractionSafe:false, and the descriptor's hasTighten routes the whole group there
		// whether or not a row is stored). NO exact-numeric-domain gate: merge is idempotent
		// selection, not accumulating arithmetic, so there is no float drift to guard — a tighten
		// column over any comparable domain (REAL/TEXT included) stays byte-exact vs the live
		// re-evaluation. A negate+decode column that failed the exact-domain gate above already
		// returned undefined, so only a decode-without-negate aggregate reaches here.
		if (algebra?.decode && !algebra.negate) {
			aggColumns.push({
				backingCol: outCol,
				schema,
				algebra,
				deltaClass: 'tighten',
				argSourceCol,
				isMultiplicity: producing.args.length === 0,
				retractionSafe: false,
			});
			continue;
		}
		if (algebra?.decompose) {
			pendingDecompose.push({ backingCol: outCol, argSourceCol, decomposition: algebra.decompose });
			continue;
		}
		return undefined; // neither directly maintainable, tighten-only, nor decomposable → residual
	}

	// Multiplicity witness: a zero-arg delta-maintainable column whose decode is exact
	// (its merged value decides group emptiness, so the reconstruction must survive
	// retraction). Structural — not name-based. A decompose column is never the witness
	// (it accumulates nothing — the requirement is a real stored count(*)).
	const multiplicityIndex = aggColumns.findIndex(c => c.isMultiplicity && c.algebra.decodeExact === true);
	if (multiplicityIndex < 0) return undefined;
	if (aggColumns.length === 0) return undefined; // defensive — findAggregate implies ≥1

	// Bind each decomposition column's partials to sibling STORED, delta-maintained columns
	// (every `aggColumns` entry already passed the accumulator gate, so it is itself delta-
	// maintainable). A partial that maps to no such sibling disqualifies the whole MV →
	// residual (honest and visible: the user wrote a body without the partials the formula
	// names). The decompose column's `combine` recomputes exactly per group at flush.
	const decomposeColumns: DeltaDecomposeColumn[] = [];
	for (const pd of pendingDecompose) {
		const partialIndices: number[] = [];
		for (const p of pd.decomposition.partials) {
			const idx = resolveDecomposePartial(p, pd.argSourceCol, aggColumns, sourceSchema);
			if (idx === undefined) return undefined;
			partialIndices.push(idx);
		}
		decomposeColumns.push({ backingCol: pd.backingCol, partialIndices, combine: pd.decomposition.combine });
	}

	return {
		aggColumns,
		decomposeColumns,
		groupColumns: groupOut,
		multiplicityIndex,
		backingColumnCount: rootAttrs.length,
		retractionSafe: aggColumns.every(c => c.retractionSafe),
		hasTighten: aggColumns.some(c => c.deltaClass === 'tighten'),
		predicate,
	};
}

/**
 * Resolve one {@link AggregateDecomposition} partial (e.g. avg's `sum` / `count`) to the
 * index of a sibling stored, delta-maintainable aggregate column — an `aggColumns` entry
 * matching the partial's function name and argument. Returns `undefined` when no such
 * sibling is stored (the decompose column is then not maintainable → the MV falls to the
 * residual). The write-side twin of `query-rewrite-matcher.resolveMergeablePartial`.
 *
 * `'same-arg'` targets a sibling over the decompose column's own argument (`f(thisArg)`);
 * `'star'` targets a zero-arg (`count(*)`-shaped) sibling. The **count(*) fallback** mirrors
 * the read-side relaxation from `feat-mv-agg-rollup-retarget`: a stored `count(*)` substitutes
 * for a `count(x)` divisor only when `x` is declared **NOT NULL** — then `count(*)` excludes
 * the same (zero) NULLs `count(x)` would, so the recombine stays exact.
 */
function resolveDecomposePartial(
	p: { readonly func: string; readonly arg: 'same-arg' | 'star' },
	ownerArgSourceCol: number | undefined,
	aggColumns: readonly DeltaAggregateColumn[],
	sourceSchema: TableSchema,
): number | undefined {
	// NOTE: a partial resolves only to an `aggColumns` entry, which already passed the
	// accumulator gate — a BARE source column argument plus the INTEGER-exact-domain check.
	// That is what keeps the decomposed value byte-exact: a partial like `sum(log x)` (a
	// non-bare, float-producing argument) can never be a stored delta-maintainable sibling,
	// so a true geometric mean is NOT delta-decomposable and correctly falls to the residual.
	const targetArg = p.arg === 'star' ? undefined : ownerArgSourceCol;
	const funcName = p.func.toLowerCase();
	const find = (name: string, argCol: number | undefined): number =>
		aggColumns.findIndex(c => c.schema.name.toLowerCase() === name && c.argSourceCol === argCol);
	let idx = find(funcName, targetArg);
	if (idx < 0 && funcName === 'count' && targetArg !== undefined
		&& sourceSchema.columns[targetArg]?.notNull === true) {
		idx = find('count', undefined); // count(*) qualifies as the count(x) divisor when x is NOT NULL
	}
	return idx < 0 ? undefined : idx;
}

/**
 * True when any Filter node's subtree contains an aggregate node — i.e. the plan
 * filters the AGGREGATE OUTPUT (HAVING, or an outer WHERE over a grouped subquery).
 * The body WHERE is the complement case: its Filter sits below the aggregate, so its
 * subtree contains none. Used by {@link buildDeltaAggregateDescriptor}'s gate.
 */
function hasFilterAboveAggregate(node: PlanNode): boolean {
	if (node.nodeType === PlanNodeType.Filter && findAggregate(node) !== undefined) return true;
	for (const child of node.getChildren()) {
		if (hasFilterAboveAggregate(child as unknown as PlanNode)) return true;
	}
	return false;
}

/**
 * Build a `'join-residual'` plan for a provably-1:1 row-preserving **inner/cross join**
 * body (`select … from T join P on T.fk = P.id`), or return `null` on a shape mismatch
 * (the caller falls through to the full-rebuild floor). The driving table `T` is the one
 * whose PK the optimizer surfaced as the backing key (the 1:1 join collapses the composite
 * product key to `T`'s PK); the other base ref is the lookup `P`. See {@link JoinResidualPlan}
 * and `docs/incremental-maintenance.md` § join-residual.
 *
 * Soundness gates (a mismatch on any returns `null` → floor): exactly two base tables; no
 * aggregate over the join; the backing PK is exactly `T`'s PK projected as passthrough
 * columns (so each changed `T` row maps to one backing row and the reverse residual's rows
 * carry the backing key); the join is provably 1:1 on `T` ({@link proveOneToOneJoin} — no
 * row loss via NOT-NULL FK→PK RI, no fan-out via the join-frame `isUnique(T.pk)`); and the
 * join is **inner/cross** (an outer join would make the lookup-side reverse residual unsound
 * — filtering `P` drops the null-extended rows). A **non-deterministic** projection is the
 * one hard reject (its arm-specific determinism diagnostic must survive).
 *
 * **A body WHERE is now accepted** (it is no longer a blanket reject): the predicate is
 * classified by which base table(s) its columns reference (reusing the per-base-ref
 * attribute→source-column maps below). A `T`-only predicate needs nothing extra — the
 * forward residual already carries it and the membership set `{ T : T.fk = P.pk }` cannot
 * move on a `P` write, so the lookup side stays upsert-only. A predicate referencing `P` (or
 * both sides) switches the lookup side to a **delete-capable** reverse residual by building
 * `lookupMembershipResidualScheduler` (the body with the WHERE stripped, keyed on `P`). See
 * {@link JoinResidualPlan}'s "WHERE handling" note and {@link applyLookupResidual}.
 */
export function buildJoinResidualPlan(
	ctx: MaterializedViewManagerContext,
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
	tableRefs: TableReferenceNode[],
): MaintenancePlan | null {
	// A >2-source join or an aggregate over the join has no join-residual binding → floor.
	// A body WHERE is no longer rejected here — it is classified (T-only vs P-referencing)
	// below, after `T`/`P` are identified, and routed to the matching lookup-side strategy.
	if (tableRefs.length !== 2) return null;
	if (findAggregate(analyzed)) return null;

	const backing = ctx._findTable(mv.name, mv.schemaName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const backingPkDefinition = resolveBackingPkColumns(backing, ctx.getCollationResolver());

	const rootAttrs = relationalAttributes(analyzed);
	if (!rootAttrs) return null;
	const producingByAttrId = collectProducingExprs(analyzed);

	// Per-base-ref attribute → source-column maps. `T` and `P` are bare
	// TableReferenceNodes (output-col index == source-col index).
	const refInfos = tableRefs.map(ref => {
		const attrToCol = new Map<number, number>();
		ref.getAttributes().forEach((a, i) => attrToCol.set(a.id, i));
		return { ref, attrToCol };
	});

	// Identify the driving table `T` as the one every backing-PK column resolves to, and
	// map each backing-PK column to its `T` source column (the delete key the forward arm
	// builds). A backing-PK column resolving to neither ref — or columns spanning both —
	// means the backing is not keyed on a single source's PK (the join is not provably
	// 1:1, or `keysOf` fell back to all-columns): reject.
	let tIndex: number | undefined;
	const backingPkSourceCols: number[] = [];
	for (const d of backingPkDefinition) {
		const attr = rootAttrs[d.index];
		let resolvedRef: number | undefined;
		let resolvedCol: number | undefined;
		for (let i = 0; i < refInfos.length; i++) {
			const sc = attr ? resolveTransitiveSourceCol(attr.id, refInfos[i].attrToCol, producingByAttrId) : undefined;
			if (sc !== undefined) { resolvedRef = i; resolvedCol = sc; break; }
		}
		// A backing-PK column resolving to neither ref, or columns spanning both, means the
		// backing is not keyed on a single source's PK (not provably 1:1) → fall to the floor.
		if (resolvedRef === undefined) return null;
		if (tIndex === undefined) tIndex = resolvedRef;
		else if (tIndex !== resolvedRef) return null;
		backingPkSourceCols.push(resolvedCol!);
	}
	if (tIndex === undefined) return null;

	const tRef = refInfos[tIndex].ref;
	const pRef = refInfos[tIndex === 0 ? 1 : 0].ref;
	const tSchema = tRef.tableSchema;
	const pSchema = pRef.tableSchema;
	const sourceBase = `${tSchema.schemaName}.${tSchema.name}`.toLowerCase();
	const lookupBase = `${pSchema.schemaName}.${pSchema.name}`.toLowerCase();
	if (sourceBase === lookupBase) return null; // self-join → floor

	// The backing key must be EXACTLY the driving source's PK (each `T` row → one backing
	// row). `keysOf` surfaced `T.pk` for the 1:1 join; verify it resolved to a real PK key
	// (not the all-columns fallback) by set-equality with `T`'s declared PK.
	const tPkCols = tSchema.primaryKeyDefinition.map(d => d.index);
	if (tPkCols.length === 0) return null;
	const backingPkSet = new Set(backingPkSourceCols);
	if (backingPkSet.size !== tPkCols.length || !tPkCols.every(c => backingPkSet.has(c))) return null;

	// Prove the join is 1:1 on `T` (no row loss + no fan-out), reusing the coverage
	// prover's shared join predicates over the analyzed body. A fanning / non-1:1 join
	// falls to the floor.
	const root = rootRelationalNode(analyzed);
	if (!root) return null;
	const proof = proveOneToOneJoin(root, tSchema);
	if (!proof.ok) return null;

	// Restrict to inner/cross: the lookup-side reverse residual filters `P`, which would
	// drop an outer join's null-extended rows (unsound). An outer 1:1 join falls to the floor.
	const topJoin = proof.topJoin;
	const joinType = topJoin && CapabilityDetectors.isJoin(topJoin) ? topJoin.getJoinType() : undefined;
	if (joinType !== 'inner' && joinType !== 'cross') return null;

	// Determinism: the residual must reproduce exactly what `select <body>` returns, so a
	// volatile projection (random()/now()/volatile UDF) is a HARD reject.
	for (const attr of rootAttrs) {
		const producing = attr ? producingByAttrId.get(attr.id) : undefined;
		if (!producing) continue; // a bare passthrough column has no producing expr to check
		const det = checkDeterministic(producing);
		if (!det.valid) {
			throw cannotMaterialize(mv.name,
				`it projects a non-deterministic expression (${det.expression}); a row-time backing value must be reproducible from the source rows`);
		}
	}

	// Forward (`T`) residual: the body with `T.pk = :pk0 AND …` injected on `T`. Recomputes
	// the one joined row for a changed `T` row (delegated to `applyForwardResidual`).
	const tRelKey = `${sourceBase}#${tRef.id ?? 'unknown'}`;
	const forwardResidual = compileResidual(ctx, analyzed, tRelKey, tPkCols, 'pk');
	if (!forwardResidual) return null;

	// Reverse (`P`) **in-scope** residual: the body — WHERE retained — with `P.pk = :pk0 AND …`
	// injected on `P`. Drives lookup-side maintenance — finds every currently in-scope joined
	// row referencing a changed `P` row.
	const pPkCols = pSchema.primaryKeyDefinition.map(d => d.index);
	if (pPkCols.length === 0) return null;
	const pRelKey = `${lookupBase}#${pRef.id ?? 'unknown'}`;
	const reverseResidual = compileResidual(ctx, analyzed, pRelKey, pPkCols, 'pk');
	if (!reverseResidual) return null;

	// Classify the body WHERE by which base table(s) its columns reference: a predicate that
	// references `P` (or both sides) can flip a row's WHERE membership on a `P` write, so the
	// lookup side must become delete-capable; a `T`-only predicate cannot move membership, so
	// the upsert-only reverse residual above stays sound. The membership residual is the body
	// with the WHERE **stripped** and the key filter on `P` — it returns every currently
	// referencing `T` row (regardless of scope) so its backing key can be deleted before the
	// in-scope survivors are re-upserted. Absent for a no-WHERE / `T`-only-WHERE body.
	const hasWhere = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
	// A volatile WHERE would make every residual (which embeds it) irreproducible → fall to
	// the floor's pragma-gated whole-body determinism reject, not an unsound bounded-delta arm.
	if (hasWhere && bodyWhereIsNonDeterministic(analyzed)) return null;
	const whereReferencesLookup = hasWhere
		&& bodyWhereReferencesLookup(analyzed, refInfos[tIndex].attrToCol, producingByAttrId);
	let lookupMembershipResidual: Scheduler | undefined;
	if (whereReferencesLookup) {
		const membership = compileLookupMembershipResidual(ctx, mv, lookupBase, pPkCols);
		if (!membership) return null; // could not strip + re-key the membership residual → floor
		lookupMembershipResidual = membership;
	}

	// ── Cost gate (parity with the other residual arms) ──
	const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
	const sourceStats = estimateMaintenanceStats(ctx, tSchema, backing.columns.length, hasWhere);
	const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
	const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
	if (chosenStrategy !== 'residual-recompute') {
		throw new QuereusError(
			`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
			StatusCode.INTERNAL,
		);
	}

	return {
		kind: 'join-residual',
		mv,
		sourceBase,
		backingSchema: mv.schemaName,
		backingTableName: mv.name,
		chosenStrategy,
		sourceStats,
		binding: { kind: 'row', keyColumns: [...tPkCols] },
		residualScheduler: forwardResidual,
		bindParamPrefix: 'pk',
		bindColumns: tPkCols,
		backingPkDefinition,
		backingPkSourceCols,
		lookupBase,
		lookupResidualScheduler: reverseResidual,
		lookupMembershipResidualScheduler: lookupMembershipResidual,
		lookupBindColumns: pPkCols,
		lookupBindParamPrefix: 'pk',
	};
}

/**
 * Compile the **lookup membership** residual for the join-residual arm's delete-capable
 * lookup side: the MV body with its top-level WHERE **stripped** (membership only) and a
 * key-equality filter injected on the lookup `P`, keyed `pk0…`. The WHERE is stripped at the
 * AST level (a shallow clone dropping `where`) and the body re-built + re-analyzed, so only
 * the WHERE is removed — the join, its `ON` condition, and any projection sub-expressions are
 * preserved. Re-analysis assigns fresh node ids, so `P`'s reference is re-located by base name
 * to compute the injection target. Returns `null` if the lookup ref or the key-filter
 * injection could not be resolved (the caller then falls to the full-rebuild floor).
 *
 * Run per affected `P` key, this residual returns **every** `T` row currently joined to `P`
 * via the join's `ON` condition — irrespective of the WHERE — so {@link applyLookupResidual}
 * can delete each one's `T.pk` backing key before the in-scope residual re-upserts the
 * survivors (the membership set the WHERE-bearing reverse residual would otherwise never
 * shrink).
 */
export function compileLookupMembershipResidual(
	ctx: MaterializedViewManagerContext,
	mv: MaintainedTableSchema,
	lookupBase: string,
	pPkCols: readonly number[],
): Scheduler | null {
	const db = ctx as unknown as Database;
	const strippedAst = { ...(mv.derivation.selectAst as AST.SelectStmt), where: undefined };
	const stripped = db.schemaManager.withSuppressedMaterializedViewRewrite(() => {
		const { plan } = ctx._buildPlan([strippedAst as AST.Statement]);
		return ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;
	});
	// Re-locate `P` in the WHERE-stripped plan by base name (fresh node ids) to build the
	// injection target key the way `compileResidual`'s callers do.
	let pRelKey: string | undefined;
	for (const [relKey, ref] of collectTableRefs(stripped)) {
		if (`${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase() === lookupBase) {
			pRelKey = relKey;
			break;
		}
	}
	if (pRelKey === undefined) return null;
	return compileResidual(ctx, stripped, pRelKey, pPkCols, 'pk');
}

/**
 * Build a `'full-rebuild'` plan — the always-correct floor — for an MV whose body matches
 * no bounded-delta arm, or throw with a non-shape diagnostic. This is the fall-through
 * builder {@link tryBuildBoundedDeltaArm} routes to on a `null` (no bounded-delta arm fits).
 * See {@link FullRebuildPlan} and `docs/mv-maintenance.md` § Full-rebuild floor /
 * § Primary key inference.
 *
 * Create-time rejections (none shape-based — the floor accepts general bodies):
 * - **bag** body with no provable unique key (`keysOf` over the optimized body root is
 *   empty) — there is no row identity to materialize on. `keysOf` already gates its
 *   all-columns fallback on `isSet`, so a non-empty result is a real key (a true column
 *   key OR the all-columns key of a provable set) and an empty result is exactly a bag.
 *   (A duplicate-producing body usually fails the set contract earlier, at create-fill.)
 * - **non-deterministic** body (any `random()`/`now()`/volatile UDF anywhere in the plan)
 *   without `pragma nondeterministic_schema` — no maintenance could keep it equal to its
 *   plain view (mirrors the per-arm determinism rejects and the DDL determinism gate);
 * - body with **no relational output** (degenerate);
 * - **size**: full-rebuild is the only sound strategy *and* the **largest** participating
 *   source exceeds the `materialized_view_rebuild_row_threshold` option
 *   ({@link isFullRebuildPathological}) — every DML write would re-scan that source.
 *   `0` disables the size reject (accept any size).
 */
export function buildFullRebuildPlan(ctx: MaterializedViewManagerContext, mv: MaintainedTableSchema, analyzed: BlockNode): FullRebuildPlan {
	const db = ctx as unknown as Database;

	// Optimize the whole body ONCE — read-side MV rewrite suppressed so it reads its
	// sources, not the backing it populates — then derive the body's key + determinism
	// from, and compile its scheduler from, the SAME optimized plan.
	const optimized = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => ctx.optimizer.optimize(analyzed, db) as BlockNode,
	);
	const root = rootRelationalNode(optimized);
	if (!root) throw cannotMaterialize(mv.name, 'its body produced no relational output');

	// Backing key = the body's provable unique key. A bag (no provable key — a key-dropping
	// projection, a `union all` of overlapping inputs, …) has no row identity to key a
	// materialization on, so it must be a set. An all-columns pseudo-key is admitted only
	// when the body is provably a set (`keysOf` gates it on `isSet`); a bag with an
	// all-columns "key" still resolves to empty here and rejects, else duplicates would
	// collide on the backing key.
	//
	// One carve-out: a keyless body whose source key survives through value-preserving
	// passthrough lineage (the parallel-migration collation-weakening shape) is keyed on
	// the COARSENED lineage key instead of rejected — the same `deriveCoarsenedBackingKey`
	// derivation `deriveBackingShape` keyed the backing with, over the same fully-optimized
	// body, so the two agree by construction. Colliding rows then last-write-win under the
	// floor's collation-keyed `replace-all` diff (docs/materialized-views.md § Coarsened
	// backing keys); the create emitter owns the key-coarsening warning.
	if (keysOf(root).length === 0 && deriveCoarsenedBackingKey(root) === undefined) {
		throw cannotMaterialize(mv.name, 'its body has no provable unique key — it is a bag (e.g. a key-dropping '
			+ 'projection or a `union all` of overlapping inputs), so it must be a set');
	}

	// Whole-body determinism: a non-deterministic body can never be kept equal to its
	// plain view by any maintenance, so it is a hard reject unless the schema-determinism
	// gate is lifted. Mirrors the per-arm determinism rejects (and the DDL gate).
	if (!db.options.getBooleanOption('nondeterministic_schema')) {
		const nonDet = findNonDeterministic(analyzed);
		if (nonDet) {
			throw cannotMaterialize(mv.name, `its body is non-deterministic (${nonDet}); a materialized view body must be `
				+ 'reproducible to stay equal to its plain view (set `pragma nondeterministic_schema` to override)');
		}
	}

	// Every source the body reads (set-op legs, every join source, …) so a write to any of
	// them triggers a rebuild. Collected from the (pre-physical) analyzed plan, where every
	// source is a bare `TableReferenceNode` — the optimized plan may have wrapped them in
	// physical access nodes.
	const tableRefs = [...collectTableRefs(analyzed).values()];
	const sourceBases = [...new Set(
		tableRefs.map(ref => `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase()),
	)];
	if (sourceBases.length === 0) throw cannotMaterialize(mv.name, 'its body reads no source table');

	const backing = ctx._findTable(mv.name, mv.schemaName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}

	// ── Cost gate + size reject ──
	// Full-rebuild is the floor: an EMPTY sound set resolves to it (`selectMaintenanceStrategy`).
	// Cost the rebuild against the LARGEST participating source — every write re-evaluates the
	// whole body, so the largest source it scans governs whether the per-write rebuild is
	// pathological (e.g. a tiny driving table joined to a huge lookup gates on the lookup).
	// Re-resolve each source's CURRENT schema (the analyzed plan node may carry a pre-`analyze`
	// snapshot whose `statistics` predates the latest counts) so the size gate reflects the
	// live source size at create time.
	const statsProvider = ctx.optimizer.getStats();
	let largestSchema = tableRefs[0].tableSchema;
	let largestRows = -1;
	for (const ref of tableRefs) {
		const live = liveSourceSchema(ctx, ref);
		const rows = statsProvider.tableRows(live) ?? DEFAULT_SOURCE_ROWS;
		if (rows > largestRows) { largestRows = rows; largestSchema = live; }
	}
	const sourceStats = estimateMaintenanceStats(ctx, largestSchema, backing.columns.length, /*hasPredicate*/ false);

	// Size reject: full-rebuild is the only sound strategy here, so a source past the
	// configurable threshold makes every write pathological. `0` disables the reject.
	const rebuildThreshold = db.options.getNumberOption('materialized_view_rebuild_row_threshold');
	if (isFullRebuildPathological(sourceStats, rebuildThreshold)) {
		const largestBase = `${largestSchema.schemaName}.${largestSchema.name}`.toLowerCase();
		throw cannotMaterialize(mv.name,
			`its only sound maintenance strategy is a full body rebuild, but its largest source '${largestBase}' has `
				+ `~${sourceStats.tableRows} rows, over the materialized_view_rebuild_row_threshold (${rebuildThreshold}) — `
				+ `every write would re-scan it. Raise or disable the threshold `
				+ `(\`pragma materialized_view_rebuild_row_threshold = 0\`)`);
	}

	// Compile the whole optimized body once into a reusable scheduler (no key filter).
	const bodyScheduler = new Scheduler(emitPlanNode(optimized, new EmissionContext(db)));

	const chosenStrategy = selectMaintenanceStrategy([], Math.max(1, sourceStats.tableRows * 0.01), sourceStats);
	if (chosenStrategy !== 'full-rebuild') {
		throw new QuereusError(
			`Internal error: cost gate selected '${chosenStrategy}' for the full-rebuild floor of materialized view '${mv.name}'`,
			StatusCode.INTERNAL,
		);
	}

	return {
		kind: 'full-rebuild',
		mv,
		sourceBase: sourceBases[0],
		backingSchema: mv.schemaName,
		backingTableName: mv.name,
		chosenStrategy,
		sourceStats,
		bodyScheduler,
		sourceBases,
	};
}

/**
 * Compile the key-filtered residual for a binding into a reusable {@link Scheduler}:
 * the analyzed body with a key-equality filter injected on `T`'s `TableReferenceNode`
 * (parameterized `${paramPrefix}0…`), then optimized + emitted. Mirrors the assertion
 * evaluator's residual compilation (`database-assertions.ts`) so the two cannot drift.
 * Returns `null` if `injectKeyFilter` could not target `T` (the arm builder then falls
 * through to the full-rebuild floor).
 */
export function compileResidual(
	ctx: MaterializedViewManagerContext,
	analyzed: BlockNode,
	relKey: string,
	bindColumns: readonly number[],
	paramPrefix: 'gk' | 'pk',
): Scheduler | null {
	const db = ctx as unknown as Database;
	const rewritten = injectKeyFilter(analyzed, relKey, bindColumns, paramPrefix);
	if (rewritten === analyzed) return null; // could not parameterize the residual → floor
	// Suppress the read-side rewrite: the residual is the MV's own body (+ a key
	// filter) compiled to maintain its backing, so it must stay over the source.
	const optimized = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => ctx.optimizer.optimize(rewritten, db) as BlockNode,
	);
	const instruction = emitPlanNode(optimized, new EmissionContext(db));
	return new Scheduler(instruction);
}

/**
 * Compile the WHOLE optimized body (no key filter, read-side rewrite suppressed) into a
 * reusable {@link Scheduler} — the residual arms' per-statement degrade-to-rebuild
 * escape ({@link ResidualArmCommon.fullRebuildScheduler}). Mirrors the floor's own
 * `bodyScheduler` compilation in {@link buildFullRebuildPlan}: run to completion against
 * live mid-transaction source state, its rows feed a single `'replace-all'` keyed diff.
 */
function compileWholeBodyScheduler(ctx: MaterializedViewManagerContext, analyzed: BlockNode): Scheduler {
	const db = ctx as unknown as Database;
	const optimized = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => ctx.optimizer.optimize(analyzed, db) as BlockNode,
	);
	return new Scheduler(emitPlanNode(optimized, new EmissionContext(db)));
}

/**
 * Build a `'prefix-delete'` plan for a single-source lateral-TVF fan-out body
 * (`select T.pk…, …, f.* from T cross join lateral tvf(<args over T>) f`), or return
 * `null` on a shape mismatch (the caller falls through to the full-rebuild floor). The
 * backing PK is the composite product key `(T.pk ∪ tvf-key)` that `keysOf` advertises
 * through the lateral join; the base PK is its leading prefix. See {@link PrefixDeletePlan}
 * and `docs/incremental-maintenance.md` § prefix-delete.
 *
 * Soundness gates (a mismatch on any returns `null` → floor): exactly one lateral TVF and
 * one join (no nested/multi TVF, no aggregate over the fan-out); the TVF advertises a
 * per-call key; the base PK projected and forming the **leading prefix** of the backing PK
 * with a non-empty TVF-key tail (so each base row's fan-out rows are individually
 * addressable and a by-prefix delete selects exactly one base row's slice). An `order by`
 * over the fan-out that reorders the composite key so the base PK no longer leads is a
 * `null` fall-through (the floor maintains it wholesale). The body's WHERE, if any, is part
 * of the residual (so an out-of-scope base row fans out to zero rows), exactly as in the
 * aggregate arm. A **non-deterministic** TVF / argument is the one hard reject (its
 * arm-specific determinism diagnostic must survive).
 */
export function buildLateralTvfPrefixDeletePlan(
	ctx: MaterializedViewManagerContext,
	mv: MaintainedTableSchema,
	analyzed: BlockNode,
	tableRef: TableReferenceNode,
	sourceBase: string,
): MaintenancePlan | null {
	// Exactly one lateral TVF and one join. A second base table is already excluded by
	// the single-source check upstream; this falls to the floor for a second TVF / chained
	// lateral join (`t join lateral tvf1 join lateral tvf2`).
	if (countNodeType(analyzed, PlanNodeType.TableFunctionCall) !== 1) return null;
	if (countJoins(analyzed) !== 1) return null;
	// An aggregate over the fan-out is a different shape → floor (the TVF route is taken
	// before the aggregate route, so an `... group by` over a lateral TVF lands here).
	if (findAggregate(analyzed)) return null;

	// Determinism: a residual must reproduce exactly what `select <body>` returns, so a
	// volatile TVF (or a volatile argument expression) is a HARD reject.
	const tvf = findTableFunctionCall(analyzed);
	if (!tvf) {
		// Unreachable — countNodeType(...) === 1 above guarantees one exists.
		throw new QuereusError(`Internal error: lateral TVF node not found for materialized view '${mv.name}'`, StatusCode.INTERNAL);
	}
	if (tvf.physical.deterministic === false) {
		throw cannotMaterialize(mv.name,
			`it fans out through a non-deterministic table-valued function '${tvf.functionName}' (a row-time fan-out must be reproducible from the base row)`);
	}
	for (const operand of tvf.operands) {
		const det = checkDeterministic(operand);
		if (!det.valid) throw cannotMaterialize(mv.name, `it passes a non-deterministic argument (${det.expression}) to the lateral table-valued function`);
	}

	// The lateral TVF must advertise a per-call key, so the composite product key is a
	// real column key `(base PK ∪ TVF key)` rather than the all-columns / `isSet`
	// fallback. Without one the fan-out rows are not individually addressable by a proper
	// key — the by-prefix delete + keyed upsert would be unsound — so fall to the floor.
	// `getType().keys` carries the validated advertisement (an out-of-range key
	// advertisement is dropped, leaving this empty), so it is the authoritative
	// "did the TVF advertise a usable key" signal.
	if (tvf.getType().keys.length === 0) return null;

	// Base T's PK source columns.
	const sourceSchema = tableRef.tableSchema;
	const sourcePkCols = sourceSchema.primaryKeyDefinition.map(d => d.index);
	if (sourcePkCols.length === 0) return null;

	// Backing table + its physical PK (the composite product key).
	const backing = ctx._findTable(mv.name, mv.schemaName);
	if (!backing) {
		throw new QuereusError(
			`Internal error: backing table '${mv.name}' for materialized view '${mv.name}' not found`,
			StatusCode.INTERNAL,
		);
	}
	const backingPkDefinition = resolveBackingPkColumns(backing, ctx.getCollationResolver());

	// Map each output attribute to a base-T source column (or `undefined` for a TVF
	// output column). T's attributes pass through the join unchanged, so a base-PK
	// output column resolves to a T column while a TVF-key output column does not.
	const sourceAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));
	const producingByAttrId = collectProducingExprs(analyzed);
	const rootAttrs = relationalAttributes(analyzed);
	if (!rootAttrs) return null;

	// Prefix soundness: the LEADING `basePrefixLen` backing-PK columns must each
	// project (transitively) a distinct base-T PK column, their set must equal the base
	// PK, and there must be a non-empty TVF-key tail. So the base PK is the leading
	// prefix of the composite product key and the by-prefix delete selects exactly one
	// base row's fan-out. A composite key that did not form this way falls to the floor.
	const basePrefixLen = sourcePkCols.length;
	if (backingPkDefinition.length <= basePrefixLen) return null;
	const basePkSet = new Set(sourcePkCols);
	const leadingSourceCols = new Set<number>();
	const backingPrefixSourceCols: number[] = [];
	for (let i = 0; i < basePrefixLen; i++) {
		const d = backingPkDefinition[i];
		const attr = rootAttrs[d.index];
		const sc = attr ? resolveTransitiveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
		if (sc === undefined || !basePkSet.has(sc)) return null; // base PK not the leading prefix → floor
		// Soundness precondition for the binary prefix scan (the property
		// `prefix-delete-noncase-collation-regression-test` locks in): the backing base-PK
		// column MUST inherit the source PK column's collation. The btree orders this prefix
		// by `d.collation`, but the keyed diff's existing-slice read (`scanEffective` with
		// the base prefix, in `applyPrefixDelete`) early-terminates the prefix scan on a
		// BINARY compare (scan-layer.ts) — sound ONLY because source-PK uniqueness under that
		// collation collapses each collation class to a single binary value, so a base row's
		// fan-out rows are binary-homogeneous and contiguous. A backing collation MORE
		// permissive than the source's would let collation-equal/binary-different base rows
		// interleave and break that. The backing column derives its collation from the body
		// relation's type (deriveBackingShape), so a mismatch is an internal derivation bug —
		// fail loud rather than register an unsound plan.
		const backingColl = normalizeCollation(d.collation);
		const sourceColl = normalizeCollation(sourceSchema.columns[sc!]?.collation);
		if (backingColl !== sourceColl) {
			throw new QuereusError(
				`Internal error: materialized view '${mv.name}' backing base-PK column `
					+ `'${backing.columns[d.index]?.name ?? d.index}' has collation '${backingColl}' but its source `
					+ `primary-key column '${sourceSchema.columns[sc!]?.name ?? sc}' has collation '${sourceColl}'; `
					+ `the prefix-delete arm's binary prefix scan requires the backing base-PK column to inherit the `
					+ `source PK collation (see scan-layer.ts early-termination)`,
				StatusCode.INTERNAL,
			);
		}
		leadingSourceCols.add(sc!);
		backingPrefixSourceCols.push(sc!);
	}
	if (leadingSourceCols.size !== basePkSet.size) return null; // prefix does not cover the base PK → floor
	// The TVF-key tail must NOT re-use a base-PK column — else the fan-out rows would
	// not be distinguished and the "key" would be base-only (defensive: the product key
	// places the TVF key, a distinct relation's columns, in the tail). Otherwise → floor.
	for (let i = basePrefixLen; i < backingPkDefinition.length; i++) {
		const d = backingPkDefinition[i];
		const attr = rootAttrs[d.index];
		const sc = attr ? resolveTransitiveSourceCol(attr.id, sourceAttrToCol, producingByAttrId) : undefined;
		if (sc !== undefined && basePkSet.has(sc)) return null;
	}

	// Compile + cache the base-PK-keyed residual once (the body with `T.pk = :pk0 AND …`
	// injected on T). Re-run per affected base key against the live transaction; it
	// re-runs the lateral join + TVF for that single base row, fanning out to N rows.
	const relKey = `${sourceBase}#${tableRef.id ?? 'unknown'}`;
	const residualScheduler = compileResidual(ctx, analyzed, relKey, sourcePkCols, 'pk');
	if (!residualScheduler) return null; // could not parameterize the residual → floor

	// ── Cost gate ──
	// The fan-out residual shares the residual-recompute cost shape (a key-filtered
	// re-execution of the body); the fan-out factor (rows per base key) is not known at
	// create, so we cost it as a residual and record the choice for substrate parity.
	// The synchronous reject-at-create / degrade-to-rebuild machinery stays dormant, as
	// it does for the other arms (a TVF whose fan-out is pathological is not detectable
	// without fan-out stats — deferred with the fanning-keyed-join follow-up).
	const soundStrategies: MaintenanceStrategy[] = ['residual-recompute'];
	const hasPredicate = mv.derivation.selectAst.type === 'select' && mv.derivation.selectAst.where !== undefined;
	const sourceStats = estimateMaintenanceStats(ctx, sourceSchema, backing.columns.length, hasPredicate);
	const estimatedChangeCardinality = Math.max(1, sourceStats.tableRows * 0.01);
	const chosenStrategy = selectMaintenanceStrategy(soundStrategies, estimatedChangeCardinality, sourceStats);
	if (chosenStrategy !== 'residual-recompute') {
		throw new QuereusError(
			`Internal error: cost gate selected unwired strategy '${chosenStrategy}' for materialized view '${mv.name}'`,
			StatusCode.INTERNAL,
		);
	}

	return {
		kind: 'prefix-delete',
		mv,
		sourceBase,
		backingSchema: mv.schemaName,
		backingTableName: mv.name,
		chosenStrategy,
		sourceStats,
		binding: { kind: 'row', keyColumns: [...sourcePkCols] },
		residualScheduler,
		bindParamPrefix: 'pk',
		bindColumns: sourcePkCols,
		backingPkDefinition,
		basePrefixLength: basePrefixLen,
		backingPrefixSourceCols,
	};
}

/**
 * Assemble {@link MaintenanceSourceStats} for the cost gate from the optimizer's
 * StatsProvider and tuning. `tableRows` / `distinctGroupsEstimate` come from the
 * provider (heuristic defaults when absent); `forwardBodyCost` is estimated from the
 * forward cost helpers (a scan + optional filter + projection of the source — the
 * covering-index body shape); `fallbackRatio` carries the detection kernel's
 * `deltaPerRowFallbackRatio` for the no-stats residual path.
 */
/**
 * The CURRENT `TableSchema` of a source `TableReferenceNode`, re-resolved through the
 * schema manager. A plan node captures the schema as of plan-build; a later `analyze`
 * replaces the catalog entry with one carrying fresh `statistics`, so the stale captured
 * schema would report pre-`analyze` row counts. Re-resolving keeps the floor's size gate
 * on the live source size. Falls back to the node's captured schema if the name no longer
 * resolves (it always should — the body planned).
 */
export function liveSourceSchema(ctx: MaterializedViewManagerContext, ref: TableReferenceNode): TableSchema {
	const captured = ref.tableSchema;
	return ctx._findTable(captured.name, captured.schemaName) ?? captured;
}

export function estimateMaintenanceStats(
	ctx: MaterializedViewManagerContext,
	sourceSchema: TableSchema,
	projectionCount: number,
	hasPredicate: boolean,
): MaintenanceSourceStats {
	const optimizer = ctx.optimizer;
	const statsProvider = optimizer.getStats();
	const tableRows = statsProvider.tableRows(sourceSchema) ?? DEFAULT_SOURCE_ROWS;
	const forwardBodyCost =
		seqScanCost(tableRows)
		+ (hasPredicate ? filterCost(tableRows) : 0)
		+ projectCost(tableRows, projectionCount);
	const stats: MaintenanceSourceStats = {
		tableRows,
		forwardBodyCost,
		fallbackRatio: optimizer.tuning.deltaPerRowFallbackRatio,
	};
	// `distinctValues` is an optional, per-column StatsProvider method. For the
	// covering-index shape the source PK is the grouping key; a single-column PK
	// yields a usable distinct-groups estimate (which only feeds the never-chosen-here
	// residual cost). Multi-column PKs leave it unset → residual takes the no-stats path.
	const pkDef = sourceSchema.primaryKeyDefinition;
	if (pkDef.length === 1 && statsProvider.distinctValues) {
		const pkColName = sourceSchema.columns[pkDef[0].index]?.name;
		if (pkColName !== undefined) {
			const distinct = statsProvider.distinctValues(sourceSchema, pkColName);
			if (distinct !== undefined) stats.distinctGroupsEstimate = distinct;
		}
	}
	return stats;
}
