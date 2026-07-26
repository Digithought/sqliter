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
 * Powerful form (additional when source is an inner/cross JoinNode):
 *   - Split the newly-inferred conjuncts by which side of the join their
 *     columns reference. For each single-side conjunct, inject a FilterNode
 *     wrapping that side of the join, re-keyed onto the branch's local
 *     column indices.
 *   - The outer FilterNode still carries the augmented predicate; the
 *     branch filter is what subsequent predicate-pushdown can carry into
 *     the leaf's Retrieve pipeline.
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
 *     restricted to the preserved side. The rule additionally refuses
 *     branch injection on these join types (outer filter only).
 *   - SEMI/ANTI: only the left side is in the output; no right inference
 *     can arise here. Treat as LEFT for branch injection.
 *
 * See ticket `3-rule-predicate-inference-equivalence` for the full design.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext as _OptContext } from '../../framework/context.js';
import type { Attribute, ConstantValue, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode } from '../../nodes/join-node.js';
import { BinaryOpNode, LiteralNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../nodes/reference.js';
import { extractEqualityFds } from '../../util/fd-utils.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:predicate-inference-equivalence');

interface InferredConjunct {
	/** Column index in the FilterNode's source attribute list. */
	readonly sourceColIdx: number;
	readonly value: ConstantValue;
	/** Synthesized `col = value` expression. */
	readonly conjunct: ScalarPlanNode;
}

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

	const inferred: InferredConjunct[] = [];
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
					const conjunct = synthesizeEquality(filter.scope, attr, otherIdx, binding.value);
					inferred.push({ sourceColIdx: otherIdx, value: binding.value, conjunct });
				}
			}
		}
	}

	if (inferred.length === 0) return null;

	log('Inferring %d new equality conjunct(s) on Filter from EC × bindings', inferred.length);

	// AND every inferred conjunct into the predicate.
	let combinedPredicate = filter.predicate;
	for (const inf of inferred) {
		combinedPredicate = andTogether(filter.scope, combinedPredicate, inf.conjunct);
	}

	// Powerful form: branch injection below inner/cross joins.
	let newSource: RelationalPlanNode = source;
	if (source instanceof JoinNode) {
		newSource = tryBranchInjection(source, inferred) ?? source;
	}

	return new FilterNode(filter.scope, newSource, combinedPredicate);
}

/**
 * For an inner or cross JoinNode whose output bears `inferred` conjuncts,
 * inject single-side conjuncts as FilterNode wrappers on the corresponding
 * branch. Returns the rebuilt join, or null if no inferred conjunct lands
 * on either branch.
 */
function tryBranchInjection(join: JoinNode, inferred: readonly InferredConjunct[]): RelationalPlanNode | null {
	// Only inner / cross are safe — see file-level "Safety" notes.
	if (join.joinType !== 'inner' && join.joinType !== 'cross') return null;

	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const leftCount = leftAttrs.length;

	const leftBranchConjuncts: ScalarPlanNode[] = [];
	const rightBranchConjuncts: ScalarPlanNode[] = [];

	for (const inf of inferred) {
		if (inf.sourceColIdx < leftCount) {
			// Left-branch: attribute id is stable, so re-synthesize against the
			// branch's local column index (which is `sourceColIdx` itself).
			const attr = leftAttrs[inf.sourceColIdx];
			if (!attr) continue;
			leftBranchConjuncts.push(synthesizeEquality(join.scope, attr, inf.sourceColIdx, inf.value));
		} else {
			const rightIdx = inf.sourceColIdx - leftCount;
			const attr = rightAttrs[rightIdx];
			if (!attr) continue;
			rightBranchConjuncts.push(synthesizeEquality(join.scope, attr, rightIdx, inf.value));
		}
	}

	if (leftBranchConjuncts.length === 0 && rightBranchConjuncts.length === 0) return null;

	let newLeft: RelationalPlanNode = join.left;
	let newRight: RelationalPlanNode = join.right;

	if (leftBranchConjuncts.length > 0) {
		// Refuse to inject a Filter above a side-effect-bearing branch — the
		// added predicate would change which rows reach the write.
		if (PlanNodeCharacteristics.subtreeHasSideEffects(join.left)) {
			return null;
		}
		const leftPred = combineAnds(join.scope, leftBranchConjuncts);
		newLeft = new FilterNode(join.left.scope, join.left, leftPred);
	}
	if (rightBranchConjuncts.length > 0) {
		if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
			return null;
		}
		const rightPred = combineAnds(join.scope, rightBranchConjuncts);
		newRight = new FilterNode(join.right.scope, join.right, rightPred);
	}

	log('Injecting %d left + %d right branch filter(s) below %s join',
		leftBranchConjuncts.length, rightBranchConjuncts.length, join.joinType);

	return new JoinNode(
		join.scope,
		newLeft,
		newRight,
		join.joinType,
		join.condition,
		join.usingColumns,
	);
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

function combineAnds(scope: Scope, conjuncts: readonly ScalarPlanNode[]): ScalarPlanNode {
	let acc = conjuncts[0];
	for (let i = 1; i < conjuncts.length; i++) {
		acc = andTogether(scope, acc, conjuncts[i]);
	}
	return acc;
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
