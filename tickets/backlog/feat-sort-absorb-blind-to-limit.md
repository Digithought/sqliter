---
description: When a query says "sort by this column and give me the first row", the part of the planner that asks a storage backend whether it can supply the rows already sorted never mentions the "first row" part. So the backend prices the job as if every row were wanted, and can decline a shortcut that would have been enormously faster.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # trySortAbsorbViaIndexOrdering (~line 594) builds the request with no `limit`; the LimitOffset arm of tryIndexStyleAccess (~line 405) is the one place `request.limit` is populated
  - packages/quereus/src/vtab/best-access-plan.ts                      # BestAccessPlanRequest.limit / .offset — the fields already exist
  - packages/quereus/src/vtab/memory/module.ts                         # adjustPlanForOrdering — a consumer that would use it
  - packages/quereus-store/src/common/store-module-access-plan.ts      # the store's ordering-vs-sort comparison, which carries a NOTE pointing here
tradeoffs: The plan shapes this would change are ones where the current answer is merely slower, not wrong, and reaching a LIMIT that sits above a Sort means either walking further up the tree from a rule that currently looks only downward or introducing a fused sort-and-limit node — both bigger changes than the payoff for backends whose point reads are cheap, where the shortcut already wins without knowing the limit.
---

# The access-plan request never carries a LIMIT that sits above a Sort

## What happens today

`BestAccessPlanRequest` has a `limit` field, and a storage module is entitled to use it —
"how many rows does the caller actually want" is exactly the input that decides whether a
shortcut is worth taking.

Two places in the planner build that request when a sort is involved, and neither fills
the field in for the query shape where it matters most:

- `trySortAbsorbViaIndexOrdering` handles `ORDER BY` over a table. It builds its request
  with a required ordering and the query's filters, and no `limit` at all. It cannot see
  one: it is triggered by the sort node and only walks *downward* from there, while a
  `LIMIT` sits *above*.
- The other path, `ruleGrowRetrieve`'s limit arm, does populate `limit` — but it only
  fires when a limit sits directly above the table access, with no sort in between. Its
  own code comment records that this arm is unreached today.

There is no fused sort-and-limit node in the planner, so `... order by n limit 1` is a
limit above a sort above the table access, and the module is asked "can you give me every
row of this table in `n` order, and what would that cost?" — never "…and I only want one".

## Why it costs something

A module deciding whether to walk an index for its ordering is comparing two prices: walk
the index and resolve every entry it touches to its row, or read the table straight
through and sort it. Under a `LIMIT 1` the walk touches one entry; without the limit it is
priced as touching all of them.

For a backend whose random row reads are about as cheap as sequential ones — the
in-memory backend, LevelDB — the walk wins either way and nothing is lost. For a backend
where a random read crosses a boundary and costs several times a sequential row —
IndexedDB in a browser — the full-table price makes the walk lose, and the query sorts the
whole table to return one row.

That is the shape behind the report that started
`feat-store-secondary-index-ordering`: a user running the IndexedDB backend measured
`MAX(date)` over an indexed column at 450–900 ms on a 20,000-row table.

## What "fixed" would look like

The module's request carries the number of rows the caller can actually consume, so a
module can price a shortcut against that instead of against the whole table. Two obvious
routes, both bigger than they first look:

- let the sort-absorb rule see the limit above it — it would have to look upward from the
  sort, which no rule in that file does today;
- introduce a fused sort-and-limit plan node, so the limit is already part of the node the
  rule matches on.

Either way `request.offset` should travel with it, as it already does on the other arm:
a module can only stop early after `limit + offset` rows.

## Related

- `feat-store-ordering-only-index-walk` (the store's ordering walk) carries a `NOTE:` at
  its cost comparison pointing here — it is the first module-side consumer that visibly
  loses out.
- `feat-minmax-index-boundary` (backlog) attacks the same user-visible symptom from the
  other end: answer `MIN` / `MAX` by reading a single index entry, without needing a limit
  to be visible at all. If that lands first, the pressure here drops considerably.
