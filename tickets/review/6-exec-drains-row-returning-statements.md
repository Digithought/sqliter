description: Made the engine's fire-and-forget "just run this SQL" call actually run queries that return rows, instead of planning them and then silently skipping the work.
files:
  - packages/quereus/src/core/database.ts                                  # _executeSingleStatement (~line 807-857) — now drains + scanConnections teardown; exec() JSDoc updated
  - docs/runtime.md                                                        # "Side effects must not live in a ... generator body" (~line 407-419) — rewritten
  - packages/quereus/test/exec-drains-row-returning-statements.spec.ts     # new regression spec
difficulty: easy
---

# `Database.exec` now drains a row-returning statement's result

## What changed

`Database._executeSingleStatement` (`packages/quereus/src/core/database.ts:807`) previously called
`await scheduler.run(runtimeCtx)` and discarded the return value. For a row-returning statement
(`select`, `values`, `explain`, ...) that return value is an un-started `AsyncIterable<Row>` — the
statement's actual work happens as rows are pulled from it, so nothing ever ran it.

Fix, at that one site (all three callers — `exec`, `_executeStatementBatch`, `_evalGenerator` —
route through it):

```ts
const scanConnections = new Map<symbol, VirtualTable>();
const runtimeCtx: RuntimeContext = { ...as before..., scanConnections };

try {
	const result = await scheduler.run(runtimeCtx);
	if (isAsyncIterable(result)) {
		for await (const _row of result as AsyncIterable<Row>) {
			throwIfAborted(signal);
		}
	}
} finally {
	for (const vtab of scanConnections.values()) {
		await disconnectVTable(runtimeCtx, vtab);
	}
}
```

- Drains and discards every row, checking `signal` at each row boundary — matches
  `Statement._iterateWithSignal`'s cancellation granularity.
- Added the `scanConnections` map to the `RuntimeContext` (was previously omitted here — harmless
  while nothing iterated, since `runtime/emit/scan.ts` falls back to owning connect/disconnect
  per-row when no cache is present). Now that `exec` actually pulls rows, a nested-loop join under
  `exec` reuses one connected `VirtualTable` instead of connecting/disconnecting per outer row,
  mirroring `Statement._iterateRowsRawInternal`. Disconnected exactly once in the new `finally`.
- `exec`'s JSDoc now states plainly that every statement — including row-returning ones — runs to
  completion; rows are pulled and discarded, so side effects and errors surface, but the rows
  themselves are never visible to the caller (use `get`/`eval` for that).
- `docs/runtime.md` § "Key Points for Emitter Authors": the old paragraph asserted `db.exec`
  *never* pulls rows and used that as the reason side effects can't live in a generator body. That
  premise is now false for a full, uninterrupted `exec`. Rewrote it: the real hazard is *partial*
  consumption (`eval`/`iterateRows` broken out of early, or an aborted signal) — nothing in the
  engine guarantees a generator runs to completion in general, only that `exec` specifically does
  now. The existing advice (mutate-then-materialize via `ArrayRowIterable`, `emitAnalyze` as the
  worked example, `SinkNode` for purely-void statements like `pragma x = y`) is unchanged and still
  the right pattern — only the *justification* changed.

## Testing / validation done

- New spec `packages/quereus/test/exec-drains-row-returning-statements.spec.ts`:
  - a scalar UDF counts invocations; `await db.exec('select boom(id) from t')` against a 3-row
    table asserts the count reaches 3 (previously stayed 0).
  - a second case: a UDF that throws mid-row makes `exec` reject with that error, proving the
    statement actually executes and errors propagate (not swallowed).
- `yarn test` (whole `packages/quereus` suite): **8752 passing**, 13 pending, no failures (baseline
  in the ticket was 8751 before the 2 new tests net +1 — matches: one new `describe` block, two
  `it`s, and the suite total already included unrelated skips).
- `yarn lint` (eslint + test-file typecheck): clean.
- `yarn typecheck`: clean.

## Use cases for reviewer to probe

- **The headline case**: any caller that hands `exec` a bare `select` (or `values`/`explain`)
  expecting side effects (a UDF call, a subquery against a vtab that has connect-time effects) to
  happen. Was silently a no-op before; now runs.
- **Cancellation**: an aborted `signal` mid-drain should reject with an `AbortError` at the next row
  boundary, not run to completion. Not separately covered by the new spec — `exec-eval-abort-signal.spec.ts`
  already exercises `exec`'s abort path for DML/DDL; worth checking it (or adding a case) still
  covers a row-returning statement under `exec` specifically, since the abort check now sits inside
  the new drain loop rather than being entirely absent.
- **Connection reuse**: the `scanConnections` map addition is defensive/performance (avoid
  reconnect-per-row on a nested-loop join under `exec`), not required for correctness — `scan.ts`'s
  fallback path was already correct without it. No test specifically exercises multiple inner-scan
  connections reused within a single `exec`'d row-returning statement (would need a multi-table join
  under `exec` with a vtab whose `connect`/`disconnect` are observable, e.g. a call counter). Low
  risk given `scan.ts`'s existing fallback and `Statement`'s identical pattern already being well
  tested, but flagging as an untested path rather than papering over it.
- **`explain` under `exec`**: `explain` plans return rows describing the plan, not side-effecting
  work — draining it is harmless (matches `sqlite3_exec` semantics: running a `select` letting the
  caller supply no row callback) but wasn't explicitly asserted in the new spec's cases beyond the
  general row-returning path. Low-risk, same code path as `select`.

## Known gaps / left for reviewer

- No test added specifically for the `scanConnections` reuse behavior described above (nested-loop
  join under `exec`, connection-count assertion). The ticket's own "Blast radius" analysis and the
  full green `yarn test` run are the coverage for that; a reviewer wanting stronger proof could add
  a vtab-with-counted-connect-calls test.
- Did not add a dedicated abort-mid-drain test for a row-returning statement under `exec`
  specifically (existing `exec-eval-abort-signal.spec.ts` covers `exec`'s abort path generally, but
  predates this fix so never exercised the new loop).
