description: Sped up grouped/aggregate SQL queries (SUM, COUNT, GROUP BY, etc.) by moving repeated per-row setup work in the query engine so it happens once per query instead of once per row.
files:
  - packages/quereus/src/runtime/emit/aggregate-setup.ts      # bindAggregateSchemas (now returns argCounts, narrowed AggregateFunctionSchema[]), computeAggregateValueTransforms (replaces computeAggregateSkipCoercion), new evalArgsSync helper
  - packages/quereus/src/runtime/emit/aggregate.ts             # stream aggregate — both row loops (no-GROUP-BY, GROUP BY) and both finalize loops rewritten
  - packages/quereus/src/runtime/emit/hash-aggregate.ts        # hash aggregate — same treatment, plus GROUP BY key evaluation in the build phase
  - packages/quereus/src/util/coercion.ts                      # coerceForAggregate — untouched; row loops no longer call it directly (see below)
  - packages/quereus/src/runtime/async-util.ts                 # resolveMaybe — reused by the new evalArgsSync helper
difficulty: easy
---

# What changed

The stream and hash aggregate emitters (`runtime/emit/aggregate.ts`,
`runtime/emit/hash-aggregate.ts`) each ran a per-row, per-aggregate loop that repeated
several checks and allocations that are actually constant for the life of one query
plan. All four of these were hoisted to emit time, into `runtime/emit/aggregate-setup.ts`:

1. **`funcNode instanceof AggregateFunctionCallNode` narrowing + INTERNAL throw +
   `funcNode.args || []`** — was re-derived every row, every aggregate, in five separate
   loops across the two files (arg-offset slicing, the step loop, the GROUP BY
   pre-evaluation loop, twice more in hash-aggregate's build phase). `bindAggregateSchemas`
   now also returns `argCounts: number[]`, computed once; every row loop indexes into
   `aggregateArgFunctions[i]` (already correctly sized) instead of re-checking the node
   type.

2. **`coerceForAggregate(rawValue, functionName)`** — previously called per value, doing
   `functionName.toUpperCase()` + Set lookup + `startsWith('JSON_')` every time.
   `computeAggregateSkipCoercion` (boolean array) is replaced by
   `computeAggregateValueTransforms`, which returns one
   `((value: SqlValue) => SqlValue) | undefined` closure per aggregate — `undefined` when
   the call site never coerces (decided once, at emit time), otherwise a closure that does
   only the value-level `string → number` conversion. Row loops became
   `transform ? transform(raw) : raw`. **`coerceForAggregate` itself is unchanged** — it's
   just no longer called from the hot path; the closure inlines the identical logic.

3. **`isAggregateFunctionSchema(schema)`** re-checked per row and again in every finalize
   loop, even though `bindAggregateSchemas` already validates this once (throwing
   INTERNAL on mismatch). `bindAggregateSchemas`'s return type is now
   `AggregateFunctionSchema[]` (narrowed from `FunctionSchema[]`), so
   `schema.stepFunction` / `schema.finalizeFunction` / `schema.initialValue` are used
   directly everywhere — no per-row guard, no dead `else` branch.

4. **`await argFunctions[j](ctx)`** — an unconditional `await` per argument per row pays a
   microtask hop even when the underlying sub-program resolves synchronously (the common
   case — same rationale as `resolveMaybe`, `runtime/async-util.ts`, already used by the
   filter emitter). New shared helper `evalArgsSync(rctx, fns, transform?)` in
   `aggregate-setup.ts` evaluates N argument closures against one row context, branching
   on `instanceof Promise` per argument and only awaiting the genuinely-async ones. It's
   used in all four aggregate-argument row loops **and** the GROUP BY key evaluation loop
   in both emitters (the ticket's edge-case note called this out explicitly).

**Semantics are unchanged by construction**: `computeAggregateValueTransforms`'s closure
body is a direct transcription of `coerceForAggregate`'s post-routing logic
(`typeof value === 'string' && value.trim() !== '' ? tryCoerceToNumber(value) : value`),
and the skip decision (COUNT/GROUP_CONCAT/JSON_*, all-numeric args, all-semantic-ordering
args) is byte-for-byte the same predicate `computeAggregateSkipCoercion` used. This was
the one thing the ticket explicitly forbade changing — the "which functions coerce"
question stays with backlog ticket `bug-text-coercion-in-arithmetic-and-aggregates`,
untouched here.

# How to validate

- `yarn test` in `packages/quereus` — 9030 passing, 16 pending, unchanged from
  pre-change baseline (I ran the full suite both before and after; identical counts, no
  new failures). This includes the aggregate/window/GROUP BY logic tests
  (`test/logic/*.sqllogic`) and `06.5.3-undeclared-return-type-comparison.sqllogic`,
  which specifically pins the "ANY-typed argument no longer skips coerceForAggregate"
  behavior this change relocates but must not alter (§8 of that file:
  `select sum(strftime('%Y', d)) as s, avg(strftime('%Y', d)) as a from urt` →
  `{"s":4047,"a":2023.5}`).
- `yarn tsc -p tsconfig.test.json --noEmit` and `yarn lint` — both clean.
- Logic tests already exercise: zero-arg aggregates (`count(*)`), DISTINCT aggregates,
  multi-arg aggregates, an async-argument aggregate case (scalar-subquery-valued
  aggregate arg — grep `test/logic` for aggregate + subquery combinations if the
  reviewer wants to confirm the `evalArgsSync` async branch specifically; I did not add a
  new dedicated test for it since existing coverage already exists and result sets were
  confirmed byte-identical via the full suite run).
- Window emitter (`runtime/emit/window.ts`) imports only `argComparisonContext` from
  `aggregate-setup.ts`, not the removed `computeAggregateSkipCoercion` — its import
  surface is untouched, confirmed by grep and by the clean typecheck.

# Known gaps / things I did not do

- **No clean before/after benchmark numbers.** I ran `yarn bench` (aggregate-heavy
  `execution/group-by-10k`, `group-by-text-10k`, `distinct-text-10k` suites) before and
  after the change, twice each. The machine this ran on is too noisy right now to draw
  any conclusion: re-running the **identical built code** back-to-back with zero changes
  produced swings of +49% on `full-scan-10k`, +227% on `parser/insert-values`, and +150%
  on `planner/aggregate-plan` — benchmarks that don't even touch aggregation or this
  diff. Since the noise floor is larger than any plausible effect size of this change,
  I'm not reporting a bench delta as evidence either way. The correctness evidence (full
  test suite, unchanged pass count) and the structural argument (strictly fewer
  allocations, branches, and promise hops per row, same work, done once instead of N
  times) are what I'm relying on instead. If the reviewer has access to a quieter
  machine, `yarn build && yarn bench` in `packages/quereus` on `execution/group-by-10k`,
  `execution/group-by-text-10k`, `execution/distinct-text-10k` would be the three to
  watch.
- I did not add new unit tests for `evalArgsSync` or `computeAggregateValueTransforms`
  in isolation — they're covered indirectly through the full aggregate logic-test suite
  (byte-identical results before/after) rather than directly. A reviewer who wants direct
  unit coverage of the sync-fast/async-fallback branching in `evalArgsSync` would need to
  add it; I judged the existing indirect coverage (every aggregate logic test exercises
  the row loop that calls it) sufficient for a mechanical hoist with no behavior change,
  but flagging it as a gap rather than asserting it's unnecessary.
- I did not touch `window.ts`'s own partition/order-by value evaluation loops
  (`runtime/emit/window.ts:205,335,1070,1079`), which have the same
  `raw instanceof Promise ? await raw : raw` pattern inlined per-value already (not
  per-row-loop-invariant work, just the same async-hop-avoidance idiom) — out of scope
  for this ticket, which named only `aggregate.ts` / `hash-aggregate.ts`.
