description: A SQL `CASE` no longer runs branches it never selects, so a branch that would error (divide-by-zero, throwing function, a subquery) only runs when its condition actually matches — matching standard SQL.
files: packages/quereus/src/runtime/emit/case.ts, packages/quereus/test/case-short-circuit.spec.ts, packages/quereus/test/logic/03-expressions.sqllogic, docs/runtime.md

## What was built

`emitCaseExpr` (`runtime/emit/case.ts`) now short-circuits unconditionally. Every
WHEN/THEN/ELSE is emitted as an on-demand callback (`emitCallFromPlan`) and invoked
lazily in SQL order, stopping at the first match; only the simple-`CASE` base expr
stays an eager param (evaluated once per row). The `run` returns
`MaybePromise<SqlValue>` and stays synchronous whenever the invoked branch callbacks
resolve synchronously — an `instanceof Promise` walk per WHEN takes the async branch
only for a genuinely async operand (e.g. a scalar subquery). The synchronous return
is load-bearing: an `async`-declared `run` would force every CASE result into a
Promise and break the materialized-view row-time projection gate
(`compileSourceRowEvaluator` in `database-materialized-views-analysis.ts`).

**Behavior change (intended):** `select case when 1=1 then 'ok' else throwing_udf() end`
returns `'ok'` where it previously raised. Same for any unmatched THEN/ELSE that would
throw or run a side-effecting subquery. (Bare `1/0` returns NULL in `binary.ts`, so
error-branch tests use a throwing UDF, not division.)

Full implement-stage detail is in the git history:
`git show 5da88e4c` (`ticket(implement): feat-case-short-circuit`).

## Review findings

Adversarial pass over the implement diff (`5da88e4c`). Read the diff first, then the
handoff. Validation: `yarn workspace @quereus/quereus test` → **6958 passing, 13
pending, 0 failing**; `yarn workspace @quereus/quereus lint` → exit 0. Ran the
`case-short-circuit.spec.ts` + `incremental/maintenance-equivalence.spec.ts` pair in
isolation (116 passing) to confirm the MV-gate regression the first draft hit stays
green.

**Correctness — checked, no defects.**
- Arg-index layout verified for both runs: searched `[when0,then0,…,else?]` with
  `else` at `clauseCount*2`; simple `[base,when0,then0,…,else?]` with the `1+…`
  offset and `else` at `1+clauseCount*2`. All indices line up.
- Short-circuit / first-match / NULL-base / NULL-WHEN / no-ELSE→NULL semantics are
  byte-identical to the old eager `run` (same `isTruthy` / `compareSqlValues`),
  confirmed by spec + `.sqllogic`.
- Async promise branch flattens correctly: `w.then(wv => … ? thenFn(ctx) : step(i+1))`
  — `thenFn` and the recursive `step` may themselves return a Promise, and `.then`
  flattens both. No double-wrap.
- `emitCallFromPlan` deferral matches the established AND/OR (`binary.ts`) and
  aggregate/cache/alter-table pattern — params become lazily-invoked callbacks, not
  eager-scheduled values. Not a novel mechanism.

**Test coverage — one gap found and fixed inline.** The implement suite exercised an
async *THEN* (correlated subquery) but never an async *WHEN* condition — the
`w instanceof Promise` branch in `step` and its `.then(… : step(i+1))` fall-through
recursion were unproven. Added two tests to `case-short-circuit.spec.ts`:
- `an async correlated-subquery WHEN condition drives selection` — WHEN is a subquery
  (callback returns a Promise), covering both promise-branch outcomes (match → THEN,
  no-match → ELSE) across two rows.
- `an async WHEN that fails falls through to a later matching WHEN` — forces the
  promise-branch `step(i+1)` recursion into a later synchronous WHEN.
Both pass; lint (which typechecks test files) re-run clean.

**Docs — verified current.** `docs/runtime.md` § "Avoid a per-row microtask hop…"
gained an accurate "Short-circuiting operators reuse this pattern" note covering the
CASE always-short-circuits rule and the MV-gate sync requirement. `docs/sql.md` is
grammar-only (no evaluation-semantics prose) — correctly left unchanged. The EXPLAIN
`note` string was updated to `case(short-circuit, N when clauses[, else])` and the
stale short-circuit TODO removed. No other doc references CASE evaluation order.

**Tripwire (recorded, not a ticket).** The clause walk `step(i)` recurses once per
WHEN on the fully-synchronous path; a pathological CASE with thousands of WHENs could
recurse that deep. Parser-bounded in practice, not a real risk. Parked as the
implementer's `Watch for` note in the review handoff / this section — no code change
warranted; if CASE clause counts ever grow unbounded, convert the sync walk to a loop.

**No new tickets filed.** CASE has no orthogonal follow-on: it always short-circuits,
there is no cost gate to tune, and no separate subsystem governs its evaluation
(unlike the AND/OR prereq, which spun off `feat-where-conjunct-cost-ordering`). No
major findings; no `blocked/` decisions. No pre-existing test failures surfaced.
