----
description: A transaction that deletes a row and re-inserts a replacement whose key differs only in letter case can now change that column's sorting rule without an internal error or silent row loss; sequences that genuinely cannot be re-keyed are refused up front as retryable, matching the plain in-memory table.
files:
  - packages/quereus-isolation/src/isolation-module.ts       # PkRekeyContext + derivePkRekey, validateOverlayMigration arm, tier-2 pre-flight block in alterTable, plan/apply/reinsert marker helpers, BUSY poison routing
  - packages/quereus-isolation/src/isolation-types.ts        # overlay-module contract note (validateOnly)
  - packages/quereus/src/vtab/table.ts                       # VirtualTable.alterSchema gains optional validateOnly
  - packages/quereus/src/vtab/memory/table.ts                # plumbs validateOnly (alterColumn only)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn validateOnly early-return before first mutation
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # rekey deletion replay verifies old-comparator identity (insurance)
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # new describe "SET COLLATE … collapses overlay deletion markers"
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES entry for the new file
difficulty: hard
----

# Review: isolation overlay adopts a primary-key re-key that collapses a deletion marker onto a staged row

## What the fix does

The headline scenario now works end to end. Inside a transaction: delete row `'A'`, insert
`('a','y')`, then `alter table … alter column k set collate nocase`:

- The ALTER succeeds (previously: an internal "validation and migration have drifted" error
  after the shared table had already been re-keyed).
- The overlay's deletion marker for `'A'` is discarded — under the new collation it is the
  staged replacement's before-image, not a second row.
- COMMIT leaves the table holding `('a','y')` (previously: silent row loss — the flush deleted
  the row it had just inserted, leaving the table empty).
- `rollback to savepoint` across the ALTER still resurrects the marker when the savepoint
  pre-dates the insert (the overlay is migrated in place; its savepoint chain survives).

Two staged live rows on one new key remain a real duplicate: the issuer is refused with the
same `UNIQUE constraint failed: <table> primary key collides under new collation (key: …)`
message the memory module uses, before anything mutates; a foreign connection's overlay in
that shape is poisoned and keeps its rows.

## One deliberate deviation from the ticket

The ticket asked for the second reproduction — insert two case-variant rows and delete both,
then re-key — to *succeed*. It does not; it is refused with the memory module's retryable
BUSY ("rows this transaction has removed still collide under the new collation … Commit/rollback
and retry"), **surfaced before the shared table mutates**, and the transaction survives: its
deletes still commit, and the retried ALTER after commit succeeds.

Reason: the **plain memory table (no isolation) refuses the identical statement sequence with
the identical BUSY** — the transaction's history layers hold the colliding pre-delete pair, and
the memory module's re-key representability check is deliberately conservative about any chain
that ever held a colliding pair (documented tradeoff in `validateRekeyedPrimaryKey`'s doc;
narrowing it is unsound without a smarter per-layer replay — I verified a concrete row-loss
counterexample when probing only rollback-reachable layers). Making the isolation leg *succeed*
here would have required exceeding plain-memory semantics by redesigning the memory module's
re-key replay. Parity plus atomicity is what landed. Same for the shape where a user savepoint
sits between the staged pair and the ALTER (rollback to it would have to restore a marker and
a live row at one re-keyed key — unrepresentable): atomic BUSY, transaction intact.

## How it works (for the reviewer)

- `derivePkRekey` (isolation-module.ts) builds a per-ALTER context when `set collate` actually
  changes the collation of a primary-key member: PK column positions plus a key serializer over
  the post-change collation (mirrors the memory manager's metadata-only gate via
  `validateCollationForType`).
- `validateOverlayMigration` gains an arm: group staged rows (markers included) by post-change
  key; two live rows in a group → CONSTRAINT (issuer aborts atomically, foreign poisons).
- **Tier-2 pre-flight** (new block in `alterTable`, issuer only): snapshot the issuer's
  effective rows (the marker drops below would un-shadow the committed rows those markers
  delete), drop the collapsible markers (saving their keys), then dry-run the overlay's
  `alterSchema(change, validateOnly=true)`. Any refusal — the pre-flight's or the
  underlying's — reinserts the markers (a marker is fully determined by its primary key) and
  rethrows with everything net-untouched.
- The migrate step re-runs the marker drop (a no-op after tier 2 — re-planning finds nothing)
  and forwards the real `alterSchema`; foreign overlays get drop+forward there, with BUSY now
  routed to poison exactly as the old NOTE in `applyInPlaceOverlayChange` prescribed.
- `validateOnly` is a new optional parameter on `VirtualTable.alterSchema`, implemented by the
  memory module for `alterColumn`: everything up to and including the pre-mutation validation
  passes runs, then it returns before the first mutation.
- `TransactionLayer.installNetOwnWrites` now verifies, under the old comparator, that a
  replayed deletion found the row it actually removed. The chain-wide validation pass makes a
  wrong-row land unreachable today; the guard is insurance so replay correctness does not hinge
  on that pass's exact conservatism.

## Validation performed

- `yarn workspace @quereus/isolation test` — 330 passing (6 new tests: both repros, savepoint
  resurrection, savepoint-after-pair atomic BUSY, foreign poison, foreign in-place collapse).
- `yarn workspace @quereus/quereus test` — 7452 passing, 13 pending (includes the new
  memory-only sqllogic file).
- `yarn test` (full workspace) and `yarn lint` — clean.
- Store leg scoped per the ticket: `node test-runner.mjs --store --grep "41"` (30 passing) and
  `--grep "10.1"` (5 passing). The new sqllogic file is memory-only — **confirmed empirically**:
  on the store leg it diverges at the very first INSERT because the store defaults an
  undecorated text primary key to NOCASE, before ever reaching the ALTER (and the store's own
  re-key still judges committed rows — `backlog/bug-store-pk-collate-rejects-deleted-row-collision`).

## Known gaps / where to push

- **The transaction.ts deletion-identity guard has no direct test.** It is unreachable through
  any in-tree path (the chain-wide validation pass refuses every shape that would trigger it),
  and constructing one requires bypassing that pass. Treat it as defensive code; if you want it
  pinned, a white-box TransactionLayer unit test is the only route.
- **Foreign-overlay BUSY→poison routing is untested.** Injected white-box overlays are written
  in one layer, so their re-key never BUSYs; a layered foreign overlay needs savepoint
  mirroring on a second connection, which the white-box harness doesn't drive. The routing is
  three lines in `applyInPlaceOverlayChange`, but a test would be better.
- **Host-injected overlay modules** (`config.overlay`) that ignore `alterSchema`'s new
  `validateOnly` parameter would apply the change during the pre-flight. Contract documented in
  `VirtualTable.alterSchema` and `IsolationModuleConfig.overlay`; not enforced at runtime.
- Tripwires recorded in code: the grouping pass materializes one key per staged row per ALTER
  (NOTE at `collectPkRekeyGroups`); the pre-flight snapshot materializes the issuer's effective
  rows once per re-keying ALTER (NOTE at the tier-2 block); the memory module's "false BUSY on
  a colliding pair at an unreachable statement boundary" conservatism is pre-existing and
  documented at `validateRekeyedPrimaryKey` — it is what makes the second repro BUSY instead of
  succeed, on both legs equally.
