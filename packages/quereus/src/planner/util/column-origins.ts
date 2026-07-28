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
 *
 * ## Row-merging operators are opaque
 *
 * A set operation and a recursive CTE both *forward* their left / base-case branch's
 * attribute ids (see `analysis/attribute-provenance.ts`), but the rows behind those
 * ids come from every branch. `union all` of a 4-distinct-value column with a
 * 1000-distinct-value one publishes the left branch's id while carrying both
 * distributions, so attributing it to the left base table alone would hand the
 * caller one branch's statistics as if they described the whole relation. The walk
 * therefore stops at such a node and records nothing beneath it — a conjunct over a
 * union reads as unknown, exactly like one over a computed projection.
 */

import { TableReferenceNode } from '../nodes/reference.js';
import { SetOperationNode } from '../nodes/set-operation-node.js';
import { RecursiveCTENode } from '../nodes/recursive-cte-node.js';
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
 * the map and any conjunct referencing them reads as unknown. It also stops at a
 * row-merging operator (see the file doc-comment).
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
		if (isRowMerging(n)) continue;
		for (const rel of n.getRelations()) stack.push(rel);
	}

	return origins;
}

/**
 * Does this node publish one branch's attribute ids over rows drawn from several
 * branches? Such an id describes no single base-table column.
 */
function isRowMerging(node: RelationalPlanNode): boolean {
	return node instanceof SetOperationNode || node instanceof RecursiveCTENode;
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
