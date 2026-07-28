---
description: Fixed a bug where a WHERE condition was silently dropped — returning every row instead of the matching ones — when a query combined a column filter, a sub-select, and a sort the table's index already satisfied.
files: packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/rules/shared/index-style-context.ts, packages/quereus/test/filter-lost-under-index-order.spec.ts, packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic, packages/quereus/test/filter-conjunct-early-exit.spec.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic, docs/optimizer-rules.md
difficulty: medium
---

## What was wrong

```sql
create table o (id integer primary key, flag integer);
insert into o values (1, 1), (2, 1), (3, 0);

select id from o where flag = 0 and (select max(id) from o o2) > 0;           -- correct: 3
select id from o where flag = 0 and (select max(id) from o o2) > 0 order by id; -- WRONG: 1, 2, 3
```

`flag = 0` was silently discarded. No error, plain memory table, no plugins.

There are two channels by which a `RetrieveNode` records "the table access applies
this predicate":

1. a `FilterNode` wrapped around `Retrieve.source` (written by `rule-predicate-pushdown`)
2. an index-style context on `moduleCtx` — access plan + handled constraints +
   `residualPredicate` (written by `rule-grow-retrieve`)

They are mutually exclusive at physicalization. `ruleSelectAccessPath` takes an
early-return branch when `moduleCtx` is index-style, builds the leaf from the access
plan and `moduleCtx.residualPredicate`, and **never reads `source`**. So `source`
becomes a dead channel the moment the context exists.

`rule-predicate-pushdown` kept writing into channel 1 after channel 2 was committed.

Needed all four ingredients: an `order by` the index already satisfies (so the Sort is
absorbed and the index-style context gets equipped), a column comparison the module does
not claim (so it lands in the residual), a sub-select in another conjunct (so
`ruleGrowRetrieve` hoists the whole residual into a Filter *above* the Retrieve and
clears `moduleCtx.residualPredicate`), and pushdown then re-attacking that hoisted
Filter.

## The fix

One guard at the top of `tryPushDown`'s `RetrieveNode` branch in
`rule-predicate-pushdown.ts` (~line 66): if `isIndexStyleContext(child.moduleCtx)`,
decline and return null. The Filter stays above the Retrieve, where `ruleGrowRetrieve`
still absorbs it, re-probes `getBestAccessPlan` with the constraint, and residualizes
whatever the module declines — the same path that produces correct plans in every
working variant. Not a lost optimization.

## Testing / validation surface

**New — `packages/quereus/test/logic/07.7.5-filter-lost-under-index-order.sqllogic`**
(row sets). Invariant pinned throughout: each ordered variant returns the same row set
as the same query with no `order by`.
- scalar sub-select conjunct × {no `order by`, `order by id`, `order by id desc`}
- same × filtered column in the select list (`select id, flag`)
- conjuncts written in the reverse order
- `exists (select 1 from o o2 where o2.id > 0)` as the sub-select conjunct
- a variant keeping *two* rows (`flag = 1`), so a dropped predicate can't be mistaken
  for a correct single-row answer
- the three-conjunct shape: `select id, k from t where k = 2 and v % 5 = 2 and
  (select count(*) from t t2) = 12` over 12 rows, all three ordering variants — this one
  drops the pushed conjunct even with `k` selected
- `k = 2 and (select count(*) …) = 12` — multi-row result under absorbed ascending order

**New — `packages/quereus/test/filter-lost-under-index-order.spec.ts`** (plan shape).
Row-set-only coverage would silently pass again if a future rewrite reordered the
conjuncts, so this asserts the emitted program via `stmt.getDebugProgram()`:
- the failing query's top-level program still matches `/filter\([^\n]*flag = 0/`
- **the precondition itself**: ascending `order by id` produces no `sort(` instruction
  (absorbed) while `order by id desc` does — if absorption ever stops firing, the
  filter assertion would pass for the wrong reason and this test says so
- row parity ordered vs unordered
- the three-conjunct shape keeps `filter(… k = 2 …)` and returns `[12]`

**Restored (these tests had been written around the bug):**
- `test/filter-conjunct-early-exit.spec.ts` — `order by id` back on `a subquery conjunct
  is skipped for rows an earlier conjunct rejected`; NOTE block deleted
- `test/where-conjunct-ordering.spec.ts` — the two three-conjunct tests go back to
  `order by id`; NOTE deleted. Also restored `select id` (was `select id, flag`) in `a
  correlated conjunct gives the same rows in either written position`, whose comment
  referenced the same dodge
- `test/logic/07.7.4-where-conjunct-ordering.sqllogic` — `order by id desc` → `order by
  id` on both three-conjunct queries; NOTE deleted

**Runs:** `yarn test` from repo root — 7676 + 341 + 109 + 61 + 17 + 28 + 1156 + 594 + 52
+ 31 + 34 + 134 + 22 passing, 13 pending, **0 failing** (quereus went 7671 → 7676: four
new spec tests plus the new sqllogic file). `yarn lint` clean. No pre-existing failures
surfaced.

## Tripwire recorded (not filed as a ticket)

`RetrieveNode.source` is decorative once `moduleCtx` is index-style — nothing reads it.
Any *future* rule that writes a predicate there will lose it exactly as this one did.
Rebuilding the source pipeline inside the index-style branch is **not** the remedy: that
branch also legitimately discards a Sort/LimitOffset that absorption already elided, so
rebuilding would resurrect them. Parked as `NOTE:` comments at the three sites where a
reader would meet it — `rule-select-access-path.ts` (index-style early return),
`rule-grow-retrieve.ts` (where the decorative Filter is built, and why: it feeds
`collectBindingsInPlan`), and the `IndexStyleContext` doc comment in
`rules/shared/index-style-context.ts`.

## Known gaps for the reviewer

- The guard is unconditional: pushdown declines for *any* index-style Retrieve, not only
  ones where the push would be lost. Believed free (grow-retrieve re-absorbs), and the
  full plan-shape golden corpus is unchanged — but that is evidence, not proof, and a
  module with an unusual `getBestAccessPlan` could in principle re-probe differently
  than it did the first time.
- Coverage is memory-module only. `yarn test:store` (LevelDB path) was not run — it is
  the slow suite and outside this ticket's default. A store module with different
  `handledFilters` behaviour exercises the same code path.
- The `isIndexStyleContext` guard is discriminant-only (pre-existing; noted in its own
  NOTE). It is sound while `ruleGrowRetrieve` is the sole writer of that channel.
- No coverage for the *other* channel-confusion direction: a rule writing into
  `moduleCtx` on a Retrieve whose `source` already carries a Filter. Not known to occur.
