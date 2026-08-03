description: Fixed a bug where running the "collect table statistics" command (ANALYZE) through the engine's fire-and-forget execution API silently did nothing — this is now corrected so it always collects statistics no matter which entry point was used to run it.
files:
  - packages/quereus/src/runtime/emit/analyze.ts            # the fix: emitAnalyze's `run` is now an eager async function
  - packages/quereus/src/util/array-row-iterable.ts          # renamed from working-table-iterable.ts (was CTE-only, now shared)
  - packages/quereus/src/runtime/emit/recursive-cte.ts       # only change: import the renamed class
  - packages/quereus/test/runtime/analyze-eager-exec.spec.ts # new regression spec
  - packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic          # comment updated, structure kept
  - packages/quereus/test/logic/108-cardinality-estimation.sqllogic        # header comment corrected (see below)
  - packages/quereus/test/materialized-view-diagnostics.spec.ts            # stale comment fixed
difficulty: easy
---

# ANALYZE now runs eagerly — summary for review

## What changed

`emitAnalyze` (`packages/quereus/src/runtime/emit/analyze.ts`) built its `run` as an
**async generator**. Connecting to each table, collecting statistics, and writing them
back onto `TableSchema.statistics` all happened inside the generator body — which does
not execute a single line until something iterates it. `db.exec` never iterates a
statement's result (see `_executeSingleStatement` / `emitBlock`), so `await
db.exec('analyze')` silently did nothing: no error, no statistics, plans never changed.
`db.eval('analyze')` worked, because its caller iterates the rows.

Fix: `run` is now a plain `async` function that does the work eagerly and returns an
already-populated `AsyncIterable<Row>` (via a small shared helper), instead of a
generator whose body only runs on iteration. Every other behavior is unchanged: same
plan node, same emitted row shape (`(table, rows)` one row per analyzed table), same
per-table try/catch-and-continue, same `vtab.disconnect()` in `finally`.

Renamed `src/util/working-table-iterable.ts` → `src/util/array-row-iterable.ts`
(class `WorkingTableIterable` → `ArrayRowIterable`) since it's no longer CTE-specific —
it's now shared between the recursive-CTE emitter and `ANALYZE`. Only its one existing
caller (`runtime/emit/recursive-cte.ts`) needed an import update; no behavior change
there.

**Scope note:** a broader, separate bug — `db.exec` on ANY row-returning statement
(not just `ANALYZE`) never runs the statement's body at all, e.g. a `select` calling a
throwing scalar function raises nothing under `exec` — is explicitly out of scope here
and is tracked as `backlog/bug-exec-never-runs-row-returning-statements`. This ticket
only fixes `ANALYZE`, which is the one relational statement whose side effects were
sitting inside an un-drained generator (audited against every statement-level emitter
reachable from `buildStatement` in `planner/building/block.ts` — nothing else needed
the same fix).

## How to test / validate this

- **New regression spec**: `packages/quereus/test/runtime/analyze-eager-exec.spec.ts`.
  Covers: `await db.exec('analyze')` installs statistics (read back via
  `db.schemaManager._findTable('s', 'main')?.statistics`, not inferred from a plan);
  the single-table form `analyze <table>`; a mid-batch `analyze` inside a
  multi-statement `db.exec(...)` string; and that `db.eval('analyze')` still yields
  one `(table, rows)` row per analyzed table (guards against the eager rewrite
  quietly dropping the report).
- Four sqllogic files run a bare `ANALYZE;` as a setup statement (which the harness
  sends through `db.exec`) and were previously exercising nothing:
  `07.7.4-where-conjunct-ordering`, `108-cardinality-estimation`,
  `11.3-index-nested-loop-join`, `53.3-materialized-view-constraint-only-ddl`. All
  four were re-read after the fix:
  - `07.7.4` and `11.3` already correctly scope themselves to row-equality only and
    explicitly defer plan-shape assertions to a companion `.spec.ts` file (which uses
    `db.eval`/drains directly and was never affected by this bug) — no changes needed.
  - `108-cardinality-estimation`'s header comment claimed to validate "cost-based
    optimizer decisions (plan shape, index selection, access method)" but every
    assertion in the file is plain row-count/data correctness — it never did and
    still doesn't test plan shape. Rewrote the header to say so accurately and point
    at where plan-shape-from-statistics actually is asserted
    (`where-conjunct-ordering.spec.ts`, `test/optimizer/*.spec.ts`).
  - `53.3-materialized-view-constraint-only-ddl` § 7 ("ANALYZE keeps MVs live") is the
    one file where the fix changes what the test actually exercises: before, `analyze
    g;` via `db.exec` never fired the `table_modified` notification the section is
    named for, so the "stays live" assertion was checking a no-op. It now genuinely
    exercises the statistics-only-change-doesn't-stale-the-MV path.
- `11.4-hash-join-side-swap.sqllogic`: kept the existing structure (each `ANALYZE` as
  its own block with an expected-result row count) exactly as instructed — that
  expected result is real evidence the statistics landed, not just a workaround.
  Rewrote the explanatory comment to drop the reference to this ticket and to state
  the assertion's purpose plainly.
- `test/materialized-view-diagnostics.spec.ts`: fixed two stale comments that said
  `db.exec` wouldn't pull ANALYZE's rows / that draining was needed to make it
  execute — no longer true, though the test still uses `db.eval`-based draining
  (harmless, just no longer load-bearing for correctness).
- `packages/quereus-isolation/test/isolation-layer.spec.ts:~4964` — `await
  adb.exec('analyze')` inside an isolated-table test with an open transaction and a
  dirty overlay. Previously this call was a complete no-op (never scanned anything),
  so the test's "must complete rather than throw" assertion was vacuous. It now
  genuinely drives the full-scan path over the dirty overlay. Left as-is; it passes.
- Grepped `docs/optimizer.md`, `docs/sql.md`, and all of `docs/` for any description
  of `ANALYZE` as lazy/generator-driven — found none, so no doc changes were needed.

## Test results

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn test` (from `packages/quereus`) — **8612 passing**, 13 pending (pre-existing
  capability-based skips), 0 failing. (Ticket's pre-fix prototype baseline was 8608;
  the +4 is this ticket's new spec file.)
- `packages/quereus-isolation`: `yarn test` — **374 passing**, 0 failing (matches
  ticket's stated baseline).
- `yarn lint` (repo root, fans out to all packages) — clean, exit 0.
- `yarn typecheck` (repo root) — clean, exit 0.

## Known gaps / things the reviewer should double check

- I did not add a test specifically pinning `53.3-materialized-view-constraint-only-ddl`
  § 7's *new* real behavior (i.e. asserting the `table_modified` notification actually
  fires with a statistics-only diff during ANALYZE) beyond the existing "MV stays
  live" row-level check already in that file. If that notification's shape matters
  beyond "doesn't stale the MV", it isn't independently pinned.
- I did not touch `packages/quereus-isolation/test/isolation-layer.spec.ts` — it
  passes as-is and its comment already accurately describes what it's testing, but I
  did not add a stronger assertion (e.g. checking that statistics were actually
  installed on the isolated table's schema afterward) — it only checks the scan
  didn't throw and data stayed correct.
- `.gitignore` in the repo root shows a modification (an added `.tmp` entry) that I
  did not make and haven't touched — it was already present in the working tree
  before this ticket's work started, unrelated to this fix.
