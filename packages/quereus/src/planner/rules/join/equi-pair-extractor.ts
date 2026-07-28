/**
 * Shared helper: extract equi-join pairs and residual predicate from an ON
 * condition. Used by both `rule-join-physical-selection` (ordering-based) and
 * `rule-monotonic-merge-join` (MonotonicOn-based).
 */

import type { ScalarPlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { EquiJoinPair } from '../../nodes/join-utils.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { operandCollation } from '../../analysis/comparison-collation.js';
import { normalizeCollationName, semanticOrderingsAgree } from '../../../util/comparison.js';
import type { LogicalType } from '../../../types/logical-type.js';

export interface EquiPairExtraction {
	equiPairs: EquiJoinPair[];
	residual: ScalarPlanNode | undefined;
	/**
	 * For each entry in `equiPairs`, the original `=` ScalarPlanNode it was
	 * extracted from (or `undefined` for USING-derived pairs that have no
	 * source node). Same length and order as `equiPairs`. Useful when a rule
	 * wants to demote a subset of equi-pairs back into the residual (e.g., the
	 * monotonic-merge rule keeps only the monotonic-driving pair as the merge
	 * key and pushes the rest into the residual).
	 */
	equiPairNodes: Array<ScalarPlanNode | undefined>;
}

/**
 * Check whether `source`'s `physical.ordering` covers the given equi-pair
 * columns positionally for the chosen `side` (the merge-join emitter compares
 * keys in equi-pair order, so the source must be ASC-sorted on each
 * equi-pair attribute at exactly that position). Returns false on the first
 * mismatch.
 */
export function isOrderedOnEquiPairs(
	source: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	side: 'left' | 'right',
): boolean {
	const ordering = PlanNodeCharacteristics.getOrdering(source);
	if (!ordering || ordering.length === 0) return false;
	if (equiPairs.length > ordering.length) return false;

	const attrIndex = source.getAttributeIndex();
	for (let i = 0; i < equiPairs.length; i++) {
		const attrId = side === 'left' ? equiPairs[i].leftAttrId : equiPairs[i].rightAttrId;
		const idx = attrIndex.get(attrId) ?? -1;
		if (idx === -1) return false;
		if (ordering[i].column !== idx || ordering[i].desc) return false;
	}
	return true;
}

/**
 * Reorder equi-pairs so they line up with the left source's ordering prefix,
 * and verify the right source agrees on the same reordered key sequence.
 * Returns null when no reordering can satisfy both sides simultaneously.
 */
export function reorderEquiPairsForMerge(
	equiPairs: readonly EquiJoinPair[],
	left: RelationalPlanNode,
	right: RelationalPlanNode,
): EquiJoinPair[] | null {
	const leftOrdering = PlanNodeCharacteristics.getOrdering(left);
	if (!leftOrdering || leftOrdering.length < equiPairs.length) return null;

	const leftAttrIndex = left.getAttributeIndex();
	const colToEqIdx = new Map<number, number>();
	for (let i = 0; i < equiPairs.length; i++) {
		const attrIdx = leftAttrIndex.get(equiPairs[i].leftAttrId) ?? -1;
		if (attrIdx === -1) return null;
		colToEqIdx.set(attrIdx, i);
	}

	const reordered: EquiJoinPair[] = [];
	for (let i = 0; i < equiPairs.length; i++) {
		const eqIdx = colToEqIdx.get(leftOrdering[i].column);
		if (eqIdx === undefined || leftOrdering[i].desc) return null;
		reordered.push(equiPairs[eqIdx]);
	}

	if (!isOrderedOnEquiPairs(right, reordered, 'right')) return null;
	return reordered;
}

/**
 * True when both sides' physical ordering covers ALL equi-pairs in the
 * exact (or reorderable) order required by the merge-join emitter. When this
 * holds the ordering-based rule will produce a multi-key merge join with
 * proper unique-key propagation; rules that demote pairs to residual should
 * defer to that path instead of taking a single-pair merge.
 */
export function isMergeReadyOnAllPairs(
	left: RelationalPlanNode,
	right: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
): boolean {
	if (isOrderedOnEquiPairs(left, equiPairs, 'left') && isOrderedOnEquiPairs(right, equiPairs, 'right')) {
		return true;
	}
	if (equiPairs.length > 1) {
		return reorderEquiPairsForMerge(equiPairs, left, right) !== null;
	}
	return false;
}

/** Combine an existing residual and a list of extra scalar conjuncts into a single AND-tree. */
export function combineResidual(
	base: ScalarPlanNode | undefined,
	extras: ReadonlyArray<ScalarPlanNode>,
): ScalarPlanNode | undefined {
	const all: ScalarPlanNode[] = [];
	if (base) all.push(base);
	for (const e of extras) all.push(e);
	if (all.length === 0) return undefined;
	if (all.length === 1) return all[0];
	return all.reduce((acc, cur) =>
		new BinaryOpNode(
			cur.scope,
			{ type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
			acc,
			cur
		)
	);
}

/**
 * Extract equi-join pairs and residual predicates from an ON condition.
 * Returns null if no equi-pairs are found.
 *
 * **Collation gate.** A `l = r` column pair is recognized only when both
 * columns contribute the same collation. Every physical join algorithm this
 * extraction feeds (hash / merge / bloom) now resolves the pair's comparison
 * collation through the SAME provenance lattice as the canonical scalar
 * comparison (`resolveComparisonCollation` — symmetric, so the result no longer
 * depends on which side the algorithm reads first; ticket
 * `join-key-collation-resolution-alignment`). So the historical
 * resolution-order disagreement is gone — but the gate is **deliberately kept
 * conservative** for a second, independent reason: a *merge* join also requires
 * both inputs physically ordered under the key's comparison collation, and the
 * physical ordering property (`PhysicalProperties.ordering`) is collation-blind
 * (`{column, desc}` only) — a column's advertised ordering is implicitly under
 * its OWN declared collation. Admitting an asymmetric pair (declared NOCASE vs
 * defaulted BINARY → resolves NOCASE) would compare under NOCASE a side sorted
 * under BINARY, silently breaking the merge. Requiring matched collations keeps
 * the resolved key collation equal to each input's declared sort collation, so
 * the merge stays sound without the ordering property having to carry collation.
 * Loosening this gate is therefore an optimization gated on teaching the planner
 * ordering to track collation end-to-end — out of scope here. Mismatched pairs
 * demote to the residual, where the canonical scalar comparison (right-first but
 * via the same lattice) evaluates them; if no matched pair remains, the rule
 * doesn't fire and the generic join evaluates the whole condition. (Tickets
 * `collation-blind-equality-fact-extraction`,
 * `join-key-collation-resolution-alignment`.)
 *
 * **Semantic-ordering gate.** A pair is likewise recognized only when both sides
 * agree on semantic ordering — neither declares a semantic-ordering logical type,
 * or both declare the SAME one ({@link semanticOrderingsAgree}). A MIXED pair
 * (`timespan_col = text_col`) is what `=` evaluates through its generic path's
 * runtime duration check, so it matches 'PT1H' against 'PT60M'; a physical join
 * key comparing raw text would silently drop that row. The gate DECLINES rather
 * than canonicalizing the key, because merge join also needs both inputs
 * physically sorted in its comparator's order and a `timespan` side is sorted by
 * elapsed time while a `text` side is sorted by text — no single comparator merges
 * those two orders, so canonicalizing would fix hash join and leave merge join
 * unsound. Declined pairs demote to the residual (or, for USING, sink the whole
 * extraction) and the `=` operator's own semantics apply. See `docs/types.md`
 * § "Semantic ordering"; ticket
 * `mixed-type-equi-join-key-drops-semantic-matches`.
 */
export function extractEquiPairs(
	condition: ScalarPlanNode | undefined,
	leftAttrIds: Set<number>,
	rightAttrIds: Set<number>
): EquiPairExtraction | null {
	if (!condition) return null;

	const norm = normalizePredicate(condition);
	const equiPairs: EquiJoinPair[] = [];
	const equiPairNodes: Array<ScalarPlanNode | undefined> = [];
	const residuals: ScalarPlanNode[] = [];

	const stack: ScalarPlanNode[] = [norm];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof BinaryOpNode && n.expression.operator === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}

		let isEqui = false;
		if (n instanceof BinaryOpNode && n.expression.operator === '=') {
			if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode
				&& operandCollation(n.left) === operandCollation(n.right)
				&& semanticOrderingsAgree(n.left.getType().logicalType, n.right.getType().logicalType)) {
				const lId = n.left.attributeId;
				const rId = n.right.attributeId;

				if (leftAttrIds.has(lId) && rightAttrIds.has(rId)) {
					equiPairs.push({ leftAttrId: lId, rightAttrId: rId });
					equiPairNodes.push(n);
					isEqui = true;
				} else if (leftAttrIds.has(rId) && rightAttrIds.has(lId)) {
					equiPairs.push({ leftAttrId: rId, rightAttrId: lId });
					equiPairNodes.push(n);
					isEqui = true;
				}
			}
		}

		if (!isEqui) {
			residuals.push(n);
		}
	}

	if (equiPairs.length === 0) return null;

	const residual = combineResidual(undefined, residuals);

	return { equiPairs, residual, equiPairNodes };
}

/**
 * The slice of an {@link import('../../nodes/plan-node.js').Attribute} the USING
 * extractor reads. Structural rather than the full `Attribute` so tests can pass a
 * literal; both production call sites pass real attributes.
 */
type UsingAttr = {
	id: number;
	name: string;
	type?: { collationName?: string; logicalType?: LogicalType };
};

/**
 * Convert USING-column names into equi-pairs given the left/right attributes.
 * Returns null if no pairs could be matched.
 *
 * Applies the same matched-collation and semantic-ordering gates as
 * {@link extractEquiPairs}: a USING pair over columns with differing declared
 * collations, or with disagreeing semantic ordering (one side `timespan`, the
 * other plain `text`), is rejected outright (USING has no residual to demote
 * into — the whole extraction returns null so the generic join handles the
 * condition).
 */
export function extractEquiPairsFromUsing(
	usingColumns: readonly string[] | undefined,
	leftAttrs: ReadonlyArray<UsingAttr>,
	rightAttrs: ReadonlyArray<UsingAttr>,
): EquiPairExtraction | null {
	if (!usingColumns || usingColumns.length === 0) return null;
	const equiPairs: EquiJoinPair[] = [];
	for (const colName of usingColumns) {
		const lower = colName.toLowerCase();
		const leftAttr = leftAttrs.find(a => a.name.toLowerCase() === lower);
		const rightAttr = rightAttrs.find(a => a.name.toLowerCase() === lower);
		if (leftAttr && rightAttr) {
			const lColl = normalizeCollationName(leftAttr.type?.collationName ?? 'BINARY');
			const rColl = normalizeCollationName(rightAttr.type?.collationName ?? 'BINARY');
			if (lColl !== rColl) return null;
			if (!semanticOrderingsAgree(leftAttr.type?.logicalType, rightAttr.type?.logicalType)) return null;
			equiPairs.push({ leftAttrId: leftAttr.id, rightAttrId: rightAttr.id });
		}
	}
	if (equiPairs.length === 0) return null;
	return { equiPairs, residual: undefined, equiPairNodes: equiPairs.map(() => undefined) };
}
