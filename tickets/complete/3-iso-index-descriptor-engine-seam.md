---
description: Reviewed the new typed record of the query planner's chosen index (a structured descriptor now rides alongside the old text string, and three modules stopped hand-parsing that string). Ships as-is; one whitespace fix applied.
files:
  - packages/quereus/src/vtab/index-descriptor.ts
  - packages/quereus/src/vtab/idx-str.ts
  - packages/quereus/src/vtab/filter-info.ts
  - packages/quereus/src/vtab/best-access-plan.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/stats/analyze.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-isolation/src/filter-info.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/vtab/idx-str.spec.ts
  - packages/quereus/test/vtab/index-descriptor.spec.ts
  - packages/quereus/test/vtab/access-path.spec.ts
  - packages/quereus/test/vtab/test-aliased-index-module.ts
  - docs/module-authoring.md, docs/optimizer.md
---

## What shipped

The engine now records the planner's chosen index in two forms that cannot drift: the
existing free-text `FilterInfo.idxStr` and a new typed `FilterInfo.accessPath`
(`fullScan | empty | index | unresolvedIndex`). Both are projected from one
`(indexName, plan, params)` triple through a single `encodeIdxStr`, and three modules that
each hand-rolled an `idxStr` splitter (`scan-plan.ts`, `store-table.ts`, plus the shared
codec) now go through one `decodeIdxStr`. A module that mints a per-plan alias for the PK
index without supplying an `indexDescriptor` is now recorded as `unresolvedIndex` (with a
warn), so order-sensitive consumers can refuse the plan instead of silently merging by PK.

Verdict: **ship as-is.** Implementation is sound, well-tested, and documented. One
whitespace-only fix applied inline; no correctness changes needed; no new tickets filed.

## Review findings

**Checked — build/lint/tests**
- `yarn lint` — clean (real eslint + `tsc -p tsconfig.test.json` on `@quereus/quereus`),
  re-run after the inline fix: exit 0.
- `yarn test` — full workspace green: 6867 + 901 + 203 + 86 + 450 + 128 + others passing,
  **0 failing**.
- `yarn test:store` (LevelDB backend, the gap the implementer flagged as unrun) — **run and
  green**: 6862 passing, 14 pending, 0 failing. This exercises the store's
  `resolveIndexFromIdxStr` refactor against the one live secondary-index `idxStr` consumer.
  Gap closed.

**Fixed inline (minor)**
- `rule-select-access-path.ts` — the `const fi = makeIndexFilterInfo(...)` block in the IN
  multi-seek arm was indented one tab too deep (5 tabs inside a 4-tab block). Pure
  whitespace; dedented to match. Logic untouched; lint + tests still green.

**Checked — the one risky behavior change (no defect)**
- Isolation's `makeFullScanFilterInfo` previously emitted `idxStr: null`; it now delegates to
  the engine builder, which emits `idxStr: 'fullscan'`. Traced every sink: the store
  (`decodeIdxStr` sentinel → null → scan), the memory `scan-plan.ts` (degenerates to a
  primary-key walk), and isolation's own `parseIndexFromFilterInfo` (no `idx=` param → primary)
  all treat `'fullscan'` identically to `null`. Furthermore isolation's `'fullscan'` filters
  only ever reach `query()` on underlying/overlay tables, never `parseIndexFromFilterInfo`
  (that one reads the *planner's* filterInfo, which already carried `'fullscan'` before this
  ticket). Cost/rows defaults (1e6/1e6) are unchanged. Safe.

**Checked — module wiring, imports, coverage**
- No runtime circular import: the `best-access-plan ↔ index-descriptor` cycle is
  value→type-only in the return direction, so it erases at compile. Confirmed by clean lint
  (tsc) and green tests.
- All isolation callers of `makeFullScanFilterInfo` use the no-arg form → defaults preserved.
  `makePkPointLookupFilter` still emits `idx=_primary_(0);plan=2` (byte-identical), now with a
  populated `accessPath`.
- Store's `resolveIndexFromIdxStr` dropped its private `name === 'fullscan'` guard because
  `decodeIdxStr` treats `fullscan`/`empty` as sentinels → null upstream; behaviour preserved.
- Spec coverage is a genuine floor, not a token pass: `idx-str.spec` round-trips all seven
  emitted shapes byte-for-byte plus punctuation/first-`=`-split/order-preservation/sentinel
  edge cases; `index-descriptor.spec` pins `resolveIndexDescriptor` precedence and every
  `validateAccessPlan` throw path; `access-path.spec` + `test-aliased-index-module.ts` prove
  the alias-without-descriptor → `unresolvedIndex` and alias-with-descriptor → primary walk
  end-to-end.
- Docs (`module-authoring.md`, `optimizer.md`) read accurately against the code — the
  `IndexDescriptor` shape, the resolution order, and the `unresolvedIndex` correctness
  contract all match the implementation.

**Major — none.** No new fix/plan/backlog tickets filed.

**Deferrals verified as out-of-scope, not regressions** (all pre-existing or by-design;
none demoted from a real defect):
- The `_primary_a` isolation corruption is *unblocked* here, not fixed — that is downstream
  ticket `iso-index-descriptor-isolation-consumer` (3.1), which must consume `accessPath` /
  `retargetFilterInfoIndex`. Confirm 3.1 lands.
- `retargetFilterInfoIndex` has no in-tree caller yet (exported for 3.1) and no direct unit
  test; its logic is only exercised transitively. Worth a direct test when a caller lands —
  not blocking.
- `indexInfoOutput.idxStr` seek-arm staleness (wrong `usableIndex` in EXPLAIN) is deliberately
  untouched and filed separately; `retargetFilterInfoIndex` already rewrites that field.
- Scan direction (`plan=1`/`plan=4`, `ordCons=DESC`) is round-tripped but modelled by nothing;
  by design, not a bug.

## Tripwires (index only — parked at their sites, not filed)

- `idx-str.ts` `decodeIdxStr` allocates a fresh `Map` per call only when parameters exist,
  sharing a frozen empty map otherwise. Per-plan cost, not per-row. Observation only — becomes
  work only if idxStr decoding ever shows up hot.
- `resolveIndexDescriptor` does a linear `tableSchema.indexes.find` per plan. Plan-time cost;
  index-by-name only if a table ever carries many indexes and planning turns hot.

Neither is a latent defect (both are correct now under every reachable path), so both stay as
review-index notes rather than code changes or tickets.
