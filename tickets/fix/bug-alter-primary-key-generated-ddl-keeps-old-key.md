---
description: After changing a table's primary key, the SQL text the engine generates for that table still declares the OLD key — so a store-backed table silently reverts to its old key after a reopen, and a sync peer recreates the table wrongly keyed.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts        # ~129 (table-level PK clause) and ~509 (inline single-column PK — reads col.primaryKey)
  - packages/quereus/src/schema/column.ts               # ColumnSchema.primaryKey / pkOrder / pkDirection — the stale flags
  - packages/quereus-store/src/common/store-module-alter.ts  # alterPrimaryKeyChange (~396) builds the schema saveTableDDL persists
  - packages/quereus/src/vtab/memory/layer/manager.ts   # buildRekeyedPrimaryKeySchema — same swap on the memory side
  - packages/quereus/src/runtime/emit/alter-table.ts    # runAlterPrimaryKey — the third producer (shadow rebuild) has the same gap
difficulty: medium
---

# What happens

Every `ALTER TABLE … ALTER PRIMARY KEY` producer swaps the schema's
`primaryKeyDefinition` but leaves each column's `primaryKey` / `pkOrder` /
`pkDirection` flags at their CREATE-time values. The DDL generator's
single-column-key path reads the **flag**, not the definition:

```sql
create table t (id integer primary key, code integer not null);
alter table t alter primary key (code);
```

`generateTableDDL` then renders:

```sql
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "code" INTEGER NOT NULL) USING memory
```

— the key is still `id`. (Confirmed by direct reproduction on this branch; the
composite-key path is unaffected because the table-level `PRIMARY KEY (a, b)`
clause reads `primaryKeyDefinition`.)

Consequences of the wrong text:

- **Store persistence**: the store's `alterPrimaryKeyChange` physically re-keys
  the data store and then persists this generated DDL (`saveTableDDL`). On the
  next reopen the catalog re-parses it, so the table comes back keyed by the
  OLD column while its stored bytes are keyed by the new one.
- **Sync**: schema-change events carry this DDL as the statement a peer
  re-executes, so a replicated table is created with the wrong key.
- **Introspection** (`explain schema`, the declarative differ's rendered
  output) shows the wrong key on the single-column case.

Also mis-rendered in the other direction: after re-keying AWAY from a
single-column key to another single-column key, the new key column renders
nothing (its flag is false) while the old one renders `PRIMARY KEY` (its flag
is true). Moving from a single-column to a composite key renders BOTH the
table-level clause (correct) and the stale inline `PRIMARY KEY` on the old
column (wrong — re-parsing rejects a table with both, or worse, accepts a key
the table never had).

# Where the truth lives

`TableSchema.primaryKeyDefinition` is authoritative everywhere else —
`table_info`, key extraction, the differ's PK comparison. The per-column flags
exist for CREATE-time parsing and for planner uniqueness hints
(`rule-select-access-path` etc. read `col.primaryKey` for `isUnique`), which
are equally stale after the ALTER (a lower-stakes symptom of the same gap:
plans may assume uniqueness on the retired key column).

# Expected behavior

After `alter primary key`, generated DDL must declare exactly the new key, and
a reopen/replicate round-trip must reproduce the post-ALTER table. Two obvious
shapes (pick one during fix):

- Rebuild the per-column flags alongside the definition swap, in one shared
  helper all three producers use (memory `buildRekeyedPrimaryKeySchema`, store
  `alterPrimaryKeyChange`, and the engine's shadow-rebuild path); or
- Make `generateTableDDL` derive the single-column inline clause from
  `primaryKeyDefinition` instead of `col.primaryKey` (smaller, fixes rendering
  everywhere at once, but leaves the planner hints stale).

# Candidate regression tests

- Single→single key move: generated DDL declares the new column as the key and
  round-trips (parse → same `primaryKeyDefinition`).
- Single→composite: no stale inline `PRIMARY KEY` beside the table-level clause.
- Store leg: `alter primary key`, close, reopen, verify `table_info` still
  reports the new key and a point lookup under it works.
