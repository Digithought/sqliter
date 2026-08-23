/**
 * Rule: Nested-Loop Right-Side Cache Injection
 *
 * Required Characteristics:
 * - Node is a logical JoinNode that survived physical selection — i.e. a
 *   nested-loop join (equi-joins were already lowered to hash/merge, which
 *   materialize their build side on their own).
 * - Join type is left-driven (`inner` / `left` / `cross` / `semi` / `anti`):
 *   the runtime re-opens the right pipeline once per left row
 *   (`emitLoopJoin.driveFromLeft`). `right` / `full` drive from the right and
 *   scan each side once, so caching their right side only wastes memory.
 * - Right side is pure (no side effects — that is the mutating-subquery-cache
 *   rule's job), deterministic, uncorrelated, and small enough to materialize.
 *
 * Applied When:
 * - A pure right side would otherwise be re-scanned N times, one full scan per
 *   left row. Wrapping it in a run-once CacheNode replays the buffer instead.
 *
 * Benefits: Turns N full right-side scans into one scan + N buffer replays —
 * decisive on a high-per-read-latency vtab where each reopen costs I/O.
 */

import { createLogger } from '../../../common/logger.js';
import { PlanNode } from '../../nodes/plan-node.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import type { OptContext } from '../../framework/context.js';
import { CacheNode } from '../../nodes/cache-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { TableAccessNode } from '../../nodes/table-access-nodes.js';
import { PlanNodeCharacteristics, CapabilityDetectors, CachingAnalysis } from '../../framework/characteristics.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';

const log = createLogger('optimizer:rule:nested-loop-right-cache');

/**
 * A CTE reference (NOT_MATERIALIZED CTEs re-emit an inlined sub-plan; recursive
 * refs stream from a working table) manages its own row-context lifetime as it
 * iterates. Eagerly materializing such a right side via a CacheNode drains and
 * tears that context down before the join's ON-condition reads it, producing a
 * runtime "no row context" error (and, for shared inlined scans, corrupting the
 * outer loop's own context). Caching a CTE-backed right side is also low value:
 * a materialized CTE is already a buffer, and a NOT_MATERIALIZED one re-scans
 * cheap local state. So skip any right side whose subtree touches CTE machinery.
 *
 * NOTE: this is a CacheNode/CTEReference runtime-emit interaction, not a
 * planner-only limitation — the sibling mutating-subquery-cache rule shares it
 * but rarely fires on CTE right sides. See the ticket handoff for the follow-up.
 */
const CTE_NODE_TYPES: ReadonlySet<PlanNodeType> = new Set([
	PlanNodeType.CTEReference,
	PlanNodeType.CTE,
	PlanNodeType.RecursiveCTE,
	PlanNodeType.InternalRecursiveCTERef,
]);

/** True iff `node` or any descendant is a CTE-machinery node (see above). */
function subtreeTouchesCte(node: PlanNode): boolean {
	const stack: PlanNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (CTE_NODE_TYPES.has(current.nodeType)) return true;
		for (const child of current.getChildren()) {
			stack.push(child);
		}
	}
	return false;
}

/**
 * Best available row estimate for the buffer the CacheNode would hold: the
 * LARGEST estimate anywhere in the right subtree.
 *
 * We can't just read `right.physical.estimatedRows`. Two gaps make the top of
 * the subtree read too low:
 *  - Not every node propagates the physical estimate. The single-source relays and
 *    the join family do (`physicalSourceRows`), but a set operation, an async
 *    gather, or a CTE reference in between still stamps nothing, so the subtree top
 *    can be `undefined` while the leaf underneath has a count.
 *  - An access leaf's `physical.estimatedRows` is the *table* row count, but the
 *    module's own access-plan estimate (getBestAccessPlan `rows`, the true "how
 *    many rows will this scan hand back" — e.g. a high-latency vtab reporting
 *    60000) lives only in `filterInfo.indexInfoOutput.estimatedRows`.
 * Taking the subtree max over both signals is a conservative upper bound that
 * keeps the memory gate sound (never under-counts a large source into a cache).
 *
 * NOTE: this over-estimates a large base scan that a selective Filter shrinks —
 * output rows may be few, yet the max reflects the pre-filter scan. That biases
 * toward NOT caching such a right side (a missed optimization, never a memory
 * hazard). If a real workload wants those cached, read the subtree top instead of
 * the max — the Filter's own physical estimate now carries the post-filter count.
 */
function estimateRightRows(node: PlanNode): number | undefined {
	let max: number | undefined;
	const consider = (rows: number | undefined): void => {
		if (rows !== undefined && Number.isFinite(rows)) {
			max = max === undefined ? rows : Math.max(max, rows);
		}
	};
	const stack: PlanNode[] = [node];
	while (stack.length > 0) {
		const current = stack.pop()!;
		consider(current.physical?.estimatedRows);
		if (current instanceof TableAccessNode) {
			consider(Number(current.filterInfo.indexInfoOutput.estimatedRows));
		}
		for (const child of current.getChildren()) {
			stack.push(child);
		}
	}
	return max;
}

/**
 * Would this join's right side be wrapped in a `CacheNode` by
 * {@link ruleNestedLoopRightCache}? The single source of truth for that
 * question: the rule below calls it and then builds the node, and
 * `rule-join-physical-selection` calls it to decide whether a plain nested loop
 * pays its inner side's first-row latency ONCE (cached: one open plus N buffer
 * replays) or once per outer row (uncached: N re-opens). Neither caller may
 * restate any of the gates.
 *
 * Every gate is a decline; the comments on each explain what it protects.
 */
export function canCacheNestedLoopRight(node: JoinNode, context: OptContext): boolean {
	// Driver gate: only the left-driven join types re-scan the right side.
	// `right` / `full` buffer the left side once and scan the right side once
	// (`emitLoopJoin.driveFromRight`), so caching their right side is pure waste.
	// NOTE: inner/left/cross fully drain the right per left row, so the run-once
	// cache (streamWithCache only retains its buffer once a consumer drains the
	// source to completion — see shared-cache.ts) fills on the first left row and
	// replays thereafter. Semi/anti `break` on the first match (emitLoopJoin
	// driveFromLeft), so a matched left row abandons the partial buffer and the
	// next row re-scans; their buffer only lands after the first *unmatched* left
	// row drains the right in full. Caching them is still never a regression
	// (same reopen count until the buffer fills, a win after), just data-dependent
	// rather than the guaranteed replay inner/cross/left get.
	if (node.joinType === 'right' || node.joinType === 'full') {
		return false;
	}

	const right = node.right;

	// Already cached (e.g. by cte / in-subquery / mutating-subquery cache).
	if (CapabilityDetectors.isCached(right) && right.isCached()) {
		return false;
	}

	// Purity gate: side effects are the mutating-subquery-cache rule's job.
	// Double-wrapping a write would change nothing and only burn memory.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(right)) {
		return false;
	}

	// Determinism gate: a non-deterministic right side (e.g. `random()`) must be
	// re-evaluated per left row to preserve today's observable behavior; caching
	// would freeze the first scan's values across every subsequent left row.
	if (!PlanNodeCharacteristics.isDeterministic(right)) {
		return false;
	}

	// Correlation gate: a right subtree that references left attributes (a
	// parameterized/lateral seek produced by predicate pushdown) is
	// re-parameterized per left row and MUST NOT be cached. Note the plain
	// `a JOIN b ON a.x > b.y` case is *uncorrelated*: the ON predicate is a
	// separate JoinNode.condition child, not inside the right subtree — so the
	// bare right access has no external refs and is cacheable.
	if (isCorrelatedSubquery(right)) {
		return false;
	}

	// CTE-safety gate: eagerly materializing a CTE-backed right side breaks the
	// join's row-context at runtime (see subtreeTouchesCte above).
	if (subtreeTouchesCte(right)) {
		return false;
	}

	// Size gate (memory safety): materializing an unbounded right side trades I/O
	// for memory. Respect the existing nested-loop caching threshold.
	const estimatedRows = estimateRightRows(right) ?? context.tuning.defaultRowEstimate;
	if (estimatedRows > context.tuning.join.maxRightRowsForCaching) {
		log('Right side too large to cache (%d rows > %d), skipping',
			estimatedRows, context.tuning.join.maxRightRowsForCaching);
		return false;
	}

	return true;
}

export function ruleNestedLoopRightCache(node: PlanNode, context: OptContext): PlanNode | null {
	// Only logical JoinNodes reach here uncached. By PostOptimization,
	// join-physical-selection has already converted every equi-join it wanted to
	// hash/merge (those materialize their build side), so any surviving logical
	// JoinNode IS a nested loop — the exact structural signal we need.
	if (!(node instanceof JoinNode)) {
		return null;
	}

	if (!canCacheNestedLoopRight(node, context)) {
		return null;
	}

	const right = node.right;

	log('Caching pure nested-loop right side (%s)', node.joinType);

	// Memory strategy + a CacheNode threshold (which degrades to pass-through
	// past its limit) mirrors the sibling mutating-subquery-cache rule. Spill is
	// unreachable under `canCacheNestedLoopRight`'s size gate (maxRightRowsForCaching <
	// cache.spillThreshold), so 'memory' is the only live choice here.
	const threshold = CachingAnalysis.getCacheThreshold(right);
	const cached = new CacheNode(right.scope, right, 'memory', threshold);

	// Reconstruct via withChildren, NOT the raw JoinNode constructor: withChildren
	// threads usingColumns AND existence through verbatim, so existence match-flag
	// columns survive the rebuild (the manual constructor drops `existence`).
	return node.withChildren(
		node.condition ? [node.left, cached, node.condition] : [node.left, cached],
	);
}
