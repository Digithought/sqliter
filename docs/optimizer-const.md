# Titan Optimizer – Constant Folding & Constant-Dependency Resolution

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

This document describes the design, data-flow, and implementation of constant folding in Titan. It assumes familiarity with `README.md` and `docs/runtime.md`.

Implementation status: Implemented as a dedicated pre-optimization pass (Pass 0) in the optimizer’s multi-pass framework. Both scalar and relational constant folding are live. See “Pass 0: Constant Folding” in `docs/optimizer.md`.

The goal is to make any scalar or relational sub-tree that is functionally constant collapse to a `LiteralNode` or a `TableLiteralNode`, using one evaluation engine — the existing runtime.

---
## 1. Definitions

| Term            | Meaning                                                                                     |
|-----------------|---------------------------------------------------------------------------------------------|
| *pure*          | The node never mutates database or VM state.                                                |
| *deterministic* | Given identical inputs the node always returns the same output.                             |
| *functional*    | `pure` **and** `deterministic`.  A functional node is safe to fold.                         |

`functional` is not a stored property; it is derived as `deterministic && readonly`. Use `PlanNode.isFunctional(physical)`:
```ts
// plan-node.ts
public static isFunctional(physical: PhysicalProperties): boolean {
  return (physical.deterministic !== false) && (physical.readonly !== false);
}
```
A helper `isFunctional(node)` returns the effective value.

---
## 2. ConstInfo – bottom-up classification

During a single post-order DFS every `PlanNode` is assigned a `ConstInfo`:
```ts
/* not exported – internal to folding pass */
interface ConstInfoConst { kind: 'const'; node: PlanNode; }
interface ConstInfoDep   { kind: 'dep';   deps: Set<AttributeId>; }
interface ConstInfoVar   { kind: 'non-const'; }

type ConstInfo = ConstInfoConst | ConstInfoDep | ConstInfoVar;
```
Rules (scalar nodes):
1. `LiteralNode` → `const` with its value.
2. `ColumnReference(attrId)` → `dep` with `{attrId}`.
3. Any other scalar node
   - If *not* functional → `non-const`.
   - Else inspect children:
     • If all children `const`  → evaluate immediately (see §4) → `const`.
     • If all children ∈ {`const`,`dep`} → `dep` with union of child `deps`.
     • Otherwise → `non-const`.

Relational nodes are initially `non-const`; attributes produced will be analysed in the top-down pass.

The `Map<PlanNodeId, ConstInfo>` is stored on the pass context.

---
## 3. Propagating constant attributes (top-down)

We now walk the *relational* tree from root to leaves carrying a set
`knownConstAttrs: Set<AttributeId>`.

For a relational node `R` with output attributes `A₀…Aₙ`:
1. For each projection / column-producing expression `Eᵢ`:
   - Look up `ConstInfo` of `Eᵢ`.
   - If `kind === 'const'`           → mark `Aᵢ` constant.
   - If `kind === 'dep'` and `deps ⊆ knownConstAttrs` → we can now fold `Eᵢ` (evaluate & replace) and mark `Aᵢ` constant.
2. After processing, add all newly constant `Aᵢ` to `knownConstAttrs` and recurse to child relations, translating attribute IDs through projection / join mapping.

The pass converges in a single traversal because the set of constant attributes only grows and every node is visited once.

---
## 4. Evaluation via runtime

When we decide to fold a scalar expression `expr`:
```ts
const instr   = emitPlanNode(expr, new EmissionContext(db /* temp */));
const sched   = new Scheduler(instr);
const rtCtx: RuntimeContext = {
  db, stmt: null, params: {},
  context: new RowContextMap(), tableContexts: new Map(),
  enableMetrics: false
};
const out  = sched.run(rtCtx);
const val  = out instanceof Promise ? await out : out;
const lit  = new LiteralNode(expr.scope, {type: 'literal', value: val});
```
Notes
- There is **no special row context**.  Column references resolve because they're replaced only when their source attribute is already folded to a literal, thus no `ColumnReferenceNode` survives evaluation.
- The scheduler may or may not be async; both paths are handled.
- Any exception aborts folding and leaves the original node untouched.

---
## 5. Folding relational constants

Relational subtrees classified as `const` are replaced with `TableLiteralNode` via **deferred materialization**:

1. The relational subtree is emitted into an instruction tree and a `Scheduler` is created.
2. A `MaterializingAsyncIterable` wraps execution: on first iteration it runs the scheduler, collects all rows, caches them, and yields. Subsequent iterations yield from the cache.
3. A `TableLiteralNode` is constructed with the iterable, preserving the original node's `RelationType` and attribute IDs (via `predefinedAttributes`).

This keeps the optimizer synchronous while deferring actual execution to first runtime access. Attribute ID preservation ensures parent `ColumnReference` nodes continue to resolve correctly.

**What gets folded:**
- `VALUES` clauses with all-literal cells
- Constant subqueries (`SELECT 1+2, 'hello'`) — Project over SingleRow with const expressions
- Deterministic TVF calls with constant arguments (e.g., `query_plan('SELECT 1')`)
- Any functional relational node whose entire child subtree is const

**What does NOT get folded:**
- Anything referencing actual tables (`Retrieve` nodes are non-const)
- Non-deterministic expressions (`random()`, `datetime('now')`)
- Mutating operations (marked `readonly: false`)
- Void-type nodes (e.g., `Block`) — border detection recurses through these to find inner foldable nodes

---
## 6. API & integration points

### 6.1 Execution entry point
- Implemented as a dedicated pre-optimization pass (Pass 0) in the pass framework. The pass:
  1. Runs bottom-up classification.
  2. Runs top-down propagation.
  3. Replaces foldable scalar subtrees with `LiteralNode` and relational subtrees with `TableLiteralNode`.

Builders do not perform folding themselves; they rely on the optimizer pass.

### 6.2 Functional safety defaults
- Functional is derived: `isFunctional(physical) = deterministic && readonly`.
- Side-effecting or non-deterministic scalar operators must set `readonly=false` or `deterministic=false` via their physical property computation so they are never folded.

---
## 7. Correctness & safety

| Hazard                         | Mitigation                                                       |
|--------------------------------|------------------------------------------------------------------|
| Side-effects (`random()`, `now()`, UDF with mutations) | Those nodes have `functional=false`; never folded. |
| Future async UDFs              | Scheduler returns Promise; folding awaits it.                    |
| Column references before producer folded | Two-phase (bottom-up + top-down) ensures dependency sets resolved first. |

---
## 8. Extension ideas
* **Cost-based cut-off**: skip folding very large expression trees if projected gain is low.

---
## 9. Implementation TODO list
1. ~~Relational constant detection and replacement~~ — **Done.** Foldable relational subtrees replaced with `TableLiteralNode` via deferred materialization.
2. Cost-based cut-off heuristics for very large expression trees.
3. Optional PRAGMA to enable/disable constant folding for debugging.
4. Broader test coverage and golden plans for complex dependency scenarios.

---
### TL;DR
* functional = deterministic && readonly indicates fold-safety.
* Bottom-up builds dependency sets, top-down resolves them.
* Scalar constants → `LiteralNode`; relational constants → `TableLiteralNode` (deferred materialization).
* Evaluation uses the **existing runtime** through a mini-Scheduler.
* No environment-variable logic is needed in the folding path.
