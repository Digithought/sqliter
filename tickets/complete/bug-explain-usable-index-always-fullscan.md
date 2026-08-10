description: When you ask the database to explain how it will run a query, it always claimed it is reading the whole table even when it actually chose an index. Now the explanation names the index used and correctly counts the matched conditions.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # makeIndexFilterInfo, ~L82-95
  - packages/quereus/test/plan/basic/multi-filter-keyed.plan.json          # golden: usableIndex + matchedClauses
difficulty: easy
---

## Root cause

`EXPLAIN` reports per-table-access `filterInfo` fields off `this.filterInfo.indexInfoOutput`
(`table-access-nodes.ts:128-139`). Every index-seek arm in `rule-select-access-path.ts` builds
its `FilterInfo` through the shared `makeIndexFilterInfo` helper. That helper set the top-level
`idxStr` to the encoded seek descriptor but let `indexInfoOutput` flow through unchanged from
`base` — which is seeded from a full scan (`makeFullScanFilterInfo`, line ~376). So every seek
plan reported `usableIndex: 'fullscan'` in `EXPLAIN`, even though the plan and runtime (which read
the top-level `filterInfo.idxStr`) correctly used the index.

## Fix (implement stage)

`makeIndexFilterInfo` now stamps the encoded `idxStr` onto both the top-level field and
`indexInfoOutput.idxStr`. Single site; every seek arm (index-aware and legacy PK) funnels through
it. Ordering-only scans (`makeOrderedScanFilterInfo`) already stamped both, so that arm was always
correct.

## Review findings

### What was checked

- **Read the implement diff (`bdc5a38`) fresh before the handoff.** Fix is correct and minimal.
- **All seek arms funnel through the helper** — verified via grep: every `idxStr`/`FilterInfo`
  construction in `rule-select-access-path.ts` goes through `makeIndexFilterInfo`
  (seeks), `makeOrderedScanFilterInfo` (ordering scans), or `makeFullScanFilterInfo` (scans). No
  hand-rolled seek FilterInfo bypasses the fix.
- **Sibling builders consistent** — `makeIndexEqSeekFilterInfo` and `retargetFilterInfoIndex`
  (`vtab/filter-info.ts`) already keep top-level and `indexInfoOutput.idxStr` in lockstep.
- **Read path** (`table-access-nodes.ts:134`) confirmed to read `indexInfoOutput.idxStr`.
- **Golden coverage** — the other 5 `usableIndex` goldens are all `plan=0` ordering scans (already
  correct); only `multi-filter-keyed` is a seek.
- **Docs** — `docs/plugins.md` only documents the `FilterInfo` interface shape (accurate);
  no `usableIndex`/`matchedClauses` prose to update.
- **Tests + lint** re-run green: `yarn lint` clean, `yarn test` 6918 passing / 13 pending / 0
  failing. No pre-existing failures surfaced.

### Found + fixed inline (minor)

- **`matchedClauses` was always `0` for seeks** — same root cause, same helper. EXPLAIN's
  `matchedClauses` reads `indexInfoOutput.aConstraintUsage?.length`, which `makeIndexFilterInfo`
  also left as the full-scan base's empty array. So `multi-filter-keyed`'s INDEX SEEK reported
  `matchedClauses: 0` despite `seekKeys: ["3"]`. Fixed by also stamping `aConstraintUsage` from the
  seek's `constraints` in the same helper. Safe: grep confirms `indexInfoOutput.aConstraintUsage`
  is read *only* by EXPLAIN (`table-access-nodes.ts:135`) — no runtime/vtab consumer, so no
  behavior change. Golden regenerated: single line `matchedClauses: 0 → 1` in
  `multi-filter-keyed.plan.json`, matching the one seek key. No other golden content changed.

### Major findings

None.

### Tripwires

None.

## Verification

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn test` — 6918 passing, 13 pending, 0 failing.
- Golden regen (`UPDATE_PLANS=true yarn test:plans`): only `multi-filter-keyed.plan.json` content
  changed — the expected `usableIndex` fix (implement stage) plus `matchedClauses 0 → 1` (this
  review). Other 3 touched goldens byte-identical.
