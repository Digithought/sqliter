<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-09-03T13:09:11.812Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\1-seek-vs-scan-baseline-quoted-by-the-module.review.2026-09-03T13-09-11-812Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: The query planner used to compare an index seek's price against a whole-table read priced from a different guess at the table's size, so on tables nobody had measured the index lost and the same condition got checked twice on every row; both prices now come from the storage backend itself.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts        # the fix: new `baselineScanCost` (~733) + the reworked veto (~559)
  - packages/quereus/test/optimizer/seek-vs-scan-baseline.spec.ts            # new spec, 8 cases
  - docs/optimizer-costing.md                                               # "Where a module's own size fits" — new paragraph
  - docs/optimizer-retrieve.md                                              # "Key properties" — corrected the "no cost modeling" claim
difficulty: medium
----

# Review: seek-versus-scan baseline is quoted by the module

## What the change does

`rule-grow-retrieve`'s index-style fallback (`fallbackIndexSupports`) decides whether to
push a predicate into a storage backend's index. It compares the backend's quoted seek cost
against a whole-table baseline and declines when the seek does not win.

Before this change the two numbers came from different places, and therefore from different
table sizes:

- the **seek** cost was quoted by the module, which may keep a live row count
  (`quereus-store` does);
- the **baseline** was `seqScanCost(request.estimatedRows ?? 1000)` — the engine's own
  formula over the *catalog's* number, which is `undefined` when nobody ran `ANALYZE` and a
  stale `0` when `ANALYZE` ran before the table was filled.

Where the two disagreed, the honest seek lost to a fabricated scan, the push-down was
declined, and `selectPhysicalNode` re-attached the predicate as a `Filter` **above** the
seek that had already bounded the rows — a whole extra pass over rows already narrowed.

The baseline now comes from a second probe of the **same module**: same request, with
`filters`, `requiredOrdering`, `limit` and `offset` stripped. Symmetric by construction; no
new module interface. `seqScanCost` survives only as the fallback for a module answering a
non-finite cost, and nothing re-fabricates 1000 onto the request (that would re-break
`ask-the-backend-before-guessing-its-size`).

One deliberate deviation from the ticket's prototype: the baseline probe was moved **below**
the early returns and inside `if (!providesOrdering)`. The veto never fired when the plan
supplied the requested ordering, so fetching a baseline there was pure waste. Behavior is
identical; the extra probe is now paid only on the branch that reads it. The `else` arm
keeps a "beneficial" log line so the trace is unchanged in shape.

## What was verified, and how

**The six-cell store table from the source ticket — all six now plan as a bare
`INDEXSEEK`, no residual `FILTER`.** Reproduced against `@quereus/store` over the in-memory
KV provider, `create table bench_t (id integer primary key, val integer)`, plan read from
`query_plan('select * from bench_t where id < 500')`:

| catalog state | 4 000 rows | 10 000 rows |
|---|---|---|
| never analyzed | bare seek | bare seek |
| `analyze` while empty, then filled | bare seek | bare seek |
| `analyze` after filling | bare seek | bare seek |

At HEAD, three of those six cells carried a `FILTER` above the `INDEXSEEK`. The script that
produced this table was a throwaway in the scratchpad, run against the built `dist`; it was
deleted and is **not** in the tree. The engine-side spec below is the durable version.

**New spec: `packages/quereus/test/optimizer/seek-vs-scan-baseline.spec.ts` — 8 cases, all
passing after, 5 failing before.** Confirmed by restoring the single source file to its HEAD
content, running the spec, and putting the fix back. The 5 that fail at HEAD:

```
✗ never-analyzed @ 8000 / 10000 / 50000 live rows   (above the ~7000-row break-even)
✗ stale measured 0 @ 1000 live rows                 (this arm fails at EVERY size)
✗ stale measured 0 @ 10000 live rows
```

The never-analyzed @ 1000 case passes at HEAD by design — it sits *below* the break-even, and
is in the parameterization precisely so a future cost-constant change that slides the flip
cannot leave the test green for the wrong reason.

**Full validation:**

- `yarn build` — clean
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json` over the spec)
- `yarn typecheck` — clean
- `yarn test` — full monorepo, green. `@quereus/quereus` alone: **10 390 passing, 0 failing,
  25 pending** (10 382 at HEAD + the 8 new cases)
- `yarn bench:gate` — **56 match, 0 differs, 0 failed; all four ratio guards hold.** At HEAD
  the same gate reported 12 differs. As the source ticket predicted, the gate went green on
  its own and **`yarn bench:accept` was NOT run** — `bench/reference/store.json` was already
  the pre-regression truth

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## The test double, and what it stands in for

`MemoryTableModule` substitutes a flat 1000 for an unknown request size, so it cannot show
this defect on its own. The spec subclasses it into `SelfSizingMemoryModule`, which
substitutes a configurable `liveRows` — the engine-side equivalent of `quereus-store`'s
`sizeRequestFromLiveCount`, including its `staleEmptySnapshot` behavior (`overrideStaleZero`)
of correcting a measured-but-stale `0`. No rows are inserted and nothing is read; the whole
spec is planning-only and runs in ~140 ms.

## Where a reviewer should push hardest

Honest gaps, in rough order of how much they would repay a second look:

- **The double is a stand-in, not the real store.** The spec pins engine behavior against a
  synthetic self-sizing module. The real `quereus-store` path is covered only indirectly —
  by the bench gate and by the throwaway six-cell script above. A reviewer who wants a
  durable store-side assertion would add one in `packages/quereus-store/test/`; I judged the
  bench gate sufficient and did not.
- **The `!providesOrdering` restructure is mine, not the ticket's.** The claim is that
  behavior is identical because the old veto was `accessPlan.cost >= seqCost &&
  !providesOrdering`. Worth confirming the `else` branch cannot now reach `assembleResidual`
  in a state the old code would have rejected. I believe it cannot — the old code's only
  other exit was the same condition — but this is the one place the diff is not a mechanical
  substitution.
- **The non-finite fallback is untested.** `BestAccessPlanResult.cost` is a required
  `number`, so `Number.isFinite(baseline.cost) === false` should be unreachable; no spec
  drives it. It is defensive code that degrades to old behavior. If a reviewer wants it
  covered, a module returning `NaN` from a filter-free probe would do it in three lines.
- **The break-even is a measured constant, not a derived one.** "~7000 rows for the memory
  backend, ~6667 for the store" comes from reading the range arm's `rows * 0.3` /
  `0.2 + rows * 0.5` shapes and confirming the flip empirically. The spec straddles it rather
  than asserting it, which is the right call, but nothing pins the constants themselves.
- **Ordering-providing plans no longer fetch a baseline at all.** If a future change ever
  makes the veto apply to an ordering-providing plan, the probe has to move back out of the
  `if`. No test guards that; it is a structural property of the current control flow.

## Tripwire parked

- `packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`, in the
  `baselineScanCost` doc comment: a `NOTE:` recording that the fix costs one extra
  `getBestAccessPlan` call per grow attempt that reaches the seek-versus-scan veto. Measured
  as free (no gated bench counter moved, all four ratio guards held), but a module with an
  expensive `getBestAccessPlan` pays it twice per such attempt — the stated remedy is to
  memoize the filter-free answer per table per optimizer pass.

## Left alone deliberately

- **`createSeqScan`'s sibling `|| 1000`** in `rule-select-access-path.ts` (~1235). Same
  constant, different path — it feeds the engine's own cost model rather than a comparison
  with a module-quoted number. Already filed as
  `bug-measured-empty-table-costed-as-thousand-rows`, and the site carries a `NOTE:` saying
  so. Untouched.
- **The other `seqScanCost` callers** (`rule-materialized-view-rewrite`,
  `database-materialized-views-plan-builders`) compare engine-modelled costs against
  engine-modelled costs, so they are internally consistent. Untouched.

## For whoever picks up `feat-memory-backend-sizes-itself`

That backlog ticket would make the default in-memory backend report its real size the way
the store does — which would have landed exactly this bug on the backend the entire test
suite runs on. **This fix pre-empts it: the asymmetry is already closed.** The new spec's
`SelfSizingMemoryModule` is also a ready-made preview of what that change makes the real
module do, so it doubles as a regression guard for it.

## Docs updated

- `docs/optimizer-costing.md`, *Where a module's own size fits* — new paragraph explaining
  that the one place the engine compared against a module-quoted number now goes through the
  module too, and why.
- `docs/optimizer-retrieve.md`, *Key properties* — the claim "Purely structural — no cost
  modeling during growth" was already false (the veto is cost modeling) and this change makes
  it more so. Replaced with two bullets that separate the genuinely structural `supports()`
  path from the cost-aware index-style fallback.
