description: A caller can now mark a read-only query as willing to see slightly older data, and it runs immediately against the last saved data instead of waiting behind a slow in-progress write. Implemented and tested; needs an adversarial review pass.
files: packages/quereus/src/common/types.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/util/abort-signal.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/architecture.md, docs/usage.md, docs/sql-txn.md
----

# Review: mutex-free committed-read path (`readConcurrency: 'committed'`)

## What was built

The opt-in from the implement ticket, wired end to end:

- `StatementOptions.readConcurrency?: 'serialized' | 'committed'` (`common/types.ts`) with the ordering-tradeoff caveat spelled out in the doc comment.
- `Database._isConcurrentReadEligible(block)` — pure synchronous predicate over the optimized plan: no explicit transaction open, every statement relational, no side-effecting node in any subtree, every `TableReferenceNode`'s module declares `readCommittedSnapshot` (via `getModuleReadCommittedSnapshot`). Carries the NOTE pointing at `backlog/debt-concurrent-reads-schema-gate` for the deliberately-omitted plan-time schema gate.
- `Database._beginConcurrentRead()` / exported `ConcurrentReadScope` / a live-scope map; `Database.close()` now aborts every live scope and awaits its `done` before its existing teardown.
- `RuntimeContext.readCommitted`; the scan emitter ORs it with the per-reference `committed.<table>` flag into the connect options; `getVTableConnection` throws `StatusCode.INTERNAL` when set (assertion that the read-only gate held — it is the transaction-joining path).
- `Statement.tryRouteConcurrent` (sync, never throws — compile failure logs and falls back so the error re-surfaces identically on the serialized path) + `Statement._iterateConcurrent` (the one mutex-free generator: scope acquire, signal combine, `readCommitted: true`, scope end in `finally`). Concurrent branches in `Statement.get/all/iterateRows/run`; `Database.eval` routes via a delegating generator (single-statement + eligible → concurrent; else `yield*` into the untouched serialized path so its transaction-finalize cleanup still runs on early exit). `Database.get` flows through `Statement.get` unchanged. `Database.exec` ignores the option (documented).
- New `util/abort-signal.ts` — `combineAbortSignals(...)` with listener disposal (no `AbortSignal.any`; Hermes reach).
- The concurrent path never touches `_finalizeImplicitTransaction` / `_ensureTransaction` / autocommit helpers, and never registers a connection.

## Deviations from the ticket spec (each deliberate — verify you agree)

1. **Eligibility condition 2 is "no *explicit* transaction", not "`getAutocommit()` is true".** Verified in `database-transaction.ts`: `isAutocommit` is `false` during an *implicit* transaction too — including the entire commit window. The ticket's literal condition would have rejected the motivating case (a read arriving while a writer is parked in its vtab commit holds an open implicit transaction). Implemented as `getAutocommit() || isImplicitTransaction()`, matching the ticket's stated intent and its edge-case list.
2. **Eligibility also requires every statement to be relational.** `TransactionPlanNode` (`BEGIN`/`COMMIT`/...) and other void nodes default `physical.readonly: true`, so the ticket's readonly-only check would have routed `BEGIN` mutex-free. `isRelationalNode` per statement closes that.
3. **The `ConcurrentReadScope` is acquired lazily at the generator's first pull, not in `tryRouteConcurrent`.** The ticket sketch returned a scope from routing; that would leak a scope (and hang `close()`) for an iterator that is created but never consumed. Routing returns a boolean; the scope lives entirely inside `_iterateConcurrent`'s try/finally. A `BEGIN` landing between routing and first pull is the ticket's already-documented non-invalidating race.
4. **Concurrent `iterateRows`/`all` return the bare generator, not a `wrapAsyncIterator` with a no-op cleanup.** The generator's own `finally` is the cleanup; the wrapper would add nothing.
5. **Test stall harness patches `db.registerConnection` instead of a wrapper module.** The memory table registers its connection itself from inside `ensureConnection`, out of a wrapper module's reach; the patch wraps each registered connection's `commit()` behind an armable gate — same interleaving the ticket wanted (writer parked *inside* commit), fully deterministic.

## Test coverage (`test/core/concurrent-committed-reads.spec.ts`, 12 tests)

Motivating case (opted-in read resolves with the pre-write value while the writer is parked mid-commit, then the writer still lands); default-path serialization pin; explicit-transaction fallback (sees own uncommitted writes); connection-count unchanged before/during/after; mixed-batch `eval` fallback; single-statement `eval` concurrent; unqualified-module fallback; multi-table universal gating (join with one unqualified table); `close()` mid-iteration (AbortError + close resolves); caller-signal abort; unawaited-write-invisible documented semantics; `stmt.all`/`run` under a parked writer. Plus: `fork-contract.spec.ts` extended for the new `RuntimeContext.readCommitted` field (policy `shared-frozen`; `ParallelDriver.fork` copies it).

Validation run: `yarn build` ✔, `yarn lint` ✔, `yarn test` ✔ (8730 passing quereus, all workspaces green), `yarn test:store` ✔ (8722 passing, 21 pending, 0 failing).

## Known gaps / review targets (starting points, not a finish line)

- **`close()` waits for the consumer.** A concurrent read parked at a `yield` unwinds only at the consumer's next `next()`/`return()`. An abandoned, never-again-pulled iterator delays `close()` indefinitely. Documented at the drain site in `close()` and in the scope doc comment; inherent to cooperative cancellation, but a reviewer may want a belt (e.g. a scope-side timeout) — none was added.
- **Routing compiles early and swallows compile errors** (logged, then serialized path re-raises them). Rests on `Statement.compile()` not memoizing failures — true today; nothing pins that assumption in a test.
- **`getVTableConnection` is the only engine-side `registerConnection` caller holding a `RuntimeContext`** (audited: the MV-maintenance and attach-reconcile registration sites run only on write/DDL paths, unreachable from an eligible plan). The audit is a claim in this handoff, not a guard — a future `RuntimeContext`-holding registration site would bypass the assertion.
- **TVFs pass the table gate vacuously** (no `TableReferenceNode`), so e.g. `select * from schema()` can run mutex-free. Catalog reads are synchronous snapshots, so this looks safe, but it was accepted by construction rather than separately audited.
- **Module-side registration cannot be blocked from the engine** — that half is the prereq ticket's module contract; the no-registration test pins it for the memory vtab only.
- **The `eval` concurrent branch prepares eagerly at first pull** and finalizes the statement in its `finally`; an iterator consumed partially then abandoned without `return()` leaves the statement to be finalized at `close()` (same as the pre-existing serialized `eval` shape).
- Sibling ticket `implement/3-concurrent-reads-conformance` (not touched here) covers broader conformance; nothing in this change anticipates its content.

## How to exercise it

```ts
const row = await db.get('select count(*) as n from t', undefined, { readConcurrency: 'committed' });
```

Run just the new spec: `cd packages/quereus && yarn test --grep "concurrent committed reads"`.

Docs updated: `docs/usage.md` (§ Concurrent Committed Reads — opt-in, eligibility, the ordering footgun), `docs/sql-txn.md` (§ 8.6 — transaction interactions), `docs/architecture.md` (design-decision bullet next to the module concurrency contract), plus the corrected `execMutex` doc comment in `core/database.ts`.
