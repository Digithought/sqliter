# SQL Virtual Tables

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 6. Virtual Tables

Virtual tables are Quereus's primary mechanism for accessing and manipulating data. They provide a table interface to various data sources through specialized modules.

### 6.1 Creating Virtual Tables

**Syntax:**
```sql
create table [if not exists] table_name [(column_def[, ...])]
using module_name [(module_arguments...)]
```

**Examples:**
```sql
-- Memory table with schema definition
create table users (
  id integer primary key,
  name text not null,
  email text unique,
  created_at text default (datetime('now'))
) using memory;

-- JSON table using the json_tree function
create table product_data
using json_tree('{"products":[{"id":1,"name":"Keyboard"},{"id":2,"name":"Mouse"}]}');

-- Create a memory table from a schema string
create table cache
using memory('create table x(key text primary key, value blob, expires integer)');
```

### 6.2 Built-in Virtual Table Modules

Quereus comes with several built-in virtual table modules:

#### 6.2.1 Memory Table Module

The `memory` module provides an in-memory, B+Tree-based storage with support for transactions, indices, and constraints.

**Key features:**
- Efficient in-memory storage
- Primary key and unique constraints
- Secondary index support via `create index`
- Transaction and savepoint support

**Examples:**
```sql
-- Create a memory table
create table products (
  id integer primary key,
  name text not null,
  price real check (price >= 0),
  category text
) using memory;

-- Create a secondary index
create index idx_products_category on products(category);

-- Insert data
insert into products (name, price, category) 
values 
  ('Laptop', 999.99, 'Electronics'),
  ('Desk Chair', 199.99, 'Furniture');

-- Query with index
select * from products where category = 'Electronics';
```

#### 6.2.2 JSON Table Modules

Quereus provides two modules for working with JSON data:

**json_each**: Expands a JSON array into rows
```sql
-- Create table from JSON array
create table users using json_each('[
  {"id":1,"name":"Alice","role":"admin"},
  {"id":2,"name":"Bob","role":"user"}
]');

-- Query expanded JSON
select key, value from users where key = 'name';
-- Result: 'name', 'Alice' and 'name', 'Bob'
```

**json_tree**: Expands a JSON structure recursively
```sql
-- Create and query a json_tree table
with json_data as (
  select '{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}' as json
)
select key, value, fullkey, path
from json_tree(
  (select json from json_data)
)
where path like '$.users[%].name';
-- Results in rows with users' names
```

#### 6.2.3 Schema Table Module

The `_schema` module provides access to schema information:

```sql
-- Query schema information
select * from _schema;
-- Returns information about tables, indexes, and views
```

### 6.3 Indexes on Virtual Tables

Virtual tables that support indexing (like the `memory` module) can have indexes created using standard SQL syntax.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (indexed_column[, ...])
```

**Examples:**
```sql
-- Simple index on a single column
create index idx_users_email on users(email);

-- Composite index on multiple columns
create index idx_orders_customer_date on orders(customer_id, order_date);

-- Unique index
create unique index idx_products_sku on products(sku);

-- Per-column COLLATE (and direction): the index orders/compares this column
-- under the given collation, overriding the table column's collation. A bare
-- `col COLLATE x` is a per-column collation, not an expression index; a genuine
-- expression operand (e.g. `lower(name)`) is still rejected.
create index idx_users_email_ci on users(email collate nocase desc);
```

**Index names are unique per schema, not per table.** `DROP INDEX`, `ALTER INDEX … TAGS`, and sync's index-owner resolution all name an index without naming its table, so a duplicate name would resolve to whichever table happened to be registered first. `create index` therefore rejects a name already held by an index anywhere in the target schema, naming the existing owner:

```sql
create index idx_note on t1 (note);
create index idx_note on t2 (note);
-- error: Index 'idx_note' already exists in schema 'main' on table 't1'
```

- **`IF NOT EXISTS` does not suppress a cross-table collision.** It means "skip if *this* index already exists"; an index of that name on a *different* table is a different object, and skipping would silently leave the requested index absent from the target table. Only a same-name index on the *same* table is skipped.
- **A UNIQUE constraint's implicit covering structure is not part of that namespace.** The auto-built secondary structure backing a plain `UNIQUE` constraint takes the constraint's name (or `_uc_<cols>` when unnamed), and constraint names are unique per *table*, so two tables may each declare `constraint uq_email unique (email)`. Those implicit structures are skipped by the schema-wide check.
- **…but the name is taken on the constraint's own table.** `create index uq_email on b (email)` where `b` already carries a `uq_email` UNIQUE constraint is rejected as a same-table duplicate — `Index uq_email already exists on table b` — and `create index if not exists` skips silently, exactly as for an ordinary same-table duplicate. This holds on every backend, including one that keeps the structure entirely internal and never reports it as an index (otherwise the new index and the constraint's structure would collide in the backend's own storage). The name is free again once the constraint is dropped.
- **…and symmetrically, a UNIQUE constraint may not take a name an index on its table already holds.** Declaring the constraint second is rejected the same way declaring the index second is:

  ```sql
  create index foo on t (b);
  alter table t add constraint foo unique (a);
  -- error: Cannot add constraint 'foo' to table 't': its backing index 'foo' would collide
  --        with existing index 'foo' on the same table. Rename the constraint or the index.
  ```

  This covers every path that declares or renames a UNIQUE constraint: `ALTER TABLE … ADD CONSTRAINT`, `ALTER TABLE … RENAME CONSTRAINT`, `ALTER TABLE … ADD COLUMN … unique` (including the unnamed `_uc_<column>` auto-name), `ALTER TABLE … RENAME COLUMN` (an unnamed constraint's `_uc_<cols>` name is derived from the covered columns, so renaming one *moves* the name onto a new one — see the bullet below), and the `ALTER TABLE … ADD <constraint>` statements `apply schema` / `declare schema` emit. `CREATE TABLE` cannot reach it — a table is created carrying no indexes. The check runs before the statement reaches the storage module, so it holds on every backend and a rejected statement persists nothing.
  - **`RENAME COLUMN` moves an unnamed UNIQUE's structure name with the column.** `_uc_<cols>` is recomputed from the columns' current names every time it is needed and recorded nowhere, so after `alter table t rename column a to z` the constraint declared `unique (a)` is backed by `_uc_z`. The structure follows silently — it stays hidden from `schema()` / `index_info()` under the new name and keeps enforcing — *unless* `_uc_z` is already an index on `t`, in which case the rename is refused with the same message and the column keeps its old name. Rename or drop that index first. A **named** UNIQUE is unaffected: its structure takes the constraint's name, which no column rename touches.
  - **Rejected even when the constraint's columns match the index's.** The two structures would coincide physically, but accepting it silently reclassifies the user's declared index as a hidden backing structure: it vanishes from `schema()` / `index_info()` and from the persisted schema, and stops being droppable. Reusing an existing index to back a constraint matches on *columns*, not names — `constraint bar unique (a)` over an index `foo` on `(a)` is unaffected.
  - **Only UNIQUE.** CHECK and FOREIGN KEY constraints build no backing structure and are never rejected for this.
  - **A `create unique index`-derived constraint is exempt.** `create unique index foo on t (a)` deliberately synthesizes a UNIQUE constraint named `foo` beside index `foo`; that index is the user's own object, not an implicit covering structure.
- **…and two UNIQUE constraints on one table may not derive the same backing structure name either.** The same one-name-one-object rule between two *constraints* rather than a constraint and an index. Two spellings reach it — a constraint name written with the engine's reserved `_uc_` prefix, and the `_`-joined auto-name colliding on ordinary column names:

  ```sql
  create table t (id integer primary key, c integer, b integer,
                  constraint _uc_c unique (b), unique (c));      -- both derive `_uc_c`
  create table t (id integer primary key, a_b integer, a integer, b integer,
                  unique (a_b), unique (a, b));                  -- both derive `_uc_a_b`
  -- error: Cannot create table 't': the UNIQUE constraint '_uc_c' and the UNIQUE constraint
  --        on (c) both derive backing structure name '_uc_c'. Rename one of them.
  ```

  Left unguarded the second constraint shares the first's structure and is then enforced by one keyed on the *other* constraint's columns, so it silently stops rejecting duplicates. Refused on every authoring path — `CREATE TABLE` (which *does* reach this one: it compares the declared constraints against each other, no index needed), `ALTER TABLE … ADD CONSTRAINT`, `ADD COLUMN … unique` (including two inline `unique` constraints on one new column), `RENAME CONSTRAINT`, `RENAME COLUMN`, and the statements `apply schema` emits. The comparison reads `uniqueConstraints`, which every backend carries, so the refusal and its message are identical on memory and store — and it runs ahead of the index comparison above so a collision both can see reports the same way everywhere. `derivedFromIndex` constraints (from `create unique index`) are skipped: their structure *is* that index, already covered by the index rule. The naming rule itself is unchanged — `_uc_<cols>` stays ambiguous by construction and is persisted in existing catalogs; the collision is refused rather than the name disambiguated.
  - **The import / rehydrate path is not guarded**, like the duplicate-constraint rule below: a catalog written before this rule still opens, with the memory backend sharing one structure between the two constraints as damage limitation.
  - **NOTE: `declare schema` does not pre-check this pairing.** A declaration that names a UNIQUE constraint and an index the same on one table is accepted at declare time and only fails when applied — from the constraint side if the index is already there, from the index side against a fresh schema (`Index foo already exists on table t`). Such a declaration is never appliable either way, so nothing can slip through; if declare-time diagnostics become worth the plumbing, fold constraint names into the duplicate-name check described in the last bullet of this section.
- **`DROP INDEX` on an implicit covering structure raises `no such index`.** The structure's lifecycle belongs to its constraint, so it is not droppable by name — exposed via `quereus.expose_implicit_index` or not (exposure makes it addressable for *tags*, nothing more). `DROP INDEX IF EXISTS` on such a name is a no-op. Remove the structure with `ALTER TABLE … DROP CONSTRAINT <constraint>`. Because implicit structures are outside the schema-wide namespace, the by-name lookup *skips past* them and keeps searching: with a `uq_email` constraint on `a` and a real `create index uq_email on c (email)`, `drop index uq_email` drops `c`'s index and leaves `a` enforcing.
- **`schema()` and `index_info()` omit a hidden implicit covering structure, on every backend.** Not being a user-addressable index (above), it is not listed as one — consistent with `collectSchemaCatalog` (the declarative-schema differ's read path), which applies the same rule. An *exposed* one (`quereus.expose_implicit_index = true`) keeps appearing in both introspection functions, with its tags, on every backend — and **describes itself as UNIQUE** there: `schema()` renders `CREATE UNIQUE INDEX` and `index_info().unique` reports `1`, identically on memory and store. That is a *description*, not a change of mechanism: rendered DDL exists to re-parse into the object it describes, and a plain `CREATE INDEX` would not re-parse into something that enforces uniqueness. Enforcement itself still belongs to the constraint. A `create unique index`-derived constraint is the user's own index and always appears.
- **Rehydration warns instead of failing.** Opening a database written before these rules that already contains a collision logs a warning and proceeds — naming both owning tables for a cross-table collision, or naming the constraint that holds the name for a same-table one. By-name resolution of that index stays first-match until one of them is renamed. (The same-table rule cannot be tripped by rehydration itself: the catalog's `CREATE TABLE` — constraints included — is imported ahead of every `CREATE INDEX`, so the table carries no indexes when its constraints are declared.)
- **`declare schema` rejects duplicates up front.** Two `index` declarations sharing a name (on any tables) are an error at diff time rather than a silently half-applied declaration — one case of the general rule that each declared name appears once (see [sql-ddl.md §2.0 *Declaration Syntax*](sql-ddl.md#declaration-syntax)).
