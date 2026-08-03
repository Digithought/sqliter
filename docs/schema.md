# Schema Management

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The schema subsystem manages database schemas, tables, views, functions, and indexes: it coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Key Types

### SchemaManager

Central coordinator for all schema operations: owns the schema collection, module registry, and change notifier. One instance per `Database`.

### Schema

A named logical grouping of tables, views, functions, and assertions. Every database has at least `main` and `temp`; additional schemas can be attached. Each schema carries a `kind`:

- **`physical`** (default) — module-backed. Tables declare `using module(...)`, may carry indexes and storage tags.
- **`logical`** — design-only (`declare logical schema X { ... }`). Tables declare columns, types, and *logical* constraints (PK, UNIQUE, CHECK, FK, NOT NULL) plus `with tags`, and **nothing physical**: module association, `create index` / `unique index`, and materialized views are all rejected at apply (tags are allowed — engine-facing, and they survive into the compiled view). At `apply schema X` each logical table is aligned against a basis schema and compiled to an inlined view (the **lens layer**); the body registers as an ordinary `ViewSchema` and the logical spec is held in a per-`Schema` **lens slot**. See [Lenses and Layered Schemas](lens.md).

### TableSchema

Columns, primary key definition, CHECK constraints, associated virtual table module, indexes, and mutation context definitions. A module-backed (physical) table always has `vtabModule` / `vtabModuleName`; a **logical** table (`isLogical: true`, held only in a lens slot — never registered or executed) carries no module, so `vtabModule` is optional (use `requireVtabModule(table)` at module-backed sites). An optional `tags` field holds arbitrary key-value metadata (see `WITH TAGS`) — likewise on the other schema-object types below.

### ColumnSchema

A single column: name, logical type, nullability, primary key membership, default value expression, collation, and whether it is generated. Columns default to NOT NULL (Third Manifesto) unless `pragma default_column_nullability = 'nullable'`.

**Primary-key nullability.** Primary-key membership forces NOT NULL **only for an *explicitly-declared* PK** — a column-level `primary key` or a table-level `primary key (...)`. When a table declares no PRIMARY KEY, Quereus synthesizes an all-columns key (the whole row is the row identity); that **synthesized** key does *not* promote nullability — each column keeps its declared (or session-default) nullability. A nullable synthesized-key column is a valid row identity because NULL participates in keys on both backends (memory compares `NULL == NULL` as equal and orders NULL first; the store key codec encodes `TYPE_NULL` first), so two fully-identical rows collide as a duplicate key.

### IndexSchema / IndexColumnSchema

A secondary index: name plus an ordered list of column references (by index into `TableSchema.columns`) with optional sort direction and collation.

### RowConstraintSchema

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings.

### UniqueConstraintSchema

A UNIQUE constraint over one or more columns beyond the primary key: column indices, optional name, default conflict action, optional partial-index `predicate`, and `derivedFromIndex` (set when synthesized from `CREATE UNIQUE INDEX`). Carries an optional `coveringStructureName` — see [Covering-structure links](#covering-structure-links).

### ViewSchema

A view: name, schema, SQL text, and parsed SELECT AST.

### TableDerivation / maintained tables

A table is a stored relation; a *derivation* is an optional maintenance contract attached to it. A **maintained table** — what `create materialized view` produces — is one ordinary `TableSchema` registered under the view's own name, carrying a `derivation: TableDerivation` (`schema/derivation.ts`; `MaintainedTableSchema = TableSchema & { derivation: TableDerivation }`). One record, one catalog name, one physical incarnation: identity (name/schema), storage (`vtabModuleName`/`vtabArgs` — the backing-host module), tags, and the physical primary key all live on the owning table; the canonical `create materialized view` DDL renders on demand via `generateMaterializedViewDDL`. `TableDerivation` carries:

- **`selectAst`** — the parsed body AST, which itself carries the trailing `with defaults (...)` clause on `SelectStmt.defaults` (consumed by the write-through rewrite — read it via `bodyDefaults`); **`columns`** — the explicit MV column list (`mv(a, b)`), when declared.
- **`bodyHash`** — `computeBodyHash` over the canonical definition (explicit column list + body, the body string already carrying any `with defaults (...)` clause, rendered by `viewDefinitionToCanonicalString`), used by the declarative-schema differ to detect "definition changed → rebuild" — so a defaults-only edit drifts the hash without a separately-itemized field.
- **`logicalKey`** — the body's logical key (the table's own `primaryKeyDefinition` stays the physical, order-by-seeded key); **`ordering`** — the captured body ordering; **`coarsenedKey`** — the collation-coarsened lineage key, when applicable.
- **`sourceTables`** — qualified names of the tables the body reads.
- **`stale`** / **`sourceScope`** — runtime maintenance state, never serialized: the staleness flag and the cached source-union change-scope a `select` from the table substitutes for `Database.watch`.
- **`covers`** — the covering-structure reverse link (below).

Full design: [Materialized Views](materialized-views.md).

### Covering-structure links

A UNIQUE constraint is logical; the structure that enforces it is optional (see [Derived-Row Constraints § Covering structures](mv-constraints.md#covering-structures)). Two schema fields record the constraint↔structure association:

- **`UniqueConstraintSchema.coveringStructureName`** — the **forward pointer** and **source of truth**: the name of the covering structure realizing this constraint (an auto-built secondary index, or an explicit covering materialized view — the maintained table's own name — recognized by the coverage prover). Set eagerly when a covering MV is created; cleared when that MV is dropped.
- **`TableDerivation.covers`** — the convenience **reverse link** `{ schemaName, tableName, constraintName? }` back to the covered constraint.

The `origin` vocabulary (`'implicit-from-unique-constraint'`) lives only on the memory-table manager's `ImplicitCoveringStructure` association — it is not a catalog field. These links are informational in the current release (enforcement still routes through the synchronously-maintained auto-index — see the materialized-views soundness note).

**Introspection.** The implicit covering structure (a UNIQUE constraint's auto-built index) is a backing detail, **omitted from `collectSchemaCatalog` / schema export by default**. It is surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`. Indexes from an explicit `CREATE [UNIQUE] INDEX` are always shown.

**Lifecycle.** The structure's lifecycle belongs to its constraint, not to `CREATE`/`DROP INDEX`, on **every** backend — exposed or not. `isImplicitCoveringIndex(tableSchema, name)` (`catalog.ts`, reading only `uniqueConstraints`, so it answers identically on memory and store) is the predicate the write paths consult: `createIndex` rejects the name as a same-table duplicate, and `SchemaManager.findIndexOwner` — the single by-name owner resolver behind `dropIndex`, `emitDropIndex`'s strict-DDL-policy gate, the `createIndex` uniqueness check and sync's replicated index DDL — skips past such a match and keeps searching at its default `'user-indexes'` scope. (`ALTER INDEX … TAGS` asks for the wider `'tag-addressable'` scope, which admits an *exposed* structure but still skips a hidden one.) `ALTER TABLE … DROP CONSTRAINT` is what removes the structure. See [sql-ddl.md §6.3](sql-ddl.md#63-indexes-on-virtual-tables) for the user-facing rules.

Once exposed, the implicit index is **addressable and introspectable identically across backends** — it appears in `schema()` and `index_info()`, and `ALTER INDEX … {SET|ADD|DROP} TAGS` targets it. Backends differ only in *where the user tags live*: memory materializes the implicit index as an `IndexSchema`, so its tags sit on `IndexSchema.tags`; backends that do not materialize it (the store, which enforces UNIQUE by full-scan over `uniqueConstraints`) derive a synthetic exposed index from the constraint in the read paths (`exposedImplicitIndexes` in `catalog.ts`) and route `ALTER INDEX … TAGS` onto a separate `UniqueConstraintSchema.exposedIndexTags` field. The asymmetry is internal; observable behavior is identical. A *hidden* implicit index (tag absent/false) stays unaddressable (`NOTFOUND`) on both — its tags live on the constraint, reached via `ALTER TABLE … ALTER CONSTRAINT … TAGS`. `exposedIndexTags` survives a store close→reopen via a trailing `alter index … set tags (…)` line in the table's catalog bundle (see [Store catalog persistence](store.md#catalog-persistence-bundled-index-ddl)) that `importDDL` re-applies silently on rehydrate. One deliberate divergence: tags are addressable — and *persisted* — only while the constraint is exposed. Dropping the exposure flag (`ALTER TABLE … ALTER CONSTRAINT … DROP TAGS`) leaves `exposedIndexTags` dormant in-session (re-exposing resurrects it), but the bundle emits no `alter index` line for an unexposed constraint, so after a reopen taken while unexposed, re-exposing yields no tags.

## SchemaManager API

### Schema Navigation

| Method | Description |
|--------|-------------|
| `getSchema(name)` | Returns a `Schema` by name, or `undefined` |
| `getSchemaOrFail(name)` | Returns a `Schema` or throws `QuereusError` |
| `getMainSchema()` | Shorthand for the `main` schema |
| `getTempSchema()` | Shorthand for the `temp` schema |
| `getCurrentSchemaName()` | Name of the current default schema |
| `setCurrentSchema(name)` | Sets the default schema for unqualified names |
| `addSchema(name, kind?)` | Creates a new schema (e.g. for ATTACH), `kind` defaulting to `'physical'` (`'logical'` for a logical schema). Throws if name conflicts |
| `removeSchema(name)` | Removes a schema (e.g. for DETACH). Cannot remove `main` or `temp` |

### Table Lookup

| Method | Description |
|--------|-------------|
| `findTable(tableName, dbName?, schemaPath?)` | Finds a table across schemas. `dbName` searches that schema only; `schemaPath` searches those schemas in order; otherwise the default order `main`, then `temp` |
| `getTable(schemaName, tableName)` | Retrieves a table from a specific schema |
| `getMaintainedTable(schemaName, name)` | Retrieves a [maintained table](#tablederivation--maintained-tables) (a derivation-bearing table — a materialized view), or `undefined` for a plain table or no table |
| `getAllMaintainedTables()` | Returns every maintained table across all schemas |
| `attachDerivation(schemaName, tableName, derivation)` | Attaches (or replaces) a `TableDerivation` on an already-registered table, swapping the registered record. Fires no event — callers own the event discipline |
| `getView(schemaName, viewName)` | Retrieves a view definition |
| `getSchemaItem(schemaName, itemName)` | Returns a table or view by name (views take priority on name conflict) |
| `getTableTags(tableName, schemaName?)` | Returns metadata tags for a table, or `undefined` |
| `setTableTags(tableName, tags, schemaName?)` | Replaces a table's metadata tags (pass `{}` to clear); fires `table_modified` |
| `setColumnTags(tableName, columnName, tags, schemaName?)` | Replaces a column's metadata tags (pass `{}` to clear). Catalog-only — column nullability / type / default / PK membership are untouched. Throws `NOTFOUND` for an unknown table or column |
| `setConstraintTags(tableName, constraintName, tags, schemaName?)` | Replaces a **named** table-level constraint's metadata tags (pass `{}` to clear). Lookup order CHECK → UNIQUE → FOREIGN KEY; throws `NOTFOUND` for no match and `ERROR` for a name ambiguous across classes |
| `setViewTags(viewName, tags, schemaName?)` | Replaces a view's metadata tags (pass `{}` to clear). Catalog-only — re-registers the `ViewSchema`; throws `NOTFOUND` for an unknown view |
| `setMaterializedViewTags(name, tags, schemaName?)` | Replaces an MV's metadata tags (pass `{}` to clear). Catalog-only — re-registers the maintained `TableSchema` (the shared `derivation` rides the swap) and fires `materialized_view_modified`; never touches contents or re-materializes. Throws `NOTFOUND` for an unknown MV |
| `setIndexTags(indexName, tags, schemaName?)` | Replaces an index's metadata tags (pass `{}` to clear). Resolves the owning table from the index name, swaps the `IndexSchema`, fires `table_modified`. Throws `NOTFOUND` for an unknown index or a hidden implicit covering index (whose tags live on the originating constraint) |
| `findSchemasContainingTable(tableName)` | Returns all schema names containing the table — useful for error messages |
| `findFunction(funcName, nArg)` | Finds a function by name and argument count |

**Persistence of catalog-only tag swaps (store-backed tables).** The tag setters above (and `ALTER … SET TAGS`) are catalog-only — they swap the in-memory schema and fire a change event but deliberately do **not** call `module.alterTable`. The generic store module (`@quereus/store`) re-persists them anyway by subscribing to `table_modified` and re-writing the table's catalog DDL (`generateTableDDL`) whenever the serialized form changes, so **table**, **column**, and **named-constraint** tags survive close → reopen → `rehydrateCatalog` for `using store` tables. The re-write is a read-compare-write keyed by `{schema}.{table}`: a table with no catalog entry (a memory table, or a store table never persisted) is skipped, and a structural ALTER — whose own `alterTable` already wrote the final DDL — produces identical bytes and is skipped (no double-write). The same subscription persists **views** and **materialized views** (and, via a trailing `alter index … set tags` line, an exposed implicit index's tags) — see [Store catalog persistence](store.md#catalog-persistence-bundled-index-ddl) and [View and materialized-view persistence](view-persistence.md).

### DDL Operations

#### `createTable(stmt): Promise<TableSchema>`

Creates a table from a parsed `CreateTableStmt`:
1. Resolves the virtual table module (explicit `USING` or configured default)
2. Builds column schemas, primary key definition, and CHECK constraints
3. Validates determinism of DEFAULT expressions
4. Calls `module.create()` to initialize storage
5. Registers the table in the target schema
6. Emits `table_added` change event

Throws on duplicate name (unless `IF NOT EXISTS`), missing module, or module creation failure.

**FOREIGN KEY collation validation (declaration time).** After the module
returns the finalized schema and **before** the table is registered, `createTable`
rejects any declared FK whose child column and parent key column carry a same-rank
conflicting collation — the exact conflict the synthesized `parent.k = child.fk`
enforcement comparison would raise at the first DML — resolved through the same
comparison-collation lattice (`schema/constraint-builder.ts`
`validateForeignKeyCollations`; see docs/types.md § Comparison collation
resolution). The same validator runs on the universal `ALTER … ADD CONSTRAINT` and
`ALTER … ADD COLUMN` emit paths (covering memory and store at once) and,
transitively, on declarative apply. On every path it runs
**before any persistence side effect**: `createTable` before `addTable`,
`ADD COLUMN` inside its validate-before-swap revert region, and `ADD CONSTRAINT`
**before** `module.alterTable` (the store's addConstraint arm
`saveTableDDL`'s the FK before returning, so a post-call throw would leave a
rejected FK on disk to rehydrate on the next reopen). It is **unconditional** —
unlike the FK existing-row scan it is *not* gated on `pragma foreign_keys`, since
a contradictory collation pairing is a malformed declaration (same class as a
child/parent column-count mismatch), not an enforcement concern. Two residuals
are intentional: a **forward-declared parent** (not yet created when the child is
declared) cannot be checked — its column types are unknown — so that conflict
stays caught at first DML; and reload / `importTable` does **not** re-validate, so
a legacy persisted conflicting FK reloads without error and surfaces only at DML.

**Column `COLLATE` validation (declaration time).** An explicit `COLLATE <name>` on a
column is validated in `columnDefToSchema` → `validateCollationForType`
(`schema/table.ts`) against BOTH the column's logical type AND the connection's
collation registry. `BINARY` is always accepted; a name on the type's supported list
(TEXT's `BINARY`/`NOCASE`/`RTRIM`) is accepted; any other name is accepted **iff the
connection has it registered** via `db.registerCollation(...)` (probed with
`Database.isCollationRegistered`). So a registered custom collation (e.g. `collate REVERSE` after
`db.registerCollation('REVERSE', …)`) is accepted on any collatable column, while an
**unregistered** name is rejected for *every* type, including `INTEGER`/`REAL`/`BLOB`, with
`Unknown collation '<name>' for type '<type>' …`. Types that declare an *empty*
supported list (`JSON` and the temporal types) reject every non-`BINARY` name,
registered or not. Because catalog rehydrate (`importTable`) shares the same
`buildColumnSchemas` choke point, a persisted column declaring a custom collation
**re-validates against the registry on reopen**: it reloads cleanly only when the
embedder re-registers that collation, and otherwise throws `Unknown collation` — the
same loud, no-silent-fallback failure the key-collation resolver produces (docs/types.md §
Comparison collation resolution; the store's `validateKeyCollations`). Re-register the
collation before reopening a database whose schema names it. The implicit *default* collation (a column with no `COLLATE` clause)
is unaffected — it resolves via `resolveDefaultCollation` and never consults the
registry.

#### `createIndex(stmt): Promise<void>`

Creates a secondary index from a parsed `CreateIndexStmt`:
1. Validates the target table exists and its module supports `createIndex`
2. Rejects the name if it is taken on this table — by a materialized `IndexSchema` or by a UNIQUE constraint's implicit covering structure (`IF NOT EXISTS` skips instead) — or, unsuppressibly, by a user index on another table in the schema
3. Builds `IndexSchema` from column references
4. Delegates to `module.createIndex()`
5. Appends the index to the table's schema
6. Emits `table_modified` change event

#### `dropTable(schemaName, tableName, ifExists?): Promise<boolean>`

Drops a table:
1. Removes the table from the schema
2. Emits `table_removed` change event
3. Awaits `module.destroy()` when supported, so callers see fully torn-down storage before the promise resolves

Returns `true` if the table was removed. With `ifExists`, returns `false` silently when not found.

When `pragma foreign_keys` is on, the drop is gated by a referencing-child scan (a non-NULL FK row in any *other* table forbids it; self-FK rows go away with the table), routed through the **reverse foreign-key index** rather than a whole-catalog walk — see below.

#### Reverse foreign-key index

`getReferencingForeignKeys(parentSchemaName, parentTableName)` returns the FKs that reference a given parent `schema.table` — the shared primitive every parent-side referential scan short-circuits on. It is a lazily-built, event-invalidated derived cache on `SchemaManager`: a `Map` from the **referenced** `schema.table` (lowercased, resolved as the scans compute their target, `fk.referencedSchema ?? childTable.schemaName` — so a declared FK keys under its **parent's** schema: the explicit `references <schema>.<table>` qualifier when one was written, else the child's own schema) to the `{ childTable, fk }` entries that reference it. A table nothing references yields a shared frozen empty array — the O(1) gate replacing an `O(tables × FKs)` catalog walk; the returned `fk` is the object held in `childTable.foreignKeys` (identity preserved). Entries stay in schema-insertion → table → FK-declaration order, so a first-surviving-child RESTRICT pre-check names the same child the nested-loop scan did.

The cache is `null`ed (rebuilt from the live catalog on next access) on every mutation that can add/drop/retarget an FK or add/remove a schema: a self-subscription to the `SchemaChangeNotifier` resets it on any `table_added` / `table_modified` / `table_removed` (the only events an FK enters/leaves/retargets through — create-with-references, ALTER ADD/DROP CONSTRAINT, a parent/column-rename FK rewrite, DROP TABLE), and `addSchema` / `getOrCreateSchema` / `removeSchema` reset it directly since ATTACH/DETACH fire no event. The silent catalog-rehydration path nulls it directly too: `importTable` registers FK-bearing tables without firing `table_added` (and `getOrCreateSchema` only resets when it *creates* a schema), so a re-import onto an already-built index would otherwise under-report. Under-reporting would silently drop enforcement, so invalidation is deliberately broad; over-reporting a since-dropped FK is harmless, since the index key enforces the `referencedTable` / target-schema match (consumers that route through it therefore dropped those two filters) and each per-FK body still re-checks arity, its action gate, and the MATCH-SIMPLE NULL skip. The lazy first-access rebuild after a (rare) DDL amortizes across the many DML writes between DDLs.

#### Lens basis-FK gate

The **logical-FK analogue** of the reverse-FK index. A *logical* FK lives only on a child lens slot's `enforced-fk` obligation, on no basis table, so it is invisible to the reverse-FK index, which scans declared `TableSchema.foreignKeys`. Three basis-keyed lens FK paths reverse-map a written **basis** parent table to the logical parent slot(s) it backs, then walk every schema's lens slots for referencing logical FKs: the cascade walker `executeLensForeignKeyActions`, the RESTRICT pre-check `assertLensRestrictsForParentMutation`, and the divergent-basis-action suppression set `basisFksOverriddenByDivergentLensFk`. The gate gives all three the O(1) short-circuit the index gives the physical paths.

`basisTableBacksLogicalParentFk(schemaName, tableName)` answers: does this basis `schema.table` back ≥1 logical parent slot referenced by ≥1 logical FK? It is a lazily-built, event-invalidated derived `Set<string>` on `SchemaManager` keyed by the **basis parent** `schema.table` (lowercased) — the value each basis write carries. `buildLensBasisFkGate` (in `lens-fk-discovery.ts`) builds it by running once the same reverse-map slot scan the three paths perform per write: for each lens slot, resolve its single basis spine (`resolveSlotBasisSource`; a multi-source / decomposition parent resolves to none and contributes no key — *consistently* with the runtime `if (!basis) continue` skip), and add the basis key iff `findLogicalParentFkRefs(slot).length > 0`. A `false` answer early-returns each path; a `true` answer runs the full scan as confirmation.

The gate is `null`ed (rebuilt on next access) on every event that can change that scan's result, across **two** dependencies — the lens-slot set and the basis-table catalog (`resolveSlotBasisSource` resolves a bare table name against it):

- **Lens deploy / redeploy** — the slots are mutated only by `lens-compiler.deployLogicalSchema`'s clear-and-rebuild, which fires **no** `SchemaChangeEvent` (there is no lens event in the union), so it calls `invalidateLensFkGate()` directly.
- **Basis-table catalog** — the `SchemaChangeNotifier` self-subscription that resets the reverse-FK index also resets the gate on `table_added` / `table_modified` / `table_removed` (a basis table created *after* the gate was built is the under-report vector; a drop or column-rename can change which slot resolves to which basis).
- **Schema attach/detach + reset + silent import** — `addSchema` / `getOrCreateSchema` / `removeSchema` / `clearAll` (ATTACH/DETACH/reset fire no event) and the silent `importTable` rehydration path all null the gate alongside the reverse-FK index.

Invalidation is exhaustive for the index's reason, and **sharper**: a stale gate that **under-reports** would silently drop logical enforcement (cascade not propagated / RESTRICT not enforced / divergent basis action not suppressed). Built from — and reset alongside — the same catalog state the three paths scan, the gate **never under-reports** for the current catalog; over-reporting (a stray key ⇒ an on-hit scan that finds nothing) is harmless. The gate is action-agnostic (keyed on *any* referencing logical FK), so a slot referenced only by a RESTRICT logical FK hits for all three paths; each then filters by action in its own body — an over-report that is correct, not a miss.

#### `dropView(schemaName, viewName): boolean`

Removes a view definition from the schema.

#### `defineTable(definition: TableSchema): void`

Programmatic alternative to `CREATE TABLE` — registers a `TableSchema` directly in the `main` schema. A `Database`-level method (not SchemaManager), for a `TableSchema` obtained by parsing or built programmatically. Only the `main` schema is supported; throws `MisuseError` for others.

```typescript
db.defineTable({
  name: 'metrics',
  schemaName: 'main',
  columns: [ /* ... */ ],
  primaryKey: [ /* ... */ ],
  vtabModule: myModule,
  vtabModuleName: 'memory'
});
```

#### `clearAll()`

Clears all tables, functions, and views from all schemas. Does not call module disconnect/destroy.

### Virtual Table Modules

| Method | Description |
|--------|-------------|
| `registerModule(name, module, auxData?)` | Registers a virtual table module by name. Replaces any existing module with the same name |
| `getModule(name)` | Retrieves a registered module and its auxData |
| `setDefaultVTabModuleName(name)` | Sets the module used when `USING` is omitted in `CREATE TABLE`. Defaults to `'memory'` |
| `getDefaultVTabModuleName()` | Returns the current default module name |
| `setDefaultVTabArgs(args)` | Sets default module arguments (key-value) |
| `getDefaultVTabModule()` | Returns `{ name, args }` for the default module |

### Catalog Import

#### `importCatalog(ddlStatements, options?): Promise<{ tables: string[]; indexes: string[]; views: string[]; materializedViews: string[] }>`

Imports existing schema objects without creating new storage — used when connecting to a backend that already holds data. For each DDL statement:
- `CREATE TABLE` calls `module.connect()` instead of `module.create()`
- `CREATE INDEX` registers the index metadata without calling `module.createIndex()`, reconstructing it with full fidelity from the re-parsed DDL — the `UNIQUE` flag, the partial `WHERE` predicate, and per-column collation (including the collate-wrapped column form the parser folds `COLLATE` into). A `CREATE UNIQUE INDEX` also re-synthesizes its `derivedFromIndex` UNIQUE constraint, as the live create path does.
- `CREATE VIEW` registers a plain view **without planning the body** — validation is deferred to first reference (as `importTable` defers create-time work via `connect`). View rehydration is therefore order-independent: a view over another view, a materialized view, or a not-yet-imported relation registers regardless of phase order, and a broken body surfaces only when the view is queried. The imported view name appears in the `views` result array.
- `CREATE MATERIALIZED VIEW` **re-materializes** through the same `materializeView` core the create emitter uses (`runtime/emit/materialized-view-helpers.ts`): the body is re-planned against the already-imported sources, the maintained table is rebuilt and filled **in the declared `USING <module>(...)` backing-host module** (memory when the clause is absent; an unknown or capability-less module fails the entry), and row-time maintenance is re-registered — but no `materialized_view_added` fires (`table_added` for the maintained table still does, as on create). A pre-existing **derivation-less** table at the MV's **own name** in the entry's backing module (a durable module's phase-1 rehydration) is **adopted** when the options below allow and every adopt gate passes, otherwise dropped and refilled from the body; a table there in a **different** module — or a maintained table already at the name — fails the entry without touching it. Unlike a plain view the body plans **eagerly** (the table cannot fill without running it), so MV import is order-dependent: sources, including another maintained table for MV-over-MV, must already be registered. A body that cannot plan, reads a still-pending maintained table (`pendingDerivations` below), fills with duplicate keys ("must be a set"), or fails the row-time eligibility gate throws after the half-built table is rolled back (a trusted pre-existing backing is instead preserved as a plain table — durable rows are not destroyed on a per-entry error). The imported MV name appears in the `materializedViews` result array.
- Schema change events are not emitted (these are existing objects)

**Options** (`ImportCatalogOptions`) — all default off; a plain `importCatalog(ddl)` always refills:
- `trustBackings` — caller-attested trust in pre-existing durable backings: the caller asserts no crash since they were last written (the store module sets this from its consumed clean-shutdown catalog marker). This is adopt gate 5; the full gate set and its rationale live in [`docs/mv-backing-host.md` § Cross-module atomicity](mv-backing-host.md#cross-module-atomicity).
- `adoptedBackings` — a shared `Set<string>` of lowercased qualified names (`schema.<table>`) of every maintained table adopted so far this rehydration session. An MV whose body reads another maintained table adopts only when that upstream is in the set — pass ONE set across all of the session's `importCatalog` calls so trust composes through fixpoint rounds.
- `pendingDerivations` — lowercased qualified names of maintained tables whose own `create materialized view` entries have NOT yet imported this session. An entry whose body reads one is deferred (throws, retried in a later fixpoint round): the source already exists as a *plain* pre-rehydrated table, so the body would plan — and adopt/refill against content the upstream's own import may be about to replace.

Each entry in `ddlStatements` may hold **more than one** statement: a table can be bundled with its `CREATE INDEX`es in one string, imported in document order (table before indexes). Single-statement entries remain valid. Any unsupported statement type throws (fail-loud), so the store's `rehydrateCatalog` records the failure rather than silently dropping the object.

### DDL Generation

> **Invariant:** [SCH-002](invariants.md#sch-002--the-per-column-primary-key-flags-mirror-primarykeydefinition)

Canonical schema → DDL generators are exported from the package entry point:

```typescript
import { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaterializedViewDDL, generateIndexTagsDDL } from '@quereus/quereus';

const ddl = generateTableDDL(tableSchema, db?);                  // CREATE TABLE ...
const idxDdl = generateIndexDDL(indexSchema, tableSchema, db?);  // CREATE INDEX ...
const viewDdl = generateViewDDL(viewSchema);                     // CREATE VIEW main.v ...
const mvDdl = generateMaterializedViewDDL(maintainedTable);      // CREATE MATERIALIZED VIEW main.mv ...
const tagDdl = generateIndexTagsDDL(schemaName, indexName, tags); // alter index s.i set tags (...)
```

`generateViewDDL` / `generateMaterializedViewDDL` lift the stored schema back into the equivalent `CreateView` / `CreateMaterializedView` AST and render it through the shared `ast-stringify` emitter (the same schema→AST-lift `generateTableDDL` uses for constraints), so the persistence path and the declarative AST→SQL path cannot drift. They emit a **fully-qualified** (`schema.name`) name so a re-parse registers into the correct schema regardless of the session's current schema, and read the **live** `tags`, so an `ALTER VIEW … SET TAGS` (which swaps the in-memory schema without rewriting the stored `sql`) round-trips. `generateMaterializedViewDDL` takes the maintained `TableSchema` and re-derives the `USING <module>(...)` clause from its own `vtabModuleName`/`vtabArgs` through `normalizeBackingModule`, which yields a clause only for a non-default hosting module (`using memory()` with no args normalizes to nothing, keeping the memory default clause-free and canonical); on reopen the import path honors the clause and rebuilds the table in the named module. Both are a `parse → generate → parse` fixed point.

Both generators accept an optional `Database` argument for session context; emission depends on whether `db` is supplied:

| Aspect | With `db` | Without `db` |
|--------|-----------|--------------|
| Schema qualification | Elided when it matches `db.schemaManager.getCurrentSchemaName()` | Always qualified (`"schema"."name"`) |
| Column nullability | Only the annotation that differs from `default_column_nullability` is emitted | Every column is explicitly annotated (`NULL` or `NOT NULL`) |
| `USING <module> (...)` | Elided when both module and args match `default_vtab_module` / `default_vtab_args` | Always emitted for any `vtabModuleName` |

Use the no-`db` form when persisting DDL, so the output survives re-parsing under any session's `default_column_nullability`; use the with-`db` form for readable display or same-session round-trip.

Feature coverage (both forms): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), non-default column `COLLATE <name>` (the default `BINARY` is elided, so a `COLLATE NOCASE` column survives a persistence re-parse rather than reverting to `BINARY`), `DEFAULT <expr>`, `USING <module>` with SQL-literal args, and `WITH TAGS (...)` at table, column, and index levels.

**Collation does NOT elide the session default.** The column-`COLLATE` emitter elides only a *literal* `BINARY` — never the session `default_collation`, a deliberate contrast with nullability / `USING`, which DO elide theirs. The `default_collation` pragma (see `docs/sql.md` § 9.2.4) is a **create-time authoring convenience only**: it sets the collation an omitted-`COLLATE` column resolves to at `CREATE TABLE` time (text types only; non-text and JSON/temporal fall back to `BINARY`), while the catalog stores the concrete resolved collation and persisted DDL always carries an explicit `COLLATE` for any non-`BINARY` one. So a `NOCASE` column authored under `default_collation = 'nocase'` round-trips unambiguously under a different default. The rehydrate path (`SchemaManager.importTable`) resolves omitted-`COLLATE` columns to canonical `BINARY` — it does **not** read the live pragma — relying on this non-elision to make the persisted `COLLATE` the single source of truth. The declarative differ resolves the declared side's omitted `COLLATE` by the **same** create-time rule (threading the live `default_collation`), so a fresh `apply` matches direct DDL and a re-apply stays idempotent (no spurious `SET COLLATE`). `ALTER TABLE ... ADD COLUMN` likewise honors `default_collation` (non-text falls back to `BINARY`), and the differ emits an explicit resolved `COLLATE` on added columns so a migration authored under one default lands the same collation under any other. `RENAME COLUMN` deliberately does **not** consult the default: its AST is reconstructed from the live column (carrying an explicit `COLLATE` only for a non-`BINARY` collation), so a renamed column preserves its existing collation — threading the default there would silently flip an existing `BINARY` column to the session default.

`generateIndexDDL` emits a **lossless** `CREATE INDEX`: `CREATE [UNIQUE] INDEX <name> ON <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]`. The `UNIQUE` keyword and partial `WHERE` clause are reconstructed on import, so a `CREATE UNIQUE INDEX` / partial index round-trips without degrading to plain/full. Clause order matches the parser grammar and the AST emitter `createIndexToString` (columns → `WHERE` → `WITH TAGS`), so re-parsing yields the same shape and the declarative differ (which matches indexes by name) does not churn. A UNIQUE index's derived constraint round-trips via the index statement itself: `generateTableDDL` omits any `derivedFromIndex` UNIQUE constraint from the table DDL, avoiding a double definition.

A **synthesized all-columns key** (a table with no declared PRIMARY KEY) emits **no** `PRIMARY KEY` clause, inline or table-level. Naming it would make a re-parse treat it as an *explicitly-declared* PK, forcing its columns NOT NULL and silently dropping a nullable declaration on a persistence round-trip; omitting it lets the re-parse re-synthesize the same key while preserving each column's declared nullability.

`@quereus/store` re-exports these symbols for backward compatibility:

```typescript
import { generateTableDDL } from '@quereus/store';
```

### Store catalog persistence

How `@quereus/store` durably persists table, index, constraint and tag state — the
bundled `CREATE TABLE` + index DDL catalog entry, its rehydration, and the rename
protocol that orders those writes — lives in
[store.md § Catalog persistence](store.md#catalog-persistence-bundled-index-ddl).

### View and materialized-view persistence

How `@quereus/store` persists engine-level views and materialized views — the reserved-prefix
catalog keys, the schema-change subscription that writes them, the
`assertCatalogObjectPersistable` pre-flight veto, and the phased rehydrate that imports them —
lives in [view-persistence.md](view-persistence.md).

## Schema Path

The schema path controls search order for unqualified table names. `Database`-level methods:

| Method | Description |
|--------|-------------|
| `db.setSchemaPath(paths: string[])` | Sets the schema search order. Equivalent to `pragma schema_path` |
| `db.getSchemaPath(): string[]` | Returns the current schema search path as an array of schema names |

```typescript
db.setSchemaPath(['main', 'extensions', 'plugins']);
const path = db.getSchemaPath(); // ['main', 'extensions', 'plugins']
```

Note the deliberate asymmetry with DDL: unqualified DDL lands objects in the **current schema** (`schemaManager.setCurrentSchema(name)`, API-only), but unqualified read resolution consults only the schema path (default `main`, then `temp`) — never the current schema. An embedder setting a non-`main` current schema should set the schema path to match, or qualify references; see [SQL Reference § Schema Search Path](sql-select.md#211-schema-search-path-with-schema).

**Stored bodies resolve against their home schema.** A view or materialized-view body resolves its unqualified names against the *owning object's* schema first, then the database default path — independent of the referencing statement's path (a statement-level `with schema` never leaks into a stored body). This holds for reads and for write-through alike: an `insert` / `update` / `delete` through a view re-plans the body on the home path, so a write binds the same base tables the matching read does (see [View Updateability § Schema resolution during write-through](view-updateability.md)). So a view declared next to its tables in a non-`main` schema works under any session path, and `refresh materialized view` does not depend on the path at refresh time. An integrity assertion follows the same rule: it belongs to a schema (unique per schema, created/dropped by possibly-qualified name), and its stored CHECK body resolves unqualified table names against the assertion's own schema first — at create time, at commit-time enforcement, and in `explain_assertion`. CHECK-constraint and foreign-key bodies follow the same owner-first principle, but more strictly: they resolve against the owning table's schema *only*, with no default-path fallback.

See the [Usage Guide](usage.md) for the consumer-facing declarative schema workflow, schema path resolution order, and `PRAGMA schema_path` syntax.

## Database Options Affecting Schema

`db.setOption()` / `db.getOption()` control several schema-related behaviors:

| Option | Effect |
|--------|--------|
| `schema_path` | Default search order for unqualified table names |
| `default_column_nullability` | Column nullability default — `'not_null'` (Third Manifesto default) or `'nullable'` |

See the [Usage Guide](usage.md) for the full options and pragmas reference.

## Schema Change Events

The `SchemaChangeNotifier` (via `schemaManager.getChangeNotifier()`) is a typed event system for observing schema mutations.

### Subscribing

```typescript
const notifier = db.schemaManager.getChangeNotifier();

const unsubscribe = notifier.addListener((event) => {
  // event.type, event.schemaName, event.objectName,
  // and (per type) event.oldObject / event.newObject
});

unsubscribe();   // when done
```

### Event Types

The `SchemaChangeEvent` discriminated union includes:

| Event Type | Payload | When |
|------------|---------|------|
| `table_added` | `newObject: TableSchema` | After `createTable` |
| `table_removed` | `oldObject: TableSchema` | After `dropTable` |
| `table_modified` | `oldObject`, `newObject: TableSchema` | After `createIndex` or table alteration |
| `function_added` | `newObject: FunctionSchema` | After function registration |
| `function_removed` | `oldObject: FunctionSchema` | After function removal |
| `function_modified` | `oldObject`, `newObject: FunctionSchema` | After function replacement |
| `assertion_added` | `newObject: IntegrityAssertionSchema` | After `CREATE ASSERTION` |
| `assertion_removed` | `oldObject: IntegrityAssertionSchema` | After `DROP ASSERTION` |
| `assertion_modified` | `oldObject`, `newObject: IntegrityAssertionSchema` | After assertion replacement |
| `view_added` | `newObject: ViewSchema` | After `CREATE VIEW` (fired from the runtime emitter, not `Schema.addView`) |
| `view_removed` | `oldObject: ViewSchema` | After `DROP VIEW` |
| `view_modified` | `oldObject`, `newObject: ViewSchema` | After `ALTER VIEW … SET TAGS`, or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent view body or its `with defaults` clause (which rides inside the body select, so the body rewrite covers it) |
| `materialized_view_added` | `newObject: TableSchema` (the maintained table) | After `CREATE MATERIALIZED VIEW`; also under the new name when `ALTER TABLE … RENAME TO` re-keys a maintained table |
| `materialized_view_removed` | `oldObject: TableSchema` (the maintained table) | After `DROP MATERIALIZED VIEW` — or `DROP TABLE` on a maintained table (one record, one drop); also under the old name on a maintained-table rename |
| `materialized_view_modified` | `oldObject`, `newObject: TableSchema` (the maintained table) | After `ALTER MATERIALIZED VIEW … SET TAGS` (catalog-only, no re-materialize), or when an `ALTER TABLE/COLUMN RENAME` rewrites a dependent MV body or its `with defaults` clause |
| `materialized_view_refreshed` | `object: TableSchema` (the maintained table) | After `REFRESH MATERIALIZED VIEW` |
| `module_added` | _(name only)_ | After module registration |
| `module_removed` | _(name only)_ | After module removal |
| `collation_added` | _(name only)_ | After collation registration |
| `collation_removed` | _(name only)_ | After collation removal |

All events carry `schemaName` and `objectName` fields. **Naming contract:** events fire the *stored* names of the swapped object — `schemaName` is the canonical (lowercase) schema name (canonicalized on tables/views/MVs at create/import time via `SchemaManager.canonicalSchemaName`), and `objectName` is the object's stored display casing, never the raw spelling from the triggering statement. Prepared statements rely on this: `Statement.compile()` invalidates its cached plan by comparing recorded dependencies (which carry stored names) against event names **exactly**, so a raw-cased name on either side would silently miss invalidation. The same stored-name guarantee holds for the **module-facing calls** the SchemaManager makes (`create`, `connect`, `createIndex`, `dropIndex`, `destroy`, `alterTable`, `renameTable`, …) — see [module authoring § Identifier casing in module-facing calls](module-authoring.md#identifier-casing-in-module-facing-calls).

Listener errors are caught and logged — a failing listener does not disrupt other listeners or the originating operation.

### Database-Level Events

The higher-level `db.onSchemaChange()` API aggregates schema events from all modules: a module with native event support emits its own; for others `SchemaManager` emits synthetic events. See the [Usage Guide](usage.md) for the database-level event API.

## Error Handling

Schema operations throw `QuereusError` with these common status codes:

| Code | Scenario |
|------|----------|
| `StatusCode.ERROR` | Module not found, schema not found, invalid DDL, module create/connect failure |
| `StatusCode.CONSTRAINT` | Table or index already exists (without `IF NOT EXISTS`), multiple primary key definitions |
| `StatusCode.NOTFOUND` | Table not found during `dropTable` (without `ifExists`) |
| `StatusCode.INTERNAL` | Module did not return a `tableSchema` after create, unexpected removal failure |
| `StatusCode.MISUSE` | Invalid argument format (e.g. non-object JSON for default vtab args) |

Errors carry source location (`line`, `column`) when the AST node has it. See [Error Handling](errors.md) for the full error model.

## Declarative Schema

The `declare schema` / `diff schema` / `apply schema` workflow provides order-independent, end-state schema declarations: the engine diffs against the current catalog (`computeSchemaDiff`) and generates migration DDL (`generateMigrationDDL`). Key diff types:

- `SchemaDiff` — tables/views/indexes/assertions to create, drop, alter, or rename
- `TableAlterDiff` — columns to rename, add, alter, or drop within an existing table; named-constraint rename / drop / add (`constraintsToRename` / `constraintsToDrop` / `constraintsToAdd`)
- `ColumnAttributeChange` — per-column attribute drift within `columnsToAlter`: nullability, data type, default, **collation**, and tags. Each surfaces as the matching `ALTER COLUMN … SET …` statement. Column collation is projected into the diff catalog (`CatalogTable.columns[].collation`, default `'BINARY'`) so the differ detects a `COLLATE` change as it does a type or default change; an absent `COLLATE` and an explicit `COLLATE BINARY` compare equal (no spurious diff). Unlike tags, collation is **behavioral** and participates in the schema hash.

- `SchemaDiff.maintainedModuleMigrations` — backing-module moves on maintained tables (a declared `using <module>(args)` change on a `materialized view` / `create table … maintained as`). Each is realized as a **destructive drop+recreate** (the DROP rides `tablesToDrop`; the recreate, which re-materializes the body into the new module, rides `tablesToCreate`), minting a new incarnation. Surfaced unconditionally by `diff schema`; **gated** at `apply schema` on `allow_destructive` (see below). See [Materialized Views § Declarative-schema integration](materialized-views.md#declarative-schema-integration).

Destructive changes require explicit acknowledgement. The maintained-table backing-module move is the one case currently **enforced**: `apply schema` aborts (before any DDL runs) unless re-run with `options (allow_destructive = true)`, since the new incarnation changes row identity for a replicated/synced table. See the [SQL Reference](sql-ddl.md#20-declarative-schema-optional-order-independent) for the full gating contract and syntax.

Direct `create table` / `create view` DDL and the corresponding `declare schema` + `apply schema` body are guaranteed to produce indistinguishable catalogs and runtime behaviour.

### Logical schemas and lenses

`declare logical schema X { ... }` declares a design-only schema (`kind: 'logical'`) — columns and *logical* constraints, no module / index / storage. At `apply schema X` the lens compiler aligns each logical table against a basis schema and registers an inlined effective view body, so reads ride the standard view path and writes ride [view updateability](view-updateability.md).

`declare lens for X over Y { view T as <select> ... }` is a **sibling statement** (parsed to `DeclareLensStmt`, stored on `DeclaredSchemaManager` keyed by the logical schema name) that binds logical schema `X` to an **explicit basis** `Y` and supplies per-table sparse overrides:

```sql
declare logical schema X { table Car (id int primary key, maxSpeed int, color text); }
declare lens for X over Y {
  view Car as select id, speed as maxSpeed from Y.CarCore;   -- rename; color gap-filled
}
apply schema X;
```

The override projection covers some columns (by output name); the default mapper gap-fills the rest from the override's `FROM`, and every logical column must end up mapped (an uncovered column the basis cannot back is a compile error). `over Y` is the explicit basis, resolving the auto-inference ambiguity with multiple physical bases. Inspect the composed result with `quereus_effective_lens(schema, table)`. See [Lenses and Layered Schemas](lens.md) for the full model — the name-based / re-read-from-source merge and the gap-fill fidelity boundary.

#### Acknowledging lens advisories (`quereus.lens.ack.*` / `quereus.lens.policy.*`)

At `apply schema X` the lens prover emits **coded, sited advisories** (`lens.no-backing-index`, `lens.no-answering-structure`, `lens.partial-override`, `lens.getput-lossy`) onto the deploy report. A developer accepts one in source with a reserved tag on the logical table (or a constraint), so the suppression is version-controlled and reviewable rather than an out-of-band suppress-list:

```sql
declare logical schema X {
  table Car (id int primary key, vin text, unique (vin))
    with tags (
      -- acknowledge the no-backing-index advisory for the vin constraint:
      "quereus.lens.ack.no-backing-index:vin" = 'low-write table; commit-time scan accepted',
      -- (optional) force a conscious decision on that code for this table:
      "quereus.lens.policy.require-ack" = 'lens.no-backing-index'
    );
}
```

- **`quereus.lens.ack.<code>[:<target>]`** — acknowledges the advisory whose `<code>` (the `lens.`-stripped advisory code) it names; the optional `:<target>` narrows to a column/constraint. The value is a **required rationale**; an empty rationale still suppresses but surfaces an empty-rationale meta-warning on the report. A trailing `#fp=<digest>` token records the advisory's fingerprint (it round-trips through DDL export) so the advisory **re-surfaces** when the underlying facts change; a bare rationale, with no `#fp=`, is honored unconditionally.
- **`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`** — a per-logical-table escalation policy (CSV of advisory codes, **default-empty**). `error-on` codes are always hard errors an ack cannot suppress; `require-ack` codes are hard errors only when *un*-acknowledged (a valid ack clears them). Escalation errors abort the deploy atomically alongside the prover's blocking errors.

The deploy summary tallies `acknowledged: N` (`LensDeployReport.acknowledged.length`); `select * from quereus_lens_advisories('x')` expands the full list — one row per advisory with its `status` (`active` / `re-surfaced` / `acknowledged` / `acknowledged-unconditional`), rationale, and current/recorded fingerprints. All `quereus.lens.*` tag shape/site validation lives in the typed registry `src/schema/reserved-tags.ts`. For the governance model — which facts each fingerprint covers, the cardinality bands, and the full status semantics — see [Lenses and Layered Schemas](lens.md).

### Migration Order

`generateMigrationDDL` produces DDL in a fixed order:

1. **Renames first** — `ALTER TABLE ... RENAME TO` for **tables** with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents. Hinted **view / index** renames emit no DDL here (no rename primitive exists) — they are realized as drop(old) + recreate(declared) in the phases below; the non-table `RenameOp`s on `SchemaDiff.renames` are metadata only.
2. **Drops second** — `DROP TABLE`, `DROP VIEW`, `DROP INDEX` for objects neither declared nor consumed by a rename.
3. **Creates third** — `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX` for new objects.
4. **Alters last** — within each `TableAlterDiff`: `RENAME COLUMN` first (so subsequent phases see post-rename names), then `ADD COLUMN`, `ALTER COLUMN`, then the **constraint lifecycle** — `RENAME CONSTRAINT` then `DROP CONSTRAINT` (free / remove a name before any re-add, and drop a UNIQUE before the PK change so it can't strand a PK dependency) — then `ALTER PRIMARY KEY`, then `ADD CONSTRAINT` (after the PK change and the column adds it may reference), then `DROP COLUMN` last, then the tag-drift `SET TAGS` phase.

This ordering frees dropped tables' names before creates run, and makes forward references between tables (e.g. FKs to later-declared tables) work, since declarations are order-independent. A constraint `ADD` lands after all `CREATE TABLE`s, so a declared FK added to an existing table can reference a freshly-declared parent.

### Rename Detection

`computeSchemaDiff(declared, actual, policy?)` accepts an optional `RenamePolicy` (`'allow' | 'require-hint' | 'deny'`, default `'allow'`):

- Under `'allow'`, declared objects whose name doesn't match an actual object are tested for `quereus.id` then `quereus.previous_name` matches against the catalog. A hit emits a `RenameOp` and consumes the actual so it isn't dropped.
- Under `'require-hint'`, any unhinted name change is rejected: if the diff produces both a drop and a create of the same kind (table, view, index), `computeSchemaDiff` throws.
- Under `'deny'`, hints are ignored entirely — every mismatch becomes drop+create.

Conflicts (declared name and hint resolving to two distinct existing objects) always throw, independent of policy beyond `'deny'`.

The same resolution runs at column granularity inside `computeTableAlterDiff` and at named-constraint granularity. Column renames emit `ALTER TABLE ... RENAME COLUMN`; named-constraint renames emit `ALTER TABLE ... RENAME CONSTRAINT` (CHECK / UNIQUE / FOREIGN KEY). View and index renames have no engine-level primitive: a hinted (rename-matched) view/index resolves to drop(actual old name) + recreate(declared new name) from the view/index buckets, definition changed or not. A definition-unchanged rename's recreate is rendered with the same diff's COLUMN renames inverse-applied NEW→OLD (creates run before `RENAME COLUMN` in migration order, and the live rename propagation then rewrites the freshly created body so the re-diff converges) while keeping declared TABLE names (table renames run first); an index rebuild on a pure rename is the accepted cost. These deliberate drop+create pairs are excluded from the `require-hint` counts, as are the body-change recreates below.

Alongside renames, `computeTableAlterDiff` resolves the full **named-constraint lifecycle** by name: a user-named constraint in the catalog but absent from the declaration (and not consumed by a rename) → `TableAlterDiff.constraintsToDrop` → `DROP CONSTRAINT`; a declared user-named constraint absent from the catalog (and not a rename target) → `TableAlterDiff.constraintsToAdd` → `ADD <fragment>`. Declared constraints are gathered from **both** the table-level `constraints` list and explicitly-named column-level constraints (`qty int constraint chk_qty check (qty > 0)`), matching what the catalog's `namedConstraints` surfaces. Only **user-named** constraints participate — engine-synthesized auto-names (`_check_*` / `_fk_*` / `_uc_*`), PRIMARY KEY (handled by `primaryKeyChange`), and `derivedFromIndex` UNIQUE constraints (managed through their index) are excluded, keeping the diff stable/idempotent for unnamed and index-derived constraints. Under `require-hint`, a constraint add **and** drop on the same table with no rename hint is rejected, mirroring the table/column guard.

`ADD CONSTRAINT` routes all three classes through module `addConstraint`, which the memory and store modules implement (a CHECK on a module that omits `alterTable` keeps an engine-side fallback) — routing CHECK through the module too keeps the module-cached schema in lock-step with the catalog so a later `DROP/RENAME CONSTRAINT` resolves it. UNIQUE / FOREIGN KEY adds **re-validate the existing rows** and fail atomically with `CONSTRAINT` (schema unchanged) when current data violates the new constraint, otherwise installing forward enforcement; a CHECK add is a schema-only append (no existing-row scan), enforced going forward. So a declarative add of a named UNIQUE / FK to an existing table **converges** (a second apply is a no-op). FK existing-row validation is gated by `pragma foreign_keys` (off ⇒ the add skips the scan and defers enforcement to later writes); the store's UNIQUE existing-row check honors each constrained column's per-column collation (`BINARY`/`NOCASE`/`RTRIM`), so a UNIQUE add — and the `CREATE UNIQUE INDEX` and `ALTER COLUMN … SET COLLATE` existing-row scans, which share the same `serializeRowKey` signature — correctly rejects pre-existing rows that collide only under that collation. (A *comparator-only* collation, registered with no `normalizer`, cannot bucket rows and so raises at ALTER/add time rather than under-rejecting.)

#### Constraint body-change detection (drop+recreate)

A constraint whose **name is unchanged but whose body changed** — an edited CHECK expression, a changed FK action / referenced table / columns, a changed UNIQUE column set or `ON CONFLICT` — is realized as **drop-old + add-new** (there is no in-place "redefine" primitive). For **UNIQUE / FOREIGN KEY** the re-add re-validates existing rows against the new rule (a violating row aborts the apply with `CONSTRAINT`, schema unchanged); for **CHECK** the re-add is **forward-enforcing only** and does **not** re-validate existing rows (a limitation of the CHECK add path — the module `addConstraint` CHECK arm and its engine-side fallback `runAddCheckEngineSide` in `runtime/emit/add-constraint.ts`), so a violating pre-existing row is not re-checked until its next write. The two statements (DROP then ADD) are **not atomic** on the memory backend: a failed re-add leaves the old constraint already dropped — the guarantee is "apply aborts + data survives", not "old constraint restored".

**Rename reconciliation (no redundant drop+recreate).** The `definition` is rendered with the *current* names on the actual side and the *declared* names on the declared side, so a name-matched constraint whose body differs *only* because of an identifier renamed in the **same** diff would naively register as a body change. To avoid a redundant drop+recreate on top of the rename, `computeTableAlterDiff` first compares the raw `definition` strings (the no-rename case short-circuits) and, on a mismatch, re-compares a **rename-reconciled** declared body from `reconciledDeclaredBody`: a clone of the declared constraint AST with the in-diff renames *inverse*-applied — each renamed identifier rewritten from its new name back to the actual pre-rename name. A CHECK expression reconciles in three ordered passes over the one `cloneExpr` copy:

1. **Every in-diff table rename**, via the runtime `renameTableInAst` — the exact inverse of the forward rewriter the rename migration runs over **all** tables' CHECKs, so the diff-side reconcile and the executed migration cannot drift. Qualified self-references and cross-table subquery references rewrite alike. Sequential application is order-independent because `resolveRenames` makes rename chains/swaps unrepresentable — every new name is absent from the actual catalog while every old name is present — so no rename's inverse output can match another's inverse input.
2. **The owning table's column renames**, via `renameColumnInCheckExpression` seeded with the OLD (actual) table name — correct unconditionally, since pass 1 pre-normalized every qualifier to OLD — and threaded with a **declared-side scope resolver**, the diff-time analogue of the live-catalog `ResolveColumnInSource` hook the forward propagation passes. It answers, from the declared column sets, "does this inner FROM source expose the renamed NEW column name in the *declared* world?", so an unqualified ref that legitimately binds a like-named column on its own subquery FROM is not falsely inverse-captured by the owning seed.
3. **Other tables' column renames**, from the same cross-table pre-resolution map the FK branch uses, via the plain scope-aware `renameColumnInAst` — no seed frame, no resolver, the forward non-owning branch — so an unqualified ref rewrites only when the renamed table sits in an enclosing FROM frame. A CHECK subquery over ANOTHER table's renamed column reconciles instead of churning a drop+recreate.

The two column passes mirror the forward `rewriteTableForColumnRename` branch split, and **their order is load-bearing** (owning first): reversed, the cross-table pass would turn the inner `capacity` back into `cap` in time for the owning inverse to falsely capture it in a compound diff (owning `qty→cap` + referenced `lim.cap→capacity`).

Accepted limitations, all failing safe to a benign — still converging — drop+recreate: cross-schema FROM sources answer `false` from the declared-side resolver (the catalog is single-schema) where the forward path's live lookup could say yes; and pathological rename interleavings (another table's NEW name equal to the owning table's OLD name combined with correlated unqualified refs) retain the scope-naïveté class the forward `renameColumnInAst` documents.

UNIQUE / FK reconcile their column lists directly; an FK also reconciles its referenced *parent table* against the table renames **and** its referenced *parent column* list against that parent's column renames. Both thread in from `computeSchemaDiff` as a one-pass pre-resolution of every name-matched declared table's column renames, keyed by declared (new) table name — the key `foreignKey.table` carries at diff time. So a parent-table rename and a parent-column rename in the same diff reconcile together (resolve the parent's column renames by the new parent name, then rewrite the table name back to old), and a self-referential FK whose referenced column is renamed is covered by the current-table entry. When the reconciled body matches the actual, only the rename emits (metadata-only RENAME COLUMN / RENAME TABLE — no UNIQUE/FK re-validation scan, no non-atomic drop+add); a genuine body edit layered on a rename still differs, preserving the drop+recreate and its RENAME suppression.

**The canonical body fragment.** Each `namedConstraints` entry carries a `definition` — a canonical body fragment excluding the `constraint <name>` prefix and `with tags (...)` suffix — from `ddl-generator`'s `constraintToCanonicalDDL`; the declared side renders the same fragment from its AST via `ast-stringify`'s `constraintBodyToCanonicalString`. One shared normalization makes format/order-stable forms compare byte-equal, collapsing parser-default-equivalent forms so they don't churn: a bare CHECK's default `INSERT|UPDATE` operation mask, a FK's default `RESTRICT` action, an elided referenced-column list, and the default `ON CONFLICT ABORT`. Bare column-name identifiers are **case-folded** (lowercased) throughout — the UNIQUE / PRIMARY KEY column list, the FK local **and** referenced column lists, the FK **referenced (parent) table** name, **and** bare column references inside a CHECK *expression* (a structural `lowerExprIdentifiers` clone that leaves string / blob / numeric / JSON literals, parameters, collation names, and cast/function names byte-exact) — matching Quereus's case-insensitive column resolution. So a case-only divergence never churns a spurious drop+recreate, while a literal-value change is a genuine body edit and still recreates. CHECK subquery bodies (`(select …)` / `exists` / `in (select …)`) pass through structurally rather than being descended into — a bounded limitation, symmetric on both diff sides.

The **FK parent-schema qualifier** is canonicalized symmetrically (`canonicalForeignKeyClause`): rendered **iff** it differs (case-insensitively) from the **child** table's schema. An explicit own-schema qualifier (`references main.t` on a child in `main`) therefore elides to the unqualified form — matching the actual-catalog side — while a genuine **cross-schema** parent survives (case-folded) as a body-change channel. The child schema threads in from `constraintToCanonicalDDL` (actual side, `tableSchema.schemaName`) and from `collectDeclaredNamedConstraints` / `reconciledDeclaredBody` (declared side, the differ's per-schema target); the parent schema is **not** a rename channel (renames are within-schema), so an FK rename reconcile carries it through the clone untouched. Net: an unchanged cross-schema FK does not churn, an own-schema qualifier is equivalent to the bare form, and editing the declared parent schema is detected as a body change.

On drift, `computeTableAlterDiff` pushes the old name to `constraintsToDrop` and the declared fragment to `constraintsToAdd` — the same buckets and `generateMigrationDDL` emission as the add/drop paths, which already order DROP before ADD within the table block. Tags are **excluded from `definition`**, so a tag-only change compares equal and takes the in-place `ALTER CONSTRAINT … SET TAGS` path, never a drop+recreate. A constraint both rename-matched **and** body-changed drops+recreates with the `RENAME CONSTRAINT` suppressed (rename-then-redefine is two ops where drop+recreate is one, and the new body must re-validate regardless); the recreate's `ADD` fragment carries the declared tags, so no separate `SET TAGS` is emitted. Body changes to *unnamed* constraints are not individually addressable (detection keys off names) and are out of scope.

#### Index body-change detection (drop+recreate)

An **index** whose name is unchanged but whose body changed — a flipped `UNIQUE`, an added/removed/reordered column, an `asc`↔`desc` direction flip, or an added/changed/removed partial `WHERE` predicate — is realized as **drop-old + recreate** (an index has no in-place "redefine" primitive). Each `CatalogIndex` carries a `definition`: a canonical **body** string (`[unique ]index (<cols>)[ where <expr>]`) produced by `ddl-generator`'s `indexToCanonicalDDL`, which lifts the stored `IndexSchema` into a minimal `CreateIndexStmt` and renders it through `ast-stringify`'s `createIndexBodyToCanonicalString`; the declared side renders the same function over its AST, so the two are byte-comparable. For a name- or rename-matched index, `computeSchemaDiff` compares the declared body against `matchedActual.definition`; on drift it pushes the actual (pre-rename) name to `SchemaDiff.indexesToDrop` and the declared `create [unique] index …` (with the declared tags) to `indexesToCreate` — `generateMigrationDDL` already orders index drops before creates. A **rename-matched** index with an *unchanged* body takes the same shape, rendered by `columnReconciledIndexStmt`.

What the canonical body covers:

- **Bare column-name identifiers, case-folded** (lowercased) — in the column list and, via the shared `lowerExprIdentifiers` the constraint CHECK path also uses, inside the partial `WHERE` predicate. The actual side lifts the column *definition* case (`tableSchema.columns[i].name`), the declared side the as-written reference case, so a case-only divergence (column `Email` indexed as `email`) does not churn. Predicate literals stay byte-exact: a genuine predicate edit still recreates.
- **Per-column collation**, but only as an already-*resolved* effective value: both sides pre-resolve each column's collation as the engine does at create/import time (explicit index `COLLATE`, else the table column's collation, else `BINARY`; normalized) before rendering — actual side in `indexToCanonicalDDL`, declared side in `schema-differ`'s `declaredIndexCanonicalBody` — so an unchanged inherited / default-`BINARY` collation renders identically (no churn on an inherited-`NOCASE` unique index) while a genuine collation change recreates.
- **Not tags**: a tag-only change takes the in-place `ALTER INDEX … SET TAGS` path, never a recreate — mutually exclusive with a body recreate per index, body drift winning.
- **Not the structural `on <table>` reference**, so a *table* rename alone never churns the column list (indexed columns carry bare names) — simpler than the constraint FK case, which also reconciles a parent table / parent column.

**Concurrent column renames are reconciled** like the constraint path: `declaredIndexCanonicalBody` inverse-applies the index table's in-diff column renames — keyed by the index's *declared* (new) table name, so a table renamed in the same diff still resolves them — to each bare column name in the declared body **and** to each column reference inside the partial `WHERE` predicate (`renameColumnInCheckExpression` over a `cloneExpr` copy). So a same-named index over a column renamed in the **same** diff matches the actual body and emits **only** the `RENAME COLUMN` (no index drop+recreate, so it never trips the `require-hint` index guard), while a genuine body edit layered on the rename still recreates. **Ordering is load-bearing**: the collation is resolved on the **new** (declared) column name *first* — the declared `ColumnDef` is keyed by it — and only then is the emitted name mapped back to its old form; reversed, the lookup would miss.

A partial `WHERE` predicate carrying a **table-qualified** self-reference (`where t.active = 1`) *does* embed the table name, so the predicate takes the constraint CHECK path's pass order: ALL in-diff table renames inverse-rewrite first (`renameTableInAst`), then the per-column rewrites, seeded with the index table's OLD name to match the now-normalized qualifiers. A *cross*-table reference cannot occur — `compilePredicate` rejects subqueries, schema-qualified refs, and any `table` qualifier other than the indexed table, at create time — but the all-renames scope mirrors the forward rewriter regardless. So a pure table rename (with or without concurrent column renames) over a qualified predicate emits only the rename op(s). (Accepted scope-naïveté, symmetric with the forward path: a subquery alias equal to a renamed table's new name can inverse-rewrite, causing a spurious but valid recreate.) A genuine unhinted create+drop of two distinctly-named indexes still trips the `require-hint` guard.

**Implicit covering indexes** (the secondary BTree backing a UNIQUE constraint) never participate in the index buckets — their lifecycle is the originating constraint's, handled by the named-constraint diff path. A **hidden** implicit index (no `quereus.expose_implicit_index`) is absent from `actualCatalog.indexes` entirely, so it never name-matches. An **exposed** one is present for introspection (`schema()` / `index_info()`), but the catalog marks it `CatalogIndex.implicit = true` and `computeSchemaDiff` filters it out of `actualIndexes` before building the rename/create/drop view — so a converged schema with an exposed implicit index diffs **empty**, never emitting a phantom `DROP INDEX IF EXISTS <name>` (and `ALTER INDEX … SET TAGS` on the exposed name routes onto the originating constraint, not the index buckets).

**Primary-key column renames** reconcile the same way (PK changes flow through `primaryKeyChange`, not the named-constraint path). Before comparing the declared PK sequence against the actual key, `computeTableAlterDiff` inverse-applies the in-diff column renames to the declared PK column *names* (reusing `inverseRenameConstraintColumns`), so a pure PK-column rename — already emitted as a metadata-only `RENAME COLUMN` — does not also churn a redundant `ALTER PRIMARY KEY`. Only **this table's own** column renames participate (a PK references only local columns, so no cross-table threading, unlike the FK body case). The reconciliation rewrites **names only**: `pkSequencesEqual` still compares direction, so a genuine `asc`→`desc` change layered on a renamed PK column still emits the PK change; and `primaryKeyChange.newPkColumns` keeps the **new (declared)** names, so a genuine membership/order change ALTERs to the correct post-rename columns. A default-PK table (no explicit `PRIMARY KEY` ⇒ all columns are the key) is covered for free.

#### View / materialized-view definition-change detection (drop+recreate)

A **view** — plain or materialized — whose name is unchanged but whose **definition** changed is realized as **drop-old + recreate** (neither has an in-place "redefine" primitive). The canonical definition covers two parts: the explicit column list (`v(a, b)` — for an MV it also names the maintained table's columns) and the body (`astToString` of the QueryExpr, which carries the trailing `with defaults (col = expr, …)` clause, so a defaults-only edit drifts the string without a separately-itemized part). Name / schema / tags are excluded. One shared renderer — `ast-stringify`'s `viewDefinitionToCanonicalString` — produces it on **both** sides: actual from the live `ViewSchema` / maintained-table `TableDerivation` fields (`CatalogView.definition`), declared from the declared statement's fields. Plain views compare strings; materialized views compare **hashes** — `TableDerivation.bodyHash` is `computeBodyHash` over this same canonical definition, stamped at create (`materializeView`) and re-stamped by the rename-propagation rewrite (`applyMaterializedViewRewrite`), so a clause-only or explicit-columns-only MV change re-materializes exactly as a body change does.

An MV's **backing-module identity** (`using <module>(...)`) is a **separate** compared field, deliberately not folded into `bodyHash` (a formula change would spuriously rebuild every already-persisted MV): both sides normalize the name (absent ⇒ `memory`, `mem` aliased, lowercased) and compare args under a stable-key-order render, so `using memory()` vs an omitted clause never churns while a genuine module or args change takes the body-drift drop+recreate path, re-materializing the backing into the newly declared module. **Rename-coincident module move:** when one apply BOTH renames a maintained table (via a `quereus.previous_name` / `quereus.id` hint) AND moves its backing module, the RENAME op is *preserved* (dependents over the old name retarget through `ALTER … RENAME`) and the module-move's drop is retargeted to the **new** declared name — the rename runs first at apply, so dropping the old name would no-op and the recreate (rendered under the new name) would collide. For a plain name match the two names coincide, so non-rename module moves are unaffected.

**Tags are excluded from the definition**: a tag-only change takes the in-place `ALTER VIEW / ALTER MATERIALIZED VIEW … SET TAGS` path, and a definition recreate carries the declared tags and suppresses any separate `SET TAGS` — mutually exclusive per object, as for indexes/constraints. **No identifier case-folding** is performed — a deliberate asymmetry vs the constraint/index bodies, which fold to avoid *expensive* churn (their recreates re-validate rows / rebuild structures): a case-only edit recreates a plain view (free — data-less) or rebuilds an MV. Both sides render parser-produced ASTs through the one emitter, so keyword case / whitespace cannot churn regardless.

**Concurrent renames are reconciled** like the constraint/index paths: on a raw mismatch only (the converged case short-circuits), `reconciledDeclaredViewDefinition` re-renders the declared definition from a clone with every in-diff table rename inverse-applied NEW→OLD (`renameTableInAst`), then each renamed table's column renames NEW→OLD (`renameColumnInAst` over the body — the body's own FROM provides the scope; the column rewrites are seeded with the table's OLD name since the qualifier pass pre-normalizes). The `with defaults` clause reconciles **for free as part of the body**: it rides inside the select AST (`SelectStmt.defaults`), so the same walk descends `select.defaults` — each entry's `column` target (a base column of the view's FROM table, often projected away) inverse-renames via the same scope-aware synthetic probe a `with inverse` target uses, and each entry's `expr` inverse-renames in the select's FROM scope frame, guarded by the same **declared-side `resolveColumnInSource` resolver** the constraint path's pass 2 threads (the scope walk consults an inner FROM's column sets only when that resolver is supplied). The explicit column list names the view's **own output columns** — stable identity — and passes through untouched. When the reconciled definition matches the actual, only the rename op(s) emit.

For **column renames this is correctness-critical, not just churn-avoidance**: `generateMigrationDDL` emits view creates *before* the table-alter block where `RENAME COLUMN` lives, and `CREATE VIEW` plans its body at create time, so an unreconciled recreate naming the NEW column would fail at apply (whole-TABLE renames are safe — they emit first). A genuine definition edit layered on a rename still recreates; a **rename-matched** view resolves to drop(old) + create(new) either way, the definition-unchanged recreate rendered by `columnReconciledViewStmt` (see [Rename Detection](#rename-detection)). **Residual hazard (known, unsolved):** a *genuine* view/MV definition edit that ALSO references a column renamed in the same diff still emits its CREATE before the RENAME COLUMN and fails at apply — the create-before-alter ordering MV rebuilds have always had; split such a migration into two applies (rename first, then the definition edit).

#### Assertion body-change detection (drop+recreate)

An **assertion** (`create assertion <name> check (<expr>)`) whose name is unchanged but whose CHECK body changed is realized as **drop-old + recreate** — an assertion has no in-place "redefine" primitive, the same shape as the index / view paths above. `CatalogAssertion.definition` carries the canonical CHECK-expression rendering (name, schema qualification, and the `CREATE ASSERTION` framing excluded) produced by `ast-stringify`'s `expressionToString`; `computeSchemaDiff` renders the declared side through the same function, so both sides stringify parser-produced ASTs and keyword case / whitespace can never churn. On drift the actual name goes to `SchemaDiff.assertionsToDrop` and the declared `create assertion …` to `assertionsToCreate`; `generateMigrationDDL` emits **all** assertion drops before every other drop (they may reference tables) and all assertion creates **last** — after the table/view/index creates, after the whole table-alter block, and after the maintained re-attaches. Creates run last because `CREATE ASSERTION` plans its body at build time (see [SQL DDL § 2.6.1](sql-ddl.md#261-createdrop-assertion-global-integrity-constraints)), so a declaration that adds a column and an assertion over that column in one round would fail if the create ran before the `ADD COLUMN`. Nothing in a migration depends on an assertion existing, so last is strictly safer — the body then sees the final shape of every object. An **unchanged** assertion whose body names a table or view this same migration DROPS is force-dropped and recreated around it (the diff checks the declared body against `tablesToDrop` / `viewsToDrop` with the same reference walk): otherwise the runtime drop guard would refuse the `DROP TABLE` and kill the migration. For a table that is dropped and recreated in one migration — a maintained table whose backing module changed — the assertion's target is back by the time the recreate runs; for one that is genuinely removed, the recreate fails loudly instead. Identifier case is **not** folded (the view/MV policy, not the constraint/index one): a case-only edit recreates, which is cheap — an assertion recreate re-plans a query rather than rebuilding a structure or rescanning rows.

Assertions have **no rename support** (the name is explicitly part of the contract — no `quereus.previous_name` hint) and **no rename reconciliation** in the differ. The stored CHECK expression *is* rewritten by `ALTER TABLE … RENAME` (like a view body — see [SQL ALTER § RENAME TABLE](sql-alter.md#27-alter-table-statement)), so the well-formed declarative case converges: `apply schema` runs the rename before the assertion recreate, and the re-diff then compares new-name against new-name. On the *first* diff a table renamed in the same round as an otherwise-unchanged assertion whose declared body already follows the new name still registers as drift and emits a spurious-but-correct drop+recreate — harmless, since assertion creates run after the rename. The converse case — rename the table but leave the declared assertion body on the **old** name — converges the *first* apply (the diff is computed before any DDL runs, so declared and stored still agree, and the `ALTER TABLE … RENAME` then rewrites the stored body onto the new name). A *second* apply of that same stale declaration sees the drift and recreates, and the recreate now **fails** — `Cannot create assertion 'a_t': Table 't' not found` — because `CREATE ASSERTION` validates its body at build time. The apply stops there with the assertion dropped; previously it silently recreated an unresolvable assertion and made every subsequent write in the database fail. Fix the declaration's assertion body to name the new table.

#### Tag-drift detection

`computeTableAlterDiff` also detects **metadata-tag drift** at three sites — the table (`TableAlterDiff.tableTagsChange`), each surviving column (`ColumnAttributeChange.tags`, computed in `computeColumnAttributeChange`), and each name-matched named constraint (`TableAlterDiff.constraintTagsChanges`). The schema hash deliberately excludes tags, so drift is detected **structurally** (an order-independent `stableStringify` compare) rather than via the hash. The rename-hint keys `quereus.id` and `quereus.previous_name` are excluded (they drive rename detection, not data state, so a hint-only declaration does not churn a `SET TAGS` after the rename); all other reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared. `generateMigrationDDL` emits the drift as `ALTER TABLE … SET TAGS (…)` / `ALTER TABLE … ALTER COLUMN … SET TAGS (…)` / `ALTER TABLE … ALTER CONSTRAINT … SET TAGS (…)` **after** the structural ALTER phases, so a tag set lands on the post-rename column / constraint name. These `SET TAGS` mutations are **catalog-only** (in-memory swap plus `table_modified`, no `module.alterTable`), and table / column / named-constraint / index / view / materialized-view tag mutations all survive reconnect for store tables through the store's event subscription — see [Store catalog persistence](store.md#catalog-persistence-bundled-index-ddl). The same in-place catalog path backs the imperative per-key `ALTER TABLE … ADD TAGS` / `DROP TAGS` ergonomics, which the differ never emits (it always computes the full desired set and emits whole-set `SET TAGS`).

The differ detects the same drift on the other tagged catalog objects — **views**, **materialized views**, and **indexes** — on a name-matched object (no rename), surfacing it through `SchemaDiff.viewTagsChanges` / `materializedViewTagsChanges` / `indexTagsChanges`. `generateMigrationDDL` emits these as `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ALTER INDEX … SET TAGS` (leaf metadata writes in the alter phase). A view or materialized-view **tag-only** change takes this in-place path instead of a drop+recreate — an MV does **not** re-materialize the body; a definition change still drops+recreates (carrying the declared tags — see [View / materialized-view definition-change detection](#view--materialized-view-definition-change-detection-droprecreate)), and the two are mutually exclusive per object. The view / MV setters re-register the in-memory schema object (firing `view_modified` / `materialized_view_modified` — distinct from the create events, so they invalidate cached write-through plans without re-registering maintenance); the index setter swaps the owning table's `IndexSchema` and fires `table_modified`. These setters likewise back the imperative per-key `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX … ADD TAGS` / `DROP TAGS` ergonomics.

#### Reserved-tag validation on the declarative path

`quereus.id` / `quereus.previous_name` are first-class entries in the typed reserved-tag registry (`src/schema/reserved-tags.ts`), not a differ-local allow-list. **Every** tag-authoring surface routes its tags through that registry at a **site** matching the object and hard-errors on an unknown or mis-sited `quereus.*` key (e.g. `quereus.previuos_name`, or a `logical-*`-only key like `quereus.lens.writable` on a physical table) — the same registry and hard-error-on-unknown severity the lens-compile, view-mutation, and advertisement paths use, so such a key fails loudly rather than being silently swallowed. Sites: `physical-table` (table), `physical-column` (column), `view-ddl` (view / materialized view), `physical-index` (index), `physical-constraint` (constraint). Free-form (non-`quereus.*`) tags pass untouched.

**Constraint siting.** A **table-level** constraint validates at `physical-constraint` whether named or not (its `WITH TAGS` is consumed regardless). An **inline column** constraint carries tags only when *named* (`qty integer constraint chk check (qty>0) with tags (...)`) — those validate at `physical-constraint`; an *unnamed* inline constraint defers its trailing tags to the column, validating once at `physical-column` (no double-validation). Rename detection still keys off named constraints only.

**Declarative path** (`computeSchemaDiff`, before rename resolution) routes every declared object's tags through `validateReservedTags(tags, site)`, raising via `raiseReservedTagDiagnostics`, so a misspelled / mis-sited key fails `diff` / `apply schema`. The two rename hints carry value-schema `'string'` (a `quereus.id` may contain a hyphen), so the rename flow is unchanged; an MV's `quereus.id` validates but is ignored (the differ supports no materialized-view rename). The duplicate-name check (SCH-003) raises right after, so a tag typo surfaces first.

**Build-time paths** — direct `CREATE TABLE` / `CREATE INDEX … WITH TAGS` and imperative `ALTER … ADD` / `ALTER … SET`|`ADD TAGS` — all validate at plan-build and raise through one sited helper, `raiseStmtTagDiagnostics`, so they cannot drift. `CREATE TABLE` mirrors the differ's four physical surfaces (table / each column / each table-level constraint / each *named* inline constraint), plus `physical-index` for `CREATE INDEX`; the per-column legs (a column's own tags + its inline constraints') come from the shared `columnTagDiagnostics` helper the `ALTER … ADD COLUMN` path also calls, accumulating table → per-column → table-constraints, the first error raised once at the statement's source location. `ADD CONSTRAINT … WITH TAGS` checks at `physical-constraint`; `ADD COLUMN … WITH TAGS` at `physical-column` **plus** each inline named constraint at `physical-constraint`. `SET TAGS` and `ADD TAGS` share the `setTags` build case and validate at the matching site (`physical-table`/`-column`/`-constraint` for `ALTER TABLE`; `view-ddl`/`physical-index` for `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX`). Validation fires even under `IF NOT EXISTS` (build-time, before the runtime existence check) and regardless of the `nondeterministic_schema` option (tags are not expressions).

**`DROP TAGS`** carries no values, so on **any** object it does no reserved-tag validation — dropping a reserved key is legitimate.

**Two deliberate blind spots.** (1) `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` are **not** eagerly validated — view tags validate lazily on the view-mutation path. The keys legal at `view-ddl` are the inert rename hints **and** `quereus.sync.replicate` (the one view-ddl key carrying behavior: it opts an MV's store backing into change-log replication, read off `getSchema().tags` by the store backing host). So a typo'd `quereus.sync.replicate` on a direct create is silently inert, whereas the **declarative** `diff` / `apply schema` path — the authoring path for migration targets — *does* validate it at `view-ddl`. (2) The catalog **import / load** path (`SchemaManager.buildTableSchemaFromAST`, via `importTable` / `importCatalog`) is by design not gated — it re-loads already-persisted DDL and must not start rejecting an openable database.

### Module Batch Hooks

Virtual table modules may opt into a per-`apply schema` batch via the optional `beginSchemaBatch` / `endSchemaBatch` callbacks on `VirtualTableModule`. When the migration loop has at least one DDL statement, the engine calls `beginSchemaBatch(db, schemaName)` on every registered module defining it (in registration order), runs the loop, then calls `endSchemaBatch(db, schemaName, error?)` on those modules in reverse order — passing the loop error on failure, `undefined` on success.

This lets a storage-backed module fold the whole migration into one substrate commit: open an in-memory overlay in begin, have subsequent `create` / `destroy` / `alterTable` calls join it, then commit (or discard) in end. Modules without the hooks are skipped. The idempotent fast-path (no DDL to run) skips both hooks.

If `beginSchemaBatch` itself throws, already-started modules receive `endSchemaBatch(error)` with the begin failure and the error propagates out of `apply schema`. Errors from `endSchemaBatch` are rethrown only when no prior loop error exists; otherwise they are logged so the original cause survives.

### Seed Data

Declared schemas can include seed data (`seed <tableName> values ...`). Under `apply schema ... with seed`:

1. Each declared seed row is written as `INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk-cols>) DO NOTHING` — **idempotent**: a re-apply skips seed PKs already present rather than colliding. User-edited and non-seed rows stay in place, so a reopen never destroys user data and fires no `ON DELETE CASCADE`. (A table whose PK is empty — a `primary key ()` singleton — falls back to the untargeted `ON CONFLICT DO NOTHING`.)
2. Per-table, after all structural migrations complete (and after `endSchemaBatch` fires).

**One block per table** (SCH-003): `setSeedData` overwrites by key, so a repeat drops the first block's rows. `declare schema` rejects it before storing anything; the differ never sees `seed` items, so the guard cannot live at diff time.

#### Rejected alternatives

- **Wipe-then-reseed** (`DELETE FROM <tbl>` unless freshly created). Freshness comes from diffing the in-memory catalog, which a reopen does not rehydrate for host-backed row data, so an already-seeded table reads as fresh, the wipe is skipped, and the bare `INSERT`s collide with persisted rows.
- **`OR REPLACE`.** Delete-then-insert, so re-seeding a parent with `ON DELETE CASCADE` children fires that cascade on every reopen — even when the values are byte-for-byte identical.
- **`OR IGNORE`.** Skips a row on **any** constraint failure (SQLite semantics), so a malformed seed row — a `CHECK` violation, a missing `NOT NULL`, a dangling child FK — vanishes without a diagnostic.

Targeting the PK keeps errors visible: `DO NOTHING` suppresses a row only when the conflict is at the PK columns. Every other violation aborts the apply, including a duplicate on a **secondary** `UNIQUE` index (whose conflicting row carries a *different* PK).

### Schema Hashing

`explain schema [<name>]` returns a short hash of the declared schema, for versioning:

```sql
explain schema main;
-- Returns: hash:a1b2c3d4
explain schema main version '2.0';
-- Returns: version:2.0,hash:a1b2c3d4
```

### DeclaredSchemaManager API

The `DeclaredSchemaManager` (via `db.declaredSchemaManager`) stores declared schema ASTs and seed data between `declare schema` and `apply schema` calls.

| Method | Description |
|--------|-------------|
| `setDeclaredSchema(schemaName, declaration)` | Stores a `DeclareSchemaStmt` AST |
| `getDeclaredSchema(schemaName)` | Retrieves stored declaration, or `undefined` |
| `hasDeclaredSchema(schemaName)` | Returns `true` if a declaration exists |
| `removeDeclaredSchema(schemaName)` | Removes declaration and its seed data |
| `setSeedData(schemaName, tableName, rows)` | Stores seed data rows (`SqlValue[][]`) for a table |
| `getSeedData(schemaName, tableName)` | Retrieves seed data for a specific table |
| `getAllSeedData(schemaName)` | Returns all seed data for a schema (`Map<string, SqlValue[][]>`) |
| `clearSeedData(schemaName)` | Clears all seed data for a schema |

All name lookups are case-insensitive. The manager is stateful: re-declaring a schema clears its seed data and replaces earlier state.

## Aggregate Function Algebra

`AggregateFunctionSchema.algebra` — the declared merge/negate/decode/decompose structure of an aggregate's accumulator — is documented in [Aggregate Function Algebra](aggregate-algebra.md).

