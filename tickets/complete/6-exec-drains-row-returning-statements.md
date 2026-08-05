description: Made the engine's fire-and-forget "just run this SQL" call actually run queries that return rows, instead of planning them and then silently skipping the work.
files:
  - packages/quereus/src/core/database.ts                                  # _executeSingleStatement (~line 828-856) — drain + scanConnections teardown; exec() JSDoc
  - packages/quereus/test/exec-drains-row-returning-statements.spec.ts     # regression spec (5 cases)
  - docs/runtime.md                                                        # "Side effects must not live in a lazily-drained generator body"
  - docs/errors.md                                                         # abort-poll seam list — exec's drain loop added
  - docs/usage.md                                                          # exec section — row-returning note; batch-atomicity claim corrected
difficulty: easy
---

# `Database.exec` drains a row-returning statement's result

## What shipped

`Database._executeSingleStatement` ended with `await scheduler.run(runtimeCtx)`, discarding
the return value. For a row-returning statement that value is an un-started
`AsyncIterable<Row>` — the work happens as rows are pulled, so the statement never ran. It
now drains and discards every row, checking the abort signal at each row boundary, and
carries a `scanConnections` map (with `finally` teardown) so a repeated inner scan reuses one
connected virtual table instead of reconnecting per outer row — mirroring
`Statement._iterateRowsRawInternal`.

Fixing it at that one private method covers all three callers: `exec`, `_executeStatementBatch`,
and `_evalGenerator`'s non-final statements.

Docs: `docs/runtime.md`'s "side effects must not live in a generator body" paragraph used the
old bug as its justification and was rewritten around the real hazard (partial consumption).

## Review findings

### Checked

Read the implement diff before the handoff summary. Verified: the drain's placement relative
to the implicit-transaction commit (teardown runs before commit, matching `statement.ts`);
that `emitBlock` returns a single value rather than an array for a one-statement plan, so the
`isAsyncIterable` guard is the whole story here (the `Array.isArray` branch `statement.ts`
carries is not needed); that `disconnectVTable` already swallows-and-logs its own errors, so
the new `finally` cannot mask the original exception; that `_evalGenerator` still yields the
final statement through `Statement`, so nothing that should reach a caller gets drained away.
Ran `yarn lint` (clean), `yarn typecheck` (clean), `yarn test`: **8755 passing**, 13 pending,
0 failing — up 3 from the implementer's 8752, matching the 3 tests added below. No
pre-existing failures surfaced.

### Fixed in this pass (minor)

- **The error-path test could not fail correctly.** `expect.fail('exec should have rejected')`
  sat inside the `try`, so its own AssertionError fell into the sibling `catch` and was then
  re-asserted for the string `row error` — a genuinely non-rejecting `exec` would have
  reported a confusing message instead of the real one. Restructured to capture and assert
  after the block. Also dropped a stray `void` in front of a non-promise `expect`.
- **Three tests added** for paths the handoff flagged as uncovered:
  - *DML carrying `RETURNING` under `exec`*. Not previously called out anywhere: `insert …
    returning` builds a `ReturningNode`, which is relational and therefore gets no `SinkNode`
    wrap, so it took the same un-drained path as a bare `select` — **the insert never
    happened**. That is the highest-impact consequence of the bug and it now has a regression
    test.
  - *Multi-statement batch*: both statements of `select …; select …;` drain.
  - *Abort mid-drain of a bare `select`* — the gap the implementer named. The signal trips on
    the first row; `exec` rejects with `AbortError` and the row count stops short.
- **`isAsyncIterable<Row>(result)`** replaces `isAsyncIterable(result)` plus an
  `as AsyncIterable<Row>` cast — the guard is already generic.
- **`docs/errors.md`** enumerates every place the engine polls the abort signal. `exec`'s new
  drain loop is one and was missing.
- **`docs/usage.md`** (a file the change should have touched but didn't): added one sentence
  that a row-returning statement under `exec` runs to completion with its rows discarded. While
  there, corrected an adjacent claim that predates this ticket — the doc said "Multiple
  statements in db.exec() are atomic … all commit together, or all rollback on error", which
  contradicts `exec`'s own JSDoc. Verified with a throwaway probe (since deleted): after
  `exec("insert into u values (1); insert into u values (1);")` throws on the second, the first
  row stays committed. Corrected to per-statement autocommit, with a pointer to `begin`/`commit`
  for all-or-nothing.

### Filed as a ticket (major)

- **`tickets/backlog/debt-runtime-context-built-by-hand-at-every-run-site.md`** — this fix had
  to hand-copy the execution-context literal and its connection-cache teardown out of
  `statement.ts`, making it the 5th of 7 hand-built copies. Three of the other sites that
  iterate rows (assertions, materialized-view apply, deferred constraints) omit the connection
  cache; they stay correct because the scan emitter owns the lifecycle when no cache is
  present, but nobody chose that — the field is just missing. Filed at the architecture rung
  (one context constructor + a small set of run-result helpers that own the teardown) rather
  than as a point fix at any single site, per *Architecture first*. Site-claim grep over the
  open board found nothing else touching `RuntimeContext` construction.

### Tripwires

- None recorded as new code comments. The one conditional concern worth knowing — `exec` on a
  row-returning statement now pays the full scan while holding the execution mutex, where it
  used to return immediately — is already stated plainly in `exec`'s JSDoc and in
  `docs/usage.md`, which is where a caller will actually meet it. A second `NOTE:` at the drain
  loop would be a third copy of the same sentence.

### Knowingly not done

- **No test asserting connection *reuse* counts** for a nested-loop join under `exec` (the gap
  the handoff listed). Reuse is a performance property with a correct fallback either way, and
  proving it needs a bespoke virtual table with an observable connect counter. The behaviour is
  identical to `Statement`'s well-tested path, and the underlying fragility — that the cache is
  opt-in per hand-built context — is now the subject of the debt ticket above, which is the
  place to add a shared guard once there is one seam to guard.
- **`explain` under `exec`** got no dedicated case. It is the same `isAsyncIterable` branch as
  `select` with no side effects to observe, so a test would assert only that draining a plan
  description is harmless.
