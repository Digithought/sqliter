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
 * `ColumnOrigin.relation` is an opaque token standing for ONE instance of a relation
 * in the plan. `from t a join t b` yields two distinct TableReferenceNodes sharing
 * ONE `TableSchema` object, so a caller asking "how many relations does this
 * expression touch?" must key on `relation` identity. Keying on `table` collapses the
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
 *
 * `rule-async-gather-union-all` rewrites a unionAll set operation into an
 * `AsyncGatherNode` that forwards the same ids, so `isRowMerging` recognises that
 * gather too — see `row-population.ts`.
 *
 * ## A CTE reference republishes its body's columns under its own relation instance
 *
 * `CTEReferenceNode` mints FRESH attribute ids for every column it republishes
 * (`cte-reference-node.ts`), so the walk cannot simply descend through it: nothing
 * above would land in the map. It instead maps the body's origins positionally onto
 * the reference's own ids — but under a relation token minted PER REFERENCE, because
 * two references to one `with` clause share a single body subtree. Pairing them with
 * the body's own relation tokens would make both arms of a CTE self-join the same
 * relation, and `rule-filter-selectivity` would read `a.qty > b.qty` as a
 * single-relation predicate comparing a column to a constant.
 */

import { TableReferenceNode } from '../nodes/reference.js';
import { CTEReferenceNode } from '../nodes/cte-reference-node.js';
import { isRowMerging } from './row-population.js';
import type { PlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';

/**
 * Identity of one *instance* of a relation in the plan — compared by reference and
 * never dereferenced. A `TableReferenceNode` is its own instance; a CTE reference
 * mints one per (reference, underlying relation) pair so that two references to the
 * same `with` clause stay distinguishable.
 */
export type RelationInstance = object;

/** Where a single attribute came from: a column of a specific relation instance. */
export interface ColumnOrigin {
	/** The relation instance that published this attribute — identity is significant. */
	readonly relation: RelationInstance;
	readonly table: TableSchema;
	readonly columnIndex: number;
	readonly columnName: string;
}

/** A CTE body's origin map, memoized so a CTE referenced N times is walked once. */
type BodyOriginCache = Map<PlanNode, ReadonlyMap<number, ColumnOrigin>>;

/**
 * Attribute id → originating base-table column, for every base column reachable
 * under `node` via `getRelations()`.
 *
 * The walk descends relations only, so scalar subqueries hanging off a join
 * condition or a filter predicate are NOT traversed — their columns stay out of
 * the map and any conjunct referencing them reads as unknown. It also stops at a
 * row-merging operator and at a CTE reference (see the file doc-comment).
 */
export function collectColumnOrigins(node: RelationalPlanNode): Map<number, ColumnOrigin> {
	return collect(node, new Map());
}

function collect(node: RelationalPlanNode, bodies: BodyOriginCache): Map<number, ColumnOrigin> {
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
		if (n instanceof CTEReferenceNode) {
			// Deliberately NOT descended: the body publishes ids this node does not
			// expose, and the body may be shared with a sibling reference.
			addCTEColumns(n, origins, bodies);
			continue;
		}
		if (isRowMerging(n)) continue;
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
		out.set(attr.id, { relation: ref, table: ref.tableSchema, columnIndex: i, columnName: col.name });
	});
}

/**
 * Re-publish a CTE body's origins under this reference's own attribute ids and its
 * own relation instances.
 *
 * `CTEReferenceNode.buildAttributes` maps `CTENode.getAttributes()` one for one and
 * `CTENode` forwards its source's attribute ids verbatim, so index i names the same
 * column on both sides. Columns the body computed (or could not attribute) simply
 * have no entry, exactly as for the equivalent inline subquery.
 */
function addCTEColumns(ref: CTEReferenceNode, out: Map<number, ColumnOrigin>, bodies: BodyOriginCache): void {
	const body = ref.source;
	// A recursive CTE's rows come from its base case AND its recursive case, so no
	// base-table column describes them — same reasoning as a set operation.
	if (isRowMerging(body)) return;

	const bodyOrigins = bodyOriginsOf(body, bodies);
	if (bodyOrigins.size === 0) return;

	// One fresh instance per underlying relation, minted for THIS reference: two
	// references to one CTE must never share an instance.
	const instances = new Map<RelationInstance, RelationInstance>();
	const bodyAttrs = body.getAttributes();
	ref.getAttributes().forEach((attr, i) => {
		const bodyAttr = bodyAttrs[i];
		const origin = bodyAttr && bodyOrigins.get(bodyAttr.id);
		if (!origin) return;
		let instance = instances.get(origin.relation);
		if (!instance) {
			instance = {};
			instances.set(origin.relation, instance);
		}
		out.set(attr.id, { ...origin, relation: instance });
	});
}

function bodyOriginsOf(body: RelationalPlanNode, bodies: BodyOriginCache): ReadonlyMap<number, ColumnOrigin> {
	const cached = bodies.get(body);
	if (cached) return cached;
	const computed = collect(body, bodies);
	bodies.set(body, computed);
	return computed;
}
