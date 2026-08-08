description: Sped up scalar SQL expressions (AND/OR/XOR, unary minus/plus/bitwise-NOT, function calls, arithmetic) by moving decisions the query planner already knows — which operator this is, whether a value could be a date, how many arguments a function takes — out of the per-row evaluation path and into a one-time setup step.
files:
  - packages/quereus/src/runtime/emit/binary.ts          # emitLogicalOp (hoisted AND/OR/XOR combine), emitNumericOp (trimmed try/catch on the number-only arm)
  - packages/quereus/src/runtime/emit/unary.ts            # emitUnaryOp — new numeric-fast / timespan-fast paths for -, +, ~
  - packages/quereus/src/runtime/emit/scalar-function.ts  # emitScalarFunctionCallDefault — emit-time arity assert, single schema-validity check
  - docs/architecture.md                                  # removed stale `runtime/functions/` line from the src-layout tree
difficulty: easy
---

# What changed

Four sites in the scalar-expression runtime re-decided per-row things that plan-time
type information (or the plan-node shape itself) already settles once. All four now
mirror the existing binary-comparison/arithmetic emitters' pattern of picking a
specialized `run` function (and, for logical ops, a specialized helper) at **emit**
time instead of dispatching on a string or probing a value's shape on every row.

1. **`emitLogicalOp` (binary.ts)** — `combineLogical`'s `switch (operator)` ran on
   every row in both the eager `run` and the deferred `runShortCircuit` path. Replaced
   with three module-level 3-valued-logic tables (`combineAnd`/`combineOr`/`combineXor`,
   typed `LogicalCombine`) and `selectLogicalCombine(operator, plan)`, called once per
   emit. `combineLogical` now just coerces truthiness and calls the pre-selected
   `combine` closure — still the single function both the eager and deferred paths
   share, so they cannot drift.

2. **`emitUnaryOp` (unary.ts)** — `-`, `+`, `~` each now branch at emit time on
   `plan.operand.getType().logicalType`:
   - `isNumeric` operand → direct arm (`-`: `typeof operand === 'bigint' ? -operand :
     -(operand as number)`; `+`: identity; `~`: bigint arm or
     `~Math.trunc(operand as number)`, skipping the `Number()` conversion). Notes:
     `-(numeric-fast)`, `+(numeric-fast)`, `~(numeric-fast)`.
   - `-` on an operand whose logical type is identically `TIMESPAN_TYPE` → duration
     negate only (`Temporal.Duration.from(operand).negated().toString()`, no try/catch —
     the type is statically known, so a parse failure is a genuine data-integrity bug,
     not a routine branch-selection miss). Note: `-(timespan)`.
   - Everything else (ANY, TEXT, mixed) → the original generic probe path, byte-for-byte
     unchanged (string-prefix duration probe with try/catch, then numeric fallback).
   `NOT` and the `IS [NOT] NULL/TRUE/FALSE` family were already minimal and are untouched.

3. **`emitScalarFunctionCallDefault` (scalar-function.ts)** — the per-call
   `args.length !== scalarFunction.numArgs` check is now a one-time emit-time assert
   comparing `plan.operands.length` against `numArgs` (throws `StatusCode.INTERNAL` —
   this can now only fire on an emitter bug, since the planner resolves the schema by
   arity and `plan.operands` is what the emitted param list is built from). Also
   dropped the duplicate `isScalarFunctionSchema` check inside this function —
   `emitScalarFunctionCall` (the only caller, directly or as the `defaultEmit` a
   `customEmitter` invokes) already validates it first. Doc comment on the exported
   function now states this precondition explicitly.

4. **`emitNumericOp`'s number-only arm (binary.ts)** — removed the try/catch around
   `inner(v1 as number, v2 as number)` in `runNumericOnly`. Plain-number arithmetic
   cannot throw (division/modulo by zero yield `Infinity`/`NaN`, already caught by the
   `Number.isFinite` check right after); only the bigint arm can throw, and that's
   still guarded (inside `mixedBigIntArithmetic`, untouched).

5. **Doc fix**: `docs/architecture.md`'s source-layout tree listed
   `runtime/functions/ # Runtime function dispatch`, a directory that does not exist
   (confirmed via `ls packages/quereus/src/runtime` — only `cache/` and `emit/` are
   subdirectories). Removed the line and fixed the tree's last-child connector.

# How to validate

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (no unused-arg/import fallout).
- Full suite: `node test-runner.mjs` in `packages/quereus` — **9043 passing, 16
  pending, 0 failing**, including `test/and-or-short-circuit.spec.ts` (the AND/OR
  parity suite the ticket named as a guard for item 1) and the sqllogic files that
  exercise the changed paths:
  - `test/logic/15-timespan.sqllogic` — `SELECT -timespan('PT1H')` /
    `-timespan('P1D')` exercise the new `-(timespan)` path directly (`timespan()`
    returns `TIMESPAN_TYPE`, confirmed via `func/builtins/conversion.ts:244`).
  - `test/logic/90-error_paths.sqllogic:66` — `SELECT 1 / 0` → `null`, exercises the
    trimmed-try/catch numeric-fast arithmetic path.
  - `test/logic/03-expressions.sqllogic` — `SELECT - -1` exercises nested unary
    minus on an INTEGER literal (numeric-fast path).
- I additionally ran a throwaway spec (not committed) directly asserting the exact
  edge cases the ticket called out, all returned the expected values:
  - `1/0`, `1%0` (number path) → `null`
  - `9223372036854775807/0`, `9223372036854775807%0` (bigint path, via
    `mixedBigIntArithmetic`, untouched by this change) → `null`
  - `-9223372036854775807` (unary minus, bigint numeric-fast) →
    `-9223372036854775807n`
  - `~9223372036854775807` (unary bitwise-NOT, bigint numeric-fast) →
    `-9223372036854775808n`
  - `~5` → `-6`, `+5` → `5`, `-5.5` → `-5.5` (int/real numeric-fast paths)

# Known gaps / things I did not do

- **No new dedicated unit tests were added.** All five changes are behavior-preserving
  refactors (move a decision from per-row to per-emit); I relied on the existing
  logic-test suite staying byte-identical (same 9043/16 pass/pending split before and
  after) plus the manual edge-case spot-check above, rather than adding tests that
  would just re-assert existing coverage. A reviewer who wants direct, permanent
  coverage of e.g. the `-(timespan)` fast path independent of `15-timespan.sqllogic`,
  or of the emit-time arity assert firing on a deliberately-broken custom emitter,
  would need to add it.
- **`emitScalarFunctionCall`'s `isScalarFunctionSchema` check is now load-bearing for
  more callers than before.** Every `customEmitter` that calls its `defaultEmit`
  parameter (currently only `json_schema`'s, in `func/builtins/json.ts`) relies on
  `emitScalarFunctionCall` having validated the schema *before* invoking the custom
  emitter — verified by reading the one call site, but there's no static guarantee a
  future `customEmitter` couldn't be invoked some other way and skip that check. If a
  new call path to `emitScalarFunctionCallDefault` is ever added outside
  `emitScalarFunctionCall`, it must re-validate `isScalarFunctionSchema` itself, or the
  new doc comment's precondition silently breaks.
- **Instruction `note` strings changed** for the specialized unary paths
  (`-(numeric-fast)`, `+(numeric-fast)`, `~(numeric-fast)`, `-(timespan)` replace the
  previous constant `unary -`/`unary +`/`bitwise ~` for the numeric/timespan cases —
  the generic-path notes are unchanged). No test asserted the old literal note text
  (grepped `test/` for `'unary -'`/`'unary +'`/`'bitwise ~'` — only AST/parser
  operator-string matches turned up, not instruction notes), so nothing broke, but any
  external tooling that snapshots `EXPLAIN`/debug-program output on unary expressions
  would see the new note text.
- Did not benchmark before/after — this ticket (like the sibling aggregate-hoist
  ticket landed just before it) is a structural argument (fewer allocations/branches
  per row, same work done once instead of N times) backed by correctness evidence, not
  a measured number. Flagging per the pattern the previous ticket in this series used.
