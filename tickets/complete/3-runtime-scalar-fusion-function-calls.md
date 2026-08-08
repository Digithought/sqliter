---
description: The expression fast path now also covers built-in and user-defined function calls like lower(name) or abs(x), which previously forced the whole surrounding expression onto the slower per-row path.
files:
  - packages/quereus/src/runtime/emit/scalar-function.ts      # buildScalarFunctionRun (new export) + thin default emitter
  - packages/quereus/src/runtime/scalar-fusion.ts             # ScalarFunctionCall arm, composeFused split out of fuseSpec
  - packages/quereus/src/runtime/emit/scalar-op.ts            # assertSpecArity NOTE (review: stale reference)
  - packages/quereus/src/runtime/emitters.ts                  # emitCallFromPlan docstring (review: stale decline list)
  - packages/quereus/src/schema/function.ts                   # ScalarFunctionSchema.isAsync
  - packages/quereus/src/func/registration.ts                 # ScalarFuncOptions.isAsync, threaded through createScalarFunction
  - packages/quereus/test/runtime/scalar-fusion.spec.ts       # 11 implement tests + 5 review tests + 5 parity tests
  - packages/quereus/test/runtime/representation-strict.spec.ts # async-UDF seam test now uses a declared `async` impl
  - packages/quereus/bench/fusion-slope.mjs                   # second ladder: lower(s) at two widths
  - docs/runtime.md                                           # "What makes a scalar function call fusable" + fusable-node list
  - docs/plugins.md                                           # "Asynchronous scalar functions"
  - docs/usage.md                                             # pointer from db.createScalarFunction to the async surface
---

# Fuse scalar function calls

## What shipped

`tryFuseScalar` (`runtime/scalar-fusion.ts`) previously declined any subtree containing a
scalar function call, and a decline is all-or-nothing up the tree — so one `lower(name)`
unfused the entire predicate around it. It now has a `ScalarFunctionCall` arm.

The design question was sync vs async. A fused node's contract is a plain `SqlValue`; a
`ScalarFunc` is typed `(...args) => MaybePromise<SqlValue>`. Rather than widen the fused
contract (which would put a promise check on every node in every chain), the arm decides
at **emit time**, in this order:

1. `functionSchema.customEmitter` set → never fuse (`nullif`, `greatest`, `least`,
   `json_schema`, `mutation_ordinal`).
2. `functionSchema.isAsync === true` → never fuse (new optional field; absent means
   synchronous).
3. `implementation instanceof AsyncFunction` → never fuse. Catches every declared
   `async function` / `async` arrow with no flag required.
4. Otherwise fuse, wrapping the body in a guard: if the implementation returns a
   `Promise` anyway, throw a `QuereusError` naming the function and the `isAsync` remedy.

The body is the new exported `buildScalarFunctionRun(plan)` (`emit/scalar-function.ts`) —
the emit-time arity assert, the `Function <name> failed: … (at line L, column C)`
wrapping, and the `REPR_STRICT` return check, resolved once.
`emitScalarFunctionCallDefault` is now a thin wrapper over it, so the fused and
instruction paths share one copy and cannot drift.

`fuseSpec` was split into `assertSpecArity` + `composeFused`, and `composeFused` (the
arity-specialized operand composition) is shared with the function-call arm. The
function-call body is variadic, so the assert stayed in `fuseSpec`. Variadic functions
(`coalesce`, `choose`) need no special case: composition switches on the call site's
`operands.length`.

## Behavior change

A non-`async` function that returns a Promise and declares no `isAsync` now throws on its
first fused call, where the sub-program path previously resolved it silently. Deliberate:
it converts a class of silent wrong answers (a Promise flowing on as a value and comparing
as garbage) into an actionable error naming the one-word fix. An `async` function or arrow
is unaffected.

## Review findings

Read the implement diff (`ac1bd7bb`) before the handoff, then read every file it touched
plus `emit/scalar-op.ts`, `emitters.ts`, `func/builtins/{scalar,json,mutation,conversion,
datetime}.ts`, `func/registration.ts`, `core/database.ts`'s registration surface,
`planner/rules/cache/rule-materialized-view-rewrite.ts` (the one in-tree synthetic scalar
function), and the three docs.

### Correctness — nothing found

Every route by which a fused call could diverge from its instruction form was traced and
closed:

- **The decision ladder is complete for what exists.** All five `customEmitter` scalar
  functions confirmed by grep (`json.ts`, `mutation.ts`, `scalar.ts` ×3), matching the
  ticket's list. No scalar implementation in `packages/quereus/src/func/builtins/` is async
  or promise-returning — grepping `async|Promise` across that directory returns nothing once
  the table-valued `async function*` generators are excluded. Re-checked the other packages:
  `quereus-sync` registers only a TVF; `sample-plugins` registers only synchronous scalars.
- **The one synthetic scalar function now fuses, safely.** `buildRecipeOutput`
  (`rule-materialized-view-rewrite.ts`) mints an `agg_combine` schema per plan wrapping
  `AggregateDecomposition.combine`, which is declared `(partialValues) => SqlValue` — no
  promise arm — and its `FunctionExpr` carries no `loc`, which the guard reads optionally.
- **`isAsync` survives registration.** `normalizeFunctionSchema` rebuilds schemas by spread,
  so the flag is not dropped on the `db.registerFunction(createScalarFunction(…))` path that
  `docs/usage.md` now points async authors at. Pinned by a parity test.
- **`mutation_ordinal` is the sharpest case and is correctly excluded.** It is zero-arg, so a
  fused compose would return its `implementation` *directly as the closure* — and that
  implementation exists only to throw. The `customEmitter` check is load-bearing here, and
  was unpinned; now tested.
- **Argument evaluation order matches.** Verified by side effect, not just call count, on
  both composition arms (fixed-arity and the array-and-spread arm).
- **The `instanceof Promise` guard not catching a non-`Promise` thenable is not a new gap** —
  confirmed the handoff's claim. `runtime/scheduler.ts` uses `instanceof Promise` at every
  await point, so a custom thenable was already unsupported on the sub-program path; both
  paths pass it through as an opaque value. No wider check warranted.
- **The `representation-strict.spec.ts` edit was the right call.** The test is named "an
  ASYNC implementation is checked on its resolved value"; `async () => 42` is what that name
  always meant, keeps the call on the instruction path (via step 3) so the promise arm under
  test is still the one exercised, and is the shape a real author writes. `isAsync: true`
  would have tested the flag rather than the seam. Separately confirmed the *fused* side of
  the `REPR_STRICT` return check is still covered: the sibling `bad_real` sync-UDF test now
  runs fused, and `yarn test:repr-strict` is green.

### Fixed in this pass (minor)

- **Stale decline list in `emitCallFromPlan`'s docstring** (`runtime/emitters.ts`). It still
  named "function calls" among what the compiler cannot prove pure and synchronous — the
  exact claim this ticket retired. The implement pass updated `docs/runtime.md` and
  `scalar-fusion.ts`'s own header but missed this one. Now reads "custom-emitter or
  asynchronous function calls".
- **Stale reference in `assertSpecArity`'s NOTE** (`emit/scalar-op.ts`). It named
  `emitScalarFunctionCallDefault` as "the one variadic scalar body"; after the refactor the
  variadic body is `buildScalarFunctionRun`, and the note now also says the fusion compiler
  composes it without this guard — the reason the assert stayed in `fuseSpec`.
- **`docs/runtime.md`'s fusable-node list omitted function calls**, and its "Every fused body
  is the node's own `ScalarOpSpec` body" claim had quietly become untrue (function calls use
  `buildScalarFunctionRun`, CASE uses `buildCaseMatcher` — neither is a `ScalarOpSpec`).
  Both corrected.

### Test coverage added (5 tests, 40 → 45 in the suite)

The implementer's suite was strong and honestly listed its own gaps. Every listed gap is now
closed, and none of them surfaced a divergence:

- **`mutation_ordinal` and `json_schema` decline** — the two custom-emitter functions the
  implement pass left unpinned, and the two with the worst failure mode if the check regresses
  (a throwing stub implementation; a pre-compiled constant schema argument).
- **Nested function calls** — `lower(lower(…(?)))`, the one shape where every frame in the
  chain is a call. Fuses, and the depth cap bites at exactly `MAX_FUSION_DEPTH + 1` nestings.
  The implement pass tested a call inside an *operator* chain only.
- **The json and datetime builtin families, fused vs unfused** — `json_type`,
  `json_extract`, `json_array_length`, `json_valid`, `json_quote`, `date`, `time`,
  `datetime`, `strftime`, `julianday`, over NULL-bearing rows plus a composed expression.
  These fuse now and were covered only implicitly by `.sqllogic`, with no parity assertion.
- **Function calls in every CASE position** — base, WHEN, THEN, ELSE. The implement pass
  covered a call in the CASE base only via a *decline*.
- **Argument evaluation order parity** — a recording UDF at 2 args (fixed-arity arm) and
  4 args (array-and-spread arm), asserting left-to-right and fused == unfused. Call *count*
  was pinned; order was not, and the two arms compose differently.

### Recorded as a tripwire, not a ticket

- **`instanceof AsyncFunction` is realm-local.** A plugin loaded into a different JS realm
  (worker, iframe, `node:vm`) carries that realm's `AsyncFunction.prototype`, so step 3 would
  miss its async implementation and it would fall to step 4's guard — a thrown error with the
  remedy, not a wrong answer. No loader in this repo crosses a realm (`plugin-loader` uses
  same-realm dynamic `import()`), so this is conditional. `NOTE:` at the `AsyncFunction`
  probe in `scalar-fusion.ts`, naming the realm-agnostic widening
  (`impl[Symbol.toStringTag] === 'AsyncFunction'`) if it ever bites.

### Appended to an existing ticket, not filed fresh

- **The guard's remedy is unreachable from `db.createScalarFunction`.** The error tells the
  author to set `isAsync: true`, an option only the low-level `createScalarFunction` factory
  exposes. Site-claim grep found `tickets/backlog/feat-udf-registration-surface-gaps.md`
  already owning `core/database.ts`'s registration surface, and its Arm B already proposes
  widening that callback to accept a promise. Appended the new constraint to Arm B (widening
  the callback must also provide a way to declare async, or treat every callback registered
  through the widened method as possibly-asynchronous) rather than filing a second ticket at
  the same site.

### Considered and left alone

- **The four-step decision ladder is written out three times** — the `fuseScalarFunctionCall`
  docstring, `docs/runtime.md`, `docs/plugins.md`. Not consolidated: the code comment states
  the rules where a maintainer edits them, `runtime.md` states them for an engine reader, and
  `plugins.md` states the *consequence* for a plugin author, in that audience's vocabulary.
  Each is the shortest form for its reader, and the surrounding files use exactly this
  density. `scalar-fusion.ts` is 311 lines, `emit/scalar-function.ts` 122 — neither is near
  a size that would force a split.
- **The `guarded` wrapper adds a closure frame per fused call, forever, to catch a
  misdeclaration.** Weighed and kept: it is one `instanceof` on a value that is virtually
  always a primitive, against the sub-program allocation it replaces, and removing it would
  reintroduce the silent-Promise-as-value failure the ticket exists to close.
- **Emit-time waste on a partial decline is larger in reach** — a declining subtree now also
  builds function-call bodies above the declining node, which the fallback rebuilds. The
  pre-existing `NOTE:` on `tryFuseScalar` already flags this and already names function-heavy
  expressions as the trigger condition, with the pre-walk fix. Not restated.

### No major findings

Nothing rose to a new `fix/`, `plan/`, or `backlog/` ticket. The one finding that wanted a
ticket already had one and became an arm on it; the one conditional concern became a
`NOTE:` at its site; the rest were fixed inline.

## Validation

| command | result |
| --- | --- |
| `yarn docs:check` | clean (links, invariants, size ratchet) |
| `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json` tsc) | clean, exit 0 |
| `yarn test` (all workspaces) | quereus **9155 passing / 25 pending / 0 failing** (up from 9150 — the 5 review tests); store 386, isolation 113, sync 725, sync-client 134, plugin-loader 63, quoomb-cli 34, quoomb-web 68, sample-plugins 1389, others green |
| `yarn test:repr-strict` (`QUEREUS_REPR_STRICT=1`) | **9164 passing / 16 pending / 0 failing** |

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written. Nothing
was skipped, disabled, or loosened.

## Measurement (from the implement stage, not re-run)

`bench/fusion-slope.mjs`, 1 vs 8 projections over 10k rows, median of 25, fused and unfused
in separate processes. Three paired runs, ns/row/expression:

| ladder | unfused | fused |
| --- | --- | --- |
| `lower(s)` | 990 / 1336 / 1147 | 319 / 65 / 132 |
| `n` (column ref, control) | 100 / 156 / 118 | 22 / 42 / 57 |

Direction is unambiguous and consistent across all three pairs; absolute magnitude is not
stable on this machine, so it is reported as a range rather than a speedup number. The
`yarn bench` execution suite showed run-to-run spread larger than any plausible fusion
effect (`bulk-insert-10k` 411.9 → 177.1 ms on the *same* build), and none of its queries
calls a scalar function in a hot per-row position — that noise is already tracked in
`backlog/debt-bench-per-instruction-scalar-cost`.
