description: Sped up grouped/aggregate SQL queries (SUM, COUNT, GROUP BY, etc.) by moving repeated per-row setup work in the query engine so it happens once per query instead of once per row.
files:
  - packages/quereus/src/runtime/emit/aggregate-setup.ts       # shared emit-time setup; evalArgsSync, computeAggregateValueTransforms, emitAggregateArgInstructions
  - packages/quereus/src/runtime/emit/aggregate.ts             # stream aggregate row loops
  - packages/quereus/src/runtime/emit/hash-aggregate.ts        # hash aggregate row loops + build phase
  - packages/quereus/src/util/coercion.ts                      # aggregateCoercesArguments / coerceAggregateValue split out of coerceForAggregate
  - packages/quereus/test/runtime/aggregate-setup.spec.ts      # new unit coverage (added during review)
  - docs/runtime.md                                            # coercion-contexts section
difficulty: easy
---

# What shipped

The stream and hash aggregate emitters ran a per-row, per-aggregate loop repeating work
that is constant for the life of one query plan. That work now happens once, at emit
time, in the shared `runtime/emit/aggregate-setup.ts`:

- **Plan-node re-narrowing.** `funcNode instanceof AggregateFunctionCallNode` plus
  `funcNode.args || []` was re-derived every row in five loops across the two files.
  `bindAggregateSchemas` now also returns `argCounts`; row loops index the
  already-correctly-sized `aggregateArgFunctions[i]`.
- **Schema re-checking.** `isAggregateFunctionSchema(schema)` was re-tested per row and
  in every finalize loop, though `bindAggregateSchemas` already validates it once.
  Its return type narrowed to `AggregateFunctionSchema[]`, so `stepFunction` /
  `finalizeFunction` / `initialValue` are used directly — no per-row guard, no dead
  `else` branch.
- **Coercion routing.** `coerceForAggregate(value, functionName)` did an uppercase +
  Set lookup + `startsWith('JSON_')` per value. `computeAggregateValueTransforms`
  decides that once per call site, yielding either `undefined` (site never coerces) or
  the shared value-level transform. Which functions coerce is unchanged — that question
  stays with backlog `bug-text-coercion-in-arithmetic-and-aggregates`.
- **Microtask hops.** An unconditional `await` per argument per row cost a tick even
  when the sub-program resolved synchronously. `evalArgsSync` branches on
  `instanceof Promise` and only awaits genuinely-pending arguments. Used by all four
  aggregate-argument loops and both GROUP BY key-evaluation loops.

# Review findings

**Reviewed:** the implement diff (`6a9bb103`) read before the handoff summary; both
emitters end to end; `aggregate-setup.ts`; `util/coercion.ts`; the async-evaluation
idiom in the sibling emitters (`project.ts`, `filter.ts`, `async-util.ts`) and the
`RuntimeContext` sharing contract (`parallel-driver.ts`, `context-helpers.ts`); every
doc file naming the touched symbols.

## Major — fixed in this pass

- **`evalArgsSync` made sibling argument evaluation concurrent.** It invoked *all* N
  argument closures before awaiting any (`Promise.all`), so argument `j+1` started while
  `j` was still pending. Every other hot path in the runtime is strictly sequential —
  `project.ts:39-45` awaits each column before invoking the next, for the same reason —
  because sibling scalar sub-programs share one `RuntimeContext`: row slots
  (`createRowSlot` mutates `rctx.context`), per-scan connection caches and the
  once-per-execution memo all live on it, and the only supported way to run
  sub-programs concurrently is against **forked** contexts (`ParallelDriver.fork`).
  This contradicted the handoff's "semantics are unchanged by construction" claim: the
  hop-avoidance win needed no overlap at all. Rewritten to stay sequential — the sync
  fast path is unchanged, and the first pending argument hands off to an async tail that
  awaits the rest in order. Regression-guarded by a new test asserting the
  start/end interleaving (it fails against the pre-review implementation).

  *Not filed as a ticket* — the class ("sub-programs must not overlap on a shared
  context") already has a runtime-level home in `ParallelDriver`/`strict-fork.ts`; the
  fix plus the explanatory comment at the site is the appropriate rung.

## Minor — fixed in this pass

- **Coercion routing was duplicated, with drift risk.** `computeAggregateValueTransforms`
  transcribed the COUNT / GROUP_CONCAT / `JSON_*` predicate and the string→number
  conversion inline, while `coerceForAggregate` kept its own copy in `util/coercion.ts`
  (whose `NON_NUMERIC_AGGREGATES` set no longer had a single reader). A future change to
  one would silently not reach the other. Split `coercion.ts` into
  `aggregateCoercesArguments(functionName)` and `coerceAggregateValue(value)`;
  `coerceForAggregate` is now their composition and the emitter path calls the same two.
  One home, as `docs/runtime.md` § Implementation Guidelines requires.
- **Dead branch inverted the old behavior.** `computeAggregateValueTransforms` returned
  `undefined` (= no coercion) for a non-`AggregateFunctionCallNode`, where the old
  `computeAggregateSkipCoercion` returned `false` (= coerce). Unreachable —
  `bindAggregateSchemas` throws INTERNAL on that shape — but silently wrong if it ever
  became reachable. Now routed through the existing `requireAggregateCall` guard, which
  also drops the branch entirely.
- **A fresh identical closure was allocated per aggregate.** The transform captured
  nothing; it is now one shared module-level function.
- **~14 lines of emit-time argument-instruction building were duplicated verbatim**
  between `aggregate.ts` and `hash-aggregate.ts` — exactly what `aggregate-setup.ts`
  exists to hold. Extracted as `emitAggregateArgInstructions`; three now-unused imports
  dropped from each emitter.
- **Docs were stale.** `docs/runtime.md` § Coercion Contexts still described
  `coerceForAggregate(rawValue, functionName)` as called per row before the step
  function, and its Implementation Guidelines told emitter authors to do exactly that —
  both now describe the emit-time transform. The `NOTE:` in `coercion.ts` referenced
  `computeAggregateSkipCoercion`, a symbol the implement pass deleted; retargeted, and
  its `bug-text-minmax-numeric-coercion` tracking reference preserved.
  `docs/plugins.md:1275` lists `coerceForAggregate` as a public export — still accurate,
  the export is unchanged and no new names were added to `index.ts`.

## Test coverage — gap closed

The handoff flagged that `evalArgsSync` and `computeAggregateValueTransforms` had no
direct unit coverage, only indirect coverage through the aggregate logic tests. Added
`test/runtime/aggregate-setup.spec.ts` (13 tests): sync fast path returns a non-promise,
zero-argument aggregates, context propagation, transform application on both the sync and
async sides of the first pending argument, order preservation when a later argument
resolves first, **strict sequencing**, no evaluation after a rejection, and synchronous
throws propagating unwrapped — plus the coercion split (routing per function name, value
conversion, and that the two compose back into `coerceForAggregate`).

`computeAggregateValueTransforms` still has no direct unit test: constructing the
`AggregateFunctionCallNode` plan shapes it takes costs far more than it proves, and its
two decisions are now each covered — the function-name routing directly (above), the
type-based skip through the existing logic tests, notably
`test/logic/06.5.3-undeclared-return-type-comparison.sqllogic` §8.

## Tripwires — none

Nothing found that is fine now and only becomes work under a future condition. The one
candidate — the concurrency change — is a defect the moment an aggregate argument is
genuinely async, not a conditional concern, so it was fixed rather than parked.

## New tickets filed — none

Both categories of finding resolved at their site inside this pass. Nothing surfaced
that needs its own ticket, and no accepted-tradeoff `NOTE:` at any touched site had its
revisit condition trip. The pre-existing `bug-text-minmax-numeric-coercion` and
`bug-text-coercion-in-arithmetic-and-aggregates` decisions about *which* aggregates
coerce were deliberately left untouched, as the original ticket required.

# Validation

- `yarn test` (workspace) — green, exit 0.
- `yarn workspace @quereus/quereus run test` — **9043 passing, 16 pending**
  (9030/16 baseline + the 13 new unit tests; no other count moved).
- `yarn lint` — clean across all packages (includes the `tsconfig.test.json` type pass).
- `yarn tsc -p tsconfig.test.json --noEmit` — clean.

**No benchmark numbers, same as the implement pass.** The implementer documented that
re-running identical built code back to back swung ±50–227% on benchmarks that don't
touch aggregation, so the noise floor exceeds any plausible effect size on this machine;
that is unchanged, and I did not re-run `yarn bench`. The evidence for this change is
the unchanged test results plus the structural argument (strictly fewer allocations,
branches and promise hops per row). If anyone wants a real number on a quiet machine,
`yarn build && yarn bench` on `execution/group-by-10k`, `execution/group-by-text-10k`
and `execution/distinct-text-10k` are the suites to watch.
