---
description: Several scalar operators re-decide things on every row — which logical operator they are, whether their input could be a date, how many arguments a function takes — that are already known when the query is compiled.
files:
  - packages/quereus/src/runtime/emit/binary.ts          # emitLogicalOp — per-row operator switch; emitNumericOp — try/catch on the number-only path
  - packages/quereus/src/runtime/emit/unary.ts           # no type specialization at all — every op probes value shape per row
  - packages/quereus/src/runtime/emit/scalar-function.ts # per-call arity validation; duplicate isScalarFunctionSchema check
  - docs/architecture.md                                 # stale line: lists src/runtime/functions/ which does not exist
difficulty: easy
---

# Move static decisions out of scalar operator run functions

Follow-up to the branch-reduction analysis of the runtime. The binary comparison and
arithmetic emitters already specialize their run function at emit time from plan-time
logical types (`numeric-fast` / `compare-fast` / `temporal` paths in `emit/binary.ts`).
Four sites have not caught up:

## 1. Logical AND/OR/XOR switch on the operator string per row

`emitLogicalOp`'s `combineLogical` closure contains `switch (operator)` — evaluated on
every row, in both the eager path and the short-circuit path. `buildCmpToResult` in the
same file is the established fix pattern: select a per-operator combine function once at
emit time. Keep ONE source of truth for the 3-valued-logic tables — the parity tests in
`test/and-or-short-circuit.spec.ts` guard eager/deferred agreement and must keep passing.

## 2. Unary operators ignore plan-time types entirely

`emitUnaryOp` picks its run function by operator only. For `-` the run probes
`startsWith('P')` + a try/catch `Temporal.Duration.from` parse on **every string operand,
every row**, then walks a typeof chain. Mirror the binary emitter's split:

- Operand logical type numeric → direct negation (`number` / `bigint` arms only), note
  `-(numeric-fast)`.
- Operand type TIMESPAN → duration negate only.
- Otherwise → today's generic probe path, unchanged.

Same treatment for `+` (numeric → identity) and `~` (numeric → skip Number() conversion
attempt). The IS NULL / IS TRUE family and NOT are already minimal — leave them.

## 3. Scalar UDF call: dead per-call arity check, duplicate schema check

`emitScalarFunctionCallDefault`'s run validates `args.length !== numArgs` per call. The
planner resolved the schema by arity; the emitter's param list is built from
`plan.operands`, so the check can only fire on an emitter bug — assert at emit time
instead (compare `plan.operands.length` against `numArgs` once, throw INTERNAL there) and
drop the branch from the run. Also: `isScalarFunctionSchema` runs in both
`emitScalarFunctionCall` and `emitScalarFunctionCallDefault` — keep one (the entry point;
the exported default can assume a validated schema, note it in its doc comment).

## 4. try/catch on the number-only arithmetic arm

In `emitNumericOp`, the `inner(v1 as number, v2 as number)` call cannot throw for plain
numbers (division by zero yields Infinity, caught by the `Number.isFinite` check); the
try/catch is only needed on the bigint arm (`innerBigInt` throws on `0n` division —
already handled inside `mixedBigIntArithmetic`). Remove the try/catch from the
number-only branch of `runNumericOnly` / the generic path's number arm. Verify with the
existing arithmetic logic tests plus `1/0`, `1%0`, bigint `1/0` cases.

## Also: fix doc drift

`docs/architecture.md` source-layout tree lists `runtime/functions/ # Runtime function
dispatch` — the directory does not exist. Remove or correct the line.

## Edge cases & interactions

- Unary `-` on an ANY-typed or TEXT-typed operand must keep today's duration-then-numeric
  probe behavior — only statically-typed numeric/timespan operands take the fast paths.
- Unary `-` on a bigint at `-(2^63)`-scale values: pure `-operand` on bigint is total; no
  overflow concern in JS bigint.
- XOR has no short-circuit form — confirm the eager path selection still covers it after
  the combine refactor.
- The short-circuit deferred path (`runShortCircuit`) shares the combine with the eager
  path today by construction; after hoisting, both must consume the same per-operator
  function object so they cannot drift (the spec tests assert behavioral parity, keep them
  green).
- `least`/`greatest`/`nullif` route through operand-comparator, not these paths — out of
  scope.

## TODO

- Hoist per-operator combine in emitLogicalOp (eager + short-circuit paths share it).
- Type-specialize emitUnaryOp for `-`, `+`, `~` on numeric and TIMESPAN operand types;
  generic path unchanged for everything else.
- Emit-time arity assert + single schema check in scalar-function.ts; remove per-call
  branch.
- Trim try/catch from number-only arithmetic arms; keep bigint arms guarded.
- Fix `docs/architecture.md` runtime layout line.
- `yarn test` in packages/quereus; unary/arithmetic/logical logic tests plus
  `test/and-or-short-circuit.spec.ts` must pass unchanged.
