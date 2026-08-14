/**
 * Access planning for a store-backed table: which physical access path
 * (`_primary_` point / range seek, a secondary-index seek or multi-seek, or a full
 * scan) this module advertises for a pushed predicate, which of the pushed filters it
 * claims as handled, and what ordering the chosen path provides.
 *
 * The mirror of `store-table-scan.ts`: the planner here decides which access path to
 * advertise, and the scan layer there executes it. A plan that claims a filter the scan
 * cannot honor drops the residual Filter and returns wrong rows, so every soundness
 * predicate the two share lives in `pk-key-resolution.ts` (`keyOrderMatchesCollation`,
 * `indexRangeAtPositionIsOrderSafe`, `pkOrderPreservingPrefixLength`) rather than being
 * restated here. The declines that are NOT shared — partial indexes, the multi-seek cap,
 * and the semantic-ordering column ban on multi-seeks specifically — are stated in both
 * files, and changing one means changing the other.
 *
 * Free functions rather than a layer of the store-module chain — access planning reads
 * no module state beyond the table's configured key collation, which the caller passes in.
 */

import type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	Database,
	OrderingSpec,
	PredicateConstraint,
	TableIndexSchema,
	TableSchema,
} from '@quereus/quereus';
import { AccessPlanBuilder, equalitySeekKeyCount, hasSemanticOrdering, isMultiValueEquality } from '@quereus/quereus';
import { PARITY_COST_PROFILE, type ResolvedCostProfile } from './cost-profile.js';
import {
	indexPrefixSeekIsCollationExact,
	indexRangeAtPositionIsOrderSafe,
	pkOrderPreservingPrefixLength,
	resolveIndexKeyCollations,
	resolvePkKeyCollations,
} from './pk-key-resolution.js';

/**
 * Planner-side constraint operator groups, as `BestAccessPlanRequest.filters` spells
 * them. Kept as one source of truth for the access-plan code below: {@link computeBestAccessPlan}
 * classifies each pushed filter with these, and {@link tryIndexAccessPlan} claims a filter as
 * handled only when it falls in the group the engine's access-path rule will consume.
 *
 * An IN is N equalities served as one multi-seek (`plan=5`), whether its members are a
 * literal list or a runtime-valued set — so EVERY equality arm here, primary key and
 * secondary index alike, fills its equality roles from this group. (The primary-key arms
 * used to keep a `'='`-only group, on the reasoning that a `_primary_` multi-seek's
 * emission order would break the isolation layer's primary-key merge. Both halves of that
 * are now false: the merge bug was fixed as `bug-isolation-multiseek-merge-order`, and
 * `StoreTableScan.scanMultiSeekPrimary` emits ascending by encoded data key — which IS
 * primary-key order — specifically to satisfy it.)
 */
const EQ_OR_IN_OPS = ['=', 'IN'] as const;

const LOWER_BOUND_OPS = ['>', '>='] as const;

const UPPER_BOUND_OPS = ['<', '<='] as const;

const RANGE_OPS = [...LOWER_BOUND_OPS, ...UPPER_BOUND_OPS] as readonly string[];

/**
 * Ceiling on the seek keys a single IN-list multi-seek may claim (the cross-product
 * for a composite seek). Above it the plan declines to cost-only — residual retained,
 * answer right, only the speed-up lost. The FK RESTRICT batch chunks at 500 keys, so
 * 1000 leaves headroom while stopping an `a in (1..100) and b in (1..100)` 10k-seek
 * explosion.
 */
const MAX_MULTI_SEEK_KEYS = 1000;

// --- The backend cost profile -------------------------------------------------------------
//
// Both per-backend cost terms this file consumes live on the provider's ResolvedCostProfile,
// passed into `computeBestAccessPlan`. See `cost-profile.ts` for the unit (one sequentially
// scanned row = 1) and the parity defaults an undeclared backend gets.
//
// `profile.pointRead` — resolving ONE secondary-index entry to its row. A secondary-index
// path reads TWO stores per matched row (the index entry, then the row it names) where a
// sequential scan reads one, and `AccessPlanBuilder.eqMatch` / `.rangeScan` charge only the
// first (0.3 / 0.5 per row) — so the `eq`, `prefixRange` and `range` arms add this term on
// top of the shape's own cost. Two arms deliberately do not: a cost-only decline (it
// resolves nothing) and the MULTI-SEEK, for the measured reason recorded at that arm in
// `tryIndexAccessPlan`.
//
// `profile.seekPositioning` — the per-seek-key cost of a multi-seek, charged by both
// multi-seek arms (`tryIndexAccessPlan`'s secondary arm and `primaryKeyMultiSeekPlan`).
//
// **`pointRead` is arm-DISABLING, not arm-tuning, and that is why the seek-vs-scan veto
// ignores it.** Because ARM_SELECTIVITY is a fixed FRACTION of the table, every arm's cost
// is linear in `estimatedRows` and so is the full scan's — for a given `pointRead` an arm
// either ALWAYS prices above a sequential scan or never does, for every query on every
// table. With `R` = `pointRead`, the flip points are `range` (0.3·N·(0.5 + R) > N) at
// R > 2.83, `prefixRange` at R > 6.17, and `eq` at R > 9.7. The veto below therefore keeps
// pricing resolution at PARITY_COST_PROFILE; the full reasoning is at the veto site.

/** Which shape of window a secondary index can serve for a given predicate. */
type IndexArm =
	/** Contiguous leading-prefix equality — one prefix window (`plan=2`, or `plan=5` for an IN). */
	| 'eq'
	/** LT/LE/GT/GE on the LEADING index column, no equality ahead of it (`plan=3`). */
	| 'range'
	/** Equality on a strict leading prefix plus a bound on the NEXT column (`plan=7`). */
	| 'prefixRange';

/**
 * Estimated rows each arm returns, as a fraction of the request's `estimatedRows`. The
 * store keeps no per-column histograms, so these are shape constants, not statistics.
 *
 * `prefixRange` sits between the two pre-existing factors, as its window does: it is
 * narrower than a bare leading-column range (the prefix pins every column ahead of the
 * bound) and wider than the pure-equality estimate, which stands for a prefix pinning
 * every column the predicate names.
 *
 * NOTE: these are the store's biggest cost-model gap, and no per-row cost term closes it.
 * They are shape constants, so `where col = ?` is modelled at 10% of the table whatever
 * the predicate actually matches, and `request.estimatedRows` is the table's row count,
 * not a selectivity-adjusted estimate. A predicate matching MOST of the table therefore
 * still prices as an index seek returning 10% of it, and the full-scan comparison in
 * {@link computeBestAccessPlan} cannot rescue it — the fix is real per-column statistics,
 * not another constant here. Two things have to land for that: the store has to KEEP a
 * value distribution (`StoreTableBase.getStatistics` reports the row count only — a
 * distinct count or histogram would cost a scan, which is why `ANALYZE` collects the
 * per-column half itself), and `BestAccessPlanRequest` has to CARRY it, which it does not
 * today — the module sees `estimatedRows` and the filters, nothing else, so even an
 * analyzed table plans identically. Until then every cost decision this file makes is
 * per-ARM, never per-PREDICATE.
 *
 * NOTE: the arms are exclusive per index, but two INDEXES compete on cost — and an index
 * on the equality prefix ALONE prices its `eq` arm cheaper (0.1) than the composite index
 * prices its `prefixRange` arm (0.15), so a schema carrying both `(a)` and `(a, b)` picks
 * `(a)` for `a = ? and b > ?` and leaves the `b` bound residual. Answers are unaffected.
 * Fine while redundant prefix indexes are rare; if one shows up as a slow plan, either
 * scale the `eq` factor by how many index columns the prefix actually pins, or drop
 * `prefixRange` below `eq` — do not just swap the two constants, which would then mis-rank
 * a genuine leading-column range.
 */
const ARM_SELECTIVITY: Readonly<Record<IndexArm, number>> = {
	eq: 0.1,
	prefixRange: 0.15,
	range: 0.3,
};

/**
 * One index's advertisement, plus what {@link computeBestAccessPlan} needs to rank it
 * against the sequential scan it does not itself build.
 */
interface IndexPlanCandidate {
	plan: BestAccessPlanResult;
	/**
	 * `plan.cost` recomputed with {@link PARITY_COST_PROFILE}'s `pointRead` — the price the
	 * seek-vs-scan veto judges this candidate at, whatever the backend declared. Equal to
	 * `plan.cost` on a parity backend, and on any arm that pays no resolution term at all
	 * (the multi-seek, a cost-only decline). Reasoning at the veto site.
	 */
	vetoCost: number;
	/**
	 * True for the `plan=5` multi-seek arm, which is EXEMPT from that comparison. Reasoning
	 * in full at the comparison site; the short of it is that this module cannot tell a
	 * user's `col in (…)` from the SYNTHETIC probes `rule-key-set-seek` sends it, which read
	 * the arm's cost as a curve at 2 and 1000 keys and decline outright if either answer
	 * stops naming an index.
	 */
	isMultiSeek: boolean;
}

/** One (column, operator-group) slot that the access-path rule fills from a single filter. */
interface SeekRole {
	colIdx: number;
	ops: readonly string[];
}

/**
 * Build `handledFilters` by claiming ONLY the constraints `rule-select-access-path`
 * actually consumes: per seek column the FIRST '=' (equality seek), or the FIRST lower
 * ('>'/'>=') plus the FIRST upper ('<'/'<=') bound, selected by `colConstraints.find(...)`
 * in `request.filters` order.
 *
 * That rule collapses `handledFilters` into a per-COLUMN set, so a redundant same-column,
 * same-role constraint marked handled is neither turned into a seek bound nor kept by
 * `ruleGrowRetrieve` as a residual — its predicate would be LOST (`where v > 10 and v > 30`
 * would wrongly return the `v > 10` rows; `where v = 20 and v = 30` would wrongly return
 * the `v = 20` row). The engine now reattaches such orphans defensively, but a module that
 * over-claims still pays a redundant predicate evaluation per fetched row.
 *
 * Claiming must therefore be POSITIONAL and match the rule's first-match pick: claiming the
 * tighter-but-later duplicate instead would be actively wrong (the rule would still seek on
 * the earlier one). Any later duplicate stays unhandled so it survives in the residual Filter.
 */
function claimFirstPerRole(
	filters: readonly PredicateConstraint[],
	roles: readonly SeekRole[],
): boolean[] {
	const claimed = new Set<number>();
	for (const { colIdx, ops } of roles) {
		// An 'IN' fills an equality role only when well-formed — a non-empty literal list
		// or a runtime-valued set. Same shape gate the rule's pick applies, so a malformed
		// IN is neither claimed here nor seeked there and survives as a residual.
		const i = filters.findIndex(f =>
			f.columnIndex === colIdx && ops.includes(f.op)
			&& (f.op !== 'IN' || equalitySeekKeyCount(f) !== null));
		if (i >= 0) claimed.add(i);
	}
	return filters.map((_f, i) => claimed.has(i));
}

/** The lower-bound + upper-bound roles a single-column range seek on `colIdx` fills. */
function rangeRoles(colIdx: number): SeekRole[] {
	return [{ colIdx, ops: LOWER_BOUND_OPS }, { colIdx, ops: UPPER_BOUND_OPS }];
}

/**
 * The one equality role each seek column of an equality/prefix seek fills — filled by a
 * `'='` or a well-formed `IN` alike, on the primary-key arms and the secondary-index arm
 * identically (see the note on {@link EQ_OR_IN_OPS}).
 */
function equalityRoles(colIdxs: readonly number[]): SeekRole[] {
	return colIdxs.map(colIdx => ({ colIdx, ops: EQ_OR_IN_OPS }));
}

/** The equality-pinned leading run of a key column list, with its seek arithmetic. */
interface EqualityPins {
	/** The pinned leading columns, in the order they were asked for. */
	readonly cols: readonly number[];
	/** Cross-product of the per-column seek-key counts (1 for a plain '='). */
	readonly seekKeyCount: number;
	/** true ⇒ delivered as a `plan=5` multi-seek, not a single point read. */
	readonly isMultiSeek: boolean;
}

/**
 * The longest LEADING run of `colIdxs` whose every column carries a filter that can fill
 * an equality role, and what that run costs to seek.
 *
 * Per column the pin is the FIRST such filter ({@link equalitySeekKeyCount} — a `'='`, a
 * non-empty literal `IN`, or a runtime-valued `IN` set). That is the same positional pick
 * {@link claimFirstPerRole} claims and `rule-select-access-path`'s `eqBySeekCol` seeks on,
 * so this module's claim and the rule's pick cannot disagree. A runtime-valued set
 * contributes its `maxCount` ceiling — the worst case the engine may deliver — so every
 * gate downstream judges the largest multi-seek it could ever be asked to perform.
 *
 * ONE helper for both the primary-key arms ({@link resolvePrimaryKeyPins}, which needs the
 * run to cover the whole key) and the secondary-index arm (which takes whatever prefix it
 * gets): separate copies of this loop are how a `'='`-only PK arm and an IN-claiming index
 * arm drifted apart in the first place — see the note on {@link EQ_OR_IN_OPS}.
 *
 * `isMultiSeek` is NOT `seekKeyCount > 1`: a runtime-valued set is delivered as a `plan=5`
 * multi-seek even at `maxCount === 1`, so it must be judged as one rather than as the plain
 * point read its ceiling arithmetic would otherwise suggest. (`seekKeyCount > 1` implies
 * the flag — every factor above 1 is a multi-value equality — so the flag only ever *adds*
 * the `maxCount === 1` runtime-set case.)
 */
function resolveEqualityPins(
	filters: readonly PredicateConstraint[],
	colIdxs: readonly number[],
): EqualityPins {
	const cols: number[] = [];
	let seekKeyCount = 1;
	let isMultiSeek = false;
	for (const colIdx of colIdxs) {
		const pin = filters.find(f => f.columnIndex === colIdx && equalitySeekKeyCount(f) !== null);
		if (!pin) break;
		cols.push(colIdx);
		seekKeyCount *= equalitySeekKeyCount(pin)!;
		if (isMultiValueEquality(pin)) isMultiSeek = true;
	}
	return { cols, seekKeyCount, isMultiSeek };
}

/**
 * The equality pins covering the WHOLE primary key, or null when a member is unpinned.
 *
 * A per-column pin rather than a count of pinned columns: `a = 1 and a = 2` on a composite
 * PK `(a, b)` pins `a`, finds nothing for `b`, and correctly reports the key unpinned.
 * Counting raw equality filters instead would read that predicate as "both PK columns
 * pinned", claim both filters handled, then — with no complete PK equality set to seek —
 * degrade to a sequential scan whose residual has already been discarded, returning the
 * whole table.
 */
function resolvePrimaryKeyPins(
	filters: readonly PredicateConstraint[],
	pkColumns: readonly number[],
): EqualityPins | null {
	if (pkColumns.length === 0) return null;
	const pins = resolveEqualityPins(filters, pkColumns);
	return pins.cols.length === pkColumns.length ? pins : null;
}

/**
 * The access plan this module advertises for `request`, before the caller stamps the
 * module-wide `honorsCollatedRangeBounds` flag onto it.
 *
 * `tableKeyCollation` is the table's resolved key collation K, passed in rather than
 * looked up: the caller (`StoreModule.getBestAccessPlan`) owns the module's table map.
 * It is the PRIMARY-KEY arms' concern only — `resolvePkKeyCollations` still falls back to
 * K for an undecorated text PK member. The secondary-index arm never sees it: index key
 * bytes encode under each index column's own collation, so {@link tryIndexAccessPlan}
 * judges its filters against that instead.
 *
 * `costProfile` is the BACKEND's declared price for a random point read and a seek key,
 * resolved once per module (`StoreModuleBase.costProfile`) and passed in for the same
 * reason `tableKeyCollation` is: this function reads no module state of its own.
 */
export function computeBestAccessPlan(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	tableKeyCollation: string,
	costProfile: ResolvedCostProfile,
): BestAccessPlanResult {
	const estimatedRows = request.estimatedRows ?? 1000;

	const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);

	// Hoisted ABOVE both primary-key arms: the multi-seek arm's ordering advertisement
	// needs it, and it is cheap (a short loop over the PK members). Its other consumer is
	// the leading-PK range arm below, which declines when the leading PK column's key
	// bytes do not order the way its comparator does (`pkOrderPreservingPrefix === 0`):
	// `StoreTable.analyzePKAccess` declines the byte window under exactly that condition,
	// so claiming the range filters handled would drop the residual Filter and return the
	// whole table.
	const pkOrderPreservingPrefix = pkOrderPreservingPrefixLength(
		db,
		tableInfo,
		resolvePkKeyCollations(tableInfo.primaryKeyDefinition, tableInfo.columns, tableKeyCollation),
		tableKeyCollation,
	);

	// Primary-key equality arms. Both live INSIDE this branch — the multi-seek is tried
	// BEFORE the leading-PK range arm below, which is what keeps a full-primary-key IN
	// list from being shadowed by a range on the leading column (the general
	// arm-competition problem is backlog `bug-store-pk-range-preempts-cheaper-index`; do
	// not fix it here).
	//
	// **No collation gate, and that is not an oversight.** The secondary-index arm gates
	// its equality window on `indexPrefixSeekIsCollationExact`; the PK arms need no
	// equivalent, for two independent reasons:
	//  - `reconcilePkCollations` (store-module-schema-rewrite.ts) rewrites an undecorated
	//    text PK column's declared collation to the table key collation K at CREATE time,
	//    so for every PK member the key collation, the declared collation, and the
	//    collation `matchesFilters` re-compares under are the same name. The divergent
	//    shape the secondary arm declines — a collation-blind `json`/temporal column under
	//    an index column carrying an explicit non-BINARY `COLLATE` — cannot occur on a PK:
	//    column DDL type-gates that `COLLATE` out, and those types are declined by the
	//    semantic-ordering gate below anyway.
	//  - `StoreTableScan.scanMultiSeekPrimary` re-applies `matchesFilters` per resolved
	//    row, so even a hypothetical coarser window over-fetches and is trimmed rather
	//    than under-fetching.
	// The multi-seek is exactly the point arm run N times, so its collation exposure is
	// the point arm's, unchanged.
	//
	// The one divergence neither reason covers is PREDICATE-side and invisible from here:
	// `where pk collate nocase in (…)` over a BINARY key column would seek exact-case
	// windows and UNDER-fetch. `PredicateConstraint` carries no collation, so this module
	// cannot see it and always claims; `rule-select-access-path`'s `classifyCollationCover`
	// (which reads the predicate's effective collation off the source expression) is what
	// declines that shape to a scan + residual. A new PK arm inherits that protection only
	// by going through the rule's index-aware path — one more reason `setSeekColumns` on
	// the point arm below is load-bearing.
	const pkPins = resolvePrimaryKeyPins(request.filters, pkColumns);
	if (pkPins && !pkPins.isMultiSeek) {
		// Full PK match - point lookup (single row; no monotonic advertisement).
		//
		// `setSeekColumns` is load-bearing now that this arm also claims a single-element
		// `IN`: it routes the plan through `rule-select-access-path`'s INDEX-AWARE arm,
		// whose `eqBySeekCol` accepts a one-element IN as an equality seek key. The legacy
		// PK arm it would otherwise take matches `op === '='` only, so the claimed IN would
		// be seeked nowhere and come back as a reattached residual over a full scan — the
		// right rows at the wrong cost. For a plain `'='` the two arms build an identical
		// `_primary_` `plan=2` seek under an identical collation-cover lookup.
		return AccessPlanBuilder
			.eqMatch(1, 0.1)
			.setHandledFilters(claimFirstPerRole(request.filters, equalityRoles(pkColumns)))
			.setIsSet(true)
			.setIndexName('_primary_')
			.setSeekColumns(pkColumns)
			.setExplanation('Store primary key lookup')
			.build();
	}
	if (pkPins) {
		const plan = primaryKeyMultiSeekPlan(
			tableInfo, request, pkColumns, pkPins, estimatedRows, pkOrderPreservingPrefix, costProfile);
		// A gate decline FALLS THROUGH to the arms below rather than returning cost-only.
		// That is safe: an `IN` is not in {@link RANGE_OPS}, so the leading-PK-range arm
		// cannot grab it, and it lands on the secondary-index arms / full scan exactly as
		// it did before this arm existed.
		if (plan) return plan;
	}

	// Check for range constraints on the leading PK column.
	// The legacy access-path rule (rule-select-access-path.ts) only forwards
	// range bounds for primaryKeyDefinition[0]; ranges on later PK columns
	// are silently dropped if marked handled. So only claim handled=true
	// when the range is on the first PK column.
	const firstPkColumn = tableInfo.primaryKeyDefinition[0]?.index;
	const hasLeadingPkRange = firstPkColumn !== undefined
		&& pkOrderPreservingPrefix >= 1
		&& request.filters.some(f => f.columnIndex === firstPkColumn && RANGE_OPS.includes(f.op));

	if (hasLeadingPkRange) {
		// Range scan on first PK column. Iteration is by PK key order (see
		// StoreTable.scanPKRange), so we can advertise monotonic emission on
		// the leading PK column. The scan seeks to the window start and
		// early-terminates (StoreTable.buildPKRangeBounds derives the encoded
		// bounds), and the leading-PK order guarantee holds throughout.
		const rangeRows = Math.max(1, Math.floor(estimatedRows * 0.3));
		const plan = AccessPlanBuilder
			.rangeScan(rangeRows, 0.2)
			.setHandledFilters(claimFirstPerRole(request.filters, rangeRoles(firstPkColumn!)))
			.setIndexName('_primary_')
			.setSeekColumns([firstPkColumn!])
			.setExplanation('Store primary key range scan')
			.build();
		return { ...plan, ...buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix) };
	}

	// Check for secondary index usage. `StoreTable.query` now implements the
	// secondary-index scan arm (leading-prefix EQ point / leading-column range /
	// prefix-equality + trailing-column range),
	// so we advertise the index with `indexName` + `seekColumns` and mark the
	// covered filters handled — subject to the range arm's order-safety gate in
	// {@link tryIndexAccessPlan}. A cost-only plan (no seek) is kept as a fallback
	// when no index yields a sound seek, preserving the prior "cheaper cost, filters
	// unhandled, residual retained" behavior.
	//
	// The sequential scan this module would otherwise fall back to, built up-front so the
	// seek arms can be PRICED AGAINST its cost below: `rule-select-access-path` takes
	// whatever single plan this function returns and never compares it with an alternative,
	// so a seek that costs more than reading the table start to finish is only rejected if
	// the module rejects it here. Built once and re-explained on the way out rather than
	// re-deriving `AccessPlanBuilder.fullScan`'s cost formula for the comparison — the
	// drift {@link AccessPlanBuilder.addCost} exists to prevent.
	const scanPlan: BestAccessPlanResult = {
		...AccessPlanBuilder
			.fullScan(estimatedRows)
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation('Store full table scan')
			.build(),
		...buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix),
	};

	const indexes = tableInfo.indexes || [];
	let bestSeekPlan: IndexPlanCandidate | null = null;
	let costOnlyFallback: BestAccessPlanResult | null = null;
	for (const index of indexes) {
		if (index.columns.length === 0) continue;
		const candidate = tryIndexAccessPlan(db, tableInfo, request, index, estimatedRows, costProfile);
		if (!candidate) continue;
		const { plan } = candidate;
		// A fully-handled seek (indexName + seekColumns set) is a candidate: keep the
		// cheapest one seen so far rather than the first, so declaration order of the
		// indexes doesn't decide the plan. Strict '<' so ties keep the first candidate,
		// matching MemoryTableModule.findBestAccessPlan's `indexPlan.cost < bestPlan.cost`.
		if (plan.seekColumnIndexes && plan.seekColumnIndexes.length > 0) {
			if (!bestSeekPlan || plan.cost < bestSeekPlan.plan.cost) bestSeekPlan = candidate;
			continue;
		}
		// Otherwise remember the first cost-only advertisement as a fallback.
		if (!costOnlyFallback) costOnlyFallback = plan;
	}
	if (bestSeekPlan) {
		//
		// The MULTI-SEEK arm is exempt, and that is a measured decision rather than an
		// oversight. `rule-key-set-seek` (engine side) does not consume this arm as a PLAN —
		// it probes `getBestAccessPlan` with SYNTHESIZED runtime-set filters at 2 and 1000
		// keys, reads the two costs as a straight line, and interpolates the key count at
		// which the seek would overtake a scan. A probe answer that stops naming an index is
		// read as "the module declined" and the whole rewrite is abandoned. Since nothing
		// here distinguishes a probe from a user's own `col in (…)`, substituting this
		// module's own scan verdict at 1000 keys silently switches key-set semi joins off:
		// MEASURED, it fails 11 tests in `key-set-seek-store.spec.ts` on tables of 200 and
		// 300 rows where the seek is unambiguously the right plan at the key counts actually
		// used. The arm's brakes stay `inCount × profile.seekPositioning` (which is what the
		// engine interpolates) and {@link MAX_MULTI_SEEK_KEYS}; the engine makes the scan
		// comparison this exemption skips, off the same numbers.
		//
		// **The comparison uses `vetoCost` — the candidate priced at PARITY `pointRead` —
		// not the declared cost the plan advertises.** A backend's declared `pointRead`
		// scales what an arm ADVERTISES and how index arms RANK against each other; it
		// deliberately does not decide whether an index is used at all. Three reasons,
		// settled when the IndexedDB profile was measured:
		//  - The flip is a knife edge, and it sits on the GUESS rather than on the
		//    measurement. Raising `pointRead` past 2.83 disables the `range` arm for EVERY
		//    query on EVERY table (the flip-point arithmetic is above, where the profile's
		//    two terms are introduced), and IndexedDB's measured band (2.8–3.4, from
		//    `packages/quereus-plugin-indexeddb/bench/README.md`) straddles that point
		//    exactly. At the 30% selectivity the `range` arm MODELS, that same bench puts
		//    seek and scan within ~10% of each other (87.5 ms vs 92.6 ms at 20k rows / 25%
		//    selectivity) — the measurement cannot resolve which side of the line the arm
		//    belongs on.
		//  - The error is wildly asymmetric. Disabling the arm costs up to 25× when the real
		//    predicate is selective (a range matching 1% of 20k rows: 3.8 ms seeked vs 95 ms
		//    scanned). Keeping it costs ~10% in the case the guess describes.
		//  - So a wholesale, every-query arm shutdown is not a defensible thing to derive
		//    from a knife-edge measurement of a number the model only guesses at.
		//    `store-column-statistics` replaces {@link ARM_SELECTIVITY} with a real
		//    per-predicate estimate; when it lands, DELETE `vetoCost` and compare on
		//    `plan.cost`, so the veto discriminates per query instead of shutting an arm off
		//    per schema. `cost-profile.spec.ts` pins the current policy — that test is what
		//    tells a future reader the choice was deliberate.
		//
		// Ties keep the seek: it returns fewer rows for the rest of the plan to carry.
		if (bestSeekPlan.isMultiSeek || bestSeekPlan.vetoCost <= scanPlan.cost) return bestSeekPlan.plan;
		// Losing the seek is SAFE, never a wrong answer: the scan claims no filters, so the
		// engine keeps every one of them as a residual Filter and the row set is identical.
		// Deliberately returns the scan rather than falling through to `costOnlyFallback`
		// below — a cost-only plan performs this same sequential scan while advertising an
		// index arm's (cheaper) cost, so falling through would undo the comparison.
		//
		// NOTE: a vetoed seek is indistinguishable from a DECLINE to the engine, and
		// `rule-key-set-seek` reads a probe answer that names no index as "the module
		// declined" and abandons its rewrite. Harmless while the veto is reachable only
		// where an arm's estimate is the whole table (a one-row table, per the flip-point
		// arithmetic above — and `vetoCost` keeps that true on every backend, whatever it
		// declares) — a key-set seek there is worthless anyway. If real
		// per-column statistics ever make the veto fire on tables worth seeking, the
		// comparison has to exempt any request carrying a runtime-valued set, not just the
		// arm this module happens to pick for it.
		return { ...scanPlan, explains: 'Store full table scan (cheaper than the best index seek)' };
	}
	// NOTE: a cost-only plan carries no PK-order advertisement even though the store still
	// iterates in PK key order for it (`StoreTable.query` full-scans), so `... where v > 'x'
	// order by <pk>` picks up a Sort it did not need. Still true, just rarer than it was: an
	// index range on a plain BINARY text column of a default-K (NOCASE) table now gets its
	// seek and no longer lands here — what remains is a range under a collation without the
	// `orderPreserving` assertion, an `any` column with a declared COLLATE, a semantic-ordering
	// column, and the multi-seek declines. If it shows up as slow, merge
	// `buildPkOrderingAdvertisement(...)` into this return.
	//
	// NOTE: cost-only fallback deliberately stays first-wins, not min-cost. These plans
	// handle no filters — the scan full-scans regardless of which index "wins" — so
	// "cheapest" among them isn't a meaningful ranking; picking a lower-cost one here would
	// just under-state the plan's advertised cost to the optimizer without changing the work.
	if (costOnlyFallback) return costOnlyFallback;

	// Fallback to full scan. The store iterates rows in PK key order
	// (see StoreTable.query / store.iterate over buildFullScanBounds), so
	// the scan is monotonic on the leading PK column. `scanPlan` advertises that so
	// downstream rules (merge-join, asof-scan) can fire on store-backed
	// tables, matching memory-mode behavior.
	return scanPlan;
}

/**
 * The `_primary_` multi-seek advertisement for a WHOLE-primary-key IN (`where pk in (…)`,
 * or a runtime-valued set on the PK), or null when a gate declines it.
 *
 * `StoreTableScan.scanMultiSeekPrimary` is the runtime twin: it encodes one data key per
 * tuple, deduplicates, sorts ascending by encoded key, and point-reads each in bounded
 * batches. Both gates below mirror one of its `multiSeekMalformed` throws, which stay in
 * place as the assertion that the plan never produced a shape it cannot serve.
 */
function primaryKeyMultiSeekPlan(
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	pkColumns: readonly number[],
	pins: EqualityPins,
	estimatedRows: number,
	pkOrderPreservingPrefix: number,
	profile: ResolvedCostProfile,
): BestAccessPlanResult | null {
	if (pins.seekKeyCount > MAX_MULTI_SEEK_KEYS) return null;
	// Mirrors `StoreTableScan.pkHasSemanticOrderingMember`, which `scanMultiSeekPrimary`
	// throws `multiSeekMalformed` on: N merged point windows ARE the whole access, with
	// the residual already dropped, so an IN member with no faithful byte position would
	// silently lose its tuple's rows. The single-value point arm has an escape this does
	// not (it can decline to the scan arm per PROBE), which is why only this one declines
	// per SCHEMA. Re-opening it is backlog `feat-store-semantic-key-multiseek`.
	if (pkColumns.some(colIdx => hasSemanticOrdering(tableInfo.columns[colIdx]?.logicalType))) return null;

	// The PK is unique, so each seek key matches at most one row — no `multiRows` clamp
	// artifact (contrast the secondary arm's), and no separate `profile.pointRead` term: the
	// point read IS the row read, with no index-entry → row indirection to charge for.
	//
	// NOTE: this arm is therefore slightly OVER-charged on a backend that declares an
	// expensive profile — `profile.seekPositioning` prices "position an index window AND
	// read the row it names", and here there is no index window (IndexedDB: ≈ 3 units of
	// real cost, charged 5). Accepted rather than split into a third knob: a second
	// multi-seek term would double the tuning surface to model a bias whose only effect is
	// that a very large `where pk in (…)` prefers a scan slightly sooner than it should.
	// Revisit only if a primary-key IN is ever measured planning wrong because of it.
	//
	// `Math.max(1, …)` is LOAD-BEARING, not defensive. `rows: 0` on a plan that claims
	// every filter makes `rule-select-access-path` replace the whole table access with an
	// `EmptyResultNode` (its "the module proved the predicate unsatisfiable" fold), so a
	// table that is empty at PLAN time would return nothing for rows written by the same
	// statement.
	const rows = Math.max(1, Math.min(estimatedRows, pins.seekKeyCount));
	const plan = AccessPlanBuilder
		// `setIsSet(false)` is likewise load-bearing: `eqMatch` defaults `isSet` to
		// `rows <= 1`, which a one-key runtime set would satisfy.
		.eqMatch(rows, pins.seekKeyCount * profile.seekPositioning)
		.setIsSet(false)
		.setIndexName('_primary_')
		// EVERY primary-key column, in `primaryKeyDefinition` order: `scanMultiSeekPrimary`
		// throws when `seekWidth` does not cover the whole key, and the rule derives
		// `seekWidth` from this list.
		.setSeekColumns(pkColumns)
		.setHandledFilters(claimFirstPerRole(request.filters, equalityRoles(pkColumns)))
		.setExplanation(`Store primary key multi-seek(${pins.seekKeyCount})`)
		.build();

	// This arm returns straight out of the PK branch, so it never reaches the
	// seek-versus-scan comparison further down `computeBestAccessPlan` — the same
	// exemption the secondary multi-seek arm gets explicitly, for the same reason:
	// `rule-key-set-seek` reads this cost as a straight line at 2 and 1000 keys and
	// abandons its rewrite if either probe stops naming an index. Do not "fix" this by
	// adding the comparison.
	//
	// `scanMultiSeekPrimary` sorts its points ascending by encoded data key, which IS
	// primary-key order (per-column DESC inversion is baked into the bytes), so the plan
	// goes through the same ordering gate every other primary-key arm uses and
	// `… where pk in (…) order by pk` elides its Sort.
	return { ...plan, ...buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix) };
}

/**
 * Build the access plan for one secondary index against `request`, or null when
 * the index is not usable for this predicate.
 *
 * Usable = a contiguous leading-prefix EQ on the index columns (an index seek /
 * point), a LT/LE/GT/GE range on the LEADING index column, or a strict leading-prefix EQ
 * plus a LT/LE/GT/GE range on the NEXT index column (`prefixRange`, `plan=7`). These
 * mirror the three windows `StoreTable.analyzeIndexAccess` can build.
 *
 * **Collation safety.** Index-column key bytes are encoded under each column's own key
 * collation (`resolveIndexKeyCollations`); `StoreTable.matchesFilters` re-checks a fetched
 * row under the index column's `COLLATE` else the table column's declared collation. Both
 * arms below ask whether those two agree — the question is no longer about the table key
 * collation K at all, which is why this function never sees it:
 *
 *  - EQUALITY — {@link indexPrefixSeekIsCollationExact}: agreement makes the window
 *    EXACTLY the qualifying set. A `text` or `any` column always agrees (both key under
 *    the same resolution the residual uses); a collation-blind column (`json`, the
 *    temporal types) under an index column with an explicit non-BINARY COLLATE does not
 *    (its key bytes are hard-BINARY) and declines.
 *  - RANGE — {@link indexRangeAtPositionIsOrderSafe}: the same agreement PLUS the
 *    collation's `orderPreserving` assertion, because a byte window also equates memcmp of
 *    the key bytes with the residual comparator's order. Asked at position 0 for a
 *    leading-column range, and at the prefix length for a `prefixRange` trailing bound —
 *    whose PREFIX additionally passes the EQUALITY gate above.
 *
 * `StoreTable.analyzeIndexAccess` gates its windows on the same two helpers, so the "mark
 * handled" and "build a window" decisions cannot disagree. A decline returns a cost-only
 * plan: cheaper cost, filters unhandled, residual retained; correct, just not sped up.
 *
 * **Cost.** Each single-window seek arm pays the backend's declared `profile.pointRead`
 * per row it expects to return, on top of the `AccessPlanBuilder` shape's own per-row term:
 * the shape prices reading the index ENTRY, and the store must then read the ROW that entry
 * names out of the data store. Two arms deliberately do NOT pay it — a cost-only decline
 * (it resolves nothing; the scan reads rows directly) and the multi-seek, for the measured
 * reason recorded at that arm below. Every candidate also carries a `vetoCost`: the same
 * arm priced at the PARITY `pointRead`, which is what the seek-vs-scan comparison in
 * {@link computeBestAccessPlan} judges it at (reasoning at that site).
 */
function tryIndexAccessPlan(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	index: TableIndexSchema,
	estimatedRows: number,
	profile: ResolvedCostProfile,
): IndexPlanCandidate | null {
	// Exclude PARTIAL indexes from access planning: neither the engine nor this
	// module checks that the query's WHERE implies the index predicate, so seeking
	// a partial index for a query it doesn't cover would silently drop the rows the
	// index omits (an out-of-scope predicate returns nothing). Treat partial indexes
	// purely as uniqueness enforcers — the query full-scans + residual instead.
	// Mirrors MemoryTableModule.getAvailableIndexes (`if (idx.predicate) continue`).
	if (index.predicate) return null;

	const indexColIndexes = index.columns.map(c => c.index);

	// Contiguous leading-prefix equality → point/prefix seek. An IN filter counts as an
	// equality here (it is N equalities, served as one multi-seek by
	// StoreTable.scanMultiSeek); `inCount` is the cross-product of the per-column seek-key
	// counts, matching the rule's seek-key count. See {@link resolveEqualityPins} for the
	// positional pick and the runtime-set ceiling both arms share.
	const { cols: eqCols, seekKeyCount: inCount, isMultiSeek } = resolveEqualityPins(request.filters, indexColIndexes);
	const leadingCol = indexColIndexes[0];
	const hasLeadingRange = request.filters.some(
		f => f.columnIndex === leadingCol && RANGE_OPS.includes(f.op),
	);

	// Prefix-equality + trailing-range: the equality prefix is a STRICT, non-empty prefix
	// of the index columns and the NEXT index column carries a bound. `StoreTable
	// .analyzeIndexAccess` builds the matching one-window `[prefix||bound]` range.
	//
	// A multi-value prefix is EXCLUDED: `rule-select-access-path` can only seek a
	// single-valued prefix key, so `a in (1, 2) and b > 15` over `(a, b)` would come back
	// as a sequential scan with both predicates residual — worse than the multi-seek this
	// index can still serve on the IN alone. MemoryTableModule.evaluateIndexAccess records
	// the same restriction for the same reason.
	const nextCol = eqCols.length > 0 && eqCols.length < indexColIndexes.length
		? indexColIndexes[eqCols.length]
		: undefined;
	const trailingRangeCol = (!isMultiSeek && nextCol !== undefined
		&& request.filters.some(f => f.columnIndex === nextCol && RANGE_OPS.includes(f.op)))
		? nextCol
		: undefined;

	let seekCols: readonly number[];
	let arm: IndexArm;
	if (trailingRangeCol !== undefined) {
		seekCols = [...eqCols, trailingRangeCol];
		arm = 'prefixRange';
	} else if (eqCols.length > 0) {
		seekCols = eqCols;
		arm = 'eq';
	} else if (hasLeadingRange) {
		seekCols = [leadingCol];
		arm = 'range';
	} else {
		return null; // this index cannot serve this predicate
	}

	// Collation gates — see the doc comment above. `StoreTable.analyzeIndexAccess` declines
	// exactly the same windows through the same two helpers, at the same positions.
	const indexKeyCollations = resolveIndexKeyCollations(index, tableInfo.columns);

	// A trailing bound whose byte order does not reproduce its residual comparator's order
	// costs only the bound, not the whole plan: DEGRADE to the equality-prefix seek and
	// leave the bound unclaimed, so it survives in the residual Filter. The scan side makes
	// the same move (a `plan=2` eqSeek arrives and it windows the prefix), and keeping the
	// prefix seek is strictly better than the cost-only fallback below.
	if (arm === 'prefixRange'
		&& !indexRangeAtPositionIsOrderSafe(db, tableInfo.columns, index, indexKeyCollations, eqCols.length)) {
		arm = 'eq';
		seekCols = eqCols;
	}

	const isRange = arm !== 'eq';
	const rows = Math.max(1, Math.floor(estimatedRows * ARM_SELECTIVITY[arm]));
	/** The arm's shape — `AccessPlanBuilder`'s per-row index-entry term, no resolution. */
	const armShape = (): AccessPlanBuilder =>
		isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3);
	/** The arm's shape plus one per-fetched-row resolution term at the given price. */
	const seekingArm = (pointRead: number): AccessPlanBuilder => armShape().addCost(rows * pointRead);
	const costOnly = (why: string): IndexPlanCandidate => {
		const plan = armShape()
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation(`Store index scan on ${index.name} (${why})`)
			.build();
		return {
			plan,
			// Cost-only resolves nothing, so its cost carries no `pointRead` term to reprice —
			// and it never reaches the comparison anyway (it claims no seek columns).
			vetoCost: plan.cost,
			// Likewise immaterial; false states the fact — this plan seeks nothing at all.
			isMultiSeek: false,
		};
	};

	if (arm === 'range') {
		if (!indexRangeAtPositionIsOrderSafe(db, tableInfo.columns, index, indexKeyCollations, 0)) {
			return costOnly('cost-only; index range needs an order-preserving key collation');
		}
	} else if (!indexPrefixSeekIsCollationExact(tableInfo.columns, index, indexKeyCollations, eqCols.length)) {
		// Covers the `prefixRange` arm's PREFIX too: its pinned columns need exactly the
		// equality arm's guarantee, and its trailing column was gated just above.
		return costOnly('cost-only; index key collation differs from the comparison collation');
	}

	// Multi-seek declines. Cost-only keeps the residual, so the answer stays right
	// and only the speed-up is lost.
	if (inCount > MAX_MULTI_SEEK_KEYS) {
		return costOnly(`cost-only; IN cross-product of ${inCount} exceeds the ${MAX_MULTI_SEEK_KEYS}-seek cap`);
	}
	if (isMultiSeek && seekCols.some(colIdx => hasSemanticOrdering(tableInfo.columns[colIdx]?.logicalType))) {
		// A plain EQ on a TIMESPAN/JSON column now seeks: `StoreTable.analyzeIndexAccess`
		// encodes the probe through the column's key transform ('PT1H' and 'PT60M' collide
		// on one key) and, for a probe with no faithful byte position, simply stops its
		// prefix short and lets the residual re-filter under the type's compare. A
		// multi-seek has neither escape — its merged windows ARE the whole access, with the
		// residual already dropped — so an unfaithful member of the IN list would silently
		// lose its tuple's rows or raise out of the key encoder. See `scanMultiSeek` and
		// backlog `feat-store-semantic-key-multiseek`.
		return costOnly('cost-only; semantic-ordering seek column cannot multi-seek');
	}

	// Claim positionally — see {@link claimFirstPerRole}. The `prefixRange` arm claims the
	// prefix equalities AND the first lower/upper bound on the trailing column; a redundant
	// same-side bound (`date > a and date > b`) stays unclaimed and survives in the residual.
	// A prefixRange DEGRADED to 'eq' above claims the prefix only, so its trailing bounds
	// likewise survive.
	const handledFilters = claimFirstPerRole(
		request.filters,
		arm === 'range'
			? rangeRoles(leadingCol)
			: arm === 'prefixRange'
				? [...equalityRoles(eqCols), ...rangeRoles(trailingRangeCol!)]
				: equalityRoles(eqCols),
	);

	if (isMultiSeek) {
		// Multi-seek (plan=5): inCount point seeks, `rows` matched per seek key. The
		// per-seek positioning term keeps a 500-key IN over a 10-row table from pricing
		// below a full scan and issuing 500 seeks to read 10 rows. `isSet` false mirrors
		// MemoryTableModule.evaluateIndexAccess's setIsSet(!isMultiSeek). No ordering is
		// advertised — window emission order is encoded-key order, not any column order.
		//
		// NOTE: this arm alone does NOT pay a per-row `profile.pointRead`, though it resolves
		// every entry it matches exactly like the single-window arms do. The reason is
		// `multiRows`, not the physics: `inCount × rows` reaches `estimatedRows` at ten seek
		// keys (`rows` is the fixed 0.1 × N equality shape constant) and at two or three on a
		// handful-of-rows table, so beyond that the figure is a CLAMP — "the whole table" —
		// rather than an estimate of what the keys match. Charging a per-row term against a
		// clamp prices the estimator's artifact:
		//   - MEASURED: it fails 16 tests in `key-set-seek-store.spec.ts`, every one a
		//     runtime key-set semi join over a 3-to-4-row table that stops seeking.
		//   - The engine's `rule-key-set-seek` interpolates a break-even from THIS cost at 2
		//     and 1000 keys. With the term, `cost(1000 keys) = 500 + 1.3 × N` exceeds a scan's
		//     `N` for every N, so the break-even can never reach the engine's 1000-key ceiling
		//     — key sets above ~710 keys would stop seeking on a table of ANY size, including
		//     the 10M-row tables where an index seek is the entire point.
		// The price of leaving it off is a narrower mis-ranking: against another index's `eq`
		// arm (which does pay the term) a small-key IN now looks relatively cheaper than it
		// is — `where a in (x, y) and b = ?` over a 1000-row table prices ix_a at 61 and ix_b
		// at 130 and picks ix_a, though ix_a's own estimate says it fetches 200 rows to ix_b's
		// 100. Charging the term everywhere fixes that ranking and breaks the feature above;
		// the union estimate has to stop clamping before both can hold. See
		// backlog/debt-store-multi-seek-union-row-estimate.
		const multiRows = Math.min(estimatedRows, inCount * rows);
		const plan = AccessPlanBuilder.eqMatch(multiRows, inCount * profile.seekPositioning)
			.setIsSet(false)
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index multi-seek(${inCount}) on ${index.name}`)
			.build();
		return {
			plan,
			// No `pointRead` term to reprice (see the NOTE above), and the arm is exempt from
			// the veto regardless — so the veto price IS the declared price.
			vetoCost: plan.cost,
			isMultiSeek: true,
		};
	}

	const armLabel = arm === 'prefixRange'
		? `prefix-range seek(prefix=${eqCols.length})`
		: arm === 'range' ? 'range scan' : 'seek';
	return {
		plan: seekingArm(profile.pointRead)
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index ${armLabel} on ${index.name}`)
			.build(),
		// Re-derived from `armShape()` rather than adjusted off `plan.cost`, so the parity
		// price is the exact number the pre-profile module produced rather than a float
		// round trip through the declared one.
		vetoCost: seekingArm(PARITY_COST_PROFILE.pointRead).build().cost,
		isMultiSeek: false,
	};
}

/**
 * Compute the PK-ordering advertisement for a scan-style plan. Returns the
 * `providesOrdering` / `monotonicOn` / `supportsAsofRight` fields for a plan
 * whose iteration is driven by the primary-key key order (full scan or PK
 * range scan).
 *
 * `providesOrdering` is set only when it actually matches what the caller
 * needs:
 *   - When the request carries `requiredOrdering`, claim it only if the
 *     requested keys form a prefix of the PK with matching directions.
 *     Claiming PK order against an `ORDER BY <other column>` would cause
 *     the absorb-Sort rule to drop the Sort and yield wrong-order rows.
 *   - When no `requiredOrdering` is present, advertise the full PK
 *     ordering so downstream rules (merge-join, sort elision after a
 *     filter) can opportunistically use it.
 *
 * `monotonicOn` reflects the access path itself and is independent of any
 * `requiredOrdering`; it always advertises the leading PK column. Strict
 * monotonicity is claimed iff the PK is single-column — composite PKs can
 * repeat values on the leading column.
 *
 * Returns an empty object when there is no PK (heap-only table) — without a
 * leading key column there is no natural emit order.
 *
 * Every claim here is about the PHYSICAL key-byte order the store iterates in, but the
 * consumers of `providesOrdering` / `monotonicOn` reason in the columns' COLLATION order.
 * `orderPreservingPrefix` (from {@link pkOrderPreservingPrefixLength}) is how many leading
 * PK members those two orders provably agree on: the advertisement is truncated to that
 * prefix, and voided entirely when even the leading member disagrees — otherwise the
 * absorb-Sort rule would elide a Sort and hand the caller byte-ordered rows.
 */
function buildPkOrderingAdvertisement(
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	orderPreservingPrefix: number,
): Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName' | 'monotonicOn' | 'supportsAsofRight'> {
	const pk = tableInfo.primaryKeyDefinition;
	if (pk.length === 0 || orderPreservingPrefix === 0) return {};

	const leading = pk[0];
	const monotonicOn = {
		columnIndex: leading.index,
		direction: leading.desc ? 'desc' as const : 'asc' as const,
		strict: pk.length === 1,
	};

	const pkOrdering: OrderingSpec[] = pk.slice(0, orderPreservingPrefix).map(col => ({
		columnIndex: col.index,
		desc: !!col.desc,
	}));

	// Pick the providesOrdering to advertise based on requiredOrdering.
	const required = request.requiredOrdering;
	let providesOrdering: readonly OrderingSpec[] | undefined;
	if (required && required.length > 0) {
		// Only claim ordering when the requested keys form a prefix of the
		// PK with matching directions. nullsFirst is intentionally not
		// matched here — if the request specifies an explicit NULLS
		// FIRST/LAST, leave the Sort in place rather than assume the PK
		// scan's natural NULL placement matches.
		if (required.length > pkOrdering.length) return { monotonicOn, supportsAsofRight: true };
		for (let i = 0; i < required.length; i++) {
			if (required[i].columnIndex !== pkOrdering[i].columnIndex) return { monotonicOn, supportsAsofRight: true };
			if (required[i].desc !== pkOrdering[i].desc) return { monotonicOn, supportsAsofRight: true };
			if (required[i].nullsFirst !== undefined) return { monotonicOn, supportsAsofRight: true };
		}
		providesOrdering = required;
	} else {
		providesOrdering = pkOrdering;
	}

	return {
		providesOrdering,
		orderingIndexName: '_primary_',
		monotonicOn,
		supportsAsofRight: true,
	};
}

// --- StoreTableModule interface implementation ---
