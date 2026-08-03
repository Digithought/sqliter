---
description: Fixed a bug where tables with a descending primary key silently dropped most matching rows in joins; this ticket hands the fix off for review.
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic
difficulty: easy
---

# Fix applied: memory-table scan now advertises the true PK direction

## Root cause (confirmed)

`packages/quereus/src/vtab/memory/module.ts` (`findBestAccessPlan`, the
"advertise PK ordering when no ORDER BY was requested" block) built the
`providesOrdering` advertisement from `tableInfo.primaryKeyDefinition` but
hard-coded `desc: false` for every column, ignoring the column's actual
declared direction (`col.desc`). For a table declared
`primary key (id desc)`, the in-memory B-tree really is walked descending, but
the planner was told the scan comes back ascending.

The merge-join rule (`rule-join-physical-selection.ts` /
`equi-pair-extractor.ts`'s `isOrderedOnEquiPairs`) trusts that advertisement
when deciding whether a merge join can run without an inserted `Sort`. With a
falsely-ascending advertisement on an actually-descending stream, the merge
join's two cursors walk away from each other and all but one matching row is
silently dropped. This affected every equi-join shape (`IN`, `EXISTS`, inner
join, left join) against a `desc`-PK memory table.

## Fix

One-line change — advertise the real direction:

```ts
const pkOrdering: OrderingSpec[] = tableInfo.primaryKeyDefinition.map(col => ({
	columnIndex: col.index,
	desc: !!col.desc
}));
```

(`packages/quereus/src/vtab/memory/module.ts`, in the PK-ordering-advertisement
block inside `findBestAccessPlan`.)

## Why no other code needed to change

- **Store backend** (`packages/quereus-store/src/common/store-module-access-plan.ts`,
  `buildPkOrderingAdvertisement`) already builds `desc: !!col.desc` — it was never
  wrong. Confirmed by running the new regression case under `yarn test:store`
  (LevelDB backend) — all green.
- **Merge-join direction check** (`equi-pair-extractor.ts`'s
  `isOrderedOnEquiPairs`, line ~55) already rejects `ordering[i].desc === true`
  as "not ordered for merge" — v1 of the merge-join emitter only streams
  ascending. So once the advertisement became truthful, a `desc`-PK side is
  correctly reported as *not* merge-ready: the physical-selection rule either
  inserts an explicit ascending `Sort` before merge, or the cost model picks
  hash/nested-loop instead. No separate "compare direction, not just column
  position" fix was needed there — it already did the right check; only the
  upstream advertisement was lying to it.

## Verification

- Added a regression block to
  `packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic` (this file
  runs under both `yarn test` and `yarn test:store`, so both backends are
  covered by one file, per the original ticket's request): a `PRIMARY KEY (id
  DESC)` table joined via `IN`, `EXISTS`, inner join, and left join against a
  plain table, asserting all three rows come back matched.
- `yarn workspace @quereus/quereus run test` — 8552 passing, 13 pending, 0
  failing.
- `yarn test:store` (LevelDB backend) — 8544 passing, 21 pending, 0 failing.
  (The `[TransactionCoordinator] release/rollback-to savepoint … out of range`
  lines in that run's output are pre-existing log noise from unrelated
  savepoint-cleanup paths, not failures — mocha reported 0 failing.)
- `yarn workspace @quereus/quereus run lint` and `run typecheck` — clean.

## TODO

- Nothing outstanding — implementation, regression test, and both backend
  test suites are done and green. Ready for review.
