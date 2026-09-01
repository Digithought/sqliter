# Schema Changes (`SchemaChangeInfo`)

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The `alterTable` contract: every arm of the `SchemaChangeInfo` union, what the engine guarantees before it calls, what a module owes each arm, the `ddl` emit-iff-set rule, and the engine-side rebuild fallback when a module raises `UNSUPPORTED`. A satellite of [Virtual Table Module Authoring Guide](module-authoring.md).

When `ALTER TABLE` performs a data-affecting change, the engine calls

```typescript
VirtualTableModule.alterTable(db, schemaName, tableName, change): Promise<TableSchema>
```

passing a `SchemaChangeInfo` discriminated union as `change` and registering the returned `TableSchema` in the catalog. This is a **module-level** hook; the engine never dispatches an `ALTER TABLE` statement through the optional per-table `VirtualTable.alterSchema` method. That method survives for *in-process wrappers* that own a table instance directly — the isolation layer forwards a change to a connection's overlay table through it. Such a caller may pass `alterSchema(change, /* validateOnly */ true)`, which must run every pre-mutation validation the change would run, throw exactly what the real application would throw, and **mutate nothing**; a module that cannot validate without mutating must throw `UNSUPPORTED` rather than silently apply. The statement dispatch lives in `runtime/emit/alter-table.ts`: each `run*` helper resolves the change and, if `module.alterTable` is absent, throws a sited `QuereusError(StatusCode.UNSUPPORTED)`. `ALTER TABLE ... RENAME TO` is schema-only and routes through the separate `renameTable` hook instead.

The current arms of the union (`vtab/module.ts`):

```typescript
export type SchemaChangeInfo = (
	| { type: 'addColumn'; columnDef: ColumnDef; backfillEvaluator?: (row: Row) => SqlValue | Promise<SqlValue>;
	    insertAtIndex?: number }
	| { type: 'dropColumn'; columnName: string }
	| { type: 'renameColumn'; oldName: string; newName: string; newColumnDefAst?: ColumnDef }
	| { type: 'alterPrimaryKey'; newPkColumns: ReadonlyArray<{ index: number; desc: boolean }> }
	| { type: 'addConstraint'; constraint: TableConstraint }
	| { type: 'dropConstraint'; constraintName: string }
	| { type: 'renameConstraint'; oldName: string; newName: string }
	| { type: 'alterColumn'; columnName: string;
	    setNotNull?: boolean; setDataType?: string; setDefault?: Expression | null; setCollation?: string }
) & { readonly ddl?: string };
```

## `ddl`: the emit-iff-set rule

Every arm also carries an optional `ddl` — the statement's **canonical, fully-qualified
SQL**, rendered by the engine at plan-build time from the *resolved* table reference (so
an unqualified `alter table orders …` arrives qualified against the schema the table
actually lives in, never re-resolved against a receiver's default schema). The engine
sets it **only on the call that IS the statement's action**. A call without `ddl` is an
engine-internal sub-step: the per-inline-constraint `addConstraint` follow-ups behind
`ALTER TABLE … ADD COLUMN`, the `dropConstraint`/`dropColumn` calls of a failed ADD
COLUMN's revert, and the materialized-view backing reshapes.

> A module with its own event emitter emits a schema-change event for an `alterTable`
> call **iff** `change.ddl` is set, and puts that text on the event.

That is what keeps one statement = one event: `add column sku text unique` is one
`addColumn` call plus one `addConstraint` call, but only the first carries `ddl`, so the
module announces once — with the whole statement's text. A statement that unwound (the
revert path) announces nothing at all. The `renameTable` hook has the same contract via
its trailing `ddl?: string` parameter; its event additionally carries `oldObjectName`
(the pre-rename table name), since `objectName` names only the new one. A module without
an emitter needs none of this — the engine's own ALTER arms announce the same text
through the auto-event gate.

## Per-arm mandate

Each arm carries its own contract. A module that implements `alterTable` is responsible for every arm it is handed — see the [`alterTable` sub-arm table](module-capabilities.md#altertable-sub-arms--the-fine-grained-mandate-layer) for the implementation status of the built-in modules.

| Arm | Mandate |
| --- | --- |
| `addColumn` | Append the column and backfill existing rows. A literal / NULL default is bulk-written; a **per-row value source** — a non-foldable default (e.g. `new.<col>`) or a `GENERATED ALWAYS AS` expression — arrives as `backfillEvaluator`, which the module must call **per existing row**. Key the module's own "NOT NULL needs a value source" rejection on the evaluator's *presence*, not on which kind of DEFAULT the column def carries: a generated column has no DEFAULT at all, yet the evaluator fills every row (and a row it evaluates to NULL is rejected per row during the backfill). A literal default must be folded **and converted to the new column's declared logical type** — use the exported `foldDefaultToType(expr, logicalType, columnName)`, never a bare `tryFoldLiteral`, or the backfilled cell holds the raw literal (`INTEGER DEFAULT '7'` → the text `'7'`) where an INSERT under the same DEFAULT stores the converted one. `backfillEvaluator`'s result is already converted by the engine and must be stored as-is. NOT-NULL backfill rejection is gated by the `delegatesNotNullBackfill` capability. `insertAtIndex`, when present, asks for the column at that slot instead of the end (every existing column at or after it shifts right by one, and every index-bearing schema field — PK definition, index / UNIQUE / FK column lists — must be renumbered to match). SQL never produces one; it reaches a module only from an in-process wrapper. A module that cannot place a column anywhere but the end must **throw `UNSUPPORTED`** for a position it cannot honor rather than silently appending. |
| `dropColumn` | Remove the column slot and reindex remaining columns — every index-bearing schema field (PK definition, index / UNIQUE / FK column lists) renumbers down over the removed slot, the mirror of `addColumn`'s `insertAtIndex` obligation. Don't hand-roll it: the exported `shiftSchemaIndicesForDrop(schema, colIndex)` returns the renumbered `columns` / `primaryKeyDefinition` / `indexes` / `uniqueConstraints` / `foreignKeys` and is what both built-in modules use. A PRIMARY KEY member, UNIQUE constraint, foreign key, or UNIQUE index that *names* the dropped column is removed **outright**, not narrowed to its surviving columns — one missing a column is a different, stronger constraint; a plain index is narrowed, and one left with no columns is dropped. It also returns `removedUniqueConstraints` (pre-shift column indices) so a module that materializes a physical structure per UNIQUE constraint can tear down exactly the ones this drop removes. `columnIndexMap` is the caller's to rebuild via `buildColumnIndexMap`. **The schema rewrite is only half the arm for a module that keeps a physical structure per index.** Diff the pre-drop index list against the returned `indexes`, by name, and act on both differences: an index the helper **removed** must have its physical structure **torn down** — the same teardown `dropIndex` performs — or it leaks, and a later `CREATE INDEX` reusing that name adopts the stale entries and answers a range scan with each row twice; an index the helper **narrowed** must have its physical structure **re-encoded** from the post-drop rows, because its key now holds one fewer column value while all later maintenance uses the narrow layout — leave it and an indexed lookup silently misses pre-drop rows and a DELETE orphans their entries. A survivor whose column *count* is unchanged needs nothing: its column indices shifted, but it encodes the same values in the same order. Ordering: re-encode after the row migration (the rebuild reads the migrated rows), tear down after the catalog write (so a failed physical delete cannot resurrect the index on reopen). |
| `renameColumn` | Schema-only rename (no row migration). |
| `alterPrimaryKey` | Re-key in place **or** throw `UNSUPPORTED` (see below). Don't hand-roll the schema swap: the exported `rekeySchemaPrimaryKey(schema, newPkColumns)` returns the re-keyed `TableSchema` and is what both built-in modules use. Swapping `primaryKeyDefinition` alone is **not enough** — the per-column `primaryKey` / `pkOrder` flags mirror it, and a stale mirror makes the canonical DDL generator emit the *retired* key (which, for a store-backed table, is what gets persisted and reloaded on reopen). See below. |
| `addConstraint` | Materialize and validate the constraint (UNIQUE / FK) against existing rows; throw `CONSTRAINT` on a violation. Also reached from `ALTER TABLE ADD COLUMN`: a constraint declared **inline** on the added column arrives as its own follow-up `addConstraint` call (UNIQUE → CHECK → FK) right after the `addColumn` call, so the module — not the engine's catalog copy — owns it and it survives later structural ALTERs. Implementing `addColumn` without `addConstraint` therefore makes `add column … check (…)` / `… references …` fail rather than silently lose the constraint. If one of those follow-ups throws, the engine reverts by handing each already-accepted CHECK / FK back through `dropConstraint` (newest first) and then `dropColumn`, so both arms must tolerate being called for a constraint/column added moments earlier in the same statement. |
| `dropConstraint` / `renameConstraint` | Rewrite the schema (and any implicit covering index that backs a UNIQUE). No row migration. |
| `alterColumn.setNotNull` | Backfill NULLs from the column default if present, else throw `CONSTRAINT`. Fold the default through `foldDefaultToType` so the fill value is converted to the column's declared type, as `addColumn`'s is. On a **PRIMARY KEY** member the backfill moves key VALUES — any key column may be nullable ([Schema § Primary-key nullability](schema.md#columnschema)) — so treat it as a re-key: pre-check the converted rows for two keys converging on one (`CONSTRAINT`) and physically re-key afterwards, exactly as `setCollation` below obliges. Loosening (`setNotNull: false`) on a key column is always metadata-only and must be accepted. |
| `alterColumn.setDataType` | Convert each row and throw `MISMATCH` on loss (narrowing, NaN, overflow) when the physical type changes. Don't hand-roll the decision or the converter: the exported `planRetypeConversion(dataType, oldLogicalType, columnName)` resolves the declared type, returns a `null` converter for an alias retype (nothing to rewrite), and otherwise returns the per-value converter that validates, normalizes, and throws the engine's own `MISMATCH` message — the isolation layer keys its staged-row handling off that status code, so a module that invents its own message/code diverges from it. When the physical type is **unchanged**, no value moves — but the change is schema-only only if the two logical types also *compare* identically. If they do not (`TEXT` ↔ `TIMESPAN`, where `'PT1H'` ≡ `'PT60M'`; `TEXT` ↔ `JSON`, where `'{"a":1}'` ≡ `'{ "a" : 1 }'`; `TEXT` ↔ `DATE`/`TIME`/`DATETIME`, whose comparison ignores the column's collation), the module owes the same obligation as `setCollation` below: re-key / re-sort every structure ordered by the column and re-validate uniqueness under the new comparator, throwing `CONSTRAINT` on a collapse. Skipping it leaves lookups missing rows and duplicates slipping past UNIQUE. Retyping a PRIMARY KEY column is refused by the engine before dispatch. |
| `alterColumn.setDefault` | Schema-only — new inserts pick up the default, existing rows are untouched. |
| `alterColumn.setCollation` | Re-key / re-sort any PK / UNIQUE / index ordered by the column and re-validate uniqueness under the new collation (a set unique under `BINARY` may collide under `NOCASE` → throw `CONSTRAINT`). A module that enforces the PRIMARY KEY *physically* under a fixed table key collation (the store) instead negotiates the PK-column case **honor-iff-consistent**: apply schema-only when the target equals that fixed key collation, else throw `UNSUPPORTED` (sited) — never silently no-op. |

## No silent divergence

> **Invariant:** [SCH-004](invariants.md#sch-004--a-module-never-silently-no-ops-an-altertable-arm)

The rule binds every arm. The store's PK-column `setCollation` was the canonical violator and now honors it: a divergent PK collation throws a sited `UNSUPPORTED` (a consistent one applies schema-only) instead of silently applying a schema change the fixed-collation key bytes never enforce. See the [recommended pattern](module-capabilities.md#recommended-capability-negotiation-pattern), rule 4.

## `alterPrimaryKey`

The `alterPrimaryKey` variant is dispatched for `ALTER TABLE ... ALTER PRIMARY KEY (...)`. Each entry in `newPkColumns` gives the column `index` (0-based position in the table's column list) and whether the column is `desc`. An empty array means the table reverts to an implicit key.

**Build the returned schema with `rekeySchemaPrimaryKey`.** A table records its key twice: `TableSchema.primaryKeyDefinition` (authoritative — what `table_info`, key extraction and the canonical DDL generator read) and the per-column `ColumnSchema.primaryKey` / `pkOrder` flags (a `CREATE TABLE`-time mirror feeding the planner's uniqueness hints and the `ColumnDef` AST that `RENAME COLUMN` reconstructs). A module that swaps only the definition leaves the mirror naming the retired key. The exported helper — the ALTER PRIMARY KEY sibling of `dropColumn`'s `shiftSchemaIndicesForDrop` — rebuilds both together:

```typescript
import { rekeySchemaPrimaryKey } from '@quereus/quereus';

const updatedSchema = rekeySchemaPrimaryKey(oldSchema, change.newPkColumns);
```

It returns a frozen schema with a frozen `primaryKeyDefinition` (each member carrying its column's `collation`, so a `NOCASE` key column isn't silently re-keyed under `BINARY`) and a frozen **new** column array of **new** `ColumnSchema` objects — the incoming columns are never mutated, which matters because the pre-ALTER schema is handed onward as `oldObject` on the `table_modified` notification and kept by the memory module as its rollback snapshot. It performs no *user-level* validation: the engine's `runAlterPrimaryKey` validates the column list (existence, no duplicates) by name before dispatch, and a module driving the API directly should keep its own pre-checks. A **nullable** member needs no check on either side — key membership does not imply NOT NULL ([Schema § Primary-key nullability](schema.md#columnschema)), so a module must accept a nullable column into a key and key NULL as an ordinary self-equal value. It does assert the two inputs that would produce a self-inconsistent schema instead of a rejected statement — an out-of-range column index and a repeated one — throwing `INTERNAL`, exactly as `shiftSchemaIndicesForDrop` asserts its column index. The per-column `pkDirection` is deliberately left untouched — direction lives in `primaryKeyDefinition.desc`, which is what the DDL generator and every key builder read.

It is the template for the no-silent-divergence rule. Modules that can re-key in place should handle the change directly and return an updated `TableSchema` — both built-in modules do (the memory module re-keys its trees, secondary indexes, and any open transaction's pending layers and pending change events; the store physically re-keys the data store). Modules that **cannot** re-key in place should throw `QuereusError(StatusCode.UNSUPPORTED)` — `runAlterPrimaryKey` catches that specific code and falls back to a generic shadow-table rebuild that copies all rows from the old table into a new table with the updated PK definition, then swaps it in place. Any other thrown error propagates unchanged. Beware what the fallback cannot do: a shadow rebuild copies **committed** rows only, so a module that owns transactional pending state must either re-key it natively or refuse the change with a non-`UNSUPPORTED` error (`BUSY` reads best) while a transaction holds uncommitted writes — an `UNSUPPORTED` refusal is swallowed by the fallback and the pending writes are silently lost.

The engine will also decline to run the fallback at all in three cases, raising a sited error instead (so "throws `UNSUPPORTED`" does not guarantee the statement then succeeds):

- **The module implements no `renameTable`.** The rebuild finishes by renaming the shadow table over the original, and a module that never hears about that rename keeps its rows under the shadow name — the rebuilt table cannot be connected. Refused with `UNSUPPORTED` regardless of transaction state. A module that wants the fallback must implement `renameTable`.
- **The module implements no `createIndex` and the table carries user indexes.** The shadow table is rendered from the live `TableSchema` through the canonical DDL writer, so it declares every constraint the table has, but an index is a separate statement — the rebuild re-creates each user index on the rebuilt table. Without the hook the index would be lost silently, so the statement is refused with `UNSUPPORTED` up front rather than after the original table is gone. (A UNIQUE constraint's implicit covering structure does not count: it re-materializes from the constraint itself.)
- **An explicit (`BEGIN`-opened) transaction is in progress.** The rebuild's `DROP` + `RENAME` survives `ROLLBACK` while its row copy does not, so a rollback would leave an empty table and destroy rows committed before the transaction began. Refused with `ERROR` (not `BUSY` — retrying inside the same transaction can never succeed). This is the engine's backstop for *any* module; it does not remove a module's own obligation to refuse with `BUSY` when it holds uncommitted writes, since that refusal has to happen even when the module's own `alterTable` is present.

None of these checks run before your `alterTable` — all sit between it and the rebuild, so a module raising `UNSUPPORTED` (which by contract has mutated nothing) still sees the catalog, the table and the transaction left untouched by the refusal.
