---
description: The execution_trace debugging function mixes up two different instructions when a query contains any arithmetic or comparison, so the timings and values it shows can belong to a different step than the one it names.
files:
  - packages/quereus/src/func/builtins/explain.ts    # collectSchedulerProgram (addr encoding) + executionTraceFunc (the join)
  - packages/quereus/src/runtime/types.ts            # InstructionTraceEvent.instructionIndex, CollectingInstructionTracer
  - packages/quereus/src/runtime/scheduler.ts        # tracingHooks — passes the scheduler-local index to the tracer
  - packages/quereus/src/runtime/emitters.ts         # emitCall — creates the nested Scheduler whose indices restart at 0
difficulty: medium
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: This is a debugging surface, not query results — nothing a user's data depends on is wrong, and the fix widens an interface (the tracer) that several call sites implement, so a maintainer may reasonably rank it below defects that affect real answers.
---

# `execution_trace()` merges unrelated instructions under one number

## What a user sees

`execution_trace('<sql>')` returns one row per instruction, naming the
operation and reporting its timing, inputs, and output. When the query
contains any scalar expression — `n + 1`, `n > 2`, almost anything — some of
those rows describe **two different instructions at once**: the operation
name comes from one, and the timing/input/output values may come from the
other. Other instructions the companion `scheduler_program()` listing shows
never appear in the trace at all.

Verified on `select n + 1 from t where n > 2`. Grouping the raw trace events
by the index they carry gives:

```
index 0 -> IndexScan(t)              AND  column(n)
index 1 -> callback(>(compare-fast)) AND  literal(2), literal(1)
index 2 -> filter(n > 2)             AND  >(compare-fast), +(numeric-fast)
index 3 -> callback(+(numeric-fast))
index 4 -> project(1 cols)
index 5 -> block(1 stmts, result idx: 0)
```

The left column is the main program; the right column is instructions from
nested scalar sub-programs. `execution_trace()` labels each group with the
main-program name only, and picks the first `input`/`output` event in the
group to compute duration and values — which can be the nested one.

## Root cause

Two different ways of numbering an instruction are being treated as one.

- The listing side (`collectSchedulerProgram` in `explain.ts`) invents a flat
  address space: main-program instructions get `0 … mainCount-1`, and a
  nested instruction gets `mainCount + programIndex * 1000 + localIndex`.
- The tracing side (`InstructionTraceEvent.instructionIndex`, set in
  `scheduler.ts`) reports the index **within whichever scheduler is
  running**. A nested program runs on its own `Scheduler` (created by
  `emitCall` in `emitters.ts`), so its indices restart at `0`.

The two agree only for main-program instructions. `execution_trace()` joins
them by plain integer equality, so nested events land on whatever
main-program instruction happens to share their local index, and the listing's
`mainCount + …` addresses match nothing.

## What's being asked for

Give an instruction one identity that both sides carry, so a nested
instruction cannot be mistaken for a top-level one. The natural shape is a
composite — which program it belongs to, plus its index inside that program —
rather than a single integer both sides have to encode and decode
compatibly. That means the tracer's events carry the program identity too,
which is an interface change through `InstructionTracer`, `Scheduler`'s
tracing hooks, and `emitCall`.

Two symptoms must both be gone afterward:

- No trace row conflates a main-program instruction with a nested one — the
  operation named and the timing/values reported come from the same
  instruction.
- Nested instructions that `scheduler_program()` lists actually appear in
  `execution_trace()` output, addressed the same way in both.

The current `programIndex * 1000` encoding also silently collides once any
program exceeds 1000 instructions; a composite identity removes that as a
side effect, and the fix should not reintroduce a magic multiplier.

## Not in scope

Changing what the diagnostics report or their column shapes beyond what
correct addressing requires, and any change to non-tracing execution — the
tracing path is already separate from the optimized dispatch loop.
