import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { checkFkPkAlignment } from '../../util/key-utils.js';
import { mapColumnsToTable, resolveTableColumnMapping } from '../../util/ind-utils.js';

const log = createLogger('optimizer:rule:join-key-inference');

/**
 * Rule: Join Key Inference
 *
 * Detects equi-join predicates and FK→PK relationships between join sides.
 * When an FK→PK alignment is found, the PK side's key is guaranteed to be
 * covered (each FK row matches ≤1 PK row), so computePhysical already handles
 * cardinality reduction. This rule logs the detection for diagnostics.
 *
 * `checkFkPkAlignment` speaks *base-table* column indices while the equi-pairs
 * carry each side's output column positions, so both are translated through
 * `resolveTableColumnMapping` first — the same translation the rules that act on
 * this alignment (`rule-join-elimination`, `rule-fanout-lookup-join`) perform.
 * The rule is diagnostic-only, but an untranslated comparison would make the log
 * line name joins that are not in fact FK joins.
 *
 * The real work happens in:
 * - analyzeJoinKeyCoverage (key-utils.ts): unique key preservation + estimatedRows
 * - CatalogStatsProvider.joinSelectivity: FK-aware selectivity = 1/ndv_pk
 */
export function ruleJoinKeyInference(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  if (node.joinType !== 'inner' && node.joinType !== 'cross') return null;

  const leftAttrs = node.left.getAttributes();
  const rightAttrs = node.right.getAttributes();
  const pairs = extractEquiPairsFromCondition(node.condition, leftAttrs, rightAttrs);
  if (pairs.length === 0) return null;

  // Check for FK→PK alignment
  const leftMapping = resolveTableColumnMapping(node.left as RelationalPlanNode);
  const rightMapping = resolveTableColumnMapping(node.right as RelationalPlanNode);

  if (leftMapping && rightMapping) {
    const leftTableCols = mapColumnsToTable(pairs.map(p => p.left), leftMapping);
    const rightTableCols = mapColumnsToTable(pairs.map(p => p.right), rightMapping);
    const leftSchema = leftMapping.schema;
    const rightSchema = rightMapping.schema;

    if (leftTableCols && rightTableCols) {
      if (checkFkPkAlignment(leftSchema, rightSchema, leftTableCols, rightTableCols)) {
        log('FK→PK detected: %s.FK → %s.PK; PK-side key covered by equi-join',
          leftSchema.name, rightSchema.name);
      } else if (checkFkPkAlignment(rightSchema, leftSchema, rightTableCols, leftTableCols)) {
        log('FK→PK detected: %s.FK → %s.PK; PK-side key covered by equi-join',
          rightSchema.name, leftSchema.name);
      }
    }
  }

  // No structural transformation needed — computePhysical handles key preservation
  return null;
}
