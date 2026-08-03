description: Fixed a bug where running the "collect table statistics" command (ANALYZE) through the engine's fire-and-forget execution API silently did nothing — it now always collects statistics no matter which entry point ran it.
files:
  - packages/quereus/src/runtime/emit/analyze.ts              # the fix: `run` is an eager async function
  - packages/quereus/src/util/array-row-iterable.ts           # renamed from working-table-iterable.ts (was CTE-only, now shared)
  - packages/quereus/src/runtime/emit/recursive-cte.ts        # import of the renamed class
  - packages/quereus/test/runtime/analyze-eager-exec.spec.ts  # regression spec
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # review: strengthened the isolated-table ANALYZE assertion
  - docs/runtime.md                                           # review: documented the side-effects-in-a-generator rule
---

# ANALYZE runs eagerly — completed

## What changed

`emitAnalyze` built its `run` as an **async generator**. Connecting to each table,
collecting statistics, and writing them back onto `TableSchema.statistics` all happened
inside the generator body, which does not execute a line until something iterates it.
`db.exec` never iterates a statement's result, so `await db.exec('analyze')` silently
did nothing — no error, no statistics, plans unchanged. `db.eval('analyze')` worked
only because its caller iterates.

`run` is now a plain `async` function that does the work and returns an
already-materialized `AsyncIterable<Row>`. Everything else is unchanged: same plan
node, same `(table, rows)` report shape, same per-table catch-and-continue, same
`vtab.disconnect()` in `finally`.

`src/util/working-table-iterable.ts` → `src/util/array-row-iterable.ts`
(`WorkingTableIterable` → `ArrayRowIterable`), since it is no longer CTE-specific; its
one existing caller (`runtime/emit/recursive-cte.ts`) took an import update only.

The broader defect — `db.exec` never running the body of ANY row-returning statement —
remains out of scope and tracked as `backlog/bug-exec-never-runs-row-returning-statements`.

## Review findings

**Correctness of the fix — confirmed.** Traced the new `Promise<AsyncIterable<Row>>`
return through all three scheduler dispatch modes (`optimizedHooks`, `tracingHooks`,
`metricsHooks` in `runtime/scheduler.ts`): each awaits or parks a promise output
correctly, and `countOutputs`/`wrapIterableForTracing` handle a materialized iterable
the same as a generator. No behavioral difference beyond the work now happening at
`run()` time. Under `db.eval` the work also moves from first-`next()` to `run()`, which
is strictly better — a consumer that abandons iteration early no longer leaves a
half-analyzed schema.

**The "nothing else needed this fix" audit — independently re-checked, and it holds,
though for a reason the handoff did not state.** `emitPragma` has exactly the same
shape (a state-mutating `rctx.db.setOption` inside an `async function*` body). It is
safe only because `buildPragmaStmt` wraps the write form in a `SinkNode`, and
`emitSink` drains its child. The other two statement-level generators
(`emitDiffSchema`, `emitExplainSchema`) are pure reporters with no side effects. Every
other DDL emitter is already a plain async function. So `ANALYZE` was genuinely the
only one exposed — it is the one statement that both mutates engine state and returns
a report, so nothing wrapped it in a Sink.

**Docs — one real gap, fixed in this pass.** `docs/runtime.md` § "Key Points for
Emitter Authors" said only "Row-producing runs are `async function*`" — the exact
guidance that produced this bug. Added the rule an emitter author needs: side effects
must not live in a generator body, because a statement's rows are not always iterated;
either be eager and return `ArrayRowIterable`, or (for void statements) let the builder
wrap you in a `SinkNode`. Re-verified the rest of the handoff's doc claim by reading
every `ANALYZE` mention in `docs/optimizer.md`, `docs/sql.md` and `docs/usage.md` —
none describe execution timing, so none needed changing.

**Tests — verified accurate, and one strengthened.** Re-read
`108-cardinality-estimation.sqllogic` end to end: the rewritten header is correct, the
file contains only row/data assertions and no plan-shape assertion, and both files it
now points at (`test/where-conjunct-ordering.spec.ts`, `test/optimizer/`) exist.
Strengthened the one test the handoff flagged as weak:
`packages/quereus-isolation/test/isolation-layer.spec.ts` "ANALYZE on an isolated table
… with a dirty overlay" now asserts the collected row count is 3 (2 committed + 1
uncommitted), so it pins that the scan ran *and* merged the overlay, instead of only
asserting the call did not throw. Passes.

**Test hygiene — fixed.** The new spec reached for the internal
`schemaManager._findTable`; switched it (and the new isolation assertion) to the public
`findTable`, which is a direct delegate. The internal form does not even resolve
through the package's published types from a sibling workspace.

**New ticket filed (major, separate root cause):**
`backlog/bug-analyze-unknown-name-silently-does-nothing`. `analyze nosuchtable`
returns success with no rows and no error, via both `db.exec` and `db.eval` (verified
by running it). `buildAnalyzeStmt` never resolves the name, so the emitter's table list
comes back empty and the loop body simply never runs; the unknown-schema form
(`analyze noSuchSchema.*`) does the same. Pre-existing and independent of this fix —
it fails identically on the drained path — but it is the same user-facing failure mode
this ticket was about (ANALYZE quietly doing nothing), so it should not stay unfiled.

**Tripwire recorded, not ticketed:** per-table failures inside ANALYZE are caught,
logged at debug level, and the table is dropped from the report — a caller cannot
distinguish "analyzed, zero rows" from "could not analyze". That is deliberate today
(one unreadable table should not cost every other table's statistics) and only becomes
work if a caller needs to tell the two apart. Parked as a `NOTE:` at the catch site in
`runtime/emit/analyze.ts`.

**Checked and clean, no findings:** resource cleanup (`vtab.disconnect()` still runs in
`finally` on every path, including the early schema-missing return, which now happens
before any connect); file sizes (`analyze.ts` 141 lines, `array-row-iterable.ts` 22 —
nothing near a split threshold); DRY (the rename is the right call — one helper, two
callers, no duplicated iterable class); type safety (no `any`, no assertions added);
memory (the eager report is one row per table). No stale references to the old
`WorkingTableIterable` name anywhere in source, tests, or docs — the only hit is a
leftover `dist/` declaration file that `tsc -b` does not prune, which is build output
and gitignored.

## Validation

Full run after the review edits:

- `yarn build` — clean.
- `yarn lint` (root fan-out) and `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn typecheck` (root fan-out) — clean.
- `yarn test` (root, all workspaces) — 0 failing; `packages/quereus` 8612 passing / 13
  pending (pre-existing capability skips), `quereus-isolation` 374 passing.
- Targeted re-runs after the review edits: the 4-case
  `test/runtime/analyze-eager-exec.spec.ts` and the full `quereus-isolation` suite —
  both green.
- `yarn docs:check` fails on `docs/schema.md`'s word-count ratchet. Pre-existing and
  already tracked as `debt-doc-size-ratchet-red-at-head` in
  `tickets/.pre-existing-known.md`; not re-reported. The `docs/runtime.md` addition
  here is within that file's own ratchet grace band.
