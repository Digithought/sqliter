description: Sped up scalar SQL expressions (AND/OR/XOR, unary minus/plus/bitwise-NOT, function calls, arithmetic) by moving decisions the query planner already knows — which operator this is, whether a value could be a date, how many arguments a function takes — out of the per-row evaluation path and into a one-time setup step.
files:
  - packages/quereus/src/runtime/emit/binary.ts          # emitLogicalOp (hoisted combine + short-circuit decision), emitNumericOp (trimmed try/catch)
  - packages/quereus/src/runtime/emit/unary.ts            # emitUnaryOp — numeric-fast / timespan-fast paths for -, +, ~
  - packages/quereus/src/runtime/emit/scalar-function.ts  # emitScalarFunctionCallDefault — emit-time arity assert, single schema-validity check
  - packages/quereus/test/logic/03-expressions.sqllogic   # unary specialization coverage (review)
  - packages/quereus/test/logic/15-timespan.sqllogic      # timespan-column negation coverage (review)
  - docs/architecture.md                                  # removed stale `runtime/functions/` line from the src-layout tree
difficulty: easy
---

# What shipped

Five sites in the scalar-expression runtime stopped re-deciding per row what the plan
already settles once. All now follow the existing binary-comparison/arithmetic pattern:
pick a specialized `run` closure at **emit** time instead of dispatching on a string or
probing a value's shape on every row.

- **`emitLogicalOp`** — the AND/OR/XOR truth table moved to three module-level
  `LogicalCombine` functions picked once by `selectLogicalCombine`. `combineLogical`
  still coerces SQL truthiness and remains the single function both the eager and the
  deferred short-circuit path call, so they cannot drift.
- **`emitUnaryOp`** — `-`, `+`, `~` branch at emit time on the operand's plan-time
  logical type: numeric-fast arms (no `Number()` round trip), a timespan-only negate
  arm for `-`, and the original generic probe path for ANY/TEXT/mixed.
- **`emitScalarFunctionCallDefault`** — arity checked once at emit time against
  `plan.operands.length` (`StatusCode.INTERNAL`; a mismatch is now only reachable via an
  emitter bug) instead of on every call; the duplicate `isScalarFunctionSchema` check
  removed, since the sole entry point `emitScalarFunctionCall` validates first.
- **`emitNumericOp`'s number-only arm** — try/catch removed; plain-number arithmetic
  cannot throw and the non-finite check already handles division/modulo by zero. The
  bigint arm keeps its guard.
- **`docs/architecture.md`** — dropped the `runtime/functions/` line; no such directory
  exists (only `emit/` and `cache/` under `runtime/`).

Review added, on top of the implement handoff:

- The short-circuit path's own per-row `operator === 'AND'` / `=== 'OR'` string
  comparisons are now a single emit-time `decidingValue` boolean.
- `plan.operand.getType().logicalType` is computed once in `emitUnaryOp` rather than in
  each of the three arithmetic cases.
- Permanent test coverage for the new specialized paths (details below).

# Review findings

**Checked:** the full implement diff read before the handoff summary; the numeric-fast
type assumption against the type registry; timespan value normalization on every write
and cast boundary; the emit-time arity assert against `ScalarFunctionCallNode.operands`;
the reachability of the removed `isScalarFunctionSchema` check from outside
`emitScalarFunctionCall`; existing test coverage of every changed path; docs that
mention the touched areas; source-file size and structure. Lint (`eslint` + the test-file
`tsc` pass), `typecheck`, and the full suite (`node test-runner.mjs`) all run: **9043
passing, 16 pending, 0 failing**, before and after the review edits.

**Minor — fixed in this pass:**

- `runShortCircuit` in `binary.ts` still compared the operator *string* on every row to
  decide whether the left operand short-circuits — the exact per-row-dispatch the ticket
  set out to remove, missed one function below the one it fixed. Replaced with an
  emit-time `decidingValue` boolean (`false` for AND, `true` for OR — which is also the
  short-circuit result), so the hot path is one `===` against a captured constant.
- `emitUnaryOp` re-read `plan.operand.getType().logicalType` in each of the `-`, `+`,
  `~` cases. Hoisted to one `const` above the switch.
- **Test gap.** The implementer added no tests, arguing the changes are
  behavior-preserving; but the specialized arms are *new code paths* selected by operand
  type, and nothing pinned their results independently of the generic path. Added:
  - `03-expressions.sqllogic` — `~5.7` / `~(-5.7)` (REAL truncation before complement),
    `-`/`+`/`~` over a bigint literal at the int64 boundary, NULL propagation through all
    three, column-sourced INTEGER and NUMERIC operands, and TEXT operands to pin the
    generic coerce-or-null path that the specialization must not swallow.
  - `15-timespan.sqllogic` — negation of a TIMESPAN *column* (not just a `timespan(...)`
    call), including a row inserted as the bare human-readable string `'90 minutes'`,
    plus `-timespan(NULL)`. The new `-(timespan)` arm calls `Temporal.Duration.from`
    with no fallback, so this is the guard that the write path normalizes to ISO 8601
    before storage. Verified empirically that it does (`validateAndParse` →
    `TIMESPAN_TYPE.parse` on the INSERT boundary, and `cast-semantics` on CAST).

**Major — none filed, and no new tickets opened.** The two candidates were examined and
dismissed on evidence, not deferred:

- *"Numeric-fast arms cast `operand as number` without checking."* Only INTEGER, REAL and
  NUMERIC carry `isNumeric` (BOOLEAN and the temporal types do not — `types/builtin-types.ts`,
  `types/temporal-types.ts:266`), and all three validate to `number | bigint`. This is the
  same assumption the pre-existing binary `runNumericOnly` arm already makes, so the unary
  change adds no new class of risk.
- *"Dropping `isScalarFunctionSchema` from the default emitter leaves a hole."* Grep
  confirms `emitScalarFunctionCallDefault` has exactly two callers — `emitScalarFunctionCall`
  and the `defaultEmit` argument it passes to a `customEmitter` — and it is not re-exported
  from `src/index.ts`, so no plugin can reach it directly. The new doc comment states the
  precondition. (Docs carry no `customEmitter`/`defaultEmit` prose at all, so there is no
  stale documentation to correct — worth knowing for whoever documents the plugin
  emitter contract.)

**Tripwire — recorded at the code site, not as a ticket:** the `~` numeric-fast arm
returns `-1` for a NaN operand where the generic path returns `null`. No numeric-typed
expression can produce NaN today (arithmetic nulls out non-finite results;
`REAL_TYPE.parse` rejects `'NaN'`), so this is unreachable rather than wrong. `NOTE:` at
`runtime/emit/unary.ts` in that arm says to restore an `isNaN` check if a path ever admits
NaN into a numeric-typed value.

**Accepted-tradeoff `NOTE:`s at the touched sites:** none present, so nothing was
re-litigated.

**Not measured:** no benchmark, matching the sibling aggregate-hoist ticket. The claim is
structural — the same work moved from N rows to one emit — backed by an unchanged
pass/pending split, not by a timing number. Nobody should quote a speedup figure for this.

**Note text changed:** the specialized unary paths emit `-(numeric-fast)`,
`+(numeric-fast)`, `~(numeric-fast)`, `-(timespan)` instead of the old constant
`unary -` / `unary +` / `bitwise ~`. Nothing in `test/` asserts those strings, but
external tooling snapshotting `EXPLAIN` / debug-program output on unary expressions would
see the new text.
