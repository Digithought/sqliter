import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { hasSingletonFd } from '../../util/fd-utils.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { physicalSourceRows } from '../../util/row-estimates.js';

const log = createLogger('optimizer:rule:join-greedy-commute');

/** True when the relation provably emits at most one row. */
function isSingleton(node: RelationalPlanNode): boolean {
	const colCount = node.getAttributes().length;
	if (colCount === 0) return node.physical?.estimatedRows === 1;
	return hasSingletonFd(node.physical?.fds, colCount, node.getType().isSet);
}

/**
 * Rule: Join Greedy Commute
 *
 * Simple heuristic: for INNER joins, prefer the smaller input on the left to drive nested-loop-like cost.
 * This uses the children's PHYSICAL row estimates (influenced by pushdown/growth)
 * and swaps left/right when beneficial.
 *
 * Safety:
 * - INNER joins are commutative; ColumnReferenceNode uses attribute IDs, so swapping sides preserves semantics.
 * - We do NOT change associativity; we only commute immediate children of a JoinNode.
 */
export function ruleJoinGreedyCommute(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  if (node.joinType !== 'inner' && node.joinType !== 'cross') return null;

  // A correlated input (LATERAL referencing the other side) imposes an
  // evaluation order: the correlated side must be the driven (right) side so the
  // relation defining its outer references is in scope. Commuting would move it
  // to the outer position and break that correlation. Skip the swap in that case
  // — a ≤1-row correlated lateral (e.g. `LIMIT 1`) now advertises a singleton FD,
  // which would otherwise mark it as the preferred driver.
  if (isCorrelatedSubquery(node.getRightSource()) || isCorrelatedSubquery(node.getLeftSource())) {
    return null;
  }

  // Refuse to swap when either side carries a write — commuting an inner join
  // reorders the user-visible execution order of side-effect-bearing subtrees.
  if (PlanNodeCharacteristics.subtreeHasSideEffects(node.getLeftSource() as RelationalPlanNode)
    || PlanNodeCharacteristics.subtreeHasSideEffects(node.getRightSource() as RelationalPlanNode)) {
    log('join-greedy-commute skipped: a side has side effects');
    return null;
  }

  // Row counts come from the PHYSICAL property first. Table-backed inputs
  // (Alias / Retrieve / SeqScan / IndexScan …) declare no logical `estimatedRows`
  // getter — they stamp their catalog-derived count into `computePhysical` only —
  // so reading the logical getter here yields `undefined` for exactly the inputs
  // this arm exists to compare. `physicalSourceRows` reads the physical count and
  // falls back to the logical getter for nodes that only have that one.
  const left = node.getLeftSource();
  const right = node.getRightSource();
  const leftRows = physicalSourceRows(left.physical, left);
  const rightRows = physicalSourceRows(right.physical, right);

  // Detect a <=1 row driver on either side
  const leftIsSingleton = isSingleton(left);
  const rightIsSingleton = isSingleton(right);

  // An unknown estimate on either side must NOT trigger a swap: `undefined` means
  // nobody knows how big that side is (a never-analyzed table), and commuting on a
  // fabricated default row count is worse than leaving the written order alone.
  // Only the singleton-FD arm applies then.
  //
  // Strict `<`: equal estimates never swap, so a pass that re-runs this rule over
  // its own output cannot oscillate between the two orders.
  const rightIsSmaller = leftRows !== undefined && rightRows !== undefined && rightRows < leftRows;

  // If right is strictly better driver (smaller or singleton), swap
  const shouldSwap = (rightIsSingleton && !leftIsSingleton) || (!rightIsSingleton && !leftIsSingleton && rightIsSmaller);
  if (!shouldSwap) return null;

  log('Commuting join children to place smaller input on the left (leftRows=%s, rightRows=%s)', String(leftRows), String(rightRows));

  // Swap children; condition stays the same (attribute IDs are stable)
  const swapped = new JoinNode(
    node.scope,
    right,
    left,
    node.getJoinType(),
    node.getJoinCondition(),
    node.getUsingColumns()
  );

  return swapped;
}


