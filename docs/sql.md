# Quereus SQL Reference Guide

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

## 1. Introduction

Quereus is a lightweight, TypeScript-native SQL engine inspired by SQLite, with a focus on in-memory data processing and extensibility via the virtual table (VTab) interface. It supports a rich subset of SQL for querying, manipulating, and joining data from virtual tables, with async operations and modern JavaScript/TypeScript idioms. Quereus is designed for use in Node.js, browsers, and other JS environments, and does not provide persistent file storage by default.

**🚨 IMPORTANT: Key Departure from SQL Standard**

Quereus sympathises with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf) principles and **defaults columns to NOT NULL** unless explicitly specified otherwise. This is contrary to standard SQL where columns are nullable by default. This behavior can be controlled via the `default_column_nullability` pragma:

- **Default behavior**: `pragma default_column_nullability = 'not_null'`
- **SQL standard behavior**: `pragma default_column_nullability = 'nullable'`

This design choice helps avoid the "billion-dollar mistake" of NULL by default while still allowing NULLs when explicitly needed.

Key features:
- **Virtual Table Centric:** All data access is via virtual tables, which can be backed by memory, JSON, or custom sources.
- **In-Memory Focus:** No built-in file storage; all tables are transient unless a VTab module provides persistence.
- **Rich SQL Subset:** Supports select, insert, update, delete, CTEs, joins, aggregates, subqueries, and more.
- **Extensible:** Register custom functions, collations, and virtual table modules.
- **Asynchronous:** Database operations are async/await compatible, allowing non-blocking I/O.
- **Third Manifesto Aligned:** Embraces principles like default NOT NULL columns and key-based addressing.

## Topic documents

<!-- NOTE: each moved top-level section left a one-line stub behind under its original
     heading below, so its old `sql.md#<anchor>` still resolves here. `yarn docs:check`
     therefore cannot tell a link deliberately left on a stub from one that should have
     been retargeted to real content in a satellite. When linking real content that lives
     in a satellite, link the satellite — not the stub. -->

| Document | Covers |
| --- | --- |
| [SELECT, clauses & expressions](sql-select.md) | Query expressions, `SELECT`, `FROM` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` / `LIMIT` / `OFFSET`, CTEs (`WITH`), operators and functions-in-expressions. |
| [Data manipulation (DML)](sql-dml.md) | `INSERT`, `UPDATE`, `DELETE`, conflict resolution (`OR` clause), UPSERT (`ON CONFLICT`), and `RETURNING` with `NEW` / `OLD`. |
| [Schema definition (DDL)](sql-ddl.md) | Declarative schema, `CREATE TABLE`, assertions, mutation context, metadata tags, virtual tables, constraints and indexes. |
| [Schema modification (ALTER)](sql-alter.md) | `ALTER TABLE` — rename, add / drop / alter column, constraints, primary key, maintained lifecycle — and the tag verbs on views, materialized views, and indexes. |
| [Views & materialized views](sql-views.md) | `CREATE VIEW`, updatable views, `CREATE MATERIALIZED VIEW`, logical schemas and lenses. |
| [Functions](sql-functions.md) | Scalar, aggregate, JSON, date/time, window, and table-valued functions. |
| [Transactions & PRAGMA](sql-txn.md) | `BEGIN` / `COMMIT` / `ROLLBACK`, savepoints, and `PRAGMA` statements. |


## 2. SQL Statement Reference

Moved. The statement reference now lives across the topic documents above — see [SELECT & queries](sql-select.md), [data manipulation](sql-dml.md), [schema definition](sql-ddl.md), and [views](sql-views.md).


## 3. Clauses and Subclauses

Moved to [SQL Queries — SELECT, Clauses & Expressions](sql-select.md#3-clauses-and-subclauses).


## 4. Expressions and Operators

Moved to [SQL Queries — SELECT, Clauses & Expressions](sql-select.md#4-expressions-and-operators).


## 5. Functions

Moved to [SQL Functions](sql-functions.md#5-functions).


## 6. Virtual Tables

Moved to [SQL Schema Definition — DDL](sql-ddl.md#6-virtual-tables).


## 7. Constraints and Indexes

Moved to [SQL Schema Definition — DDL](sql-ddl.md#7-constraints-and-indexes).


## 8. Transactions and Savepoints

Moved to [SQL Transactions & PRAGMA](sql-txn.md#8-transactions-and-savepoints).


## 9. PRAGMA Statements

Moved to [SQL Transactions & PRAGMA](sql-txn.md#9-pragma-statements).


## 10. Error Handling

Quereus provides structured error handling through the `QuereusError` class hierarchy. Understanding these errors helps in debugging and creating robust applications.

### 10.1 Error Types

#### 10.1.1 QuereusError

The base error class for all Quereus errors. Contains:
- `message`: Description of the error
- `code`: A `StatusCode` value indicating the error type
- `cause`: Optional underlying error
- `line`, `column`: Position information when available

#### 10.1.2 ParseError

Specialized error for syntax problems during SQL parsing:
- Contains token information
- Includes precise position information

#### 10.1.3 MisuseError

Indicates API misuse, such as:
- Operating on a closed database
- Invalid parameter binding
- Interface contract violations

#### 10.1.4 ConstraintError

Indicates constraint violations, such as:
- Unique constraint violations
- NOT NULL constraint violations
- CHECK constraint failures

### 10.2 Error Status Codes

Important status codes include:

- `ERROR`: Generic error
- `INTERNAL`: Internal logic error
- `CONSTRAINT`: Constraint violation 
- `MISUSE`: Library misuse
- `RANGE`: Parameter out of range
- `NOTFOUND`: Item not found

### 10.3 Handling Errors in Applications

**JavaScript Example:**

```javascript
try {
  await db.exec("insert into users (email, username) values (?, ?)", 
    ['user@example.com', 'newuser']);
  console.log("Insert successful");
} catch (error) {
  if (error.code === StatusCode.CONSTRAINT) {
    console.error("Constraint violation:", error.message);
    // Handle specific constraint error (e.g., duplicate email)
  } else if (error instanceof ParseError) {
    console.error("SQL syntax error at line", error.line, "column", error.column);
  } else {
    console.error("Database error:", error.message);
  }
}
```

### 10.4 Common Error Scenarios

#### Syntax Errors

```sql
-- Missing FROM clause (will cause ParseError)
select id, name where status = 'active';
```

#### Constraint Violations

```sql
-- Assuming unique constraint on email (will cause ConstraintError)
insert into users (email) values ('existing@example.com');
```

#### Schema Errors

```sql
-- Reference to non-existent table (will cause QuereusError)
select * from nonexistent_table;
```

#### Type Errors

```sql
-- Type mismatch in operation (may cause runtime error)
select 'text' + 42 from users;
```

## 11. Quereus vs. SQLite

While Quereus supports similar SQL syntax, it has evolved into a distinct system with significant architectural and design differences from SQLite. Understanding these differences is important when porting applications from SQLite or creating new applications with Quereus.

### 11.1 Key Similarities

- SQL syntax is largely compatible
- Core DML (select, insert, update, delete) support
- Transaction and savepoint support
- Similar built-in function set
- Parameter binding with `?`, `:name`, and `$name` (an all-digit name — `:1`, `:007` — names a 1-based positional slot, so it binds from the same array position a `?` would)

### 11.2 Key Differences

#### 11.2.1 Type System

**Quereus:**
- Modern logical/physical type separation
- Native temporal types (DATE, TIME, DATETIME) using Temporal API
- Native JSON type with deep equality comparison
- Conversion functions (`integer()`, `date()`, `json()`) preferred over CAST
- Plugin-extensible custom types
- See [Type System Documentation](types.md)

**SQLite:**
- Type affinity model (INTEGER, REAL, TEXT, BLOB, NUMERIC)
- Dates stored as TEXT, REAL, or INTEGER
- JSON support via JSON1 extension (text-based)
- CAST operator for type conversion
- Limited type extensibility

#### 11.2.2 Architecture

**Quereus:**
- All tables are virtual tables
- No built-in file storage
- In-memory default with `memory` module
- Async/await API design for JavaScript

**SQLite:**
- Physical disk-based tables by default with optional virtual tables
- Built around persistent file storage
- Synchronous C API

#### 11.2.3 Feature Support

| Feature | Quereus | SQLite |
|---------|---------|--------|
| **Type System** | Logical/physical separation, temporal types, JSON | Type affinity model |
| **File Storage** | Supported via modules | Built-in |
| **Virtual Tables** | Central to design; all tables are virtual | Additional feature |
| **Triggers** | Not supported | Supported |
| **Views** | Basic support | Full support |
| **Foreign Keys** | Supported (on by default; requires explicit action clauses) | Full support (when enabled) |
| **Window Functions** | Phase 1 Complete (ranking, aggregates, partitioning) | Full support |
| **Recursive CTEs** | Basic support | Full support |
| **JSON Functions** | Extensive support with native JSON type | Available as extension |
| **Indexes** | Depends on VTab module | Full support |
| **BLOB I/O** | Basic support | Advanced support |
| **`OR <action>` modifier** | `INSERT OR <action>` only; UPDATE/DELETE deliberately omitted (use schema-level `ON CONFLICT` or rewrite) | `INSERT/UPDATE/DELETE OR <action>` (SQLite-specific extension) |

#### 11.2.4 Syntax Extensions

Quereus provides some syntax extensions:

```sql
-- Quereus: CREATE TABLE with USING clause for virtual tables
create table users (id integer primary key, name text) using memory;

-- Quereus: Temporal and JSON types
create table events (
  id integer primary key,
  event_date date,
  event_time time,
  created_at datetime,
  metadata json,  -- Extra commas are OK
);

-- Quereus: Conversion functions instead of CAST
select integer('42'), date('2024-01-15'), json('{"x":1}');

-- Quereus: PRIMARY KEY with ASC/DESC qualifier
create table logs (timestamp integer primary key desc, event text);

-- Quereus: CHECK constraints with operation specificity
create table products (
  price real check on insert (price >= 0),
  stock integer check on update (stock >= 0)
);

-- Quereus: Empty keys = singleton table (0-1 rows)
create table settings (
  knob integer,
  primary key ()
);

-- Quereus: Declarative DDL
declare schema Movies {
  table movie (id integer primary key,
    -- ...
  )
}
apply schema Movies;
```

Quereus also has row contraints with old/new context, mutation contexts, `with tags` metadata, and many more features.

#### 11.2.5 Performance Characteristics

- **Quereus**: JavaScript-based with optimization for federated operations (handed off to modules)
- **SQLite**: C-based with focus on disk I/O efficiency

### 11.3 Migration Considerations

When migrating from SQLite to Quereus:

1. **Type System**: Update date/time columns to use DATE, TIME, DATETIME types. Consider using JSON type for structured data. Replace CAST with conversion functions.
2. **Storage Strategy**: Determine how to handle persistence (quereus-plugin-indexeddb, quereus-plugin-leveldb, etc.)
3. **Async Handling**: Convert synchronous SQLite code to async/await with Quereus
4. **Feature Check**: Review use of triggers, advanced views, enforced foreign keys
5. **Transaction Model**: Similar, but understand Quereus's virtual table transaction model
6. **Custom Functions**: Port custom SQL functions to JavaScript

## 12. EBNF Grammar

Below is a formal Extended Backus-Naur Form (EBNF) grammar for Quereus's SQL dialect, based on the parser implementation.

### 12.1 Notation

- `[ a ]`: Optional element a
- `{ a }`: Zero or more repetitions of a
- `a | b`: Either a or b
- `( a )`: Grouping
- `"a"`: Literal terminal symbol
- `a b`: Sequence: a followed by b

### 12.2 Grammar

```ebnf
/* Top-level constructs */
sql_script         = { sql_statement ";" } ;

sql_statement      = [ with_clause ] ( select_stmt
                    | insert_stmt
                    | update_stmt
                    | delete_stmt
                    | values_stmt
                    | create_table_stmt
                    | create_index_stmt
                    | create_view_stmt
                    | create_materialized_view_stmt
                    | refresh_materialized_view_stmt
                    | create_assertion_stmt
                    | drop_stmt
                    | alter_table_stmt
                    | begin_stmt
                    | commit_stmt
                    | rollback_stmt
                    | savepoint_stmt
                    | release_stmt
                    | pragma_stmt
                    | analyze_stmt
                    | declare_schema_stmt
                    | declare_lens_stmt
                    | diff_schema_stmt
                    | apply_schema_stmt
                    | explain_schema_stmt ) ;

/* WITH clause and CTEs */
with_clause        = "with" [ "recursive" ] common_table_expr { "," common_table_expr } [ option_clause ] ;

option_clause      = "option" "(" "maxrecursion" integer ")" ;

common_table_expr  = cte_name [ "(" column_name { "," column_name } ")" ] 
                     "as" [ "materialized" | "not" "materialized" ]
                     "(" ( select_stmt | insert_stmt | update_stmt | delete_stmt ) ")" ;

cte_name           = identifier ;

/* SELECT statement */
select_stmt        = simple_select [ compound_operator simple_select ]* [ order_by_clause ] [ limit_clause ] [ with_defaults_clause ] ;

with_defaults_clause = "with" "defaults" "(" column_name "=" expr { "," column_name "=" expr } ")" ;
                     (* per-column omitted-insert defaults for view write-through; binds to the whole
                        compound, after limit/offset and before the DDL-level tags_clause — see view-updateability.md *)

simple_select      = "select" [ distinct_clause ] result_column { "," result_column }
                     [ from_clause ]
                     [ where_clause ]
                     [ group_by_clause ]
                     [ having_clause ]
                     [ with_schema_clause ] ;

distinct_clause    = "distinct" | "all" ;

result_column      = "*" | table_name "." "*"
                   | expr [ [ "as" ] column_alias ] [ with_inverse_clause ] ;

with_inverse_clause = "with" "inverse" "(" column_name "=" expr { "," column_name "=" expr } ")" ;
                     (* authored write-back expressions for updatable views — see view-updateability.md *)

from_clause        = "from" table_or_subquery { "," table_or_subquery } ;

table_or_subquery  = table_name [ [ "as" ] table_alias ] 
                   | "(" select_stmt ")" [ "as" ] table_alias
                   | "(" ( insert_stmt | update_stmt | delete_stmt ) ")" [ "as" ] table_alias
                   | function_name "(" [ expr { "," expr } ] ")" [ [ "as" ] table_alias ]
                   | join_clause ;

join_clause        = table_or_subquery { join_operator table_or_subquery join_constraint } ;

join_operator      = ","
                   | [ "left" [ "outer" ] | "inner" | "cross" | "right" [ "outer" ] | "full" [ "outer" ] ] "join" [ "lateral" ] ;

join_constraint    = [ "on" expr | "using" "(" column_name { "," column_name } ")" ] ;

where_clause       = "where" expr ;

group_by_clause    = "group" "by" expr { "," expr } ;

having_clause      = "having" expr ;

compound_operator  = "union" [ "all" ] | "intersect" | "except" | "diff" ;

order_by_clause    = "order" "by" ordering_term { "," ordering_term } ;

ordering_term      = expr [ "asc" | "desc" ] [ "nulls" ( "first" | "last" ) ] ;

limit_clause       = "limit" expr [ ( "offset" expr ) | ( "," expr ) ] ;

/* INSERT statement */
insert_stmt        = "insert" [ "or" conflict_resolution ] "into" table_name
                     [ "(" column_name { "," column_name } ")" ]
                     ( values_clause | select_stmt )
                     { upsert_clause }
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

conflict_resolution = "rollback" | "abort" | "fail" | "ignore" | "replace" ;

upsert_clause      = "on" "conflict" [ "(" column_name { "," column_name } ")" ]
                     ( "do" "nothing" | "do" "update" "set" column_name "=" expr
                       { "," column_name "=" expr } [ where_clause ] ) ;

values_clause      = "values" "(" expr { "," expr } ")" { "," "(" expr { "," expr } ")" } ;

values_stmt        = values_clause [ order_by_clause ] [ limit_clause ] ;

/* UPDATE statement */
update_stmt        = "update" table_name
                     "set" column_name "=" expr { "," column_name "=" expr }
                     [ where_clause ]
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

/* DELETE statement */
delete_stmt        = "delete" "from" table_name [ where_clause ]
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

context_clause     = "with" "context" context_assignment { "," context_assignment } ;

context_assignment = identifier "=" expr ;

with_schema_clause = "with" "schema" schema_name { "," schema_name } ;

returning_clause   = "returning" [ qualifier "." ] "*" { "," [ qualifier "." ] "*" }
                   | "returning" [ qualifier "." ] expr [ [ "as" ] column_alias ]
                     { "," [ qualifier "." ] expr [ [ "as" ] column_alias ] } ;

qualifier          = "old" | "new" ;

/* CREATE TABLE statement */
create_table_stmt  = "create" "table" [ "if" "not" "exists" ]
                     table_name "(" column_def { "," ( column_def | table_constraint ) } ")"
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ]
                     { context_def_clause | tags_clause } ;

context_def_clause = "with" "context" "(" context_var_def { "," context_var_def } ")" ;

context_var_def    = identifier type_name [ "null" ] ;

tags_clause        = "with" "tags" "(" tag_entry { "," tag_entry } ")" ;

tag_entry          = identifier "=" tag_value ;

tag_value          = string_literal | signed_number | "true" | "false" | "null" ;

column_def         = column_name [ type_name ] { column_constraint } [ tags_clause ] ;

type_name          = identifier [ "(" signed_number [ "," signed_number ] ")" ] ;

column_constraint  = [ "constraint" name ]
                     ( primary_key_clause
                     | "not" "null" [ conflict_clause ]
                     | "unique" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "default" ( signed_number | literal_value | "(" expr ")" )
                     | "collate" collation_name
                     | foreign_key_clause
                     | "generated" "always" "as" "(" expr ")" [ "stored" | "virtual" ] )
                     [ tags_clause ] ;

primary_key_clause = "primary" "key" [ ( "asc" | "desc" ) ] [ conflict_clause ] [ "autoincrement" ] ;

table_constraint   = [ "constraint" name ]
                     ( "primary" "key" "(" indexed_column { "," indexed_column } ")" [ conflict_clause ]
                     | "unique" "(" column_name { "," column_name } ")" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "foreign" "key" "(" column_name { "," column_name } ")" foreign_key_clause )
                     [ tags_clause ] ;

foreign_key_clause = "references" foreign_table [ "(" column_name { "," column_name } ")" ]
                     { [ "on" ( "delete" | "update" ) ( "set" "null" | "set" "default" | "cascade" | "restrict" | "no" "action" ) ]
                     | [ "match" name ] }
                     [ [ "not" ] "deferrable" [ "initially" ( "deferred" | "immediate" ) ] ] ;

conflict_clause    = "on" "conflict" conflict_resolution ;

row_op_list        = row_op { "," row_op } ;

row_op             = "insert" | "update" | "delete" ;

/* CREATE INDEX statement */
create_index_stmt  = "create" [ "unique" ] "index" [ "if" "not" "exists" ]
                     index_name "on" table_name "(" indexed_column { "," indexed_column } ")"
                     [ "where" expr ] [ tags_clause ] ;

indexed_column     = column_name [ "collate" collation_name ] [ "asc" | "desc" ] ;

/* CREATE VIEW statement */
create_view_stmt   = "create" "view" [ "if" "not" "exists" ]
                     view_name [ "(" column_name { "," column_name } ")" ] "as" select_stmt
                     [ tags_clause ] ;
                     (* omitted-insert defaults ride inside select_stmt's trailing with_defaults_clause *)

/* CREATE / REFRESH MATERIALIZED VIEW statements.
   The body is any query expression — a select_stmt, values_stmt, or with_clause select_stmt.
   Its omitted-insert defaults ride inside select_stmt's trailing with_defaults_clause. */
create_materialized_view_stmt = "create" "materialized" "view"
                     [ "if" "not" "exists" ] view_name [ "(" column_name { "," column_name } ")" ]
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] "as" select_stmt
                     [ tags_clause ] ;

refresh_materialized_view_stmt = "refresh" "materialized" "view" view_name ;

/* CREATE ASSERTION statement */
create_assertion_stmt = "create" "assertion" assertion_name "check" "(" expr ")" ;

/* DROP statement */
drop_stmt          = "drop" ( "table" | "index" | "view" | "assertion"
                            | "materialized" "view" ) [ "if" "exists" ] name ;

/* ALTER TABLE statement */
alter_table_stmt   = "alter" "table" table_name
                     ( rename_table_stmt
                     | rename_column_stmt
                     | add_column_stmt
                     | drop_column_stmt
                     | add_constraint_stmt
                     | alter_pk_stmt
                     | alter_column_stmt
                     | set_table_tags_stmt
                     | alter_constraint_tags_stmt ) ;

rename_table_stmt  = "rename" "to" new_table_name ;

rename_column_stmt = "rename" [ "column" ] old_column_name "to" new_column_name ;

add_column_stmt    = "add" [ "column" ] column_def ;

drop_column_stmt   = "drop" [ "column" ] column_name ;

add_constraint_stmt = "add" table_constraint ;

alter_pk_stmt      = "alter" "primary" "key" "(" [ pk_col { "," pk_col } ] ")" ;

alter_column_stmt  = "alter" "column" column_name
                     ( "set" "not" "null"
                     | "drop" "not" "null"
                     | "set" "data" "type" type_name
                     | "set" "default" expression
                     | "drop" "default"
                     | "set" "tags" tags_body ) ;

set_table_tags_stmt = "set" "tags" tags_body ;

alter_constraint_tags_stmt = "alter" "constraint" constraint_name "set" "tags" tags_body ;

/* ALTER VIEW / MATERIALIZED VIEW / INDEX — tag mutation only (SET replace / ADD merge / DROP delete) */
object_tags_action = ( "set" "tags" tags_body | "add" "tags" tags_body | "drop" "tags" tag_keys_body ) ;

alter_view_stmt    = "alter" "view" view_name object_tags_action ;

alter_mat_view_stmt = "alter" "materialized" "view" mat_view_name object_tags_action ;

alter_index_stmt   = "alter" "index" index_name object_tags_action ;

/* Like tags_clause's body but without the "with tags" prefix; empty "()" clears all tags. */
tags_body          = "(" [ tag_entry { "," tag_entry } ] ")" ;

/* Bare comma-list of tag keys (no "= value") for the DROP TAGS forms; empty "()" is a no-op. */
tag_keys_body      = "(" [ identifier { "," identifier } ] ")" ;

pk_col             = column_name [ "asc" | "desc" ] ;

/* Transaction statements */
begin_stmt         = "begin" [ "deferred" | "immediate" | "exclusive" ] [ "transaction" ] ;

commit_stmt        = "commit" [ "transaction" ] ;

rollback_stmt      = "rollback" [ "transaction" ] [ "to" [ "savepoint" ] savepoint_name ] ;

savepoint_stmt     = "savepoint" savepoint_name ;

release_stmt       = "release" [ "savepoint" ] savepoint_name ;

/* PRAGMA statement */
pragma_stmt        = "pragma" pragma_name [ "=" pragma_value ] ;

/* ANALYZE statement */
analyze_stmt       = "analyze" [ ( [ schema_name "." ] table_name ) | ( schema_name "." "*" ) ] ;

pragma_value       = signed_number | name | string_literal ;

/* Declarative schema statements */
declare_schema_stmt = "declare" [ "logical" ] "schema" schema_name
                      [ "version" string_literal ]
                      [ "using" "(" schema_option { "," schema_option } ")" ]
                      "{" { schema_item } "}" ;

declare_lens_stmt  = "declare" "lens" "for" schema_name "over" schema_name
                     "{" { "view" table_name "as" select_stmt [ ";" ] } "}" ;

schema_option      = identifier "=" string_literal ;

schema_item        = "table" table_name ( "{" | "(" ) column_def { "," ( column_def | table_constraint ) } ( "}" | ")" )
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] ";"
                   | "index" index_name "on" table_name "(" indexed_column { "," indexed_column } ")" ";"
                   | "view" view_name [ "(" column_name { "," column_name } ")" ] "as" select_stmt ";"
                   | "materialized" "view" view_name [ "(" column_name { "," column_name } ")" ]
                       [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] "as" select_stmt ";"
                   | "assertion" assertion_name "check" "(" expr ")" ";"
                   | seed_item ;

seed_item          = "seed" table_name [ "(" column_name { "," column_name } ")" ]
                     [ "values" ] "(" expr { "," expr } ")" { "," "(" expr { "," expr } ")" } ";" ;

diff_schema_stmt   = "diff" "schema" schema_name ;

apply_schema_stmt  = "apply" "schema" schema_name
                     [ "to" "version" string_literal ]
                     [ "with" "seed" ]
                     [ "options" "(" schema_option { "," schema_option } ")" ] ;

explain_schema_stmt = "explain" "schema" schema_name
                      [ "version" string_literal ] ;

/* Basic elements */
expr               = literal_value
                    | identifier
                    | unary_operator expr
                    | expr binary_operator expr
                    | function_call
                    | "(" expr ")"
                    | cast_expr
                    | expr "collate" collation_name
                    | expr [ "not" ] "like" expr [ "escape" expr ]
                    | expr [ "not" ] "glob" expr
                    | expr [ "not" ] "regexp" expr
                    | expr [ "not" ] "in" ( "(" [ select_stmt | expr { "," expr } ] ")" | table_name )
                    | expr "is" [ "not" ] expr
                    | expr [ "not" ] "between" expr "and" expr
                    | [ "exists" ] "(" select_stmt ")"
                    | case_expr
                    | window_function ;

literal_value      = numeric_literal | string_literal | blob_literal | "null" | "true" | "false" ;

numeric_literal    = [ "+" | "-" ] ( integer_literal | float_literal ) ;

integer_literal    = digit+ ;

float_literal      = digit+ "." digit* [ "e" [ "+" | "-" ] digit+ ]
                   | "." digit+ [ "e" [ "+" | "-" ] digit+ ]
                   | digit+ "e" [ "+" | "-" ] digit+ ;

string_literal     = "'" { character } "'" { "'" { character } "'" } ;

blob_literal       = "x'" hex_digit+ "'" ;

identifier         = [ schema_name "." ] name ;

schema_name        = name ;

table_name         = [ schema_name "." ] name ;

column_name        = [ table_name "." ] name ;

collation_name     = name ;

function_name      = name ;

function_call      = function_name "(" [ [ "distinct" ] expr { "," expr } ] ")" ;

cast_expr          = "cast" "(" expr "as" type_name ")" ;

case_expr          = "case" [ expr ] { "when" expr "then" expr } [ "else" expr ] "end" ;

window_function    = function_call "over" window_name_or_specification ;

window_name_or_specification = window_name | "(" window_specification ")" ;

window_specification = [ window_name ] [ "partition" "by" expr { "," expr } ] [ "order" "by" ordering_term { "," ordering_term } ] [ frame_spec ] ;

frame_spec         = ( "range" | "rows" ) ( frame_bound | "between" frame_bound "and" frame_bound ) [ frame_exclude ] ;

frame_bound        = "unbounded" "preceding"
                   | "current" "row"
                   | "unbounded" "following"
                   | expr "preceding"
                   | expr "following" ;

frame_exclude      = "exclude" "no" "others"
                   | "exclude" "current" "row"
                   | "exclude" "group"
                   | "exclude" "ties" ;

/* Basic lexical elements */
name               = identifier_start_char { identifier_char } ;

identifier_start_char = alpha | "_" ;

identifier_char    = alpha | digit | "_" ;

alpha              = "a" | "b" | ... | "z" | "A" | "B" | ... | "Z" ;

digit              = "0" | "1" | ... | "9" ;

hex_digit          = digit | "a" | "b" | "c" | "d" | "e" | "f" | "A" | "B" | "C" | "D" | "E" | "F" ;

unary_operator     = "-" | "+" | "~" | "not" ;

binary_operator    = "||" | "*" | "/" | "%" | "+" | "-" | "<<" | ">>" | "&" | "|"
                   | "<" | "<=" | ">" | ">=" | "=" | "==" | "!=" | "<>"
                   | "and" | "or" | "xor"
                   | "->" | "->>" ;
```

This grammar defines the syntax of SQL statements supported by Quereus. While it captures most of the language features, some specialized constructs and edge cases may not be fully represented. For the definitive reference, always consult the Quereus parser implementation.
