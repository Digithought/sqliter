description: Read-only queries currently wait behind any in-flight write — including a write stalled for many seconds on a slow network commit — even though the engine already knows how to serve the last committed data. Let opted-in reads run concurrently with a writer.
prereq:
files: packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus-store/src/common/store-module.ts
difficulty: hard
----

# Concurrent committed reads: let read-only statements run while a write is in flight

## Motivation

`Database` serializes every statement — reads included — through one
promise-chained mutex (`execMutex`, `core/database.ts`). The mutex is held
across the whole statement, including the virtual-table commit phase. For an
in-memory table a commit is microseconds, so serialization is invisible. But a
vtab commit can be an arbitrarily long I/O round: a downstream consumer
(Sereus's cadre-core, via the optimystic distributed vtab) measured a write
whose network commit stalls ~20 s against an unresponsive peer, during which
every read on that `Database` hangs. A standalone check confirmed the mutex
alone is sufficient: holding it 3 s with no I/O makes a `select count(1)` take
2955 ms against a 7 ms baseline.

During a writer's commit window, a read of the *last committed* state is safe
and is exactly what callers want. The engine's own docs already acknowledge the
seam — `_isExecuting()` is exported precisely so hosts can defer rather than
re-enter.

## What already exists (verified, not speculative)

The hard half — "serve committed state, not the writer's staged state" — is
already built:

- **`_readCommitted` module contract** (`vtab/module.ts`, `BaseModuleConfig`):
  connect option meaning "read-only view of committed, pre-transaction state".
- **`committed.<table>` schema qualifier**: planner resolves it
  (`planner/building/schema-resolution.ts`), stamps `readCommitted` on the
  table reference, and the scan emitter passes `_readCommitted: true` into the
  module connect (`runtime/emit/scan.ts`). DML against `committed.` refs is
  rejected at build time.
- **Memory vtab honours it**: committed-snapshot reads start at the
  connection's `readLayer`, skipping `pendingTransactionLayer`
  (`vtab/memory/table.ts`).
- **Isolation layer honours it**: `IsolationModule.connect` reads the flag and
  `IsolatedTable` bypasses the uncommitted overlay
  (`quereus-isolation/src/isolation-module.ts` ~line 790,
  `isolated-table.ts` ~line 405). All four persistent store plugins
  (leveldb, indexeddb, nativescript-sqlite, react-native-leveldb) wrap
  `@quereus/store`'s `StoreModule` behind this isolation layer, so they inherit
  the behavior.
- **External proof**: the optimystic vtab (separate repo) implements the same
  contract with regression tests (`committed-read.spec.ts` there). Those tests
  cover committed-read semantics inside deferred constraint checks; whether a
  committed read stays non-blocking while a distributed commit is stalled is a
  verification item tracked in that repo, not assumed here.
- **Second external implementation**: the Lamina vtab module (separate repo)
  also honours `_readCommitted` today — its `LaminaModule.connect` maps the
  flag onto the table and the read path bypasses the in-transaction staged
  overlay. See "What honouring `_readCommitted` today does NOT guarantee"
  below: that implementation, like the memory vtab's, is only correct because
  the mutex currently guarantees no read overlaps a commit.
- **Read-without-joining-transaction precedent**: deferred-constraint
  evaluation already registers connections that skip `begin()`
  (`Database.registerConnection`, the `isEvaluatingDeferredConstraints` gate).
- **Read-only classification exists**: every plan node carries
  `physical.readonly`; `PlanNode.hasSideEffects` is the accessor.
- **`VtabConcurrencyMode`** (`vtab/module.ts`) already lets a module declare
  whether concurrent reads are safe per connection.

What is missing is engine plumbing: routing eligible reads around the mutex and
onto committed-read connections — plus a sharpened module contract (next
section).

## What honouring `_readCommitted` today does NOT guarantee

Reviewing the Lamina adapter against this plan surfaced a gap that applies to
*every* module already claiming `_readCommitted` support, including the
in-tree memory vtab. Today the flag means only "do not show me the writer's
staged rows". It says nothing about **when** the underlying committed state is
read, because under the current mutex a read can never overlap a commit. Once
reads run concurrently, "read the committed store directly" and "read a
*consistent* committed state" stop being the same statement.

Concretely, a module whose commit publishes its new state incrementally —
per-column, per-index, per-chunk, or by mutating live structures in place
rather than flipping one root at the end — will let a concurrent reader
observe a half-applied commit:

- a row present in one column's structure and absent in another (torn row on
  `select *`);
- base rows materialized while the corresponding secondary/compound index
  entries are not yet built, so an *index-driven* plan silently returns fewer
  rows than a full scan of the same snapshot;
- for modules that deliberately split one logical write into several atomic
  units, a partially-applied write.

Lamina hits all three: its per-column stores are mutated in place under the
writer's write context, and its index maintenance drains after the cell
writes. Its snapshot machinery (point-in-time reads keyed by a logical clock)
can answer this correctly, but the current `_readCommitted` branch does not
use it — it reads the live structures.

So the module contract this plan depends on has to be stated as a **snapshot**
obligation, not a staged-rows-bypass obligation:

> A connection opened with `_readCommitted` must serve a state that is
> consistent as of some commit boundary at or before the moment the read
> began, and must keep serving that same state for the life of the scan —
> including across a concurrent writer's commit landing mid-iteration, and
> including across index-driven access paths.

Two acceptable implementation shapes: pin a snapshot at scan start, or publish
committed state atomically at end-of-commit so a live read can never observe a
partial one. Modules that can do neither must decline the concurrent path (see
`VtabConcurrencyMode` below) rather than answer with a torn snapshot.

Action items this adds to the plan:

- State the obligation above in the module-authoring docs for
  `_readCommitted`, not just "skips the pending transaction layer".
- Audit the in-tree memory vtab against it: does starting at `readLayer`
  remain coherent if the writer's commit publishes to that layer in steps?
- Make `VtabConcurrencyMode` the fail-closed switch: a module that cannot meet
  the snapshot obligation declares itself serial-only and the engine routes
  its reads down the existing serialized path.

## Module connection registry: broadcasts must not reach read connections

The plan already says a concurrent read must never reuse the writer's
registered connection and must never call `_finalizeImplicitTransaction`. The
Lamina adapter shows why that has to be enforced on the *engine* side rather
than left to each module: its per-connection transaction state is keyed by
`Database`, not by connection, and sibling connections cooperate idempotently
on one shared transaction. A committed-read connection that lands in the same
registry would receive `begin` / `commit` / `rollback` / savepoint broadcasts
and drive the *writer's* transaction; symmetrically, that connection
disconnecting at end-of-statement would tear down per-database transaction
state the writer still owns. Any module using a per-database (rather than
per-connection) transaction map has the same exposure.

Requirements this adds:

- Committed-read connections are held in a registry the transactional
  broadcasts (`begin`/`commit`/`rollback`/`savepoint*`) never walk — not
  merely filtered at each broadcast site, since a new broadcast site added
  later would silently reacquire the bug.
- Their disconnect must not trigger last-connection teardown of shared
  per-database state owned by the writer.
- `Database.close()` with concurrent reads in flight disposes them without
  double-disconnect and without releasing a writer-held resource.

## Required behavior

- **Opt-in.** Default behavior stays byte-identical. Today
  `void db.exec(insert); await db.get(select)` guarantees the read sees the
  insert (queue order); concurrent reads deliberately break that ordering, so
  the caller must ask for it. Proposed surface: a `StatementOptions` field
  (e.g. `readConcurrency: 'committed'`), possibly plus a database-level option
  as convenience. Exact surface is a design decision for this plan stage.
- **Eligibility.** A statement runs concurrently only when ALL hold:
  every statement in its block is read-only (`physical.readonly`), the caller
  opted in, and the database is not inside a user `BEGIN` (explicit
  transaction). Reads inside an explicit transaction always take the normal
  serialized path — they must see the transaction's own writes.
- **Committed snapshot.** A concurrent read serves the last locally committed
  state via `_readCommitted` connections. It must never see a concurrent
  writer's staged rows, and must never reuse the writer's registered
  connection (`getVTableConnection` in `runtime/utils.ts` currently reuses
  `existingConnections[0]` — the writer's — and `registerConnection`
  auto-joins new connections to the open transaction; both are wrong for this
  path).
- **No transaction interference.** Concurrent reads never begin a transaction
  and never call `_finalizeImplicitTransaction` — the current read-path
  cleanup would commit or roll back the *writer's* open implicit transaction.
  This is the sharpest correctness edge in the whole change.
- **Writers unchanged.** Writer-vs-writer serialization, explicit
  transactions, external-change ingest, and MV refresh keep the exclusive
  mutex exactly as today.

## Store modules ("update the store modules too")

The persistent store stack must be first-class in this work, not assumed:

- Raw `StoreModule.connect` (`quereus-store/src/common/store-module.ts`)
  ignores `_readCommitted` today; only the isolation wrapper honours it. Its
  own doc comment claims per-connection snapshot isolation with committed
  cross-connection reads — decide whether raw `StoreModule` must honour the
  flag directly, or whether "isolation wrapper required for concurrent reads"
  becomes a documented contract enforced at connect time. Silent
  wrong-snapshot behavior is not acceptable.
- Each store module (memory, StoreModule, isolation wrapper, and the four
  platform plugins) should declare an accurate `VtabConcurrencyMode` so the
  engine can serialize concurrent read connections against modules that need
  it.
- Concurrent read connections must not disturb store-side machinery keyed to
  the connection registry: persist queue draining, lazy reconnect
  (`store-module-schema-sync.ts`), savepoint replay on registration, and
  disconnect/collapse triggers.
- Per-backend tests: at minimum memory + StoreModule-over-memory-KV +
  isolation-wrapped, exercising "read answers with committed data while a
  write's commit is artificially stalled".

## Design decisions to settle in this plan stage

- Exact opt-in surface (per-statement, per-database, or both) and its name.
- Lifecycle of the committed-read connection scope: per-statement open/close
  vs. a cached read connection per table; who disposes it; interaction with
  `Statement` re-execution and the statement's schema-change recompile.
- Plan-time vs. run-time routing: the same prepared statement may run
  serialized (inside `BEGIN`) or concurrent (autocommit) — the
  committed-read flag must therefore bind at execution, not bake into the
  cached plan the way `committed.` references do.
- **Where the flag binds, given modules resolve it at `connect`.** The
  bind-at-execution requirement above collides with how `_readCommitted` is
  actually delivered: it rides `connect`'s options dictionary, so modules
  (Lamina and the isolation layer both do this) read it once at connect and
  store it on the table instance. "Bind at execution" therefore means "open a
  *different connection* at execution", and each such connection can be
  expensive — Lamina's takes a refcounted database handle per connection.
  Settle one of:
    (a) per-statement committed-read connection, opened and disposed around
        the scan (simple, correct, costs a connect per statement);
    (b) a cached committed-read connection per (database, table), disposed at
        database close (cheap steady-state, needs an eviction/invalidation
        story on schema change and a refcount that survives overlapping
        concurrent reads);
    (c) carry the flag on the scan call rather than on `connect`, so one
        connection can serve both modes — the largest module-contract change
        of the three, and it forces every module to make the decision
        per-scan.
  Whichever is chosen, the concurrent path must not acquire the connection
  from the same pool the writer's connection came from (see the registry
  section above).
- Interaction with `committed.<table>` and any module-specific temporal
  qualifier (`AS OF`-style historical reads, change-stream reads). Lamina's
  current `_readCommitted` branch bypasses temporal scope entirely, and its
  change-stream scope is not a row fold at all. Define precedence explicitly:
  which wins when a statement is both opted into concurrent reads and carries
  a temporal qualifier, and which qualifiers make a statement ineligible for
  the concurrent path.
- Whether the engine exposes a "reads are currently unsafe" signal a module
  can raise mid-flight. Lamina can enter a poisoned state when a commit fails
  between its durable log append and its projection apply; a concurrent reader
  holding a snapshot from before that point is arguably still correct, but
  new concurrent reads afterwards are not. Decide whether fail-closed here is
  the module's job or the engine's.
- Planning-vs-DDL race: a concurrent read plans against `SchemaManager` while
  a DDL statement may be mid-mutation. Note public `db.prepare()` already
  parses without the mutex, so the race class is not new, but decide the
  guard: a shared plan-time gate (readers shared during prepare; DDL exclusive
  during its local schema mutation, never held across vtab commit) vs.
  documented single-threaded-section reliance.
- Whether concurrent reads among themselves need throttling for modules
  declaring `'serial'` concurrency.

## Edge cases & interactions

- Read arriving while a writer is mid-commit (the motivating case) — must
  answer from committed state without waiting.
- Read arriving between a user `BEGIN` and `COMMIT` with no statement
  currently executing — must serialize and see the transaction's writes.
- Opted-in read racing an unawaited write issued earlier — allowed to serve
  pre-write state; tests must pin this as the *documented* semantics, not an
  accident.
- Read cleanup running while the writer's implicit transaction is open — must
  not touch it (`_finalizeImplicitTransaction` ownership).
- Savepoint create/release/rollback broadcasts during a concurrent read —
  must not reach committed-read connections (they are outside the
  transactional registry).
- Writer rollback while a concurrent read is mid-iteration — read result must
  stay a coherent committed snapshot.
- DDL executing while a concurrent read is planning (see the schema gate
  decision above). Note the module-side half: a module may mutate its own
  catalogue and per-table caches during DDL (Lamina clears a shared per-table
  scan-plan registry on schema refresh), so the schema gate has to cover the
  module's structures too, not only `SchemaManager`.
- A concurrent read whose plan uses a secondary or compound index while a
  writer's commit is between "base rows applied" and "index entries applied"
  — must not return a short result set (see the snapshot obligation above).
- A writer's commit that fails partway and leaves the module in a degraded or
  poisoned state while concurrent reads are mid-iteration.
- `Database.close()` while concurrent reads are in flight — connection scope
  disposal must not leak or double-disconnect.
- A mixed batch (`select; insert; select`) with the opt-in set — not
  eligible; must fall back to the serialized path, not error.
- Modules without `_readCommitted` support (raw `StoreModule` today, arbitrary
  third-party vtabs) — must fail closed: serialized fallback or explicit
  error, never a silently wrong snapshot.

## Key tests (later phases)

- Engine: stall a memory-table commit via an injected slow connection;
  opted-in read answers < deadline with pre-write values; non-opted read still
  queues (regression pin on default behavior).
- Engine: opted-in read inside explicit transaction sees uncommitted writes
  (serialized path chosen).
- Engine: read cleanup does not finalize the writer's implicit transaction
  (the writer's commit still lands with its own outcome).
- Store: same stall scenario through the isolation-wrapped StoreModule on the
  in-memory KV provider.
- Full-suite pass with the feature off proves zero default-path drift.

## Done means

- An opted-in, read-only, autocommit statement completes while another
  statement's vtab commit is blocked indefinitely, returning the last
  committed state.
- Default (non-opted) behavior is unchanged across the whole existing suite.
- Store modules either honour `_readCommitted` end-to-end or reject the
  concurrent path explicitly; each declares an accurate `VtabConcurrencyMode`.
- Docs updated where the serialization contract is stated (`database.ts`
  mutex comment, module authoring docs for `_readCommitted` +
  `VtabConcurrencyMode`), including the snapshot obligation — stated as a
  requirement out-of-tree module authors can implement against, since at
  least two out-of-tree modules (optimystic, Lamina) already claim
  `_readCommitted` support under the weaker reading.
- An engine-level conformance test a module author can run against their own
  module: with a commit artificially stalled mid-publish, a committed read
  returns a snapshot that is self-consistent across columns and across
  index-driven vs. full-scan access paths.
