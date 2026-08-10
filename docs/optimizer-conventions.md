# Optimizer Conventions: Node Discrimination & Characteristics

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

This document is the canonical guide for **how an optimizer rule or plan builder asks a question about a plan node** — "is this a specific class?", "can this node do X?", "what are its physical properties?" — and which mechanism answers each. It also covers the characteristics/physical-property layer that many rules reason over.

## Node discrimination: three questions, three mechanisms

A rule almost always needs one of three distinct things from a node. They are **not** interchangeable, and each has exactly one right mechanism:

| Question the rule is asking | Mechanism | Where it lives |
| --- | --- | --- |
| "Is this *this specific class*, so I can use its API?" | `instanceof SomeNode` | the node classes themselves |
| "Can this node do X, whatever its class?" (any join kind, any aggregate kind) | branded marker interface + `CapabilityDetectors` guard | `src/planner/framework/characteristics.ts` |
| "What are this node's physical properties?" (readonly / ordering / FDs / determinism) | `PlanNode.physical` via `PlanNodeCharacteristics` | `src/planner/framework/characteristics.ts` |

A fourth mechanism, `node.nodeType` (a `PlanNodeType` enum value), exists but is **for dispatch and serialization only** — rule-manifest routing, the plan formatter, EXPLAIN. It is *not* a class-narrowing tool: `nodeType` is not 1:1 with classes and gives the compiler no narrowing.

### The distinction rule authors need at the keyboard

> **Need one class's specific API → `instanceof` that class.**
> **Need "any node that can do X" → the capability guard.**

Both are legitimate. They differ by **intent**, and that difference is not "drift." A rule that only ever works on `AggregateNode` should say `instanceof AggregateNode`; a rule that works on *any* aggregating node should ask `CapabilityDetectors.isAggregating(node)`. Choosing the narrower `instanceof` when you mean one class is correct, not a smell.

## `instanceof` — concrete class identity

Use `instanceof` when a rule needs a **specific class's** API. It is type-sound, narrows natively, and is the dominant idiom in the planner (hundreds of call sites). The canonical rule shape is:

```typescript
const ruleAggregateStreaming: RuleFn = (node, optimizer) => {
  if (!(node instanceof AggregateNode)) return null;
  // node is now AggregateNode — its full API is available with compiler narrowing
  ...
};
```

**Why `instanceof` is safe here (cross-bundle constraint).** Planner node classes are singletons within `@quereus/quereus` — there is exactly one `AggregateNode` constructor per process, and plugins never receive plan nodes across a bundle boundary. So the classic `instanceof`-across-realms hazard (two copies of a class, `instanceof` silently false) does not arise for plan nodes. `instanceof` on a planner node is as reliable as any other identity check.

## Cross-class capability — branded marker interfaces

When a rule accepts **any implementer of a capability** — any join kind, any aggregate kind, anything that exposes a predicate — use the branded marker interfaces in `characteristics.ts` and their `CapabilityDetectors` guards.

Each capability interface declares a unique `readonly is<X>Capable: true` **brand**. Every implementer sets it, and the matching guard tests exactly that marker:

```typescript
export interface AggregationCapable extends RelationalPlanNode {
  readonly isAggregationCapable: true;   // the brand
  getGroupingKeys(): readonly ScalarPlanNode[];
  ...
}

// in CapabilityDetectors:
static isAggregating(node: PlanNode): node is AggregationCapable {
  return (node as Partial<Pick<AggregationCapable, 'isAggregationCapable'>>).isAggregationCapable === true;
}
```

To make a node detectable as a capability:

1. Declare `implements XCapable` on the class.
2. Set the `is<X>Capable` brand to `true`.
3. Add (or reuse) the guard in `CapabilityDetectors`.

**The compiler enforces completeness.** `implements XCapable` fails to compile unless the class also sets the brand, so "implements the capability" and "is detected as having it" are the *same fact* — a new implementer cannot silently be missed by a guard. A unique brand name also cannot misfire on an incidental property.

### The anti-pattern: duck-typed `as any` detectors

The thing to **not** do — and the reason `characteristics.ts` is lint-guarded against `any` — is detect a capability by probing for a property or method with a cast to `any`:

```typescript
// ❌ Anti-pattern: duck-typed property-presence check
function isAggregating(node: PlanNode): boolean {
  return 'getGroupingKeys' in node
    && typeof (node as any).getGroupingKeys === 'function';
}
```

This misfires: it silently matches any *unrelated* node that happens to grow a `getGroupingKeys` member, and it silently *stops* matching if the method is renamed — with no compiler help either way. The brand mechanism above replaced every such detector. `characteristics.ts` carries a file-scoped `@typescript-eslint/no-explicit-any: error` override (in `packages/quereus/eslint.config.mjs`) so a reintroduced `as any` detector fails lint.

## `nodeType` — dispatch and serialization only

`node.nodeType` routes the rule manifest, drives the plan formatter, and labels EXPLAIN output. Use it there. Do **not** use it to narrow to a class in rule logic — it is not 1:1 with classes and the compiler cannot narrow on it. For "is this a specific class?" use `instanceof`; for "can it do X?" use the capability guard.

## Physical characteristics

Physical properties — readonly, ordering, functional dependencies, determinism, cardinality — are the canonical source for "what this node *does* at runtime," independent of its class. They live on `PlanNode.physical` and are read through `PlanNodeCharacteristics`.

This is a genuinely different question from class identity. Detecting side effects, for example, is a physical-property question, not an `instanceof` one:

```typescript
// A node's side-effect status is a physical property, not a class fact —
// UpdateNode, DeleteNode, and any future mutating node all answer through
// the same surface.
if (PlanNodeCharacteristics.hasSideEffects(node)) {
  // handle operations with side effects
}
```

Likewise "does this produce ordered output?" is answered by physical properties, not by enumerating the classes (`Sort`, `StreamAggregate`, …) that happen to:

```typescript
if (PlanNodeCharacteristics.hasOrderedOutput(node)) {
  // any node that produces ordered output
}
```

The detector surface (`PlanNodeCharacteristics`) covers side effects, readonly/determinism/idempotence, ordering and monotonicity, cardinality (`estimatesRows`, `guaranteesUniqueRows`, `hasUniqueKeys`), and the relational/scalar/void type class. See `src/planner/framework/characteristics.ts` for the full list.

### Functional Dependencies, Equivalence Classes, Bindings

**Problem**: Rules need to reason about "what determines what" — uniqueness, transitive equalities, pinned constants, domain constraints — across many operator shapes without re-implementing the algebra.
**Solution**: Treat `PhysicalProperties.fds` / `equivClasses` / `constantBindings` / `domainConstraints` as the single source of truth, and route every query through the helpers in `planner/util/fd-utils.ts` rather than walking the lists directly.

```typescript
// ❌ Fragile: re-implementing closure inline
const determined = new Set<number>(seedCols);
for (const fd of node.physical.fds ?? []) {
  if (fd.determinants.every(d => determined.has(d))) {
    for (const dep of fd.dependents) determined.add(dep);
  }
}

// ✅ Robust: use the shared fixed-point helper (which also handles iteration to convergence)
import { computeClosure } from '../util/fd-utils.js';
const determined = computeClosure(seedCols, node.physical.fds ?? []);
```

**Key conventions for FD-aware rules.** Most of these are normative — the register is where
they are stated, and where a reviewer checks them against the code. This guide keeps only
what a rule author needs at the keyboard.

> **Invariant:** [OPT-030](invariants.md#opt-030--uniqueness-is-read-through-one-surface), [OPT-032](invariants.md#opt-032--coverage-is-not-uniqueness)

Reason through the helpers, never by walking `physical.fds` yourself — hand-walking misses
transitive closure and forgets the subsumption / cap / guard semantics `addFd` enforces. And
pick coverage vs uniqueness deliberately: `closureCoversAll` is a pure value claim (a
determined column is redundant in an `ORDER BY` / `GROUP BY` regardless of uniqueness),
whereas `isUniqueDeterminant` — or, at node level, `keysOf` / `isUnique` — is the only sound
way to ask "is this set row-unique?".

> **Invariant:** [OPT-034](invariants.md#opt-034--closure-helpers-skip-guarded-fds), [OPT-036](invariants.md#opt-036--a-guard-is-discharged-only-at-the-producing-filter), [OPT-038](invariants.md#opt-038--projection-drops-an-fd-whose-guard-loses-a-column)

If your rule needs a guarded FD's fact, do not discharge the guard yourself. Discharge happens
at the producing `Filter`'s `computePhysical`, via `predicateImpliesGuard` + `stripGuard`.

> **Invariant:** [OPT-048](invariants.md#opt-048--dependency-facts-index-output-columns)

Crossing a Project / Returning / Aggregate / join boundary, translate via `projectFds` /
`shiftFds` and their EC / binding / domain / IND mirrors instead of hand-mapping indices.

> **Invariant:** [OPT-046](invariants.md#opt-046--addfd-is-the-only-fd-accumulation-path), [OPT-047](invariants.md#opt-047--addfd-deduplicates-by-subsumption-and-evicts-by-keykind-preference)

Accumulate with `addFd`, not `Array.push`. Pass `{ keyHints }` listing column-index sets known
to be keys so cap eviction prefers to keep them; truncations log on the `quereus:planner:fd`
debug channel.

> **Invariant:** [OPT-042](invariants.md#opt-042--an-outer-join-drops-the-null-padded-sides-facts)

Do not invent a propagation policy for a new operator — follow the per-operator table in
[Functional Dependency Tracking](optimizer-fd.md#per-operator-propagation).

> **Invariant:** [OPT-054](invariants.md#opt-054--all-columns-key-ness-lives-on-isset), [OPT-052](invariants.md#opt-052--provenance-is-informational)

Set-ness is not an FD, but the readers consume it: `hasAnyKey(fds, columnCount, isSet)` and
friends take it as a parameter, while `keysOf` / `isUnique` read `getType().isSet` themselves.
And a `source` tag is for diagnostics — never branch rule logic on it.

**Not in the register** (a convention, not an invariant): whenever a rule adds a
`ConstantBinding` at the same site as ECs (Filter, inner join), close it with
`closeConstantBindingsOverEcs` so downstream consumers see the binding on every EC peer in one
pass. That is what makes `WHERE t.k = u.k AND t.k = 5` land as one binding covering both
columns.

See [Functional Dependency Tracking](optimizer-fd.md#functional-dependency-tracking) for the producer/consumer catalog and the per-operator propagation table, and [Assertions § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable) for the `analyzeRowSpecific` / `extractBindings` analysis surface that builds on this layer.

## Worked example: caching eligibility

Cache eligibility mixes all three questions — a physical-property check (`isRelational`, `hasSideEffects`) and a capability guard (`isCached` narrows to `CacheCapable`, so `isCached()` is callable without a cast):

```typescript
export class CachingAnalysis {
  static isCacheable(node: PlanNode): boolean {
    // Physical: must be relational to cache results
    if (!PlanNodeCharacteristics.isRelational(node)) return false;

    // Capability: already-cached nodes don't need re-caching
    if (CapabilityDetectors.isCached(node) && node.isCached()) return false;

    // Physical: side effects gate cacheability
    if (PlanNodeCharacteristics.hasSideEffects(node)) {
      return this.isExpensiveRepeatedOperation(node);
    }
    return true;
  }
}
```

## Rule Development Guidelines

### Decide which question you're asking first
Before writing a rule, name what it needs from the node:

```typescript
function ruleMyOptimization(node: PlanNode, context: OptContext): PlanNode | null {
  // Class identity → instanceof
  if (!(node instanceof MyTargetNode)) return null;
  // Physical gate → PlanNodeCharacteristics
  if (PlanNodeCharacteristics.hasSideEffects(node)) return null;
  // Cross-class capability → CapabilityDetectors
  if (!CapabilityDetectors.canPushDownPredicate(node)) return null;
  return transform(node, context);
}
```

### Document required characteristics
Make a rule's requirements explicit in its doc comment:

```typescript
/**
 * Rule: Predicate Pushdown
 *
 * Required:
 * - Node implements PredicateCapable (CapabilityDetectors.canPushDownPredicate)
 * - Node is read-only (PlanNodeCharacteristics.hasSideEffects === false)
 * - Predicate is deterministic
 */
export function rulePushDownPredicate(node: PlanNode, context: OptContext): PlanNode | null {
  // Implementation follows documented requirements
}
```

## For New Developers

When working with the optimizer or plan builders:

- **Need a specific class's API?** → `instanceof ThatNode`. It's type-sound, narrows natively, and is the dominant idiom. Safe here because planner nodes are singletons in `@quereus/quereus` (no cross-bundle realm hazard).
- **Need "any node that can do X"?** → a `CapabilityDetectors` guard backed by a branded marker interface in `src/planner/framework/characteristics.ts`.
- **Need a physical property** (readonly / ordering / FDs / determinism / cardinality)? → `PlanNodeCharacteristics` over `PlanNode.physical`.
- **Routing / serialization / EXPLAIN?** → `nodeType`. Never for class narrowing in rule logic.
- **DON'T** detect a capability by duck-typing — `'foo' in node && typeof (node as any).foo === 'function'`. That's the misfiring pattern the brand mechanism (and the `no-explicit-any` guard on `characteristics.ts`) exists to prevent.
