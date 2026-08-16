# Store Catalog Persistence and Key Collation

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

How `@quereus/store` writes a table's definition to the catalog store — the bundled `CREATE TABLE` + index DDL entry, when it is written, and what survives a crash mid-rename — and how the collation of a key column reaches the physical key bytes it is encoded under. A satellite of [Persistent Store Module Design](store.md).

This document covers **table** entries. Views and materialized views are engine-level
objects that never reach a module hook; the store persists them under reserved-prefix
keys through a schema-change subscription — see
[view-persistence.md](view-persistence.md).

## The bundle format

`@quereus/store` persists each table's secondary indexes **inside the same
catalog entry as the table**, keyed `{schema}.{table}` (no per-index key
namespace). The entry is a newline-joined bundle: the `CREATE TABLE` statement
first, then one `CREATE [UNIQUE] INDEX` line per persistable index, then one
`alter index … set tags (…)` line per *exposed implicit index* carrying user
tags:

```
CREATE TABLE "main"."t" (...) USING store
CREATE INDEX "ix_b" ON "main"."t" ("b")
CREATE UNIQUE INDEX "uq_email" ON "main"."t" ("email" COLLATE NOCASE) WHERE "email" IS NOT NULL
alter index main.uq_vin set tags (purpose = 'lookup')
```

`StoreModule.buildCatalogEntry` produces the bundle (table DDL + every index DDL,
both in the persistence-safe no-`db` form; the `alter index` lines via
`generateIndexTagsDDL`, a schema→AST-lift over the shared `alterIndexToString`
emitter — its lowercase keywords are cosmetic, both forms re-parse). Hidden
implicit covering indexes (the auto-built BTree backing a declared inline
`UNIQUE`) are excluded — they round-trip via the table's `UNIQUE` constraint,
not as a standalone `CREATE INDEX`. An *exposed* implicit index is likewise
never emitted as a `CREATE INDEX` (a re-import would materialize a real
`IndexSchema`, changing the store-mode shape); only its user tags
(`UniqueConstraintSchema.exposedIndexTags`) persist, as a whole-set
`alter index … set tags` statement (the canonical replace form; empty tag records
emit no line). On reopen, `rehydrateCatalog` feeds each bundle to
`importCatalog`, whose `parser.parseAll` splits it by AST (never on `\n`, so a
newline inside a `DEFAULT` / `CHECK` / partial-predicate string literal is safe)
and imports table-before-indexes; the trailing `alter index` lines re-apply
silently (no change event, no import-result entry) against the just-imported
table, whose `CREATE TABLE` earlier in the bundle carries the constraint and its
exposure flag.

**When a table's entry is written.** The authoritative write happens when the engine
REGISTERS the table — the store's schema-change listener handles `table_added` and
compare-writes the bundle. Registration is the right moment because it is the first
point at which the table definitively exists: `SchemaManager.createTable` runs
`validateForeignKeyCollations` *after* `module.create` returns and throws there without
calling `destroy`, so a write inside `create` could leave an entry for a table the user
never got, which would reopen as a phantom.

The listener self-filters on ownership (`ownsTableCatalogEntry` — memory tables and other
modules' tables are left alone, and a store table behind the isolation wrapper is still
recognized) and compare-writes rather than blind-puts, because `table_added` is also
delivered during rehydration for a store-hosted materialized-view backing whose entry is
already current.

`StoreTableBase.initializeStore` still compare-writes the entry the first time a table's
storage is opened, now purely as a **backstop**: for an already-persisted table it reads
and skips. It is retained because the `table_added` write rides the async persist queue,
which logs and swallows — so the backstop is the only site where a table whose DDL text
cannot be encoded at all (a lone surrogate in a quoted column name, a `DEFAULT` string
literal, a `CHECK` constant) raises on a statement rather than vanishing quietly. Before
this arrangement the write was *only* lazy, so a table nobody ever read or wrote was never
persisted at all and disappeared on reopen.

**Why bundle rather than a per-index key:** every existing re-persist path carries
the indexes for free —

- `CREATE INDEX` / `DROP INDEX` rewrite the bundle (`StoreModule.createIndex` /
  `dropIndex` call `saveTableDDL` after updating the connected table's schema).
- `DROP TABLE` deletes the single key, so the indexes vanish with it (no orphan
  catalog entries). The teardown drains the persist queue first, so a create-then-drop
  in one session cannot have its queued `table_added` write land *after* the delete and
  resurrect a phantom entry.
- `RENAME TABLE` regenerates the bundle under the new name (index DDL references
  the renamed table automatically).
- `ALTER INDEX … SET/ADD/DROP TAGS` fires `table_modified` on the *owning* table;
  the store's catalog listener regenerates the bundle (index tags live in
  `tableSchema.indexes`; exposed-implicit-index tags on the originating
  constraint's `exposedIndexTags`) with no index-specific plumbing.
- Structural ALTERs that reindex columns already re-persist the table, so the
  bundle's index lines track the reindexed columns.
- `RENAME TABLE` / `RENAME COLUMN` rewrite every self-naming part of the table's own
  definition — partial-index `WHERE` predicates, `CHECK` expressions, and a
  self-referencing foreign key's target — **before** it is persisted, in two places. The
  module's hook does it inline: the engine's propagation runs only after the hook returns,
  so a module that persisted first would durably write a definition naming the pre-rename
  table or column, and a crash in that window strands an un-rehydratable bundle on disk.
  `runRenameTable` repeats it inside the engine before the catalog swap and the
  `table_modified` notify, or the store's catalog listener — firing on that notify —
  re-persists a bundle whose self-FK still names the vanished table. The expression
  rewrites are idempotent and mutate the AST in place (shared by reference with the catalog
  schema and with a unique partial index's derived `UNIQUE` constraint), so the later
  propagation pass finds nothing to change and its event compare-skips; the foreign-key
  retarget is a copy, since it touches a name field rather than an AST.
- `RENAME TABLE` corrects **other** objects too — a cross-schema FK, a `CHECK` expression,
  a view or materialized-view body naming the renamed table — which live in *other*
  catalog entries the module's single-table hook cannot know about. The engine rewrites them
  in its post-hook propagation (`propagateTableRename`), which enqueues their corrective
  catalog writes. So that a crash cannot strand a dependent naming a vanished table, the
  rename is **two-phase** at the module boundary: `module.renameTable` writes the
  new entry and moves physical storage but leaves the **old** name's catalog entry in place;
  the engine then calls `module.finalizeRename` at the end of `runRenameTable`, after
  propagation, and the store drains the dependents' writes to durability **before** deleting
  the old entry. Both entries coexist on disk during the window, so every
  intermediate catalog set rehydrates into a working database. The guarantee is
  *"no durable catalog set ever names a vanished table"* — short of full cross-table atomicity
  (see best-effort residue below).

**Reattach, not rebuild.** The physical index KV store survives a logical close,
so rehydrate does **not** scan rows to rebuild it. After the import loop,
`rehydrateCatalog` refreshes each connected `StoreTable`'s cached schema from the
now-current registry (import updates the registry, not the live table instance), so
DML maintains the rehydrated index and the derived `UNIQUE` enforces. The backing
store is reattached lazily on first access via `provider.getIndexStore`. Partial
indexes are maintained on DML too: the index-update path honors the index `WHERE`
predicate, matching the build-time filtering.

**Best-effort durability.** Persistence follows the store's best-effort contract:
if the catalog write fails after a `CREATE INDEX` built the physical index store,
the in-memory schema has the index but the catalog does not, so on reopen the
index is missing and its store is orphaned — no two-phase protocol here.

The `RENAME TABLE` `finalizeRename` protocol (above) orders the *catalog* writes but
does not make the whole rename atomic. Two accepted residues remain, both safer than the
"child cannot be written to" failure they replace, neither occurring on a clean
(crash-free) rename:

- **Physical-move orphan.** `renameTableStores` *moves* (not copies) the old table's data
  store into the new name inside `renameTable`, while the old catalog entry is still present.
  A crash there, then reopen, rehydrates the old name as an **empty** table (a fresh store
  is minted on connect) — a visible, droppable orphan.
- **Copy-fallback orphan.** A provider without `renameTableStores` gets the module's
  generic copy fallback instead: every entry is read from the old-named data and index
  stores and written under the new name, then the old stores are reclaimed via
  `deleteTableStores` when the provider has it, or closed with a logged warning when it
  does not (the old-named copy then survives as a droppable duplicate). A provider whose
  `deleteTableStores` only *closes* its stores — both mobile plugins do today — leaves the
  same duplicate without the warning. A copy failure propagates before the catalog is
  rewritten, so the table stays reachable under its old name.
- **Old-entry delete failure.** The deferred old-entry delete is best-effort (logged, not
  fatal); a failure leaves both entries on disk — again a droppable orphan, not a stranded
  dependent.

Full cross-table atomicity would remove even these residues; it is unimplemented — see
`docs/todo.md`.

## Per-column PK key collation

The store enforces PRIMARY KEY uniqueness/ordering
*physically* in the key bytes, encoding each PK column under its own declared collation
(`StoreTable.pkKeyCollations` — `BINARY` / `NOCASE` / `RTRIM`, the registered key
encoders). So **any** declared PK collation is honored natively (`x text collate binary
primary key` keys under BINARY, `collate nocase` under NOCASE), at parity with the memory
module. The table-level key collation K (`config.collation`, `BINARY` or `NOCASE`, default
`NOCASE`) is only a **default** for an undecorated PK column whose logical type is
`isTextual` (i.e. `text`). Secondary-index *column* values are likewise keyed per-column,
under the index column's own effective collation (`resolveIndexKeyCollations`: the index
column's `COLLATE`, else the table column's declared collation, else `BINARY` — **not** K;
an undecorated non-PK text column genuinely compares under BINARY, since the CREATE-time
K-reconcile below applies only to PK members), with the same hard-`BINARY` rule for
collation-blind columns (`json`, the temporal types) as the PK bullet below. So the stored
index bytes always agree with the collation the residual re-check, the planner's cover
analysis, and UNIQUE enforcement compare under. The schema entry points:

- **A collation-aware PK column** — one whose type's `compare` applies the collation it
  is handed (`LogicalType.collationAware`: `text` and `any`) — is keyed under its
  **declared collation**. `create table t (k any collate nocase primary key)` is accepted
  (`NOCASE` is a registered built-in, so it passes the registry-aware column-DDL gate on
  `ANY_TYPE`, which declares no supported-collation list; an *unregistered* name is
  rejected there) and the `nocase` is *honored*: key bytes, PK/UNIQUE enforcement, and
  every comparison agree that `'A'` and `'a'` are one key, and
  `pkOrderPreservingPrefixLength` finds key and comparison collation equal, so the range
  seek and PK-order advertisement stay open. An **undecorated** `any` PK column keys (and
  compares) BINARY — `resolveDefaultCollation` never applies a non-BINARY session default
  to ANY, and the CREATE-time K-reconcile below deliberately skips it — so only an
  explicit non-BINARY `COLLATE` moves its key bytes.

- **A PK column that can hold text but is collation-blind** — `json` and the temporal
  types `date` / `time` / `datetime` / `timespan` — is keyed under **hard-coded
  `BINARY`**, never under a declared collation and never under K. Those types' `compare`
  is not the generic storage-class + collation comparison — the temporals ignore the
  argument `createTypedComparator` hands them, and JSON ranks structurally, applying the
  collation only to a string-scalar pair — so keying such a
  column under anything but BINARY would enforce uniqueness under one collation and
  compare under another — `'A'` and `'a'` are distinct to the comparator but would
  collide at one NOCASE key, so a second `insert` would be spuriously rejected and an
  `insert or replace` would silently destroy the first row. (Their empty
  `supportedCollations` list already keeps a non-BINARY column COLLATE out at DDL time;
  the hard-coding is the backstop.)

- **What the PK-order advertisement is measured against.** A range seek and a
  `providesOrdering` advertisement claim that memcmp over the key bytes reproduces the order
  the planner's `Sort` would have produced. For a collation-aware column `Sort` orders under
  the operand's *collation*, which is exactly what the key bytes encode under, so the
  advertisement holds (subject to the collation's `orderPreserving` assertion). For a
  semantic-ordering type `Sort` ranks through `logicalType.compare`, and the member counts
  only when the explicit per-type allow-list `semanticKeyOrderIsFaithful`
  (pk-key-resolution.ts) asserts its stored key bytes memcmp in exactly that order —
  TIMESPAN through its total-seconds `groupKey` transform, JSON through the structural
  byte form; any other semantic-ordering type keeps the blanket decline. Every seek
  *probe* passes through the per-value gate `semanticProbeIsKeyFaithful` besides: a probe
  the type gives no faithful byte position (a numeric or unparseable TIMESPAN probe, a
  blob/bigint JSON probe) degrades in whichever way its arm can afford — a range bound is
  dropped (widening the window), a full-PK equality declines its whole point arm (a point
  window cannot widen, only under-fetch), and a secondary index's EQ prefix stops short at
  that column (a shorter prefix window is a superset). The type-aware residual
  (`matchesFilters`) decides rows in every case. The memory backend's declared-key BTrees
  (`createTypedComparator`) agree with `Sort` on both kinds, so the two backends advertise
  the same orders.

- **CREATE.** `module.create` applies the store default K to an *implicit*-default text PK
  column (the engine's BINARY column default becomes NOCASE under K = NOCASE), so an
  undecorated text PK keeps the store's NOCASE-keyed behavior; an *explicit*
  `COLLATE` clause — even one diverging from K — is left exactly as declared and keyed
  under it. So `create table t (x text primary key)` yields **BINARY under memory**
  (`'a'` and `'A'` distinct) and **NOCASE under the store** (they collide). This is
  intentional: memory honors the session `default_collation` (BINARY out of box, via
  `resolveDefaultCollation` in `quereus/src/schema/table.ts`) while the store preserves its
  on-disk NOCASE semantics for undecorated text PKs. An authored lens (bijection inverse)
  for a text PK is therefore read-only under the store default but writable under memory,
  because the value-discriminating check needs BINARY-level distinct `'a'`/`'A'` to prove
  injectivity. (The explicit-vs-implicit distinction rides on `ColumnSchema.collationExplicit`,
  set by `columnDefToSchema` for a `COLLATE` clause and — for a **materialized-view backing
  column** — by `deriveBackingShape` (`materialized-view-helpers.ts`) when the body output
  column's collation provenance is `explicit` or `declared`. So an MV key column publishing a deliberate
  collation — an explicit `collate …` projection or a passthrough of a declared-collation
  source column — is keyed under it across the reconcile, while a genuinely-implicit MV
  column keeps the store-default reconcile, like an undecorated base-table PK.) Non-text PK columns (e.g. `integer primary key`) keep their declared
  collation — collation governs key bytes only for text.
- **Load path (`connect` / rehydrate).** The load path does **not** reconcile — the
  persisted DDL is the source of truth. The per-column key collation round-trips through
  the column's `COLLATE` clause (`generateTableDDL` elides the default `BINARY`, emits
  any non-`BINARY` collation explicitly), and the engine import path defaults a
  no-`COLLATE` column to `BINARY`, so the reloaded collation matches what the physical
  keys were written under. (A persisted DDL whose declared collation does not match its
  key bytes loads as-declared — see `store-pk-collate-legacy-reopen-divergence`.)
- **`ALTER COLUMN … SET COLLATE` on a PK column, `ALTER COLUMN … SET NOT NULL` on a PK
  column when it backfills, and `ALTER TABLE … ALTER PRIMARY KEY`,** are all honored by a
  **physical re-key**: `StoreTable.rekeyRows` re-encodes every data-store key under the new
  key definition (a new collation for SET COLLATE, the backfilled value for SET NOT NULL —
  the value rewrite runs first so the re-key reads the rewritten row — a new column set for
  ALTER PRIMARY KEY) and `rebuildSecondaryIndexes` rebuilds each secondary index
  non-enforcing (its keys embed the PK suffix; uniqueness was already judged pre-mutation,
  see below). Before anything is flushed or mutated, every arm asks
  `StoreTable.validateRekeyedPrimaryKey` the memory backend's two re-key questions over two
  different row sets (see [memory-table.md](memory-table.md) §"A change that moves a
  PRIMARY KEY column's keys obeys a stricter rule" — the store mirrors it status-for-status;
  for the backfill both probes judge the rows as the rewrite will leave them): a
  collision among the rows the DDL transaction can *see* (its staged rows included, via the
  isolation wrapper's effective row stream) throws `CONSTRAINT` naming the key; a collision
  confined to committed rows the transaction has *deleted* — rows a `rollback` must restore,
  which a re-keyed store cannot hold — throws `BUSY` ("commit/rollback and retry"). Either
  refusal leaves the store, the catalog, and the enclosing transaction untouched. "Deleted"
  covers a delete staged in an isolation wrapper's overlay *and* one buffered in this
  module's own coordinator, so the bare module answers `BUSY` here too rather than flushing
  the delete and re-keying — which would spend the transaction's rollback silently. For SET
  COLLATE, a target equal to the column's current collation is a schema-only no-op (no
  re-key); ALTER PRIMARY KEY always re-keys. `rekeyRows`' own duplicate-key pass stays in
  place after both probes, as a backstop rather than the gate.

  An ACCEPTED re-key is still not transactional: the new collation and the re-keyed
  stores are durable the moment the statement returns, while the issuing transaction's
  own row changes remain undoable. A `rollback` afterwards therefore restores rows the
  probes judged deleted — including, where a UNIQUE index covers the altered column, rows
  that violate it under the new collation. The data store and the index still describe the
  same rows (index entry keys carry the PK suffix, so no row is displaced); the memory
  backend leaves the same state for the same statement sequence, since its secondary
  structures are multi-maps and its DDL is equally non-transactional.

The store carries no on-disk format version stamp and no rebuild-on-open path: a store whose
non-textual PK bytes were written under any collation but BINARY must be recreated. Likewise
for secondary indexes: index-column bytes were formerly encoded under the table key collation
K, so any previously-persisted database with a secondary index over a text column whose
effective collation differs from K must be recreated or re-indexed (drop + recreate the
index); the data-store bytes and the PK suffix inside each index key are unchanged.

See [`docs/sql-alter.md` § ALTER COLUMN](sql-alter.md#27-alter-table-statement) for the
full SET COLLATE contract, including the non-PK UNIQUE re-validation. Physical key bytes
and existing-row dedup both resolve the collation's key normalizer against the connection's
registry, so a custom or overridden collation is honored; a comparator-only collation
(no `normalizer`) is rejected rather than silently keyed under someone else's bytes.

## OBJECT-class PK / index key encoding

An object-valued key member encodes through a
**canonical JSON string** (`canonicalJsonString` from `@quereus/quereus` — recursive
object-key sort, array order preserved), not a bare `JSON.stringify`. So reorder-equal
objects encode to identical key bytes and collide as one row (matching `deepCompareJson`
and the memory module), while array order stays significant. The canonical form governs
only the *key* bytes — the stored/displayed row value keeps its insertion order (rows
round-trip through `serializeRow`/`deserializeRow`, independent of the key). **No collation
applies** — the canonical string is encoded verbatim, mirroring the engine, whose
OBJECT-class comparison (`compareSameType`) and key serializer (`util/key-serializer.ts`)
both ignore the collation for object values. So the object-valued members of an
`any collate nocase` key stay case-distinct and keep the comparator's code-point order,
while that column's *text* values still fold under NOCASE.

This canonical-text path serves members with **no declared `json` type** (an `any` column
holding an object). A member on a column DECLARED `json` takes the store-local
**structural byte form** instead (`jsonStructuralKey`, `json-key.ts` — see [store.md § Order
preservation](store.md#order-preservation) and `docs/types.md` § Semantic ordering): same reorder-equal identity, but a
memcmp order that reproduces `JSON_TYPE.compare` rather than JSON punctuation order. Its
key bytes are likewise collation-free (a declared-`json` index column keys hard-`BINARY`).

**Where a declared-`json` index column's `COLLATE` *does* bite.** `CREATE UNIQUE INDEX …
(j COLLATE NOCASE)` over a `json` column is accepted (index DDL applies no type gate), and
although the key bytes ignore that name, both uniqueness checks honor it on the one shape
`JSON_TYPE.compare` treats as text — a **top-level string scalar**. Write-time enforcement
compares through the index's collation; build-time enforcement (`buildIndexEntries`'
in-pass `seen` check and `validateUniqueIndexOverRows`) signs each value through
`storeDedupeKeyTransform`, which leaves a top-level string scalar AS a string so
`serializeKey` runs the collation normalizer over it, and falls back to the structural
bytes for every other node. Signing a string through the structural bytes instead dropped
the collation and let `CREATE UNIQUE INDEX` admit rows a later insert then rejected
(`bug-store-index-build-dedupe-skips-collation`). A **nested** string leaf is unaffected:
`deepCompareJson` takes no collation, so `["a"]` and `["A"]` stay distinct under any index
`COLLATE`.

## Index-derived UNIQUE enforcement collation

A `CREATE UNIQUE INDEX … (col COLLATE x)`
synthesizes a `derivedFromIndex` UNIQUE constraint whose DML enforcement resolves each
column's comparison collation from the **index's** per-column `COLLATE` clause (falling
back to the declared column collation when the index column carries none) —
`StoreTable.uniqueEnforcementCollations`, matching memory's `checkUniqueViaIndex`, the
store's own `buildIndexEntries` build-time dedup, and SQLite (a unique index enforces
under the index's collation). So a *finer* index (`COLLATE BINARY` over a `NOCASE` column)
admits case-variants the column would unify, and a *coarser* index (`COLLATE NOCASE` over a
`BINARY` column) unifies case-variants the column would keep distinct. When **two** UNIQUE
indexes cover the same column-set with differing collations, each derived constraint enforces
under **its own** index's collation regardless of creation order — both backends resolve the
enforcing index BY NAME (memory's `findIndexForConstraint` off `uc.derivedFromIndex`; the
store's by-name `uniqueEnforcementCollations`), where a by-column-set resolution would collapse
both onto the first-listed index and under-enforce the coarser one
(`memory-multi-index-unique-collation-resolution`). `ALTER COLUMN … SET
COLLATE` on a column under such an index propagates the new collation into the index
column *and* rebuilds every index covering it — the store's index *key* bytes encode each
index column under its own effective collation, so the persisted entries are stale until
re-encoded under the new one — mirroring memory's schema propagation with the physical
rebuild the store's byte encoding additionally requires.

A non-derived (table-level / column) UNIQUE always enforces under the declared column
collation, even when a *finer* same-column-set `CREATE UNIQUE INDEX` exists (either DDL
order). Memory does **not** reuse that finer index as the constraint's realizing structure:
it builds the constraint's own declared-collation covering index and resolves the non-derived
UC to it BY NAME (via `getImplicitCoveringStructure`), so the two indexes coexist and each
enforces its own equivalence — matching SQLite and the store, which never reused the user
index (`memory-nonderived-unique-reused-finer-index-under-enforcement`). When a row-time
covering materialized view is *also* linked to such a constraint, a finer/incomparable index
collation disqualifies the MV from answering it (see the [covering-MV collation eligibility
gate](mv-constraints.md#enforcement-through-a-covering-mv)), so enforcement falls back to
this per-scan / auto-index path, still under the index collation. That gate reads the same
`index.columns[i].collation` this resolver does, so the two stay consistent across an `ALTER
COLUMN … SET COLLATE`.

A **semantic-ordering** column (TIMESPAN, JSON — see [types-ordering.md § Semantic
ordering](types-ordering.md#semantic-ordering)) is the one exception: its enforcement comparison is
the declared type's `compare`, so neither the index nor the column `COLLATE` participates
and `'PT1H'`/`'PT60M'` conflict under any collation. The resolved collation is still passed
to the type's `compare` (types whose ordering is partly textual may consult it). Every
backend builds these comparators from the resolved collations through one helper,
`uniqueEnforcementComparators` (`schema/unique-enforcement.ts`).
