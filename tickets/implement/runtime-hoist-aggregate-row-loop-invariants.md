---
description: The row-processing loops inside aggregation redo work on every row that could be done once per query, making grouped queries slower than they need to be.
files:
  - packages/quereus/src/runtime/emit/aggregate.ts            # stream aggregate — two row loops (~lines 161-186, 257-290)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts       # hash aggregate — two row loops (~lines 129-160, 225-260)
  - packages/quereus/src/runtime/emit/aggregate-setup.ts      # computeAggregateSkipCoercion — extend into per-aggregate transform closures
  - packages/quereus/src/util/coercion.ts                     # coerceForAggregate — the per-value call being hoisted (do NOT change its semantics)
  - packages/quereus/src/runtime/async-util.ts                # resolveMaybe — the hop-free sync-path helper to reuse
difficulty: easy
---

# Hoist emit-time-constant work out of the aggregate row loops

The stream and hash aggregate emitters each run a per-row, per-aggregate, per-argument
loop. Several operations inside those loops are loop-invariant — decidable once at emit
time — but currently execute per row:

1. **`funcNode instanceof AggregateFunctionCallNode`** narrowing plus the
   `quereusError(...)` INTERNAL throw, and **`funcNode.args || []`**. Both already run at
   emit time inside `bindAggregateSchemas` / `buildDistinctComparators`; the row loops
   repeat them per row purely to re-derive `args`. Hoist: capture per-aggregate
   `args.length` / arg metadata into the emit-time setup arrays.

2. **`coerceForAggregate(rawValue, functionName)`** — called per value; internally does
   `functionName.toUpperCase()`, a Set lookup, and `startsWith('JSON_')` on every call
   (`util/coercion.ts:103-114`). The function-name routing is fully static per call site.
   Extend `computeAggregateSkipCoercion` (or replace it) with a per-aggregate
   `valueTransform: ((v: SqlValue) => SqlValue) | undefined` — undefined when the call
   site skips coercion, otherwise a closure that applies only the value-level conversion
   (`typeof value === 'string' && trim !== '' → tryCoerceToNumber`). The row loop becomes
   `transform ? transform(raw) : raw`.

3. **`isAggregateFunctionSchema(schema)`** per row (and again in the finalize loops) —
   already validated once in `bindAggregateSchemas`, which throws INTERNAL on mismatch.
   Narrow the setup return type so the row loop needs no re-check.

4. **`await argFunctions[j](ctx)`** — an unconditional `await` per argument per row pays a
   microtask hop even when the compiled argument expression resolves synchronously (the
   common case). The filter emitter avoids exactly this with `resolveMaybe`
   (`runtime/async-util.ts`); the scheduler docs call the pattern out ("hop-free on the
   synchronous fast path"). Apply the same pattern to the aggregate argument loops:
   check `instanceof Promise`, only await genuinely-async results. Keep the code shape
   readable — a small shared helper for "evaluate N arg functions, sync-fast" used by all
   four loops is preferable to four hand-rolled copies.

**Semantics guard:** the *content* of the coercion decision (which functions coerce,
what a numeric string becomes) is claimed by the backlog ticket
`bug-text-coercion-in-arithmetic-and-aggregates` and must not change here. This ticket
only moves *when* the decision is computed (per value → per emit). Result sets must be
byte-identical before/after.

## Edge cases & interactions

- Aggregates with zero args (`count(*)`) — transform arrays must align by index with
  `plan.aggregates`; empty-arg aggregates skip the arg loop entirely.
- DISTINCT aggregates — the distinct-tree insert consumes the coerced value; ensure the
  transform is applied before the distinct check, as today.
- Custom/UDF aggregates registered with names starting `JSON_` — routing must match
  `coerceForAggregate`'s current behavior exactly (case-insensitive, prefix match).
- Window emitter shares `argComparisonContext` from aggregate-setup — do not break its
  import surface.
- An async argument expression (scalar subquery as aggregate arg) must still work — the
  resolveMaybe path covers it; add or confirm a logic test with a subquery-valued
  aggregate argument.

## TODO

- Extend aggregate-setup with per-aggregate arg metadata (count, arg functions) and
  per-aggregate value-transform closure; delete `computeAggregateSkipCoercion` if fully
  subsumed.
- Rewrite the four row loops (stream ×2, hash ×2) to use the hoisted metadata; remove
  per-row instanceof / isAggregateFunctionSchema checks.
- Apply resolveMaybe-style sync-fast evaluation to aggregate argument and GROUP BY key
  evaluation loops.
- `yarn test` in packages/quereus; confirm aggregate logic tests and window tests pass
  unchanged.
- Run `yarn bench` before/after on aggregate-heavy benchmarks; note delta in handoff
  (no strict threshold — this is a hygiene win, regression is the thing to rule out).
