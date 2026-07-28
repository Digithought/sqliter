/**
 * Rule: Filter Selectivity
 *
 * Stamps a stats-derived selectivity onto a FilterNode so its `estimatedRows`
 * reflects real column statistics instead of the flat DEFAULT_FILTER_SELECTIVITY.
 *
 * Runs in the Physical pass (bottom-up), which fires AFTER the Structural pass —
 * predicate-pushdown / grow-retrieve have already put the Filter in its final
 * position over its final source, so the source subtree is settled (and may carry
 * physical access nodes between the join and its table references).
 *
 * Node-level accessors (`estimatedRows` / `computePhysical`) carry no OptContext,
 * so a Filter cannot consult `context.stats` from inside itself. This rule holds
 * the context, does the lookup, and mints a stamped Filter — the estimate then
 * flows through `estimatedRows` automatically.
 *
 * Two paths:
 *   - **single-table** — `extractTableSchema` finds one base table under the
 *     Filter; hand the whole predicate to the provider, which decomposes its
 *     boolean structure itself.
 *   - **multi-relation** — the source spans several tables (a join). Split the
 *     predicate into conjuncts, attribute each to the base table(s) its columns
 *     come from, estimate per conjunct, and combine.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { TableSchema } from '../../../schema/table.js';
import { FilterNode } from '../../nodes/filter.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, type TableReferenceNode } from '../../nodes/reference.js';
import { extractTableSchema } from '../../util/key-utils.js';
import { collectColumnOrigins, type ColumnOrigin } from '../../util/column-origins.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import { combineConjunctive } from '../../stats/selectivity-combine.js';

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

	// extractTableSchema walks single-child wrappers (Filter/Project/Sort/Retrieve/
	// TableReference) to the base table. It returns undefined for a join / other
	// multi-relation source, which is what the second path handles.
	const tableSchema = extractTableSchema(filter.source);
	const sel = tableSchema
		? singleTableSelectivity(tableSchema, filter, context)
		: multiRelationSelectivity(filter, context);
	if (sel === undefined) return null;

	const clamped = Math.min(1, Math.max(0, sel));

	// Rebuild the identical Filter (same scope, source, predicate → same output
	// attribute ids) with only the added estimate — hence sideEffectMode 'safe'.
	return new FilterNode(filter.scope, filter.source, filter.predicate, undefined, clamped);
}

// ── Single-table path ───────────────────────────────────────────────────

function singleTableSelectivity(
	tableSchema: TableSchema,
	filter: FilterNode,
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
	const sel = context.stats.selectivity(tableSchema, filter.predicate);
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
 *
 * NOTE: `collectColumnOrigins` walks the whole source subtree and this rule fires
 * per FilterNode, so a stack of N filters over one large subtree costs O(N·subtree).
 * Filters over joins are few and the walk is cheap per node; if this ever shows up
 * in optimizer profiles, compute the map once per pass and cache it on OptContext.
 */
function multiRelationSelectivity(filter: FilterNode, context: OptContext): number | undefined {
	const origins = collectColumnOrigins(filter.source);
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
	log('Filter over %d relations: %d/%d conjuncts estimated, stamping %f',
		countRelations(origins), known.length, conjuncts.length, combined);
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
	const byRelation = conjunctOrigins(conjunct, origins);
	if (byRelation === undefined) return undefined;

	if (byRelation.size === 1) {
		const [cols] = [...byRelation.values()];
		return singleRelationConjunct(cols, conjunct, context);
	}
	if (byRelation.size === 2) {
		return crossRelationConjunct(conjunct, origins, context);
	}
	// Three or more relations in one conjunct: no model for it here.
	return undefined;
}

/**
 * Group the conjunct's column references by originating relation.
 *
 * Returns undefined when the conjunct references no column at all, or references
 * any attribute that is not a base-table column (a computed projection, an
 * aggregate output, a join existence flag, a column of a table inside a scalar
 * subquery) — in either case there are no statistics to consult.
 */
function conjunctOrigins(
	conjunct: ScalarPlanNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
): Map<TableReferenceNode, ColumnOrigin[]> | undefined {
	const byRelation = new Map<TableReferenceNode, ColumnOrigin[]>();
	const stack: PlanNode[] = [conjunct];
	let sawColumn = false;

	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode) {
			sawColumn = true;
			const origin = origins.get(n.attributeId);
			if (!origin) return undefined;
			const cols = byRelation.get(origin.ref);
			if (cols) cols.push(origin); else byRelation.set(origin.ref, [origin]);
			continue;
		}
		for (const child of n.getChildren()) stack.push(child);
	}

	return sawColumn ? byRelation : undefined;
}

/**
 * A conjunct over exactly one relation: hand it to the provider as if it were a
 * single-table predicate.
 *
 * Gated on real column statistics. `context.stats.selectivity` ALWAYS returns a
 * number for a stats-less table (CatalogStatsProvider falls through to
 * NaiveStatsProvider, which answers 0.1 for any BinaryOp), so without this gate the
 * rule would replace 0.5 with 0.1 on essentially every filter-over-join in the
 * codebase — including the many tests that never run ANALYZE — churning plan shapes
 * with no actual information behind the change.
 */
function singleRelationConjunct(
	cols: readonly ColumnOrigin[],
	conjunct: ScalarPlanNode,
	context: OptContext,
): number | undefined {
	if (!cols.every(hasColumnStats)) return undefined;
	return context.stats.selectivity(cols[0].table, conjunct);
}

function hasColumnStats(origin: ColumnOrigin): boolean {
	return origin.table.statistics?.columnStats.has(origin.columnName.toLowerCase()) ?? false;
}

/**
 * A conjunct comparing a column of one relation to a column of another
 * (`o.qty > l.qty`, `a.id = b.id`). Only a plain binary comparison with a bare
 * column reference on each side is modelled; anything else is unknown.
 *
 * Gated on both tables carrying real statistics, for the same reason as
 * {@link singleRelationConjunct}.
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
	if (!leftOrigin.table.statistics || !rightOrigin.table.statistics) return undefined;

	const op = conjunct.expression.operator;

	if (op === '=' || op === '==') return equiJoinSelectivity(conjunct, leftOrigin, rightOrigin, context);

	if (op === '!=' || op === '<>') {
		const eq = equiJoinSelectivity(conjunct, leftOrigin, rightOrigin, context);
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
	context: OptContext,
): number | undefined {
	return context.stats.joinSelectivity?.(leftOrigin.table, rightOrigin.table, conjunct);
}
