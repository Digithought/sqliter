---
description: When a query filters on both a primary-key range and an indexed column, the persistent storage backend always scans the primary-key range even when using the other index would read far fewer rows, so such queries are slower than they need to be.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeBestAccessPlan — the leading-PK range arm returns before the secondary-index loop runs
  - packages/quereus-store/test/pushdown.spec.ts                   # where the analogous secondary-vs-secondary tests live
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: Rows returned are correct - the residual filter is retained - so this is speed only, and making the access-plan arms compete on cost means giving the primary-key arms a cost model they do not have today.
---

# Primary-key range scan wins over a cheaper secondary index

## What happens

`computeBestAccessPlan` decides an access path in fixed arms, in this order:

1. full primary-key equality (point lookup),
2. a range on the leading primary-key column,
3. secondary indexes.

Arms 1 and 2 `return` as soon as they match. So a query that could use *either* a
primary-key range or a secondary index never compares the two — arm 2 wins by position.
Ticket `bug-store-index-choice-ignores-cost` fixed the same class of problem *within*
arm 3 (secondary indexes now compete on cost); the arms themselves still don't compete.

Observed (store-backed table `t(id integer primary key, v integer)` with `create index ix_v on t (v)`):

```sql
select id from t where id > 0 and v = 7
-- plan detail: INDEX RANGE t USING primary ORDER BY 0
```

The rows returned are correct — the residual filter on `v` is retained — so this is a
speed problem, not a wrong-answer problem.

## Why it's worse than the alternative

The module's own cost model already says the secondary index is the better plan, and the
code ignores it. Per estimated table row:

- leading-PK range scan: `rows = 0.3 × estimated`, cost-per-row `0.2` → `0.06 × estimated`
- secondary-index equality seek: `rows = 0.1 × estimated`, cost-per-row `0.3` → `0.03 × estimated`

i.e. the arm that runs first is priced at **twice** the arm that never gets to run. (Both
figures read off `computeBestAccessPlan` / `tryIndexAccessPlan`; the estimate is the plan
model's, not a measured wall-clock number — no timing was taken.) The gap widens with
selectivity: a highly selective equality on `v` combined with an almost-unbounded PK range
(`id > 0`) scans essentially the whole table.

The full-PK-equality arm (arm 1) is not in question — a single-row point lookup is cheapest
by construction and should keep returning immediately.

## Expected behavior

A query with both a leading-PK range and an index-servable predicate should use whichever
access path the cost model prices lower, with the same "first candidate wins a tie"
determinism the secondary-index loop now has. Answers must stay identical either way —
whichever path loses, its filters go back to the residual.

## Worth deciding while specifying

- The PK range arm advertises PK ordering (`buildPkOrderingAdvertisement`); secondary-index
  seeks advertise no ordering at all. So a cheaper index seek can cost a downstream `Sort`
  that the PK range would have elided. A pure cost comparison would not see that, and could
  make `... where id > 0 and v = 7 order by id` slower overall. Whatever rule lands should
  say what it does when the request carries a `requiredOrdering` the PK arm satisfies.
- Test coverage should mirror the existing `cost-based index choice (declaration order must
  not decide)` block in `packages/quereus-store/test/pushdown.spec.ts` — assert the chosen
  path *and* the returned rows, so a wrong choice and a wrong answer are both caught.
