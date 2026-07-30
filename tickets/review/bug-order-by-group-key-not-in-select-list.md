description: A grouped query that sorts by the column it grouped on used to fail with an internal error whenever that column only appeared in the output wrapped in an expression; the fix shipped earlier and this pass added the regression tests, docs, and a code note that lock it in.
files:
  - packages/quereus/src/planner/building/select.ts                        # branch keys off "did grouping run", not "are there aggregates"
  - packages/quereus/src/planner/building/select-aggregates.ts             # forced final projection + SELECT * expansion (comment added this pass)
  - packages/quereus/test/logic/07.3.1-group-by-order-by-key.sqllogic      # NEW — result coverage
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts            # NEW — plan-shape + column-order coverage
  - docs/sql-select.md                                                     # ORDER BY section: grouping keys are always sortable
difficulty: medium

----

# `order by <group key>` in a `group by` query with no aggregate functions

## What shipped

The planner fix landed in commit `6f915362` (before this ticket ran). This pass
verified it and added the coverage that was missing:

- `packages/quereus/test/logic/07.3.1-group-by-order-by-key.sqllogic` (new file;
  `07.3-group-by-extras.sqllogic` was already 217 lines) — 27 result assertions.
- `packages/quereus/test/plan/grouped-projection-shape.spec.ts` (new file) —
  9 plan-shape / output-column-order assertions.
- `docs/sql-select.md` §3.5 ORDER BY — one bullet + one example stating the rule.
- A `NOTE:` comment at the `!hasAggregates` guard in `select-aggregates.ts`
  recording why widening it is not a free change.

No production code changed in this pass beyond that comment.

## The bug, in one paragraph

`select cast(v as text) x from t group by v order by v` threw
`QuereusError: No row context found for column v`. Three things had to combine:
a `group by`, an `order by` naming a grouping key as a **bare column**, and a
select list with **no aggregate function at all**. The planner chose its
final-projection path from "does the select list contain an aggregate" rather
than "did a grouping phase run", so such a query took *both* paths and ended up
with a second, stale projection whose column references still pointed at
pre-aggregate attributes. `shouldApplyOrderByBeforeProjection` (which fires only
for a bare-column `order by` not in the alias list) then put a blocking `Sort`
*underneath* that stale projection, the source row context was gone by the time
it ran, and resolution failed. Adding `count(*)` or sorting by the output alias
hid it. Full root cause is in the git history of the implement ticket; the fix
is: branch on `hasGrouping = Boolean(aggregateResult.aggregateScope)`, force a
final projection for a grouped-but-aggregate-free select list, and teach
`buildFinalAggregateProjections` to expand `SELECT *`.

## What to exercise when reviewing

Run the two new files:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "07.3.1"
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/plan/grouped-projection-shape.spec.ts"
```

Shapes covered by the `.sqllogic` file (table `gk (v integer primary key, g text)`
holding `(1,'a'),(2,'b'),(3,'a')`):

| shape | why it is there |
|---|---|
| `select cast(v as text) x from gk group by v order by v` (+ `desc`) | the original repro |
| `select v+0 x …`, `select upper(g) x …` | arithmetic / function wrappers |
| `select g from gk group by g order by g` | bare grouping key, still no aggregate |
| `order by -v` | expression over a grouping key |
| `having v > 1 order by v`, `having g > 'a' order by g` | HAVING + the bare-column sort |
| `distinct`, `limit 1`, `limit 1 offset 1` | operators stacked above the sort |
| `group by g, v order by g, v` | multiple keys |
| `select g, upper(g) x … order by g` | key projected bare *and* wrapped |
| `select cast(v as text) x, count(*) c …` | the variant that always worked — must stay working |
| `select upper(g) x from gk order by g` | the **non-grouped** pre-projection sort path, still live |
| `select v, g …`, `select * …`, `select gk.* …` over `group by g, v` | source-column order, not GROUP BY order |
| derived table, CTE, `in (...)` subquery, scalar subquery, `union all` branch, materialized-view body | the grouped aggregate-free select must compose everywhere |
| NULL grouping key with explicit `nulls first` / `nulls last` | NULLs collapse to one group and sort where asked |

The plan-shape spec asserts the structural invariant that actually regresses if
the branch condition drifts back: exactly **one** `Project`, sitting below the
`Sort` and above the aggregate. It also pins output **column order** via
`getColumnNames()`, which the `.sqllogic` harness cannot do (row objects are
compared key-order-insensitively by chai, so a `(g, v)`-ordered result would
still deep-equal a `(v, g)` expectation).

## Verification actually run

- `yarn test` — **8108 passing, 0 failing** across the monorepo (8098 before;
  +10 = 1 new `.sqllogic` file + 9 new spec cases). `test/incremental/delta-aggregate.spec.ts`,
  the guard that caught the over-broad first attempt at this fix, still passes.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- The new `.sqllogic` file also passes under the **store** backend
  (`QUEREUS_TEST_STORE=true … --grep "07.3.1"`), so it does not need a
  `MEMORY_ONLY_FILES` entry.
- **Negative check**: with the two production edits temporarily neutered in the
  working tree, the new tests fail as intended and were then restored exactly
  (`git diff` clean against `6f915362`). Reverting *both* edits → 3 spec failures
  (two Projects instead of one) and the `.sqllogic` file dies on the original
  `No row context found for column v`. Reverting *only* the forced
  `needsFinalProjection` → 2 spec failures.

## Known gaps — please push on these

- **The `select *` / `select gk.*` column-order cases are weaker guards than
  they look.** With the fix reverted they still pass: an FD-driven GROUP BY
  reduction rewrites `group by g, v` (where `v` is the PK) into
  `group by v` + `min(g)`, which coincidentally yields source-column order. They
  guard the *new* star-expansion code in `buildFinalAggregateProjections` going
  forward, not the historical bug. The `select g, v from gk group by g, v` case
  in the same block **does** fail on revert, so the order assertion as a whole
  has teeth — but a reviewer wanting a sharper star test should look for a table
  shape where the FD reduction cannot fire (no PK among the grouping keys).
- **Default NULL placement under `desc` is deliberately unasserted.** The engine
  sorts NULLs first in both directions, which differs from SQLite (NULLs last
  under `desc`); `10.5.3-desc-index-ordering.sqllogic` already sidesteps the
  question with an explicit comment. The new NULL cases all pass an explicit
  `nulls first` / `nulls last`. Whether the default should change is a separate
  question nobody has filed — flagging it, not resolving it.
- **`select count(*) n from t group by g` returns two columns** (`g`, then `n`).
  Found while probing, reproduced on `main` at `6f915362`, unrelated to this
  diff (that path has no projection at all, and the branch this ticket changed
  behaves identically before and after for it). Filed as
  `backlog/bug-grouped-aggregate-only-select-returns-extra-column`, and the
  reason it is still broken — the load-bearing `!hasAggregates` guard — is now a
  `NOTE:` at the guard itself in `select-aggregates.ts`.
- **`select upper(g) x from t group by 2-1 order by g`** still fails with
  "Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP
  BY". Confirmed pre-existing (identical at `b06d2bfb`): `group by
  <non-literal constant expression>` is not recognised as a grouping key.
  Untested today and out of scope here; not filed.
- `select upper(g) x from t group by g collate nocase` is rejected by
  `validateAggregateProjections` both before and after the fix. Also out of
  scope, per the implement ticket.
- The new `.sqllogic` file was run under store mode; the new plan-shape spec is
  memory-only by construction (it asserts optimizer operator choice), which
  matches how the other `test/plan/*.spec.ts` files behave.

## Tripwires parked this pass

- `packages/quereus/src/planner/building/select-aggregates.ts` — `NOTE:` at the
  forced `needsFinalProjection`: widening the `!hasAggregates` guard re-routes
  grouped materialized-view incremental maintenance from residual-recompute to
  full-rebuild, and is the reason the aggregate-only leak above is still open.
