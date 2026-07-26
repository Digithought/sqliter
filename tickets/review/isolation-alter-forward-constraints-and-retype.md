---
description: Changing a column's type, nullability, default or collation, or adding, dropping or renaming a constraint inside a transaction no longer throws away rows the transaction had already written before a savepoint. The overlay rebuild machinery is gone; every ALTER now adjusts the staged rows in place.
prereq: isolation-alter-forward-column-shape
files:
  - packages/quereus-isolation/src/isolation-module.ts        # the whole change
  - packages/quereus/src/vtab/memory/table.ts                 # one line — alterSchema now passes setCollation through
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new savepoint suite, ADD CONSTRAINT + tombstone white-box, ALTER PRIMARY KEY suite
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic  # new cross-backend sections
  - tickets/.pre-existing-error.md                            # memory-native metadata-only-ALTER savepoint defect surfaced by the new coverage
---

# Review: ALTER COLUMN and the constraint change types now forward to the isolation overlay in place

Implemented from `implement/isolation-alter-forward-constraints-and-retype` — the second half of
`isolation-alter-forward-column-shape` (read its review for the root cause: rebuilding the overlay
replayed the savepoint stack above the copied rows, so `rollback to savepoint` discarded rows
staged before the savepoint). The rebuild machinery (`migrateOverlayForAlter`,
`translateOverlayRow`, `insertIntoRebuiltOverlay`, `adoptRebuiltOverlay`) is deleted; nothing
rebuilds an overlay any more.

## What changed (all in `isolation-module.ts` unless noted)

- `alterTable`'s `migrateOverlay` dispatch now forwards every change type in place, all routed
  through the shared `applyInPlaceOverlayChange` CONSTRAINT tiering (issuer → INTERNAL drift
  error, foreign → poison):
  - **`alterColumn`** (`forwardAlterColumnToOverlay`): `set data type` / `set collate` /
    `set default` forward through the overlay's own `alterSchema` — the memory module converts /
    re-keys its open layers with savepoint snapshots intact, and NULLs pass a retype untouched so
    tombstones ride through. **`set not null` is deliberately withheld** — the overlay column
    stays nullable (tombstones carry placeholder NULLs) — and staged LIVE NULLs are filled by
    `backfillStagedNotNull` via ordinary `overlay.update()` writes keyed by PK.
  - **`addConstraint`** (`forwardAddConstraintToOverlay`): UNIQUE lands as a
    **tombstone-narrowed unique index** (`installOverlayUniqueConstraint`) through
    `overlayTable.createIndex` + the existing `overlayPredicate` narrowing, named
    `constraint name ?? '_uc_<cols>'` (the memory module's `implicitIndexNameFor` rule) so
    DROP/RENAME resolve it later. CHECK forwards verbatim (schema-only). FOREIGN KEY is **not**
    forwarded — engine-side enforcement, and the memory FK arm validates via a catalog query the
    unregistered `_overlay_*` table cannot serve. `add constraint … primary key` asserts INTERNAL
    (both bundled underlyings reject it first). Rationale for each is in the method doc.
  - **`dropConstraint` / `renameConstraint`** (`forwardConstraintNameChangeToOverlay`): forwarded,
    **presence-guarded** (`schemaHasNamedConstraint`) so a constraint the overlay never carried
    (an unforwarded FK; UNIQUE under an overlay module without `createIndex`) no-ops instead of
    aborting the issuer's already-applied ALTER with NOTFOUND.
  - **`alterPrimaryKey`**: established end-to-end — memory rejects it (UNSUPPORTED) so it is only
    reachable through a store-backed underlying. The overlay cannot follow (layer trees keyed by
    the old PK; tombstone identity is the old PK), so: issuer with staged rows → rejected
    UNSUPPORTED **before** `underlying.alterTable` (atomic); foreign with staged rows → poisoned;
    clean overlay → swapped for a fresh staging table under the post-alter schema
    (`replaceOverlayForPrimaryKeyChange`).
- Pre-validation (`validateOverlayMigration` + the three derive* contexts) and the
  issuer-atomic / foreign-poison tiering are **kept unchanged**; `setDataTypeCtx` now serves
  validation only (the conversion itself is the overlay module's job).
- `packages/quereus/src/vtab/memory/table.ts`: `MemoryTable.alterSchema` was silently dropping
  `setCollation` when delegating to `manager.alterColumn` — with the rebuild gone, the in-place
  `set collate` forward needs the instance-level path to carry it. One-line fix; the module-level
  path already passed it.

## How to validate

- `yarn workspace @quereus/isolation run test` — 308 passing (was 291). New coverage:
  - "constraint & retype ALTER inside a transaction preserves the overlay savepoint chain":
    savepoint-ledger splits for SET NOT NULL (plus the backfill flavor), SET DATA TYPE
    (survivor comes back CONVERTED), SET DEFAULT, ADD/DROP/RENAME CONSTRAINT, and the spike's
    tombstone case (UNIQUE over a primary-key member with two in-transaction deletions must not
    report a phantom duplicate).
  - Poison-suite white-box additions: ADD CONSTRAINT UNIQUE forwards a foreign overlay in place
    (same object, narrowed index + derived UNIQUE installed, enforces for the rest of the
    transaction), poisons a violating foreign overlay without truncating its rows, ignores a
    foreign overlay's tombstones; a backfilling SET NOT NULL leaves a tombstone's placeholder
    NULL alone and adopts in place (object identity asserted).
  - "ALTER PRIMARY KEY over per-connection overlays": issuer-staged reject fires before the
    underlying is called (call-count asserted on a stub), foreign-staged poison, clean-overlay
    swap (fresh table keyed by the new PK, old one released — leak-map asserted), and the memory
    underlying's UNSUPPORTED propagating untouched. The stub (`PkAcceptingMemoryModule`) answers
    `alterPrimaryKey` with the re-keyed schema and delegates everything else to memory.
- `cd packages/quereus && node test-runner.mjs --grep 41.8` and `--store --grep 41.8` — both legs
  green with the new sections (backfilling SET NOT NULL, SET DATA TYPE conversion + savepoint
  split, SET DEFAULT, ADD/DROP CONSTRAINT savepoint splits, no-savepoint RENAME CONSTRAINT,
  tombstone-UNIQUE-over-PK-member, tombstone across a backfilling SET NOT NULL).
- Full `yarn build`, root `yarn test` (all packages), `yarn lint` — clean.
- `alter-table-conformance.spec.ts` untouched and green (its one stale comment mentioning
  `adoptRebuiltOverlay` was left alone per the "treat any edit as a signal" instruction).

## Flags for the reviewer (honest gaps)

- **Savepoint-frame consequence of the NOT NULL backfill, by design**: `backfillStagedNotNull`'s
  rewrites are ordinary staged writes in the CURRENT frame, so `rollback to savepoint` to a
  point BEFORE the ALTER restores the pre-backfill NULL while the column stays NOT NULL.
  Confirmed to be the same class as backlog `bug-rolled-back-rows-violate-surviving-ddl` (any
  rolled-back row can violate surviving DDL — e.g. un-inserting past an ADD CONSTRAINT); the
  NOTE at the site references that ticket. No sqllogic test exercises that divergent shape on
  purpose.
- **A new memory-NATIVE defect surfaced** (NOT fixed here — memory layer manager, outside the
  diff): a metadata-only `alter column set not null` or a `rename constraint` with a savepoint
  across it loses the transaction's staged rows on the memory leg. Repros + suspected vicinity
  (`adoptSchemaOnOpenLayers` skipped by the metadata-only arms) in `tickets/.pre-existing-error.md`.
  The two affected sqllogic shapes live in the isolation spec instead (where they pass — staged
  rows live in the overlay), with a NOTE in the 41.8 file saying so; nothing was skipped or
  weakened.
- **FOREIGN KEY constraints never forward to overlays** (add/drop/rename all no-op overlay-side
  for FKs). Believed correct — FK enforcement is engine-side and overlay FK entries are inert —
  but it does mean an overlay created BEFORE an `add constraint … foreign key` carries no copy
  while one created after does (schema drift with no behavioral consequence found). Worth a
  reviewer sanity-check.
- **Missing overlay-module capability = no-op** (`alterSchema` for alterColumn/CHECK/drop/rename,
  `createIndex` for UNIQUE), mirroring the index paths and the column-shape ticket's documented
  posture — the same reviewer-opinion flag from that review still applies to a host-injected
  custom overlay module.
- The `alterPrimaryKey` store-leg behavior is exercised only through the white-box stub; the 41.8
  sqllogic has no alterPrimaryKey section because the memory leg rejects it with a different
  error than the staged-rows pre-check, so no single expected outcome fits both legs.
- The store leg of 41.8 still logs the pre-existing `[TransactionCoordinator] rollback-to
  savepoint depth 0 out of range` warnings the column-shape review already flagged; assertions
  all hold.
