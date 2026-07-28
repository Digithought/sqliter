---
description: Fixed a bug where a WHERE condition was silently dropped — returning every row instead of the matching ones — when a query combined a column filter, a sub-select, and a sort the table's index already satisfied.
files: packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/shared/index-style-context.ts, packages/quereus/test/filter-lost-under-index-order.spec.ts, packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic, packages/quereus/test/util/debug-program.ts, docs/optimizer-rules.md, docs/optimizer-retrieve.md, docs/invariants.md
---

## What was wrong

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 0);

select id from o where flag = 0 and (select max(id) from o o2) > 0;           -- correct: 3
select id from o where flag = 0 and (select max(id) from o o2) > 0 order by id; -- WRONG: 1, 2, 3
```

`flag = 0` was silently discarded. No error, plain memory table, no plugins.

A `RetrieveNode` has two channels for recording "the table access applies this
predicate":

1. a `FilterNode` wrapped around `Retrieve.source` (written by `rule-predicate-pushdown`)
2. an index-style context on `moduleCtx` — access plan + handled constraints +
   `residualPredicate` (written by `rule-grow-retrieve`)

They are mutually exclusive at physicalization. `ruleSelectAccessPath` takes an
early-return branch when `moduleCtx` is index-style, builds the leaf from the access
plan and `moduleCtx.residualPredicate`, and never reads `source`. So channel 1 stops
executing the moment channel 2 exists, and `rule-predicate-pushdown` kept writing into
it anyway.

Needed all four ingredients: an `order by` the index already satisfies (so the Sort is
absorbed and the index-style context gets equipped), a column comparison the module does
not claim (so it lands in the residual), a sub-select in another conjunct (so
`ruleGrowRetrieve` hoists the whole residual into a Filter *above* the Retrieve and
clears `moduleCtx.residualPredicate`), and pushdown then re-attacking that hoisted
Filter.

## The fix

One guard at the top of `tryPushDown`'s `RetrieveNode` branch in
`rule-predicate-pushdown.ts`: if `isIndexStyleContext(child.moduleCtx)`, decline and
return null. The Filter stays above the Retrieve, where `ruleGrowRetrieve` still absorbs
it, re-probes `getBestAccessPlan` with the constraint, and residualizes whatever the
module declines. Both rules live in the Structural pass's fixed-point loop with
grow-retrieve registered first, so declining costs one extra iteration, not the
optimization.

## Test surface

- `test/logic/07.7.5-filter-lost-under-index-order.sqllogic` — row sets. Invariant
  pinned throughout: each ordered variant returns the same rows as the same query with
  no `order by`. Covers the scalar sub-select conjunct across
  {none, `order by id`, `order by id desc`}, the filtered column present/absent in the
  select list, reversed conjunct order, `exists (…)` as the sub-select conjunct, a
  variant keeping two rows, the three-conjunct shape over 12 rows, `limit`/`limit …
  offset` on top of the absorbed order, and `delete`/`update` with the same WHERE.
- `test/filter-lost-under-index-order.spec.ts` — plan shape via `getDebugProgram()`, so
  a future conjunct reshuffle cannot make a row-set-only test pass for the wrong reason.
  Asserts the surviving `filter(… flag = 0 …)` instruction, and separately that the
  precondition still holds (ascending order emits no `sort(`, descending does).
- Restored the `order by id` that three earlier tests had been written around:
  `filter-conjunct-early-exit.spec.ts`, `where-conjunct-ordering.spec.ts`,
  `test/logic/07.7.4-where-conjunct-ordering.sqllogic`. Their `NOTE:` blocks are gone.

## Review findings

Implement-stage diff read first, then the four rule files it touches plus
`docs/optimizer-retrieve.md` / `docs/invariants.md`, which it did not.

**Correctness of the fix — confirmed, no findings.** Traced the fixed-point interaction
by hand (grow-retrieve is registered before pushdown in the Structural pass, so the
declined Filter gets re-absorbed on the next iteration and the plan converges to the
same shape it had before the guard). Probed for adjacent instances of the same
lost-predicate class that the guard would not cover, all returning correct rows:
`limit` / `limit … offset` over the absorbed order, `distinct`, aggregate, derived
table, `in (select …)`, `delete`, `update`, composite primary key with full and partial
key equality, and inner joins where the filtered column is the primary key (which the
module *does* claim, so it never reaches the residual). Nothing reproduced. The
regression assertion was also checked against a real `getDebugProgram()` dump rather
than trusted from the regex alone.

**Fixed in this pass (minor):**

- The tripwire `NOTE:` blocks called `Retrieve.source` "decorative" / "nothing reads
  it". That is true only of `ruleSelectAccessPath`. Two other readers do walk it:
  `collectBindingsInPlan` (already noted) and `trySortAbsorbViaIndexOrdering`'s
  constraint sweep, which explicitly collects "Filters already pushed into
  `Retrieve.source`". A future reader acting on the blanket wording could stop
  populating `source` and silently break Sort absorption. Reworded both NOTEs to say
  `source` is dead as an *execution* channel, not dead weight.
- Docs were incomplete. `docs/optimizer-retrieve.md` § *Supported-only placement policy*
  is the file that describes the pushdown/grow protocol and still described pushdown as
  unconditional; added the decline-once-committed bullet. Amended invariant **OPT-022**
  in `docs/invariants.md` with the same rule and registered the new spec as one of its
  guards. (`docs/optimizer-rules.md` was already updated at implement time.)
- DRY: the `programOf` statement-dump helper was copy-pasted in three specs and the new
  spec added a fourth. Extracted to `test/util/debug-program.ts` (`programOf`,
  `topLevelProgram`) and pointed all four at it —
  `filter-lost-under-index-order.spec.ts`, `filter-conjunct-early-exit.spec.ts`,
  `and-or-short-circuit.spec.ts`, `runtime/case-comparison-collation.spec.ts`.
  `logic.spec.ts` keeps its own variant: it needs the prepare wrapped in the same
  try/catch as the dump, which the shared helper deliberately does not do.
- Test coverage gaps closed in `07.7.5-…sqllogic`: `limit` / `limit … offset` over the
  absorbed order (`LimitOffset` is the *other* operation grow-retrieve can turn into an
  index-style context, so it re-probes an already-committed plan), and `delete` /
  `update` with the same WHERE shape (the mutation planner runs the same rules, where a
  dropped conjunct would destroy rows the WHERE excluded rather than merely over-return).

**New tickets filed: none.** Nothing found rose to major — the one candidate is below.

**Tripwires recorded:**

- Implement-stage tripwire, still valid and left in place: a rule writing a predicate
  into a committed Retrieve's `source` loses it. Parked as `NOTE:` comments at
  `rule-select-access-path.ts` (index-style early return), `rule-grow-retrieve.ts` (the
  non-executing Filter, and why it is still written), and the `IndexStyleContext` doc
  comment in `rules/shared/index-style-context.ts`. Both of the first two were reworded
  as described above.
- New, recorded here only (no code site is wrong today, so no `NOTE:` was added):
  `fallbackIndexSupports` re-probes with the constraints of the *node being grown*
  alone. If a second Filter ever reaches a committed Retrieve carrying a predicate
  different from the one already folded into `accessPlan`, the re-probe would replace
  that plan with one that never saw the first predicate — and the first predicate lives
  only in the non-executing `source`. Every shape probed for this (join predicate
  inference, primary-key equality plus a later residual, limit-over-committed-plan)
  came back correct, so it is not reachable through the rules as registered today. It
  becomes reachable if a rule starts synthesizing a *new* Filter above a Retrieve whose
  original predicate the module fully handled.
- `rule-select-access-path.ts` is 1547 lines — the largest file in the rules tree. Not
  touched beyond a comment here and out of scope for a bug fix, but worth splitting when
  something substantive next lands in it.

**Checked, nothing found:** type safety (`isIndexStyleContext` is the only narrowing
path and no new casts were added), resource cleanup (statement finalization moved into
the shared helper unchanged), error handling (the guard's only effect is a `return null`
plus a log line, matching every other decline in the rule), file size and function
length of the changed code, and the accuracy of the three restored tests' expected
values against the data they insert.

**Validation:** `yarn lint` from `packages/quereus` (eslint + `tsc -p tsconfig.test.json
--noEmit`) exits 0. `yarn test` from the repo root: 7676 + 341 + 109 + 61 + 17 + 28 +
1156 + 594 + 52 + 31 + 34 + 134 + 22 passing, 13 pending, **0 failing** — identical
counts before and after the review edits. No pre-existing failures surfaced;
`tickets/.pre-existing-error.md` was not written. `yarn test:store` (the LevelDB path)
was not run — it is the slow suite and outside this ticket's default, so a store module
with different `handledFilters` behaviour remains unexercised against this guard.
