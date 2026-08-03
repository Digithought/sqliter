/**
 * Rule: Aggregate Predicate Pushdown
 *
 * Subsumes WHERE-on-group-by-column and HAVING-on-group-by-column. For a
 *   FilterNode(predicate, AggregateNode|StreamAggregateNode|HashAggregateNode)
 * each conjunct of `predicate` that references only GROUP-BY columns (or
 * columns FD-determined by them in the aggregate's output FDs) is rewritten
 * onto the aggregate's source attribute IDs and moved below the aggregate.
 * Conjuncts referencing aggregate outputs (sum/count/etc.), non-column
 * GROUP-BY expressions, or a correlated sub-query stay above.
 *
 * Aggregate output indices in `physical.fds` come exclusively from
 * bare-`ColumnReferenceNode` GROUP BYs (per `propagateAggregateFds`), so every
 * output column in the FD closure has a known source attribute and can be
 * rewritten.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode, Attribute } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { StreamAggregateNode } from '../../nodes/stream-aggregate.js';
import { HashAggregateNode } from '../../nodes/hash-aggregate.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { collectPredicateDependencies } from '../../analysis/predicate-dependencies.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { computeClosure } from '../../util/fd-utils.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:aggregate-predicate-pushdown');

type AnyAggregate = AggregateNode | StreamAggregateNode | HashAggregateNode;

function isAggregateNode(node: PlanNode): node is AnyAggregate {
	return node instanceof AggregateNode
		|| node instanceof StreamAggregateNode
		|| node instanceof HashAggregateNode;
}

export function ruleAggregatePredicatePushdown(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;
	if (!isAggregateNode(filter.source)) return null;

	const agg = filter.source;
	// Scalar aggregate (no GROUP BY): the predicate selects on the single output
	// row, so nothing is pushable.
	if (agg.groupBy.length === 0) return null;

	// Refuse to push when the aggregate's source carries a write — landing
	// extra predicates below would change which rows reach the side-effect
	// subtree (and could pre-filter rows that the aggregate's grouping never
	// would have rejected on their own).
	if (PlanNodeCharacteristics.subtreeHasSideEffects(agg.source)) {
		log('aggregate-predicate-pushdown skipped: aggregate source has side effects');
		return null;
	}

	const aggAttrs = agg.getAttributes();
	const sourceAttrs = agg.source.getAttributes();

	// Build the output → source mapping for bare-column GROUP BYs. Aggregate
	// output columns (indices ≥ groupCount) have no source mapping. Non-column
	// GROUP BY expressions (`group_${i}`) also have no source mapping.
	const outputToSource = new Map<number, { sourceAttrId: number; sourceColIdx: number }>();
	const groupByOutputIndices = new Set<number>();

	for (let i = 0; i < agg.groupBy.length; i++) {
		const gbExpr = agg.groupBy[i];
		if (!(gbExpr instanceof ColumnReferenceNode)) continue;
		const outAttrId = aggAttrs[i].id;
		const srcAttrId = gbExpr.attributeId;
		const srcIdx = agg.source.getAttributeIndex().get(srcAttrId) ?? -1;
		if (srcIdx < 0) continue;
		outputToSource.set(outAttrId, { sourceAttrId: srcAttrId, sourceColIdx: srcIdx });
		groupByOutputIndices.add(i);
	}

	if (outputToSource.size === 0) return null;

	// Map output attribute id → output column index, used to test FD closure
	// membership.
	const outAttrIdToIndex = new Map<number, number>();
	aggAttrs.forEach((a, i) => outAttrIdToIndex.set(a.id, i));

	// FD closure on the aggregate's output indices, seeded by the bare-column
	// GROUP BY output indices. With composite GROUP BYs and inherited source
	// FDs, this can widen `outputToSource` membership to FD-dependent columns
	// (which by `propagateAggregateFds`'s projection are themselves bare-column
	// GROUP BY outputs and therefore already in `outputToSource`).
	const aggFds = agg.physical.fds ?? [];
	const pushableOutputIndices = computeClosure(groupByOutputIndices, aggFds);

	// Normalize → split → partition conjuncts.
	const normalized = normalizePredicate(filter.predicate);
	const conjuncts = splitConjuncts(normalized);

	const pushable: ScalarPlanNode[] = [];
	const remaining: ScalarPlanNode[] = [];

	for (const conj of conjuncts) {
		if (isConjunctPushable(conj, outAttrIdToIndex, outputToSource, pushableOutputIndices)) {
			pushable.push(conj);
		} else {
			remaining.push(conj);
		}
	}

	if (pushable.length === 0) return null;

	// Rewrite pushable conjuncts: rebind output column refs to source ones.
	const rewrittenPushable = pushable.map(c => rewriteOutputToSource(c, outputToSource, sourceAttrs));
	const pushedPredicate = combineConjuncts(rewrittenPushable)!;

	const newSource = new FilterNode(agg.source.scope, agg.source, pushedPredicate);

	// Rebuild the aggregate over the filtered source, preserving attribute IDs.
	const newAgg = rebuildAggregate(agg, newSource);

	log('Pushed %d/%d conjunct(s) below %s', pushable.length, conjuncts.length, agg.nodeType);

	if (remaining.length === 0) {
		return newAgg;
	}
	const residualPredicate = combineConjuncts(remaining)!;
	return new FilterNode(filter.scope, newAgg, residualPredicate);
}

function isConjunctPushable(
	conj: ScalarPlanNode,
	outAttrIdToIndex: ReadonlyMap<number, number>,
	outputToSource: ReadonlyMap<number, { sourceAttrId: number; sourceColIdx: number }>,
	pushableOutputIndices: ReadonlySet<number>,
): boolean {
	const { direct, correlated } = collectPredicateDependencies(conj);

	// A conjunct whose sub-query operand correlates to anything is refused outright.
	// `splitConjuncts` cannot break an `or` (or a `case`) apart, so a single conjunct
	// can mix a pushable GROUP-BY reference with a correlated sub-query; pushing it
	// carries the correlated reference below the aggregate that defines the attribute
	// it reads, and the query dies with "No row context found for column …".
	// NOTE: this refuses a correlation onto a pushable GROUP BY column, which would in
	// principle be legal. Buying it back means teaching `rewriteOutputToSource` to
	// descend into relational children — it currently skips them, so the reference
	// inside the sub-query would keep pointing at the aggregate's OUTPUT attribute id
	// while the rest of the conjunct is rewritten onto source ids. See `remapOuterRefs`
	// in `rule-scalar-agg-decorrelation.ts` for a rewriter that does descend.
	if (correlated.size > 0) return false;

	if (direct.size === 0) {
		// Constant conjunct: safe to push (and safe to keep above too — pushing
		// reduces work below). Keep above to avoid spurious rule firings; the
		// rule only "fires" when there's a real column-driven push.
		return false;
	}
	for (const attrId of direct) {
		const idx = outAttrIdToIndex.get(attrId);
		if (idx === undefined) return false;
		if (!pushableOutputIndices.has(idx)) return false;
		// Every pushable index must have a source mapping for rewrite.
		if (!outputToSource.has(attrId)) return false;
	}
	return true;
}

function rewriteOutputToSource(
	expr: ScalarPlanNode,
	outputToSource: ReadonlyMap<number, { sourceAttrId: number; sourceColIdx: number }>,
	sourceAttrs: readonly Attribute[],
): ScalarPlanNode {
	if (expr instanceof ColumnReferenceNode) {
		const mapping = outputToSource.get(expr.attributeId);
		if (mapping === undefined) return expr;
		const srcAttr = sourceAttrs.find(a => a.id === mapping.sourceAttrId);
		// `sourceAttrs` was indexed against to build `outputToSource`; the lookup must hit.
		if (!srcAttr) return expr;
		return new ColumnReferenceNode(
			expr.scope,
			expr.expression,
			srcAttr.type,
			mapping.sourceAttrId,
			mapping.sourceColIdx,
		);
	}
	const children = expr.getChildren();
	if (children.length === 0) return expr;
	const newChildren: PlanNode[] = [];
	let changed = false;
	for (const c of children) {
		if (isRelationalNode(c)) {
			newChildren.push(c);
			continue;
		}
		const replaced = rewriteOutputToSource(c as ScalarPlanNode, outputToSource, sourceAttrs);
		newChildren.push(replaced);
		if (replaced !== c) changed = true;
	}
	if (!changed) return expr;
	return expr.withChildren(newChildren) as ScalarPlanNode;
}

function rebuildAggregate(agg: AnyAggregate, newSource: RelationalPlanNode): AnyAggregate {
	if (agg instanceof AggregateNode) {
		return new AggregateNode(
			agg.scope,
			newSource,
			agg.groupBy,
			agg.aggregates,
			undefined,
			agg.getAttributes(),
		);
	}
	if (agg instanceof StreamAggregateNode) {
		return new StreamAggregateNode(
			agg.scope,
			newSource,
			agg.groupBy,
			agg.aggregates,
			undefined,
			agg.getAttributes(),
		);
	}
	return new HashAggregateNode(
		agg.scope,
		newSource,
		agg.groupBy,
		agg.aggregates,
		undefined,
		agg.getAttributes(),
	);
}
