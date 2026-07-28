/**
 * Rule: Subquery Decorrelation
 *
 * Transforms EXISTS and IN subqueries in WHERE-clause FilterNode predicates
 * into equivalent semi/anti joins, enabling hash join selection and
 * eliminating per-row re-execution (correlated) or set-probe evaluation
 * (uncorrelated) of the inner query.
 *
 * Transformations:
 *   Filter[EXISTS(correlated)](outer)  →  SemiJoin[corr_pred](outer, inner)
 *   Filter[NOT EXISTS(correlated)](outer) → AntiJoin[corr_pred](outer, inner)
 *   Filter[col IN (correlated subquery)](outer) → SemiJoin[col = inner.col](outer, inner)
 *   Filter[col IN (uncorrelated subquery)](outer) → SemiJoin[col = inner.col0](outer, inner)
 *
 * Applicability:
 * - FilterNode with top-level ExistsNode, NOT ExistsNode, or InNode (subquery variant)
 * - Correlated arms: subquery references outer attributes and the correlation
 *   predicate is a simple equi-join condition (col = col across inner/outer)
 * - Uncorrelated IN arm: bare outer column on the left of IN, deterministic
 *   read-only inner, hashable synthesized equi-pair, and agreeing IN/`=`
 *   collation resolutions (see `extractUncorrelatedIn`). The inner tree is used
 *   VERBATIM as the join's right side — no descent, so inner LIMIT / DISTINCT /
 *   set-ops / CTE bodies are preserved as-is.
 *
 * Why the uncorrelated IN rewrite is sound in WHERE position ONLY: `x IN S` is
 * three-valued — it yields NULL (not FALSE) when `x` is NULL, or when there is
 * no match and `S` contains a NULL. A FilterNode predicate collapses NULL to
 * "drop the row", and a semi join also drops a row with no match (NULL never
 * equals under `=`), so under a WHERE filter the two agree on every case.
 * Projection-position IN must keep its three-valued answer and stays on the
 * runtime set-probe path (`emitIn`), which also remains the fallback whenever
 * any gate declines.
 *
 * NOT IN is deferred due to NULL semantics complexity (the parser builds it as
 * UnaryOp(NOT) over the InNode, so it never matches these top-level-conjunct
 * shapes).
 *
 * A SECOND ANCHOR (`ruleExistsInSelectDecorrelation`, ProjectNode) handles the
 * same subqueries appearing in a SELECT list, where a semi/anti join cannot be
 * used (every outer row must survive, with the match reported as a column).
 * Each recognized subquery becomes a LEFT join carrying an `exists right as`
 * match flag (`ExistenceColumnSpec`), and the subquery node in the projection
 * is replaced by a reference to the flag column. See the section header further
 * down for the fan-out and IN NULL-semantics gates.
 */

import { createLogger } from '../../../common/logger.js';
import type { ScalarPlanNode, RelationalPlanNode, Attribute } from '../../nodes/plan-node.js';
import { isRelationalNode, PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode, type JoinType } from '../../nodes/join-node.js';
import { EXISTENCE_FLAG_TYPE } from '../../nodes/join-utils.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { ExistsNode, InNode } from '../../nodes/subquery.js';
import { UnaryOpNode } from '../../nodes/scalar.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { isCorrelatedSubquery, collectExternalReferences } from '../../cache/correlation-detector.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { isEquiCorrelation, collectDefinedAttrIds, referencesAnyAttr } from '../../analysis/equi-correlation.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { extractEquiPairs } from '../join/equi-pair-extractor.js';
import { resolveComparisonCollation, resolveInCollationForNode } from '../../analysis/comparison-collation.js';

const log = createLogger('optimizer:rule:subquery-decorrelation');

interface DecorrelationCandidate {
	/** The EXISTS/IN node (or NOT EXISTS) */
	subqueryNode: ExistsNode | InNode;
	/** 'semi' or 'anti' */
	joinType: JoinType;
	/**
	 * True for the uncorrelated filter-position IN arm: the subquery tree is used
	 * verbatim as the join's right side via `extractUncorrelatedIn` instead of the
	 * correlation-lifting `extractInCorrelation` descent.
	 */
	uncorrelatedIn?: boolean;
}

/**
 * Identify a decorrelation candidate from a single conjunct.
 */
function identifyCandidate(node: ScalarPlanNode): DecorrelationCandidate | null {
	// EXISTS(subquery)
	if (node instanceof ExistsNode) {
		if (isCorrelatedSubquery(node.subquery)) {
			return { subqueryNode: node, joinType: 'semi' };
		}
		return null;
	}

	// NOT EXISTS(subquery)
	if (node instanceof UnaryOpNode && node.expression.operator === 'NOT') {
		if (node.operand instanceof ExistsNode) {
			const exists = node.operand;
			if (isCorrelatedSubquery(exists.subquery)) {
				return { subqueryNode: exists, joinType: 'anti' };
			}
		}
		return null;
	}

	// col IN (subquery) — correlated and uncorrelated take different extractions
	if (node instanceof InNode && node.source && !node.values) {
		if (isCorrelatedSubquery(node.source)) {
			return { subqueryNode: node, joinType: 'semi' };
		}
		// Uncorrelated filter-position IN: semi join ≡ IN under WHERE's NULL
		// collapse (see the rule header). Gates live in extractUncorrelatedIn;
		// any decline leaves the InNode on the runtime set-probe path.
		return { subqueryNode: node, joinType: 'semi', uncorrelatedIn: true };
	}

	return null;
}

/**
 * For an EXISTS subquery, extract the inner relational source and separate
 * the correlation predicate from inner-only predicates.
 *
 * The subquery tree is typically:
 *   Project → Filter[mixed_predicates] → inner_scan
 * or just:
 *   Filter[mixed_predicates] → inner_scan
 * or the predicates may be pushed into a Retrieve.
 *
 * We walk down through Project nodes (which don't affect the relational shape
 * for EXISTS) and look for FilterNode(s) that contain correlation conditions.
 */
function extractExistsCorrelation(
	subqueryRoot: RelationalPlanNode,
	outerAttrIds: Set<number>
): {
	innerSource: RelationalPlanNode;
	correlationCondition: ScalarPlanNode;
	residualInnerFilter: ScalarPlanNode | null;
} | null {
	// Walk through Project nodes to find the core relation
	let current: RelationalPlanNode = subqueryRoot;

	// Skip Project and Alias nodes (EXISTS doesn't care about projection or aliasing)
	while (current.nodeType === PlanNodeType.Project || current.nodeType === PlanNodeType.Alias) {
		const children = current.getChildren();
		const source = children[0];
		if (!isRelationalNode(source)) break;
		current = source;
	}

	// Now we expect a FilterNode with the correlation condition
	if (!(current instanceof FilterNode)) {
		// No filter found — correlation may be embedded deeper (not a simple pattern)
		return null;
	}

	const filter = current;
	const innerSource = filter.source;
	const innerAttrIds = collectDefinedAttrIds(innerSource);

	// Split predicate into conjuncts and classify each
	const conjuncts = splitConjuncts(filter.predicate);
	const correlationConjuncts: ScalarPlanNode[] = [];
	const innerOnlyConjuncts: ScalarPlanNode[] = [];

	for (const conj of conjuncts) {
		if (isEquiCorrelation(conj, outerAttrIds, innerAttrIds)) {
			correlationConjuncts.push(conj);
		} else {
			innerOnlyConjuncts.push(conj);
		}
	}

	if (correlationConjuncts.length === 0) {
		// No simple equi-correlation found
		return null;
	}

	// Safety: residual inner-only conjuncts must not still reference outer
	// attributes. If they do (e.g. a correlated predicate that didn't match
	// the strict equi-pattern, such as `outer.x = cast(inner.y as real)` or
	// `outer.x > inner.y`), decorrelation cannot be safely applied without
	// preserving the correlation, so abort.
	for (const conj of innerOnlyConjuncts) {
		if (referencesAnyAttr(conj, outerAttrIds)) return null;
	}

	const correlationCondition = combineConjuncts(correlationConjuncts)!;
	const residualInnerFilter = combineConjuncts(innerOnlyConjuncts);

	return { innerSource, correlationCondition, residualInnerFilter };
}

/**
 * For an IN subquery, extract the inner relational source and build the
 * equi-join condition (outer.col = inner.firstCol) plus any existing
 * correlation conditions within the subquery.
 */
function extractInCorrelation(
	inNode: InNode,
	outerAttrIds: Set<number>
): {
	innerSource: RelationalPlanNode;
	correlationCondition: ScalarPlanNode;
	residualInnerFilter: ScalarPlanNode | null;
} | null {
	if (!inNode.source) return null;

	// The IN condition references outer.col = inner.firstColumn
	// The IN subquery source may itself have correlated filters
	const subqueryRoot = inNode.source;

	// The left side of IN must be a column reference from the outer
	if (!(inNode.condition instanceof ColumnReferenceNode)) {
		// Non-column IN conditions are more complex; skip for now
		return null;
	}

	const outerColRef = inNode.condition;
	if (!outerAttrIds.has(outerColRef.attributeId)) {
		// The left side of IN doesn't reference the outer — unusual, skip
		return null;
	}

	// The inner subquery's first column is the comparison target
	const innerAttrs = subqueryRoot.getAttributes();
	if (innerAttrs.length === 0) return null;
	const innerFirstAttr = innerAttrs[0];

	// Build the equi-join condition: outer.col = inner.firstCol
	// We need a BinaryOpNode with = between the outer column ref and an inner column ref
	const innerColRef = new ColumnReferenceNode(
		outerColRef.scope,
		outerColRef.expression,  // reuse expression for formatting
		innerFirstAttr.type,
		innerFirstAttr.id,
		0 // column index in the inner relation
	);

	const equiCondition = new BinaryOpNode(
		outerColRef.scope,
		{ type: 'binary', operator: '=', left: outerColRef.expression, right: innerColRef.expression },
		outerColRef,
		innerColRef
	);

	// Walk through the subquery to find any additional correlation filters
	let current: RelationalPlanNode = subqueryRoot;

	// Skip Project and Alias nodes
	while (current.nodeType === PlanNodeType.Project || current.nodeType === PlanNodeType.Alias) {
		const children = current.getChildren();
		const source = children[0];
		if (!isRelationalNode(source)) break;
		current = source;
	}

	// If there's a filter with additional correlation, extract it
	if (current instanceof FilterNode) {
		const innerAttrIds = collectDefinedAttrIds(current.source);
		const conjuncts = splitConjuncts(current.predicate);
		const additionalCorrelation: ScalarPlanNode[] = [];
		const innerOnly: ScalarPlanNode[] = [];

		for (const conj of conjuncts) {
			if (isEquiCorrelation(conj, outerAttrIds, innerAttrIds)) {
				additionalCorrelation.push(conj);
			} else {
				innerOnly.push(conj);
			}
		}

		// Safety: residual inner-only conjuncts must not still reference outer
		// attributes. See note in extractExistsCorrelation.
		for (const conj of innerOnly) {
			if (referencesAnyAttr(conj, outerAttrIds)) return null;
		}

		const allCorrelation = [equiCondition, ...additionalCorrelation];
		const correlationCondition = combineConjuncts(allCorrelation)!;
		const residualInnerFilter = combineConjuncts(innerOnly);

		return {
			innerSource: current.source,
			correlationCondition,
			residualInnerFilter,
		};
	}

	// No inner filter — the only correlation is the IN condition itself
	return {
		innerSource: current,
		correlationCondition: equiCondition,
		residualInnerFilter: null,
	};
}

interface UncorrelatedInRewrite {
	/**
	 * `inNode.source`, verbatim — no descent through Project/Alias, so the first
	 * output attribute is exposed by construction, no inner predicate can be
	 * dropped, and an inner LIMIT / DISTINCT / set-op / CTE body is preserved
	 * as-is.
	 */
	right: RelationalPlanNode;
	/** The synthesized `outer.col = right.col0` equi-join condition. */
	condition: ScalarPlanNode;
}

/**
 * Recognize an uncorrelated filter-position `col IN (subquery)` and build the
 * semi-join right side + condition. Every gate declines to `null`, leaving the
 * InNode on the runtime set-probe path (`emitIn`) — the O(K + N·log K) floor;
 * a decline only costs the better plan, never correctness.
 */
function extractUncorrelatedIn(
	inNode: InNode,
	outerAttrIds: Set<number>
): UncorrelatedInRewrite | null {
	const right = inNode.source;
	if (!right) return null;

	// Gate: bare outer column on the left of IN. A non-column left side would
	// fail the equi-pair gate below anyway; requiring it up front keeps the
	// decline reason in one place.
	if (!(inNode.condition instanceof ColumnReferenceNode)) return null;
	const outerColRef = inNode.condition;
	if (!outerAttrIds.has(outerColRef.attributeId)) return null;

	// Gate: mirror the runtime set probe's own admission (emitIn's uncorrelated
	// arm requires a functional source) so the two paths accept the same shapes.
	// A non-deterministic inner must keep its per-outer-row evaluation
	// semantics; side effects were already refused by the caller.
	if (!PlanNodeCharacteristics.isFunctional(right)) return null;

	// Build-time validation guarantees an IN subquery exposes exactly one column.
	const innerAttr = right.getAttributes()[0];
	if (!innerAttr) return null;

	// Synthesize `outer.col = inner.col0`, giving the inner reference its OWN
	// AST rather than reusing the outer column's expression (which is why the
	// correlated arm's condition renders as the nonsense `a.x = a.x` in EXPLAIN).
	const innerColRef = new ColumnReferenceNode(
		outerColRef.scope,
		{ type: 'column', name: innerAttr.name },
		innerAttr.type,
		innerAttr.id,
		0 // column index in the inner relation
	);
	const condition = new BinaryOpNode(
		outerColRef.scope,
		{ type: 'binary', operator: '=', left: outerColRef.expression, right: innerColRef.expression },
		outerColRef,
		innerColRef
	);

	// Gate (the O(N×K)-floor guardrail): the synthesized condition must survive
	// the SAME extraction rule-join-physical-selection uses, as exactly one
	// equi-pair with no residual. That is that rule's only structural
	// precondition, so the join always reaches its hash/merge/NL cost
	// comparison with a usable hashable pair — the inner side is materialized
	// once (hash build) rather than re-driven per outer row. This also folds in
	// the collation-conflict and semantic-ordering-agreement declines (a mixed
	// TIMESPAN/TEXT pair keeps the set-probe path, whose semanticKeyTransform
	// handles it).
	// NOTE: nested loop can still win the cost comparison when the OUTER is
	// tiny (L ≤ ~2 under current COST_CONSTANTS); rule-nested-loop-right-cache
	// then wraps the uncorrelated right in a CacheNode whose abandon threshold
	// is the subject of backlog/bug-cache-threshold-abandon-cliff. A one-row
	// outer scanning the inner once is not a cliff, so that interaction is
	// confined to the harmless quadrant.
	const rightAttrIds = new Set(right.getAttributes().map(a => a.id));
	const extraction = extractEquiPairs(condition, outerAttrIds, rightAttrIds);
	if (!extraction || extraction.equiPairs.length !== 1 || extraction.residual) return null;

	// Gate: the IN membership collation and the synthesized `=`'s collation
	// must both resolve (no conflict) to the SAME name — a divergence would
	// silently change which rows match. `inRhsTypes` reduces a subquery RHS to
	// its single output column's type, the same operand pair the `=` sees, so
	// agreement is expected; assert it rather than assume it.
	const inResolution = resolveInCollationForNode(inNode);
	const eqResolution = resolveComparisonCollation(inNode.condition.getType(), innerAttr.type);
	if (inResolution.kind !== 'resolved' || eqResolution.kind !== 'resolved'
		|| inResolution.name !== eqResolution.name) {
		return null;
	}

	return { right, condition };
}

/**
 * Decorrelate the first rewritable EXISTS/IN conjunct of one FilterNode.
 * Returns the semi/anti join (with any remaining conjuncts re-wrapped in a
 * FilterNode above it), or null when no conjunct rewrites.
 */
function decorrelateOneConjunct(node: FilterNode): PlanNode | null {
	const outerSource = node.source;
	const outerAttrIds = new Set(outerSource.getAttributes().map(a => a.id));

	// Split the filter predicate into conjuncts
	const conjuncts = splitConjuncts(node.predicate);

	for (let i = 0; i < conjuncts.length; i++) {
		const candidate = identifyCandidate(conjuncts[i]);
		if (!candidate) continue;

		// Decorrelating EXISTS/IN into a semi/anti join changes how many times the
		// inner subquery's subtree executes (per outer row → once per matching outer
		// row in the semi-join driver). Refuse on impure inners so DML-bearing
		// subqueries keep their declared per-row firing.
		const innerRoot = candidate.subqueryNode instanceof ExistsNode
			? candidate.subqueryNode.subquery
			: (candidate.subqueryNode as InNode).source;
		if (innerRoot && PlanNodeCharacteristics.subtreeHasSideEffects(innerRoot)) {
			log('Decorrelation skipped: inner subquery has side effects');
			continue;
		}

		log('Found %s decorrelation candidate in filter predicate', candidate.joinType);

		// Extract the join right side and condition based on the candidate arm
		let joinRight: RelationalPlanNode;
		let joinCondition: ScalarPlanNode;

		if (candidate.uncorrelatedIn) {
			const rewrite = extractUncorrelatedIn(candidate.subqueryNode as InNode, outerAttrIds);
			if (!rewrite) {
				log('Uncorrelated IN gates declined; conjunct keeps the set-probe path');
				continue;
			}
			joinRight = rewrite.right;
			joinCondition = rewrite.condition;
		} else {
			const extraction = candidate.subqueryNode instanceof ExistsNode
				? extractExistsCorrelation(candidate.subqueryNode.subquery, outerAttrIds)
				: extractInCorrelation(candidate.subqueryNode as InNode, outerAttrIds);
			if (!extraction) {
				log('Could not extract simple equi-correlation; skipping conjunct');
				continue;
			}
			// If there are residual inner-only predicates, wrap the inner in a FilterNode
			joinRight = extraction.residualInnerFilter
				? new FilterNode(extraction.innerSource.scope, extraction.innerSource, extraction.residualInnerFilter)
				: extraction.innerSource;
			joinCondition = extraction.correlationCondition;
		}

		// Build the semi/anti join
		const joinNode = new JoinNode(
			outerSource.scope,
			outerSource,
			joinRight,
			candidate.joinType,
			joinCondition
		);

		log('Decorrelated %s subquery into %s JOIN', candidate.subqueryNode.nodeType, candidate.joinType.toUpperCase());

		// If there are remaining conjuncts in the original filter, wrap in a new FilterNode
		const remainingConjuncts = conjuncts.filter((_, j) => j !== i);
		if (remainingConjuncts.length > 0) {
			const residualPredicate = combineConjuncts(remainingConjuncts)!;
			return new FilterNode(node.scope, joinNode, residualPredicate);
		}

		return joinNode;
	}

	return null;
}

export function ruleSubqueryDecorrelation(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof FilterNode)) return null;

	// The engine never re-offers a rule its own output (see pass.ts), so loop
	// internally: each iteration decorrelates ONE conjunct, and a residual
	// FilterNode output feeds the next iteration. Two IN conjuncts in one WHERE
	// thus become two stacked semi joins (the second joins against the first as
	// its outer). Terminates: every successful iteration removes one conjunct.
	let result: PlanNode | null = null;
	let current: FilterNode = node;
	for (;;) {
		const rewritten = decorrelateOneConjunct(current);
		if (!rewritten) break;
		result = rewritten;
		if (!(rewritten instanceof FilterNode)) break;
		current = rewritten;
	}
	return result;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SELECT-list EXISTS / IN decorrelation (existence-flag left join)
 *
 * `select o.id, exists(select 1 from c where c.fk = o.k) as f from o` cannot
 * become a semi join (that would drop non-matching outer rows); instead each
 * recognized correlated EXISTS / IN in a ProjectNode's expressions becomes a
 * LEFT join carrying an `exists right as` match flag (`ExistenceColumnSpec`),
 * and the subquery node is replaced by a reference to the flag column:
 *
 *   Project[ o.id, <flag ref> AS f ]
 *     LeftJoin[ c.fk = o.k ] exists right as <flag>
 *       o
 *       Distinct(Project[key cols](Filter(residual, c)))
 *
 * Fan-out: `emitLoopJoin` drives the flag join as a plain left join, so K
 * matching inner rows would duplicate the outer row K times. EXISTS only cares
 * about presence, so the inner side is collapsed to at most one row per
 * correlation key: an attribute-id-preserving projection onto the key columns
 * under a DISTINCT. (`distinct-elimination` drops the DISTINCT again when the
 * key is already unique, and `nested-loop-right-cache` materializes the — now
 * uncorrelated — right side once.)
 *
 * NOT EXISTS / NOT IN need no special casing: the rewrite fires on the inner
 * ExistsNode/InNode and the enclosing NOT survives over the two-valued flag.
 *
 * IN NULL semantics: a projected `x IN S` is three-valued — it yields NULL
 * (not FALSE) when there is no match but x is NULL or S contains a NULL. The
 * flag is a clean two-valued boolean, so the rewrite is exact only when both
 * comparison sides are statically non-nullable; otherwise bail (the per-row
 * path keeps the NULL/unknown result). This also makes an enclosing NOT — the
 * NOT IN form — exact. EXISTS is two-valued and needs no such gate.
 * ──────────────────────────────────────────────────────────────────────── */

export function ruleExistsInSelectDecorrelation(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	const candidates = collectProjectionCandidates(node.projections.map(p => p.node));
	if (candidates.length === 0) return null;

	const outer = node.source;
	const outerAttrIds = new Set(outer.getAttributes().map(a => a.id));

	// One existence-flag LEFT join per recognized subquery, stacked left-deep in
	// collection order (the outer's attributes stay visible through every join,
	// so later candidates' correlations still resolve).
	let currentSource: RelationalPlanNode = outer;
	const replacements = new Map<ScalarPlanNode, ScalarPlanNode>();
	for (const cand of candidates) {
		const rewrite = decorrelateExistsInProjection(cand, outerAttrIds, currentSource);
		if (!rewrite) continue;
		currentSource = rewrite.join;
		replacements.set(cand, rewrite.flagRef);
	}
	if (replacements.size === 0) return null;

	log('Decorrelated %d SELECT-list EXISTS/IN subquery(ies) into existence-flag left join(s)', replacements.size);

	// Rebuild the projection over the join stack, preserving output attribute
	// ids so consumers above resolve unchanged (mirrors the scalar-agg rule's
	// rebuildProject). preserveInputColumns is threaded verbatim.
	const attributes = node.getAttributes();
	const newProjections = node.projections.map((p, i) => ({
		node: substituteInScalar(p.node, replacements),
		alias: p.alias,
		attributeId: attributes[i].id,
	}));
	return new ProjectNode(node.scope, currentSource, newProjections, undefined, attributes, node.preserveInputColumns);
}

/**
 * Collect correlated-decorrelation candidates (ExistsNode, or subquery-variant
 * InNode) across the projection expression trees, deduplicated by identity in
 * deterministic pre-order. A recognized node is a leaf for this walk — its
 * relational body is not descended (a nested subquery inside it stays part of
 * its branch).
 *
 * NOTE: dedup is by node identity only. Two *distinct* nodes with identical SQL
 * (`exists(...) as a, exists(...) as b` over the same body) each build their own
 * flag join; if such repeated correlated subqueries in one projection ever show
 * up as a cost, dedup by structural equality here to share a single join.
 */
function collectProjectionCandidates(exprs: readonly ScalarPlanNode[]): Array<ExistsNode | InNode> {
	const out: Array<ExistsNode | InNode> = [];
	const seen = new Set<ScalarPlanNode>();
	const walk = (expr: ScalarPlanNode): void => {
		if (expr instanceof ExistsNode || (expr instanceof InNode && expr.source && !expr.values)) {
			if (!seen.has(expr)) {
				seen.add(expr);
				out.push(expr);
			}
			return;
		}
		for (const child of expr.getChildren()) {
			if (child.getType().typeClass === 'scalar') {
				walk(child as ScalarPlanNode);
			}
		}
	};
	for (const expr of exprs) walk(expr);
	return out;
}

/**
 * Rebuild a scalar expression with each mapped node replaced by its substitute,
 * leaving wrappers (NOT, CASE, arithmetic) intact. Relational children (the
 * subquery bodies themselves) are never descended.
 */
function substituteInScalar(
	expr: ScalarPlanNode,
	replacements: ReadonlyMap<ScalarPlanNode, ScalarPlanNode>,
): ScalarPlanNode {
	const direct = replacements.get(expr);
	if (direct) return direct;

	const children = expr.getChildren();
	if (children.length === 0) return expr;

	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const child of children) {
		if (child.getType().typeClass === 'scalar') {
			const replaced = substituteInScalar(child as ScalarPlanNode, replacements);
			newChildren.push(replaced);
			if (replaced !== child) changed = true;
		} else {
			newChildren.push(child);
		}
	}
	if (!changed) return expr;
	return expr.withChildren(newChildren) as ScalarPlanNode;
}

/** Visit every ColumnReferenceNode in a scalar expression tree (scalar children only). */
function visitColumnRefs(node: ScalarPlanNode, visit: (ref: ColumnReferenceNode) => void): void {
	if (node instanceof ColumnReferenceNode) {
		visit(node);
		return;
	}
	for (const child of node.getChildren()) {
		if (child.getType().typeClass === 'scalar') {
			visitColumnRefs(child as ScalarPlanNode, visit);
		}
	}
}

/**
 * Attempt to decorrelate one SELECT-list EXISTS/IN subquery into an
 * existence-flag LEFT join over `leftSource`. Returns null (leaving the
 * subquery on the per-row path) when any recognition or safety gate fails.
 * Never mutates the original tree.
 */
function decorrelateExistsInProjection(
	cand: ExistsNode | InNode,
	outerAttrIds: Set<number>,
	leftSource: RelationalPlanNode,
): { join: JoinNode; flagRef: ColumnReferenceNode } | null {
	const subqueryRoot = cand instanceof ExistsNode ? cand.subquery : cand.source;
	if (!subqueryRoot) return null;

	// Correlated, and every external reference resolves to the immediate outer —
	// deeper correlation cannot be captured by a join against `leftSource`.
	const external = collectExternalReferences(subqueryRoot);
	if (external.size === 0) return null;
	for (const id of external) {
		if (!outerAttrIds.has(id)) return null;
	}

	// Per-row firing of a side-effecting inner is contractually observable.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(subqueryRoot)) return null;

	// IN three-valued-logic gate: both comparison sides must be non-nullable for
	// the two-valued flag to be exact (see the section header).
	if (cand instanceof InNode) {
		if (!(cand.condition instanceof ColumnReferenceNode)) return null;
		if (cand.condition.getType().nullable) return null;
		const innerAttrs = subqueryRoot.getAttributes();
		if (innerAttrs.length === 0 || innerAttrs[0].type.nullable) return null;
	}

	const extraction = cand instanceof ExistsNode
		? extractExistsCorrelation(cand.subquery, outerAttrIds)
		: extractInCorrelation(cand, outerAttrIds);
	if (!extraction) return null;
	const { innerSource, correlationCondition, residualInnerFilter } = extraction;

	const filteredInner: RelationalPlanNode = residualInnerFilter
		? new FilterNode(innerSource.scope, innerSource, residualInnerFilter)
		: innerSource;

	// Inner-side correlation key columns: every non-outer column the join
	// condition references. Each must be a top-level column of the inner source;
	// an id the source does not expose (a deep-projected column, or an IN whose
	// first column is computed and so carries a fresh attribute id) cannot be
	// re-exposed by the key projection — bail.
	const innerAttrByIdx = new Map(filteredInner.getAttributes().map((a, i) => [a.id, { attr: a, index: i }]));
	const keyIds: number[] = [];
	const seenKeys = new Set<number>();
	visitColumnRefs(correlationCondition, ref => {
		if (!outerAttrIds.has(ref.attributeId) && !seenKeys.has(ref.attributeId)) {
			seenKeys.add(ref.attributeId);
			keyIds.push(ref.attributeId);
		}
	});
	if (keyIds.length === 0) return null;

	const keyAttrs: Attribute[] = [];
	const keyProjections: Array<{ node: ScalarPlanNode; attributeId: number }> = [];
	for (const id of keyIds) {
		const found = innerAttrByIdx.get(id);
		if (!found) return null;
		keyAttrs.push(found.attr);
		keyProjections.push({
			node: new ColumnReferenceNode(
				innerSource.scope,
				{ type: 'column', name: found.attr.name },
				found.attr.type,
				found.attr.id,
				found.index,
			),
			attributeId: found.attr.id,
		});
	}

	// Collapse the inner side to at most one row per correlation key (the
	// fan-out guard — see the section header). The key projection preserves the
	// correlation attribute ids, so the extracted condition serves verbatim as
	// the join condition.
	const keyProject = new ProjectNode(innerSource.scope, filteredInner, keyProjections, undefined, keyAttrs, false);
	const distinctRight = new DistinctNode(innerSource.scope, keyProject);

	// Correctness backstop: the built right side must be fully decorrelated (an
	// outer reference outside the extracted conjuncts would re-correlate it).
	if (collectExternalReferences(distinctRight).size !== 0) return null;

	const flagAttrId = PlanNode.nextAttrId();
	const flagName = `__exists_${flagAttrId}`;
	const join = new JoinNode(
		cand.scope,
		leftSource,
		distinctRight,
		'left',
		correlationCondition,
		undefined,
		[{ attrId: flagAttrId, name: flagName, side: 'right' }],
	);
	// The flag column sits after both sides in the join's output.
	const flagRef = new ColumnReferenceNode(
		cand.scope,
		{ type: 'column', name: flagName },
		EXISTENCE_FLAG_TYPE,
		flagAttrId,
		leftSource.getAttributes().length + keyAttrs.length,
	);

	log('Decorrelated SELECT-list %s subquery into existence-flag LEFT JOIN on %d key(s)',
		cand instanceof ExistsNode ? 'EXISTS' : 'IN', keyAttrs.length);
	return { join, flagRef };
}
