# SQL Constraints and Indexes

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 7. Constraints and Indexes

**Constraint names are unique within a table — one case-insensitive name space across CHECK, UNIQUE and FOREIGN KEY.** A `CREATE TABLE` declaring two constraints under one name is refused with `CONSTRAINT`; so is every `ALTER TABLE … ADD CONSTRAINT` / `ADD COLUMN … constraint <name> …` / `RENAME CONSTRAINT` onto a taken name ([§2.7](sql-alter.md)). The rule exists because `DROP` / `RENAME CONSTRAINT` resolves by name: two constraints of the same class under one name would both be removed by a single `DROP`, and two of different classes would be rejected as **ambiguous** forever. The import / rehydrate path is deliberately *not* guarded, so a database written before the rule still opens and surfaces the collision at its next `ALTER`.

Constraints written **without** a name are auto-named — `_check_<column>`, `_fk_<table>_<columns>`, `_uc_<columns>` for a UNIQUE's covering structure — and those names are user-addressable (a CHECK violation and a `DROP COLUMN` refusal both quote them back at you). Declaring two constraints that mint the *same* auto-name is legal — two unnamed CHECKs on one column, or two foreign keys from one child column into different parents — so the mint disambiguates instead of refusing: the first keeps the base spelling, the Nth gets a `_<N>` suffix (`_fk_c_x`, then `_fk_c_x_2`). The suffix is collision-only and the taken set includes the names the user typed, so an auto-name never lands on a user's name and every non-colliding auto-name is spelled exactly as it always was.

### 7.1 Primary Key Constraint

The primary key constraint uniquely identifies each record in a table.

A table declared with **no** primary key gets one covering **every** column, in declaration order — Quereus has no rowid, so whole-row identity is the fallback. That synthesized key is exact syntactic sugar for writing the same `primary key (...)` clause out: the two produce identical schemas.

**Primary key does not imply `not null`.** A key column keeps the nullability it declared, or the one `pragma default_column_nullability` gave it — the same rule for a declared key and a synthesized one. Under the shipped `not_null` default that is invisible (every column is NOT NULL unless it says otherwise), so `id integer primary key` is still non-nullable; the nullable case needs an explicit `x integer null primary key` or the `nullable` session default. NULL is an ordinary self-equal value in key position, so two rows with an all-NULL key collide as a duplicate primary key — unlike `UNIQUE`, where NULLs stay distinct and never collide ([§ 7.3](#73-unique-constraint)). See [Schema § Primary-key nullability](schema.md#columnschema).

Nullability matters wherever the primary key is referenced implicitly: `references <parent>` with no column list resolves to it (see [§ 7.6](#76-foreign-key-constraint)).

**Syntax - Column Constraint:**
```sql
column_name data_type primary key [asc|desc] [conflict_clause] [autoincrement]
```

**Syntax - Table Constraint:**
```sql
primary key (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column primary key
create table users (
  id integer primary key autoincrement,
  username text not null
);

-- Composite primary key (table constraint)
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null,
  primary key (order_id, product_id)
);

-- Primary key with descending order
create table logs (
  timestamp integer primary key desc,
  event text not null
);
```

### 7.2 NOT NULL Constraint

The not null constraint ensures that a column cannot have a NULL value.

**Syntax:**
```sql
column_name data_type not null [conflict_clause]
```

**Example:**
```sql
create table contacts (
  id integer primary key,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text
);
```

### 7.3 UNIQUE Constraint

The unique constraint ensures that all values in a column are different.

**Syntax - Column Constraint:**
```sql
column_name data_type unique [conflict_clause]
```

**Syntax - Table Constraint:**
```sql
unique (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column unique constraint
create table users (
  id integer primary key,
  email text unique,
  username text unique
);

-- Multi-column unique constraint
create table bookings (
  id integer primary key,
  room_id integer,
  date text,
  unique (room_id, date)
);
```

**A table may not carry the same plain UNIQUE twice.** Two *unnamed*, non-partial UNIQUE
constraints over the same column set are refused with `CONSTRAINT` — neither has a name
for `DROP CONSTRAINT` to address, so neither could be removed short of recreating the
table, while every write pays the identical check twice. Column order is not identity
(`unique (a, b)` and `unique (b, a)` are one rule) and column names fold case. The rule
holds identically at `CREATE TABLE` (both the column-level and table-level spellings, and
across the two), `ALTER TABLE … ADD CONSTRAINT`, and `ALTER TABLE … ADD COLUMN … unique`
— see [ALTER § ADD CONSTRAINT](sql-alter.md) for the two carve-outs (a *named* UNIQUE
beside an unnamed one stays legal, as do partial UNIQUEs with a `where` predicate).
Reading the catalog of a database written before the rule is unaffected.

### 7.4 CHECK Constraint

The check constraint ensures that values in a column satisfy a specific condition.

**Syntax - Column Constraint:**
```sql
column_name data_type check [on operation_list] (expression)
```

**Syntax - Table Constraint:**
```sql
check [on operation_list] (expression)
```

The optional `on operation_list` specifies when the constraint should be checked (insert, update, delete).

**Examples:**
```sql
-- Column-level check constraint
create table products (
  id integer primary key,
  name text not null,
  price real check (price > 0),
  discount real check (discount >= 0 and discount <= 1)
);

-- Table-level check constraint
create table transfers (
  id integer primary key,
  source_account_id integer not null,
  dest_account_id integer not null,
  amount real not null check (amount > 0),
  check (source_account_id != dest_account_id)
);

-- Operation-specific check constraint
create table audit_log (
  id integer primary key,
  record_id integer not null,
  action text not null,
  timestamp text not null,
  check on insert (action in ('insert', 'update', 'delete'))
);

-- JSON structure validation with check constraint
create table events (
  id integer primary key,
  event_type text not null,
  data json check (json_schema(data, '[{x:integer,y:number}]'))
);

-- Complex JSON schema validation
create table api_logs (
  id integer primary key,
  endpoint text not null,
  request json check (json_schema(request, '{ method: string, headers: any, body: any }')),
  response json check (json_schema(response, '{ status: number, body: any }'))
);
```

### 7.5 DEFAULT Constraint

The default constraint provides a default value for a column when no value is specified.

**Syntax:**
```sql
column_name data_type default value
```

**Examples:**
```sql
-- Constant default value
create table posts (
  id integer primary key,
  title text not null,
  content text,
  views integer default 0,
  status text default 'draft'
);

-- Function-based default
create table audit_records (
  id integer primary key,
  action text not null,
  timestamp text default (datetime('now'))
);
```

A DEFAULT that is a literal (as opposed to a function call, a `new.<column>` reference, or a bare column) is converted to the column's declared type at the point it is declared — `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, or `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` — and stored already converted. A literal that cannot convert (e.g. `n integer default 'abc'`) is refused right there, rather than being accepted and failing on the first INSERT that relies on it.

### 7.6 FOREIGN KEY Constraint

The foreign key constraint links tables together and ensures referential integrity.

Foreign key enforcement is controlled by the `foreign_keys` pragma (default: on):

```sql
pragma foreign_keys = on;   -- enable FK enforcement (default)
pragma foreign_keys = off;  -- parse but don't enforce
```

When no `ON DELETE` or `ON UPDATE` clause is specified, the default action is `RESTRICT`. `NO ACTION` is currently treated as a synonym for `RESTRICT`.

A foreign key records its **child** columns by position but its **parent** columns by *name*, re-resolving them on every write. So `ALTER TABLE ... DROP COLUMN` treats the two sides differently: dropping a child column removes the key along with it, while dropping a column some key points **at** as a parent column is **rejected** — drop the referencing key first (`ALTER TABLE <child> DROP CONSTRAINT <name>`). The rejection does not depend on `pragma foreign_keys`, since a schema left in that state breaks the referencing table as soon as enforcement is switched on. See [sql-alter.md § 2.7](sql-alter.md#27-alter-table-statement) under *DROP COLUMN*.

**Syntax - Column Constraint:**
```sql
column_name data_type references [schema.]foreign_table [(column)] [ref_actions]
```

**Syntax - Table Constraint:**
```sql
foreign key (column[, ...]) references [schema.]foreign_table [(column[, ...])] [ref_actions]
```

The parent table may be **schema-qualified** (`references other_schema.parent(id)`),
so a child in one schema can reference a parent in another. An unqualified parent
defaults to the child's own schema and persists with no qualifier (byte-identical
to a same-schema FK). All reference actions (RESTRICT / CASCADE / SET NULL /
SET DEFAULT) and `foreign_key_info()`'s `referenced_schema` column work the same
across schemas.

Because an unqualified parent binds to the **child's own schema**, a table in one
schema that names a parent living in another resolves to a table that is not
there — the foreign key is declared but can never be satisfied. The remedy is to
qualify the parent; the missing-parent diagnostic below names the schema it
looked in so this case is visible from the error alone.

**Reference Actions:**
```sql
[on delete action] [on update action]
```

Where `action` can be:
- `set null` — set child FK columns to NULL when parent row is deleted/updated
- `set default` — set child FK columns to their default values
- `cascade` — delete/update child rows when parent row is deleted/updated
- `restrict` (default) — immediately reject delete/update if child rows exist
- `no action` — currently treated as a synonym for `restrict`

**Enforcement Semantics:**

When `pragma foreign_keys = on` (the default):

- **Child-side (INSERT/UPDATE):** Validates that referenced parent rows exist. These checks are deferred to commit time (they use cross-table subqueries). Uses MATCH SIMPLE semantics (SQL default): if any FK column is NULL, the constraint is satisfied without checking the parent table. If the referenced parent table does not exist, non-NULL FK rows are rejected.
- **Parent-side DELETE/UPDATE with RESTRICT:** Immediately rejects the operation if child rows reference the parent row being modified. Two layers of enforcement run: a plan-time `NOT EXISTS` synthesized into the DML's constraint-check node, and a runtime `select 1 from <child> where <fk> = ? limit 1` pre-check fired by the DML executor before the vtab `xUpdate` call. The runtime pass is defense-in-depth so any vtab module — including those whose subquery evaluation diverges from a plain row scan — sees a consistent enforcement path. The check honours MATCH SIMPLE (NULL parent values cannot be referenced) and, on UPDATE, skips when no referenced parent column actually changed.
- **Parent-side DELETE/UPDATE with CASCADE:** Automatically deletes or updates matching child rows.
- **Parent-side DELETE/UPDATE with SET NULL:** Sets child FK columns to NULL.
- **Parent-side DELETE/UPDATE with SET DEFAULT:** Sets child FK columns to their default values.

On UPDATE, all three propagating actions (CASCADE / SET NULL / SET DEFAULT) apply the same short-circuit as the RESTRICT check above: if the update leaves every parent column the FK references at its old value, the action does not fire and child rows are not written at all — an update to an unrelated parent column never touches, re-points, or emits a data-change event for the children.

Cascade cycle detection prevents infinite recursion when cascading actions chain across multiple tables.

**A parent key tuple containing NULL is unreferenceable.** A primary key may hold NULL (see [§ 7.1](#71-primary-key-constraint)), and so may a `UNIQUE` parent column, so `references <parent>` — with or without a column list — can point at a parent row whose key contains NULL. MATCH SIMPLE settles what happens, in both directions, with no rule specific to primary keys:

- A child row whose FK columns are all non-NULL compares with `=` against the parent columns. `=` against NULL is never true, so it never matches a NULL-containing parent key and the child row is **rejected** (no such parent).
- A child row with NULL in any FK column is admitted unchecked — that is MATCH SIMPLE, and it is why a NULL-containing parent key can never be the thing that satisfies a reference.
- Every parent-side action skips a parent tuple containing NULL for the same reason: `restrict` does not fire for it, and `cascade` / `set null` / `set default` do not propagate from it.

The practical consequence: a row whose primary key contains NULL can be deleted freely regardless of `on delete restrict`, because nothing can legally reference it.

**When a foreign key cannot be enforced:**

Parent resolution happens **per plan**, not once at `CREATE TABLE` — that is what makes forward references ([sql-ddl.md § *Order Independence*](sql-ddl.md#semantics-and-features)) work, and it means a key can become unenforceable long after it was declared. Two cases, and what each reports:

- **The parent table does not exist** (never created, dropped since, or — see the note on unqualified parents under *Syntax* above — named without a qualifier from a child in another schema). MATCH SIMPLE still applies: a row with any NULL FK column is accepted. Every other row is rejected with

  ```
  CHECK constraint failed: <fk name> — referenced table '<schema>.<parent>' does not exist
  ```

  The schema in that message is the one the lookup used, so an unqualified cross-schema reference is diagnosable from the error: qualify the parent. This is *not* a `CREATE TABLE` refusal — declaring a child before its parent stays legal.

- **The child's column count does not match the parent key.** Writing an explicit parent column list of the wrong length (`references p(a, b)` from a one-column key) is refused at declaration time. The defaulted form, `references <parent>` with no column list, resolves to the parent's **primary key** — whose arity is not knowable at declaration time — so a mismatch there is raised at the enforcement seam instead, failing the statement:

  ```
  Foreign key '<name>' on table '<schema>.<child>': <n> column(s) reference the primary key of '<schema>.<parent>', which has <m> column(s).
  ```

  Both the child-side existence check and every parent-side path (RESTRICT, CASCADE / SET NULL / SET DEFAULT) raise it, so an unenforceable key never looks enforced. Read queries and `foreign_key_info()` are unaffected.

  Watch for this on a parent declared with **no** `primary key`: Quereus gives such a table an all-columns primary key ([§ 7.1](#71-primary-key-constraint)), so `references p` against a three-column PK-less parent is a three-column reference, and a single-column child FK is a mismatch. Declare the parent's key, or write the parent column list explicitly.

Neither case fires while `pragma foreign_keys = off` — no checks are built at all, on either side of the key.

**Examples:**
```sql
-- Column-level foreign key (no action clause = RESTRICT default)
create table posts (
  id integer primary key,
  user_id integer references users(id),
  title text not null
);

-- Table-level foreign key with explicit actions
create table comments (
  id integer primary key,
  post_id integer,
  user_id integer,
  content text not null,
  foreign key (post_id) references posts(id) on delete cascade,
  foreign key (user_id) references users(id) on delete set null
);
```

### 7.7 Creating Indexes

Indexes improve query performance for specific columns.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (column [asc|desc][, ...]) [where condition]
```

**Examples:**
```sql
-- Simple index
create index idx_users_email on users(email);

-- Multi-column index
create index idx_posts_user_date on posts(user_id, created_at desc);

-- Partial index with WHERE clause
create index idx_active_users on users(last_login) where status = 'active';

-- Unique index
create unique index idx_products_sku on products(sku);
```

### 7.8 Dropping Indexes

**Syntax:**
```sql
drop index [if exists] index_name
```

**Example:**
```sql
drop index idx_users_email;
```
