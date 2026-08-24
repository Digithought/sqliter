/**
 * Cost model helpers for query optimization
 * Provides consistent cost estimation formulas across the optimizer
 */

import { quereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";

/**
 * Basic cost constants (in arbitrary "virtual CPU units")
 */
export const COST_CONSTANTS = {
	/** Cost per row for sequential scan */
	SEQ_SCAN_PER_ROW: 1.0,
	/** Base cost for starting a sequential scan */
	SEQ_SCAN_BASE: 0.1,

	/** Cost per row for index seek */
	INDEX_SEEK_PER_ROW: 0.3,
	/** Base cost for index seek operation */
	INDEX_SEEK_BASE: 0.5,

	/** Cost per row for index scan */
	INDEX_SCAN_PER_ROW: 0.5,
	/** Base cost for index scan operation */
	INDEX_SCAN_BASE: 0.3,

	/** Cost per row for sorting */
	SORT_PER_ROW: 2.0,
	/** Log base for sort cost calculations */
	SORT_LOG_BASE: 2,

	/** Cost per row for filtering */
	FILTER_PER_ROW: 0.2,

	/** Cost per row for projection */
	PROJECT_PER_ROW: 0.1,

	/** Cost per output row for aggregation */
	AGGREGATE_PER_GROUP: 1.5,
	/** Cost per input row for aggregation */
	AGGREGATE_PER_INPUT_ROW: 0.3,

	/** Cost per row for nested loop join (inner side) */
	NL_JOIN_PER_INNER_ROW: 0.1,
	/** Cost per row for nested loop join (outer side) */
	NL_JOIN_PER_OUTER_ROW: 1.0,

	/** Cost per row for bloom/hash join build phase */
	HASH_JOIN_BUILD_PER_ROW: 0.8,
	/** Cost per row for bloom/hash join probe phase */
	HASH_JOIN_PROBE_PER_ROW: 0.4,

	/** Cost per row for merge join comparison */
	MERGE_JOIN_PER_ROW: 0.3,

	/** Cost per row for distinct operation */
	DISTINCT_PER_ROW: 1.2,

	/** Cost per row for limit operation */
	LIMIT_PER_ROW: 0.05,

	/** Cost per row for cache access */
	CACHE_ACCESS_PER_ROW: 0.1,
	/** Cost per row for cache population */
	CACHE_POPULATE_PER_ROW: 0.2,

	/** Cost per input row for hash aggregate (hashing + map insertion) */
	HASH_AGG_BUILD_PER_ROW: 0.5,
	/** Cost per group for hash aggregate finalization */
	HASH_AGG_PER_GROUP: 1.0,

	/** Cost per input row for stream aggregate */
	STREAM_AGG_PER_INPUT_ROW: 0.1,
	/** Cost per output group for stream aggregate */
	STREAM_AGG_PER_GROUP: 1.5,
} as const;

/**
 * Calculate cost for sequential scan
 */
export function seqScanCost(rows: number): number {
	return COST_CONSTANTS.SEQ_SCAN_BASE + (rows * COST_CONSTANTS.SEQ_SCAN_PER_ROW);
}

/**
 * Calculate cost for index seek (point lookup or tight range)
 */
export function indexSeekCost(rows: number): number {
	return COST_CONSTANTS.INDEX_SEEK_BASE + (rows * COST_CONSTANTS.INDEX_SEEK_PER_ROW);
}

/**
 * Calculate cost for index scan (range scan with ordering)
 */
export function indexScanCost(rows: number): number {
	return COST_CONSTANTS.INDEX_SCAN_BASE + (rows * COST_CONSTANTS.INDEX_SCAN_PER_ROW);
}

/**
 * Calculate cost for sorting operation
 * Uses O(n log n) complexity
 */
export function sortCost(rows: number): number {
	if (rows <= 1) return COST_CONSTANTS.SORT_PER_ROW;
	return rows * Math.log2(rows) * COST_CONSTANTS.SORT_PER_ROW;
}

/**
 * Calculate cost for filter operation
 */
export function filterCost(inputRows: number): number {
	return inputRows * COST_CONSTANTS.FILTER_PER_ROW;
}

/**
 * Calculate cost for projection operation
 */
export function projectCost(rows: number, projectionCount: number = 1): number {
	return rows * projectionCount * COST_CONSTANTS.PROJECT_PER_ROW;
}

/**
 * Calculate cost for aggregation operation
 */
export function aggregateCost(inputRows: number, outputRows: number): number {
	return (inputRows * COST_CONSTANTS.AGGREGATE_PER_INPUT_ROW) +
		   (outputRows * COST_CONSTANTS.AGGREGATE_PER_GROUP);
}

/**
 * Calculate cost for hash aggregate operation
 */
export function hashAggregateCost(inputRows: number, estimatedGroups: number): number {
	return (inputRows * COST_CONSTANTS.HASH_AGG_BUILD_PER_ROW) +
		   (estimatedGroups * COST_CONSTANTS.HASH_AGG_PER_GROUP);
}

/**
 * Calculate cost for stream aggregate operation (excluding any sort)
 */
export function streamAggregateCost(inputRows: number, outputRows: number): number {
	return (inputRows * COST_CONSTANTS.STREAM_AGG_PER_INPUT_ROW) +
		   (outputRows * COST_CONSTANTS.STREAM_AGG_PER_GROUP);
}

/**
 * Calculate cost for nested loop join
 */
export function nestedLoopJoinCost(outerRows: number, innerRows: number): number {
	return (outerRows * COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW) +
		   (outerRows * innerRows * COST_CONSTANTS.NL_JOIN_PER_INNER_ROW);
}

/**
 * Cost for an index-nested-loop join: one index seek into the inner side per
 * outer row. `rowsPerSeek` is the MODULE's estimate for the equality access
 * plan — selectivity authority stays with the module that owns the index rather
 * than being re-derived from engine-side statistics (same discipline as
 * rule-key-set-seek's break-even). `perSeekLatencyMs` is the inner subtree's
 * `physical.expectedLatencyMs` (0 for every in-process vtab), treated as
 * ms-equivalent cost — the same convention as `tuning.parallel.branchSetupCost`.
 *
 * NOTE: the field's two consumers read it on incompatible scales, and this one is the
 * ratio side. The `tuning.parallel.*ThresholdMs` gates (all 25 today) read
 * `expectedLatencyMs` as literal wall-clock milliseconds; this formula adds it to cost
 * constants whose unit is `SEQ_SCAN_PER_ROW = 1.0`, i.e. ONE SCANNED ROW. The two readings
 * agree only where a scanned row costs about 1 ms — true of the network-latency backends
 * this machinery was designed for (25-100 ms, where latency swamps engine cost and the
 * ratio stops mattering), and off by roughly two orders of magnitude for a sub-millisecond
 * backend, whose honest declaration is worth tens of cost units on this scale and a
 * fraction of one on the gates' scale. Inert today: every gate sits at 25 ms and no in-tree
 * module declares a sub-millisecond value (the IndexedDB and LevelDB providers both decline
 * to, with their reasons recorded at their `costProfile` sites). Revisit if either changes —
 * and do NOT resolve it by inflating a declaration to the ratio value, which would lie to
 * the wall-clock gates.
 */
export function indexNestedLoopJoinCost(
	outerRows: number, rowsPerSeek: number, perSeekLatencyMs = 0,
): number {
	return outerRows * (
		COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW
		+ COST_CONSTANTS.INDEX_SEEK_BASE
		+ rowsPerSeek * COST_CONSTANTS.INDEX_SEEK_PER_ROW
		+ perSeekLatencyMs
	);
}

/**
 * Index-nested-loop with the per-outer-row seeks pipelined (a one-branch
 * `FanOutLookupJoinNode` in `batched` outer mode): the engine-side per-row work
 * is unchanged — the engine is single-threaded — and only the storage latency is
 * amortized across the `inFlight` seeks the batched driver keeps open at once.
 * `rowsPerSeek` and `perSeekLatencyMs` mean what they do for
 * {@link indexNestedLoopJoinCost}; at `inFlight <= 1` the two formulas agree.
 *
 * The caller derives `inFlight` as `min(outerBatchConcurrency,
 * maxOuterReadAhead)` for one branch — see the coupling comment at
 * `deriveReadAhead` in `runtime/emit/fanout-lookup-join.ts`, the driver-side
 * half of the same number.
 */
export function batchedIndexNestedLoopJoinCost(
	outerRows: number, rowsPerSeek: number, perSeekLatencyMs: number, inFlight: number,
): number {
	return outerRows * (
		COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW
		+ COST_CONSTANTS.INDEX_SEEK_BASE
		+ rowsPerSeek * COST_CONSTANTS.INDEX_SEEK_PER_ROW
		+ perSeekLatencyMs / Math.max(1, inFlight)
	);
}

/**
 * Calculate cost for merge join
 * Includes optional sort costs for each side
 */
export function mergeJoinCost(leftRows: number, rightRows: number, needsSortLeft: boolean, needsSortRight: boolean): number {
	let cost = (leftRows + rightRows) * COST_CONSTANTS.MERGE_JOIN_PER_ROW;
	if (needsSortLeft) cost += sortCost(leftRows);
	if (needsSortRight) cost += sortCost(rightRows);
	return cost;
}

/**
 * Calculate cost for bloom/hash join
 */
export function hashJoinCost(buildRows: number, probeRows: number): number {
	return (buildRows * COST_CONSTANTS.HASH_JOIN_BUILD_PER_ROW) +
		   (probeRows * COST_CONSTANTS.HASH_JOIN_PROBE_PER_ROW);
}

/**
 * Calculate cost for distinct operation
 */
export function distinctCost(rows: number): number {
	// Distinct typically involves sorting or hashing
	return rows * COST_CONSTANTS.DISTINCT_PER_ROW;
}

/**
 * Calculate cost for limit operation
 */
export function limitCost(inputRows: number, limitValue: number): number {
	const processedRows = Math.min(inputRows, limitValue);
	return processedRows * COST_CONSTANTS.LIMIT_PER_ROW;
}

/**
 * Calculate cost for cache operations
 */
export function cacheCost(rows: number, accessCount: number = 1): number {
	const populateCost = rows * COST_CONSTANTS.CACHE_POPULATE_PER_ROW;
	const accessCost = rows * accessCount * COST_CONSTANTS.CACHE_ACCESS_PER_ROW;
	return populateCost + accessCost;
}

/**
 * Helper to choose the minimum cost option
 */
export function chooseCheapest<T>(options: Array<{ cost: number; option: T }>): T {
	if (options.length === 0) {
		quereusError('No options provided to chooseCheapest', StatusCode.INTERNAL);
	}
	return options.reduce((min, current) =>
		current.cost < min.cost ? current : min
	).option;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Backward (maintenance-direction) cost surface
 *
 * The formulas above estimate forward (read-direction) cost. Row-time
 * materialized-view maintenance needs the *backward* cost: how expensive it is to
 * keep an MV's backing table consistent as its source changes. `maintenanceCost`
 * is that judgment; the create-time gate (`buildMaintenancePlan` in
 * core/database-materialized-views.ts) picks the cheapest structurally-sound
 * strategy via `selectMaintenanceStrategy`. See docs/incremental-maintenance.md.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The maintenance strategies the incremental substrate **costs** — a subset of
 * `MaintenancePlan['kind']` in core/database-materialized-views.ts, plus
 * `'delta-aggregate'`: the arithmetic fast path INSIDE the `'residual-recompute'` arm
 * (the plan kind stays `'residual-recompute'`; the apply path routes on the plan's
 * `delta` descriptor). The arms the cost model does not distinguish (`'prefix-delete'`,
 * `'join-residual'`) record the strategy they are costed as (`'residual-recompute'`) in
 * their `chosenStrategy`. Each arm builder calls {@link selectMaintenanceStrategy} with
 * its own sound set and rejects any answer outside it as INTERNAL, so the gate can never
 * hand back a strategy no arm implements (docs/invariants.md MV-007).
 */
export type MaintenanceStrategy = 'inverse-projection' | 'residual-recompute' | 'delta-aggregate' | 'full-rebuild';

/**
 * Default source row count above which a per-write `'full-rebuild'` is pathological under
 * the synchronous (row-time, in-transaction) policy: every DML statement on the source
 * would trigger a full scan of it. A body whose only sound strategy is `'full-rebuild'`
 * over a source larger than this is rejected at view-create time rather than degraded
 * per write (see {@link isFullRebuildPathological}). This is the default for the
 * configurable `materialized_view_rebuild_row_threshold` option; `0` disables the reject
 * (accept any size).
 */
export const MAINTENANCE_REBUILD_ROW_THRESHOLD = 10_000;

/**
 * Defensive no-stats fallback multiplier for the `'residual-recompute'` arm. The gate
 * normally threads DeltaExecutor's `deltaPerRowFallbackRatio` (DEFAULT_TUNING, currently
 * 0.5) through {@link MaintenanceSourceStats.fallbackRatio}; this literal is only used
 * when a caller omits it, and is kept equal to that default so the no-stats path is
 * unchanged from the legacy ratio heuristic.
 */
const DEFAULT_RESIDUAL_FALLBACK_RATIO = 0.5;

/**
 * Inputs to {@link maintenanceCost}, assembled at view-create time from the forward
 * optimizer and the `StatsProvider` (`planner/stats/index.ts`). `tableRows` /
 * `distinctGroupsEstimate` come from `StatsProvider.tableRows` / `distinctValues`;
 * `forwardBodyCost` is the read-direction cost of the full view body; `fallbackRatio`
 * is `optimizer.tuning.deltaPerRowFallbackRatio`, used only on the no-stats path.
 */
export interface MaintenanceSourceStats {
	/** Estimated source row count (StatsProvider.tableRows). For a multi-source body fed
	 *  to {@link isFullRebuildPathological} this is the **largest** participating source's
	 *  count — every write rebuilds the whole body, so the largest source it scans governs
	 *  whether the per-write full-rebuild is pathological. */
	tableRows: number;
	/** Estimated distinct groups/keys per change (StatsProvider.distinctValues); absent ⇒ no-stats path. */
	distinctGroupsEstimate?: number;
	/** Forward (read-direction) cost of the full view body. */
	forwardBodyCost: number;
	/** No-stats fallback multiplier; the gate supplies tuning.deltaPerRowFallbackRatio. */
	fallbackRatio?: number;
	/** Expected fraction of changes to a **tighten-only** (min/max) delta-aggregate body
	 *  that retract and so fall back to the key-filtered residual for their group. Set at
	 *  create only for a `'delta-aggregate'` body carrying a tighten column (min/max, or a
	 *  join-semilattice UDAF — `merge`, no `negate`); blended into the delta cost by
	 *  {@link maintenanceCost}. Absent/0 ⇒ pure-group body, delta cost unchanged. */
	deltaTightenFallbackRatio?: number;
}

/**
 * Backward (maintenance-direction) cost of applying `strategy` to `changeCardinality`
 * distinct changed rows/groups against a source described by `stats`. Lower is cheaper.
 *
 * This is the single cost judgment the row-time maintenance gate uses to choose among
 * the structurally sound strategies for a body. It is a planning-time decision, and is
 * re-checked per write only for the residual → rebuild demotion ({@link shouldDegradeToRebuild}).
 *
 *  - `'inverse-projection'`: O(1) per changed row — an index seek plus reprojection.
 *    Always the cheapest arm for the covering-index shapes it is eligible for; never demoted.
 *  - `'residual-recompute'`: recompute the key-filtered residual body once per changed
 *    group. With stats, costed against rows-per-group (tableRows / distinctGroupsEstimate);
 *    with no stats, falls back to the legacy `deltaPerRowFallbackRatio` heuristic so
 *    behaviour is unchanged on the no-stats path.
 *  - `'delta-aggregate'`: O(1) arithmetic per changed row plus one read-modify-write of
 *    the stored group row per affected group — no source read, no residual re-execution.
 *    Modeled as an index seek + reprojection per change (the same shape as
 *    inverse-projection), CAPPED at half the residual per-group cost: per affected
 *    group the delta does strictly less work than the residual (one point RMW vs a
 *    key-filtered body re-execution over that group's source rows), so it must cost
 *    strictly below `'residual-recompute'` for every stats input — including a
 *    small/empty source at create time, where the residual's no-stats fallback
 *    (`forwardBodyCost × ratio`) shrinks below any fixed constant. A body carrying a
 *    **tighten-only** (min/max) column blends in `deltaTightenFallbackRatio` — the expected
 *    fraction of retracting changes that re-derive their group from the full residual — so
 *    it costs strictly more than a pure-group body but, for the small create-time estimate,
 *    still below the always-residual arm.
 *  - `'full-rebuild'`: re-evaluate the whole body once — the always-correct floor,
 *    independent of changeCardinality.
 */
export function maintenanceCost(
	strategy: MaintenanceStrategy,
	changeCardinality: number,
	stats: MaintenanceSourceStats,
): number {
	switch (strategy) {
		case 'inverse-projection':
			return changeCardinality * (COST_CONSTANTS.INDEX_SEEK_PER_ROW + COST_CONSTANTS.PROJECT_PER_ROW);
		case 'delta-aggregate': {
			// Pure-group delta cost: an index seek + reprojection per change, capped at half the
			// residual per-group cost (delta does strictly less work than the residual per group).
			const deltaPerGroup = Math.min(
				COST_CONSTANTS.INDEX_SEEK_PER_ROW + COST_CONSTANTS.PROJECT_PER_ROW,
				residualCostPerGroup(stats) * 0.5,
			);
			// A tighten-only (min/max) column re-derives the fraction `f` of changes that retract
			// from the FULL residual. Blend: `(1-f)·deltaPerGroup + f·residualPerGroup`. Pure-group
			// bodies (f = 0) reduce to exactly `deltaPerGroup` — unchanged. `f` is a create-time
			// estimate (small), so a tighten body costs more than a pure-group one yet stays below
			// the always-residual arm; only a (currently unmeasurable) retraction-heavy `f` would
			// legitimately tip the argmin to plain residual.
			const f = stats.deltaTightenFallbackRatio ?? 0;
			return changeCardinality * ((1 - f) * deltaPerGroup + f * residualCostPerGroup(stats));
		}
		case 'residual-recompute':
			return changeCardinality * residualCostPerGroup(stats);
		case 'full-rebuild':
			return stats.forwardBodyCost;
		default: {
			// A new strategy must extend this switch; never-assignment makes that a
			// compile error rather than a silent mis-cost. Falls back to the rebuild floor.
			const exhaustiveCheck: never = strategy;
			void exhaustiveCheck;
			return stats.forwardBodyCost;
		}
	}
}

/**
 * Cost of recomputing the key-filtered residual body for a single changed group. With
 * stats present this is a filtered, reprojected scan of one group's rows
 * (tableRows / distinctGroupsEstimate). With stats absent it reproduces the legacy
 * `deltaPerRowFallbackRatio` heuristic (forwardBodyCost × ratio) so the no-stats path
 * is byte-for-byte the previous behaviour.
 */
function residualCostPerGroup(stats: MaintenanceSourceStats): number {
	const haveStats =
		stats.distinctGroupsEstimate !== undefined &&
		stats.distinctGroupsEstimate > 0 &&
		stats.tableRows > 0;
	if (!haveStats) {
		const ratio = stats.fallbackRatio ?? DEFAULT_RESIDUAL_FALLBACK_RATIO;
		return stats.forwardBodyCost * ratio;
	}
	const rowsPerGroup = stats.tableRows / stats.distinctGroupsEstimate!;
	return rowsPerGroup * (COST_CONSTANTS.SEQ_SCAN_PER_ROW + COST_CONSTANTS.FILTER_PER_ROW + COST_CONSTANTS.PROJECT_PER_ROW);
}

/**
 * Choose the cheapest structurally-sound maintenance strategy at create time: argmin
 * over `soundStrategies` of {@link maintenanceCost}. `soundStrategies` is the set the
 * soundness analysis admits for the body shape; `'full-rebuild'` is always sound and
 * acts as the floor, so an empty list resolves to it.
 */
export function selectMaintenanceStrategy(
	soundStrategies: readonly MaintenanceStrategy[],
	changeCardinality: number,
	stats: MaintenanceSourceStats,
): MaintenanceStrategy {
	if (soundStrategies.length === 0) return 'full-rebuild';
	return chooseCheapest(soundStrategies.map(strategy => ({
		cost: maintenanceCost(strategy, changeCardinality, stats),
		option: strategy,
	})));
}

/**
 * True when a per-write `'full-rebuild'` is pathological under the synchronous policy:
 * the source is large and the body costs more than a full scan of it, so every DML
 * write would scan the whole source. The gate uses this to reject-at-create when
 * `'full-rebuild'` is a body's only sound strategy.
 *
 * `threshold` is the configurable row ceiling (the `materialized_view_rebuild_row_threshold`
 * option; default {@link MAINTENANCE_REBUILD_ROW_THRESHOLD}). A `threshold` of `0` (or any
 * non-positive value) **disables** the size reject — full-rebuild of any size is accepted.
 * For a multi-source body `stats.tableRows` is the largest participating source (see
 * {@link MaintenanceSourceStats.tableRows}).
 */
export function isFullRebuildPathological(stats: MaintenanceSourceStats, threshold: number): boolean {
	if (threshold <= 0) return false; // 0 disables the size reject (accept any size)
	const fullScanCost = stats.tableRows * COST_CONSTANTS.SEQ_SCAN_PER_ROW;
	return stats.tableRows > threshold && stats.forwardBodyCost > fullScanCost;
}

/**
 * Per-write demotion test for the `'residual-recompute'` arm: at the DML boundary the
 * actual `changeCardinality` of the current statement may spike above the
 * residual ↔ rebuild crossover, at which point a single `'full-rebuild'` for that
 * statement is cheaper. Returns true when the driver should set `degradeToRebuild` for
 * this statement only (the stored strategy is retained for later, lower-cardinality writes).
 * Stateless by design, so a subsequent low-cardinality statement naturally reverts.
 */
export function shouldDegradeToRebuild(
	changeCardinality: number,
	stats: MaintenanceSourceStats,
): boolean {
	return maintenanceCost('residual-recompute', changeCardinality, stats) >
		maintenanceCost('full-rebuild', changeCardinality, stats);
}
