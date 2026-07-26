---
description: Creating a view or materialized view containing a broken half-character used to look like it worked but was silently lost on reopen; now the statement fails immediately instead.
files:
  - packages/quereus/src/vtab/module.ts                            # new optional hook + CatalogObjectKind
  - packages/quereus/src/schema/catalog-persistability.ts          # NEW — engine-side driver
  - packages/quereus/src/runtime/emit/create-view.ts               # call site
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # call site (inside materializeView's rollback try)
  - packages/quereus/src/schema/manager.ts                         # call sites: updateViewTags / updateMaterializedViewTags
  - packages/quereus/src/index.ts                                  # re-export CatalogObjectKind
  - packages/quereus-store/src/common/store-module.ts              # hook impl + shared {key, ddl} helpers
  - packages/quereus-isolation/src/isolation-module.ts             # forward to underlying
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts        # 9 rejection/acceptance cases
  - packages/quereus-store/test/view-mv-persistence.spec.ts        # close→reopen: rejected create leaves empty catalog
  - docs/schema.md, docs/store.md, docs/module-authoring.md, packages/quereus-isolation/README.md
difficulty: medium
---

## What was wrong

A **lone surrogate** is a broken half of a Unicode character — a JS string can hold one
(`'\uD800'`) and Quereus accepts it as a `text` value, but no UTF-8 byte sequence encodes
it. `TextEncoder` folds every one of them to the replacement character U+FFFD, so the
persistent store cannot faithfully write text containing one.

For tables the store already **refused** such text up front. For **views** and
**materialized views** it did not, and could not: those objects are persisted
fire-and-forget, off a schema-change event. `SchemaChangeNotifier.notifyChange` wraps each
listener in try/catch and only logs; `StoreModule.enqueuePersist` chains the write onto an
async queue behind its own `.catch`. So the encode failure had nowhere to surface. The
result: `create view "<lone surrogate>" as select …` reported success, answered queries for
the rest of the session, wrote nothing to the catalog, and was simply gone after reopen —
visible only as a `console.warn`.

## What changed

A new **pre-flight veto hook**, `VirtualTableModule.assertCatalogObjectPersistable?(db,
kind, object)`, modelled on the existing `notifyLensDeployment` hook (optional method,
looped over `db.schemaManager.allModules()`, throws propagate). It is synchronous, pure (no
IO), and asked **before** the object is registered, so a refusal leaves the statement a
clean no-op. This is the only synchronous point on the whole persistence path — hence a
veto rather than tightening either swallow layer (tightening them would let an unrelated
listener failure abort user DDL).

Engine driver: `packages/quereus/src/schema/catalog-persistability.ts` (exported from the
package index only as the `CatalogObjectKind` type — the driver itself has no consumer
outside `packages/quereus`).

Call sites:
- `emitCreateView` — before `schema.addView`.
- `materializeView` — **inside** the existing `registerMaterializedView` try, before the
  register call. It must be here, not in the create emitter: the MV's persisted DDL
  (`generateMaintainedTableDDL`) does not exist until the derivation is attached. The
  existing `catch` already unlinks covered UNIQUE constraints and drops the half-built
  backing, so a rejection rolls back with zero new teardown code.
- `SchemaManager.updateViewTags` / `updateMaterializedViewTags` — before the schema swap
  (tag keys and values ride the persisted DDL text).

`StoreModule` implements the hook by running exactly the derivation its write path runs —
two file-local helpers `viewCatalogEntry(view)` / `maintainedViewCatalogEntry(table)`
returning `{ key, ddl }`, plus `assertPersistableDdlText(ddl)` split out of
`encodeCatalogDDL`. `saveViewDDL` / `saveMaterializedViewDDL` build from the same helpers,
so veto and write cannot drift.

`IsolationModule` forwards the hook to `underlying` — `allModules()` yields the *registered*
wrapper, so without the forward an isolation-wrapped store keeps the bug.

## Behavior verified

| statement (store module subscribed) | before | after |
|---|---|---|
| `create view "<lone>" as select …` | silent success, gone on reopen | **raises**, view not registered |
| `create view v as select '<lone>' as tag from t` (clean name, bad BODY literal) | silent success | **raises**, `v` not registered |
| `create materialized view "<lone>" as select …` (memory backing) | silent success | **raises**, no backing table left |
| `create materialized view "<lone>" using store as select …` | raised | still raises (unchanged) |
| `alter view v set tags ("<lone>" = 1)` / `(k = '<lone>')` | silent success | **raises**, view survives, tags unchanged |
| `alter materialized view mv set tags ("<lone>" = 1)` | silent success | **raises**, MV survives, tags unchanged |
| same, through an **isolation-wrapped** store | silent success | **raises** (wrapper forwards the hook) |
| astral (well-formed) names / literals | worked | works |
| any of the above on a DB with **no** store module | worked | works (deliberate memory-vs-store divergence) |

Error message matches `/unpaired surrogate/i` and is never a spurious UNIQUE violation.

## Review findings

### Validation run (review stage, after the review's own edits)

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — all workspaces pass.
- `yarn test:store` — **7323 passing, 19 pending** (~3 min), matching the implement stage.
- Nothing pre-existing surfaced; `tickets/.pre-existing-error.md` not written.

### Major — new ticket filed

**A rename into a lone-surrogate name still silently destroys a dependent view or MV.**
`tickets/fix/bug-store-rename-into-lone-surrogate-drops-dependent-view-or-mv.md`.

The implement handoff declared rename propagation out of scope on the reasoning that "a
propagated body rewrite cannot introduce a surrogate that was not already there." That is
false — a rename is precisely how new text enters a body. Three reproductions were run
against the implement commit; in every one the statement **succeeded** and the object was
lost, with only a `console.warn`:

- `alter table <memory-backed MV> rename to "<lone>"` — the worst case: the old catalog
  entry is deleted (`materialized_view_removed`) before the new one fails to write, so the
  MV is destroyed outright rather than left stale.
- `alter table <memory table> rename column x to "<lone>"` with a persisted view over it —
  the propagated body rewrite carries the new name into the view's DDL, which then cannot
  be encoded.
- `alter table <memory table> rename to "<lone>"` with a persisted view over it — same.

Store-**backed** tables are incidentally protected because the physical store-name guard
refuses the rename first; memory tables and memory-backed MVs are not. The fix is not a
one-liner — the rename flow mutates (physical storage, then the table catalog entry) before
it propagates to dependents, so a veto discovered during propagation is already too late to
be a clean no-op. It needs a pre-flight pass over the would-be-rewritten dependents, which
is design work, hence a ticket rather than an inline fix. Recorded in `docs/schema.md`,
`docs/store.md`, and the hook's own docstring so nobody re-derives the false "renames are
safe" reasoning.

### Minor — fixed in this pass

- **Broken doc reference.** The hook docstring in `packages/quereus/src/vtab/module.ts`
  pointed at "`docs/store.md` § View / materialized-view catalog persistence" — a section
  that does not exist in that file. Repointed to `docs/schema.md` § View and
  materialized-view persistence, where the content actually lives.
- **`docs/store.md` never learned about the veto.** Its unpaired-surrogate section
  enumerates every guard the store applies (`encodeText`, the key builders, the physical
  store-name builders) and stopped at tables. Added the view/MV veto to that enumeration,
  including why the identifier guard alone is insufficient there (the throw lands inside the
  persist queue) and what the veto does not cover.
- **No test covered the `IsolationModule` forward** — flagged by the implementer as a
  reasonable review-stage fix, and it was. Added a case to `lone-surrogate-keys.spec.ts`
  that registers `createIsolatedStoreModule` and asserts both the bad-name and bad-body
  view creates are refused. It fails without the forward.
- **Two vacuous tag assertions.** The SET TAGS tests asserted only
  `getView('main','v')?.tags === undefined`, which passes just as happily if the veto had
  taken the whole view with it. Both now assert the object survives the refusal first.

### Checked and found clean

- **Every other write path into a view/MV catalog entry.** Enumerated the store's
  `dispatchSchemaChange` arms and traced each event's producers. `view_added` /
  `view_modified` come from `emitCreateView`, `updateViewTags`, and the two rename
  propagation loops in `alter-table.ts`; `materialized_view_added` / `_modified` from
  `materializeView`, `updateMaterializedViewTags`, `applyMaterializedViewRewrite`, and the
  MV-rename block. All but the rename paths are now vetoed — the rename ones are the ticket
  above.
- **`alter view … rename`.** Does not exist; `AlterViewStmt` carries only a tags action, so
  there is no unguarded view-rename path.
- **Internal (non-DDL) view registration.** `lens-compiler.ts` and `SchemaManager.importView`
  call `schema.addView` directly and fire no event, so they are correctly not vetoed —
  nothing persists them.
- **`adoptMaterializedView` skipping the check** (implementer's flagged gap). Correct as
  argued: adopt is reached only from catalog import, where the DDL was read back from the
  catalog and is persistable by construction.
- **Rollback completeness on the MV path.** The veto sits inside `materializeView`'s
  existing catch arm; the "no backing table may survive" assertion in the new test confirms
  the half-built backing is dropped, with no teardown code added.
- **DRY / structure.** The shared `{key, ddl}` helpers are the right shape — veto and write
  provably run the same derivation. The new engine file is 33 lines, one exported function,
  no state. No duplication introduced.
- **Docs the change should have touched.** `docs/schema.md`, `docs/module-authoring.md`
  (both signaling tables), `packages/quereus-isolation/README.md`, and — after this pass —
  `docs/store.md`. Read each against the code; all now describe the shipped behavior.

### Noted, deliberately not actioned

- **The `subscribedDb !== db` gate** (implementer's headline caveat). A store module that
  has never been handed a `db` writes nothing, so vetoing there would refuse a definition
  that loses nothing. The residual hole — a brand-new database whose very first DDL is a
  `create view` — is the pre-existing
  `bug-store-untouched-table-and-early-view-never-persisted`, already tracked and already
  documented. The test suite's `create table … using store` in `beforeEach` is honest
  coverage, not an accommodation: any real store-backed session has a store table.
- **`IsolationModule` declares the hook unconditionally**, unlike the `getBackingHost`
  precedent which is assigned only when the underlying implements it. So a wrapped module
  lacking the hook still advertises it. Harmless today — every call site invokes through
  `?.` and nothing branches on presence — and making it conditional would add constructor
  machinery for no current consumer. Left as is.
- **Two `as` casts in `StoreModule.assertCatalogObjectPersistable`** (`object as ViewSchema`
  / `as TableSchema`). The `kind`/`object` pair is a correlated union TypeScript cannot
  narrow without overloads on the interface; the casts are immediately validated by
  `maintainedViewCatalogEntry`'s `isMaintainedTable` guard on the MV arm. Not worth
  restructuring the public hook signature for.
- **`store-module.ts` is ~3900 lines** and this change added ~100 more. Pre-existing size
  problem, unrelated to this ticket, not worth splitting under it.

### Tripwires

- One, parked by the implementer and left in place: a `NOTE:` at
  `packages/quereus-store/src/common/store-module.ts` on `assertCatalogObjectPersistable` —
  the object's DDL text is now rendered twice per view/MV DDL statement, once for the veto
  and once for the persist. Correct call: DDL is rare and the text is small. If a
  schema-heavy `apply schema` deploying many views ever shows up hot there, thread the
  veto's already-built `CatalogEntry` through to the write.
- No new tripwires were added by this review.
