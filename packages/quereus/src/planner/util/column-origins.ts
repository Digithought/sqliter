/**
 * Column origin attribution.
 *
 * Maps every output attribute id reachable under a relational subtree back to the
 * base-table column that minted it. `rule-filter-selectivity` uses this to route
 * each conjunct of a filter-over-join predicate to the statistics of the table its
 * columns actually come from, instead of declining the whole filter because its
 * source spans more than one table.
 *
 * ## Identity — not schema — distinguishes the two sides of a self-join
 *
 * `ColumnOrigin.ref` is the `TableReferenceNode` instance that produced the
 * attribute. `from t a join t b` yields two distinct TableReferenceNodes sharing
 * ONE `TableSchema` object, so a caller asking "how many relations does this
 * expression touch?" must key on `ref` identity. Keying on `table` collapses the
 * two sides and mis-classifies `a.age > b.age` as a single-table predicate
 * comparing a column to a constant.
 *
 * ## Attributes minted above a base table are deliberately absent
 *
 * Computed projections, aggregate outputs, `values` rows and join existence flags
 * never appear in the map. A predicate over one of them has no base-table column
 * statistics to consult, so the caller must treat it as unknown rather than
 * mis-attribute it by column name.
 */

import { TableReferenceNode } from '../nodes/reference.js';
import type { PlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';

/** Where a single attribute came from: a column of a specific base-table reference. */
export interface ColumnOrigin {
	/** The TableReferenceNode that minted this attribute — identity is significant. */
	readonly ref: TableReferenceNode;
	readonly table: TableSchema;
	readonly columnIndex: number;
	readonly columnName: string;
}

/**
 * Attribute id → originating base-table column, for every base column reachable
 * under `node` via `getRelations()`.
 *
 * The walk descends relations only, so scalar subqueries hanging off a join
 * condition or a filter predicate are NOT traversed — their columns stay out of
 * the map and any conjunct referencing them reads as unknown.
 */
export function collectColumnOrigins(node: RelationalPlanNode): Map<number, ColumnOrigin> {
	const origins = new Map<number, ColumnOrigin>();
	// Plan trees are DAGs (a CTE instance can be shared), so dedupe by identity.
	const visited = new Set<PlanNode>();
	const stack: RelationalPlanNode[] = [node];

	while (stack.length > 0) {
		const n = stack.pop()!;
		if (visited.has(n)) continue;
		visited.add(n);

		if (n instanceof TableReferenceNode) {
			addBaseColumns(n, origins);
			continue;
		}
		for (const rel of n.getRelations()) stack.push(rel);
	}

	return origins;
}

/** Zip a table reference's attributes with its schema columns (1:1 by construction). */
function addBaseColumns(ref: TableReferenceNode, out: Map<number, ColumnOrigin>): void {
	// TableReferenceNode builds its attributes by mapping `tableSchema.columns`
	// positionally (see reference.ts), so index i describes the same column in both
	// lists — the same zip `computePhysical` uses to seed update lineage.
	const attrs = ref.getAttributes();
	ref.tableSchema.columns.forEach((col, i) => {
		const attr = attrs[i];
		if (!attr) return;
		out.set(attr.id, { ref, table: ref.tableSchema, columnIndex: i, columnName: col.name });
	});
}
