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
import {
	operandCollation,
	isValueDiscriminatingEquality,
	resolveComparisonCollation,
	logicalTypeCanHoldText,
	type CollationCarrier,
} from '../../analysis/comparison-collation.js';
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
 * **Collation handling — tagged, not gated.** A `l = r` column pair is
 * extracted regardless of whether the two sides declare the same collation;
 * every physical join algorithm this extraction feeds resolves the pair's
 * comparison collation through the SAME symmetric provenance lattice as the
 * canonical scalar comparison (`resolveComparisonCollation`; ticket
 * `join-key-collation-resolution-alignment`), so a hash/bloom key over an
 * asymmetric pair (declared NOCASE vs defaulted BINARY → resolves NOCASE)
 * normalizes both sides identically and matches exactly what `=` matches.
 * The two collation-derived properties that DO differ per pair travel on the
 * pair itself (see {@link EquiJoinPair}):
 *
 * - `collationsMatch` — merge join's admission bit. Merge additionally needs
 *   both inputs physically ordered under the key's comparison collation, and
 *   `PhysicalProperties.ordering` is collation-blind (`{column, desc}` only);
 *   a matched declared collation is what makes each input's advertised order
 *   equal the merge comparator's order. The selection rules
 *   (`rule-join-physical-selection`, `rule-monotonic-merge-join`) consider
 *   merge only for matched pairs; hash/bloom take every pair.
 * - `valueDiscriminating` — the fact-minting bit
 *   (`isValueDiscriminatingEquality`). A non-BINARY comparison passes
 *   value-DIFFERENT rows ('Bob' = 'bob' NOCASE), so the physical join nodes
 *   exclude such pairs from key coverage / FD / EC / monotonicity
 *   propagation while still keying the join on them. (Ticket
 *   `collation-blind-equality-fact-extraction`.)
 *
 * One collation shape is still declined outright: a same-rank
 * explicit/declared *conflict* (`resolveComparisonCollation` → `conflict`,
 * e.g. declared NOCASE vs declared RTRIM). That is a plan-time user error
 * surfaced by `BinaryOpNode.generateType`; extraction must neither throw nor
 * admit the pair (the emitters' lattice resolution would throw), so the
 * conjunct stays in the residual and the error surfaces at its own site.
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
				&& semanticOrderingsAgree(n.left.getType().logicalType, n.right.getType().logicalType)
				&& resolveComparisonCollation(n.left.getType(), n.right.getType()).kind !== 'conflict') {
				const lId = n.left.attributeId;
				const rId = n.right.attributeId;
				const collationsMatch = operandCollation(n.left) === operandCollation(n.right);
				const valueDiscriminating = isValueDiscriminatingEquality(n.left, n.right);

				if (leftAttrIds.has(lId) && rightAttrIds.has(rId)) {
					equiPairs.push({ leftAttrId: lId, rightAttrId: rId, collationsMatch, valueDiscriminating });
					equiPairNodes.push(n);
					isEqui = true;
				} else if (leftAttrIds.has(rId) && rightAttrIds.has(lId)) {
					equiPairs.push({ leftAttrId: rId, rightAttrId: lId, collationsMatch, valueDiscriminating });
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
	type?: CollationCarrier & { logicalType?: LogicalType };
};

/**
 * The USING analogue of {@link isValueDiscriminatingEquality}, over declared
 * attribute slices rather than plan nodes: both sides' declared collations are
 * BINARY, or neither side's static type can ever hold text at runtime.
 */
function isValueDiscriminatingUsingPair(left: UsingAttr, right: UsingAttr): boolean {
	const lColl = normalizeCollationName(left.type?.collationName ?? 'BINARY');
	const rColl = normalizeCollationName(right.type?.collationName ?? 'BINARY');
	if (lColl === 'BINARY' && rColl === 'BINARY') return true;
	return !logicalTypeCanHoldText(left.type?.logicalType) && !logicalTypeCanHoldText(right.type?.logicalType);
}

/**
 * Convert USING-column names into equi-pairs given the left/right attributes.
 * Returns null if no pairs could be matched.
 *
 * Collation is handled as in {@link extractEquiPairs}: a pair over columns with
 * differing declared collations IS extracted, tagged `collationsMatch: false`
 * (hash/bloom join it; merge declines) and with `valueDiscriminating` per the
 * value-discrimination gate. Two shapes still sink the whole extraction to
 * `null` (USING has no residual to demote into — the generic join evaluates
 * the condition instead): a same-rank explicit/declared collation *conflict*,
 * and disagreeing semantic ordering (one side `timespan`, the other plain
 * `text` — see the semantic-ordering gate on {@link extractEquiPairs}).
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
			if (resolveComparisonCollation(leftAttr.type ?? {}, rightAttr.type ?? {}).kind === 'conflict') return null;
			if (!semanticOrderingsAgree(leftAttr.type?.logicalType, rightAttr.type?.logicalType)) return null;
			const lColl = normalizeCollationName(leftAttr.type?.collationName ?? 'BINARY');
			const rColl = normalizeCollationName(rightAttr.type?.collationName ?? 'BINARY');
			equiPairs.push({
				leftAttrId: leftAttr.id,
				rightAttrId: rightAttr.id,
				collationsMatch: lColl === rColl,
				valueDiscriminating: isValueDiscriminatingUsingPair(leftAttr, rightAttr),
			});
		}
	}
	if (equiPairs.length === 0) return null;
	return { equiPairs, residual: undefined, equiPairNodes: equiPairs.map(() => undefined) };
}
