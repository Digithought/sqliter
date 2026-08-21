/**
 * Modern, type-safe replacement for xBestIndex API
 * Provides better type safety, clearer intent, and extensibility for future optimizations
 */

import { quereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import type { LogicalType } from '../types/logical-type.js';
import { validateIndexDescriptor, type IndexDescriptor } from './index-descriptor.js';
import type { IndexColumnSchema, TableSchema } from '../schema/table.js';

/**
 * Constraint operators that can be pushed down to virtual tables
 */
export type ConstraintOp = '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB' | 'IS NULL' | 'IS NOT NULL' | 'IN' | 'NOT IN' | 'OR_RANGE';

/**
 * Column metadata provided to virtual tables for planning
 */
export interface ColumnMeta {
	/** Column index in the table */
	index: number;
	/** Column name */
	name: string;
	/** Logical type information */
	type: LogicalType;
	/** Whether this column is part of the primary key */
	isPrimaryKey: boolean;
	/** Whether this column has a unique constraint */
	isUnique: boolean;
}

/**
 * A single range specification within an OR_RANGE constraint.
 * Each range has optional lower and upper bounds.
 */
export interface RangeSpec {
	lower?: { op: '>=' | '>'; value: SqlValue };
	upper?: { op: '<=' | '<'; value: SqlValue };
}

/**
 * Describes an `IN` constraint whose member values are produced at execution time
 * (typically from a subquery), so the planner cannot name them. Present ⇒ `value`
 * is absent.
 *
 * A module that accepts such a constraint (`handledFilters[i] = true`, plus
 * `indexName` and `seekColumnIndexes`) promises only that it can serve the column as
 * a multi-seek on the named index. In exchange the engine promises that at `query()`
 * time the module receives an ordinary `plan=5` multi-seek `FilterInfo` — the same
 * shape a literal `IN (…)` list produces, with `1 ≤ K ≤ maxCount` seek keys — so no
 * module runtime needs to change and nothing distinguishes a runtime-derived set from
 * a hand-written list. Declining is always safe. See `docs/module-authoring.md`
 * § "Runtime-valued `IN` sets".
 */
export interface RuntimeSetSpec {
	/**
	 * Hard ceiling on the number of seek keys the engine will deliver at query() time.
	 * The engine enforces it: a larger set never reaches the module — the engine falls
	 * back to a full scan on its own.
	 */
	readonly maxCount: number;
	/**
	 * Planner's estimate of the actual count, when it has one. Advisory — a module may
	 * price against it but must still be correct for any count in `1..maxCount`. When
	 * present it is an integer in `0..maxCount` (0 meaning "probably empty").
	 *
	 * NOTE: no shipped module reads this — both price against `maxCount`, i.e. worst case.
	 * If the engine ever probes with a large ceiling for a typically tiny set, those plans
	 * will look more expensive than they are and may lose to a scan they should beat;
	 * blend `estimatedCount` into the cost (not into the safety gates) at that point.
	 */
	readonly estimatedCount?: number;
}

/**
 * A predicate constraint extracted from WHERE clause
 */
export interface PredicateConstraint {
	/** Column index this constraint applies to */
	columnIndex: number;
	/** Constraint operator */
	op: ConstraintOp;
	/** Constant value if this is a column-constant comparison */
	value?: SqlValue;
	/** Whether this constraint can be used by the virtual table */
	usable: boolean;
	/** Range specifications for OR_RANGE constraints */
	ranges?: RangeSpec[];
	/**
	 * Set only when `op === 'IN'` and the members are not known at plan time.
	 * Mutually exclusive with `value` — see {@link RuntimeSetSpec}.
	 */
	readonly runtimeSet?: RuntimeSetSpec;
}

/**
 * Number of seek keys an equality-role filter contributes at plan time, or null when
 * the filter cannot fill an equality role at all:
 *
 *   `=`                    → 1
 *   literal `IN`           → `value.length` (elements may be `undefined` for parameter
 *                            bindings — only the LENGTH is meaningful at plan time)
 *   runtime-set `IN`       → `runtimeSet.maxCount`, the WORST case; the delivered count
 *                            is anywhere in `1..maxCount`
 *   anything else          → null
 *
 * A malformed shape — an empty literal list, a `maxCount` that is not a positive integer —
 * returns null, so a module declines it and it survives as a residual. That mirrors the
 * literal arm's long-standing non-empty-array gate and holds even when
 * {@link validateAccessPlanRequest} was never called (the store module, for one, does not
 * call it), so a bad request degrades to a scan rather than to a zero-key seek.
 *
 * For plan-time-known values this mirrors the exact predicate
 * `rule-select-access-path`'s `eqBySeekCol` uses to pick its per-column equality
 * constraint, so a module's positional claim and the rule's pick cannot disagree. The
 * runtime-set arm has no counterpart there because nothing in the planner emits
 * `runtimeSet` yet — `feat-key-set-semi-join` supplies the engine half and lowers a
 * runtime set to a literal seek-key list before the rule ever sees it.
 */
export function equalitySeekKeyCount(f: PredicateConstraint): number | null {
	if (f.op === '=') return 1;
	if (f.op === 'IN') {
		if (f.runtimeSet) {
			const { maxCount } = f.runtimeSet;
			return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : null;
		}
		if (Array.isArray(f.value) && (f.value as unknown[]).length > 0) {
			return (f.value as unknown[]).length;
		}
	}
	return null;
}

/**
 * True when the filter may seek more than one key — i.e. it walks the index in seek-key
 * order rather than column order, so a plan built on it cannot claim `providesOrdering`
 * over that column and is not a scan-constant.
 *
 * A well-formed runtime set is ALWAYS multi-valued here, even at `maxCount === 1`: the
 * delivered count is not knowable at plan time, and mistaking a multi-seek for a constant
 * would elide a `Sort` the plan needs. (That is the one case where this disagrees with
 * `equalitySeekKeyCount(f) > 1`; the conservative answer is the safe one.) A malformed
 * one fills no equality role at all, so it is not multi-valued either.
 */
export function isMultiValueEquality(f: PredicateConstraint): boolean {
	if (f.op !== 'IN') return false;
	if (f.runtimeSet) return equalitySeekKeyCount(f) !== null;
	return Array.isArray(f.value) && (f.value as unknown[]).length > 1;
}

/**
 * Pushed-filter operators that reject a NULL in the filtered column: every comparison and
 * IN-membership evaluates to NULL (not TRUE) against a NULL operand, and `IS NOT NULL`
 * says so outright. A row with NULL in that column therefore cannot survive the filter —
 * wherever the filter ends up being enforced.
 *
 * `OR_RANGE` is deliberately absent. It is a union of NULL-rejecting ranges and so would
 * in fact be NULL-excluding, but it already disqualifies an ordering claim on other
 * grounds in both shipped backends (concatenated windows emit in range order, not column
 * order), so including it would widen what has to be argued and buy nothing.
 */
const NULL_EXCLUDING_OPS: ReadonlySet<ConstraintOp> = new Set<ConstraintOp>([
	'=', 'IN', '>', '>=', '<', '<=', 'IS NOT NULL',
]);

/**
 * Truncate an ordered key's order-preserving prefix at the first DESC column whose walk
 * could misplace NULLs. Shared by every module that turns an index (or primary-key) walk
 * into an ordering claim.
 *
 * The engine's ORDER BY places NULLs FIRST for BOTH directions — placement is absolute,
 * never direction-conditioned (`orderByNullResult`, util/comparison.ts). Both shipped
 * backends agree on an ASC column and DISAGREE on a DESC one: the store bit-inverts the
 * column's key bytes (NULL's low `0x00` tag ends up last) and the memory module negates
 * the ascending comparator (NULL is the lowest value, so negation sends it last). So a
 * DESC ordering claim is only sound when no NULL can appear in that column's emitted
 * rows:
 *
 *  - the column is declared NOT NULL — columns are NOT NULL by default in this engine, so
 *    this is the case that keeps the gate from firing on ordinary tables;
 *  - the column is pinned by this plan's own equality (`pinnedCols`) — an equality never
 *    matches NULL, and a pinned column contributes no ordering anyway;
 *  - some pushed filter on the column is NULL-excluding ({@link NULL_EXCLUDING_OPS}) —
 *    this is what keeps `where n > 5 order by n desc` fast, and it holds whether or not
 *    the module marks the filter handled: an unhandled filter is retained by the engine
 *    as a residual `Filter`, which removes the NULL rows and preserves order either way.
 *
 * `keyColumns` is `ReadonlyArray<IndexColumnSchema>` rather than a whole `IndexSchema` so
 * that a table's `primaryKeyDefinition` can be passed directly — `PrimaryKeyColumnDefinition`
 * is structurally identical (`{ index; desc?; collation? }`) and a nullable DESC primary-key
 * member is exposed by exactly the same reasoning as a secondary-index one.
 *
 * The prefix-length form is the primitive. A caller that claims a required ordering
 * VERBATIM (all or nothing, which is what both backends' request-matching paths do) wants
 * the boolean `nullSafeOrderingPrefixLength(...) === matchedLength`; truncation only
 * matters where an index's OWN ordering is advertised with no request to match.
 */
export function nullSafeOrderingPrefixLength(
	tableInfo: TableSchema,
	request: BestAccessPlanRequest,
	keyColumns: ReadonlyArray<IndexColumnSchema>,
	orderPreservingPrefix: number,
	pinnedCols: ReadonlySet<number>,
): number {
	for (let i = 0; i < orderPreservingPrefix; i++) {
		const col = keyColumns[i];
		if (!col.desc) continue;
		if (tableInfo.columns[col.index]?.notNull) continue;
		if (pinnedCols.has(col.index)) continue;
		if (request.filters.some(f => f.columnIndex === col.index && NULL_EXCLUDING_OPS.has(f.op))) continue;
		return i;
	}
	return orderPreservingPrefix;
}

/**
 * Ordering specification for ORDER BY clauses
 */
export interface OrderingSpec {
	/** Column index to order by */
	columnIndex: number;
	/** True for descending order, false for ascending */
	desc: boolean;
	/** Whether NULL values should come first or last */
	nullsFirst?: boolean;
}

/**
 * Request object passed to getBestAccessPlan containing query planning information
 */
export interface BestAccessPlanRequest {
	/** Column metadata for the table */
	columns: readonly ColumnMeta[];
	/** Extracted predicate constraints from WHERE clause */
	filters: readonly PredicateConstraint[];
	/** Required ordering that ancestor nodes need (ORDER BY) */
	requiredOrdering?: readonly OrderingSpec[];
	/** LIMIT value known at plan time */
	limit?: number | null;
	/**
	 * OFFSET value known at plan time. Modules pushing LIMIT into the scan
	 * must read this and stamp `scan-side limit = limit + offset`, because the
	 * runtime LimitOffsetNode still applies the OFFSET skip above whatever the
	 * scan emits — pushing only `limit` would underproduce by `offset` rows.
	 *
	 * If the module advertises `supportsOrdinalSeek` on its result, the runtime
	 * may instead consume this `offset` directly as a seek-to-kth-row directive
	 * (no buffer-and-discard); in that case the scan emits exactly `limit` rows
	 * starting at the `offset`-th monotonic position.
	 */
	offset?: number | null;
	/** Estimated rows hint from planner (may be unknown) */
	estimatedRows?: number;
}

/**
 * Result object returned by getBestAccessPlan describing the chosen query plan
 */
export interface BestAccessPlanResult {
	/** Which filters were handled by the virtual table (parallel to filters array) */
	handledFilters: readonly boolean[];
	/** Optional JavaScript filter function for residual predicates */
	residualFilter?: (row: Row) => boolean;
	/** Estimated cost in arbitrary virtual CPU units */
	cost: number;
	/** Estimated number of rows this plan will return */
	rows: number | undefined;
	/** Ordering guaranteed by this access plan */
	providesOrdering?: readonly OrderingSpec[];
	/** Name of the index that provides the ordering (if any) */
	orderingIndexName?: string;
	/** Name of the index chosen for filtering (e.g., '_primary_' or a secondary index name) */
	indexName?: string;
	/**
	 * Structured identity of the index named by `indexName` (or, for an ordering-only
	 * plan, by `orderingIndexName`).
	 *
	 * OPTIONAL when that name is `_primary_` or matches an index present in the table
	 * schema — the engine resolves those itself. REQUIRED when the module names the
	 * index anything else (e.g. a per-plan alias like `_primary_1`): without it the
	 * engine cannot tell a primary-key walk from a secondary-index walk, and consumers
	 * that depend on scan order (the isolation layer's overlay merge) cannot trust the
	 * plan. See `docs/module-authoring.md`.
	 */
	indexDescriptor?: IndexDescriptor;
	/** Column indexes that form the seek/range key, in order */
	seekColumnIndexes?: readonly number[];
	/** Whether this plan guarantees unique rows (helps DISTINCT optimization) */
	isSet?: boolean;
	/** Free-text explanation for debugging */
	explains?: string;

	/**
	 * The access path emits rows in monotonic non-decreasing (or non-increasing,
	 * for `direction: 'desc'`) order on the named column. Stronger than
	 * `providesOrdering` because:
	 *   - it is a property of the underlying storage (not just a sort),
	 *   - the column's values are total-ordered with no gaps in coverage,
	 *   - downstream rules may rely on `between(a,b)` semantics.
	 *
	 * `strict = true` additionally guarantees no two rows share a value.
	 *
	 * `columnIndex` is the table-relative column index (0-based, into
	 * `request.columns`). The optimizer translates this into an attribute id
	 * when lifting onto the physical leaf node.
	 */
	monotonicOn?: {
		columnIndex: number;
		direction: 'asc' | 'desc';
		strict: boolean;
	};

	/**
	 * The module honours each index column's declared COLLATION when filtering and
	 * positioning a NON-equality (range / BETWEEN / prefix-range / OR_RANGE) index
	 * seek — i.e. it compares range bounds and early-terminates the walk under the
	 * index collation, not a fixed BINARY comparator.
	 *
	 * Default/absent ⇒ the access-path collation-cover analysis
	 * (`classifyConstraintCover` in `rule-select-access-path.ts`) conservatively
	 * DECLINES a non-BINARY range seek (predicate collation = index collation but not
	 * BINARY) and falls back to a scan + residual, because a BINARY bound filter over
	 * a non-BINARY-ordered window would under-fetch case/space variants.
	 *
	 * When true, that range seek is permitted whenever the predicate's effective
	 * collation equals the index collation (mirroring the equality MATCH arm). Only
	 * modules whose runtime actually threads the index collation into the bound
	 * compare may set this — the in-memory vtab does (`scan-layer.ts` /
	 * `plan-filter.ts`), and so does the store module (its post-fetch row filter
	 * `StoreTable.compareValues` compares every pushed bound under the column's
	 * declared collation via `compareSqlValues`).
	 */
	honorsCollatedRangeBounds?: boolean;

	/**
	 * The access path supports O(log N) seek to the kth row in monotonic
	 * order — i.e., LIMIT n OFFSET k can be pushed into the scan instead
	 * of buffer-and-discard. Implies `monotonicOn` is set.
	 *
	 * The vtab's query()/scan() implementation must accept an offset
	 * directive in its access-plan request when this is advertised.
	 */
	supportsOrdinalSeek?: boolean;

	/**
	 * The access path can serve as the right input to a streaming asof
	 * scan: given a left row and its match key, the vtab can position
	 * its cursor at the largest row ≤ that key in O(log avg-gap), and
	 * advance forward without re-seeking for monotonically increasing
	 * left keys. Implies `monotonicOn` is set.
	 */
	supportsAsofRight?: boolean;
}

/**
 * Builder class for constructing access plan results
 */
export class AccessPlanBuilder {
	private result: Partial<BestAccessPlanResult> = {};

	/**
	 * Create a full table scan access plan
	 */
	static fullScan(estimatedRows: number): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(estimatedRows * 1.0) // Sequential scan cost
			.setRows(estimatedRows)
			.setExplanation('Full table scan');
	}

	/**
	 * Create an equality match access plan (index seek)
	 */
	static eqMatch(matchedRows: number, indexCost: number = 0.5): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(indexCost + matchedRows * 0.3)
			.setRows(matchedRows)
			.setIsSet(matchedRows <= 1)
			.setExplanation('Index equality seek');
	}

	/**
	 * Create a range scan access plan
	 */
	static rangeScan(estimatedRows: number, indexCost: number = 0.3): AccessPlanBuilder {
		return new AccessPlanBuilder()
			.setCost(indexCost + estimatedRows * 0.5)
			.setRows(estimatedRows)
			.setExplanation('Index range scan');
	}

	/**
	 * Set the estimated cost of this access plan
	 */
	setCost(cost: number): this {
		this.result.cost = cost;
		return this;
	}

	/**
	 * Add to the cost already set — by a static shape constructor above, or by an
	 * earlier {@link setCost}.
	 *
	 * For a module that pays a per-row term one of the standard shapes does not model:
	 * a secondary-index path resolves every index entry to its row in a second store,
	 * which {@link eqMatch} / {@link rangeScan} do not charge for. Adding to the shape's
	 * cost keeps that module from restating (and drifting from) the shape's own formula.
	 */
	addCost(delta: number): this {
		if (this.result.cost === undefined) {
			quereusError('addCost requires a cost to have been set first', StatusCode.INTERNAL);
		}
		this.result.cost += delta;
		return this;
	}

	/**
	 * Set the estimated number of rows
	 */
	setRows(rows: number | undefined): this {
		this.result.rows = rows;
		return this;
	}

	/**
	 * Set which filters are handled by this plan
	 */
	setHandledFilters(handledFilters: readonly boolean[]): this {
		this.result.handledFilters = handledFilters;
		return this;
	}

	/**
	 * Set the ordering provided by this plan
	 */
	setOrdering(ordering: readonly OrderingSpec[]): this {
		this.result.providesOrdering = ordering;
		return this;
	}

	/**
	 * Set whether this plan produces unique rows
	 */
	setIsSet(isSet: boolean): this {
		this.result.isSet = isSet;
		return this;
	}

	/**
	 * Set an explanation for debugging
	 */
	setExplanation(explanation: string): this {
		this.result.explains = explanation;
		return this;
	}

	/**
	 * Set the index name chosen for this access plan
	 */
	setIndexName(indexName: string): this {
		this.result.indexName = indexName;
		return this;
	}

	/**
	 * Set the structured identity of the chosen index. Required when `indexName` is a
	 * per-plan alias the engine cannot resolve from the table schema.
	 */
	setIndexDescriptor(indexDescriptor: IndexDescriptor): this {
		this.result.indexDescriptor = indexDescriptor;
		return this;
	}

	/**
	 * Set the column indexes that form the seek/range key
	 */
	setSeekColumns(seekColumnIndexes: readonly number[]): this {
		this.result.seekColumnIndexes = seekColumnIndexes;
		return this;
	}

	/**
	 * Set a residual filter function
	 */
	setResidualFilter(filter: (row: Row) => boolean): this {
		this.result.residualFilter = filter;
		return this;
	}

	/**
	 * Build the final access plan result
	 */
	build(): BestAccessPlanResult {
		// Ensure required fields are set
		if (this.result.cost === undefined) {
			quereusError('Access plan cost must be set', StatusCode.INTERNAL);
		}
		if (this.result.handledFilters === undefined) {
			this.result.handledFilters = [];
		}

		return this.result as BestAccessPlanResult;
	}
}

/**
 * Validate the REQUEST the engine hands a module, before the module can improvise on a
 * shape it was never promised. Called from {@link validateAccessPlan}, so every module
 * that follows the validate-your-plan convention gets it without a second call site.
 *
 * The checks are all on {@link RuntimeSetSpec}: it must ride an `IN`, it must not carry
 * plan-time `value`s (a module reading `value` on a runtime set would seek on garbage),
 * its ceiling must be a usable count, and an advisory `estimatedCount` must fall within
 * that ceiling — an estimate above `maxCount` describes a set the engine has promised
 * never to deliver, so it is an engine bug rather than a pessimistic guess.
 */
export function validateAccessPlanRequest(request: BestAccessPlanRequest): void {
	for (const filter of request.filters) {
		if (!filter.runtimeSet) continue;

		if (filter.op !== 'IN') {
			quereusError(
				`runtimeSet is only valid on an 'IN' constraint, got '${filter.op}' on column ${filter.columnIndex}`,
				StatusCode.FORMAT
			);
		}
		if (filter.value !== undefined) {
			quereusError(
				`runtimeSet and value are mutually exclusive (column ${filter.columnIndex}); a runtime set has no plan-time members`,
				StatusCode.FORMAT
			);
		}
		const { maxCount, estimatedCount } = filter.runtimeSet;
		if (!Number.isInteger(maxCount) || maxCount < 1) {
			quereusError(
				`runtimeSet.maxCount must be an integer >= 1, got ${maxCount} on column ${filter.columnIndex}`,
				StatusCode.FORMAT
			);
		}
		if (estimatedCount !== undefined && (!Number.isInteger(estimatedCount) || estimatedCount < 0 || estimatedCount > maxCount)) {
			quereusError(
				`runtimeSet.estimatedCount must be an integer in 0..${maxCount}, got ${estimatedCount} on column ${filter.columnIndex}`,
				StatusCode.FORMAT
			);
		}
	}
}

/**
 * Validation function for access plan results
 * Throws if the plan violates basic contracts
 */
export function validateAccessPlan(
	request: BestAccessPlanRequest,
	result: BestAccessPlanResult
): void {
	validateAccessPlanRequest(request);

	// Validate handledFilters array length
	if (result.handledFilters.length !== request.filters.length) {
		quereusError(
			`handledFilters length (${result.handledFilters.length}) must match filters length (${request.filters.length})`,
			StatusCode.FORMAT
		);
	}

	// Validate cost is non-negative
	if (result.cost < 0) {
		quereusError(`Access plan cost cannot be negative: ${result.cost}`, StatusCode.INTERNAL);
	}

	// Validate rows is non-negative if specified
	if (result.rows !== undefined && result.rows < 0) {
		quereusError(`Access plan rows cannot be negative: ${result.rows}`, StatusCode.INTERNAL);
	}

	// Validate ordering column indexes
	if (result.providesOrdering) {
		for (const order of result.providesOrdering) {
			if (order.columnIndex < 0 || order.columnIndex >= request.columns.length) {
				quereusError(
					`Invalid ordering column index ${order.columnIndex}, must be 0-${request.columns.length - 1}`,
					StatusCode.FORMAT
				);
			}
		}
	}

	// Whenever a plan claims `providesOrdering`, it must identify the index that
	// produces that order via `orderingIndexName`. When the same plan also drives
	// iteration via `indexName` (i.e., a seek/range plan), the two MUST refer to
	// the same index — claiming ordering from one index while iterating via
	// another silently emits rows in the wrong order. This invariant catches
	// the bug at the boundary regardless of which module emits the plan.
	if (result.providesOrdering && result.providesOrdering.length > 0) {
		if (!result.orderingIndexName) {
			quereusError(
				'providesOrdering requires orderingIndexName to identify the source index',
				StatusCode.FORMAT
			);
		}
		if (result.indexName && result.indexName !== result.orderingIndexName) {
			quereusError(
				`providesOrdering claims ordering from '${result.orderingIndexName}' but plan iterates via '${result.indexName}'; ordering can only be claimed from the same index that drives iteration`,
				StatusCode.FORMAT
			);
		}
	}

	// Validate seek column indexes
	if (result.seekColumnIndexes) {
		for (const colIdx of result.seekColumnIndexes) {
			if (colIdx < 0 || colIdx >= request.columns.length) {
				quereusError(
					`Invalid seek column index ${colIdx}, must be 0-${request.columns.length - 1}`,
					StatusCode.FORMAT
				);
			}
		}
	}

	// A supplied indexDescriptor must describe the index the plan actually drives —
	// a descriptor naming a different index than `indexName` is a module bug, and
	// silently reconciling it would hand order-sensitive consumers the wrong sort key.
	if (result.indexDescriptor) {
		validateIndexDescriptor(
			result.indexDescriptor,
			result.indexName,
			result.orderingIndexName,
			request.columns.length,
		);
	}

	// Validate monotonicOn column index is in range
	if (result.monotonicOn) {
		const colIdx = result.monotonicOn.columnIndex;
		if (colIdx < 0 || colIdx >= request.columns.length) {
			quereusError(
				`Invalid monotonicOn column index ${colIdx}, must be 0-${request.columns.length - 1}`,
				StatusCode.FORMAT
			);
		}
	}

	// Validate supportsOrdinalSeek implies monotonicOn is set
	if (result.supportsOrdinalSeek && !result.monotonicOn) {
		quereusError(
			'supportsOrdinalSeek requires monotonicOn to be set',
			StatusCode.FORMAT
		);
	}

	// Validate supportsAsofRight implies monotonicOn is set
	if (result.supportsAsofRight && !result.monotonicOn) {
		quereusError(
			'supportsAsofRight requires monotonicOn to be set',
			StatusCode.FORMAT
		);
	}
}


