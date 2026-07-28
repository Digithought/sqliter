/**
 * Rule: Join Physical Selection
 *
 * Required Characteristics:
 * - Node must be a logical JoinNode (not already a physical join)
 * - Node must have an equi-join predicate for hash/merge join consideration
 *
 * Applied When:
 * - Logical JoinNode with equi-join predicates where hash or merge join is cheaper than nested loop
 *
 * Benefits: Replaces O(n*m) nested loop with O(n+m) hash/merge join for equi-joins
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode, RelationalPlanNode, Attribute } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { BloomJoinNode, type EquiJoinPair } from '../../nodes/bloom-join-node.js';
import { MergeJoinNode } from '../../nodes/merge-join-node.js';
import { SortNode } from '../../nodes/sort.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { nestedLoopJoinCost, hashJoinCost, mergeJoinCost } from '../../cost/index.js';
import {
	extractEquiPairs,
	extractEquiPairsFromUsing,
	isOrderedOnEquiPairs,
	reorderEquiPairsForMerge,
} from './equi-pair-extractor.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:join-physical-selection');

/**
 * Create a SortNode that sorts a source on the equi-pair columns for this side.
 */
function createSortForEquiPairs(
	source: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	side: 'left' | 'right',
	scope: import('../../scopes/scope.js').Scope
): RelationalPlanNode {
	const attrs = source.getAttributes();
	const attrIndex = source.getAttributeIndex();
	const sortKeys = equiPairs.map(pair => {
		const attrId = side === 'left' ? pair.leftAttrId : pair.rightAttrId;
		const idx = attrIndex.get(attrId) ?? -1;
		const attr = attrs[idx];
		// Create a ColumnReferenceNode for this attribute
		const colRef = new ColumnReferenceNode(
			scope,
			{ type: 'column', table: '', name: attr.name, schema: '' },
			attr.type,
			attr.id,
			idx
		);
		return {
			expression: colRef as ScalarPlanNode,
			direction: 'asc' as const,
			nulls: undefined
		};
	});
	return new SortNode(scope, source, sortKeys);
}

export function ruleJoinPhysicalSelection(node: PlanNode, _context: OptContext): PlanNode | null {
	// Guard: only apply to logical JoinNode, not already-physical nodes
	if (!(node instanceof JoinNode)) return null;

	// A join exposing `exists … as` match flags stays the nested-loop JoinNode (the
	// only emitter that derives the flag bit); the physical Bloom/Merge variants do
	// not carry or emit the appended flag column, so converting would drop it. Read
	// half: existence joins forgo hash/merge selection — documented limitation.
	if (node.hasExistenceColumns) return null;

	const joinType = node.joinType;

	// Support INNER, LEFT, SEMI, and ANTI joins
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'semi' && joinType !== 'anti') return null;

	// Build attribute ID sets for left and right
	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const leftAttrIds = new Set(leftAttrs.map(a => a.id));
	const rightAttrIds = new Set(rightAttrs.map(a => a.id));

	// Try to extract equi-join pairs from condition (or USING)
	let extracted: { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null = null;

	if (node.condition) {
		extracted = extractEquiPairs(node.condition, leftAttrIds, rightAttrIds);
	} else if (node.usingColumns) {
		extracted = extractEquiPairsFromUsing(node.usingColumns, leftAttrs, rightAttrs);
	}

	if (!extracted || extracted.equiPairs.length === 0) return null;

	// Cost comparison: nested loop vs hash join vs merge join
	const leftRows = node.left.estimatedRows ?? 100;
	const rightRows = node.right.estimatedRows ?? 100;

	const nlCost = nestedLoopJoinCost(leftRows, rightRows);

	// Hash join cost: build side is the smaller input
	const buildRows = Math.min(leftRows, rightRows);
	const probeRows = Math.max(leftRows, rightRows);
	const hashCostValue = hashJoinCost(buildRows, probeRows);

	// Merge join is a candidate only when EVERY pair has matched declared
	// collations: merge needs both inputs physically ordered under the key's
	// comparison collation, and the ordering property is collation-blind — a
	// matched declared collation is what makes each input's advertised order
	// equal the merge comparator's order (see EquiJoinPair.collationsMatch).
	// Any mismatched pair ⇒ merge unavailable; hash vs nested-loop compete.
	// (Merging on just the matched subset would be sound but is deliberately
	// not attempted — rare shape, minimal-change tradeoff.)
	const mergeAvailable = extracted.equiPairs.every(p => p.collationsMatch);

	// Merge join cost: depends on whether inputs are already sorted.
	// Try reordering equi-pairs to match the source orderings first.
	let mergeEquiPairs = extracted.equiPairs;
	let leftOrdered = isOrderedOnEquiPairs(node.left, mergeEquiPairs, 'left');
	let rightOrdered = isOrderedOnEquiPairs(node.right, mergeEquiPairs, 'right');
	if ((!leftOrdered || !rightOrdered) && mergeEquiPairs.length > 1) {
		const reordered = reorderEquiPairsForMerge(mergeEquiPairs, node.left, node.right);
		if (reordered) {
			mergeEquiPairs = reordered;
			leftOrdered = true;
			rightOrdered = true;
		}
	}
	const mergeCostValue = mergeAvailable
		? mergeJoinCost(leftRows, rightRows, !leftOrdered, !rightOrdered)
		: Infinity;

	// Pick the cheapest physical join algorithm
	type JoinAlgo = 'nested-loop' | 'hash' | 'merge';
	let bestAlgo: JoinAlgo = 'nested-loop';
	let bestCost = nlCost;

	if (hashCostValue < bestCost) {
		bestAlgo = 'hash';
		bestCost = hashCostValue;
	}
	if (mergeCostValue < bestCost) {
		bestAlgo = 'merge';
		bestCost = mergeCostValue;
	}

	if (bestAlgo === 'nested-loop') {
		log('Nested loop cheapest (nl=%.2f, hash=%.2f, merge=%.2f) for %d x %d rows',
			nlCost, hashCostValue, mergeCostValue, leftRows, rightRows);
		return null;
	}

	log('Selecting %s join (nl=%.2f, hash=%.2f, merge=%.2f) for %d x %d rows',
		bestAlgo, nlCost, hashCostValue, mergeCostValue, leftRows, rightRows);

	// Preserve attribute IDs from the logical JoinNode
	const preserveAttrs = node.getAttributes().slice() as Attribute[];

	if (bestAlgo === 'merge') {
		// Build merge join, inserting SortNodes if needed
		let leftSource: RelationalPlanNode = node.left;
		let rightSource: RelationalPlanNode = node.right;

		if (!leftOrdered) {
			leftSource = createSortForEquiPairs(node.left, mergeEquiPairs, 'left', node.scope);
			log('Inserted left sort for merge join');
		}
		if (!rightOrdered) {
			rightSource = createSortForEquiPairs(node.right, mergeEquiPairs, 'right', node.scope);
			log('Inserted right sort for merge join');
		}

		return new MergeJoinNode(
			node.scope,
			leftSource,
			rightSource,
			joinType,
			mergeEquiPairs,
			extracted.residual,
			preserveAttrs
		);
	}

	// Hash join path
	// Determine build and probe sides: build=smaller, probe=larger
	// For LEFT JOIN, the left side MUST remain the probe side to preserve
	// null-padding semantics (all left rows must appear in output).
	let probeSource = node.left;
	let buildSource = node.right;
	let equiPairs = extracted.equiPairs;

	// For INNER join, swap sides if left is smaller (becomes build side).
	// For LEFT/SEMI/ANTI, left must remain probe to preserve semantics.
	// Refuse to swap when either side carries a write — flipping build/probe
	// reorders the user-visible execution order of side-effect subtrees.
	if (joinType === 'inner' && leftRows < rightRows
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.left)
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.right)) {
		// Swap: left becomes build, right becomes probe
		probeSource = node.right;
		buildSource = node.left;
		// Flip equi-pair directions; spread so the collation flags survive.
		equiPairs = extracted.equiPairs.map(p => ({
			...p,
			leftAttrId: p.rightAttrId,
			rightAttrId: p.leftAttrId
		}));
	}

	return new BloomJoinNode(
		node.scope,
		probeSource,
		buildSource,
		joinType,
		equiPairs,
		extracted.residual,
		preserveAttrs
	);
}
