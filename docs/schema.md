# Schema Management

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The schema subsystem manages database schemas, tables, views, functions, and indexes: it coordinates virtual table module lifecycle, resolves names across multi-schema search paths, and emits typed change events.

## Topic documents

This document is the **hub**: key types, the change-event surface, the schema path, DDL generation, and the declarative-schema pipeline. The subsystems large enough to read on their own live in the topic documents below.

<!-- NOTE: a section that moved into a satellite left a one-line stub behind under its original
     heading, so its old anchor still resolves here. `yarn docs:check` therefore cannot tell a
     link deliberately left on a stub from one that should have been retargeted and was not.
     When linking real content that lives in a satellite, link the satellite — not the stub. -->

| Document | Covers |
| --- | --- |
| [Rename Detection](schema-rename-detection.md) | How the declarative differ pairs a declared object with an existing one across a rename; the body-change detection that overrides a rename with drop+recreate; tag-drift detection; and reserved-tag validation on the declarative path. |
| [View and Materialized-View Persistence](view-persistence.md) | How `@quereus/store` durably persists views and materialized views: the catalog keys, the schema-change subscription that writes them, and the reopen rehydrate. |

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

A CHECK constraint with an AST expression, an operation bitmask (insert/update/delete), and deferral settings. The expression normally *passes* when truthy or NULL. A write-plan-time synthesizer may instead set the transient `messageValued` flag (never persisted to the catalog), which inverts that test: the expression yields NULL when satisfied and the violation-message text when violated, so one planned expression can decide several rules and still name the one that failed — see [Lens § Constraint Attachment](lens.md).

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

**Lifecycle.** The structure's lifecycle belongs to its constraint, not to `CREATE`/`DROP INDEX`, on **every** backend — exposed or not. `isImplicitCoveringIndex(tableSchema, name)` (`catalog.ts`, reading only `uniqueConstraints`, so it answers identically on memory and store) is the predicate the write paths consult: `createIndex` rejects the name as a same-table duplicate, and `SchemaManager.findIndexOwner` — the single by-name owner resolver behind `dropIndex`, `emitDropIndex`'s strict-DDL-policy gate, the `createIndex` uniqueness check and sync's replicated index DDL — skips past such a match and keeps searching at its default `'user-indexes'` scope. (`ALTER INDEX … TAGS` asks for the wider `'tag-addressable'` scope, which admits an *exposed* structure but still skips a hidden one.) `ALTER TABLE … DROP CONSTRAINT` is what removes the structure. See [sql-vtab.md §6.3](sql-vtab.md#63-indexes-on-virtual-tables) for the user-facing rules.

**One name, one structure.** The structure's name is the constraint's own name, or `_uc_<covered column names joined by _>` when unnamed (`implicitIndexNameForColumns` in `catalog.ts` is the single spelling of that rule; `quereus-store`'s `implicitUniqueIndexName`, `MemoryTableManager.implicitIndexNameFor` and `quereus-isolation`'s `installOverlayUniqueConstraint` mirror it). Two objects on one table may not derive it: `assertUniqueConstraintIndexNameFree` refuses a UNIQUE declaration whose structure name is already held by another UNIQUE constraint's structure (searching `uniqueConstraints`) or by an index (searching `.indexes`), in that order, and `assertNoDuplicateUniqueConstraintBackingNames` applies the constraint half pairwise at `CREATE TABLE`, where there is no table to compare against yet. Both read only backend-independent schema, so memory and store refuse the same declarations with the same message. `derivedFromIndex` constraints are skipped by the constraint half — their structure is the `CREATE UNIQUE INDEX` that synthesized them, already compared by the index half. The guards sit on the write paths only; `importTable` / `importDDL` stay unguarded so a catalog written before them still opens, and `ensureUniqueConstraintIndexes` adopting a held name is the damage limitation for exactly those.

Once exposed, the implicit index is **addressable and introspectable identically across backends** — it appears in `schema()` and `index_info()`, and `ALTER INDEX … {SET|ADD|DROP} TAGS` targets it. Backends differ only in *where the user tags live*: memory materializes the implicit index as an `IndexSchema`, so its tags sit on `IndexSchema.tags`; backends that do not materialize it (the store, which enforces UNIQUE by full-scan over `uniqueConstraints`) derive a synthetic exposed index from the constraint in the read paths (`exposedImplicitIndexes` in `catalog.ts`) and route `ALTER INDEX … TAGS` onto a separate `UniqueConstraintSchema.exposedIndexTags` field. The asymmetry is internal; observable behavior is identical. A *hidden* implicit index (tag absent/false) stays unaddressable (`NOTFOUND`) on both — its tags live on the constraint, reached via `ALTER TABLE … ALTER CONSTRAINT … TAGS`. `exposedIndexTags` survives a store close→reopen via a trailing `alter index … set tags (…)` line in the table's catalog bundle (see [Store catalog persistence](store-catalog-persistence.md)) that `importDDL` re-applies silently on rehydrate. One deliberate divergence: tags are addressable — and *persisted* — only while the constraint is exposed. Dropping the exposure flag (`ALTER TABLE … ALTER CONSTRAINT … DROP TAGS`) leaves `exposedIndexTags` dormant in-session (re-exposing resurrects it), but the bundle emits no `alter index` line for an unexposed constraint, so after a reopen taken while unexposed, re-exposing yields no tags.

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

**Persistence of catalog-only tag swaps (store-backed tables).** The tag setters above (and `ALTER … SET TAGS`) are catalog-only — they swap the in-memory schema and fire a change event but deliberately do **not** call `module.alterTable`. The generic store module (`@quereus/store`) re-persists them anyway by subscribing to `table_modified` and re-writing the table's catalog DDL (`generateTableDDL`) whenever the serialized form changes, so **table**, **column**, and **named-constraint** tags survive close → reopen → `rehydrateCatalog` for `using store` tables. The re-write is a read-compare-write keyed by `{schema}.{table}`: a table with no catalog entry (a memory table, or a store table never persisted) is skipped, and a structural ALTER — whose own `alterTable` already wrote the final DDL — produces identical bytes and is skipped (no double-write). The same subscription persists **views** and **materialized views** (and, via a trailing `alter index … set tags` line, an exposed implicit index's tags) — see [Store catalog persistence](store-catalog-persistence.md) and [View and materialized-view persistence](view-persistence.md).

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

Feature coverage (both forms): `TEMP`, schema qualification, inline single-column `PRIMARY KEY`, table-level `PRIMARY KEY (...)` (including singleton `PRIMARY KEY ()`), non-default column `COLLATE <name>` (the default `BINARY` is elided, so a `COLLATE NOCASE` column survives a persistence re-parse rather than reverting to `BINARY`), `DEFAULT <expr>`, `GENERATED ALWAYS AS (<expr>) STORED|VIRTUAL`, `USING <module>` with SQL-literal args, and `WITH TAGS (...)` at table, column, and index levels.

**The generated-column storage keyword is always explicit.** `VIRTUAL` is the parser's default for an omitted keyword, so eliding it would round-trip correctly — but persisted DDL states it anyway, matching the no-`db` form's stance that persistence output must be unambiguous to any reader. `DEFAULT` and `GENERATED ALWAYS AS` are mutually exclusive on one column (`columnDefToSchema` rejects both), so the two clauses never co-emit.

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
[Store catalog persistence](store-catalog-persistence.md).

### View and materialized-view persistence

How `@quereus/store` persists engine-level views and materialized views — the reserved-prefix
catalog keys, the schema-change subscription that writes them, the
`assertCatalogObjectPersistable` pre-flight veto, and the phased rehydrate that imports them —
lives in [view-persistence.md](view-persistence.md).

## Schema Path

The schema path controls search order for unqualified **relation** names — tables and views alike. Each entry's tables and views are checked together, so the first schema holding that name wins whatever its kind. `Database`-level methods:

| Method | Description |
|--------|-------------|
| `db.setSchemaPath(paths: string[])` | Sets the schema search order. Equivalent to `pragma schema_path` |
| `db.getSchemaPath(): string[]` | Returns the current schema search path as an array of schema names |

```typescript
db.setSchemaPath(['main', 'extensions', 'plugins']);
const path = db.getSchemaPath(); // ['main', 'extensions', 'plugins']
```

Note the deliberate asymmetry with DDL: unqualified DDL lands objects in the **current schema** (`schemaManager.setCurrentSchema(name)`, API-only), but unqualified read resolution consults only the schema path (default `main`, then `temp`) — never the current schema. An embedder setting a non-`main` current schema should set the schema path to match, or qualify references; see [SQL Reference § Schema Search Path](sql-select.md#211-schema-search-path-with-schema).

**Stored bodies resolve against their home schema.** A view or materialized-view body resolves its unqualified names against the *owning object's* schema first, then the database default path — independent of the referencing statement's path (a statement-level `with schema` never leaks into a stored body). This holds for reads and for write-through alike: an `insert` / `update` / `delete` through a view re-plans the body on the home path, so a write binds the same base tables the matching read does — including a subquery inside a body-derived expression the lowering copies into the base statement (see [View Updateability § Schema resolution during write-through](view-updateability.md)). So a view declared next to its tables in a non-`main` schema works under any session path, and `refresh materialized view` does not depend on the path at refresh time. An integrity assertion follows the same rule: it belongs to a schema (unique per schema, created/dropped by possibly-qualified name), and its stored CHECK body resolves unqualified table names against the assertion's own schema first — at create time, at commit-time enforcement, and in `explain_assertion`. Schema-authored expressions follow the same owner-first principle, but more strictly: a column `default`, a generated-column expression, a CHECK constraint and a foreign-key probe resolve against the owning table's schema *only*, with no default-path fallback, so one naming a relation in another schema must qualify it.

The same isolation applies to the **common-table-expression namespace**, not only the schema search path: a stored body binds only the `with` clause it declares itself, plus schema objects on its home path — a caller's `with` clause is invisible to it, so `with t as (…) select * from v` cannot substitute the caller's `t` for the base table `v` reads. Ephemeral write targets are excluded: a CTE-name DML target (`with c as (…) update c set …`) or an inline FROM-subquery target is part of the *caller's own statement*, so it keeps the caller's CTEs along with the caller's schema path.

**Schema-authored expressions never see the writing statement's namespace.** A column `default`, a generated-column expression, a `check` constraint and a foreign-key existence check are written in the *table's* definition, not in the statement doing the write, so their unqualified relation names always mean schema objects on the owning table's schema — never a `with` clause, whether the writing statement declared it itself or inherited it from an enclosing statement, and never a relation picked up from the writer's schema path. Given `create table temp.t (w integer default (select count(*) from c))`, both `with c as (…) insert into temp.t (id) values (1)` and an insert run under `pragma schema_path = 'main'` (or a per-statement `with schema main`) count rows of `temp.c`. All four kinds agree, so a table definition cannot disagree with itself about a bare name.

See the [Usage Guide](usage.md) for the consumer-facing declarative schema workflow, schema path resolution order, and `PRAGMA schema_path` syntax.

## Database Options Affecting Schema

`db.setOption()` / `db.getOption()` control several schema-related behaviors:

| Option | Effect |
|--------|--------|
| `schema_path` | Default search order for unqualified relation (table / view) names |
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

The `declare schema` / `diff schema` / `apply schema` workflow provides order-independent, end-state schema declarations: the engine diffs against the current catalog (`computeSchemaDiff`) and builds an ordered migration plan (`generateMigrationPlan`). Key diff types:

- `SchemaDiff` — tables/views/indexes/assertions to create, drop, alter, or rename
- `MigrationCreate` — one entry of a create bucket: the rendered DDL text (`sql`) paired with the exact statement AST it was rendered from (`ast`)
- `MigrationStep` — one statement of the plan: `sql` always, plus `ast` when the step came from a statement rather than a template string
- `TableAlterDiff` — columns to rename, add, alter, or drop within an existing table; named-constraint rename / drop / add (`constraintsToRename` / `constraintsToDrop` / `constraintsToAdd`)
- `ColumnAttributeChange` — per-column attribute drift within `columnsToAlter`: nullability, data type, default, **collation**, and tags. Each surfaces as the matching `ALTER COLUMN … SET …` statement. Column collation is projected into the diff catalog (`CatalogTable.columns[].collation`, default `'BINARY'`) so the differ detects a `COLLATE` change as it does a type or default change; an absent `COLLATE` and an explicit `COLLATE BINARY` compare equal (no spurious diff). Unlike tags, collation is **behavioral** and participates in the schema hash.

- `SchemaDiff.maintainedModuleMigrations` — backing-module moves on maintained tables (a declared `using <module>(args)` change on a `materialized view` / `create table … maintained as`). Each is realized as a **destructive drop+recreate** (the DROP rides `tablesToDrop`; the recreate, which re-materializes the body into the new module, rides `tablesToCreate`), minting a new incarnation. Surfaced unconditionally by `diff schema`; **gated** at `apply schema` on `allow_destructive` (see below). See [Materialized Views § Declarative-schema integration](materialized-views.md#declarative-schema-integration).

Destructive changes require explicit acknowledgement. The maintained-table backing-module move is the one case currently **enforced**: `apply schema` aborts (before any DDL runs) unless re-run with `options (allow_destructive = true)`, since the new incarnation changes row identity for a replicated/synced table. See the [SQL Reference](sql-ddl.md#20-declarative-schema-optional-order-independent) for the full gating contract and syntax.

Direct `create table` / `create view` DDL and the corresponding `declare schema` + `apply schema` body are guaranteed to produce indistinguishable catalogs and runtime behaviour.

### Applied-state snapshot (the unchanged-schema fast path)

Re-applying an unchanged declaration used to pay for a full comparison to be told nothing changed, and `computeSchemaDiff` is two thirds to three quarters of a no-op apply's cost. `apply schema` therefore keeps, per `Database` and per (lowercased) schema name, an **applied-state snapshot**: what the declaration rendered to, what the live catalog rendered to, and the effective `default_collation`, as of the end of the last successful apply whose migration plan came out **empty**.

On the next apply the physical branch collects the catalog as before, re-renders both sides, and compares. On a three-way match it skips `computeSchemaDiff` and `generateMigrationPlan` entirely; everything else — schema creation, the seed loop, the empty-plan hook behaviour — is unchanged.

| | rendered by | includes |
|---|---|---|
| declared side | `renderDeclaredSchemaCanonical` (`schema/schema-hasher.ts`) | the `isLogical` kind prefix + `generateDeclaredDDL`, **tags included** |
| catalog side | `renderCatalogForComparison` (`schema/catalog-rendering.ts`) | every field of every `Catalog*` interface, each category sorted so live `Map` insertion order cannot matter |

**Why skipping is sound.** `computeSchemaDiff(declared, catalog, renamePolicy, defaultCollation)` reads nothing but its four arguments. On a hit, two of them render identically to the recorded strings and the third is compared directly; the remaining one, `renamePolicy`, is inert when there are no differences — there are no name-change pairs for a policy to police. (`allow_destructive` likewise only gates a non-empty `diff.maintainedModuleMigrations`.) So the diff would again be empty.

**Duplicate-name checks are among the skipped work.** `computeSchemaDiff` is also where the
`table`/`view`/`materialized view` and `assertion` duplicate-declared-name rejection
([SCH-003](invariants.md#sch-003--a-declared-schema-names-each-object-once)) and the declared-index-name
arm of the per-schema index-name-uniqueness check ([SCH-001](invariants.md#sch-001--index-names-are-unique-per-schema))
live, so the fast path skips them too. That is safe rather than a hole for the same reason as above:
a snapshot is recorded only after a diff that *succeeded*, so it can never describe a
duplicate-bearing declaration, and adding a duplicate changes the declared rendering — which makes
the fast path miss and the diff run. Any future declaration-shape guard added to the differ
inherits the same requirement: it must be defeated by a change the declared rendering shows.

**Why it is recorded only after a verified-empty plan.** At write time this process has *observed*, via a real diff, that the catalog matches the declaration. Two consequences are features rather than accidents:

- The very first apply on a fresh database migrates, so it records nothing; the *second* apply diffs, finds the plan empty, and records; the third and later are fast. This preserves `apply schema`'s self-healing property — if DDL generation were ever imperfect, a repeat apply still re-diffs rather than being told by a cache that everything is fine.
- A failed apply (a mid-migration DDL failure, a seed failure) records nothing, so the next apply reconciles in full.

A snapshot is a claim about a *pair* of renderings — "these two were once verified equal" — not about a moment in time, so it survives a later re-`declare schema` (a byte-identical redeclaration still renders the same and still hits) and survives an intervening migrating apply (drift makes the compare miss; repairing the drift makes it match again). `removeDeclaredSchema` clears it, since nothing is left to compare against.

**Not covered, deliberately:**

- **`diff schema`** — a preview; no cache read, no cache write, ever.
- **`explain schema`** — keeps returning the tag-stripped version hash (see [Schema Hashing](#schema-hashing)).
- **Logical schemas / lenses** — the `isLogical` branch returns before catalog collection and has real side effects on every apply (lens compile, snapshot rotation, module notification). No fast path there.
- **Reserved-tag warning advisories** — `computeSchemaDiff` raises tag diagnostics. The `severity:'error'` ones throw, so an apply that recorded a snapshot never had one; the `severity:'warning'` ones go to a debug logger and are not re-logged on a fast-pathed apply. This is the one observable difference, and it is debug-log-only.
- **A second `Database` over the same store, or a store reopen** — each connection has its own `DeclaredSchemaManager` and starts with an empty snapshot map, so it always reconciles first. In particular this does **not** help the declare-and-apply-once-per-process-start case; serving that needs the snapshot persisted alongside the catalog.

Measured on the synthetic 54-table / 14-view declaration of `bench/apply-schema-unchanged.mjs` (median of 9, one Windows box — treat the ratios as the finding):

| declaration | full-diff no-op | fast-pathed no-op | |
|---|---|---|---|
| 20.4 KB | 1.52 ms | 0.64 ms | 58% off |
| 62.9 KB | 3.13 ms | 1.14 ms | 64% off |
| 112.7 KB | 5.64 ms | 1.52 ms | 73% off |

The fast path removes `computeSchemaDiff` (0.86 / 2.30 / 4.35 ms) and adds a catalog render plus a string compare (0.17 / 0.40 / 0.56 ms and 0.004 / 0.012 / 0.017 ms); `collectSchemaCatalog` (0.26 / 0.46 / 0.67 ms) is still paid on both paths. Storing the rendered strings rather than hashing them is what removes hash-collision risk from the comparison — the cost is memory proportional to the schema's DDL (309 KB catalog + 109 KB declaration at the top size measured). The *encoding* is still separator-delimited rather than uniquely decodable: a tag value or string `DEFAULT` containing a raw newline reaches the rendering verbatim, so text crafted to imitate another item's rendering can in principle make two different catalogs render alike. See the `NOTE:` on `renderCatalogForComparison` and `tickets/backlog/debt-catalog-rendering-injective-encoding`.

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

`generateMigrationPlan` is the single ordering authority; `generateMigrationDDL` is a thin wrapper over it (`plan.map(s => s.sql)`). `diff schema` shows the wrapper's strings; `apply schema` walks the plan. Because the preview text and the executed statement are two fields of one object, the two can never disagree.

A create step (and the `set maintained as` re-attach) carries the statement AST its DDL was rendered from, so `apply schema` executes a **spine clone** of it instead of re-lexing text the differ just produced. The clone is required, not defensive polish: a step's AST is (a subtree of) the statement `DeclaredSchemaManager` holds — the schema qualifiers spread only the outermost node, so a view's `select`, an assertion's body and a `set maintained as` body are the declaration's own subtrees on **every** target schema — while the create emitters retain what they execute (`ViewSchema.selectAst` and its assertion / maintained-table counterparts) and rename propagation rewrites those catalog bodies *in place*. Handing over the original node would let a later `ALTER TABLE … RENAME` silently rewrite the declaration, at which point `diff schema` stops reporting the drift it exists to report. Because `spineCloneAst` copies the whole statement while the catalog retains only a few subtrees of it, the clone costs roughly what the parse it replaces costs (measured over 68 creates: 0.91 ms clone vs 1.07 ms parse on a 20.4 KB declaration; 3.57 ms vs 3.13 ms on a 112.7 KB one) — so a create-heavy `apply schema` nets a few percent off the migration loop, not the large win the uncloned form appeared to offer. Reclaiming it means moving ownership into the create emitters so each copies only what it stores. Template-built steps (renames, drops, column/constraint alters, `SET TAGS`) carry no AST and are parsed as before. Either way the log line and the `Failed to execute DDL: …` wrapper name `step.sql`, so error text is identical on both branches. One consequence: an error raised while executing a create now carries the source location of the **declaration**, not of the generated DDL string — on the *cause*, since the `Failed to execute DDL: …` wrapper supplies no line/column of its own.

Pairing the two guarantees they name the same statement, but it does not by itself guarantee they *mean* the same statement — a renderer that dropped a field would make `apply schema` do more than `diff schema` previewed. `schema-differ.spec.ts` § "the paired AST and its rendered DDL mean the same statement" pins that property over every create form: re-parsing a create's own `sql` must reproduce its `ast`, modulo source positions and exactly two normalizations the schema builder applies anyway — collation-name case (`validateCollationForType` upper-cases) and `moduleArgs: {}` vs absent (`resolveModuleInfo` does `stmt.moduleArgs || {}`). Adding a field to a create's AST node without teaching `ast-stringify` to render it fails there.

The plan produces DDL in a fixed order:

1. **Renames first** — `ALTER TABLE ... RENAME TO` for **tables** with a stable identity hint (`quereus.id` / `quereus.previous_name`). This frees the old name before any create reuses it and lets the engine's rename rewriter propagate references through dependents. Hinted **view / index** renames emit no DDL here (no rename primitive exists) — they are realized as drop(old) + recreate(declared) in the phases below; the non-table `RenameOp`s on `SchemaDiff.renames` are metadata only.
2. **Drops second** — `DROP TABLE`, `DROP VIEW`, `DROP INDEX` for objects neither declared nor consumed by a rename.
3. **Creates third** — `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX` for new objects.
4. **Alters last** — within each `TableAlterDiff`: `RENAME COLUMN` first (so subsequent phases see post-rename names), then `ADD COLUMN`, `ALTER COLUMN`, then the **constraint lifecycle** — `RENAME CONSTRAINT` then `DROP CONSTRAINT` (free / remove a name before any re-add, and drop a UNIQUE before the PK change so it can't strand a PK dependency) — then `ALTER PRIMARY KEY`, then `ADD CONSTRAINT` (after the PK change and the column adds it may reference), then `DROP COLUMN` last, then the tag-drift `SET TAGS` phase.

This ordering frees dropped tables' names before creates run, and makes forward references between tables (e.g. FKs to later-declared tables) work, since declarations are order-independent. A constraint `ADD` lands after all `CREATE TABLE`s, so a declared FK added to an existing table can reference a freshly-declared parent.

### Rename Detection

Moved to [Rename Detection](schema-rename-detection.md#rename-detection).

### Module Batch Hooks

Virtual table modules may opt into a per-`apply schema` batch via the optional `beginSchemaBatch` / `endSchemaBatch` callbacks on `VirtualTableModule`. When the migration loop has at least one DDL statement, the engine calls `beginSchemaBatch(db, schemaName)` on every registered module defining it (in registration order), runs the loop, then calls `endSchemaBatch(db, schemaName, error?)` on those modules in reverse order — passing the loop error on failure, `undefined` on success.

This lets a storage-backed module fold the whole migration into one substrate commit: open an in-memory overlay in begin, have subsequent `create` / `destroy` / `alterTable` calls join it, then commit (or discard) in end. Modules without the hooks are skipped. The idempotent fast-path (no DDL to run) skips both hooks.

If `beginSchemaBatch` itself throws, already-started modules receive `endSchemaBatch(error)` with the begin failure and the error propagates out of `apply schema`. Errors from `endSchemaBatch` are rethrown only when no prior loop error exists; otherwise they are logged so the original cause survives.

### Seed Data

Declared schemas can include seed data (`seed <tableName> values ...`). Under `apply schema ... with seed`:

1. Each declared seed row is written as `INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk-cols>) DO NOTHING` — **idempotent**: a re-apply skips seed PKs already present rather than colliding. User-edited and non-seed rows stay in place, so a reopen never destroys user data and fires no `ON DELETE CASCADE`. (A table whose PK is empty — a `primary key ()` singleton — falls back to the untargeted `ON CONFLICT DO NOTHING`.)
2. Per-table, after all structural migrations complete (and after `endSchemaBatch` fires).
3. On **both** apply paths. The [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path) elides the diff and the migration plan, nothing else — so a table emptied since the last apply gets its seed rows back, which is the behaviour a user relies on and the only reading consistent with "observably indistinguishable from a full apply whose diff came out empty". Seeding is idempotent, so the repeat costs no correctness.

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

**The version hash and the reconciliation rendering are different strings, deliberately.** Both go through `renderDeclaredSchemaCanonical` (`schema/schema-hasher.ts`), but `computeSchemaHash` calls it on a **tag-stripped** copy first, because tags are non-behavioral metadata and must not move a schema's version. The differ, by contrast, *does* diff tags and emits `ALTER … SET TAGS` steps for them — so the [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path) uses the tags-**inclusive** rendering. Reusing the version hash there would silently skip a tag-only edit. Do not conflate the two.

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
| `getDeclaredRendering(schemaName)` | Canonical **tags-inclusive** rendering of the stored declaration (memoized), or `undefined` |
| `getAppliedSnapshot(schemaName)` | The [applied-state snapshot](#applied-state-snapshot-the-unchanged-schema-fast-path), or `undefined` |
| `setAppliedSnapshot(schemaName, snapshot)` | Records one — only valid after an apply that succeeded **and** produced an empty plan |

All name lookups are case-insensitive. The manager is stateful: re-declaring a schema clears its seed data and replaces earlier state. Re-declaring also drops the memoized rendering (it described the previous declaration) but **keeps** the applied snapshot, so a byte-identical redeclaration still takes the fast path; `removeDeclaredSchema` drops both.

## Aggregate Function Algebra

`AggregateFunctionSchema.algebra` — the declared merge/negate/decode/decompose structure of an aggregate's accumulator — is documented in [Aggregate Function Algebra](aggregate-algebra.md).

