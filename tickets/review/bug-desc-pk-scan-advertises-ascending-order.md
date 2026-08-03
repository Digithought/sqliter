---
description: Fixed a bug where tables with a descending primary key silently dropped most matching rows in joins; this ticket hands the fix off for review.
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic
difficulty: easy
repro: verified
---

# Memory-table scan now advertises the true PK direction

## Bug (confirmed, was reachable)

`findBestAccessPlan` in `packages/quereus/src/vtab/memory/module.ts` (the
"advertise PK ordering when no ORDER BY was requested" block, ~line 362-378)
built the `providesOrdering` advertisement from `tableInfo.primaryKeyDefinition`
but hard-coded `desc: false` for every column, ignoring the column's actual
declared direction (`col.desc`). A table declared `primary key (id desc)` is
walked descending by the in-memory B-tree, but the planner was told the scan
comes back ascending.

The merge-join rule (`rule-join-physical-selection.ts` /
`equi-pair-extractor.ts`'s `isOrderedOnEquiPairs`) trusts that advertisement
when deciding whether a merge join can skip an inserted `Sort`. A falsely-
ascending advertisement over an actually-descending stream makes the merge
join's two cursors walk away from each other, silently dropping all but one
matching row. Affected every equi-join shape (`IN`, `EXISTS`, inner join, left
join) against a `desc`-PK memory table.

## Fix

One-line change at `packages/quereus/src/vtab/memory/module.ts:368-371` —
advertise the real direction:

```ts
const pkOrdering: OrderingSpec[] = tableInfo.primaryKeyDefinition.map(col => ({
	columnIndex: col.index,
	desc: !!col.desc
}));
```

No other site needed a change:

- **Store backend** (`packages/quereus-store/src/common/store-module-access-plan.ts`,
  `buildPkOrderingAdvertisement`) already builds `desc: !!col.desc` — never wrong.
- **Merge-join direction check** (`equi-pair-extractor.ts`'s
  `isOrderedOnEquiPairs`, ~line 55) already rejects `ordering[i].desc === true`
  as "not merge-ready" — so once the advertisement became truthful, a `desc`-PK
  side is correctly reported as needing an explicit `Sort` (or the cost model
  picks hash/nested-loop instead). The consumer-side check was already
  correct; only the upstream advertisement was lying to it.

## Use cases to exercise when reviewing

Regression block added to
`packages/quereus/test/logic/91-merge-join-edge-cases.sqllogic` (lines 99-130,
runs under both `yarn test` and `yarn test:store` since it's one shared file):
a `mj_dpk` table with `PRIMARY KEY (id DESC)` joined against a plain
ascending-PK table (`mj_small`) via:

- `IN` subquery
- `EXISTS` correlated subquery
- inner `JOIN`
- `LEFT JOIN`

All four assert all 3 rows come back matched (pre-fix, all but one row was
dropped in each shape).

Worth poking at by hand beyond what the tests cover:

- These tests assert final *row-set correctness*, not that a merge join was
  actually chosen for the ascending-PK side plans elsewhere in the file — a
  reviewer wanting to confirm the physical-selection rule's behavior directly
  (Sort-insertion vs. hash/nested-loop fallback) would need to inspect
  `EXPLAIN` output for the `desc`-PK case, which isn't pinned anywhere.
- A composite/multi-column PK with mixed directions (e.g.
  `PRIMARY KEY (a ASC, b DESC)`) — not covered; `pkOrdering` maps every column
  independently so it should be correct, but untested here.
- Descending PK on the **store** (LevelDB) backend specifically for the merge
  path — `test:store` re-runs the same `.sqllogic` file and was confirmed
  green, but no store-specific assertion targets this beyond that shared file.

## Validation run

- `yarn workspace @quereus/quereus run test` — 8552 passing, 13 pending, 0 failing.
- `yarn test:store` (LevelDB backend) — 8544 passing, 21 pending, 0 failing.
  (Output contains repeated `[TransactionCoordinator] release/rollback-to
  savepoint … out of range` lines — pre-existing log noise from unrelated
  savepoint-cleanup paths, not test failures; mocha reported 0 failing both
  runs, independently re-confirmed during this review handoff.)
- `yarn workspace @quereus/quereus run lint` and `run typecheck` — clean,
  independently re-run.
