description: When a table has several indexes that could answer a query, the persistent storage backend now picks the cheapest one instead of whichever it happens to check first, so a query no longer does hundreds of index lookups where one would do.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeBestAccessPlan — the fixed index loop
  - packages/quereus-store/test/pushdown.spec.ts                   # new 'cost-based index choice' describe block
difficulty: easy
---

# Pick the cheapest usable index, not the first one

## What changed

`computeBestAccessPlan` in `packages/quereus-store/src/common/store-module-access-plan.ts` used
to `return plan` on the first secondary index whose candidate claimed a seek — so with two
indexes both able to serve a predicate (e.g. a cheap single-key EQ on column `a` and an expensive
300-key IN multi-seek on column `b`), whichever index happened to be declared/iterated first won,
regardless of cost. Confirmed repro (in the original ticket) showed swapping two `create index`
statement order flipped the chosen index and the seek count (1 seek vs. 300 seeks) for the exact
same query.

The fix mirrors `MemoryTableModule.findBestAccessPlan`
(`packages/quereus/src/vtab/memory/module.ts:339`): the loop now keeps the lowest-`cost` seek
candidate (strict `<`, so ties keep the first candidate — deterministic across a stable index
order) and returns it after the loop, ahead of the pre-existing cost-only fallback. No change to
the cost formulas themselves (`AccessPlanBuilder` in
`packages/quereus/src/vtab/best-access-plan.ts`) — they already priced the multi-seek ~15x the
single-key seek; nothing was comparing the numbers.

The cost-only fallback (plans that claim no filters — full scan regardless) deliberately stays
first-wins, not min-cost: those plans don't discriminate on real work done, so ranking them by
cost would just understate a plan's advertised cost to the optimizer without changing anything
it does. This reasoning is recorded as a `NOTE:` at that site
(`store-module-access-plan.ts` ~line 243) for the next reader who's tempted to "fix" it too.

## Validation

- New regression tests in `packages/quereus-store/test/pushdown.spec.ts`, nested describe
  `'cost-based index choice (declaration order must not decide)'` inside the existing
  `'IN-list multi-seek (feat-store-in-list-index-pushdown)'` block (around line 1135):
  - cheaper index (`ix_a`, plain EQ) declared **second**, after the expensive one (`ix_b`,
    300-key IN) — plan still names `ix_a`.
  - same two indexes, declaration order swapped (mirrors the case above) — still `ix_a`.
  - **predicate swapped** instead of declaration order (`a` gets the 300-key IN, `b` gets the
    plain EQ, with declaration order fixed `ix_a` then `ix_b`) — plan now names `ix_b`. This
    is the case that actually isolates cost-based selection from a hard-coded/reversed order:
    the first two tests alone wouldn't distinguish "picks cheapest" from "now always picks the
    later-declared index."
  - Each test asserts both the chosen index (`query_plan()` `detail` column, via a new
    `planDetails()` helper alongside the existing `planOps()`) and the actual returned row ids,
    so a wrong-index choice AND wrong-rows are both caught.
- `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus-store/test/pushdown.spec.ts"` — 104 passing, including the 3 new tests.
- Full store suite (`packages/quereus-store/test/**/*.spec.ts`) — 1288 passing, 0 failing.
- `yarn test` (whole workspace) — all green, no failures (main `quereus` package 8336 passing,
  which includes the store suite above).

## Known gaps / things a reviewer should look at

- Only secondary-index vs. secondary-index competition was fixed/tested. The PK arms (full PK
  match, leading-PK range) still return immediately and are never compared against a secondary
  index — that's pre-existing behavior, unchanged by this ticket, and not verified either way
  here. If a case exists where a secondary index would be cheaper than a PK range scan, it's out
  of scope for this ticket.
- The new tests use a fixed, hand-picked cost gap (1 seek vs. 300 seeks, ~15x per the ticket's
  arithmetic) rather than a boundary/near-tie case. No test exercises the tie-break itself
  (equal-cost candidates); the `<` strict-inequality tie-break is a one-line change with no
  dedicated coverage. Low risk (falls out directly from `MemoryTableModule`'s established
  pattern) but flagging it as untested.
- No test exercises 3+ competing indexes in a single query — only ever two.

## Review findings

(none yet — reviewer to fill in)
