/**
 * Rule: Empty-Relation Folding
 *
 * Const-fold pass that recognizes provably-empty subtrees and replaces them
 * with `EmptyRelationNode`, preserving attribute IDs and `RelationType` shape
 * so consumers above the rewrite keep working.
 *
 * Recognized shapes (E = EmptyRelationNode):
 *   - Filter(x, lit-false / lit-null / lit-0) → E with x's schema
 *   - Filter(E, _)                            → E (pass-through)
 *   - Project(E, projections)                 → E with project's schema
 *   - Sort(E, _) / LimitOffset(E, _) / Distinct(E) → E (schema unchanged)
 *   - Join(E, R, inner|cross|semi)            → E with join's schema
 *   - Join(L, E, inner|cross|semi)            → E with join's schema
 *   - Join(E, R, left)                        → E (empty driving side)
 *   - Join(L, E, right)                       → E (symmetric)
 *   - Join(E, _, anti)                        → E (anti drives from left)
 *   - Join(E, E, full)                        → E (both sides empty)
 *
 * Deliberately NOT folded (sound reasons):
 *   - Join(L, E, left)     — returns L null-padded on right
 *   - Join(E, R, right)    — symmetric
 *   - Join(L, E, anti)     — anti with empty right returns all of L
 *   - Single-side-empty FULL — still emits null-padded rows for non-empty side
 *
 * Runs in the Structural pass (TopDown) after the IND rules. Cascade is
 * bounded: rules chain within a single node visit via the per-node fixed-
 * point loop in `applyPassRules`, but the Structural pass itself is one
 * top-down traversal — a parent already visited won't re-fire when an inner
 * Filter folds. See "Cascade limits" in `docs/optimizer-rule-families.md`.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { SortNode } from '../../nodes/sort.js';
import { LimitOffsetNode } from '../../nodes/limit-offset.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { LiteralNode } from '../../nodes/scalar.js';
import { EmptyRelationNode } from '../../nodes/empty-relation-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:empty-relation-folding');

/**
 * Detects EmptyRelation, including the common case where it sits beneath one
 * or more attribute-renaming wrappers (Alias) introduced by FROM-clause
 * subquery aliases. Looking through Alias is sound here because the *host*
 * fold (Join, Project, etc.) produces an EmptyRelation carrying the host's
 * own attributes — the wrapped Alias's rename is discarded along with the
 * Alias itself.
 */
function isEmpty(node: PlanNode): boolean {
	if (node instanceof EmptyRelationNode) return true;
	if (node instanceof AliasNode) return isEmpty(node.source);
	return false;
}

/**
 * WHERE-clause truthiness: `false`, `null`, `0`, `0n` all reject every row.
 * Conservatively cover only the canonical "no rows" literals. Other coercions
 * (e.g. empty string, 0.0) are left out; if needed, expand here.
 */
export function isLiteralFalsy(node: PlanNode): boolean {
	if (!(node instanceof LiteralNode)) return false;
	const v = node.expression.value;
	return v === false || v === null || v === 0 || v === 0n;
}

export function ruleFilterFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof FilterNode)) return null;
	if (isEmpty(node.source)) {
		log('Filter(Empty, _) → Empty');
		return node.source;
	}
	if (isLiteralFalsy(node.predicate)) {
		// Refuse to drop a source subtree that carries a write: folding
		// `Filter(InsertReturning, false)` to Empty would silently skip the
		// INSERT. The audit gate forces an explicit run; the empty result still
		// has to be produced by some surviving subtree.
		if (PlanNodeCharacteristics.subtreeHasSideEffects(node.source)) {
			log('Filter(x, lit-false) skipped: source has side effects');
			return null;
		}
		log('Filter(x, lit-false) → Empty');
		return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
	}
	return null;
}

export function ruleProjectFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;
	if (!isEmpty(node.source)) return null;
	log('Project(Empty, _) → Empty');
	return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
}

export function ruleSortFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof SortNode)) return null;
	if (!isEmpty(node.source)) return null;
	log('Sort(Empty, _) → Empty');
	return node.source;
}

export function ruleLimitOffsetFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof LimitOffsetNode)) return null;
	if (!isEmpty(node.source)) return null;
	log('LimitOffset(Empty, _) → Empty');
	return node.source;
}

export function ruleDistinctFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof DistinctNode)) return null;
	if (!isEmpty(node.source)) return null;
	log('Distinct(Empty) → Empty');
	return node.source;
}

export function ruleJoinFoldEmpty(node: PlanNode, _ctx: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;
	const leftEmpty = isEmpty(node.left);
	const rightEmpty = isEmpty(node.right);
	if (!leftEmpty && !rightEmpty) return null;

	let fold = false;
	switch (node.joinType) {
		case 'inner':
		case 'cross':
			fold = leftEmpty || rightEmpty;
			break;
		case 'left':
			// LEFT JOIN: empty left → empty output. Empty right → keep (null-pad L).
			fold = leftEmpty;
			break;
		case 'right':
			// RIGHT JOIN: empty right → empty output. Empty left → keep (null-pad R).
			fold = rightEmpty;
			break;
		case 'full':
			// FULL JOIN: only fold when BOTH sides empty; one empty side still
			// emits null-padded rows from the non-empty side.
			fold = leftEmpty && rightEmpty;
			break;
		case 'semi':
			// SEMI JOIN: empty L → empty. Empty R → empty (no matches possible).
			fold = leftEmpty || rightEmpty;
			break;
		case 'anti':
			// ANTI JOIN: empty L → empty. Empty R → all of L (do NOT fold).
			fold = leftEmpty;
			break;
		default:
			return null;
	}

	if (!fold) return null;

	// Refuse to drop the non-empty side when it carries a write — collapsing
	// the join to Empty would silently skip those writes. The empty side has
	// no children (EmptyRelation is a leaf, possibly wrapped in Alias whose
	// source is Empty), so only the *other* side is the concern.
	const droppedSide = leftEmpty ? node.right : node.left;
	if (PlanNodeCharacteristics.subtreeHasSideEffects(droppedSide)) {
		log('Join(%s) fold skipped: dropped side has side effects', node.joinType);
		return null;
	}

	log('Join(%s) with empty side(s) → Empty', node.joinType);
	return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
}
