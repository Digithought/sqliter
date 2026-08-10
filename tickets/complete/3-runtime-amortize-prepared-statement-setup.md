description: A prepared query now builds its execution machinery once and reuses it across runs, instead of rebuilding it and re-checking the whole schema on every run. Reviewed: caching is correct and does not leak stale state between runs.
prereq:
files: packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/runtime.md
difficulty: medium
----

## Summary of the work

A prepared `Statement` used to redo two things on every execution: (1) re-emit its
instruction tree and build a fresh `Scheduler`, and (2) re-validate every captured
schema object inside every capturing instruction's `run`. This work amortized both to
once (scheduler cached on the `Statement`; schema validation hoisted to one call per
execution), and fixed one regression the caching introduced (the impure-subquery
run-once memo moved off the emit-time closure onto the per-execution `RuntimeContext`).

Implementation landed in commit `3079aeae`. Review confirmed it correct and added the
cleanups below.

## Review findings

Adversarial pass over the implement diff, read before the handoff. Checked SPP/DRY,
resource cleanup, cache-invalidation completeness, the memo correctness invariant,
type safety, and metrics fidelity. Lint (eslint + `tsc -p tsconfig.test.json`), build,
and the full quereus suite (6889 passing / 13 pending) all green before and after the
review edits.

### Correctness — CONFIRMED sound, nothing to fix

- **Load-bearing invariant "one RuntimeContext per execution, threaded by identity,
  never forked in normal execution" — holds.** Traced the re-evaluation paths that
  could break the impure-subquery memo: `project.ts` and `filter.ts` invoke their
  per-row scalar callbacks as `fn(rctx)` → `program.run(rctx)`, passing the *same*
  `rctx` object every row (verified by reading the call sites, not just grepping for
  spreads). The impure subquery inner is emitted as a direct param, not a callback, so
  its `runImpure` receives the outer `rctx` directly. The only site that hands a
  distinct `RuntimeContext` is `ParallelDriver.fork()`, which has zero query consumers
  (dormant). So the memo (keyed by a per-emit-site `Symbol`, stored on
  `ctx.executionMemo`) dedups within one execution and resets between executions —
  DML fires exactly once per execution, matching the pre-cache contract.

- **Scheduler cache invalidation is complete.** Every site that nulls `plan` /
  `emissionContext` or sets `needsCompile = true` also nulls `this.scheduler` in
  lockstep: `nextStatement()`, the schema-change listener, and `finalize()`. Grepped
  all three predicates across `statement.ts` — no orphan site. `compile()` rebuilds the
  plan only when `needsCompile`, which is only set true at those same guarded sites, so
  a stale scheduler can never outlive its plan.

- **Schema-validation hoisting is behavior-equivalent.** Validating once at execution
  start (instead of before each capturing instruction) is safe because the exec mutex
  serializes external DDL — schema cannot change mid-execution — and intra-block DDL
  affecting a captured object fails at plan time. The lost per-instruction re-check
  guarded a scenario that is unreachable. Noted, not filed.

- **Metrics reset is complete.** `onStart` zeroes all four `InstructionRuntimeStats`
  fields (`in`, `out`, `elapsedNs`, `executions`); the top-level scheduler runs once
  per execution, so per-execution counts are exact (test 2 pins this).

### Minor — fixed in this pass

- **Dead field removed.** `createValidatedInstruction` stopped setting
  `Instruction.emissionContext`; grep confirmed nothing else sets or reads it. Removed
  the now-dead `emissionContext?: EmissionContext` field from the `Instruction` type
  and its now-unused import in `runtime/types.ts`. (`createValidatedInstruction`'s
  `_emissionCtx` param is intentionally retained, `_`-prefixed, to keep its six call
  sites untouched — left as-is.)

- **Missing regression test added.** Added an `IN(impure)` prepared-twice test to
  `prepared-statement-amortization.spec.ts` (the branch that was only covered
  transitively). Now 7 tests in that spec, all passing.

### Tripwire — recorded in code, not filed

- **Sub-program metrics reset per invocation.** A `emitCall` sub-program scheduler
  reruns once per outer row in a correlated re-eval, so its stats now reset per
  invocation, not per execution — its `onComplete` debug log reports the last
  invocation rather than a cumulative sum. Debug telemetry only; arguably more correct
  per-line. `NOTE:` added at the reset site in `scheduler.ts`. Revisit only if
  sub-program metrics ever feed a real decision.

- (Carried from implement, still valid) `trace_plan_stack` mid-life toggle ignored
  until recompile — `NOTE:` at the scheduler-cache site in `statement.ts`.
  `executionMemo` lazy-init vs. future in-fork impure subqueries — `NOTE:` at
  `ParallelDriver.fork()`.

### Known gaps left as floor (not filed — low value, conditional)

- Test 3 (drop captured table) exercises the recompile path; the
  `validateCapturedSchemaObjects()` throw backstop is race-only and preempted by the
  listener, so no direct test drives it. A direct `EmissionContext` unit test could pin
  it if that backstop is ever hardened.
- No test asserts the cached scheduler is shared between a traced and a plain run of the
  same statement. Reasoned safe (per-run `tracer`/`enableMetrics` go into `runtimeCtx`,
  not the scheduler build); not pinned.
- `getDebugProgram()` still emits its own throwaway scheduler (debug-only; left as-is).

## Docs

`docs/runtime.md` § impure subquery emitters was updated at implement time (memo now on
`ctx.executionMemo`); re-read and confirmed accurate against the final code.
