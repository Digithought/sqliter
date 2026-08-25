import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode } from '../../nodes/join-node.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:quickpick');

interface JoinPredicate {
  leftIndex: number;
  rightIndex: number;
  condition: ScalarPlanNode; // equi-predicate (or AND of equis) connecting the pair
}

interface JoinGraph {
  relations: RelationalPlanNode[];
  predicates: JoinPredicate[];
}

function extractJoinGraph(node: PlanNode): JoinGraph | null {
  // Flatten INNER/CROSS join subtree into leaves (relations) and equi-predicates between them
  const relations: RelationalPlanNode[] = [];
  const attrIdToRel = new Map<number, number>();
  const pairToConds = new Map<string, ScalarPlanNode[]>();

  function addRelation(rel: RelationalPlanNode): number {
    const idx = relations.length;
    relations.push(rel);
    for (const attr of rel.getAttributes()) {
      attrIdToRel.set(attr.id, idx);
    }
    return idx;
  }

  function addPairCond(aIdx: number, bIdx: number, cond: ScalarPlanNode): void {
    const [x, y] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
    const key = `${x}:${y}`;
    if (!pairToConds.has(key)) pairToConds.set(key, []);
    pairToConds.get(key)!.push(cond);
  }

  // Enumeration covers INNER/CROSS spines only. A non-inner join anywhere in the
  // subtree abandons the whole graph — it must be a latched flag, NOT a sentinel
  // written into `relations`: the recursion continues in the ancestor frames after
  // a bail, so an emptied `relations` is refilled by the still-unvisited siblings
  // and a PARTIAL graph then looks like a complete one. That silently reordered a
  // join over the surviving relations and dropped the bailed subtree along with
  // every predicate touching it (wrong rows, or "No row context found for column").
  //
  // NOTE: bailing is stricter than necessary — a non-inner join could instead be
  // registered as ONE opaque leaf relation (its attributes are all this walk needs)
  // and the surviving spine still enumerated. That matters because
  // `rule-semi-join-pushdown` now routinely parks a semi join at the bottom of an
  // inner spine, so `a join b join c where a.x in (select …)` loses enumeration it
  // used to get. Revisit if a 3+-relation join under an `IN (SELECT …)` filter shows
  // up with a bad join order; the opaque-leaf variant needs its own correlation
  // guard first (a LATERAL leaf must not be reordered below its provider).
  let bailed = false;

  function visit(n: PlanNode): void {
    if (bailed) return;
    if (n instanceof JoinNode) {
      if (n.getJoinType() !== 'inner' && n.getJoinType() !== 'cross') {
        bailed = true;
        return;
      }
      visit(n.getLeftSource());
      visit(n.getRightSource());
      if (bailed) return;

      // Analyze equi-join predicates
      const cond = n.getJoinCondition();
      if (cond) {
        const norm = normalizePredicate(cond);
        const stack: ScalarPlanNode[] = [norm];
        while (stack.length) {
          const expr = stack.pop()!;
          if (expr instanceof BinaryOpNode && expr.expression.operator === 'AND') {
            stack.push(expr.left, expr.right);
          } else if (expr instanceof BinaryOpNode && expr.expression.operator === '=') {
            if (expr.left instanceof ColumnReferenceNode && expr.right instanceof ColumnReferenceNode) {
              const lRel = attrIdToRel.get((expr.left as ColumnReferenceNode).attributeId);
              const rRel = attrIdToRel.get((expr.right as ColumnReferenceNode).attributeId);
              if (lRel !== undefined && rRel !== undefined && lRel !== rRel) {
                addPairCond(lRel, rRel, expr);
              }
            }
          }
        }
      }
      return;
    }
    if (isRelationalNode(n)) {
      addRelation(n);
      return;
    }
    // Traverse generic children otherwise
    for (const c of n.getChildren()) visit(c);
  }

  visit(node);
  if (bailed || relations.length === 0) return null; // non-inner join encountered, or non-join

  // Build predicates array (AND-combine multiple per pair later during plan build)
  const predicates: JoinPredicate[] = [];
  for (const [key, conds] of pairToConds) {
    const [aStr, bStr] = key.split(':');
    const a = parseInt(aStr, 10);
    const b = parseInt(bStr, 10);
    // Leave multiple conditions to be AND-combined when consumed
    const combined = conds.length === 1 ? conds[0] : conds.reduce((acc, cur) =>
      new BinaryOpNode(
        relations[a].scope,
        { type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
        acc,
        cur
      )
    );
    predicates.push({ leftIndex: a, rightIndex: b, condition: combined });
  }
  return { relations, predicates };
}

function estimatePlanCost(plan: RelationalPlanNode): number {
  // Use total cost, but apply penalties for cross products (no predicates between recent components)
  // and reward key-covered joins via lower estimatedRows coming from computePhysical.
  // Total cost already accumulates subtree costs; keep it as primary signal.
  return plan.getTotalCost();
}

function buildLeftDeepPlan(order: number[], graph: JoinGraph): RelationalPlanNode {
  let current: RelationalPlanNode | null = null;
  const chosen = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    if (current === null) {
      current = graph.relations[idx];
      chosen.add(idx);
      continue;
    }
    const next = graph.relations[idx];
    // Gather all predicates that connect next to the chosen set
    const connectors: ScalarPlanNode[] = [];
    for (const p of graph.predicates) {
      const connects = (chosen.has(p.leftIndex) && p.rightIndex === idx) || (chosen.has(p.rightIndex) && p.leftIndex === idx);
      if (connects) connectors.push(p.condition);
    }
    const cond = connectors.length === 0 ? undefined : connectors.reduce((acc, cur) =>
      acc
        ? new BinaryOpNode(
            current!.scope,
            { type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
            acc,
            cur
          )
        : cur
    , undefined as ScalarPlanNode | undefined);
    current = new JoinNode(current.scope, current, next, 'inner', cond);
    chosen.add(idx);
  }
  return current!;
}

// Greedy bushy: repeatedly merge the pair of components with minimal estimated join cost
function buildBushyPlan(graph: JoinGraph): RelationalPlanNode {
  type Component = { members: Set<number>; plan: RelationalPlanNode };
  const components: Component[] = graph.relations.map((r, i) => ({ members: new Set([i]), plan: r }));

  function predicatesBetween(a: Component, b: Component): ScalarPlanNode | undefined {
    const conns: ScalarPlanNode[] = [];
    for (const p of graph.predicates) {
      const lInA = a.members.has(p.leftIndex);
      const rInA = a.members.has(p.rightIndex);
      const lInB = b.members.has(p.leftIndex);
      const rInB = b.members.has(p.rightIndex);
      const crosses = (lInA && rInB) || (rInA && lInB);
      if (crosses) conns.push(p.condition);
    }
    if (conns.length === 0) return undefined;
    return conns.reduce((acc, cur) =>
      acc
        ? new BinaryOpNode(
            graph.relations[0].scope,
            { type: 'binary', operator: 'AND', left: acc.expression, right: cur.expression },
            acc,
            cur
          )
        : cur,
      undefined as ScalarPlanNode | undefined);
  }

  while (components.length > 1) {
    let bestI = -1, bestJ = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestPlan: RelationalPlanNode | null = null;

    for (let i = 0; i < components.length; i++) {
      for (let j = i + 1; j < components.length; j++) {
        const a = components[i];
        const b = components[j];
        const cond = predicatesBetween(a, b);
        const joined = new JoinNode(a.plan.scope, a.plan, b.plan, 'inner', cond);
        const cost = estimatePlanCost(joined);
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
          bestPlan = joined;
        }
      }
    }

    // Merge best pair
    const a = components[bestI];
    const b = components[bestJ];
    const merged: Component = { members: new Set([...a.members, ...b.members]), plan: bestPlan! };
    // Remove higher index first
    components.splice(bestJ, 1);
    components.splice(bestI, 1);
    components.push(merged);
  }

  return components[0].plan;
}

export function ruleQuickPickJoinEnumeration(node: PlanNode, context: OptContext): PlanNode | null {
  const qk = context.tuning.quickpick;
  if (!qk?.enabled) return null;
  if (!(node instanceof JoinNode)) return null;

  const graph = extractJoinGraph(node);
  if (!graph) return null;
  if (graph.relations.length < 3) return null; // Only helpful for 3+ relations

  // Refuse to reorder when any participating relation carries a write —
  // QuickPick enumerates arbitrary join orderings, which would change the
  // user-visible execution order of side-effect subtrees.
  for (const rel of graph.relations) {
    if (PlanNodeCharacteristics.subtreeHasSideEffects(rel)) {
      log('quickpick skipped: a relation has side effects');
      return null;
    }
  }

  const baselineCost = estimatePlanCost(node as unknown as RelationalPlanNode);
  if (baselineCost < (qk.minTriggerCost ?? 0)) return null;

  const maxTours = qk.maxTours ?? 100;
  let bestPlan: RelationalPlanNode | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  // Try multiple strategies: left-deep greedy from small bases and bushy greedy
  const sizes = graph.relations.map(r => r.estimatedRows ?? 1e9);
  const baseOrder = [...graph.relations.keys()].sort((a, b) => (sizes[a] - sizes[b]));

  const start = Date.now();
  let tours = 0;
  while (tours < maxTours && (Date.now() - start) <= (qk.timeLimitMs ?? 100)) {
    // Greedy NN tour: start with random among top-2 smallest
    const startIdx = baseOrder[Math.min(tours % 2, baseOrder.length - 1)];
    const remaining = new Set<number>(graph.relations.keys());
    remaining.delete(startIdx);
    const order: number[] = [startIdx];

    while (remaining.size > 0) {
      let bestNext: number | null = null;
      let bestIncCost = Number.POSITIVE_INFINITY;

      for (const cand of remaining) {
        // Prefer connected joins (has predicate to chosen set); penalize cross-products
        const connected = graph.predicates.some(p =>
          (order.some(o => o === p.leftIndex) && p.rightIndex === cand) ||
          (order.some(o => o === p.rightIndex) && p.leftIndex === cand)
        );
        const plan = buildLeftDeepPlan([...order, cand], graph);
        let cost = estimatePlanCost(plan);
        if (!connected) cost *= 10; // strong penalty for cross product
        if (cost < bestIncCost) {
          bestIncCost = cost;
          bestNext = cand;
        }
      }
      order.push(bestNext!);
      remaining.delete(bestNext!);
    }

    const plan = buildLeftDeepPlan(order, graph);
    const cost = estimatePlanCost(plan);
    if (cost < bestCost) {
      bestCost = cost;
      bestPlan = plan;
    }
    tours++;
  }

  // Bushy attempt (one per invocation)
  const bushy = buildBushyPlan(graph);
  const bushyCost = estimatePlanCost(bushy);
  if (bushyCost < bestCost) {
    bestCost = bushyCost;
    bestPlan = bushy;
  }

  if (!bestPlan) return null;
  // Always record diagnostics for visibility
  context.diagnostics.quickpick = { tours, bestCost };
  if (bestCost < baselineCost * 0.9) {
    log('QuickPick replaced join plan (%.2f -> %.2f)', baselineCost, bestCost);
    return bestPlan as unknown as PlanNode;
  }
  return null;
}


