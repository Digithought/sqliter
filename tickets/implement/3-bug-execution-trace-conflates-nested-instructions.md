---
description: The execution_trace debugging function mixes up two different instructions when a query contains any arithmetic or comparison, so the timings and values it shows can belong to a different step than the one it names. Give every instruction one address that both the listing and the trace agree on.
files:
  - packages/quereus/src/runtime/scheduler.ts                      # owns the addressing; tracingHooks + wrapIterableForTracing report it
  - packages/quereus/src/func/builtins/explain.ts                  # collectSchedulerProgram (listing) + executionTraceFunc / rowTraceFunc (the join)
  - packages/quereus/src/runtime/types.ts                          # InstructionTraceEvent, CollectingInstructionTracer, SubProgramInfo
  - packages/quereus/src/runtime/emitters.ts                       # emitCall — the only place a nested Scheduler is created
  - packages/quereus/test/core/diagnostic-tvfs.spec.ts             # where the regression test goes
  - docs/runtime.md                                                # ~line 627: "joins its trace events against that same instruction listing by index"
difficulty: medium
repro: verified
---

# Give every instruction one address

## What a user sees today

`execution_trace('select n + 1 from t where n > 2')` returns six rows. Three of
them describe two different instructions at once — the name comes from one
instruction, the timing and the input/output values may come from another. The
six instructions that live inside the two scalar sub-programs never get a row of
their own.

## Verified repro

Against a table `t(id integer primary key, n integer)` with two rows, running
`select n + 1 from t where n > 2`:

`scheduler_program()` lists twelve instructions:

```
addr 0  IndexScan(t)                       main
addr 1  callback(>(compare-fast))          main
addr 6  column(n)                          sub-program of addr 1
addr 7  literal(2)                         sub-program of addr 1
addr 8  >(compare-fast)                    sub-program of addr 1
addr 2  filter(n > 2)                      main
addr 3  callback(+(numeric-fast))          main
addr 6  column(n)                          sub-program of addr 3   <-- addr 6 again
addr 7  literal(1)                         sub-program of addr 3   <-- addr 7 again
addr 8  +(numeric-fast)                    sub-program of addr 3   <-- addr 8 again
addr 4  project(1 cols)                    main
addr 5  block(1 stmts, result idx: 0)      main
```

Grouping the raw trace events by the index they carry gives:

```
index 0 -> IndexScan(t)              AND  column(n)
index 1 -> callback(>(compare-fast)) AND  literal(2)  AND  literal(1)
index 2 -> filter(n > 2)             AND  >(compare-fast)  AND  +(numeric-fast)
index 3 -> callback(+(numeric-fast))
index 4 -> project(1 cols)
index 5 -> block(1 stmts, result idx: 0)
```

So there are three separate defects, all from one cause:

- Trace events from a nested sub-program land on whatever main-program
  instruction happens to share their local index.
- The listing's sub-program addresses (`6,7,8`) match no trace event at all, so
  nested instructions never appear in `execution_trace()`.
- The listing's own sub-program addresses **collide with each other**: the
  formula is `mainCount + programIndexWithinThatInstruction * 1000 + localIndex`,
  and `programIndexWithinThatInstruction` is always `0` because `emitCall`
  attaches exactly one program per instruction. Every instruction's first
  sub-program therefore starts at the same address. This is worse than "collides
  past 1000 instructions" — it collides immediately, on the query above.

Sub-program *dependency* lists have the same problem: the listing reports
`addr 8 -> dependencies [0,1]`, which are local indices inside that sub-program
but read as main-program addresses 0 and 1 (`IndexScan(t)` and
`callback(...)`).

## Root cause

Two different numbering schemes are treated as one identity.

- The listing side (`collectSchedulerProgram`, `explain.ts`) invents a flat
  address space with the `* 1000` formula above.
- The tracing side (`Scheduler.tracingHooks`, `scheduler.ts`) reports the index
  **within whichever `Scheduler` is currently running**. A nested program runs on
  its own `Scheduler` — created by `emitCall` (`emitters.ts`) — whose indices
  restart at `0`.

`execution_trace()` joins the two by plain integer equality.

The one structural fact that makes a fix possible: `emitCall` creates the nested
`Scheduler` at **emit** time, stores it on `instruction.programs`, and closes
over that same object to run it. So the object the trace runs on is exactly the
object the parent scheduler can see through `instruction.programs` — a parent can
number its children, and `emitCall` is the only place in the codebase that sets
`programs`, so each nested `Scheduler` has exactly one owner.

## The design: one address space, one implementation

Make `Scheduler` the single owner of instruction addressing, and have both the
listing and the tracer read addresses from it. Nothing encodes or decodes an
address; there is no multiplier to collide.

Numbering (depth-first, deterministic from the instruction tree alone):

```
a scheduler with base B and N own instructions occupies:
  B .. B+N-1                    its own instructions, in scheduler order
  then, in order of (owning instruction index, program index),
  each nested program takes the next block of its own total size
```

`totalSize` = own instruction count plus the total size of every nested program,
computable in the constructor because sub-schedulers already exist by then
(emission is bottom-up).

Suggested shape on `Scheduler`:

```ts
/** Number of instructions in this scheduler plus every program nested under it. */
readonly totalInstructionCount: number;

/** Global address of local instruction `i` within the whole program tree. */
addressOf(localIndex: number): number;

/**
 * Assigns global addresses across this scheduler and everything nested under it.
 * Idempotent; only the tracing and listing paths need it, so the optimized and
 * metrics dispatch loops never pay for it.
 */
ensureAddressesAssigned(): void;   // root entry point
```

Keep the assignment **off the non-tracing path** — the ticket scopes out changes
to normal execution. Assign lazily: `run()` calls `ensureAddressesAssigned()`
only in the tracing branch (`ctx.tracer` set, `enableMetrics` false), memoized by
a flag so a cached scheduler pays it once. A nested scheduler never needs to
assign for itself: its root always runs first and stamps it on the way through.

With that in place:

- `tracingHooks` passes `this.addressOf(i)` to `traceInput` / `traceOutput` /
  `traceError`, and `wrapIterableForTracing` passes it to `traceRow`. The
  `InstructionTracer` interface, its four method signatures, and
  `InstructionTraceEvent.instructionIndex` all keep their current shape — the
  number they carry simply becomes globally unique instead of scheduler-local.
  (The fix ticket floated a composite `(programId, localIndex)` identity instead.
  A single tree-global integer meets both required outcomes, keeps the `addr` /
  `instruction_index` columns INTEGER as declared, and leaves every external
  `InstructionTracer` implementation compiling. The nesting a composite would
  have carried is already reported by `scheduler_program`'s `is_subprogram` and
  `parent_addr` columns, which now actually resolve.)
- `collectSchedulerProgram` drops its `mainCount + progIdx * 1000 + subI`
  formula and asks the scheduler for both its own and its nested addresses, and
  maps sub-program dependency lists through the owning sub-scheduler's addresses
  so they name real instructions. Prefer walking nested programs through one
  recursive helper over the current single-level special case, so a program
  nested two deep (a correlated subquery inside a filter predicate) is listed
  too.
- `SubProgramInfo.programIndex` (`types.ts`) is currently a per-tracer counter
  (`nextSubProgramId++`) that means nothing to a reader. Make it the
  sub-program's base address, so the `sub_programs` JSON blob in
  `execution_trace()` points at rows that exist in `scheduler_program()`.
  `CollectingInstructionTracer.getSubPrograms()` should key by the same address.

`rowTraceFunc` needs no change of its own — it groups by
`event.instructionIndex` and inherits correct addressing.

## Definition of done

Both symptoms gone, checked by test:

- No address maps to two instructions. Grouping raw trace events by
  `instructionIndex` yields exactly one distinct `note` per address, and that
  note equals the `description` that `scheduler_program()` reports for the same
  address.
- Every address `scheduler_program()` lists is unique, and every listed
  instruction that actually executes appears in `execution_trace()` under that
  same address.

## Test shape

Put the regression test in `test/core/diagnostic-tvfs.spec.ts` (which already
covers these five TVFs end-to-end). Write it as **one generalized check run over
several query shapes**, not an assertion about the one query in this ticket —
the defect is a class, and the same check should keep catching it as emitters
change:

For each SQL shape, run the statement under a `CollectingInstructionTracer` with
`stmt._emitUnfused = true` (exactly as `executionTraceFunc` does — fusion would
dissolve the sub-programs this test is about), and separately read
`scheduler_program(sql)`:

- every `addr` in the listing is distinct;
- every distinct `instructionIndex` in the trace events has exactly one distinct
  `note`;
- that note equals the listing's `description` at the same `addr`;
- every dependency address in the listing names a row that exists in the listing;
- at least one sub-program instruction (`is_subprogram = 1`) shows up in the
  trace — i.e. nested instructions are reachable at all.

Query shapes worth covering: scalar arithmetic in the projection plus a
comparison in the `where` (the ticket's repro, two sibling sub-programs); an
aggregate; a join; and something that nests a program inside a program, e.g. a
correlated scalar subquery in a predicate — that last one is the case the current
single-level listing walk misses entirely.

## Not in scope

- Column shapes of the diagnostic TVFs: `addr` / `instruction_index` stay
  INTEGER, no columns added or removed.
- Non-tracing execution. The optimized and metrics dispatch loops must not gain
  work; addressing is assigned lazily on the tracing path only.
- `planner/debug.ts` (`getInstructionDebugInfo`, `generateTraceReport`) prints
  scheduler-local indices for a human reader and joins against nothing. Leave it
  alone unless `generateTraceReport` reads a field this change renames.
- `quoomb-web`'s `ExecutionTrace.tsx` consumes `instruction_index` and
  `dependencies` from these TVFs. It sorts numerically and walks dependencies, so
  it keeps working and simply starts showing the nested rows; no change is
  required, but a quick read of it before handing off is worth the minute.

## TODO

- Add `totalInstructionCount`, `addressOf`, and lazy `ensureAddressesAssigned()`
  to `Scheduler`; document the numbering scheme in a comment at the top of the
  new code, including why it is off the non-tracing path.
- Route `tracingHooks` and `wrapIterableForTracing` through `addressOf`, and call
  `ensureAddressesAssigned()` from `run()`'s tracing branch only.
- Rewrite `collectSchedulerProgram` to take addresses (own, nested, and
  dependency lists) from the scheduler, recursively for programs nested more
  than one level deep; delete the `* 1000` formula.
- Make `SubProgramInfo.programIndex` the sub-program's base address and key
  `getSubPrograms()` by it.
- Add the generalized regression test described above to
  `test/core/diagnostic-tvfs.spec.ts`.
- Update `docs/runtime.md` (~line 627) — "joins its trace events against that
  same instruction listing by index" now needs to say the address is assigned
  once by the scheduler across the whole program tree, main and nested alike.
  Check `docs/functions.md` §diagnostic functions for anything that describes
  `addr` and correct it if it claims main-program-only numbering.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
