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
- `feat-minmax-index-boundary` landed since this ticket was filed — and the "pressure
  drops considerably" prediction above did not hold. Its rewrite (`rule-minmax-index-
  boundary.ts`) still builds the bare `SortNode` probe with no `LimitOffsetNode` — the
  `LimitOffset(1)` is only wrapped on *after* `trySortAbsorbViaIndexOrdering` succeeds
  (`rule-minmax-index-boundary.ts:94-121`) — so it hits exactly this blindness. Landing
  `feat-minmax-index-boundary` removed the *shape* problem (no rule to absorb into) but not
  the *cost-visibility* one this ticket describes.

## Confirmed live on GitHub issue #31, 2026-08-24 — this is the actual blocker

A user running the real `@quereus/plugin-indexeddb` (not the in-memory reference provider)
reported `SELECT MIN(date) FROM entry WHERE entity_id = ?` over `idx_entry_entity_date
(entity_id, date)` still full-scanning post-`feat-minmax-index-boundary`, including the
*ascending* `MIN` case that ticket's own release comment said should already be fast.
Investigated and confirmed mechanically, not by inference:

- `IndexedDBProvider` declares a measured `costProfile.pointRead = 3.0`
  (`packages/quereus-plugin-indexeddb/src/provider.ts:106`); the reference
  `createInMemoryProvider()` defaults to `PARITY_COST_PROFILE.pointRead = 1.0`.
- `tryIndexAccessPlan`'s `eq`-arm veto (`store-module-access-plan.ts:689-737`) is linear in
  `pointRead`: the seek beats a full scan only while `selectivity ≤ 1/(0.3 + pointRead)` —
  **≈77% at `pointRead=1.0`, ≈30% at `pointRead=3.0`**. Because the veto never sees that
  only 1 row is needed (this ticket's exact gap), any `entity_id` with real-world
  selectivity above ~30% — plausible for a handful of entities over many rows each —
  makes the store module decline the composite-index arm entirely and return a plain full
  scan, which carries no ordering advertisement on `date`. `ruleMinMaxIndexBoundary` then
  finds nothing to absorb and returns `null`, unrewritten.
- The in-memory reference provider's ~77% threshold is forgiving enough that this was
  never observed in-tree — every test and every prior "confirmed working" check against
  `createInMemoryProvider()` sits under it. It reproduces only against a backend with a
  real, non-trivial `pointRead`, which today means only `IndexedDBProvider`.

So this ticket, not a store- or IndexedDB-specific bug, is the actual reason
`feat-minmax-index-boundary`'s ascending-`MIN` case doesn't help the one backend it was
aimed at. Both fix routes above remain open (upward-looking sort-absorb vs. a fused
sort-and-limit node) — that design call is still yours; this note is evidence, not a
resolution.

## Re-confirmed on GitHub issue #31, 2026-09-01 — still live on 4.18.0, mechanism agreed independently

The same reporter read the published 4.18.0 sources and reached this ticket's diagnosis without
being pointed at it, which is worth recording because it was reached from the opposite direction:
they were looking for the backward-index-walk gap and found this instead.

Their trace, re-checked and correct: `rule-minmax-index-boundary.ts` builds a bare `SortNode`
probe, hands it to `trySortAbsorbViaIndexOrdering`, and only **afterwards** wraps the result in a
`LimitOffsetNode(limit=1)` (the `probe` at ~line 97, `absorbed` at ~line 100, `limited` at
~line 116). So at the moment the store is asked whether it can serve the ordering, the request
carries no limit and the walk is priced for the whole table — exactly what the `NOTE:` on
`chooseOrderingPlan` (`packages/quereus-store/src/common/store-module-access-plan.ts`, ~825-830)
already predicted, naming this ticket as the enabling change.

They also confirmed the equality-seek-with-ordering arm does not rescue it:
`buildIndexOrderingAdvertisement` correctly advertises `date`-ordering off an `entity_id = ?` pin,
but that seek is likewise priced to resolve **every** matching row, so at `pointRead = 3.0` it
loses to the batched full scan. Same root cause, second path.

Still reproducing on 4.18.0: `select min(date) from entry where entity_id = ?` plans as
`StreamAggregate | Filter | IndexScan _primary_`, ~480 ms, no boundary read.

**Test-coverage consequence worth acting on whenever this is picked up.** This is invisible in
every in-tree test by construction: at the memory backend's cheap `pointRead` the ordered plan
wins *even when priced for the whole table*, so no memory-backend test can fail on it. Only a
high-`pointRead` cost profile flips the comparison. Whatever fix lands should come with a
cost-profile-parameterized case, or it will regress silently the same way.

Both fix routes named above remain open (upward-looking sort-absorb vs. a fused sort-and-limit
node); this changes the evidence, not the decision.
