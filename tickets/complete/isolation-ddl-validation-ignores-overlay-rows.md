---
description: Adding a UNIQUE constraint or index mid-transaction now sees the rows that transaction has written but not yet committed, so duplicates are rejected instead of slipping through — and a rejected change no longer throws away a row.
files:
  - packages/quereus/src/vtab/module.ts                         # NEW: EffectiveRowSource; createIndex/alterTable gained an optional rows param
  - packages/quereus/src/vtab/table.ts                          # VirtualTable.createIndex gained the same param
  - packages/quereus/src/index.ts                               # exports EffectiveRowSource, serializeKeyNullGrouping
  - packages/quereus/src/vtab/memory/layer/base.ts              # populateIndexFromRowsAsync + shared addRowToIndex
  - packages/quereus/src/vtab/memory/layer/manager.ts           # validateUniqueOverEffectiveRows now async + rowSource-aware; 3 call sites
  - packages/quereus/src/vtab/memory/table.ts                   # MemoryTable.createIndex forwards rows
  - packages/quereus/src/vtab/memory/module.ts                  # module-level createIndex/alterTable forward rows
  - packages/quereus-store/src/common/store-module.ts           # createIndex validates up front; buildIndexEntries skip flag
  - packages/quereus-isolation/src/overlay-rows.ts              # NEW: collectOverlayEntries, makePkKeySerializer, iterateEffectiveRows
  - packages/quereus-isolation/src/flush.ts                     # now reuses collectOverlayEntries
  - packages/quereus-isolation/src/isolation-module.ts          # effectiveRowsFor/issuerEffectiveRows; createIndex rebuild; adoptRebuiltOverlay
  - packages/quereus-isolation/src/isolated-table.ts            # instance createIndex/dropIndex now delegate to the module
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic   # acceptance test, now runs in store mode
  - packages/quereus/test/logic.spec.ts                         # 10.1.2 removed from MEMORY_ONLY_FILES
  - packages/quereus-store/test/isolated-store.spec.ts          # 3 new tests
  - packages/quereus-isolation/test/isolation-layer.spec.ts     # 1 new test
  - docs/module-authoring.md                                    # § "When the pending rows live outside your module"
  - docs/memory-table.md                                        # § DDL and transactions — wrapper-supplied rows
  - docs/design-isolation-layer.md                              # § 6 DDL — createIndex rebuild + third poison source (added in review)
difficulty: hard
---

# Row-validating DDL under the isolation layer sees the issuing transaction's own rows

## What was wrong

The isolation layer gives each connection a private staging area (an "overlay") holding the rows
it has written but not yet committed. When that connection ran `create unique index` or
`alter table … add constraint … unique`, the duplicate check ran inside the *underlying* storage
module, which can only see committed rows. Three defects fell out:

*   **A — wrong row set.** A duplicate the transaction had just inserted was invisible, so the
    constraint was created over data that violates it. Symmetrically, a duplicate the transaction
    had already deleted was still visible, so a legal index build was rejected.
*   **B — the new constraint was not enforced afterwards.** The overlay was built from the
    pre-index schema, so a second colliding insert later in the same transaction was accepted.
*   **C — silent row loss.** `MemoryTable.update` *returns* `{status: 'constraint'}` rather than
    throwing. The overlay-rebuild loops ignored that return, so a row the new schema rejected was
    dropped and the transaction committed without it.

## What was built

**`EffectiveRowSource`** — an optional `() => AsyncIterable<Row>` parameter on
`VirtualTableModule.createIndex` / `.alterTable` and on `VirtualTable.createIndex`. Supplied only
by a wrapper module that holds the issuing connection's pending rows outside the target module.
When present the target module judges *that* stream for every row-content decision, and must not
reject the DDL over a duplicate that exists only in its own committed data. Physical structures
are still built from the module's own rows — an index entry with no live row behind it is
harmless, since every reader resolves an entry back to its live row. The engine's own emitters
pass nothing, so unwrapped modules are unchanged. Contract in `docs/module-authoring.md`.

Both bundled backends honor it. Memory: `validateUniqueOverEffectiveRows` became async and
prefers the supplied rows over `effectiveDdlRows()`, at all three call sites. Store:
`createIndex`'s duplicate check was hoisted out of `buildIndexEntries` and runs before
`getIndexStore`, so a rejection leaves no index-store directory behind.

The isolation layer supplies the stream (`overlay-rows.ts`, whose `collectOverlayEntries` also
replaced a duplicate copy in `flush.ts`) and rebuilds every non-poisoned overlay under the
post-index schema — which is what fixes B. Defect C is closed by `insertIntoRebuiltOverlay`,
which turns the returned `constraint` status into a throw; `adoptRebuiltOverlay` routes it to
`INTERNAL` for the issuing connection and to overlay poison for a foreign one. A failed rebuild
leaves the old overlay installed whole, never with a row missing.

## Review findings

Read the implement diff (`118b582c`) before the handoff summary. Checked the `EffectiveRowSource`
contract against both bundled backends, the isolation layer's two overlay-rebuild paths, the
tombstone row shape, resource cleanup, error routing, docs currency, lint, and both test suites.
Ran targeted white-box probes against the isolated store module for cases no in-tree test covers.

### Major — filed as tickets

*   **The issuer-side "Defect C" guard is reachable, and the ticket's own claim that it is
    "unreachable by construction" is wrong.** The handoff invited exactly this probe. Repro:

    ```sql
    create table t (a integer, b integer, primary key (a, b));
    insert into t values (1, 1);
    insert into t values (1, 2);
    begin;
      delete from t;                       -- two tombstones, both a = 1
      create unique index t_a_ux on t (a); -- StatusCode.INTERNAL out of the overlay rebuild
    ```

    The DDL's validation pass correctly saw an empty effective row set and accepted the index.
    The *migration* disagreed, because the rebuilt overlay enforces the new UNIQUE index over
    **tombstone rows**. A tombstone carries its row's primary key and NULL elsewhere, so a UNIQUE
    index whose columns all sit inside the PK sees two deleted rows as a duplicate.

    Root cause is **pre-existing and independent of this ticket**: `createOverlaySchema` has
    always copied the underlying's `UNIQUE` indexes onto the overlay verbatim. Confirmed with a
    second repro that touches nothing this ticket changed — index created *before* the
    transaction, no rebuild involved:

    ```sql
    create table t (a integer, b integer, primary key (a, b));
    create unique index t_a_ux on t (a);
    insert into t values (1, 1);
    begin;
      delete from t where a = 1 and b = 1;
      insert into t values (1, 2);   -- rejected: UNIQUE constraint failed
    ```

    Ordinary non-PK unique indexes escape only because a tombstone's value there is NULL and SQL
    NULLs are distinct. Filed `tickets/fix/overlay-unique-index-enforces-tombstones` with both
    repros and the suggested lever (make the overlay's copy of each index partial on the
    tombstone flag). A `KNOWN DEFECT:` comment now sits on `createOverlaySchema` pointing at it.
    Not fixed inline: the fix touches every overlay's schema and the merged secondary-index scan
    path, which is more than a review pass should carry.

*   **Overlay tables are created and never destroyed.** `IsolationModule` builds each overlay
    through `overlayModule.create()`, which registers a `MemoryTableManager` in the module's
    `tables` map; only `destroy()` removes one, and the layer never calls it —
    `clearConnectionOverlay` merely drops the layer's own reference. One dead in-memory table
    accumulates per writing transaction, for the life of the `Database`, plus one per overlay
    rebuild. Pre-existing, but this ticket's `createIndex` rebuild makes it fire more often.
    Filed `tickets/backlog/bug-isolation-overlay-tables-never-released`.

### Minor — fixed in this pass

*   **`docs/design-isolation-layer.md` § 6 was stale.** It stated that `dropIndex` is the only
    index DDL that rebuilds overlays and that exactly two DDLs poison (`alterTable`, `destroy`).
    `createIndex` now does both. Updated the migration bullet, added a bullet for row-validating
    DDL and `EffectiveRowSource`, corrected the poison-source count to three, documented the
    "discard the half-built replacement, keep the old overlay whole" guarantee and the
    issuer-`INTERNAL` / foreign-poison split, and fixed the poison-lifecycle paragraph's
    enumeration of the rebuild paths that skip a poisoned overlay.
*   **`overlay-rows.ts` exported `resolveTombstoneIndex`, which no other module uses.** Made it
    module-private.

### Checked and found sound

*   **`makePkKeySerializer` using `serializeKeyNullGrouping` rather than `serializeRowKey`.** The
    handoff asked for a second opinion. Null-grouping is the right choice and the alternative is
    strictly worse: `serializeRowKey` returns `null` for *any* NULL in the key, so under a
    degenerate nullable PK every such row would collapse to one bucket and the effective-row walk
    would silently shadow all of them. Null-grouping keeps the per-column distinction.
*   **Memory builds its physical index with `enforceUnique = false`** (`addIndexToBase`), so the
    committed-rows build cannot re-reject a duplicate the transaction deleted. Store's
    `buildIndexEntries` gets the same effect via `skipDuplicateCheck`. Both match the documented
    contract.
*   **`assertIndexPresent`.** Guards against a third-party underlying that refreshes only its
    module-level schema, which would rebuild overlays under the pre-index schema and silently
    re-open Defect B. Correct to assert rather than assume. Both bundled backends refresh
    (`MemoryTable.createIndex`, `StoreTable.updateSchema`) — verified under `test:store`, where
    the store has no instance-level `createIndex` and the module-level path is what runs.
*   **`IsolatedTable.createIndex` / `.dropIndex` rerouted through `IsolationModule`.** Confirmed
    dead in-tree: `SchemaManager.createIndex` reaches `vtabModule.createIndex`, never the
    instance hook. Rerouting is the right call — the old bodies drove the underlying and overlay
    directly, skipping both the row source and the rebuild. Keeping them costs nothing and puts a
    hypothetical outer wrapper on the same protocol.
*   **Only the issuing connection's overlay feeds validation.** Verified this matches the
    documented semantics: a foreign connection's staged duplicates are its problem at commit,
    exactly as a concurrent duplicate insert would be, and its overlay is poisoned rather than
    truncated. The one test that reaches the guard asserts poison, both rows retained, and a
    failing commit.
*   **`alterTable`'s foreign loop.** A `validateOverlayMigration` CONSTRAINT still poisons and
    `continue`s; a rebuild CONSTRAINT now poisons too; `INTERNAL` still rethrows for everyone. An
    already-poisoned overlay is skipped before the split and keeps its original message.
*   **Test coverage.** `10.1.2-ddl-in-transaction.sqllogic` now runs against both backends and
    covers pending-duplicate rejection, committed-vs-pending collision, post-DDL enforcement via
    both `create unique index` and `add constraint`, the pending-delete-unblocks-the-build case,
    and multiple-NULLs-are-distinct. The four white-box tests cover what sqllogic cannot see: a
    rejected DDL leaving both staged rows readable, an accepted one preserving live rows and
    tombstones, and the foreign-overlay poison. Probes for delete-then-reinsert and
    non-PK-column uniqueness pass; the PK-subset cases fail and are in the filed ticket.

### Tripwires

None new. The implement stage's tripwire stands: `effectiveRowsFor` re-materializes the overlay
and re-scans the underlying on every call, and `alter column … set collate` calls once per
covering UNIQUE constraint. The `NOTE:` at the site says to share one PK map across the calls if
it ever shows up as slow. Verified the `NOTE:` is there and accurate.

### Left as-is, with reason

*   **`ALTER COLUMN … SET COLLATE` on a PRIMARY KEY member** remains holed — explicitly out of
    scope in the source ticket, `NOTE:` comments at both re-key sites, gap stated in
    `docs/module-authoring.md`. With Defect C closed, a case that previously lost a row silently
    now raises `INTERNAL`: louder, still not correct.
*   **`tickets/backlog/bug-set-not-null-ignores-uncommitted-rows`**, filed by the implement stage
    for `alter column … set not null` ignoring pending rows on both backends. Same shape as
    Defect A; the machinery to fix it is now in place. Left in backlog.

## Validation performed

*   `yarn build` — clean.
*   `yarn lint` — clean (also type-checks `packages/quereus` test files).
*   `yarn test` — 6802 + 901 + 450 + 191 + … passing, **0 failing**.
*   `yarn workspace @quereus/quereus test:store` — **6797 passing, 0 failing**, 14 pre-existing
    pending. Confirms `10.1.2-ddl-in-transaction.sqllogic` executes under the real LevelDB store
    behind the isolation layer.
