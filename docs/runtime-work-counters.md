# Runtime Work Counters

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

Machine-independent execution counts for one statement execution: what
`Statement.getWorkCounters()` and `Statement.getPlanShape()` return, how the
per-instruction and per-table counters are keyed, and which boundary each one
measures. A satellite of [Quereus Runtime](runtime.md).

## Machine-independent execution counts

When runtime metrics are on (the `runtime_stats` db option, alias `runtime_metrics`),
each statement execution also feeds a `WorkCounterCollector`
(`runtime/work-counters.ts`) carried on the `RuntimeContext`. After the row iterable
is fully drained, `Statement.getWorkCounters()` returns a `WorkCounterSnapshot` — a
JSON-safe, by-value record of how much work the execution did — and
`Statement.getPlanShape()` returns plan-node counts by type without executing at all.
The premise is **machine independence**: the same statement over the same data
produces byte-identical snapshots on every machine, every run, and every process, so
counts can be compared where timings cannot.

- **What is counted**: per instruction, `executions` (times its `run` was invoked),
  `in` (argument values received), and `out` (rows/values produced — an async
  iterable's output is counted per yield via a wrapping generator, so streaming
  operators report true row counts). Totals sum executions and rows over the
  instructions that ran; instructions that never ran are omitted (a missing entry and
  an all-zero entry are different claims).
- **`in` and `out` are on different scales** — `in` counts argument values, so a
  streaming argument counts 1 no matter how many rows flow through it, while `out`
  counts every row. Read an operator's input row count off its *producer's* `out`,
  never as its own `in`; `totals.rowsOut` likewise sums rows over the whole pipeline
  (a row crossing three operators counts three times), not rows returned to the caller.
- **Labels name the producing operator**: a transparent wrapper node (alias,
  asserted-keys, collate, lens-auxiliary-access) emits its source's instruction
  verbatim, so that instruction's `nodeType` stays the source operator's — the plan
  node that vanished at emit time never labels the work someone else did.
- **What is deliberately not counted**: elapsed time — a nanosecond figure on a
  machine-independence surface invites exactly the cross-machine comparison this
  replaces (`elapsedNs` stays in the debug-only `runtime:metrics` log). A fused
  scalar subtree (see
  [Runtime § Scalar fusion](runtime.md#scalar-fusion-the-second-execution-tier))
  is one instruction, so its interior nodes contribute no separate counts — by
  design, since fusion also deletes their scheduler-visible existence.
- **Keys are structural, never plan-node ids**: the root program is `r`; the
  scheduler at `instructions[i].programs[j]` of program `P` is `P/i/j`; instruction
  `i` of a program keys as `<path>#<i>` (e.g. `r#4`, `r/2/0#1`). `PlanNode.id` is a
  process-global counter and must never appear in a key — that is what makes
  snapshots comparable across processes.
- **Sub-program counts accumulate across re-invocations** (unlike
  `Instruction.runtimeStats`, which resets per program invocation for the debug log):
  a correlated subquery driven once per outer row reports N executions of its inner
  instructions — the shape that makes an N+1 regression visible.
- **Drain-completeness caveat**: the snapshot is only complete once the row iterable
  is fully drained; a snapshot taken after an error is partial but kept. Forked
  parallel branches share the collector by reference (fork policy `shared-sink`), so
  their counts roll up with no merge step.
- **The premise holds only as far as plan choice is itself machine-independent**, and
  today there is one place where it is not: QuickPick join enumeration
  (`planner/rules/join/rule-quickpick-enumeration.ts`) stops after `maxTours`
  candidates *or* `timeLimitMs` of wall clock, whichever comes first. The candidates
  are deterministic; how many of them a slow or loaded machine gets through is not, so
  a join of **three or more relations** can plan differently on different hardware and
  count differently as a result. Joins below three relations never reach the rule and
  are unaffected. Tracked as `bug-join-order-depends-on-wall-clock`; until it is
  resolved, read the machine-independence claim above as holding for every statement
  whose plan does not go through QuickPick.

`WorkCounterSnapshot`, `TableWorkCounters` and `PlanShape` are exported from the
package root. `test/runtime/work-counter-stability.spec.ts` is the acceptance suite:
identical snapshots across two executions of one prepared statement, two databases at
different plan-node-id offsets, and two separate processes.

### Per-table counters, and which boundary they measure

`snapshot.tables` adds how many times the execution **asked a table for data** and how
much came back. Keyed by lowercased `<schema>.<table>`, keys sorted, each entry carrying
`queryCalls`, `rowsScanned` and `updateCalls` (insert, update and delete alike);
`totals` sums each across tables. A row count alone cannot separate a narrow index seek
from a full scan that post-filters to the same rows, and `queryCalls` is what makes an
N+1 legible: an undecorrelated correlated subquery goes from 2 calls to one per outer
row while the row count barely moves.

- **Counted at engine-owned call sites** — the `vtabInstance.query()` call and its
  `for await` loop in `runtime/emit/scan.ts` (the one door for `SeqScan`, `IndexScan`
  and `IndexSeek`), and the per-row `vtab.update()` await in
  `runtime/emit/dml-executor.ts`. So they work for every module — in-tree, wrapper or
  third-party — with nothing for a module author to implement.
- **This is the engine-to-module boundary, NOT the module-to-storage boundary.** A
  module that swaps 1000 single-key reads for one batched multi-key read moves neither
  number — the engine issued the same one `query()` either way. That layer has its own
  instrument (the counting key-value store double in `@quereus/store/testing`); these
  counters cannot catch a batching regression inside a module.
- **Keyed by table, not by scan site**: a self-join's two sites roll into one entry —
  the per-site breakdown is already in `instructions`.
- **Calls, not connects**: `RuntimeContext.scanConnections` caches the instance per scan
  site, so a nested-loop-join inner re-scan connects once but calls `query()` once per
  outer row. The call count is the work; the connect count is a caching artifact.
- **Rows counted at the scan, before any downstream operator**: a scan yielding 10000
  rows into a filter passing 3 reports `rowsScanned: 10000` and `out: 3`. A `LIMIT` or
  abort that stops a scan early leaves a partial count — the truth of what ran, and why
  a benchmark must drain fully for reproducible counters.
- **Not counted**: table access outside the instruction pipeline, where no collector
  exists — `ANALYZE`'s sampling scan (`planner/stats/analyze.ts`) and deferred constraint
  evaluation (`runtime/deferred-constraint-queue.ts` builds its own context), so a
  deferred CHECK's reads are invisible. The latter is also the only context that resolves
  a mid-execution table rename, so the scan's post-rename counter key never fires.

`test/runtime/work-counter-tables.spec.ts` pins exact counts per shape.
