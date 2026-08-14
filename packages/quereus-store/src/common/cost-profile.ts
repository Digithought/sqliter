/**
 * What a storage backend's basic read operations cost, declared by the provider and
 * consumed by store access planning (`store-module-access-plan.ts`).
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
	 */
	readonly seekPositioning?: number;
}

/** A {@link KVCostProfile} with every field filled in — what the planner actually reads. */
export type ResolvedCostProfile = Required<KVCostProfile>;

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
export const PARITY_COST_PROFILE: ResolvedCostProfile = { pointRead: 1.0, seekPositioning: 0.5 };

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
