---
description: Fixed a bug where tables with a descending primary key silently dropped most matching rows in joins, and extended the regression tests to cover mixed-direction composite keys.
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic
  - docs/module-authoring.md
repro: verified
---

# Memory-table scan advertises the true PK direction

## What was wrong

`findBestAccessPlan` in `packages/quereus/src/vtab/memory/module.ts` built the
"this scan comes back in primary-key order" advertisement from
`tableInfo.primaryKeyDefinition` but hard-coded `desc: false` for every column.
A table declared `primary key (id desc)` is walked descending by the in-memory
B-tree (the key comparator multiplies by -1 for a `desc` column —
`vtab/memory/utils/primary-key.ts:95`), so the planner was told the opposite of
the truth. The merge-join rule trusts that advertisement to decide whether it
can skip inserting a `Sort`; against an actually-descending stream the two
merge cursors walk away from each other and all but one matching row is
dropped. Every equi-join shape was affected (`IN`, `EXISTS`, inner join, left
join).

## Fix

`packages/quereus/src/vtab/memory/module.ts` — the PK-ordering advertisement now
reads each column's declared direction:

```ts
const pkOrdering: OrderingSpec[] = tableInfo.primaryKeyDefinition.map(col => ({
	columnIndex: col.index,
	desc: !!col.desc
}));
```

The consumer side needed no change: `equi-pair-extractor.ts`'s
`isOrderedOnEquiPairs` already treats `desc: true` as not merge-ready, so a
descending side now correctly gets an explicit `Sort` (or the cost model picks
hash / nested-loop). Only the upstream advertisement was lying.

## Review findings

**Fix correctness — confirmed.** Traced the memory B-tree comparator
(`utils/primary-key.ts:95`, `index.ts:119`) and the scan layer
(`layer/scan-layer.ts`): a forward walk of a `desc` key emits that column
descending, so `desc: !!col.desc` is the truthful advertisement. The descending
*scan direction* path (`isDescendingScan`, plan types 1/4) is only reached when
`requiredOrdering` is present, and that branch skips this advertisement block
entirely — no double-negation.

**Regression test actually regresses — confirmed by experiment.** Temporarily
reverted the one-line fix and re-ran
`node test-runner.mjs --grep "91-merge-join-edge"`: the added `mj_dpk` block
fails on the first `IN`-subquery assertion, then passes again with the fix
restored. The implementer's claim was not taken on faith.

**Test coverage gaps closed in this pass (minor, fixed inline)** — in
`test/logic/91-merge-join-edge-cases.sqllogic`:

- *Mixed-direction composite PK* (`primary key (a asc, b desc)`), which the
  handoff explicitly listed as untested. Added inner-join and left-join cases
  against a second mixed-direction table. This is a genuinely independent
  regression vector — verified by isolating the case in a scratch `.sqllogic`
  file and running it with the fix reverted; the join returns wrong rows, same
  as the single-column case.
- *Sort absorption over the same advertisement* — `order by id` and
  `order by id desc` against the `desc`-PK table. These pass both with and
  without the fix (the `ORDER BY` path goes through `adjustPlanForOrdering`,
  which was always direction-aware), so they are a cheap guard on the
  absorb-Sort rule rather than a regression test for this bug. Kept and labeled
  as such.

**Sibling sites audited — all already correct, no further work.** Checked every
producer of an ordering advertisement in the repo:

- `buildMonotonicAdvertisement` (`module.ts:465`) derives its direction from
  `leadingCol.desc` — never wrong.
- The store backend's `buildPkOrderingAdvertisement`
  (`packages/quereus-store/src/common/store-module-access-plan.ts:458`) already
  used `desc: !!col.desc`.
- The isolation overlay passes the underlying module's plan straight through,
  and its overlay-merge comparator is direction-aware
  (`quereus-isolation/src/isolated-table.ts:976,1039`).
- `quereus-isolation/src/filter-info.ts:25`'s `desc: false` describes an
  equality point lookup, where direction has no meaning. Left alone.

**Docs (were stale, fixed inline).** `docs/module-authoring.md` documented
`providesOrdering` without ever saying the direction flag must match the real
emit direction — exactly the contract this bug broke. Added a capability-contract
bullet stating the rule and the consequence of getting it wrong.

**Tripwire recorded, not filed.** `indexSatisfiesOrdering` (`module.ts`) never
compares `OrderingSpec.nullsFirst`, while the store module's equivalent declines
the index when an explicit NULLS FIRST/LAST is requested. Nothing in the planner
populates `nullsFirst` today (it exists only as a type field), so this is dormant,
not a live defect. Parked as a `NOTE:` comment on `indexSatisfiesOrdering`'s doc
block rather than as a ticket.

**Accepted, not addressed.** The handoff wanted `EXPLAIN` output pinned to prove
a merge join is (or is not) chosen for the `desc`-PK shapes. Not added: pinning
plan shape makes the test brittle against cost-model tuning, and the
revert-and-watch-it-fail experiment above is stronger evidence that the
advertisement drives the behavior under test.

**No new tickets filed** — nothing found rose above "fix it here", and the one
conditional concern became a tripwire per the rules above.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file tsc pass).
- `yarn workspace @quereus/quereus run test` — 8552 passing, 13 pending, 0 failing.
- `yarn test:store` (LevelDB backend, re-runs the same `.sqllogic` file so the
  new mixed-direction cases run there too) — 8544 passing, 21 pending, 0 failing.
  Output carries repeated `[TransactionCoordinator] release/rollback-to savepoint
  … out of range` lines — pre-existing log noise from unrelated savepoint cleanup,
  present before this change; mocha reports 0 failing.
