---
description: The expression fast path now also covers built-in and user-defined function calls like lower(name) or abs(x), which previously forced the whole surrounding expression onto the slower per-row path.
files:
  - packages/quereus/src/runtime/emit/scalar-function.ts      # buildScalarFunctionRun (new export) + thin default emitter
  - packages/quereus/src/runtime/scalar-fusion.ts             # ScalarFunctionCall arm, composeFused split out of fuseSpec
  - packages/quereus/src/schema/function.ts                   # ScalarFunctionSchema.isAsync
  - packages/quereus/src/func/registration.ts                 # ScalarFuncOptions.isAsync, threaded through createScalarFunction
  - packages/quereus/test/runtime/scalar-fusion.spec.ts       # 11 new unit tests + 5 new parity tests
  - packages/quereus/test/runtime/representation-strict.spec.ts # async-UDF seam test now uses a declared `async` impl
  - packages/quereus/bench/fusion-slope.mjs                   # second ladder: lower(s) at two widths
  - docs/runtime.md                                           # new "What makes a scalar function call fusable" subsection
  - docs/plugins.md                                           # new "Asynchronous scalar functions" subsection
  - docs/usage.md                                             # pointer from db.createScalarFunction to the async surface
difficulty: medium
---

# Review: fuse scalar function calls

## What landed

`tryFuseScalar` (`runtime/scalar-fusion.ts`) previously declined any subtree containing a
scalar function call, and a decline is all-or-nothing up the tree — so one `lower(name)`
unfused the entire predicate around it. It now has a `ScalarFunctionCall` arm.

The whole design question was sync vs async. A fused node's contract is a plain
`SqlValue`; a `ScalarFunc` is typed `(...args) => MaybePromise<SqlValue>`. Rather than
widen the fused contract (which would put a promise check on every node in every chain),
the arm decides at **emit time**, in this order:

1. `functionSchema.customEmitter` set → never fuse. It builds its own `Instruction` and
   the compiler cannot see inside it. That is `nullif`, `greatest`, `least`,
   `json_schema`, `mutation_ordinal`.
2. `functionSchema.isAsync === true` → never fuse (new optional field; absent means
   synchronous).
3. `implementation instanceof AsyncFunction` → never fuse. Catches every declared
   `async function` / `async` arrow with no flag required.
4. Otherwise fuse, wrapping the body in a guard: if the implementation returns a
   `Promise` anyway, throw a `QuereusError` naming the function and the `isAsync` remedy.

The body itself is the new exported `buildScalarFunctionRun(plan)`
(`emit/scalar-function.ts`) — the emit-time arity assert, the
`Function <name> failed: … (at line L, column C)` wrapping, and the `REPR_STRICT` return
check, resolved once. `emitScalarFunctionCallDefault` is now a thin wrapper over it, so
the fused and instruction paths share one copy and cannot drift.

`fuseSpec` was split: `fuseSpec` = `assertSpecArity` + `composeFused`, and `composeFused`
(the arity-specialized operand composition) is now shared with the function-call arm.
The function-call body is variadic, so it has no fixed parameter count to assert — which
is why the assert stayed in `fuseSpec` rather than moving down. Variadic functions
(`coalesce`, `choose`) need no special case: the composition switches on the call site's
`operands.length`, so a 2-arg site takes the fixed `case 2` arm and a 5-arg site takes
the array-and-spread arm.

## Behavior change to be aware of

**A non-`async` function that returns a Promise and declares no `isAsync` now throws on
its first fused call.** Previously the sub-program path resolved it silently. This is
deliberate — it converts a class of silent wrong answers (a Promise flowing on as a
value and comparing as garbage) into an actionable error — and the error message carries
the one-word fix. An `async` function or arrow is unaffected (step 3 auto-detects it).

This is not hypothetical: it caught one in-tree test.
`test/runtime/representation-strict.spec.ts` registered its "ASYNC implementation" seam
test as `() => Promise.resolve(42)` — promise-returning but not declared `async`. It now
uses `async () => 42`, which is what the test name always meant and which additionally
exercises the step-3 auto-detection. **Reviewer: check this was the right call** rather
than, say, adding `isAsync: true` there — either would pass; the `async` form was chosen
because it is the shape a real author writes.

## Verification requested / things to poke at

- **The guard's `instanceof Promise`** does not catch a non-`Promise` thenable. That is
  consistent with the rest of the engine — `runtime/scheduler.ts` uses `instanceof
  Promise` at all six of its await points — so a custom thenable was already unsupported;
  this adds no new gap. Confirm you agree it needs no wider check.
- **`AsyncFunction` detection is prototype-chain based**, so it does NOT see a
  `.bind()`ed or otherwise wrapped async function. That is by design — step 4's guard is
  the safety net for exactly those — but it means the failure mode for a wrapped async
  UDF moved from "works" to "throws with a fix-it message". Documented in
  `docs/plugins.md`.
- **`buildScalarFunctionRun` takes only `plan`**, not the `(plan, ctx)` the ticket's
  sketch showed. Nothing in the body needs the emission context, and an unused parameter
  would trip the repo's no-unused-args rule. Trivial to add back if a future consumer
  needs it.
- **`Database.createScalarFunction` did not get `isAsync`.** Its callback parameter is
  typed synchronous (`(...args: SqlValue[]) => SqlValue`), so an async implementation
  cannot be registered through it at all — declaring `isAsync` there would be
  contradictory. Async registration goes through `db.registerFunction(createScalarFunction(…))`,
  which is the path plugins already take. `docs/usage.md` now says so. (The broader gap
  is already tracked in `backlog/feat-udf-registration-surface-gaps`.)
- **Emit-time waste on decline is unchanged in kind but larger in reach:** a subtree that
  declines partway has already built every spec (and now every function-call body) above
  the declining node, which the fallback `emitPlanNode` then rebuilds. The existing
  `NOTE:` at the top of `scalar-fusion.ts` already flags this and names function-heavy
  expressions as the trigger condition; no new note added.

## Ticket checklist items, and what was found

- **Short-circuit-shaped builtins.** Checked rather than assumed. `coalesce` (`numArgs
  -1`), `iif` (`numArgs 3`) and `choose` (`numArgs -1`) are all registered with plain
  eager implementations that receive already-evaluated arguments
  (`func/builtins/scalar.ts`). None relies on lazy argument evaluation — the instruction
  path already evaluated every param before the run, and fusion does the same. Fusing
  them changes nothing observable.
- **No built-in scalar implementation is async** — re-verified, not taken on faith. Every
  `async` in `packages/quereus/src/func/builtins/` is an `async function*` belonging to a
  table-valued function (`explain.ts`, `generation.ts`, `json-tvf.ts`, `schema.ts`,
  `string.ts`'s `split`). Every scalar implementation is synchronous. Also checked
  `packages/sample-plugins/*` — no async scalar functions there either.
- **`scheduler_program()` stays unfused** — unchanged plumbing from the prereq ticket.
  `test/logic/06.5.4-declared-return-type-builtins.sqllogic` passes with no edits.

## Test coverage (this is a floor, not a ceiling)

`test/runtime/scalar-fusion.spec.ts`, unit level:

- a synchronous call fuses and evaluates (`lower(?)`)
- `nullif` / `greatest` / `least` decline (custom emitter), and a `BinaryOp` containing
  one declines whole
- an `async` implementation declines (auto-detection)
- an `isAsync: true` implementation declines
- variadic `coalesce` fuses at 2 args (fixed arm) and at 5 args (array arm)
- a zero-arg call (`random()`) fuses to the body itself
- a function argument counts toward `MAX_FUSION_DEPTH` — pinned on both sides of the cap
- the pre-existing "simple CASE whose base cannot fuse" test now uses `nullif` as its
  unfusable base (it used `lower`, which fuses now)

End-to-end fused-vs-unfused parity (two `Database`s, one with
`runtime_fuse_scalars = false`):

- a 12-column sweep of built-ins over NULL-bearing rows: `lower`, `upper`, `substr`,
  `abs`, `length`, `coalesce`, `round`, `nullif`, `greatest`, `least`, a nested
  `lower(s) || cast(abs(n) as text)`, and a CASE over `lower`/`upper`
- **volatile call-count parity**: a registered non-deterministic counting UDF in a filter
  over a 5-row scan — asserts exactly 5 invocations AND that fused equals unfused
- **error parity**: a throwing UDF produces the identical message *and* line/column in
  both modes (`Function kaboom failed: nope (at line 1, column 8)`)
- an auto-detected `async` UDF answers identically in both modes
- an `isAsync: true` promise-returning UDF answers identically in both modes
- the promise guard: an undeclared promise-returning UDF throws naming itself and
  `isAsync: true` when fused, while the unfused mode still resolves it

**Known gaps in the tests** — worth an adversarial pass:

- No test covers the `json_*` or datetime builtin families end-to-end under fusion. They
  are ordinary synchronous scalar functions with no custom emitter, so they now fuse, and
  they are covered by the existing `.sqllogic` suites (which run fused by default and
  pass) — but there is no explicit fused/unfused parity assertion for them.
- No test asserts that `mutation_ordinal` / `json_schema` decline; only the three
  comparison builtins are pinned by name.
- The depth test uses a `||` chain around `lower(?)`; it does not test a function call
  *nested inside another function call* at the depth boundary.
- Nothing tests a function call inside a fused CASE branch specifically (only inside a
  CASE base, via the decline test).

## Commands run and counts

| command | result |
| --- | --- |
| `yarn lint` (all workspaces) | clean |
| `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) | clean |
| `tsc -p tsconfig.json --noEmit`, `tsc -p tsconfig.test.json --noEmit` | clean |
| `yarn build` | clean |
| `yarn test` (all workspaces) | quereus **9150 passing / 25 pending / 0 failing**; store 386, isolation 113, sync 725, sync-client 134, plugin-loader 63, quoomb-cli 59, quoomb-web 68, others green |
| `yarn test:repr-strict` (`QUEREUS_REPR_STRICT=1`) | **9159 passing / 16 pending / 0 failing** |

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

The one failure seen during the run was caused by this change (the
`representation-strict` async-UDF seam described above) and was fixed, not skipped.

## Measurement

**Isolated projection ladder** — `bench/fusion-slope.mjs`, extended with a second ladder.
Times 1 projection vs 8 copies over a 10k-row memory table, median of 25 iterations after
5 warmups, with `runtime_fuse_scalars` taken from argv so the two modes run in **separate
processes**. Slope = (wide − narrow) / 7 extra expressions / 10k rows.

Three paired runs, `ns/row/expression`:

| ladder | unfused | fused |
| --- | --- | --- |
| `lower(s)` | 990 / 1336 / 1147 | **319 / 65 / 132** |
| `n` (column ref, prereq's shape, as control) | 100 / 156 / 118 | **22 / 42 / 57** |

Direction is unambiguous and consistent across all three pairs; the absolute magnitude is
not stable on this machine (the fused `lower(s)` slope ranged 65–319 ns). Reported as a
range rather than a single speedup number, because a single number here would be
fiction.

**`yarn bench` execution-suite delta: not measurable on this machine.** Two consecutive
runs of the *same* build differed by more than any plausible fusion effect —
`group-by-10k` 85.4 → 219.9 ms, `correlated-subquery` 123.7 → 53.6 ms, `bulk-insert-10k`
411.9 → 177.1 ms. The four archived runs at commit `81e6dd25` show the same spread
(`full-scan-10k` 14.1–64.0 ms). Both post-change runs are in
`packages/quereus/bench/results/` if a reviewer on a quieter machine wants to re-measure;
note the `commit` field in those files records HEAD, not the uncommitted working tree.

None of the bench suite's queries call a scalar function in a hot per-row position, so
even a clean run would be expected to show roughly nothing for this ticket — the slope
ladder is the measurement that targets the change.
