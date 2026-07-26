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
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts        # 8 new rejection/acceptance cases
  - packages/quereus-store/test/view-mv-persistence.spec.ts        # close→reopen: rejected create leaves empty catalog
  - docs/schema.md, docs/module-authoring.md, packages/quereus-isolation/README.md
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
two new file-local helpers `viewCatalogEntry(view)` / `maintainedViewCatalogEntry(table)`
returning `{ key, ddl }`, plus `assertPersistableDdlText(ddl)` split out of
`encodeCatalogDDL`. `saveViewDDL` / `saveMaterializedViewDDL` now build from the same
helpers, so veto and write cannot drift.

`IsolationModule` forwards the hook to `underlying` — `allModules()` yields the *registered*
wrapper, so without the forward an isolation-wrapped store keeps the bug.

## Behavior to verify

| statement (store module subscribed) | before | after |
|---|---|---|
| `create view "<lone>" as select …` | silent success, gone on reopen | **raises**, view not registered |
| `create view v as select '<lone>' as tag from t` (clean name, bad BODY literal) | silent success | **raises**, `v` not registered |
| `create materialized view "<lone>" as select …` (memory backing) | silent success | **raises**, no backing table left |
| `create materialized view "<lone>" using store as select …` | raised | still raises (unchanged) |
| `alter view v set tags ("<lone>" = 1)` / `(k = '<lone>')` | silent success | **raises**, tags unchanged |
| `alter materialized view mv set tags ("<lone>" = 1)` | silent success | **raises**, tags unchanged |
| astral (well-formed) names / literals | worked | works |
| any of the above on a DB with **no** store module | worked | works (deliberate memory-vs-store divergence) |

Error message must match `/unpaired surrogate/i` and must never be a spurious UNIQUE
violation.

## Validation run

- `yarn build` — clean.
- `yarn test` — all workspaces pass (no new failures; nothing pre-existing surfaced).
- `yarn typecheck` — clean.
- `yarn lint` — clean.
- `yarn test:store` — **7323 passing, 19 pending** (~3 min). Worth re-running: this ticket
  is entirely store-path and the change sits on the CREATE VIEW / CREATE MATERIALIZED VIEW
  paths that logic tests exercise heavily.

New tests: 8 cases in `lone-surrogate-keys.spec.ts` (new block *"a view or materialized view
the store could not persist"*), 1 close→reopen case in `view-mv-persistence.spec.ts` pinning
that a rejected create leaves an **empty** catalog — specifically no entry folded onto the
U+FFFD replacement character, which would collide with every other lone surrogate.

## Known gaps / things a reviewer should push on

- **The `subscribedDb !== db` gate is the honesty boundary, and it is a real behavioral
  seam.** `StoreModule` only vetoes while subscribed to that `Database`'s change notifier,
  which happens lazily on its first `create`/`connect`/`alterTable`/`rehydrateCatalog`. A
  brand-new database whose **very first** DDL is `create view` therefore still accepts an
  unpersistable view and still silently drops it. That is the pre-existing gap tracked by
  `bug-store-untouched-table-and-early-view-never-persisted` (documented in
  `docs/schema.md` § View and materialized-view persistence, and in the hook's docstring),
  not something this ticket closes. Deliberate: vetoing when unsubscribed would reject a
  definition that loses nothing. The test suite makes the subscription explicit with a
  `create table … using store` in `beforeEach` — worth judging whether that is honest
  coverage or an accommodation.
- **Rename propagation is deliberately out of scope** (`runtime/emit/alter-table.ts` ~1768 /
  ~1900 fire `view_modified` from a body rewrite). Rationale: a rename *into* a
  lone-surrogate name is already refused by the store-name guard, and a propagated body
  rewrite cannot introduce a surrogate that was not already there. Unverified by test.
- **`adoptMaterializedView` does not run the check**, only `materializeView` does. Reasoning:
  adopt is reached only from catalog import, where the DDL was read back from the catalog and
  so is persistable by construction. `materializeView` *is* also on the import path and does
  run the check there — harmless for the same reason, and it keeps one call site.
- **`getBackingHost`-style "conditional presence" was not used.** `StoreModule` always
  declares the method and no-ops internally via the `subscribedDb` gate, rather than
  assigning it conditionally. `IsolationModule` forwards unconditionally with `?.`, so a
  wrapped module lacking the hook is fine — but the wrapper *does* advertise the method even
  when the underlying lacks it, unlike the `getBackingHost` precedent. Judge whether that
  asymmetry matters (nothing today branches on presence of this hook).
- **Only one failure mode is implemented**: unpaired surrogates. The hook is deliberately
  general ("could you persist this?"), so a reviewer should sanity-check that the contract
  wording does not over-promise relative to what any module actually checks.
- **Tripwire parked** (`NOTE:` at `packages/quereus-store/src/common/store-module.ts`, on
  `assertCatalogObjectPersistable`): the DDL text is now generated twice per view/MV DDL
  statement — once for the veto, once for the persist. Not worth caching today; if a
  schema-heavy `apply schema` ever shows up hot there, thread the veto's already-built
  `CatalogEntry` through to the write.
- **No test covers the isolation forward.** The `IsolationModule` delegate is written and
  documented but exercised only indirectly (`yarn test` / `yarn test:store` pass); no test
  asserts that an isolation-wrapped store rejects a lone-surrogate view. Adding one would be
  a reasonable review-stage fix.

## Review findings

_(to be filled in by the review stage)_
