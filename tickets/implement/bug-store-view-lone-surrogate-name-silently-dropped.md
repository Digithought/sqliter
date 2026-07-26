---
description: Creating a view or materialized view whose name (or body text) contains a broken half-character looks like it succeeded, but the definition is silently lost when the database is reopened — make the statement fail up front instead.
files:
  - packages/quereus/src/vtab/module.ts                          # add the optional module hook
  - packages/quereus/src/runtime/emit/create-view.ts             # call site: CREATE VIEW, before schema.addView
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # call site: materializeView, inside the existing rollback try
  - packages/quereus/src/schema/manager.ts                       # call sites: updateViewTags / updateMaterializedViewTags (~1069 / ~1139)
  - packages/quereus/src/schema/ddl-generator.ts                  # generateViewDDL / generateMaintainedTableDDL (used by the store's check)
  - packages/quereus-store/src/common/store-module.ts             # implement the hook; DRY it with saveViewDDL / saveMaterializedViewDDL / encodeCatalogDDL
  - packages/quereus-store/src/common/key-builder.ts              # buildViewCatalogKey / buildMaterializedViewCatalogKey (guard already lives here)
  - packages/quereus-isolation/src/isolation-module.ts            # forward the new hook to `underlying` (~line 767 pattern)
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts       # extend: view / MV rejection cases
  - packages/quereus-store/test/view-mv-persistence.spec.ts       # reference for the close→reopen harness
difficulty: medium
---

## Background

A **lone surrogate** is a broken half of a Unicode character — a JS string may hold one
(`'\uD800'`), it is a legal Quereus `text` value, but no UTF-8 byte sequence encodes it.
`TextEncoder` folds every one of them to the same replacement bytes (U+FFFD), so two
identifiers differing only in a lone surrogate collapse onto one storage key.

Earlier tickets (`bug-store-catalog-key-lone-surrogate-identifier-collision`,
`bug-store-physical-store-name-lone-surrogate-collision`) made the store **refuse** such an
identifier rather than silently merge. The guard is `assertNoUnpairedSurrogate`
(`packages/quereus-store/src/common/encoding.ts`), wired into:

- the physical store-name builders (`buildDataStoreName` / `buildIndexStoreName`),
- every catalog-key builder (`buildCatalogKey` / `buildViewCatalogKey` /
  `buildMaterializedViewCatalogKey`),
- the persisted-DDL-text encoder (`StoreModule.encodeCatalogDDL`), which guards the FULL
  text — so a lone surrogate in a column name or a string literal is caught too, even when
  the object's own name is clean.

## Reproduced behavior (measured, this ticket)

Against a persistent in-memory provider (`create table … using store` first, so the module
is subscribed), then close → reopen:

| statement | today |
|---|---|
| `create view "<lone>" as select …` | **succeeds**, queryable in-session, catalog entry never written, gone after reopen. Only a `console.warn`. |
| `create view v as select '<lone>' as tag from t` (clean name, lone surrogate in the BODY) | **succeeds**, same silent loss — the DDL-text guard fires and is swallowed. |
| `create materialized view "<lone>" as select …` (default memory backing) | **succeeds**, same silent loss. |
| `create materialized view "<lone>" using store as select …` | already **fails** loudly — `StoreModule.create` → `buildDataStoreName` throws before any side effect. |

The swallow is two layers deep and both are by design:

1. `SchemaChangeNotifier.notifyChange` (`packages/quereus/src/schema/change-events.ts:175`)
   wraps every listener in `try/catch` and only logs.
2. `StoreModule.enqueuePersist` (`store-module.ts:3882`) chains the async save onto
   `persistQueue` with `.catch(err => console.warn(...))`.

So **no** change confined to the store's listener can surface the error — a synchronous
throw from `dispatchSchemaChange` would still be eaten by layer 1. The fix has to run at
statement-execution time, on a path whose throw propagates.

Note the BODY-literal row above: it rules out "just reject lone surrogates in identifiers
engine-wide" as a complete fix. A string literal in a view body is a *value*, and values
carrying lone surrogates are deliberately accepted by the engine and by memory tables (see
the header comment of `packages/quereus-store/test/lone-surrogate-keys.spec.ts`). Only the
module that would have to persist the generated DDL can judge it.

## Design

Add an optional **pre-flight veto hook** on `VirtualTableModule`, consulted over every
registered module before the catalog object is registered. Modelled directly on the existing
`notifyLensDeployment` hook (`packages/quereus/src/vtab/module.ts:531`, driven by
`notifyLensDeploymentAll` in `runtime/emit/schema-declarative.ts:495`), which already
establishes the "loop `db.schemaManager.allModules()`, optional method, throws propagate"
shape.

```ts
// packages/quereus/src/vtab/module.ts — on VirtualTableModule
/**
 * Optional pre-flight: throw when this module would be UNABLE to durably persist
 * the catalog entry for `object`. Consulted over every registered module by the
 * CREATE VIEW / CREATE MATERIALIZED VIEW / ALTER … SET TAGS paths BEFORE the object
 * is registered (or, for an MV, inside materializeView's existing rollback arm), so
 * a rejection leaves the statement a clean no-op.
 *
 * Views and materialized views are not owned by any one module the way a table is, so
 * every module gets the veto; a module that would not persist the object must no-op.
 * Synchronous by contract: the check must be a pure function of the schema (no IO).
 * Omit ⇒ never consulted (today's behavior).
 */
assertCatalogObjectPersistable?(
	db: Database,
	kind: 'view' | 'materializedView',
	object: ViewSchema | TableSchema,
): void;
```

Engine-side driver (a small exported helper — put it next to the hook's other call sites,
e.g. `packages/quereus/src/schema/catalog-persistability.ts`, so both
`runtime/emit/*` and `schema/manager.ts` can reach it):

```ts
export function assertCatalogObjectPersistable(
	db: Database, kind: 'view' | 'materializedView', object: ViewSchema | TableSchema,
): void {
	for (const { module } of db.schemaManager.allModules()) {
		module.assertCatalogObjectPersistable?.(db, kind, object);
	}
}
```

### Call sites

- **`emitCreateView`** (`runtime/emit/create-view.ts`) — after the `viewSchema` literal is
  built, **before** `schema.addView(viewSchema)`. Nothing has happened yet, so a throw is a
  clean no-op.
- **`materializeView`** (`runtime/emit/materialized-view-helpers.ts`, the `db.registerMaterializedView`
  try-block around line 540) — call it immediately before `db.registerMaterializedView(maintained)`,
  **inside** that existing `try`. Its `catch` already does the full rollback
  (`unlinkCoveredUniqueConstraints` + `sm.dropTable(..., ifExists: true)`), so a rejection
  drops the half-built backing and the statement is a no-op with **no new teardown code**.
  This is why the check goes here and not in `emitCreateMaterializedView`: the exact DDL text
  (`generateMaintainedTableDDL`) only exists once the derivation is attached.
  `materializeView` is shared with the catalog-**import** path; running the check there is
  harmless (an entry read back from the catalog re-generates persistable DDL by construction)
  and keeps one call site.
- **`SchemaManager.updateViewTags`** (~manager.ts:1069) and
  **`updateMaterializedViewTags`** (~manager.ts:1139) — validate the `updated` object before
  `schema.addView(updated)` / `schema.addTable(updated)`. Same silent-drop applies to
  `alter view … set tags ('<lone>' = 1)`. `SchemaManager` holds `private db` (manager.ts:195),
  so the driver is reachable.

Deliberately **out of scope**: the `view_modified` fired by rename-propagation
(`runtime/emit/alter-table.ts:1768` / `:1900`). A rename into a lone-surrogate name is
already refused by the store-name guard, and a propagated body rewrite cannot introduce a
surrogate that was not already there.

### Store-side implementation

In `StoreModule`, factor the *(catalog key, DDL text)* derivation out of `saveViewDDL` /
`saveMaterializedViewDDL` into two small private helpers, and split the assert out of
`encodeCatalogDDL`, so the veto and the actual write are provably the same check:

```ts
assertCatalogObjectPersistable(db: Database, kind, object): void {
	// Only veto what we would actually persist: this module persists a view/MV only
	// while subscribed to that Database's change notifier (ensureSchemaSubscription).
	if (this.subscribedDb !== db) return;
	const entry = kind === 'view'
		? viewCatalogEntry(object as ViewSchema)               // throws on a bad key
		: maintainedViewCatalogEntry(object as TableSchema);   // undefined if not maintained
	if (entry) assertPersistableDdlText(entry.ddl);            // throws on bad DDL text
}
```

- `viewCatalogEntry(view)` → `{ key: buildViewCatalogKey(view.schemaName, view.name), ddl: generateViewDDL(view) }`
- `maintainedViewCatalogEntry(mv)` → `undefined` unless `isMaintainedTable(mv)`, else
  `{ key: buildMaterializedViewCatalogKey(…), ddl: generateMaintainedTableDDL(mv) }`
- `assertPersistableDdlText(ddl)` → `assertNoUnpairedSurrogate(ddl, 'persisted schema text')`;
  `encodeCatalogDDL` calls it and then encodes.

`saveViewDDL` / `saveMaterializedViewDDL` then build their `{key, ddl}` from the same
helpers. The `subscribedDb !== db` gate keeps the veto honest — a `StoreModule` registered
but never handed a `db` persists nothing, so vetoing there would reject a view that loses
nothing. Document that gate; it becomes removable if
`bug-store-untouched-table-and-early-view-never-persisted` lands and makes persistence
unconditional.

### Isolation wrapper

`IsolationModule` wraps `StoreModule`, and `allModules()` yields the **registered** wrapper.
Add the same forward the existing hooks use (`packages/quereus-isolation/src/isolation-module.ts:767`):

```ts
assertCatalogObjectPersistable(db, kind, object): void {
	this.underlying.assertCatalogObjectPersistable?.(db, kind, object);
}
```

Without it an isolation-wrapped store keeps the silent-drop bug.

## Expected behavior after the fix

- `create view "<lone>" as select 1` → raises, message names the unpaired surrogate, the view
  is NOT registered in-session.
- `create view v as select '<lone>' as tag from t` → raises, `v` not registered.
- `create materialized view "<lone>" as select …` (memory backing) → raises, no half-built
  backing table left behind.
- `create materialized view "<lone>" using store as select …` → keeps raising as today.
- `alter view v set tags ('<lone>' = 1)` → raises, tags unchanged.
- Every well-formed / astral case keeps working unchanged, and a `Database` with **no** store
  module registered keeps accepting all of the above (the memory-vs-store divergence stays
  deliberate).

## TODO

- Add `assertCatalogObjectPersistable?` to `VirtualTableModule` in
  `packages/quereus/src/vtab/module.ts`, documented as above (sync, pure, veto-before-register).
- Add the engine driver that loops `db.schemaManager.allModules()`; export it from the
  package index only if a consumer outside `packages/quereus` needs it (it does not today).
- Call it from `emitCreateView` before `schema.addView`.
- Call it from `materializeView` inside the existing `registerMaterializedView` try-block,
  before the register call; confirm by test that the rollback leaves no backing table.
- Call it from `SchemaManager.updateViewTags` and `updateMaterializedViewTags` before the
  schema swap.
- Implement the hook on `StoreModule`; refactor `saveViewDDL` / `saveMaterializedViewDDL` /
  `encodeCatalogDDL` onto the shared `{key, ddl}` helpers so the veto and the write cannot drift.
- Forward the hook in `IsolationModule`.
- Extend `packages/quereus-store/test/lone-surrogate-keys.spec.ts`'s "an identifier or
  persisted DDL text carrying a lone surrogate" block with the four rejection cases above,
  reusing its existing `rejects()` helper. Assert the object is absent from the in-session
  schema afterwards (`select … from "<lone>"` fails, MV backing table not registered) — the
  bug was that it was *present but unpersisted*.
- Add one close→reopen test using the persistent-provider harness from
  `packages/quereus-store/test/view-mv-persistence.spec.ts`, pinning that a view whose create
  was rejected leaves an empty catalog (no folded U+FFFD entry).
- Update the timing note in `lone-surrogate-keys.spec.ts`'s block comment: it currently
  documents two rejection timings (CREATE-time for store names, first-access for DDL text).
  Views/MVs are now a third: CREATE-time via the module veto.
- Check `docs/` for a place that describes the schema-change-event persistence contract
  (`docs/store.md`, `docs/schema.md`) and record that catalog persistence is advisory /
  fire-and-forget **except** for this pre-flight veto — that asymmetry is the whole point of
  the design and a future reader will otherwise re-derive it.
- `yarn build`, `yarn test`, `yarn lint` from repo root. `yarn test:store` is worthwhile here
  (this ticket is entirely store-path) if it completes inside the ~10 min agent budget;
  stream it with `tee` and skip/defer it if it does not.
