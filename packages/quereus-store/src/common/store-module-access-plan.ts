/**
 * Access planning for a store-backed table: which physical access path
 * (`_primary_` point / range seek, a secondary-index seek or multi-seek, or a full
 * scan) this module advertises for a pushed predicate, which of the pushed filters it
 * claims as handled, and what ordering the chosen path provides.
 *
 * The mirror of `store-table-scan.ts`: the planner here decides which access path to
 * advertise, and the scan layer there executes it. Several soundness predicates — the
 * collation-cover guards, the partial-index and semantic-ordering declines — are
 * deliberately duplicated across the two, because a plan that claims a filter the scan
 * cannot honor drops the residual Filter and returns wrong rows. Change one and the
 * other must change with it.
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
import {
	columnCanHoldText,
	keyOrderMatchesCollation,
	pkOrderPreservingPrefixLength,
	resolvePkKeyCollations,
} from './pk-key-resolution.js';

/**
 * Planner-side constraint operator groups, as `BestAccessPlanRequest.filters` spells
 * them. Kept as one source of truth for the access-plan code below: {@link computeBestAccessPlan}
 * classifies each pushed filter with these, and {@link tryIndexAccessPlan} claims a filter as
 * handled only when it falls in the group the engine's access-path rule will consume.
 */
const EQ_OPS = ['='] as const;

/**
 * Secondary-index arm ONLY: an IN is N equalities served as one multi-seek (`plan=5`),
 * whether its members are a literal list or a runtime-valued set. The primary-key arms
 * deliberately keep {@link EQ_OPS} — a `_primary_` multi-seek's emission order would
 * break the isolation layer's primary-key merge — so an IN on the PK declines here,
 * runtime-valued or not. PK IN support is deferred; see
 * tickets/backlog/feat-store-pk-in-list-multiseek.
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

/** Cost of positioning one index seek, in the same unit as the per-row fetch cost. */
const INDEX_SEEK_COST = 0.5;

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
 * The one equality role each seek column of an equality/prefix seek fills. `ops` is
 * explicit so the PK arm ({@link EQ_OPS}) and the secondary-index arm
 * ({@link EQ_OR_IN_OPS}) cannot drift into each other — see the note on EQ_OR_IN_OPS.
 */
function equalityRoles(colIdxs: readonly number[], ops: readonly string[]): SeekRole[] {
	return colIdxs.map(colIdx => ({ colIdx, ops }));
}

/**
 * The access plan this module advertises for `request`, before the caller stamps the
 * module-wide `honorsCollatedRangeBounds` flag onto it.
 *
 * `tableKeyCollation` is the table's resolved key collation K, passed in rather than
 * looked up: the caller (`StoreModule.getBestAccessPlan`) owns the module's table map,
 * and every gate below judges the pushed filters against K.
 */
export function computeBestAccessPlan(
	db: Database,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	tableKeyCollation: string,
): BestAccessPlanResult {
	const estimatedRows = request.estimatedRows ?? 1000;

	// Check for primary key equality constraints. Count DISTINCT pinned PK columns:
	// counting raw '=' filters would read `a = 1 and a = 2` on a composite PK (a, b)
	// as "both PK columns pinned", claim both filters handled, then — with no
	// complete PK equality set to seek — degrade to a sequential scan whose residual
	// has already been discarded, returning the whole table.
	const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);
	const pinnedPkColumns = new Set(
		request.filters
			.filter(f => f.columnIndex !== undefined && pkColumns.includes(f.columnIndex) && f.op === '=')
			.map(f => f.columnIndex)
	);

	if (pinnedPkColumns.size === pkColumns.length && pkColumns.length > 0) {
		// Full PK match - point lookup (single row; no monotonic advertisement)
		return AccessPlanBuilder
			.eqMatch(1, 0.1)
			.setHandledFilters(claimFirstPerRole(request.filters, equalityRoles(pkColumns, EQ_OPS)))
			.setIsSet(true)
			.setIndexName('_primary_')
			.setExplanation('Store primary key lookup')
			.build();
	}

	// Check for range constraints on the leading PK column.
	// The legacy access-path rule (rule-select-access-path.ts) only forwards
	// range bounds for primaryKeyDefinition[0]; ranges on later PK columns
	// are silently dropped if marked handled. So only claim handled=true
	// when the range is on the first PK column.
	//
	// The seek is also declined when the leading PK column's key bytes do not order the
	// way its comparator does (`pkOrderPreservingPrefix === 0`): `StoreTable.analyzePKAccess`
	// declines the byte window under exactly that condition, so claiming the range filters
	// handled here would drop the residual Filter and return the whole table.
	const pkOrderPreservingPrefix = pkOrderPreservingPrefixLength(
		db,
		tableInfo,
		resolvePkKeyCollations(tableInfo.primaryKeyDefinition, tableInfo.columns, tableKeyCollation),
		tableKeyCollation,
	);
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
	// secondary-index scan arm (leading-prefix EQ point / leading-column range),
	// so we advertise the index with `indexName` + `seekColumns` and mark the
	// covered filters handled — subject to the collation-safety guard in
	// {@link tryIndexAccessPlan}. A cost-only plan (no seek) is kept as a fallback
	// when no index yields a collation-safe seek, preserving the prior "cheaper
	// cost, filters unhandled, residual retained" behavior.
	const indexes = tableInfo.indexes || [];
	let bestSeekPlan: BestAccessPlanResult | null = null;
	let costOnlyFallback: BestAccessPlanResult | null = null;
	for (const index of indexes) {
		if (index.columns.length === 0) continue;
		const plan = tryIndexAccessPlan(db, tableKeyCollation, tableInfo, request, index, estimatedRows);
		if (!plan) continue;
		// A fully-handled seek (indexName + seekColumns set) is a candidate: keep the
		// cheapest one seen so far rather than the first, so declaration order of the
		// indexes doesn't decide the plan. Strict '<' so ties keep the first candidate,
		// matching MemoryTableModule.findBestAccessPlan's `indexPlan.cost < bestPlan.cost`.
		if (plan.seekColumnIndexes && plan.seekColumnIndexes.length > 0) {
			if (!bestSeekPlan || plan.cost < bestSeekPlan.cost) bestSeekPlan = plan;
			continue;
		}
		// Otherwise remember the first cost-only advertisement as a fallback.
		if (!costOnlyFallback) costOnlyFallback = plan;
	}
	if (bestSeekPlan) return bestSeekPlan;
	// NOTE: a cost-only plan carries no PK-order advertisement even though the store still
	// iterates in PK key order for it (`StoreTable.query` full-scans). The range gate makes
	// this arm fire more often — an index range on a BINARY text column of a default-K table
	// now lands here — so `... where v > 'x' order by <pk>` picks up a Sort it did not need.
	// If that shows up as slow, merge `buildPkOrderingAdvertisement(...)` into this return.
	//
	// NOTE: cost-only fallback deliberately stays first-wins, not min-cost. These plans
	// handle no filters — the scan full-scans regardless of which index "wins" — so
	// "cheapest" among them isn't a meaningful ranking; picking a lower-cost one here would
	// just under-state the plan's advertised cost to the optimizer without changing the work.
	if (costOnlyFallback) return costOnlyFallback;

	// Fallback to full scan. The store iterates rows in PK key order
	// (see StoreTable.query / store.iterate over buildFullScanBounds), so
	// the scan is monotonic on the leading PK column. Advertise that so
	// downstream rules (merge-join, asof-scan) can fire on store-backed
	// tables, matching memory-mode behavior.
	const plan = AccessPlanBuilder
		.fullScan(estimatedRows)
		.setHandledFilters(new Array(request.filters.length).fill(false))
		.setExplanation('Store full table scan')
		.build();
	return { ...plan, ...buildPkOrderingAdvertisement(tableInfo, request, pkOrderPreservingPrefix) };
}

/**
 * Build the access plan for one secondary index against `request`, or null when
 * the index is not usable for this predicate.
 *
 * Usable = a contiguous leading-prefix EQ on the index columns (an index seek /
 * point), or a LT/LE/GT/GE range on the LEADING index column. These mirror the
 * two windows `StoreTable.analyzeIndexAccess` can build.
 *
 * **Collation-safety guard against under-fetch.** The store's index-column
 * window is encoded under the table key collation K, but `matchesFilters`
 * compares under the COLUMN's declared collation. Marking a filter handled drops
 * the residual Filter, so the K-window must be a guaranteed SUPERSET of the
 * qualifying rows. That holds only when K is coarser-or-equal to the column's
 * declared collation. To stay provably safe with minimal logic we mark the
 * covered filters handled — setting `indexName` + `seekColumns` — only when every
 * seek column is non-text, OR its declared collation equals K, OR (K = NOCASE
 * while the column is BINARY, i.e. K strictly coarser). Otherwise we return a
 * cost-only plan (cheaper cost, filters unhandled, residual retained — correct,
 * just not sped up). K itself always keys: `StoreTable`'s constructor rejects a
 * table whose key encoding would need a collation it cannot resolve to a normalizer.
 *
 * NOTE: the coarser-K relaxation is sound for EQUALITY only. A RANGE window equates
 * memcmp of K-normalized bytes with C's comparator order, which a merely coarser K does
 * not give — under K = NOCASE and C = BINARY, 'K' (U+212A) is `> 'z'` yet keys as 'k',
 * before 'z'. So the range arm demands `C === K` *and* K's `orderPreserving` assertion,
 * via the shared {@link keyOrderMatchesCollation}; `StoreTable.analyzeIndexAccess`
 * declines the same windows, so the two decisions cannot disagree. The cost is that a
 * default-K (NOCASE) table with an index on a plain BINARY text column loses its index
 * RANGE seek and falls back to the cost-only plan; EQ seeks are unchanged.
 */
function tryIndexAccessPlan(
	db: Database,
	tableKeyCollation: string,
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	index: TableIndexSchema,
	estimatedRows: number,
): BestAccessPlanResult | null {
	// Exclude PARTIAL indexes from access planning: neither the engine nor this
	// module checks that the query's WHERE implies the index predicate, so seeking
	// a partial index for a query it doesn't cover would silently drop the rows the
	// index omits (an out-of-scope predicate returns nothing). Treat partial indexes
	// purely as uniqueness enforcers — the query full-scans + residual instead.
	// Mirrors MemoryTableModule.getAvailableIndexes (`if (idx.predicate) continue`).
	if (index.predicate) return null;

	const indexColIndexes = index.columns.map(c => c.index);

	// Contiguous leading-prefix equality → point/prefix seek. An IN filter counts as
	// an equality here (it is N equalities, served as one multi-seek by
	// StoreTable.scanMultiSeek); `inCount` is the cross-product of the per-column
	// seek-key counts (1 for a plain '='), matching the rule's seek-key count. The
	// FIRST role-filling filter per column is what the rule seeks on, so its
	// cardinality is the one that counts.
	//
	// A runtime-valued IN set contributes its `maxCount` ceiling — the worst case the
	// engine may deliver — so every gate below (the MAX_MULTI_SEEK_KEYS cap, the
	// semantic-ordering decline) judges it against the largest multi-seek it could
	// ever be asked to perform.
	const eqCols: number[] = [];
	let inCount = 1;
	// `isMultiSeek` is NOT `inCount > 1`: a runtime set is delivered as a `plan=5`
	// multi-seek even at `maxCount === 1`, so the gates below must judge it as one
	// rather than as the plain EQ its ceiling arithmetic would otherwise suggest.
	// (`inCount > 1` implies this flag — every factor above 1 is a multi-value
	// equality — so the flag only ever *adds* the maxCount-1 runtime-set case.)
	let isMultiSeek = false;
	for (const colIdx of indexColIndexes) {
		const eqFilter = request.filters.find(f => f.columnIndex === colIdx && equalitySeekKeyCount(f) !== null);
		if (!eqFilter) break;
		eqCols.push(colIdx);
		inCount *= equalitySeekKeyCount(eqFilter)!;
		if (isMultiValueEquality(eqFilter)) isMultiSeek = true;
	}
	const leadingCol = indexColIndexes[0];
	const hasLeadingRange = request.filters.some(
		f => f.columnIndex === leadingCol && RANGE_OPS.includes(f.op),
	);

	let seekCols: number[];
	let isRange: boolean;
	if (eqCols.length > 0) {
		seekCols = eqCols;
		isRange = false;
	} else if (hasLeadingRange) {
		seekCols = [leadingCol];
		isRange = true;
	} else {
		return null; // this index cannot serve this predicate
	}

	const rows = isRange
		? Math.max(1, Math.floor(estimatedRows * 0.3))
		: Math.max(1, Math.floor(estimatedRows * 0.1));
	const costOnly = (why: string): BestAccessPlanResult =>
		(isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3))
			.setHandledFilters(new Array(request.filters.length).fill(false))
			.setExplanation(`Store index scan on ${index.name} (${why})`)
			.build();

	// The INDEX column's effective comparison collation C — the index column's own
	// COLLATE, else the table column's declared collation. C, not the table column's
	// declared collation, is what matchesFilters compares an index-scan row under and
	// what the planner matched to drop the residual, so the K-window must be a superset
	// relative to C.
	const K = tableKeyCollation;
	const effectiveCollation = (colIdx: number): string => {
		const indexCol = index.columns.find(c => c.index === colIdx);
		return (indexCol?.collation ?? tableInfo.columns[colIdx]?.collation ?? 'BINARY').toUpperCase();
	};

	// EQUALITY: safe to mark handled iff K is coarser-or-equal to C. Exempt only columns
	// that can NEVER hold text — their key bytes are type-native and collation-independent.
	// A bare `isTextual` test wrongly exempts an `ANY` column (no marker, but it stores
	// text as text), which would seek under K, drop the residual, and lose rows.
	const eqSafeToHandle = (colIdx: number): boolean => {
		const col = tableInfo.columns[colIdx];
		if (!columnCanHoldText(col)) return true;
		const C = effectiveCollation(colIdx);
		if (C === K) return true;                               // equal
		if (K === 'NOCASE' && C === 'BINARY') return true;      // K strictly coarser
		return false;
	};

	// RANGE: coarser is not enough — byte order must BE comparator order. See the doc above.
	const rangeSafeToHandle = (colIdx: number): boolean =>
		keyOrderMatchesCollation(db, tableInfo.columns[colIdx], K, effectiveCollation(colIdx));

	if (!seekCols.every(isRange ? rangeSafeToHandle : eqSafeToHandle)) {
		return costOnly('cost-only; key collation may under-fetch');
	}

	// Multi-seek declines. Cost-only keeps the residual, so the answer stays right
	// and only the speed-up is lost.
	if (inCount > MAX_MULTI_SEEK_KEYS) {
		return costOnly(`cost-only; IN cross-product of ${inCount} exceeds the ${MAX_MULTI_SEEK_KEYS}-seek cap`);
	}
	if (isMultiSeek && seekCols.some(colIdx => hasSemanticOrdering(tableInfo.columns[colIdx]?.logicalType))) {
		// A plain EQ on a TIMESPAN/JSON column degrades safely (StoreTable.analyzeIndexAccess
		// breaks its prefix there and the full-scan residual re-filters under the type's
		// compare), but a multi-seek drops the residual and its byte-equality windows
		// under-fetch the type's equality ('PT1H' ≡ 'PT60M', byte-distinct raw values).
		return costOnly('cost-only; semantic-ordering seek column cannot multi-seek');
	}

	// Claim positionally — see {@link claimFirstPerRole}.
	const handledFilters = claimFirstPerRole(
		request.filters,
		isRange ? rangeRoles(leadingCol) : equalityRoles(eqCols, EQ_OR_IN_OPS),
	);

	if (isMultiSeek) {
		// Multi-seek (plan=5): inCount point seeks, `rows` matched per seek key. The
		// per-seek positioning term keeps a 500-key IN over a 10-row table from pricing
		// below a full scan and issuing 500 seeks to read 10 rows. `isSet` false mirrors
		// MemoryTableModule.evaluateIndexAccess's setIsSet(!isMultiSeek). No ordering is
		// advertised — window emission order is encoded-key order, not any column order.
		const multiRows = Math.min(estimatedRows, inCount * rows);
		return AccessPlanBuilder.eqMatch(multiRows, inCount * INDEX_SEEK_COST)
			.setIsSet(false)
			.setHandledFilters(handledFilters)
			.setIndexName(index.name)
			.setSeekColumns(seekCols)
			.setExplanation(`Store index multi-seek(${inCount}) on ${index.name}`)
			.build();
	}

	return (isRange ? AccessPlanBuilder.rangeScan(rows, 0.2) : AccessPlanBuilder.eqMatch(rows, 0.3))
		.setHandledFilters(handledFilters)
		.setIndexName(index.name)
		.setSeekColumns(seekCols)
		.setExplanation(`Store index ${isRange ? 'range scan' : 'seek'} on ${index.name}`)
		.build();
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
