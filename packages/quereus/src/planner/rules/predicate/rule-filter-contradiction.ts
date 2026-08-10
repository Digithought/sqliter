/**
 * Rule: Filter Predicate Contradiction
 *
 * Folds Filter nodes whose conjuncts together with the source's
 * `domainConstraints` and literal `constantBindings` are provably
 * unsatisfiable. The empty result is materialized as `EmptyRelationNode`
 * carrying the Filter's own attribute IDs / RelationType, so the const-fold
 * cascade (Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi
 * Join) can drop the parent subtree.
 *
 * Scope (see `analysis/sat-checker.ts`):
 *   - Single-column comparisons against literals (= / != / < / <= / > / >=).
 *   - Single-column BETWEEN literal AND literal.
 *   - Single-column IN (lit, lit, ...) and intersection across IN-lists.
 *   - Domain-vs-predicate intersection.
 *
 * Out of scope (treated as `unknown`, never folded):
 *   - OR / CASE branch analysis, cross-column arithmetic, LIKE, IS NULL,
 *     user-function reasoning. The sat-checker tracks an `unknown` flag
 *     per column so an in-scope contradiction on column `a` still fires
 *     even if an unrelated LIKE on column `b` is present.
 *
 * Registered in the Structural pass — runs alongside the empty-
 * relation-folding rules so any `Filter(_, false)` produced by other rules
 * has already been collapsed.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { EmptyRelationNode } from '../../nodes/empty-relation-node.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import { checkSatisfiability } from '../../analysis/sat-checker.js';
import { isLiteralFalsy } from './rule-empty-relation-folding.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:filter-contradiction');

export function ruleFilterContradiction(node: PlanNode, ctx: OptContext): PlanNode | null {
	if (!(node instanceof FilterNode)) return null;

	// `Filter(_, lit-false|null|0|0n)` is the empty-folding rule's job; bail out
	// so this rule doesn't dispatch to the sat-checker for predicates the
	// sibling rule will collapse anyway.
	if (isLiteralFalsy(node.predicate)) {
		return null;
	}

	const sourcePhysical = node.source.physical;
	const domains = sourcePhysical.domainConstraints ?? [];
	const bindings = sourcePhysical.constantBindings ?? [];
	const conjuncts = splitConjuncts(node.predicate);

	const sourceAttrs = node.source.getAttributes();
	const attrIdToIndex = new Map<number, number>();
	sourceAttrs.forEach((a, i) => attrIdToIndex.set(a.id, i));

	const collationOf = (col: number): string | undefined => {
		const attr = sourceAttrs[col];
		return attr?.type.collationName;
	};

	const result = checkSatisfiability(
		conjuncts,
		domains,
		bindings,
		(attrId) => attrIdToIndex.get(attrId),
		collationOf,
		ctx.db.getCollationResolver(),
	);

	// `'unknown'` ("cannot prove unsatisfiable") and `'sat'` both leave the Filter alone.
	if (result !== 'unsat') return null;

	// Refuse to drop a source that carries a write — folding to Empty would
	// silently skip the write. Mirrors `ruleFilterFoldEmpty`'s guard.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.source)) {
		log('Filter contradiction fold skipped: source has side effects');
		return null;
	}

	log('Filter predicate provably unsatisfiable → Empty');
	return new EmptyRelationNode(node.scope, node.getAttributes(), node.getType());
}
