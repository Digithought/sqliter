/**
 * Binding-key extraction for incremental delta planning.
 *
 * Wraps `analyzeRowSpecific` and packages its per-relation classifications
 * into a `BindingMode` per `TableReferenceNode` instance. The shape is
 * consumer-neutral — assertions, materialized views, and any other change-
 * driven consumer can register a `DeltaSubscription` against the same
 * `PlanBindings`.
 *
 * - 'row' bindings carry the unique-key columns to bind on (PK preferred,
 *   else the lex-min covered key under FD closure).
 * - 'group' bindings carry the minimal GROUP BY columns recovered from
 *   `analyzeRowSpecific.groupKeys`.
 * - 'global' bindings carry no extra metadata — the consumer evaluates its
 *   plan once for any dependency change.
 *
 * Also the home of {@link collectTableReferences}, the plan walk `extractBindings`
 * is built on — exported because any consumer asking "which base tables does this
 * plan read" must get the same answer this one does, keyed the same way.
 */

import { PlanNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { analyzeRowSpecific, extractCoveredKeysForTable } from './constraint-extractor.js';

/**
 * The way one plan instance binds to its changes.
 *
 * - `'global'`: the plan re-runs once when any dependency table changes.
 * - `'row'`: the plan binds on `keyColumns` (output-column indices on the
 *   table reference). Consumers parameterize per changed PK tuple.
 * - `'group'`: the plan binds on `groupColumns` (output-column indices on
 *   the table reference). Consumers parameterize per changed group-key
 *   tuple, including OLD and NEW projections when group membership shifts.
 */
export type BindingMode =
	| { kind: 'global' }
	| { kind: 'row'; keyColumns: number[] }
	| { kind: 'group'; groupColumns: number[] };

/**
 * One `TableReferenceNode` instance found in a plan, paired with the base
 * table it reads.
 */
export interface PlanTableReference {
	/** The plan-node instance the reference was found at. */
	node: TableReferenceNode;
	/** Qualified base table name, lowercased `schema.table`. */
	base: string;
}

/**
 * Per-`TableReferenceNode` binding info for a plan, plus a quick lookup
 * from `relationKey` to the qualified base table name (lowercased).
 */
export interface PlanBindings {
	/** For each TableReference instance in the plan, how this plan is bound to its changes. */
	perRelation: Map<string /* relationKey */, BindingMode>;
	/** Convenience: relationKey → base table name (lowercased `schema.table`). */
	relationToBase: Map<string, string>;
}

/**
 * Walk a plan and emit the per-`TableReferenceNode` binding modes the runtime
 * needs to parameterize a delta-driven consumer over the same plan.
 *
 * The selection rule for `'row'` matches what the assertion path already
 * picks: prefer the primary key when it's covered, else fall back to the
 * first covered unique key (lex-min by column index). For `'group'`,
 * `groupKeys.get(relKey)` from `analyzeRowSpecific` is copied through
 * verbatim — already in the table reference's output-column space.
 */
export function extractBindings(plan: PlanNode | RelationalPlanNode): PlanBindings {
	const { classifications, groupKeys } = analyzeRowSpecific(plan);

	const perRelation = new Map<string, BindingMode>();
	const relationToBase = new Map<string, string>();

	const tableRefs = collectTableReferences(plan as PlanNode);
	for (const [relKey, ref] of tableRefs) {
		relationToBase.set(relKey, ref.base);
	}

	for (const [relKey, classification] of classifications) {
		if (classification === 'global') {
			perRelation.set(relKey, { kind: 'global' });
			continue;
		}
		if (classification === 'group') {
			const groupColumns = groupKeys.get(relKey);
			if (groupColumns && groupColumns.length > 0) {
				perRelation.set(relKey, { kind: 'group', groupColumns: [...groupColumns] });
			} else {
				// Should not happen — analyzeRowSpecific guarantees groupKeys
				// for every 'group' classification. Fall back to global so
				// the consumer doesn't silently bind on nothing.
				perRelation.set(relKey, { kind: 'global' });
			}
			continue;
		}
		// 'row': pick the same key the assertion path picks today: PK first,
		// else first covered unique key.
		const tableRef = tableRefs.get(relKey)?.node;
		if (!tableRef) {
			perRelation.set(relKey, { kind: 'global' });
			continue;
		}
		const pkIndices = tableRef.tableSchema.primaryKeyDefinition.map(d => d.index);
		const covered = extractCoveredKeysForTable(plan as RelationalPlanNode, relKey);
		if (covered.length === 0) {
			// Classification said 'row' but nothing is covered — defensive fallback.
			perRelation.set(relKey, { kind: 'global' });
			continue;
		}
		// `chooseRowKey` may legitimately return the empty key `[]` when the
		// reference is provably ≤1-row (keysOf yielded the empty key, which sorts
		// first by length). An empty `keyColumns` means "≤1 row, no key filter
		// needed" — downstream consumers treat it as a sound full/global scan.
		const chosen = chooseRowKey(pkIndices, covered);
		perRelation.set(relKey, { kind: 'row', keyColumns: chosen });
	}

	return { perRelation, relationToBase };
}

/** Choose the key for a 'row' binding: PK if it's among covered, else
 *  the lex-min covered key (sort by length, then by joined indices). */
function chooseRowKey(pkIndices: number[], coveredKeys: readonly number[][]): number[] {
	if (coveredKeys.length === 0) return [];
	if (pkIndices.length > 0) {
		const pkKey = [...pkIndices].sort((a, b) => a - b).join(',');
		for (const k of coveredKeys) {
			if ([...k].sort((a, b) => a - b).join(',') === pkKey) return [...pkIndices];
		}
	}
	// Lex-min covered key for determinism: shortest first, then lexicographic
	// by column indices.
	const sorted = [...coveredKeys].map(k => [...k]).sort((a, b) => {
		if (a.length !== b.length) return a.length - b.length;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return a[i] - b[i];
		}
		return 0;
	});
	return sorted[0];
}

/**
 * Every `TableReferenceNode` instance reachable from `plan`, keyed by
 * `relationKey` — `<schema>.<table>#<nodeId>`, the one spelling of that key in
 * the codebase.
 *
 * The walk descends `getChildren()`, NOT `getRelations()`: a table reference
 * under a scalar subquery expression (`not exists (select … from t …)`, the
 * shape almost every assertion body has) hangs off a scalar child and is
 * invisible to the relational-only walk.
 *
 * Callers that care about reference *identity* — one entry per reference, two
 * for a self-join — must hand in a plan that has only been optimized for
 * analysis (`Optimizer.optimizeForAnalysis`). Full physical optimization leaves
 * several distinct `TableReferenceNode` instances per table, so the same table
 * comes back more than once under different node ids.
 */
export function collectTableReferences(plan: PlanNode): Map<string, PlanTableReference> {
	const out = new Map<string, PlanTableReference>();
	collectInto(plan, out);
	return out;
}

function collectInto(node: PlanNode, out: Map<string, PlanTableReference>): void {
	if (node instanceof TableReferenceNode) {
		const schema = node.tableSchema;
		const base = `${schema.schemaName}.${schema.name}`.toLowerCase();
		out.set(`${base}#${node.id ?? 'unknown'}`, { node, base });
	}
	for (const child of node.getChildren()) {
		collectInto(child as unknown as PlanNode, out);
	}
}
