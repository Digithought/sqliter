----
description: A transaction that deletes a row and re-inserts a replacement whose key differs only in letter case can now change that column's sorting rule without an internal error or silent row loss; sequences that genuinely cannot be re-sorted are refused up front as retryable, matching the plain in-memory table.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # PkRekeyContext + derivePkRekey, validateOverlayMigration arm, tier-2 pre-flight, marker plan/apply/reinsert, BUSY poison routing
  - packages/quereus-isolation/src/isolation-types.ts         # overlay-module contract note (validateOnly)
  - packages/quereus-isolation/README.md                      # SET COLLATE on a PK column bullet (review)
  - packages/quereus/src/index.ts                             # export formatKeyValue (review)
  - packages/quereus/src/vtab/table.ts                        # VirtualTable.alterSchema gains optional validateOnly
  - packages/quereus/src/vtab/memory/table.ts                 # plumbs validateOnly (alterColumn only)
  - packages/quereus/src/vtab/memory/layer/manager.ts         # alterColumn validateOnly early-return before first mutation
  - packages/quereus/src/vtab/memory/layer/transaction.ts     # rekey deletion replay verifies old-comparator identity
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # "SET COLLATE … collapses overlay deletion markers"
  - packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic
  - packages/quereus/test/logic.spec.ts                       # MEMORY_ONLY_FILES entry
  - docs/design-isolation-layer.md                            # tiers 2/3 + new "SET COLLATE on a primary key" section (review)
  - docs/module-authoring.md                                  # VirtualTable.alterSchema / validateOnly contract (review)
----

# Complete: isolation overlay adopts a primary-key re-key that collapses a deletion marker

## What shipped

Inside a transaction: delete row `'A'`, insert `('a','y')`, then
`alter table … alter column k set collate nocase`.

- The ALTER succeeds. The staging area's deletion marker for `'A'` is discarded — under the new
  collation it is the replacement row's before-image, not a second row. Previously this raised
  an internal "validation and migration have drifted" error *after* the shared table had already
  been re-sorted, and a subsequent COMMIT silently emptied the table.
- COMMIT leaves the table holding `('a','y')`.
- `rollback to savepoint` across the ALTER still resurrects the marker when the savepoint
  pre-dates the insert (the staging area is migrated in place, savepoint chain intact).
- Two staged **live** rows on one new key stay a real duplicate: refused with the memory
  module's own collision message, before anything mutates.
- Shapes the re-sorted staging area cannot physically hold are refused as retryable (`BUSY`) —
  surfaced by a new pre-flight *before* the shared table mutates, so the transaction survives.

The implementer's one documented deviation from the original ticket stands and was verified
during review: the second reproduction (insert two case-variant rows, delete both, then
re-sort) is refused with `BUSY` rather than succeeding, because the **plain memory table
refuses the identical statement sequence with the identical `BUSY`**. Parity plus atomicity is
the right answer; making the isolated leg succeed would mean exceeding non-isolated semantics.

## How it works

- `derivePkRekey` builds a per-ALTER context when `set collate` actually changes the collation
  of a primary-key member (mirrors the memory manager's metadata-only gate exactly).
- `validateOverlayMigration` groups staged rows (markers included) by post-change key and
  refuses a group holding two live rows — atomically for the issuer, as poison for a foreign
  connection.
- **Tier-2 pre-flight**: snapshot the issuer's effective rows, drop the collapsible markers,
  then dry-run the staging table's own `alterSchema(change, validateOnly=true)`. Any refusal —
  the pre-flight's or the underlying's — reinserts the marker rows verbatim and rethrows with
  everything net-untouched.
- `validateOnly` is a new optional parameter on `VirtualTable.alterSchema`, implemented by the
  memory module for `alterColumn`: every pre-mutation validation runs, then it returns before
  the first mutation. Non-`alterColumn` change types throw `UNSUPPORTED` rather than silently
  validating nothing.
- `TransactionLayer.installNetOwnWrites` verifies, under the old comparator, that a replayed
  deletion found the row it actually removed.

## Review findings

Read the implement diff first, then the code around it, then the handoff. Ran `yarn build`,
`yarn typecheck`, `yarn lint`, `yarn test` (full workspace), plus the two package test suites
individually. All green — no pre-existing failures surfaced, so nothing was written to
`tickets/.pre-existing-error.md`.

### Fixed in this pass (minor)

- **Restoring a dropped deletion marker was lossy.** `reinsertPkRekeyMarkers` rebuilt each
  marker from its primary key alone, filling NULL at every other column, justified by a doc
  comment claiming "a deletion marker is fully determined by its primary key". That is only
  true of markers minted for a *committed* row. Deleting a row the same transaction had already
  staged converts that row to a marker **keeping its values**
  (`isolated-table.ts`, the convert-to-tombstone branch). So a refused ALTER restored
  `['a', null, 1]` where `['a', 'y', 1]` had been dropped. No path reads a marker's non-key
  columns today, so nothing was observably broken — but the rollback was not the identity it
  claimed to be. Fixed by carrying the whole marker rows through plan → drop → reinsert
  (`PkRekeyGroup.markerPks` → `markerRows`) and reinserting them verbatim. Pinned by a new
  assertion on the existing two-deletions test, which now asserts both markers come back
  unchanged (it fails against the old reconstruction).
- **Duplicated key formatter.** `formatPkKeyValue` was a verbatim copy of the engine's
  `formatKeyValue`, with a comment saying the original was un-exported. It *is* exported from
  its module, just absent from the package barrel. Added it to `packages/quereus/src/index.ts`
  and deleted the copy.
- **Duplicated tombstone-index lookup.** `validateOverlayMigration` inlined the same
  lookup-or-`INTERNAL` the new `requireTombstoneIndex` helper does. Routed through the helper.
- **Redundant guard.** The tier-2 block tested `change.type === 'alterColumn'` alongside
  `pkRekeyCtx`, which can only be non-undefined for that type. Removed.
- **Dead condition in the rollback path.** The `underlying.alterTable` catch guarded on
  `droppedMarkerRows.length > 0` before calling a function whose first line already returns on
  an empty list. Removed.
- **Docs were stale — the change touched none of them.** Updated:
  `docs/design-isolation-layer.md` (tier 2 now describes the pre-flight; tier 3 now says a
  foreign staging area is poisoned by a retryable refusal too; the "forward straight through"
  claim for `set collate` corrected; new section explaining the marker collapse),
  `docs/module-authoring.md` (its claim that `VirtualTable.alterSchema` "no longer exists" was
  actively wrong and now had a new `validateOnly` contract to document), and
  `packages/quereus-isolation/README.md` (a user-facing bullet for the primary-key
  `SET COLLATE` case alongside the existing `ALTER PRIMARY KEY` one).

### Filed as new tickets (major)

- `backlog/debt-isolation-pk-rekey-edge-paths-untested` — two live-but-uncovered safety paths:
  the foreign-staging-area `BUSY`→poison routing (the white-box harness writes injected staging
  areas in a single layer, so they can never raise it), and the transaction-layer deletion
  identity check (unreachable through any in-tree path). Both were flagged by the implementer;
  both are believed correct; neither has a test, so a refactor could break them silently.
- `backlog/debt-isolation-module-alter-migration-extract` — `isolation-module.ts` is now 2835
  lines and roughly half of it is one self-contained subject (carrying staging areas forward
  across a DDL change). This ticket alone added eight methods to it. A behavior-preserving
  extraction to a sibling module.

### Recorded as tripwires, not tickets

- **Host-injected staging modules that ignore `validateOnly`** would apply the change during the
  pre-flight instead of validating. The contract is documented in three places
  (`VirtualTable.alterSchema`, `IsolationModuleConfig.overlay`, `docs/module-authoring.md`) but
  is not enforced at runtime — a `Function.length` check does not work, since a default
  parameter does not count toward arity. Only reachable for a non-conforming host module, so:
  `NOTE:` at the pre-flight call site pointing at a module capability flag as the fix if
  host-injected staging modules ever become common.
- **The marker-only collapse arm (`markerRows.slice(1)`) cannot currently survive an ALTER.**
  Two markers share a post-change key only if the rows they shadow did too, and such a pair is
  refused one level down — by the underlying's re-sort for a committed pair, or by the staging
  area's own for a staged-then-deleted pair. The arm still runs (and is undone) on the way to
  those refusals, so it is kept rather than removed. `NOTE:` at `planPkRekeyMarkerDrops`.
- The implementer's three existing `NOTE:` tripwires (per-row key materialization in the
  grouping pass, the effective-row snapshot in the pre-flight, and the memory module's
  conservative representability check) were re-read and remain accurate as written.

### Checked and found sound — no action

- **Ordering of the effective-row snapshot vs the marker drops.** Dropping a marker un-shadows
  the committed row it deletes, so the underlying must judge the pre-drop view. The snapshot is
  taken first; verified against `issuerEffectiveRows`' merge and against the memory manager's
  two-arm `validateRekeyedPrimaryKey`.
- **Pre-flight/migrate determinism.** The pre-flight's one side effect (draining committed
  layers into the base) can only make the real call see a *shallower* chain, i.e. it is monotone
  toward acceptance — the real call cannot refuse what the pre-flight accepted.
- **Latch handling** around the new `validateOnly` early return: inside the existing
  `try`/`finally`, so the schema-change latch is released.
- **Collation gate parity** between `derivePkRekey` and `MemoryTableManager.alterColumn`
  (`normalized === (oldCol.collation || 'BINARY')`) — a metadata-only re-declare re-keys nothing
  on either side, so they cannot disagree.
- **Error-message parity** with the memory module, including reporting the *second* colliding
  row's key, matching the underlying's duplicate probe.
- **Flush path** reads only a marker's primary key, so the collapse cannot mis-target a delete;
  traced `applyOverlayToUnderlying` end to end for the headline scenario.
- **The new foreign `BUSY`→poison routing widens beyond the re-key case** (any change type's
  forward now poisons on `BUSY` instead of rethrowing). This is what the pre-existing `NOTE:` at
  that site prescribed, and no other forward raises `BUSY`. Accepted as intended.
- **`hasChanges` gating** of the pre-flight: the flag is only ever set to `true` and never
  cleared, so a false value means the staging area was never written and has nothing to collapse.

### Empty categories

No security, resource-cleanup, or cross-platform findings. The change adds no I/O, no timers, no
new async resources, and no platform-specific calls — it is in-memory data-structure work behind
existing interfaces.
