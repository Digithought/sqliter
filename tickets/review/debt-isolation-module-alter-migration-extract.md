description: The half of the transaction-isolation module that carries each connection's uncommitted changes across an ALTER TABLE now lives in its own file, so both that file and the one it left are small enough to read. No behavior changed.
files:
  - packages/quereus-isolation/src/alter-migration.ts     # NEW — the extracted machinery
  - packages/quereus-isolation/src/isolation-module.ts    # 2845 → 1825 lines
  - packages/quereus-isolation/src/isolation-types.ts     # gained the shared state/predicate types
  - packages/quereus-isolation/src/index.ts               # re-export path moved (same public names)
  - packages/quereus-isolation/src/isolated-table.ts      # one import path
  - docs/design-isolation-layer.md                        # one paragraph naming the new file
difficulty: medium
----

# Review: ALTER-migration machinery split out of `isolation-module.ts`

## What the change is

`packages/quereus-isolation/src/isolation-module.ts` was ~2835 lines. About a thousand of them
were one self-contained subject: **carrying a connection's open staging area (its "overlay")
forward across an `ALTER TABLE`.** That subject is now `alter-migration.ts` — free functions
over one overlay, no class state.

`isolation-module.ts` 2845 → 1825 lines; `alter-migration.ts` is 1082 (roughly half of it doc
comments, moved verbatim with their cross-reference links retargeted).

### Moved to `alter-migration.ts`

Per-change-type context derivation (`deriveAddColumnBackfill`, `deriveSetNotNullBackfill`,
`deriveSetDataTypeConvert`, `derivePkRekey`), the pre-mutation validation pass
(`validateOverlayMigration` + `stagedLiveRows` + `computeAddColumnValue` +
`requireTombstoneIndex`), the per-change-type forwards (`forwardColumnShapeToOverlay`,
`buildOverlayAddColumnChange`, `forwardAlterColumnToOverlay`, `backfillStagedNotNull`,
`forwardAddConstraintToOverlay`, `installOverlayUniqueConstraint`,
`forwardConstraintNameChangeToOverlay`, `schemaHasNamedConstraint`), the primary-key re-key
marker handling (`collectPkRekeyGroups`, `dropCollapsedPkRekeyMarkers`,
`planPkRekeyMarkerDrops`, `applyPkRekeyMarkerDrops`, `reinsertPkRekeyMarkers`),
`assertColumnNameNotTombstone`, and `buildAlterPoisonMessage`.

### Deliberately left on the class

- `applyInPlaceOverlayChange` + `issuerOverlayDriftError` + `buildInPlaceAdoptPoisonMessage` —
  the issuer-vs-foreign error routing seam, **shared** with the CREATE/DROP INDEX paths. Moving
  it would have made the index paths import from a file named "alter-migration".
- `replaceOverlayForPrimaryKeyChange` — it swaps the overlay table itself, so it needs
  `connectionOverlays` / `overlayModule` / `createOverlaySchema` / `releaseOverlayTable`.
- `buildDropPoisonMessage` — that one is DROP TABLE, not ALTER.
- The overlay-schema builders (`createOverlaySchema`, `overlayPredicate`, …).

## The three things that are NOT a pure relocation

Flagging these because everything else is a verbatim move and these are where a real defect
could hide.

**1. Four context parameters became one `AlterMigrationPlan` object.** The old code threaded
`addColumnCtx, setNotNullCtx, setDataTypeCtx, pkRekeyCtx` as four separate parameters through
`validateOverlayMigration` and the migrate switch. There was a `NOTE:` comment at the head of
the cluster saying: *if a fourth attribute ever needs a context, extract the cluster into its
own module and pass a single context object instead of a widening parameter list.* A fourth
(`PkRekeyContext`) had already landed, so that condition had tripped; this change does what it
prescribed, and the NOTE is removed. `deriveAlterMigrationPlan` calls the four derive helpers in
the original order (only `derivePkRekey` can throw, and it is still last).

**2. The per-change-type migrate switch moved into `migrateOverlayForward`.** In `alterTable`
the switch is now an early-return for `alterPrimaryKey` followed by one
`applyInPlaceOverlayChange` call; the eight remaining change types are dispatched inside
`alter-migration.ts`. Its parameter is typed `Exclude<SchemaChangeInfo, {type:'alterPrimaryKey'}>`
and still ends in a `never` exhaustiveness check. The old `const alterColumnChange = change`
re-captures (which existed only to pin closure narrowing) are gone; one re-capture remains in
`alterTable` for the same reason.

**3. `backfillStagedNotNull` now calls `requireTombstoneIndex` instead of an inline copy of it.**
Identical message and `StatusCode.INTERNAL`; the schema is already proven non-null at that point.

Two smaller structural changes:

- `IsolationModule.overlayPredicate` and `.schemaHasIndex` went `private` → public so the class
  satisfies the new `AlterMigrationHost` interface (`tombstoneColumn` + those two — the only
  three things the extracted code reaches back for). This widens the exported class's surface by
  two members.
- `UnderlyingTableState`, `ConnectionOverlayState` and the internal `Predicate` alias moved to
  `isolation-types.ts` so `alter-migration.ts` need not import from `isolation-module.ts`
  (avoiding a module cycle). `index.ts` re-exports the same two names from the new location, so
  the **package's public type surface is unchanged**; `isolated-table.ts` picked up the new
  import path.

## What to check

The high-value question is whether the move preserved the ordering and error-routing guarantees
the cluster's doc comments claim, since those are what the whole tiering rests on:

- **Atomic abort for the issuer.** Everything fallible still runs before `underlying.alterTable`.
  Specifically: `assertColumnNameNotTombstone` → `deriveAlterMigrationPlan` →
  `validateOverlayMigration(issuer)` → the primary-key re-key marker drops + `alterSchema`
  validate-only pre-flight → `underlying.alterTable`.
- **Poison vs rethrow for foreign overlays.** `CONSTRAINT`/`MISMATCH` out of
  `validateOverlayMigration` → poison that one overlay and skip its migration; anything else
  rethrows. `CONSTRAINT`/`BUSY` out of the forward → routed by `applyInPlaceOverlayChange`.
- **Marker reinsertion on refusal.** Both catch sites (`alterSchema` pre-flight refusal, and
  `underlying.alterTable` refusal) still call `reinsertPkRekeyMarkers` with the saved rows.
- **`validateOverlayMigration`'s early-return chain.** Its arms `return` after each match, and
  a `set not null` *with* a usable default deliberately falls through to a no-op. That
  fall-through is easy to break when rewriting the gates onto a plan object — worth re-reading.

### Use cases the behavior lives in

Run an `ALTER TABLE` on one connection while one or more *other* connections hold uncommitted
rows staged for the same table, and check both what the issuer sees and what the other
connections see on their next read / write / commit:

- `add column` with a literal default, with a non-foldable per-row `new.<col>` default, and
  `NOT NULL` with no usable default (issuer aborts atomically; a foreign overlay is poisoned).
- `drop column` / `rename column`, including the rejection when the new name collides with the
  overlay's reserved `_tombstone` flag.
- `alter column … set not null` with a usable DEFAULT (staged NULLs backfilled) and without one
  (rejected / poisoned).
- `alter column … set data type` with every staged value convertible, and with one that is not.
- `alter column … set collate` on a primary-key column: a deletion marker collapsing onto a live
  row under the new collation (accepted, marker dropped), two live rows colliding (refused), and
  the refusal path that must leave the dropped markers restored.
- `add constraint` unique / check / foreign key; `drop constraint` / `rename constraint` for a
  constraint the overlay never carried.
- `alter primary key` with a clean overlay (swapped), a dirty issuer overlay (rejected up front),
  and a dirty foreign overlay (poisoned).
- Any of the above followed by `rollback to savepoint` taken *before* the ALTER — the in-place
  migration exists so the savepoint chain survives.

Existing coverage: `packages/quereus-isolation/test/isolation-layer.spec.ts` (the ALTER blocks
around lines 2100–3300 and 6100–6250) and `test/alter-table-conformance.spec.ts`.

## Validation run

- `yarn build` — clean.
- `yarn typecheck` (all packages, incl. the isolation package's `tsconfig.test.json` pass) — clean.
- `yarn lint` — clean.
- `yarn test` — **0 failures.** 7698 quereus, 341 isolation, plus every other workspace package.
- `npx tsc --noEmit --noUnusedLocals` in the isolation package — only two pre-existing hits, both
  in files this change did not meaningfully touch (`isolated-connection.ts:2`,
  `isolated-table.ts:640`).

## Known gaps — treat the above as a floor

- **No new tests were written.** The ticket specified a move, and the existing suite passing
  untouched is the intended proof. But that means the split is verified only to the resolution
  the existing tests already had; if a path was untested before, it is untested now. There is a
  sibling ticket `debt-isolation-pk-rekey-edge-paths-untested` covering exactly that gap for the
  primary-key re-key arm, which is the newest and least-covered part of what moved.
- **`yarn test:store` was not run.** Per AGENTS.md it is for store-specific diagnosis or release
  prep, and this change is pure relocation inside the isolation layer. The store path does
  exercise ALTER, so if the reviewer wants belt-and-braces, that is the run to do.
- **`buildOverlayAddColumnChange` still carries its own inline tombstone-column lookup** rather
  than calling `requireTombstoneIndex`. Left alone on purpose: it reads through an optional
  schema (`overlayTable.tableSchema?.…`) where the helper requires a non-null one, so collapsing
  them would change which condition produces the error. Minor duplication, deliberate.
- **`AlterMigrationHost` is satisfied structurally, not nominally checked at every call site.**
  `IsolationModule` declares `implements … AlterMigrationHost`, so drift is caught — but the
  interface is a callback seam back into the class, which is the one direction of coupling the
  split did not remove. If a future change needs a fourth member on it, that is a signal the
  boundary is in the wrong place.
