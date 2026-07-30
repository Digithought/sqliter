---
description: When a table has several indexes that could answer a query, the persistent storage backend uses whichever one it happens to look at first instead of the cheapest, so a query can end up doing hundreds of index lookups where one would have done.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeBestAccessPlan — the index loop (NOT store-module.ts)
  - packages/quereus-store/test/pushdown.spec.ts                   # where the regression test belongs
  - packages/quereus/src/vtab/memory/module.ts                     # findBestAccessPlan — the min-cost precedent to mirror
  - packages/quereus/src/vtab/best-access-plan.ts                  # AccessPlanBuilder cost formulas
difficulty: easy
---

# Pick the cheapest usable index, not the first one

## Confirmed reproduction

Ran against current `main`, store module, `query_plan()` output:

```sql
create table two (id integer primary key, a integer, b integer) using store;
create index ix_b on two (b);   -- declared first
create index ix_a on two (a);
select id from two where a = 7 and b in (<300 values>);
```

→ `INDEX SEEK two USING ix_b` (a 300-key multi-seek) plus a residual `FILTER WHERE a = 7`.

Swap the two `create index` statements and the same query picks `ix_a` — one seek, residual on
`b`. Declaration order is the whole decision. Rows are correct either way; only the work differs.

## Cause

`computeBestAccessPlan` in `packages/quereus-store/src/common/store-module-access-plan.ts`
(the ticket's original `files:` pointed at `store-module.ts`, which only forwards to this
free function). The secondary-index loop returns on first hit:

```ts
for (const index of indexes) {
    if (index.columns.length === 0) continue;
    const plan = tryIndexAccessPlan(db, tableKeyCollation, tableInfo, request, index, estimatedRows);
    if (!plan) continue;
    if (plan.seekColumnIndexes && plan.seekColumnIndexes.length > 0) return plan;  // ← first wins
    if (!costOnlyFallback) costOnlyFallback = plan;
}
```

Every candidate already carries a `cost` (required field on `BestAccessPlanResult`, always set
by `AccessPlanBuilder`), and nothing compares them.

The in-memory module already does the right thing — `MemoryTableModule.findBestAccessPlan`
(`packages/quereus/src/vtab/memory/module.ts:339`) keeps `indexPlan.cost < bestPlan.cost`.
Mirror that shape.

## The costs do order correctly (checked, as the ticket asked)

`AccessPlanBuilder` (`packages/quereus/src/vtab/best-access-plan.ts:309`):
`eqMatch(rows, indexCost)` ⇒ `cost = indexCost + rows * 0.3`.

For the repro above, with the default `estimatedRows = 1000` and `rows = floor(1000 * 0.1) = 100`:

| candidate | shape | cost |
|---|---|---|
| `ix_a` (`a = 7`) | plain EQ seek | `0.3 + 100*0.3` = **30.3** |
| `ix_b` (`b in (300)`) | multi-seek, `inCount = 300`, `multiRows = min(1000, 300*100) = 1000` | `300*0.5 + 1000*0.3` = **450** |

So the many-key seek prices ~15× the single-key seek. The intuition and the arithmetic agree;
no cost-formula change is needed for this fix. Note the shape of *why*: both candidates estimate
the same `rows` (10% of the table per seek), so among equality candidates the plan with fewer
seek keys always wins — the seek-key count is doing all the discriminating.

## The fix

In the index loop, keep the lowest-`cost` seek plan instead of returning on the first one;
return it after the loop, before the existing cost-only fallback. Prototyped and verified: both
declaration orders then choose `ix_a`.

Tie-break on equal cost by keeping the **first** candidate (strict `<`, not `<=`), so the choice
stays deterministic across a schema whose index order is stable.

Leave the cost-only fallback selecting the first candidate. Those plans handle no filters — the
retrieve full-scans regardless — so "cheapest" among them is not a meaningful ranking, and
lowering the advertised cost of a plan that will scan anyway would only under-state cost to the
optimizer. (Record that reasoning as a `NOTE:` at the fallback site; it is the obvious next
thing a reader will want to "fix".)

Also refresh the block comment above the loop — it currently says a fully-handled seek "wins
immediately".

## Validation done during the fix stage

- Full store suite with the prototype applied: **1204 passing, 0 failing**
  (`node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/**/*.spec.ts"`).
  No existing pushdown/plan-shape assertion needed editing.
- The prototype was reverted; the working tree is unchanged at handoff.

## TODO

- Replace the first-wins `return plan` in the secondary-index loop of `computeBestAccessPlan`
  with min-cost selection (strict `<` tie-break, first candidate wins ties); return the winner
  after the loop, ahead of the cost-only fallback.
- Update the loop's block comment ("wins immediately" is no longer true) and add the `NOTE:`
  explaining why the cost-only fallback deliberately stays first-wins.
- Add regression tests to `packages/quereus-store/test/pushdown.spec.ts`, in the IN-list
  multi-seek describe block. Assert the chosen index name from `query_plan()` detail
  (`INDEX SEEK <table> USING <index>`) — `planOps` there only collects `op`, so either widen it
  or add a small helper that also selects `detail`:
  - better index declared **second**: `ix_b` then `ix_a`, `where a = 7 and b in (<many>)` →
    plan names `ix_a`.
  - mirrored declaration order (`ix_a` then `ix_b`), same predicate → still `ix_a`.
  - **reversed predicate** on a fixed declaration order (`ix_a` declared first,
    `where a in (<many>) and b = 7`) → plan names `ix_b`. This is the case that proves
    cost-based choice rather than a reversed hard-coded order; the two above alone do not.
  - rows stay correct in each case (assert the returned ids, not only the plan shape).
- Run `yarn test` and the store suite; confirm no existing assertion changes.
