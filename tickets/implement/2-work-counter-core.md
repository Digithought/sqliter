---
description: Benchmark timings vary by machine, so a result from one laptop cannot be compared with another; add a way to read the counts of work a query actually did - how many times each step ran and how many rows it produced - because those counts come out the same on every machine.
files:
  - packages/quereus/src/runtime/types.ts                  # DONE - RuntimeContext field + Instruction label
  - packages/quereus/src/runtime/work-counters.ts          # DONE - collector + snapshot
  - packages/quereus/src/runtime/scheduler.ts              # DONE - metrics hooks feed the collector
  - packages/quereus/src/runtime/emitters.ts               # DONE - stamp plan node type onto instructions
  - packages/quereus/src/runtime/parallel-driver.ts        # DONE - fork carries the collector by reference
  - packages/quereus/src/core/statement.ts                 # DONE - builds the collector; exposes the snapshot
  - packages/quereus/src/index.ts                          # DONE - exports WorkCounterSnapshot/PlanShape types
  - packages/quereus/test/runtime/fork-contract.spec.ts    # DONE - fork policy entry + sentinel added
  - packages/quereus/test/runtime/work-counter-stability-shared.ts  # DONE (written, not yet run)
  - packages/quereus/test/runtime/work-counter-stability-child.ts   # DONE (written, not yet run)
  - packages/quereus/test/runtime/work-counter-stability.spec.ts    # NOT WRITTEN - the actual spec
  - docs/runtime.md                                        # NOT DONE - document the surface
  - docs/runtime-parallel.md                               # NOT DONE - fork-contract table row
difficulty: hard
---

<!-- resume-note -->
## Progress (third run budget-interrupted — ALL src code + fork spec landed and BUILT clean)

Runs 1-2 did investigation, bench baseline, and Phase 1 (see "Trusted facts" below).
Run 3 landed **Phases 2-4 in full plus the statement surface and exports**, and
`yarn workspace @quereus/quereus run build` **passed clean** after all src edits.
Then wrote the two test support files and was budget-stopped before writing the spec.

### DONE this run (do not redo; all compiled by the passing build)

- **emitters.ts**: `instruction.nodeType = plan.nodeType` stamped in `emitPlanNode`
  right after `registration.emitter(...)`, before the tracing wrap.
- **scheduler.ts (Phase 2 complete)**: `RunHooks.runInstruction` now takes `index`
  first param; both call sites (`runSyncLoop`, `runAsyncLoop`) pass `i`;
  optimized/tracing hooks take ignored `_index`; `metricsHooks(ctx)` looks up
  `ctx.workCounters?.countersFor(this)` once and passes `counters?.[i]` to
  `runInstructionWithMetrics(instruction, ctx, args, slot?)`, which computes
  `countInputs(args)` once (feeds both stats and slot), increments
  `slot.executions/in`, and routes both the sync return and the promise `.then`
  resolved value through `recordOutput(slot, value)`. `runtimeStats` lines
  byte-identical; doc comment explains why NOT an `onAsyncOutput` hook (the await
  would serialize parked promises).
- **statement.ts (Phase 3 complete)**: private field
  `workCounters: { collector, planShape } | null`; built in
  `_iterateRowsRawInternal` right after scheduler reuse
  (`enableMetrics ? new WorkCounterCollector(scheduler) : undefined`, planShape
  captured AT EXECUTION time via `computePlanShape(blockPlanNode)`);
  `workCounters: collector` placed on the runtime ctx; public
  `getWorkCounters()` (by-value snapshot; doc covers drain-completeness and
  post-error partials) and `getPlanShape()` (compiles, no execution); nulled in
  `finalize()`.
- **parallel-driver.ts (Phase 4 complete)**: `workCounters: rctx.workCounters` in
  `fork()` + shared-list doc paragraph (shared-sink, not strict-fork-wrapped).
- **fork-contract.spec.ts**: `workCounters: 'shared-sink'` in
  `EXPECTED_FORK_POLICY` + sentinel
  `parent.workCounters = {} as unknown as RuntimeContext['workCounters']` in the
  aliasing test. (Spec not yet executed this run.)
- **index.ts**: `export type { WorkCounterSnapshot, PlanShape }` added next to the
  runtime-utilities exports (~line 275).
- **test/runtime/work-counter-stability-shared.ts** (support module, not a spec):
  `STABILITY_CASES` (full-scan / filtered-scan / group-by / correlated-subquery /
  fixed-point `update t set b = b + 0 where a <= 3`), `TABLE_ROW_COUNT = 5`,
  `setupDatabase()` (table `t(a integer primary key, b integer)`, 5 rows,
  `db.setOption('runtime_metrics', true)`), `snapshotStatement(db, sql)`
  (prepare → drain via `stmt.all()` → `getWorkCounters()` → finalize),
  `collectSnapshots(warmupStatements)` (fresh db, N warmup `select i` execs to
  shift `PlanNode.nextId`, snapshot every case). NOTE: an earlier parse error
  (block comment terminated by a `**/*` glob literal) was fixed; diagnostics
  after the fix were not re-confirmed — `yarn lint` will type-check it.
- **test/runtime/work-counter-stability-child.ts**: reads warmup from argv[2],
  `collectSnapshots(warmup)`, reports via `process.send` (IPC not stdout),
  `process.disconnect?.()` both arms.

### REMAINING (in order)

1. **Write `test/runtime/work-counter-stability.spec.ts`** with these tests
   (design settled — implement as written):
   - *Two executions of one prepared statement*: for each `STABILITY_CASES`
     entry, prepare once, drain twice, `getWorkCounters()` after each, deep-equal.
   - *Two fresh Databases in one process*: `collectSnapshots(0)` vs
     `collectSnapshots(7)` deep-equal (different warmups strengthen the id-leak
     catch; the first call's id burn already offsets the second).
   - *Two child processes*: `this.timeout(180000)`; fork
     `work-counter-stability-child.ts` twice (warmups 3 and 11) with
     `fork(childPath, [String(warmup)], { cwd: REPO_ROOT, execArgv: ['--import', pathToFileURL(join(REPO_ROOT, 'packages/quereus/register.mjs')).href], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })`
     — `REPO_ROOT = join(__dirname, '..', '..', '..', '..')`; `register.mjs`
     resolves `TS_NODE_PROJECT` relative to cwd so cwd MUST be repo root. Collect
     `{ ok, snapshots?, error? }` from the `message` event, resolve on `exit`;
     deep-equal the two results.
   - *JSON round-trip*: `JSON.parse(JSON.stringify(snap))` deep-equals snap for
     every case (proves no bigint).
   - *Metrics off*: fresh Database WITHOUT `runtime_metrics`, drain a select,
     `getWorkCounters()` === undefined.
   - *Zero-row execution*: `select a from t where a > 1000` on the fixture —
     snapshot defined, `totals.instructionExecutions > 0`, and
     `instructions.some(i => i.out === 0)` (snapshot only includes executed
     instructions, so that entry proves executed-but-zero-rows).
   - *N+1 visibility*: correlated-subquery snapshot has
     `instructions.some(i => i.executions >= TABLE_ROW_COUNT)`. Prefer also
     asserting a `key.startsWith('r/')` sub-program entry exists, BUT verify
     empirically first — if the optimizer decorrelates the subquery into a join
     there will be no `r/` keys; in that case swap the case's SQL for one that
     provably stays a sub-program (check snapshot content by hand) or drop the
     prefix assertion and keep the executions one.
2. **Run**: `yarn workspace @quereus/quereus run test` and `yarn lint` (lint also
   type-checks test files — it is what will catch any residual error in the two
   support files). Confirm `test/prepared-statement-amortization.spec.ts` and
   `test/runtime/fork-contract.spec.ts` still green.
3. **Strict-fork leg** (run once, foreground):
   `QUEREUS_FORK_STRICT=1 node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/runtime/work-counter-stability.spec.ts"`
   from repo root (Git Bash env-prefix syntax; PowerShell needs `$env:`).
4. **Bench comparison** (baseline already recorded — see below): from
   `packages/quereus`, REBUILD first (`yarn build` — bench imports
   `../../dist/src/index.js`), then
   `node bench/run.mjs --filter execution --baseline bench/results/2026-08-19T10-56-27-427Z.json`.
   Record both numbers in the review handoff; require no regression beyond the
   harness noise floor (metrics-off path allocates nothing — `ctx.workCounters`
   undefined, `enableMetrics` false — but the ticket demands measurement, not
   inspection).
5. **Docs**: `docs/runtime.md` — new work-counter subsection after "### Scalar
   fusion" (:534) and before "### Key Points for Emitter Authors" (:602): what is
   counted, what deliberately is not (no elapsed time; fused scalars are one
   instruction — reference the existing fusion note rather than restating), how
   structural keys are formed (`r`, `P/i/j`, `#i`), why stable (no plan-node
   ids), sub-programs accumulate (N+1 visible), drain-completeness caveat.
   `docs/runtime-parallel.md` — add `workCounters | shared-sink` row to the fork
   table (rows at :25-44).
6. **Handoff**: write the review/ ticket (distilled summary + validation steps +
   bench numbers + any gaps), delete this file.

### Trusted facts from earlier runs (skip re-verification)

- **Baseline bench DONE — do not redo**: pre-change tree, `--filter execution`,
  results at `packages/quereus/bench/results/2026-08-19T10-56-27-427Z.json`;
  console copy `tickets/.logs/2-work-counter-core.bench-baseline.log`.
- tsconfig `strict` but NOT `exactOptionalPropertyTypes` — assigning
  `T | undefined` to optional fields is fine (statement.ts relies on this).
- Metrics gate: `runtime_stats` option, alias `runtime_metrics`
  (database.ts:294); `db.setOption('runtime_metrics', true)` is the test idiom.
- `test/prepared-statement-amortization.spec.ts` reaches into
  `(stmt as any).scheduler.getMetrics()` — `getMetrics()`, `runtimeStats`, the
  per-run reset in `onStart` and its `NOTE:` were left untouched (verified).
- Keys are structural (`r`, `P/i/j`, `${path}#${i}`); `PlanNode.id` is a
  process-global counter and must never appear in keys — the fresh-db and
  child-process legs are the guards.
- Slots accumulate across sub-program re-invocations (never reset mid-execution);
  `instruction.runtimeStats` still resets per program invocation (unchanged).
- No-collector metrics contexts (database.ts:852, deferred-constraint-queue.ts:160,
  database-assertions.ts:509) are safe by construction: `countersFor` returns
  undefined → slot undefined → exactly today's behavior. No edits were needed there.
- The counting-wrapper marker symbol's value is the wrapping SLOT — re-wrap by a
  different instruction's slot is correct double-counting, not a bug.
- `computePlanShape` uses an own visited-set walk over `getChildren()` — NOT
  `PlanNode.visit()` (which visits DAG nodes once per path and would inflate
  `nodeCount`).

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
run**. `PlanNode.id` is a process-global counter, so no counter key may contain a
plan-node id, directly or via `PlanNode.toString()`. Keys are derived structurally.
Timings (`elapsedNs`) are deliberately excluded from the snapshot.

## Public surface (as landed)

- `Statement.getWorkCounters(): WorkCounterSnapshot | undefined` — last execution's
  snapshot, by value; complete only once the row iterable is fully drained; a
  post-error snapshot is partial but kept.
- `Statement.getPlanShape(): PlanShape` — available after compile without executing.
- Gated on the existing `runtime_stats`/`runtime_metrics` option; no new option.
- Snapshot shape: `{ plan: { nodeCount, nodeTypes }, instructions: [{ key, nodeType?,
  executions, in, out }], totals: { instructionExecutions, rowsOut } }` — JSON-safe,
  no bigint, no timings. A `tables` block is added by the follow-on vtab-boundary
  ticket; room left, not built.

# Not in scope

Storage round trips at the virtual-table boundary (next ticket), benchmark harness
wiring, and gating on any counter.
