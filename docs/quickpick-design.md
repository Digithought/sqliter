# QuickPick Join Enumeration Design for Quereus

## Overview

QuickPick treats join order optimization as a Traveling Salesman Problem (TSP) where:
- **Cities** = Relations to join
- **Tour** = Join order (left-deep plan)
- **Distance** = Join cost between relations
- **Goal** = Find minimum-cost tour visiting all relations

## Core Algorithm

### 1. Random Greedy Tours
```typescript
interface JoinGraph {
  relations: RelationalPlanNode[];
  predicates: JoinPredicate[];
  crossProducts: Set<[number, number]>; // Pairs without predicates
}

interface Tour {
  order: number[];        // Indices into relations array
  cost: number;          // Total estimated cost
  plan: RelationalPlanNode;  // Actual join tree
}

class QuickPickEnumerator {
  async enumerate(
    graph: JoinGraph,
    maxTours: number = 100  // Tunable parameter
  ): Promise<RelationalPlanNode> {
    const tours: Tour[] = [];
    
    for (let i = 0; i < maxTours; i++) {
      const tour = this.generateGreedyTour(graph);
      tours.push(tour);
    }
    
    return this.selectBestTour(tours).plan;
  }
  
  private generateGreedyTour(graph: JoinGraph): Tour {
    // Start with random relation
    const unvisited = new Set(graph.relations.keys());
    const startIdx = Math.floor(Math.random() * graph.relations.length);
    const tour = [startIdx];
    unvisited.delete(startIdx);
    
    // Greedily add closest unvisited relation
    while (unvisited.size > 0) {
      const lastIdx = tour[tour.length - 1];
      const nextIdx = this.findCheapestNext(lastIdx, unvisited, graph);
      tour.push(nextIdx);
      unvisited.delete(nextIdx);
    }
    
    // Build actual join tree and compute cost
    const plan = this.buildJoinTree(tour, graph);
    const cost = this.computeTourCost(plan);
    
    return { order: tour, cost, plan };
  }
}
```

### 2. Cost Model Integration

```typescript
interface JoinCostModel {
  // Leverage existing Quereus infrastructure
  estimateJoinCost(
    left: RelationalPlanNode,
    right: RelationalPlanNode,
    predicate?: ScalarPlanNode
  ): number {
    const leftRows = left.physical.estimatedRows ?? 1000;
    const rightRows = right.physical.estimatedRows ?? 1000;
    
    // Use existing key analysis from JoinNode.computePhysical()
    const keyCovered = this.analyzesKeyJoin(left, right, predicate);
    
    if (keyCovered.leftKeyCovered) {
      // Right-unique join: cost = leftRows * log(rightRows)
      return leftRows * Math.log2(rightRows + 1);
    } else if (keyCovered.rightKeyCovered) {
      // Left-unique join: cost = rightRows * log(leftRows)
      return rightRows * Math.log2(leftRows + 1);
    } else if (predicate) {
      // General equi-join with selectivity
      const selectivity = this.estimateSelectivity(predicate);
      return leftRows * rightRows * selectivity;
    } else {
      // Cross product
      return leftRows * rightRows;
    }
  }
  
  // Reuse key analysis from JoinNode
  private analyzesKeyJoin(
    left: RelationalPlanNode,
    right: RelationalPlanNode,
    predicate?: ScalarPlanNode
  ): { leftKeyCovered: boolean; rightKeyCovered: boolean } {
    // Extract from JoinNode.computePhysical() logic
    // ...
  }
}
```

### 3. Integration with Existing Optimizer

```typescript
// New rule: ruleQuickPickJoinEnumeration
export function ruleQuickPickJoinEnumeration(
  node: PlanNode,
  context: OptContext
): PlanNode | null {
  // Only apply to join trees with 3+ relations
  const joinGraph = extractJoinGraph(node);
  if (!joinGraph || joinGraph.relations.length < 3) {
    return null;
  }
  
  // Check if worth enumerating (cost threshold)
  const currentCost = estimateCurrentPlanCost(node);
  if (currentCost < context.tuning.joinEnumerationThreshold) {
    return null;
  }
  
  const enumerator = new QuickPickEnumerator(context);
  const maxTours = context.tuning.quickPickMaxTours ?? 100;
  const optimizedPlan = enumerator.enumerate(joinGraph, maxTours);
  
  // Only return if significantly better
  const newCost = estimateCurrentPlanCost(optimizedPlan);
  if (newCost < currentCost * 0.9) {  // 10% improvement threshold
    return optimizedPlan;
  }
  
  return null;
}
```

## Architecture Decisions

### 1. **Join Graph Extraction**
- Walk the plan tree to find all joins and base relations
- Identify join predicates and their referenced relations
- Mark cross products (joins without predicates)

### 2. **Tour Representation**
- Use relation indices for efficient manipulation
- Build left-deep trees (matches Quereus's current execution model)
- Preserve attribute IDs through reconstruction

### 3. **Parallelization Opportunity**
```typescript
// Tours are independent - can parallelize
async function parallelEnumerate(graph: JoinGraph, maxTours: number): Promise<Tour[]> {
  const tourPromises = Array.from({ length: maxTours }, () => 
    Promise.resolve(generateGreedyTour(graph))
  );
  return Promise.all(tourPromises);
}
```

### 4. **Bushy Tree Support (Future)**
```typescript
interface BushyTour {
  structure: TreeStructure;  // Not just left-deep
  cost: number;
  plan: RelationalPlanNode;
}

// Modify tour generation to sometimes create bushy trees
// This would require more sophisticated tree building
```

## Integration Points

### 1. **Registration in Optimizer**
```typescript
// In optimizer.ts - a RULE_MANIFEST entry in the Physical pass (bottom-up).
// Manifest array order is execution order, so its position places this before
// other join optimizations.
{
  pass: PassId.Physical,
  id: 'quickpick-join-enumeration',
  nodeType: PlanNodeType.Join,
  phase: 'impl',
  fn: ruleQuickPickJoinEnumeration,
  sideEffectMode: 'aware',
}
```

### 2. **Tuning Parameters**
```typescript
interface OptimizerTuning {
  // Existing...
  quickPickMaxTours?: number;         // Default: 100
  quickPickTimeLimit?: number;        // Default: 100ms
  joinEnumerationThreshold?: number;  // Min cost to trigger enumeration
  quickPickParallel?: boolean;        // Default: false (start simple)
}
```

### 3. **Statistics Integration**
- QuickPick benefits from good cardinality estimates
- Our pushdown/growth work improves base relation estimates
- Key propagation helps identify cheap key-based joins

## Implementation Complexity

### Required Components:
1. **Join Graph Extractor** (~200 lines)
   - Tree walker to find joins and relations
   - Predicate analyzer to map joins to relations

2. **Tour Generator** (~150 lines)
   - Random start selection
   - Greedy next-relation selection
   - Tour → Join tree builder

3. **Cost Model** (~100 lines)
   - Reuse existing JoinNode cost logic
   - Add tour-specific cost accumulation

4. **Rule Integration** (~50 lines)
   - Rule function
   - Registration in optimizer

**Total: ~500 lines of code**

## Advantages Over Incremental Approach

### QuickPick Benefits:
1. **Near-optimal results** with minimal complexity
2. **Predictable performance** (linear in tours × relations)
3. **No complex memo structures** or dynamic programming
4. **Naturally handles** cross products and cartesian products
5. **Easy to tune** via maxTours parameter
6. **Future-proof** for parallel execution

### Current Greedy Commute Limitations:
1. **Only local optimization** (swaps immediate children)
2. **No associativity changes** (can't reorder join tree)
3. **Misses global optimum** frequently
4. **Hard to extend** to bushy trees

## Migration Path

### Phase 1: Basic QuickPick (Recommended)
- Implement core algorithm with left-deep trees
- Use existing cost model and key analysis
- Register as optional rule (can disable via tuning)

### Phase 2: Enhancements
- Add parallelization for tour generation
- Support bushy trees for specific patterns
- Integrate with statistics when available

### Phase 3: Advanced
- Adaptive tour count based on query complexity
- Learning from previous enumerations
- Cost model refinement based on execution feedback

## Decision: Skip Incremental, Go to QuickPick

### Reasons to Skip Incremental:
1. **Limited benefit** - Greedy commute only helps simple cases
2. **QuickPick is simple** - ~500 lines total
3. **Better foundation** - QuickPick can evolve more easily
4. **Clean architecture** - Single enumeration point vs multiple small rules
5. **Proven algorithm** - Well-tested in literature and practice

### QuickPick Implementation Plan:
1. Start with basic left-deep enumeration
2. Reuse all existing infrastructure (JoinNode costs, key analysis)
3. Make it tunable and optional
4. Add tests comparing plans with/without enumeration
5. Document tuning guidelines

## Testing Strategy

### 1. Correctness Tests
```sql
-- Verify same results regardless of join order
CREATE TABLE a (id INT PRIMARY KEY, val INT);
CREATE TABLE b (id INT PRIMARY KEY, a_id INT);
CREATE TABLE c (id INT PRIMARY KEY, b_id INT);

-- Should produce same results with different plans
SELECT * FROM a JOIN b ON a.id = b.a_id JOIN c ON b.id = c.b_id;
```

### 2. Performance Tests
```sql
-- Test that QuickPick finds better plans
SELECT COUNT(*) AS plan_cost_before FROM query_plan('...') WHERE op = 'JOIN';
-- Enable QuickPick
SET quickpick_max_tours = 100;
SELECT COUNT(*) AS plan_cost_after FROM query_plan('...') WHERE op = 'JOIN';
-- Assert plan_cost_after < plan_cost_before
```

### 3. Stability Tests
- Ensure attribute IDs preserved
- Verify predicate semantics maintained
- Check key propagation still works

## Conclusion

QuickPick is the right choice for Quereus because:
- It's surprisingly simple (~500 lines)
- Provides near-optimal results
- Integrates cleanly with existing infrastructure
- More maintainable than complex DP-based approaches
- Scales well with tunable parameters

The incremental improvements (beyond the commute rule we added) would provide minimal benefit and complicate the path to QuickPick. Let's skip them and implement QuickPick directly.
