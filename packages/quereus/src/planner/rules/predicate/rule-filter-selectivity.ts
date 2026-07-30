/**
 * Rule: Filter Selectivity
 *
 * Stamps a stats-derived selectivity onto a FilterNode so its `estimatedRows`
 * reflects real column statistics instead of the flat DEFAULT_FILTER_SELECTIVITY.
 *
 * Registered TWICE, both bottom-up:
 *
 *   - `filter-selectivity` (Physical pass), which fires AFTER the Structural pass —
 *     predicate-pushdown / grow-retrieve have already put the Filter in its final
 *     position over its final source, so the source subtree is settled (and may carry
 *     physical access nodes between the join and its table references). This stamp is
 *     what the physical and PostOptimization cost readers consult.
 *   - `filter-selectivity-restamp` (PostOptimization pass, registered first in that
 *     pass), which recovers the estimate for a Filter whose stamp was dropped by
 *     `FilterNode.withChildren` because PostOptimization rewrote something inside its
 *     predicate — `scalar-subquery-cache` wrapping an uncorrelated scalar subquery's
 *     inner re-mints every scalar ancestor up to the predicate. Without it, any query
 *     with a subquery in its `where` plans on the flat DEFAULT_FILTER_SELECTIVITY.
 *
 * The `selectivity !== undefined` guard below makes the second registration a no-op on
 * every Filter whose stamp survived, so it only ever fills in, never overwrites. Both
 * firings read a physical source subtree (`select-access-path` has already replaced
 * Retrieve with an access node by the Physical pass's own bottom-up order);
 * PostOptimization sources are the same shape or further lowered.
 *
 * Node-level accessors (`estimatedRows` / `computePhysical`) carry no OptContext,
 * so a Filter cannot consult `context.stats` from inside itself. This rule holds
 * the context, does the lookup, and mints a stamped Filter — the estimate then
 * flows through `estimatedRows` automatically.
 *
 * Two paths:
 *   - **single-table** — `extractRowSourceTableSchema` finds one base table under
 *     the Filter *whose rows are the ones arriving at it*; hand the whole predicate
 *     to the provider, which decomposes its boolean structure itself.
 *   - **multi-relation** — the source spans several tables (a join), or the strict
 *     walk declined. Split the predicate into conjuncts, attribute each to the base
 *     table(s) its columns come from, estimate per conjunct, and combine.
 *
 * The strict walk matters because an aggregate's output rows are a different
 * population from its source's, so no fraction of the base table describes them at
 * all: over `select cat, count(*) as ct from o group by cat having ct > 2` the
 * permissive `extractTableSchema` reaches `o` through the aggregate, but `o`'s row
 * count and column distributions say nothing about how many GROUPS survive `ct > 2`.
 *
 * Both paths hand the provider a {@link ColumnStatsResolver} built from
 * `collectColumnOrigins`, so a column in the predicate is matched to statistics by
 * ATTRIBUTE IDENTITY rather than by the name in its AST. `ProjectNode` forwards the
 * source attribute id for a bare column reference and mints a fresh one for a
 * computed expression, which is exactly the distinction wanted: `select cat as qty`
 * still reads `o.cat`'s statistics, while `select id * 7 as qty` reads none rather
 * than borrowing `o.qty`'s because the alias happens to collide.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { TableSchema } from '../../../schema/table.js';
import { FilterNode } from '../../nodes/filter.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, type TableReferenceNode } from '../../nodes/reference.js';
import { extractRowSourceTableSchema } from '../../util/key-utils.js';
import { collectColumnOrigins, type ColumnOrigin } from '../../util/column-origins.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import { combineConjunctive } from '../../stats/selectivity-combine.js';
import type { ColumnStatsResolver } from '../../stats/index.js';

const log = createLogger('optimizer:rule:filter-selectivity');

/**
 * Selectivity of an inequality (`<` `<=` `>` `>=`) comparing a column of one table
 * to a column of another. The standard uniform-distribution estimate for a
 * two-sided inequality is 1/3: there is no cross-table histogram, so nothing
 * better than the uniform assumption is available here.
 */
export const CROSS_RELATION_INEQUALITY_SELECTIVITY = 1 / 3;

export function ruleFilterSelectivity(node: PlanNode, context: OptContext): PlanNode | null {
	const filter = node as FilterNode;

	// Idempotent: a prior fire already stamped this Filter → decline. (The pass
	// engine also suppresses re-offering a rule its own output, but this guard
	// makes the rule safe on any already-stamped node regardless.)
	if (filter.selectivity !== undefined) return null;

	// extractRowSourceTableSchema walks single-child wrappers (Filter/Project/Sort/
	// Retrieve/TableReference) to the base table, but stops at any operator whose
	// output rows are not its source's rows (aggregate, recursive CTE, set operation).
	// It returns undefined for those and for a join / other multi-relation source,
	// which is what the second path handles.
	const tableSchema = extractRowSourceTableSchema(filter.source);

	// Attribute id → base-table column, for every base column under the Filter. Both
	// paths need it: the multi-relation path to route a conjunct to a relation, and
	// both paths to identify a predicate's columns by identity rather than by name.
	//
	// NOTE: this walk covers the whole source subtree and this rule fires per
	// FilterNode, so a stack of N filters over one large subtree costs O(N·subtree) —
	// and unlike before, it now runs for EVERY Filter, not only filters over joins.
	// The walk is cheap per node and filter stacks are shallow; if it ever shows up in
	// optimizer profiles, either cache the map per pass on OptContext, or — for the
	// single-table path only — build the resolver from the one TableReferenceNode the
	// strict walk already found, which is O(columns) instead of O(subtree).
	const origins = collectColumnOrigins(filter.source);

	const sel = tableSchema
		? singleTableSelectivity(tableSchema, filter, origins, context)
		: multiRelationSelectivity(filter, origins, context);
	if (sel === undefined) return null;

	const clamped = Math.min(1, Math.max(0, sel));

	// Rebuild the identical Filter (same scope, source, predicate → same output
	// attribute ids) with only the added estimate — hence sideEffectMode 'safe'.
	return new FilterNode(filter.scope, filter.source, filter.predicate, undefined, clamped);
}

// ── Column identity ─────────────────────────────────────────────────────

/**
 * A resolver over `origins`, restricted to the origins `accept` allows.
 *
 * An attribute with no origin — or one belonging to a relation the caller is not
 * currently estimating — resolves to undefined, which the provider reads as "this
 * column has no statistics" rather than falling back to its AST name.
 */
function makeResolver(
	origins: ReadonlyMap<number, ColumnOrigin>,
	accept: (origin: ColumnOrigin) => boolean,
): ColumnStatsResolver {
	return (attributeId) => {
		const origin = origins.get(attributeId);
		return origin && accept(origin) ? origin.columnName : undefined;
	};
}

// ── Single-table path ───────────────────────────────────────────────────

function singleTableSelectivity(
	tableSchema: TableSchema,
	filter: FilterNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
	context: OptContext,
): number | undefined {
	// CatalogStatsProvider recurses over the predicate's boolean structure, so
	// `a = 1 and b = 2` combines the two per-column estimates rather than falling
	// back to a flat per-nodeType guess. It still returns undefined when it can say
	// nothing at all, in which case the naive heuristic applies as before.
	//
	// NOTE: this path is deliberately NOT gated on real statistics existing — it may
	// still stamp a NaiveStatsProvider number, as it always has. The multi-relation
	// path below IS gated; see the comment there for why the asymmetry is on purpose.
	//
	// Schema equality is the right narrowing here: the strict walk established that
	// exactly this table's rows arrive at the Filter, so any origin under it belongs
	// to that one reference anyway.
	const resolve = makeResolver(origins, origin => origin.table === tableSchema);
	const sel = context.stats.selectivity(tableSchema, filter.predicate, resolve);
	if (sel === undefined) return undefined;
	log('Filter over %s: stamping selectivity %f', tableSchema.name, sel);
	return sel;
}

// ── Multi-relation path ─────────────────────────────────────────────────

/**
 * Estimate a filter whose source spans several base tables by attributing each
 * conjunct to the relation(s) its columns come from.
 *
 * NOTE: join type is ignored. A `left`/`right`/`full` join emits NULL-extended
 * rows, which makes a predicate on the non-preserved side more selective than the
 * base-table fraction suggests and one on the preserved side less so. Applying the
 * base-table fraction either way is the conventional simplification, not an
 * oversight.
 *
 * NOTE: an `aggregate` between the Filter and the join forwards group-key attribute
 * ids unchanged, so a predicate on a group key is attributed to its base table and
 * the base-table fraction is applied to post-aggregate cardinality. Imprecise but
 * not unsound; deliberately not special-cased.
 *
 * NOTE: the stamped number is currently visible on `FilterNode.selectivity` but does
 * NOT yet move `estimatedRows` above a join: `JoinNode.computePhysical` derives its
 * own cardinality from its children's LOGICAL `estimatedRows`, and a physical access
 * node (SeqScan/IndexScan over a Retrieve) exposes none — so the join reports
 * undefined rows and the Filter has nothing to multiply. Tracked in backlog
 * `debt-join-rows-from-physical-children`; nothing here needs to change when it lands.
 */
function multiRelationSelectivity(
	filter: FilterNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
	context: OptContext,
): number | undefined {
	if (origins.size === 0) return undefined;

	const conjuncts = splitConjuncts(filter.predicate);
	const known: number[] = [];
	for (const conjunct of conjuncts) {
		const sel = estimateConjunct(conjunct, origins, context);
		if (sel !== undefined) known.push(sel);
	}
	// Nothing estimable → leave the Filter unstamped exactly as before this path existed.
	if (known.length === 0) return undefined;

	const combined = combineConjunctive(known);
	// countRelations walks the whole origin map; keep it off the hot path.
	if (log.enabled) {
		log('Filter over %d relations: %d/%d conjuncts estimated, stamping %f',
			countRelations(origins), known.length, conjuncts.length, combined);
	}
	return combined;
}

function countRelations(origins: ReadonlyMap<number, ColumnOrigin>): number {
	const refs = new Set<TableReferenceNode>();
	for (const origin of origins.values()) refs.add(origin.ref);
	return refs.size;
}

/** Estimate one conjunct, or undefined when it cannot be attributed / estimated. */
function estimateConjunct(
	conjunct: ScalarPlanNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
	context: OptContext,
): number | undefined {
	const refs = conjunctRelations(conjunct, origins);
	if (refs === undefined) return undefined;

	if (refs.size === 1) {
		const [ref] = refs;
		// Reference identity, not schema: `from t a join t b` gives two
		// TableReferenceNodes sharing one TableSchema, so schema equality would not
		// separate the sides. `conjunctRelations` has already established that this
		// conjunct touches exactly this one reference.
		const resolve = makeResolver(origins, origin => origin.ref === ref);
		return singleRelationConjunct(ref.tableSchema, conjunct, resolve, context);
	}
	if (refs.size === 2) {
		return crossRelationConjunct(conjunct, origins, context);
	}
	// Three or more relations in one conjunct: no model for it here.
	return undefined;
}

/**
 * The distinct relations a conjunct's column references come from.
 *
 * Returns undefined when the conjunct references no column at all, or references
 * any attribute that is not a base-table column (a computed projection, an
 * aggregate output, a join existence flag, a set-operation output, a column of a
 * table inside a scalar subquery) — in either case there are no statistics to
 * consult.
 */
function conjunctRelations(
	conjunct: ScalarPlanNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
): Set<TableReferenceNode> | undefined {
	const refs = new Set<TableReferenceNode>();
	const stack: PlanNode[] = [conjunct];

	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode) {
			const origin = origins.get(n.attributeId);
			if (!origin) return undefined;
			refs.add(origin.ref);
			continue;
		}
		for (const child of n.getChildren()) stack.push(child);
	}

	return refs.size > 0 ? refs : undefined;
}

/**
 * A conjunct over exactly one relation: hand it to the provider as if it were a
 * single-table predicate.
 *
 * `statsOnlySelectivity` — not `selectivity` — IS the statistics gate. `selectivity`
 * always returns a number (CatalogStatsProvider falls through to NaiveStatsProvider,
 * which answers a flat 0.1 for any BinaryOp), so using it here would replace 0.5 with
 * 0.1 on essentially every filter-over-join in the codebase — including the many tests
 * that never run ANALYZE — churning plan shapes with no information behind the change.
 * It also covers the subtler case of an analyzed table with a predicate the catalog
 * cannot read (`lower(o.cat) = 'x'`), which a column-stats-presence check would let
 * through. A provider that does not implement it is treated as having no statistics.
 */
function singleRelationConjunct(
	table: TableSchema,
	conjunct: ScalarPlanNode,
	resolve: ColumnStatsResolver,
	context: OptContext,
): number | undefined {
	return context.stats.statsOnlySelectivity?.(table, conjunct, resolve);
}

function hasColumnStats(origin: ColumnOrigin): boolean {
	return origin.table.statistics?.columnStats.has(origin.columnName.toLowerCase()) ?? false;
}

/**
 * A conjunct comparing a column of one relation to a column of another
 * (`o.qty > l.qty`, `a.id = b.id`). Only a plain binary comparison with a bare
 * column reference on each side is modelled; anything else is unknown.
 *
 * Gated on real column statistics for BOTH compared columns, for the same reason as
 * {@link singleRelationConjunct}: `joinSelectivity` falls back to
 * `NaiveStatsProvider`'s `1/max(rowCount)` whenever it cannot read a distinct count,
 * so table-level `statistics` being present is not enough on its own.
 */
function crossRelationConjunct(
	conjunct: ScalarPlanNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
	context: OptContext,
): number | undefined {
	if (!(conjunct instanceof BinaryOpNode)) return undefined;
	if (!(conjunct.left instanceof ColumnReferenceNode)) return undefined;
	if (!(conjunct.right instanceof ColumnReferenceNode)) return undefined;

	const leftOrigin = origins.get(conjunct.left.attributeId);
	const rightOrigin = origins.get(conjunct.right.attributeId);
	if (!leftOrigin || !rightOrigin) return undefined;
	if (!hasColumnStats(leftOrigin) || !hasColumnStats(rightOrigin)) return undefined;

	const op = conjunct.expression.operator;

	// Both origins were resolved and stats-checked by identity just above, so no
	// further narrowing is needed — the resolver only has to replace the AST names
	// with the base columns those two attributes actually are.
	const resolve = makeResolver(origins, () => true);

	if (op === '=' || op === '==') return equiJoinSelectivity(conjunct, leftOrigin, rightOrigin, resolve, context);

	// `extractEquiJoinColumns` accepts only `=`, so the catalog declines a `<>` and
	// `joinSelectivity` answers from NaiveStatsProvider, which is capped at 0.5. The
	// complement is therefore bounded to [0.5, 1] — it can only ever relax the
	// estimate relative to DEFAULT_FILTER_SELECTIVITY, and the true value for a
	// cross-relation `<>` is near 1, so the bound errs in the right direction.
	if (op === '!=' || op === '<>') {
		const eq = equiJoinSelectivity(conjunct, leftOrigin, rightOrigin, resolve, context);
		return eq === undefined ? undefined : 1 - eq;
	}

	if (op === '<' || op === '<=' || op === '>' || op === '>=') {
		return CROSS_RELATION_INEQUALITY_SELECTIVITY;
	}

	return undefined;
}

/**
 * Argument order matters: `CatalogStatsProvider.joinSelectivity` reads the column
 * pair off the condition's own child order (`extractEquiJoinColumns`) and
 * `fkPkSelectivity` interprets left/right against the tables it was handed. So the
 * table owning the conjunct's LEFT child must be passed first.
 */
function equiJoinSelectivity(
	conjunct: ScalarPlanNode,
	leftOrigin: ColumnOrigin,
	rightOrigin: ColumnOrigin,
	resolve: ColumnStatsResolver,
	context: OptContext,
): number | undefined {
	return context.stats.joinSelectivity?.(leftOrigin.table, rightOrigin.table, conjunct, resolve);
}
