---
description: When a table has several indexes that could answer a query, the persistent storage backend uses whichever one it happens to look at first instead of the cheapest, so a query can end up doing hundreds of index lookups where one would have done.
files:
  - packages/quereus-store/src/common/store-module.ts   # computeBestAccessPlan — the index loop
  - packages/quereus-store/test/pushdown.spec.ts        # where a regression test belongs
difficulty: medium
---

# Pick the cheapest usable index, not the first one

## What happens

`StoreModule.computeBestAccessPlan` walks the table's indexes and **returns the first
one** that can serve the query:

```ts
for (const index of indexes) {
    const plan = this.tryIndexAccessPlan(...);
    if (!plan) continue;
    if (plan.seekColumnIndexes && plan.seekColumnIndexes.length > 0) return plan;  // ← first wins
    ...
}
```

Each candidate plan already carries a `cost`, and nothing compares them. Which index the
query uses therefore depends on the order the indexes were declared in, not on how much
work each one saves.

## Why it matters now

This was mostly harmless while an index only qualified for a single-value equality — the
candidates were all roughly one seek. Now that an `IN` list on an indexed column also
qualifies (a "multi-seek": one index lookup per distinct list value), a *far worse* plan
can be the one that wins.

Reproduced against the current code:

```sql
create table two (id integer primary key, a integer, b integer) using store;
create index ix_b on two (b);   -- declared first
create index ix_a on two (a);
select id from two where a = 7 and b in (<300 values>);
```

Chosen plan: `INDEX SEEK two USING ix_b` with 300 seek keys, plus a residual
`FILTER WHERE a = 7`. The obviously better plan — one seek on `ix_a` — is never
considered, because `ix_b` is examined first. Swap the two `create index` statements and
the good plan comes back.

Results are correct either way; this is purely how much work the query does.

## What "fixed" looks like

The index loop keeps the lowest-`cost` seek plan rather than returning on the first hit,
and still falls back to the existing cost-only advertisement when no index yields a seek.

Worth checking while in there: the cost the multi-seek plan reports
(`inCount * 0.5 + rows * 0.3`) should actually price a many-key seek above a cheaper
single-key seek on another index — pick a case like the one above and confirm the numbers
order the way the intuition does, not just that a comparison now happens.

## Expectations

- A regression test with two candidate indexes where the better one is declared **second**,
  asserting the plan names it — and a mirrored case with the declaration order swapped, so
  the test proves cost-based choice rather than a reversed hard-coded order.
- Existing pushdown/plan-shape tests stay green without assertion edits; if one does change,
  that is a real plan change and needs its own justification in the handoff.
