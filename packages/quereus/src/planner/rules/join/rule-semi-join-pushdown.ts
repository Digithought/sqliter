/**
 * Rule: Semi-Join Pushdown — reassociate a semi join below an inner/cross join
 *
 * A semi join is an existential *filter* on its left input: it emits the left
 * rows for which the key source holds a match, and publishes the left input's
 * attributes verbatim. When its condition reads columns from only ONE side of an
 * inner/cross join underneath it, the filter can be applied to that side first:
 *
 *   Join(semi, Join(inner|cross, L, R), K, cond)   cond reads L (and K) only
 *     →  Join(inner|cross, Join(semi, L, K, cond), R)
 *
 *   Join(semi, Join(inner|cross, L, R), K, cond)   cond reads R (and K) only
 *     →  Join(inner|cross, L, Join(semi, R, K, cond))
 *
 * This is the same argument `rules/predicate/rule-join-predicate-pushdown.ts`
 * makes for scalar conjuncts — see its header's null-extension table. Neither
 * side of an `inner` / `cross` join is ever null-extended, so every output row
 * carries that side's genuine input values, and filtering the side before the
 * join removes exactly the output rows filtering after it would have.
 *
 * Soundness, stated for the semi case: `semi(X, K, p) = { x ∈ X : ∃k ∈ K. p(x, k) }`.
 * When `p` reads only the `L` part of `x`, the test is per-`L`-row and
 * deterministic, so it commutes with the join — whether the join drops `L` rows
 * or fans them out, filtering before removes precisely the output rows filtering
 * after would have.
 *
 * Output attributes are unchanged in identity AND order. A semi join publishes
 * its left input's attributes verbatim, so both the original and the rewritten
 * shape yield `L.attrs ++ R.attrs`; every `ColumnReferenceNode` above the join
 * resolves to the same attribute id it did before.
 *
 * WHY: `rules/access/rule-key-set-seek.ts` — which turns a semi join into
 * "materialize the key set once, then seek the target index per key" — only
 * fires when the filtered side peels down to a bare access leaf. A compound
 * query (`… from entry e join txn t on t.id = e.txn_id where e.txn_id in
 * (select …)`) puts a join there instead, so that rule declines and `entry` is
 * read end-to-end. After this reassociation the filtered side is a bare leaf
 * again and the existing rule fires unchanged — no new peel through `JoinNode`
 * is needed (walking a join in the peel would be unsound; this rule is the
 * sound way to reach the same plan).
 *
 * Deeper nesting works without extra machinery: the rewrite's new semi join is a
 * child of the returned node, so the top-down descent visits it and
 * `Join(semi, Join(inner, Join(inner, A, B), C), K)` pushes down twice.
 *
 * Admission gates (all must hold):
 * - Anchor is a semi `JoinNode` with a condition and no `exists … as` flags.
 * - `node.left` is an `inner` or `cross` `JoinNode`.
 * - The key source is uncorrelated, deterministic and write-free — the same
 *   admission test `rule-key-set-seek`'s `admitJoin` applies, and for the same
 *   reason: re-rooting the semi join must not change how the source is drained.
 * - The condition is functional (deterministic + read-only): the reassociation
 *   changes how many rows it is evaluated against.
 * - Neither inner-join branch is correlated. A LATERAL right side reads the left
 *   side, and re-rooting either branch under a semi join must not disturb that.
 * - Neither inner-join branch carries a write.
 * - Every attribute id the condition needs (`collectPredicateAttributeIds`,
 *   which also accounts for correlated references inside a sub-query operand) is
 *   either a key-source attribute or an attribute of EXACTLY ONE inner-join
 *   branch. An id in neither branch (an outer reference, an `exists … as` flag)
 *   declines; ids spanning both branches decline; ids touching neither branch
 *   decline because there is nothing to gain.
 *
 * `inner.condition` / `inner.usingColumns` / `inner.existence` carry over
 * verbatim to the rebuilt inner join, and `node.condition` / `node.usingColumns`
 * to the pushed semi join — both rebuilds go through `withChildren`, which
 * threads those fields. Existence flags on an INNER join are unreachable today
 * (the parser only accepts `exists … as` on `left join`), and the attribute-id
 * gate above already declines any condition that reads a flag, so no redundant
 * guard is added for them.
 *
 * NOT IN SCOPE — deliberately:
 * - NOTE: `anti` joins are declined by design, not by accident.
 *   `anti(L ⋈ R, K) = anti(L, K) ⋈ R` when the condition reads only `L`,
 *   exactly as above (the test is still per-`L`-row and deterministic), but
 *   `rule-key-set-seek` admits `semi` only, so there is nothing downstream to
 *   gain. Revisit if that rule ever admits `anti`.
 * - NOTE: a LEFT join on the probe side with the semi condition reading the
 *   PRESERVED (left) side is also sound — `σ(L ⟕ R) = σ(L) ⟕ R` when `σ` reads
 *   only `L` — and is left out only to keep the first pass to the shape in the
 *   repro. Revisit if a compound outer-join shape shows up wanting the seek.
 *   The MIRROR case is NOT sound and must stay declined permanently: a
 *   condition reading the NULL-EXTENDED side (the right side of a `left join`)
 *   does not commute, because filtering `R` before the join re-pads the left row
 *   with NULLs instead of dropping it.
 *   `backlog/feat-outer-join-to-inner-on-null-rejecting-filter`, if it lands,
 *   converts some outer joins to inner ones and this rule then covers them.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { collectPredicateAttributeIds } from '../../analysis/predicate-dependencies.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';

const log = createLogger('optimizer:rule:semi-join-pushdown');

/** Which branch of the inner join the semi join's condition reads. */
type InnerSide = 'left' | 'right';

const attributeIds = (node: RelationalPlanNode): Set<number> =>
	new Set(node.getAttributes().map(a => a.id));

/**
 * The single inner-join branch `cond` reads, or null when it spans both, escapes
 * both (an outer reference or an existence flag), or reads neither.
 */
function conditionSide(
	cond: ScalarPlanNode,
	keyIds: ReadonlySet<number>,
	leftIds: ReadonlySet<number>,
	rightIds: ReadonlySet<number>,
): InnerSide | null {
	let needsLeft = false;
	let needsRight = false;
	for (const id of collectPredicateAttributeIds(cond)) {
		if (keyIds.has(id)) continue;
		if (leftIds.has(id)) { needsLeft = true; continue; }
		if (rightIds.has(id)) { needsRight = true; continue; }
		// An id belonging to neither branch nor the key source: an outer
		// reference, or an `exists … as` flag the inner join appends. Pushing
		// below either branch would strand it.
		return null;
	}
	// Equal means either "spans both branches" (unsound to push to one) or
	// "reads neither" (nothing to gain — a condition over constants alone).
	if (needsLeft === needsRight) return null;
	return needsLeft ? 'left' : 'right';
}

export function ruleSemiJoinPushdown(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;
	if (node.joinType !== 'semi') return null;
	if (!node.condition) return null;
	// An `exists … as` flag on the anchor would be published above it, but the
	// pushed semi join publishes only its own left input's attributes.
	if (node.hasExistenceColumns) return null;

	const inner = node.left;
	if (!(inner instanceof JoinNode)) return null;
	if (inner.joinType !== 'inner' && inner.joinType !== 'cross') return null;

	// NOTE: unconditional — no cost gate, matching `rule-join-predicate-pushdown`'s
	// treatment of scalar conjuncts. At Structural time the row estimates are not
	// usable anyway (most table-backed inputs report `Infinity`; see the NOTE in
	// `rule-join-greedy-commute`). The one shape where pushdown does extra work is a
	// strongly *filtering* inner join, where the semi join probes |L| rows instead of
	// the smaller |L ⋈ R| — offset by the join then receiving a smaller left input.
	// Revisit condition: if a filtering-join shape ever shows up regressed in
	// `yarn bench:gate`, gate this on estimated rows.

	const keySource = node.right;
	// The key source is drained once by the semi join wherever it sits; a
	// correlated / non-deterministic / write-bearing source must keep its
	// per-execution semantics. Same admission test as `rule-key-set-seek`.
	if (isCorrelatedSubquery(keySource)) {
		log('decline: key source is correlated');
		return null;
	}
	if (!PlanNodeCharacteristics.isDeterministic(keySource)) {
		log('decline: key source is non-deterministic');
		return null;
	}
	if (PlanNodeCharacteristics.subtreeHasSideEffects(keySource)) {
		log('decline: key source has side effects');
		return null;
	}
	// Both branches are re-rooted (one under the semi join, one under the rebuilt
	// inner join) — refuse to touch a subtree carrying a write.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(inner.left)
		|| PlanNodeCharacteristics.subtreeHasSideEffects(inner.right)) {
		log('decline: an inner-join branch has side effects');
		return null;
	}
	// A LATERAL right side reads the left side; re-rooting either branch must not
	// disturb the row context it reads from.
	if (isCorrelatedSubquery(inner.left) || isCorrelatedSubquery(inner.right)) {
		log('decline: an inner-join branch is correlated');
		return null;
	}
	// The condition is evaluated against a different number of rows after the
	// move, so a non-deterministic or write-bearing one must stay put.
	if (!PlanNodeCharacteristics.isFunctional(node.condition)) {
		log('decline: semi-join condition is not functional');
		return null;
	}

	const side = conditionSide(
		node.condition,
		attributeIds(keySource),
		attributeIds(inner.left),
		attributeIds(inner.right),
	);
	if (side === null) return null;

	const target = side === 'left' ? inner.left : inner.right;
	// `withChildren` (not `new JoinNode(...)`) so `usingColumns` / `existence`
	// thread through both rebuilds.
	const pushedSemi = node.withChildren([target, keySource, node.condition]) as RelationalPlanNode;
	const innerChildren: PlanNode[] = side === 'left'
		? [pushedSemi, inner.right]
		: [inner.left, pushedSemi];
	if (inner.condition) innerChildren.push(inner.condition);

	log('Pushed semi join below %s join onto its %s branch', inner.joinType, side);
	return inner.withChildren(innerChildren);
}
