---
description: |
  The query debugger's instruction listing and its execution trace used two different
  numbering schemes, so a trace row could show one instruction's name next to another
  instruction's timings, and instructions inside nested sub-programs were unreachable.
  Every instruction now has one number that means the same thing everywhere.
files:
  - packages/quereus/src/runtime/scheduler.ts                # addressOf / baseAddress / dependencyAddressesOf / ensureAddressesAssigned; tracingHooks
  - packages/quereus/src/func/builtins/explain.ts            # appendSchedulerEntries; execution_trace() and row_trace() bodies
  - packages/quereus/src/runtime/types.ts                    # InstructionTraceEvent, SubProgramInfo, CollectingInstructionTracer
  - packages/quereus/src/planner/debug.ts                    # NOTE: its listings are local-numbered, not joinable
  - packages/quereus/test/core/diagnostic-tvfs.spec.ts       # 8 addressing cases (4 tracer-level, 4 through the TVFs)
  - docs/runtime.md, docs/functions.md                       # instruction address defined; which surfaces join on it
difficulty: medium
---

# One address space for instructions

Implemented in `d4bbf3724`, reviewed and extended here.

## What shipped

`Scheduler` owns instruction addressing. `assignAddresses(base)` stamps a base
depth-first across the scheduler tree; `ensureAddressesAssigned()` is the idempotent
root entry point; `addressOf(i)`, `baseAddress` and `dependencyAddressesOf(i)` read it.
Nothing encodes or decodes an address, so the old `mainCount + progIdx * 1000 + local`
formula — which collided for every instruction, because `emitCall` attaches exactly one
program per instruction and so `progIdx` was always `0` — is gone.

Assignment happens only on the tracing path, memoized by a flag, so ordinary execution
and the metrics loop pay nothing. `collectSchedulerProgram` recurses, so a program
nested two deep (a correlated subquery inside a filter predicate) is listed at all,
which the old single-level special case never did. `SubProgramInfo.programIndex` is now
the sub-program's base address instead of a meaningless per-tracer counter.

After this review, `scheduler_program().addr`, `execution_trace().instruction_index` and
`row_trace().instruction_index` are all addresses in that one space and join on it.
`Statement.getDebugProgram()` deliberately is not — it prints each scheduler's own local
numbering with sub-programs in separate sections — and both the code and `docs/runtime.md`
now say so.

## Review findings

Read the implement diff before the handoff summary, then chased each item the handoff
flagged plus the consumers it did not.

### Answers to the handoff's open questions

- **Lazy assignment holds.** `assignAddresses` sets `addressesAssigned` on *every*
  scheduler it visits, so a nested scheduler's own tracing-path call is always the no-op
  guard. More importantly, no nested scheduler can be reached with a tracer before its
  root: read every `Scheduler.run` call site, and each non-statement one
  (materialized-view maintenance and apply, assertions, the derived-row validator, the
  const evaluator) constructs a fresh `RuntimeContext` with no tracer. Probed it too —
  an insert with a CHECK constraint and an insert driving materialized-view maintenance,
  both traced, produced zero addresses carrying more than one instruction note.
- **`addressesAssigned` never being invalidated is correct.** `Instruction.programs` is
  set only by `emitCall`, at construction, so the tree is frozen before the first
  assignment can run. Nothing re-parents.
- **`totalInstructionCount` was dead** — computed in the constructor, read only by its
  own recursive computation. `assignAddresses` threads the next free address through its
  return value and never consults it. Removed, along with the extra constructor pass,
  and the address-space comment that referenced it was corrected.
- **The sub-program blob's `index` field was misleading** — it carries a global address.
  Renamed to `address`. No in-tree consumer; the JSON is read only by humans and now by
  the new test.
- **`is_subprogram` semantics are safe.** `parentAddr !== null` reproduces the old
  per-arm value for depth-1 programs and correctly extends to deeper nesting. The only
  consumer in the repo is the spec.

### Fixed in this pass (minor)

- **`row_trace()` traced the *fused* graph** while `scheduler_program()` and
  `execution_trace()` use the unfused one — same column name `instruction_index`, two
  different numberings, silently unjoinable. Now sets `_emitUnfused` like its siblings.
  Honest caveat: no test distinguishes the two, because fusion collapses exactly the
  scalar sub-programs that emit no row events, so today's query shapes address the same
  either way. Verified that by reverting the line and watching the new tests still pass.
- Dead `totalInstructionCount` removed (above).
- Sub-program blob field renamed (above).
- `docs/runtime.md` gained `row_trace()` in the unfused list and an explicit statement of
  which surfaces join on the address and which does not; `docs/functions.md` gained the
  same join note next to its TVF table. `docs/usage.md`, `docs/sql-functions.md`,
  `docs/optimizer-retrieve.md`, `docs/stability.md` and the package README were read and
  need no change — none of them describe the numbering.

### Tests added

The implementer's four cases assert invariants over query shapes from the tracer's own
events. They left three named gaps; two are now closed by four more cases that go
through the TVFs a user actually calls, so what is *published* is checked, not only what
the scheduler computes:

- every `execution_trace().instruction_index` resolves against the listing;
- every address in its `dependencies` resolves;
- every `sub_programs[].programIndex` resolves, and every nested
  `instructions[].address` and its dependencies resolve — this was one of the three
  defects the original ticket named and had no assertion before;
- every `row_trace().instruction_index` resolves;
- non-vacuity guards, so an empty trace or an absent sub-program blob fails rather than
  passes silently.

`yarn test` green, 10297 passing in quereus (up from 10293). `yarn lint`,
`yarn typecheck`, `yarn build` and `node scripts/check-docs.mjs` all clean. No
pre-existing failures surfaced, so nothing was written to
`tickets/.pre-existing-error.md`.

The handoff's third gap — that no test pins the claim that non-tracing execution never
assigns addresses — is left open deliberately. Pinning it means asserting on a private
field or counting calls to a private method; the guarantee is one `if` in `run()` and is
better read than mocked.

### Tripwires recorded (no tickets filed)

- `Scheduler.ensureAddressesAssigned` — the address space is per scheduler *tree* and
  always bases at 0, so two independently-rooted trees traced by one tracer would
  collide. Fine today, verified as above. `NOTE:` at the site says bases must come from
  the tracer if a site ever runs a second root on a traced context.
- `Scheduler.assignAddresses` — assumes the program graph is a tree. A shared or cyclic
  sub-program would be stamped twice, silently handing two instructions one address.
  `WorkCounterCollector.walk` already guards the same assumption defensively; the `NOTE:`
  points at it as the shape of the fix.
- `planner/debug.ts` `generateTraceReport` — its trace events now carry global addresses
  while `generateInstructionProgram` next to it numbers each scheduler locally, and both
  print `[nnn]`. `NOTE:` at the site says the two are not joinable.

### Considered and not filed

`generateTraceReport` and `getInstructionDebugInfo` in `planner/debug.ts` are exported
and called from nowhere in the repo — a third numbering scheme kept alive only by being
public. Not worth a ticket: it is dead code, deleting it is outside this ticket's reach,
and the risk it carries (a future reader joining its output against an address) is now
answered by a `NOTE:` at the site and by `docs/runtime.md`.

### Major findings

None. Nothing warranted a new `fix/`, `plan/` or `backlog/` ticket: every real defect
found was a one-line inconsistency fixable in place, and the two structural risks are
genuinely conditional on changes that have not happened.
