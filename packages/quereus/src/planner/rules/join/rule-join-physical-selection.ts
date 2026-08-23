/**
 * Rule: Join Physical Selection
 *
 * Required Characteristics:
 * - Node must be a logical JoinNode (not already a physical join)
 * - Node must have an equi-join predicate for hash/merge/index-NL consideration
 * - Neither side may read the other's columns (such a side must keep the
 *   nested-loop driver — hash/merge drain one side before the other's rows exist)
 *
 * Applied When:
 * - Logical JoinNode with equi-join predicates where hash join, merge join, or
 *   an index-nested-loop (per-outer-row seek into the inner side, built by
 *   `index-nested-loop.ts`) is cheaper than the plain nested loop
 *
 * Benefits: Replaces the O(n*m) nested loop with an O(n+m) hash/merge join, or
 * with an O(n·seek) index-nested-loop when one side's module can answer an
 * equality seek on the join key. For an INNER join the index-nested-loop is
 * offered in BOTH orientations (seek the right driven by the left, and the
 * mirror: seek the left driven by the right) and the cheaper wins — this rule
 * is the only place a two-table join's orientation can be decided with the
 * module's own seek-versus-scan answers in hand (`rule-join-greedy-commute`'s
 * row-count arm never fires for table-backed inputs, and QuickPick returns
 * immediately for fewer than three relations).
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
	isOrderedOnEquiPairs,
	reorderEquiPairsForMerge,
} from './equi-pair-extractor.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { readsColumnsOf } from '../../cache/correlation-detector.js';
import { physicalSourceRows } from '../../util/row-estimates.js';
import { tryIndexNestedLoop, type IndexNestedLoopCandidate } from './index-nested-loop.js';

const log = createLogger('optimizer:rule:join-physical-selection');

/** Flip every pair so left=old right / right=old left; spread keeps the collation flags. */
function mirrorEquiPairs(pairs: readonly EquiJoinPair[]): EquiJoinPair[] {
	return pairs.map(p => ({ ...p, leftAttrId: p.rightAttrId, rightAttrId: p.leftAttrId }));
}

/**
 * Whether the index-nested-loop may also be tried with the sides exchanged
 * (seek the LEFT input, drive from the right). Only a plain inner join
 * commutes: `left` / `semi` / `anti` are left-driven by definition (a mirrored
 * `left` join is a `right` join, which the emitter drives from the other
 * side); an `exists … as` join appends its flag columns after both sides with
 * a resolved `side` per flag, so a swap would have to flip and re-derive them
 * — excluded rather than attempted. A write in either subtree forbids the swap
 * because it reorders user-visible execution — the same refusal the hash
 * build/probe swap makes below.
 */
function mayMirrorIndexNestedLoop(node: JoinNode): boolean {
	return node.joinType === 'inner'
		&& !node.hasExistenceColumns
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.left)
		&& !PlanNodeCharacteristics.subtreeHasSideEffects(node.right);
}

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

export function ruleJoinPhysicalSelection(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: only apply to logical JoinNode, not already-physical nodes
	if (!(node instanceof JoinNode)) return null;

	const joinType = node.joinType;

	// Support INNER, LEFT, SEMI, and ANTI joins
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'semi' && joinType !== 'anti') return null;

	// Build attribute ID sets for left and right
	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const leftAttrIds = new Set(leftAttrs.map(a => a.id));
	const rightAttrIds = new Set(rightAttrs.map(a => a.id));

	// Try to extract equi-join pairs from the condition. A USING join has one too —
	// `buildUsingCondition` desugars it at build time — so there is no separate path.
	const extracted: { equiPairs: EquiJoinPair[]; residual: ScalarPlanNode | undefined } | null =
		extractEquiPairs(node.condition, leftAttrIds, rightAttrIds);

	if (!extracted || extracted.equiPairs.length === 0) return null;

	// A side that reads its sibling's columns must keep the nested-loop driver.
	// LATERAL is a parsed, supported join form, so `join lateral (…) on
	// <equality>` reaches this rule with a right side reading left columns —
	// converting it to a hash join raised "No row context found" at runtime.
	// This is also what makes the index-nested-loop rewrite below idempotent:
	// its own output seeks on left-side column references.
	if (readsColumnsOf(node.right, node.left) || readsColumnsOf(node.left, node.right)) {
		log('Declining: a join side reads its sibling\'s columns; nested-loop driver required');
		return null;
	}

	// Cost comparison: nested loop vs hash join vs merge join vs index-nested-loop.
	// Physical relay first: by PostOptimization both sides are physical access
	// nodes (or wrappers over them) which declare no logical `estimatedRows`
	// getter — the catalog-derived count lives in `physical.estimatedRows` (see
	// planner/util/row-estimates.ts). `||` not `??`: 0 is the un-analyzed
	// "unknown" sentinel, not "empty" (same collapse rule-select-access-path
	// applies), so an un-analyzed table costs exactly as it did under the old
	// logical-getter read (which yielded undefined → 100).
	const leftRows = physicalSourceRows(node.left.physical, node.left) || 100;
	const rightRows = physicalSourceRows(node.right.physical, node.right) || 100;

	const nlCost = nestedLoopJoinCost(leftRows, rightRows);

	// Index-nested-loop candidate: the logical JoinNode survives with its right
	// leaf replaced by a per-outer-row correlated IndexSeek. Considered BEFORE
	// the existence early-return below — index-NL keeps the nested-loop emitter
	// (the only one that derives `exists … as` flag bits) and `withChildren`
	// threads `existence` verbatim, so existence joins CAN take this path,
	// unlike hash/merge which drop the appended flag column.
	const indexNL = tryIndexNestedLoop(
		joinType, node.left, node.right, extracted.equiPairs, leftRows, context);

	// Mirrored candidate: seek the LEFT input, drive from the right. Whether a
	// table landed on the left or the right was decided long before anything
	// knew which side had a usable index, so the un-mirrored candidate alone can
	// read a whole table the join had a perfectly good index for. The cost
	// formula is linear in the outer row count, so this is fed `rightRows` —
	// the mirror is only cheap when the NEW outer is the small side.
	const mirroredNL: IndexNestedLoopCandidate | null = mayMirrorIndexNestedLoop(node)
		? tryIndexNestedLoop(
			'inner', node.right, node.left, mirrorEquiPairs(extracted.equiPairs), rightRows, context)
		: null;

	// Rebuild with the seek-bearing inner side, KEEPING the ON condition on the
	// join. It is redundant when the seek is exact, but it is the safety net
	// when the seek over-fetches (a COARSER_SAFE collation cover, a module
	// returning a superset) — and it costs one predicate evaluation per emitted
	// row, not per scanned row. `condition` is defined — equi pairs were
	// extracted from it above.
	const rebuildWithIndexNL = (): PlanNode => {
		log('Selecting index-nested-loop join (cost=%.2f) for %d outer rows', indexNL!.cost, leftRows);
		return node.withChildren([node.left, indexNL!.newInner, node.condition!]);
	};
	// The mirrored rebuild is a NEW JoinNode with the children exchanged —
	// `withChildren` re-uses the node's own slot order and cannot express the
	// swap. The ON condition and `usingColumns` carry over verbatim: both refer
	// to attributes by id, and `buildJoinAttributes` concatenates the two
	// sides' Attribute objects as-is (no `preserveAttributeIds` list is passed),
	// so the swap changes the join's attribute ORDER, never an attribute id.
	// Order is harmless: column references resolve by id at runtime, every
	// positional consumer derives its row descriptor from this node's own
	// `getAttributes()` at emit time, the nested-loop emitter yields
	// `[...leftRow, ...rightRow]` where "left" is now the old right on both
	// sides of that equation, and `JoinNode.computePhysical` advertises no
	// `ordering` — so no ancestor Sort was elided on the strength of the join's
	// emission order. What DOES change is the order rows come out in for a query
	// without ORDER BY, which is permitted (hash join already does it).
	// `existence` is omitted: `mayMirrorIndexNestedLoop` excludes flag joins.
	const rebuildWithMirroredNL = (): PlanNode => {
		log('Selecting mirrored index-nested-loop join (cost=%.2f) for %d outer rows (sides exchanged)',
			mirroredNL!.cost, rightRows);
		return new JoinNode(node.scope, node.right, mirroredNL!.newInner, 'inner',
			node.condition, node.usingColumns);
	};

	// A join exposing `exists … as` match flags stays the nested-loop JoinNode (the
	// only emitter that derives the flag bit); the physical Bloom/Merge variants do
	// not carry or emit the appended flag column, so converting would drop it. Read
	// half: existence joins forgo hash/merge selection — documented limitation.
	// Index-NL remains available (see above): only plain NL and index-NL compete.
	// (`mirroredNL` is null here — the mirror gate excludes existence joins.)
	if (node.hasExistenceColumns) {
		if (indexNL && indexNL.cost < nlCost) return rebuildWithIndexNL();
		return null;
	}

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

	// Hash and merge each scan the inner side once, so the inner subtree's
	// first-row latency is charged ONCE to each — locally here, not in the
	// shared cost functions (which other callers use latency-free). Index-NL's
	// formula charges it per outer row (per seek). Plain nested-loop's formula
	// is deliberately left alone: it is the no-change fallback, and if it wins
	// nothing is rewritten.
	//
	// NOTE: that last exemption biases against index-NL once a module reports a
	// nonzero `expectedLatencyMs` — plain NL re-opens the right side per outer
	// row too, so it pays the same per-seek latency but is charged none, and can
	// win a comparison against the strictly cheaper index-NL. Harmless today
	// (both shipped modules report 0). If a high-latency module appears, charge
	// plain NL `outerRows * latency` here rather than dropping it from index-NL.
	const rightLatencyMs = node.right.physical.expectedLatencyMs ?? 0;

	// Pick the cheapest physical join algorithm. Every comparison is a strict
	// `<` in this fixed order, so an exact tie keeps the earlier entry: in
	// particular two un-analyzed sides (both at the 100-row default) cost the
	// two index-NL orientations identically, and the un-mirrored one wins — a
	// plan must not flip its drive side on a coin toss.
	type JoinAlgo = 'nested-loop' | 'hash' | 'merge' | 'index-nl' | 'index-nl-mirrored';
	let bestAlgo: JoinAlgo = 'nested-loop';
	let bestCost = nlCost;

	if (hashCostValue + rightLatencyMs < bestCost) {
		bestAlgo = 'hash';
		bestCost = hashCostValue + rightLatencyMs;
	}
	if (mergeCostValue + rightLatencyMs < bestCost) {
		bestAlgo = 'merge';
		bestCost = mergeCostValue + rightLatencyMs;
	}
	if (indexNL && indexNL.cost < bestCost) {
		bestAlgo = 'index-nl';
		bestCost = indexNL.cost;
	}
	if (mirroredNL && mirroredNL.cost < bestCost) {
		bestAlgo = 'index-nl-mirrored';
		bestCost = mirroredNL.cost;
	}

	const COSTS = 'nl=%.2f, hash=%.2f, merge=%.2f, index-nl=%.2f, index-nl-mirrored=%.2f';
	const costArgs = [nlCost, hashCostValue, mergeCostValue, indexNL?.cost ?? Infinity, mirroredNL?.cost ?? Infinity];

	if (bestAlgo === 'nested-loop') {
		log(`Nested loop cheapest (${COSTS}) for %d x %d rows`, ...costArgs, leftRows, rightRows);
		return null;
	}

	if (bestAlgo === 'index-nl') {
		return rebuildWithIndexNL();
	}
	if (bestAlgo === 'index-nl-mirrored') {
		return rebuildWithMirroredNL();
	}

	log(`Selecting %s join (${COSTS}) for %d x %d rows`, bestAlgo, ...costArgs, leftRows, rightRows);

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

		// NOTE: merge takes `preserveAttrs` unpermuted because it never swaps its
		// sides — the sort wrappers preserve each child's attribute order, so
		// logical-left-then-right IS the emitted layout here. If merge ever grows a
		// side swap, it needs the same permutation the hash path does below.
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
	let hashAttrs = preserveAttrs;

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
		// INVARIANT: a physical join's advertised attribute order IS its emitted
		// row layout. `emitBloomJoin` yields `[...leftRow, ...rightRow]` — that is,
		// probe-then-build — and `getType()`, `combineJoinKeys` and
		// `computePhysical`'s `leftAttrs.length` FD shift all describe the row the
		// same way. So the preserved attributes must be permuted with the sides:
		// same attribute IDs (which is all `preserveAttributeIds` guarantees —
		// id stability, not position stability), new order. Skipping this makes
		// any positional consumer that maps attribute id → column index through
		// `getAttributes()` (e.g. `emitHashAggregate`'s scan row descriptor) read
		// the wrong slot and silently return wrong values.
		// The slice assumes `preserveAttrs` is exactly left++right, which the
		// `joinType === 'inner'` test here and the `hasExistenceColumns` return
		// above together guarantee — an existence join appends flag attributes
		// after both sides and would need them left in place.
		hashAttrs = [
			...preserveAttrs.slice(leftAttrs.length),
			...preserveAttrs.slice(0, leftAttrs.length),
		];
	}

	return new BloomJoinNode(
		node.scope,
		probeSource,
		buildSource,
		joinType,
		equiPairs,
		extracted.residual,
		hashAttrs
	);
}
