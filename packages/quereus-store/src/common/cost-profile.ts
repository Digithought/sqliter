/**
 * What a storage backend's basic read operations cost, declared by the provider and
 * consumed by store access planning (`store-module-access-plan.ts`) — plus the one other
 * provider-declared planner input resolved the same way, {@link resolveExpectedLatencyMs}
 * (first-row latency, wall-clock rather than a ratio; see its doc comment).
 *
 * The store framework already lets a provider declare things about itself that the
 * layers above must adapt to — `beginAtomicBatch`, `readCommittedSnapshot`,
 * `concurrencyMode`. Cost belongs on that list: the same index seek that is nearly free
 * on LevelDB (block cache, in-process reads) is a separate request across a browser IPC
 * boundary on IndexedDB, and pricing both at one number makes the planner wrong for one
 * of them.
 */

/**
 * What one storage backend's basic operations cost, RELATIVE to reading one row
 * sequentially during a full scan (which is 1.0 by definition — the unit
 * `AccessPlanBuilder.fullScan` charges per row).
 *
 * Every field is optional; an omitted field takes the parity default
 * ({@link PARITY_COST_PROFILE}), which reproduces the module's pre-profile constants
 * exactly. A provider that declares nothing plans byte-identically to before.
 *
 * A ratio rather than milliseconds, deliberately: these numbers are request-latency
 * dominated, so a slower device scales both the seek path AND the scan baseline
 * together and the ratio survives. A wall-clock declaration would be wrong on every
 * device but the one it was measured on.
 *
 * NOTE: there is deliberately no third `entryRead` knob for reading an index ENTRY.
 * That per-row term is the ENGINE's — `AccessPlanBuilder.eqMatch` charges `rows * 0.3`
 * and `.rangeScan` charges `rows * 0.5`, both internal to the builder and shared with
 * the memory module — so scaling it from here means either restating the builder's
 * formula in the store (exactly the drift `AccessPlanBuilder.addCost` exists to
 * prevent) or growing a new builder surface, for a term the IndexedDB benchmark puts at
 * 0.8× a data row, i.e. within noise of parity. If a backend ever shows index-entry
 * reads pricing very differently from data rows, add `entryRead` here AND give
 * `AccessPlanBuilder` a per-row-entry hook — do not restate its formula in this package.
 */
export interface KVCostProfile {
	/**
	 * Resolving ONE secondary-index entry to the row it names — a random point read of
	 * the data store, batched through `getMany` (`StoreTableScan` pages at
	 * `ROW_RESOLUTION_BATCH`). Default 1.0.
	 *
	 * Priced by the three single-window index arms (`eq`, `prefixRange`, `range`), which
	 * pay it once per row they expect to return, on top of the `AccessPlanBuilder`
	 * shape's own per-row index-entry term.
	 */
	readonly pointRead?: number;

	/**
	 * The per-seek-key cost of a multi-seek: positioning one index window AND reading the
	 * row(s) it names. It is a WHOLE-key cost, not just the positioning half, because the
	 * multi-seek arms deliberately charge no separate per-row resolution (the reason is
	 * recorded at those arms in `store-module-access-plan.ts`). Default 0.5.
	 *
	 * This is the knob that actually moves plan CHOICE today: the engine's
	 * `rule-key-set-seek` probes the module at 2 and 1000 seek keys, fits a line, and
	 * solves for the key count at which a seek overtakes the plan it would displace. With
	 * the store's multi-seek cost `k·S + 0.3·min(N, k·0.1N)` against a scan baseline of
	 * `N` rows, the break-even lands at roughly `N/(2S)`.
	 *
	 * NOTE: ONE knob, TWO arms — and they do not run the same shape. The secondary-index
	 * multi-seek opens one `iterate()` window per seek key over the index store; the
	 * primary-key multi-seek (`primaryKeyMultiSeekPlan`) runs `scanMultiSeekPrimary`, which
	 * BATCHES through `readEffectiveRowsByKeys` at `ROW_RESOLUTION_BATCH` and pays no
	 * per-key iterator at all. The gap is backend-dependent and was small enough to accept
	 * when IndexedDB was measured (≈3 real against 5 charged, recorded at the PK arm in
	 * `store-module-access-plan.ts`). LevelDB's 2026-08-19 measurement puts the same two
	 * shapes roughly an ORDER OF MAGNITUDE apart on that backend — a windowed seek key costs
	 * about fifteen sequential rows where a batched one costs about one-and-a-half — which is
	 * why LevelDB declares nothing rather than declaring its measured seek cost. Splitting
	 * this into per-arm terms is
	 * `backlog/debt-store-seek-positioning-conflates-two-arms`; the numbers are in
	 * `packages/quereus-plugin-leveldb/README.md` § Measured read cost.
	 */
	readonly seekPositioning?: number;
}

/** A {@link KVCostProfile} with every field filled in — what the planner actually reads. */
export type ResolvedCostProfile = Required<KVCostProfile>;

// --- Ordering-walk cost terms -------------------------------------------------------------
//
// Both constants below are DELIBERATELY the memory module's numbers
// (`MemoryTableModule`'s SORT_COST_PER_COMPARISON / RESIDUAL_FILTER_COST_PER_ROW), for the
// same reason `ARM_SELECTIVITY.eq` in store-module-access-plan.ts is deliberately the
// memory module's EQ_SELECTIVITY_WITHOUT_STATS: the two backends should make the same
// ordering-vs-sort tradeoff for the same query. The engine's own `planner/cost` module is
// not exported from `@quereus/quereus`, so they are restated here rather than imported.

/**
 * Cost per pairwise comparison of the external sort a plan avoids by emitting rows
 * already ordered. Commensurate with `AccessPlanBuilder`'s units (full scan = rows × 1.0):
 * sorting 1000 rows ≈ 1000 × log2(1000) × 0.1 ≈ 1000 — on the order of scanning them once.
 */
export const SORT_COST_PER_COMPARISON = 0.1;

/**
 * Per-row cost charged for each pushed filter an ordering-only access pattern leaves
 * unhandled (the residual `Filter` re-checks them above the leaf). This term is what keeps
 * an ordering-only index walk from displacing a selective seek on a filtered query.
 */
export const RESIDUAL_FILTER_COST_PER_ROW = 0.2;

/**
 * The estimated cost of an external O(n·log n) sort over `rows` rows — the memory
 * module's `estimateSortCost`, at {@link SORT_COST_PER_COMPARISON}. 0 at `rows <= 1`,
 * where no sort is needed.
 */
export function estimateSortCost(rows: number): number {
	if (rows <= 1) return 0;
	return rows * Math.log2(rows) * SORT_COST_PER_COMPARISON;
}

/**
 * The module's pre-profile constants, and the default for any backend that declares
 * nothing. `pointRead: 1.0` says a resolved row costs about what a sequentially-iterated
 * row costs (true for an in-process, block-cached backend, where the index path simply
 * pays the row read ON TOP OF the entry read); `seekPositioning: 0.5` says positioning
 * one seek key costs half a sequentially scanned row.
 *
 * Also the price the seek-vs-scan veto uses regardless of what a provider declares —
 * see the veto site in `store-module-access-plan.ts`.
 */
// Frozen because {@link resolveCostProfile} returns this very object (not a copy) for the
// undeclared case, so every parity-backend module in the process shares one instance — and
// it is a public export, reachable from JS that the interface's `readonly` cannot stop.
export const PARITY_COST_PROFILE: ResolvedCostProfile = Object.freeze({ pointRead: 1.0, seekPositioning: 0.5 });

/**
 * Fill in the parity defaults for whatever a provider left undeclared, replacing any
 * non-finite or non-positive field with its parity value.
 *
 * `costProfile` is an optional member of a PUBLIC interface, so a third-party provider
 * can declare anything at all. A bad declaration must not break planning (hence the
 * per-field fallback rather than a throw) and must not pass silently either (hence the
 * warning) — a `NaN` cost would propagate into every comparison this module makes and
 * turn every `<` into `false`.
 */
export function resolveCostProfile(profile: KVCostProfile | undefined): ResolvedCostProfile {
	if (!profile) return PARITY_COST_PROFILE;
	return {
		pointRead: resolveCostField(profile.pointRead, 'pointRead'),
		seekPositioning: resolveCostField(profile.seekPositioning, 'seekPositioning'),
	};
}

/**
 * A provider's declared first-row latency ({@link KVStoreProvider.expectedLatencyMs}), or
 * `0` when it declares none or declares something unusable.
 *
 * Lives beside the cost profile because both are provider-declared planner inputs resolved
 * once at module construction, but it is NOT part of {@link KVCostProfile} and does not
 * share its unit: the profile is a RATIO against one sequentially scanned row, this is
 * wall-clock milliseconds.
 *
 * Same public-interface reasoning as {@link resolveCostField} — a third-party provider can
 * declare anything, so a bad value must neither break planning (hence the fallback rather
 * than a throw) nor pass silently (hence the warning). One difference: `0` is a perfectly
 * valid latency, so only NEGATIVE and non-finite values are rejected here, where a cost
 * field also rejects `0`.
 */
export function resolveExpectedLatencyMs(declared: number | undefined): number {
	if (declared === undefined) return 0;
	if (!Number.isFinite(declared) || declared < 0) {
		console.warn(
			`[StoreModule] provider declares an unusable expectedLatencyMs (${declared}); falling back to 0`,
		);
		return 0;
	}
	return declared;
}

/** One field's declared value, or its parity default when absent or unusable. */
function resolveCostField(declared: number | undefined, field: keyof ResolvedCostProfile): number {
	const parity = PARITY_COST_PROFILE[field];
	if (declared === undefined) return parity;
	if (!Number.isFinite(declared) || declared <= 0) {
		console.warn(
			`[StoreModule] provider cost profile declares an unusable ${field} (${declared}); `
			+ `falling back to the parity default ${parity}`,
		);
		return parity;
	}
	return declared;
}
