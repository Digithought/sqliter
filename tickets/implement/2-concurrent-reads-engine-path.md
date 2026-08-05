description: Today every query waits its turn behind any write in progress, even a write stuck for many seconds saving to a slow network. Let a caller mark a read-only query as willing to see slightly older data, and run it immediately against the last saved data instead of waiting.
prereq: concurrent-reads-module-gate
files: packages/quereus/src/common/types.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/vtab/concurrency.ts, docs/architecture.md, docs/usage.md, docs/sql-txn.md
difficulty: hard
----

# Mutex-free committed-read path for opted-in read-only statements

## The problem

`Database` serializes every statement — reads included — through one
promise-chained mutex (`execMutex`, `core/database.ts` ~line 123). The mutex is
held across the whole statement *including* the virtual-table commit. For an
in-memory table a commit is microseconds, so serialization is invisible. For a
network-backed vtab it is an arbitrarily long I/O round: a downstream consumer
measured a write whose commit stalls ~20 s against an unresponsive peer, during
which every read on that `Database` hangs. A standalone check confirmed the
mutex alone is sufficient to cause it — holding it 3 s with no I/O makes a
`select count(1)` take 2955 ms against a 7 ms baseline.

During a writer's commit window, a read of the *last committed* state is safe
and is exactly what those callers want.

## What is already in place (verified against the code, not assumed)

The read-committed machinery mostly exists; what is missing is the routing.

- **`_readCommitted` connect option** (`vtab/module.ts`, `BaseModuleConfig`) and
  the `committed.<table>` schema qualifier that sets it per table reference.
- **`readCommittedSnapshot` module flag** — added by the prereq ticket; `true`
  on the memory vtab and `false` everywhere else (fail closed). Note the
  isolation wrapper does **not** inherit it: review found it re-serves one
  memoized underlying handle to committed reads while flushing overlays through
  that same handle incrementally, so it declares `false` unconditionally until
  `fix/bug-isolation-committed-read-shares-writer-handle` lands. Only a bare
  memory-vtab table takes the concurrent path for now.
- **The scan emitter already connects per scan site, per execution.**
  `runtime/emit/scan.ts` calls `module.connect(...)` directly (~line 107) —
  it does *not* go through `getVTableConnection` — caches the instance in
  `RuntimeContext.scanConnections` keyed by a per-scan-site symbol, and
  `Statement._iterateRowsRawInternal`'s `finally` disconnects each cached
  instance exactly once (`core/statement.ts` ~line 405).

  **This is the decisive fact for the design.** "Bind the committed-read flag at
  execution, not at plan time" does not require a new connection pool, a cache
  keyed by `(database, table)`, or a per-scan module-contract change. It
  requires only that `connect`'s options dictionary gain `_readCommitted: true`
  for this execution. The engine already pays exactly one `connect` per scan
  site per execution today, so the concurrent path costs **no additional
  connect** — the objection that a module's connect may be expensive (a
  refcounted database handle per connection, say) does not apply, because the
  count is unchanged.
- **Read-without-joining-a-transaction precedent** — deferred-constraint
  evaluation already registers connections that skip `begin()`
  (`Database.registerConnection`, the `isEvaluatingDeferredConstraints` gate,
  ~line 2090).
- **Read-only classification** — every plan node carries `physical.readonly`;
  `PlanNode.hasSideEffects` is the accessor.
- **Schema-race defences already exist** — `Statement.compile()` is fully
  synchronous (no `await`), so it cannot interleave with an awaited DDL step;
  `EmissionContext.validateCapturedSchemaObjects()` re-checks captured schema
  objects at execution start (`statement.ts` ~line 385); and the schema-change
  notifier invalidates a compiled plan. `db.prepare()` is already mutex-free, so
  planning outside the mutex is not a new race class.

## Design

### Opt-in surface — per statement only

```ts
// common/types.ts
export interface StatementOptions {
	signal?: AbortSignal;
	/**
	 * Read concurrency for this execution.
	 *
	 * - `'serialized'` (default) — queue behind the execution mutex. The read
	 *   sees whatever an already-queued write left behind, exactly as today.
	 * - `'committed'` — when the statement is eligible, run WITHOUT the mutex
	 *   against each table's last committed state, so the read completes even
	 *   while another statement is blocked in its virtual-table commit. An
	 *   ineligible statement silently falls back to `'serialized'`.
	 *
	 * `'committed'` deliberately gives up the ordering guarantee that
	 * `void db.exec(insert); await db.get(select)` shows the insert — the read
	 * may serve the pre-insert state. That is why it is opt-in per call.
	 */
	readConcurrency?: 'serialized' | 'committed';
}
```

No database-level default in this ticket. A database-wide switch would silently
change that ordering guarantee for every read in a codebase, including reads
written years before the switch was flipped; the per-call form makes the
tradeoff visible at the site that accepts it. A convenience default is parked in
`backlog/feat-concurrent-reads-database-default`.

`StatementOptions` is already threaded through every execution entry point, so
no new parameter plumbing is needed.

### Which entry points honour it

Honour `readConcurrency` on the row-returning paths: `Database.get`,
`Database.eval`, `Statement.get`, `Statement.all`, `Statement.iterateRows`,
`Statement.run`.

`Database.exec` **ignores** it (document this). `exec` returns no rows, so a
concurrent read through it has no consumer, and its per-statement
implicit-transaction loop is exactly the machinery the concurrent path must not
touch.

### Eligibility — all must hold, else silent fallback

Never an error. Falling back to the serialized path is always correct.

1. `options.readConcurrency === 'committed'`.
2. The database is in autocommit — `transactionManager.getAutocommit()` is
   `true`. Reads inside an explicit `BEGIN` must see the transaction's own
   writes, so they always serialize.
3. The compiled block is read-only: every statement in `block.statements`
   satisfies `!PlanNode.hasSideEffects(stmt)`.
4. Every `TableReferenceNode` in the optimized plan resolves to a module with
   `getModuleReadCommittedSnapshot(module) === true`. Walk the tree the way
   `planner/building/constraint-builder.ts` (~line 313) already walks for
   `readCommitted` references. Because the check runs on the *optimized* plan,
   tables reached through views and materialized views are covered.
5. For `Database.eval`: `stmt.astBatch.length === 1`. A multi-statement batch
   falls back wholesale — this is what makes `select; insert; select` with the
   opt-in take the serialized path rather than erroring.
6. The database is open (`checkOpen()` as today).

Add on `Database`:

```ts
/** @internal True when this optimized block may run on the mutex-free
 *  committed-read path. Pure predicate — no side effects, no awaits. */
_isConcurrentReadEligible(block: BlockNode): boolean;
```

Condition 2 is evaluated at routing time. A `BEGIN` that lands *after* routing
does not invalidate an in-flight concurrent read: that read is already pinned to
a committed snapshot and simply does not see the new transaction's writes, which
is the documented semantics.

### Routing

`Statement.compile()` is synchronous, so routing can be decided in the
*synchronous* body of each public method — before any generator is constructed —
which is what lets the two paths use structurally different wrappers instead of
a mutable flag:

```ts
// statement.ts
/** @internal Returns a live scope when this execution takes the concurrent
 *  committed-read path, else null (caller takes the serialized path). */
private tryRouteConcurrent(options?: StatementOptions): ConcurrentReadScope | null {
	if (options?.readConcurrency !== 'committed') return null;
	const block = this.compile();                       // synchronous
	if (!this.db._isConcurrentReadEligible(block)) return null;
	return this.db._beginConcurrentRead();
}

iterateRows(params?, options?) {
	const scope = this.tryRouteConcurrent(options);
	return scope
		// No mutex; NO _finalizeImplicitTransaction — see below.
		? wrapAsyncIterator(this._iterateConcurrent(params, options, scope), () => {})
		: wrapAsyncIterator(this._iterateRowsGenerator(params, options?.signal),
			(commit, error) => this.db._finalizeImplicitTransaction(commit, error));
}
```

The serialized branch must stay byte-identical to today, including when it
compiles (lazily, inside the mutex). Only the concurrent branch compiles early.

### The sharpest correctness edge: `_finalizeImplicitTransaction`

A concurrent read must **never** call `Database._finalizeImplicitTransaction`.
The writer it is running alongside owns the open implicit transaction; the read
path's normal cleanup would commit or roll back *the writer's* transaction. The
concurrent branch therefore uses a no-op completion callback, and must not call
`_ensureTransaction` / `_autocommitIfNeeded` / `_autorollbackIfNeeded` either.
This is a test target, not just a code comment.

### Committed-snapshot plumbing

```ts
// runtime/types.ts — RuntimeContext
/** When true, every table scan in this execution connects with
 *  `_readCommitted: true` and no connection joins the writer's transaction. */
readCommitted?: boolean;
```

`runtime/emit/scan.ts` (~line 105) becomes:

```ts
...((source.readCommitted || runtimeCtx.readCommitted) ? { _readCommitted: true } : {})
```

That is the whole binding. The prepared plan is untouched, so the *same* cached
plan runs serialized inside `BEGIN` and concurrent in autocommit — which is
exactly the "bind at execution, not at plan time" requirement.

`runtime/utils.ts` `getVTableConnection` must throw `QuereusError`
/ `StatusCode.INTERNAL` when `ctx.readCommitted` is set. A read-only plan should
never reach it (it is the transaction-joining path — it reuses
`existingConnections[0]`, which is the *writer's* connection, and
`registerConnection` auto-joins new connections to the open transaction). The
throw is an assertion that the eligibility gate held, not a control-flow branch.
Same treatment for any other engine-side site that calls
`Database.registerConnection` from a `RuntimeContext`.

Module-side registration cannot be blocked from the engine (a module calls
`db.registerConnection` with no `RuntimeContext` in hand). That half is the
module contract from the prereq ticket, pinned here by a test asserting
`db.getAllConnections().length` is unchanged across a concurrent read.

### Cancellation and `Database.close()`

```ts
/** @internal Live concurrent-read scopes. */
private concurrentReads = new Set<ConcurrentReadScope>();

/** @internal Registers a concurrent read; the returned scope carries an
 *  AbortSignal that `close()` fires, and an `end()` the read calls on every
 *  exit path. */
_beginConcurrentRead(): ConcurrentReadScope;
```

`ConcurrentReadScope` = `{ signal: AbortSignal; done: Promise<void>; end(): void }`.
The execution's effective signal is the caller's signal combined with the
scope's (add a small `anySignal`-style helper if none exists in `util/`).

`Database.close()` currently disconnects registered connections and finalizes
statements. It must now, *first*, abort every live scope and await their `done`
promises, then proceed as today. A concurrent read that is mid-iteration when
`close()` runs rejects with `AbortError` at its next row boundary
(`throwIfAborted` in the scan loop, `scan.ts` ~line 154), and its vtab instances
are released by the existing `scanConnections` teardown in
`_iterateRowsRawInternal`'s `finally` — so no double-disconnect and no leak.

### Why no plan-time schema gate

Considered and deliberately not built. The residual risk is covered:

- `Statement.compile()` is synchronous, so it cannot observe a half-applied
  multi-step DDL — it sees the catalog either wholly before or wholly after any
  awaited DDL step.
- `validateCapturedSchemaObjects()` re-checks at execution start, and the
  schema-change notifier invalidates the cached plan.
- For the *long* window (the scan itself), the snapshot obligation the prereq
  ticket puts on `readCommittedSnapshot` already requires the module to keep
  serving its pinned snapshot across concurrent DDL. For the memory vtab this
  holds structurally: the pinned `readLayer` is an immutable BTree the reader
  holds a reference to, so a concurrent `ALTER`/`DROP` yields a *stale but
  coherent* snapshot — which is the documented semantics, not corruption.

A shared/exclusive plan-time gate becomes necessary only if a module that cannot
pin across DDL ever wants onto this path; that is parked as
`backlog/debt-concurrent-reads-schema-gate`. Add a `NOTE:` comment at
`_isConcurrentReadEligible` pointing at it.

### Not in this ticket

- **Throttling concurrent reads against each other.** Each concurrent read opens
  its own connection, so `VtabConcurrencyMode` (a per-*connection* property) does
  not apply. Cross-connection safety is exactly what `readCommittedSnapshot`
  declares.
- **Two concurrent executions of the same prepared `Statement`.** Already
  refused by the existing `busy` guard, and unchanged here. Concurrency is
  across statements. `Database.get`/`eval` mint a fresh `Statement` per call, so
  the motivating case works.

## Edge cases & interactions

- Read arriving while a writer is mid-commit — the motivating case; answers from
  committed state without waiting.
- Read arriving between `BEGIN` and `COMMIT` with nothing executing — serializes
  and sees the transaction's writes.
- Opted-in read racing an unawaited write issued earlier — allowed to serve the
  pre-write state. Pin this as *documented semantics* in a test, not as an
  accident of timing.
- Concurrent read completes while the writer's implicit transaction is still
  open — the writer's commit must still land with its own outcome.
- Savepoint create/release/rollback-to broadcasts during a concurrent read —
  cannot reach it, because it holds no registered connection.
- Writer *rollback* mid-iteration — the read's result stays a coherent committed
  snapshot (it never saw the staged rows).
- Mixed batch (`select; insert; select`) with the opt-in — falls back to
  serialized, no error.
- Statement over a module without `readCommittedSnapshot` — falls back to
  serialized, no error. Includes every store-backed table today.
- Multi-table statement where only some tables' modules qualify — ineligible
  (condition 4 is universal, not existential).
- `Database.close()` mid-iteration — abort + drain, no leak, no double
  disconnect.
- A concurrent read that throws mid-iteration — `scope.end()` must run on every
  exit path (completion, `break`, error, abort), or `close()` hangs.
- `committed.<table>` reference inside a concurrent read — already
  `_readCommitted`; the OR in the scan emitter makes it a no-op, not a conflict.

## Key tests

New `packages/quereus/test/core/concurrent-committed-reads.spec.ts`. The stall
harness is a thin wrapper module around `MemoryTableModule` that delegates
everything (including `readCommittedSnapshot`) but whose connection `commit()`
awaits a manually-released promise.

- **Motivating case** — seed a row; start an unawaited write; with the writer
  parked in `commit()`, `db.get(select, [], { readConcurrency: 'committed' })`
  resolves with the *pre-write* value **before** the stall is released. Assert
  the ordering explicitly (race the read against a marker), not via a timeout.
- **Default-path regression pin** — same setup, no opt-in: the read does *not*
  resolve until the stall is released.
- **Explicit transaction** — inside `BEGIN`, an opted-in read sees the
  transaction's own uncommitted writes (proves the serialized path was chosen).
- **Writer's transaction untouched** — after a concurrent read completes during
  the writer's implicit transaction, releasing the stall still commits the
  writer's row.
- **No registration** — `db.getAllConnections().length` is identical before,
  during and after a concurrent read.
- **Mixed batch** — `db.eval('select …; insert …', …, { readConcurrency:
  'committed' })` falls back; no error.
- **Unqualified module** — a stub module without `readCommittedSnapshot` falls
  back; no error; result is correct.
- **Close during read** — `db.close()` while a concurrent read is mid-iteration:
  the iteration rejects with `AbortError` and `close()` resolves.
- **Caller abort** — an `AbortSignal` passed alongside `readConcurrency:
  'committed'` still cancels at a row boundary.
- **Zero default drift** — the full existing suite passes unchanged
  (`yarn test`), and `yarn test:store` for the store path.

## Docs

- `docs/architecture.md` — the serialization contract paragraph and the module
  concurrency bullet (~line 199): describe the concurrent committed-read path,
  its opt-in, and that it is gated on `readCommittedSnapshot`.
- `docs/usage.md` — `readConcurrency` on `StatementOptions`, with the ordering
  caveat spelled out in plain language.
- `docs/sql-txn.md` — how the path interacts with implicit and explicit
  transactions (never joins one; always serializes inside `BEGIN`).
- The `execMutex` doc comment in `core/database.ts` (~line 118) — it currently
  states unconditional serialization; correct it and point at the new path.

## TODO

- `readConcurrency` on `StatementOptions`.
- `Database._isConcurrentReadEligible(block)` + the `TableReferenceNode` walk +
  the `NOTE:` tripwire about the deferred schema gate.
- `Database._beginConcurrentRead()` / `ConcurrentReadScope` / the
  `concurrentReads` set; `close()` aborts and drains before its existing work.
- `RuntimeContext.readCommitted`; OR it into `scan.ts`'s connect options.
- `getVTableConnection` assertion throw when `ctx.readCommitted`; audit for any
  other `RuntimeContext`-holding `registerConnection` caller and do the same.
- `Statement.tryRouteConcurrent` + concurrent branches in `get`, `all`,
  `iterateRows`, `run`; `Database.get` / `Database.eval` equivalents. Serialized
  branches untouched.
- Signal-combining helper if `util/` has none.
- Tests above; docs above.
- `yarn build`, `yarn lint`, `yarn test`, then `yarn test:store`.
