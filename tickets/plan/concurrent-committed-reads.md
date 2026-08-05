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
- **Read-without-joining-transaction precedent**: deferred-constraint
  evaluation already registers connections that skip `begin()`
  (`Database.registerConnection`, the `isEvaluatingDeferredConstraints` gate).
- **Read-only classification exists**: every plan node carries
  `physical.readonly`; `PlanNode.hasSideEffects` is the accessor.
- **`VtabConcurrencyMode`** (`vtab/module.ts`) already lets a module declare
  whether concurrent reads are safe per connection.

What is missing is engine plumbing: routing eligible reads around the mutex and
onto committed-read connections.

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
  decision above).
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
  `VtabConcurrencyMode`).
