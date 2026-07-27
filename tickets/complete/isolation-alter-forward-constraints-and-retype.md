----
description: Changing a column's type, nullability, default or collation, or adding, dropping or renaming a constraint inside a transaction no longer throws away rows the transaction had already written before a savepoint. The machinery that used to copy a transaction's staged rows into a fresh staging table is gone; every such change is now applied to the staged rows where they already sit.
files:
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic
  - docs/design-isolation-layer.md
  - packages/quereus-isolation/README.md
----

# Complete: ALTER COLUMN and the constraint change types forward to the isolation overlay in place

Second half of `isolation-alter-forward-column-shape`. A transaction's uncommitted rows live in a
per-connection staging table (the "overlay"). Carrying that overlay across an `ALTER TABLE` used
to mean copying every staged row into a *new* staging table — which flattened the transaction's
savepoint chain, so a later `rollback to savepoint` discarded rows staged *before* the savepoint.
Every change type now applies in place instead, through the overlay module's own
`alterSchema` / `createIndex` or through ordinary staged writes. `migrateOverlayForAlter`,
`translateOverlayRow`, `insertIntoRebuiltOverlay` and `adoptRebuiltOverlay` are deleted; nothing
in the layer rebuilds an overlay any more.

## Where each change type lands

| Change | Route |
| --- | --- |
| `add` / `drop` / `rename column` | `forwardColumnShapeToOverlay` (prior ticket) |
| `alter column set data type` / `set collate` / `set default` | forwarded verbatim to the overlay's `alterSchema` |
| `alter column set not null` | **withheld** from the overlay; staged live NULLs filled by `backfillStagedNotNull` via ordinary writes |
| `alter column drop not null` | withheld too — the overlay never enforced nullability |
| `add constraint … unique` | a tombstone-narrowed unique **index** (`installOverlayUniqueConstraint`) |
| `add constraint … check` | forwarded verbatim (schema-only) |
| `add constraint … foreign key` | not forwarded (engine-side enforcement) |
| `drop` / `rename constraint` | forwarded, presence-guarded so an unforwarded constraint no-ops |
| `alter primary key` | no overlay can follow: issuer with staged rows rejected pre-mutation, foreign poisoned, clean overlay swapped |

Pre-validation (`validateOverlayMigration` and the three `derive*` contexts) and the
issuer-atomic / foreign-poison tiering are unchanged.

## Review findings

### Fixed in this pass (minor)

- **`set collate` had no test at all against an open overlay.** The one production line this
  ticket changed outside the isolation package — `MemoryTable.alterSchema` passing `setCollation`
  through to `manager.alterColumn` — was uncovered: every existing `set collate` test
  (`41.7*.sqllogic`) runs outside a transaction, so no overlay exists and the forward never
  fires. Verified the gap by reverting the one-liner: the whole statement then dies with
  `ALTER COLUMN requires an attribute to change` (INTERNAL) for any connection holding an
  overlay. Added `SET COLLATE forwards to the overlay and keeps the savepoint ledger` to
  `isolation-layer.spec.ts` and confirmed it fails on the reverted line and passes on the fix.
- **`add constraint … check` forwarding was untested.** Added a test covering in-transaction
  enforcement, the savepoint split, and the later `drop constraint` that resolves against the
  overlay's own copy — the reason the CHECK is forwarded at all.
- **`drop not null` was untested.** It takes the same withheld path as the tightening direction,
  so nothing tells the overlay the column relaxed. Added a test that stages a NULL immediately
  after the relax, in-transaction and past the flush.
- **`docs/design-isolation-layer.md` still documented the deleted rebuild model** in five places
  ("`createIndex` / `dropIndex` rebuild each overlay", "`alterTable` translates every staged
  row", "a rebuild that cannot re-insert a staged row…", "overlay-rebuilding paths", and the
  overlay-schema rationale). Rewritten to the in-place model, with the per-change-type routes
  spelled out and a new `ALTER PRIMARY KEY` section — the doc had no mention of that behavior.
- **`packages/quereus-isolation/README.md` did not mention the new user-visible restriction**
  that `ALTER PRIMARY KEY` is rejected while the connection has staged rows. Added.
- **`alter-table-conformance.spec.ts:532`** named the deleted `adoptRebuiltOverlay`. Repointed at
  `applyInPlaceOverlayChange`.
- **`buildRebuildPoisonMessage` renamed to `buildInPlaceAdoptPoisonMessage`** — its own doc
  already said "raised by the in-place adoption itself"; nothing rebuilds any more.
- **`forwardAlterColumnToOverlay`'s doc claimed "the overlay's copy of the column stays
  nullable".** False: `createOverlaySchema` copies each base column verbatim, `notNull` included.
  Corrected, and both NOT NULL directions are now documented explicitly rather than the relaxing
  one falling through an unexplained early return.

### Filed as a new ticket (major)

- `fix/pk-collate-in-transaction-misjudges-deleted-rows` — changing a primary-key column's
  collation inside a transaction misjudges rows the transaction has deleted, in two shapes.
  Reproduced both. Shape 1: a collision that exists only among deleted rows still refuses the
  ALTER, on both legs, even though the isolation layer already passes the correct effective-row
  set down. Shape 2 (worse): a committed row deleted and replaced by one that collides with it
  under the new rule — the underlying accepts and commits, then the overlay's own primary key
  (which deliberately covers deletion markers) collides marker-vs-staged-row, and the statement
  dies with the INTERNAL "validation and migration have drifted" message *after* the shared
  table's collation has already changed. Not a regression from this diff — the old rebuild path
  hit the identical collision re-inserting the two rows — but never covered, and reachable today
  because `alter-collate-pk-in-transaction` made the statement genuinely work in a transaction.

### Recorded as a tripwire (not a ticket)

- The overlay's per-column `notNull` flag now drifts from the base across **both** NOT NULL
  directions, since neither forwards. Inert today: the isolation layer builds the overlay's
  `FilterInfo` itself (`filter-info.ts`) and never plans through `MemoryTableModule.getBestAccessPlan`,
  which is the one consumer that reads the flag (it prunes `IS NULL` on a NOT NULL column to an
  empty result) — and the overlay write path does not consult nullability at all. `NOTE:` parked
  at `forwardAlterColumnToOverlay` in `isolation-module.ts`, stating what would have to change
  for it to bite. The new `drop not null` test pins the current behavior.

### Checked and clean

- **Read the implement diff first**, then the follow-on triage commit, before the handoff.
- **The implementer's flagged memory-native defect is already fixed.** The runner's triage pass
  (`c1ab1215`, immediately after the implement commit) landed
  `adoptSchemaOnOpenLayers` on the metadata-only `alterColumn` arm and on `renameConstraint`,
  deleted `tickets/.pre-existing-error.md`, and moved the two withheld sqllogic shapes back into
  `41.8`. Re-read both; nothing stale left behind, no `NOTE:` pointing at the deleted file.
- **Runtime-added UNIQUE naming resolves end to end.** `installOverlayUniqueConstraint`'s
  `constraint name ?? '_uc_<cols>'` matches `MemoryTableManager.implicitIndexNameFor`;
  `createIndex({unique: true})` derives a `UniqueConstraintSchema` under the index's own name
  with `derivedFromIndex` set, so `schemaHasNamedConstraint` finds it and a later
  `drop`/`rename constraint` takes the UNIQUE arm and tears down constraint *and* covering index
  together. Traced through `manager.ts` rather than trusting the doc comment.
- **"A runtime-added UNIQUE carries no partial predicate" holds** — `buildUniqueConstraintSchema`
  has no predicate field, so narrowing the overlay index to live rows loses nothing.
- **Converter parity.** `deriveSetDataTypeConvert` and memory's own retype arm both call
  `validateAndParse(v, newLogicalType, columnName)` and wrap failures as `MISMATCH`. This
  matters: `applyInPlaceOverlayChange` catches only `CONSTRAINT`, so a `MISMATCH` escaping the
  forward would abort the issuer's ALTER *after* the underlying committed. Parity is what makes
  that unreachable — if either converter is ever swapped, the routing needs revisiting.
- **"Tombstones ride a retype through untouched" holds** for a non-obvious reason worth
  recording: memory rejects `set data type` on a primary-key column outright, so a retyped column
  is always one where a deletion marker carries NULL, and `convertNulls` is false for a retype.
- **`replaceOverlayForPrimaryKeyChange`'s savepoint claim holds.** Confirmed
  `MemoryTable.ensureConnection` registers the fresh staging table's connection via
  `Database.registerConnection`, which replays depths `0..activeDepth`. The clean-overlay swap is
  also close to unreachable through real SQL (an overlay is created and marked dirty inside one
  `update` call), which is why its white-box test injects state directly.
- **FOREIGN KEY non-forwarding is benign.** Nothing reads an overlay's `foreignKeys` except the
  presence guard, so an overlay created before the FK add no-ops its later drop/rename and one
  created after forwards it cleanly. Both are correct.

### Not chased

- The store leg of `41.8` still logs `[TransactionCoordinator] rollback-to savepoint depth 0 out
  of range` warnings. Already flagged by the column-shape review, still cosmetic, all assertions
  hold. Not re-reported.
- The `_exhaustive: never` local in `alterTable`'s switch trips an editor-only TS 6133 hint. It
  is the project's existing exhaustiveness idiom and `yarn lint` is clean; left alone.

## Validation run

- `yarn build` — clean.
- `yarn lint` (all packages; `packages/quereus` runs eslint + `tsc -p tsconfig.test.json`) — clean.
- `yarn test` — all packages green: 7404 (quereus), 315 (isolation, +3 from this pass), 1081,
  594, 134, 109, 68, 61, 52, 34, 31, 28, 22, 17, 10.
- `node test-runner.mjs --store --grep "41\."` from `packages/quereus` — 21 passing, 1 pending.
- Both the reverted-one-liner check and the two new bug repros were run through a throwaway spec
  that was removed afterwards.
