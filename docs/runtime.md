# Quereus Runtime

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The Quereus runtime executes query plans through a three-phase process: **Planning** (AST → Plan Nodes), **Emission** (Plan Nodes → Instructions), and **Execution** (Instructions → Results).

## Value Types

### SqlValue
Core SQL data types that can be stored and manipulated:
```typescript
type SqlValue = string | number | bigint | boolean | Uint8Array | null;
```

### RuntimeValue  
Input types that instructions can receive as arguments:
```typescript
type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue);
```

### OutputValue
Output types that instructions can produce:
```typescript
type OutputValue = MaybePromise<RuntimeValue>;
```

### TypeClasses
The runtime uses TypeScript's structural typing for type safety. Key classes and interfaces:
- `PlanNode`: Base class for all plan nodes
- `VoidNode`: Plan nodes that don't produce output (DDL, DML)
- `RelationalNode`: Plan nodes that produce rows (must implement `getAttributes()`)
- `ExpressionNode`: Plan nodes that produce scalar values

## Adding a New Plan Node

### 1. Create the Node Interface (`src/planner/nodes/`)

```typescript
// src/planner/nodes/my-operation-node.ts
import { RelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { Cached } from '../../util/cached.js';

export class MyOperationNode extends PlanNode implements UnaryRelationalNode {
	readonly nodeType = PlanNodeType.MyOperation;
	
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly operationParam: string
	) {
		super(scope, source.getTotalCost() + 10); // Add operation cost
		this.attributesCache = new Cached(() => this.buildAttributes());
	}
	
	private buildAttributes(): Attribute[] {
		// Define how this node creates/transforms attributes
		// Option 1: Preserve source attributes (like FilterNode, SortNode)
		return this.source.getAttributes();
		
		// Option 2: Create new attributes (like ProjectNode)
		// return this.projections.map((proj, index) => ({
		//   id: PlanNode.nextAttrId(),
		//   name: proj.alias ?? `col_${index}`,
		//   type: proj.node.getType(),
		//   sourceRelation: `${this.nodeType}:${this.id}`
		// }));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}
	
	getType(): RelationType {
		// Define output relation type
		return this.source.getType(); // Or build custom type
	}
	
	// ... other required methods
}
```

### 2. Add to PlanNodeType Enum

```typescript
// src/planner/nodes/plan-node-type.ts
export enum PlanNodeType {
	// ... existing types
	MyOperation = 'MyOperation',
}
```

### 3. Create the Builder (`src/planner/building/`)

```typescript
// src/planner/building/my-operation.ts
import type { PlanningContext } from '../planning-context.js';
import * as AST from '../../parser/ast.js';
import { MyOperationNode } from '../nodes/my-operation-node.js';
import { buildSelectStmt } from './select.js';

export function buildMyOperationStmt(ctx: PlanningContext, stmt: AST.MyOperationStmt): MyOperationNode {
	// Build child nodes
	const sourceNode = buildSelectStmt(ctx, stmt.inputQuery);
	
	// Validate parameters
	if (!stmt.operationParam) {
		throw new QuereusError('Operation parameter required', StatusCode.ERROR);
	}

	return new MyOperationNode(ctx.scope, sourceNode, stmt.operationParam);
}
```

## Plan Node Output Format

All plan nodes follow standardized output conventions for consistent query plan display and debugging.

### Plan Node Data Structure

Each plan node provides three complementary sources of information:

```typescript
{
  id: string,                    // Unique node identifier
  nodeType: PlanNodeType,        // Node type enum (displayed by viewer)
  description: string,           // toString() output
  logical: Record<string, any>,  // getLogicalProperties() output
  physical?: PhysicalProperties  // Physical execution properties (when optimized)
}
```

### toString() Guidelines

**Purpose**: Provide concise, human-readable descriptions for quick plan comprehension.

**Rules**:
- Never include node type, ID, or parentheses
- Keep ≤ 80 characters when practical  
- Start with SQL keyword or principal action
- Show only essential information (predicates, projections, etc.)
- Don't duplicate information from logical/physical properties

**Examples**:
```typescript
// TableReferenceNode
toString(): "main.users"

// FilterNode
toString(): "where age > 40"

// ProjectNode
toString(): "select name, count(*) as total"

// SortNode
toString(): "order by name desc, age asc"

// AggregateNode
toString(): "group by dept_id  agg  count(*) as count, sum(salary) as total"
```

### getLogicalProperties() Guidelines

**Purpose**: Provide comprehensive logical information for detailed plan analysis.

**Rules**:
- Always return an object (never undefined)
- Use camelCased keys with semantic meaning
- Return primitive JSON types when possible (strings, numbers, arrays)
- Include logically important information not in description
- Don't duplicate physical properties (estimatedRows, ordering, etc.)

**Examples**:
```typescript
// FilterNode
getLogicalProperties(): {
  predicate: "age > 40"
}

// AggregateNode  
getLogicalProperties(): {
  groupBy: ["dept_id"],
  aggregates: [
    { expression: "COUNT(*)", alias: "count" },
    { expression: "SUM(salary)", alias: "total" }
  ]
}
```

### Formatting Utilities

Use consistent formatting helpers from `src/util/plan-formatter.ts`:

```typescript
import { 
  formatExpression,      // ScalarPlanNode → string
  formatExpressionList,  // ScalarPlanNode[] → "expr1, expr2, ..."  
  formatProjection,      // Expression + alias → "expr AS alias"
  formatSortKey,         // Expression + direction + nulls → "expr DESC NULLS LAST"
  formatScalarType       // ScalarType → "INTEGER" | "TEXT" | etc.
} from '../../util/plan-formatter.js';
```

### Implementation Template

```typescript
export class MyOperationNode extends PlanNode {
  // ... constructor and other methods

  override toString(): string {
    // Concise description focusing on key operation details
    return `MY_OP ${this.operationParam}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      operation: this.operationParam,
      targetColumns: this.columns.map(col => col.name),
      // Include other logical details...
    };
  }
}
```

This standardized format ensures plan viewers receive consistent, comprehensive information for both quick scanning (description) and deep analysis (logical + physical properties).

## Creating an Emitter

### 1. Create the Emitter (`src/runtime/emit/`)

```typescript
// src/runtime/emit/my-operation.ts
import type { MyOperationNode } from '../../planner/nodes/my-operation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import { createRowSlot } from '../context-helpers.js';

export function emitMyOperation(plan: MyOperationNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	// Create output row descriptor (if this node transforms attributes)
	const outputRowDescriptor: RowDescriptor = [];
	const outputAttributes = plan.getAttributes();
	outputAttributes.forEach((attr, index) => {
		outputRowDescriptor[attr.id] = index;
	});

	// Common run function pattern: streaming with row slot
	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		const rowSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const row of inputRows) {
				rowSlot.set(row);
				const processedRow = processRow(row, plan.operationParam);
				yield processedRow;
			}
		} finally {
			rowSlot.close();
		}
	}

	// For scalar operations:
	// function run(rctx: RuntimeContext, inputValue: SqlValue): SqlValue {
	//     return processValue(inputValue, plan.operationParam);
	// }

	// For void operations (DDL/DML):
	// async function run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): Promise<void> {
	//     await processRowsWithContext(rctx, sourceRowDescriptor, inputRows, async (row) => {
	//         await performSideEffect(row);
	//     });
	//     return undefined;
	// }

	return {
		params: [sourceInstruction],
		run: asRun(run),
		note: `myOperation(${plan.operationParam})`
	};
}
```

Wrap `run` in `asRun(...)`: a `run` with specific parameters (`SqlValue`,
`AsyncIterable<Row>`, fixed arity) is not assignable to `InstructionRun` —
`strictFunctionTypes` parameter contravariance rejects it. `asRun`
(`src/runtime/types.ts`) is the single audited home for that cast;
`createValidatedInstruction(...)` takes it too. It checks params are
`RuntimeValue`s and the return an `OutputValue`: an `async` `run` returns
`Promise<RuntimeValue>`, and a sometimes-emitted `SubProgram` param is a rest tuple,
not optional (`emit/bloom-join.ts`).

### 2. Register the Emitter

```typescript
// src/runtime/register.ts
import { emitMyOperation } from './emit/my-operation.js';

export function registerEmitters() {
	// ... existing registrations
	registerEmitter(PlanNodeType.MyOperation, emitMyOperation as EmitterFunc);
}
```

## Key Emitter Patterns

### Row Context Management
Use context helpers to manage row contexts safely and efficiently:

**Pattern 1: High-volume streaming (createRowSlot) — preferred for all streaming emitters**
```typescript
import { createRowSlot } from '../context-helpers.js';

// Used by scan, join, filter, project, and distinct emitters.
// Installs the context entry once; updates by cheap field write per row.
const rowSlot = createRowSlot(rctx, rowDescriptor);
try {
	for await (const row of sourceRows) {
		rowSlot.set(row);  // Cheap update - no Map mutation
		yield processRow(row);
	}
} finally {
	rowSlot.close();
}
```

**Pattern 2: One-off / low-frequency context (withRowContext / withAsyncRowContext)**
```typescript
import { withRowContext, withAsyncRowContext } from '../context-helpers.js';

// Best for single-row evaluations such as constraint checks, DML context
// setup, or any place where Map.set+delete once is negligible.

// Synchronous evaluation
const result = withRowContext(rctx, rowDescriptor, () => row, () => {
	return evaluateExpression(rctx);
});

// Async evaluation
const result = await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
	return await evaluateAsyncExpression(rctx);
});
```

### Column Reference Resolution
Column references are resolved automatically using attribute IDs.  Resolution has
two tiers (see `resolveAttribute` in `context-helpers.ts`):

1. **Fast path — `attributeIndex` (authoritative).** `RowContextMap` keeps a flat
   `attributeIndex[attrId] → { rowGetter, columnIndex }`. The winner for a given
   attribute ID is whichever context called `context.set(descriptor, …)` **most
   recently** for that ID — i.e. *last-`set`-wins*, **not** insertion-order
   "newest scope wins". Note `slot.set(row)` is a cheap field write that does
   **not** touch the index; only slot creation, `RowSlot.reactivate()`, or a
   direct `context.set` re-claims an attribute ID.
2. **Fallback — newest → oldest scan.** Used only when the indexed entry's row is
   not yet populated (e.g. a slot created but not yet `set`). `resolveAttribute`
   then walks the remaining contexts newest → oldest and returns the first whose
   row is a populated array.

```typescript
// In emitColumnReference (built-in):
function run(ctx: RuntimeContext): SqlValue {
	// O(1) attributeIndex fast path; newest→oldest scan only as a fallback
	return resolveAttribute(ctx, plan.attributeId, plan.expression.name);
}
```

#### Invariant: source-attr contexts and child pulls

> **A streaming operator must not leave a row context built from its source's
> attribute IDs winning the `attributeIndex` while it pulls its child for the
> next input row.**

Because `slot.set(row)` does not reclaim the index, a child that updates its own
slot per row (e.g. a residual `Filter` directly below the operator) cannot win
back the shared attribute IDs if the parent's context is still the most-recent
`set`. The parent's stale row then silently **shadows** the child's current-row
reads — the child evaluates against the parent's previous output instead of its
own current row.

The mirror case is equally real: an operator whose source-attr context is
shadowed *by* a still-running child cursor (a look-ahead peek) must re-win the
index *before yielding* so downstream resolves through the operator's intended
row, not the child cursor's position.

There are two tools, picked by which side must win at the moment of the next pull:

- **Tear-down-before-pull (`delete`)** — for the *operator-shadows-child*
  direction. The operator drops its source-attr context after yielding and before
  pulling the next child row, letting the deepest child reclaim the index; it
  re-establishes the context when the next row arrives. Worked examples:
  - `emit/aggregate.ts` (streaming GROUP BY) tears the just-yielded group's
    representative-row context down before pulling the next source row.
  - `emit/window.ts` (streaming variant) `demote()`s its `myDesc` at the end of
    each iteration, then `promote()`s again on the next row. This is also the
    canonical *stacked same-attr operator* case: a `set(row)` alone is
    insufficient because it does not re-insert, so `promote()` does delete+set to
    win for its own callbacks and at the yield, while `demote()` releases the
    index across the pull.
- **`reactivate()` before yield** — for the *child-shadows-operator* direction.
  The operator re-`set`s its descriptor (re-winning the index) just before it
  yields. Worked example: `emit/asof-scan.ts` (merge variant) calls
  `rightSlot.reactivate()` before yielding the matched / null-padded row, so
  downstream reads the matched row rather than the right scan's look-ahead cursor.

The **operator-shadows-child** direction (tear-down-before-pull) is checked at
runtime by the off-by-default `QUEREUS_CONTEXT_STRICT` harness — see § Strict
context-shadow test mode below. The mirror **child-shadows-operator** direction is
deliberately *not* checked (recency can't distinguish a forgotten `reactivate()`
from a correct newest write); that gap is tracked in the backlog ticket
`debt-context-shadow-reactivate-direction`.

## Scheduler Execution Model

The Scheduler executes instructions in dependency order:

1. **Flattening**: Converts instruction tree to linear array
2. **Dependency Resolution**: Ensures instructions execute after their dependencies
3. **Async Handling**: Uses `Promise.all()` for concurrent dependency resolution
4. **Memory Management**: Clears instruction arguments after execution
5. **Error-unwind sweep**: An instruction's output is parked in `instrArgs[destination]`
   until the consuming instruction awaits it. If an instruction throws before a
   destination that holds a still-pending promise runs, that promise would otherwise
   be abandoned and surface as an unhandled rejection (process-fatal under strict
   rejection handling). On any throw, the async loop drains every remaining parked
   promise via `Promise.allSettled` (logging rejections, not swallowing them) and
   re-throws the original error.

Dispatch is factored into one synchronous entry loop and one async continuation
loop, parameterized by a small per-mode `RunHooks` seam (optimized / tracing /
metrics). The sweep lives once, in the async loop. The synchronous loop hands off to
the async loop the instant an instruction returns a promise, so it never parks a
promise — nothing to sweep there. Tracing eagerly awaits each promise output before
tracing it (so trace events are ordered by settlement), which means it can never
abandon a promise; the sweep there is defensive. Metrics parks its timing-wrapped
promises like the optimized path and defers awaiting to the destination.
NOTE: `logAggregateMetrics` runs on the normal-completion path only; if the final
instruction returns a bare `Promise` (rare — a SELECT root is an async iterable,
counted synchronously), that one instruction's `out` count may not yet be recorded in
the debug-only aggregate log. Not observable outside the `runtime:metrics` logger.

### Key Points for Emitter Authors

- **Row Descriptors**: Always create row descriptors mapping attribute IDs to column indices
- **Context Cleanup**: Use try/finally blocks to ensure context cleanup
- **Return Types**: Match your function signature to expected output type
- **Async Iterables**: Use `async function*` for row-producing operations
- **Error Handling**: Throw `QuereusError` with appropriate `StatusCode`
- **Attribute Preservation**: Understand whether your node preserves or creates new attributes

## Schema Resolution (Build-Time)

Quereus resolves all schema dependencies during the planning phase and tracks them for automatic plan invalidation:

### Early Resolution at Build Time

All schema objects are resolved during planning and stored directly in plan nodes:

```typescript
// TableReferenceNode stores pre-resolved objects
class TableReferenceNode {
  constructor(
    scope: Scope,
    public readonly tableSchema: TableSchema,
    public readonly vtabModule: VirtualTableModule,
    public readonly vtabAuxData?: unknown
  ) { ... }
}

// ScalarFunctionCallNode stores pre-resolved function
class ScalarFunctionCallNode {
  constructor(
    scope: Scope,
    public readonly expression: AST.FunctionExpr,
    public readonly functionSchema: FunctionSchema,
    public readonly operands: ScalarPlanNode[]
  ) { ... }
}
```

### Dependency Tracking and Auto-Invalidation

The planning context tracks all schema dependencies:

```typescript
// During planning
const functionSchema = resolveFunctionSchema(ctx, 'sum', 1);
const tableSchema = resolveTableSchema(ctx, 'users');
const vtabModule = resolveVtabModule(ctx, 'memory');

// Dependencies tracked automatically
ctx.schemaDependencies.recordDependency({
  type: 'function',
  objectName: 'sum/1'
}, functionSchema);
```

Prepared statements automatically invalidate when dependencies change:

```typescript
// Schema change triggers automatic plan invalidation
schemaManager.createTable(...); // Emits 'table_added' event
// → Statements using affected schema objects recompile automatically
```

## Attribute-Based Context System

Quereus implements a robust attribute-based context system that eliminates the architectural deficiencies of traditional node-based column reference resolution.

**Core Design Principles:**

- **Stable Attribute IDs**: Every column is identified by a unique, stable attribute ID that persists across plan transformations and optimizations.
- **Deterministic Resolution**: Column references use attribute IDs for lookup, eliminating the need for node type checking or fragile node-based resolution.
- **Context Isolation**: Each row context is isolated using row descriptors that map attribute IDs to column indices.
- **Transformation Safety**: Plan transformations (logical→physical) preserve attribute IDs, ensuring column references remain valid.

### Core Types

**RowDescriptor**: Maps attribute IDs to column indices in a row
```typescript
type RowDescriptor = number[];  // attributeId → columnIndex mapping
```

**RowGetter**: Function that provides access to the current row
```typescript
type RowGetter = () => Row;
```

**RuntimeContext**: Uses attribute-based context mapping
```typescript
interface RuntimeContext {
  db: Database;
  stmt: Statement;
  params: SqlParameters;
  context: RowContextMap;  // Row contexts with O(1) attribute index
}
```

### Attribute System

Every relational plan node must implement `getAttributes(): Attribute[]` to define its output schema:

```typescript
interface Attribute {
  id: number;           // Stable, unique identifier
  name: string;         // Column name
  type: ScalarType;     // Column type
  sourceRelation: string; // For debugging/tracing
}
```

**Key principles:**
- Attribute IDs are **stable** across plan transformations
- Column references use attribute IDs for resolution, not node references
- Optimizer preserves attribute IDs when converting logical to physical nodes
- No node type checking required in `emitColumnReference`

## Context Debugging and Tracing

Quereus provides comprehensive debugging infrastructure for diagnosing context-related issues, which are common when developing new emitters or troubleshooting column reference resolution problems.

**`quereus:runtime:context`**: General context lifecycle operations
**`quereus:runtime:context:lookup`**: Column reference resolution attempts

```bash
# Enable all context tracing
set DEBUG=quereus:runtime:context* && yarn test
```

### Debugging Common Issues

**"No row context found" Errors:**
1. Enable `DEBUG=quereus:runtime:context:lookup` to see what contexts are available
2. Check if the expected attribute ID is present in any context
3. Verify context push/pop timing with `DEBUG=quereus:runtime:context`

**Context Lifecycle Issues:**
1. Enable `DEBUG=quereus:runtime:context` to trace context management
2. Look for mismatched PUSH/POP operations
3. Verify contexts are available when column references are evaluated

**Best Practices for Emitter Authors:**
- Always use the logging helpers: `logContextPush()` and `logContextPop()`
- Include meaningful notes that identify the operation context
- Log attribute information when setting up row descriptors
- Always use context helpers (`withRowContext`, `withAsyncRowContext`, `createRowSlot`)
- Never call `rctx.context.set/delete` directly
- Choose the appropriate helper based on your use case
- Include meaningful notes in your instruction's `note` field

## Bags vs Sets (Relational Semantics)

Quereus implements a precise distinction between **bags** (multisets) and **sets** in its relational model, aligning with Third Manifesto principles and enabling sophisticated query optimizations.

### Core Concepts

**Set**: A relation that guarantees unique rows (no duplicates)
- All rows are distinct according to the relation's primary key(s)
- Example: Result of `SELECT DISTINCT`, aggregation results, base tables

**Bag**: A relation that can contain duplicate rows
- Multiple identical rows are possible
- Example: Result of `SELECT * FROM table`, table function outputs

### RelationType.isSet Property

Every relational plan node specifies whether it produces a set or bag via the `isSet` property:

```typescript
interface RelationType {
  ...
  isSet: boolean;  // true = set (unique rows), false = bag (duplicates possible)
  ...
}
```

### Set/Bag Classification by Node Type

**Nodes that produce Sets (`isSet: true`):** - `TableScanNode`, `AggregateNode`/`StreamAggregateNode`, `SingleRowNode`, `SequencingNode`

**Nodes that may produce Bags (`isSet: false`):** - `TableFunctionCallNode` (depends on function declaration), `ProjectNode` (depending on whether key columns are preserved, and whether distinct), `FilterNode` (reflects input), `SortNode` (reflects input), `WindowNode`, `ValuesNode` (assumed to be bag, but we could check statically)

### SequencingNode: Bag-to-Set Conversion

`SequencingNode` is a special operation that converts any bag into a set by adding a unique row number column (`sequenceColumnName`)

**Runtime Behavior:**
```typescript
// Emitter adds row numbers to each row
async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
  let rowNumber = 1;
  for await (const sourceRow of source) {
    yield [...sourceRow, rowNumber++] as Row;
  }
}
```

### Optimization Implications

The bag/set distinction enables important optimizations:

**Set-Specific Optimizations:**
- Duplicate elimination can be skipped for sets
- Certain join algorithms are more efficient with sets
- Set operations (UNION, INTERSECT) have different complexity

**Bag-Aware Planning:**
- Streaming operations can be more efficient on bags
- Memory usage optimizations for bag operations
- Different sorting strategies for bags vs sets

### Third Manifesto Alignment

This design aligns with Third Manifesto principles:
- **Clear Semantics**: Explicit distinction between sets and bags
- **Type Safety**: RelationType captures bag/set information at compile time
- **Algebraic Foundation**: Operations preserve or transform bag/set properties predictably
- **Optimization Enabling**: Type information guides query optimization decisions

## Mutation Operations: Always-Present OLD/NEW Model

Quereus implements a uniform OLD/NEW attribute model for all mutation operations (INSERT, UPDATE, DELETE) that eliminates conditional context management and provides consistent symbol resolution.

### Core Design

**Always-Present Attributes**: Every mutation operation has both OLD and NEW attributes for every table column, regardless of operation type:
- **INSERT**: OLD attributes are constant NULL, NEW attributes contain inserted values
- **UPDATE**: OLD attributes contain pre-update values, NEW attributes contain post-update values  
- **DELETE**: OLD attributes contain deleted values, NEW attributes are constant NULL

**Flat Row Composition**: At runtime, mutation contexts use a flat row format:
```
[oldCol0, oldCol1, ..., oldColN, newCol0, newCol1, ..., newColN]
```

### Planning Phase

During statement building, mutation operations generate:
- `oldRowDescriptor`: Maps OLD attribute IDs to indices 0..n-1 in flat row
- `newRowDescriptor`: Maps NEW attribute IDs to indices n..2n-1 in flat row
- Layered scope registration where unqualified column references default to the meaningful values:
  - INSERT/UPDATE: NEW attributes (since OLD may be NULL/irrelevant)
  - DELETE: OLD attributes (since NEW is always NULL)

### Runtime Execution

**Context Setup**: Single flat context eliminates attribute ID collisions:
```typescript
// Use withRowContext for constraint evaluation
const flatRow = composeOldNewRow(oldRow, newRow, columnCount);
await withAsyncRowContext(rctx, flatRowDescriptor, () => flatRow, async () => {
	await evaluateConstraints(rctx);
});
```

**Symbol Resolution**: Column references resolve deterministically:
- Unqualified `column` → NEW.column (INSERT/UPDATE) or OLD.column (DELETE)
- Qualified `OLD.column` → OLD section of flat row
- Qualified `NEW.column` → NEW section of flat row

**Constraint Evaluation**: All constraints (CHECK, NOT NULL) evaluate against the flat row context without conditional logic. CHECK constraints that reference other relations automatically defer to transaction boundaries via the `DeferredConstraintQueue`, so emitters simply enqueue the evaluator and continue streaming. Deferred rows reuse a single runtime context and row slot for efficiency while preserving scope isolation.

### Benefits

- **Eliminates Context Conflicts**: Single flat descriptor prevents attribute ID collisions
- **Simplifies Emitters**: No conditional OLD/NEW context setup across mutation types
- **Consistent Symbol Space**: OLD/NEW always available, always defined for all operations
- **Easier Reasoning**: Users can reliably reference OLD/NEW in any mutation context
- **Future-Proof**: Supports triggers, defaults, and other features that need OLD/NEW access

### Don't use Conditional Model

The previous model used conditional OLD/NEW descriptors with metadata properties:
```typescript
// OLD MODEL - conditional contexts
if (plan.oldRowDescriptor) {
  rctx.context.set(plan.oldRowDescriptor, () => updateData.oldRow);
}
// Plus hidden __updateRowData properties

// CURRENT MODEL - always-present flat context with helpers
const flatRow = composeOldNewRow(oldRow, newRow, columnCount);
const slot = createRowSlot(rctx, flatRowDescriptor);
try {
	for await (const flatRow of flatRows) {
		slot.set(flatRow);
		yield flatRow;
	}
} finally {
	slot.close();
}
```

This eliminates the break-fix cycle where attribute ID conflicts caused unpredictable column resolution behavior.

## Mutation Context

Quereus supports table-level mutation context variables that provide per-operation parameters for default values and constraints. This feature integrates seamlessly with the existing attribute-based context system.

### Overview

Mutation context allows you to:
- Define reusable parameters in table definitions
- Pass different values for each DML operation
- Use context in default value expressions
- Reference context in CHECK constraints (both immediate and deferred)
- Provide runtime-specific validation rules

### Architecture

**Planning Phase:**
- Context variables are parsed from `WITH CONTEXT (...)` clauses
- Variables converted to attributes with unique attribute IDs
- Context scope created using `RegisteredScope`
- Both unqualified (`varName`) and qualified (`context.varName`) symbols registered
- Context variables registered BEFORE OLD/NEW columns (giving them shadowing precedence)

**Runtime Phase:**
- Context values evaluated once per statement (not per row)
- Context stored in row descriptor using attribute ID mapping
- Context made available via `createRowSlot()` for the statement lifetime
- Context composed with OLD/NEW rows for constraint evaluation: `[context..., old..., new...]`

### Scope Resolution

Mutation context variables are registered in scopes using the same mechanism as table columns:

```typescript
// In constraint-builder.ts
contextAttributes.forEach((attr, contextVarIndex) => {
  const contextVar = tableSchema.mutationContext![contextVarIndex];
  const varNameLower = contextVar.name.toLowerCase();

  // Register both unqualified and qualified names
  constraintScope.registerSymbol(varNameLower, (exp, s) =>
    new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
  );
  constraintScope.registerSymbol(`context.${varNameLower}`, (exp, s) =>
    new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
  );
});
```

**Resolution Order:**
1. Context variables registered first (in constraint scopes)
2. OLD/NEW columns registered after
3. Unqualified references resolve to context if name matches
4. Qualified `context.varName` always resolves to context

### Runtime Integration

**Context Evaluation:**
```typescript
// In constraint-check emitter
// Evaluate context once per statement
const contextRow: Row = [];
for (const contextEvaluator of contextEvalFunctions) {
  // Hop-free on the synchronous fast path (see Scheduler-Centric Execution Model).
  const raw = contextEvaluator(rctx);
  const value = (raw instanceof Promise ? await raw : raw) as SqlValue;
  contextRow.push(value);
}

// Install context for statement duration
const contextSlot = createRowSlot(rctx, contextDescriptor);
contextSlot.set(contextRow);

try {
  // Process rows - context available to all child operations
  for await (const row of inputRows) {
    // Defaults and constraints can reference context variables
  }
} finally {
  contextSlot.close();
}
```

**Combined Row Composition:**
For constraint evaluation, context is composed with OLD/NEW rows:
```typescript
const combinedRow = [...contextRow, ...oldRow, ...newRow];
const combinedDescriptor = composeCombinedDescriptor(contextDescriptor, flatRowDescriptor);
```

**Descriptor Composition:**
```typescript
function composeCombinedDescriptor(
  contextDescriptor: RowDescriptor, 
  flatRowDescriptor: RowDescriptor
): RowDescriptor {
  const combined: RowDescriptor = [];
  const contextLength = Object.keys(contextDescriptor).length;

  // Context attributes: indices 0..contextLength-1
  for (const attrIdStr in contextDescriptor) {
    const attrId = parseInt(attrIdStr);
    combined[attrId] = contextDescriptor[attrId];
  }

  // OLD/NEW attributes: offset by contextLength
  for (const attrIdStr in flatRowDescriptor) {
    const attrId = parseInt(attrIdStr);
    combined[attrId] = flatRowDescriptor[attrId] + contextLength;
  }

  return combined;
}
```

### Deferred Constraints

Mutation context is captured and preserved for deferred constraints:

**Queueing:**
```typescript
rctx.db._queueDeferredConstraintRow(
  baseTable,
  constraintName,
  coerceNewSection(row, tableSchema),  // NEW section coerced to column logical types
  flatRowDescriptor,
  evaluator,
  connectionId,
  contextRow,        // Captured context values
  contextDescriptor  // Context row descriptor
);
```

The NEW section of the snapshotted row (indices `n..2n-1`) is coerced to the
declared column logical types via `validateAndParse` before queueing. The insert
pipeline otherwise defers type conversion to the storage layer's `performInsert`,
so the row reaching the ConstraintCheck node still holds *raw* NEW values. Deferred
CHECK subqueries compare those values against rows already stored (and therefore
coerced) in other tables, so without this step a logical type that rewrites its
value on parse (e.g. `datetime`) would spuriously fail equality at COMMIT (GitHub
#25). OLD values are left untouched — they are NULL on INSERT or read from
already-coerced stored rows on UPDATE — and a per-cell parse failure falls back to
the raw value so the row's own `performInsert` remains the authoritative source of
the MISMATCH error.

**Evaluation at COMMIT:**
```typescript
// Compose context with flat row for deferred evaluation
const evaluationRow = entry.contextRow 
  ? [...entry.contextRow, ...entry.row] 
  : entry.row;
const evaluationDescriptor = entry.contextRow && entry.contextDescriptor
  ? composeCombinedDescriptor(entry.contextDescriptor, entry.descriptor)
  : entry.descriptor;

// Evaluate with context available
const slot = createRowSlot(runtimeCtx, evaluationDescriptor);
slot.set(evaluationRow);
const value = await entry.evaluator(runtimeCtx);
```

### Plan Node Structure

**DML Nodes (InsertNode, UpdateNode, DeleteNode):**
- `mutationContextValues?: Map<string, ScalarPlanNode>` - Value expressions for each variable
- `contextAttributes?: Attribute[]` - Attribute metadata for context variables
- `contextDescriptor?: RowDescriptor` - Maps attribute IDs to row indices

**ConstraintCheckNode:**
- Receives mutation context from parent DML node
- Stores context for use during emission
- Passes context through optimizer transformations

### Integration with Existing Systems

**Attribute-Based Context:**
- Mutation context uses the same attribute ID system as OLD/NEW rows
- Context attributes have unique, stable IDs
- No special handling needed - integrates with existing `resolveAttribute()`

**Row Descriptors:**
- Context uses standard row descriptors
- Context row composed with OLD/NEW rows for constraint evaluation
- Single combined descriptor provides unified attribute lookup

**Transaction Support:**
- Context evaluated per statement
- Captured for deferred constraints
- Preserved across savepoints (part of queued row data)

### Statement-Level Atomicity

A multi-row `INSERT`/`UPDATE`/`DELETE` is atomic at the statement level: either
all of its row effects apply or none do, mirroring SQLite's
implicit-savepoint-per-statement semantics. In autocommit this is masked because
`_finalizeImplicitTransaction` rolls back the whole implicit transaction on
error; inside an explicit `begin … rollback` the guarantee comes from a
statement-scope savepoint instead.

All three DML generators route through one shared higher-order async generator,
`runWithStatementSavepoints` (`runtime/emit/dml-executor.ts`), which owns the
savepoint lifecycle and calls back a per-row `processRow` closure for the
operation-specific body:

- **non-FAIL** (ABORT default / IGNORE / REPLACE / ROLLBACK): a single
  statement-scope savepoint (`__stmt_atomic_N`) is opened before the row loop,
  released after it completes, and rolled-back-and-released on **any** throw
  escaping the loop — whether from the source iterator (a `ConstraintCheckNode`
  above the executor raising NOT NULL / CHECK / parent-side FK RESTRICT before a
  row is yielded) or from `processRow` (a vtab-returned constraint, or the
  runtime RESTRICT pre-check). This is what reverts rows 1..N-1 when row N fails.
- **OR FAIL**: deliberately *skips* the statement wrap (FAIL keeps prior rows)
  and instead opens a per-row savepoint (`__or_fail_N`), released on success and
  rolled back on throw, so only the failing row's partial work (including a
  row-time MV backing write that landed before a later maintenance throw) is
  undone.

At the **end-of-statement boundary** — after the row loop completes and (for
non-FAIL) **before** the statement savepoint releases — the generator drains its
per-statement *deferred full-rebuild set* via `Database._flushDeferredRebuilds`.
Only the full-rebuild materialized-view arm is deferred there (the bounded-delta
arms apply per row inside `processRow`); each source row that touched a
full-rebuild MV marked it dirty, and the flush rebuilds each such MV exactly once.
Placing it inside the statement savepoint makes a failed rebuild roll the whole
statement back, and a statement that aborts mid-loop never reaches the flush (so a
dirtied-then-aborted MV leaves its backing untouched). FAIL mode still runs the
flush after the loop, but — having no statement savepoint (it keeps prior rows via
per-row savepoints) — a flush failure there does not unwind the already-applied
rows, consistent with FAIL's keep-prior-rows semantics. See
`docs/incremental-maintenance.md` § end-of-statement flush.

The savepoint helpers used are always the broadcast variants
(`_createSavepointBroadcast` / `_releaseSavepointBroadcast` /
`_rollbackAndReleaseSavepointBroadcast`) so per-connection savepoint stacks stay
in lockstep with the `TransactionManager`'s stack. This covers the row-time MV
backing connection, which registers lazily on the first maintenance call:
`Database.registerConnection` replays the active savepoint depth (which already
includes the statement savepoint created before the row loop) onto it, so the
backing write participates in the same rollback/release.

### DML executor: read/write phase separation (physical Halloween)

A predicate `DELETE`/`UPDATE` reads its target table (the source scan) and writes
it (the per-row `vtab.update()`). Streaming those two phases on one live cursor —
pull a source row, apply its mutation inline, pull the next — is the classic
**physical Halloween hazard**: the write mutates the very structure the scan
cursor is still walking. A backing store whose scan cursor caches a path into a
shared b-tree has that path invalidated by the first write and the next
`cursor.next()` throws (e.g. `Path is invalid due to mutation of the tree`).

Whether streaming is safe is a **module property**, so it is gated on a module
capability flag, `VirtualTableModule.scanSnapshotIsolation` (default **false**):

- **Snapshot-isolated (`true`)** — a `query()` iterator sees a stable snapshot
  even if `update()` mutates the same table mid-scan. The memory module qualifies
  (it captures an immutable layer at `query()` entry and writes a fresh child
  layer), so `runUpdate`/`runDelete` **stream** the source, paying no buffering
  cost. This is the common path and keeps existing behavior unchanged.
- **Not snapshot-isolated (default)** — `runUpdate`/`runDelete` fully **drain**
  the source match set into an array (`drainSourceRows`), closing the scan cursor,
  **before** applying any write. The read phase now precedes the write phase in
  full, matching SQLite's "figure out which rows to change, then change them".

The false default is correctness-first: any durable / third-party store is correct
out of the box (it buffers) and opts into streaming only after it can prove
per-scan snapshot isolation. Buffering costs O(match-set) memory for such a store
(a `DELETE big WHERE rare` matching millions materializes them all) — the accepted
price of correctness, since such a store cannot safely stream-delete anyway. The
drain feeds the same `runWithStatementSavepoints` loop, so savepoint / FAIL-mode /
RETURNING semantics are unchanged (RETURNING still streams per row after the
drain). An FK cascade issues its own child `DELETE`/`UPDATE` through a fresh
executor call, which makes its own drain-or-stream decision from the *child*
module's flag.

**Boundary — INSERT-source Halloween is out of scope here.** An
`INSERT … SELECT` that reads the same table it inserts into is a *different*
Halloween shape (the insert node, `runInsert`); it is not addressed by this
read/write split and relies on the memory savepoint snapshot + the existing
CTE/Halloween machinery for today's tested paths.

### Per-row post-write pipeline and internal evictions

After each successful `vtab.update()`, the executor's `processRow` body runs one
**post-write pipeline** for the row: change-tracking (`_recordInsert` /
`_recordUpdate` / `_recordDelete`, consumed by `Database.watch` / change-scope and
the `DeltaExecutor`), row-time materialized-view backing maintenance
(`maintainRowTimeStructures`), foreign-key `ON DELETE` / `ON UPDATE` actions
(`executeForeignKeyActions`), and — for modules without native event support — a
data-change auto-event. This pipeline has exactly one home; substrates do not drive
any of it themselves.

A REPLACE conflict resolved inside `vtab.update()` can delete rows the executor
never asked it to touch. Two channels on the `ok` `UpdateResult` report them so the
pipeline still runs uniformly (`internal-eviction-reporting`):

- **`replacedRow`** — the row displaced at the *same PK* by a PK-collision REPLACE,
  modeled as an update-in-place of that PK slot (FK fired as a delete of the old
  image).
- **`evictedRows`** — rows at *other PKs* removed because REPLACE resolved a non-PK
  UNIQUE conflict for this same call. The executor runs the **full delete pipeline**
  for each (a shared `processEvictions` helper: `_recordDelete` +
  `maintainRowTimeStructures({op:'delete'})` + `executeForeignKeyActions('delete')` +
  a delete auto-event), fired **before** the writing row's own bookkeeping so the
  evict-then-write order the substrate journaled is preserved. This is what makes a
  secondary-UNIQUE REPLACE eviction fire FK cascades, change subscriptions, events,
  and covering-MV backing maintenance — uniformly across the memory, store, and
  isolation substrates, none of which re-drive the pipeline themselves.

`processEvictions` enforces FK `RESTRICT` / `NO ACTION` for the eviction's would-be
delete alongside the FK *actions* (`CASCADE` / `SET NULL` / `SET DEFAULT`). The substrate
has already physically removed the evicted row inside `vtab.update()`, so there is no
pre-mutation point at which to block; instead the helper runs the transitive RESTRICT scan
(`assertTransitiveRestrictsForParentMutation`) **post-eviction** — the child rows the scan
keys off remain, so `select 1 from child where fk = ?` still answers correctly — and, on a
violation, throws. `runWithStatementSavepoints` then rolls back the statement-scope
savepoint (`__stmt_atomic_N`, opened before the row loop), unwinding both the substrate's
eviction and the writing row. (Evictions only occur under REPLACE resolution, which is
never `OR FAIL`, so the non-FAIL statement-savepoint branch always applies.) The surfaced
error is the `FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from
'<child>'` form — not the plan-time `CHECK constraint failed: _fk_...` form — since the
plan-time parent-side FK check is absent for internal evictions. Enforced on the key-based
memory, direct-store, and isolation-wrapped substrates. Rowid-chained backends (lamina) are
out of scope: the transitive recursion reads children at call time and, post-eviction, the
parent value is gone, so a deeper cascade may not resolve — mirroring the documented
SET-DEFAULT recursion gap and no regression beyond status quo.

**Internal statement cache.** The per-row FK/DDL enforcement statements — the RESTRICT
existence probe (`assertNoRestrictedChildrenForParentMutation` and its lens dual), the
transitive cascade pre-walk child scan, the cascade DML
(`executeSingleFKAction`'s `DELETE`/`UPDATE`), and the drop-referencing check
(`SchemaManager.assertNoReferencingChildrenForDrop`) — are executed through a
per-`Database` LRU pool of compiled statements keyed by exact SQL text
(`InternalStatementCache`), rather than a fresh `prepare`/`finalize` per affected row (the
engine has no plan cache, so each fresh prepare pays a full parse + plan + emit). Each fixed
shape compiles once and rebinds; a bulk cascade over N parents runs a couple of compiles, not
2N. Correctness rides existing `Statement` behavior: the compiled statement subscribes to
schema-change notifications and lazily recompiles across intervening DDL, and a cascade that
re-enters with the same SQL text while that statement is mid-iteration falls back to a fresh
one-shot statement (the busy-guard) rather than sharing a live cursor. Internal probes are
prepared type-agnostically, so a loose-affinity FK column binding an integer key on one row
and a text key on another under one SQL shape is neither rejected nor served a
first-use-frozen plan. Deliberately internal — not a public statement-cache feature. The
batched RESTRICT flush is a handful of compiles per statement, not per row, so it is left on
the plain `prepare` path.

### Batched RESTRICT

Parent-side RESTRICT enforcement normally costs **two** probes per mutated parent row per
inbound FK: the plan-time synthesized `NOT EXISTS(select 1 from child where fk = OLD.pk)`
constraint (compiled once, evaluated per row by `ConstraintCheckNode`) and the runtime
transitive pre-walk (`assertTransitiveRestrictsForParentMutation` inside
`processDeleteRow` / `processUpdateRow`). On a high-latency store each probe is a storage
round-trip, so a bulk parent DELETE paid O(rows × FKs) round-trips even when nothing
references the deleted keys.

For statement shapes where it is provably equivalent, both per-row probes are replaced by
**one chunked probe per inbound FK at the end-of-statement boundary**. The shared
batchability gate, `getBatchableRestrictFks` (`planner/building/foreign-key-builder.ts`),
is consulted by both the plan builders (`buildDeleteStmt` / `buildUpdateStmt` skip the
per-row `NOT EXISTS` checks) and the DML executor (`runDelete` / `runUpdate` skip the
per-row pre-walk), so the two sides cannot disagree. A DELETE/UPDATE batches iff it is
not lens-routed, its effective conflict resolution is default/ABORT or ROLLBACK, and
**every** inbound FK is a non-self-referential `restrict` for the op:

- **FAIL / IGNORE / REPLACE** have per-row keep/skip semantics a statement-end check
  cannot honor (FAIL keeps prior rows; the gate excludes it, so the flush always runs
  under the statement-scope savepoint).
- **Any cascading / set-null / set-default inbound FK** forces the per-row transitive
  pre-walk, which must interleave with cascade execution (a cascade could delete a
  RESTRICT child's rows mid-statement).
- **A self-referential FK**'s check outcome depends on which rows of the same table the
  statement has already deleted, so it stays per-row.

During the row loop the executor accumulates each affected row's OLD referenced-key tuple
into per-execution, per-FK state (`createParentRestrictBatch` /
`accumulateParentRestrictKeys`, `runtime/foreign-key-actions.ts`) — deduplicated on an
injective serialization, skipping tuples containing NULL (MATCH SIMPLE) and UPDATE rows
that change no referenced column. The state is allocated per execution (never on the emit
closure), so a re-run prepared statement starts empty. `flushParentRestrictBatch` fires in
`runWithStatementSavepoints` after the row loop, **before** the deferred-maintenance flush
(fail fast — skip wasted MV work) and before the statement savepoint releases, probing
each FK's child table in ~500-key chunks (`fkcol in (?, …)`, or OR-of-conjunctions for a
composite FK — plain SQL `=`/`IN` against the child column, so collation semantics match
the per-row `NOT EXISTS` by construction). A hit throws the existing
`FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from '<child>'`
error and the statement savepoint unwinds every row — the same final state and error class
as a per-row abort. The REPLACE-eviction path (`processEvictions`) always stays per-row.

The one observable divergence: a consumer streaming `RETURNING` rows sees **all** rows
yielded before the violation aborts the statement, instead of only the rows preceding the
violating one — transient output before an error that voids the statement either way.

### Implementation Guidelines for Emitter Authors

**When adding new mutation operations:**
1. Process `stmt.contextValues` in the builder
2. Create context attributes with unique IDs
3. Build context expression plan nodes
4. Create context scope and register variables (both forms)
5. Pass context scope when evaluating defaults
6. Pass context attributes to `buildConstraintChecks()`
7. Create context descriptor from attributes
8. Pass mutation context to plan node constructors
9. Pass mutation context to ConstraintCheckNode

**Key Points:**
- Context is evaluated once per statement (performance)
- Context persists for entire statement via row slot
- Context composed with OLD/NEW for constraints
- Deferred constraints capture and preserve context
- Use existing context helpers - no special APIs needed

## Determinism Validation

The real invariant Quereus needs in DEFAULT / CHECK / GENERATED clauses is not
"the source expression is deterministic" — it is "the captured artifact at the
`vtab.update()` frontier is fully resolved and replayable." That invariant is
satisfied by construction: defaults and stored generated columns are evaluated
per row before reaching the module, immediate row CHECKs fire at write time so
only passing rows reach `vtab.update()`, and deferred CHECKs evaluate once at
commit (their outcome decides commit-vs-rollback for the entire transaction,
so replay-via-module-layer cannot disagree with the commit outcome).

Because of this, the prohibition on non-deterministic expressions in DDL is a
**stricter-than-necessary proxy** for the actual replay contract, not a
correctness requirement. Quereus therefore defaults to strict rejection for
backward compatibility but exposes a single opt-in to lift the gate when you
want it.

### The `nondeterministic_schema` option

| Option | Type | Default | Aliases |
| --- | --- | --- | --- |
| `nondeterministic_schema` | boolean | `false` | `allow_nondeterministic_schema_expressions` |

Set programmatically or via PRAGMA:

```sql
pragma nondeterministic_schema = true;
pragma nondeterministic_schema;
-- → [{"name":"nondeterministic_schema","value":true}]
```

```typescript
db.setOption('nondeterministic_schema', true);
```

When `true`, Quereus permits non-deterministic expressions in DEFAULT, CHECK,
and `GENERATED ALWAYS AS` clauses. Capture still happens at the resolved-row
frontier: the row stored in the table (and the literal SQL produced by
`buildInsertStatement` / `buildUpdateStatement` / `buildDeleteStatement` in
`util/mutation-statement.ts`) contains the concrete value the engine
evaluated for that row.

The option is not baked into any persisted schema; toggling it affects
validation of *subsequent* DDL/DML only — already-created tables keep
whatever expressions they were created with.

### Strict-mode behaviour (default)

The default `nondeterministic_schema = false` preserves the historical
rejection paths.

**Rejected in Constraints and Defaults:**
- `random()`, `randomblob()` - Random value generation
- `date('now')`, `time('now')`, `datetime('now')`, `julianday('now')` - Current time functions
- User-defined functions marked as non-deterministic
- Any expression containing non-deterministic sub-expressions
- DML in expression position (`(insert/update/delete … returning …)` inside
  a CHECK / DEFAULT / assertion expression). DML is non-deterministic via
  the side-effect axis — the `DmlExecutorNode` sets `deterministic: false`,
  which propagates through the AND-of-children physical-properties chain
  and is rejected by the determinism enforcer.

**Allowed in Constraints and Defaults:**
- Constant literals: `42`, `'hello'`, `true`
- Deterministic built-in functions: `upper()`, `lower()`, `abs()`, `round()`
- Column references: `NEW.price`, `OLD.quantity`
- Mutation context variables: `context.timestamp`, `context.user_id`
- User-defined functions marked as deterministic (default)

### Using Mutation Context for Non-Deterministic Values

Instead of using non-deterministic functions directly, pass values via mutation context:

```sql
-- ❌ REJECTED: Non-deterministic default
create table orders (
    id integer primary key,
    created_at text default datetime('now')  -- ERROR
);

-- ✅ ACCEPTED: Use mutation context
create table orders (
    id integer primary key,
    created_at text default timestamp
) with context (
    timestamp text
);

-- Pass the timestamp when inserting
insert into orders (id)
with context timestamp = datetime('now')
values (1);
```

### Physical Properties System

Determinism is tracked through the `PhysicalProperties` system:

```typescript
interface PhysicalProperties {
    deterministic: boolean;  // Same inputs → same outputs
    readonly: boolean;       // No side effects
    idempotent: boolean;     // Safe to call multiple times
    constant: boolean;       // Directly produces constant result
}
```

**Propagation Rules:**
- Function nodes check the `FunctionFlags.DETERMINISTIC` flag
- Non-deterministic functions mark `deterministic: false`
- Properties propagate bottom-up through the expression tree
- Parent nodes inherit the most restrictive properties from children

**User-Defined Functions:**
```typescript
// Non-deterministic UDF
db.createScalarFunction("my_random",
    { numArgs: 0, deterministic: false },
    () => Math.random()
);

// Deterministic UDF (default)
db.createScalarFunction("my_upper",
    { numArgs: 1, deterministic: true },  // or omit (defaults to true)
    (text) => String(text).toUpperCase()
);
```

### Validation Timing

All determinism rejection sites described below are skipped when
`nondeterministic_schema = true`. The bind-parameter / column-reference
pre-walks remain active in both modes (those are scope checks, not
determinism checks).

**CREATE TABLE:**
- DEFAULT expressions are rejected if they reference bind parameters
  (`?`, `:name`) or a **bare** table column; both are detected via an AST
  pre-walk before expression building. A `new.<column>` reference is the
  exception — it explicitly reads a sibling value the INSERT supplies, so it
  passes the pre-walk and its build/determinism check is deferred to INSERT
  time (the row scope isn't available at CREATE TABLE), alongside the existing
  deferrals for mutation-context identifiers and self-referencing subqueries.
- DEFAULT expressions are then built and rejected if their physical
  `deterministic` property is false (e.g. `random()`).
- CHECK constraints are walked at DDL time: any function call is looked up
  against the registry and rejected unless it has the `DETERMINISTIC` flag.
  Bind parameters (`?`, `:name`) are also rejected at DDL time. Column
  references inside CHECK predicates are validated later, at INSERT/UPDATE
  time, when the row scope is established.

`ALTER TABLE … ALTER COLUMN … SET DEFAULT` routes the new default through the
**same** validator (`SchemaManager.validateAlterColumnDefault`): bind
parameters / bare columns / non-determinism are rejected at `ALTER` time, and a
`new.<column>` default is accepted with the build/determinism check deferred to
INSERT time. `ALTER TABLE ADD COLUMN` routes its default through the same shared
validator (`SchemaManager.validateAddColumnDefault`, at plan-build time) — a
non-foldable, deterministic default (including `new.<column>`) is now accepted.
A literal / NULL default is bulk-written to every existing row by the module's
`addColumn` (the fast path). A non-foldable default is **backfilled per existing
row**: the planner compiles it against the table's *existing* columns as the
"supplied" row (the same `buildRowDefaultScope` the single-source INSERT and
view-write key default use) and hangs the scalar on the `AlterTableNode`; the
emitter installs a row slot over each existing row and passes a per-row evaluator
to `module.alterTable`, so `new.<column>` resolves to the existing row's sibling.
The memory module applies the evaluator while it appends the column (building the
new tree locally and swapping it in only once every row migrates; the store module
likewise accumulates into a batch and writes only after the loop), enforcing the
column's NOT NULL on the produced value before commit. CHECK enforcement splits by
default kind:

- **Literal / NULL default** — new CHECK constraints are validated against the
  backfilled rows by a post-`alterTable` scan, reverting the column add on a
  violation.
- **Non-foldable (per-row) default** — each column-level CHECK is compiled at
  plan-build time (against the existing columns plus the new column) and evaluated
  *inside the per-row backfill hook* against `[...existingRow, backfilledValue]`,
  mirroring the per-row NOT NULL path. A violating row throws mid-loop, so the
  module's local tree/batch is discarded before any swap and the catalog is never
  mutated — no separate revert needed. The post-scan is skipped on this path
  (it would read a stale pre-backfill snapshot). Truthiness matches write-time
  CHECK semantics (fails on `false`/`0`, passes on truthy/NULL), and the new
  column's declared collation is carried into the predicate so comparisons resolve
  the same collation as at write time.

The compiled CHECKs are also merged into the table-level constraint set, so future
INSERT/UPDATE enforce them the same way. `ADD CONSTRAINT` likewise validates at
first INSERT/UPDATE.

A **column-level FOREIGN KEY** added via `ADD COLUMN` validates the existing
(backfilled) rows against the referenced parent, for **both** default kinds, via a
single post-`alterTable` scan using the shared `validateForeignKeyOverExistingRows`
primitive — the same one `ADD CONSTRAINT` calls, so the two paths cannot drift. It is
MATCH SIMPLE (a fully-non-NULL backfilled value with no matching parent row aborts; a
NULL value satisfies the FK), pragma-gated (`pragma foreign_keys = false` skips it),
and runs in the **same try/revert region** as the literal-default CHECK scan, so a
violation drops the new column and restores the original catalog entry. Unlike CHECK,
FK validation runs for **all** default kinds (literal and per-row): it is a
cross-table existence check, not a per-row predicate, and a post-scan reads a
consistent post-alter table — correct even for a self-referential FK (parent ==
child) and for the parent-absent case (any fully-non-NULL backfilled row is an
orphan). The new column-level FK is also merged into the table-level constraint set
for forward INSERT/UPDATE enforcement.

> **Why validation runs against an intermediate schema.** The optimizer trusts a
> DECLARED constraint as a proven invariant, which makes each existing-row validator
> fold away its own work if the new constraint is already live during the pass:
> - The FK validator issues a `NOT EXISTS` correlated subquery (the same form `ADD
>   CONSTRAINT` uses). The decorrelator may materialize it as an anti-join, which
>   `ruleAntiJoinFkEmpty` folds to `EmptyRelation` under the inclusion dependency
>   `child.fk ⊆ parent.pk`.
> - The literal-default CHECK scan issues `select 1 from <t> where not (<check>)`. A
>   declared CHECK `<p>` seeds a domain constraint on the scan, so `ruleFilterContradiction`
>   folds `where not (<p>)` to `EmptyRelation` (the domain `<p>` and predicate `not <p>`
>   are jointly unsatisfiable).
>
> Either fold makes validation trust the very invariant it is checking and silently admit
> a violating row. So ADD COLUMN registers the new **column with only the pre-existing
> (already-proven) constraints** for the validation pass — an intermediate
> `validationSchema` that omits the new FK(s) **and** the new CHECK(s) — then commits the
> full schema **after** validation passes. The live schema the planner reads during
> validation therefore declares neither the new FK nor the new CHECK to fold against, so
> the validators read the freshly-backfilled column directly and surface real violations.
> This mirrors `ADD CONSTRAINT`, which likewise validates before swapping the constraint
> into the live schema.

**INSERT/UPDATE:**
- DEFAULT expressions validated when building row expansion
- CHECK constraints validated when building constraint checks (full
  column-scope resolution happens here)
- `GENERATED ALWAYS AS` expressions validated when building the generated
  column projection (INSERT) or assignment chain (UPDATE)

**ALTER TABLE ADD CONSTRAINT:**
- Validation deferred to first INSERT/UPDATE (constraints may reference NEW/OLD)

## Common Patterns

### Row Processing with Context
```typescript
// Streaming pattern with row slot
async function* run(rctx: RuntimeContext, input: AsyncIterable<Row>): AsyncIterable<Row> {
	const slot = createRowSlot(rctx, rowDescriptor);
	try {
		for await (const row of input) {
			slot.set(row);
			yield processRow(row, rctx);
		}
	} finally {
		slot.close();
	}
}
```

### Scalar Functions
```typescript
function run(rctx: RuntimeContext, ...args: SqlValue[]): SqlValue {
	// Compute result
	return result;
}
```

### Side Effects (DDL/DML)
```typescript
async function run(rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<undefined> {
	// Process each row with proper context
	for await (const row of input) {
		await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
			await performMutation(row, rctx);
		});
	}
	return undefined;
}
```

### Impure subquery emitters: full-drain + run-once

Scalar, `IN`, and `EXISTS` subquery emitters detect a side-effecting inner via
`PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery)` and switch to
an impure-path implementation that applies two contracts:

- **Full drain.** The emitter iterates every row of the inner. The pure path's
  short-circuits (scalar's "first row only" / `IN`'s "first match" / `EXISTS`'s
  "first row") would skip writes past row 1, so they are dropped for impure
  inners. Loss of the short-circuit is acceptable because (a) it only fires for
  DML-bearing inners and (b) correctness trumps the optimization there.
- **Run-once per statement execution.** A correlated outer expression or a
  per-row scan would re-invoke the scalar subquery's `run` function once per
  outer row. The emitter memoizes the materialized result and the
  scalar/`EXISTS`/`IN` answer on first call, and replays the memoized answer
  on subsequent calls without re-driving the iterator. The memo lives on the
  per-execution `RuntimeContext` (`ctx.executionMemo`, keyed by a symbol minted
  at emit time), not in the emit-time closure — so a `Statement` that caches and
  reuses its instruction tree across executions still resets the memo between
  prepared-statement runs, re-driving the inner DML once per run.

Both contracts are gated by `physical.readonly === false` on the inner — pure
subqueries take a non-impure path. For `IN`, that path splits again: an
uncorrelated + functional source is materialized once per execution into a
probed lookup set (`runSetProbe`; see [Runtime caching § IN-subquery set probe](runtime-caching.md#in-subquery-set-probe)),
while a correlated or non-deterministic source keeps the per-outer-row streaming
short-circuit. Scalar / `EXISTS` pure inners take their unchanged short-circuit
fast path. See `src/runtime/emit/subquery.ts` for the emitter source.

DML in expression position is rejected as a view body at view-creation time
(see `src/planner/building/create-view.ts`). A view body re-evaluates on
every reference; a DML body would re-drive writes per read, which the
run-once fence cannot rescue (views compose, the cache lives at one emission
site, and a downstream consumer would observe stale state). The check is
permanent, not pending.

### Per-execution caches

Inner-scan connection reuse, `CacheNode` row-cache lifetime, and shared
(multi-reference) CTE materialization are documented in
[Runtime Caching](runtime-caching.md).

## Query Optimizer Integration

The Quereus optimizer transforms logical plan nodes into physical execution plans between the builder and runtime phases. This section covers the key aspects relevant to runtime emitter development.

### Optimizer Overview

The optimizer uses a single plan node hierarchy with logical-to-physical transformation:
- **Logical nodes**: Created by the builder - may or may not have physical emitters
- **Physical nodes**: Transformed by the optimizer with execution properties
- **Attribute preservation**: Column references use stable attribute IDs that survive optimization

Key optimizer guarantees for emitter authors:
- Every node reaching the emitter phase has `physical` properties set
- Attribute IDs remain stable across all transformations
- Column references can rely on deterministic attribute ID lookup
- The optimizer respects virtual table capabilities via `BestAccessPlan`

### Physical Properties

Physical properties capture execution characteristics used by both optimizer and runtime:
```typescript
interface PhysicalProperties {
  ordering?: Ordering[];        // Output row ordering
  estimatedRows?: number;       // Cardinality estimate
  uniqueKeys?: number[][];      // Attribute IDs forming unique keys
  deterministic: boolean;       // Pure and repeatable
  readonly: boolean;            // No side effects
}
```

These can be overridden through overriding the computePhysical() plan node method, otherwise these are inherited from child nodes or are defaults.
```typescript
computePhysical(): Partial<PhysicalProperties> {
  return {
    readonly: false,  // Side-effecting (should only be set if the node directly mutates)
    estimatedRows: this.source.estimatedRows,
    uniqueKeys: this.source.getType().keys.map(key => key.map(colRef => colRef.index)),
  };
}
```

### Attribute ID System

The runtime's column reference resolution relies on the optimizer's attribute ID preservation:
- Each column has a unique, stable attribute ID assigned during planning
- The optimizer's `withChildren()` infrastructure preserves these IDs
- Runtime column lookup uses attribute IDs, not names or positions
- This enables robust resolution across arbitrary plan transformations

For comprehensive optimizer details, see the [Optimizer Documentation](optimizer.md).

## ParallelDriver (Runtime Primitive)

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

`src/runtime/parallel-driver.ts` exposes a `ParallelDriver` class with two operations:

- `fork(rctx, n)` — returns `n` independent `RuntimeContext` views. Each fork has its own `RowContextMap` (seeded with a snapshot of the parent's entries) and its own `tableContexts` `Map` (seeded with a shallow copy). Writes via `createRowSlot`, `withRowContext`, or direct `tableContexts.set/delete` in one fork do not leak to siblings or to the parent. The fork's view of `context` and `tableContexts` is **snapshot-at-fork**, not read-through: parent mutations made *after* the fork is created are not visible inside the fork. Callers must therefore treat the parent's `context` and `tableContexts` as immutable for the lifetime of the forks. Read-mostly fields (`db`, `stmt`, `params`, `enableMetrics`, `tracer`, `activeConnection`, `contextTracker`, `planStack`) are shared by reference; concurrent mutation of those by branch code is the caller's responsibility (the driver makes no concurrency guarantee about them).
- `drive(factories, forks, opts?)` — runs N `(ctx) => AsyncIterable<T>` factories concurrently with optional `concurrency` cap and `AbortSignal` cancellation, yielding `{ branch, value }` pairs in arrival order. On any branch error or signal abort, all sibling iterators are best-effort `return()`-closed before the error propagates; the same close-all path runs when a consumer breaks out of the `for-await` early. Close is prompt **and** drained: each live branch is signalled via `return()` (interrupting a parked `next()`) *and* its outstanding pull is awaited, so cleanup never resolves while a `next()` the driver started is still executing and possibly still touching cursor/vtab state. A source that both ignores `return()` and parks its `next()` forever therefore hangs cleanup rather than leaking a runaway pull (see the `closeBranch` `NOTE:` in `parallel-driver.ts`).

The driver is intentionally combinator-agnostic — it does not gather, zip, merge, or otherwise combine branch outputs. It has no plan-node or emitter consumers yet; it exists as the foundation primitive for the broader `parallel-*` track. Parallel use of virtual-table connections is governed by the module's declared `concurrencyMode` (see [Module Authoring § Concurrency Mode](module-authoring.md#3-concurrency-mode-parallel-runtime)); consumers call `getModuleConcurrencyMode(module)` and `acquireConnectionLock(connection)` (from `vtab/concurrency.ts`) to fall back to serial behavior when a `'serial'` module's connection is shared across sibling branches. The driver itself does not enforce the lock — enforcement belongs in the consumer that owns the vtab interaction (e.g. fan-out lookup join).

### Parallel runtime fork contract

Three invariants govern what code may do with a `RuntimeContext` once it has been forked. They are enforced by the test harness in `packages/quereus/test/runtime/fork-contract.spec.ts`.

**1. Fork policy per RuntimeContext field.** Every field has a declared policy:

| Field | Policy | Meaning |
| --- | --- | --- |
| `db` | `shared-frozen` | Shared by reference, immutable for fork lifetime. |
| `stmt` | `shared-frozen` | Shared by reference. |
| `params` | `shared-frozen` | Shared by reference (bound args). |
| `context` | `forked` | Independent per branch (snapshot-at-fork). |
| `tableContexts` | `forked` | Independent per branch (snapshot-at-fork). |
| `tracer` | `shared-sink` | Shared write-only instrumentation. |
| `activeConnection` | `shared-cooperative` | Vtab's `concurrencyMode` declares concurrent-use safety; `'serial'` (the default) requires `acquireConnectionLock`. |
| `enableMetrics` | `shared-frozen` | Boolean flag. |
| `contextTracker` | `shared-sink` | Diagnostics sink. |
| `planStack` | `shared-sink` | Tracing-only stack. |
| `executionMemo` | `shared-cooperative` | Once-per-execution impure-subquery memo; shared so the run-once contract spans branches. |
| `scanConnections` | `shared-cooperative` | Once-per-execution inner-scan connection cache; shared so statement teardown disconnects every branch's instances exactly once. |
| `cacheStates` | `shared-cooperative` | Once-per-execution `CacheNode` row-cache map; shared so a cache materialized in one branch is visible to a sibling branch re-driving the same cache site. |
| `cteMaterializations` | `shared-cooperative` | Once-per-execution shared CTE buffer map; shared so a CTE materialized in one branch replays in a sibling branch instead of re-driving the source. |

Adding a new field to `RuntimeContext` requires adding it to `EXPECTED_FORK_POLICY` in `fork-contract.spec.ts` with a declared policy — the test fails compile otherwise.

**2. Parent immutability during fork lifetime.** A `RuntimeContext` whose `tableContexts` or `context` has been forked must not be mutated by the parent until every fork has finished being driven. The fork snapshots are taken at `fork()` time, not read-through, so parent mutations made afterward would silently diverge between parent and forks.

**3. Mutation-site allowlist.** Direct `tableContexts.set/delete` and `context.set/delete` on a `RuntimeContext` are restricted to an audited set of files (`TABLE_CONTEXTS_MUTATION_ALLOWLIST` and `ROW_CONTEXT_MUTATION_ALLOWLIST` in the spec). Prefer `createRowSlot` / `withRowContext` / `withAsyncRowContext` over direct mutation. New direct-mutation sites must be added to the allowlist deliberately after weighing the fork-contract implications.

### Connection-lock contract under impure subtrees

`acquireConnectionLock` (in `vtab/concurrency.ts`) serializes sibling branches that share a `'serial'` (or `'reentrant-reads'`) module connection. It governs concurrent **reads** of the same connection — write operations are *not* a supported usage of the lock; the per-connection write protocol (transactions, savepoints, statement-bumps) is not reentrant under any of the currently-defined `concurrencyMode` values. A DML subtree on a branch driven concurrently with a sibling read would interleave the write with the sibling's cursor under the same connection, violating both the lock contract and the write protocol.

Because of this, the parallel-track recognition rules in the optimizer (`AsyncGather` union-all / zip-by-key, `EagerPrefetch` probe, `FanOutLookupJoin`, `FanOutBatchedOuter`) **refuse to fold** when any participating branch reports `hasSideEffects = true`. The serial plan stays in place; writes execute exactly once, in textual order, under the connection lock. See `docs/optimizer.md` § "Parallel-track side-effect refusal" for the optimizer-side discipline and the shared `PlanNodeCharacteristics.isConcurrencySafe` predicate. Once a module advertises `'fully-reentrant'`, this restriction can be relaxed for that module — at which point both the optimizer predicate and the lock policy refine in tandem.

### Strict-fork test mode

Set `QUEREUS_FORK_STRICT=1` (or run `yarn test:fork-strict` from `packages/quereus`, which the root `yarn check` gate also runs) to enable a Node-only proxy/subclass that wraps every `RuntimeContext.tableContexts` and `RuntimeContext.context` constructed at the five production sites (`Statement`, `Database._executeSingleStatement`, `DatabaseAssertions.executeResidualPerTuple`, `DeferredConstraintQueue.runDeferredRows`, `const-evaluator`) plus every fork's own maps. The wrapper throws a `strict-fork: parent context mutated ...` error if any `set` / `delete` / `clear` is invoked on a parent map while one of its forks is currently being driven by `ParallelDriver.drive()`.

State is tracked per parent map (not globally) so concurrent unrelated drivers don't interfere and forks may freely mutate their own (fresh) maps. When the env flag is unset every helper is a no-op pass-through — production paths see vanilla `new RowContextMap()` / `new Map()`.

### Strict context-shadow test mode

Set `QUEREUS_CONTEXT_STRICT=1` (or run `yarn test:context-strict` from `packages/quereus`, which the root `yarn check` gate also runs alongside `test:fork-strict`) to enable an off-by-default runtime assertion that catches the **operator-shadows-child** stale-shadow described in § Invariant: source-attr contexts and child pulls — a whole class of silent wrong-row bugs where a streaming operator leaves a row context built from its source's attribute IDs winning the `attributeIndex` while a child sets a newer row for the same IDs.

**What it asserts.** The strict `RowContextMap` subclass (in `runtime/strict-fork.ts`, shared with the fork-strict harness and constructed through the same `createStrictRowContextMap()` factory) maintains a monotonic clock, a per-descriptor `epoch` bumped on both `set()` and each `slot.set(row)` (via `noteRowSet`), and a per-attribute `winnerByAttr` map kept in lockstep with `attributeIndex`. `resolveAttribute` calls `assertNoShadow` under the flag: for the attribute being read, if a *different* live context carries the same attr with a strictly-newer epoch **and a differing value at the resolved column**, it throws a `QuereusError(INTERNAL)` whose message begins `context-strict:` and points back here. The value comparison is deliberate — a wider projection (e.g. a nested-loop join output `[...left, ...right]`) legitimately re-carries a source attribute in a newer row object that agrees on the shared column, which is not an observable wrong-row.

**What it deliberately does not assert.** The mirror **child-shadows-operator** direction (an operator that forgets `reactivate()` before yielding, letting a child cursor's genuinely-newer look-ahead `set` win) is out of scope: recency alone cannot distinguish that wrong-but-newest state from a correct newest write. Catching it needs per-operator declared intent (provenance threading), tracked in the backlog ticket `debt-context-shadow-reactivate-direction`.

**Cost & gating.** Zero-cost when off: a module-level `CONTEXT_STRICT` boolean (read once from the env in `runtime/strict-flags.ts`) guards the single leading `if (CONTEXT_STRICT) rctx.context.assertNoShadow?.(...)` in `resolveAttribute` and the per-row `noteRowSet?` bump in `createRowSlot`; the base `RowContextMap` carries no epoch side-tables and `createStrictRowContextMap()` returns a vanilla map when both strict flags are off. The per-read check is O(live contexts carrying the attr) — small in practice; if a pathological plan makes strict-mode CI slow, index the per-attr candidate list instead of scanning all live entries (noted as a tripwire at the call site). Diagnostics name the attribute + column, the stale index winner and the shadowing context (by their best-effort installer labels, threaded incrementally through `createRowSlot` / `withRowContext` / the direct-`set` aggregate/window emitters; absent labels degrade to the descriptor's attribute-ID list), and the reading operator from `planStack` top when tracing is on.

### EagerPrefetchNode (first ParallelDriver.fork consumer)

`EagerPrefetchNode` is the first physical relational node that consumes `ParallelDriver.fork()` directly. It is a pass-through whose only effect is timing: **on `run()`** (emit / scheduler arg-assembly, *not* first iteration), its emitter forks the runtime context once, immediately starts a detached "pump" that drains the child sub-tree into a bounded ring buffer, and serves the consumer from that buffer. Rows, order, attribute IDs, keys, FDs, equivalence classes, orderings, and monotonicity all pass through verbatim — only `deterministic` / `idempotent` / `readonly` / `concurrencySafe` propagate via the default child-merge.

Eager-on-`run()` is the point: inside a `BloomJoinNode`, the scheduler invokes the prefetch's `run()` during arg-assembly — before the join's generator body drains the build (`right`) side — so the probe's first fetch is already in flight while the build materializes. `prefetchAsyncIterable` returns a manual `AsyncIterable<Row>` (not an async generator) whose iterator owns teardown via `next()`/`return()`/`throw()`.

**Iterate-or-close contract.** Because the fork (and its strict-fork counter) is live from `run()`, any consumer of an EagerPrefetch MUST either iterate the stream to completion or call its iterator's `return()` — otherwise the pump leaks (fills the buffer, then blocks on back-pressure forever) and the fork counter stays bumped. `emitBloomJoin` honors this by acquiring the left iterator up front and closing it in a `finally` that wraps both the build and probe phases (covering the build-error-before-probe path).

Because the emitter uses `ParallelDriver.fork()` without going through `drive()`, it is responsible for the strict-fork bookkeeping that `drive()` normally handles internally. `parallel-driver.ts` re-exports `bumpParentForkCounter` / `dropParentForkCounter` for this purpose: any caller using `fork()` manually must `bump` once per parent map after forking and `drop` the returned state in cleanup once the fork's iteration is complete. Don't import these from `strict-fork.ts` directly — that module is internal.

**Strict-fork interaction (eager-start).** Holding the fork live from `run()` means it is active for the entire statement, so any slot-creating ancestor (a `Project` or `Sort` above the join) mutates the same parent `rctx` while the fork is counted — tripping the strict-fork contract (invariant 2). This is the same known interaction as Sort-above-`AsyncGather`, and is a **strict-harness false-positive only**: `bumpParentForkCounter` is a no-op in production, and the probe is a self-contained relation scan whose detached snapshot never observes the parent's later mutations. Strict-mode tests over executed eager-prefetched plans are skipped accordingly; the non-strict path validates correctness.

### AsyncGatherNode (N-ary parallel relational combinator)

`AsyncGatherNode` is a physical N-ary relational node that drives ≥ 2 independent (uncorrelated) child relations concurrently via `ParallelDriver.drive()` and combines their outputs with a per-node `AsyncGatherCombinator`. Three combinators ship:

- `unionAll` — yield every row from every branch in **arrival order** (multiset union, no dedup). All children must share a column count. Attribute IDs mirror `children[0]` so downstream `ORDER BY` references keep resolving (same convention as `SetOperationNode.buildAttributes`). Ordering, FDs, equivalence classes, constant bindings, and domain constraints are all dropped — arrival-order interleave is non-deterministic, so downstream consumers requiring a total order must wrap the gather in `Sort`. `isSet` is `false`; per-column nullability is the OR across children.

- `crossProduct` — drain every branch fully, then yield the full N-ary Cartesian product. Output attributes are the verbatim concatenation of children's attributes; FDs / ECs / constant bindings / domain constraints are the pairwise N-ary fold of children's properties (the same fold `JoinNode(cross)` does, applied repeatedly). Cartesian-product order is deterministic-but-unspecified — it depends on the per-branch arrival order. **Memory caveat: the runtime buffers every branch in memory before yielding the first row.** This matches the materialization profile a fully-materialized `JoinNode(cross)` would have, but it is a real cost on wide products — callers should not use `crossProduct` when any branch is large. No streaming variant exists in v1.

- `zipByKey({ branchKeyAttrs, outputKeyAttrs })` — full N-way **outer join** on the key columns named **per branch** by `branchKeyAttrs`. `branchKeyAttrs[b]` lists the attribute IDs of branch *b*'s K key columns in key-position order (distinct per branch — each branch originates its own key id); `outputKeyAttrs` lists the K attribute IDs the gather **mints** for the merged key columns (one per key position, pairwise distinct and disjoint from every child id). For each distinct key value present in any branch, emit exactly one composed row: the K merged key columns once (carrying the `outputKeyAttrs` ids, in key-position order), then each branch's non-key columns (NULL when that branch has no row for that key). Implemented as an **eager hash-merge** over a `BTree` keyed by the key tuple — *not* a chained binary full-outer-join lowering. Output key is `[[0..K-1]]`; `isSet` is `false`; key nullability is the OR across branches (a NULL-keyed standalone row can surface) and non-key columns are forced nullable. **Provenance:** the gather genuinely *originates* the K merged key columns ("branch0's key, or branch1's key, …, whichever row is present" — `outputKeyAttrs` appear in no child) and *forwards* each branch's non-key id (each appears in exactly one child), so `validatePhysicalTree` passes by construction — no id is output by two branches. Relational invariants (FDs/ECs/bindings/domains/ordering) are dropped, same conservatism as `unionAll` (conditional non-key FDs are future work). **Memory caveat: every branch is drained before the first row is yielded.** NULL keys never merge (SQL `NULL = NULL` is unknown) — each NULL-keyed row emits standalone. Within-branch duplicate keys are unspecified in v1 (branches assumed key-unique). Manual construction only — the recognition rule is the backlog ticket `parallel-async-gather-zip-by-key-rule`.

All three combinators inherit `ParallelDriver.drive()`'s cancellation, error propagation (one branch's throw is re-raised after a best-effort `return()`-close of in-flight siblings), strict-fork bookkeeping, and consumer-break cleanup. Concurrency is capped at the node's `concurrencyCap` field, which the recognition rule (see `5.5-parallel-async-gather-union-all-rule`) initialises from `tuning.parallel.concurrency`.

`expectedLatencyMs` and `concurrencySafe` are now defined on `PhysicalProperties`. The merge default the `PlanNode.physical` getter applies is `max` across children for `expectedLatencyMs` and `AND` across children for `concurrencySafe`. `TableReferenceNode` populates the leaf values: `concurrencySafe` from `getModuleConcurrencyMode(vtabModule) !== 'serial'`, and `expectedLatencyMs` from an optional `VirtualTableModule.expectedLatencyMs` hint (omit-implies-0 — local-only paths stay at 0 and the fan-out cost gate is inert by design until a remote plugin declares non-zero latency).

**Recognition rule (unionAll).** `rule-async-gather-union-all.ts` (`PassId.PostOptimization`, after physical selection and before `materialization-advisory`) folds a chain of `SetOperationNode(unionAll)` into one `AsyncGatherNode({ kind: 'unionAll' })`. The rule fires only when every flattened child clears `physical.concurrencySafe === true` AND the slowest child meets `tuning.parallel.gatherThresholdMs` (default 25 ms). Memory-vtab leaves declare `expectedLatencyMs = 0`, so the rule is inert by design in local-only configurations and the `test/plan/` golden sweep is unaffected. The flatten step absorbs unionAll-`AsyncGatherNode` children as well as nested `SetOperationNode(unionAll)` — necessary because bottom-up traversal fires the rule on inner sub-chains first, so the outer firing must collapse the inner gather into the new one rather than nesting them. See `docs/optimizer-parallel.md` § "Async gather UNION ALL" for the full rule contract, gates, and tuning knobs. `crossProduct` recognition is opt-in only and is not on the optimizer roadmap. The `zipByKey` combinator (full N-way outer join, eager hash-merge) is implemented as a manual-construction node; its recognition rule is deferred to the backlog ticket `parallel-async-gather-zip-by-key-rule`.

### FanOutLookupJoinNode (per-row fan-out lookup join)

`FanOutLookupJoinNode` is a physical relational node that replaces a chain of N nested-loop LEFT/INNER joins where each branch is a key-aligned (FK→PK) lookup against an independent table — or, for `cross` branches, an unconstrained 1:n inner nested-loop join. For one outer row, the emitter forks the runtime context N times, drives the N parameterized branch sub-plans concurrently via `ParallelDriver.drive()`, collects each branch's result rows, and assembles the wide result rows (outer ++ branch[0] ++ … ++ branch[N-1] — the n-ary Cartesian product across branches).

**Branch modes.** Each branch declares a `mode`:

- `atMostOne-left` — like LEFT JOIN: a zero-row branch yields NULL-padded columns for that slice; the outer row is kept.
- `atMostOne-inner` — like INNER JOIN: a zero-row branch drops the outer row entirely.
- `cross` — like an inner nested-loop join: the branch yields *n* rows per outer row (data-driven cardinality) and the node emits one wide row per `(outer, branch-row)` combination — the Cartesian product. A zero-row branch drops the outer row (inner-drop). All product rows of one outer row are emitted contiguously, in outer order, with the right-most branch varying fastest (matching the nested-loop chain it replaces).
- `cross-left` — like a LEFT nested-loop join with a data-driven 1:n match: same Cartesian product as `cross` when the branch matches, but a zero-row branch emits one NULL-padded factor row so the outer row is preserved (LEFT semantics). Its output columns are nullable-widened, like `atMostOne-left`.

The left-preserving modes (`atMostOne-left` / `cross-left`) and the 1:n cross modes (`cross` / `cross-left`) are distinguished by the `isLeftBranchMode` / `isCrossBranchMode` predicates exported from `fanout-lookup-join-node.ts`, shared by the node's attribute/type widening, the recognition rule, and the emit composer. The `atMostOne-*` modes share an `atMostOne` invariant the runtime enforces defensively (scoped to those modes only — `cross` / `cross-left` are exempt): any such branch that yields more than one row for a single outer row throws `QuereusError(StatusCode.CONSTRAINT, "FanOutLookupJoin: branch i produced more than one row …")`. The recognition rule guarantees FK→PK alignment so this is unreachable in practice; it remains a defense against manually-constructed plans. The `array` (per-row N rows preserved) mode is deferred to a follow-up backlog ticket.

**Lock policy.** Each branch declares a `concurrencySafe: boolean` (the node constructor / rule layer computes it from `getModuleConcurrencyMode` on the branch's table reference, plus a read-only-subtree check). When the flag is `true` the branch is invoked raw on its forked context; when `false`, the emitter wraps the branch in `acquireConnectionLock(target)` so sibling branches sharing the same lock target serialize. The lock target is the branch's `connectionKey` hint when present, otherwise `rctx.activeConnection`. Distinct connections never contend; sibling branches sharing a `'serial'` module connection serialize through the per-connection promise chain. When `concurrencySafe` is `false` but neither a `connectionKey` nor `rctx.activeConnection` is available (e.g. for CTE-materialization or const-evaluation paths that run without an established connection), the branch falls through raw — there is no identity to key the lock by, so serialization cannot be enforced and callers must ensure the situation is safe. v1 always reuses the outer's connection (`rctx.activeConnection`) when no explicit hint is set — opening a fresh connection per branch is deferred until a `'reentrant-reads'` plugin needs per-connection isolation.

**Outer-row binding propagation.** The emitter installs the outer row's `RowSlot` on the parent `rctx.context` *before* forking, so each fork's snapshot (per `ParallelDriver.fork()`'s parent-snapshot semantics) already carries the binding. The branch sub-plan can read the outer columns from `rctx.context` inside its own emit code without further wiring.

**Ordering / FDs.** Outer ordering passes through; v1 emits rows in outer order. Functional-dependency propagation is conservative: it folds the branches in left-to-right `propagateJoinFds` calls with **empty equi-pair lists** — the node does not currently carry per-branch FK→PK alignment, so it cannot derive the cross-branch FDs that the recognition rule (4.5) would otherwise see. Once a per-branch equi-pair surface is added to `FanOutBranchSpec`, the node's `computePhysical` can tighten without changing the emitter. `concurrencyCap` bounds the number of concurrently-active branches via `ParallelDriver.drive()`; the recognition rule (`rule-fanout-lookup-join.ts`) sources it from `min(tuning.parallel.concurrency, branches.length)`.

**Recognition + cost gate.** The `rule-fanout-lookup-join` Structural-pass rule (ahead of `join-elimination`) clusters a Project-rooted chain of N FK→PK-aligned LEFT/INNER joins into one `FanOutLookupJoinNode`. Eligibility mirrors `ruleJoinElimination`'s checks (AND-of-column-equalities ON-clause, FK→PK alignment via `lookupCoveringFK` + `checkFkPkAlignment`, NOT-NULL FK + row-preserving path for INNER branches). The cost gate fires only when `(N − concurrencyCap) × expectedLatencyMs > N × branchSetupCost`; the formula clamps to 0 savings when `cap ≥ N` — fan-out wins only when concurrency-bound. The gate is intentionally inert for local-only chains (`expectedLatencyMs = 0`) — see `docs/optimizer-joins.md` for the full rule contract.

**Outer execution modes (`outerMode`).** The node carries `outerMode: 'serial' | 'batched'` (default `'serial'`). The serial path above overlaps the N branches of *one* outer row, then blocks on the next row — so a small per-row `branchCount` can never saturate a larger budget, and latency hiding is bounded to a single row. The `'batched'` path (run by `runFanOutLookupJoinBatched` in `runtime/emit/fanout-lookup-join.ts`) pipelines lookups *across* outer rows. `'serial'` remains the default; `rule-fanout-batched-outer` (`PassId.PostOptimization` — see `docs/optimizer-joins.md` § "Fan-out batched outer") flips a node to `'batched'` only when the per-row branch count under-saturates the global budget, the slowest branch is high-latency, and the outer cardinality is large — gates that are all inert on memory-vtab plans, so the golden-plan sweep stays byte-for-byte unchanged. When it flips, the rule also wraps the outer in an `EagerPrefetchNode` so the outer sub-plan runs against an isolated forked context (the batched pump then drains a pure buffer, never mutating the shared `rctx.context` the per-row forks bump — this is what makes the cross-row outer pump safe under strict-fork and against torn non-outer reads). Both modes emit rows in identical outer order, so `computePhysical`'s ordering pass-through holds for both.

The batched driver:

- **Global in-flight budget.** A single `AsyncSemaphore` (`runtime/async-semaphore.ts`, FIFO, single-shot idempotent release) over `tuning.parallel.outerBatchConcurrency` (default 16) caps concurrent branch lookups across *all* in-flight outer rows — distinct from `concurrency` (the per-row serial cap, default 8). A small `branchCount` saturates the budget by admitting more outer rows rather than more branches per row.
- **Bounded outer read-ahead.** The outer pump admits at most `R = clamp(ceil(globalCap / max(1, branchCount)), 1, maxOuterReadAhead)` rows *ahead of the emit frontier* (the lowest not-yet-emitted row). `tuning.parallel.maxOuterReadAhead` (default 64) is the hard clamp so `branchCount = 1` cannot fork an unbounded number of contexts. Backpressure is measured from the consumer: a slow head-of-line row holds back at most `R` rows.
- **Per-outer-row context isolation (load-bearing correctness point).** Each admitted row forks its own `rowCtx` from `rctx` and installs its own `RowSlot` (its own boxed `ref`), then forks the branches from `rowCtx`. The branch forks snapshot *this row's* getter — a closure over a ref that is never mutated again — so concurrently in-flight rows never share an outer binding. (The serial single-slot-on-parent approach mutates one shared `ref` per row and is unsafe under cross-row concurrency.) This is nested forking (`rctx → rowCtx → branch forks`); strict-fork counters are bumped on admit and dropped on row completion, mirroring `prefetchAsyncIterable`.
- **Permit-before-lock ordering.** Each branch task acquires its global permit *before* the wrapped factory's first pull (where `acquireConnectionLock` is taken). A lock-holder therefore always also holds a permit, so a permit-holder blocked on a lock is always waiting on another permit-holder that will release — no deadlock. A shared `'serial'` connection still serializes across branches of *different* outer rows through the per-connection promise chain (more rows in flight just raises contention on that one connection).
- **Order-preserving reorder buffer.** Each completed row lands in a `seq`-keyed map as the (possibly empty) list of wide rows it produced; the generator emits all of `seq = emitFrontier`'s rows contiguously as soon as they land, then advances the frontier (an empty list is a dropped outer row — an `atMostOne-inner` miss or an empty `cross` branch). Window accounting advances per `seq`, independent of product fan-out. Out-of-order completion, in-order emit. Consumer `return()`, downstream `throw`, or any branch error aborts the pump, `return()`-closes all live branch iterators, drains all per-row jobs to their teardown (drop fork counters, close slots), and re-raises the first branch error.

The `composeOuterRows(outerRow, branchBuf, descriptors, padLengths) → Row[]` helper (NULL-pad + inner-drop + Cartesian-product composition) is shared by both drivers so they compose identically; an empty array signals a dropped outer row.

## Incremental Delta Runtime

Quereus runs a single reusable **change-driven delta kernel** at transaction
boundaries: it captures changed rows per base table (savepoint-aware), and at COMMIT
executes only the affected slice of each registered consumer's query via
binding-aware residual plans, falling back to a global re-evaluation past a cost
threshold. Live consumers are transaction-deferred **assertions** (pre-commit) and
**`Database.watch`** (post-commit); reactive signals, triggers, and the lens layer
plug into the same surface.

The kernel — its lifecycle (capture demand → record → read at COMMIT), the
`DeltaSubscription` contract, savepoint merge semantics, and the plug-in pattern for
new consumers — is documented definitively in
[Incremental Maintenance](incremental-maintenance.md). The optimizer-side analysis
that classifies a plan's references (`'row'` / `'group'` / `'global'`) and chooses
binding keys is in
[Assertions § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable).

> Materialized views do **not** use this kernel — they are maintained synchronously
> at the DML write boundary inside the writing transaction (row-time); see
> [Materialized Views](materialized-views.md).

## Type Coercion Best Practices

SQL requires different coercion strategies for different contexts. Quereus handles coercion at two levels:

1. **Plan-time coercion** — Cross-category comparisons (numeric vs textual) are resolved by the planner, which inserts explicit `CastNode`s so the runtime never needs implicit coercion for comparisons or BETWEEN.
2. **Runtime coercion** — Arithmetic and aggregate contexts still use centralized utilities from `src/util/coercion.ts`.

### Coercion Contexts

**Comparison Context** (plan-time):
- When one operand is numeric and the other textual, the planner wraps the textual operand in a CastNode targeting the numeric type
- Example: `42 = '42'` → planner rewrites to `42 = cast('42' as INTEGER)`, both sides are numeric at runtime
- No runtime coercion is needed; the generic comparison path only handles temporal checks

**Arithmetic Context** (`coerceToNumberForArithmetic`):
- Converts all values to numbers for arithmetic operations
- Non-numeric strings become 0 (SQL standard behavior)
- Example: `'abc' + 0` → 0, `'123' + 0` → 123
- Used in: +, -, *, /, % operators

**Aggregate Context** (`coerceForAggregate`):
- Function-specific coercion for aggregate arguments
- COUNT functions skip coercion, numeric aggregates (SUM/AVG) coerce strings
- Used in: aggregate function argument processing

### Implementation Guidelines

```typescript
import { coerceToNumberForArithmetic, coerceForAggregate } from '../../util/coercion.js';

// In arithmetic operations:
const n1 = coerceToNumberForArithmetic(v1);
const n2 = coerceToNumberForArithmetic(v2);
const result = n1 + n2;

// In aggregate functions:
const coercedArg = coerceForAggregate(rawValue, functionName);
accumulator = schema.stepFunction(accumulator, coercedArg);
```

**Critical Rule**: Never implement custom coercion logic in individual emitters. Always use centralized utilities (for arithmetic/aggregates) or rely on planner-inserted CastNodes (for comparisons) to ensure consistent behavior across the system.

## Uniqueness and sorting guidelines

### Never Use JSON.stringify for DISTINCT

**Wrong**:
```typescript
const seen = new Set<string>();
const key = JSON.stringify(value);
if (seen.has(key)) continue; // Skip duplicate
seen.add(key);
```

**Problems**: 
- Doesn't follow SQL comparison rules
- `1` and `"1"` have different JSON representations but may be equal in SQL
- Doesn't respect collation rules

**Correct** — pre-resolve comparators at emit time to avoid runtime overhead:
```typescript
import { BTree } from 'inheritree';
import { createCollationRowComparator, BINARY_COLLATION } from '../util/comparison.js';

// At emit time: pre-resolve collation-based row comparator. Names resolve against the
// EmissionContext's database (`ctx.resolveCollation`) — there is no global registry.
const collationRowComparator = createCollationRowComparator(
  attributes.map(attr => attr.type.collationName ? ctx.resolveCollation(attr.type.collationName) : BINARY_COLLATION)
);

// At runtime: use pre-resolved comparator in BTree
const distinctTree = new BTree<Row, Row>(
  (row: Row) => row,
  collationRowComparator
);

const existingPath = distinctTree.insert(row);
if (!existingPath.on) {
  continue; // Skip duplicate
}
```

For typed contexts (where runtime types are guaranteed, e.g. GROUP BY keys):
```typescript
import { createTypedComparator } from '../util/comparison.js';

// At emit time: pre-resolve typed comparator from expression type
const exprType = expr.getType();
const collationFunc = exprType.collationName ? ctx.resolveCollation(exprType.collationName) : undefined;
const comparator = createTypedComparator(exprType.logicalType, collationFunc);
```

## Debugging and Common Pitfalls

Hard-won lessons for runtime emitter authors. Most reduce to *use the canonical
context and scheduler helpers* — the sections above are the reference; this is the
checklist.

### Never call instructions directly

Route every sub-program through its scheduler callback, never a direct
`instruction.run(...)` — direct calls bypass dependency resolution and can race. See
[Scheduler Execution Model](#scheduler-execution-model) and
[Key Points for Emitter Authors](#key-points-for-emitter-authors).

### Avoid a per-row microtask hop on the synchronous fast path

A scalar sub-program (filter predicate, projected column, join condition,
order/partition key, constraint check) runs through a sub-scheduler that completes
*synchronously* and returns a concrete value whenever no instruction in it is itself
async — the overwhelmingly common case. But `await value` still schedules a microtask
even when `value` is not a thenable (`await x` ≡ `await Promise.resolve(x)`), so a
per-row/per-column `await callback(rctx)` pays that tick N times for nothing. Branch on
`instanceof Promise` instead:

```typescript
// Pure-extraction site — value consumed as-is:
const raw = callback(rctx);
const value = raw instanceof Promise ? await raw : raw;

// Transform site — value mapped before use: route through resolveMaybe,
// then await only on the rare async path (async-util.ts):
const decision = resolveMaybe(predicate(rctx), (r) => isTruthy(r));
if (decision instanceof Promise ? await decision : decision) { /* ... */ }
```

The `await` must stay *lexical* at the extraction point — a value-returning helper the
caller then `await`s just reintroduces the hop. `instanceof Promise` is the right test
(not a duck-typed `.then` check): the scheduler itself decides async transitions with
`instanceof Promise`, so instructions only ever return a native `Promise` or a concrete
value. Genuinely-async sub-programs (e.g. a correlated scalar subquery) still work — they
take the promise branch.

#### Short-circuiting operators reuse this pattern

`CASE` (`runtime/emit/case.ts`) and `AND`/`OR` (`runtime/emit/binary.ts`) both emit
their deferrable operands as on-demand callbacks (`emitCallFromPlan`) and invoke only
the branches SQL semantics require. Each `run` returns `MaybePromise<SqlValue>` and
stays fully synchronous whenever the invoked callbacks resolve synchronously — the
`instanceof Promise` branch above is taken only for a genuinely async branch (e.g. a
scalar-subquery operand). Two consequences worth pinning:

- **`CASE` always short-circuits — no cost gate.** SQL evaluates `WHEN` clauses
  left-to-right, stops at the first match, and evaluates *only* the selected result.
  So every `WHEN`/`THEN`/`ELSE` is deferred unconditionally (the simple-`CASE` base
  expr stays an eager param, evaluated once). This is a **behavior change**: a branch
  that would throw, divide by zero, or run a subquery no longer executes unless
  selected — `select case when 1=1 then 'ok' else throwing_udf() end` now returns
  `'ok'` where it previously raised. `AND`/`OR`, by contrast, defer only a
  subquery-bearing right operand (perf, not correctness — see `emitLogicalOp`).
- **The synchronous return matters beyond perf.** The materialized-view row-time
  projection gate (`compileSourceRowEvaluator` in
  `database-materialized-views-analysis.ts`) rejects a `Promise` result for a gated
  single-row scalar. A `CASE` in a covering-structure body qualifies for that gate, so
  its `run` must return a concrete value synchronously — declaring the `run` `async`
  (forcing every result into a `Promise`) would break maintenance of any view whose
  body contains a `CASE`.

### Common pitfalls checklist

- **Scope resolution.** Most column-reference errors are scope issues: a scope missing
  from its `MultiScope`, a wrong scope order (earlier scopes shadow later ones), or
  projection outputs and original qualified columns both needing to stay reachable after a
  `ProjectNode`. See [Column Reference Resolution](#column-reference-resolution).
- **Context lifecycle.** Manage row context only through the helpers in
  `src/runtime/context-helpers.ts` — `createRowSlot` for streaming, `withRowContext` /
  `withAsyncRowContext` for one-off evaluation (see
  [Row Context Management](#row-context-management)) — and always `close()` a slot in a
  `finally`; never call `rctx.context.set/delete` directly. Typical bugs: forgotten
  cleanup (stale context), a row descriptor whose attribute IDs do not match the row, or
  context set up too late / torn down too early.
- **Tracing.** Diagnose context and resolution problems with the
  `DEBUG=quereus:runtime:context*` environment variables — see
  [Context Debugging and Tracing](#context-debugging-and-tracing).
