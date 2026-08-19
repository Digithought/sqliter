---
description: Queries can now report how much work they did - how many times each step ran and how many rows it produced - as counts that come out identical on every machine, so results from different computers can finally be compared.
files:
  - packages/quereus/src/runtime/work-counters.ts          # collector, snapshot types, recordOutput, computePlanShape
  - packages/quereus/src/runtime/scheduler.ts              # metrics RunHooks feed the collector slots
  - packages/quereus/src/runtime/emitters.ts               # stamps plan node type onto instructions
  - packages/quereus/src/runtime/types.ts                  # RuntimeContext.workCounters + Instruction.nodeType
  - packages/quereus/src/runtime/parallel-driver.ts        # fork shares the collector by reference
  - packages/quereus/src/core/statement.ts                 # getWorkCounters() / getPlanShape()
  - packages/quereus/src/index.ts                          # exports WorkCounterSnapshot, PlanShape
  - packages/quereus/test/runtime/work-counter-stability.spec.ts     # acceptance suite (10 tests)
  - packages/quereus/test/runtime/work-counter-stability-shared.ts   # cases + snapshot helpers
  - packages/quereus/test/runtime/work-counter-stability-child.ts    # child-process runner (IPC)
  - packages/quereus/test/runtime/fork-contract.spec.ts    # workCounters fork policy = shared-sink
  - docs/runtime.md                                        # "Work counters" section
  - docs/runtime-parallel.md                               # workCounters row in the fork-policy table
  - docs/usage.md                                          # Statement API Reference entries
---
# What landed

A machine-independent work-counter surface on prepared statements. With runtime
metrics on (`db.setOption('runtime_metrics', true)` — alias of the existing
`runtime_stats` option), each execution collects per-instruction counts:

- `Statement.getWorkCounters(): WorkCounterSnapshot | undefined` — last execution's
  snapshot, by value; `undefined` with metrics off, partial (but kept) after an error
  or an un-drained iterable.
- `Statement.getPlanShape(): PlanShape` — `{ nodeCount, nodeTypes }`, available after
  compile with no execution.

Snapshot shape: `{ plan, instructions: [{ key, nodeType?, executions, in, out }],
totals: { instructionExecutions, rowsOut } }`. JSON-safe, no timings by design.

Instruction keys are structural program addresses (root program `r`; sub-program `j`
of instruction `i` of program `P` is `P/i/j`; instruction `i` keys as `<path>#<i>`),
never plan-node ids, which are process-global and would diverge between runs.
Sub-program slots accumulate across re-invocations, so an N+1 pattern shows up as N
executions of the inner instructions. Streaming outputs are wrapped in a counting
generator so `out` is a true row count. Parallel branches share the collector by
reference (fork policy `shared-sink`).

# Review findings

## What was checked

The implement diff in full (`git diff 9953896cd^ f66d4dd45`): all six source files,
three test files, and both doc files, plus the file the change should have touched
and did not (`docs/usage.md`). Angles: label correctness, key stability, snapshot
semantics, `in`/`out` semantics against the scheduler's own input/output counting,
iterable wrapping and its cleanup propagation, re-iterability, sub-program discovery,
statement lifecycle and invalidation, fork policy, and every other `RuntimeContext` /
`Scheduler` construction site in the repo. Findings were confirmed by running real
queries and dumping snapshots, not by reading alone.

## Fixed in this pass (minor)

- **Transparent wrapper emitters mislabeled their instruction.** The emitters for
  alias, asserted-keys, collate and lens-auxiliary-access return their *source's*
  instruction verbatim, and `emitPlanNode` unconditionally overwrote the stamp, so
  the work got attributed to a plan node that has no instruction of its own.
  Reproduced: `select t.a from t join t as u on t.a = u.a` reported one instruction
  labeled `Alias` and one labeled `IndexScan`, while the plan shape in the same
  snapshot claimed `IndexScan: 2`. Now first-stamp-wins (`??=`), so the label names
  the operator that produced the instruction. Regression test added.
- **A stale snapshot survived an execution that exited early.** The counters were
  only cleared once execution setup reached the collector, so an execution that threw
  in `compile()` or found an empty statement block left `getWorkCounters()` reporting
  the execution before last. Cleared at the top of the execution body instead.
- **`in` and `out` are on different scales and nothing said so.** `in` counts
  argument values (a streaming argument counts 1 regardless of how many rows flow
  through it), `out` counts rows — so `out/in` on one entry is not selectivity, and
  `totals.rowsOut` is rows-through-operators, not rows returned to the caller.
  Documented on the type and in docs/runtime.md.
- **`docs/usage.md` never learned about the two new public methods.** Its Statement
  API Reference now documents `getWorkCounters()` (with the metrics-option and
  drain-completeness caveats) and `getPlanShape()`.
- **Test gaps.** The N+1 test asserted over all instructions rather than the
  sub-program subset it had just computed, so it would have passed with zero
  sub-program re-invocation. Tightened. Three tests added: per-yield row counting
  (nothing pinned the counting generator — every `out` could have been 1 and all six
  stability legs would still have passed), transparent-wrapper labeling, and
  `getPlanShape()` before execution matching the executed snapshot's `plan`.

## Major findings

None. Every finding resolved at its own site within this pass, so no new ticket was
filed.

## Tripwires recorded (deliberately not tickets)

- `recordOutput` (work-counters.ts): the counting wrap turns a *re-iterable* output
  into a single-shot generator, so a second pass over it would yield nothing with
  metrics on. Safe today — every re-drive in the runtime goes through a callback
  instruction that returns a fresh iterable per call — so this is conditional on a
  future emitter parking a re-iterable as its output. A `NOTE:` at the site says what
  to do then (wrap per `[Symbol.asyncIterator]()` call rather than once per value).
- `WorkCounterCollector.walk` (work-counters.ts): the walk runs once at execution
  start, so a `Scheduler` built *during* a run would be absent from the map and
  counting for it would silently be skipped. No such site exists today — every
  sub-program is built at emit time. Folded into the existing `NOTE:` about
  `Instruction.programs`.

## Known gaps left standing (with reasons)

- **Partial-drain snapshots remain untested.** What "partial" contains is
  position-dependent by nature; the behavior is documented on `getWorkCounters()` and
  in docs/runtime.md, and pinning a specific partial count would test the scheduler's
  pull order rather than the counter surface. Left as documentation only.
- **The parallel fork roll-up has no end-to-end test.** The parallel driver has no
  query consumers yet, so no reachable query forks; the policy is asserted in
  `fork-contract.spec.ts` and the sharing is one line of the fork literal. Worth an
  end-to-end assertion when the driver gains a consumer.
- **Metrics mode inserts a generator hop per row per operator.** Metrics is a debug
  mode with no default-on path and the counted numbers are unaffected, so this is not
  a concern now; the bench comparison in the implement pass measured metrics-off
  executions, which allocate nothing new.
- **`nodeType` is absent on synthetic instructions** (callback instructions, fused
  scalars) — by design, documented; those entries carry their structural key only.
- **The `tables` block (storage round-trips at the virtual-table boundary) was never
  in scope** — follow-on work.

## Validation

- `yarn lint` — green (includes the type-check pass over the test files).
- `yarn test` — green across the whole workspace (full run, ~5m).
- `packages/quereus/test/runtime/work-counter-stability.spec.ts` re-run alone —
  **10 passing** (7 from implement + 3 added here), including the two-process leg.
