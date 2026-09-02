---
description: Review the change that gives every instruction one tree-global address, so scheduler_program()'s listing and execution_trace()'s events name the same instruction instead of colliding.
files:
  - packages/quereus/src/runtime/scheduler.ts                # addressOf / baseAddress / dependencyAddressesOf / ensureAddressesAssigned; tracingHooks
  - packages/quereus/src/func/builtins/explain.ts            # collectSchedulerProgram -> appendSchedulerEntries; executionTraceFunc's sub-program detail
  - packages/quereus/src/runtime/types.ts                    # InstructionTraceEvent, SubProgramInfo, CollectingInstructionTracer
  - packages/quereus/test/core/diagnostic-tvfs.spec.ts       # new: 4 generalized addressing cases
  - docs/runtime.md                                          # ~line 627, "by index" -> "by address" plus a definition
---

# Review: one address space for instructions

Implements `implement/3-bug-execution-trace-conflates-nested-instructions`.

**This handoff is written by a different agent than the one that wrote the code.** The
runner was killed part-way through the implement stage, leaving the edits uncommitted and
no review ticket. I verified the work rather than authoring it: build, the ticket's own
definition of done, the full suite, lint, typecheck and docs. Treat the confidence here as
"checked against the ticket", not "I know why every line is the way it is".

## What was built

Two numbering schemes were being joined by integer equality. `collectSchedulerProgram`
invented a flat address space with a `mainCount + progIdx * 1000 + localIndex` formula —
where `progIdx` is always `0`, because `emitCall` attaches exactly one program per
instruction, so **every** instruction's sub-program started at the same address. The
tracer meanwhile reported the index *within whichever `Scheduler` was running*, and a
nested program's indices restart at zero.

`Scheduler` now owns addressing outright:

- `assignAddresses(base)` stamps a `base` depth-first across the scheduler tree;
  `ensureAddressesAssigned()` is the idempotent root entry point. `addressOf(i)`,
  `baseAddress` and `dependencyAddressesOf(i)` read it. Nothing encodes or decodes an
  address, so there is no multiplier left to collide.
- `argIndexes` was promoted from a constructor local to a field, which is what lets
  dependency lists be reported as addresses.
- **Assignment stays off the non-tracing path.** `run()` calls it only in the tracing
  branch, memoized by a flag, so ordinary execution and the metrics loop pay nothing.
- `tracingHooks` and `wrapIterableForTracing` report `addressOf(i)`. The
  `InstructionTracer` interface and its four signatures are unchanged — the integer they
  carry simply becomes globally unique, so external tracer implementations still compile.
- `collectSchedulerProgram` drops the formula for a recursive `appendSchedulerEntries`,
  so a program nested two deep (a correlated subquery inside a filter predicate) is listed
  too — the old single-level special case never listed those at all.
- `SubProgramInfo.programIndex` was a per-tracer counter (`nextSubProgramId++`) meaning
  nothing to a reader; it is now the sub-program's base address, and
  `getSubPrograms()` keys by the same, so the `sub_programs` blob points at rows that
  `scheduler_program()` actually lists.

## What to attack

- **Lazy assignment is the load-bearing bit.** `ensureAddressesAssigned` is called on the
  root in the tracing branch of `run()`, and the comment claims a nested scheduler never
  needs to assign for itself because "its root always runs first and stamps it on the way
  through". Verify that. A nested scheduler reached by a path that does not run its root
  first would report `base = 0` and silently collide again — which is the original bug,
  reintroduced in a form the new tests would not necessarily catch.
- **`addressesAssigned` is set but never invalidated.** Schedulers are cached on prepared
  statements. If a scheduler tree could ever be re-parented or a nested program re-attached
  after first assignment, the stale base would be wrong. Probably impossible — `emitCall`
  is the only site that sets `programs` — but confirm, since the memoization is what makes
  the cost argument work.
- **`totalInstructionCount` is computed in the constructor but I did not find a consumer.**
  Check whether it is dead. Its doc comment argues it is computable because emission is
  bottom-up; if nothing reads it, it is an unused field carrying a subtle invariant.
- **`executionTraceFunc`'s sub-program detail block** now maps through
  `subScheduler.addressOf(idx)` and assigns it to a field named `index`. Confirm the field
  name is not now misleading to a consumer, and that no caller still treats it as a local
  offset.
- **The `is_subprogram` flag changed meaning.** It used to be set per-arm; it is now
  `parentAddr !== null`. Check nothing consumed the old semantics.

## Testing

Four generalized cases in `test/core/diagnostic-tvfs.spec.ts`, written as invariants over
several query shapes rather than assertions about the ticket's one repro — scalar
arithmetic plus comparison (two sibling sub-programs), aggregate, join, and a correlated
scalar subquery (a program nested inside a program). Each asserts: every listed address is
distinct; every dependency address names a listed row; each traced address carries exactly
one distinct note; that note equals the listing's description at the same address; and at
least one sub-program instruction actually appears in the trace.

That is the ticket's stated definition of done, and it fails against the pre-change code by
construction (the old listing emitted duplicate addresses for the first shape).

`yarn test` green across all workspaces, exit 0 — quereus 10293 passing, up from 10284.
`yarn lint`, `yarn typecheck`, `node scripts/check-docs.mjs` clean.

## Known gaps

- **`yarn test:store` not run for this change.** It is engine-only and touches no store
  path, so the risk is low, but it was not run.
- **`rowTraceFunc` is untested here.** The ticket says it needs no change because it groups
  by `event.instructionIndex` and inherits correct addressing. That reasoning looks right
  but is unverified by any assertion.
- **`execution_trace()`'s `sub_programs` JSON is not asserted.** The tests read raw trace
  events and the `scheduler_program()` listing; they do not check that the blob's
  `programIndex` values now resolve against the listing, which is one of the three defects
  the ticket named.
- **No test pins the cost claim** that non-tracing execution never assigns addresses.
- **The docs edit is mine, not the implementer's.** `docs/runtime.md` said trace events
  join the listing "by index"; it now says "by address" and defines the term. Check the
  wording against what the code actually guarantees.
