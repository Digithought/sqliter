# SQL Data Manipulation — INSERT, UPDATE, DELETE & RETURNING

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 2.2 INSERT Statement

The insert statement adds new rows to a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](sql-views.md#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  insert [or conflict_resolution] into table_name [(column [, column...])]
  { values (expr [, expr...]) [, (expr [, expr...])]... | select_statement }
  [ with context (variable = expr [, ...]) ]
  [ with schema schema_name [, schema_name...] ]
  [ returning { * | table.* | [qualifier.]expr [ [as] alias ] } [, ...] ]

conflict_resolution:
  rollback | abort | fail | ignore | replace

upsert_clause:
  on conflict [ (column [, column ...]) ] do nothing
  | on conflict [ (column [, column ...]) ] do update set assignment [, assignment ...] [ where condition ]

assignment:
  column = expression
```

**Options:**
- `with clause`: Common Table Expressions for use in the insert — visible to every clause of the statement, including the source, a subquery in a `values` row, and `returning` (see [§3.7 WITH Clause](sql-select.md#37-with-clause-common-table-expressions))
- `or conflict_resolution`: Specifies how to handle constraint conflicts (see Conflict Resolution below)
- `table_name`: Target table for the insertion
- `column`: Optional list of columns to insert into
- `values`: A list of value sets to insert
- `select_statement`: A select query whose results are inserted
- `upsert_clause`: Specifies how to handle conflicts with fine-grained control (see UPSERT below)
- `with context`: Provides table-level parameters for defaults and constraints (see [§2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters))
- `with schema`: Specifies schema search path for resolving table names (see [§2.1.1 Schema Search Path](sql-select.md#211-schema-search-path-with-schema))
- `returning`: Returns specified expressions from the inserted rows. `*` (or `table.*`) expands to every table column in declaration order, projecting the NEW (inserted) image; named expressions support the NEW qualifier

### Conflict Resolution (OR clause)

When inserting a row that would violate a `UNIQUE`, `PRIMARY KEY`, `NOT NULL`, `CHECK`, or `FOREIGN KEY` constraint, the `OR` clause specifies how to handle the conflict:

- **`OR ROLLBACK`**: Abort the current statement *and* automatically roll back the enclosing transaction (implicit or explicit). Any prior writes inside the transaction are discarded.
- **`OR ABORT`**: Abort the current statement (default behavior). In autocommit mode the implicit transaction rolls back; inside an explicit transaction the prior writes are preserved (you must `ROLLBACK` manually if you want them undone).
- **`OR FAIL`**: Abort the current statement but commit prior rows of the same statement that succeeded before the violation. Inside an explicit transaction those rows simply remain in the pending transaction.
- **`OR IGNORE`**: Silently skip the row that would cause a conflict and continue with the next row.
- **`OR REPLACE`**: For `UNIQUE`/`PRIMARY KEY` conflicts, delete the existing row and insert the new one (destructive—loses unspecified column values). For `NOT NULL` conflicts, substitute the column's `DEFAULT` value if one is declared (otherwise behaves like `ABORT`). `CHECK` and foreign-key constraints are *not* relaxed by `REPLACE` — those still abort.

**Per-constraint defaults.** A column- or table-level constraint may carry its own `ON CONFLICT <action>` clause:

```sql
create table products (
  sku text primary key on conflict ignore,           -- duplicate INSERTs silently skipped
  name text not null on conflict ignore,             -- NULL name → row skipped
  price real check (price > 0) on conflict ignore,   -- non-positive price → row skipped
  email text unique on conflict replace              -- duplicate email → existing row replaced
);
```

The action precedence is: **statement-level OR clause > per-constraint default > ABORT**. So `INSERT OR ABORT INTO products ...` overrides every column-level directive above.

**Note:** The `OR` clause and `ON CONFLICT DO ...` clause are mutually exclusive. Use `OR REPLACE` for simple full-row replacement, and `ON CONFLICT DO UPDATE` for surgical column-level updates.

**INSERT only.** The `OR <action>` clause is **only accepted on `INSERT`**. Quereus does not support SQLite's `UPDATE OR <action>` (or `DELETE OR <action>`) per-statement override — that syntax has no precedent outside SQLite (Postgres, SQL Server, MySQL, Oracle, and ANSI SQL all lack it). For UPDATE conflict handling, use the schema-level `ON CONFLICT <action>` declared on the constraint, or rewrite the UPDATE with `WHERE NOT EXISTS (...)` / explicit `DELETE` + `UPDATE` inside a transaction.

### UPSERT (ON CONFLICT clause)

The `ON CONFLICT` clause provides fine-grained control over conflict handling, allowing you to update specific columns rather than replacing the entire row.

**Syntax:**
```sql
insert into table_name (columns) values (...)
  on conflict [ (conflict_columns) ] do nothing | do update set assignments [ where condition ]
```

**Conflict Target:**
- `ON CONFLICT (col1, col2, ...)` — Specifies which unique constraint to match. The columns must correspond to a PRIMARY KEY or UNIQUE constraint.
- `ON CONFLICT` (without columns) — Matches any unique constraint violation.

A targeted conflict is matched the way the named constraint *enforces* uniqueness: the target
column's affinity is applied to the proposed value and it is compared under the constraint's
collation, or — for a column whose declared type defines its own notion of equal values
(TIMESPAN, JSON; see [types-ordering.md § Semantic ordering](types-ordering.md)) — under that type. So a conflict
that arises only through collation (e.g. `'abc'` proposed against a stored `'ABC'` under
`COLLATE NOCASE`), through affinity (e.g. `'1'` proposed against a stored integer `1` on an
`INTEGER` key), or through a re-spelling of the same value (`'PT60M'` against a stored `'PT1H'`
on a `TIMESPAN` key) still routes to the `DO UPDATE` / `DO NOTHING` arm rather than aborting
with a UNIQUE error. A conflict on a *different* unique constraint than the one named still
aborts.

**Actions:**
- `DO NOTHING` — Silently skip the conflicting row (equivalent to `INSERT OR IGNORE`)
- `DO UPDATE SET col = expr, ...` — Update specific columns on the existing row

**Referencing Values:**
- `NEW.column` or `excluded.column` — References the value that was proposed for insertion (PostgreSQL compatibility via `excluded`)
- `column` or `table.column` — References the current value in the existing row
- The `WHERE` clause can use both to conditionally apply updates

**Generated Columns:**

`DO UPDATE` treats them exactly as `UPDATE` does — a generated column may not appear as a SET
target (`Cannot UPDATE generated column '<name>'`), and every generated column of the table is
recomputed from the updated row after the SET assignments are applied, in dependency order
(see *Generated Columns* in [sql-ddl.md](sql-ddl.md)).

**Constraint validation on the DO UPDATE arm:**

The row a `DO UPDATE` arm composes — the conflicting stored row, plus the SET assignments,
plus the recomputed generated columns — is validated **exactly as the equivalent plain
`UPDATE` of that row would be**, before anything is written. That means UPDATE-scoped
`CHECK` constraints (so a `check ... on insert` does *not* fire here and a `check ... on
update` does), `NOT NULL`, child-side foreign keys (the composed row must reference a live
parent), and parent-side foreign keys (a change to a referenced column with a live
`RESTRICT` child is refused). A transition CHECK sees the conflicting **stored** row as
`OLD`. A per-constraint `ON CONFLICT <action>` default applies to a violation raised here —
`IGNORE` skips the row silently, and `NOT NULL ... ON CONFLICT REPLACE DEFAULT <expr>`
substitutes the default into the composed row. A CHECK carrying a subquery is auto-deferred
and evaluated at `COMMIT`, again matching the plain `UPDATE`.

Two things this does *not* change:

- The statement's INSERT-shaped checks still run first, on the **proposed** row, before the
  conflict is known (matching SQLite). A proposed row that violates a CHECK aborts even when
  the `DO UPDATE` arm would have stored a legal value.
- `DO NOTHING` writes nothing and gains no validation, and a clause `WHERE` that skips the
  row short-circuits before any of it.

**Key Differences from OR REPLACE:**

| Feature | `INSERT OR REPLACE` | `ON CONFLICT DO UPDATE` |
|---------|---------------------|-------------------------|
| Behavior | Deletes existing row, inserts new | Updates existing row in place |
| Unspecified columns | Lost (reset to defaults) | Preserved |
| Conditional update | Not supported | Supported via `WHERE` |
| Column-level control | No | Yes |
| Triggers | DELETE + INSERT | UPDATE |

**Examples:**
```sql
-- Basic insert with explicit columns
insert into users (name, email, age) values ('John', 'john@example.com', 35);

-- Multiple rows insert
insert into products (name, price, category) 
  values 
    ('Keyboard', 49.99, 'Electronics'),
    ('Mouse', 29.99, 'Electronics'),
    ('Headphones', 99.99, 'Audio');

-- Insert from select
insert into active_users (id, name, email)
  select id, name, email from users where last_login > date('now', '-30 days');

-- INSERT with RETURNING clause
insert into users (name, email) 
  values ('Alice', 'alice@example.com')
  returning id, name, datetime('now') as created_at;

-- INSERT with RETURNING used in a larger query
select 'User created: ' || new_user.name as message
from (
  insert into users (name, email) 
  values ('Bob', 'bob@example.com')
  returning name
) as new_user;

-- With CTE
with recent_orders as (
  select * from orders where order_date > date('now', '-7 days')
)
  insert into order_summary (order_id, customer, total)
    select id, customer_name, sum(price * quantity) 
    from recent_orders
    group by id, customer_name
    returning order_id, total;

-- INSERT OR REPLACE (full row replacement)
insert or replace into users (id, name, email, updated_at)
  values (1, 'Alice', 'alice@example.com', datetime('now'));
-- If a user with id=1 exists, it is DELETED and replaced; otherwise, a new row is inserted
-- WARNING: Any columns not in the insert list are reset to defaults!

-- INSERT OR IGNORE (skip conflicts)
insert or ignore into tags (name)
  values ('javascript'), ('typescript'), ('javascript');
-- Only inserts 'javascript' and 'typescript' once, skipping the duplicate

-- UPSERT: Insert or update specific columns (preserves other columns)
insert into users (id, name, email)
  values (1, 'Alice', 'alice@example.com')
  on conflict (id) do update set
    name = NEW.name,
    email = NEW.email;
-- If id=1 exists, updates only name and email; other columns (like created_at) are preserved

-- UPSERT with increment pattern
insert into vocabulary (word, count)
  values ('hello', 1)
  on conflict (word) do update set
    count = count + 1;
-- Inserts with count=1, or increments existing count

-- UPSERT with conditional update (only update if newer)
insert into documents (id, content, version)
  values (100, 'new content', 5)
  on conflict (id) do update set
    content = NEW.content,
    version = NEW.version
  where NEW.version > version;
-- Only updates if the new version is greater than existing

-- UPSERT with DO NOTHING (same as INSERT OR IGNORE)
insert into tags (name)
  values ('javascript'), ('typescript'), ('javascript')
  on conflict (name) do nothing;

-- UPSERT on composite key
insert into user_roles (user_id, role_id, granted_at)
  values (1, 2, datetime('now'))
  on conflict (user_id, role_id) do update set
    granted_at = NEW.granted_at;

-- Multiple ON CONFLICT clauses (evaluated in order)
insert into products (id, sku, name, price)
  values (1, 'ABC123', 'Widget', 9.99)
  on conflict (id) do update set name = NEW.name, price = NEW.price
  on conflict (sku) do update set price = NEW.price;
-- First matching conflict target wins

-- UPSERT with RETURNING
insert into counters (key, value)
  values ('page_views', 1)
  on conflict (key) do update set value = value + 1
  returning key, value, 
    case when value = NEW.value then 'inserted' else 'updated' end as action;
```

## 2.3 UPDATE Statement

The update statement modifies existing rows in a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](sql-views.md#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  update table_name
    set column = expr [, column = expr...]
    [ where condition ]
    [ with context (variable = expr [, ...]) ]
    [ with schema schema_name [, schema_name...] ]
    [ returning { * | table.* | [qualifier.]expr [ [as] alias ] } [, ...] ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the update — visible to `set`, `where` and `returning` alike (see [§3.7 WITH Clause](sql-select.md#37-with-clause-common-table-expressions))
- `table_name`: Table to be updated
- `set`: Column assignments with new values
- `where`: Optional condition to specify which rows to update
- `with context`: Provides table-level parameters for defaults and constraints (see [§2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters))
- `with schema`: Specifies schema search path for resolving table names (see [§2.1.1 Schema Search Path](sql-select.md#211-schema-search-path-with-schema))
- `returning`: Returns specified expressions from the updated rows. `*` (or `table.*`) expands to every table column in declaration order, projecting the NEW (updated) image by default; named expressions support the OLD and NEW qualifiers

**Examples:**
```sql
-- Simple update
update users set status = 'inactive' where last_login < date('now', '-90 days');

-- Multi-column update with RETURNING
update products 
  set price = price * 1.1, 
      updated_at = datetime('now')
  where category = 'Electronics'
  returning id, name, price, updated_at;

-- Update with OLD and NEW qualifiers
update employees 
  set salary = salary * 1.05 
  where performance_rating >= 4
  returning id, OLD.salary as old_salary, NEW.salary as new_salary, 
           (NEW.salary - OLD.salary) as increase;

-- UPDATE with RETURNING clause
update users 
  set last_login = datetime('now')
  where id = 42
  returning id, name, last_login;

-- UPDATE with RETURNING used as table source
select 'Updated: ' || updated.name || ' to ' || updated.new_status as message
from (
  update users 
  set status = 'premium', updated_at = datetime('now')
  where subscription_type = 'paid'
  returning name, status as new_status
) as updated;

-- Update with expression
update orders
  set 
    total = (select sum(price * quantity) from order_items where order_id = orders.id),
    status = case 
      when paid = 1 then 'completed' 
      else 'pending' 
    end
  where order_date > date('now', '-30 days')
  returning id, OLD.status, NEW.status, NEW.total;

-- With CTE
with discounted_items as (
  select product_id, price * 0.8 as sale_price
  from products
  where category = 'Clearance'
)
  update products
    set price = di.sale_price
    from discounted_items as di
    where products.id = di.product_id
    returning id, OLD.price as original_price, NEW.price as sale_price;
```

## 2.4 DELETE Statement

The delete statement removes rows from a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](sql-views.md#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
delete from table_name
[ where condition ]
[ with context (variable = expr [, ...]) ]
[ with schema schema_name [, schema_name...] ]
[ returning { * | table.* | [qualifier.]expr [ [as] alias ] } [, ...] ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the delete — visible to `where` and `returning` alike (see [§3.7 WITH Clause](sql-select.md#37-with-clause-common-table-expressions))
- `table_name`: Table to delete from
- `where`: Optional condition to specify which rows to delete
- `with context`: Provides table-level parameters for defaults and constraints (see [§2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters))
- `with schema`: Specifies schema search path for resolving table names (see [§2.1.1 Schema Search Path](sql-select.md#211-schema-search-path-with-schema))
- `returning`: Returns specified expressions from the deleted rows. `*` (or `table.*`) expands to every table column in declaration order, projecting the OLD (deleted) image; named expressions support the OLD qualifier

**Examples:**
```sql
-- Simple delete
delete from users where status = 'deactivated';

-- DELETE with RETURNING clause
delete from users 
  where last_login < date('now', '-365 days')
  returning id, name, email;

-- DELETE with RETURNING used for audit logging
insert into deleted_users_audit (user_id, name, deleted_at)
select deleted.id, deleted.name, datetime('now')
from (
  delete from users 
  where status = 'spam'
  returning id, name
) as deleted;

-- Delete with subquery
delete from products
  where id in (
    select product_id 
    from inventory 
    where stock = 0 and last_updated < date('now', '-180 days')
  )
  returning id, name, category;

-- With CTE
with old_orders as (
  select id from orders where order_date < date('now', '-365 days')
)
  delete from order_items
  where order_id in (select id from old_orders);
```

## 2.5 RETURNING Clause with NEW/OLD Qualifiers

The RETURNING clause allows you to retrieve values from rows that were inserted, updated, or deleted in a DML operation. Quereus supports NEW and OLD qualifiers to distinguish between original and modified values.

**Syntax:**
```sql
returning result_column [, result_column...]

result_column:
  { * | [qualifier.]column_name | expression } [ [ as ] alias ]

qualifier:
  { NEW | OLD }
```

### 2.5.1 Operation-Specific Rules

**INSERT Operations:**
- `NEW`: References the inserted values ✅
- `OLD`: Not allowed (will cause error) ❌
- Unqualified columns: Default to NEW values

**UPDATE Operations:**
- `NEW`: References the updated values ✅
- `OLD`: References the original values before update ✅
- Unqualified columns: Default to NEW values

**DELETE Operations:**
- `OLD`: References the deleted values ✅
- `NEW`: Not allowed (will cause error) ❌
- Unqualified columns: Default to OLD values

**`*` / `table.*` expansion:** A `*` (or table-qualified `table.*`) expands, in
place, to every column of the target in declaration order — so `returning id, *`
and `returning *, expr` keep the surrounding items in position. Each expanded
column follows the unqualified-default image rule above: the NEW image for
INSERT/UPDATE, the OLD image for DELETE. Output column names are the bare column
names regardless of any qualifier. A `table.*` qualifier must name the target
table; any other name is an error. Through a view, `*` expands to the *view's*
output columns (in view order), not the base table's, and a `view.*` qualifier
must name the view (or, for an inline-subquery / CTE target, its correlation
name) — any other qualifier is the same error.

### 2.5.3 Advanced RETURNING Examples

**Audit Trail with UPDATE:**
```sql
-- Track all changes for audit purposes
update customer_profiles 
  set email = 'new.email@example.com', phone = '555-0123'
  where customer_id = 42
  returning 
    customer_id,
    OLD.email as old_email,
    NEW.email as new_email,
    OLD.phone as old_phone,
    NEW.phone as new_phone,
    datetime('now') as changed_at;
```

**Calculating Differences:**
```sql
-- Calculate price changes
update inventory 
  set quantity = quantity - 5, last_updated = datetime('now')
  where product_id in (101, 102, 103)
  returning 
    product_id,
    OLD.quantity as stock_before,
    NEW.quantity as stock_after,
    OLD.quantity - NEW.quantity as items_sold,
    NEW.last_updated;
```

**Conditional RETURNING with CASE:**
```sql
-- Conditional logic in RETURNING clause
update user_accounts 
  set login_attempts = login_attempts + 1
  where username = 'user123'
  returning 
    user_id,
    username,
    NEW.login_attempts,
    case 
      when NEW.login_attempts >= 5 then 'LOCKED'
      when NEW.login_attempts >= 3 then 'WARNING'
      else 'NORMAL'
    end as account_status,
    case
      when OLD.login_attempts < 3 and NEW.login_attempts >= 3 then 'Security alert triggered'
      else 'Login attempt recorded'
    end as message;
```
