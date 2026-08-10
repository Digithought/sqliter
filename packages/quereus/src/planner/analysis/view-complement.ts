import type { PlanNode, RelationalPlanNode, UpdateSite } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { FilterNode } from '../nodes/filter.js';
import type * as AST from '../../parser/ast.js';

/**
 * The predicate-honest complement of a view body — what a write through the view
 * holds *fixed*, i.e. the part of the base state the view does not expose. Per
 * `docs/vu-roundtrip.md` § The predicate-honest complement, the
 * `docs/view-updateability.md` § Philosophy fan-out makes this *determined* (no Bancilhon–Spyratos choice),
 * so it is a first-class derived object computed off the backward walk:
 *
 * - `hiddenColumns` — base columns present in the base relation(s) but absent
 *   from the view image (no `updateLineage` entry traces to them), keyed by the
 *   producing `TableReferenceNode`'s id and base column name.
 * - `residualPredicate` — the conjunction of the body's σ predicates (the
 *   conjuncts that constrain base rows the view never surfaces). Within the
 *   supported conjunctive-σ shape this is already negation-free; the accessor
 *   conjoins the raw `FilterNode` predicates verbatim and performs no
 *   normalization, so an out-of-envelope `not`/`<>` predicate is carried as-is.
 *
 * With this object the lens prover's *Round-trip (lens laws)* check becomes
 * computed (GetPut ⇔ `put` leaves the complement fixed; PutGet ⇔ `get ∘ put`
 * reproduces the written image) rather than an enumerated checklist. The prover
 * (`schema/lens-prover.ts`) is the intended consumer; it rides its
 * `analyzeRoundTrip` / `emitRoundTrip` seam onto this accessor.
 */
export interface ViewComplement {
	readonly hiddenColumns: ReadonlyArray<{ readonly table: number; readonly column: string }>;
	readonly residualPredicate?: AST.Expression;
}

/** The base columns an `UpdateSite` reaches (unwrapping outer-join null-extension). */
function collectCoveredBase(site: UpdateSite, out: Set<string>): void {
	if (site.kind === 'base') out.add(`${site.table}:${site.baseColumn.toLowerCase()}`);
	else if (site.kind === 'null-extended') collectCoveredBase(site.inner, out);
}

/** Walk the planned subtree, collecting base tables and σ predicates. */
function collect(node: PlanNode, tables: TableReferenceNode[], predicates: AST.Expression[]): void {
	if (node instanceof TableReferenceNode) tables.push(node);
	else if (node instanceof FilterNode) predicates.push(node.predicate.expression);
	for (const child of node.getChildren()) collect(child, tables, predicates);
}

/**
 * Compute the {@link ViewComplement} of a planned view body from its backward
 * walk. Reads `node.physical.updateLineage` (the columns the view exposes) and
 * the base tables / σ predicates in the subtree; the complement is everything
 * left over. Generalizes across sources — a multi-source (join) body simply
 * contributes every non-exposed column of every base table it touches.
 */
export function viewComplement(node: RelationalPlanNode): ViewComplement {
	const tables: TableReferenceNode[] = [];
	const predicates: AST.Expression[] = [];
	collect(node, tables, predicates);

	const covered = new Set<string>();
	const lineage = node.physical.updateLineage;
	if (lineage) for (const site of lineage.values()) collectCoveredBase(site, covered);

	const hiddenColumns: Array<{ table: number; column: string }> = [];
	for (const table of tables) {
		const tid = Number(table.id);
		for (const col of table.tableSchema.columns) {
			if (!covered.has(`${tid}:${col.name.toLowerCase()}`)) {
				hiddenColumns.push({ table: tid, column: col.name });
			}
		}
	}

	let residualPredicate: AST.Expression | undefined;
	for (const p of predicates) {
		residualPredicate = residualPredicate
			? { type: 'binary', operator: 'AND', left: residualPredicate, right: p }
			: p;
	}

	return { hiddenColumns, ...(residualPredicate ? { residualPredicate } : {}) };
}

/** Alias matching the `complementOf(node)` accessor name in the design doc. */
export const complementOf = viewComplement;
