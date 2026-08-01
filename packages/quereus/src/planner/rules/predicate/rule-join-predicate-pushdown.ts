/**
 * Rule: Join Predicate Pushdown
 *
 * For a `FilterNode(predicate, JoinNode)`, each conjunct of `predicate` whose
 * column references all land on ONE side of the join is MOVED onto that side's
 * branch (wrapped as a `FilterNode` around `join.left` / `join.right`).
 * Cross-side conjuncts, and anything the refusals below reject, stay in a
 * residual Filter above the rebuilt join.
 *
 * Why this is sound — the null-extension argument. A side may receive a
 * conjunct exactly when that side's columns are NEVER null-extended in the
 * join's output (read straight off `buildJoinAttributes` in
 * `nodes/join-utils.ts`). For such a side, every output row carries that side's
 * genuine input values, so rejecting an input row before the join removes
 * precisely the output rows the conjunct would have removed after it. On a
 * null-extended side the two differ: `left join r … where r.date > 'x'` drops
 * the NULL-padded rows after the join, but pushing `r.date > 'x'` below would
 * KEEP them (the left row simply finds no match and is padded again).
 *
 * | joinType | null-extended side | conjuncts pushable to |
 * |----------|--------------------|-----------------------|
 * | `inner`  | neither            | left and right        |
 * | `cross`  | neither            | left and right        |
 * | `left`   | right              | left only             |
 * | `right`  | left               | right only            |
 * | `full`   | both               | neither — rule declines |
 * | `semi`   | n/a (output is left columns) | left only   |
 * | `anti`   | n/a (output is left columns) | left only   |
 *
 * For `semi`/`anti` the left-only restriction is moot in practice —
 * `buildJoinAttributes` returns only the left attributes, so a Filter above such
 * a join cannot reference a right column at all — but it is encoded anyway so
 * the table is exhaustive and the reasoning stays local.
 *
 * Attribution is a plain attribute-id set test: ids are minted per node instance
 * and are stable across this pass's rewrites, so a self-join's two branches
 * carry distinct ids, and a join's `exists … as` flag ids are in neither side's
 * set (a conjunct over a flag falls out as un-pushable with no special case).
 *
 * Refusals:
 * - A conjunct whose subtree references a RELATIONAL child (any subquery) is
 *   left above. The id collector descends through relational children too, so
 *   `exists (select 1 from x where x.a = e.id and x.b = t.id)` contributes `x`'s
 *   own ids — which belong to neither side — and the conjunct is declined. That
 *   descent is load-bearing: a scalar-only walk would see only `e.id` and push a
 *   conjunct onto the left branch where `t.id` does not resolve.
 * - A conjunct with NO column references (`where 1 = 1`, `where :p > 0`) stays
 *   above; pushing it buys nothing and would make the rule fire on plans it
 *   should leave alone.
 * - A non-functional conjunct (`random() < e.amount`) stays above — moving it
 *   below the join changes how many times it is evaluated.
 * - A branch whose subtree carries a write keeps ITS conjuncts above while the
 *   other branch still receives its own (per-branch refusal, unlike
 *   `rule-predicate-inference-equivalence`'s outright one).
 *
 * A pushed conjunct is MOVED, not copied. A redundant copy above would
 * re-evaluate per output row for no gain and, worse, make the rule
 * non-idempotent — it would find the same pushable conjunct on every visit.
 * With a move, a re-visit of the residual Filter finds nothing pushable and
 * returns null, which is the termination argument.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode, type JoinType } from '../../nodes/join-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:join-predicate-pushdown');

type JoinSide = 'left' | 'right';

/** The sides of `joinType` that are never null-extended in the output — see the header table. */
function pushableSides(joinType: JoinType): ReadonlySet<JoinSide> {
	switch (joinType) {
		case 'inner':
		case 'cross':
			return new Set<JoinSide>(['left', 'right']);
		case 'left':
		case 'semi':
		case 'anti':
			return new Set<JoinSide>(['left']);
		case 'right':
			return new Set<JoinSide>(['right']);
		case 'full':
			return new Set<JoinSide>();
		default:
			return new Set<JoinSide>();
	}
}

/**
 * Every attribute id any `ColumnReferenceNode` in `expr`'s WHOLE subtree names —
 * descending through relational children as well as scalar ones. See the
 * file-header refusal notes for why the relational descent is required.
 */
function collectSubtreeAttributeIds(expr: ScalarPlanNode): Set<number> {
	const ids = new Set<number>();
	// Iterative worklist so a deep predicate cannot overflow the native stack.
	const stack: PlanNode[] = [expr];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current instanceof ColumnReferenceNode) {
			ids.add(current.attributeId);
		}
		for (const child of current.getChildren()) {
			stack.push(child);
		}
	}
	return ids;
}

/** The single side `ids` lands entirely on, or null when it spans / escapes both. */
function attributeSide(
	ids: ReadonlySet<number>,
	leftIds: ReadonlySet<number>,
	rightIds: ReadonlySet<number>,
): JoinSide | null {
	let allLeft = true;
	let allRight = true;
	for (const id of ids) {
		if (!leftIds.has(id)) allLeft = false;
		if (!rightIds.has(id)) allRight = false;
		if (!allLeft && !allRight) return null;
	}
	// A self-join mints distinct ids per branch, so the two sets are disjoint and
	// a non-empty `ids` can satisfy at most one of these.
	if (allLeft) return 'left';
	if (allRight) return 'right';
	return null;
}

export function ruleJoinPredicatePushdown(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;
	const join = filter.source;
	if (!(join instanceof JoinNode)) return null;

	const sides = pushableSides(join.joinType);
	if (sides.size === 0) return null;

	const leftIds = new Set(join.left.getAttributes().map(a => a.id));
	const rightIds = new Set(join.right.getAttributes().map(a => a.id));

	const conjuncts = splitConjuncts(normalizePredicate(filter.predicate));

	let leftPush: ScalarPlanNode[] = [];
	let rightPush: ScalarPlanNode[] = [];
	const residual: ScalarPlanNode[] = [];

	for (const conj of conjuncts) {
		const ids = collectSubtreeAttributeIds(conj);
		// No column reference at all (`1 = 1`, `:p > 0`): nothing to gain below.
		if (ids.size === 0) {
			residual.push(conj);
			continue;
		}
		// Non-deterministic / write-bearing conjunct: moving it changes how many
		// times it is evaluated.
		if (!PlanNodeCharacteristics.isFunctional(conj)) {
			residual.push(conj);
			continue;
		}
		const side = attributeSide(ids, leftIds, rightIds);
		if (side === null || !sides.has(side)) {
			residual.push(conj);
			continue;
		}
		(side === 'left' ? leftPush : rightPush).push(conj);
	}

	// Per-branch side-effect refusal: a branch carrying a write keeps its own
	// conjuncts above while the other branch still receives its.
	if (leftPush.length > 0 && PlanNodeCharacteristics.subtreeHasSideEffects(join.left)) {
		log('join-predicate-pushdown: left branch has side effects; keeping its conjuncts above');
		residual.push(...leftPush);
		leftPush = [];
	}
	if (rightPush.length > 0 && PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('join-predicate-pushdown: right branch has side effects; keeping its conjuncts above');
		residual.push(...rightPush);
		rightPush = [];
	}

	if (leftPush.length === 0 && rightPush.length === 0) return null;

	const newLeft: RelationalPlanNode = leftPush.length > 0
		? new FilterNode(join.left.scope, join.left, combineConjuncts(leftPush)!)
		: join.left;
	const newRight: RelationalPlanNode = rightPush.length > 0
		? new FilterNode(join.right.scope, join.right, combineConjuncts(rightPush)!)
		: join.right;

	// `withChildren` (not `new JoinNode(...)`) so `existence` and `usingColumns`
	// thread through — a dropped existence spec strands every upstream reference
	// to the flag's attribute id.
	const newChildren: PlanNode[] = join.condition
		? [newLeft, newRight, join.condition]
		: [newLeft, newRight];
	const newJoin = join.withChildren(newChildren) as RelationalPlanNode;

	log('Pushed %d left + %d right conjunct(s) below %s join (%d residual)',
		leftPush.length, rightPush.length, join.joinType, residual.length);

	if (residual.length === 0) return newJoin;
	return new FilterNode(filter.scope, newJoin, combineConjuncts(residual)!);
}
