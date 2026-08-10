---
description: When a table has several indexes that could answer a query, the persistent storage backend now picks the cheapest one instead of whichever it happens to check first, so a query no longer does hundreds of index lookups where one would do.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeBestAccessPlan — the fixed index loop
  - packages/quereus-store/test/pushdown.spec.ts                   # 'cost-based index choice' describe block
  - packages/quereus-store/README.md                               # index-choice paragraph (was stale)
difficulty: easy
---

# Pick the cheapest usable index, not the first one

## What changed

`computeBestAccessPlan` in `packages/quereus-store/src/common/store-module-access-plan.ts` used
to `return plan` on the first secondary index whose candidate claimed a seek — so with two
indexes both able to serve a predicate (a cheap single-key EQ on column `a` and an expensive
300-key IN multi-seek on column `b`), whichever index happened to be declared first won,
regardless of cost.

The loop now keeps the lowest-`cost` seek candidate (strict `<`, so ties keep the first
candidate — deterministic across a stable index order) and returns it after the loop, ahead of
the pre-existing cost-only fallback. Mirrors `MemoryTableModule.findBestAccessPlan`
(`packages/quereus/src/vtab/memory/module.ts:339`). No change to the cost formulas
themselves — they already priced the multi-seek far above the single-key seek; nothing was
comparing the numbers.

The cost-only fallback (plans that claim no filters — full scan regardless) deliberately stays
first-wins, not min-cost; reasoning recorded as a `NOTE:` at that site.

Note the source edit landed in commit `c71e23f0` (an earlier, timed-out run of this ticket);
the tests and handoff landed in `31a40826`. The two commits together are the implement diff.

## Validation

- `packages/quereus-store/test/pushdown.spec.ts`, describe
  `'cost-based index choice (declaration order must not decide)'`: cheaper index declared
  second still wins; same pair declared the other way still wins; predicate swapped instead of
  declaration order flips the choice (isolates cost from order); equal-cost tie broken
  deterministically by declaration order (both orders); three competing indexes with the
  cheapest declared in the middle. Each asserts the chosen index (`query_plan()` `detail`) and
  the returned row ids.
- `yarn lint` — clean.
- `yarn test` (whole workspace) — all green, 0 failing (`quereus` 8336 passing, store suite
  1291 passing).

## Review findings

**Checked:** the implement diff read cold before the handoff (both commits — the source change
is in `c71e23f0`, not in the `31a40826` implement commit, which is tests only); the fixed loop
against the arms around it; whether the new tests actually fail without the fix; the ticket's
three self-declared gaps; docs touched and docs that *should* have been touched; `yarn lint` +
full `yarn test`.

**The fix itself is correct.** Mutation-tested: temporarily reverting the loop body to
first-wins turns 2 of the 3 original tests red (the third, cheaper-index-declared-first, passes
either way by construction — it is a control, not a regression guard). Restored; working tree
verified identical afterwards.

**Fixed in this pass (minor):**
- The three tests repeated table creation verbatim; folded into a `seedTwo(...declarationOrder)`
  helper.
- Gap the handoff flagged — no coverage of the equal-cost tie-break: added two tests (two plain
  EQ seeks price identically) asserting the first-declared index wins in both declaration orders,
  pinning stability rather than an arbitrary winner.
- Gap the handoff flagged — never more than two competing indexes: added a three-index test with
  the cheapest declared in the middle, so neither "first candidate" nor "last candidate" can be
  mistaken for cost-based choice.
- `packages/quereus-store/README.md:69` still stated index choice is "first-match, not cheapest"
  and pointed at this ticket as open backlog. Rewritten to describe the cost-based rule, the
  tie-break, and that the primary-key arms still take precedence.

**Filed as a new ticket (major):** `backlog/bug-store-pk-range-preempts-cheaper-index.md`. The
handoff listed the un-compared primary-key arms as an untested unknown; it is a real, reachable
missed optimization, verified by running it — `select id from t where id > 0 and v = 7` with an
index on `v` plans `INDEX RANGE t USING primary`, and the module's own model prices the
PK range arm at `0.06 × estimated` rows against the index seek's `0.03 × estimated`. Answers stay
correct (residual retained), so it is a plan-quality defect, not a correctness one. The ticket
also records the ordering wrinkle that makes it non-trivial (the PK arm advertises PK ordering,
index seeks advertise none).

**Considered and dismissed:** whether min-cost selection could silently drop an ordering
advertisement — it cannot *among secondary indexes*, because `tryIndexAccessPlan` never sets
`providesOrdering`/`monotonicOn` on a seek plan; only the PK arms and the full-scan fallback
advertise ordering. That is why the concern above is scoped to PK-vs-index and not to the loop
this ticket changed.

**Empty categories:** no tripwires recorded — every conditional concern noticed either already
had a `NOTE:` at its site from the implement pass (the cost-only fallback's first-wins choice,
the cost-only plan's missing PK-order advertisement) or was concrete enough to file as the ticket
above rather than park as a "if X later" note. No pre-existing test failures surfaced;
`.pre-existing-error.md` not written.
