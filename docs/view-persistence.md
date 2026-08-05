# View and Materialized-View Persistence

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

How `@quereus/store` durably persists engine-level views and materialized views: the
reserved-prefix catalog keys, the schema-change subscription that writes them, the pre-flight
veto that stops an unencodable definition from being created, and the phased rehydrate that
imports them on reopen. Schema management itself is [schema.md](schema.md); the table-side
catalog format is [store.md § Catalog persistence](store.md#catalog-persistence-bundled-index-ddl).

Views and materialized views are engine-level catalog objects that never pass
through a vtab-module hook, so the store persists them by subscribing to their
engine schema-change events (the same `SchemaChangeNotifier` it already uses for
`table_modified`). Each object's DDL is written under a **reserved-prefix** catalog
key so it can never collide with a same-named table entry — essential for a
store-hosted materialized view, whose maintained table persists its own unprefixed
table bundle under the very same `{schema}.{name}`:

```
table key  =  encode(`{schema}.{table}`)             // unprefixed (unchanged)
view key   =  encode(`\x00view\x00{schema}.{view}`)
mv key     =  encode(`\x00mview\x00{schema}.{mv}`)
```

A leading `0x00` byte is a valid KV key byte for the in-memory, LevelDB, and
IndexedDB stores; table identifier keys never contain it, so `classifyCatalogKey`
routes each loaded entry to the right phase. `buildCatalogScanBounds()` is a full
range scan, so it returns the prefixed view/MV entries alongside table entries —
intended; rehydrate classifies and routes them.

**Incremental writes (the listener).** `view_added`/`view_modified` and
`materialized_view_added`/`_modified`/`_refreshed` regenerate the object's DDL
(`generateViewDDL` / `generateMaterializedViewDDL`, which read live tags) and
compare-write (skip identical); `view_removed`/`materialized_view_removed` delete
the entry. Unlike the table path there is no catalog-absent self-filter: one
`StoreModule` serves one `Database`, so its views/MVs belong in its catalog. A **store-hosted** maintained table additionally persists its
ordinary (unprefixed) table bundle through the table channel — its rows and shape
reconnect as a plain table in rehydrate phase 1, for phase 3's MV entry to adopt
or refill. A **memory-hosted** maintained table's `table_*` events stay ignored
(memory tables are never persisted as bundles), so exactly one catalog entry —
the MV form — persists, and it always refills on reopen. All writes ride the same
serialized `persistQueue` drained by `closeAll`/`whenCatalogPersisted`.

**Subscription is established at `Database.registerModule`**, through the optional
`VirtualTableModule.onRegister` hook (the isolation wrapper forwards it). The store
subscribes there, before any statement can run, so view/MV DDL persists regardless of
where it falls in statement order — including as the very first statement of a brand-new
database that was never rehydrated. `rehydrateCatalog` still subscribes as well
(idempotent), since it is reachable with a `Database` the module was never registered on.

**Persistence is advisory — except for one pre-flight veto.** These writes are
fire-and-forget in both layers: `SchemaChangeNotifier.notifyChange` wraps every
listener in `try`/`catch` and only logs, and the store chains the actual save onto
`persistQueue` behind its own `.catch`. That is deliberate — an unrelated listener's
failure must not abort user DDL — but it means **no** write-time failure can reach the
statement that caused it: a definition the store cannot encode would create
"successfully", answer queries for the session, and be silently absent after reopen.

The single exception closes that hole: the optional module hook
`VirtualTableModule.assertCatalogObjectPersistable(db, kind, object)`, driven by
`assertCatalogObjectPersistable` in `src/schema/catalog-persistability.ts` over every
registered module. It is **synchronous, pure (no IO), and consulted before the object
is registered** — from `emitCreateView` (before `schema.addView`), from
`materializeView` (inside its existing rollback arm, since the MV's DDL text does not
exist until the derivation is attached), and from `SchemaManager.updateViewTags` /
`updateMaterializedViewTags` (tags ride the persisted DDL). A module that would not
persist the object no-ops; a throw propagates and leaves the statement a clean no-op.
The store implements it by running exactly the key + DDL derivation its write path
runs, so veto and write cannot drift. It rejects one thing: text carrying an
unpaired UTF-16 surrogate, which `TextEncoder` folds to U+FFFD (see
`packages/quereus-store/src/common/encoding.ts`). A wrapper module (e.g. the isolation
layer) must forward the hook or the wrapped module never gets its veto.

**The RENAME arms get the same veto, through a pre-flight dependent scan.**
`alter table … rename to` / `rename column` rewrites the new name into every dependent
view and materialized-view body and fires `view_modified` / `materialized_view_modified`;
it also rewrites every dependent **table** (an FK's `referencedTable` / referenced-column
list, a CHECK expression, a partial-index predicate, a column's `DEFAULT` / generated
expression) and fires `table_modified`; and
renaming a materialized view additionally moves its own catalog entry
(`materialized_view_removed` old → `materialized_view_added` new). Those re-persists are
fire-and-forget like the rest, so both arms run `assertRenameDependentsPersistable`
(same file) BEFORE their first side effect — `module.renameTable` for the table arm,
`module.alterTable` for the column arm:

- Every view and every maintained table in the renamed object's **own schema** (the scope
  the propagation's own loops use) has its body rewritten on a **spine clone** —
  `spineCloneAst` in `src/util/ast-spine-clone.ts`, a plain-object/array deep copy that
  passes every other value through by reference. The rewriters mutate in place, so a veto
  thrown after mutating the live AST would strand a body naming a table that was never
  renamed; `structuredClone` is not an option, because `LiteralExpr.value` may hold a
  Promise. A body the rewrite does not touch renders identically to what is persisted, so
  it is skipped.
- Every table in **every** schema is probed under kind `'table'`, because the propagation's
  table loop is not schema-scoped (`propagateTableRename` walks `_getAllSchemas()`, so a
  cross-schema FK reference is rewritten). Its rewritable state is spread over three fields
  and only the FK arm is copy-on-write, so the probe runs against a copy whose CHECK
  expressions and index predicates are spine clones (`cloneTableRewritableAsts`). The
  rewriters return the SAME reference when nothing changed, which is the skip test.
- Both DDL generators read the AST rather than a cached string, so the prospective object
  is just the record with the clone swapped in.
- The renamed table itself is left in the table scan rather than special-cased: it is probed
  under its OLD name with only new-name-carrying text rewritten in, so a veto there is
  always true, and its own catalog entry stays covered by the module's `renameTable` /
  `alterTable` guards.
- Renaming a maintained table additionally vets the prospective record
  `{ …, name: newName }` directly — checking the new catalog **key** as well as the new DDL
  text, long before the `materialized_view_removed` that would otherwise delete the old
  entry.
- The column arm threads the very `ResolveColumnInSource` the real propagation builds, so
  the probe computes the rewrite that later lands. Evaluating it pre-mutation is sound: the
  resolver is only ever asked about sources *other* than the renamed table, whose column
  sets the rename does not touch.

Because the `'table'` kind is offered over tables the asked module may not own, a module
answering it must **self-filter synchronously** — the hook is pure by contract, so it cannot
read its catalog the way the table write path's absent-entry filter does. The store mirrors
`StoreModule.resolveOwnedTable`: a table it already holds, or one whose `vtabModule` is the
store (or a wrapper exposing it as `underlying`, which is what isolation-wrapping produces).
Not owned ⇒ no entry ⇒ no check, which is what keeps a memory-backed dependent from being
refused in a database that also has store tables. Ownership is a slightly coarser test than
the write path's: a store-owned table whose catalog entry has not been written yet is refused
here where the write path would have skipped it — the safe side, since that table's own later
save would throw the same complaint with nowhere left to report it.

Ordering note: for a **store-backed** table with a dependent view or dependent store table
the pre-flight fires ahead of the store's physical store-name guard, so the reported message
is `cannot store persisted schema text …` rather than `cannot store the identifier …`. Both
name the unpaired surrogate and both leave a clean no-op.

Two things stay uncovered. A `select *` materialized view's persisted backing **column
list** shifts under a column rename with no AST change, so the scan cannot see it (and no
persist event fires) — harmless today because reopen re-derives an implicit MV's shape from
its body; see the `NOTE:` on `restoreUnaffectedMaterializedViews` in
`runtime/emit/materialized-view-helpers.ts`. And a `create table` is not gated here at
all — it goes through `module.create`, whose failure already reaches the statement, but
that hook does not check DDL-text encodability; for a store table an unencodable
definition (a lone surrogate in a quoted column name, a `DEFAULT` string literal, a
`CHECK` constant) is instead raised by the catalog backstop the first time the table's
storage is opened, so a table nobody ever reads or writes never surfaces it.

**Rehydrate phasing.** `rehydrateCatalog` first consumes the clean-shutdown marker
(the reserved `\x00meta\x00clean_shutdown` entry `closeAll` writes after every batch
flushed — read and immediately deleted, single-use; its value is the JSON set of
`schema.mv` names **stale-at-close**), then loads all entries once and classifies
them by key prefix (meta entries never reach DDL import; `loadAllDDL` filters them
too), then imports in dependency order — every phase through `importCatalog`:
(1) **tables** (connect to storage — a store-hosted maintained table reconnects here
as a plain table); (2) **views** (engine silent-register — body validation deferred
to query time, so view-over-view and view-over-MV are order-independent and no event
fires); (3) **materialized views** per entry (engine re-materialize via the shared
`materializeView` core: rebuild contents from current source data, re-register
row-time maintenance, re-run the eligibility gate — or adopt the phase-1 table
without a refill). Phase 3 threads `{ trustBackings, adoptedBackings,
pendingDerivations }` into each `importCatalog` call; `trustBackings` is decided
**per entry** (`<marker present> && this MV was not stale-at-close`), enabling the
store-hosted-backing **adopt fast path** (no refill) when every gate passes — see
[`docs/mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity).
Import is silent — no `materialized_view_added` fires — so rehydration writes
nothing back to the catalog and a second consecutive reopen yields identical catalog
bytes (adopt included: an adopted MV record is byte-identical to a refilled one).

MV-over-MV ordering uses a **fixpoint retry** rather than a static topological sort:
the resolved `sourceTables` are not serialized in the DDL, so they are unavailable
before import, and a dependent's body *plans* against its upstream's phase-1 plain
table, so plan failure cannot order the rounds. Instead each round's `importCatalog`
call carries `pendingDerivations` (the names of every other still-pending MV entry),
and the engine defers — per-entry error, retried next round — any entry whose body
reads one. The one shared `adoptedBackings` set composes across rounds: an upstream
adopted in round 1 unlocks its dependent's adoption in round 2. A genuinely
unbuildable MV — a missing (e.g. memory) source, an ineligible body, or an
unresolvable cycle — makes no progress in a round and is recorded in the
`RehydrationResult.errors` array (which also gains additive `views` /
`materializedViews` name arrays). An MV over a non-persisted (memory) source is
therefore an inherent limitation: its source is absent on reopen, so it lands in
`errors` and is not registered.
