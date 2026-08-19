description: Fixed a debugging helper (`execution_trace()`) that used to hang forever instead of returning results; also added a test that would catch the same class of mistake in its four sibling helpers.
files:
  - packages/quereus/src/func/builtins/explain.ts        # collectSchedulerProgram() extracted; scheduler_program + execution_trace now share it
  - packages/quereus/src/func/registration.ts             # NOTE on createIntegratedTableValuedFunction: TVF bodies run under the exec mutex
  - packages/quereus/test/core/diagnostic-tvfs.spec.ts    # new — all five SQL-taking diagnostic TVFs, end-to-end, short timeout
  - packages/quereus/test/runtime/scalar-fusion.spec.ts   # stale NOTE replaced with a real execution_trace() assertion; timeout 20s -> 5s
difficulty: easy
---

# `execution_trace()` no longer deadlocks

## What changed

`execution_trace('<sql>')` used to hang forever. Root cause: it ran a nested
`db.eval('SELECT * FROM scheduler_program(?)', [sql])` from inside its own
generator body. A table-valued function body executes *inside* the statement
that invoked it, under the same single exec mutex
(`Database._acquireExecMutex`) that statement already holds. The nested
`db.eval` queued behind that mutex and could never be granted — nothing
threw, it just sat forever.

Fix: extracted the instruction-listing logic that both `scheduler_program`
and `execution_trace` need into one in-process helper,
`collectSchedulerProgram(db, sql)`, in
`packages/quereus/src/func/builtins/explain.ts`. It calls `db.getPlan` →
`EmissionContext` → `emitPlanNode` → `Scheduler` directly (all mutex-free),
returning `SchedulerProgramEntry[]`. `scheduler_program()` now maps those
entries to its six-column tuples; `execution_trace()` calls the helper
directly instead of going through SQL. Same instruction addressing as
before (main-program index, or `mainCount + progIdx*1000 + subI` for
sub-program instructions), so the two listings stay identical by
construction — `execution_trace` still joins its trace events against these
addresses by index.

Also routed `execution_trace`'s two `console.warn` calls (scheduler-info
failure, traced-execution failure) through the module's existing
`createLogger('func:builtins:explain')` logger, matching every other
diagnostic in the file. Neither failure path was silenced — both still log,
just through the namespaced logger instead of `console.warn`.

## Guarding the class

Any table-valued function body that reaches for `db.eval`/`db.exec` instead
of the mutex-free `db.getPlan`/`db.prepare`/`Statement.iterateRowsWithTrace`
path will deadlock the same way, silently. Two guards landed:

- A `NOTE:` on `createIntegratedTableValuedFunction` itself in
  `packages/quereus/src/func/registration.ts` (the single factory every
  integrated TVF body is defined through — including all five diagnostic
  TVFs), stating the constraint and the mutex-free alternatives. I put it
  there rather than at each of the ~9 individual TVF bodies in `explain.ts`
  so future TVF authors — in this file or elsewhere — see it at the one
  choke point, rather than relying on someone copying it into new call
  sites. `collectSchedulerProgram` also carries its own shorter version
  since it's the exact site that was wrong. **Flag for review**: the ticket
  suggested "a short comment where the TVF body starts" (implying per-body);
  I judged the shared factory a stronger single seam. If you disagree,
  duplicating a one-line version into each of `query_plan` / `stack_trace` /
  `row_trace` (the three that don't already touch `collectSchedulerProgram`)
  is a small follow-up.
- `packages/quereus/test/core/diagnostic-tvfs.spec.ts` (new): runs all five
  SQL-taking diagnostic TVFs (`query_plan`, `scheduler_program`,
  `stack_trace`, `execution_trace`, `row_trace`) end-to-end through
  `db.eval`, each with a 5s per-test timeout and a "got at least one row
  back" assertion. A future regression that reintroduces a nested top-level
  query now fails a named test instead of hanging an unrelated caller.

An engine-level guard (make `db.eval` throw instead of hang when the mutex
is already held by the current call chain) was considered and rejected in
the original ticket — it needs `AsyncLocalStorage`-style async-context
tracking to distinguish "nested inside the holder" from "legitimately
queued behind it," which isn't available on the browser/React Native
targets this engine supports. Not revisited here.

## Stale NOTE updated

`packages/quereus/test/runtime/scalar-fusion.spec.ts` had a NOTE (previously
around line 766) saying `execution_trace()` "cannot be exercised end-to-end
here" because of this exact deadlock, pointing at a now-stale ticket path.
Replaced with a real test: `execution_trace('select n + 1 from t where n >
2')` must report an operation containing `+(numeric-fast)` and none starting
with `fused(`. The two pre-existing mechanism-level tests right after it
(`_emitUnfused=true traces the full sub-program instruction graph`, `a
default statement actually runs the fused form`) are untouched. Note: the
actual `operation` string for a scalar sub-program instruction reported by
`execution_trace` is `callback(+(numeric-fast))` (wrapped), not the bare
`+(numeric-fast)` scheduler_program reports — I used `.includes(...)` rather
than exact match to account for that; worth a second look in case that
wrapping is itself something reviewers expect flagged/changed elsewhere.

Also lowered `this.timeout(20_000)` on that describe block to `5_000` — it
was sized for the deadlock-adjacent worst case per the ticket; the fixed
path runs in well under 100ms per the ticket's own verification and matches
what I measured.

## docs/functions.md

Checked the `execution_trace(sql)` table entry — "Instruction-level trace
with timing. Non-deterministic" was already accurate and made no claim
about hanging or nested-query behavior. No change needed.

## Verification

- `yarn build` (in `packages/quereus`): clean.
- `yarn lint` (in `packages/quereus`, which also type-checks test files):
  clean.
- Targeted: `node test-runner.mjs --grep "diagnostic table-valued
  functions|debug surfaces report the unfused graph"` — 10/10 passing,
  including the new `execution_trace()` assertion and all five diagnostic
  TVFs completing (not hanging) within their 5s timeouts.
- Full suite from repo root: `yarn lint` (all workspaces — quereus is the
  only one with a real lint, rest are the intentional no-op) and `yarn test`
  (all workspaces) — both clean, no failures. quereus alone: 9774 passing,
  25 pending (pre-existing skips, untouched by this change).

## Gaps / things worth a second look

- `collectSchedulerProgram` is placed in `explain.ts` right above
  `scheduler_program`'s definition, not in a shared module — it's only
  consumed by the two functions in this file, so I didn't see a reason to
  relocate it, but flagging in case reviewer wants it elsewhere for
  discoverability.
- `row_trace()`'s own `console.warn` (a different failure path, not one of
  the two the ticket named at explain.ts:461/:484) was left as-is — out of
  the ticket's stated scope, not touched.
- No new test exercises `execution_trace()`'s error/degraded paths (e.g.
  what it reports when the traced SQL fails to plan, or when tracing itself
  throws) — the new spec only checks the happy path returns rows. The
  existing try/catch behavior there is untouched by this fix, so I didn't
  add coverage for it, but it's not covered by this ticket's or the
  existing suite's tests either.
