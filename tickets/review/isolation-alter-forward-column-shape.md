---
description: Adding, dropping, or renaming a column inside a transaction no longer throws away rows the transaction had already written before a savepoint. The staged rows are now reshaped in place instead of being copied into a fresh staging table.
prereq: memory-add-column-at-position, bug-isolation-index-ddl-rebuild-drops-savepoint-writes
files:
  - packages/quereus-isolation/src/isolation-module.ts        # the whole change
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new savepoint + layout suites, foreign-overlay in-place cases
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic  # new, cross-backend
  - tickets/.pre-existing-error.md                            # two memory-module defects surfaced by the new coverage
---

# Review: ADD / DROP / RENAME COLUMN now forward to the isolation overlay in place

Implemented from `implement/isolation-alter-forward-column-shape`. Sibling of the
CREATE/DROP INDEX fix (`bug-isolation-index-ddl-rebuild-drops-savepoint-writes`), same
mechanism: rebuilding the overlay (copying staged rows into a fresh memory table)
registered a fresh connection whose replayed savepoint stack sat ABOVE the copied rows,
so `rollback to savepoint` discarded rows staged long before the savepoint was taken.

## What changed (all in `isolation-module.ts`)

- `alterTable` now dispatches per overlay: `addColumn` / `dropColumn` / `renameColumn`
  forward IN PLACE via the overlay's own `alterSchema` (a local `migrateOverlay` closure
  chooses the path); `alterColumn` and the constraint change types stay on the rebuild
  path (still lose staged rows — finished by `isolation-alter-forward-constraints-and-retype`).
- The issuer/foreign CONSTRAINT routing was extracted from `applyIndexChangeToOverlays`
  into `applyInPlaceOverlayChange` (issuer → INTERNAL drift error, foreign → poison,
  untouched overlay) and is shared by the index paths and the new ALTER forwards.
- `forwardColumnShapeToOverlay`: drop/rename forward the caller's change unchanged; a
  missing overlay `alterSchema` is a no-op (mirrors the index paths — see flags below).
- `buildOverlayAddColumnChange` builds the overlay-flavoured `addColumn`:
  `insertAtIndex` = overlay tombstone index (flag stays last), NOT NULL stripped from the
  column def (the overlay's tombstone rows carry placeholder NULLs the base never sees),
  and a `backfillEvaluator` that routes each overlay row through `computeAddColumnValue`
  — the same helper the pre-validation dry-run uses, so the two cannot drift.
- Behavior preserved: issuer pre-validation still runs BEFORE `underlying.alterTable`
  (atomic abort); foreign overlays are still validated-then-poisoned before being
  touched; poisoned overlays skipped.

## How to validate

- `yarn workspace @quereus/isolation run test` — 291 passing. New suites:
  "column-shape ALTER inside a transaction preserves the overlay savepoint chain"
  (both rollback directions for ADD/DROP, literal + `new.<col>` defaults, RENAME,
  tombstone-under-savepoint), "in-transaction column-shape ALTER keeps the overlay
  tombstone flag last" (write/read/update the new column, committed-delete at commit,
  DROP with committed rows), plus two in-place foreign-overlay cases (same overlay
  OBJECT asserted — proves no rebuild) in the cross-connection white-box suite.
- `cd packages/quereus && node test-runner.mjs --grep 41.8` and
  `node test-runner.mjs --store --grep 41.8` — the new
  `41.8-alter-savepoint-staged-rows.sqllogic`, both legs green.
- Full `yarn build`, `yarn test` (all packages), `yarn lint` — clean.

## Flags for the reviewer (honest gaps)

- **Two pre-existing memory-module defects surfaced** by the new coverage; both are
  documented with repros in `tickets/.pre-existing-error.md` and are NOT fixed here
  (outside the diff — `packages/quereus/src/vtab/memory/`):
  1. Memory-native RENAME COLUMN with a savepoint across it loses the transaction's
     pending rows at COMMIT (`renameColumn` has no open-layer reshape). The RENAME block
     was left out of the new sqllogic file with a NOTE comment.
  2. `rollback to savepoint` on a connection whose (empty-of-own-writes) memory
     transaction spans a column-shape ALTER restores the committed rows' PRE-alter
     layout — permanent corruption, reachable through the isolation wrapper's forwarded
     savepoints. Three new-test assertions were deliberately scoped around it (empty
     underlying in the savepoint DROP case; `w` not read in the tombstone case), each
     marked with a comment pointing at the report. Tighten them when the fix lands.
- **Missing overlay `alterSchema` is a no-op**, per the ticket's instruction (mirrors
  the index paths). For a column-shape change that no-op leaves the overlay's row layout
  diverged from the base — only reachable with a host-injected custom overlay module
  lacking `alterSchema` (the default `MemoryTableModule` has it). A rebuild fallback
  would be safer for that exotic case; worth a reviewer opinion.
- `dropColumnIdx` and `translateOverlayRow`'s `dropColumn` arm are now unreachable
  (dropColumn no longer rebuilds) but kept so the rebuild machinery stays whole until
  `isolation-alter-forward-constraints-and-retype` retires it — noted in a comment.
- The store leg of 41.8 logs two `[TransactionCoordinator] rollback-to savepoint depth 0
  out of range` warnings (underlying store savepoint forward after DDL auto-commits the
  store transaction); assertions all hold. Pre-existing noise, not introduced here, but a
  reviewer eye on it would be welcome.
