# Quereus Query Optimizer

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The optimizer turns the logical plan the builder produced into a physical plan the
emitter can compile, by running rewrite rules over the plan tree in a fixed sequence of
passes. This document is the **hub**: it covers the pass framework, the shared machinery
every rule stands on (physical properties, attribute identity, visited tracking), and the
discipline a new rule must follow. The rules themselves, and the
subsystems that grew large enough to read on their own, live in the topic documents below.

## Topic documents

| Document | Covers |
| --- | --- |
| [Optimizer Rules](optimizer-rules.md) | The rule catalog — one line per rule, grouped by `src/planner/rules/` subdirectory. |
| [Optimizer Cost and Statistics](optimizer-costing.md) | The cost model, the self-cost-only convention, conjunct cost tiers, and the statistics/selectivity abstraction. |
| [Optimizer Rule Families](optimizer-rule-families.md) | Deep-dives: materialized-view read-side rewrite, constant folding, the predicate family, cardinality/key reasoning. |
| [Optimizer Joins](optimizer-joins.md) | Join ordering (QuickPick), physical join selection, fan-out lookup joins, join key propagation. |
| [Optimizer Retrieve Push-down](optimizer-retrieve.md) | The `RetrieveNode` module boundary, access-path selection, correlated access, TVF property declarations. |
| [Optimizer Streaming Recognition](optimizer-streaming.md) | Asof scan, and the monotonic LIMIT/OFFSET, range-scan, and window recognitions. |
| [Optimizer Parallel Track](optimizer-parallel.md) | Recognition rules for concurrent execution: async gather, eager prefetch. |
| [Optimizer Assertion Analysis](optimizer-assertions.md) | Row/group/global classification and binding-aware delta planning. |
| [Functional Dependencies](optimizer-fd.md) | FDs, equivalence classes, constant bindings, inclusion dependencies, coverage proving. |
| [Constant Folding System](optimizer-const.md) | The three-phase constant-folding algorithm in full. |
| [Optimizer Visited Tracking](optimizer-visited-tracking.md) | Context-scoped visited tracking: the per-pass traversal cache, DAG handling, rule-application control. |
| [Optimizer Conventions](optimizer-conventions.md) | House style for writing a rule. |
| [Progressive Query Optimization](progressive-optimizer.md) | The tiered, feedback-driven optimization strategy. |

## Philosophy

The Quereus optimizer embodies several core principles that guide its design and implementation:

### Virtual Table Centric
The optimizer is built around the premise that all data access happens through virtual tables. This means optimization decisions must respect the capabilities and constraints exposed by each virtual table module through the `BestAccessPlan` API.

### Streaming First
Quereus prioritizes streaming execution over materialization. The optimizer favors transformations that preserve pipeline-able operations and only introduces blocking operations (sorts, materializations) when absolutely necessary for correctness or significant performance gains.

### Attribute-Based Identity
Column identity is tracked through stable attribute IDs rather than names or positions. This enables robust column reference resolution across arbitrary plan transformations without the fragility of name-based or position-based systems.

### Single Hierarchy, Dual Phase
Rather than maintaining separate logical and physical plan hierarchies, Quereus uses a single `PlanNode` tree that transitions from logical to physical through property annotation. This eliminates duplication while maintaining clear phase separation.

### Cost-Based with Heuristic Fallbacks
While the optimizer uses cost estimates to guide decisions, it provides sensible heuristic defaults when statistics are unavailable. This ensures reasonable plan quality even without detailed table statistics.

### Property based rules
Rather than tying rules to specific node types, as much as possible, the optimizer and its rules are tied to properties of the nodes, such as the physical properties, or the node's data type.  This reduces direct dependencies, making the system more robust and flexible.

## Architecture Overview

The Quereus optimizer operates as a transformation engine between the plan builder and runtime emitter:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   Parser    │ --> │   Builder    │ --> │  Optimizer  │ --> │   Emitter    │
│             │     │              │     │             │     │              │
│ SQL → AST   │     │ AST → Logic  │     │Logic → Phys │     │ Phys → Code  │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
```

The optimizer uses a **multi-pass architecture** where different categories of transformations occur in separate tree traversals. Each pass can use either top-down or bottom-up traversal order depending on its requirements:

```mermaid
graph LR
    subgraph "Plan Node"
        LogicalNode[Logical Node<br/>no physical property]
        PhysicalNode[Physical Node<br/>with physical property]
    end
    
    subgraph "Optimization Rules"
        Rule1[Access Path Rule]
        Rule2[Aggregate Rule]
        Rule3[Cache Rule]
        Rule4[Constant Fold Rule]
    end
    
    LogicalNode --> Rule1
    Rule1 -->|"transforms"| PhysicalNode
    LogicalNode --> Rule2
    Rule2 -->|"transforms"| PhysicalNode
    LogicalNode --> Rule3
    Rule3 -->|"injects cache"| PhysicalNode
    LogicalNode --> Rule4
    Rule4 -->|"folds constants"| PhysicalNode
    
    style LogicalNode fill:#fdd,stroke:#333,stroke-width:2px
    style PhysicalNode fill:#dfd,stroke:#333,stroke-width:2px
```

### Multi-Pass Optimization System

The optimizer executes transformations through a series of **optimization passes**, each with a specific purpose and traversal order:

#### Pass 0: Constant Folding (Bottom-up)
- **Purpose**: Pre-evaluate constant expressions before other optimizations
- **Traversal**: Bottom-up to evaluate from leaves to root
- **Implementation**: Custom execution using runtime expression evaluator
- **Result**: Simplified plan with literals replacing constant expressions

#### Pass 1: Structural Transformations (Top-down)
- **Purpose**: Restructure the plan tree for optimal execution boundaries
- **Key Rules**: `ruleGrowRetrieve`, `rulePredicatePushdown`, `ruleScalarCSE`
- **Traversal**: Top-down to see parent context for sliding operations
- **Result**: Operations pushed into virtual table boundaries where beneficial; duplicate scalar expressions eliminated

#### Pass 2: Physical Selection (Bottom-up)
- **Purpose**: Convert logical operators to physical implementations
- **Key Rules**: `ruleSelectAccessPath`, `ruleAggregatePhysical`
- **Traversal**: Bottom-up to select implementations based on child properties
- **Result**: Executable physical plan with concrete operators

#### Pass 3: Post-Optimization (Bottom-up)
- **Purpose**: Final cleanup, materialization decisions, and caching
- **Key Rules**: `ruleCteOptimization`, `ruleMutatingSubqueryCache`, `ruleNestedLoopRightCache`, `ruleScalarSubqueryCache`
- **Nested-loop right-side caching**: `rule-nested-loop-right-cache` fires on Join nodes right after `mutating-subquery-cache`. By this pass every equi-join `join-physical-selection` wanted has already become a hash/merge join, so any surviving logical `JoinNode` is a nested loop — plain, or an index-nested-loop whose right leaf is a correlated per-outer-row `IndexSeek` — whose left-driven types (`inner`/`left`/`cross`/`semi`/`anti`) re-open the right pipeline once per left row. The rule wraps a **pure, deterministic, uncorrelated, non-CTE, size-bounded** right side in a `CacheNode` so the right side is materialized once and replayed — decisive on a high-per-read-latency vtab. (The uncorrelated gate is what keeps an index-nested-loop's seek out of the cache: freezing a per-outer-row seek would replay the first row's matches for every row.) Where `mutating-subquery-cache` handles impure right sides, this rule handles pure ones; the two partition the space and the already-cached gate prevents double-wrapping.
- **Where an `IN (SELECT …)` predicate ends up**: a filter-position `IN` that decorrelation turns into a semi join flows through this pass in stages, and different shapes stop at different stages. A correlated / non-deterministic / side-effect-bearing / projection-position `IN` never leaves the runtime **set probe** (`emitIn` materializes the inner once per execution and probes per row). A decorrelated semi join whose both sides are monotonic on the join key becomes a **merge semi join** (`monotonic-merge-join`); otherwise `join-physical-selection` picks a **hash semi join**. Finally `rule-key-set-seek` (see `optimizer-rules.md`) replaces a qualifying semi join — hash (id `key-set-seek`) **or merge** (id `key-set-seek-merge`) — with a **`KeySetSemiJoinNode`**: the key set is materialized once at runtime and, when small enough by the module's own costs, handed to the target's module as an ordinary single-column `plan=5` multi-seek so only the matching index windows are read. The merge anchor is what catches the most common shape, `where pk in (select …)` on the target's primary key: both sides advertise a key walk, so it becomes a merge semi join before the hash anchor could ever see it. It fires only when the seek index is the walk index (`seekPreservesTargetOrder`) — then the node claims the target's own `ordering` / `monotonicOn`, so an ORDER BY the walk absorbed stays served through the rewrite — and only when the key source's row estimate does not already exceed the runtime seek threshold. The node's probe is unconditional, so the seek can only over-fetch (trimmed by the probe), never change the answer; shapes that fail its gates (no usable index, a pushed limit/offset, target/key types that do not share one seek key space, semantic-ordering keys, unsafe collation cover, a load-bearing leaf emission order the seek cannot reproduce) simply keep the join they arrived as. A target leaf that is itself an `IndexSeek` — another indexed column of the same table also filtered, e.g. `where status = 'x' and id in (select …)` — is admitted too: the seek is kept as the target unchanged and the predicate its `FilterInfo` enforces (recorded in `pushedConstraints`) is re-applied as a `Filter` directly above the new node, so the runtime's seek branch cannot lose it while its scan branch remains byte-for-byte the displaced plan. The key-space gate admits any pair drawn from `INTEGER` / `REAL` / `NUMERIC` — a numeric key's identity is its value, not its JS representation — so `where i in (select r from …)` seeks rather than falling back. **A semi join sitting over an inner/cross join is reassociated below it first.** `rule-key-set-seek` only peels a probe side down through `Alias` / trivial `Project` / `Filter` wrappers, so the compound query — the filtered table is ALSO joined to another table, `… from entry e join txn t on t.id = e.txn_id where e.txn_id in (select …)` — used to arrive with a join on the probe side and decline, reading `entry` end-to-end. In the Structural pass `rule-semi-join-pushdown` moves the semi join onto whichever inner-join branch its condition reads (declining when the condition spans both, when the join underneath is outer, or when either branch is correlated or write-bearing), which leaves the probe side a bare access leaf again — and the key-set seek then fires unchanged. That is the sound route to the plan; teaching the peel itself to walk a `JoinNode` would not be.
- **Traversal**: Bottom-up for global analysis and cache injection
- **Result**: Optimized plan with caching and materialization points

#### Pass 3.5: Materialization Advisory (single whole-tree pass, order 35)

> **Invariant:** [OPT-004](invariants.md#opt-004--a-custom-execute-pass-argues-its-own-soundness)

- **Purpose**: Inject caching where reference analysis shows materialization pays off
- **Implementation**: A custom-`execute` pass (no per-node rules) that runs `MaterializationAdvisory.analyzeAndTransform` **once** over the whole plan — one reference-graph build with global parent counts, versus the previous 12 per-anchor-type rule firings that each rebuilt a graph over their own subtree. Runs after Post-Optimization so it observes the `CacheNode`s already injected by `cte-optimization` (it skips `nodeType === Cache`, avoiding double-wrapping). See `createMaterializationPass` in `framework/pass.ts` for the coverage and side-effect-soundness rationale.
- **Result**: `CacheNode`s wrapping relational subtrees that benefit from materialization (multi-parent sharing). Nested-loop-inner (single-parent, loop-context) caching is handled by the dedicated `rule-nested-loop-right-cache` above, not here — the advisory's former `appearsInLoop` / `loopMultiplier` scaffolding never fired (the logical reference graph makes no execution-strategy assumptions) and has been removed. A `CacheNode` is a physical pass-through: it preserves its source's relational physical properties (FDs, keys, ordering, monotonicOn, equivalence classes, INDs, update-lineage) so wrapping a subtree never degrades downstream key-based optimizations.
- **CTE materialize mark**: the same pass (reusing its single reference graph) resolves the shared-materialization decision for non-recursive CTEs. A `CTENode` with two-plus referencing parents, or an explicit `MATERIALIZED` hint, is rewritten with `materialize: true` — unless the user wrote `NOT MATERIALIZED`, which is honored as an opt-out (the CTE then re-executes per reference). The rewrite is **memoized by node identity** so a CTENode shared by several `CTEReferenceNode` parents is rewritten once and stays shared. The runtime keys its once-per-execution buffer on the CTE's `tableDescriptor`, not on the plan id, so the buffer is still shared if a later pass does split the node (see `docs/runtime.md`). CTEs (recursive and not) are excluded from the advisory's `CacheNode` recommendations: a wrap could never land (`CTEReferenceNode.withChildren` rejects a non-CTE child), and the mark supersedes the intent.
- **Data-modifying CTE — always buffered, decided at build time**: a CTE whose body is an `INSERT` / `UPDATE` / `DELETE` (with `RETURNING`) is constructed with `materialize: true` in `planner/building/with.ts` and never consults this gate (`markCTEMaterialization` short-circuits on the already-set flag). Its write must happen exactly once per statement execution however many times the query names it, and the gate above cannot carry that decision for two reasons: the reference count **undercounts** — two mentions using the same alias share one `CTEReferenceNode`, so the `CTENode` shows a single parent while both mentions still emit and run the body — and a `NOT MATERIALIZED` hint would license re-execution, i.e. a second write. The hint is therefore overridden for writing bodies, the same call the recursive branch makes below. Read-only bodies are untouched by this rule and keep flowing through the normal gate.
- **Recursive CTE materialize mark**: a recursive CTE referenced 2+ times is also marked `materialize` (on its `RecursiveCTENode`), so `emitRecursiveCTE` buffers the recursion once per execution and every reference replays it — without this, two interleaved streaming drives clobber each other on the shared working table and trip the iteration guard. This branch differs from the non-recursive one in three ways: (1) it gates on the **reference count summed per `tableDescriptor`**, because earlier passes duplicate a multi-referenced recursive CTE into distinct `RecursiveCTENode` instances (each with `parentCount` 1) that all share one descriptor; (2) it **ignores** the `MATERIALIZED` / `NOT MATERIALIZED` hint (honoring `NOT MATERIALIZED` would re-open the runaway — correctness wins); and (3) the same pass **forbids caching any node inside a recursive-case subtree** — those nodes re-evaluate every semi-naïve iteration against the changing working table, so a `CacheNode` there would freeze the delta to the first iteration's rows. The runtime keys the buffer on the shared `tableDescriptor` (see `docs/runtime.md`).

#### Pass 3.7: Final Estimates (Bottom-up, order 37)
- **Purpose**: Re-derive plan estimates that a later-than-Physical pass invalidated
- **Key Rules**: `filter-selectivity-final`
- **Why it exists**: a plan estimate is derived by a rule holding an `OptContext` (node accessors carry none) and cached on the node, so any later pass that *re-mints* that node drops the estimate with nothing behind it to restore the number — `FilterNode.withChildren` carries `selectivity` forward only when the predicate child is the same object, and the Materialization advisory above rebuilds every path on which it marks a `with` clause or injects a `CacheNode`. Rules registered here run behind every plan-mutating pass, so an estimate's survival no longer depends on which pass happened to touch its node last. Rules here must be fill-in-only (decline on a node that already carries the estimate), since they run after every cost reader has already consulted the earlier stamp.
- **Nothing plan-mutating may run behind it**: anything later-ordered that rewrites a node re-opens the hole, whether it arrives as a rule or as a whole pass. `test/optimizer/rule-manifest.spec.ts` asserts both statically — no `RULE_MANIFEST` entry targets a pass ordered after this one, and no pass ordered after it carries a custom `execute` (the shape Pass 3.5 has, which no manifest check could see). Today only `Pass 4: Validation` sits behind it, with neither.
- **Result**: every Filter the estimator can describe reaches emission with a real row estimate rather than the flat 0.5

#### Pass 4: Validation (Bottom-up)
- **Purpose**: Validate the correctness of the optimized plan
- **Implementation**: Structural and property validation checks
- **Result**: Verified executable plan or error if invalid

### Pass Framework (`src/planner/framework/pass.ts`)

The pass system provides a clean abstraction for multi-pass optimization:

```typescript
interface OptimizationPass {
  id: string;                          // Unique identifier
  name: string;                        // Human-readable name
  traversalOrder: TraversalOrder;      // 'top-down' or 'bottom-up'
  rules: RuleHandle[];                 // Rules belonging to this pass
  execute?: (plan, context) => plan;   // Optional custom execution
  order: number;                       // Execution order (lower first)
}
```

**Key Benefits**:
- **Separation of Concerns**: Each pass focuses on a specific optimization category
- **Proper Sequencing**: Structural transformations happen before physical selection
- **Flexible Traversal**: Each pass can choose its optimal traversal order
- **Clean Debugging**: Clear pass boundaries make optimization easier to understand
- **Depth safety**: Each pass enforces a per-pass depth budget of `max(tuning.maxOptimizationDepth, planInputDepth + tuning.optimizationDepthHeadroom)` so wide input shapes (deep AND chains, deep CASE) plan without tripping the guard, while a separate `tuning.maxRulesFired` budget catches runaway rule rewrites independent of input shape.

### Core Components

**Pass Manager** (`src/planner/framework/pass.ts`)
- Coordinates execution of all optimization passes
- Manages rule registration per pass
- Implements both top-down and bottom-up traversal strategies
- Provides hooks for custom pass execution logic

**Rule Engine** (`src/planner/optimizer.ts`)
- Registers rules to appropriate passes based on their purpose
- Creates optimization context for rule execution
- Integrates with pass manager for multi-pass optimization
- Provides debugging and tracing infrastructure

**Physical Properties** (`src/planner/framework/physical-utils.ts`)
- Captures execution characteristics: ordering, uniqueness, cardinality, monotonic-on-attribute
- `monotonicOn` (per `MonotonicOnInfo` in `nodes/plan-node.ts`) is stronger than `ordering`: it identifies an attribute the relation is totally ordered on (with optional `strict` to assert no duplicates), and is meaningful only for total-order-preserving sources (vtab access plans that advertise it; sort nodes; merge join). Propagation rules live alongside each operator's `computePhysical`.
- `rangeBoundedOn` is a non-relational annotation set by `monotonic-range-access` on physical leaves whose access plan walks a `MonotonicOn(x)` path bounded by a recognized range predicate on `x`. See [Streaming § Monotonic range-scan recognition](optimizer-streaming.md#monotonic-range-scan-recognition).
- Propagates properties through plan transformations
- Enables property-based optimization decisions

**Rule Framework** (`src/planner/framework/`)
- Standard rule signature: `(node, context) → node | null`
- Context provides access to database, statistics, and tuning parameters
- Rules are pure functions that return transformed nodes or null

**Generic Tree Rewriting** (`PlanNode.withChildren()`)
- Every plan node implements generic tree reconstruction
- Preserves attribute IDs during transformations
- Eliminates manual node-specific handling in optimizer core

## Design Decisions

### Immutable Plan Nodes

> **Invariant:** [OPT-008](invariants.md#opt-008--plan-nodes-are-immutable)

Plan nodes are never mutated after construction. All transformations create new nodes, ensuring:
- Clear debugging with before/after comparisons
- Safe concurrent access during optimization
- Predictable transformation behavior

### Attribute ID Preservation

> **Invariant:** [OPT-012](invariants.md#opt-012--withchildren-preserves-attribute-ids)

The optimizer guarantees that attribute IDs remain stable across transformations:
```typescript
// ProjectNode preserves original attribute IDs
const newProjections = this.projections.map((proj, i) => ({
  node: newProjectionNodes[i] as ScalarPlanNode,
  alias: proj.alias,
  attributeId: proj.attributeId // ✅ Preserved from original
}));
```

### Two-Phase Transformation
1. **Logical Phase**: Builder creates plan nodes without physical properties
2. **Physical Phase**: Optimizer transforms and annotates with physical properties

This separation allows the builder to focus on semantic correctness while the optimizer handles execution strategy.

### Rule-Based Transformation
Optimization logic is organized into focused, composable rules:
- Each rule has a single responsibility
- Rules can be enabled/disabled independently  
- New optimizations can be added without modifying core code
- Rules are registered per node type for efficient dispatch

## Engineering Considerations

### Generic Tree Walking
The optimizer uses a generic tree walking mechanism via `withChildren()`:

```typescript
private optimizeChildren(node: PlanNode): PlanNode {
  const originalChildren = node.getChildren();
  const optimizedChildren = originalChildren.map(child => this.optimizeNode(child));
  
  const childrenChanged = optimizedChildren.some((child, i) => child !== originalChildren[i]);
  if (!childrenChanged) {
    return node;
  }
  
  return node.withChildren(optimizedChildren); // Attribute IDs preserved
}
```

This eliminates error-prone manual reconstruction and ensures consistent handling across all node types.

### Physical Properties System

Physical properties are automatically computed and cached for each plan node using a bottom-up inheritance model:

**Default Properties**
```typescript
const DEFAULT_PHYSICAL: PhysicalProperties = {
  deterministic: true,    // Pure - same inputs produce same outputs
  readonly: true,         // No side effects
  idempotent: true,       // Safe to call multiple times
  constant: false,        // Not a constant value
};
```

**Inheritance Model**
```typescript
// Physical properties are lazily computed and cached
get physical(): PhysicalProperties {
  if (!this._physical) {
    const childrenPhysical = this.getChildren().map(child => child.physical);

    // Get node-specific overrides
    const propsOverride = this.computePhysical?.(childrenPhysical);

    // Derive defaults from children if any, else use DEFAULT_PHYSICAL
    const defaults = childrenPhysical.length
      ? {
        deterministic: childrenPhysical.every(child => child.deterministic),
        idempotent: childrenPhysical.every(child => child.idempotent),
        readonly: childrenPhysical.every(child => child.readonly),
        // constant is not inherited; only leaf nodes explicitly set it
      }
      : DEFAULT_PHYSICAL;

    this._physical = { ...defaults, ...propsOverride };
  }
  return this._physical;
}
```

**Key Principles:**
- Leaf nodes get `DEFAULT_PHYSICAL` properties
- Parent nodes inherit the most restrictive properties from children
- Nodes can override specific properties via `computePhysical()`; `constant` is only set explicitly by nodes that can provide `getValue()`
- Properties are computed once and cached

**Property Computation Example**
```typescript
// SortNode only overrides specific properties
computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
  return {
    ordering: extractOrderingFromSortKeys(this.sortKeys),
    // Read the CHILD's already-computed physical properties, never `.physical`
    // on the child node itself — the bottom-up walk hands them in.
    estimatedRows: physicalSourceRows(childrenPhysical[0], this.source),
    // deterministic and readonly are inherited from source
  };
}
```

### Scalar Expression Properties (per-attribute)

Distinct from `physical` (relational, cached on the node), `ScalarPlanNode` exposes three **per-attribute** property methods on `PlanNode`:

```typescript
isInjectiveIn(inputAttrId: number): InjectivityResult;
monotonicityIn(inputAttrId: number): MonotonicityResult;  // Monotonicity = 'increasing' | 'decreasing' | 'constant' | 'non_monotone' | 'unknown'
rangeRewriteIn(inputAttrId: number, constant: SqlValue): RangeRewrite | undefined;
```

The base class returns conservative defaults (`{ injective: false }` / `{ monotonicity: 'unknown' }` / `undefined`); concrete scalar nodes override only what they can prove. Composite nodes (`UnaryOpNode`, `BinaryOpNode`, `ScalarFunctionCallNode`) recurse into children — they don't switch on `nodeType`. Helper lattices `addMonotonicity` and `negateMonotonicity` (in `nodes/plan-node.ts`) compose the operator rules.

`ScalarFunctionCallNode` consults per-function traits on `FunctionSchema`:
- `injectiveOnArgs?: readonly number[]` — arg indices on which the function is injective when other args are constants.
- `monotoneOnArgs?: { [argIndex]: 'increasing' | 'decreasing' }` — direction-of-monotonicity per arg.
- `rangeRewriteOnArg?: { [argIndex]: { kind: string } }` — names a bucketing kind; the actual boundary computation lives on the operand's `LogicalType.bucketBounds(kind, value)`.

The function-call traits compose with the operand's own `monotonicityIn` / `isInjectiveIn`, so `f(g(x))` is treated correctly when both layers are annotated. `rangeRewriteIn` is intentionally tighter: it only rewrites the `f(x) op c` case, requiring the operand to be a bare `ColumnReferenceNode` for the queried attribute (anything else would conflate value spaces).

Consumers (key propagation through non-trivial projections, sargable predicate rewrites for `date(ts) = D`, etc.) build on this surface — see [Rule Families § Sargable range rewrites](optimizer-rule-families.md#sargable-range-rewrites).

### Constant folding

Constant expressions are evaluated at plan time rather than at runtime, via a three-phase
classify / border-detect / replace algorithm that folds even expressions whose column
references resolve to constants further up the tree. See
[Constant Folding System](optimizer-const.md) for the algorithm and
[Rule Families § Constant Folding Subsystem](optimizer-rule-families.md#constant-folding-subsystem) for the
`constant` property's requirements and the `ConstantNode` contract.

### Sargable range rewrites

A predicate of the form `f(col) = c` — notably `date(ts) = D` — is rewritten to the
half-open range `col >= lower(c) and col < upper(c)`, restoring a bare `col op literal`
shape the constraint extractor can push into an index seek. See
[Rule Families § Sargable range rewrites](optimizer-rule-families.md#sargable-range-rewrites).

### TVF property declarations

Table-valued functions can advertise keys, ordering, monotonicity, and row estimates
through `relationalAdvertisement`, so the optimizer reasons about a TVF exactly as it does
about a virtual table. See
[Retrieve § TVF Property Declarations](optimizer-retrieve.md#tvf-property-declarations).

## Component Reference

### Plan Node Hierarchy

> **Invariant:** [OPT-009](invariants.md#opt-009--every-held-expression-is-a-child)

All plan nodes extend the base `PlanNode` class and implement category-specific interfaces:

**Base Classes**
- `PlanNode`: Abstract base with cost, scope, and transformation methods
- `RelationalNode`: Nodes producing row streams (implement `getAttributes()`)
- `ScalarNode`: Nodes producing scalar values
- `VoidNode`: Nodes with side effects (DDL, DML)

**Key Methods**
- `getChildren()`: Returns all child nodes — including every held scalar expression — in a consistent order
- `withChildren(newChildren)`: Creates new instance with updated children
- `computePhysical()`: Optionally overrides specific physical properties
- `getLogicalProperties()`: Returns logical plan information

### Rule catalog

Rules live in `src/planner/rules/`, one directory per optimization family
(`access`, `aggregate`, `cache`, `distinct`, `join`, `predicate`, `retrieve`, `sort`,
`subquery`, `parallel`), and are registered to passes in `src/planner/optimizer.ts`.
That file is the single source of truth for which rule runs in which pass, in what
order (the `RULE_MANIFEST` array order, which IS the execution order), under which
`sideEffectMode`. The prose catalog — what each rule matches, its
guards, and its soundness argument — is
[Optimizer Rules § Optimization Rules](optimizer-rules.md#optimization-rules).

### Virtual Table Integration

The optimizer integrates with virtual tables through the `BestAccessPlan` API:

```typescript
interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: OrderingSpec;
  limit?: number | null;
  estimatedRows?: number;
}

interface BestAccessPlanResult {
  handledFilters: boolean[];
  cost: number;
  rows: number | undefined;
  providesOrdering?: OrderingSpec;
  uniqueRows?: boolean;

  // Optional monotonic-storage advertisements. Lifted onto the physical leaf's
  // `physical.monotonicOn` / `physical.accessCapabilities`; not propagated by
  // single-input pass-through nodes (Filter, LimitOffset, Alias).
  monotonicOn?: { columnIndex: number; direction: 'asc' | 'desc'; strict: boolean };
  supportsOrdinalSeek?: boolean; // implies monotonicOn
  supportsAsofRight?: boolean;   // implies monotonicOn
}
```

Virtual tables communicate their capabilities, allowing the optimizer to:
- Push predicates to the data source
- Utilize indexes for efficient access
- Preserve beneficial orderings
- Estimate result cardinalities

#### The `handledFilters` contract

> **Invariant:** [OPT-024](invariants.md#opt-024--an-unconsumed-seek-constraint-is-reattached)

`handledFilters[i] = true` is a promise that filter `i` is enforced somewhere other than
the residual `Filter` — and the only channel available is `FilterInfo.constraints`, the
seek bounds `rule-select-access-path` builds. `rule-grow-retrieve` residualizes exactly
the constraints whose flag is `false`, so a claimed filter that never becomes a seek
bound would be applied nowhere.

A module may set `handledFilters[i] = true` only for a filter it will actually apply.
For the seek-family operators (`=`, `IN`, `<`, `<=`, `>`, `>=`, `OR_RANGE`) the planner
consumes at most one filter per column per role — the first `=`, the first lower bound,
the first upper bound, **in `request.filters` order**. Claim positionally: mark the first
match, leave redundant same-column same-role filters unhandled so they survive as a
residual `Filter`. The planner defends itself against an over-claim by reattaching any
seek-family filter it did not consume (`reattachUnconsumedConstraints`), so an
over-claiming module costs a redundant filter, not a wrong answer.

Ops outside the seek family (`IS NULL`, `IS NOT NULL`, `LIKE`, `GLOB`, `MATCH`,
`NOT IN`) are never pushed into `FilterInfo` by this rule, so a module claiming one is
taken at its word — claim only when the predicate is tautological over the rows you
return (the memory module's `IS NOT NULL` on a `NOT NULL` column).

#### The access-path seam: `FilterInfo.accessPath`

Alongside the free-text `idxStr`, `rule-select-access-path` records its choice on the
physical leaf as a typed `FilterInfo.accessPath` (`vtab/index-descriptor.ts`): one of
`{ kind: 'fullScan' }`, `{ kind: 'empty' }`, `{ kind: 'index', index, plan }`, or
`{ kind: 'unresolvedIndex', indexName, plan }`. `idxStr` is the text *projection* of the
same choice — both are emitted from one `(indexName, plan, params)` triple through
`encodeIdxStr`, so they cannot drift, and every module runtime still parses `idxStr` via
the shared `decodeIdxStr`. Consumers that need to know *what the index is* — above all the
isolation overlay, which must merge in the underlying scan's sort order — read
`accessPath.index` (its `role`, full `keyColumns`, `unique`) rather than re-parsing text.

The `index` arm's descriptor is resolved by `resolveIndexDescriptor`: a module-supplied
`indexDescriptor` wins, then `_primary_`, then a case-insensitive schema-index lookup. A
name that resolves to none of these — a per-plan alias a module minted without a
descriptor — becomes `unresolvedIndex`, logged at warn level; an order-sensitive consumer
must refuse such a plan rather than guess it is the primary key. See
[module authoring](module-authoring.md#2-index-based-access-standard) for the module-side
contract.

Which seek-family filters the rule *can* consume is further shaped by the seek encodings.
Seek keys are positional, so a standalone range bound is only ever seeked on the
**leading** seek column; a range on a later seek column requires the prefix-range
encoding, which needs every preceding seek column pinned by a single-valued equality. A
multi-value `IN` is not a single-valued prefix key: a module that advertised `a in (1, 2)
and b > 15` over `(a, b)` as a prefix-range seek would get a sequential scan with both
predicates as residuals, so the built-in modules decline that arm and keep the `IN`
multi-seek with `b` residual.

### Debugging and Tracing

The optimizer provides comprehensive debugging support:

**Debug Namespaces**
- `quereus:optimizer`: General optimizer operations
- `quereus:optimizer:rule:*`: Individual rule execution
- `quereus:optimizer:properties`: Physical property computation

**Trace Hooks**
```typescript
interface TraceHook {
  onRuleStart?(rule: RuleHandle, node: PlanNode): void;
  onRuleEnd?(rule: RuleHandle, before: PlanNode, after: PlanNode | undefined): void;
}
```

**Plan Visualization and Testing**
The PlanViz tool (`packages/tools/planviz`) provides visual plan inspection:
```bash
quereus-planviz query.sql --format tree
quereus-planviz query.sql --format mermaid --phase physical
```

Testing optimizer effects is easy using the `query_plan()` built-in:
```sql
-- Example: ensure FILTER was pushed into Retrieve (0 remaining above)
SELECT COUNT(*) AS filters
FROM query_plan('SELECT id FROM t WHERE id = 1')
WHERE op = 'FILTER';
```

## Extending the Optimizer

### Adding a New Optimization Rule

1. **Create Rule File** in appropriate subdirectory:
```typescript
// src/planner/rules/category/rule-name.ts
export function ruleMyOptimization(
  node: PlanNode,
  context: OptimizerContext
): PlanNode | null {
  // Check applicability
  if (!isApplicable(node)) {
    return null;
  }
  
  // Transform node
  const transformed = performTransformation(node);
  
  // Preserve attribute IDs!
  return transformed;
}
```

2. **Register Rule** by adding an entry to `RULE_MANIFEST` in optimizer:
```typescript
// src/planner/optimizer.ts — add an entry to RULE_MANIFEST at the position
// that gives the ordering you want. Array order IS execution order within a
// pass; place the entry before/after the rules it must run before/after.
{
  pass: PassId.Structural,
  id: 'MyRule',
  nodeType: PlanNodeType.Target, // or an array to fan `fn` across several types
  phase: 'rewrite',
  fn: ruleMyOptimization,
  sideEffectMode: 'safe', // or 'aware' — see § Audit discipline below
}
```

3. **Add Tests** with golden plans:
```sql
-- test/plan/my-optimization/test.sql
SELECT * FROM users WHERE active = true;
```

### Best Practices

**Rule Development**
- Keep rules focused on a single transformation
- Return `null` for non-applicable cases
- Never mutate input nodes
- Always preserve attribute IDs
- **Use characteristics-based patterns**: Prefer `CapabilityDetectors` over `instanceof` checks for robust, extensible rules
- Include comprehensive tests
- **A rule is never re-offered its own output.** When a rule fires, `PassManager.applyPassRules` (`framework/pass.ts`) marks the rule applied on the node it consumed and inherits that applied-rule set onto the node the rule produced, so the same rule will not fire again on its own result during the fixpoint loop. A rule that needs to converge over its *own* rewrites (e.g. collapsing an arbitrarily deep stack of the same node type) must loop internally rather than lean on the engine to re-invoke it — see `rule-filter-merge` (`planner/rules/predicate/rule-filter-merge.ts`), which absorbs a whole chain of nested `Filter` nodes in one call for exactly this reason.

**Property Computation**
- Implement `computePhysical()` to override physical properties for new node types
- Use automatic inheritance of properties from children when appropriate
- Document any property assumptions

**Cost Estimation**
- Use centralized cost functions
- Provide reasonable defaults
- Document cost model assumptions

## Audit discipline (`sideEffectMode`)

> **Invariant:** [OPT-001](invariants.md#opt-001--every-rule-declares-sideeffectmode)

Every rule registered via `addRuleToPass` **must** declare its
`sideEffectMode`. `validateSideEffectMode` (`framework/registry.ts`) checks
the field at registration time and rejects any rule that fails to declare.
This is the load-bearing audit gate the side-effect-aware optimizer rests on.

### The signal

`PlanNode.physical.readonly` is the canonical side-effect flag — `false`
means "executing this node has a write side effect" (DML, sequence step,
external sink). It propagates as **AND-of-children**: a node inherits
`readonly` from its children unless its own `computePhysical` overrides
the value. So for any well-formed plan tree, a single DML node anywhere
beneath a SELECT marks every ancestor as side-effect-bearing.

`PlanNodeCharacteristics` exposes two helpers:

```typescript
PlanNodeCharacteristics.hasSideEffects(node)         // local node only
PlanNodeCharacteristics.subtreeHasSideEffects(node)  // iterative subtree walk (defensive)
```

The defensive subtree helper (an explicit worklist, so a deep plan cannot
overflow the native call stack) exists so a rule's intent reads clearly
(*"refuse if any subtree I move / drop / dedup carries a write"*) and so
the audit gate still fires when a custom `computePhysical` override fails
to propagate `readonly=false`.

### The two declarations

> **Invariant:** [OPT-002](invariants.md#opt-002--an-aware-rule-consults-the-side-effect-signal), [OPT-003](invariants.md#opt-003--a-static-guard-checks-every-aware-rules-source-for-a-purity-signal)

- `'safe'` — the rule never moves, duplicates, drops, or merges any
  subtree it does not separately verify pure. Annotation-only transforms,
  in-place field flips (e.g. swap an AsofScan strategy), and logical→
  physical replacements where every child survives in the same position
  qualify. The rule does NOT need to consult `hasSideEffects` because its
  structural shape guarantees side-effect preservation.

- `'aware'` — the rule DOES move, duplicate, drop, or merge subtrees, and
  explicitly consults `PlanNodeCharacteristics.hasSideEffects` (or
  `subtreeHasSideEffects`) to refuse / weaken when any participating
  subtree carries a write. Includes rules that *intentionally* preserve
  side effects through run-once memoization (e.g.
  `rule-mutating-subquery-cache`, which targets impure right sides and
  wraps them in a `CacheNode` so the join's nested-loop driver doesn't
  re-execute the write per outer row).

### Rule categories that consult the signal

| Category | Mode | Why |
|---|---|---|
| `subquery/` (decorrelation, FK-empty / FK-trivial) | aware | Decorrelation changes execution cardinality; FK-empty / -trivial drop subtrees. |
| `predicate/` (pushdown, aggregate-pushdown, fold-empty, contradiction, inference) | aware | Pushdown moves rows under a side-effect subtree; folds drop subtrees. |
| `cache/` (mutating-subquery-cache, nested-loop-right-cache, scalar-subquery-cache, materialization-advisory, scalar-cse) | aware | Cache injection is a run-once memoize; CSE dedups scalar expressions. |
| `join/` (greedy-commute, physical-selection, fanout, quickpick, join-elimination, lateral-asof) | mixed | Commute / build-probe swap / index-NL seek-side swap reorder; elimination drops; FanOut clusters concurrently. |
| `parallel/` (async-gather union-all / zip-by-key, eager-prefetch-probe, fanout-batched) | aware | Concurrent drivers interleave per-branch writes. |
| `retrieve/` (grow-retrieve, projection-pruning) | mixed | Grow slides into read-only Retrieve (safe); pruning drops scalar projections (aware). |
| `access/`, `sort/`, `aggregate/`, `window/`, `distinct/` | mostly safe | Replace logical with physical nodes / annotate in place. |

The full per-rule annotation lives on each entry in `RULE_MANIFEST` in
`src/planner/optimizer.ts`. Treat that file as the single source of truth
for the audit.

### When DML-in-expression-position lands

The audit gate is mostly inert today because DML appears only at the
root or in FROM position. Once `dml-in-expression-position` lifts the
planning-time gate, side-effect-bearing scalars (`(insert ... returning ...)`)
will appear inside Project / Filter / Sort expressions, and every aware
rule that consults `subtreeHasSideEffects` will start refusing or
weakening on the new shapes. The discipline is the safety net those
landings stand on.

### Parallel-track side-effect refusal

> **Invariant:** [OPT-006](invariants.md#opt-006--parallel-track-rules-refuse-an-impure-branch)

The `parallel/` rules (`async-gather-union-all`, `async-gather-zip-by-key`,
`eager-prefetch-probe`) and the `join/`-residing fan-out rules
(`fanout-lookup-join`, `fanout-batched-outer`) all fork the
`RuntimeContext` and drive sibling subtrees **concurrently** on the same
connection. The module concurrency contract (`'serial'` /
`'reentrant-reads'` / `'fully-reentrant'`) governs *reads*; a DML
subtree on a sibling branch violates the per-connection lock under
everything except `'fully-reentrant'`, and no module currently
advertises that level. The parallel-recognition rules must therefore
refuse to fold / fork / prefetch when any participating branch reports
`hasSideEffects = true`.

`PlanNodeCharacteristics.isConcurrencySafe(node)` is the shared
predicate every parallel-track rule consults. It is implemented as the
negation of `subtreeHasSideEffects` — side-effect freedom is the only
gate today; the module-level concurrency contract is enforced
separately via `node.physical.concurrencySafe`. Once a
`'fully-reentrant'` module ships, `isConcurrencySafe` can be refined to
permit concurrent impure execution on it, without touching every
caller.

The refusal pattern is uniform across the parallel rules:

```typescript
for (const branch of branches) {
  if (branch.physical.concurrencySafe !== true) return null;   // module-level
  if (!PlanNodeCharacteristics.isConcurrencySafe(branch)) return null; // side-effect
}
```

This is a **refusal**, not a fallback to a serial variant — the rules
are optimizations layered on top of an already-correct serial plan.
Refusing leaves the serial plan in place, which is correct (writes
execute exactly once, in textual order, under the connection lock).
Regression coverage lives in
`packages/quereus/test/optimizer/parallel-side-effect-refusal.spec.ts`,
which pins the predicate's contract and the negative-fold cases.

## Common Patterns

### Predicate analysis and pushdown

Filter predicates are normalized, split into constraints, and pushed as far toward the data
as each module will accept — the supported-only placement policy keeps unsupported residuals
above the `Retrieve` boundary. See
[Rule Families § Predicate Analysis and Pushdown](optimizer-rule-families.md#predicate-analysis-and-pushdown).

### Property Propagation
```typescript
computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
  return {
    // Physical count first, logical getter only as fallback — see
    // "The number the selectivity multiplies" in docs/optimizer-costing.md.
    estimatedRows: physicalSourceRows(childrenPhysical[0], this.source),
    // Keys propagate as FDs in `fds`. TableReferenceNode emits `{pk} → other-cols`
    // FDs; physical access nodes pass them through unchanged.
    fds: childrenPhysical[0]?.fds,
    ordering: this.providesOrdering,
  };
}
```

### Cache Injection
```typescript
if (shouldCache(node, context)) {
  return new CacheNode(
    node.scope,
    node,
    'memory',
    calculateThreshold(node.physical.estimatedRows)
  );
}
```

## Performance Considerations

### Rule Ordering
- Rules execute in registration order
- Place cheap checks before expensive transformations
- Consider rule dependencies when ordering

### Property Caching
- Physical properties are computed once and cached
- Avoid redundant property calculations
- Use lazy evaluation where appropriate

### Memory Usage
- Plan trees can be large for complex queries
- Avoid keeping references to old plan nodes
- Clean up temporary data structures

## Current limitations

- **OR predicate extraction across different indexes** remains a residual filter. The
  same-column collapses (OR-of-equalities ⇒ `IN`, OR-of-ranges ⇒ `OR_RANGE`) are
  implemented and gated on matching disjunct collation. Tracked by
  `tickets/plan/2-or-to-union-rewriting.md`.
- **Prefix-equality + trailing-range seeks on composite indexes** are not supported.
  Tracked by `tickets/plan/2-composite-index-advanced-seeks.md`.
- **Collation-mismatched index seeks** re-apply the predicate as a residual `Filter`
  (coarser equality index) or decline to a filtered scan (finer index, or any range
  mismatch). See the collation-cover note under `ruleSelectAccessPath` in the
  [rule catalog](optimizer-rules.md#optimization-rules).
- Longer-range optimizer work is listed in [`docs/todo.md`](todo.md) and `tickets/plan/`.

## Streaming and monotonic recognition

Several rules recognize that a plan's input already arrives in the order an operator would
otherwise have to establish, and replace the buffering operator with a one-pass streaming
one. They all read the `physical.monotonicOn` advertisement. Covered in
[Optimizer Streaming Recognition](optimizer-streaming.md):

- **[Streaming asof scan](optimizer-streaming.md#streaming-asof-scan)** — rewrites the
  lateral-top-1 idiom (`left join lateral (… order by q.ts desc limit 1)`) to an
  `AsofScanNode` that runs in `O(L + R)` instead of `O(L · log R)`.
- **[Monotonic LIMIT/OFFSET pushdown](optimizer-streaming.md#monotonic-limitoffset-pushdown)**
  — seeks straight to the kth row when the access path advertises ordinal seek.
- **[Monotonic range-scan recognition](optimizer-streaming.md#monotonic-range-scan-recognition)**
  — annotates a range-bounded monotonic leaf, and defensively drops `monotonicOn` when a
  module declines a range filter it claimed to order on.
- **[Monotonic streaming-window recognition](optimizer-streaming.md#monotonic-streaming-window-recognition)**
  — flips a `WindowNode` to a one-pass emitter, dropping the sort and the buffer.

## Future Directions

The overarching optimization strategy is **progressive, JIT-inspired**: robust heuristic defaults that avoid catastrophic plans without any statistics, with runtime execution feedback driving incremental improvement. See [Progressive Query Optimization](./progressive-optimizer.md) for the full architecture.

See `tickets/plan/` for planned optimizer work.

## Join planning

Join order is chosen by a randomized greedy tour search (QuickPick); a physical algorithm
(nested loop, hash, merge, or an index-nested-loop that seeks one side once per row of
the other — for an inner join, whichever orientation costs less) is then selected per
join by cost. Separately, a chain of
per-outer-row lookups can be clustered into one concurrently-driven fan-out node, and the
keys a join propagates to its output are derived from equi-pair coverage. See
[Optimizer Joins](optimizer-joins.md).

## Visited tracking

Rule application is tracked per optimization *context*, never globally. A per-pass
traversal cache keyed by node id keeps a shared subtree — a CTE referenced twice, a
repeated view expansion — optimized consistently within a pass, and a per-context record
of which rules have already *transformed* which node stops a rule being re-offered its own
output. Declines are tracked separately and ephemerally: they are reset the moment any rule
transforms the node, so they never suppress a rule that becomes applicable on the new
shape. See [Optimizer Visited Tracking](optimizer-visited-tracking.md).

## Attribute provenance

> **Invariant:** [OPT-014](invariants.md#opt-014--an-attribute-id-is-originated-exactly-once)

Attribute IDs have two distinct lifecycle operations that `getAttributes()` smears together:

- **Origination** — a node *mints* a fresh ID via `PlanNode.nextAttrId()` (scans, computed projections, aggregate outputs, VALUES rows).
- **Forwarding** — a node *re-publishes* an ID one of its children already produced.

The real invariant of the attribute model is **"each ID is originated exactly once"**, plus "every referenced ID resolves to an in-scope origin". It is emphatically *not* "each ID appears at most once in the tree": several physical node families deliberately forward their children's IDs verbatim so that downstream `ORDER BY` and column references keep resolving against stable IDs — `SetOperationNode` (mirrors the left child), `JoinNode` / `BloomJoinNode` / `MergeJoinNode` (concatenate left+right), `EagerPrefetchNode` (pass-through), `AsyncGatherNode` (mirror children[0] / concatenate), `FanOutLookupJoinNode`, and `ProjectNode` / `ReturningNode` (forward the source ID for *simple column-ref* projections while minting fresh IDs for *computed* projections — so the distinction is per-attribute, not per-node).

Origination is **derivable structurally** without any per-node declaration: an ID is originated at the deepest relational node that outputs it and whose direct relational children do **not**. Any node that outputs an ID already present in one of its direct children is forwarding it. `computeAttributeProvenance(root)` (`planner/analysis/attribute-provenance.ts`) does this in one post-order walk, returning `Map<attrId, { originNode, path }>`. It throws `QuereusError(INTERNAL)` when two distinct nodes originate the same ID (the genuine-bug case) or when one node lists an ID twice; forwarding never throws. The walk dedupes by node identity, so a shared subtree instance (DAG) is not mistaken for a collision.

`validatePhysicalTree` (the `tuning.debug.validatePlan` pass) consumes this surface: it computes provenance once at entry — which both detects duplicate origins and yields the complete `attrId → origin` map — then resolves every `ColumnReference` against `provenance.has(attrId)`. This preserves the prior global-set scoping semantics (sibling-scope visibility is intentionally not tightened here) while no longer false-positiving on attribute-preserving parents.

A companion per-node surface, `PlanNode.getAttributeIndex(): ReadonlyMap<number, number>` (cached, mirrors the `attributesCache` pattern; rebuilds automatically since `withChildren` mints a fresh instance), answers the local "attrId → its index in this node's output" question — replacing the scattered `attrs.findIndex(a => a.id === …)` scans (e.g. `bloom-join-node.ts`, `rule-monotonic-range-access.ts`).

This provenance surface is the **future** mechanism for the [lens](lens.md#overrides-are-merged-per-attribute) sparse-override merge: addressing override coverage by stable attribute ID is what the lens prover (`lens-prover-and-constraint-attachment`) needs when it plans the compiled body to read the FD/key surface. **v1 of the merge does not yet use it** — it composes at the AST level, reading coverage by output-column *name* and recomputing (re-reading the override from source) on every deploy, which delivers the same rename-then-add composability without pulling the planner into the lens compiler. When the prover lands, the merge moves onto the plan tree and addresses attributes by ID.

## Functional Dependency Tracking

Functional dependencies (FDs) are the canonical surface for "what determines what" on a relational node's output. A unique key `K` is encoded as the FD `K → (all_cols \ K)` rather than carried in a separate field, and `∅ → all_cols` encodes the at-most-one-row claim. Equivalence classes, constant bindings, domain constraints, and inclusion dependencies ride the same per-operator propagation. Consumers read uniqueness through `keysOf` / `isUnique` / `isUniqueDeterminant` in `planner/util/fd-utils.ts` and never hand-check the underlying surfaces.

See [Functional Dependency Tracking](optimizer-fd.md) for the type definitions, the per-operator propagation tables, the collation gates, and the producer/consumer catalog.

## Cardinality and key rules

Equality on every column of a unique key caps a relation at one row; foreign keys are
inclusion dependencies that let a semi-join fold to its left side and an anti-join fold to
empty; an unsatisfiable predicate folds to `EmptyRelationNode`, which then cascades. These
rules and the key-propagation rules that feed them are in
[Optimizer Rule Families](optimizer-rule-families.md#key-driven-row-count-reduction).

## Parallel-track recognition

Three rules recognize plan shapes that can be driven concurrently: independent `union all`
branches (`AsyncGatherNode`, `unionAll`), a shared-key full-outer join chain
(`AsyncGatherNode`, `zipByKey`), and a hash join whose build side is high-latency
(`EagerPrefetchNode` over the probe). Every one is inert on local-only plans, because the
gate reads `expectedLatencyMs`, which memory-backed leaves leave at 0. See
[Optimizer Parallel Track](optimizer-parallel.md); the runtime contracts are in
[Runtime](runtime.md).

## Assertion delta analysis

A `create assertion` violation query is re-checked at COMMIT. Re-running it whole on every
commit is unaffordable, so each table reference inside the plan is classified `'row'`,
`'group'`, or `'global'`: whether a change to that table can be re-checked by binding a
unique key, a group key, or not at all. The same analysis is reused by `Database.watch` and
the lens layer. See [Optimizer Assertion Analysis](optimizer-assertions.md) for the
classification and binding rules, and [Incremental Maintenance](incremental-maintenance.md)
for the runtime that executes the residuals.

## Retrieve push-down and correlated access

Every `TableReferenceNode` is wrapped in a `RetrieveNode` at build time, marking the exact
boundary between module execution and Quereus execution. Structural rules slide supported
operations across that boundary — never unsupported ones — and the physical pass replaces
every `RetrieveNode` with a concrete access node (`SeqScan`, `IndexScan`, `IndexSeek`) or a
`RemoteQuery`. See [Optimizer Retrieve Push-down](optimizer-retrieve.md).

## Optimization Pipeline Architecture

Quereus uses a **characteristic-based** optimization pipeline that leverages the unique logical properties of different node types to apply rules in optimal sequence. The RetrieveNode's unique logical representation makes it an ideal boundary marker for this approach.

### Why the segment boundary comes first

The builder wraps every `TableReferenceNode` in a `RetrieveNode`, so module execution
boundaries exist before any rule runs. `ruleGrowRetrieve` then slides operators into those
boundaries in the Structural pass — ahead of predicate push-down, ahead of join
enumeration, ahead of physical selection.

That ordering is the point. Growth is purely structural (it asks `supports()`, never the
cost model), so it always terminates at the same segment for a given plan. Once the
segments are fixed, every later rule sees a base relation whose `estimatedRows` already
reflects everything the module will do for itself — which is what makes join enumeration's
cost comparisons meaningful. Enumerating first and pushing afterwards would order joins
against cardinalities that the push-down then invalidates.

The concrete pass list, with what runs in each, is
[Multi-Pass Optimization System](#multi-pass-optimization-system) above. Push-down work
still on the roadmap — projection and aggregation push-down, cost-precise placement of OR
and subquery predicates, correlated push-down — is tracked in
[`docs/todo.md`](todo.md#-push-down--federation-roadmap-active-items).

### Characteristic-Based Rule Design Philosophy

**RetrieveNode Exception**: While Quereus generally avoids hard-coding specific node types in rules, `RetrieveNode` represents a unique logical concept - the module execution boundary. This makes it appropriate to have rules that specifically target `RetrieveNode` characteristics.

**General Principle**: Most other rules should operate on logical characteristics rather than specific node types:
- Filter placement based on selectivity characteristics
- Join reordering based on cardinality characteristics  
- Projection elimination based on attribute usage characteristics

**Benefits of This Approach**:
- Rules remain orthogonal and composable
- Easy to add new node types without breaking existing rules
- Clear separation of concerns between different optimization phases
- Predictable rule application order based on logical properties

## Rejected alternatives

- **Inheriting a rule's *declines* across a transform.** Decline sets are reset the moment
  any rule transforms a node, and are never carried onto the freshly-minted node. Carrying
  them would suppress a rule that becomes applicable only after a *sibling* rule reshapes
  the node — `ruleAsyncGatherZipByKey` is a concrete case — silently changing plans in
  exchange for a small amount of re-run work.
- **A global visited set.** Tracking is context-scoped instead, so the same rule may apply
  to a shared subtree along different paths, and a later pass can revisit what an earlier
  one cached. See [Optimizer Visited Tracking](optimizer-visited-tracking.md).
- **Separate logical and physical plan hierarchies.** One `PlanNode` tree transitions from
  logical to physical by property annotation; see
  [Single Hierarchy, Dual Phase](#single-hierarchy-dual-phase).
