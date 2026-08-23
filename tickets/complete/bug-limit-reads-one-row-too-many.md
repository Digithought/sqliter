---
description: A query with LIMIT used to read one more row than it returned; it now reads exactly what it returns, and a LIMIT placed over something that writes rows no longer cuts the writing short.
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts                    # the fix, plus a review-stage decomposition
  - packages/quereus/src/runtime/emit/ordinal-slice.ts                   # review-stage NOTE: why its break needs no drain gate
  - packages/quereus/test/runtime/early-stop-consumption.spec.ts         # the generalized "consume what you emit" spec
  - packages/quereus/test/logic/01.9.1-limit-over-dml-subquery.sqllogic  # LIMIT over a writing source, end to end (was 13.13-*)
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts        # BOUNDARY_ROWS 2 -> 1
  - docs/sql-select.md                                                   # § Query expressions — drain rule, and its scope
  - docs/runtime.md                                                      # § Impure subquery emitters — now names the LIMIT emitter
  - docs/architecture.md                                                 # query-expression bullet — same omission
repro: verified
---

# `LIMIT n` no longer consumes row `n + 1`

## What shipped

`packages/quereus/src/runtime/emit/limit-offset.ts` tested its counter at the **top** of
its loop, so `for await` had already asked the source for one more row before the `break`
fired. Every `LIMIT n` pulled `n + 1` rows; `LIMIT 0` pulled one.

**Arm 1 — stop pulling at the last row emitted.** The limit test moved below the `yield`
(the shape `ordinal-slice.ts` already used), plus a `limit <= 0` early return so a zero
limit never touches the source. Row counts are now exactly `offset + limit`.

**Arm 2 — a LIMIT never truncates a writing source.** `subtreeHasSideEffects(plan.source)`
is evaluated once at emit time (the same gate `emitExists` / `emitScalarSubquery` use).
When true, the emitter stops *yielding* at the limit but keeps *consuming*, so the DML
underneath runs to completion — lining the FROM-subquery case up with the
data-modifying-CTE case, the scalar / `IN` / `EXISTS` cases, and PostgreSQL. A pure source
pays one subtree test at emit, nothing per row.

Measured on the memory backend, table `t` with 4 rows, `rowsScanned` from
`Statement.getWorkCounters()`:

| statement | returns | pulled BEFORE | pulled NOW |
|---|---|---|---|
| `select k from t limit 1` | 1 | 2 | 1 |
| `select k from t limit 2` | 2 | 3 | 2 |
| `select k from t limit 0` | 0 | 1 | 0 |
| `select k from t limit 2 offset 1` | 2 | 4 | 3 |

## Review findings

Read the implement-stage diff (`1e7e803dd`) before the handoff, then probed the runtime
directly with a throwaway spec (since deleted) rather than trusting the handoff's claims.

### Checked and clean — no finding

- **The core fix is right, and the `limit <= 0` early return is load-bearing.** With the
  limit tested after the `yield`, a zero limit that entered the loop would fall through to
  the drain `continue` and read the *whole* source. The early return is the only thing
  stopping that, and the `LIMIT 0` case in `early-stop-consumption.spec.ts` pins it.
- **No optimizer rule can strand the drain.** Audited every rule that constructs, matches,
  or rewrites a `LimitOffsetNode`. `ruleLimitOffsetFoldEmpty` only folds when the source is
  *already* an empty relation — there is no `LIMIT 0 → Empty` rewrite that could drop a
  write. `ruleMonotonicLimitPushdown` and `rule-grow-retrieve`'s limit extraction both peel
  down to a physical access leaf advertising ordinal seek, which a mutation node never is.
  `rule-grow-retrieve` pushes `limit + offset` to the module, which matches the emitter's
  new exact `offset + limit` pull.
- **Composition holds, and I measured it rather than reasoning about it.** Ran an outer
  `LIMIT` over an inner `LIMIT` over an INSERT, an `EXISTS` over a limited DML, and a join
  with a limited DML on one side: all four rows written in every case. This works because
  `subtreeHasSideEffects` is subtree-wide, not "is my child a mutation" — see the new
  regression case below.
- **`ordinal-slice.ts` is correct by inspection** (yield, then test; `limit <= 0` early
  return) and its lack of a drain gate is *structurally* safe, not merely dormant.
- **`work-counter-tables.spec.ts` left alone deliberately.** Its `limit 2` case still
  asserts `at.least(2)` / `lessThan(5)`, which the new exact count of 2 satisfies. The
  handoff flagged it as "no longer discriminating, worth a look" — it is, but that test's
  stated purpose is that counters report the partial count an execution *actually* did, not
  where the engine stops. The exact number is now owned by `early-stop-consumption.spec.ts`;
  tightening this one would duplicate that and couple an unrelated test to the stop point.

### Minor — fixed in this pass

- **The end-to-end test was filed in the CTE family.** `13.13-limit-over-dml-subquery`
  contains no CTE; `13.x` is the CTE corpus, and `01.9-query-expr-dml.sqllogic` is the file
  that already pins full-drain for a writing inner in every relation position — including
  FROM-source. Renamed to `01.9.1-limit-over-dml-subquery.sqllogic`, header rewritten to
  say it is that file's LIMIT arm, `src13`/`u13`/`x13` renamed off the stale number, and
  the three references updated.
- **The `limit <= 0` comment understated its own consequence** ("would pull a row the query
  can never emit" — it would drain the entire source). Rewritten, with the pinning test
  named.
- **`docs/sql-select.md` claimed the drain unconditionally.** Verified false: a caller that
  reads one row of `select … from (insert … returning …) limit 5` and breaks out of the
  iteration performs one insert, not four. That is not LIMIT-specific — the same caller
  breaking out of the same statement *without* a LIMIT also gets one insert — and `LIMIT 0`
  is immune, because it drains on the first `next()`. Added a *Scope* paragraph stating all
  three, and a matching note in the sqllogic header. This is the engine's lazy-streaming
  contract, so it is documented, not ticketed.
- **`docs/runtime.md` § "Impure subquery emitters: full-drain + run-once" still listed only
  scalar / `IN` / `EXISTS`** — and `sql-select.md` points readers there "for the
  emitter-level mechanics", so the one doc a reader lands on omitted the new emitter. Added
  a paragraph for `emitLimitOffset`, including why it takes the full-drain half but not the
  run-once half (a LIMIT is not re-evaluated per outer row).
- **`docs/architecture.md`'s query-expression bullet had the same omission** — one clause
  added.
- **`run()` had grown to ~67 lines** mixing argument unpacking, coercion, clamping, and
  iteration. Extracted `resolveWindow` + a `RowWindow` type; the generator is ~48 lines and
  the clamp rules are now documented in one place with their pinning tests named.
- **Added a composition regression case** to the sqllogic file: an outer LIMIT over an
  inner LIMIT over an INSERT still writes every row. Narrowing the drain gate to "my direct
  child is a mutation" would silently reintroduce the truncation one level up, and nothing
  caught that before.

### Major — none

Nothing rose to a new ticket. Arm 2 is a semantics choice, not a defect, and it is the one
the fix ticket recommended; it is now pinned in four places (the sqllogic file, one case in
`early-stop-consumption.spec.ts`, `docs/sql-select.md`, `docs/runtime.md`), so reversing it
stays a bounded change if a maintainer disagrees.

### Appended to an existing ticket rather than filed fresh

- `backlog/bug-null-limit-returns-no-rows` already claims `runtime/emit/limit-offset.ts`.
  Appended an arm: measured that `limit -1` over a **writing** source now returns nothing
  and writes all four rows, where before it wrote one — no test pins either answer, so
  whichever semantics that ticket picks has to decide it. Also recorded that the
  `Infinity`-destroying guard it quotes moved into `resolveWindow`.

### Tripwires parked

- `runtime/emit/limit-offset.ts`, at the drain branch — the implementer's `NOTE:` that rows
  swallowed after the limit still travel the whole pipeline between the write and the LIMIT.
  Verified in place and kept as written.
- `runtime/emit/ordinal-slice.ts`, at its streaming break — new `NOTE:` recording that this
  break needs no drain gate only because the substituting rule peels to a physical access
  leaf, so a write can never sit under it; if that stops holding it needs the same
  `subtreeHasSideEffects` drain, and the early-stop spec needs a case driving it.

### Gaps carried forward, unchanged

- **`OrdinalSlice` early stop is still unexercised.** No shipped module advertises
  `supportsOrdinalSeek` (`vtab/memory/module.ts` defers it), so there is no honest way to
  drive it. Not a ticket: the operator is correct by inspection and unreachable, and both
  facts are now parked at the code site and in the spec's header comment.
- **Store mode not run** (`yarn test:store` exceeds a ticket run's budget). The new
  sqllogic file uses only plain tables and DML, so it should be backend-neutral — reasoning,
  not a measurement.
- **Benchmarks not run.** A grep of `bench/suites/` found no SQL-level LIMIT workload that
  records work counters, so no reference baseline should move. Unmeasured, but the grep is
  the whole surface.

## Validation

`yarn lint` clean across all workspaces. `yarn test` clean: 10191 passing / 0 failing in
`packages/quereus`, every other workspace green. No pre-existing failures surfaced.
