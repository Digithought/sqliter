/**
 * Which attributes does a predicate need in scope?
 *
 * A predicate's dependencies are NOT just the column references in its own
 * scalar tree. A sub-query operand (`exists (...)`, `x in (select ...)`, a
 * scalar sub-query) hangs a RELATIONAL subtree off the scalar expression, and a
 * correlated reference inside that subtree reads an outer attribute just as
 * surely as a top-level `t.d` does. A rule that walks scalar children only sees
 * an empty dependency set for `exists (select 1 from side where t.d > 0)` and
 * will happily move the predicate below the node that defines `d`, stranding
 * the reference and failing at runtime with "No row context found for column d".
 *
 * The relational half is answered by `collectExternalReferences`, which walks
 * both `getChildren()` and `getRelations()` and subtracts everything the
 * subtree defines for itself — what remains is exactly what it reads from
 * outside.
 */

import { isRelationalNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { CapabilityDetectors } from '../framework/characteristics.js';
import { collectExternalReferences } from '../cache/correlation-detector.js';

export interface PredicateDependencies {
	/** Attribute IDs referenced directly in the predicate's own scalar tree. */
	readonly direct: ReadonlySet<number>;
	/** Attribute IDs a sub-query operand references from OUTSIDE its own subtree. */
	readonly correlated: ReadonlySet<number>;
}

/**
 * Split a predicate's attribute dependencies into the ones its own scalar tree
 * names and the ones its sub-query operands correlate to. Rules that only need
 * "must be in scope" should use {@link collectPredicateAttributeIds}; rules that
 * must treat a correlation differently from a plain reference read the two apart.
 */
export function collectPredicateDependencies(expr: ScalarPlanNode): PredicateDependencies {
	const direct = new Set<number>();
	const correlated = new Set<number>();
	walk(expr, direct, correlated);
	return { direct, correlated };
}

/** Union of both — the full set of attributes the predicate needs in scope. */
export function collectPredicateAttributeIds(expr: ScalarPlanNode): Set<number> {
	const { direct, correlated } = collectPredicateDependencies(expr);
	const ids = new Set<number>(direct);
	for (const id of correlated) ids.add(id);
	return ids;
}

function walk(expr: ScalarPlanNode, direct: Set<number>, correlated: Set<number>): void {
	if (CapabilityDetectors.isColumnReference(expr)) {
		direct.add(expr.attributeId);
	}
	for (const child of expr.getChildren()) {
		if (isRelationalNode(child)) {
			for (const id of collectExternalReferences(child)) correlated.add(id);
		} else {
			walk(child as ScalarPlanNode, direct, correlated);
		}
	}
}
