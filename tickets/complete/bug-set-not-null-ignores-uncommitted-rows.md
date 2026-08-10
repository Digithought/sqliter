----
description: Tightening a column to NOT NULL inside a transaction now sees the rows that transaction just wrote — a pending NULL rejects the ALTER (or is backfilled from the column's DEFAULT) instead of being silently ignored, across all three storage backends. This ticket records the review of that fix.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus-isolation/README.md
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus-store/test/isolated-store.spec.ts
  - docs/memory-table.md
----

# Complete: `alter column … set not null` sees the transaction's own rows

## What landed

`ALTER TABLE … ALTER COLUMN … SET NOT NULL` used to decide reject-vs-backfill by scanning only
**committed** rows, ignoring the issuing transaction's own uncommitted writes — so a pending NULL
was silently accepted, leaving a NULL under a `NOT NULL` column. Fixed independently in all three
storage layers, mirroring the already-landed `set data type` (memory) and UNIQUE-DDL-overlay
(isolation) fixes (implement commit `16db946a`):

- **Memory** — the NULL scan now walks the effective view (`rows() ?? effectiveDdlRows()`); backfill
  was rerouted off the old in-place `tree.upsert` onto the same base-replacement + open-layer
  conversion seam `set data type` uses, via a new `convertNulls` flag threaded through
  `convertBaseRows` / `TransactionLayer.convertColumn` (the `null → DEFAULT` map otherwise skips
  NULLs). Local `typeConvert` renamed `valueConvert` (now serves both arms).
- **Store** — `alterColumnSetNotNull` takes the isolation-supplied `rows` and scans the overlay for
  the decision; the committed-store `mapRowsAtIndex` backfill is unchanged (overlay-resident pending
  rows are the isolation layer's job).
- **Isolation** — new `SetNotNullBackfillContext` + `deriveSetNotNullBackfill`;
  `translateOverlayRow` backfills a staged NULL when a usable DEFAULT exists;
  `validateOverlayMigration` rejects a staged NULL with no usable DEFAULT (issuer → atomic abort,
  foreign → poison), matching the `add column … not null` tiering.

## Review findings

**Checked:** the full implement diff read fresh across all four source files (memory `manager.ts`
+ `transaction.ts`, store `store-module.ts`, isolation `isolation-module.ts`) and all four test
files + `docs/memory-table.md`; the reject-vs-backfill decision over the effective view on each
backend; the `convertNulls` threading through base-replacement and open-layer conversion; the
primary-key key-bytes-change edge; tombstone handling in the isolation validate/translate loops;
the poison tiering (issuer atomic abort / foreign poison / foreign DEFAULT backfill);
`deriveSetNotNullBackfill`'s pre-alter-schema source; the DEFAULT-literal detection across backends;
the deferred `set data type`-behind-isolation gap and its `NOTE:` pointers; the atomicity reasoning
in the `alterColumn` catch block; docs (`docs/memory-table.md`, `quereus-isolation/README.md`).
Build (all packages type-check), lint (`@quereus/quereus`), and the full workspace `yarn test`
(6932 passing in quereus + all wrapped packages, **0 failing**, 13 pending) all green.

**Verified correct (no action):**
- PK-column backfill cannot corrupt keys: a NULL in a PRIMARY KEY column is unreachable — quereus
  rejects `insert`ing NULL into any PK part (verified empirically), so the backfill (which would
  change key bytes) never fires on a key column. The doc claim "key bytes never change" holds.
- Effective-view scan excludes pending-deleted rows and includes pending overwrites (both backends
  use the engine's live-only `rows()` / `effectiveDdlRows()`); tombstone rows are correctly skipped
  in the isolation white-box path (raw overlay query yields tombstones; the merged `rows()` does not).
- Poison tiering matches the `add column … not null` path: issuer un-backfillable overlay aborts
  atomically before the underlying mutates; foreign one is poisoned; foreign with a usable DEFAULT
  is backfilled forward. `deriveSetNotNullBackfill` reads the (shared) pre-alter overlay schema, so
  every migrated overlay sees the same column index + folded DEFAULT.
- The `alterColumn` catch-block comment ("a throw from … `setNotNull`'s NULL scan mutated nothing")
  still reads correctly: the scan runs before any mutation and throws atomically.

**Minor — fixed inline this pass:**
- `packages/quereus-isolation/README.md` — the "Atomic ALTER + cross-connection poison" bullets
  described the mechanism only in terms of `ADD COLUMN … NOT NULL`. `SET NOT NULL` now drives the
  identical validate/poison/backfill path; generalized the wording (issuer "the ALTER" not "an ADD
  COLUMN"; foreign "the new or newly-`NOT NULL` column"; noted the DEFAULT-backfill branch). A doc
  the change should have touched.
- `packages/quereus/src/vtab/memory/layer/manager.ts` — the perf tripwire "rebuilds EVERY secondary
  index, not just those covering the altered column; filter if wide-index tables get slow" was
  **deleted** with the old `valuesRewritten` branch and **not** re-homed. The handoff claimed it
  "already exists on the sibling path" — it did not (grep-verified absent). Re-added the `NOTE:` at
  the shared `valueConvert` rebuild site so the tripwire set stays greppable.
- `packages/quereus/test/ddl-in-transaction-validation.spec.ts` — added two cases the suite missed:
  a pending **UPDATE** overwriting a committed non-null to NULL rejects, and one clearing the only
  committed NULL is accepted. The prior tests covered pending insert + pending delete but not the
  in-place overwrite path through the effective view. (Memory spec now 78 passing, was 76.)

**Major — new tickets:** none. No defect warranted a new fix/plan/backlog ticket.

**Tripwires (parked, not ticketed):**
- `set data type` behind the isolation overlay is still an open gap (its issuer/foreign overlay rows
  are not converted). Deferred by the source ticket and by the prior `set data type` review, which
  deliberately left it un-ticketed. The exact seam a future implementer would extend
  (`SetNotNullBackfillContext` / `translateOverlayRow` / `validateOverlayMigration`) carries greppable
  `NOTE:` markers pointing at the completed memory-side ticket that documents the gap. Confirmed the
  pointer lands on real, gap-documenting content and sits where a future implementer would be working.

**Known gaps re-confirmed, correctly left as-is (no new ticket):**
- **DEFAULT-literal detection asymmetry (pre-existing).** Memory and isolation fold the DEFAULT with
  `tryFoldLiteral` (accepts e.g. `1+1`); the store uses a strict `expr.type === 'literal'`. A
  `SET NOT NULL` with a foldable-but-non-literal DEFAULT would backfill on memory but reject on the
  store. This predates the ticket (the store's strict check and memory's fold both existed on the
  prior `set data type` / add-column paths) and is not exercised by any test. Narrow, dormant, and
  behind the store path; not introduced here, so left un-ticketed rather than expanding scope.
- **Wrapped-package test files are `tsconfig`-excluded** (type-stripped at runtime, project
  convention), so the isolation/store spec additions are not CI type-gated — only `@quereus/quereus`
  lint type-checks its own test files. Convention question, not this ticket's to change.
- **Foreign-overlay poison exercised only against a `MemoryTableModule` underlying** in the white-box
  matrix (harness convention); the store-behind-isolation path is covered separately by
  `isolated-store.spec.ts` (reject + DEFAULT backfill), just not the foreign-poison case against a
  real store. Heavier; not added.

**Empty categories stated explicitly:** No major findings and no new tickets — every finding was
minor and fixed in this pass. No pre-existing test failures surfaced (full suite 0 failing).

## How it was validated

`yarn build` (all packages type-check), `yarn workspace @quereus/quereus run lint` (clean), and
`yarn test` (full workspace, 0 failing) all run green this pass, including the memory block (now 78
cases), the isolation conformance + white-box specs, and the store-behind-isolation spec.
`yarn test:store` (LevelDB) not run — same agent-runtime deferral the sibling tickets take; the store
path is exercised in-process via `isolated-store.spec.ts`.
