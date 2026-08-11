/**
 * The one owner of the **relation key** — the label that names a single *read*
 * of a table inside a plan, as opposed to the table itself.
 *
 * Format: `` `<schema>.<table>#<nodeId>` ``, all lowercase — e.g. `main.orders#42`.
 * The `#<nodeId>` suffix is what makes it instance-unique: a self-join reads one
 * table twice and the two reads must be told apart.
 *
 * Every site that builds, parses, or matches that label goes through this module.
 * The recipe drifted three separate times when it was spelled by hand (a site that
 * forgot to lowercase silently widened every single-key equality select to a whole-
 * table scan), and the failure mode is always silent: two sites compute keys for the
 * same read, the strings differ, the lookup finds nothing, the feature degrades
 * quietly. Keeping one owner is what makes that class of drift impossible rather
 * than merely unlikely.
 *
 * This module is deliberately a **leaf**: its only imports are `planner/nodes/`, so
 * `core/`, `runtime/`, and `func/` can import it without dragging in the analysis
 * machinery, and `constraint-extractor.ts` can import it without a cycle through
 * `binding-extractor.ts`.
 */

import { PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';

/**
 * Instance-unique identity of one table read within a plan:
 * `` `<schema>.<table>#<nodeId>` ``, lowercased.
 *
 * A plain `string` alias — it documents intent at signature sites without rippling
 * into every `Map` type. Making it a type the compiler enforces is tracked
 * separately (`debt-relation-key-branded-type`).
 */
export type RelationKey = string;

/** One `TableReferenceNode` found in a plan, paired with the base table it reads. */
export interface PlanTableReference {
	/** The plan-node instance the reference was found at. */
	node: TableReferenceNode;
	/** Qualified base table name, lowercased `schema.table`. */
	base: string;
}

/** Suffix used when a node carries no id. Unreachable today (`PlanNode.id` is
 *  always assigned) but preserved so the key is never silently truncated. */
const UNKNOWN_NODE_ID = 'unknown';

/** Lowercased qualified base name (`schema.table`) for a table schema. */
export function relationBaseName(schema: { schemaName: string; name: string }): string {
	return `${schema.schemaName}.${schema.name}`.toLowerCase();
}

/**
 * Compose a key from an already-canonical (lowercased, qualified) base and a node id.
 * Prefer {@link relationKeyOf} where a `TableReferenceNode` is in hand.
 */
export function relationKeyFrom(base: string, nodeId: string | null | undefined): RelationKey {
	return `${base}#${nodeId ?? UNKNOWN_NODE_ID}`;
}

/** The key of a table reference — THE canonical entry point. */
export function relationKeyOf(ref: TableReferenceNode): RelationKey {
	return relationKeyFrom(relationBaseName(ref.tableSchema), ref.id);
}

/**
 * The key of an arbitrary relational node — the general case
 * {@link createTableInfoFromNode} needs.
 *
 * A `TableReferenceNode` always canonicalizes to {@link relationKeyOf}, regardless
 * of the display name the caller passed, so two callers naming the same read cannot
 * disagree. Anything else falls back to `displayName ?? node.toString()`, lowercased
 * — preserving today's behaviour for non-table relational nodes, which have no
 * schema-qualified name to canonicalize on.
 */
export function relationKeyOfRelation(node: RelationalPlanNode, displayName?: string): RelationKey {
	if (node instanceof TableReferenceNode) return relationKeyOf(node);
	const base = (displayName ?? node.toString()).toLowerCase();
	return relationKeyFrom(base, node.id);
}

/**
 * The base-table half of a key.
 *
 * Splits at the **last** `#`: a node id never contains `#`, but a quoted table name
 * legally can (`create table "we#ird"`), so splitting at the first `#` would truncate
 * the base. Returns the whole string when there is no `#` at all.
 */
export function relationKeyBase(key: RelationKey): string {
	const hash = key.lastIndexOf('#');
	return hash >= 0 ? key.slice(0, hash) : key;
}

/**
 * The same read, re-based onto `newBase` — what `ALTER TABLE … RENAME` propagation
 * needs. Round-trips with {@link relationKeyBase}.
 */
export function relationKeyWithBase(key: RelationKey, newBase: string): RelationKey {
	const hash = key.lastIndexOf('#');
	return hash >= 0 ? `${newBase}${key.slice(hash)}` : newBase;
}

/**
 * Whether `key` names the read at `nodeId`.
 *
 * Compares the id segment exactly rather than by string suffix, so id `42` does not
 * match `main.orders#142`.
 */
export function relationKeyHasNodeId(key: RelationKey, nodeId: string | null | undefined): boolean {
	const hash = key.lastIndexOf('#');
	if (hash < 0) return false;
	return key.slice(hash + 1) === (nodeId ?? UNKNOWN_NODE_ID);
}

/**
 * Every `TableReferenceNode` instance reachable from `plan`, keyed by relation key.
 *
 * The walk descends `getChildren()`, NOT `getRelations()`: a table reference under a
 * scalar subquery expression (`not exists (select … from t …)`, the shape almost
 * every assertion body has) hangs off a scalar child and is invisible to the
 * relational-only walk.
 *
 * Callers that care about reference *identity* — one entry per reference, two for a
 * self-join — must hand in a plan that has only been optimized for analysis
 * (`Optimizer.optimizeForAnalysis`). Full physical optimization leaves several
 * distinct `TableReferenceNode` instances per table, so the same table comes back
 * more than once under different node ids.
 */
export function collectTableReferences(plan: PlanNode): Map<RelationKey, PlanTableReference> {
	const out = new Map<RelationKey, PlanTableReference>();
	collectInto(plan, out);
	return out;
}

function collectInto(node: PlanNode, out: Map<RelationKey, PlanTableReference>): void {
	if (node instanceof TableReferenceNode) {
		out.set(relationKeyOf(node), { node, base: relationBaseName(node.tableSchema) });
	}
	for (const child of node.getChildren()) {
		collectInto(child as unknown as PlanNode, out);
	}
}
