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
	ColumnStatistics,
	Database,
	OrderingSpec,
	PredicateConstraint,
	TableIndexSchema,
	TableSchema,
	TableStatistics,
} from '@quereus/quereus';
import {
	AccessPlanBuilder,
	combineConjunctive,
	equalitySeekKeyCount,
	hasSemanticOrdering,
	isMultiValueEquality,
	selectivityFromHistogram,
} from '@quereus/quereus';
import {
	estimateSortCost,
	PARITY_COST_PROFILE,
	RESIDUAL_FILTER_COST_PER_ROW,
	type ResolvedCostProfile,
} from './cost-profile.js';
import {
	indexOrderPreservingPrefixLength,
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
// **Whether the declared `pointRead` may decide the seek-vs-scan veto depends on where the
// arm's row estimate came from.** An arm whose estimate is real (per-predicate, from
// `tableSchema.statistics` — see {@link resolveArmEstimate}) is judged at its declared
// price: the estimate discriminates per query, so the veto discriminates per query too.
// An arm still priced by an {@link ARM_SELECTIVITY} shape constant is judged at
// PARITY_COST_PROFILE instead, because a constant fraction makes every arm's cost linear
// in `estimatedRows` — for a given `pointRead` such an arm either ALWAYS prices above a
// sequential scan or never does, for every query on every table (with `R` = `pointRead`,
// the flip points are `range` (0.3·N·(0.5 + R) > N) at R > 2.83, `prefixRange` at
// R > 6.17, and `eq` at R > 9.7 — and IndexedDB's measured `pointRead` band straddles the
// `range` flip point exactly). Judging a shape constant at the declared price would be a
// wholesale, every-query arm shutdown derived from a guess; full reasoning at the veto site.

/** Which shape of window a secondary index can serve for a given predicate. */
type IndexArm =
	/** Contiguous leading-prefix equality — one prefix window (`plan=2`, or `plan=5` for an IN). */
	| 'eq'
	/** LT/LE/GT/GE on the LEADING index column, no equality ahead of it (`plan=3`). */
	| 'range'
	/** Equality on a strict leading prefix plus a bound on the NEXT column (`plan=7`). */
	| 'prefixRange';

/**
 * FALLBACK rows each arm returns, as a fraction of the request's `estimatedRows` — shape
 * constants, reached only when {@link resolveArmEstimate} cannot produce a per-predicate
 * estimate from `tableSchema.statistics`. Concretely, a constant is still the estimate
 * when:
 *
 *  - the table has never been `ANALYZE`d (`tableSchema.statistics` absent) — the common
 *    case, which must plan byte-identically to the pre-statistics module;
 *  - the snapshot was taken while the table was EMPTY (`rowCount` 0), so it describes
 *    nothing and every `distinctCount` in it is 0 — see {@link resolveArmEstimate};
 *  - any column filling an EQUALITY role in the arm has no per-column statistics (a
 *    column added or renamed after the last `ANALYZE` — the arm falls back WHOLESALE
 *    rather than mixing a measured factor with a shape constant);
 *  - a pure `range` arm's bound cannot be answered by the column's histogram (no
 *    histogram was built, the bound's value is a parameter unknown at plan time, or the
 *    histogram declines). A `prefixRange` arm in the same position stays per-query — its
 *    measured prefix factors carry the estimate and only the bound's factor falls back
 *    to this constant.
 *
 * `prefixRange` sits between the two other factors, as its window does: narrower than a
 * bare leading-column range (the prefix pins every column ahead of the bound) and wider
 * than the pure-equality estimate, which stands for a prefix pinning every column the
 * predicate names.
 *
 * NOTE: the arms are exclusive per index, but two INDEXES compete on cost — and on an
 * un-analyzed table an index on the equality prefix ALONE prices its `eq` arm cheaper
 * (0.1) than the composite index prices its `prefixRange` arm (0.15), so a schema
 * carrying both `(a)` and `(a, b)` picks `(a)` for `a = ? and b > ?` and leaves the `b`
 * bound residual. Answers are unaffected, and `ANALYZE` largely resolves it: under real
 * statistics the composite arm's estimate is the prefix's factor damped by the bound's,
 * so it under-prices the single-column arm whenever the bound is at all selective. If
 * the un-analyzed ranking ever shows up as a slow plan, the fix is `ANALYZE`, not a
 * constant swap here.
 */
const ARM_SELECTIVITY: Readonly<Record<IndexArm, number>> = {
	eq: 0.1,
	prefixRange: 0.15,
	range: 0.3,
};

/**
 * What {@link resolveArmEstimate} established for one arm of one index: the fraction of
 * `request.estimatedRows` the arm is expected to return, and whether real per-column
 * statistics produced that fraction (versus an {@link ARM_SELECTIVITY} shape constant).
 */
interface ArmEstimate {
	readonly selectivity: number;
	readonly statsBacked: boolean;
}

/**
 * The `ANALYZE`-collected statistics for the table column at `colIdx`, or undefined when
 * the table has none or the column is not covered.
 *
 * `columnStats` is keyed by LOWERCASE COLUMN NAME while this file works in column index,
 * so the lookup goes index → current column name → stats. That direction is what keeps a
 * post-`ANALYZE` `ALTER TABLE` safe: a RENAMED column's current name is absent from the
 * map (falls back to the shape constant), and a DROPPED column shifts later indexes onto
 * their own current names — a miss or the right entry, never a neighbour's numbers.
 */
function columnStatsFor(
	tableInfo: TableSchema,
	stats: TableStatistics,
	colIdx: number,
): ColumnStatistics | undefined {
	const name = tableInfo.columns[colIdx]?.name;
	return name === undefined ? undefined : stats.columnStats.get(name.toLowerCase());
}

/**
 * The histogram-answered selectivity of the range bound(s) on `colIdx`, or undefined
 * when the histogram cannot answer them (then the caller falls back to a shape
 * constant).
 *
 * Reads the FIRST lower and FIRST upper bound in `filters` order — the same positional
 * pick {@link claimFirstPerRole} claims and `rule-select-access-path` seeks on, so the
 * bound being priced is the bound being served. Each bound needs a plan-time value
 * (`f.value !== undefined`; a parameter binding has none) and a histogram verdict; a
 * present bound that cannot be answered makes the whole factor undefined rather than
 * half-measured. Both formulas are the engine's: a single bound is
 * `selectivityFromHistogram` verbatim, and a two-sided range combines as
 * `max(0, lowSel + highSel - 1)` — `CatalogStatsProvider.estimateLeaf`'s BETWEEN
 * arithmetic, which models the two bounds as the anti-correlated pair they are rather
 * than damped-independent conjuncts.
 *
 * NOTE: that is the engine's number for `v between 10 and 20` but not for the same range
 * spelled `v > 10 and v < 20` — the engine reaches this arithmetic only from a `Between`
 * node and folds two separate comparisons through `combineConjunctive` instead (roughly 2x
 * looser; `estimateConjunction` carries its own note saying same-column pairing is what
 * would fix it). The tighter number is kept here deliberately: it is the more accurate of
 * the two, and a claimed range leaves no residual `Filter` carrying the engine's competing
 * estimate for the optimizer to compare it against. If the engine ever pairs same-column
 * bounds the two spellings converge with no change on this side; if a plan is measured
 * going wrong on the gap before then, it is the ENGINE's conjunction that should move.
 */
function rangeBoundSelectivity(
	stats: TableStatistics,
	colStats: ColumnStatistics,
	filters: readonly PredicateConstraint[],
	colIdx: number,
): number | undefined {
	const histogram = colStats.histogram;
	if (!histogram) return undefined;
	const boundSel = (ops: readonly string[]): { present: boolean; sel: number | undefined } => {
		const bound = filters.find(f => f.columnIndex === colIdx && ops.includes(f.op));
		if (!bound) return { present: false, sel: undefined };
		return {
			present: true,
			sel: bound.value === undefined
				? undefined
				: selectivityFromHistogram(histogram, bound.op, bound.value, stats.rowCount),
		};
	};
	const low = boundSel(LOWER_BOUND_OPS);
	const high = boundSel(UPPER_BOUND_OPS);
	if ((low.present && low.sel === undefined) || (high.present && high.sel === undefined)) return undefined;
	if (low.sel !== undefined && high.sel !== undefined) return Math.max(0, low.sel + high.sel - 1);
	return low.sel ?? high.sel;
}

/**
 * The per-predicate row estimate for one arm: equality columns in `eqCols`, plus — for
 * the `range` / `prefixRange` arms — the bound on `rangeCol`.
 *
 * **The design rule this implements: the estimate must be the number the engine's
 * `CatalogStatsProvider` would produce for the same predicate.** A seek's advertised
 * `rows` and the estimate the residual `Filter` above it carries describe the same row
 * set; two different numbers would have the optimizer comparing two different worlds. So
 * every formula here is `estimateLeaf`'s — equality is `1 / max(distinctCount, 1)`, a
 * bound is the histogram's verdict ({@link rangeBoundSelectivity}) — and the factors
 * combine through the engine's own `combineConjunctive` (damped independence), never a
 * restated product.
 *
 * `statsBacked` — the flag the veto, the multi-seek's resolution charge, and `vetoCost`
 * all key off — means the estimate is per-QUERY rather than a shape constant: every
 * equality column had real statistics, and at least one factor was measured. An arm that
 * is not statistics-backed returns exactly {@link ARM_SELECTIVITY}'s constant, so an
 * un-analyzed table plans byte-identically to the pre-statistics module. A missing
 * equality column falls back WHOLESALE (no mixing a measured factor with a constant);
 * only a `prefixRange` arm's unanswerable BOUND degrades softly, contributing the arm
 * constant as its factor while the measured prefix keeps the estimate per-query.
 *
 * A fraction of `request.estimatedRows`, deliberately, even though the histogram/NDV
 * numbers are ratios of `statistics.rowCount`: `estimatedRows` is the figure the rest of
 * the plan was costed with, and both snapshots come from the same `ANALYZE` unless the
 * planner overrode the size — in which case following the override is the engine-wide
 * rule (see `sizeRequestFromLiveCount`).
 */
function resolveArmEstimate(
	tableInfo: TableSchema,
	filters: readonly PredicateConstraint[],
	arm: IndexArm,
	eqCols: readonly number[],
	rangeCol: number | undefined,
): ArmEstimate {
	const fallback: ArmEstimate = { selectivity: ARM_SELECTIVITY[arm], statsBacked: false };
	const stats = tableInfo.statistics;
	// A snapshot taken while the table was EMPTY describes nothing — every `distinctCount`
	// is 0, no histogram was built — so it is treated as no statistics at all rather than
	// applied. Both halves of the design rule demand it: the engine short-circuits the same
	// case (`estimatePredicateSelectivity` returns 0 outright on `rowCount === 0` and never
	// reaches `estimateLeaf`'s formulas), and applying the snapshot anyway reads `1 / max(0,
	// 1)` as "this equality matches EVERY row" — the opposite extreme — which prices the arm
	// above a scan and hands the veto a table it should never have judged. That is reachable
	// in ordinary use: `analyze` in a bootstrap script that runs before the data load leaves
	// the request sized from the LIVE row count while these numbers still say zero, so every
	// equality on the table would scan until someone re-analyzed it.
	if (!stats || stats.rowCount <= 0) return fallback;

	const factors: number[] = [];
	for (const colIdx of eqCols) {
		const colStats = columnStatsFor(tableInfo, stats, colIdx);
		if (!colStats) return fallback;
		// NOTE: `1/D` assumes uniformity, so an equality on a skewed column (a 99/1
		// two-valued flag) is still mispriced for the common value. The histogram carries
		// per-bucket distinct counts and could answer equality too, but the engine's
		// `CatalogStatsProvider.estimateLeaf` prices `=` as `1/D`, and this file's design
		// rule is to match it — if a skewed equality is ever measured planning wrong, move
		// BOTH the engine and this factor to the histogram together.
		//
		// NOTE: `distinctCount` counts distinct NON-NULL values but the factor is applied
		// against the full row count, so a mostly-NULL column over-estimates its matches
		// (NULL rows never match an equality). Same treatment as skew: the engine prices it
		// this way, so this file does too — fix both together or neither.
		factors.push(1 / Math.max(colStats.distinctCount, 1));
	}

	if (rangeCol !== undefined) {
		const colStats = columnStatsFor(tableInfo, stats, rangeCol);
		const boundFactor = colStats
			? rangeBoundSelectivity(stats, colStats, filters, rangeCol)
			: undefined;
		if (boundFactor !== undefined) {
			factors.push(boundFactor);
		} else if (eqCols.length === 0) {
			// A pure `range` arm with no histogram answer has no measured factor at all —
			// that IS the fallback case, not a degraded estimate.
			return fallback;
		} else {
			// `prefixRange` with a measured prefix: the bound alone degrades to the arm
			// constant as its factor; the estimate stays per-query on the prefix's strength.
			factors.push(ARM_SELECTIVITY[arm]);
		}
	}

	return { selectivity: combineConjunctive(factors), statsBacked: true };
}

/**
 * One index's advertisement, plus what {@link computeBestAccessPlan} needs to rank it
 * against the sequential scan it does not itself build.
 */
interface IndexPlanCandidate {
	plan: BestAccessPlanResult;
	/**
	 * The price the seek-vs-scan veto judges this candidate at. For a STATISTICS-BACKED
	 * arm this is `plan.cost` itself — the estimate is per-query, so the backend's
	 * declared profile is allowed to decide the arm's fate per query. For an arm still
	 * priced by an {@link ARM_SELECTIVITY} shape constant it is the arm repriced at
	 * {@link PARITY_COST_PROFILE}'s `pointRead`: judging a fixed fraction at a declared
	 * price would disable the arm for every query on every table (reasoning at the veto
	 * site). Equal to `plan.cost` on a parity backend either way, and on any arm that
	 * pays no resolution term at all (an unbacked multi-seek, a cost-only decline).
	 */
	vetoCost: number;
	/**
	 * True for the `plan=5` multi-seek arm. Together with {@link statsBacked} it decides
	 * the veto exemption at the comparison site: a multi-seek whose row estimate is still
	 * the clamped shape-constant union (`min(N, inCount × 0.1N)`) must not be judged by
	 * the veto — the figure is an artifact, not an estimate.
	 */
	isMultiSeek: boolean;
	/** {@link ArmEstimate.statsBacked} for the arm behind this plan. */
	statsBacked: boolean;
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
 * Two halves: {@link computeFilterAccessPlan} picks the best plan for the pushed
 * PREDICATE (PK point / multi-seek / range, secondary-index seek, or full scan), and
 * {@link chooseOrderingPlan} then asks whether walking some index purely for its
 * EMISSION ORDER — pushing no filters at all — prices below that plan plus the external
 * sort it would otherwise need. Wrapping the whole filter decision (rather than
 * threading the comparison through its several return points) is what lets the early
 * PK returns compete against an ordering walk too.
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
	const filterPlan = computeFilterAccessPlan(db, tableInfo, request, tableKeyCollation, costProfile);
	return chooseOrderingPlan(db, tableInfo, request, filterPlan, costProfile);
}

/**
 * The best access plan for the pushed PREDICATE alone — {@link computeBestAccessPlan}'s
 * former body, extracted verbatim so {@link chooseOrderingPlan} can wrap every one of its
 * return points. Ordering is not ignored here (the seek arms still attach their
 * advertisements, which is how a plan that already satisfies the required ordering skips
 * the walk comparison entirely); this function just never chooses an access path FOR
 * ordering's sake.
 */
function computeFilterAccessPlan(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	tableKeyCollation: string,
	costProfile: ResolvedCostProfile,
): BestAccessPlanResult {
	const estimatedRows = request.estimatedRows ?? 1000;

	// Whether ANY pushed filter is a runtime-valued set. Detected once, on the REQUEST:
	// such a request is engine-synthesized (`rule-key-set-seek`'s probes, or the key-set
	// semi join itself) and must never be answered with this module's own scan verdict,
	// whichever arm ends up serving it — see the exemption at the seek-vs-scan comparison.
	const requestCarriesRuntimeSet = request.filters.some(f => f.runtimeSet !== undefined);

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
		// Two narrow exemptions skip the seek-vs-scan comparison outright:
		//
		//  - **A request carrying a runtime-valued set** (`filter.runtimeSet`). Such a
		//    request is only ever built by the engine — `rule-key-set-seek`'s synthesized
		//    probes and the key-set semi join itself — and the engine reads a probe answer
		//    that names no index as "the module declined", abandoning the whole rewrite.
		//    So this module must NEVER substitute its own scan verdict there: the engine
		//    makes the scan comparison itself, interpolating a break-even from the module's
		//    costs at 2 and 1000 keys. Detected on the REQUEST rather than on the winning
		//    arm, because the probe must survive whichever arm this module happens to pick
		//    for it. (Substituting a scan verdict at 1000 keys was MEASURED to fail 11
		//    tests in `key-set-seek-store.spec.ts` on 200-and-300-row tables where the seek
		//    is unambiguously right at the key counts actually used.)
		//  - **A multi-seek whose row estimate is not statistics-backed.** Its
		//    `min(N, inCount × 0.1N)` union reaches the whole table at ten seek keys, so
		//    beyond that the figure is a CLAMP rather than an estimate — vetoing on it
		//    would judge the estimator's artifact. A statistics-backed multi-seek clamps
		//    only at `inCount ≈ distinctCount`, which is the honest saturation point, so it
		//    faces the comparison like every other arm — a literal `col in (…900 values…)`
		//    over an analyzed 100-row table now correctly loses to the scan.
		//
		// **The comparison judges the candidate at `vetoCost`, which is `plan.cost` itself
		// exactly when the arm's row estimate is statistics-backed.** A per-query estimate
		// lets the backend's declared profile decide the arm's fate per query: on
		// IndexedDB (`pointRead: 3.0`) the `range` arm's break-even is
		// 1/(0.5 + 3.0) ≈ 0.286 of the table, so a range the histogram puts at 25% seeks
		// and one it puts at 35% scans — the discrimination the declared profile exists to
		// buy. An arm still priced by an {@link ARM_SELECTIVITY} shape constant is instead
		// judged at PARITY `pointRead`, settled when the IndexedDB profile was measured:
		// a fixed fraction makes the veto arm-DISABLING rather than arm-tuning (the
		// flip-point arithmetic is at the top of this file, where the profile's terms are
		// introduced), IndexedDB's measured band straddles the `range` arm's flip point
		// exactly, and the error is wildly asymmetric — disabling the arm costs up to 25×
		// when the real predicate is selective, keeping it costs ~10% in the case the
		// constant describes. So the declared profile decides per QUERY once the estimate
		// is real, and falls back to the parity price where the estimate is still a shape
		// constant. `cost-profile.spec.ts` pins both halves of that policy.
		//
		// Ties keep the seek: it returns fewer rows for the rest of the plan to carry.
		const exemptFromVeto = requestCarriesRuntimeSet
			|| (bestSeekPlan.isMultiSeek && !bestSeekPlan.statsBacked);
		if (exemptFromVeto || bestSeekPlan.vetoCost <= scanPlan.cost) return bestSeekPlan.plan;
		// Losing the seek is SAFE, never a wrong answer: the scan claims no filters, so the
		// engine keeps every one of them as a residual Filter and the row set is identical.
		// Deliberately returns the scan rather than falling through to `costOnlyFallback`
		// below — a cost-only plan performs this same sequential scan while advertising an
		// index arm's (cheaper) cost, so falling through would undo the comparison.
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
 * The empty pinned-column set an ordering-only walk aligns its index under. Deliberately
 * empty even when the request carries equality filters: the walk pushes NO filters, so
 * nothing pins a column to one value inside the walk itself. (The residual `Filter` above
 * the leaf does make an equality column constant in the OUTPUT, which is the argument
 * `MemoryTableModule.evaluateOrderingOnlyPlans` leans on to skip pinned columns — but that
 * argument quietly assumes the equality's comparison collation equates only rows the walk
 * emits adjacently. Declining the skip costs an optimization, never an answer.)
 */
const NO_PINNED_COLUMNS: ReadonlySet<number> = new Set();

/**
 * Pushed-filter operators that reject a NULL in the filtered column: every comparison and
 * IN-membership is false against NULL, and the filter is enforced SOMEWHERE for every
 * plan this module emits (the seek window, `matchesFilters`, or the residual `Filter` the
 * engine keeps for an unhandled filter) — so a row with NULL there never reaches the
 * consumer of an ordering claim.
 */
const NULL_EXCLUDING_OPS: ReadonlySet<string> = new Set([...EQ_OR_IN_OPS, ...RANGE_OPS, 'IS NOT NULL']);

/**
 * Truncate an index's order-preserving prefix at the first DESC column whose walk could
 * misplace NULLs.
 *
 * The engine's ORDER BY places NULLs FIRST for BOTH directions — placement is absolute,
 * never direction-conditioned (`orderByNullResult`, util/comparison.ts). Index key bytes
 * agree on an ASC column (NULL's `0x00` tag sorts below every other tag) but DISAGREE on
 * a DESC column, whose byte inversion sends NULL to the END of the walk. So a DESC
 * ordering claim is only sound when no NULL can appear in that column's emitted rows:
 *
 *  - the column is declared NOT NULL;
 *  - the column is pinned by this arm's own equality (`pinnedCols` — an equality never
 *    matches NULL, and a pinned column contributes no ordering anyway);
 *  - some pushed filter on the column is NULL-excluding ({@link NULL_EXCLUDING_OPS}) —
 *    this is what keeps the parent arms' claims for `where n > 5 order by n desc`, where
 *    the bound itself already evicts every NULL.
 *
 * NOTE: this gate deliberately DIVERGES from `MemoryTableModule.indexSatisfiesOrdering`,
 * which has no NULL check and therefore shares the misplacement for a bare
 * `order by <nullable col> desc` claim (its DESC comparator negation also sends NULLs
 * last) — that twin, and the PK advertisement's (`buildPkOrderingAdvertisement` has the
 * same exposure for a nullable DESC PK member), are tracked as
 * `fix/bug-desc-index-ordering-claims-misplace-nulls`.
 */
function nullSafeOrderingPrefixLength(
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	index: TableIndexSchema,
	orderPreservingPrefix: number,
	pinnedCols: ReadonlySet<number>,
): number {
	for (let i = 0; i < orderPreservingPrefix; i++) {
		const col = index.columns[i];
		if (!col.desc) continue;
		if (tableInfo.columns[col.index]?.notNull) continue;
		if (pinnedCols.has(col.index)) continue;
		if (request.filters.some(f => f.columnIndex === col.index && NULL_EXCLUDING_OPS.has(f.op))) continue;
		return i;
	}
	return orderPreservingPrefix;
}

/**
 * True when a filter plan's `providesOrdering` satisfies `required` position for
 * position (same `columnIndex`, same `desc`; the plan may provide extra trailing
 * ordering) — the engine's own `orderingMatches` (rule-grow-retrieve.ts). Every arm of
 * {@link computeFilterAccessPlan} that matches a `requiredOrdering` claims it VERBATIM,
 * so in practice this is "did some arm already claim it".
 */
function orderingAlreadySatisfied(
	provided: readonly OrderingSpec[] | undefined,
	required: readonly OrderingSpec[],
): boolean {
	if (!provided || provided.length < required.length) return false;
	for (let i = 0; i < required.length; i++) {
		if (provided[i].columnIndex !== required[i].columnIndex || provided[i].desc !== required[i].desc) {
			return false;
		}
	}
	return true;
}

/**
 * Consider replacing `filterPlan` with an ordering-only walk of a secondary index: a
 * whole-index scan (`plan=0`) chosen purely for its emission order, with EVERY pushed
 * filter left to the residual `Filter`. `... order by n` with an index on `n` and no
 * usable predicate otherwise full-scans the data store in PK order and sorts the whole
 * table — the walk streams the rows already ordered at the price of one index-entry read
 * plus one row resolution per row.
 *
 * The Sort-absorption rule (`trySortAbsorbViaIndexOrdering`, rule-grow-retrieve.ts)
 * deletes the Sort on the strength of `providesOrdering` alone, with no cost comparison
 * of its own — so this function is the only place "is the walk actually cheaper than
 * sorting?" gets asked. Mirrors `MemoryTableModule.adjustPlanForOrdering` /
 * `evaluateOrderingOnlyPlans`, minus the memory module's seek-plus-ordering hybrid (the
 * store's seek arms already advertise their ordering, so the hybrid case IS `filterPlan`
 * satisfying the request).
 *
 * `filterPlan` is returned unchanged unless ALL of:
 *  - a required ordering is present that `filterPlan` does not already satisfy;
 *  - the request carries no runtime-valued set — such a request is engine-synthesized
 *    (`rule-key-set-seek`'s probes / the key-set semi join itself) and must be answered
 *    with the module's genuine filter plan: substituting a walk whose cost does not
 *    scale with the key count would corrupt the probe's cost line, and the walk's
 *    all-false `handledFilters` would push the runtime-set membership into a residual
 *    the engine never meant to evaluate that way. Same ONE rule as the seek-vs-scan
 *    veto exemption above.
 *  - some non-partial index's order-preserving prefix satisfies the required ordering
 *    with NO pinned columns (see {@link NO_PINNED_COLUMNS});
 *  - the cheapest such walk prices STRICTLY below `filterPlan` plus the external sort
 *    it would otherwise need. Ties keep `filterPlan` — it is the plan the store already
 *    produces, and the sort estimate is the softer of the two numbers.
 *
 * NOTE: the walk is priced for the WHOLE table because `request.limit` is never
 * populated on this path — `trySortAbsorbViaIndexOrdering` builds its request with no
 * `limit`, and the `LimitOffset` grow arm that does populate one sits above the Sort,
 * not above the Retrieve. So `order by n limit 1` is priced exactly like `order by n`,
 * and a backend declaring an expensive `pointRead` (IndexedDB) prefers scan-then-sort
 * even under a tight LIMIT, where the walk would have read one row. The enabling engine
 * change is backlog `feat-sort-absorb-blind-to-limit`.
 */
function chooseOrderingPlan(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	filterPlan: BestAccessPlanResult,
	profile: ResolvedCostProfile,
): BestAccessPlanResult {
	const required = request.requiredOrdering;
	if (!required || required.length === 0) return filterPlan;
	if (orderingAlreadySatisfied(filterPlan.providesOrdering, required)) return filterPlan;
	if (request.filters.some(f => f.runtimeSet !== undefined)) return filterPlan;

	const estimatedRows = request.estimatedRows ?? 1000;
	let bestWalk: BestAccessPlanResult | null = null;
	for (const index of tableInfo.indexes ?? []) {
		// Partial indexes are excluded from access planning outright (see
		// {@link tryIndexAccessPlan}) — doubly so here, where the walk IS the whole
		// row source and a partial index omits rows no residual can resurrect.
		if (index.predicate || index.columns.length === 0) continue;
		// Same collation gate as the seek arms' ordering advertisement: only the prefix
		// whose key bytes provably reproduce the DECLARED collation's order may claim.
		const indexKeyCollations = resolveIndexKeyCollations(index, tableInfo.columns);
		const orderPreservingPrefix = indexOrderPreservingPrefixLength(
			db, tableInfo.columns, index, indexKeyCollations);
		const claimablePrefix = nullSafeOrderingPrefixLength(
			tableInfo, request, index, orderPreservingPrefix, NO_PINNED_COLUMNS);
		if (claimablePrefix === 0) continue;
		const indexOrdering: OrderingSpec[] = index.columns
			.slice(0, claimablePrefix)
			.map(col => ({ columnIndex: col.index, desc: !!col.desc }));
		if (!indexOrderingSatisfies(indexOrdering, required, NO_PINNED_COLUMNS)) continue;

		const walk = buildOrderingWalkPlan(index, request, required, estimatedRows, profile);
		// Strict '<' keeps the first qualifying index on a tie, so declaration order
		// does not decide — matching the best-seek loop above.
		if (!bestWalk || walk.cost < bestWalk.cost) bestWalk = walk;
	}
	if (!bestWalk) return filterPlan;

	const sortCost = estimateSortCost(filterPlan.rows ?? estimatedRows);
	return bestWalk.cost < filterPlan.cost + sortCost ? bestWalk : filterPlan;
}

/**
 * The advertisement for one ordering-only walk candidate: a whole-index range scan that
 * resolves EVERY index entry to its row (`estimatedRows × profile.pointRead`, added via
 * `addCost` like the seek arms rather than restating the shape's formula) and re-checks
 * every pushed filter in the residual (`estimatedRows × filters × 0.2` — the term that
 * stops a walk from displacing a selective seek on a filtered query).
 *
 * `indexName` is set with NO `seekColumnIndexes`, so `rule-select-access-path`
 * physicalizes through its legacy path's ordering branch: an `IndexScanNode` whose
 * idxStr is `idx=<name>(0);plan=0` (`makeOrderedScanFilterInfo`) and whose FilterInfo
 * carries no constraints. `StoreTableScan.analyzeIndexAccess` reads the `plan=0`
 * explicitly and walks the whole index store. `orderingIndexName` equals `indexName` —
 * `validateAccessPlan` rejects an ordering claim naming any index but the one walked.
 */
function buildOrderingWalkPlan(
	index: TableIndexSchema,
	request: BestAccessPlanRequest,
	required: readonly OrderingSpec[],
	estimatedRows: number,
	profile: ResolvedCostProfile,
): BestAccessPlanResult {
	const plan = AccessPlanBuilder
		.rangeScan(estimatedRows)
		.addCost(estimatedRows * profile.pointRead)
		.addCost(estimatedRows * request.filters.length * RESIDUAL_FILTER_COST_PER_ROW)
		.setHandledFilters(new Array(request.filters.length).fill(false))
		.setIndexName(index.name)
		.setExplanation(`Store index ordering walk on ${index.name}`)
		.build();
	return { ...plan, providesOrdering: required, orderingIndexName: index.name };
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
	// NOTE: this arm is therefore OVER-charged on a backend that declares an expensive
	// profile — `profile.seekPositioning` prices "position an index window AND read the row
	// it names", and here there is no index window (IndexedDB: ≈ 3 units of real cost,
	// charged 5). Accepted rather than split into a third knob: a second multi-seek term
	// would double the tuning surface to model a bias whose only effect is that a very
	// large `where pk in (…)` prefers a scan slightly sooner than it should.
	//
	// That acceptance was priced on IndexedDB's 1.7x bias. LevelDB's 2026-08-19 read-cost
	// measurement makes the same bias an order of magnitude there (a windowed seek key costs
	// about fifteen scan rows, while THIS arm's batched `readEffectiveRowsByKeys` path costs
	// about one-and-a-half), which is why that backend declares no profile at all rather than
	// declaring its measured seek cost and disfiguring this arm. So the tradeoff still holds for every backend that
	// declares one today, but it is now the reason a measured backend CANNOT declare —
	// tracked as `backlog/debt-store-seek-positioning-conflates-two-arms`, with the numbers
	// in `packages/quereus-plugin-leveldb/README.md` § Measured read cost.
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

	// This arm returns straight out of the PK branch, so it never reaches the seek-versus-scan
	// comparison further down `computeBestAccessPlan` — structurally what the secondary arms
	// state as `requestCarriesRuntimeSet`, and ONE rule for both: a request the engine
	// synthesized to probe this module must never be answered with the module's own scan
	// verdict. `rule-key-set-seek` reads this cost as a straight line at 2 and 1000 keys and
	// abandons its whole rewrite if either probe stops naming an index; the engine makes the
	// scan comparison itself, off the break-even it interpolates from those two costs. Do not
	// "fix" this by adding the comparison.
	//
	// The PK arm is exempt unconditionally where the secondary arms are exempt per request,
	// and that is not a divergence: a literal `where pk in (…)` is priced honestly here with
	// or without statistics (the PK is unique, so `D = N` and `min(estimatedRows, K)` already
	// IS the per-predicate estimate — nothing for `ANALYZE` to sharpen), so there is no
	// clamp artifact for a veto to correct.
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
 * **Rows.** Each arm's row estimate comes from {@link resolveArmEstimate}: per-predicate
 * when the table's `ANALYZE`-collected statistics cover the arm's columns, the
 * {@link ARM_SELECTIVITY} shape constant otherwise — with `statsBacked` recording which.
 *
 * **Cost.** Each single-window seek arm pays the backend's declared `profile.pointRead`
 * per row it expects to return, on top of the `AccessPlanBuilder` shape's own per-row term:
 * the shape prices reading the index ENTRY, and the store must then read the ROW that entry
 * names out of the data store. A cost-only decline deliberately does not pay it (it
 * resolves nothing; the scan reads rows directly), and the multi-seek pays it exactly when
 * its row estimate is statistics-backed — the reason is recorded at that arm below. Every
 * candidate also carries a `vetoCost`, the price the seek-vs-scan comparison in
 * {@link computeBestAccessPlan} judges it at: the declared cost itself for a
 * statistics-backed arm, the arm repriced at PARITY `pointRead` otherwise (reasoning at
 * that site).
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
	// Resolved AFTER the prefixRange→eq degradation above, so the estimate prices the arm
	// actually advertised (a degraded arm's unclaimed bound survives in the residual and
	// must not narrow this estimate). For a multi-seek, `eq`'s estimate is PER SEEK KEY —
	// one full equality tuple — which is exactly what the union arithmetic below wants.
	const { selectivity, statsBacked } = resolveArmEstimate(
		tableInfo,
		request.filters,
		arm,
		arm === 'range' ? [] : eqCols,
		arm === 'eq' ? undefined : (arm === 'range' ? leadingCol : trailingRangeCol),
	);
	const rows = Math.max(1, Math.floor(estimatedRows * selectivity));
	/** The arm's shape — `AccessPlanBuilder`'s per-row index-entry term, no resolution. */
	const armShape = (): AccessPlanBuilder =>
		isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3);
	/** The arm's shape plus one per-fetched-row resolution term at the given price. */
	const seekingArm = (pointRead: number): AccessPlanBuilder => armShape().addCost(rows * pointRead);
	const costOnly = (why: string): IndexPlanCandidate => {
		// NO ordering claim on a cost-only decline, ever: it names no index and no seek
		// columns, so the engine sequentially scans the DATA store in primary-key order.
		// An ordering claim here would make `rule-select-access-path` take its
		// ordering-only branch and emit an IndexScanNode over a walk the store never
		// performs — a silent wrong-order answer. (The PK-order advertisement the scan
		// genuinely could carry is a separate matter — see the NOTE at the
		// `costOnlyFallback` return in {@link computeBestAccessPlan}.)
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
			statsBacked,
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
		// advertised — N merged windows emit in seek-key order, not column order, so the
		// single-window arms' `buildIndexOrderingAdvertisement` must never be attached
		// here. `isMultiSeek` (not `seekKeyCount > 1`) is the gate deliberately: a
		// runtime-valued set is delivered as a multi-seek even at `maxCount === 1`.
		//
		// **This arm pays the per-row `profile.pointRead` exactly when `statsBacked`.** It
		// resolves every entry it matches, like the single-window arms do, so the physics
		// always says charge it; what varies is whether `multiRows` is an ESTIMATE worth
		// charging against — and that is precisely what `statsBacked` records.
		//
		// UNBACKED, `rows` is the fixed 0.1 × N equality shape constant, so
		// `min(N, inCount × rows)` reaches the whole table at ten seek keys, and at two or
		// three on a handful-of-rows table. Beyond that the figure is a CLAMP — "the whole
		// table" — rather than an estimate of what the keys match, and charging a per-row
		// term against a clamp prices the estimator's artifact:
		//   - MEASURED: it fails 16 tests in `key-set-seek-store.spec.ts`, every one a
		//     runtime key-set semi join over a 3-to-4-row table that stops seeking.
		//   - The engine's `rule-key-set-seek` interpolates a break-even from THIS cost at 2
		//     and 1000 keys. With the term, `cost(1000 keys) = 500 + 1.3 × N` exceeds a scan's
		//     `N` for every N, so the break-even can never reach the engine's 1000-key ceiling
		//     — key sets above ~710 keys would stop seeking on a table of ANY size, including
		//     the 10M-row tables where an index seek is the entire point.
		//
		// BACKED, `rows` is `N/D` for the seek column, so `inCount × rows` only reaches N as
		// `inCount` approaches `D` — the honest saturation point (at `inCount = D` the IN list
		// really does name every value the column holds). The two failure modes above both
		// dissolve there: the 3-to-4-row key-set tables are covered by the `runtimeSet`
		// exemption at the veto site regardless of statistics, and the probe cost stays a
		// straight line in K (`K·seekPositioning + min(N, K·N/D)·(0.3 + pointRead)`) until the
		// clamp bites at `K ≈ D`, which is where a scan genuinely is cheaper.
		//
		// NOTE: charging it DOES change which key-set semi joins the engine rewrites. The
		// engine fits a chord through this cost at 2 and 1000 keys and solves for a break-even;
		// the honest cost is higher, so a rewrite stops firing once the seek keys approach the
		// table's own row count — 1000 keys over a 1000-row table now scans, correctly. The
		// answer never moves (`column-statistics-plan.spec.ts` pins that), and large tables are
		// untouched (10k keys into 10M rows is still nowhere near the clamp). If an ANALYZE is
		// ever measured making a real key-set join SLOWER, the thing to look at is the chord,
		// not this term: the true cost is concave (linear, then flat once `multiRows` clamps at
		// `K = D`), so a two-point interpolation under-reads it in between.
		//
		// Charging it also fixes the mis-ranking the unbacked case still carries: against
		// another index's `eq` arm (which always pays the term) a small-key IN looks cheaper
		// than it is — `where a in (x, y) and b = ?` over an un-analyzed 1000-row table prices
		// ix_a at 61 and ix_b at 130 and picks ix_a, though ix_a's own estimate says it fetches
		// 200 rows to ix_b's 100. `ANALYZE` is now the fix for that; the residual unbacked case
		// is backlog/debt-store-multi-seek-union-row-estimate.
		const multiRows = Math.min(estimatedRows, inCount * rows);
		const multiSeekShape = AccessPlanBuilder.eqMatch(multiRows, inCount * profile.seekPositioning);
		if (statsBacked) multiSeekShape.addCost(multiRows * profile.pointRead);
		const plan = multiSeekShape
			.setIsSet(false)
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index multi-seek(${inCount}) on ${index.name}`)
			.build();
		return {
			plan,
			// Statistics-backed: the declared profile decides this arm's fate per query, so the
			// veto price IS the declared price. Unbacked: no `pointRead` term was charged, so
			// there is nothing to reprice at parity — and the arm is exempt from the veto
			// anyway. `plan.cost` is right either way.
			vetoCost: plan.cost,
			isMultiSeek: true,
			statsBacked,
		};
	}

	const armLabel = arm === 'prefixRange'
		? `prefix-range seek(prefix=${eqCols.length})`
		: arm === 'range' ? 'range scan' : 'seek';
	// Ordering advertisement — the three single-window arms only, resolved AFTER the
	// `prefixRange → eq` degradation above so the claim describes the arm actually
	// advertised (like the row estimate, and unlike a degraded arm's dropped bound, the
	// pinned set `eqCols` is the same either way). The multi-seek and cost-only returns
	// above deliberately make no claim; the reasons are stated at each.
	const plan = {
		...seekingArm(profile.pointRead)
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index ${armLabel} on ${index.name}`)
			.build(),
		...buildIndexOrderingAdvertisement(db, tableInfo, request, index, indexKeyCollations, eqCols),
	};
	return {
		plan,
		// Statistics-backed: `rows` discriminates per query, so the backend's DECLARED price
		// decides this arm's fate per query — that discrimination is what declaring a profile
		// buys. Otherwise judged at parity, because a shape constant makes the veto
		// arm-disabling rather than arm-tuning (full reasoning at the veto site). The parity
		// price is re-derived from `armShape()` rather than adjusted off `plan.cost`, so it is
		// the exact number the pre-profile module produced rather than a float round trip
		// through the declared one.
		vetoCost: statsBacked ? plan.cost : seekingArm(PARITY_COST_PROFILE.pointRead).build().cost,
		isMultiSeek: false,
		statsBacked,
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

/**
 * Compute the ordering advertisement for a SINGLE-WINDOW secondary-index arm (`eq` with
 * `isMultiSeek === false`, `prefixRange`, or `range`) — the secondary-index twin of
 * {@link buildPkOrderingAdvertisement}, with the same rigour and one deliberate
 * difference in what it measures.
 *
 * **Why the claim is sound at all.** A single-window arm walks ONE contiguous byte
 * region of the index store forward, and every layer between that walk and the caller
 * preserves entry order: batched row resolution answers positionally and skips
 * dead entries without shifting later ones (`resolveIndexEntries` / `resolveRowBatch`,
 * store-table-scan.ts), and the read-your-own-writes merge interleaves pending puts /
 * deletes by byte comparison of the same keys (`iterateEffective`, store-table-base.ts).
 * `buildIndexKey` writes `{index columns}{PK}` with each column's DESC flag baked into
 * the bytes by inversion, so a forward byte walk IS a walk in each index column's
 * declared direction.
 *
 * **What it measures — the declared collation, not the residual's.** The consumer of an
 * ordering claim is `ORDER BY`, which compares under the TABLE COLUMN's declared
 * collation — not under the index column's own `COLLATE`, which is what the seek gates
 * (`indexRangeAtPositionIsOrderSafe`) rightly judge their windows against. So the claim
 * is truncated to {@link indexOrderPreservingPrefixLength} (which compares key bytes
 * against the DECLARED collation via `indexOrderMatchesDeclaredCollation` — see its doc
 * comment for the `collate nocase` counter-example) and voided at prefix 0, exactly as
 * the PK version truncates to `pkOrderPreservingPrefixLength`.
 *
 * **Matching mirrors `MemoryTableModule.indexSatisfiesOrdering`,** including its
 * equality-skip: a column pinned to one value by THIS arm's own seek (`eqCols`) is
 * constant across the whole window and contributes no ordering, so `where a = 1 order
 * by b` over `(a, b)` claims. The pinned set is this arm's `eqCols` — never every
 * equality in `request.filters` — and only a non-multi-seek arm may call this at all: a
 * multi-seek's N merged windows emit in seek-key order, not column order.
 *
 * When `requiredOrdering` is present, the claim is the request verbatim, and only when
 * genuinely satisfied; declines on any explicit `nullsFirst` (no promise about NULL
 * placement — mirrors the PK version). Never reversed: the claim is only ever the index's
 * own declared directions — the store has no reverse secondary-index walk
 * (`iterateEffective` accepts `reverse` but no secondary arm passes it). Absent a request,
 * the index's own (truncated) ordering is advertised so merge-join / streaming-aggregate
 * rules can fire opportunistically — claiming the pinned leading columns there is sound
 * for the same reason the skip is: they are constant.
 *
 * NOTE: the `nullsFirst` decline is a belt on top of the engine's own braces, not the
 * thing that makes `order by <nullable indexed col> nulls last` safe. Nothing populates
 * `OrderingSpec.nullsFirst` today (the same NOTE sits on `MemoryTableModule
 * .indexSatisfiesOrdering`): `trySortAbsorbViaIndexOrdering` refuses a sort key carrying
 * an explicit NULLS placement outright, and `ruleGrowRetrieve`'s Sort arm goes through
 * `extractOrderingFromSortKeys`, which drops `SortKey.nulls` — so that arm could never
 * see the placement to forward it. Harmless while it also never absorbs such a Sort
 * (`index-ordering.spec.ts` pins that the Sort survives). If `nullsFirst` ever starts
 * reaching `requiredOrdering`, this decline becomes load-bearing rather than redundant —
 * index bytes put NULLs FIRST on an ASC column and LAST on a DESC one (inversion), which
 * is the engine's default placement and nothing else.
 *
 * NOTE: advertising the index's own ordering with no `requiredOrdering` can COST a
 * pushdown. `ruleGrowRetrieve` carries an equipped `providesOrdering` into its re-probe as
 * a `requiredOrdering` and declines the grow when the re-probe does not match it. A bare
 * claim includes the pinned leading columns; the matched claim skips them — so
 * `[a, b]` advertised for `where a = 1` cannot be re-satisfied on a second grow and the
 * Filter stays above the Retrieve. Costs an optimization, never an answer (a Filter
 * preserves row order). If a store-backed plan is ever seen refusing a filter pushdown it
 * used to take, advertise only the unpinned suffix here.
 *
 * `orderingIndexName` is always this very index — `validateAccessPlan` rejects a claim
 * naming any index but the one the plan iterates.
 */
function buildIndexOrderingAdvertisement(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	index: TableIndexSchema,
	indexKeyCollations: ReadonlyArray<string | undefined>,
	eqCols: readonly number[],
): Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName'> {
	const orderPreservingPrefix = indexOrderPreservingPrefixLength(
		db, tableInfo.columns, index, indexKeyCollations);
	// Additionally truncated at the first DESC column NULLs could reach: index bytes put
	// them at the walk's END, the engine's ORDER BY puts them FIRST for both directions.
	// See {@link nullSafeOrderingPrefixLength}.
	const claimablePrefix = nullSafeOrderingPrefixLength(
		tableInfo, request, index, orderPreservingPrefix, new Set(eqCols));
	if (claimablePrefix === 0) return {};

	const indexOrdering: OrderingSpec[] = index.columns
		.slice(0, claimablePrefix)
		.map(col => ({ columnIndex: col.index, desc: !!col.desc }));

	const required = request.requiredOrdering;
	if (required && required.length > 0) {
		return indexOrderingSatisfies(indexOrdering, required, new Set(eqCols))
			? { providesOrdering: required, orderingIndexName: index.name }
			: {};
	}
	return { providesOrdering: indexOrdering, orderingIndexName: index.name };
}

/**
 * True when `indexOrdering` (an index's declared column order, already truncated to its
 * order-preserving prefix) satisfies `required` — the position-for-position match of
 * `MemoryTableModule.indexSatisfiesOrdering`, over {@link OrderingSpec}s instead of a
 * schema. Leading pinned columns are skipped before aligning. Any explicit `nullsFirst`
 * declines — see {@link buildIndexOrderingAdvertisement}. An under-length index (fewer
 * unpinned columns than required keys) declines rather than claiming a prefix:
 * `orderingMatches` upstream would reject the short claim anyway, so emitting it would
 * only mislead.
 *
 * The mid-loop skip (a pinned column encountered AFTER the matched prefix, which a
 * constant column between two ordered ones would need) is kept for exact parity with the
 * memory module, where the pinned set can be non-contiguous. It is unreachable from THIS
 * caller: `pinnedCols` is `resolveEqualityPins`' `cols`, which stops at the first
 * unpinned index column, so the leading skip above already consumes every pinned column.
 */
function indexOrderingSatisfies(
	indexOrdering: readonly OrderingSpec[],
	required: readonly OrderingSpec[],
	pinnedCols: ReadonlySet<number>,
): boolean {
	let i = 0; // pointer into indexOrdering
	let j = 0; // pointer into required

	while (i < indexOrdering.length && pinnedCols.has(indexOrdering[i].columnIndex)) i++;

	while (j < required.length) {
		if (required[j].nullsFirst !== undefined) return false;
		if (i >= indexOrdering.length) return false;
		if (required[j].columnIndex === indexOrdering[i].columnIndex
			&& required[j].desc === indexOrdering[i].desc) {
			i++;
			j++;
			continue;
		}
		if (pinnedCols.has(indexOrdering[i].columnIndex)) {
			i++;
			continue;
		}
		return false;
	}
	return true;
}

// --- StoreTableModule interface implementation ---
