/**
 * Optimizer tuning parameters - centralized configuration for magic numbers
 */
export interface OptimizerTuning {
	/** Row estimation defaults */
	readonly defaultRowEstimate: number;

	/**
	 * Floor for the per-pass depth budget. The effective budget is
	 * `max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`,
	 * so this only matters for shallow inputs — wide-input plans scale up
	 * automatically via the headroom term.
	 */
	readonly maxOptimizationDepth: number;

	/**
	 * Extra depth allowance added on top of the input plan's measured depth
	 * when computing the per-pass depth budget. Absorbs rule-introduced
	 * wrapping; the depth guard is meant to catch pathological recursion,
	 * not punish naturally deep input shapes (wide AND trees, deep CASE, …).
	 */
	readonly optimizationDepthHeadroom: number;

	/**
	 * Maximum number of rule firings within a single pass before the pass
	 * aborts. Catches genuinely runaway rewrites independent of input shape;
	 * generously sized so it only trips on stuck rules.
	 */
	readonly maxRulesFired: number;

	/** Join optimization */
	readonly join: {
		/** Minimum left side rows to consider caching right side */
		readonly minLeftRowsForCaching: number;
		/** Maximum right side rows to cache */
		readonly maxRightRowsForCaching: number;
		/** Cache threshold multiplier (rightSize * multiplier) */
		readonly cacheThresholdMultiplier: number;
		/** Maximum cache threshold */
		readonly maxCacheThreshold: number;
	};

	/**
	 * Shared by `rule-scalar-subquery-cache` for its cache threshold. Named `cte`
	 * for historical reasons (it also fed the now-removed CTE-source cache wrap);
	 * kept rather than renamed to avoid rippling into unrelated test overrides.
	 */
	readonly cte: {
		/** Maximum cache threshold */
		readonly maxCacheThreshold: number;
	};

	/** Recursive CTE configuration */
	readonly recursiveCte: {
		/** Maximum iterations before recursive CTE is terminated (0 = unlimited) */
		readonly maxIterations: number;
		/** Default cache threshold for CTE self-references */
		readonly defaultCacheThreshold: number;
	};

	/** Materialization advisory configuration */
	readonly cache: {
		/** Row threshold for switching from memory to spill strategy */
		readonly spillThreshold: number;
		/** Maximum memory buffer size for spill caches */
		readonly maxSpillBuffer: number;
		/** Whether spill caching is enabled */
		readonly spillEnabled: boolean;
	};

	/** AsofScan emitter strategy selection */
	readonly asof: {
		/**
		 * Right-side row count below which the hash strategy is preferred over
		 * merge. Below this threshold, hash buffering's constant factors beat
		 * the merge variant's per-row state bookkeeping.
		 */
		readonly mergeRowThreshold: number;
	};

	/**
	 * Delta executor cost fallback ratio.
	 *
	 * When a `DeltaSubscription` has accumulated more changed distinct binding
	 * tuples than `deltaPerRowFallbackRatio × estimatedRows(base)`, the kernel
	 * demotes the relation to global re-evaluation instead of running N
	 * per-binding residual executions. A first-cut threshold; a real cost
	 * comparator is a follow-up.
	 */
	readonly deltaPerRowFallbackRatio: number;

	/** Set of rule IDs to skip during optimization (test/debug use) */
	readonly disabledRules?: ReadonlySet<string>;

	/** Development and debugging options */
	readonly debug: {
		/** Whether to validate physical plans before emission */
		readonly validatePlan: boolean;
	};

	/** QuickPick join enumeration tuning */
	readonly quickpick?: {
		/** Maximum number of random greedy tours to evaluate */
		readonly maxTours: number;
		/** Time limit in milliseconds for enumeration (soft cap) */
		readonly timeLimitMs: number;
		/** Minimum estimated plan cost to trigger enumeration */
		readonly minTriggerCost: number;
		/** Enable/disable QuickPick globally */
		readonly enabled: boolean;
	};

	/**
	 * Parallel-execution rule tuning. Consumed by `rule-fanout-lookup-join`
	 * (the FK→PK fan-out recognition rule), `rule-async-gather-union-all`
	 * (the UNION ALL gather recognition rule), and `rule-async-gather-zip-by-key`
	 * (the full-outer-on-shared-key zip gather recognition rule). All values are
	 * unitless cost comparators except `concurrency`, which is a row-time branch
	 * cap.
	 */
	readonly parallel: {
		/** Don't form a fan-out / gather below this branch count. Default 2. */
		readonly minBranches: number;
		/**
		 * Per-branch fixed overhead, charged against the latency win. Anchored
		 * against `COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW`; the value only matters
		 * relative to `expectedLatencyMs`, so the unit is "ms-equivalent cost".
		 * Default 1.0.
		 */
		readonly branchSetupCost: number;
		/** Static cap on in-flight branches per outer row. Default 8. */
		readonly concurrency: number;
		/**
		 * Global cap on concurrent branch lookups across *all* in-flight outer
		 * rows in a `outerMode: 'batched'` fan-out lookup join. Distinct from
		 * `concurrency` (the per-row serial cap): the batched driver shares a
		 * single semaphore over this budget so a small per-row `branchCount` can
		 * still saturate block I/O by admitting more outer rows ahead of the
		 * emit frontier. With `maxOuterReadAhead` it also fixes the seeks-in-flight
		 * count `rule-join-physical-selection` prices a batched index-nested-loop
		 * at (`min(outerBatchConcurrency, maxOuterReadAhead)`). Default 16.
		 */
		readonly outerBatchConcurrency: number;
		/**
		 * Hard clamp on the number of outer rows a batched fan-out lookup join
		 * admits ahead of the emit frontier. Bounds the order-preserving reorder
		 * buffer (and the number of forked per-row contexts) so a `branchCount`
		 * of 1 cannot fork an unbounded number of contexts. The effective
		 * read-ahead is `clamp(ceil(outerBatchConcurrency / branchCount), 1,
		 * maxOuterReadAhead)`. Default 64.
		 */
		readonly maxOuterReadAhead: number;
		/**
		 * Minimum slowest-branch `expectedLatencyMs` for `toBatchedOuter` (the
		 * `rule-fanout-batched-outer` flip, also applied by
		 * `rule-join-physical-selection` to a proved-at-most-one index-nested-loop
		 * candidate) to flip a `FanOutLookupJoinNode` from `serial` to `batched`
		 * outer mode. Like `gatherThresholdMs` / `prefetchProbeThresholdMs`,
		 * any positive value keeps the rule inert on memory-vtab plans (their leaves
		 * declare `expectedLatencyMs = 0`), so the golden-plan sweep is unaffected.
		 * Default 25 ms — matches the synthetic high-latency vtab fixture the other
		 * parallel rules use.
		 */
		readonly batchedOuterThresholdMs: number;
		/**
		 * Minimum estimated outer-row count for `toBatchedOuter` (same two callers
		 * as above) to flip to `batched`. Cross-row pipelining only amortizes the reorder-buffer +
		 * per-row-fork overhead when outer rows clearly exceed the read-ahead window;
		 * below this the serial per-row overlap is already an upper bound on
		 * wall-clock. An unknown estimate (`undefined`) is treated as *failing* the
		 * gate (conservative — never flip on a missing statistic). Synthetic
		 * memory-vtab fixtures resolve `estimatedRows` to 0, so the default also keeps
		 * the rule inert there independent of the latency gate. Default 256
		 * (≈ 4× `maxOuterReadAhead`).
		 */
		readonly batchedOuterMinRows: number;
		/**
		 * The slowest child of a UNION ALL chain must have at least this expected
		 * first-row latency (in milliseconds) for `rule-async-gather-union-all`
		 * to fold it into an `AsyncGatherNode`. Set high enough that local-only
		 * memory-vtab plans never trigger — `expectedLatencyMs` is 0 throughout
		 * those plans, so any positive value keeps the rule inert there. Default
		 * 25 ms (matches the high-latency vtab fixture used by the parallel
		 * optimizer tests, so the same fixture exercises both this rule and the
		 * fan-out rule).
		 */
		readonly gatherThresholdMs: number;
		/**
		 * Minimum `right.physical.expectedLatencyMs` (in milliseconds) on a
		 * physical hash join's build side for `rule-eager-prefetch-probe` to wrap
		 * the probe (`left`) input in an `EagerPrefetchNode`. Like
		 * `gatherThresholdMs`, any positive value keeps the rule inert on
		 * memory-vtab plans (their leaves declare `expectedLatencyMs=0`). Default
		 * 25 ms — the same high-latency vtab fixture value the other parallel
		 * rules use, so no test-side tuning is needed to exercise the rule.
		 */
		readonly prefetchProbeThresholdMs: number;
		/**
		 * Buffer size handed to the `EagerPrefetchNode` the prefetch-probe rule
		 * inserts. Default 64 — mirrors the `EagerPrefetchNode` constructor
		 * default so the in-tree default matches what manual construction
		 * already produces.
		 */
		readonly prefetchBufferSize: number;
		/**
		 * Per-branch row cap for `cross` (1:n) fan-out lookup-join branches.
		 * `rule-fanout-lookup-join` refuses to fold a parameterized equi-lookup
		 * that is *not* provably at-most-one into a `cross` branch when that
		 * lookup's row estimate exceeds this — its Cartesian contribution could
		 * blow memory, so the chain is left as a streaming nested-loop join.
		 * At-most-one branches (FK→PK) are exempt: they contribute ≤1 row per
		 * outer row. Default 10000.
		 */
		readonly maxCrossBranchRows: number;
		/**
		 * Whole-product cap for a `cross` fan-out lookup join:
		 * `outer.estimatedRows × Π(cross-branch estimatedRows)`. Above this the
		 * chain stays nested-loop. Unknown estimates are treated as *exceeding*
		 * the cap (conservative) so a missing statistic never authorizes an
		 * unbounded product. Default 1e6.
		 */
		readonly maxCrossProduct: number;
	};
}

/**
 * Default optimizer tuning parameters
 */
export const DEFAULT_TUNING: OptimizerTuning = {
	defaultRowEstimate: 1000,
	maxOptimizationDepth: 50,
	optimizationDepthHeadroom: 16,
	maxRulesFired: 100000,
	join: {
		minLeftRowsForCaching: 1,
		maxRightRowsForCaching: 50000,
		cacheThresholdMultiplier: 2,
		maxCacheThreshold: 10000
	},
	cte: {
		maxCacheThreshold: 20000
	},
	recursiveCte: {
		maxIterations: 10000,
		defaultCacheThreshold: 10000
	},
	cache: {
		spillThreshold: 100000,
		maxSpillBuffer: 10000,
		spillEnabled: true
	},
	asof: {
		mergeRowThreshold: 10000
	},
	deltaPerRowFallbackRatio: 0.5,
	debug: {
		validatePlan: false // Default to disabled in production
	},
	quickpick: {
		maxTours: 100,
		timeLimitMs: 100,
		minTriggerCost: 0,
		enabled: true
	},
	parallel: {
		minBranches: 2,
		// 1.0 ≈ COST_CONSTANTS.NL_JOIN_PER_OUTER_ROW; this is "ms-equivalent" because
		// it is compared directly against `expectedLatencyMs * (N - cap)` savings.
		branchSetupCost: 1.0,
		concurrency: 8,
		// Global in-flight budget for batched-outer fan-out lookup joins, shared
		// across all in-flight outer rows. Larger than `concurrency` so a small
		// per-row branch count can still saturate block I/O.
		outerBatchConcurrency: 16,
		// Hard clamp on outer rows admitted ahead of the emit frontier in a
		// batched fan-out lookup join; bounds the reorder buffer and forked
		// per-row contexts.
		maxOuterReadAhead: 64,
		// ≥ this many ms on the slowest branch flips a fan-out to batched outer
		// mode. 25 ms matches the synthetic high-latency vtab fixture; memory-vtab
		// plans declare 0 ms so the rule stays inert on local-only plans.
		batchedOuterThresholdMs: 25,
		// ≥ this many estimated outer rows required before batched is worthwhile;
		// ≈ 4× maxOuterReadAhead. Unknown estimates fail the gate; memory-vtab
		// fixtures resolve to 0 and never flip.
		batchedOuterMinRows: 256,
		// ≥ this many ms on the slowest child of a unionAll chain triggers the
		// parallel gather. 25 ms matches the synthetic high-latency vtab fixture;
		// memory-vtab plans declare 0 ms so they never cross this gate.
		gatherThresholdMs: 25,
		// ≥ this many ms on a hash join's build (right) side triggers wrapping
		// the probe (left) side in EagerPrefetch. 25 ms matches the synthetic
		// high-latency vtab fixture; memory-vtab plans declare 0 ms so the rule
		// stays inert on local-only plans.
		prefetchProbeThresholdMs: 25,
		// Ring-buffer size for the inserted EagerPrefetchNode; mirrors the node's
		// own constructor default.
		prefetchBufferSize: 64,
		// Per-branch row cap for `cross` (1:n) fan-out branches; a lookup whose
		// estimate exceeds this stays a nested-loop join. At-most-one branches
		// are exempt.
		maxCrossBranchRows: 10000,
		// Whole-product cap for a cross fan-out (outer × Π cross-branch rows);
		// unknown estimates count as exceeding it. Bounds the per-outer-row
		// product replay the node materializes.
		maxCrossProduct: 1_000_000,
	}
};
