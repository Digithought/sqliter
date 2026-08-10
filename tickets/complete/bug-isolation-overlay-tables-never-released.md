---
description: Every transaction that wrote to a table used to leave behind a small in-memory staging table that was never freed, slowly growing a long-lived connection's memory without bound; now fixed with a single release path and a regression test that pins the staging-table count back to zero after every transaction.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # releaseOverlayTable helper; release at commit/destroy/adopt/rebuild/closeAll; clearConnectionOverlay now async; ConnectionOverlayState gained `db`
  - packages/quereus-isolation/src/isolated-table.ts          # ensureOverlay sets state.db; clearOverlay async; awaits threaded through rollback/alterSchema/onConnectionRollback/onConnectionRollbackToSavepoint
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # two new describes at EOF: 9 baseline-count regression tests; 9 existing overlay-construction sites updated for required `db`
---

# Release isolation overlay tables instead of leaking them — COMPLETE

## Summary

The isolation layer stages each connection's uncommitted writes in a private in-memory
*overlay* table (`_overlay_<table>_<id>`). `MemoryTableModule.create()` registers the overlay's
manager in the module's public `tables` map; only `MemoryTableModule.destroy()` removes it. The
isolation layer never called `destroy` on any abandon path — it just dropped the JS reference —
so one dead staging table accumulated per (connection, table) overlay per writing transaction,
plus one per overlay rebuild. Unbounded growth on a long-lived `Database`.

Fix: a single sink, `IsolationModule.releaseOverlayTable(state)`, drives
`overlayModule.destroy(...)` to free the staging table. Every abandon path funnels through it —
commit, rollback, alterSchema, rollback-to-pre-overlay-savepoint, DROP TABLE (`destroy`), rebuild
replace/failure, and `closeAll`. `ConnectionOverlayState` gained a required `db: Database` field
(set at the three real creation sites) so the release targets the overlay's OWN db, correct for
the multi-db sweeps in `destroy`/`closeAll`. Nine regression tests assert the class-of-bug
invariant directly: `overlayModule.tables.size` returns to a baseline of 0 after every cycle.

Implementation handoff (design rationale, integration-risk analysis, per-path release map) is
preserved in git: `git show 5b81585c`.

## Review findings

Adversarial pass over the implement diff (`git show 5b81585c`), read before the handoff summary,
then cross-checked against the surrounding isolation + memory-vtab code.

### Verification run (all green)
- `yarn workspace @quereus/isolation test` — **240 passing** (9 new).
- `yarn workspace @quereus/quereus run lint` — exit 0 (the only real lint + test-file tsc in the
  repo).
- `yarn workspace @quereus/isolation run build` — exit 0 (confirms the required `db` field is
  satisfied in production code and the async signature changes type-check).

### Correctness — checked, nothing found
- **Every overlay-abandonment path releases.** Traced all creation sites (`ensureOverlay`, the two
  rebuild builders) against all discard sites. Commit, rollback, alterSchema,
  rollback-to-pre-overlay-savepoint, DROP TABLE (`destroy`), rebuild-replace, rebuild-failure, and
  `closeAll` all route through `releaseOverlayTable`. `renameTable` rekeys (keeps the overlay
  tracked, released later) — correctly NOT a release site. Rolling back to a savepoint that
  post-dates the overlay keeps the overlay — correctly not released.
- **No double-free / use-after-free.** `MemoryTableModule.destroy` is idempotent (missing manager
  → no-op), so a redundant release is harmless. In `commitConnectionOverlays`, release happens in
  the final clear-loop AFTER Phase-1 apply and Phase-2 commit have read `state.overlayTable`, so
  the staging table is live throughout the flush. `adoptRebuiltOverlay` frees the OLD overlay only
  on the success branch and the builder's own `catch` frees the half-built NEW overlay on throw —
  the two branches are mutually exclusive, no path frees both or neither.
- **Rebuild builders have no leaking caller.** `rebuildOverlayForIndexChange` /
  `migrateOverlayForAlter` are invoked ONLY via `adoptRebuiltOverlay`'s `rebuild` thunk (module
  lines 1214, 1375, 1398); their returned `newState` is always either adopted or released.
- **Teardown ordering (the ticket's flagged integration risk) holds.** When a savepoint pre-dates
  the overlay, the overlay's own `MemoryVirtualTableConnection` is registered with the `Database`;
  releasing the overlay's manager mid-commit/rollback then leaves that connection detached.
  `MemoryTableManager.destroy` rolls back the pending layer and clears `connections`; a later
  db-side `disconnect`/`commit` on the detached connection is tolerated. Confirmed by the two new
  `pre-overlay savepoint + commit/rollback` cases AND the pre-existing savepoint suite staying
  green — not by reasoning alone.

### Resource cleanup — checked, one non-defect noted
- **`closeAll` is host-facing API, not engine-invoked.** Grep confirms the engine never calls any
  module's `closeAll` (`db.close()` does not). Its release loop is reachable only when a host holds
  a shared `IsolationModule` across multiple `Database`s and explicitly sweeps it. This is NOT a
  residual leak: `db.close()` reaches `schemaManager.clearAll()` → `dropTable` → `IsolationModule.
  destroy` for every table, and `destroy`'s own-overlay branch releases any overlay an abandoned
  open transaction had staged for that db. So a normally-closed database frees its overlays even
  without `closeAll`. No action; the belt-and-suspenders `closeAll` release is correct and cheap.
  The ticket's "exercised only indirectly" wording understates it (the engine never calls it), but
  the code is right.

### Type safety — checked, pre-existing coverage gap (recorded as tripwire, not ticketed)
- The new `ConnectionOverlayState.db` field is **required**, so production code fails the package
  `tsc` build if a future creation site omits it (verified green). But the isolation package's
  `test/` is excluded from its tsconfig, its `lint` is an intentional no-op, and ts-node runs
  `transpileOnly` — so spec-file type drift (including a future omission of `db` at a test
  overlay-construction site) is caught by **no** CI gate. I manually verified all 10 existing spec
  construction sites now pass `db` (grep at module lines 462/1495/1719/1737/2062/2778/2983/3209/
  4161/4369). This blind spot is pre-existing and matches a deliberate repo-wide stance
  (AGENTS.md: only `packages/quereus` type-checks its tests; every other package ships a no-op
  lint on purpose), so it is neither this ticket's defect to fix nor mine to ticket. Recorded here
  as the index entry; the concern is conditional ("if a future edit drifts an isolation spec
  signature, nothing flags it") — a tripwire, per the workflow rules.

### Tests — reviewed as a floor, judged adequate
- Nine new count-invariant regressions cover the full abandon matrix: write+commit, write+rollback,
  create-index rebuild, drop-index rebuild, alter-add-column, drop-table, pre-overlay-savepoint
  commit/rollback (teardown ordering), and a rebuild-FAILURE case asserting the half-built overlay
  is freed (count 1, not 2) and the poisoned old overlay is freed on rollback (→ 0). They read
  `overlayModule.tables.size` directly (public field, public `Map`), so they pin the actual
  class-of-bug invariant rather than a proxy.
- Gaps the implementer honestly flagged and I confirm are acceptable: `closeAll`'s release loop has
  no direct count assertion (its logic mirrors the others and is dead-simple); the rebuild-failure
  case uses white-box overlay injection for the foreign connection (matching the established
  two-db suite pattern) rather than a second SQL-driven transaction (the SQL end-to-end paths are
  covered by the first eight cycles). Neither warrants blocking or a follow-up ticket.

### Docs — checked
- No user-facing doc describes overlay staging-table lifecycle (the isolation package README and
  `docs/` cover isolation semantics, not the internal `_overlay_*` registry). The behavior change
  is invisible at the SQL/API boundary — memory is simply reclaimed. The rationale lives where a
  maintainer meets it: extensive doc-comments at every release site and on `ConnectionOverlayState.
  db`. Nothing to update.

### Disposition
- **Minor findings fixed inline:** none — no code change was warranted.
- **Major findings → new tickets:** none.
- **Conditional/speculative → tripwires:** one (spec type-checking blind spot), recorded above; no
  code site to tag since it is a package-config stance, so its home is this findings section.

## How to validate

- `yarn workspace @quereus/isolation test` — 240 passing.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` — green.
