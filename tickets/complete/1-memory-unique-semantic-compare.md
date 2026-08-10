---
description: In-memory tables used to let two different spellings of the same duration (like "PT1H" and "PT60M") both sit in a unique column; the second one is now rejected as a duplicate, matching every other part of the engine.
files:
  - packages/quereus/src/schema/unique-enforcement.ts        # uniqueEnforcementComparators helper
  - packages/quereus/src/index.ts                            # export
  - packages/quereus/src/vtab/memory/layer/manager.ts        # 3 re-validators + 2 NOTE tripwires
  - packages/quereus-store/src/common/store-table.ts         # uniqueColumnComparators folded onto the helper
  - packages/quereus-isolation/src/isolated-table.ts         # findMergedUniqueConflict folded onto the helper
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/unique-enforcement-comparators.spec.ts  # added in review
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts
  - docs/types.md                                            # § Semantic ordering
  - docs/schema.md                                           # § Index-derived UNIQUE enforcement collation (added in review)
---

# Complete: memory UNIQUE enforcement compares through the column's declared type

## What was wrong

Some declared column types define their own "same value" that differs from comparing the
stored text byte-for-byte — `docs/types.md` § "Semantic ordering". `TIMESPAN` is the
motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour, and the type's
`compare` returns 0 for them. `=`, `DISTINCT`, `GROUP BY`, the memory PRIMARY KEY and the
persistent store's UNIQUE constraints already treated them as one value; the in-memory
backend's UNIQUE enforcement did not.

The candidate *lookup* was already type-aware (the memory index's BTree comparator is
built with `createTypedComparator`, so a `'PT60M'` probe returned the `'PT1H'` row's
primary key). The re-validation immediately after it compared the probe against the live
row under storage class + collation only, decided `'PT1H' ≠ 'PT60M'`, skipped the
candidate, and admitted the duplicate.

## What shipped

- **New shared helper** `uniqueEnforcementComparators(columns, ucColumns, collations)` in
  `packages/quereus/src/schema/unique-enforcement.ts`, exported from the package index.
  One comparison function per constrained column: the declared type's `compare` when
  `hasSemanticOrdering(logicalType)`, else `compareSqlValuesFast` under the supplied
  collation. It takes **pre-resolved** collations because the four call sites resolve
  collations differently (memory's index path reads them from the live index handle, a
  divergence conformance-locked by `test/unique-enforcement-collation.spec.ts`).
- **Three private copies collapsed onto it**: the store's `uniqueColumnComparators` (kept
  as a thin wrapper), the isolation overlay's inline block in
  `findMergedUniqueConflict`, and memory's three re-validators
  (`checkUniqueViaIndex`, `checkUniqueViaMaterializedView`, `checkUniqueByScanning`).
  `enforceSecondaryUniqueOnMaintenance` is fixed transitively through
  `checkSingleUniqueConstraint`.

Behavior on memory now matches the store case-for-case: plain and composite UNIQUE,
`create unique index`, `insert or ignore`, `insert or replace`, UPDATE onto another row's
identity (rejected), UPDATE re-spelling a row's own value (allowed), intra-statement
duplicates, and a `text unique` negative control that still keeps both spellings.

## Review findings

### Checked

Read the implement diff before the handoff, then: the helper's contract (semantic gate,
NULL totality, positional pairing of columns↔collations), all four call sites, the
early-bail ordering in `checkUniqueViaIndex`, leftover imports at every touched file, the
new sqllogic block and the re-enabled store-package oracles, `docs/types.md` and
`docs/schema.md`, and the neighbouring paths the change makes newly reachable (UPSERT
clause routing, intra-statement duplicate detection, NULL multiplicity, JSON identity).
Ran `yarn build`, `yarn lint`, `yarn test` (all workspaces), and store-mode logic tests.

### Found and fixed in this pass (minor)

- **`docs/schema.md` § "Index-derived UNIQUE enforcement collation" was left stale.** It
  states without qualification that enforcement compares under the index's per-column
  `COLLATE`; that is now false for a semantic-ordering column, where the type's `compare`
  governs and the collation is only passed through. Added a paragraph naming the
  exception and the shared helper. (`docs/types.md` was updated by the implementer and is
  accurate.)
- **The helper had no direct test.** The implementer's own handoff flagged that two of the
  three memory re-validators are only covered indirectly, so reverting the substitution in
  them would not fail a test. Added
  `packages/quereus/test/unique-enforcement-comparators.spec.ts` (5 cases) pinning the
  rule itself: TIMESPAN spellings collapse under any collation, JSON collapses
  key-reordered objects but keeps array order, a NOCASE text column still compares by
  collation and never consults a type `compare`, comparators pair with their own column
  when the constrained columns are out of declaration order, and NULL ordering stays
  total. This does not prove a given call site *uses* the helper, but it stops the rule
  itself from silently regressing.

### Found and filed (major)

- **`tickets/fix/upsert-conflict-target-semantic-ordering.md`** —
  `insert … on conflict (d) do update` and `… do nothing` against a semantic-ordering
  UNIQUE column raise `UNIQUE constraint failed` instead of routing to the clause. The
  runtime's conflict-target match (`conflictTargetValuesMatch`, `runtime/emit/dml-executor.ts`)
  compares storage class + collation only, so `'PT1H'` and `'PT60M'` do not match the
  target and no clause is selected. Reproduced on **both** backends at `28620d00`; the
  untargeted `on conflict do update` form and a `text unique` column both work. This is a
  fifth private copy of the comparison rule in a different layer — pre-existing on store,
  and this ticket is what makes it reachable on memory (memory previously admitted the
  duplicate outright, which was wrong in a different way). Not a regression to hold this
  ticket for; the two backends now agree, and they now agree on being wrong here.

### Checked and deliberately not filed

- **Covering-materialized-view UNIQUE with a semantic-ordering column** — the candidate
  generator still narrows under the source column's collation, so the duplicate never
  reaches the fixed re-validator. Already tracked as
  `tickets/implement/2-covering-mv-conflict-candidates-semantic.md`, which names this
  ticket as its prerequisite. Not re-filed.
- **`checkUniqueByScanning` has no direct end-to-end test.** It is a defensive fallback
  reached only when *no* covering structure resolves for a constraint, which no SQL shape
  in the suite produces; the new unit spec covers the rule it applies. Accepted, no
  ticket.
- **Comment density in `manager.ts`.** The three touched sites carry 10–25 line
  explanatory blocks. Above the repo's usual bar, but the file's established style and
  mostly pre-existing text — churning it would bury the diff. No action.
- **Per-check closure allocation** (one per constrained column per constraint check) —
  measured against the existing per-check collation resolve it sits beside, and the
  zero-candidate insert bails before reaching it. Not worth a note.
- **Unused-import drift, positional misalignment, NULL handling, TEXT/ANY regression** —
  all checked, all clean. `compareSqlValuesFast` is correctly gone from `manager.ts`;
  `createTypedComparator`/`hasSemanticOrdering` are still used elsewhere in the store and
  isolation files, so their imports rightly stay.

### Tripwires parked

- `MemoryTableManager.uniqueColumnsChanged` over-triggers the UPDATE re-check for a
  semantic-ordering column (byte-level compare gates *whether* to re-check; the re-check
  itself is correct). `NOTE:` in that method's docstring — parked by the implementer,
  verified present.
- `checkUniqueByScanning` resolves its collations from the declared column collation
  rather than the shared `uniqueEnforcementCollations`, so it would enforce an
  index-derived UNIQUE under the wrong collation *if* that fallback ever became reachable
  for one (it is not today — such a constraint always resolves its own index). New
  `NOTE:` at the resolve site in `manager.ts`.

## Validation

- `yarn build` — clean.
- `yarn lint` (all workspaces, includes the quereus test-file type pass) — clean.
- `yarn test` (all workspaces) — clean; `packages/quereus` 7194 passing, 13 pending
  (7189/13 before the added spec).
- Store-mode logic tests (`node test-runner.mjs --store`) — 7183 passing, 19 pending.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
