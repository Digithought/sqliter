description: A caller can now mark a read-only query as willing to see slightly older data, and it runs immediately against the last saved data instead of waiting behind a slow in-progress write. Implemented, reviewed, and hardened.
files: packages/quereus/src/common/types.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/emit/remote-query.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/util/abort-signal.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/architecture.md, docs/usage.md, docs/sql-txn.md
----

# Concurrent committed reads (`readConcurrency: 'committed'`)

## What shipped

`StatementOptions.readConcurrency?: 'serialized' | 'committed'`. An eligible
read-only statement executed with `'committed'` runs WITHOUT the database's
execution mutex, against each table's last committed state — so it completes even
while another statement is parked inside a slow virtual-table commit. An
ineligible statement silently falls back to the serialized path; opting in is
never an error.

Engine shape:

- `Database._isConcurrentReadEligible(block)` — synchronous predicate over the
  optimized plan, delegating per statement to `Database.isCommittedReadSafeSubtree`.
- `Database._beginConcurrentRead()` / `ConcurrentReadScope` / a live-scope map;
  `Database.close()` aborts every live scope and awaits its `done` before teardown.
- `RuntimeContext.readCommitted`, OR-ed into the connect options by the scan leaf
  and by the remote-query (module pushdown) emitter.
- `Statement.tryRouteConcurrent` + `Statement._iterateConcurrent` — the one
  mutex-free generator; scope acquired lazily at first pull, released in `finally`.
- `util/abort-signal.ts` `combineAbortSignals` — caller signal + close signal,
  with listener disposal (no `AbortSignal.any`; Hermes reach).

The concurrent path never touches `_finalizeImplicitTransaction` /
`_ensureTransaction` / autocommit helpers, and never registers a connection.

Eligibility (all must hold): no explicit `BEGIN` open (an *implicit* transaction
does not disqualify — that is the motivating case); every statement relational;
no side-effecting node; no surviving table-valued function call; every
`TableReferenceNode`'s module declares `readCommittedSnapshot`. For `db.eval`,
also: a single-statement batch.

Docs: `docs/usage.md` § Concurrent Committed Reads, `docs/sql-txn.md` § 8.6,
`docs/architecture.md` design-decision bullet.

## Review findings

Read the implement diff (`604c4af9`) before the handoff summary. Reviewed for
correctness, gate completeness, resource cleanup, cancellation, DRY, docs
accuracy, and test coverage.

### Fixed in this pass (minor)

- **The eligibility gate let table-valued functions through, including ones that
  execute arbitrary SQL.** `TableFunctionCallNode` exposes no `TableReferenceNode`
  (so the module gate passed vacuously) and `computePhysical` hardcodes
  `readonly: true` (so the side-effect check passed too). Verified empirically
  before the fix: `select * from row_trace('insert into t values (99, ''z'')')`
  with `readConcurrency: 'committed'` ran mutex-free and the INSERT landed — a
  write executing outside the execution mutex while another statement could be
  mid-commit. The implement handoff had flagged TVFs as "accepted by construction
  rather than separately audited"; auditing them turned up the hole. Now refused
  outright (fail closed, matching the module contract's opt-in-or-serialize
  discipline), with the walk extracted into
  `Database.isCommittedReadSafeSubtree`. Two regression tests added. Note: a
  constant-argument deterministic TVF (`json_each('[1,2]')`) const-folds to a
  table literal before the gate runs; that literal reads nothing, so it stays
  eligible — correct, and called out in the test comment.
- **`RuntimeContext.readCommitted` was not propagated by the module-pushdown
  emitter.** `runtime/emit/remote-query.ts` connects with a hardcoded `{}` config,
  so a plan containing a `RemoteQueryNode` would have opened a normal connection
  during a mutex-free read — joining the writer's transaction, exactly what the
  path forbids. Dormant today (only `test/vtab/test-query-module.ts` implements
  `executePlan`, and it does not declare `readCommittedSnapshot`), but silently
  wrong the moment a module does both. Fixed to mirror the scan leaf. The
  pre-existing omission of `vtabArgs` at the same site is left alone, with a NOTE.
- **`getVTableConnection`'s new assertion is in a function with zero callers.**
  Grepped the whole repo (`packages/**`, all extensions, excluding `dist/`): the
  helper is not called anywhere and is not exported from `src/index.ts`. The
  handoff presents it as the guard covering the transaction-joining path; it
  guards nothing today. Left in place with a NOTE saying so, so the next reader is
  not misled. Removing the dead helper is a separate hygiene call.
- **Overlapping executions of one prepared `Statement` now throw.** `Statement`
  carries per-execution state (`boundArgs`, the `busy` flag); the mutex used to
  make overlap impossible, and mutex-free reads expose it, so a shared hot
  statement gets `MisuseError: Statement busy`. Verified. Documented in
  `docs/usage.md` and pinned by a test; the real fix is filed (below).
- **Test-file DRY.** The duplicated "memory module minus the flag" setup and the
  duplicated "assert this did not settle while the writer is parked" dance are now
  `registerNoSnapshotModule()` and `expectSerialized()`; the existing
  default-path-serialization test was rewritten onto the latter.

### Filed as tickets (major)

- `backlog/bug-execution-trace-hangs-forever` — `execution_trace('<any sql>')`
  deadlocks forever on every call (its body issues a nested top-level `db.eval`
  while the outer statement holds the execution mutex). Verified repro on a clean
  database with no options passed; predates this ticket entirely, found while
  auditing what the TVFs do. `row_trace` does the same job without the nested
  query and works.
- `backlog/feat-reusable-statement-across-concurrent-reads` — separating a
  `Statement`'s compiled form from its per-execution state so N concurrent reads
  can share one prepared query. Interface change with knock-on effects on the
  parameter-binding API; not a fix-in-place.

### Checked and found clean

- **Gate completeness against hidden sub-plans.** Walked every planner node whose
  sub-tree is deliberately *not* in `getChildren()` (`IndexSeekNode.pushedConstraints`,
  `RetrieveNode.bindings`, `LensAuxiliaryAccessNode.auxScan` — all tagged OPT-009).
  Each is inert at emit time (no emitter reads it), so nothing reachable at
  runtime escapes the walk. `Filter`/`Project`/`Join` all expose their scalar
  children, so subquery table references are covered — verified empirically:
  `select * from t where id in (select id from u)` with an unqualified `u` is
  correctly ineligible.
- **Views.** Both directions tested: an unqualified table reached through a view
  disqualifies; a view over a qualified table stays concurrent. The gate runs on
  the optimized plan, so the view is already inlined.
- **Parameter binding on the concurrent path.** `db.get(sql, params, opts)` binds
  at `prepare()` and passes `undefined` onward; correct, and now tested.
- **Side-effecting statements.** `insert ... returning` with the opt-in falls back
  and still writes — tested.
- **`Database.close()` scope draining.** No synchronous mutation of the scope map
  during the abort loop, and `_beginConcurrentRead`'s `checkOpen()` closes the
  register-after-close window. `end()` is idempotent via the map delete.
- **`combineAbortSignals`.** Listener bookkeeping is correct on all three arms
  (zero / one / many signals), including the already-aborted early break; `dispose()`
  detaches everything it attached.
- **Fork policy.** `readCommitted` is set once per execution and only ever read;
  `shared-frozen` in `fork-contract.spec.ts` is the right classification.
- **Doc links.** `docs/module-authoring.md#4-committed-snapshot-reads-_readcommitted`,
  `usage.md#concurrent-committed-reads-readconcurrency`, and
  `sql-txn.md#86-concurrent-committed-reads` all resolve to real headings.
- **Deviations 1–5 in the implement handoff** (implicit-transaction allowance,
  relational-statement requirement, lazy scope acquisition, bare generator return,
  the `registerConnection` stall harness) — each re-derived from the code and
  agreed with.

### Noted, not filed

- `packages/quereus/src/core/database.ts` is 2770 lines (`wc -l`); this change
  added roughly 200 of them. Large, but pre-existing and not caused by this work,
  and no open ticket claims the file for a split. Recording the measurement rather
  than filing, since splitting it is a decision about the whole file, not this
  diff.
- `disconnectVTable(ctx, vtab)` in `src/runtime/utils.ts` has an unused `ctx`
  parameter (compiler hint, pre-existing, untouched by this diff).

### Tripwires recorded in code

- `src/core/database.ts`, in `isCommittedReadSafeSubtree`: rejecting every TVF also
  rejects pure ones like `json_each`; if a pure TVF ever needs this path, add an
  explicit opt-in flag to the table-valued function schema and gate on it there.
- `src/runtime/emit/remote-query.ts`: the connect call still drops the table's
  `vtabArgs` (pre-existing); thread them through if a pushdown-capable module ever
  needs them.
- `src/runtime/utils.ts`: `getVTableConnection` currently has no callers, so its
  committed-read guard is a standing precondition rather than an active net.

### Known limits carried forward (unchanged from the implement handoff)

- `Database.close()` waits for the consumer: a concurrent read parked at a `yield`
  unwinds only at the consumer's next pull, so an abandoned iterator delays close.
  Inherent to cooperative cancellation; no timeout belt added.
- Routing compiles early and logs-then-swallows compile errors, relying on
  `Statement.compile()` not memoizing failures. True today; still not pinned by a
  test.
- Module-side registration cannot be blocked from the engine — that half is the
  module contract's; the no-registration test pins it for the memory vtab only.

## Validation

From the repo root: `yarn build` ✔, `yarn lint` ✔ (all workspaces),
`yarn test` ✔ (0 failing; the new spec is 19 tests, all passing),
`yarn test:store` ✔ (8730 passing, 21 pending, 0 failing).

## How to exercise it

```ts
const row = await db.get('select count(*) as n from t', undefined, { readConcurrency: 'committed' });
```

Just the spec: `cd packages/quereus && yarn test --grep "concurrent committed reads"`.
