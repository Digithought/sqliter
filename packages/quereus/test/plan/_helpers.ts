import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { safeJsonStringify } from '../../src/util/serialization.js';

export interface PlanRow {
	id: number;
	parent_id: number | null;
	op: string;
	node_type: string;
	detail: string;
	object_name: string | null;
}

export async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		"SELECT id, parent_id, op, node_type, detail, object_name FROM query_plan(?)", [sql]
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

export async function planOps(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const r of db.eval("SELECT op FROM query_plan(?)", [sql])) {
		ops.push((r as { op: string }).op);
	}
	return ops;
}

export async function planNodeTypes(db: Database, sql: string): Promise<string[]> {
	const types: string[] = [];
	for await (const r of db.eval("SELECT node_type FROM query_plan(?)", [sql])) {
		types.push((r as { node_type: string }).node_type);
	}
	return types;
}

export async function allRows<T>(db: Database, sql: string): Promise<T[]> {
	const rows: T[] = [];
	for await (const r of db.eval(sql)) rows.push(r as T);
	return rows;
}

export function isDescendantOf(rows: PlanRow[], childId: number, ancestorId: number): boolean {
	let current = childId;
	const visited = new Set<number>();
	while (true) {
		if (visited.has(current)) return false;
		visited.add(current);
		const row = rows.find(r => r.id === current);
		if (!row || row.parent_id === null) return false;
		if (row.parent_id === ancestorId) return true;
		current = row.parent_id;
	}
}

/**
 * View onto PlanNode's process-global id counters. They are `private static` in
 * production; the golden harness reaches in (test-only) so every snapshot is
 * planned from a fixed id base. Without this, node ids and — more importantly —
 * attribute ids are offset by however many ids earlier tests in the same process
 * allocated, so a golden generated in isolation would never match when
 * golden-plans.spec runs inside the full `yarn test` suite.
 */
const planNodeIdCounters = PlanNode as unknown as { nextId: number; nextAttributeId: number };

/**
 * Run `fn` with the global PlanNode id counters reset to 0, restoring them to the
 * high-water mark afterward so any plan nodes still live outside `fn` keep unique
 * ids. Async because schema setup (`db.exec`) allocates ids before planning; the
 * Mocha runner is serial, so no other work allocates ids during the awaited gaps.
 */
export async function withDeterministicPlanIds<T>(fn: () => Promise<T>): Promise<T> {
	const savedId = planNodeIdCounters.nextId;
	const savedAttr = planNodeIdCounters.nextAttributeId;
	planNodeIdCounters.nextId = 0;
	planNodeIdCounters.nextAttributeId = 0;
	try {
		return await fn();
	} finally {
		planNodeIdCounters.nextId = Math.max(savedId, planNodeIdCounters.nextId);
		planNodeIdCounters.nextAttributeId = Math.max(savedAttr, planNodeIdCounters.nextAttributeId);
	}
}

/** One serialized plan-tree node in a golden snapshot. */
export interface SerializedPlanNode {
	nodeType: string;
	op: string;
	detail: string;
	logical: Record<string, unknown>;
	physical: unknown;
	children: SerializedPlanNode[];
}

/**
 * The default `PlanNode.toString()` embeds the node's global, monotonically
 * increasing id as a ` [<n>]` suffix (and some overrides reference `#<n>`). That
 * counter is never reset per-database, so the same query planned in an isolated
 * spec run versus a full `yarn test` run yields different absolute ids. Strip
 * any such id token from the human-readable detail so goldens stay stable.
 */
function stripNodeIds(detail: string): string {
	return detail.replace(/ \[\d+\]/g, '').replace(/#\d+/g, '');
}

/**
 * Build the plain-object snapshot for a single node. Deliberately captures only
 * shape + logical + physical — never `estimatedCost` / `getTotalCost()` / the
 * node's logical `estimatedRows` getter / the node `id`, all of which churn on
 * unrelated optimizer or statistics changes. This mirrors the EXPLAIN /
 * `query_plan()` surface (node_type / op / detail / properties / physical) rather
 * than the cost-laden `serializePlanTree` debug view.
 *
 * `physical.estimatedRows` IS captured — it is part of the physical-properties
 * surface EXPLAIN exposes, so a change in cardinality propagation shows up here.
 * The golden corpus never runs `ANALYZE`, so those numbers stay stable.
 */
function buildSerializedNode(node: PlanNode): SerializedPlanNode {
	return {
		nodeType: node.nodeType,
		op: node.nodeType.replace(/Node$/, '').toUpperCase(),
		detail: stripNodeIds(node.toString()),
		logical: node.getLogicalAttributes(),
		// `physical` is a lazy getter that always returns a value; the `?? null`
		// is defensive only.
		physical: node.physical ?? null,
		children: node.getChildren().map(buildSerializedNode),
	};
}

/**
 * Normalize a snapshot object for deterministic, diff-friendly output:
 *  - sort plain-object keys (insertion order is not load-bearing here),
 *  - defensively drop unstable `id` / `timestamp` keys,
 *  - pass `Map` / `Uint8Array` through untouched so `safeJsonStringify` renders
 *    them via its bounded `$map` / hex summaries (recursing into a `Map` would
 *    otherwise collapse it to `{}` before the replacer ever sees it).
 */
function normalizeSnapshot(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Map || value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return value.map(normalizeSnapshot);

	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		if (key === 'id' || key === 'timestamp') continue;
		out[key] = normalizeSnapshot(source[key]);
	}
	return out;
}

/**
 * Serialize an (optimized) plan tree to the canonical golden-snapshot string.
 * `Map`-valued physical/logical properties render as the bounded `{$map, size}`
 * summary that EXPLAIN and `query_plan()` emit, so the golden corpus tracks the
 * real physical-properties surface. Output is terminated with a trailing newline
 * for clean diffs.
 */
export function serializePlanForGolden(node: PlanNode): string {
	const tree = normalizeSnapshot(buildSerializedNode(node));
	return safeJsonStringify(tree, 2) + '\n';
}
