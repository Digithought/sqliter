# Titan Optimizer Framework (Phase 1)

This directory contains the core framework components for the Titan optimizer Phase 1 implementation.

## Components

### Registry (`registry.ts`)
- **RuleHandle**: Structured rule registration with ID, node type, and phase
- **Loop Detection**: `hasRuleBeenApplied` / `markRuleApplied` prevent infinite rule application using per-node visited-rule tracking (consulted by `PassManager`). Records transforming applications only, inherited across a transform's re-mint. A rule that *declines* is tracked ephemerally per node id inside `PassManager.applyPassRules` so it is not re-run on the same unchanged node every fixpoint iteration; that decline suppression is dropped the moment the node is transformed (the plan piece changed), so no plan output changes
- **`validateSideEffectMode`**: Rejects any rule handle missing its `sideEffectMode` declaration

### Trace Framework (`trace.ts`)
- **TraceHook Interface**: Extensible hooks for rule and node processing events
- **DebugTraceHook**: Logs all optimizer activity to debug channels
- **PerformanceTraceHook**: Measures and logs rule execution times
- **CompositeTraceHook**: Combines multiple trace hooks
- **Environment Integration**: Automatically enables tracing based on DEBUG environment

### Context (`context.ts`)
- **OptContext**: Unified interface combining optimizer, stats provider, and tuning
- **Rule Visitation Tracking**: `visitedRules` / `optimizedNodes` prevent infinite rule re-application (see `hasRuleBeenApplied` / `markRuleApplied` in `registry.ts`)
- **Phase Management**: Supports 'rewrite' (logical→logical) and 'impl' (logical→physical) phases

### Physical Utilities (`physical-utils.ts`)
- **Property Inference**: Utilities for combining and propagating physical properties
- **Ordering Operations**: Functions for merging and inferring result orderings
- **Unique Key Handling**: Logic for combining unique keys across joins and projections
- **Cost Estimation**: Helpers for consistent cost model application

## Architecture Integration

### Rule Registration
Rules are declared as ordered entries in `RULE_MANIFEST` (`src/planner/optimizer.ts`).
`registerRulesToPasses()` walks the manifest in array order and registers each entry
with its pass — so **array order is execution order** (there is no numeric priority).
```typescript
// src/planner/optimizer.ts — an entry in RULE_MANIFEST
{
  pass: PassId.Physical,
  id: 'Aggregate→StreamAggregate',
  nodeType: PlanNodeType.Aggregate,
  phase: 'impl',
  fn: ruleAggregateStreaming,
  sideEffectMode: 'safe', // see docs/optimizer.md § Audit discipline
}
```

### Rule Implementation
A rule leads with the discrimination check that matches its intent. When it targets a
**specific class**, that check is `instanceof` — type-sound, natively narrowing, and the
dominant idiom. When it targets **any node with a capability** (any join kind, any aggregate
kind), use the `CapabilityDetectors` guard instead. See
[docs/optimizer-conventions.md § Node discrimination](../../../../../docs/optimizer-conventions.md#node-discrimination-three-questions-three-mechanisms)
for the full standard (`instanceof` vs capability brands vs `nodeType` vs physical
characteristics).
```typescript
import type { RuleFn } from '../framework/registry.js';

const ruleAggregateStreaming: RuleFn = (node, context) => {
  // This rule needs AggregateNode's specific API → instanceof (concrete class identity).
  if (!(node instanceof AggregateNode)) return null;

  const stats = context.stats;

  // Rule logic here...
  return transformedNode;
};
```

### Tracing Integration
Tracing is automatically enabled based on environment variables:
- `DEBUG=quereus:optimizer*` - enables debug tracing
- `QUEREUS_OPTIMIZER_PERF=true` - enables performance tracing

### Statistics Provider
```typescript
// Use built-in providers
import { defaultStatsProvider, vtabStatsProvider } from '../stats/index.js';

// Or create custom provider
const customStats = createStatsProvider(
  new Map([['users', 50000]]), // table row counts
  new Map([['users:BinaryOp', 0.1]]) // predicate selectivity
);
```

## Phase 1 Status

✅ **Implemented Components:**
- Rule registration and management framework
- Comprehensive trace framework with multiple hook types
- Optimizer context with statistics provider integration
- Physical property utilities
- Golden plan test harness
- Environment-based configuration

✅ **Integration Complete:**
- Optimizer updated to use new framework
- Emitter metadata support added
- Trace hooks integrated into rule application
- Statistics provider abstraction ready

🔄 **Next Steps (Phase 2):**
- Advanced optimization rules implementation
- Seek/range scan access path selection  
- Materialization advisory framework
- Plan validation pass

## Usage Examples

### Enabling Tracing
```bash
# Enable all optimizer tracing
DEBUG=quereus:optimizer* yarn test

# Enable performance measurement
QUEREUS_OPTIMIZER_PERF=true DEBUG=quereus:optimizer* yarn test

# Trace specific rule categories
DEBUG=quereus:optimizer:rule:* yarn test
```

### Running Golden Plan Tests
```bash
# Run all golden plan tests
yarn test:plans

# Update golden files when plans change
UPDATE_PLANS=true yarn test:plans
```

### Custom Statistics Provider
```typescript
const optimizer = new Optimizer(
  DEFAULT_TUNING,
  new VTabStatsProvider() // Uses VTab module statistics when available
);
```

This framework provides the foundation for sophisticated query optimization while maintaining clear separation of concerns and comprehensive debugging capabilities. 
