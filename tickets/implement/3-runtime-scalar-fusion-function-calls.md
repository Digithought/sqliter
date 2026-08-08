---
description: Extend the expression fast-path so it also covers built-in function calls like lower(name) or abs(x), which today force the whole surrounding expression back onto the slow per-row path.
prereq: runtime-scalar-fusion-compiler
files:
  - packages/quereus/src/runtime/scalar-fusion.ts        # add the ScalarFunctionCallNode arm
  - packages/quereus/src/runtime/emit/scalar-function.ts # export the shared per-call body
  - packages/quereus/src/schema/function.ts              # ScalarFunctionSchema.isAsync
  - packages/quereus/src/func/registration.ts            # ScalarFuncOptions.isAsync
  - docs/runtime.md                                      # two-tier section: what makes a function fusable
  - docs/plugins.md                                      # plugin-facing: declaring an async scalar function
  - docs/usage.md                                        # scalar-function registration surface
difficulty: medium
---

# Fuse scalar function calls

## Why this is separate

The fusion compiler refuses any subtree containing a function call, and refusal is
all-or-nothing up the tree — so a single `lower(name)` unfuses the entire predicate it sits
in. Built-in scalar functions are everywhere (`lower`, `upper`, `substr`, `abs`, `length`,
`coalesce`, `round`, the `json_*` family, the datetime family), so this arm is where a
large share of real queries actually reach the fast path.

It is its own ticket because it carries a question the rest of the compiler does not: a
`ScalarFunc` is typed `(...args: SqlValue[]) => MaybePromise<SqlValue>`, and a fused node's
contract is a plain `SqlValue`.

## The sync/async decision

Accepting `MaybePromise` into the fused contract was considered and rejected: it would
infect every node in the chain with a promise check and a `.then` path, which is the
sub-program overhead this work exists to delete. Fused nodes stay strictly synchronous.

So a function call fuses only when it is provably synchronous, decided at emit time in
this order:

1. **`functionSchema.customEmitter` is set → never fuse.** A custom emitter builds its own
   `Instruction` — possibly with sub-programs or async behavior — and the fusion compiler
   cannot see inside it. Today that excludes `nullif`, `greatest`, `least`, `json_schema`
   and `mutation_ordinal`; giving custom emitters a fusion hook is parked in
   `backlog/feat-fuse-custom-emitter-scalar-functions`.
2. **`functionSchema.isAsync === true` → do not fuse.** New optional field, default absent
   (meaning synchronous). This is the author's explicit declaration.
3. **`implementation` is a declared `async` function → do not fuse.** Auto-detected with
   `implementation instanceof AsyncFunction` where
   `const AsyncFunction = (async () => {}).constructor`. An `async function` / `async` arrow
   has `AsyncFunction.prototype` on its chain, so this catches the ordinary async UDF with
   no flag required. It does **not** catch a non-`async` function that returns a promise —
   that is what step 4 is for.
4. **Otherwise fuse**, with a guard: if the implementation returns a `Promise` anyway, the
   fused body throws a `QuereusError` naming the function and telling the author to declare
   `isAsync: true` on its registration.

Step 4's guard is one `instanceof` per call — negligible next to the sub-program it
replaces — and it converts a silent wrong answer (a `Promise` flowing on as if it were a
value, comparing as garbage) into a loud, actionable error. It is a deliberate behavior
change for the narrow case of a promise-returning non-`async` UDF that declares nothing;
the error message carries the fix. No built-in scalar function is affected: every async
implementation in `func/builtins/` is a table-valued `async function*`, and every scalar
implementation is synchronous (verified by inspection during planning — re-verify, do not
take it on faith).

## Sharing the body

Do not restate the call logic. `emitScalarFunctionCallDefault` already resolves the
function name, asserts arity once at emit time, and builds a `run` that wraps
implementation errors in a `QuereusError` carrying the call's source location and applies
the `REPR_STRICT` return-type check. Export that body so both consumers use one copy:

```ts
/** The per-call body of a scalar function call, with its emit-time arity assert, error
 *  wrapping and REPR_STRICT return check resolved once. Returns MaybePromise because a
 *  registered implementation may be async; the fusion compiler admits only bodies it has
 *  proven synchronous and guards the remainder. */
export function buildScalarFunctionRun(
	plan: ScalarFunctionCallNode,
	ctx: EmissionContext,
): (rctx: RuntimeContext, ...args: SqlValue[]) => MaybePromise<SqlValue>;
```

`emitScalarFunctionCallDefault` becomes a thin wrapper around it (this is the emitter the
prereq ticket deliberately left unconverted). The fusion arm wraps the same body with the
promise guard and then composes operands by arity exactly as every other fused node does.
The implementation is invoked with a spread either way — that is inherent to a variadic
`ScalarFunc`, not something fusion adds.

Variadic functions (`numArgs === -1`, e.g. `coalesce`) use the compiler's general
array-and-spread arm; no special case.

## Schema and registration surface

- `ScalarFunctionSchema` gains `isAsync?: boolean` with a doc comment stating what it
  means, that omitting it declares the function synchronous, and that a synchronous
  declaration lets the engine fuse the call into a direct closure.
- `ScalarFuncOptions` in `func/registration.ts` gains the matching option, threaded through
  the schema-building helper alongside the existing `deterministic` / `replicable` flags.
- Document it for plugin authors wherever scalar-function registration is already described
  (`docs/plugins.md` and `docs/usage.md` both cover it — update whichever actually carries
  the registration surface, don't add a new doc), and add a line to the `docs/runtime.md`
  fusion section listing the four rules above.

## Edge cases & interactions

- **`coalesce` and other short-circuit-shaped builtins.** Check how each is registered
  before fusing: if a builtin relies on lazy argument evaluation, fusing it changes nothing
  (fusion evaluates operands eagerly *exactly as the instruction form already does* — the
  sub-program evaluates every param before the run), but confirm rather than assume, and
  say what you found in the handoff.
- **Volatile functions** (`random()`, and anything not marked deterministic) must be called
  the same number of times per row as before. A fused closure invokes its operands once per
  invocation, like the sub-program. Pin with a test that counts invocations of a registered
  test UDF across a filtered scan, fused and unfused.
- **A UDF that throws.** The error must still be `Function <name> failed: <message>` with
  the call's line/column, identical to the unfused path. Compare both with
  `runtime_fuse_scalars = false`.
- **`REPR_STRICT`.** Scalar function returns are its main seam. Run the suite once with
  `QUEREUS_REPR_STRICT` on and confirm violations are still reported against "the return
  value of function X", not swallowed or re-labelled.
- **The promise guard.** Add a test that registers a non-`async` function returning a
  resolved promise without `isAsync`, and asserts the thrown error names the function and
  the `isAsync` remedy. Add a second registering the same implementation *with*
  `isAsync: true` and asserting it still works (unfused).
- **Auto-detection.** Register an `async` UDF with no flag and assert it works unchanged —
  that is the case step 3 exists to protect.
- **Custom emitters.** Assert `nullif` / `greatest` / `least` still take their custom path
  and produce identical results, and that a predicate containing one simply does not fuse.
- **`scheduler_program()` output stays unfused** (the prereq ticket's plumbing), so the
  function-note assertions in `test/logic/06.5.4-declared-return-type-builtins.sqllogic`
  must remain green without edits.
- **Depth accounting.** A function call's arguments count toward `MAX_FUSION_DEPTH` like any
  other operand.

## Measurement

Re-run the isolated projection-ladder measurement from the prereq ticket with a
function-bearing shape (`select lower(s) from t` at two widths) and report the per-expression
slope fused vs unfused, in separate processes. Re-run `yarn bench` and report the execution
suite delta. State the method; do not quote a speedup you did not measure.

## TODO

- Export `buildScalarFunctionRun` from `emit/scalar-function.ts`; rewrite
  `emitScalarFunctionCallDefault` as a thin wrapper over it.
- Add `isAsync` to `ScalarFunctionSchema` and `ScalarFuncOptions`, threaded through
  registration.
- Add the `ScalarFunctionCallNode` arm to `tryFuseScalar` with the four-step decision and
  the returned-promise guard.
- Re-verify by inspection that no built-in scalar implementation is async; record the result.
- Tests: volatile-call-count parity, error-message parity, promise guard, `isAsync`
  declaration, `async`-implementation auto-detection, custom-emitter builtins unchanged.
- Document in `docs/runtime.md` and `docs/usage.md`.
- Run `yarn lint`, `yarn typecheck`, `yarn test` (plus one `QUEREUS_REPR_STRICT` pass);
  record counts. Run the benchmarks and record the numbers.
