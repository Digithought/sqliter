# Optimizer Visited Tracking

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

How the optimizer avoids re-firing a rule forever, and how it optimizes a plan that is a
DAG rather than a tree. Both answers live on the optimization context: a per-pass traversal
cache keyed by node id, and a per-context record of which rules have already *transformed*
which node. The pass framework that drives them is
[Optimizer § Pass Framework](optimizer.md#pass-framework-srcplannerframeworkpassts).

## Design Philosophy

Quereus uses context-scoped visited tracking to handle optimization of directed acyclic graphs (DAGs) containing shared subtrees. This approach eliminates the architectural problems inherent in global tracking systems while enabling sophisticated multi-pass optimizations.

## Core Architecture

The visited tracking system is built around the optimization context rather than global state:

```typescript
interface OptContext {
  optimizer: Optimizer;
  stats: StatsProvider;
  tuning: OptimizerTuning;
  db: Database;
  
  // Context-scoped tracking
  visitedRules: Map<string, Set<string>>;     // nodeId → ruleIds applied (transformed) in this context
  optimizedNodes: Map<string, PlanNode>;      // nodeId → optimized result cache
}
```

## Shared Subtree Handling

**Problem**: Traditional optimizers assume tree structures, but SQL plans form DAGs due to:
- CTEs referenced multiple times (`WITH t AS (...) SELECT * FROM t UNION SELECT * FROM t`)
- Correlated subqueries with repeated correlation variables
- View expansions that reference the same underlying tables

**Solution**: The pass framework uses a **per-pass traversal cache** to ensure shared subtrees are optimized consistently within a pass, while still allowing later passes to revisit nodes.

```typescript
// PassManager traversal: reuse within a single pass
const cached = context.optimizedNodes.get(node.id);
if (cached) return cached;

// ... optimize children + apply rules ...

context.optimizedNodes.set(node.id, result);
return result;
```

The cache is cleared at the start of each pass (so Physical Selection can still rewrite nodes that Structural cached).

## Rule Application Control

> **Invariant:** [OPT-010](invariants.md#opt-010--visited-rules-are-inherited-across-a-re-mint-declines-are-not)

Rules are prevented from infinite loops through per-context tracking of
*transforming* applications:

```typescript
// Registry checks context-local applied state
hasRuleBeenApplied(nodeId: string, ruleId: string, context: OptContext): boolean {
  const nodeVisited = context.visitedRules.get(nodeId);
  return nodeVisited?.has(ruleId) ?? false;
}

// Marks are context-local, allowing same rule on shared nodes in different paths
markRuleApplied(nodeId: string, ruleId: string, context: OptContext): void {
  if (!context.visitedRules.has(nodeId)) {
    context.visitedRules.set(nodeId, new Set());
  }
  context.visitedRules.get(nodeId)!.add(ruleId);
}
```

When a rule transforms a node the `PassManager` inherits the applied set onto the
freshly-minted node (`inheritVisitedRules`), so an applied rule is not re-tried
on its own output (loop prevention).

**Declines are tracked separately and ephemerally.** Inside a single
`applyPassRules` fixpoint loop, a rule that declines (returns `null` / the same
node) on the current node id is remembered so it is not re-offered on that
*unchanged* node every `while` iteration — the rule is deterministic in its
input node, so the re-run would be pure waste. This decline set is **reset the
moment any rule transforms the node**: the plan piece changed, so every decliner
gets a fresh shot on the new node (a rule that declined on the old shape may well
apply to the new one). Because declines are never inherited across a transform,
this is a strict speedup with **no plan-output change** — only same-node re-runs
are cut, never a legitimate re-offer after the node actually changes.

Individual rules can also be disabled via `OptimizerTuning.disabledRules` (a `ReadonlySet<string>` of rule IDs). Both the pass-based and registry-based rule application paths skip disabled rules. This is primarily intended for testing (e.g., verifying semantic equivalence with/without a specific rewrite).

## Multi-Pass Optimization Support

The architecture supports multi-pass optimization strategies via:

**Single optimization session (current)**:
- One context per optimization session
- `optimizedNodes` is used as a per-pass traversal cache (cleared each pass)
- `visitedRules` persists across passes and is inherited along rewrite chains so local fixpoint iteration terminates

**Multi-Pass (Future)**:
- Fresh context per optimization pass
- Different rule sets or heuristics per pass
- Best plan selection across all passes

## Context Lifecycle

Today there is exactly one `OptimizationContext` per optimization session (`Optimizer.optimize` /
`optimizeForAnalysis` each call `createOptContext` once via `framework/context.ts`); it is not
derived or specialized mid-session — see [Multi-Pass Optimization Support](#multi-pass-optimization-support)
above for the planned direction.

Per-traversal depth is tracked by the pass framework itself rather than on the
context — see [Optimizer § Pass Framework](optimizer.md#pass-framework-srcplannerframeworkpassts)
for the input-scaled budget
(`max(maxOptimizationDepth, planInputDepth + optimizationDepthHeadroom)`) and
the `maxRulesFired` cap.

## Performance Characteristics

**Memory**: O(nodes × rules) per context, garbage collected when context ends
**Time**: O(1) lookup for visited rules and optimized nodes
**Scalability**: Each context is independent, enabling parallel optimization

## Integration with Advanced Optimizations

The context-scoped design enables sophisticated optimization strategies:

**[QuickPick Join Enumeration](optimizer-joins.md#join-optimization-with-quickpick)**:
- The rule builds and costs each candidate join tree in-place, outside the visited set
- Only the winning tree is returned, so exactly one transform is recorded for the node
- Discarded candidates leave no visited-tracking residue to invalidate

**Progressive Optimization** (see [progressive-optimizer.md](./progressive-optimizer.md)):
- Contexts can carry different statistics or cost models
- Tier 2 re-optimization re-runs physical selection with runtime stats overlay
- Runtime cardinality feedback updates stats between executions
