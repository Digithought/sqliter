/**
 * Rule: Predicate Inference (Equivalence-Class driven)
 *
 * Materializes inferred equality predicates derived from combining
 * (predicate-derived) constant bindings with (source-derived) equivalence
 * classes. When `t.k = u.k` is known via a join's equi-pair and `t.k = V`
 * is asserted in the filter, the rule emits `u.k = V` so the predicate is
 * visible to vtab access plans on the `u` side independently.
 *
 * Simple form (always run):
 *   Filter(predicate, source)
 *   - Extract `predBindings` from the predicate (col-index → constant value).
 *   - Cross with `source.physical.equivClasses`: for every EC member of a
 *     bound column that is not itself bound by the predicate, emit a new
 *     `col = value` conjunct.
 *   - AND the new conjuncts into the filter predicate.
 *
 * Getting the inferred conjunct onto the branch is NOT this rule's job.
 * `rule-join-predicate-pushdown` (registered immediately after this one, so it
 * fires on this rule's own output within the same node visit) moves every
 * single-side conjunct of the augmented predicate — original and inferred alike —
 * onto the branch it constrains, and `rule-predicate-pushdown` then carries it
 * across that branch's Alias into its Retrieve. This rule used to inject those
 * branch Filters itself, back when no rule could cross a join; doing both now
 * materializes the same conjunct twice on one branch (`u.k = 5 AND u.k = 5`), so
 * the injection was removed rather than duplicated. Disabling
 * `join-predicate-pushdown` therefore also stops inferred conjuncts from reaching
 * a branch — they still land in the Filter above the join.
 *
 * Fixpoint guard: the rule's emission set is `{otherIdx ∈ EC | otherIdx
 * is not already in predBoundIdx}`. On a second invocation the
 * inferred conjuncts have themselves contributed bindings, so every EC
 * member is in `predBoundIdx` and the rule yields nothing. The registry's
 * per-node `markRuleApplied` is a belt-and-suspenders second guard.
 *
 * Safety:
 *   - LEFT/RIGHT/FULL joins: per `propagateJoinFds`, NULL-padded sides drop
 *     their bindings/ECs, so the EC visible at the filter's source is
 *     restricted to the preserved side — no conjunct over a null-extended
 *     side can be inferred here in the first place.
 *   - SEMI/ANTI: only the left side is in the output; no right inference
 *     can arise here.
 *
 * See ticket `3-rule-predicate-inference-equivalence` for the full design.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext as _OptContext } from '../../framework/context.js';
import type { Attribute, ConstantValue, ScalarPlanNode } from '../../nodes/plan-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { BinaryOpNode, LiteralNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../nodes/reference.js';
import { extractEqualityFds } from '../../util/fd-utils.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:predicate-inference-equivalence');

export function rulePredicateInferenceEquivalence(node: import('../../nodes/plan-node.js').PlanNode, _context: _OptContext): import('../../nodes/plan-node.js').PlanNode | null {
	if (!(node instanceof FilterNode)) return null;
	const filter = node as FilterNode;
	const source = filter.source;
	const sourcePhys = source.physical;
	const ecs = sourcePhys?.equivClasses;
	if (!ecs || ecs.length === 0) return null;

	const sourceAttrs = source.getAttributes();
	const attrIdToIndex = new Map<number, number>();
	sourceAttrs.forEach((a, i) => attrIdToIndex.set(a.id, i));

	const { constantBindings: predBindings } = extractEqualityFds(filter.predicate, attrIdToIndex);
	if (predBindings.length === 0) return null;

	// Columns the predicate itself directly pins. Used both to find which
	// EC members already have a binding and as the fixpoint guard: once
	// every EC member is in this set, the rule contributes nothing further.
	const predBoundIdx = new Set<number>();
	for (const b of predBindings) for (const c of b.attrs) predBoundIdx.add(c);

	// Only the synthesized expressions are needed now that branch injection is gone —
	// the rule's whole output is the augmented predicate.
	const inferred: ScalarPlanNode[] = [];
	const seen = new Set<string>();
	for (const binding of predBindings) {
		for (const predIdx of binding.attrs) {
			for (const cls of ecs) {
				if (!cls.includes(predIdx)) continue;
				for (const otherIdx of cls) {
					if (otherIdx === predIdx) continue;
					if (predBoundIdx.has(otherIdx)) continue;
					const key = `${otherIdx}|${valueSignature(binding.value)}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const attr = sourceAttrs[otherIdx];
					if (!attr) continue;
					inferred.push(synthesizeEquality(filter.scope, attr, otherIdx, binding.value));
				}
			}
		}
	}

	if (inferred.length === 0) return null;

	log('Inferring %d new equality conjunct(s) on Filter from EC × bindings', inferred.length);

	// AND every inferred conjunct into the predicate. `join-predicate-pushdown`
	// distributes the single-side ones onto their branches from here.
	let combinedPredicate = filter.predicate;
	for (const inf of inferred) {
		combinedPredicate = andTogether(filter.scope, combinedPredicate, inf);
	}

	return new FilterNode(filter.scope, source, combinedPredicate);
}

function synthesizeEquality(scope: Scope, attr: Attribute, columnIndex: number, value: ConstantValue): ScalarPlanNode {
	const colExpr: AST.ColumnExpr = attr.relationName
		? { type: 'column', name: attr.name, table: attr.relationName }
		: { type: 'column', name: attr.name };
	const colRef = new ColumnReferenceNode(scope, colExpr, attr.type, attr.id, columnIndex);

	let valueNode: ScalarPlanNode;
	if (value.kind === 'literal') {
		const litExpr: AST.LiteralExpr = { type: 'literal', value: value.value };
		// Type the synthesized literal from the attribute it is compared against, so a
		// non-null constant whose JS shape does not name its logical type (a JSON
		// document is a plain object) still reports the column's type. A null keeps the
		// inferred NULL_TYPE — the attribute's type would claim `nullable: false`.
		const litType = value.value !== null
			? { ...attr.type, nullable: false, isReadOnly: true }
			: undefined;
		valueNode = new LiteralNode(scope, litExpr, litType);
	} else {
		const paramExpr: AST.ParameterExpr = typeof value.paramRef === 'string'
			? { type: 'parameter', name: value.paramRef }
			: { type: 'parameter', index: value.paramRef };
		valueNode = new ParameterReferenceNode(scope, paramExpr, value.paramRef, attr.type);
	}

	const eqAst: AST.BinaryExpr = {
		type: 'binary',
		operator: '=',
		left: colRef.expression,
		right: valueNode.expression,
	};
	return new BinaryOpNode(scope, eqAst, colRef, valueNode);
}

function andTogether(scope: Scope, left: ScalarPlanNode, right: ScalarPlanNode): ScalarPlanNode {
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: 'AND',
		left: left.expression,
		right: right.expression,
	};
	return new BinaryOpNode(scope, ast, left, right);
}

function valueSignature(value: ConstantValue): string {
	if (value.kind === 'literal') {
		const v = value.value;
		if (v === null) return 'lit:null';
		if (v instanceof Uint8Array) return `lit:blob:${Array.from(v).join(',')}`;
		return `lit:${typeof v}:${String(v)}`;
	}
	return `param:${value.paramRef}`;
}
