---
description: The engine promises every expression's type is known when a query is compiled, but the actual JavaScript values are looser than the types claim — an integer might arrive as either of two JavaScript number kinds — forcing every operator to re-check what it received on every row; decide and enforce one canonical representation per declared type.
files:
  - packages/quereus/src/types/logical-type.ts       # PhysicalType — where the representation contract would live
  - packages/quereus/src/types/builtin-types.ts      # per-type parse/coerce — the write-side canonicalization that already exists
  - packages/quereus/src/runtime/emit/binary.ts      # mixedBigIntArithmetic + typeof dispatch — the per-row cost this retires
  - packages/quereus/src/util/comparison.ts          # getStorageClass / boolean-to-number arms — second beneficiary
  - packages/quereus/src/core/statement.ts           # parameter binding — an ingress boundary to canonicalize
  - packages/quereus/src/planner/nodes/scalar.ts     # literal construction — another ingress boundary
  - docs/types.md                                    # the logical/physical contract doc this would extend
difficulty: hard
---

# Design ticket: canonical physical representation per declared type

## The gap

`docs/types.md` and the architecture doc state that all expressions have known types at
plan time. That promise is cashed at the *logical* level but not at the
*value-representation* level:

- An INTEGER-typed value may be a JS `number` or a `bigint` at runtime, depending on how
  it entered (literal size, parameter binding, stored row, arithmetic result).
- `boolean` values flow through numeric contexts and every numeric comparison carries a
  boolean-coercion arm (`compareSameType`'s NUMERIC branch).
- ANY columns are legitimately heterogeneous (not the target of this ticket).

Consequence: even fully-specialized operator runs keep per-row `typeof` dispatch —
`mixedBigIntArithmetic`'s promotion/demotion logic, the bigint arms in `numeric-fast`
arithmetic, the boolean arms in comparison. The guarded-specialization ticket
(`runtime-guarded-comparison-specialization`) can hide these behind cheap guards, but only
a representation invariant can *delete* them.

## What this plan pass must produce

A written decision (in `docs/types.md` + implement tickets), covering:

1. **The INTEGER representation rule.** Options:
   - (a) INTEGER is always `bigint`. Clean, total, but slower for the overwhelmingly
     common small-integer case (bigint arithmetic and allocation cost), and changes the
     JS values users receive from `eval`/`iterateRows`.
   - (b) INTEGER is `number` while exactly representable, `bigint` past 2^53, with the
     boundary crossing rule pinned (this is roughly today's de-facto behavior — the
     decision would be to *specify and enforce* it, which still leaves dual-typeof
     dispatch but makes it sound and testable).
   - (c) Parameterize per-column/per-database. Rejected unless a strong case appears —
     complexity tax on every emitter.
   Interaction: the backlog ticket `bug-text-coercion-in-arithmetic-and-aggregates`
   (arm A) needs arbitrary-precision arithmetic on large integers — option (a) or a
   disciplined (b) is its substrate. Coordinate; do not duplicate its semantic claims.
2. **The BOOLEAN rule.** Keep `boolean` as a first-class runtime value (today) or
   canonicalize to 0/1 at ingress and make BOOLEAN purely logical? Comparison, JSON
   round-trip, and user-visible result values all observable.
3. **Ingress boundary inventory.** Where values enter typed positions: parameter binding
   (`Statement` bind/validate), literal construction in the planner, vtab `query()` rows
   (module contract — memory module vs. store vs. third-party), UDF return values,
   `lenientCast` outputs. For each: canonicalize there, or trust-and-guard? Third-party
   vtab modules cannot be trusted — decide whether the scan boundary coerces (per-row
   cost exactly where we're trying to remove it) or the module capability contract
   declares representation fidelity (like `scanSnapshotIsolation` — declared, defaulted
   to untrusted, guarded when undeclared).
4. **Enforcement.** A debug-mode representation assertion (à la `QUEREUS_FORK_STRICT`)
   that walks emitted rows/values and throws on a value whose JS type violates its
   declared type's representation — so drift is caught in tests, not by wrong results.
   Property tests: extend the insert/select round-trip and key-soundness suites to assert
   representation, not just value equality.
5. **Payoff accounting.** Which per-row branches each decision retires (list them:
   mixedBigIntArithmetic, numeric-fast bigint arms, compareSameType boolean arm,
   getStorageClass boolean/bigint lines), and which stay (ANY columns, TEXT/ANY probe
   paths) — so the implement tickets have measurable exit criteria.

## Constraints

- User-visible values (`eval` results, UDF arguments, vtab `update()` inputs) are API
  surface — any representation change there is breaking for embedders and must be called
  out explicitly, with the migration story, before implement tickets are cut.
- Cross-platform: bigint is universal in supported runtimes; no environment gate needed,
  but JSON serialization of bigint (structured results, sync layer) must be inventoried.
- This ticket produces design + implement tickets; it should not itself change runtime
  behavior.
