# Constant Folding Implementation

This directory contains the Phase 3 constant folding implementation for the Titan optimizer.

## Overview

The constant folding system implements the two-phase algorithm described in `docs/optimizer-const.md`:

1. **Bottom-up classification**: Assign `ConstInfo` to every node during post-order DFS
2. **Top-down propagation**: Walk relational tree carrying known constant attributes

## Files

### `const-pass.ts`
Core constant folding analysis with:
- `ConstInfo` types: `const`, `dep`, `non-const`
- `classifyConstants()` - bottom-up classification using generic tree walking
- `applyConstPropagation()` - top-down propagation and folding
- Framework ready for runtime-based evaluation

### `const-evaluator.ts`
Runtime-based expression evaluation:
- `createRuntimeExpressionEvaluator()` - uses existing runtime via mini-scheduler
- Avoids duplicate expression interpreter by reusing `emitPlanNode()` + `Scheduler`
- Minimal `RuntimeContext` for constant-only evaluation

### `constraint-extractor.ts`
Existing predicate analysis utilities (Phase 0 infrastructure).

## Integration Points

### Builder Level
```typescript
import { foldScalars } from '../util/fold-scalars.js';

// In VALUES, default expressions, etc.
const foldedExpr = foldScalars(originalExpression);
```

### Optimizer Rules
Constant folding runs as early `rewrite` phase rules targeting nodes with expressions:
- Project (projection expressions)
- Filter (predicate expressions) 
- Window, Aggregate, Sort, Values, Join

### Key Design Principles

✅ **Generic Tree Walking**: Uses `getChildren()`/`withChildren()` exclusively
✅ **Minimal Node-Type Knowledge**: Only checks types for targeting, not folding logic
✅ **Expression Boundary Triggering**: Only runs on relational nodes with expressions
✅ **Functional Safety**: Only folds expressions marked as `functional` (pure + deterministic)
✅ **Attribute ID Preservation**: Maintains column reference validity through transformations

## Usage

### Basic Builder Usage
```typescript
import { foldScalars } from '../util/fold-scalars.js';

// Automatically fold constant expressions in builders
const expr = buildExpression(ctx, ast);
const folded = foldScalars(expr); // e.g., "1 + 2 * 3" → "7"
```

### Advanced Runtime-Based Usage
```typescript
import { classifyConstants, applyConstPropagation, createConstFoldingContext } from '../analysis/const-pass.js';
import { createRuntimeExpressionEvaluator } from '../analysis/const-evaluator.js';

// For complex expressions requiring runtime evaluation
const evaluator = createRuntimeExpressionEvaluator(database);
const ctx = createConstFoldingContext(evaluator);
classifyConstants(planTree, ctx);
const foldedTree = applyConstPropagation(relationalNode, ctx);
```

### Debug Tracing
```bash
# Enable constant folding debug output
DEBUG=quereus:optimizer:folding* yarn test
```

## Current Status

- ✅ Infrastructure complete with `functional` flag and generic tree walking
- ✅ Synchronous folding for basic arithmetic/logical operations  
- ✅ Optimizer rule integration using generic `getProducingExprs()` interface
- ✅ `MaybePromise<SqlValue>` support for async subquery constant folding
- ✅ Builder-level utility for immediate expression folding
- 🔄 Runtime evaluation framework ready for complex expressions
- 🔄 Advanced expression types (CASE, CAST, functions) need implementation

The implementation provides immediate value through synchronous folding while supporting promise-based values for subquery constants, eliminating the "projection list" specificity through the generic `getProducingExprs()` interface. 