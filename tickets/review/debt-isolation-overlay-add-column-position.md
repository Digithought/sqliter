---
description: Added the missing tests that pin down that "add a column at a chosen position" already works correctly when going through the transaction-isolation layer, so a future edit can't quietly break it.
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new describe block "ADD COLUMN at a caller-chosen position (isolation layer)", ~2960
  - packages/quereus-isolation/src/alter-migration.ts         # buildOverlayAddColumnChange (~708) — behavior under test; untouched
  - packages/quereus-isolation/README.md                      # one new bullet in the ALTER section (~145)
difficulty: easy
---

# Pin the caller-chosen ADD COLUMN position through the isolation layer — implemented

## What this is

Test-only ticket, as scoped. No behavior changed. `packages/quereus-isolation/src/alter-migration.ts`
and every other `src/` file in the package are untouched — `git diff --stat` shows only the spec file
(+234 lines) and a one-line README addition.

## What was added

A `PositionedIsolationModule` harness (subclasses `IsolationModule`, overrides `alterTable` to inject
`insertAtIndex` into an `addColumn` change) plus a new
`describe('ADD COLUMN at a caller-chosen position (isolation layer)', ...)` block in
`isolation-layer.spec.ts`, placed right after the existing `'in-transaction column-shape ALTER keeps
the overlay tombstone flag last'` block (which only exercises the no-position default arm). 11 new
`it`s, mirroring every case the ticket specified:

- position 0 with both a committed and a staged row, in-transaction and post-commit
- writes (UPDATE/INSERT/DELETE) issued *after* the reshape, targeting the new column by name — the
  case that would catch a row/schema layout disagreement
- a staged DELETE surviving a positioned ALTER (deleted row stays deleted)
- a multi-column PRIMARY KEY *and* a secondary index both renumbered by one insert ahead of both
  (`select … where k1 = ? and k2 = ?` and `select … where v = ?` both still hit)
- `insertAt` equal to the base's own column count (the overlay's append slot, ahead of the bookkeeping
  flag) — indistinguishable from a plain append
- an explicit mask-check: a change with no position still appends, so the harness itself can't hide a
  regression in the default arm
- an out-of-range position (99) rejected with `Cannot add column 'w' at position 99: expected an
  integer in [0, 2]`, catalog/rows untouched, and the open transaction still commits afterward
- a positioned ALTER surviving a `rollback to savepoint` (DDL isn't transactional here — the column
  change stays; the pre-savepoint row is what must survive, reshaped to the new layout)
- a cross-connection case: connection A issues a positioned ALTER while connection B holds a foreign
  overlay with one live staged row and one deletion marker (built directly via
  `iso.overlayModule.create` / `iso.createOverlaySchema` / `iso.setConnectionOverlay`, mirroring the
  existing `injectOverlay` pattern at `isolation-layer.spec.ts:3182`) — B is not poisoned, its overlay
  schema gains the column at the named slot ahead of `_tombstone`, and its rows show the backfilled
  value at that slot for the live row and `NULL` at that slot for the marker.

Every assertion reads back by column name (`select *` or an explicit column list), never by row
index — that's the failure mode being pinned (a value landing under the wrong column name).

All 11 passed on first run against the current tree; none needed adjustment. This confirms the
ticket's premise (the caller-named `insertAtIndex ?? tombstoneIdx` path in `buildOverlayAddColumnChange`
already works) rather than fixing anything.

## Validation run

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation test` — 364 passing (up from 353 before this ticket).
- `yarn test` (full workspace) — green: `@quereus/quereus` 8277 passing, `@quereus/isolation` 364,
  every other package passing, 0 failures anywhere in the run.
- `yarn workspace @quereus/isolation run lint` — package has the intentional no-op lint script (see
  AGENTS.md); nothing to check for a test-only change.

## Gaps / things a reviewer should know

- **Optional stub-underlying case skipped, per the ticket's own guidance.** The ticket explicitly said
  not to add a `@quereus/store` dependency to test "the underlying refuses the position" path (already
  covered by `packages/quereus-store/test/alter-table.spec.ts:105`), and to treat an in-package stub
  for that path as optional. I skipped it — the memory module is the only underlying this package's
  tests exercise, and building a second fake `VirtualTableModule` just to pin a rejection message
  didn't seem worth the added surface for a test-only ticket. If a reviewer wants that path pinned
  in-package, it's a small addition (a stub module whose `alterTable` throws on a non-append
  `insertAtIndex`).
- **New tests only; nothing existing was touched or re-asserted differently.** I did not re-verify
  the *no-position* default-arm block (`isolation-layer.spec.ts:2888`) beyond confirming it still
  passes — it was explicitly out of scope ("do not change").
- **Coverage is behavioral, not exhaustive over every schema field.** The sibling ticket
  `memory-add-column-at-position` (complete) already pins FK-child-column and generated-column
  renumbering at the memory-module level directly; this ticket didn't re-derive that through the
  isolation layer since `buildOverlayAddColumnChange` doesn't touch those fields itself (it only sets
  `insertAtIndex` and `backfillEvaluator` on the change it forwards) — the renumbering is entirely the
  underlying module's job, already covered there.
