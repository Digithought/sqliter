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
 * than borrowing `o.qty`'s because the alias happens to collide. A CTE reference
 * republishes its body's columns under per-reference relation instances, so a `with`
 * clause estimates like the equivalent subquery while the two arms of a CTE self-join
 * still count as two relations — see `column-origins.ts`.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { TableSchema } from '../../../schema/table.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractRowSourceTableSchema } from '../../util/key-utils.js';
import { collectColumnOrigins, type ColumnOrigin, type RelationInstance } from '../../util/column-origins.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import { combineConjunctive } from '../../stats/selectivity-combine.js';
import { estimateConjunctSelectivity, makeColumnStatsResolver } from '../../stats/conjunct-selectivity.js';

const log = createLogger('optimizer:rule:filter-selectivity');

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
	// `rule-filter-conjunct-ordering` (PostOptimization) runs the SAME walk again on
	// each Filter it ranks, so the walk now happens twice per Filter. The walk is
	// cheap per node and filter stacks are shallow; if it ever shows up in an
	// optimizer profile, memoize the map per pass on OptContext keyed by the source
	// node (or — for the single-table path only — build the resolver from the one
	// TableReferenceNode the strict walk already found, O(columns) not O(subtree)).
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
	const resolve = makeColumnStatsResolver(origins, origin => origin.table === tableSchema);
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
 * NOTE: the stamped number does move `estimatedRows` above a join — the join family
 * derives its physical cardinality from its children's PHYSICAL counts
 * (`physicalSourceRows` / `joinPhysicalRows`), so a Filter over a join has a real
 * number to multiply. It still has nothing to multiply above a `union`/`union all`,
 * where `SetOperationNode` stamps no count at all (backlog
 * `debt-row-estimates-die-at-set-operations`).
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
		const sel = estimateConjunctSelectivity(conjunct, origins, context);
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
	const relations = new Set<RelationInstance>();
	for (const origin of origins.values()) relations.add(origin.relation);
	return relations.size;
}
