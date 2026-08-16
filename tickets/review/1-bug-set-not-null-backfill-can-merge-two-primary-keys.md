---
description: Filling in the empty values of a column that is part of a table's row identity is now treated as a change of identity on every backend — refused when it would merge rows, otherwise physically re-keyed — so rows no longer silently merge, deleted rows no longer come back, and the persistent backend can find and delete the backfilled rows again.
files:
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`pkColumnRekeyed` now also set for a key-member rewrite — `buildAlterColumnPlan`; docs on `AlterColumnPlan.pkColumnRekeyed`, `planTightenNotNull`)
  - packages/quereus/src/vtab/memory/layer/manager.ts (`validateAlterColumnPlan` rewrite arm calls `validateRekeyedPrimaryKey` with the converted-row mapper; `validateRekeyedPrimaryKey` / `makePrimaryKeyProbe` / both `assertNoPrimaryKeyCollisionIn*` take an optional `RowMapper`; stale NOTE replaced; `convertColumnOnOpenLayers` doc)
  - packages/quereus/src/vtab/memory/layer/row-convert.ts (new `makePrimaryKeyConverter` — key-side twin of `convertRowAtIndex`)
  - packages/quereus/src/vtab/memory/layer/transaction.ts (`convertColumn` re-derives staged deletion keys through `makePrimaryKeyConverter`; doc rewritten; `installNetOwnWrites` doc)
  - packages/quereus-store/src/common/store-module-alter-column.ts (`pkRekeyNeeded` widened to `rewritesValues && pk member`; `valueConvert` block moved ahead of the re-key block; `makeRowConverter` / `mapRowsAsync` replace `convertRowsAtIndex`; NOTE that prescribed the reordering removed)
  - packages/quereus-store/src/common/store-table.ts (`validateRekeyedPrimaryKey` optional `mapRow` applied by both probes; `mapRowsAtIndex` doc)
  - packages/quereus-isolation/src/alter-migration.ts (`derivePkRekey` gains the `set not null` arm, gated on "the underlying will actually backfill"; `PkRekeyContext.forwardedViaAlterSchema`; `deriveAlterMigrationPlan` async + `underlyingRows` param; `forwardAlterColumnToOverlay` drops collapsed markers before `backfillStagedNotNull`; `backfillStagedNotNull(…, rekeysMarkers)` also fills tombstone rows' key column; collision message generalized; poison message)
  - packages/quereus-isolation/src/isolation-module.ts (`rowSource` built before the plan; new `committedRowsOf`; tier-2 `alterSchema` pre-flight gated on `forwardedViaAlterSchema`)
  - packages/quereus/test/logic/41.2.3-alter-column-set-not-null-pk-backfill.sqllogic (new, cross-backend, 12 sections)
  - packages/quereus-isolation/test/isolation-layer.spec.ts (new describe "SET NOT NULL on a nullable PRIMARY KEY column re-keys the overlay like SET COLLATE does" — 3 issuer + 3 foreign-overlay tests)
  - packages/quereus-store/test/alter-table-conformance.spec.ts (2 new arms: honored re-key, colliding → CONSTRAINT)
  - docs/schema.md § Primary-key nullability, docs/sql-alter.md (ALTER COLUMN bullets), docs/memory-table.md § 3 (retitled), docs/store.md, docs/store-catalog-persistence.md
difficulty: hard
repro: verified
---

# `alter column … set not null` on a key column: validate and re-key (implemented)

## What changed, per leg

**Memory (`packages/quereus`).** `buildAlterColumnPlan` now sets `pkColumnRekeyed` for a
value rewrite on a key member (a retype of a key member is refused upstream, so this is only the
`set not null` backfill). `validateAlterColumnPlan`'s rewrite arm runs `validateRekeyedPrimaryKey`
with the same converted-row mapper the UNIQUE probe uses; the mapper is applied inside
`makePrimaryKeyProbe`, so both the effective-row pass (CONSTRAINT) and the layer-chain pass
(BUSY) judge post-backfill keys. On the accepted path own rows already re-keyed themselves; the
fix for staged **deletions** is `TransactionLayer.convertColumn` running each deletion key
through `makePrimaryKeyConverter` (new in `row-convert.ts`: maps the key's component at the
altered column's key position through the same conversion; identity for a non-key column). No
row image is needed, so no prepare/install split. Soundness argument in `convertColumn`'s doc:
the pre-pass forbids any converging pair anywhere in the chain, so a re-derived deletion key
resolves to exactly the converted image of the row this layer deleted; no `deletionTargets`
identity check (none possible without an image, and the conversion is not invertible).

**Store (`packages/quereus-store`).** `pkRekeyNeeded` now includes a key-member value rewrite.
Order in `alterColumnChange` is: UNIQUE re-validation → PK probes (`validateRekeyedPrimaryKey`
with `mapRow`, both passes) → **value rewrite (`mapRowsAtIndex`)** → **re-key (`rekeyRows` +
index rebuild)** → the `!pkRekeyNeeded` index rebuild is skipped, so every index is built once.
The old NOTE that prescribed exactly this reordering is gone. `rekeyRows` itself is unchanged —
it recomputes keys from the stored (now rewritten) row.

**Isolation overlay (`packages/quereus-isolation`).** `derivePkRekey` has a second arm:
`set not null` on a key member with a usable DEFAULT, **only when the underlying will actually
backfill** — decided by scanning the same rows the underlying's own gate reads (`underlyingRows`
= the issuer's effective rows when it has staged work, else the underlying's committed rows via
the new `IsolationModule.committedRowsOf`). Without that gate a metadata-only tightening (no
visible NULL) would leave the committed NULL keys in place while the overlay re-keyed its
markers away from them. `keyOf` serializes the backfilled tuple. `PkRekeyContext` grew a
`forwardedViaAlterSchema` flag: the tier-2 `alterSchema` pre-flight in `IsolationModule.alterTable`
runs only for the `set collate` flavour (the backfill is never forwarded through `alterSchema`;
its marker drop runs in the migrate step only, before `backfillStagedNotNull`). Two things the
ticket did not spell out and that turned out to be required:

- **Markers must be re-keyed too.** A tombstone at a key column carries the REAL key of the
  committed row it deletes, and the underlying just moved that key. `backfillStagedNotNull`
  gains `rekeysMarkers`: when a `PkRekeyContext` exists it fills the tightened column on
  tombstone rows as well. Mutation-tested: with this disabled, sqllogic § 5 (resurrection)
  fails in store mode with "Expected 1, got 2".
- **`validateOverlayMigration` already fell through** for the has-DEFAULT tightening (the early
  `return` is inside `if (plan.setNotNull && !hasDefault)`); doc updated, no structural change.

## Verified (all green)

- `yarn build` (full, incl. UI apps), `yarn lint`, `yarn test` (9624 passing quereus, all
  workspaces green), `yarn test:store` (9616 passing).
- New `41.2.3-alter-column-set-not-null-pk-backfill.sqllogic`, both modes. Sections: (1)
  committed/committed → CONSTRAINT, table untouched; (2) staged/committed → CONSTRAINT, txn
  usable; (3) collision only among deleted rows → BUSY, retry after commit lands; (4) staged
  delete removes the collision → accepted; (5) resurrection guard through ALTER and COMMIT;
  (6) non-colliding backfill findable by equality seek, duplicate INSERT refused, deletable;
  (7) scalar (arity-1) key; (9) staged/staged → CONSTRAINT; (10) staged NULL row collapsing onto
  a deleted committed row's key → accepted; (11) metadata-only tightening (no visible NULL)
  leaves the deleted NULL-keyed row's deletion landing; (12) non-key backfill unchanged.
- Mutation checks: memory `convertKey` → identity fails § 5 in memory mode; isolation
  `rekeysMarkers` → false fails § 5 in store mode.
- Isolation spec: 3 issuer white-box tests (marker re-keyed to `[0,1,1]`; marker dropped +
  live backfilled; metadata-only leaves marker at NULL) + 3 foreign-overlay tests (poison on
  converging live pair; foreign marker re-keyed and its delete lands; foreign marker/live
  collapse commits the replacement).
- Store conformance matrix (bare `StoreModule`, no isolation): honored re-key arm and
  colliding → CONSTRAINT arm.

## Where to look hardest (reviewer)

- `TransactionLayer.convertColumn` soundness without a `deletionTargets` check — the argument
  rests on `validateRekeyedPrimaryKey` pass 2 walking every layer with `mapRow`. If you can
  construct a chain where two rows converge only ACROSS layers (never within one layer's
  merged tree) and both survive, that is the hole. I could not: a child layer's tree is merged
  with its parents' rows, so a cross-layer pair is always in some single tree.
- Isolation gate parity: `derivePkRekey`'s "will the underlying backfill" scan mirrors the
  underlyings' `hasNullValue` / `rows()`-or-`rowsWithNullAtIndex` gates. If either underlying's
  gate ever changes (e.g. to "any physical row holds NULL"), this scan must follow — no shared
  code enforces it. Consider whether that deserves a debt ticket for a shared predicate.
- Isolation marker/marker collapse under the backfill when the underlying does NOT refuse
  (both markers minted from rows this transaction inserted then deleted — "phantom" markers):
  `planPkRekeyMarkerDrops` drops one, the survivor's key is backfilled, the flush deletes one
  key. I reasoned this is correct whichever survives (they are one logical key), but the
  memory backend without isolation may answer BUSY for the analogous history — a
  cross-backend divergence for that shape. Not pinned by a test; the shape needs a NULL row
  inserted+deleted in the transaction alongside a visible NULL.
- The `alterColumnSetDataType` doc in the store now says a key-member retype "would carry the
  key bytes mechanically" under the new ordering — that is a claim, not something exercised
  (the local guard still refuses). Sanity-check the wording.

## Known gaps / not done

- A FOREIGN overlay's staged live row that converges with a COMMITTED row the issuer backfills
  is not caught anywhere; at that connection's flush it is applied as an update over the
  backfilled row (last-writer-wins). Same pre-existing class and same documented design as the
  `set collate` foreign case ("only the issuing connection's overlay feeds validation") — not
  new, not addressed.
- Whether the rewrite arm fires still depends on a NULL being visible in the transaction's
  effective rows (pre-existing `hasNullValue` gate). So "deleted NULL row + committed collider"
  is BUSY only when some other NULL is visible, and metadata-only otherwise. Documented in
  `docs/sql-alter.md`; not changed.
- Poison message for the foreign converging-pair case says "tightened column … which this
  connection's uncommitted rows cannot satisfy (a NULL with no usable default, or two rows
  converging on one primary key under the backfill)" — one message for both causes.

## Tripwires parked

- `alter-migration.ts` `derivePkRekey`: NOTE on the extra effective-row scan per key-member
  `set not null` with open overlays.
- `validateOverlayMigration` collision message names the second row's OLD tuple; the
  underlyings name the post-change tuple (comment at the site).
