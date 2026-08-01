/**
 * Per-conjunct selectivity estimation shared by `rule-filter-selectivity`
 * (which folds the estimates into one stamped number) and
 * `rule-filter-conjunct-ordering` (which ranks conjuncts individually).
 * Extracted verbatim from the former so the two cannot drift.
 *
 * Everything here is gated on REAL statistics: a single-relation conjunct goes
 * through `statsOnlySelectivity` (never `selectivity`, whose NaiveStatsProvider
 * fallback fabricates a per-nodeType guess), and a cross-relation conjunct
 * requires `columnStats` for both compared columns. Undefined always means
 * "no real statistics answered", never "here is a guess".
 *
 * Do NOT re-export this module from `stats/index.ts`: `framework/context.ts`
 * imports `stats/index.ts`, and this module type-imports `OptContext` from
 * `framework/context.ts`, so a barrel re-export would create an import cycle
 * (mirroring the same note on `cost/conjunct-cost.ts`).
 *
 * NOTE: a CORRELATED subquery conjunct (`exists (select … where i.oid = o.id)`)
 * can resolve an outer attribute id through `conjunctRelations` — the walk
 * descends relational children — and come back with a base-column estimate that
 * describes the OUTER column rather than the subquery's result. Pre-existing in
 * the stamping path, and bounded in the ordering path because the cost tier is
 * the primary sort key: such a conjunct is `Subquery` tier, so a bogus estimate
 * can only reorder it against other `Subquery`-tier conjuncts, never lift it
 * ahead of a `Pure` one.
 */

import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import type { OptContext } from '../framework/context.js';
import type { TableSchema } from '../../schema/table.js';
import { BinaryOpNode } from '../nodes/scalar.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type { ColumnOrigin, RelationInstance } from '../util/column-origins.js';
import type { ColumnStatsResolver } from './index.js';

/**
 * Selectivity of an inequality (`<` `<=` `>` `>=`) comparing a column of one table
 * to a column of another. The standard uniform-distribution estimate for a
 * two-sided inequality is 1/3: there is no cross-table histogram, so nothing
 * better than the uniform assumption is available here.
 */
export const CROSS_RELATION_INEQUALITY_SELECTIVITY = 1 / 3;

/**
 * A resolver over `origins`, restricted to the origins `accept` allows.
 *
 * An attribute with no origin — or one belonging to a relation the caller is not
 * currently estimating — resolves to undefined, which the provider reads as "this
 * column has no statistics" rather than falling back to its AST name.
 */
export function makeColumnStatsResolver(
	origins: ReadonlyMap<number, ColumnOrigin>,
	accept: (origin: ColumnOrigin) => boolean,
): ColumnStatsResolver {
	return (attributeId) => {
		const origin = origins.get(attributeId);
		return origin && accept(origin) ? origin.columnName : undefined;
	};
}

/** Estimate one conjunct, or undefined when it cannot be attributed / estimated. */
export function estimateConjunctSelectivity(
	conjunct: ScalarPlanNode,
	origins: ReadonlyMap<number, ColumnOrigin>,
	context: OptContext,
): number | undefined {
	const relations = conjunctRelations(conjunct, origins);
	if (relations === undefined) return undefined;

	if (relations.size === 1) {
		const [[relation, table]] = relations;
		// Relation-instance identity, not schema: `from t a join t b` gives two
		// instances sharing one TableSchema, so schema equality would not separate the
		// sides. `conjunctRelations` has already established that this conjunct touches
		// exactly this one instance.
		const resolve = makeColumnStatsResolver(origins, origin => origin.relation === relation);
		return singleRelationConjunct(table, conjunct, resolve, context);
	}
	if (relations.size === 2) {
		return crossRelationConjunct(conjunct, origins, context);
	}
	// Three or more relations in one conjunct: no model for it here.
	return undefined;
}

/**
 * The distinct relation instances a conjunct's column references come from, each
 * mapped to the schema whose statistics describe it.
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
): Map<RelationInstance, TableSchema> | undefined {
	const relations = new Map<RelationInstance, TableSchema>();
	const stack: PlanNode[] = [conjunct];

	while (stack.length > 0) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode) {
			const origin = origins.get(n.attributeId);
			if (!origin) return undefined;
			relations.set(origin.relation, origin.table);
			continue;
		}
		for (const child of n.getChildren()) stack.push(child);
	}

	return relations.size > 0 ? relations : undefined;
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
	const resolve = makeColumnStatsResolver(origins, () => true);

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
