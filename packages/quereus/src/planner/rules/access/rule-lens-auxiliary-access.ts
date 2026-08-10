/**
 * Rule: Lens Auxiliary Access (ticket `lens-access-shape-path-selection`).
 *
 * Routes an outer-query predicate over an inlined lens view through an advertised
 * auxiliary-access structure (nd-tree spatial / vector knn / full-text) instead
 * of leaving it a residual filter over the full decomposition scan. Registered on
 * {@link FilterNode}, in the Structural (`rewrite`) pass, **before** generic
 * predicate-pushdown so the predicate still sits directly above the
 * {@link LensAuxiliaryAccessNode} marker.
 *
 * On a match (D1–D6):
 *   Filter[ nd_contains(coord, :pt) ∧ rest ]            Filter[ rest ]?
 *   └─ marker( V )                            ──►        └─ V ⋈semi[V.pk = aux.key] Filter[nd_contains(aux.coord, :pt)](AuxScan)
 *
 * The matched predicate fragment is **consumed** (v1 treats an advertised form as
 * exact — the auxiliary fully answers it). The access column is rewritten to the
 * auxiliary's backing basis column so the auxiliary's module serves it through the
 * existing access-path surface. The join-back is a **semi-join** on the logical
 * primary key, which preserves the body's output attributes exactly (D4) and
 * needs the auxiliary to be total over the logical key (the motivating nd-tree
 * fixture is). No match / not routable ⇒ `null` (degrade — the marker survives as
 * a transparent pass-through, D5).
 *
 * v1 scope: routes one **function-predicate** (exotic) match per firing; comparison
 * forms (`equality`/`range`) the matcher also surfaces are deferred to the primary
 * body's own pushdown (D2) and logged, not routed here.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { AliasNode } from '../../nodes/alias-node.js';
import { AssertedKeysNode } from '../../nodes/asserted-keys-node.js';
import { LensAuxiliaryAccessNode } from '../../nodes/lens-auxiliary-access-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { matchAccessForms, type MatchedAuxiliaryPath } from './lens-access-form-matcher.js';
import type { AuxJoinPair } from '../../nodes/lens-auxiliary-access-node.js';
import type { ScalarType } from '../../../common/datatype.js';
import type { Scope } from '../../scopes/scope.js';
import type * as AST from '../../../parser/ast.js';

const log = createLogger('optimizer:rule:lens-auxiliary-access');

/** Walk through pass-through wrappers (Alias / AssertedKeys) to the marker, or null. */
function findMarker(node: RelationalPlanNode): LensAuxiliaryAccessNode | null {
	if (node instanceof LensAuxiliaryAccessNode) return node;
	if (node instanceof AliasNode || node instanceof AssertedKeysNode) {
		return findMarker(node.source);
	}
	return null;
}

/** Rebuild the pass-through chain with the marker replaced by `replacement`. */
function replaceMarker(node: RelationalPlanNode, replacement: RelationalPlanNode): RelationalPlanNode {
	if (node instanceof LensAuxiliaryAccessNode) return replacement;
	if (node instanceof AliasNode || node instanceof AssertedKeysNode) {
		return node.withChildren([replaceMarker(node.source, replacement)]) as RelationalPlanNode;
	}
	return node;
}

/**
 * Whether every column reference in `fragment` resolves to `accessAttrId`. The
 * rewrite only re-points the matched access column at the auxiliary's backing
 * column and pushes the fragment below the semi-join onto the aux scan; any other
 * logical column it references (e.g. `nd_contains(coord, other)`) would dangle
 * there — the aux scan does not project it. Such a fragment is **not routable**
 * (it degrades to scan, the same graceful-degrade contract as an unrecognized
 * form), so we drop it before choosing a match rather than emit a broken plan.
 */
function fragmentConfinedToAccessColumn(fragment: ScalarPlanNode, accessAttrId: number): boolean {
	const stack: ScalarPlanNode[] = [fragment];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode && n.attributeId !== accessAttrId) return false;
		for (const c of n.getChildren()) stack.push(c as ScalarPlanNode);
	}
	return true;
}

/** Replace every ColumnReferenceNode to `fromAttrId` with `replacement` in a scalar subtree. */
function rewriteAttrRef(node: ScalarPlanNode, fromAttrId: number, replacement: ColumnReferenceNode): ScalarPlanNode {
	if (node instanceof ColumnReferenceNode) {
		return node.attributeId === fromAttrId ? replacement : node;
	}
	const children = node.getChildren();
	let changed = false;
	const newChildren = children.map(c => {
		const nc = rewriteAttrRef(c as ScalarPlanNode, fromAttrId, replacement);
		if (nc !== c) changed = true;
		return nc;
	});
	return changed ? (node.withChildren(newChildren) as ScalarPlanNode) : node;
}

function colRef(scope: Scope, ref: { attrId: number; columnIndex: number; type: ScalarType }, name: string): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name };
	return new ColumnReferenceNode(scope, expr, ref.type, ref.attrId, ref.columnIndex);
}

/** Build the AND-of-equalities semi-join condition over the logical-PK ↔ aux-key pairs. */
function buildJoinCondition(scope: Scope, pairs: readonly AuxJoinPair[]): ScalarPlanNode {
	const eqs = pairs.map(p => {
		const left = colRef(scope, p.logicalPk, 'pk');
		const right = colRef(scope, p.auxKey, 'auxkey');
		const expr: AST.BinaryExpr = { type: 'binary', operator: '=', left: left.expression, right: right.expression };
		return new BinaryOpNode(scope, expr, left, right) as ScalarPlanNode;
	});
	return combineConjuncts(eqs)!;
}

/**
 * Deterministically pick the routed match: function-predicate matches only (D2),
 * ordered by advertisement id then the conjunct's position, so >1 candidate auxiliary
 * resolves stably. Returns the chosen match and logs the rest.
 */
function chooseMatch(matches: readonly MatchedAuxiliaryPath[], conjuncts: readonly ScalarPlanNode[]): MatchedAuxiliaryPath | null {
	const routable = matches.filter(m => m.kind === 'function-predicate');
	if (routable.length === 0) {
		const deferred = matches.filter(m => m.kind === 'comparison');
		if (deferred.length > 0) {
			log('comparison-form match(es) on %s deferred to primary pushdown (v1, D2)', deferred.map(m => m.routable.advertisement.id).join(','));
		}
		return null;
	}
	const ordered = [...routable].sort((a, b) => {
		const byId = a.routable.advertisement.id.localeCompare(b.routable.advertisement.id);
		if (byId !== 0) return byId;
		return conjuncts.indexOf(a.predicateFragment) - conjuncts.indexOf(b.predicateFragment);
	});
	const chosen = ordered[0];
	for (const other of ordered.slice(1)) {
		if (other.routable.advertisement.id !== chosen.routable.advertisement.id || other.predicateFragment !== chosen.predicateFragment) {
			log('auxiliary %s form %s un-chosen (chose %s)', other.routable.advertisement.id, other.form, chosen.routable.advertisement.id);
		}
	}
	return chosen;
}

export function ruleLensAuxiliaryAccess(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;

	const marker = findMarker(filter.source);
	if (!marker) return null;

	// Normalize once, then operate entirely on the normalized conjuncts so the
	// matched fragment is one of the conjuncts we rebuild the residual from.
	const normalized = normalizePredicate(filter.predicate);
	const conjuncts = splitConjuncts(normalized);

	const matches = matchAccessForms(normalized, marker.routables)
		// A routable fragment must reference only its access column; anything else
		// would dangle when pushed below the semi-join onto the aux scan (degrade).
		.filter(m => fragmentConfinedToAccessColumn(m.predicateFragment, m.accessColumn.logicalAttrId));
	const chosen = chooseMatch(matches, conjuncts);
	if (!chosen) return null;

	const { routable, accessColumn, predicateFragment } = chosen;

	// Rewrite the access column in the matched fragment from the logical body's
	// attribute to the auxiliary's own backing-column attribute, then push it onto
	// the auxiliary scan (D3).
	const auxColumnRef = colRef(filter.scope, accessColumn.auxRef, accessColumn.logicalColumn);
	const rewrittenFragment = rewriteAttrRef(predicateFragment, accessColumn.logicalAttrId, auxColumnRef);
	const auxScanFiltered: RelationalPlanNode = new FilterNode(filter.scope, routable.auxScan, rewrittenFragment);

	// Semi-join the logical body (V = marker.source) back to the auxiliary seek on
	// the logical primary key. Semi preserves V's attributes, so the consumed
	// predicate's output shape is unchanged (D4).
	const condition = buildJoinCondition(filter.scope, routable.joinPairs);
	const semiJoin: RelationalPlanNode = new JoinNode(filter.scope, marker.source, auxScanFiltered, 'semi', condition);

	// Splice the semi-join in where the marker was (through any Alias/AssertedKeys
	// pass-throughs), and re-wrap any residual conjuncts as a Filter above it.
	const rewrittenSource = replaceMarker(filter.source, semiJoin);
	const residual = combineConjuncts(conjuncts.filter(c => c !== predicateFragment));

	log('routed predicate via auxiliary %s (form %s, column %s)', routable.advertisement.id, chosen.form, accessColumn.logicalColumn);

	if (residual) {
		return new FilterNode(filter.scope, rewrittenSource, residual);
	}
	return rewrittenSource;
}
