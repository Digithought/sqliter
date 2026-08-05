---
description: Make the engine's fire-and-forget "just run this SQL" call actually run queries that return rows, instead of planning them and then silently skipping the work.
files:
  - packages/quereus/src/core/database.ts          # _executeSingleStatement (~line 805-838) — runs the scheduler, discards the result; exec() JSDoc ~line 862-886
  - packages/quereus/src/core/statement.ts         # _iterateRowsRawInternal (~line 348-425) — the existing drain + scanConnections teardown to mirror
  - packages/quereus/src/runtime/utils.ts          # isAsyncIterable, disconnectVTable
  - packages/quereus/src/runtime/emit/scan.ts      # ~line 78-90 — per-execution connection cache; falls back to self-owned connect/disconnect when absent
  - docs/runtime.md                                # "Side effects must not live in a generator body" (~line 406-417) — states the OLD rule; must be rewritten
repro: verified
difficulty: easy
---

# `Database.exec` must drain a row-returning statement's result

## Problem (re-verified on `main` at `3b0e956c`)

`Database._executeSingleStatement` ends with:

```ts
await scheduler.run(runtimeCtx);
```

The scheduler's return value for a statement that produces rows is an un-started
`AsyncIterable<Row>`. Nothing pulls from it, so the query never executes. Reproduced with a
scalar UDF counting its own invocations:

```
calls after exec('select boom(id) from t'): 0
calls after eval('select boom(id) from t'): 3
```

Statements with no rows to return (DDL; DML, which the builder wraps in a `SinkNode`) are
unaffected — hence the bug being invisible until a row-returning statement acquired an effect
(`analyze`, `pragma x = y`), each of which was then patched at the statement instead of here.

## Decision

Drain it. The ticket was promoted from `backlog/` into `fix/` by a human, which settles the open
question the backlog ticket posed. This matches `sqlite3_exec`, which runs a `select` and simply
lets the caller pass no row callback.

## Where the fix goes

`_executeSingleStatement`, not `exec`. All three of its callers want "run this, discard rows":

- `exec` — the per-statement implicit-transaction loop;
- `_executeStatementBatch` → `_execWithinTransaction` — nested SQL run while already holding the
  mutex;
- `_evalGenerator` — every statement in a multi-statement batch except the last.

Draining at that one site fixes all three.

## Shape

```ts
const result = await scheduler.run(runtimeCtx);
// A row-returning statement does its work only as its rows are pulled. `exec` wants
// none of them, but it does want the work — an un-drained stream means the statement
// never ran at all. Drain and discard, checking the abort signal at row boundaries the
// way Statement._iterateWithSignal does.
if (isAsyncIterable<Row>(result)) {
	for await (const _row of result) {
		throwIfAborted(signal);
	}
}
```

`isAsyncIterable` comes from `../runtime/utils.js`; `throwIfAborted` and `Row` are already
imported in `database.ts`. `scheduler.run` returns `OutputValue`, which is nullable and a union —
`isAsyncIterable<Row>` narrows it, but expect to satisfy the compiler about the `null` case (the
existing `isAsyncIterable(result)` call sites in `database-materialized-views-apply.ts:364` and
`database-assertions.ts:510` are the precedent to follow).

## Blast radius — measured

Prototyped exactly the above and ran `yarn test` (whole monorepo, 6m57s): **no failures**;
`packages/quereus` 8751 passing, every other package green. Nothing in `packages/*/src` calls
`exec` with a row-returning statement — grep for `exec('select|with |values|explain` outside
`test/` returns nothing. The test call sites that do pass a query to `exec`
(`core-api-transactions.spec.ts:266`, `integration-boundaries.spec.ts:343,396`,
`lifecycle.spec.ts:39`, `quereus-isolation/test/isolation-layer.spec.ts:6876,6886`,
`quereus-store/test/alter-table.spec.ts:418`) either fail at plan time or scan a tiny table, and
all stayed green.

## Connection reuse follows from the fix

`Statement` passes a `scanConnections` map in its `RuntimeContext` so an inner-loop re-scan
reuses one connected `VirtualTable`, then disconnects each exactly once in a `finally`.
`_executeSingleStatement` builds its `RuntimeContext` without that map. That was harmless while
nothing iterated; now that `exec` pulls rows, a nested-loop join under `exec` would connect and
disconnect per outer row. It stays *correct* either way — `scan.ts` falls back to owning the
lifecycle when no cache is present — but mirror `statement.ts` here: create the map, put it on
the context, and disconnect its values in a `finally` after the drain loop (`disconnectVTable`
from `runtime/utils.js`).

## Documentation

`docs/runtime.md` § "Key Points for Emitter Authors" currently *states this bug as the rule*:

> **Side effects must not live in a generator body.** … `db.exec` discards a row-returning
> statement's result without pulling a single row …

That paragraph is wrong once this lands and must be rewritten, not deleted — the surrounding
advice still matters, but for a different reason. What stays true after the fix: `exec` drains,
so an emitter's generator body does run; the eager-materialization pattern (`emitAnalyze`
returning an `ArrayRowIterable`) and the `SinkNode` wrap (`buildPragmaStmt` for `pragma x = y`)
remain valid and should not be reverted, since a *partially consumed* stream (a caller who
`break`s out of `eval`) still leaves a lazy emitter's effect half-done.

## TODO

- Drain the row-returning result in `Database._executeSingleStatement`, honouring `signal` at row
  boundaries.
- Add a `scanConnections` map to that method's `RuntimeContext` and disconnect its entries in a
  `finally` after the drain, mirroring `Statement._iterateRowsRawInternal`.
- Update the `exec` JSDoc: it runs every statement to completion and discards the rows; a caller
  passing a query pays for the full scan and sees any error the query raises. Leave the existing
  `readConcurrency` paragraph — `exec` still yields no rows to a caller, so that reasoning holds.
- Rewrite the `docs/runtime.md` "Side effects must not live in a generator body" paragraph per
  above.
- Add a regression test (new spec under `packages/quereus/test/`): a scalar UDF that counts
  invocations, `await db.exec('select f(id) from t')`, assert the count equals the row count; and
  a second case asserting a UDF that throws makes `exec` reject.
- Run `yarn test` and `yarn lint` from the repo root.
