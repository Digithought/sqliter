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

#### Item keywords and bare aliases

Items in a declaration block need no separator, so the leading keyword of an item
sits exactly where the previous item's body would accept a bare (no-`as`) alias.
To keep the boundary unambiguous, an item keyword — `table`, `index`, `unique`,
`materialized`, `view`, `seed`, `assertion`, `domain`, `collation`, `import` —
cannot be used as a *bare* alias at a position where an item could begin:

```sql
declare schema main {
  view v1 as select id from t1 materialized   -- `materialized` is NOT an alias here
  materialized view m2 as select id from t1
}
```

If you want one of those words as an alias inside a declaration block, write it
explicitly (`from t1 as materialized`), quote it (`from t1 "materialized"`), or
separate the items with `;`. Outside a declaration block nothing is reserved:
`select a from t1 materialized` still aliases `t1` as `materialized`.

The restriction applies only where an item could actually begin — the item body's
top level. Inside an open `(` (a subquery source, a scalar subquery) a bare alias
is unaffected:

```sql
declare schema main {
  view v1 as select id from t1 where exists (select 1 from t2 materialized)
}                                                          -- ^ still an alias
```

An item kind the parser doesn't model yet (`domain`, `collation`, `import`) is
skipped up to the next `;`, the closing `}`, or the next item keyword — separate
those items with `;` when their body could itself contain an item keyword.

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

**Each declared name appears once.** A repeated name used to last-writer-wins silently, so the first declaration never reached the migration. `diff schema` / `apply schema` now reject it up front, naming the object:
- `table`, `view`, and `materialized view` share **one** namespace — the engine enforces it imperatively too (`create view` refuses a name a table holds, and vice versa), so a cross-kind clash could only ever half-apply and then fail mid-migration. Both the same-kind and the cross-kind case are errors:
  ```sql
  -- error: Table 't1' is declared more than once in schema 'main'
  -- error: 'dual' is declared as both a table and a view in schema 'main'
  ```
- `index` has its own namespace (unique per schema — see §6.3), as does `assertion`. An index or assertion may share a table's name; only a duplicate *within* its own namespace is rejected.
- A repeated `seed` block for one table is rejected when the declaration is stored, not at diff time — two blocks for one table have no defined meaning, and the second used to discard the first's rows:
  ```sql
  -- error: Seed data for table 't1' is declared more than once in schema 'main'
  ```
- Names compare case-insensitively, so `table T1` and `table t1` collide.

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

Renames apply to tables, views, indexes, named constraints (CHECK / UNIQUE / FOREIGN KEY, either table-level `CONSTRAINT <name> ...` or a column-level constraint carrying a name), and columns. Tables and columns rename via the `ALTER TABLE ... RENAME` / `RENAME COLUMN` primitives, which propagate references through dependent CHECK expressions, FK targets, partial-index predicates, column `DEFAULT` / `GENERATED ALWAYS AS` expressions, view bodies, materialized-view bodies, and assertion CHECK expressions. Named constraints rename via the `ALTER TABLE ... RENAME CONSTRAINT` primitive. The differ also detects constraint **drops** (a named constraint present in the catalog but absent from the declaration → `DROP CONSTRAINT`) and **adds** (a declared named constraint absent from the catalog → `ADD CONSTRAINT`; CHECK applies in place, UNIQUE / FK adds depend on module support — see §2.7). Only **user-named** constraints participate — engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names for unnamed constraints) and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` are excluded (the latter are managed through their index). View and index renames still fall back to drop+recreate when no rename primitive exists.

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

**Persistability:**

Before the table is created, every registered virtual-table module is asked whether it
could durably persist the resulting definition, and the first refusal fails the statement —
the table is never created, no storage is left behind. This guards against a definition
whose generated DDL text a storage backend cannot write down (today's only instance: a
JavaScript string carrying a lone/unpaired surrogate — in the table name, a quoted column
name, a `default` string literal, or a `check` constant — has no valid UTF-8 encoding, which
the persistent store's catalog requires). Without this check the create would otherwise
succeed, and — since the catalog write it depends on is fire-and-forget — a table nobody
ever reads or writes again would simply vanish on the next reopen with no error at all. See
[store.md](store.md) and [view-persistence.md](view-persistence.md) for the underlying
mechanism, which `CREATE VIEW` / `CREATE MATERIALIZED VIEW` / `ALTER TABLE … RENAME` also use.

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
- A name in a generated expression resolves against the table being defined **unless a `FROM` clause inside the expression binds it** — the same rule a CHECK constraint follows. `(select v from d where d.k = id limit 1)` reads `d.v` without qualification, and a generated column may read another table's column that shares its own name without creating a false cycle. A name bound by nothing — a bare typo, or an unrebound `new.<name>` that is not a column — is rejected at DDL time. Because a name a `FROM` binds belongs to that source, a column of another table can be dropped or renamed only with the generated expression accounted for: the drop is refused and the rename rewrites the body, exactly as for a qualified reference.
- **How a generated expression may spell its own row's columns.** Four spellings are accepted, and they mean the same thing wherever the body is compiled — at `CREATE TABLE`, at `INSERT`, at `UPDATE`, in an `INSERT ... ON CONFLICT ... DO UPDATE` recompute, and in an `ALTER TABLE ... ADD COLUMN` backfill. A declaration the engine accepts is therefore one every subsequent write accepts.

  | spelling | accepted | meaning |
  | --- | --- | --- |
  | `<column>` | yes | the column of the row being written |
  | `<table>.<column>` | yes | same — the self-qualifier is folded away before the expression is resolved |
  | `<own-schema>.<table>.<column>` | yes | same, provided the schema named is the table's own |
  | `new.<column>` | yes | same — an exact alias for the bare form |
  | `old.<column>` | **no** | a generated value is computed from the row being *written*; there is no old row to compute it from, and the backfill of an `ADD COLUMN` has no old row at all |
  | any other qualifier | no | resolved through the ordinary scope chain, so it fails unless a `FROM` inside the expression binds it |

  `new` and `old` are not reserved words, so a subquery inside the body that names a real table called `"new"` reads that table: the subquery's own `FROM` binds the name first.

  **An unbindable qualified reference is rejected at declaration time, by both statements.** `old.<column>`, or `<some other table>.<column>` with no `FROM` inside the body binding it, is rejected the moment the table is declared — by `CREATE TABLE` and by `ALTER TABLE ... ADD COLUMN` alike, with the same message — and the table is left uncreated (`CREATE TABLE`) or unchanged (`ADD COLUMN`). The two surfaces always agree: neither accepts a declaration the other rejects. The one case that still reaches the first write is a qualifier sitting inside a body the analysis cannot read — a CTE body, a derived table, or a nested `INSERT` / `UPDATE` / `DELETE` — where "nothing binds it" is undecidable and the declaration is accepted rather than refused on a guess. Prefer spelling the row's own columns with one of the four accepted forms above.

  The same undecidability cuts the other way for a **self**-reference: a name inside one of those bodies might be this table's own column, and the analysis records the dependency rather than guess it away. So `ALTER TABLE ... ADD COLUMN g GENERATED ALWAYS AS (...)` whose body spells `g` anywhere inside a nested `INSERT` / `UPDATE` / `DELETE` — its `RETURNING` list, an `ON CONFLICT DO UPDATE` assignment, a `WITH CONTEXT` assignment — is rejected as a cycle, even though that `g` names the nested statement's table. Qualifying the reference does not help — the analysis cannot resolve a qualifier in there either — so give the column a different name.
- **Mutation-context variables do not shadow a column here.** In a `CHECK` or a column `DEFAULT`, a `with context (...)` variable claims the bare name and the column stays reachable as `new.<column>` (§2.6.2). A generated expression is deliberately different: the bare name always means the column. Its value is a pure function of the row being written and must compute identically at all the sites above, and the `ADD COLUMN` backfill has no mutation-context envelope to read. Nothing is lost by this: a bare name in a generated body that is not a column of the table is already rejected at DDL time, so a generated body can only ever collide with a context variable, never usefully name one.
- Cannot have both `DEFAULT` and `GENERATED ALWAYS AS` on the same column.
- Cannot INSERT into or UPDATE a generated column directly.
- `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...)` **backfills the existing rows**: each one's value is computed from that row, exactly as `CREATE TABLE` with the same declaration and a subsequent INSERT would produce it. This holds for the `STORED`, `VIRTUAL` and unspecified spellings alike, and for an expression that reads another generated column (already materialized in the stored row). Determinism is checked at declaration time — `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` alike, before any row is touched — so `GENERATED ALWAYS AS (random())` is rejected there rather than at the next INSERT, whichever statement declares it (unless `nondeterministic_schema` is on). If the new column is `NOT NULL` and the expression yields NULL for some existing row, or an inline `CHECK` on it fails for some existing row, the whole `ALTER` is rejected and the table is left exactly as it was.
- `ALTER TABLE ... DROP COLUMN` of a column referenced by another generated column's expression is rejected; drop the referencing generated column first. (A column that a foreign key in another table points at is rejected the same way — see §7.6.)

**CHECK Constraints:**

- `check (expr)` is enforced on INSERT and UPDATE by default; `check on {insert | update | delete}[,...]` restricts the operations. Unqualified columns name the NEW row (the OLD row for DELETE-only checks); `old.<col>` / `new.<col>` reference either row image explicitly. Both spellings are equivalent as far as ALTER goes: `RENAME COLUMN` rewrites `new.<col>` / `old.<col>` references along with the unqualified ones, and `DROP COLUMN` refuses over them (see below). `new` and `old` are not reserved words, so a CHECK subquery reading a real table named `"new"` is left alone by both — and the qualifier always names the row of the table that **owns** the CHECK, so altering a table that happens to be called `new` or `old` neither rewrites another table's `new.<col>` / `old.<col>` nor is blocked by one.
- Comparisons inside a CHECK resolve **declared column collations** (and explicit `COLLATE` wrappers), exactly like the same expression in a query — `check (c = 'abc')` over a `text collate nocase` column accepts any case-variant. Resolution follows the engine's symmetric provenance lattice (explicit `COLLATE` > declared column collation > defaulted collation > BINARY; see `docs/types.md` § Comparison collation resolution), so `check (b = c)` and `check (c = b)` behave identically.
- A CHECK containing a subquery is automatically deferred to transaction commit; the deferred evaluation runs the same compiled predicate, so collation semantics are identical to the immediate path.
- `ALTER TABLE ... DROP COLUMN` of a column a CHECK expression names is rejected — there is no narrowed form of an arbitrary expression, only deleting it silently or refusing. Drop the constraint first (`ALTER TABLE ... DROP CONSTRAINT <name>`); an *unnamed* table-level CHECK has no name to address, so a column it names can only be removed by rebuilding the table. The same holds for a live **assertion** whose CHECK body names the column (`DROP ASSERTION <name>` first) — there the refusal also prevents one broken body from blocking writes to every table in the database. Detection is scope-aware, so a like-named column reached only through a subquery over *another* table does not block the drop. See [sql-alter.md § 2.7](sql-alter.md#27-alter-table-statement) under *DROP COLUMN* for the structural-vs-expression rule these restrictions come from.
- The scan covers **every table in every schema**, not just the altered one, and follows **view and materialized-view bodies to any depth**. A CHECK may contain a subquery, so another table's constraint can legitimately read this column — directly (`check (n < (select max(v) from t))` on some table `x`) or through a view over it (`check (n < (select max(v) from vv))` where `vv` is `select id, v from t`); dropping `t.v` out from under either would leave `x` unwritable, with an error naming neither `t`, nor `v`, nor the constraint. The refusal names the referencing table, schema-qualified when it lives elsewhere, and — when the reference is indirect — the chain it travelled: `CHECK constraint 'ck1' on table 'x' reaches it through view 'v2' -> view 'v1'`.
- **`DROP TABLE` / `DROP VIEW` / `DROP MATERIALIZED VIEW` refuses the same class**, for the same reason and with the same scope and chain-following: `cannot drop table 'main.t': it is referenced by CHECK constraint 'ck1' on table 'x' — drop or redefine it first`, or `cannot drop table 'main.t': CHECK constraint 'ck1' on table 'x' reaches it through view 'vv' — drop or redefine it first`. `IF EXISTS` does not weaken it (that clause governs absence, not dependency). A table's *own* self-referencing CHECK never blocks its own drop — the constraint goes away with the table. Dropping a table out from under a plain **view** stays legal and leaves the view broken (a broken view breaks queries of that view; a broken CHECK makes a whole table unwritable) — but dropping a *view* that a CHECK subquery reads, directly or through a further view, is refused, because there the referencing table is what breaks.

**Default Values:**

A column `DEFAULT` supplies the value when an INSERT omits the column; an explicitly supplied value always wins. The expression must be deterministic and may not reference bind parameters.

- A default may read a sibling **the INSERT supplies** via `new.<column>` — e.g. `slug text default (lower(new.title))` or `total integer default (new.subtotal + tax)`. Only INSERT-supplied columns are visible, so a default never depends on another column's default (which would impose an evaluation-order race); referencing an omitted column raises a resolution error. The same `new.<column>` surface also resolves at the **shared-key view-write envelope** (an anchor key default reading a supplied sibling — see [vu-mutation-context.md § Mutation context](vu-mutation-context.md#mutation-context)).
- A **bare** (unqualified) column reference is rejected at `CREATE TABLE` — use `new.<column>` to read a supplied value, or `GENERATED ALWAYS AS` to compute from any sibling. (With a `with context (...)` clause an unqualified identifier may instead resolve to a mutation-context variable.)
- A `new.<column>` default survives ALTER exactly as a CHECK's does: `RENAME COLUMN` rewrites the reference (so the table keeps accepting rows), and `DROP COLUMN` refuses over it, naming the column whose default is in the way. `new` is not a reserved word, so a default whose subquery reads a real table named `"new"` is left alone by both. Both spellings of the ALTER — the inline `default (…)` and `ALTER COLUMN … SET DEFAULT` — write the same catalog field and behave identically here.
- A default (and a `GENERATED ALWAYS AS` body) on **another table** that reads this one through a subquery — `w integer default ((select min(v) from t))` — is scanned and refused the same way a CHECK is, by both `DROP COLUMN` and `DROP TABLE`. See *CHECK Constraints* above.
- `mutation_ordinal()` (the 1-based per-row ordinal) and mutation-context variables are also available in default position. See [vu-mutation-context.md § Mutation context](vu-mutation-context.md#mutation-context).
- `ALTER TABLE … ALTER COLUMN … SET DEFAULT` routes the new default through the **same** validator `CREATE TABLE` uses: bind parameters / bare columns / non-deterministic expressions are rejected at `ALTER` time, and a `new.<column>` default is accepted (its build is deferred to INSERT time, exactly as on `CREATE TABLE`). `DROP DEFAULT` clears the default.
- `ALTER TABLE … ADD COLUMN … DEFAULT (…)` accepts the same default expressions (the shared validator rejects bind parameters / bare columns / non-determinism). Existing rows are **backfilled per row**: `new.<column>` resolves to the *existing* row's sibling (e.g. `add column doubled integer default (new.base * 2)` sets each existing row's `doubled` from its own `base`), while a literal default is bulk-written. Future inserts derive the column from the INSERT-supplied sibling, so an insert that omits that sibling raises the same resolution error as the single-source path. An `ADD COLUMN NOT NULL` whose per-row backfill yields NULL for any existing row is rejected and the column is not added. DEFAULT is not the only backfilled kind: `ADD COLUMN … GENERATED ALWAYS AS (…)` takes the same per-row route (see *Generated Columns*), except that it never bulk-writes — even a constant generated expression is evaluated per row, since a generated column has no DEFAULT for the module to write.

**ADD COLUMN over a non-empty table needs a value for the rows that already exist.**

`ALTER TABLE … ADD COLUMN` is rejected — before any schema or data is touched — when the table already holds rows, the new column is NOT NULL, and nothing supplies a value for those rows. Three points are easy to trip over:

- **NOT NULL is resolved, not read off the statement text.** A column is NOT NULL either because it says `not null` or because the session option `default_column_nullability` (see [usage.md § Database Options](usage.md#database-options)) makes it so; that option ships as `not_null`, so `add column extra text` and `add column extra text default null` are both mandatory columns unless you write `null` explicitly.
- **A DEFAULT that is literally NULL supplies no value.** `default null` (and `default (null)`) counts as "no DEFAULT" for this rule, because filling the existing rows with NULL is exactly what the column forbids. Write `add column extra text null default null` if you want the column to be optional.
- **A per-row source does count.** A non-foldable expression default (`default (new.other)`) or a `generated always as (…)` expression fills each existing row from that row; the ALTER proceeds, and NOT NULL is then enforced against each computed value (a row yielding NULL rejects the whole ALTER).

On an **empty** table any of these is accepted — there is nothing to backfill — and NOT NULL enforces from the first write, matching SQLite. Both shipped storage modules (memory and the persistent store) give the same answer for the same statement. A storage module that carries pre-existing rows forward and enforces NOT NULL at write time can opt out of this engine-level rejection with the `delegatesNotNullBackfill` capability, in which case the module decides.

## 2.6.1 CREATE/DROP ASSERTION (Global Integrity Constraints)

Quereus supports database-wide integrity assertions evaluated at COMMIT time.

Syntax:
```sql
create assertion [schema_name.]assertion_name check (condition_expression);
drop assertion [if exists] [schema_name.]assertion_name;
```

Behavior:
- An assertion belongs to a schema. An unqualified name means the current schema, matching every other DDL statement; names are unique per schema, so two schemas may each hold an assertion of the same name and both enforce independently.
- The stored CHECK body resolves its unqualified table names against the assertion's **own** schema first, independent of the session's search path — the same home-schema rule stored view and materialized-view bodies follow (see `sql-select.md` § 2.1.1).
- The CHECK body is **validated at create time**, at exactly the strictness a `CREATE VIEW` body is validated: the derived violation SQL is planned under the assertion's home-schema path, so a body naming a missing table, a missing column, or an unknown function fails the `CREATE ASSERTION` (`Cannot create assertion 'a1': Table 't' not found …`). Anything the planner accepts for a view body is accepted here too — a type mismatch such as `x + 'abc'` is not a planner error and still creates. This matters because enforcement recompiles **every** live assertion on any commit that touched any table, so an assertion that cannot be planned would otherwise block writes to the whole database at some unrelated later statement.
- For the same reason, `DROP TABLE` / `DROP VIEW` / `DROP MATERIALIZED VIEW` is **refused** while a live assertion can still reach the object: `cannot drop table 'main.t': assertion 'a1' still refers to it — drop or redefine the assertion first`. `IF EXISTS` does not weaken this (it governs absence, not dependency). The refusal is a clean no-op; `drop assertion a1` then lets the drop through. "Refers to" is decided by the same walk `ALTER TABLE … RENAME` uses to rewrite dependent bodies, so a name a CTE or a FROM alias merely shadows is not a reference and does not block the drop.
- The refusal follows **view and materialized-view chains**, to any depth: an assertion reading `v` where `create view v as select * from t` blocks `drop table t`, and the message names the chain — `assertion 'a1' reaches it through view 'v2' -> view 'v1'`. Each body in the chain resolves its own unqualified names under its own home schema.
- The refusal consults assertions in **every** schema, not only the dropped object's. An assertion in `temp` naming `main.t` — explicitly, or by a bare name that resolves down its home path to `main.t` — blocks the drop, and the message qualifies the assertion (`assertion 'temp.a1'`) so the user can find the one to drop. An assertion in `temp` whose bare `t` means `temp.t` is left alone.
- `ALTER TABLE … DROP COLUMN` is refused on the same reach, probing every body in the chain for the column by name: `Cannot drop column 'x' from 't': it is referenced by assertion 'a1' through view 'v' — drop or redefine the assertion first`. An assertion body that names the table but not the column is no obstacle — including a `select *` body, which names no column at all.
- The column verb follows column **republication** too: each body in the chain is probed not only against the altered table but against every view / materialized view that re-exposes the dropped column as one of its own output columns — the same lineage the `RENAME COLUMN` cascade re-targets on (see [sql-alter.md § 2.7](sql-alter.md#27-alter-table-statement)). So a star re-exposure (`create view v as select * from t`, `select t.*`, or a materialized view of either), which spells the column's name nowhere, still blocks `alter table t drop column x` under `create assertion a1 check (… from v where x < 0)`. Two arms of that rule are worth knowing:
  - A view with an **explicit column list** over a covering star (`create view v(a, b) as select * from t`) never shifts a published name — but dropping any starred-over column changes the arity the star produces and breaks the view **outright**, every column of it. An assertion whose reach names such a view at all is refused, and the message says the view breaks entirely rather than pointing at a column name no body spells.
  - For a **materialized view** the refusal is deliberately conservative: its backing table keeps its own columns, so the assertion would in fact have kept compiling and running — against frozen contents, with the MV marked stale and its next `refresh materialized view` failing. The engine refuses anyway, keeping one rule for views and materialized views and erring the same direction `DROP TABLE` does for the same object.
- An **aliased** FROM source is no obstacle to any of the above: an alias adds a qualifier, it does not take the source's columns out of scope, so an assertion body reading `select 1 from t a where x < 0` — or a view republishing through `select * from t a` — is seen exactly as the unaliased spelling is.
- Known limit on the column verb: an inline **subquery source** (`from (select …) s`) and a **function source** have no askable column set — inferring it would mean analysing the inner body recursively — so a republication arriving only that way (`create view v as select * from (select * from t) s`) is invisible and the drop is accepted, after which the assertion fails every write to the whole database. Where the inner subquery *spells* the column the drop guard does see it, but `RENAME COLUMN` still does not follow the outer reference. See [sql-alter.md § DROP COLUMN](sql-alter.md#27-alter-table-statement); tracked by `bug-column-verbs-blind-to-star-over-subquery-source`.
- Assertions are enforced at COMMIT. Any row produced by the stored violation query indicates a violation and the COMMIT fails with a constraint error (transaction rolled back). The error names the assertion, schema-qualified outside `main` (`Integrity assertion failed: sales.a1`).
- The `check (expr)` is stored as a violation SQL: `select 1 where not (expr)`.
- `ALTER TABLE ... RENAME` / `RENAME COLUMN` rewrites the stored body and regenerates that violation SQL, so the assertion keeps enforcing the same rule against the renamed object — the same in-place propagation view and materialized-view bodies get, in every schema (see [sql-alter.md § 2.7](sql-alter.md#27-alter-table-statement) for how a reference is decided to be a reference).
- Efficiency: The optimizer classifies each table reference instance in the violation query as row-specific (unique key fully covered) or global. If any changed base is global, run the violation SQL once. Otherwise, for row-specific references, the engine executes per changed primary key using prepared parameters (`pk0`, `pk1`, ... for composite keys), early-exiting on the first violation.

Diagnostics:
- Use `explain_assertion(name)` to introspect classification and prepared parameterization. The argument may be `'schema.name'` (schema-scoped) or a bare name (first match across schemas).
- `assertion_info()` lists all assertions with their `schema_name`.

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
- Variables default to NOT NULL unless explicitly marked NULL (the session `default_column_nullability` decides, exactly as it does for columns)
- Both unqualified (`varName`) and qualified (`context.varName`) references supported
- Context variables can be used in DEFAULT expressions and CHECK constraints
- Context values are evaluated once per statement, not per row
- Context is captured for deferred constraints and evaluated at COMMIT time

**Which variables a statement must supply:**

The rule is per variable, and it is enforced where the variable is *read*:

- A **NOT NULL** variable must be supplied by any statement whose defaults or constraints read it. One that is read but not supplied fails at plan time with `table '<schema>.<table>' requires mutation context variable '<name>'; supply it with `with context <name> = …``. This is the same diagnosis whether the statement omitted the whole `with context` clause or just that one variable.
- A variable declared **NULL** may be omitted; it reads as NULL. A CHECK comparing against a NULL context variable is *unknown* and therefore passes, like any NULL comparison — write `coalesce(<comparison>, 0)` if the intent is to reject the omission.
- A variable that **no default or constraint of this statement reads** never needs supplying, even when it is NOT NULL. A table may declare a variable only its `check on update` reads, and a DELETE against that table needs no envelope.
- A supplied name the table does **not** declare is ignored, not rejected. A write through a view forwards one envelope to every underlying base table, and each takes only the variables it declares. (This does mean a mistyped variable name reads as NULL rather than being reported, and that a planning error inside an unread assignment's expression goes unreported — the expression is never built.)
- Names are matched **case-insensitively**, like every other identifier: `with context ownerkey = …` supplies a variable declared `OwnerKey`.
- Supplying the same name **twice** is rejected (`mutation context variable '<name>' supplied more than once`), matching the duplicate rules on an INSERT column list and an UPDATE `set` list.
- A context value expression is evaluated to *build* the context row, so it cannot read a context variable — `with context cap = base` reports `base` as an unresolved column even when `base` is itself declared.

Because context variables shadow same-named columns, a table that declares a variable named like one of its columns resolves a *bare* reference in a DEFAULT or CHECK to the variable — including when the statement supplies no envelope, in which case an omitted NULL-marked variable reads NULL. The `new.<column>` / `old.<column>` forms always reach the column.

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
- Mark optional context variables as NULL — those may then be omitted by a statement and read as NULL
- Combine with user-defined functions for custom verification logic
- A NOT NULL context variable must be supplied by any statement whose defaults or constraints read it

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

Moved to [SQL Schema Modification — ALTER](sql-alter.md#27-alter-table-statement), with the
tag verbs on views, materialized views, and indexes.


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
- **`schema()` and `index_info()` omit a hidden implicit covering structure, on every backend.** Not being a user-addressable index (above), it is not listed as one — consistent with `collectSchemaCatalog` (the declarative-schema differ's read path), which applies the same rule. An *exposed* one (`quereus.expose_implicit_index = true`) keeps appearing in both introspection functions, with its tags, on every backend. A `create unique index`-derived constraint is the user's own index and always appears.
- **Rehydration warns instead of failing.** Opening a database written before these rules that already contains a collision logs a warning and proceeds — naming both owning tables for a cross-table collision, or naming the constraint that holds the name for a same-table one. By-name resolution of that index stays first-match until one of them is renamed. (The same-table rule cannot be tripped by rehydration itself: the catalog's `CREATE TABLE` — constraints included — is imported ahead of every `CREATE INDEX`, so the table carries no indexes when its constraints are declared.)
- **`declare schema` rejects duplicates up front.** Two `index` declarations sharing a name (on any tables) are an error at diff time rather than a silently half-applied declaration — one case of the general rule that each declared name appears once (see §2.0 *Declaration Syntax*).

## 7. Constraints and Indexes

**Constraint names are unique within a table — one case-insensitive name space across CHECK, UNIQUE and FOREIGN KEY.** A `CREATE TABLE` declaring two constraints under one name is refused with `CONSTRAINT`; so is every `ALTER TABLE … ADD CONSTRAINT` / `ADD COLUMN … constraint <name> …` / `RENAME CONSTRAINT` onto a taken name ([§2.7](sql-alter.md)). The rule exists because `DROP` / `RENAME CONSTRAINT` resolves by name: two constraints of the same class under one name would both be removed by a single `DROP`, and two of different classes would be rejected as **ambiguous** forever. The import / rehydrate path is deliberately *not* guarded, so a database written before the rule still opens and surfaces the collision at its next `ALTER`.

Constraints written **without** a name are auto-named — `_check_<column>`, `_fk_<table>_<columns>`, `_uc_<columns>` for a UNIQUE's covering structure — and those names are user-addressable (a CHECK violation and a `DROP COLUMN` refusal both quote them back at you). Declaring two constraints that mint the *same* auto-name is legal — two unnamed CHECKs on one column, or two foreign keys from one child column into different parents — so the mint disambiguates instead of refusing: the first keeps the base spelling, the Nth gets a `_<N>` suffix (`_fk_c_x`, then `_fk_c_x_2`). The suffix is collision-only and the taken set includes the names the user typed, so an auto-name never lands on a user's name and every non-colliding auto-name is spelled exactly as it always was.

### 7.1 Primary Key Constraint

The primary key constraint uniquely identifies each record in a table.

A table declared with **no** primary key gets one covering **every** column, in declaration order — Quereus has no rowid, so whole-row identity is the fallback. The synthesized key does not force its columns `not null`. This matters wherever the primary key is referenced implicitly: `references <parent>` with no column list resolves to it (see [§ 7.6](#76-foreign-key-constraint)).

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

**When a foreign key cannot be enforced:**

Parent resolution happens **per plan**, not once at `CREATE TABLE` — that is what makes forward references (§ *Order Independence*) work, and it means a key can become unenforceable long after it was declared. Two cases, and what each reports:

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
