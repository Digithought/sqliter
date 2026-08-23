# Quereus Runtime

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The Quereus runtime executes query plans through a three-phase process: **Planning** (AST → Plan Nodes), **Emission** (Plan Nodes → Instructions), and **Execution** (Instructions → Results).

This document is the **overview**: value types, the plan-node and emitter authoring path, row
context, mutation execution, and the strict test harnesses. The subsystems large enough to read
on their own live in the topic documents below.

## Topic documents

<!-- NOTE: a section that moved into a satellite left a one-line stub behind under its original
     heading, so its old anchor still resolves here. When linking real content that lives in a
     satellite, link the satellite — not the stub. -->

| Document | Covers | Written for |
| --- | --- | --- |
| [Runtime Caching](runtime-caching.md) | Per-execution caches on the `RuntimeContext`: inner-scan connection reuse, `CacheNode` row caches, shared-CTE materialization. | An engine developer touching a per-execution cache. |
| [Parallel Runtime](runtime-parallel.md) | The `ParallelDriver` primitive, the fork and connection-lock contracts, and the `EagerPrefetch` / `AsyncGather` / `FanOutLookupJoin` plan nodes. | An engine developer working on the `parallel-*` track. |
| [Runtime Work Counters](runtime-work-counters.md) | Machine-independent per-instruction and per-table execution counts: `Statement.getWorkCounters()`, `Statement.getPlanShape()`, key structure, and the engine-to-module boundary they measure. | An engine developer reading or extending the counter surface. |

## Value Types

### SqlValue
Core SQL data types:
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
The runtime relies on TypeScript's structural typing. Key classes and interfaces:
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
		// Forward the source's attributes (FilterNode, SortNode), or mint new ones with
		// `PlanNode.nextAttrId()` when the node originates columns (ProjectNode).
		return this.source.getAttributes();
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

Plan nodes follow standardized output conventions for query-plan display and debugging.

### Plan Node Data Structure

Each plan node exposes:

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

One line a reader scans, not parses. Start with the SQL keyword or principal action,
keep it ≤ 80 characters when practical, and show only what identifies this node —
never the node type, ID, or wrapping parentheses, and nothing already in the logical
or physical properties.

```typescript
"main.users"                        // TableReferenceNode
"where age > 40"                    // FilterNode
"select name, count(*) as total"    // ProjectNode
"order by name desc, age asc"       // SortNode
```

### getLogicalProperties() Guidelines

Always an object, never undefined. camelCased keys, primitive JSON values (strings,
numbers, arrays), carrying the logically important detail the description omits — and
not the physical properties (`estimatedRows`, ordering, …), which have their own slot.

```typescript
{ predicate: "age > 40" }                                        // FilterNode
{ groupBy: ["dept_id"], aggregates: [{ expression: "COUNT(*)", alias: "count" }] }
```

### Formatting Utilities

Use the shared helpers in `src/util/plan-formatter.ts`:

```typescript
import { 
  formatExpression,      // ScalarPlanNode → string
  formatExpressionList,  // ScalarPlanNode[] → "expr1, expr2, ..."  
  formatProjection,      // Expression + alias → "expr AS alias"
  formatSortKey,         // Expression + direction + nulls → "expr DESC NULLS LAST"
  formatScalarType       // ScalarType → "INTEGER" | "TEXT" | etc.
} from '../../util/plan-formatter.js';
```

## Creating an Emitter

### 1. Create the Emitter (`src/runtime/emit/`)

```typescript
// src/runtime/emit/my-operation.ts
import type { MyOperationNode } from '../../planner/nodes/my-operation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';

export function emitMyOperation(plan: MyOperationNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Row descriptors for the source and, if this node transforms attributes, the output
	const sourceRowDescriptor = buildRowDescriptor(plan.source.getAttributes());
	const outputRowDescriptor = buildRowDescriptor(plan.getAttributes());

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

#### Scalar emitters: build a `ScalarOpSpec`, don't build the `Instruction`

A **scalar** emitter whose body is synchronous and takes one already-evaluated value per
operand does not build its own `Instruction`. It splits in two: a `buildXxxSpec(plan)` —
plus `ctx` only when it resolves collations — returning a `ScalarOpSpec`
(`emit/scalar-op.ts`), the operand plan nodes plus the body and the note; and a one-line
`emitXxx` that calls `emitScalarOp(spec, ctx)`. Only the `emitXxx` name is registered; the
spec builder is the reusable half.

**One spec builder per registered node type.** Where an emitter dispatches internally, the
dispatch belongs on the spec side, not the `Instruction` side: `emitBinaryOp` is a two-liner
over `buildBinaryOpSpec`, which owns the operator switch, so a fusion consumer never restates
which operator routes to which body.

The point is that the body has two consumers: `emitScalarOp` wraps it as an `Instruction`
the scheduler dispatches, and the scalar-fusion compiler composes it directly into a closure
chain with no scheduler. Keeping the body in one place is what stops the two from drifting
as emit-time specializations accumulate (`+(numeric-fast)` vs `+(temporal-date-timespan)`,
`=(compare-typed)` vs `=(compare-fast)`, `LIKE(like-const)` vs `LIKE(like)`).

**Emit-time specializations, and what each note means.** A spec builder reads the operands'
*declared* types and picks the narrowest body that can be correct, once, instead of
re-deciding per row. The tag inside the note names which body was picked, so
`scheduler_program()` / `EXPLAIN` shows whether a specialization engaged:

| Note | Selected when | Per-row cost it removes |
| --- | --- | --- |
| `+(numeric-fast)` | both operands numeric, neither temporal | the temporal probe and arithmetic coercion |
| `+(numeric)` | anything else non-temporal (TEXT, mixed) | — (the general body) |
| `+(temporal-date-timespan)` | `temporalOpCaseForTypes` resolves both operand kinds **and** `types/temporal-ops.ts` has a case for `(operator, left kind, right kind)` — the same lookup the planner announced the result type from | deriving both operand kinds from the values (up to four shape probes each) before the same table lookup |
| `+(temporal-unsupported)` | both kinds resolve and the table has **no** case (`date + date`, `date * number`, anything with `%`) | as above; the body is a NULL check plus a constant throw. The throw stays at *runtime* deliberately — a guarded, filtered-out, or empty-table occurrence must keep succeeding |
| `+(temporal)` | at least one declared type settles nothing: TEXT, ANY, NULL, TIMESTAMP, or a plugin-registered temporal type | nothing — runtime value sniffing *is* the defined semantics there |
| `=(compare-typed)` | both operands the same logical type with semantic ordering (TIMESPAN, JSON) | the generic compare and its temporal probe |
| `=(compare-fast)` | both operands the same category (numeric or textual), neither temporal | the temporal probe |
| `LIKE(like-const)` | the pattern is a literal constant | compiling (or cache-looking-up) the matcher |

The temporal rows carry one trade worth knowing: `temporal-date-timespan` and its siblings
**trust the declared type**. A DATE-declared operand actually holding a non-parseable string
yields NULL there, where the sniffing body raised `Unsupported temporal operation`. Write-side
coercion enforces declared logical types on every path SQL can reach (a bad INSERT is
rejected; a failed CAST is NULL), so only a misbehaving virtual table can produce such a
value.

The comparison twin, `tryTemporalComparison`, is deliberately *not* specialized this way —
its per-row cost is one `startsWith` per operand, and `buildComparisonOpSpec` already routes
the hot case to `=(compare-typed)` before reaching it.

`spec.operands` is what becomes `Instruction.params` — **not** the plan node's children.
`buildLikeOpSpec`'s constant-pattern fast path bakes the pattern into its closure and declares
one operand while the plan node still has two. The body must declare exactly one parameter per
operand (plus the leading context); `emitScalarOp` asserts that at emit time, since a short
body would otherwise silently ignore the values it was handed.

Two shapes stay off the spec, and their builders return `undefined` (or there is no builder)
so a fusion consumer knows to decline:

- **A body that can return a `MaybePromise`.** `ScalarOpSpec.run` returns a plain `SqlValue`
  deliberately; widening it to `OutputValue` would break fusion's contract. AND/OR's
  short-circuit form (right operand is a `SubProgram`, not a value) and a literal holding an
  unresolved async constant-fold result are the two live cases.
- **A body that invokes lazy branch callbacks.** `emitCaseExpr` must not evaluate unmatched
  branches, so it keeps its own emitter; what it shares is `buildCaseMatcher`, the per-clause
  match test, so a fused CASE and an instruction CASE agree on which branch fires.

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

`withAsyncRowContext` is the default choice. Reach for the synchronous
`withRowContext` only when the callee is *provably* synchronous — an emitted
scalar evaluator is not, whatever the planner validated about it. In particular
a DDL-authored expression (column DEFAULT, `GENERATED ALWAYS AS`, `CHECK`) may
embed a scalar subquery and return a `Promise`; validated determinism says
nothing about synchrony (see [determinism.md](determinism.md)). As of this
writing no `src/` site uses `withRowContext`; it is kept for callers whose
callee is a plain value read.

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
back the shared attribute IDs while the parent's context is the most-recent
`set`. The parent's stale row then silently **shadows** the child's current-row
reads — the child evaluates against the parent's previous output.

The mirror case is equally real: an operator whose source-attr context is
shadowed *by* a still-running child cursor (a look-ahead peek) must re-win the
index *before yielding* so downstream resolves through the operator's intended
row, not the child cursor's position.

There are two tools, picked by which side must win at the moment of the next pull:

- **Tear-down-before-pull (`delete`)** — for the *operator-shadows-child*
  direction. The operator drops its source-attr context after yielding and before
  pulling the next child row, letting the deepest child reclaim the index, and
  re-establishes it when the next row arrives. `emit/aggregate.ts` (streaming
  GROUP BY) tears down the just-yielded group's representative-row context before
  pulling the next source row. `emit/window.ts` (streaming variant) `demote()`s
  its `myDesc` at the end of each iteration and `promote()`s again on the next —
  also the canonical *stacked same-attr operator* case: `set(row)` alone does not
  re-insert, so `promote()` does delete+set to win for its own callbacks and at
  the yield, while `demote()` releases the index across the pull.
- **`reactivate()` before yield** — for the *child-shadows-operator* direction.
  The operator re-`set`s its descriptor (re-winning the index) just before it
  yields. `emit/asof-scan.ts` (merge variant) calls `rightSlot.reactivate()`
  before yielding the matched / null-padded row, so downstream reads the matched
  row rather than the right scan's look-ahead cursor.

The **operator-shadows-child** direction (tear-down-before-pull) is checked at
runtime by the off-by-default `QUEREUS_CONTEXT_STRICT` harness — see § Strict
context-shadow test mode. The mirror **child-shadows-operator** direction is
deliberately *not* checked: recency cannot distinguish a forgotten `reactivate()`
from a correct newest write.

Every scalar row read goes through `resolveAttribute` — there is no recency-based
read left that this invariant cannot be stated for. (The last one was the window
phase's positional read of the WindowNode's output row, which resolved against
whatever live context was newest; window results are now addressed by attribute
id like every other column.)

##### Corollary: a published source row reaches only the adjacent consumer

Tear-down-before-pull bounds *how long* such a context lives, and therefore **who can
see it**: only an operator that consumes the yield directly. `emit/aggregate.ts`
publishes a representative source row of the current group — `groupSourceRowDescriptor`
/ `scanRowDescriptor` set to the group's `previousGroupSourceRow` /
`currentSourceRow` — immediately around each `yield`, and tears it down in the `finally`
right after. A `Project` sitting straight on the aggregate can still resolve base-table
attribute ids through it. Put *any* buffering operator in between and it cannot:
`emit/window.ts`'s buffered path does `for await (const row of source)
allRows.push(row)`, draining the aggregate to completion before it yields anything, by
which point every representative-row context is long gone.

**So plan-time binding must never depend on it.** A grouped query's select list that
binds a grouping key to a *base-table* attribute happens to read the right value off the
representative row when the projection is adjacent to the aggregate — the group key's
value on any row of the group is by definition the group key — but it is right by
accident, and it dies with `No row context found for column <name>` the moment a
WindowNode lands in between.

This is enforced, in two halves, both in `planner/building`:

- **One redirect choke point.** Every post-aggregate expression of a grouped query —
  the rebuilt select list, the window phase's specifications and function arguments,
  the HAVING predicate, and every post-aggregate sort key (including the sort
  `buildSelectStmt` places below the window phase) — is passed through `redirectPostAggregate`
  (`select-aggregates.ts`), which rewrites any spelling of a grouping key that fell
  through to a pre-grouping attribute onto the AggregateNode's own group output
  column. It is gated on `referencesAggregateInput`, so a reference that already
  resolved through the projection, window-output or aggregate-output scope is left
  exactly as it bound.
- **One boundary check over the finished plan.** At the end of `buildSelectStmt`,
  `assertGroupedPlanCoverage` walks an aggregate query's plan from the root down to (and
  stopping at) the AggregateNode and rejects any remaining reference to a
  pre-grouping attribute the aggregate's output does not carry, with the user-facing
  "must appear in the GROUP BY clause or be used in an aggregate function" message.
  The walk is subquery-aware: a subquery's own columns and correlated references to
  an enclosing query pass through; a correlated reference to *this* query's ungrouped
  column is rejected. A builder that forgets the redirect now fails at plan time
  instead of shipping the accident above. It runs for an aggregate query with **no**
  `group by` too — that query has one implicit group whose row carries only the
  aggregate results, so `having`, `limit`, `offset` and an `order by` forced above the
  aggregation are all subject to the same rule. (The `order by` that stays *below* the
  aggregation — the pre-aggregate input sort of `select group_concat(b) from t order by
  a` — is outside the walk by construction.)

The check is deliberately strict — there is no escape hatch. A query that genuinely
reads an ungrouped column above the aggregate (`select a from t group by a order by
b`) is rejected even though the adjacent-consumer accident used to let it run; it
sorted by an arbitrary representative row, which was a wrong-result bug. The revisit
condition and the weaker buffering-only alternative are recorded in the NOTE at the
`assertGroupedPlanCoverage` call in `select.ts`.

##### The one binding that does depend on a source-attr context

An aggregate `ORDER BY` naming an aggregate the SELECT list lacks (`select a from t
group by a order by max(b)`) sorts *above* the final `ProjectNode`, and `max(b)` is not
one of that projection's output columns. The sort key binds to the **AggregateNode's own
output** attribute and resolves through the projection's source-attr context, which
`emitProject` keeps live while it yields. Unlike the accident above this is a reviewed,
deliberate dependency, and it is sound only while every node between the final
`ProjectNode` and the `SortNode` is *streaming* — today that is at most the `DistinctNode`
of a `DISTINCT` query, which yields each surviving row straight through. It is **not** an
invitation to bind this way elsewhere: it stays legal because the grouping-key redirect and
`assertGroupedPlanCoverage` above still forbid binding a *pre-grouping* attribute here, and
because a buffering node in that gap would break it. The NOTE at the `applyOrderBy` call in
`select.ts` carries the remedy if one ever lands there.

### Filter conjunct early exit

`emitFilter` (`runtime/emit/filter.ts`) splits a conjunctive predicate into its
top-level `AND` conjuncts (`splitConjuncts` — source order, no cost reordering),
compiles each as its own callback, and drops the row at the first conjunct that is
not true. So `where cheap and expensive_udf()` pays for `expensive_udf()` only on
rows `cheap` kept.

No three-valued-logic reasoning is needed at that boundary: a filter keeps a row only
when the predicate is *true*, and under `AND` a `false` **or** `NULL` conjunct
rejects it either way — only evaluation counts change, never the row set. Splitting
is top-level only; a nested `AND` (under `NOT`, inside `CASE`, below `OR`) still goes
through `emitLogicalOp`. A multi-conjunct filter is marked
`[N conjuncts, early exit]` in the instruction note.

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
metrics). The sweep lives once, in the async loop: the synchronous loop hands off
the instant an instruction returns a promise, so it never parks one. Tracing eagerly
awaits each promise output before tracing it (ordering trace events by settlement),
so it can never abandon a promise and the sweep there is defensive; metrics parks its
timing-wrapped promises like the optimized path and defers awaiting to the
destination. NOTE: `logAggregateMetrics` runs on the normal-completion path only, so
if the final instruction returns a bare `Promise` (rare — a SELECT root is an async
iterable, counted synchronously) that instruction's `out` count may be missing from
the debug-only aggregate log. Not observable outside the `runtime:metrics` logger.

### Scalar fusion: the second execution tier

The instruction graph handles relational and asynchronous work; **pure synchronous
scalar subtrees run as fused closures** beside it. `emitCallFromPlan`
(`runtime/emitters.ts`) — the one front door every per-row scalar callback goes
through (filter conjuncts, aggregate/GROUP BY arguments, CASE branches, sort and join
keys, projections, LIMIT/OFFSET, INSERT values, CHECK predicates) — first offers the
plan to `tryFuseScalar` (`runtime/scalar-fusion.ts`). On success the whole subtree
becomes one closure `(rctx) => SqlValue`, invoked directly per row with no
sub-`Scheduler`, no per-instruction argument arrays, and no `instanceof Promise`
checks; the instruction is marked `fused(<expr>)`. On refusal (`undefined`) the plan
takes the existing sub-program path unchanged.

Fusable nodes: literals (unless holding an unresolved async constant-fold result),
column references, parameter references, `COLLATE` (fused through, no runtime
effect), `CAST`, unary operators, `BETWEEN`, binary operators (numeric, comparison,
concat, `LIKE`, and the *eager* logical form — the `AND`/`OR` short-circuit form with
a subquery right leg declines), `CASE` (all-or-nothing over base/WHEN/THEN/ELSE,
keeping lazy branch selection via the shared `buildCaseMatcher`), and scalar function
calls that are provably synchronous (next subsection). Every fused body is the node's
own `ScalarOpSpec` body — or, for `CASE` and function calls, the same `buildCaseMatcher`
/ `buildScalarFunctionRun` the instruction emitter uses — so semantics, error messages,
and evaluation counts are identical by construction.
Subqueries and window/aggregate/relational nodes decline as unknown node types. A
subtree deeper than `MAX_FUSION_DEPTH` (32) declines
whole — fused closures nest on the JS call stack where the scheduler's linearized
loop did not — but the fallback emission still reaches nested `emitCallFromPlan` sites
(CASE branches, an AND/OR short-circuit right leg), each of which retries fusion from
depth 0, so a deep tree fuses in pieces below those seams.

#### What makes a scalar function call fusable

A fused node's contract is a plain `SqlValue`, while a `ScalarFunc` is typed
`(...args) => MaybePromise<SqlValue>`. Admitting `MaybePromise` into the fused contract
would put a Promise check and a `.then` path on *every* node in the chain — the
sub-program overhead fusion exists to delete — so a call fuses only when it is provably
synchronous, decided at emit time in this order:

1. **A `customEmitter` never fuses.** It builds its own `Instruction`, possibly with
   sub-programs or async behavior, and the compiler cannot see inside it. That is
   `nullif`, `greatest`, `least`, `json_schema` and `mutation_ordinal` today.
2. **`ScalarFunctionSchema.isAsync === true` never fuses** — the author's explicit
   declaration that the implementation may return a Promise.
3. **A declared `async function` / `async` arrow never fuses**, auto-detected via
   `implementation instanceof AsyncFunction`, so an ordinary async UDF needs no flag.
4. **Otherwise it fuses, with a guard.** A non-`async` function that returns a Promise
   anyway (including a `.bind()` or wrapper around an async one) is invisible to step 3,
   so the fused body checks and throws a `QuereusError` naming the function and telling
   the author to declare `isAsync: true`. One `instanceof` per call, and it converts a
   silent wrong answer — a Promise flowing on as if it were a value — into a loud error.

The fused body is `buildScalarFunctionRun` (`emit/scalar-function.ts`), the same body
`emitScalarFunctionCallDefault` gives the scheduler, so the arity assert, the
`Function <name> failed: …` wrapping with source location, and the `REPR_STRICT` return
check are shared rather than restated. Variadic functions (`numArgs === -1`, e.g.
`coalesce`) need no special case: composition switches on the call site's operand count.
A call's arguments count toward `MAX_FUSION_DEPTH` like any other operand.

Fusion is off when `trace_plan_stack = true` (fused frames would silently vanish from
`ctx.planStack`) or when the `runtime_fuse_scalars` db option (default `true`) is set
false — the explicit kill switch for bisecting a suspected fusion bug. Both are baked
into a prepared statement's cached emission context at emit time; recompile to pick up
a toggle. **Debug introspection reports the unfused graph**: `scheduler_program()`,
`execution_trace()` (which joins its trace events against that same instruction
listing by index — both build it from one shared in-process helper), and
`Statement.getDebugProgram()` all emit with fusion disabled — the faithful description
of what the query computes — while a normal execution runs the fused form.

### Work counters: machine-independent execution counts

Machine-independent per-instruction and per-table execution counts —
`Statement.getWorkCounters()`, `Statement.getPlanShape()`, their keying rules and the
engine-to-module boundary they measure — are documented in
[Runtime Work Counters](runtime-work-counters.md).

### Key Points for Emitter Authors

Build a row descriptor mapping attribute IDs to column indices, close every context in
a `finally`, and know whether your node forwards its source's attributes or originates
new ones. Row-producing runs are `async function*`; failures throw `QuereusError` with
a `StatusCode`.

**Side effects must not live in a lazily-drained generator body.** A generator's body
does not run until something iterates it. `db.exec` does iterate a row-returning
statement's result to completion (`Database._executeSingleStatement` drains and discards
every row), so a full, uninterrupted `exec` does run the body. But a caller that only
partially consumes a result — `eval`/`iterateRows` stopped early with `break`, or an
aborted signal — still leaves a lazy emitter's effect half-done, and nothing else in the
engine guarantees full consumption. An emitter whose `run` both mutates engine state and
yields a report should therefore still be a plain `async` function that does the work
up front, then returns an already-materialized `AsyncIterable<Row>` — `ArrayRowIterable`
(`src/util/array-row-iterable.ts`) exists for that. `emitAnalyze` is the worked example.
An emitter with no side effects (a scan, a filter, `EXPLAIN SCHEMA`) is free to stay a
generator — laziness there is the point. Statements whose effect is purely void take a
third route: the builder wraps them in a `SinkNode`, whose emitter drains the child
(`buildPragmaStmt` does this for `pragma x = y`).

## Schema Resolution (Build-Time)

Quereus resolves all schema dependencies during the planning phase and tracks them for automatic plan invalidation:

### Early Resolution at Build Time

Schema objects are resolved during planning and stored on the plan node as readonly
constructor fields — `TableReferenceNode` holds its `TableSchema`, `VirtualTableModule`
and aux data; `ScalarFunctionCallNode` holds its `FunctionSchema`. The runtime never
re-resolves a name.

### Dependency Tracking and Auto-Invalidation

Each `resolve*Schema(ctx, …)` call records what it resolved on
`ctx.schemaDependencies`, keyed by type and object name (`'function'`, `'sum/1'`). A
schema change emits an event (`table_added`, …), and every prepared statement holding
a dependency on the affected object recompiles on its next execution.

## Attribute-Based Context System

Column references resolve through stable attribute IDs rather than node references, so
no emitter has to type-check a node to find a column.

### Core Types

```typescript
type RowDescriptor = number[];  // attributeId → columnIndex mapping
type RowGetter = () => Row;     // access to the current row

interface RuntimeContext {
  db: Database;
  stmt: Statement;
  params: SqlParameters;
  context: RowContextMap;  // Row contexts with O(1) attribute index
}
```

### Attribute System

Every relational plan node implements `getAttributes(): Attribute[]` — its output
schema, one entry per column:

```typescript
interface Attribute {
  id: number;           // Stable, unique identifier
  name: string;         // Column name
  type: ScalarType;     // Column type
  sourceRelation: string; // For debugging/tracing
}
```

Attribute IDs are **stable** across plan transformations — the optimizer preserves them
when it converts a logical node to a physical one, which is what keeps a reference
built at plan time valid at runtime.

## Context Debugging and Tracing

Two debug namespaces cover the failure modes new emitters hit — a "no row context
found" error and a reference resolving against the wrong row:

- **`quereus:runtime:context`** — context lifecycle. Watch for mismatched PUSH/POP, and
  for a context torn down before the reference that reads it evaluates.
- **`quereus:runtime:context:lookup`** — resolution attempts, showing which contexts are
  live and whether the wanted attribute ID appears in any of them.

```bash
# Enable all context tracing
set DEBUG=quereus:runtime:context* && yarn test
```

Log through `logContextPush()` / `logContextPop()` rather than ad-hoc logging, and give
every instruction a `note` — both traces are only readable when the operations name
themselves.

## Bags vs Sets (Relational Semantics)

A **set** guarantees unique rows — every row distinct by the relation's key
(`SELECT DISTINCT`, aggregation results, base tables). A **bag** (multiset) may repeat
a row (`SELECT * FROM table`, table function output).

### RelationType.isSet Property

Every relational plan node declares which it produces via `RelationType.isSet`: `true`
for unique rows, `false` where duplicates are possible.

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

`isSet` is what lets the optimizer drop a redundant duplicate elimination, pick a
set-aware join or set-operation strategy, and choose sorting/memory strategy per
input. Operations preserve or transform the property predictably, so it is
statically known for every node.

## Mutation Operations: Always-Present OLD/NEW Model

One uniform OLD/NEW attribute model covers all mutation operations (INSERT, UPDATE, DELETE), eliminating conditional context management and giving consistent symbol resolution.

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
- Layered scope registration, so an unqualified column reference defaults to the
  meaningful side (NEW for INSERT/UPDATE, OLD for DELETE — see Symbol Resolution below)

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

### Rejected alternatives

- **Conditional OLD/NEW descriptors** (installed only when the operation has that
  side, plus hidden `__updateRowData` properties). Attribute IDs then collided
  between the conditionally-present descriptors, making column resolution depend on
  which contexts happened to be installed. One flat descriptor per mutation is
  collision-free by construction, keeps OLD/NEW defined for every operation, and
  removes the conditional setup from every emitter.

## Mutation Context

A table declares reusable parameters in its definition (`WITH CONTEXT (...)`) and each
DML statement supplies values for them. Those values are readable from DEFAULT
expressions and from CHECK constraints, immediate and deferred alike — which is how a
schema states a rule that depends on a per-operation value (a timestamp, a user id)
without a non-deterministic expression in the DDL.

### Architecture

**Planning Phase:**
- Context variables are parsed from `WITH CONTEXT (...)` clauses
- Variables converted to attributes with unique attribute IDs
- Context scope created using `RegisteredScope`
- Both unqualified (`varName`) and qualified (`context.varName`) symbols registered;
  a qualified `context.varName` always resolves to context
- Context variables registered BEFORE OLD/NEW columns, so an unqualified reference
  resolves to context when the name matches (shadowing precedence)

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
  // Process rows — defaults and constraints can reference context variables
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

`composeCombinedDescriptor` keeps each context attribute at its own index and shifts
every OLD/NEW attribute right by the context length, so one descriptor addresses the
concatenation without renumbering either side.

### Deferred Constraints

**Queueing:**
```typescript
rctx.db._queueDeferredConstraintRow(
  baseTable,
  constraintName,
  flatRow,           // already in declared column logical types
  flatRowDescriptor,
  evaluator,
  connectionId,
  contextRow,        // Captured context values
  contextDescriptor  // Context row descriptor
);
```

The queued row is the same one the *immediate* CHECKs read: the DML emitters
convert the NEW section to the declared column logical types at the top of the
pipeline, driven by static types (see docs/types.md § Where coercion happens),
so the ConstraintCheck node holds declared-form values by the time either path
runs. Deferred CHECK subqueries compare against rows already stored (and
therefore converted) in other tables, so a logical type that rewrites its value
on parse (e.g. `datetime`) compares equal at COMMIT (GitHub #25). OLD values are
NULL on INSERT or read from already-converted stored rows on UPDATE.

**Evaluation at COMMIT:** the queued entry's captured context row and descriptor are
recomposed with its snapshotted row the same way, installed in a row slot, and the
stored evaluator runs against them — so a deferred CHECK sees the context values the
originating statement supplied, not whatever is current at COMMIT.

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

Context attributes carry unique, stable IDs and resolve through the same
`resolveAttribute()` path and standard row descriptors as OLD/NEW rows — no special
handling. They are preserved across savepoints as part of the queued row data.

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
Inside the statement savepoint, a failed rebuild rolls the whole statement back, and
a statement that aborts mid-loop never reaches the flush (so a dirtied-then-aborted
MV leaves its backing untouched). FAIL mode still runs the flush after the loop, but
having no statement savepoint, a flush failure there does not unwind the
already-applied rows — consistent with FAIL's keep-prior-rows semantics. See
`docs/incremental-maintenance.md` § end-of-statement flush.

The savepoint helpers used are always the broadcast variants
(`_createSavepointBroadcast` / `_releaseSavepointBroadcast` /
`_rollbackAndReleaseSavepointBroadcast`) so per-connection savepoint stacks stay
in lockstep with the `TransactionManager`'s stack. This covers the row-time MV
backing connection, which registers lazily on the first maintenance call:
`Database.registerConnection` replays the active savepoint depth (already including
the statement savepoint) onto it, so the backing write participates in the same
rollback/release.

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
  cost. This is the common path.
- **Not snapshot-isolated (default)** — `runUpdate`/`runDelete` fully **drain**
  the source match set into an array (`drainSourceRows`), closing the scan cursor,
  **before** applying any write. The read phase now precedes the write phase in
  full, matching SQLite's "figure out which rows to change, then change them".

The false default is correctness-first: any durable / third-party store is correct
out of the box (it buffers) and opts into streaming only once it can prove per-scan
snapshot isolation. Buffering costs O(match-set) memory for such a store (a
`DELETE big WHERE rare` matching millions materializes them all) — the accepted
price of correctness, since such a store cannot safely stream-delete anyway. The
drain feeds the same `runWithStatementSavepoints` loop, so savepoint / FAIL-mode /
RETURNING semantics are unchanged (RETURNING still streams per row after the
drain). An FK cascade issues its own child `DELETE`/`UPDATE` through a fresh
executor call, which makes its own drain-or-stream decision from the *child*
module's flag.

**Boundary — INSERT-source Halloween is out of scope here.** An
`INSERT … SELECT` reading the same table it inserts into is a *different* Halloween
shape (the insert node, `runInsert`), not addressed by this read/write split; it
relies on the memory savepoint snapshot plus the existing CTE/Halloween machinery.

### Per-row post-write pipeline and internal evictions

After each successful `vtab.update()`, the executor's `processRow` body runs one
**post-write pipeline** for the row: change-tracking (`_recordInsert` /
`_recordUpdate` / `_recordDelete`, consumed by `Database.watch` / change-scope and
the `DeltaExecutor`), row-time materialized-view backing maintenance
(`maintainRowTimeStructures`), foreign-key `ON DELETE` / `ON UPDATE` actions
(`executeForeignKeyActions`), and — for modules without native event support — a
data-change auto-event. This pipeline has exactly one home; substrates do not drive
any of it themselves.

**Raw flows down, stored flows back up.** Coercion to the declared logical type
happens *inside* `vtab.update()` (`coerceRowToSchema` in the memory manager and the
store table; the overlay's own coercion in the isolation layer), so the row the
executor hands **down** still carries the statement's un-converted input — a `json`
column's `'{"a":2}'` is TEXT there, an `integer`-affinity column's `'7'` still a
string — while a subsequent `select` reads back the coerced one. Every post-write
consumer must therefore see the **stored** row, reported as `UpdateResult.row`: the
executor recovers it via `storedRowOrRaw` and feeds it to change-tracking, row-time
MV maintenance, the FK cascade, the changed-column comparison, the auto-event, and
the row yielded downstream to `RETURNING` (`withStoredNewSection` swaps the NEW half
of the flat OLD/NEW row). Nothing is coerced *before* the write, so the row is
coerced exactly once and non-idempotent parses are never re-entered.

`UpdateResult.row` carries two signals, and all four arms read the first. Its
**presence** means a row really was written or removed; every arm short-circuits and
returns nothing downstream when it is absent, which is how a key-not-found
UPDATE/DELETE and a module-resolved IGNORE conflict are reported. Its **contents**
are the stored row, read only by INSERT/UPDATE: `storedRowOrRaw` falls back to the
raw row when the reported row's width is not the table's column count, covering a
minimal test/sample module that echoes its input (raw *is* stored for one that never
coerces). DELETE reads only the presence — its OLD image comes from the source scan
and is already a stored row, and the isolation layer returns a synthetic PK-only
placeholder there. See `bug-dml-downstream-uses-uncoerced-row`.

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
keys off remain, so `select 1 from child where fk = ?` still answers correctly — and throws
on a violation. `runWithStatementSavepoints` then rolls back the statement-scope savepoint
(`__stmt_atomic_N`, opened before the row loop), unwinding both the substrate's eviction and
the writing row. (Evictions only occur under REPLACE resolution, which is never `OR FAIL`,
so the non-FAIL statement-savepoint branch always applies.) The surfaced error is the
`FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from '<child>'`
form — not the plan-time `CHECK constraint failed: _fk_...` form — since the plan-time
parent-side FK check is absent for internal evictions. Enforced on the key-based memory,
direct-store, and isolation-wrapped substrates. Rowid-chained backends (lamina) are out of
scope: the transitive recursion reads children at call time and, post-eviction, the parent
value is gone, so a deeper cascade may not resolve — mirroring the documented SET-DEFAULT
recursion gap.

**Internal statement cache.** The per-row FK/DDL enforcement statements — the RESTRICT
existence probe (`assertNoRestrictedChildrenForParentMutation` and its lens dual), the
transitive cascade pre-walk child scan, the cascade DML (`executeSingleFKAction`'s and
`issueLensFkAction`'s `DELETE`/`UPDATE`), and the drop-referencing check
(`SchemaManager.assertNoReferencingChildrenForDrop`) — run through a per-`Database` LRU pool
of compiled statements keyed by exact SQL text (`InternalStatementCache`) rather than a fresh
`prepare`/`finalize` per affected row (the engine has no plan cache, so each fresh prepare
pays a full parse + plan + emit). Each fixed shape compiles once and rebinds; a bulk cascade
over N parents runs a couple of compiles, not 2N. Correctness rides existing `Statement`
behavior: the compiled statement subscribes to schema-change notifications and lazily
recompiles across intervening DDL, and a cascade re-entering with the same SQL text while
that statement is mid-iteration falls back to a fresh one-shot statement (the busy-guard)
rather than sharing a live cursor. Internal probes are prepared type-agnostically, so a
loose-affinity FK column binding an integer key on one row and a text key on another under
one SQL shape is neither rejected nor served a first-use-frozen plan. Deliberately internal —
not a public statement-cache feature. The batched RESTRICT flush is a handful of compiles per
statement, not per row, so it stays on the plain `prepare` path.

### Batched RESTRICT

Parent-side RESTRICT enforcement normally costs **two** probes per mutated parent row per
inbound FK: the plan-time synthesized `NOT EXISTS(select 1 from child where fk = OLD.pk)`
constraint (compiled once, evaluated per row by `ConstraintCheckNode`) and the runtime
transitive pre-walk (`assertTransitiveRestrictsForParentMutation` inside
`processDeleteRow` / `processUpdateRow`). On a high-latency store each probe is a storage
round-trip, so a bulk parent DELETE costs O(rows × FKs) round-trips even when nothing
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

The gate takes the `Database`, not a bare `SchemaManager`, because it answers two questions
that must not be split across callers: it reports "not batchable" whenever `pragma
foreign_keys` is off (nothing is enforced on either route, so the executor builds no batch),
and it **raises** on an inbound FK whose child column count does not match the parent key it
references (see [Constraints § 7.6 FOREIGN KEY](sql-constraints.md#76-foreign-key-constraint)) — the
batch is that FK's only enforcement on this route, so skipping it would leave the key
unenforced here alone. The executor calls the gate on every DELETE/UPDATE and has no other
pragma check in front of it.

During the row loop the executor accumulates each affected row's OLD referenced-key tuple
into per-execution, per-FK state (`createParentRestrictBatch` /
`accumulateParentRestrictKeys`, `runtime/foreign-key-actions.ts`) — deduplicated on an
injective serialization, skipping tuples containing NULL (MATCH SIMPLE) and UPDATE rows
that change no referenced column. "Change" means the value the column will actually
**store** differs, not that the UPDATE text differs: `anyReferencedColumnChanged` re-coerces
a non-identical NEW value through the column's logical type (the same `validateAndParse`
conversion `coerceRowToSchema` applies moments later) before comparing again, so rewriting a
key as an equivalent-but-differently-spelled value (`1` as the text `'1'`, a JSON object with
reordered keys) is not a change. The comparison is deliberately BINARY, not the column's
collation — a `nocase` column still stores `'A'` and `'a'` distinctly. The same helper backs
the per-row pre-walk and the lens pre-check, so all four enforcement sites agree; see its doc
comment for the failure-direction reasoning. The state is per execution (never on the emit
closure), so a re-run prepared statement starts empty. `flushParentRestrictBatch` fires in
`runWithStatementSavepoints` after the row loop, **before** the deferred-maintenance flush
(fail fast — skip wasted MV work) and before the statement savepoint releases, probing
each FK's child table in ~500-key chunks (`fkcol in (?, …)`, or OR-of-conjunctions for a
composite FK — plain SQL `=`/`IN` against the child column, so collation semantics match
the per-row `NOT EXISTS` by construction). A hit throws the same
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

## Determinism Validation

Determinism enforcement in DEFAULT / CHECK / `GENERATED ALWAYS AS` clauses — the
`nondeterministic_schema` opt-out, the physical `deterministic` property, mutation context
for non-deterministic values, and the per-statement validation timing — is documented in
[Determinism Validation](determinism.md).

## Common Patterns

The three `run` shapes — streaming (`createRowSlot`), scalar (plain value in, value
out), and void DDL/DML (`withAsyncRowContext` per row) — are shown under
[Creating an Emitter](#creating-an-emitter) and
[Row Context Management](#row-context-management). What follows are the patterns those
templates do not cover.

### Impure subquery emitters: full-drain + run-once

Scalar, `IN`, and `EXISTS` subquery emitters detect a side-effecting inner via
`PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery)` and switch to
an impure-path implementation that applies two contracts:

- **Full drain.** The emitter iterates every row of the inner. The pure path's
  short-circuits (scalar's "first row only" / `IN`'s "first match" / `EXISTS`'s
  "first row") would skip writes past row 1, so they are dropped for impure
  inners — acceptable because it only affects DML-bearing inners, where
  correctness trumps the optimization.
- **Run-once per statement execution.** A correlated outer expression or a
  per-row scan would re-invoke the scalar subquery's `run` once per outer row. The
  emitter memoizes the materialized result and the scalar/`EXISTS`/`IN` answer on
  first call and replays it afterwards without re-driving the iterator. The memo
  lives on the per-execution `RuntimeContext` (`ctx.executionMemo`, keyed by a
  symbol minted at emit time), not the emit-time closure — so a `Statement` reusing
  its instruction tree across executions still resets the memo between runs,
  re-driving the inner DML once per run.

`emitLimitOffset` applies the full-drain half of this rule (never the run-once
half — a `LIMIT` is not re-evaluated per outer row) with the same
`subtreeHasSideEffects` gate, on `plan.source`. Reaching the limit stops it
*yielding* but not *consuming*, so a DML FROM-subquery under a `LIMIT` writes
every row. Over a pure source it instead stops precisely, testing the limit
after the `yield` so the source is never asked for the row past the last one
emitted — a zero limit returns before touching the source at all, which is what
keeps it from falling through into the drain branch.

Both contracts are gated by `physical.readonly === false` on the inner — pure
subqueries take a non-impure path. `IN` splits again: an uncorrelated +
functional source is materialized once per execution into a probed lookup set
([Runtime caching § IN-subquery set probe](runtime-caching.md#in-subquery-set-probe)
— filter-position shapes mostly decorrelate to semi joins and skip
`emitIn`), while correlated / non-deterministic sources keep the
per-outer-row streaming short-circuit. Scalar / `EXISTS` pure inners keep their
short-circuit fast path (`src/runtime/emit/subquery.ts`).

DML in expression position is rejected as a view body at view-creation time
(`src/planner/building/create-view.ts`). A view body re-evaluates on every
reference; a DML body would re-drive writes per read, which the run-once fence
cannot rescue (views compose, the cache lives at one emission site, and a
downstream consumer would observe stale state). The check is permanent, not pending.

### Per-execution caches

Inner-scan connection reuse, `CacheNode` row-cache lifetime, and shared
(multi-reference) CTE materialization are documented in
[Runtime Caching](runtime-caching.md).

## Query Optimizer Integration

Between the builder and runtime phases the optimizer rewrites **logical** nodes
into **physical** ones over a single node hierarchy, attaching
[physical properties](determinism.md#physical-properties-system) — override `computePhysical()`
to set them, otherwise they are inherited from children or defaulted. Every node
reaching the emitter phase has `physical` set, and virtual-table capabilities are
respected via `BestAccessPlan`. Column references carry stable attribute IDs that
`withChildren()` preserves, so runtime column lookup (by attribute ID, never by
name or position) survives arbitrary plan transformations. See the
[Optimizer Documentation](optimizer.md).

## ParallelDriver (Runtime Primitive)

Moved to [ParallelDriver](runtime-parallel.md#paralleldriver-runtime-primitive), along with
the fork contract, the connection-lock contract, and the three plan nodes built on the driver.

## Strict runtime test modes

Three off-by-default harnesses, all gated by module-level booleans read once from the
environment in `runtime/strict-flags.ts`, and all zero-cost when their flag is unset.

### Strict-fork test mode

Set `QUEREUS_FORK_STRICT=1` (or run `yarn test:fork-strict` from `packages/quereus`, which the root `yarn check` gate also runs) to enable a Node-only proxy/subclass that wraps every `RuntimeContext.tableContexts` and `RuntimeContext.context` constructed at the five production sites (`Statement`, `Database._executeSingleStatement`, `DatabaseAssertions.executeResidualPerTuple`, `DeferredConstraintQueue.runDeferredRows`, `const-evaluator`) plus every fork's own maps. The wrapper throws a `strict-fork: parent context mutated ...` error if any `set` / `delete` / `clear` is invoked on a parent map while one of its forks is currently being driven by `ParallelDriver.drive()`.

State is tracked per parent map (not globally) so concurrent unrelated drivers don't interfere and forks may freely mutate their own (fresh) maps. When the env flag is unset every helper is a no-op pass-through — production paths see vanilla `new RowContextMap()` / `new Map()`. What it enforces is invariant 2 of the [parallel runtime fork contract](runtime-parallel.md#parallel-runtime-fork-contract).

### Strict context-shadow test mode

Set `QUEREUS_CONTEXT_STRICT=1` (or run `yarn test:context-strict` from `packages/quereus`, which the root `yarn check` gate also runs alongside `test:fork-strict`) to enable an off-by-default runtime assertion that catches the **operator-shadows-child** stale-shadow described in § Invariant: source-attr contexts and child pulls.

**What it asserts.** The strict `RowContextMap` subclass (in `runtime/strict-fork.ts`, shared with the fork-strict harness through the same `createStrictRowContextMap()` factory) maintains a monotonic clock, a per-descriptor `epoch` bumped on both `set()` and each `slot.set(row)` (via `noteRowSet`), and a per-attribute `winnerByAttr` map kept in lockstep with `attributeIndex`. Under the flag `resolveAttribute` calls `assertNoShadow`: if a *different* live context carries the attribute being read with a strictly-newer epoch **and a differing value at the resolved column**, it throws a `QuereusError(INTERNAL)` whose message begins `context-strict:` and points back here. The value comparison is deliberate — a wider projection (e.g. a nested-loop join output `[...left, ...right]`) legitimately re-carries a source attribute in a newer row object that agrees on the shared column, which is not an observable wrong-row.

**What it deliberately does not assert.** The mirror **child-shadows-operator** direction is out of scope, for the reason given under § Invariant: source-attr contexts and child pulls; catching it needs per-operator declared intent (provenance threading), tracked in the backlog ticket `debt-context-shadow-reactivate-direction`.

**Cost & gating.** Zero-cost when off: a module-level `CONTEXT_STRICT` boolean (read once from the env in `runtime/strict-flags.ts`) guards the single leading `if (CONTEXT_STRICT) rctx.context.assertNoShadow?.(...)` in `resolveAttribute` and the per-row `noteRowSet?` bump in `createRowSlot`; the base `RowContextMap` carries no epoch side-tables and `createStrictRowContextMap()` returns a vanilla map when both strict flags are off. The per-read check is O(live contexts carrying the attr) — small in practice; if a pathological plan makes strict-mode CI slow, index the per-attr candidate list instead of scanning all live entries (a tripwire noted at the call site). Diagnostics name the attribute + column, the stale index winner and the shadowing context (by best-effort installer labels threaded through `createRowSlot` / `withRowContext` / the direct-`set` aggregate/window emitters; absent labels degrade to the descriptor's attribute-ID list), and the reading operator from `planStack` top when tracing is on.

### Strict physical-representation test mode

Set `QUEREUS_REPR_STRICT=1` (or run `yarn test:repr-strict` from `packages/quereus`) to enable the third off-by-default harness in `runtime/strict-flags.ts`. It verifies that every value is in the JavaScript form its declared type promises, at four seams: virtual-table scan output, DML write, scalar-UDF return, and statement row egress. The checker is `runtime/strict-representation.ts`; the rules it enforces, the per-seam table, the known coverage gaps, and why there is no module capability flag are all in [types.md § Enforcement: `QUEREUS_REPR_STRICT`](types.md#enforcement-quereus_repr_strict).

**Cost & gating.** Zero-cost when off, on the same pattern as the two harnesses above: a module-level `REPR_STRICT` boolean guards every call site, and each seam's supporting state (declared column type/name arrays, the resolved UDF return type) is built inside that guard so a normal emit allocates nothing for it. The scan seam's check is synchronous and sits inside the existing `for await` loop, so enabling the flag adds no microtask hop to the scan's fast path.

This harness runs in the root `yarn check` chain via `test:repr-strict`, alongside `test:fork-strict` and `test:context-strict`.

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

SQL requires different coercion strategies for different contexts. Quereus coerces at two levels: **plan-time**, where the planner inserts explicit `CastNode`s for cross-category comparisons so the runtime never coerces implicitly for comparisons or BETWEEN; and **runtime**, where arithmetic and aggregate contexts use the centralized utilities in `src/util/coercion.ts`.

### Coercion Contexts

**Comparison Context** (plan-time):
- When one operand is numeric and the other textual, the planner wraps the textual operand in a CastNode targeting the numeric type
- Example: `42 = '42'` → planner rewrites to `42 = cast('42' as INTEGER)`, both sides are numeric at runtime
- `IN` value lists, simple `CASE` and the comparison-group builtins share that rule through `coerceComparisonSet`; an `IN` **subquery** has no operand list to wrap and converts per row instead (`inMembershipKeys`, `runtime/emit/subquery.ts`)
- The generic runtime comparison path only handles temporal checks

**Arithmetic Context** (`coerceToNumberForArithmetic`):
- Converts all values to numbers for arithmetic operations
- Non-numeric strings become 0 (SQL standard behavior)
- Example: `'abc' + 0` → 0, `'123' + 0` → 123
- Used in: +, -, *, /, % operators

**Aggregate Context** (`coerceForAggregate`):
- Function-specific coercion for aggregate arguments
- COUNT/GROUP_CONCAT/`JSON_*` skip coercion, numeric aggregates (SUM/AVG) coerce strings
- The aggregate emitters do not call it per row: the routing decision is constant for a
  call site, so `computeAggregateValueTransforms` (`runtime/emit/aggregate-setup.ts`)
  resolves it once at emit time into a per-aggregate value transform — `undefined` when
  the site never coerces (the aggregate ignores coercion, or every argument is already
  numeric or carries semantic ordering). The transform applies the identical value-level
  conversion; `coerceForAggregate` remains the definition and the public export

### Implementation Guidelines

**Critical Rule**: never write coercion logic in an emitter. Coerce each operand with
`coerceToNumberForArithmetic` before an arithmetic op, coerce an aggregate argument
through the emit-time transform described above (whose body is `coerceForAggregate`'s,
not a re-derivation), and for comparisons rely on the planner-inserted `CastNode` — one
behavior, one home (`src/util/coercion.ts`).

## Uniqueness and sorting guidelines

### Never Use JSON.stringify for DISTINCT

**Wrong**:
```typescript
const seen = new Set<string>();
const key = JSON.stringify(value);
if (seen.has(key)) continue; // Skip duplicate
seen.add(key);
```

A JSON string is not a SQL comparison: it respects no collation, and `1` and `"1"`
serialize differently though SQL may compare them equal.

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

`CASE` (`emit/case.ts`), `AND`/`OR` (`emit/binary.ts`), and `Filter` conjuncts
(`emit/filter.ts`) all emit their deferrable operands as on-demand callbacks
(`emitCallFromPlan`) and invoke only what SQL semantics require. Each `run` returns
`MaybePromise<SqlValue>` and stays synchronous whenever the callbacks do — the
`instanceof Promise` branch above is taken only for a genuinely async operand (e.g. a
scalar subquery). Two consequences worth pinning:

- **`CASE` always short-circuits — no cost gate.** SQL evaluates `WHEN` clauses
  left-to-right and evaluates *only* the selected result, so every
  `WHEN`/`THEN`/`ELSE` defers unconditionally (the simple-`CASE` base expr stays an
  eager param). A branch that would throw or run a subquery therefore never executes
  unless selected: `select case when 1=1 then 'ok' else throwing_udf() end` returns
  `'ok'`. `AND`/`OR` in scalar position, by contrast, defer only a subquery-bearing
  right operand (perf, not correctness — see `emitLogicalOp`).
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
  Invariant: **a FROM source's scope holds only its own columns.** `registerColumnScope`
  and the `subquerySource` branch of `buildFrom` parent their `RegisteredScope` on
  `EmptyScope.instance`, so a source answers "no" for any name it does not own. The
  fallback to the enclosing query is composed *once* by the consumer — `buildSelectStmt`'s
  `ShadowScope([...sourceScopes, outerScope])`, `buildJoin`'s ON-condition
  `ShadowScope([MultiScope([leftScope, rightScope]), outerScope])`, and `buildJoin`'s
  LATERAL `ShadowScope([leftOutputScope, outerScope])` — never by chaining each source
  scope to its parent. Every consumer owes that fallback: without it an ON condition
  cannot name a correlated outer column or a bind parameter at all. Chaining, on the
  other hand, breaks `MultiScope`: its first-match walk asks peer #1, which
  forwards the miss to the outer scope and answers from there, so peer #2 is never
  consulted and a join's own right-hand source loses to a same-named enclosing symbol
  (silently wrong rows when an inner alias shadows an outer one; a runtime "No row
  context found for column …" when the enclosing symbol is bound to attribute ids nothing
  below publishes). The same rule applies to what `buildFrom`/`buildJoin` publish into
  `ctx.outputScopes`: that entry is the node's *own* columns only, because its consumer
  may be another join that has to consult its sibling peer first.
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
