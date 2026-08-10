---
description: Inserts and updates into a table with a uniqueness rule no longer read the whole table to check for duplicates — they look the duplicate up through the index that backs the rule, while still catching duplicates that only exist in the current transaction's uncommitted changes.
files:
  - packages/quereus-isolation/src/isolated-table.ts          # findMergedUniqueConflict split + canSeekForConstraint
  - packages/quereus-isolation/src/filter-info.ts             # makeSecondaryIndexEqSeekFilter
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # "two-phase merged UNIQUE check (index seek)" describe
  - docs/design-isolation-layer.md                            # Non-PK UNIQUE Conflict section
---

## What shipped

The isolation layer's non-PK UNIQUE conflict check (`IsolatedTable.findMergedUniqueConflict`)
was rewritten from "full-scan the whole underlying table + one overlay point-lookup per row"
into a two-phase search over the merged view (this connection's overlay superimposed on the
underlying committed rows):

```
merged view  =  (overlay rows)  ∪  (underlying rows with no overlay entry)
```

- **Phase 1** (`findOverlayUniqueConflict`) full-scans the small in-memory overlay, skipping
  tombstones and the writer's own PK(s).
- **Phase 2** (`findUnderlyingUniqueConflict`) looks up matching underlying rows, skipping the
  writer's own PK(s) and any PK the overlay already owns. The lookup is an **index seek**
  (`makeSecondaryIndexEqSeekFilter`) when `canSeekForConstraint` allows it, else the old full
  scan.

Both phases share one matcher (`rowMatchesUniqueConstraint`). The seek is gated to
index-derived constraints (`derivedFromIndex`) whose enforcement collation is entirely BINARY.

## Review findings

Adversarial pass over commit `aaebe661`. Read the full source + test + docs diff before the
handoff summary.

### Checked — correctness

- **Two-phase disjointness / no double-count.** Verified the merged view is partitioned
  exactly: any PK with an overlay entry (live or tombstone) is Phase 1's territory and Phase 2
  skips it via `getOverlayRow`. Overlay live-match → Phase 1 reports; overlay live-no-match →
  neither reports (merged value is the overlay value); tombstone → both skip. Sound.
- **BINARY seek gate (`canSeekForConstraint`) — the load-bearing correctness piece.** Confirmed
  the reasoning holds: BINARY is the finest collation, so `{BINARY-equal} ⊆ {K-equal}` for the
  store's physical index key collation K *whatever K is*. A BINARY-enforced seek therefore always
  fetches a superset of the true conflict set, which Phase 2's per-column re-validation filters —
  correct regardless of K. Non-BINARY enforcement (NOCASE/RTRIM) is declined and falls to the
  full scan, so the encoder defect in `debt-store-index-keys-use-column-collation` cannot turn
  this perf fix into a lost UNIQUE violation. The store's own richer gate
  (`indexSeekHonorsEnforcementCollation`, coarser-or-equal) admits more cases; the isolation
  layer's stricter BINARY-only gate is a safe subset — costs an optimisation, never correctness.
- **Composite / index-key-order seek.** `makeSecondaryIndexEqSeekFilter` reads seek values in
  index-key order (`index.columns[i].index`), not `uc.columns` order; the descriptor and values
  stay positionally aligned. Covered by the `create unique index ux on t(b, a)` test.
- **NULL handling.** The outer guard in `checkMergedUniqueConstraints` skips the whole check when
  any constrained column of `newRow` is NULL, so no seek is ever built with a NULL key. Covered.
- **Tie-break / REPLACE eviction.** Phase 1 running first means an overlay-side conflict is named
  in preference to an underlying one *only in the pre-violated case*, which normal DML cannot
  reach (an earlier write onto the value would itself have been rejected/evicted). Documented in
  code + docs. All 224 isolation + 6867 quereus + 901 store tests pass, so no existing
  "which row is reported" expectation broke.

### Found + fixed (minor, this pass)

- Stale comment at the REPLACE eviction site (`isolated-table.ts` ~1493) claimed `conflict.row`
  "is the live underlying row". Phase 1 can now return an overlay-derived merged row. Rewrote the
  comment to state the row is user-facing schema shape from either phase. Fixed inline.

### Found — filed as a new ticket (test hardening)

- **`backlog/debt-iso-store-unique-seek-rowcount`** — the "optimisation actually happened" proof
  (a row-count assertion via `CountingMemoryModule`) is memory-only. The store seek arm — the one
  this ticket most cares about — has correctness coverage (`test:store`, `isolated-store.spec`) but
  no perf guard, so a silent store-seek→full-scan regression would pass every correctness test.
  Low priority; regression guard, not a correctness fix.

### Tripwires (conditional — recorded, not ticketed)

- **Downstream cascade for eviction.** `evictedRows` shape is asserted via `update()`'s return
  value, not by observing FK-CASCADE / covering-MV maintenance firing. This is a *pre-existing*
  documented isolation limitation ("Same-PK REPLACE ... FK CASCADE side-effects do not fire",
  `docs/design-isolation-layer.md` Trade-offs), not introduced here. No new tripwire needed — the
  existing docs bullet is its home.
- **drop-index mid-transaction with a stale `UniqueConstraintSchema`.** Handled defensively:
  `canSeekForConstraint` resolves the index or returns null (no `!`-assert), falling back to full
  scan. Only covered indirectly (existing DROP UNIQUE INDEX tests clear the constraint entirely).
  Parked at the existing `// DROP INDEX may have retired it...` comment in `canSeekForConstraint`.
- **Partial-UNIQUE + seek on the store.** The predicate re-runs in both phases regardless of
  whether the physical index physically excludes out-of-scope rows, so correct either way; no
  dedicated store-mode partial-UNIQUE-with-seek test beyond the memory scenarios. Fine now;
  becomes worth a test only if the partial-index physical scope and the re-check ever diverge.

### Checked — docs

- `docs/design-isolation-layer.md` Non-PK UNIQUE Conflict section fully rewritten to the two-phase
  model, `canSeekForConstraint` gate, and updated Trade-offs. Read against the code; reflects the
  new reality. `yarn docs:check` clean.

### Validation run this pass

- `yarn test` — **EXIT 0**, all workspaces green (quereus 6867, isolation 224, store 901, sync 450,
  others). Error lines in output are intentional injected-failure tests, all suites passing.
- `yarn lint` — **EXIT 0**, clean (only `packages/quereus` has a real lint; change is isolation-only).
- `tsc -p tsconfig.json` **and** `-p tsconfig.test.json` (isolation) — both clean, catches spec drift.
- `yarn docs:check` — clean.
- `yarn test:store` not re-run this pass (implementer reported green); the store seek arm's
  correctness is covered there and by `isolated-store.spec`.
