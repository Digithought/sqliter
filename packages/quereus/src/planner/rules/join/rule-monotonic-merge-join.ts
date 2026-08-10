/**
 * Rule: Monotonic Merge Join
 *
 * Required Characteristics:
 * - Node must be a logical JoinNode (not already physical)
 * - Both inputs advertise `MonotonicOn` on (at least) one of the equi-pair
 *   attributes, with matching direction (ASC for v1, since the merge-join
 *   emitter assumes ASC ordering).
 * - Neither input reads the other's columns (a merge join drains each side
 *   independently, so such a side must keep the nested-loop driver).
 *
 * Why this rule exists alongside `rule-join-physical-selection`:
 * The existing rule chooses merge-join when both sources' `physical.ordering`
 * matches the equi-pair attribute order positionally. That misses the canonical
 * case where a merge-join's *output* declares `monotonicOn = [l.X, r.X]` but
 * `ordering` reflects only the left side — a parent join on `r.X` then sees
 * the right ordering implicitly through `monotonicOn` but not through
 * `ordering[0]`. This rule looks the equi-pair attrs up directly in
 * `monotonicOn`, recognising those (and other future MonotonicOn-propagating
 * paths) without sorting.
 *
 * Out of scope (TODO):
 * - Composite monotonic-on prefixes (multi-key streaming merge keyed on
 *   `(X, Y)` when both sides are jointly monotonic on the prefix).
 * - Right and full outer joins — emitter doesn't support them today.
 * - Recognising `monotonicOn(asc)` vs `monotonicOn(desc)` by reversing one
 *   side via Sort. That defeats this rule's premise (the rule's whole point is
 *   that no sort is needed because both sides are already monotonic).
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { MergeJoinNode } from '../../nodes/merge-join-node.js';
import type { EquiJoinPair } from '../../nodes/join-utils.js';
import { nestedLoopJoinCost, hashJoinCost, mergeJoinCost } from '../../cost/index.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { extractEquiPairs, combineResidual, isMergeReadyOnAllPairs } from './equi-pair-extractor.js';
import { readsColumnsOf } from '../../cache/correlation-detector.js';

const log = createLogger('optimizer:rule:monotonic-merge-join');

export function ruleMonotonicMergeJoin(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;

	// Existence-flag joins must stay the nested-loop JoinNode (see
	// rule-join-physical-selection): the MergeJoin variant would drop the flag.
	if (node.hasExistenceColumns) return null;

	const joinType = node.joinType;
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'semi' && joinType !== 'anti') return null;

	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const leftAttrIds = new Set(leftAttrs.map(a => a.id));
	const rightAttrIds = new Set(rightAttrs.map(a => a.id));

	// A USING join carries a desugared condition (see `buildUsingCondition`), so the
	// one extractor covers both spellings.
	const extracted = extractEquiPairs(node.condition, leftAttrIds, rightAttrIds);
	if (!extracted || extracted.equiPairs.length === 0) return null;

	// Same hazard `rule-join-physical-selection` guards: a merge join drains each
	// side independently, so a side reading its SIBLING's columns (a `JOIN
	// LATERAL` subtree, an index-nested-loop's correlated seek) would resolve
	// against no row. Defensive here — no SQL shape was found that both reads a
	// sibling's columns and advertises `monotonicOn` on the join key, so this
	// gate is untested — but the emitter contract is identical, so declining
	// costs at most one unreachable optimization.
	if (readsColumnsOf(node.right, node.left) || readsColumnsOf(node.left, node.right)) {
		log('Declining: a join side reads its sibling\'s columns; nested-loop driver required');
		return null;
	}

	// Defer to `rule-join-physical-selection` whenever both sides' physical
	// ordering already covers ALL equi-pairs in merge-ready order. The
	// ordering-based path produces a multi-key merge join with full
	// unique-key propagation; demoting pairs to residual here would lose that
	// propagation. Our rule is meant to *extend* recognition, not regress it.
	// Defer only when that rule can actually take merge: it requires EVERY
	// pair `collationsMatch` (see EquiJoinPair.collationsMatch) — with any
	// mismatched pair it never merges, so there is nothing to defer to.
	if (extracted.equiPairs.every(p => p.collationsMatch)
		&& isMergeReadyOnAllPairs(node.left, node.right, extracted.equiPairs)) return null;

	const leftMon = PlanNodeCharacteristics.getMonotonicOn(node.left);
	const rightMon = PlanNodeCharacteristics.getMonotonicOn(node.right);
	if (leftMon.length === 0 || rightMon.length === 0) return null;

	// Find equi-pairs where BOTH sides are MonotonicOn on their respective
	// attrId with matching direction. v1 requires ASC because the merge-join
	// emitter assumes ASC; DESC-DESC streaming would need a reversed compareKeys.
	// The driving merge key must have matched declared collations: each side's
	// monotonicOn (like `ordering`) is implicitly under its OWN declared
	// collation, and the merge comparator resolves the pair's collation — only
	// a matched pair makes those the same order (see EquiJoinPair.collationsMatch).
	const matchedIndices: number[] = [];
	for (let i = 0; i < extracted.equiPairs.length; i++) {
		const pair = extracted.equiPairs[i];
		if (!pair.collationsMatch) continue;
		const l = leftMon.find(m => m.attrId === pair.leftAttrId && m.direction === 'asc');
		if (!l) continue;
		const r = rightMon.find(m => m.attrId === pair.rightAttrId && m.direction === 'asc');
		if (!r) continue;
		matchedIndices.push(i);
	}
	if (matchedIndices.length === 0) return null;

	// v1: pick a single driving equi-pair. Other equi-pairs (matched or not)
	// must be evaluated as residual conjuncts — the merge-join emitter assumes
	// the right side is sorted lexicographically across ALL listed equi-pair
	// columns, which we cannot guarantee for non-driving keys.
	// TODO: composite monotonic-on prefixes — recognise when both sides are
	// jointly MonotonicOn on a multi-key prefix and use multiple driving keys.
	const drivingIndex = matchedIndices[0];
	const driving: EquiJoinPair[] = [extracted.equiPairs[drivingIndex]];

	// Residualize the rest. For pairs that originated from a real `=` BinaryOpNode
	// (ON-condition path), reuse the original node. For USING-derived pairs,
	// `equiPairNodes[i]` is undefined — bail out and let the existing
	// ordering-based rule handle USING-with-multiple-pairs.
	const extras: ScalarPlanNode[] = [];
	for (let i = 0; i < extracted.equiPairs.length; i++) {
		if (i === drivingIndex) continue;
		const orig = extracted.equiPairNodes[i];
		if (!orig) return null;
		extras.push(orig);
	}
	const residual = combineResidual(extracted.residual, extras);

	// Cost gate: even with the precondition met, hash or nested-loop may win
	// on tiny inputs. Don't regress those.
	const leftRows = node.left.estimatedRows ?? 100;
	const rightRows = node.right.estimatedRows ?? 100;
	const mergeC = mergeJoinCost(leftRows, rightRows, false, false);
	const hashC = hashJoinCost(Math.min(leftRows, rightRows), Math.max(leftRows, rightRows));
	const nlC = nestedLoopJoinCost(leftRows, rightRows);
	if (Math.min(hashC, nlC) < mergeC) {
		log('Skipping monotonic-merge: cheaper alternative exists (merge=%.2f, hash=%.2f, nl=%.2f)',
			mergeC, hashC, nlC);
		return null;
	}

	log('Selecting monotonic merge-join on equi-pair %d=%d (merge=%.2f, hash=%.2f, nl=%.2f)',
		driving[0].leftAttrId, driving[0].rightAttrId, mergeC, hashC, nlC);

	return new MergeJoinNode(
		node.scope,
		node.left,
		node.right,
		joinType,
		driving,
		residual,
		node.getAttributes().slice() as Attribute[],
	);
}
