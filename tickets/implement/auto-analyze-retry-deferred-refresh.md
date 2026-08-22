---
description: When a background statistics refresh is skipped because a transaction happened to be open at that instant, it is thrown away instead of retried — so a table can be left with stale statistics forever. Make the skip reschedule itself a few times before giving up.
files:
  - packages/quereus/src/core/database-auto-analyze.ts   # `refresh` early returns, `start`, `arm`, `evaluate`, `whenIdle`, `TableStalenessEntry`
  - packages/quereus/test/auto-analyze-refresh.spec.ts   # existing suite; add a mid-statement-wakeup group
  - docs/sql-txn.md                                      # §9.5, "It is skipped while a transaction is open" bullet
repro: verified
difficulty: medium
---

# Make a deferred statistics refresh reschedule itself

## The bug, reproduced

`AutoAnalyzeManager.refresh` checks `getAutocommit()` before running `ANALYZE`,
because collecting statistics inside an open transaction would fold that
transaction's uncommitted rows into the result. When the check says "a transaction
is open" the method just `return`s. Nothing is rescheduled. The drift counter is
left intact, so the table is still over threshold — but the only thing that ever
arms a new timer is **the next commit that touches that same table**
(`recordCommit` → `evaluate` → `arm`, and `recordCommit` only sees the tables the
committing transaction actually wrote).

So a crossing for table `t` is lost outright whenever `t`'s debounce timer fires
during a write to some *other* table, and `t` is never written again.

Verified with a throwaway spec (deleted; reproduce it by pasting this back in):

```ts
db.setOption('auto_analyze_min_mutations', 3);
await db.exec('create table t (id integer primary key, v integer)');
await db.exec('create table other (id integer primary key, v integer)');
await db.exec('insert into other values (1, 1), (2, 2)');
db.createScalarFunction('fire_timers', { numArgs: 1 }, (x) => {
	assert.equal(db.getAutocommit(), false);  // holds: we are inside `other`'s implicit transaction
	void db._whenAutoAnalyzeIdle();           // fires t's armed timer from *inside* this statement
	return x;
});

await db.exec('insert into t values (1, 10), (2, 20), (3, 30)');   // t crosses, arms a timer
await db.exec('update other set v = fire_timers(9) where id = 1'); // timer lands mid-statement

// observed: armed(t) === false, refreshCount() === 0, changedSinceAnalyze(t) === 3
await db._whenAutoAnalyzeIdle();
// observed: stats(t) === undefined — t's crossing is gone for good
```

## How reachable it is — corrected

The source ticket said `getAutocommit()` is false for "the implicit,
single-statement transaction every ordinary statement runs inside". That is too
broad. An implicit transaction is opened by `_ensureTransaction()`, which only the
DML and DDL emitters call. Probed from a scalar function evaluated mid-statement:

| statement | `getAutocommit()` during it |
| --- | --- |
| `select …` | `true` |
| `insert … values (…)` (function in the VALUES list) | `true` |
| `insert … select …` | **`false`** |
| `update … set v = f()` | **`false`** |
| `delete … where id = f()` | **`false`** |
| any statement inside an explicit `begin` | **`false`** |

So the window is not "any query" — it is the duration of any `UPDATE`, `DELETE`,
`INSERT…SELECT`, or DDL statement, plus any explicit transaction. That is still an
ordinary shape and still wide: a bulk load that writes several tables and then
keeps writing only one of them loses the others' crossings. Reads are safe.

## Do not "fix" it by narrowing the check

The tempting simplification — defer only for `'explicit'` transactions, since the
refresh's `db.exec` queues on the execution mutex and an implicit transaction
belongs to the statement currently *holding* that mutex — is **unsound**.
`Statement._iterateRowsGenerator` releases the mutex in its `finally`, and
`wrapAsyncIterator` runs `_finalizeImplicitTransaction` *after* that (there is an
explicit NOTE saying so at `packages/quereus/src/core/statement.ts:620`). There is
a real window where the mutex is free and an implicit transaction is still open.
Keep the deferral policy exactly as it is; change only what happens after a
deferral.

## Shape of the fix

The root cause is that every early return in `refresh` spells "give up" the same
way, so *declined on purpose* and *transiently deferred* are indistinguishable to
the caller. Make the distinction part of the type:

```ts
/** Why a scheduled refresh ended. `deferred` is the only outcome that wants a retry. */
type RefreshOutcome = 'analyzed' | 'declined' | 'deferred' | 'failed';
```

`refresh` returns one of these; `start` becomes the single place that decides what
an outcome means for scheduling. A new early return then has to name its outcome,
and the "abandoned crossing" class stops being writable.

Mapping for the existing returns:

| site in `refresh` | outcome |
| --- | --- |
| `this.disposed` | `declined` |
| `!this.enabled()` (feature switched off) | `declined` |
| `!this.ctx.getAutocommit()` | **`deferred`** |
| known rows over `auto_analyze_row_limit` | `declined` |
| table gone or is a plain view | `declined` |
| entry replaced while `ANALYZE` ran (`entries.get(key) !== entry`) | `declined` |
| fell through to the end | `analyzed` |
| `catch` | `failed` |

### Retry policy

`TableStalenessEntry` gains `deferRetries: number` — retries already spent on the
current crossing.

- **Bounded.** At most `AUTO_ANALYZE_MAX_DEFER_RETRIES` (suggest 4) retries per
  crossing. Once spent, drop the crossing exactly as today: wait for the next
  write. A user parking an explicit transaction open for an hour costs a bounded
  handful of wakeups per stale table, not a wakeup every few seconds forever.
- **Backed off.** Not the 50 ms debounce — a statement in flight now is likely
  still in flight in 50 ms. Suggest `AUTO_ANALYZE_DEFER_RETRY_MS = 250` growing
  geometrically (`250, 500, 1000, 2000` — about 3.75 s of total patience). Express
  it through the existing `nextEligibleAt` / `armDelayMs` machinery rather than a
  second timer concept.
- **Reset on the next commit.** `recordCommit` zeroes `deferRetries` for each table
  it touches; a successful `analyzed` zeroes it too.

`start` currently clears `entry.running` in a `.finally`. The retry re-arm must run
*after* that clear, because `arm` early-returns while `running` is set. Sequence the
two rather than racing them.

`arm` already guards `disposed` and a dropped/view table, so a retry cannot outlive
`dispose()` or resurrect a dropped table.

Coalescing is unaffected: `evaluate`'s first check is `entry.timer !== undefined ||
entry.running !== undefined`, so a commit arriving while a retry timer is armed is
absorbed into it.

### `whenIdle` interaction — decide this deliberately

`whenIdle` fires armed timers immediately and loops until nothing is armed, capped
at `AUTO_ANALYZE_IDLE_MAX_PASSES` (10). A retry timer *is* an armed timer, so a
`whenIdle` driven while a transaction is open will fire → defer → re-arm → fire …
until the retry budget is spent, then settle.

**Recommended: keep that behaviour and document it**, because it is what makes the
budget observable without sleeping — a test does `begin`, awaits
`_whenAutoAnalyzeIdle()`, and asserts `deferRetries` landed at the maximum with no
timer left armed. Check the arithmetic: `MAX_DEFER_RETRIES + 2` passes must stay
under `AUTO_ANALYZE_IDLE_MAX_PASSES`, i.e. keep the budget at 8 or below, or the
settle loop starts emitting its "did not settle" warning.

The existing test `open transactions › defers while an explicit transaction is open
and refreshes after the commit` calls `_whenAutoAnalyzeIdle()` inside a `begin`. It
must keep passing unchanged: it asserts `refreshCount() === 0` and
`changedSinceAnalyze === 3`, both of which still hold once the budget is spent.

## Test seam — cheaper than the source ticket assumed

The source ticket budgeted for a new production seam to fire a timer mid-statement.
None is needed. A user-defined scalar function registered with
`db.createScalarFunction` and referenced from a DML statement runs on that
statement's own stack, inside its implicit transaction; calling
`void db._whenAutoAnalyzeIdle()` from it clears the armed timer and drives
`start` → `refresh` through the `getAutocommit()` check synchronously, before
`refresh` reaches its first `await`. That is exactly the production sequence. The
repro above is the whole seam.

Two notes for whoever writes the tests:

- Do **not** `await` the promise from the inner `_whenAutoAnalyzeIdle()` — the
  statement would deadlock behind its own settle loop. `void` it.
- User functions default to non-deterministic, which is what you want (no constant
  folding, no caching). A non-deterministic function is rejected inside a `CHECK`
  constraint, so drive the wakeup from an `UPDATE`/`DELETE`/`INSERT…SELECT` instead.

## Docs

`docs/sql-txn.md` §9.5 currently says, in the automatic-refresh bullet list:

> **It is skipped while a transaction is open** … A skip leaves the drift counter
> untouched and schedules nothing — the next commit is what re-arms, so writes that
> stop right after a crossing can leave that crossing unserved until the table is
> written again.

Rewrite the second half to describe the bounded, backed-off retry and what happens
when the budget is spent. Also correct the "That covers the implicit transaction an
ordinary statement runs inside too" phrasing — a plain `SELECT` opens no
transaction; writes and DDL do.

The `NOTE:` block above the `getAutocommit()` check in
`database-auto-analyze.ts` references `tickets/fix/auto-analyze-lost-wakeup`;
replace it with a description of the retry, keeping the neighbouring accepted-
tradeoff NOTE about a `begin` landing between the check and the mutex acquisition
(that race is unchanged and still accepted).

## TODO

Phase 1 — types and scheduling

- Add the `RefreshOutcome` union and change `refresh` to return it; give every
  early return an explicit outcome per the table above.
- Add `deferRetries` to `TableStalenessEntry` and initialize it in `recordCommit`'s
  lazy entry construction.
- Add `AUTO_ANALYZE_DEFER_RETRY_MS` and `AUTO_ANALYZE_MAX_DEFER_RETRIES` with
  doc comments explaining why the retry delay is not the debounce and why the
  budget is bounded.
- Move the scheduling decision into `start`: re-arm with backoff on `deferred`,
  do nothing on `declined`, keep the existing failure backoff on `failed`, zero
  `deferRetries` on `analyzed`. Ensure the re-arm runs after `entry.running` is
  cleared.
- Zero `deferRetries` in `recordCommit` for each table the commit touched.
- Update `whenIdle`'s doc comment to state what a settle loop does to the retry
  budget, and verify `MAX_DEFER_RETRIES + 2 <= AUTO_ANALYZE_IDLE_MAX_PASSES`.

Phase 2 — tests in `test/auto-analyze-refresh.spec.ts`

- A crossing whose timer fires mid-statement (scalar-function seam, driven from an
  `UPDATE` on a *different* table) is eventually served, with no further writes to
  the crossed table.
- The retry budget is finite: with an explicit transaction held open, the retries
  stop at the maximum and nothing stays armed.
- A commit arriving during the retry window coalesces into one refresh, not two.
- The counter is untouched across every deferral and retry.
- Existing `open transactions` and `coalescing` tests still pass unchanged.
- Extend the spec's file header comment, which currently lists "transaction open"
  among the situations where no refresh happens — it is now a *delay*, not a skip.

Phase 3 — docs and validation

- Update `docs/sql-txn.md` §9.5 and the in-file `NOTE:` blocks.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file type pass).
- `yarn test` from the repo root.
