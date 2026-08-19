---
description: Benchmark timings vary by machine, so a result from one laptop cannot be compared with another; add a way to read the counts of work a query actually did - how many times each step ran and how many rows it produced - because those counts come out the same on every machine.
files:
  - packages/quereus/src/runtime/types.ts                  # RuntimeContext field + Instruction label
  - packages/quereus/src/runtime/work-counters.ts          # NEW - collector + snapshot
  - packages/quereus/src/runtime/scheduler.ts              # metrics hooks feed the collector
  - packages/quereus/src/runtime/emitters.ts               # stamp plan node type onto instructions
  - packages/quereus/src/runtime/parallel-driver.ts        # fork carries the collector by reference
  - packages/quereus/src/core/statement.ts                 # builds the collector; exposes the snapshot
  - packages/quereus/test/runtime/fork-contract.spec.ts    # new field needs a fork policy + sentinel
  - packages/quereus/test/runtime/work-counter-stability.spec.ts  # NEW - stability acceptance test
  - docs/runtime.md                                        # document the surface
difficulty: hard
---

<!-- resume-note -->
## Progress (run interrupted by budget warning — no code changes made yet)

A prior agent run completed all investigation and the pre-change bench baseline, then hit
the soft token budget before editing any source file. The working tree has **zero source
changes** — resume by implementing directly; no partial-state check needed.

**Baseline bench (Phase 5 prerequisite) is DONE — do not redo it:**
- Pre-change tree (clean at HEAD), `packages/quereus` built via `yarn build`, then
  `node bench/run.mjs --filter execution` from `packages/quereus`.
- Baseline results file: `packages/quereus/bench/results/2026-08-19T10-56-27-427Z.json`
- Console copy: `tickets/.logs/2-work-counter-core.bench-baseline.log`
- After the change: rebuild, then `node bench/run.mjs --filter execution --baseline bench/results/2026-08-19T10-56-27-427Z.json`.
- Bench imports `../../dist/src/index.js` — always rebuild before benching.

**Design decisions resolved by reading the code (follow these, they dodge real traps):**

- **Do NOT feed the collector via a new `onAsyncOutput` hook.** `Scheduler.runAsyncLoop`
  does `output = await hooks.onAsyncOutput(...)` — the await flattens any promise the hook
  returns, so adding that hook to metrics mode would eagerly await every promise output at
  the producing instruction, serializing what today runs concurrently via parked promises
  + destination `Promise.all`. That changes existing metrics-mode behavior, which the
  ticket forbids.
- **Instead:** add an `index` first param to the private `RunHooks.runInstruction`
  signature in `scheduler.ts` (two call sites: `runSyncLoop`, `runAsyncLoop`); optimized/
  tracing hooks ignore it. Change `metricsHooks()` → `metricsHooks(ctx)` (one call site in
  `run()`), look up `const counters = ctx.workCounters?.countersFor(this)` once per run,
  and pass `counters?.[i]` into `runInstructionWithMetrics(instruction, ctx, args, slot?)`.
  Inside it: compute `countInputs(args)` once, add to both `stats` and slot; on output
  (sync value and inside the existing `.then(resolved => ...)`) call a
  `recordOutput(slot, value)` helper from work-counters.ts — arrays add `.length`, async
  iterables get wrapped in a counting generator (slot.out++ per yield), everything else
  adds 1. Existing `runtimeStats` lines stay byte-identical.
- **Counting-wrapper marker:** symbol whose value is the *slot* that wrapped it — skip
  only if same slot (a pass-through iterable re-counted by a different instruction's slot
  is correct double-wrapping, not a bug). Note in code: metrics mode and tracing mode are
  mutually exclusive in `Scheduler.run()` (metrics wins), so no interplay with
  `TRACED_ITERABLE_SYMBOL`.
- **Collector:** `WorkCounterCollector` holds `Map<Scheduler, WorkCounterSlot[]>` + a
  flat `walkOrder` array. Constructor walks root scheduler: program path `r`; sub-program
  at `instructions[i].programs[j]` of `P` → `P/i/j`; slot key `${path}#${i}`. Defensive:
  if a scheduler was already walked, skip (first path wins). `snapshot(plan)` filters
  `executions > 0`, builds fresh objects (by-value contract), totals summed over included
  entries.
- **Plan shape:** write an own iterative walk with a visited `Set` over `getChildren()` —
  do NOT use `PlanNode.visit()`, it deliberately visits a DAG node once **per path**
  (plan-node.ts ~line 901), which would inflate `nodeCount` nondeterministically-looking
  and double-count shared subtrees.
- **Statement wiring:** in `_iterateRowsRawInternal`, after the scheduler is
  built/reused: `this.workCounters = enableMetrics ? { collector: new
  WorkCounterCollector(scheduler), planShape: computePlanShape(blockPlanNode) } : null`,
  and put `workCounters: collector` (or undefined) on the runtime ctx. Capture planShape
  AT EXECUTION time so a schema-invalidation recompile between execution and
  `getWorkCounters()` can't pair new plan shape with old counters. `getWorkCounters()`
  returns `collector.snapshot(storedPlanShape)`. `getPlanShape()` =
  `computePlanShape(this.compile())` (works pre-execution). Null the stored pair in
  `finalize()`.
- **`Instruction.nodeType`:** optional `PlanNodeType` field on `Instruction`
  (runtime/types.ts already type-imports from planner); stamp in `emitPlanNode` right
  after `registration.emitter(plan, ctx)` returns (before the tracing wrap — wrap only
  replaces `run`).
- **No-collector contexts are already safe by construction:** `database.ts:852`,
  `deferred-constraint-queue.ts:160`, `database-assertions.ts:509` build metrics-enabled
  contexts without a collector → `countersFor` returns undefined → slot undefined →
  today's behavior. The analysis contexts (`enableMetrics: false`) never reach
  metricsHooks. No edits needed at any of those sites.
- **Existing consumer to keep green:** `test/prepared-statement-amortization.spec.ts`
  reaches into `(stmt as any).scheduler.getMetrics()` — leave `getMetrics()`,
  `runtimeStats`, the per-run reset in `onStart`, and its `NOTE:` untouched.
- **Fork contract:** `fork()` must enumerate `workCounters: rctx.workCounters` explicitly
  (the pinned-keys test derives the field list from `Object.keys(fork)`). Add
  `workCounters: 'shared-sink'` to `EXPECTED_FORK_POLICY` and a non-undefined sentinel
  (`parent.workCounters = {} as unknown as ...`) in the "shared fields are aliased to
  parent" test. Add a row to the fork-policy table in `docs/runtime-parallel.md`
  § Parallel runtime fork contract.
- **Child-process stability leg mechanics:** put shared logic in a NON-spec module
  `test/runtime/work-counter-stability-shared.ts` (mocha glob is `test/**/*.spec.ts`, so
  it won't be collected) exporting `collectSnapshots(warmupStatements: number)`. Child
  runner `test/runtime/work-counter-stability-child.ts` imports it and `process.send`s
  the result (IPC, not stdout — ts-node may chat on stdio).
  Fork from the spec with:
  `fork(childPath, [String(warmupN)], { cwd: repoRoot, execArgv: ['--import', pathToFileURL(join(repoRoot, 'packages/quereus/register.mjs')).href] })`
  — `register.mjs` sets `TS_NODE_PROJECT='./packages/quereus/tsconfig.test.json'`
  **relative to cwd**, so cwd MUST be the repo root. Give each child a different
  `warmupN` (number of dummy statements prepared before the real ones) so the two
  processes execute the real statements at different `PlanNode.nextId` offsets — that is
  what makes the cross-process leg catch an id leaking into a key. ts-node startup is
  slow: `this.timeout(120000)` on that test.
- **Stability spec extra assertions worth including:** JSON round-trip deep-equal (proves
  no bigint); metrics-off execution → `getWorkCounters()` undefined; zero-row execution →
  snapshot present with `executions > 0`, `out === 0`; correlated-subquery snapshot has
  some instruction with `executions >= outerRowCount` (the N+1-visibility claim).
- **Strict-fork leg:** run once manually, e.g.
  `QUEREUS_FORK_STRICT=1 node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/runtime/work-counter-stability.spec.ts"` from repo root
  (or `yarn workspace @quereus/quereus run test:fork-strict` for the full suite).
- **Docs:** add the work-counter section under `docs/runtime.md` § "Scheduler Execution
  Model" (after the "Scalar fusion" subsection); the fused-scalar per-operator blindness
  is already documented there — reference it rather than restating.

# What this is

The scheduler already collects per-instruction statistics when metrics mode is on
(`InstructionRuntimeStats`: `executions`, `in`, `out`, `elapsedNs`), but they are only
ever written to a debug log line in aggregate. Nothing can read them programmatically,
and three separate consumers want to: the benchmark harness (report counts beside
timings), a later regression gate (fail a build on a changed count), and the progressive
optimizer design (`docs/progressive-optimizer.md` section 5, runtime cardinality
feedback).

This ticket builds the readable surface. It does **not** gate on it and does not touch
the benchmark harness — those are downstream tickets.

## The stability requirement drives every design choice

A work counter is only worth having if it is **identical on every machine and every
run**. Two facts in this codebase actively threaten that, and the design exists to dodge
both:

1. **`PlanNode.id` is a process-global counter.** `planner/nodes/plan-node.ts` assigns
   `this.id = String(PlanNode.nextId++)` from a `private static nextId`. Two runs of the
   same query in one process get different ids, because the setup DDL and inserts built
   plan nodes in between. **No counter key may contain a plan-node id**, directly or via
   `PlanNode.toString()` (the base `toString()` returns `` `${nodeType} [${id}]` ``, and
   `emitCallFromPlan` embeds that in a `fused(...)` note). Keys are derived structurally
   instead — see below.
2. **Timings are not counters.** `elapsedNs` is deliberately **excluded** from the
   snapshot. Putting a nanosecond figure into a surface whose whole premise is
   machine-independence invites exactly the comparison this ticket exists to replace.

## Design

### Where the counters live

A new optional field on `RuntimeContext`:

```ts
/** Per-execution work-counter collector; present only when `enableMetrics` is on. */
workCounters?: WorkCounterCollector;
```

Fork policy: **`'shared-sink'`** — the policy `tracer`, `contextTracker` and `planStack`
already carry. Forks share the collector by reference, so counts from a forked branch
roll up into the parent for free with no merge step. It is a plain object field, not one
of the two maps `QUEREUS_FORK_STRICT` wraps (`context` / `tableContexts`), so
incrementing it from inside a fork cannot trip the strict-fork parent-mutation guard.

Why the context and not the instruction objects, where `runtimeStats` lives today: the
instruction tree is **cached on the Statement and reused across executions**, while a
fresh `RuntimeContext` is built per execution. Context-resident state is per-execution by
construction — the same reasoning that already puts `executionMemo`, `cacheStates`,
`cteMaterializations` and `inSetProbes` there. It is also the only place the scan and DML
emitters can reach, which the follow-on vtab-boundary ticket needs.

The existing `instruction.runtimeStats` path and its aggregate debug log stay **exactly
as they are**. This work is additive; no current debug telemetry changes.

### Instruction identity: a structural program address

`Scheduler` linearizes the instruction tree into a deterministic post-order array, so the
index into that array is stable for a given plan. Sub-programs are reachable
structurally: `emitCall` (`runtime/emitters.ts`) is the *only* site that sets
`Instruction.programs`, and it always sets `programs: [scheduler]` on the instruction
that owns it.

So the collector walks the root `Scheduler` **once**, at construction, and assigns every
program a path:

- root program: `r`
- the scheduler at `instructions[i].programs[j]` of program `P`: `P/i/j`

giving instruction keys like `r#12` and `r/12/0#3`. This is purely structural: it does
not depend on execution order, on which branch of a plan ran, or on any plan-node id.
Two runs of the same plan produce the same keys.

Each instruction also carries its **plan node type** as a label. Stamp it centrally in
`emitPlanNode` (`instruction.nodeType = plan.nodeType`) — the one place that knows both
the plan node and the instruction it produced. `PlanNodeType` values are stable strings.
The free-text `note` is **not** in the snapshot: it can embed a plan-node id, and it is
recoverable from a trace when a human needs it.

### Rows must be counted where rows are produced

`Scheduler.countOutputs` returns **1** for an async iterable, because the size is unknown
at that point. A "row count" that reports 1 for every streaming operator is not a row
count. In counter mode, wrap each async-iterable output in a counting generator that
increments `out` per yield — the same shape `wrapIterableForTracing` already uses,
including a marker symbol so an iterable is not double-wrapped when tracing is on too.
This costs one generator layer per relational instruction, paid only when counters are
on.

### Sub-programs accumulate; they do not reset

The metrics `onStart` hook zeroes `instruction.runtimeStats` on every `run()`, and a
`NOTE:` at that site records the consequence: a correlated re-evaluation's sub-program
reports its **last** invocation, not a cumulative sum. Fine for a debug log; wrong for
anything gated.

The collector's counters are **never reset mid-execution**. They are allocated once when
the collector is built (per execution) and accumulate across every invocation of every
sub-program. A correlated subquery driven 100 times reports 100 executions of its inner
scan, which is the number that makes an N+1 regression visible. Leave the existing
`runtimeStats` reset behaviour and its `NOTE:` alone.

### Snapshot shape

JSON-serializable: no bigint, no timings.

```ts
export interface WorkCounterSnapshot {
	/** Plan-shape facts. Available after compile — no execution needed. */
	plan: {
		nodeCount: number;
		/** PlanNodeType -> how many nodes of that type. Keys sorted. */
		nodeTypes: Record<string, number>;
	};
	/** One entry per instruction that ran at least once, in program-walk order. */
	instructions: Array<{
		/** Structural address, e.g. `r#12` or `r/12/0#3`. Never contains a plan-node id. */
		key: string;
		/** PlanNodeType, when the instruction came from a plan node. */
		nodeType?: string;
		executions: number;
		in: number;
		out: number;
	}>;
	totals: {
		instructionExecutions: number;
		rowsOut: number;
	};
}
```

A `tables` block (storage round trips) is added by the follow-on vtab-boundary ticket.
Leave room for it; do not build it here.

### Public surface

- `Statement.getWorkCounters(): WorkCounterSnapshot | undefined` — the last execution's
  snapshot, or `undefined` when that execution did not collect. Counts are only
  **complete** once the row iterable has been fully drained; document that plainly,
  because a caller who breaks out of a `for await` gets a partial count that will read as
  a regression.
- `Statement.getPlanShape(): WorkCounterSnapshot['plan']` — available after compile
  without executing. The planner benchmark suite only ever prepares statements, so this
  is the only counter it can report.
- Collection is gated on the **existing** switch: `enableMetrics`, i.e. the
  `runtime_stats` database option (alias `runtime_metrics`). No new option.

### Zero cost when off

The optimized scheduler path is documented as having no metrics overhead and must stay
that way. `ctx.workCounters` is undefined and `ctx.enableMetrics` is false on the default
path, so nothing is allocated and no hook is installed. Prove it by measurement, not
inspection — see the TODO.

# Edge cases & interactions

- **Plan-node ids must not leak into keys.** The stability spec is the guard: a run in a
  fresh `Database` and a run in a database that has already executed other statements
  build plan nodes at different id offsets, so any id-derived key diverges immediately.
- **Fork rollup.** `ParallelDriver.fork` must copy `workCounters` by reference, and the
  new field needs an entry in `EXPECTED_FORK_POLICY`
  (`test/runtime/fork-contract.spec.ts`) or the pinned-keys test fails by design. The
  "shared fields are aliased to parent" test populates every non-forked field with a
  non-undefined sentinel — add one there too, or that assertion passes vacuously.
- **Strict-fork mode.** Run at least one counter test under `QUEREUS_FORK_STRICT=1` to
  confirm the collector never trips the parent-mutation guard.
- **Concurrent executions of one prepared statement** are already refused
  (`Statement.busy`), so one collector per Statement execution is unambiguous. A second
  execution replaces the collector; `getWorkCounters()` returns a snapshot **by value**,
  so a caller holding an earlier one never watches it mutate.
- **Scalar fusion collapses a pure scalar subtree into one `fused(...)` instruction**
  (`emitCallFromPlan`), so per-operator counts inside it are invisible — the same
  limitation `runtime_stats` and the database-level tracer already carry, documented in
  `runtime/emitters.ts`. Do not fight it here; state it in the docs.
- **Transient and analysis contexts** (`planner/analysis/const-evaluator.ts`,
  `core/database-materialized-views-analysis.ts`, `core/derived-row-validator.ts`,
  `core/database-assertions.ts`) construct `RuntimeContext`s with `enableMetrics: false`
  and no collector. They must keep working untouched — the field is optional.
- **Zero-row execution** still produces a snapshot: `executions` is non-zero even when
  `out` is 0. A missing snapshot and an all-zero snapshot are different claims.
- **An execution that throws** leaves whatever was counted before the throw. Do not
  discard it — a partial count is diagnostic — but document that a post-error snapshot is
  partial.
- **`emitCall` sub-program identity.** The structural walk assumes `programs` is only
  ever set by `emitCall`. If a future emitter sets it directly, the walk still works
  (it is structural), but a `NOTE:` at the walk site should say the assumption out loud.

# Not in scope

Storage round trips at the virtual-table boundary (next ticket), benchmark harness
wiring, and gating on any counter.

## TODO

### Phase 1 - the collector

- Add `runtime/work-counters.ts`: `WorkCounterCollector` (walks the root `Scheduler`
  once, assigns structural program paths, allocates per-instruction counter slots) and
  `WorkCounterSnapshot` (plain JSON, no bigint, no elapsed time)
- Stamp `instruction.nodeType = plan.nodeType` centrally in `emitPlanNode`; add the
  optional field to `Instruction`
- Add `workCounters?: WorkCounterCollector` to `RuntimeContext` with a doc comment stating
  the per-execution lifetime and the shared-sink fork policy

### Phase 2 - wire the scheduler

- Feed the collector from the metrics hooks: per-instruction `executions` and `in`, plus
  an async-iterable wrapper that counts real rows for `out` (marker symbol so tracing
  does not double-wrap)
- Leave `instruction.runtimeStats`, its per-invocation reset, and the aggregate debug log
  untouched — confirm `test/prepared-statement-amortization.spec.ts` (the one existing
  `getMetrics()` consumer) still passes

### Phase 3 - expose it

- Build the collector in `Statement._iterateRowsRawInternal` when `enableMetrics` is on;
  store it on the Statement so it outlives the generator
- Add `Statement.getWorkCounters()` and `Statement.getPlanShape()`; derive plan shape by
  walking the compiled block plan's children

### Phase 4 - forks and the contract

- Carry `workCounters` through `ParallelDriver.fork` by reference; extend the fork doc
  comment
- Add the `EXPECTED_FORK_POLICY` entry (`'shared-sink'`) and the non-undefined sentinel in
  the aliasing test
- Add a line to `docs/runtime-parallel.md` section "Parallel runtime fork contract"

### Phase 5 - prove it

- Add `test/runtime/work-counter-stability.spec.ts`. For each of ~5 representative
  statements (full scan, filtered index scan, group by, correlated subquery, one
  mutation) assert the snapshots are deep-equal across: two executions of the same
  prepared statement; two fresh `Database`s in the same process; two separate child
  processes (`child_process.fork` of a small runner). The fresh-database and
  separate-process legs are what catch a plan-node id leaking into a key
- Run one counter test under `QUEREUS_FORK_STRICT=1`
- **Zero-overhead proof, by measurement:** on the pre-change tree run
  `yarn bench --filter execution` and keep the results file path; after the change run
  `yarn bench --filter execution --baseline <that file>` and require no regression beyond
  the harness's own noise floor. Record both numbers in the review handoff — an
  inspection argument is not acceptable here
- `yarn build && yarn test && yarn lint`

### Phase 6 - document

- `docs/runtime.md`: a section on the work-counter surface — what it counts, what it
  deliberately does not (no elapsed time, no per-operator detail inside a fused scalar),
  how keys are formed, and why they are stable
