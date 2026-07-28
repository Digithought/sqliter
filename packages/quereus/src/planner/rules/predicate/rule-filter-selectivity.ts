/**
 * Rule: Filter Selectivity
 *
 * Stamps a stats-derived selectivity onto a FilterNode so its `estimatedRows`
 * reflects real column statistics instead of the flat DEFAULT_FILTER_SELECTIVITY.
 *
 * Runs in the Physical pass (bottom-up), which fires AFTER the Structural pass —
 * predicate-pushdown / grow-retrieve have already put the Filter in its final
 * position over its final source, so `extractTableSchema` sees the settled tree.
 *
 * Node-level accessors (`estimatedRows` / `computePhysical`) carry no OptContext,
 * so a Filter cannot consult `context.stats` from inside itself. This rule holds
 * the context, does the lookup, and mints a stamped Filter — the estimate then
 * flows through `estimatedRows` automatically.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractTableSchema } from '../../util/key-utils.js';

const log = createLogger('optimizer:rule:filter-selectivity');

export function ruleFilterSelectivity(node: PlanNode, context: OptContext): PlanNode | null {
	const filter = node as FilterNode;

	// Idempotent: a prior fire already stamped this Filter → decline. (The pass
	// engine also suppresses re-offering a rule its own output, but this guard
	// makes the rule safe on any already-stamped node regardless.)
	if (filter.selectivity !== undefined) return null;

	// extractTableSchema walks single-child wrappers (Filter/Project/Sort/Retrieve/
	// TableReference) to the base table. It returns undefined for a join / other
	// multi-table source — leave the default 0.5 there (multi-column / join
	// selectivity is parked in backlog feat-conjunction-and-join-selectivity).
	const tableSchema = extractTableSchema(filter.source);
	if (!tableSchema) return null;

	// CatalogStatsProvider recurses over the predicate's boolean structure, so
	// `a = 1 and b = 2` combines the two per-column estimates rather than falling
	// back to a flat per-nodeType guess. It still returns undefined when it can say
	// nothing at all, in which case the naive heuristic applies as before.
	const sel = context.stats.selectivity(tableSchema, filter.predicate);
	if (sel === undefined) return null;

	const clamped = Math.min(1, Math.max(0, sel));
	log('Filter over %s: stamping selectivity %f', tableSchema.name, clamped);

	// Rebuild the identical Filter (same scope, source, predicate → same output
	// attribute ids) with only the added estimate — hence sideEffectMode 'safe'.
	return new FilterNode(filter.scope, filter.source, filter.predicate, undefined, clamped);
}
