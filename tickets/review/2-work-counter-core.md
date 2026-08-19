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
  - packages/quereus/test/runtime/work-counter-stability.spec.ts     # acceptance suite (7 tests)
  - packages/quereus/test/runtime/work-counter-stability-shared.ts   # cases + snapshot helpers
  - packages/quereus/test/runtime/work-counter-stability-child.ts    # child-process runner (IPC)
  - packages/quereus/test/runtime/fork-contract.spec.ts    # workCounters fork policy = shared-sink
  - docs/runtime.md                                        # "Work counters" section (before Key Points for Emitter Authors)
  - docs/runtime-parallel.md                               # workCounters row in the fork-policy table
---
# What landed

A readable, machine-independent work-counter surface on prepared statements. With
runtime metrics on (`db.setOption('runtime_metrics', true)` — alias of the existing
`runtime_stats` option; no new option), each execution collects per-instruction
counts, and after the row iterable is fully drained:

- `Statement.getWorkCounters(): WorkCounterSnapshot | undefined` — last execution's
  snapshot, by value. `undefined` with metrics off. Partial (but kept) after an error
  or an un-drained iterable.
- `Statement.getPlanShape(): PlanShape` — `{ nodeCount, nodeTypes }`, available after
  compile with no execution.

Snapshot shape: `{ plan: { nodeCount, nodeTypes }, instructions: [{ key, nodeType?,
executions, in, out }], totals: { instructionExecutions, rowsOut } }`. JSON-safe — no
bigint, and **no timings by design** (elapsed time stays in the debug log only).

Stability is the whole point: instruction keys are structural program addresses
(root program `r`; sub-program `j` of instruction `i` of program `P` is `P/i/j`;
instruction `i` keys as `<path>#<i>`), never plan-node ids — `PlanNode.id` is a
process-global counter and would diverge between runs. Sub-program slots accumulate
across re-invocations (a correlated subquery driven 5 times reports 5 executions of
its inner instructions — N+1 made visible), unlike the per-invocation-reset
`Instruction.runtimeStats` debug path, which is untouched. Streaming operators count
true row output: async-iterable outputs are wrapped in a counting generator, with a
slot-valued marker symbol so re-wrap by a *different* instruction is deliberate
double-counting (rows flow through both), not a bug.

Parallel branches share the collector by reference (`RuntimeContext.workCounters`,
fork policy `shared-sink` in the fork-contract spec) — counts roll up, no merge step.

# How to validate

- `yarn workspace @quereus/quereus run test` — full suite: **9786 passing, 0
  failing** (includes the new 7-test `test/runtime/work-counter-stability.spec.ts`,
  plus `prepared-statement-amortization.spec.ts` and `fork-contract.spec.ts`, both
  re-run individually and green).
- `yarn lint` — green (type-checks the test files too).
- Strict-fork leg (from repo root, Git Bash syntax):
  `QUEREUS_FORK_STRICT=1 node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/runtime/work-counter-stability.spec.ts"` — 7 passing.
- The acceptance suite's legs: same prepared statement drained twice; two fresh
  databases at different plan-node-id offsets (warmup statements burn ids); **two
  separate child processes** (forked with different warmups, reporting over IPC) —
  all deep-equal. Plus JSON round-trip, metrics-off → `undefined`, zero-row
  execution still reports work, and N+1 sub-program visibility (`r/` keys with
  `executions >= TABLE_ROW_COUNT`).

# Bench (no regression)

Baseline captured on the pre-change tree
(`packages/quereus/bench/results/2026-08-19T10-56-27-427Z.json`), compared after all
changes with `node bench/run.mjs --filter execution --baseline <that file>`:
**15 benchmarks, 15 "no change", 0 regressed, 0 unstable.** Worst delta +2.7%
(text-pk-point-seek-10k) against a ±23.5% noise floor. Console copies in
`tickets/.logs/2-work-counter-core.bench-baseline.log` and
`.../2-work-counter-core.bench-compare.log`. Metrics-off executions allocate
nothing new (`ctx.workCounters` undefined → hooks find no slot).

# Gaps and notes for the reviewer

- **Optimizer decorrelation surprised the N+1 case.** The originally planned
  correlated SQL (`select count(*) ... where t2.b = t.b`) is decorrelated into a
  HashJoin — no sub-program, nothing for the N+1 assertion. The suite now uses a
  `limit 1` scalar subquery (stays a per-row sub-program, verified empirically) for
  the sub-program assertions, and keeps the decorrelated form as its own stability
  case. If a future optimizer rule learns to decorrelate through `limit 1`, the N+1
  test will fail loudly — swap in whatever still compiles to a sub-program.
- **Partial-drain snapshots are documented but not tested.** `getWorkCounters()`
  after `break`-ing out of the iterable returns a partial snapshot; no test pins
  what "partial" contains (it is inherently position-dependent).
- **`nodeType` is absent on synthetic instructions** (emitCall callbacks, fused
  scalars) — they count under their structural key with no plan-node label. Fused
  scalar subtrees are one instruction by design (documented in docs/runtime.md; the
  fusion section explains why interior nodes have no scheduler existence).
- **Snapshot omits never-ran instructions** — deliberate (a missing entry and an
  all-zero entry are different claims), asserted by the zero-row test.
- **`tables` block (storage round-trips at the vtab boundary) is room left, not
  built** — that is the follow-on ticket, out of scope here.
- **Trusted invariant to spot-check if inclined**: the collector's program walk
  assumes `Instruction.programs` is only set by `emitCall` (single site today); a
  `NOTE:` at the walk site records what happens if that changes.
