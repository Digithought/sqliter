# SQL Schema Definition — DDL

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 2.0 Declarative Schema (Optional, Order-Independent)

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

Quereus keeps traditional DDL fully intact. Declarative schema is an optional alternative for describing the desired end‑state in a single, order‑independent block. Modules continue to use DDL‑based interfaces; declarative workflows operate entirely in the engine and produce DDL.

**Concepts:**
- **Schema**: Named logical grouping of objects; may span multiple modules.
- **Catalog**: The set of objects owned by a module; may span multiple schemas.
- **Diff**: JSON representation of changes needed to align actual state with declared schema.
- **Apply**: Automatic execution of migration DDL statements.

**Key Statements:**

1. `declare schema` – Describes desired end‑state and stores declaration with optional seed data.
2. `diff schema` – Compares declared schema with current state and returns JSON diff.
3. `apply schema` – Executes the generated migration DDL, optionally applying seed data.
4. `explain schema` – Returns the schema content hash for versioning.

### Declaration Syntax

```sql
declare schema schema_name
  [version 'major.minor.patch']
  [using (default_vtab_module = 'memory', default_vtab_args = '{}')]
{
  -- Tables: use {...} or (...) for column definitions
  table users {
    id integer primary key,
    email text not null unique,
    name text not null,
    created_at text not null default (datetime('now'))
  }
  
  -- Or with explicit USING clause
  table sessions (
    id text primary key,
    user_id integer not null,
    expires_at integer
  ) using memory;

  table roles {
    id integer primary key,
    name text not null unique
  }

  table user_roles (
    user_id integer not null,
    role_id integer not null,
    constraint pk_user_roles primary key (user_id, role_id),
    constraint fk_user foreign key (user_id) references users(id),
    constraint fk_role foreign key (role_id) references roles(id)
  );

  -- Indexes (optional `unique`, optional partial `where`, optional `with tags`)
  index users_email on users(email);
  unique index users_active_email on users(email) where created_at is not null;

  -- Views
  view v_user_roles as
    select u.id as user_id, u.email, r.name as role
    from users u join user_roles ur on u.id = ur.user_id
                 join roles r on ur.role_id = r.id;

  -- Seed data: ( (row1_values), (row2_values), ... )
  seed roles (
    (1, 'admin'),
    (2, 'viewer')
  )
  
  -- Or with explicit column names
  seed users values (id, email, name) values
    (1, 'admin@example.com', 'Admin'),
    (2, 'viewer@example.com', 'Viewer');

  -- Assertions: enforced at commit time
  assertion positive_balance check (not exists (select 1 from users where balance < 0))

  -- Future: domains, collations, and imports
  -- domain email_address as text check (like(value, '%@%'));
  -- collation nocase = nocase();
  -- import schema auth from 'https://example.com/auth-schema.sql' cache 'auth@1' version '^2';
}
```

### Diffing and Applying

```sql
-- Get migration DDL as result rows (one DDL statement per row)
diff schema main;
-- Returns rows like:
--   {"ddl": "create table users (...)"}
--   {"ddl": "drop table old_table"}
-- Returns no rows if schema is already aligned

-- Execute DDL yourself with custom migration logic
-- TypeScript example:
--   for await (const {ddl} of db.eval('diff schema main')) {
--     console.log('Executing:', ddl);
--     await db.exec(ddl);
--     // Insert custom backfill/transform logic here
--   }

-- Or use apply to execute automatically (no result rows)
apply schema main;

-- Apply with seed data (clears and repopulates)
apply schema main with seed;

-- Get schema hash for versioning
explain schema main;
-- Returns: {"info": "hash:a1b2c3d4e5f6"}

-- Future: versioned apply with options
apply schema main to version '1.0.0' options (
  dry_run = false,
  validate_only = false,
  allow_destructive = false,
  rename_policy = 'require-hint'
);
```

### Semantics and Features

**Order Independence:**
- Tables, indexes, and views can be declared in any order within the `{...}` block.
- Forward references are allowed (e.g., foreign keys to tables declared later).

**Flexible Syntax:**
- Column definitions accept brace syntax `{...}` or traditional parentheses `(...)`.
- Identifiers are only quoted when they are reserved keywords or contain special characters.

**Schema Diffing:**
- Compares the declared schema against the current database catalog.
- Generates a JSON diff showing tables/views/indexes to create, drop, or alter.
- Produces canonical DDL statements for all required changes.

**Migration Application:**
- `apply schema` executes the migration DDL automatically.
- Migrations are applied in safe order: drops first, then creates, then alters.
- Seed data application: `with seed` clears existing data and inserts declared seed rows.

**Versioning and Hashing:**
- Schema declarations can include semantic versions.
- `explain schema` computes a SHA-256 hash of the canonical schema representation.
- Enables tracking schema changes and ensuring consistency across environments.

**Safety:**
- Seed data application is destructive (clears table before inserting).
- `allow_destructive` is **enforced for one case today**: a backing-module change on a maintained table (`materialized view … using <module>` or `create table … maintained as … using <module>`). Such a move physically relocates the table to a different store with no in-place primitive, so it is realized as a `DROP TABLE` + `create materialized view … using <newmodule>` that **mints a new incarnation** (changing row identity for a replicated/synced table). `apply schema` aborts — before any DDL runs — unless re-run with `options (allow_destructive = true)`:

  ```sql
  -- Re-declared with a moved backing module; refused without the ack:
  apply schema main;
  -- Error: backing-module change on maintained table(s) 'mv' is destructive
  --        (drop + recreate, new incarnation). Re-run with options
  --        (allow_destructive = true) to migrate the backing.

  -- Acknowledged — drops + recreates, re-materializing the body into the new module:
  apply schema main options (allow_destructive = true);
  ```

  `diff schema` surfaces the `DROP TABLE` / `create materialized view` DDL unconditionally (it is a read-only preview, never gated). Other drops are **not yet** gated — a general `allow_destructive` gate over all destructive schema changes remains future work.
- Rename hints prevent accidental drops during renames — see "Rename detection" below.

**Rename detection (`rename_policy`):**

`apply schema` understands rename hints carried via the reserved `quereus.id` and `quereus.previous_name` tags (see §2.6.3). The `rename_policy` option in `OPTIONS (...)` controls how strictly the differ behaves when names change:

| Value | Behavior |
|-------|----------|
| `'allow'` (default) | Use hints when present; without hints, fall through to drop+create. |
| `'require-hint'` | Reject any name change that lacks a hint — if drops *and* creates of the same kind both remain after rename matching, error rather than executing destructive DDL. |
| `'deny'` | Ignore hints entirely. Any name mismatch becomes drop+create. Escape hatch for opting back into the legacy behavior. |

A rename detected via `quereus.id` is authoritative: when both `id` and `previous_name` would resolve, `id` wins. A *conflict* — declared name and the hint resolving to two distinct existing actuals — is always an error regardless of policy.

Renames apply to tables, views, indexes, named constraints (CHECK / UNIQUE / FOREIGN KEY, either table-level `CONSTRAINT <name> ...` or a column-level constraint carrying a name), and columns. Tables and columns rename via the `ALTER TABLE ... RENAME` / `RENAME COLUMN` primitives, which propagate references through dependent CHECK expressions, FK targets, partial-index predicates, view bodies, and materialized-view bodies. Named constraints rename via the `ALTER TABLE ... RENAME CONSTRAINT` primitive. The differ also detects constraint **drops** (a named constraint present in the catalog but absent from the declaration → `DROP CONSTRAINT`) and **adds** (a declared named constraint absent from the catalog → `ADD CONSTRAINT`; CHECK applies in place, UNIQUE / FK adds depend on module support — see §2.7). Only **user-named** constraints participate — engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names for unnamed constraints) and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` are excluded (the latter are managed through their index). View and index renames still fall back to drop+recreate when no rename primitive exists.

**Notes:**
- Keywords `schema`, `version`, and `seed` are contextual and don't conflict with column names or function calls like `schema()`.
- DDL remains the primary interface; declarative schema is a convenience layer that generates DDL.
- Modules are unaware of declarative schemas; they receive standard DDL commands.


## 2.6 CREATE TABLE Statement

The create table statement defines a new table structure.  Note that all tables are "without rowid" implicitly.

**Syntax:**
```sql
create table [if not exists] table_name (
  column_definition [, column_definition...]
  [, table_constraint...]
)
[using module_name [(module_args...)]]
[with tags (key = value [, ...])]
```

**Column Definition:**
```sql
column_name [data_type] [column_constraint...] [with tags (key = value [, ...])]
```

**Column Constraints:**
```sql
[constraint name]
{ primary key [asc | desc] [conflict_clause] [autoincrement]
| not null [conflict_clause]
| unique [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| default value
| collate collation_name
| references foreign_table [(column[,...])] [ref_actions]
| generated always as (expr) [stored | virtual] }
[with tags (key = value [, ...])]
```

**Table Constraints:**
```sql
[constraint name]
{ primary key ([column [asc | desc][,...]]) [conflict_clause]
| unique (column[,...]) [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| foreign key (column[,...]) references foreign_table [(column[,...])] [ref_actions] }
[with tags (key = value [, ...])]
```

**Conflict Clause:**
```sql
on conflict { rollback | abort | fail | ignore | replace }
```

**Options:**
- If an empty key column list is provided, the table may have 0 or 1 rows.
- `if not exists`: Creates the table only if it doesn't already exist
- `column_definition`: Defines a column with optional constraints
- `table_constraint`: Defines a table-level constraint
- `using module_name`: Specifies a virtual table module

**Examples:**
```sql
-- Basic table with constraints
create table employees (
  id integer primary key,
  name text not null,
  email text unique collate nocase,
  department text default 'General',
  salary real check (salary >= 0),
  hire_date text,
  manager_id integer references employees(id)
);

-- Table with composite key and multiple constraints
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null check on insert (quantity > 0),
  price real not null check (price >= 0),
  discount real default 0 check (discount >= 0 and discount <= 1),
  primary key (order_id, product_id),
  foreign key (order_id) references orders(id),
  foreign key (product_id) references products(id)
);

-- Memory-backed virtual table
create table cache (
  key text primary key,
  value blob,
  expires_at integer
) using memory;

-- Table with generated (computed) columns
create table products (
  id integer primary key,
  base_price integer not null,
  tax_rate real not null default 0.1,
  total_price real generated always as (base_price * (1 + tax_rate)) stored,
  label text generated always as ('Product #' || id) virtual
);
```

**Generated Columns:**

Generated columns are computed from an expression over other columns in the same row:

- `STORED`: The value is computed at INSERT/UPDATE time and persisted. Reads return the stored value directly.
- `VIRTUAL`: Semantically computed on read (currently stored identically to STORED; storage optimization is planned).
- If neither `STORED` nor `VIRTUAL` is specified, `VIRTUAL` is the default.
- Generated column expressions must be deterministic. They may reference any column of the same table, including other generated columns; their dependency graph must be acyclic and self-references are rejected at `CREATE TABLE` / `ALTER TABLE ADD COLUMN` time.
- Cannot have both `DEFAULT` and `GENERATED ALWAYS AS` on the same column.
- Cannot INSERT into or UPDATE a generated column directly.
- `ALTER TABLE ... DROP COLUMN` of a column referenced by another generated column's expression is rejected; drop the referencing generated column first.

**CHECK Constraints:**

- `check (expr)` is enforced on INSERT and UPDATE by default; `check on {insert | update | delete}[,...]` restricts the operations. Unqualified columns name the NEW row (the OLD row for DELETE-only checks); `old.<col>` / `new.<col>` reference either row image explicitly.
- Comparisons inside a CHECK resolve **declared column collations** (and explicit `COLLATE` wrappers), exactly like the same expression in a query — `check (c = 'abc')` over a `text collate nocase` column accepts any case-variant. Resolution follows the engine's symmetric provenance lattice (explicit `COLLATE` > declared column collation > defaulted collation > BINARY; see `docs/types.md` § Comparison collation resolution), so `check (b = c)` and `check (c = b)` behave identically.
- A CHECK containing a subquery is automatically deferred to transaction commit; the deferred evaluation runs the same compiled predicate, so collation semantics are identical to the immediate path.

**Default Values:**

A column `DEFAULT` supplies the value when an INSERT omits the column; an explicitly supplied value always wins. The expression must be deterministic and may not reference bind parameters.

- A default may read a sibling **the INSERT supplies** via `new.<column>` — e.g. `slug text default (lower(new.title))` or `total integer default (new.subtotal + tax)`. Only INSERT-supplied columns are visible, so a default never depends on another column's default (which would impose an evaluation-order race); referencing an omitted column raises a resolution error. The same `new.<column>` surface also resolves at the **shared-key view-write envelope** (an anchor key default reading a supplied sibling — see [vu-mutation-context.md § Mutation context](vu-mutation-context.md#mutation-context)).
- A **bare** (unqualified) column reference is rejected at `CREATE TABLE` — use `new.<column>` to read a supplied value, or `GENERATED ALWAYS AS` to compute from any sibling. (With a `with context (...)` clause an unqualified identifier may instead resolve to a mutation-context variable.)
- `mutation_ordinal()` (the 1-based per-row ordinal) and mutation-context variables are also available in default position. See [vu-mutation-context.md § Mutation context](vu-mutation-context.md#mutation-context).
- `ALTER TABLE … ALTER COLUMN … SET DEFAULT` routes the new default through the **same** validator `CREATE TABLE` uses: bind parameters / bare columns / non-deterministic expressions are rejected at `ALTER` time, and a `new.<column>` default is accepted (its build is deferred to INSERT time, exactly as on `CREATE TABLE`). `DROP DEFAULT` clears the default.
- `ALTER TABLE … ADD COLUMN … DEFAULT (…)` accepts the same default expressions (the shared validator rejects bind parameters / bare columns / non-determinism). Existing rows are **backfilled per row**: `new.<column>` resolves to the *existing* row's sibling (e.g. `add column doubled integer default (new.base * 2)` sets each existing row's `doubled` from its own `base`), while a literal default is bulk-written. Future inserts derive the column from the INSERT-supplied sibling, so an insert that omits that sibling raises the same resolution error as the single-source path. An `ADD COLUMN NOT NULL` whose per-row backfill yields NULL for any existing row is rejected and the column is not added.

## 2.6.1 CREATE/DROP ASSERTION (Global Integrity Constraints)

Quereus supports database-wide integrity assertions evaluated at COMMIT time.

Syntax:
```sql
create assertion assertion_name check (condition_expression);
drop assertion assertion_name;
```

Behavior:
- Assertions are enforced at COMMIT. Any row produced by the stored violation query indicates a violation and the COMMIT fails with a constraint error (transaction rolled back).
- The `check (expr)` is stored as a violation SQL: `select 1 where not (expr)`.
- Efficiency: The optimizer classifies each table reference instance in the violation query as row-specific (unique key fully covered) or global. If any changed base is global, run the violation SQL once. Otherwise, for row-specific references, the engine executes per changed primary key using prepared parameters (`pk0`, `pk1`, ... for composite keys), early-exiting on the first violation.

Diagnostics:
- Use `explain_assertion(name)` to introspect classification and prepared parameterization.

Examples:
```sql
-- Global-style assertion (aggregate)
create table t2 (id integer primary key) using memory;
create assertion a_global check ((select count(*) from t2) = (select count(*) from t2));
select exists(
  select 1 from explain_assertion('a_global') where classification = 'global'
) as ok;

-- Row-specific assertion: PK equality reduces to row-specific
create table t1 (id integer primary key) using memory;
create assertion a_row check (exists (select 1 from t1 where id = 1));
select prepared_pk_params from explain_assertion('a_row') where classification = 'row' limit 1;
```

## 2.6.2 Mutation Context (Table-Level Parameters)

Quereus supports table-level mutation context variables that provide per-operation parameters for default values and constraints. The primary use case is implementing application-specific security, rights management, and audit mechanisms using signatures, digests, and cryptographic verification.

**Syntax:**
```sql
create table table_name (
  column_definitions...
) using module_name
with context (
  variable_name data_type [null],
  ...
)
```

**DML Syntax:**
```sql
insert into table_name [(columns...)]
with context variable = expression, ...
values (...) | select_statement

update table_name
with context variable = expression, ...
set column = value ...

delete from table_name
with context variable = expression, ...
where condition
```

**Key Features:**
- Context variables are declared in the table definition alongside columns
- Variables default to NOT NULL unless explicitly marked NULL
- Both unqualified (`varName`) and qualified (`context.varName`) references supported
- Context variables can be used in DEFAULT expressions and CHECK constraints
- Context values are evaluated once per statement, not per row
- Context is captured for deferred constraints and evaluated at COMMIT time

**Examples:**

**Multi-Tenant Data Isolation:**
```sql
-- Enforce tenant isolation at database level
create table tenant_records (
  id integer primary key,
  tenant_id text,
  data text,
  constraint tenant_check check (new.tenant_id = context.current_tenant_id)
) using memory
with context (
  current_tenant_id text
);

-- Insert restricted to current tenant
insert into tenant_records (id, tenant_id, data)
with context current_tenant_id = 'tenant_abc'
values (1, 'tenant_abc', 'Private data');  -- Passes

-- Attempt to insert for different tenant fails
insert into tenant_records (id, tenant_id, data)
with context current_tenant_id = 'tenant_abc'
values (2, 'tenant_xyz', 'Data');  -- Fails: tenant mismatch
```

**Audit Trail with Actor Tracking:**
```sql
-- Audit log with actor identity
create table audit_log (
  id integer primary key,
  action text,
  user_id text default actor_id,
  timestamp text default datetime('now')
) using memory
with context (
  actor_id text
);

-- Log action with actor identity
insert into audit_log (id, action)
with context actor_id = 'user123'
values (1, 'DELETE_RECORD');
```

**Permission Verification:**
```sql
-- Prevent unauthorized modifications
create table user_profiles (
  user_id integer primary key,
  email text,
  constraint update_auth check (
    context.requester_id = old.user_id or context.is_admin = 1
  )
) using memory
with context (
  requester_id integer,
  is_admin integer
);

-- User can update their own profile
update user_profiles
with context requester_id = 42, is_admin = 0
set email = 'newemail@example.com'
where user_id = 42;  -- Passes: requester_id matches
```

**Best Practices:**
- Use mutation context for application-specific security and access control
- Implement signature verification, digest validation, and rights checking in constraints
- Store actor identity, timestamps, and cryptographic proofs in defaults
- Use qualified `context.varName` for clarity when variable names might conflict
- Mark optional context variables as NULL
- Combine with user-defined functions for custom verification logic
- Context is required when defaults or constraints reference context variables

## 2.6.3 Metadata Tags

Quereus supports arbitrary key-value metadata tags on schema objects via `WITH TAGS`. Tags are informational only -- the engine does not derive behavior from them. They do not affect schema hashing.

**Syntax:**
```sql
-- Table-level tags
create table Orders (
  id integer primary key,
  name text not null
) with tags (display_name = 'Customer Orders', audit = true);

-- Column-level tags
create table Products (
  id integer primary key with tags (display_name = 'Product ID'),
  name text not null with tags (searchable = true)
);

-- Constraint-level tags
create table Employees (
  id integer primary key,
  email text not null,
  constraint uq_email unique (email) with tags (error_message = 'Email must be unique')
);

-- View and index tags
create view ActiveUsers as select * from Users where active = 1
  with tags (cacheable = true);

create index idx_name on Products (name) with tags (purpose = 'search optimization');
```

Tag values can be strings, numbers, booleans (`true`/`false`), or `null`. Tag keys are identifiers. `TAGS` is a contextual keyword and can still be used as a regular identifier. `WITH TAGS` can appear alongside `WITH CONTEXT` in any order.

Tags are available on the schema interfaces (`TableSchema.tags`, `ColumnSchema.tags`, etc.) and via the programmatic API (`SchemaManager.getTableTags()`, `SchemaManager.setTableTags()`, `SchemaManager.setColumnTags()`, `SchemaManager.setConstraintTags()`). Tags set at `CREATE` time can be changed later from SQL with `ALTER TABLE … SET TAGS` (whole-set replacement; see [§2.7](#27-alter-table-statement)).

**Reserved namespace `quereus.*`:** keys whose name starts with `quereus.` are reserved for the engine and validated against a typed registry (`src/schema/reserved-tags.ts`). The two most common keys, both rename hints, are:

| Key | Used by | Effect |
|-----|---------|--------|
| `"quereus.id"` | `apply schema` / `diff schema` | Stable identifier — when a declared and actual object share the same `quereus.id` but have different names, the differ emits a rename instead of a drop+create. Authoritative; wins over `previous_name`. |
| `"quereus.previous_name"` | `apply schema` / `diff schema` | One or more comma-separated old names. The differ matches a declared object whose name is missing in the catalog against an actual object whose name appears in this list. |

This is only a subset; other reserved keys include `quereus.expose_implicit_index` and the `quereus.lens.*` family (see the registry for the full set). An **unrecognized or mis-sited** `quereus.*` key is a **hard error** — rejected loudly at plan-build on every authoring path (`CREATE TABLE` / `CREATE INDEX … WITH TAGS`, `ALTER … SET TAGS`, statement-level DML `WITH TAGS` (`INSERT`/`UPDATE`/`DELETE`), and `apply schema` / `diff schema`) rather than silently stored — so a typo (`quereus.idd`) or a view-only key on a physical table fails the statement. Note that **no** reserved key is currently legal at the DML-statement site — the namespace there is purely a typo guard (since the `quereus.update.*` retirement, every `quereus.*` key on a DML statement is rejected, whether the statement targets a base table or a view). Tag keys with dots must use the quoted-identifier form (`"quereus.id"`). Non-reserved (free-form) keys outside the `quereus.*` namespace are accepted untouched.

Example — declaring a renamed table and column:

```sql
declare schema main {
  table customer with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  ) {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  }
}
```

Against an existing `client(client_id, name)`, this diffs to `ALTER TABLE client RENAME TO customer` plus two `ALTER TABLE customer RENAME COLUMN ...` rather than dropping and recreating.

## 2.7 ALTER TABLE Statement

Modifies an existing table's structure or name.

**RENAME TABLE**

```sql
ALTER TABLE old_name RENAME TO new_name;
```

Renames a table. The old name becomes invalid immediately. Fails if the new name already exists. References to the old name in dependent objects are rewritten in place: CHECK expressions on every table in the schema, FOREIGN KEY `referencedTable` entries (across all schemas), partial-index `WHERE` predicates (a table-qualified self-reference like `where t.active = 1` follows the rename, including in the derived UNIQUE constraint of a unique partial index, which shares the predicate AST), view bodies (`selectAst` and the cached `sql` text), view/MV `with defaults` clauses (now stored inside the body select, so an expr subquery referencing the renamed table is rewritten by the body walk — a clause-only rewrite still fires the modified event), and materialized-view bodies (which additionally re-key their derived fields and re-register row-time maintenance, staying live — see [mv-schema-change.md § Rename propagation](mv-schema-change.md#rename-propagation-mv--faster-view)). The rewrite is best-effort AST replacement — a CTE that intentionally shadowed the old name is not preserved.

**RENAME COLUMN**

```sql
ALTER TABLE table_name RENAME COLUMN old_col TO new_col;
```

Renames a column. Data is preserved. Fails if the new name conflicts with an existing column or the old name doesn't exist. As with `RENAME TABLE`, references in CHECK expressions, FOREIGN KEY `referencedColumnNames`, partial-index `WHERE` predicates (unqualified and table-qualified refs on the renamed table, resolved against the indexed table the same way an implicit CHECK seed is; the derived UNIQUE constraint of a unique partial index shares the rewritten AST), view bodies, view/MV `with defaults` clauses (stored inside the body select; the clause's target names a base column of the view's FROM table — usually projected away — and rewrites via the same scope-aware synthetic-probe path a `with inverse` target uses, so a clause-only rewrite still fires the modified event; expr subqueries rewrite scope-aware — see [vu-inverses.md § View defaults](vu-inverses.md#view-defaults)), and materialized-view bodies (a bare passthrough projection's exposed output name follows the rename, carried onto the backing table in place — see [mv-schema-change.md § Rename propagation](mv-schema-change.md#rename-propagation-mv--faster-view)) are propagated. Inside dependent SELECTs the rewrite follows scope: unqualified column references resolve when the renamed table (or a CTE that re-exposes the renamed column under the same name) is in the unaliased FROM scope; qualified references resolve via the alias map. A CTE re-exposes the renamed column when it has no explicit column list (`with c as ...` not `with c(x) as ...`) and at least one result column is a passthrough of the renamed column (an unaliased `select k`, `t.k`, or `select *` from the renamed table).

A partial index on the renamed table survives as a **live structure**, not just a catalog entry: the module rewrites the predicate as part of the rename, before rebuilding its index structures against the new column list. If the rewrite or the rebuild fails, the whole `RENAME COLUMN` fails and both the table and the stored predicate are left untouched — a rename never silently loses an index the catalog still advertises.

**ADD COLUMN**

```sql
ALTER TABLE table_name ADD COLUMN col_name type [constraints];
```

Adds a new column to the table. Existing rows are backfilled with the column's DEFAULT value (or NULL if no default). A literal default is bulk-written to every existing row; a non-foldable expression default (including one that reads `new.<column>`) is evaluated **per existing row** — `new.<column>` resolves to that row's own sibling value (the existing-row backfill semantics described under *Default Values* above). Restrictions:

- Cannot add a PRIMARY KEY column.
- Cannot add a NOT NULL column without a DEFAULT if the table has existing rows — unless the table's module advertises the `delegatesNotNullBackfill` capability, in which case the engine skips this pre-check and the module's `alterTable` owns the decision (intended for structurally-total modules that carry pre-existing rows forward and enforce NOT NULL at write time going forward). Native modules (memory, store) leave the capability off, so this restriction applies to them. A NOT NULL column *with* a per-row default whose backfill yields NULL for some existing row is likewise rejected (after backfill), and the column add is reverted.
- Cannot add a column with **both** a non-foldable (per-row) DEFAULT and a CHECK constraint on the new column — this combination is not yet supported, because the per-row backfill is not validated against the CHECK (the literal-default + CHECK path *is* validated and reverts on violation). Add the column first, then add the CHECK separately, or use a literal DEFAULT.

A column-level **UNIQUE** declared inline on the new column (`ADD COLUMN col … UNIQUE`, named or unnamed) is materialized and enforced via the **same** module path as `ALTER TABLE ADD CONSTRAINT … UNIQUE`: once the column is materialized it routes through the module's `addConstraint`, which builds (or reuses) the covering structure, **re-validates the backfilled values** — failing atomically with `CONSTRAINT` and reverting the column if a literal DEFAULT produces a duplicate across existing rows — and persists for store-backed tables. NULLs are distinct, so existing rows backfilled with NULL never collide, and a named inline UNIQUE round-trips its name through `unique_constraint_info`. (Inline column-level CHECK / FOREIGN KEY on the new column are likewise enforced — CHECK in place, FK via the same existing-row validation as `ADD CONSTRAINT`.)

**DROP COLUMN**

```sql
ALTER TABLE table_name DROP COLUMN col_name;
```

Removes a column from the table and all its data. Restrictions:

- Cannot drop a PRIMARY KEY column.
- Cannot drop the last remaining column.
- Cannot drop a column named by a **partial index's `WHERE` clause** — the index would be left with a predicate it cannot evaluate. Drop the index first. (A column used only as an index *key* column is fine: the index is narrowed to its surviving key columns, and dropped outright when none survive.)

Any UNIQUE constraint over the dropped column is removed with it — a single-column UNIQUE outright, and a **multi-column** UNIQUE in full (a UNIQUE missing one of its columns is a different, stronger constraint, not a silently-narrowed one). The auto-built covering index backing such a constraint is torn down at the same time, leaving no orphan in `index_info`. A UNIQUE whose columns do **not** include the dropped column survives, with its column indices shifted over the removed slot. (SQLite rejects dropping a column that participates in a UNIQUE; Quereus permits it and drops the constraint.)

**ADD / DROP / RENAME CONSTRAINT**

```sql
ALTER TABLE table_name ADD CONSTRAINT con_name <constraint-body>;  -- CHECK (...) / UNIQUE (...) / FOREIGN KEY (...)
ALTER TABLE table_name DROP CONSTRAINT con_name;
ALTER TABLE table_name RENAME CONSTRAINT old_con TO new_con;
```

Manages a **named** table-level constraint (CHECK / UNIQUE / FOREIGN KEY) over its lifetime. All three resolve a name across the constraint classes in the fixed order CHECK → UNIQUE → FOREIGN KEY; a name present in more than one class is rejected as **ambiguous**, and an unknown name raises `NOTFOUND`. Constraint names are local to their table — there are no cross-object references to rewrite on rename.

- **ADD CONSTRAINT** adds a new named (or, for the unnamed `ADD UNIQUE (...)` / `ADD FOREIGN KEY (...)` form, auto-named) constraint. A CHECK is added in place and begins enforcing on the next INSERT/UPDATE. A UNIQUE / FOREIGN KEY add routes through the table's module, which **re-validates the existing rows** against the new constraint and fails atomically with `CONSTRAINT` (leaving the schema unchanged) when the current data violates it; otherwise it installs forward enforcement. UNIQUE validation honors SQL NULL semantics (multiple NULLs are distinct) and any partial predicate. FOREIGN KEY existing-row validation is **gated by `pragma foreign_keys`** — when off, the add succeeds without a validating scan and enforcement is deferred to subsequent writes — and follows MATCH SIMPLE (a child row with any NULL FK column is exempt). A declarative add of a named UNIQUE / FK to an already-existing table now converges via this path.
- **DROP CONSTRAINT** removes the named constraint. Dropping a UNIQUE also tears down the auto-built secondary index that backs it. A UNIQUE constraint synthesized from a `CREATE UNIQUE INDEX` cannot be dropped this way (the index is the user's object) — use `DROP INDEX`, which removes both.
- **RENAME CONSTRAINT** changes a named constraint's name; the new name must not already address a constraint. For a UNIQUE backed by an implicit covering index named after the constraint, the index is renamed in lock-step. (A UNIQUE derived from a `CREATE UNIQUE INDEX` is likewise managed via its index, not renamed here.)

These are schema-catalog operations that round-trip through the module's `alterTable`, so store-backed tables re-persist their DDL across reconnect.

There is no in-place "redefine constraint" primitive. When a **declarative** schema (`apply schema`) changes the *body* of a named constraint while keeping its name — an edited CHECK expression, a changed FK `ON DELETE`/`ON UPDATE` action or referenced table/columns, a changed UNIQUE column set or `ON CONFLICT` — the differ realizes it as **DROP CONSTRAINT + ADD CONSTRAINT** (drop the old, add the new). For **UNIQUE / FOREIGN KEY**, the re-add re-validates existing rows against the new rule and fails atomically with `CONSTRAINT` (leaving the schema unchanged) if any current row violates the new body. For **CHECK**, the re-add is **forward-enforcing only** — it installs the new predicate but does **not** re-validate rows already in the table (a pre-existing limitation of the CHECK add path), so an existing row that violates the new predicate survives and is checked only on its next write. A change to a constraint's **tags** only is *not* a body change — it takes `ALTER CONSTRAINT … SET TAGS` (no drop+recreate). If a constraint is both renamed (via a `quereus.previous_name`/`quereus.id` hint) and has a changed body, the drop+recreate subsumes the rename (the new body must re-validate regardless). Note that the DROP and ADD are two separate statements and the migration is **not atomic** on the memory backend: if the re-add fails re-validation, the old constraint has already been dropped (see `docs/schema.md` for the atomicity caveat).

**ALTER PRIMARY KEY**

```sql
ALTER TABLE table_name ALTER PRIMARY KEY (col_name [ASC|DESC] [, ...]);
```

Replaces the table's primary key definition. All named columns must have a NOT NULL constraint. The empty-PK case `ALTER PRIMARY KEY ()` is permitted (the table reverts to an implicit rowid-style key). Modules that support re-keying in place handle the change directly; modules that cannot (including the built-in MemoryTable) use an automatic rebuild fallback that copies all rows into a new table with the updated PK and swaps it in place.

**ALTER COLUMN**

```sql
ALTER TABLE table_name ALTER COLUMN col_name SET NOT NULL;
ALTER TABLE table_name ALTER COLUMN col_name DROP NOT NULL;
ALTER TABLE table_name ALTER COLUMN col_name SET DATA TYPE type_name;
ALTER TABLE table_name ALTER COLUMN col_name SET DEFAULT expr;
ALTER TABLE table_name ALTER COLUMN col_name DROP DEFAULT;
ALTER TABLE table_name ALTER COLUMN col_name SET COLLATE collation_name;
```

Changes a single column attribute. Each statement carries exactly one attribute; combine multiple attributes by issuing multiple statements. Restrictions:

- `SET NOT NULL` scans existing rows. If any are NULL and the column has a literal DEFAULT, NULL rows are backfilled with that default; otherwise the statement fails with `CONSTRAINT`.
- `DROP NOT NULL` is rejected on PRIMARY KEY columns.
- `SET DATA TYPE` rewrites no stored value when the new type shares the same physical representation; otherwise each row's value is re-validated and converted, failing with `MISMATCH` on any value that cannot be coerced. Rejected on PRIMARY KEY columns. Sharing a physical representation does **not** make it schema-only, though: when the two types *compare* differently — `TEXT` ↔ `TIMESPAN`, where `'PT1H'`, `'PT60M'` and `'PT3600S'` are one value; `TEXT` ↔ `JSON`, where `'{"a":1}'` and `'{ "a" : 1 }'` are one value; `TEXT` ↔ `DATE`/`TIME`/`DATETIME`, whose comparison is `BINARY` regardless of the column's collation — every PRIMARY KEY, UNIQUE, or index that orders by the column is re-keyed and re-validated exactly as `SET COLLATE` does (next-but-one bullet). Only a retype between types that compare identically (`TEXT` → `VARCHAR(50)`, `INTEGER` → `BIGINT`) is genuinely schema-only.
- `SET DATA TYPE` keeps the column's existing collation, so the **new** type must accept it: the collation is re-checked with the same validator (and the same `Unknown collation '…' for type '…'` error) `CREATE TABLE` uses, before anything is mutated. A `TEXT COLLATE NOCASE` column therefore cannot be retyped to `DATE`/`TIME`/`DATETIME`/`TIMESPAN`/`JSON` — those accept `BINARY` only — because the result would be a column shape `CREATE TABLE` refuses and whose generated DDL does not re-parse (a store-backed table with such a column is dropped on reopen). Drop the collation first: `ALTER COLUMN d SET COLLATE BINARY;` then `ALTER COLUMN d SET DATA TYPE DATE;`. The rejection is uniform — it does not matter whether the collation was written explicitly or inherited from `pragma default_collation`, since that distinction is not persisted and would otherwise flip across a reopen. `INTEGER`/`REAL`/`BLOB` declare no collation list and accept any registered collation, so retypes into them are unaffected.
- Every change that can make two previously-distinct rows collide **re-validates every UNIQUE constraint covering the column, before anything is mutated** — a duplicate fails with `CONSTRAINT`, leaving the table unchanged. Two ways to collide: the *values* collapse (`SET DATA TYPE` across physical representations: `'1'` and `'01'` are distinct text but one integer; a `SET NOT NULL` DEFAULT backfill: several NULLs are mutually distinct under SQL UNIQUE but backfill to one DEFAULT), or the *comparison* moves with the values untouched (`SET COLLATE`, or the same-representation semantic retype above). The LevelDB store honors this too: it defers its physical value rewrite until after the same re-validation, so a rejection leaves the stored values, the declared type and the enclosing transaction untouched.
- `SET/DROP DEFAULT` is schema-only; existing rows are not touched.
- `SET COLLATE` changes the column's collation (its comparison/ordering rule, default `BINARY`). The collation name is validated against the column's logical type up front — an unknown/unsupported collation is rejected with `Unknown collation '…' for type '…'`, the same error shape as `CREATE TABLE`. Because collation is **semantic** (it changes `=` and `ORDER BY`), the module re-keys / re-sorts any PRIMARY KEY, UNIQUE, or index that orders by the column and **re-validates uniqueness under the new collation**: a value set that was unique under `BINARY` but collides under `NOCASE` fails with `CONSTRAINT`, leaving the table unchanged. `SET COLLATE` is permitted on PRIMARY KEY columns (the primary structure is re-keyed). `SET COLLATE BINARY` restores the default. Unlike `SET TAGS`, a collation change **does move the schema hash** (`explain schema` reports a new hash). Query-layer `=` / `ORDER BY` / `table_info().collation` pick up the new collation regardless. A durable module honors the same contract by physically re-keying: see [Schema Management § Store catalog persistence](schema.md#store-catalog-persistence-bundled-index-ddl) for the LevelDB store's re-key and existing-row dedup, including the one collation shape it rejects outright (**comparator-only** — registered with no normalizer, so its rows cannot be bucketed).

The declarative schema differ (`diff schema`) detects column-attribute drift and emits the matching `ALTER COLUMN` statements with the two comparison-domain changes (`SET DATA TYPE`, `SET COLLATE`) first, then `SET/DROP DEFAULT`, then `SET/DROP NOT NULL` — so a newly-declared DEFAULT is in place before any NOT NULL tightening relies on it for backfill. The two comparison-domain statements order **relative to each other by the target collation**, because `SET DATA TYPE` carries the column's current collation into the new type (previous-but-two bullet): a target of `BINARY` emits `SET COLLATE` **first** (every type accepts `BINARY`, and the retype would otherwise be rejected when narrowing to a `BINARY`-only type — `TEXT COLLATE NOCASE` → `DATE`), any other target emits it **after** the retype (only the new type declares support for it — `DATE` → `TEXT COLLATE NOCASE`). A declared `COLLATE BINARY` and an absent `COLLATE` are treated as equal — no spurious diff.

**SET TAGS / ADD TAGS / DROP TAGS**

```sql
ALTER TABLE table_name SET TAGS (key = value [, ...]);                       -- replace the whole table tag set
ALTER TABLE table_name SET TAGS ();                                          -- clear all table tags
ALTER TABLE table_name ADD TAGS (key = value [, ...]);                       -- merge: set/overwrite the listed keys, keep the rest
ALTER TABLE table_name DROP TAGS (key [, ...]);                              -- delete the listed keys
ALTER TABLE table_name ALTER COLUMN col_name SET TAGS (key = value [, ...]);     -- column: replace
ALTER TABLE table_name ALTER COLUMN col_name ADD TAGS (key = value [, ...]);     -- column: merge
ALTER TABLE table_name ALTER COLUMN col_name DROP TAGS (key [, ...]);            -- column: delete keys
ALTER TABLE table_name ALTER CONSTRAINT con_name SET TAGS (key = value [, ...]); -- named constraint: replace
ALTER TABLE table_name ALTER CONSTRAINT con_name ADD TAGS (key = value [, ...]); -- named constraint: merge
ALTER TABLE table_name ALTER CONSTRAINT con_name DROP TAGS (key [, ...]);        -- named constraint: delete keys
```

Mutates the metadata tags on the table itself, one of its columns, or one of its **named** table-level constraints (CHECK / UNIQUE / FOREIGN KEY). The three verbs differ only in how they combine with the existing tags; all are catalog-only, schema-hash-neutral, and read the *live* tag set at execution time. Semantics and restrictions:

- **Whole-set replacement vs. per-key merge / delete.** `SET TAGS` replaces the *entire* tag set at the target with the listed tags — an empty list `SET TAGS ()` clears all tags. `ADD TAGS (k = v[, …])` **merges**: it sets/overwrites the listed keys and keeps every other existing key (the ergonomic "touch one tag" form — no need to restate the whole set). `DROP TAGS (k[, …])` **deletes** the listed keys. After any of these the introspection TVFs (`schema()`, `table_info()`, `check_constraint_info()`, …) report the resulting set, and `tags IS NULL` once the set is empty.
- **DROP of an absent key fails atomically.** `DROP TAGS` validates that **every** listed key is currently present *before* mutating anything; if any is absent it raises `NOTFOUND` naming the missing key(s) and drops **nothing** (so a typo like `DROP TAGS (audt)` fails loudly rather than silently no-op'ing). Dropping the last remaining key(s) leaves `tags IS NULL`, exactly like `SET TAGS ()`. There is no `IF EXISTS` form.
- **Empty list is a no-op for ADD / DROP.** `ADD TAGS ()` and `DROP TAGS ()` change nothing — deliberately distinct from `SET TAGS ()`, which clears.
- **Case-sensitive / verbatim keys.** Tag keys are stored exactly as authored (`display_name`, `audit`, `quereus.id`) with no case-folding; `ADD`/`DROP` match keys verbatim.
- **`null` is a stored value, not a delete.** `ADD TAGS (k = null)` stores `k` present with value null (a legal stored value) — distinct from `DROP TAGS (k)`, which removes the key. (This is why there is a dedicated `DROP TAGS` rather than overloading `SET k = null`.)
- **Catalog-only.** Tags are pure informational metadata: they touch no stored row and no physical layout, so none of these round-trips through the module's `alterTable`, and they succeed even on modules that don't implement it. (Caveat: store-backed modules re-persist DDL only through `alterTable`; the generic store recovers tag changes by subscribing to the `table_modified` event these fire, so table / column / named-constraint tag mutations — SET, ADD, and DROP alike — survive reconnect for store tables.)
- **Reserved-tag validation.** `SET TAGS` and `ADD TAGS` validate any `quereus.*` key against the reserved-tag registry at the matching site (table / column / constraint) exactly as on `CREATE TABLE` / `declare schema`, so a misspelled or mis-sited reserved key (e.g. `"quereus.previuos_name"`) fails loudly at plan-build rather than being stored. `DROP TAGS` does **no** value validation — it removes by key — so dropping a reserved key (e.g. removing a stale `quereus.previous_name` hint) is legitimate and succeeds.
- **Schema hash unaffected.** Tags are excluded from the schema hash, so `explain schema` reports the same hash after any tag-only `ALTER` (SET / ADD / DROP).
- **Only named constraints are addressable.** `ALTER CONSTRAINT` targets a constraint by name; an unnamed constraint (e.g. an inline `CHECK` whose trailing `WITH TAGS` attaches to its column) has no addressable name and its tags are immutable post-create. A name that does not match any named constraint raises `NOTFOUND`; a name present in more than one constraint class (lookup order CHECK → UNIQUE → FOREIGN KEY) is rejected as ambiguous.
- **Attribute-preserving.** A tag mutation on a column changes only its `tags`; nullability, type, default, generated-ness, and PK membership are untouched.

The declarative schema differ detects tag drift at all three sites and emits the matching **whole-set** `SET TAGS` statements (it computes the full desired set) **after** the structural ALTER phases (rename/add/alter/pk/drop), so a tag set lands on the post-rename column / constraint name. `ADD TAGS` / `DROP TAGS` are an imperative-only convenience and are **not** emitted by the differ. The rename-hint keys `"quereus.id"` and `"quereus.previous_name"` are excluded from the tag-drift comparison (they drive rename detection, not data state, so a declaration carrying only a hint does not churn out a `SET TAGS` after the rename completes); all other reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared.

### SET MAINTAINED / DROP MAINTAINED — derivation lifecycle

```sql
ALTER TABLE table_name SET MAINTAINED AS query_expr [WITH DEFAULTS (column = expr [, ...])];
ALTER TABLE table_name DROP MAINTAINED;
```

`SET MAINTAINED AS` attaches a derivation to a plain table — making it a [maintained table](materialized-views.md) — or atomically replaces an already-maintained table's derivation. The body must derive the table's exact declared shape (names included; alias body outputs to match), and the table's current contents are reconciled against the derived contents by keyed diff (identical content writes nothing; divergence resolves derived-wins, reporting only genuine changes). There is no `using` clause — the module is the table's identity. A body closing a derivation cycle (including self-reference) and duplicate derived keys are rejected with the table untouched. `DROP MAINTAINED` detaches the derivation: catalog-only — the table keeps its rows and becomes an ordinary, user-writable table; maintenance stops. The declared-shape create form (`create table … maintained as <body>`) and the full attach/detach semantics are specified in [materialized-views.md § DDL statements](materialized-views.md#ddl-statements).

### SET / ADD / DROP TAGS on views, materialized views, and indexes

The other tagged catalog objects — views, materialized views, and indexes — also carry their tags from `CREATE` time, and can be re-tagged in place with the same three verbs as `ALTER TABLE`:

```sql
ALTER VIEW view_name               SET TAGS (key = value [, ...]);  -- view: replace whole set
ALTER VIEW view_name               ADD TAGS (key = value [, ...]);  -- view: merge (set/overwrite listed keys, keep rest)
ALTER VIEW view_name               DROP TAGS (key [, ...]);         -- view: delete listed keys
ALTER MATERIALIZED VIEW mv_name    SET TAGS (key = value [, ...]);  -- materialized-view: replace / add / drop
ALTER MATERIALIZED VIEW mv_name    ADD TAGS (key = value [, ...]);
ALTER MATERIALIZED VIEW mv_name    DROP TAGS (key [, ...]);
ALTER INDEX index_name             SET TAGS (key = value [, ...]);  -- index: replace / add / drop
ALTER INDEX index_name             ADD TAGS (key = value [, ...]);
ALTER INDEX index_name             DROP TAGS (key [, ...]);
ALTER VIEW view_name               SET TAGS ();                     -- clear all tags (any kind)
```

The three verbs carry **exactly the `ALTER TABLE … {SET|ADD|DROP} TAGS` semantics** documented above — `SET` is whole-set replacement (empty list clears, after which `schema()` / `index_info()` report `tags IS NULL`); `ADD` merges (empty list is a no-op, *not* a clear); `DROP` deletes the listed keys atomically (every key must be present, else `NOTFOUND` names the missing key(s) and drops nothing; dropping the last key leaves `tags IS NULL`; empty list is a no-op). Keys are matched verbatim (case-sensitive), all forms are catalog-only (no module / data round-trip; the tag change re-registers the in-memory schema object only) and schema-hash-neutral, and the live tag set is read at execution time. Notes specific to these objects:

- **Reserved-tag validation site (SET / ADD only; DROP does not validate).** A `quereus.*` key on `ALTER VIEW` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ADD TAGS` is validated at the `view-ddl` site, and on `ALTER INDEX … SET TAGS` / `ADD TAGS` at the `physical-index` site — the same registry and sites `CREATE` / `declare schema` use, so a typo (e.g. `"quereus.bogus"`) fails loudly at plan-build. `DROP TAGS` removes by key with no value validation, so dropping a reserved key (e.g. `DROP TAGS ("quereus.id")`) is legitimate and succeeds.
- **Materialized views never re-materialize.** Any MV tag change — `SET`, `ADD`, or `DROP` — is a pure metadata write; it does **not** touch the backing table or re-run the body. The declarative differ enforces this: a tag-only MV change takes the in-place `SET TAGS` path, while a **body** change still drops+recreates (carrying the declared tags through the recreate) — the two are mutually exclusive per MV in one migration.
- **View tag changes reach prepared statements.** No reserved tag drives write-through behavior (routing is per-row presence/membership columns; omitted-insert defaults are the body select's `with defaults (…)` clause — see [§2.9](sql-views.md#29-updatable-views)), but reserved-tag *validation* re-runs whenever a write-through plan is built — and the change applies to both newly planned statements *and* already-prepared ones: an `ALTER VIEW … {SET|ADD|DROP} TAGS` fires `view_modified` (and the `ALTER MATERIALIZED VIEW` forms fire `materialized_view_modified`), and every view-/MV-mediated write records a `view` plan dependency, so a cached prepared statement that writes through the view is invalidated and re-planned on its next execution — exactly as a table tag change invalidates via `table_modified` — surfacing, e.g., a newly-added invalid reserved key. (Read-only `select … from v` is intentionally *not* invalidated: view tags do not affect read results.)
- **Index resolution and implicit covering structures.** `ALTER INDEX` resolves the owning table from the index name (index names are unique per schema). The auto-built covering structure backing a UNIQUE constraint is **not** a user-addressable index — `ALTER INDEX … {SET|ADD|DROP} TAGS` on its name raises `NOTFOUND`; its tags live on the originating constraint (`ALTER TABLE … ALTER CONSTRAINT … {SET|ADD|DROP} TAGS`), unless the constraint opted the structure into visibility via `quereus.expose_implicit_index`.
- **Tags are the only `ALTER` verb for these objects.** There is no structural `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX` (rename, recolumn, …) yet; structural changes still go through drop+recreate (which the declarative pipeline drives automatically).

The declarative schema differ detects tag drift on a name-matched view / materialized view / index and emits the corresponding **whole-set** `SET TAGS` in the migration's alter phase (`ADD` / `DROP TAGS` are an imperative-only convenience and are not emitted by the differ).

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

## 7. Constraints and Indexes

### 7.1 Primary Key Constraint

The primary key constraint uniquely identifies each record in a table.

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

### 7.6 FOREIGN KEY Constraint

The foreign key constraint links tables together and ensures referential integrity.

Foreign key enforcement is controlled by the `foreign_keys` pragma (default: on):

```sql
pragma foreign_keys = on;   -- enable FK enforcement (default)
pragma foreign_keys = off;  -- parse but don't enforce
```

When no `ON DELETE` or `ON UPDATE` clause is specified, the default action is `RESTRICT`. `NO ACTION` is currently treated as a synonym for `RESTRICT`.

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

Cascade cycle detection prevents infinite recursion when cascading actions chain across multiple tables.

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
