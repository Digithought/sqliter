---
description: Asking for the largest or smallest value per category — "the newest entry for each account" — reads the whole table, even when an index already groups the rows by category and sorts them within each one, so the answer could be read one row per category.
prereq: feat-minmax-index-boundary
files:
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # the ungrouped rule this generalizes
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts            # trySortAbsorbViaIndexOrdering — the ordering probe
  - packages/quereus/src/vtab/memory/module.ts                                   # indexSatisfiesOrdering — composite index prefix matching
  - packages/quereus/src/planner/util/fd-utils.ts                                # keysOf / isUnique — for reasoning about group counts
severity: cosmetic
likelihood: normal-use
tradeoffs: This is the valuable half of the min/max optimization and also much the harder half — it needs a plan operator that does not exist yet (walk an ordered stream and emit the first row of each group, or seek group-to-group), whereas the ungrouped case reuses machinery that already ships; a maintainer may reasonably wait until the ungrouped rule has proven itself.
---

# Read grouped MIN / MAX one row per group instead of scanning

## The shape

```sql
select account, max(entered_at) from entry group by account
```

With an index on `(account, entered_at desc)` the answer is the first row of each
`account` run in that index — one row read per distinct account, however many entries
each account has. Today the query streams every row through the aggregate.

`feat-minmax-index-boundary` handles the ungrouped case (`select max(entered_at) from
entry`) by rewriting it into "sort by that column, take one row" and letting the
existing sort-absorption machinery answer it from the index. That trick does not
generalize: there is no "take one row per group" shape in the planner to rewrite into.

## What would have to exist

Two plausible routes, both bigger than the ungrouped rule:

- **Streaming first-per-group.** Given a stream already ordered by
  `(group keys…, aggregated column)`, emit the first row of each group and skip the
  rest of the run. Cheap to implement, but it still *reads* every row — the win is
  only the aggregate work, not the I/O, unless the access path can skip ahead.
- **Group-skipping seek.** Read the first row of a group, then seek directly to the
  start of the next group rather than walking through it. This is where the real win
  is (proportional to the number of groups, not the number of rows), and it needs an
  access-path capability the modules do not advertise today: "reposition to the next
  distinct value of the leading key column".

Deciding between them — or doing the first as a stepping stone to the second — is the
design question, and it should be settled in a `plan/` pass rather than assumed here.

## Worth noting

The second route is the same primitive `select distinct <indexed column>` wants (see
`feat-distinct-from-ordered-access`). If both are wanted, they should be designed
against one capability rather than two.
