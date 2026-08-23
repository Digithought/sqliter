# SQL Queries — SELECT, Clauses & Expressions

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## Query expressions

A **query expression** is anything that produces a relation. Quereus accepts
the same five forms at every relation-producing site:

| Form                                 | Notes                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `SELECT …`                           | The canonical relational query.                               |
| `VALUES (…), …`                      | A literal row set. Body-supplied / binding-site names apply.  |
| `INSERT … RETURNING …`               | DML re-projected through `RETURNING`.                         |
| `UPDATE … RETURNING …`               | DML re-projected through `RETURNING`.                         |
| `DELETE … RETURNING …`               | DML re-projected through `RETURNING`.                         |

Each of these may appear at any **relation site**:

- Top-level statement
- FROM-clause subquery source (`… FROM (<query-expr>) AS t [(cols)]`)
- Scalar / row subquery (`(<query-expr>)`)
- `IN (<query-expr>)` and `NOT IN (<query-expr>)`
- `EXISTS (<query-expr>)`
- Compound legs (`<query-expr> UNION [ALL] | INTERSECT | EXCEPT | DIFF <query-expr>`), where
  either leg may itself be a parenthesized query expression (see the set-operation section)
- CTE body (`WITH cte(cols) AS (<query-expr>) …`)
- View body (`CREATE VIEW v[(cols)] AS <query-expr>`)

**RETURNING is required for DML at non-top-level positions.** The outer
position consumes a relation, so a `RETURNING`-less DML is rejected at parse
time outside top-level.

**All five forms run at every relation site**, with one exception: DML
(`INSERT/UPDATE/DELETE … RETURNING`) is rejected as a view body. A view
re-evaluates on every reference, and replaying a write per read is incoherent
with view semantics; the mutation belongs in the statement that references
the view, not in the view body. The rejection fires at view-creation time.

**Run-once + full-drain contract for impure subqueries.** When a DML appears
in scalar / `IN` / `EXISTS` position, the runtime applies two contracts that
do not apply to pure inners:

- **Full drain.** The emitter consumes every row of the inner iterator —
  no short-circuit on first row (`scalar`), on match (`IN`), or on
  `EXISTS = true`. The pure-inner optimization survives unchanged.
- **Run once per statement execution.** If the outer expression is
  re-evaluated (correlated subquery, per-row scan), the inner DML executes
  exactly once and subsequent evaluations replay the memoized result.

**`LIMIT` over a writing source drains too.** The same rule covers a `LIMIT`
whose source subtree carries a write — most visibly a DML FROM-subquery,
`select … from (insert … returning …) limit n`. The `LIMIT` caps how many rows
the query RETURNS; it does not cap how many rows the statement WRITES. Once the
limit is reached the emitter stops yielding but keeps consuming the source, so
the DML runs to completion — including under `LIMIT 0`, which returns nothing
and still performs every write. This matches what a data-modifying CTE already
does (`test/logic/13.6-cte-dml-runs-once.sqllogic`) and what PostgreSQL does for
data-modifying CTEs. Pinned end-to-end in
`test/logic/01.9.1-limit-over-dml-subquery.sqllogic`. The gate asks whether the
whole source *subtree* writes, not whether its immediate child does, so an outer
`LIMIT` over an inner `LIMIT` over a DML drains through both.

A `LIMIT` over a **pure** source keeps its early stop, and stops precisely: it
pulls exactly `offset + limit` rows and never asks the source for the row past
the last one it emits (`test/runtime/early-stop-consumption.spec.ts`).

*Scope.* "Runs to completion" means *when the statement is run to completion* —
`exec()`, or an iteration that reaches the end of the result. Abandoning the
iteration early stops the writes with it, because the engine is lazy end to end:
a caller that reads one row of `select … from (insert … returning …) limit 5`
and breaks has performed one insert. That is not specific to `LIMIT` — the same
caller breaking out of the same statement *without* a `LIMIT` gets the same one
insert. `LIMIT 0` is the exception in the other direction: it drains on the first
`next()`, so every write happens before the caller can abandon anything.

All of these contracts are gated by `physical.readonly === false` on the inner
subtree, so pure inners are unaffected. See `docs/runtime.md` for the
emitter-level mechanics.

**Conflict resolution does not propagate inward.** An outer
`INSERT OR REPLACE … (insert into inner … returning …)` does not flow its
`OR REPLACE` into the inner DML — each DML carries its own
`onConflict` from its own AST.

**Limitation: per-row DML in an outer DML is not supported.** Expressions
of the form `update outer set x = (insert into inner … returning y)` where
the scalar subquery is evaluated *per row of an outer DML* are not yet
supported. The ordering semantics (does the inner see the outer's mid-flight
writes?) are subtle and the engine errs on the side of refusing rather than
guessing. Use a CTE pre-pass or a two-statement form instead.

**Column naming for unnamed bodies.** When a `VALUES` (or any other form
without explicit projection aliases) appears at a site that binds columns,
the precedence is:

1. Binding-site column list — `(VALUES (…)) AS t(a, b)`, `WITH t(a, b) AS …`,
   `CREATE VIEW v(a, b) AS …` — wins absolutely.
2. Body-supplied names — SELECT/RETURNING aliases or column refs. `VALUES`
   has none.
3. Synthesized fallback — `column_0`, `column_1`, … (today's default).

Persistent named relations (top-level CTE bodies, view bodies) with neither
binding-site nor body-supplied names silently fall back to the synthesized
form; they do **not** error.

## 2.1 SELECT Statement

The select statement retrieves data from one or more tables or views.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
select [distinct | all] select_expr [, select_expr ...]
[ from table_reference [, table_reference...] ]
[ where condition ]
[ group by expr [, expr...] ]
[ having condition ]
[ order by expr [asc | desc] [, expr [asc | desc]...] ]
[ limit count [offset skip] | limit skip, count ]
[ union [all] select_statement ]
+| [ intersect select_statement ]
+| [ except select_statement ]
+| [ diff select_statement ]
[ with schema schema_name [, schema_name...] ]
[ with defaults (column = expr [, ...]) ]

select_expr:
  { * | table.* | expr [ [as] alias ] [ with inverse (column = expr [, ...]) ] }
```

**Options:**
- `with clause`: Common Table Expressions (CTEs) for temporary named result sets
- `distinct`: Removes duplicate rows from the result set
- `all`: Includes all rows (default behavior)
- `select_expr`: Column expressions to be returned; `*` for all columns. A result column may carry a trailing `with inverse (...)` clause — a core-`select` extension supplying authored write-back expressions for updatable-view write-through (see [Result-column inverses](#result-column-inverses-with-inverse) below)
- Output columns follow the written select-list order, with each `*` / `table.*` expanded in place — `select v, * from t` returns `v` followed by every column of `t` (including `v` again, disambiguated), not the star's columns first. This holds for grouped queries too (see [§3.3 GROUP BY Clause](#33-group-by-clause)).
- `from`: Tables, views, or subqueries to retrieve data from
- `where`: Filters rows based on a condition
- `group by`: Groups rows that have the same values
- `having`: Filters groups based on a condition
- `order by`: Sorts the result set
- `limit/offset`: Restricts the number of rows returned
- `union`/`intersect`/`except`/`diff`: Set operations combining two result sets
- `with schema`: Specifies an ordered search path for resolving unqualified table names (see [§2.1.1 Schema Search Path](#211-schema-search-path-with-schema))
- `with defaults`: Trailing clause binding the whole query expression; declares per-column omitted-insert defaults for updatable-view write-through (see [Insert defaults](#insert-defaults-with-defaults) below)

**Set operations:**
- `union all`: Concatenation (bag semantics)
- `union`: Union with deduplication (set semantics)
- `intersect`: Common rows (set semantics)
- `except`: Rows in left not in right (set semantics)
- `diff`: Symmetric difference = (A except B) union (B except A) (set semantics)

**Parenthesized operands.** A parenthesized query expression `( <query-expr> )` is a
valid operand on **either side** of a set operation, and equally as a view body, CTE body,
or top-level query — so `(select 1) union (select 2)`, `(A union B) union (C union D)`, and
`create view v as (select 1) union (select 2)` all parse. The inner expression is a full
query expression: it may carry its own `WITH`, a nested compound, and its own trailing
`ORDER BY` / `LIMIT` (which bind **inside** the parentheses). Redundant grouping collapses:
`(select 1)` ≡ `select 1`, and a simple `(select 1) union (select 2)` carries the same AST
as the unparenthesized `select 1 union select 2`.

> **Note (associativity):** Parenthesized operands group **as written** (left-associative):
> `(A) union (B) union (C)` evaluates as `(A union B) union C`. Unparenthesized chains keep
> their existing **right-leaning** grouping: `A except B union C` evaluates as
> `A except (B union C)`, not `(A except B) union C`. Parentheses are the escape hatch — use
> them (or CTEs/subqueries) to force a specific left-to-right evaluation order.

### Set-operation membership columns

Between a set-operation keyword (`union [all]` / `intersect` / `except`) and its right
leg, a compound may expose **membership columns** — a clean `{true,false}` NOT NULL flag
per branch telling you whether the result tuple is a member of that immediate operand of
the binary combinator (the row analogue of the join [existence column](#existence-columns-on-outer-joins)):

```sql
-- which branch(es) did each result row come from?
select id, x, inA, inB
from a union exists left as inA, exists right as inB select id, x from b;
```

- The clause sits **after the operator keyword (and any `all`) and before the right leg**.
  `exists left as <name>` names the leg already parsed before the operator; `exists right
  as <name>` names the operand that follows. Comma-separated; either or both may be
  exposed. `exists` here is **always** followed by `left` / `right` — never `(` — so one-token
  lookahead distinguishes it from the `exists (<subquery>)` predicate (which never legally
  begins a compound leg). This is additive grammar — it occupies previously-unused space and
  breaks nothing.
- Applies to `union` / `union all` / `intersect` / `except`. **Rejected on `diff`** (symmetric
  difference desugars to `(A except B) union (B except A)`, so branch membership is ambiguous
  over the two `except`s).
- The flag is derived **at the combinator** by a per-branch semijoin probe over the operand
  *data* relations (`inA ≡ tuple ∈ A`), never stored in a branch (a stored flag would re-enter
  the union schema and dedup, perturbing set identity). For `union all` the probe is against a
  set, so the flag is the boolean "present ≥ once". `except` reads `inLeft = true, inRight =
  false`; `intersect` reads all flags `true`.
- The binary combinator always names its **own** two operands; the n-way case is covered by
  **nesting** (no global positional "middle branch" naming).
- **Writable (binary, non-nested).** A membership column **is** the branch presence, so
  *writing* it drives the branch's existence — `set inB = true` over a row absent from B
  inserts it into B; `set inB = false` over a row in B deletes the matching B row; **both
  false** removes the row from the view. For `except` (`A except B`), `set inRight = true`
  inserts into B (pushing the row out of the view) and `set inLeft = false` deletes from A;
  for `intersect`, `set inB = false` deletes from B (dropping the row). A membership value
  must be a boolean literal. Data-column writes and `delete from`s **fan out** to every
  branch the row is a member of (via the runtime membership probe); `insert into` routes by
  the supplied flags (a true flag inserts into that branch). `column_info` reports each
  column `is_updatable = 'YES'` with null base (writable through an *effect*, not a base
  mapping). Nested / n-way set-op writes and non-literal membership values are deferred.
- **Flag-less predicate-honest writes (the preferred surface).** A flag-less set-op body
  whose legs carry *regular projected columns* — plain base columns plus literal
  **discriminators** (`'red' as kind`) — is writable WITHOUT any `exists … as <flag>`
  column: a flat `union all` of literal-discriminator legs (and a binary `intersect` /
  `except`) routes INSERT to, and fans DELETE / data-UPDATE across, the legs each row is
  consistent with — decided at plan time by the leg's σ-facts + literal discriminators
  (`checkSatisfiability`). The literal discriminators are **read-only** (a `set kind = …`
  is `no-inverse`); plain data columns are writable. This coexists with — and is preferred
  over — the `exists`-membership path above. See
  [docs/view-updateability.md](view-updateability.md) § Set Operations.

**Examples:**
```sql
-- Basic select with where clause
select id, name, age from users where age > 21;

-- Select with join
select u.name, o.product 
  from users as u
  inner join orders as o on u.id = o.userId
  where o.status = 'shipped';

-- Group by with aggregates
select department, count(*) as employeeCount, avg(salary) as avgSalary
  from employees
  group by department
  having count(*) > 5
  order by avgSalary desc;

-- With CTE and union
with active_users as (
  select * from users where status = 'active'
)
  select name, email from active_users where age < 30
  union all
  select name, email from premium_users where subscriptionStatus = 'paid';

-- Symmetric difference (DIFF)
select value from set_a
diff
select value from set_b
order by value;

-- Table equality check using DIFF
select not exists(
  select * from (
    select * from a
    diff
    select * from b
  )
) as tables_equal;

-- Query with explicit schema search path
select * from users, orders
with schema sales, main;
```

### Result-column inverses (WITH INVERSE)

A result column may carry a trailing `with inverse (column = expr, ...)` clause — a
**core `select` extension**, not a view-only feature — that supplies authored write-back
expressions for [updatable-view](sql-views.md#29-updatable-views) write-through. Each assignment names
a base column of the FROM sources and gives the expression that computes it from the
written view row, referenced through the mandatory `new.` qualifier:

```sql
-- target names the BASE column (code5); new.* names the OUTPUT column (code)
select
  case code5 when 'A1' then 'A' when 'A2' then 'A' end as code
    with inverse (code5 = case new.code when 'A' then 'A1' end),
  first || ' ' || last as full_name
    with inverse (first = substr(new.full_name, 1, instr(new.full_name, ' ') - 1),
                  last  = substr(new.full_name, instr(new.full_name, ' ') + 1))
from people;
```

- Upgrades an otherwise **read-only computed column** to writable on both `update` and
  `insert` (a registry-invertible column such as `v + 1` is writable on `update` only; the
  authored inverse is the hook that also makes the column insertable).
- Targets must be base columns of the FROM sources; every `new.*` reference must be an
  output column of the select. Both are **validated at build time wherever the clause
  appears**, so a typo fails loudly even when the relation is never written through.
- Because the clause lives on the core `select`, it parses at every relation site — view
  bodies, CTE bodies, subqueries-in-`from`, and lens bodies — and is **inert metadata
  until the relation is an actual write target**.
- An inverse expression's `new.` references are **inert to schema-rename propagation**:
  they name the enclosing select's output row, so neither renaming a real table called
  `new` (or one of its columns) nor dropping it touches or is blocked by them. They follow
  exactly one thing — a shift of the enclosing select's **own published output name**
  (e.g. `alter table … rename column` moving a bare passthrough projection's name), and
  that shift stops at a nested select's own `with inverse` clause, whose `new.` refs
  track the nested outputs instead. Table and column references inside an inverse
  expression's *subqueries* propagate normally.

See [vu-inverses.md § Authored inverses](vu-inverses.md#authored-inverses-with-inverse)
for the law treatment (PutGet / GetPut) and the per-shape consumption.

### Insert defaults (WITH DEFAULTS)

A query expression may carry a trailing `with defaults (column = expr, ...)` clause — bound
to the **whole compound**, after `order by` / `limit` and before any DDL-level `with tags`
— declaring per-column **omitted-insert defaults** for [updatable-view](sql-views.md#29-updatable-views)
write-through. Like `with inverse`, it is a clause of the **core select**, not a view-only
construct:

```sql
create view NewUsers(uid, label) as
  select id, name from Users
  with defaults (created = epoch_ms('now'));

insert into NewUsers (uid, label) values (7, 'Bob');   -- created defaults to epoch_ms('now')
```

- Each entry names a base column the view projects away (the dominant case) or a
  `base`-lineage view column, and supplies a **self-contained** expression (literals,
  function calls, subqueries — it cannot reference the inserted row's columns; that rule
  is documented, not rejected at create time, and schema-rename propagation pins it the
  same way it does `with inverse`: a bare `new.` / `old.` in an entry expression is never
  treated as a reference to a table so named). At
  write-through it fills a still-omitted column *after* the user value / equality-predicate
  constant / EC sources and *ahead of* the base column's declared `default`.
- Column names must be distinct (a duplicate is a parse error); the target is resolved —
  and a typo rejected — at **write time**, not create time.
- It parses wherever a select parses and is **inert where no write path consumes it** — a
  bare top-level `select … with defaults (…)` runs and ignores the clause; only a view or
  CTE-name INSERT target fires it. It is the **only** insert-default surface (the former
  `insert defaults (…)` spelling and the `quereus.update.default_for.*` tag are both removed).

See [vu-inverses.md § View defaults](vu-inverses.md#view-defaults).

### 2.1.1 Schema Search Path (WITH SCHEMA)

Quereus supports flexible schema resolution through search paths. Unqualified relation names are resolved by searching schemas in a specified order.

**Resolution Hierarchy:**
1. **Qualified names** (`schema.table`) - Always used exactly as specified
2. **WITH SCHEMA clause** - Per-query explicit search path
3. **PRAGMA schema_path** - Session-level default search path
4. **Default search order** - `main`, then `temp`

**Tables, views and materialized views resolve identically.** The path applies to every unqualified relation name written *anywhere in the statement that declares it* — in a `FROM` clause, as an `INSERT` / `UPDATE` / `DELETE` target, and inside that statement's other clauses (a subquery in `RETURNING`, in an `INSERT`'s `VALUES` row, in `SET` / `WHERE`). The path is walked **one schema at a time**, and each entry's tables *and* views are checked **together** before moving to the next entry; the first entry holding an object of that name wins, whatever its kind. So a table named `x` in an earlier path entry beats a view named `x` in a later one. (A table and a view of the same name inside one schema is impossible — `create table` and `create view` reject a name the other already holds.)

**Anything written in an object's own definition is the exception** — it resolves against that object's schema, never the calling statement's `WITH SCHEMA` path, in two grades:

- A **view / materialized-view body** resolves unqualified names against the **owning object's schema first**, then the session default path. A view declared next to its tables in a non-`main` schema therefore reads correctly under any session path, and `refresh materialized view` is path-independent.
- A **schema-authored expression** — a column `DEFAULT`, a generated-column expression, a `CHECK` constraint, a foreign-key existence check — is stricter: the **owning table's schema only**, with no fallback to the default path. So a `DEFAULT (select count(*) from c)` on a table in `temp` always counts `temp.c`, whatever the writing statement's path, and one naming a relation in another schema must qualify it.

**DDL landing vs. read resolution (deliberate asymmetry):** unqualified DDL (`create table` / `create view` / `create index` / `drop …` / `alter … tags`) lands objects in the **current schema** (`SchemaManager.setCurrentSchema`, an embedder API — there is no SQL surface for it), while unqualified *reads* resolve only via the search path above, which does **not** consult the current schema. An embedder that sets a non-`main` current schema must also set `schema_path` (or qualify references); otherwise objects it creates are invisible to unqualified reads. Pure-SQL users are unaffected — the current schema is always `main` unless an embedder changes it.

**WITH SCHEMA Syntax:**
```sql
SELECT ... FROM table1, table2
WITH SCHEMA schema1, schema2, schema3;
```

The `WITH SCHEMA` clause specifies an ordered list of schemas to search when resolving unqualified table names. The first schema containing a matching table is used.

**Examples:**

```sql
-- Explicitly search sales schema, then main
SELECT * FROM orders, customers
WITH SCHEMA sales, main;
-- If 'orders' exists in 'sales', uses sales.orders
-- If 'customers' only exists in 'main', uses main.customers

-- Works with CTEs
-- Note: WITH SCHEMA applies only to the outer query.
-- The CTE (recent_orders) uses the connection/database default schema path.
WITH recent_orders AS (
  SELECT * FROM orders WHERE date > date('now', '-7 days')
)
SELECT * FROM recent_orders
WITH SCHEMA sales, archive, main;

-- To apply schema path to the CTE query itself, use a nested WITH SCHEMA:
WITH recent_orders AS (
  SELECT * FROM orders WHERE date > date('now', '-7 days')
  WITH SCHEMA sales, archive
)
SELECT * FROM recent_orders;

-- DML operations also support WITH SCHEMA
UPDATE inventory SET quantity = quantity - 1
WHERE sku = 'ABC123'
WITH SCHEMA warehouse, main;

INSERT INTO logs (message) VALUES ('Order processed')
WITH SCHEMA audit, main
RETURNING id;

DELETE FROM temp_data WHERE expired = 1
WITH SCHEMA workspace, main;
```

**Error Messages:**

When a table is not found, Quereus provides helpful diagnostics:

```sql
-- Table not in search path
SELECT * FROM products WITH SCHEMA sales, finance;
-- Error: Table 'products' not found in schema path: sales, finance
--        Did you mean 'main.products'?
--        Or add 'main' to your schema path?

-- Table doesn't exist anywhere
SELECT * FROM nonexistent WITH SCHEMA main, sales;
-- Error: Table 'nonexistent' not found in schema path: main, sales
```

**Best Practices:**

- Use qualified names (`schema.table`) when you need precision
- Use `WITH SCHEMA` for cross-schema queries without qualification
- Set `PRAGMA schema_path` for session-wide defaults
- Default to `main` schema for simple, single-schema applications

**Order Independence:**

The `WITH CONTEXT` and `WITH SCHEMA` clauses can appear in any order:

```sql
-- Both are valid:
INSERT INTO table VALUES (...) WITH CONTEXT (x = 1) WITH SCHEMA sales;
INSERT INTO table VALUES (...) WITH SCHEMA sales WITH CONTEXT (x = 1);

UPDATE table SET col = val WITH SCHEMA main WITH CONTEXT (x = 1);
DELETE FROM table WHERE id = 1 WITH CONTEXT (x = 1) WITH SCHEMA main;
```

## 3. Clauses and Subclauses

### 3.1 FROM Clause

The from clause specifies the data sources for a query.

**Syntax:**
```sql
from table_reference [, table_reference...]

table_reference:
  table_name [[as] alias]
| function_name ([arg[,...]]) [[as] alias]
| (select_statement) [[as] alias]
| (mutating_statement) [[as] alias]
| table_reference join_type join table_reference [join_specification]
```

**Mutating Statements:**
Quereus supports **relational orthogonality** - any statement that results in a relation can be used anywhere that expects a relation value. This includes:
- `(INSERT ... RETURNING ...) AS alias`
- `(UPDATE ... RETURNING ...) AS alias` 
- `(DELETE ... RETURNING ...) AS alias`

This allows for powerful compositions where the results of data modifications can be immediately used in queries.

**Join Types:**
- `[inner] join`: Matches rows when join condition is true
- `left [outer] join`: Includes all rows from left table, plus matching rows from right table
- `right [outer] join`: Includes all rows from right table, plus matching rows from left table
- `full [outer] join`: Includes all rows from both tables
- `cross join`: Cartesian product of both tables

**Join Specifications:**
- `on condition`: Join condition
- `using (column[,...])`: Join on equal named columns. Shorthand for the `on
  left.col = right.col and …` predicate, and identical to it in every respect
  (type coercion, collation resolution, NULL handling, plan shape). Unlike SQLite,
  the shared column is **not** merged into one output column — both sides' columns
  remain selectable, so an unqualified reference to the shared name is ambiguous.
  A named column absent from either side is an error.

#### Existence columns on outer joins

After a complete `on` / `using` predicate, an outer join may expose **existence
columns** — a clean `{true,false}` NOT NULL flag per non-preserved side telling you
whether that side matched the current row (Dataphor's `include rowexists`):

```sql
-- non-preserved (right) side of a LEFT join; `exists as` resolves the side
select c.id, hasOrder
from customers c left join orders o on o.cust = c.id exists as hasOrder;

-- explicit side; required for FULL (both sides null-extendable), comma-separated
select a.id, aOnly, bOnly
from a full join b on b.k = a.k exists left as aOnly, exists right as bOnly;
```

- The clause appears **only after a finished `on` / `using` predicate**, and
  `exists` here is always followed by `as` or a side token — never `(` — so it never
  collides with the `exists (<subquery>)` predicate (one-token lookahead
  distinguishes them). The comma form is recognised only when the next token is
  another `exists`, so a genuine new FROM-source comma is unaffected.
- `exists as <name>` resolves to the unique non-preserved side of a `left` / `right`
  join. A side is **required** for `full outer` (both sides null-extend); `inner` /
  `cross` and the preserved side of a `left` / `right` join are **rejected** (no
  null-extension ⇒ the flag would be a meaningless constant `true`).
- The flag is derived **at the join** from the actual match, never stored in the
  operand and never a re-evaluation of the predicate (which would be unsound on a
  null-extended row). **Writing it drives the non-preserved side's existence** through
  an updatable view: `set hasOrder = true` over a null-extended row inserts the matching
  side (join key via the equi-join equivalence class, other columns defaulted), `= false`
  over a matched row deletes it, and it is consumed as a routing directive on insert
  (`insert into v (…, hasOrder) values (…, false)` ⇒ preserved-only) — never stored to a
  base column. Only a **boolean literal** (`true`/`false`) is supported; a per-row branch
  on a non-literal value is deferred. See [vu-operators.md § Existence columns](vu-operators.md#existence-columns-on-outer-joins).

**Examples:**
```sql
-- Multiple tables
select u.name, p.title 
from users as u, posts as p
where u.id = p.user_id;

-- Inner join
select e.name, d.name as department
from employees as e
inner join departments as d on e.dept_id = d.id;

-- Left join
select c.name, o.order_date
from customers as c
left join orders as o on c.id = o.customer_id;

-- Using clause
select p.title, c.content
from posts as p
join comments as c using (post_id);

-- Multiple joins
select o.id, c.name, p.name as product
from orders as o
join customers as c on o.customer_id = c.id
join order_items as oi on o.id = oi.order_id
join products as p on oi.product_id = p.id;

-- Subquery in from
select avg_dept.department, avg_dept.avg_salary
from (
  select department, avg(salary) as avg_salary
  from employees
  group by department
) as avg_dept
where avg_dept.avg_salary > 50000;

-- Mutating subquery: INSERT with RETURNING as table source
select new_user.id, new_user.name, 'created' as status
from (
  insert into users (name, email) 
  values ('Alice', 'alice@example.com')
  returning id, name
) as new_user;

-- Mutating subquery: UPDATE with RETURNING in JOIN
select u.name, updated.old_email, updated.new_email
from users u
join (
  update user_profiles 
  set email = lower(email)
  where email != lower(email)
  returning user_id, email as old_email, lower(email) as new_email
) as updated on u.id = updated.user_id;

-- Mutating subquery: DELETE with RETURNING for audit trail
insert into audit_log (action, deleted_user_id, deleted_name)
select 'user_deleted', deleted.id, deleted.name
from (
  delete from users 
  where last_login < date('now', '-365 days')
  returning id, name
) as deleted;

-- Table-valued function
select key, value 
from json_each('{"name":"John","age":30}');
```

### 3.2 WHERE Clause

The where clause filters rows returned by a query.

**Syntax:**
```sql
where condition
```

The condition is an expression that evaluates to a boolean result. If true, the row is included in the result set.

**Examples:**
```sql
-- Simple comparison
select * from products where price < 50;

-- Multiple conditions with AND/OR
select * from employees 
  where (department = 'Sales' or department = 'Marketing')
  and hire_date >= date('2020-01-01');

-- Pattern matching with LIKE
select * from customers where email like '%@gmail.com';

-- Range check with BETWEEN
select * from orders where order_date between date('now', '-30 days') and date('now');

-- NULL checking
select * from users where last_login is null;

-- Subquery in WHERE
select * from products
  where category_id in (select id from categories where parent_id = 5);

-- EXISTS subquery
select * from customers as c
  where exists (
    select 1 from orders as o
      where o.customer_id = c.id and o.status = 'shipped'
  );
```

### 3.3 GROUP BY Clause

The group by clause groups rows that have the same values into summary rows.

**Syntax:**
```sql
group by expression [, expression...]
```

**Behavior:**
- Each expression in the group by must be a column name, an expression, or a positive integer representing a position in the select list.
- A positional reference binds to the select list's Nth **output column**, not to that column's name. A select-list alias, or a same-named column from another table in the FROM clause, therefore cannot capture it: in `select t2.*, count(*) from t1 join t2 on t1.k = t2.k group by 1, 2` the ordinals name `t2`'s columns even though `t1` exposes the same column names.
- Aggregate functions (`count()`, `sum()`, etc.) can be used with group by to calculate summary statistics for each group.
- Columns in the select list that are not aggregated must appear in the group by clause.
- The restriction covers **every** clause evaluated after grouping — the select list, `having`, the `order by`, and window specifications — and reaches inside a correlated subquery written in any of them: `select a, (select count(*) from t2 where t2.b = t.b) from t group by a` names the ungrouped `t.b` and is rejected, while the subquery's *own* columns and references correlated to an *enclosing* query are unaffected. All of these raise `Column '<name>' must appear in the GROUP BY clause or be used in an aggregate function`; `having`'s own bare references keep their dedicated message (see [§3.4](#34-having-clause)).
- A non-bare grouping key (`group by a || '!'`) is recognised elsewhere in the query by matching the whole expression, written the same way. Identifier case does not count as a difference (`group by A || '!'` covers a later `a || '!'`), but a quoted literal's case does: `a || 'X'` and `a || 'x'` are different keys. A **qualifier** difference does count: under `group by a || '!'`, a later `t.a || '!'` does not match the key and is rejected as an ungrouped reference to `a`. Bare-column keys are exempt — `group by a` is named by `a`, `t.a` or `w.a` alike.
- A group by with no aggregate function anywhere is legal and yields one row per distinct group.
- Output column order follows the select list, not the group by list. `select *` over a grouped query therefore emits the source columns in table order even when `group by` names them in another order.
- The output is exactly the select list — a grouping key the select list does not name is not returned. `select count(*) from t group by g` yields one column.
- A window function in a grouped select list runs over the **grouped result rows** — one row per group — not over the underlying rows. `select a, row_number() over (order by a) from t group by a` numbers the groups, and `count(*) over ()` returns the number of groups. Its window specification (`partition by` / `order by`) and its arguments are subject to the same group by restriction as the rest of the select list: they may reference only grouping keys and aggregate results. A grouping key may be named there by **any** spelling that denotes it — bare (`a`), table-qualified (`t.a`), alias-qualified (`w.a`), the whole grouped expression written out again (`a || '!'` against `group by a || '!'`, identifier case immaterial), or the select-list alias of the column that selects it (`select a as k, row_number() over (order by k) … group by a`) — regardless of how the group by itself spelled it. The alias spelling works for an *aggregate* too (`select a, count(*) as c, row_number() over (order by c) …`). An aggregate spelled out inside a window specification must also appear in the select list.

**Examples:**
```sql
-- Simple grouping
select department, count(*) as employee_count
from employees
group by department;

-- Multiple grouping expressions
select department, job_title, avg(salary) as avg_salary
from employees
group by department, job_title;

-- Grouping with expression
select 
  substr(email, instr(email, '@') + 1) as domain,
  count(*) as user_count
from users
group by domain;

-- Grouping with DATE function
select 
  strftime('%Y-%m', order_date) as month,
  sum(total) as monthly_sales
from orders
group by month
order by month;
```

### 3.4 HAVING Clause

The having clause filters groups based on a condition.

**Syntax:**
```sql
having condition
```

The condition is applied after grouping, allowing filtering on aggregate values. References to columns are restricted: only columns that appear in `group by` and aggregate expressions are valid; bare references to ungrouped columns raise an error. The same restriction applies to the implicit single group when the query has aggregates but no `group by`.

The restriction is about **this** query's own columns. A `having` written inside a subquery may name a column of an *enclosing* query, exactly as `where` may — `select w.b, (select count(*) from wg t group by t.a having t.a = w.a) from wg w` is legal, with and without a `group by` on the inner query. This is the same line [§3.3](#33-group-by-clause) draws for the general post-grouping restriction. The enclosing query keeps its own rule: if *it* is grouped and the correlated reference names one of *its* ungrouped columns, the query is still rejected — by the enclosing query's restriction, and so under the `Column '<name>' must appear in the GROUP BY clause` wording rather than the `having` message.

**Select-list aliases are visible here.** A grouped query's output columns can be named in `having` (and in a window specification of the same query) by their select-list alias — an aggregate's alias (`select a, count(*) as c … having c > 1`) and a grouping key's alias (`select a as k … having k = 'x'`) alike. This is SQLite-style permissiveness; strict SQL admits an alias only in the statement's top-level `order by`. Two consequences worth knowing:

- An alias **shadows** a same-named base-table column: under `select a as b … group by a`, a bare `b` in `having` is the grouping key `a`, not the table's own `b`.
- An alias is the **lowest-precedence** name there. It never outranks a grouping key's own name or an aggregate's alias, so `select a as b … group by a, b having b = '1'` filters on the grouping key `b`. The same holds for a grouping key's *qualified* name, which matters only for a quoted alias containing a dot: under `select wg.a as "wg.a" … group by wg.a`, `"wg.a"` in `having` is the grouping key, not the alias. Two aliases naming *different* grouping keys collide and make the shared name ambiguous.

The select list itself is **not** widened: a select-list column still cannot name a sibling column's alias (`select a as k, k as k2 … group by a` is an error), matching SQLite and PostgreSQL.

**Reusing a select-list aggregate.** An aggregate spelled out in `having` (or in a top-level `order by`, or in a window specification of the same query) reads the value the select list already computed when the two spellings denote the *same* aggregate; otherwise it is computed as an additional aggregate. Sameness is structural: column and table names compare case-insensitively (`sum(B)` is `sum(b)`), whitespace and redundant parentheses are ignored, and `distinct` participates — but every literal compares exactly, so `count(nullif(b, 'A'))` and `count(nullif(b, 'a'))` are two different aggregates. A qualifier is part of the spelling too: `sum(w.b)` and `sum(b)` do not match even when `w` is the only table in scope, so the `having` / `order by` form simply computes its own aggregate over the same column.

**Examples:**
```sql
-- Filter groups with HAVING
select department, count(*) as employee_count
from employees
group by department
having employee_count > 10;

-- HAVING with aggregate function
select product_id, sum(quantity) as total_sold
from order_items
group by product_id
having total_sold > 100
order by total_sold desc;

-- HAVING with multiple conditions
select category, avg(price) as avg_price
from products
group by category
having avg_price > 50 and count(*) >= 5;
```

### 3.5 ORDER BY Clause

The order by clause sorts the result set.

**Syntax:**
```sql
order by expression [asc | desc] [nulls first | nulls last]
       [, expression [asc | desc] [nulls first | nulls last] ...]
```

**Options:**
- `asc`: Ascending order (default)
- `desc`: Descending order
- `nulls first`: NULL values sort before non-NULL values
- `nulls last`: NULL values sort after non-NULL values
- Expression can be a column name, alias, expression, or a positive integer representing a position in the select list (1-based; out-of-range raises an error)
- A positional reference binds to the select list's Nth **output column**, not to the name of the expression that produced it — `order by 2` is exactly `order by <the second result column>`. A select-list alias cannot shadow it (`select b as a, a as z from t order by 2` sorts by `z`), two same-named columns under `*` cannot be confused (`select * from t1 join t2 … order by 4` sorts by whichever table owns output column 4), and a computed column is read from the output rather than recomputed — so an ordinal may point at a window function or an aggregate
- Aggregate functions are permitted when the query is itself an aggregate query (has aggregates in `select`/`having`, or has `group by`)
- Any expression legal in `group by` is also legal in `order by` of the same query and sorts by the grouped value — regardless of how, or whether, the select list projects it. This holds even when the select list contains no aggregate function at all
- The converse also holds: in a grouped query every `order by` term must be a grouping key (under any spelling that denotes it), an aggregate, a select-list alias, or an ordinal. A term naming an **ungrouped** column — directly (`select a from t group by a order by b`) or through a correlated subquery — is rejected with the same `must appear in the GROUP BY clause or be used in an aggregate function` error the select list raises. There is no "sort by an arbitrary row of the group" tolerance
- An aggregate query with **no** `group by` returns exactly one row, and its `order by` may name that row's own columns by select-list alias (`select count(*) as c from t order by c`). Sorting one row is a no-op, so this is about legality, not order
- In that same no-`group by` shape, an `order by` term that names *no* select-list alias and *no* aggregate sorts the **input** rows before aggregation instead. That is a Quereus extension: it gives an order-sensitive aggregate a deterministic input order, so `select group_concat(b) as gc from t order by a` concatenates in `a` order. An unqualified name that IS a select-list alias outranks a same-named source column (matching SQLite, and the grouped and non-aggregate paths), which turns the extension off for that term — `select group_concat(b) as a from t order by a desc` sorts the one output row rather than the input. Qualify the name (`order by t.a`) to keep the input sort

**Examples:**
```sql
-- Simple ordering
select * from products order by price;

-- Multiple sort keys
select * from employees
order by department asc, salary desc;

-- Ordering by expression
select name, price, quantity, price * quantity as total
from order_items
order by total desc;

-- Ordering with NULLS FIRST/LAST
select * from users
order by last_login desc nulls last;

-- Aggregate function in ORDER BY (legal with GROUP BY or other aggregates)
select grp, count(*) as cnt from t group by grp order by count(*) desc;

-- Aggregate referenced only in ORDER BY (not in SELECT)
select grp from t group by grp order by max(val) desc;

-- Grouping key in ORDER BY while the select list only projects an expression over it
select cast(grp as text) as g from t group by grp order by grp;
```

### 3.6 LIMIT and OFFSET Clauses

The limit and offset clauses restrict the number of rows returned.

**Syntax:**
```sql
limit count [offset skip]
-- or
limit skip, count
```

**Options:**
- `count`: Maximum number of rows to return
- `skip`: Number of rows to skip before returning rows

**Examples:**
```sql
-- Simple LIMIT
select * from products order by price limit 10;

-- LIMIT with OFFSET
select * from products order by price limit 10 offset 20;

-- Alternative syntax
select * from products order by price limit 20, 10;

-- Pagination example
select id, title, created_at
from posts
order by created_at desc
limit 20 offset (3 - 1) * 20; -- Page 3, 20 items per page
```

### 3.7 WITH Clause (Common Table Expressions)

The `WITH` clause allows you to define temporary named result sets called Common Table Expressions (CTEs) that can be referenced within the main query. CTEs are particularly useful for creating readable, modular queries and implementing recursive operations.

**Syntax:**
```sql
with [recursive] cte_name [(column1, column2, ...)] as (
    select_statement
) [, cte_name2 as (...)]
select ... from cte_name ...
```

**Options:**
- `recursive`: Enables recursive processing for the CTE
- `column_name_list`: Optional explicit column names for the CTE  
- `materialized` / `not materialized`: Hints for optimization - by default, results are cached if accessed more than once

**Visibility between CTEs:**

- Every CTE in a `WITH` clause can name the CTEs defined **before** it, whatever its own
  body is — `SELECT`, `VALUES`, or a data-modifying `INSERT` / `UPDATE` / `DELETE … RETURNING`.
  Only a `RECURSIVE` CTE may name itself; no CTE may name a later sibling.
- A CTE body may carry its own `WITH` clause. Its members can name the enclosing clause's
  earlier CTEs, and a name defined there **shadows** a same-named enclosing one for that
  body only.
- Reading a data-modifying CTE yields that CTE's `RETURNING` rows, and its write happens
  **once** per statement execution no matter how many times it is named — the reference is
  what drives the write, and the rows are then replayed from one buffer. See
  `docs/runtime-caching.md` § Shared CTE materialization.
- A CTE that instead reads the **base table** another CTE writes is a different case: it
  is not defined whether it observes that write. Do not rely on either answer; see the
  gap list in `docs/runtime-caching.md`.

**Where a data-modifying CTE may appear:**

A member whose body is an `INSERT` / `UPDATE` / `DELETE … RETURNING` is legal **only in a
statement's own leading `WITH` clause**. Anywhere else it is rejected at build time with
`WITH member '<name>' is data-modifying (INSERT), which is only allowed in a statement's
own leading WITH clause …`. Rejected positions include a `FROM` sub-query, a scalar / `EXISTS` / `IN`
sub-query, a `WITH` clause nested inside another CTE's body, a compound (`UNION`) arm's own
clause, and the body of a stored `CREATE VIEW`, `CREATE MATERIALIZED VIEW`,
`CREATE TABLE … MAINTAINED` or `CREATE ASSERTION` — whether or not anything references the
member. This matches PostgreSQL.

The reason is that only the leading clause has an owner for the write's
once-per-statement-execution guarantee. In the other positions the write is driven by
whatever happens to reference the member: nothing does, and the write silently disappears;
a stored view body re-evaluates, and the write re-runs on every read; a correlated
sub-query evaluates per outer row, and "once per statement" stops meaning anything. Move
the mutation to the statement that uses the query.

**Read-only** nested `WITH` clauses are unaffected — the rule applies to data-modifying
members only.

**Visibility inside the declaring statement:**

- A statement's own leading `WITH` clause is visible to **every clause of that statement**,
  not only to the relation it selects from. For `INSERT` that means the source `SELECT`,
  a scalar subquery inside a `VALUES` row, the `RETURNING` projections, the
  `ON CONFLICT … DO UPDATE` assignments and `WHERE`, and the `WITH CONTEXT` assignments;
  for `UPDATE` / `DELETE`, the `SET` / `WHERE` / `RETURNING` clauses. A view or
  materialized-view target is included — the write-through rewrite carries the same CTEs.
  (A *subquery* in `ON CONFLICT` or `WITH CONTEXT` currently resolves but does not yet
  execute — an unrelated planner gap, tracked separately.)
- A **schema-qualified** `FROM` name never binds a CTE. A CTE lives in no schema, so
  `main.c` can only mean the schema object `c`: `WITH c AS (…) SELECT … FROM c` reads the
  CTE while `… FROM main.c` reads the real table / view, and a qualified name with no
  matching schema object raises the ordinary table-not-found error rather than silently
  binding the CTE. The same rule applies to a qualified DML target (`UPDATE main.c`). This
  matches SQLite and PostgreSQL.
- **Schema-authored** expressions are deliberately excluded: a column `DEFAULT`, a
  generated-column expression, a `CHECK` constraint and a foreign-key existence check
  belong to the table's DDL rather than to the statement, so
  `DEFAULT (SELECT count(*) FROM c)` always binds the real `c` even when the inserting
  statement declares a CTE of that name — and binds it in the *table's own* schema, not
  the writer's (see [§2.1.1](#211-schema-search-path-with-schema)).

```sql
-- A writing CTE reading an earlier reading CTE
with a as (select id from staging),
     b as (insert into target select id, 1 from a returning id)
select count(*) as loaded from b;

-- A writing CTE reading an earlier WRITING CTE: `a` inserts once, `b` reads its RETURNING rows
with a as (insert into q values (300, 1) returning id),
     b as (insert into q select id + 1, 2 from a returning id)
select count(*) as n from b;
```

#### 3.7.1 Basic (Non-Recursive) CTEs

Basic CTEs create temporary named views that exist only for the duration of the query:

**Examples:**
```sql
-- Simple CTE for code organization
with active_users as (
  select id, name, email 
  from users 
  where status = 'active' and last_login > date('now', '-30 days')
)
select name, email 
from active_users 
where email like '%@company.com'
order by name;

-- Multiple CTEs
with 
  high_value_customers as (
    select customer_id, sum(total) as lifetime_value
    from orders
    group by customer_id
    having lifetime_value > 1000
  ),
  recent_orders as (
    select customer_id, order_id, total, order_date
    from orders
    where order_date > date('now', '-90 days')
  )
select c.name, hvc.lifetime_value, ro.total, ro.order_date
from high_value_customers hvc
join customers c on hvc.customer_id = c.id
join recent_orders ro on hvc.customer_id = ro.customer_id
order by hvc.lifetime_value desc;

-- CTE with explicit column names
with sales_summary(dept, total_sales, avg_sale) as (
  select department, sum(amount), avg(amount)
  from sales
  group by department
)
select * from sales_summary where avg_sale > 500;
```

#### 3.7.2 Recursive CTEs

Recursive CTEs enable hierarchical and iterative processing by allowing a CTE to reference itself. They follow the SQL:1999 standard semantics as defined in ISO/IEC 9075-2:2016, Section 7.14.

**Structure:**
A recursive CTE must have the form:
```sql
with recursive cte_name as (
  base_case_query          -- Initial/seed query (non-recursive)
  union [all]
  recursive_case_query     -- Query that references cte_name (recursive part)
)
```

#### 7.4.1 Auto-Deferred Row-Level CHECKs

Quereus automatically defers certain row-level CHECK constraints to COMMIT time to spare users from managing `DEFERRABLE`/`SET CONSTRAINTS`.

- Immediate: Constraints that only reference the current row (including `OLD`/`NEW` references) are validated during the DML statement.
- Auto-deferred: Constraints that reference other relations (e.g., contain subqueries) are validated at COMMIT using the same delta engine as global assertions. If any violation is found, COMMIT fails and the transaction is rolled back.
- Row references: an unqualified column names the row being written (`NEW` for INSERT/UPDATE, `OLD` for DELETE); `new.<col>` / `old.<col>` name a row image explicitly. A self-reference qualified by the owning table — `check (t.qty > 0)` on table `t` — resolves like the unqualified form, except where a subquery inside the CHECK rebinds the table name (there it resolves to the subquery's relation, per normal scoping).

Example:

```sql
create table inventory (
  loc text,
  sku text,
  qty integer check (qty >= 0),
  constraint enough_stock check (
    new.qty <= (select sum(s.qty) from inventory s where s.sku = new.sku)
  )
);
```

`qty >= 0` is checked immediately; `enough_stock` is auto-deferred and validated at COMMIT.

**Standard Semantics (ISO SQL-2016 §7.14):**
According to the SQL standard, recursive CTE evaluation follows this algorithm:

1. **W₀** := result of base_case_query
2. **R** := ∅ (empty result)
3. **repeat**:
    - **R** := **R** ∪ **W₀** (accumulate final result)
    - **W₁** := result of recursive_case_query applied to **W₀**
    - **W₀** := **W₁** ∖ **R** (working table = new rows only, for union)
    - **W₀** := **W₁** (working table = all new rows, for union all)
4. **until** **W₀** = ∅
5. **return** **R**

**Key Points:**
- The recursive term sees only the **working table** (rows from the previous iteration)
- It does **not** see the entire accumulated result
- This enables efficient **semi-naïve evaluation** with O(N) complexity instead of O(N²)

**Implementation in Quereus:**
Quereus implements the semi-naïve (delta) evaluation algorithm:
- Maintains separate `allRows` (accumulated result) and `delta` (previous iteration result) 
- Each iteration feeds only `delta` to the recursive term
- For `union`: deduplicates new rows against `allRows`
- For `union all`: appends all new rows directly
- Complexity is O(N) rather than the naive O(N²) approach

**Examples:**

```sql
-- Simple counter (classic recursive CTE example)
with recursive counter(n) as (
  select 1              -- Base case: start with 1
  union all
  select n + 1          -- Recursive case: increment by 1
  from counter 
  where n < 5           -- Termination condition
)
select n from counter order by n;
-- Result: 1, 2, 3, 4, 5

-- Hierarchical organization chart
with recursive org_chart(employee_id, name, manager_id, level, path) as (
  -- Base case: top-level managers (no manager)
  select id, name, manager_id, 0, name
  from employees 
  where manager_id is null
  
  union all
  
  -- Recursive case: find direct reports
  select e.id, e.name, e.manager_id, oc.level + 1, oc.path || ' -> ' || e.name
  from employees e
  join org_chart oc on e.manager_id = oc.employee_id
  where oc.level < 10  -- Prevent infinite recursion
)
select * from org_chart order by level, name;

-- Tree traversal with path tracking
with recursive tree_path(node_id, parent_id, path, depth) as (
  -- Base case: root nodes
  select id, parent_id, name, 0
  from nodes 
  where parent_id is null
  
  union all
  
  -- Recursive case: children
  select n.id, n.parent_id, tp.path || '/' || n.name, tp.depth + 1
  from nodes n
  join tree_path tp on n.parent_id = tp.node_id
  where tp.depth < 20  -- Maximum depth limit
)
select node_id, path, depth from tree_path order by path;

-- Graph traversal (finding all paths)
with recursive paths(start_node, end_node, path, visited) as (
  -- Base case: all edges as single-step paths
  select from_node, to_node, from_node || '->' || to_node, from_node || ',' || to_node
  from edges
  
  union
  
  -- Recursive case: extend paths
  select p.start_node, e.to_node, p.path || '->' || e.to_node, p.visited || ',' || e.to_node
  from paths p
  join edges e on p.end_node = e.from_node
  where p.visited not like '%,' || e.to_node || ',%'  -- Avoid cycles
    and length(p.path) < 100  -- Prevent runaway recursion
)
select distinct start_node, end_node, path 
from paths 
order by start_node, end_node, length(path);
```

#### 3.7.3 Optimization and Performance

**Materialization Hints:**
While parsed, materialization hints are not currently enforced but may influence future optimizations:
```sql
with recursive 
  large_cte as materialized (select ...),
  small_cte as not materialized (select ...)
select ...
```

**Recursion Limits:**
Use the `option` clause to control maximum recursion depth:
```sql
with recursive counter(n) as (
  select 1
  union all
  select n + 1 from counter where n < 1000000
)
option (maxrecursion 10000)  -- Limit to 10,000 iterations
select count(*) from counter;
```

A `limit`/`offset` written on the outer compound is also honored as an early-termination bound on the entire recursive output, applied after deduplication for `union`. Iteration stops as soon as the consumer has been served `limit` rows, so it can be used to cap an otherwise unbounded recursion:
```sql
with recursive counter(n) as (
  select 1
  union all
  select n + 1 from counter
  limit 5
)
select n from counter;  -- 1, 2, 3, 4, 5
```

**Performance Characteristics:**
- **Non-recursive CTEs**: Executed once, results may be cached
- **Recursive CTEs**: Semi-naïve evaluation with O(N) complexity
- **Memory usage**: Working table and result set kept in memory
- **Deduplication**: For `union`, uses B-Tree with proper SQL value comparison

#### 3.7.4 Common Patterns and Best Practices

**Hierarchical Data:**
```sql
-- Employee reporting hierarchy
with recursive reporting_chain as (
  select employee_id, manager_id, 1 as level
  from employees where employee_id = ?  -- Specific employee
  
  union all
  
  select e.employee_id, e.manager_id, rc.level + 1
  from employees e
  join reporting_chain rc on e.employee_id = rc.manager_id
)
select * from reporting_chain;
```

**Series Generation:**
```sql
-- Generate date series
with recursive date_series(dt) as (
  select date('2024-01-01')  -- Start date
  
  union all
  
  select date(dt, '+1 day')
  from date_series
  where dt < '2024-12-31'    -- End date
)
select dt, strftime('%w', dt) as day_of_week from date_series;
```

**Tree Operations:**
```sql
-- Calculate subtree sizes
with recursive subtree_sizes(node_id, size) as (
  -- Leaf nodes
  select id, 1 from nodes where id not in (select distinct parent_id from nodes where parent_id is not null)
  
  union all
  
  -- Internal nodes
  select n.id, 1 + sum(ss.size)
  from nodes n
  join subtree_sizes ss on n.id = ss.parent_id
  group by n.id
)
select node_id, size from subtree_sizes;
```

**Safety Considerations:**
- Always include termination conditions to prevent infinite recursion
- Use depth/iteration limits as safeguards
- Consider cycle detection for graph traversal
- Monitor memory usage for large result sets

## 4. Expressions and Operators

### 4.1 Literals

**Numeric Literals:**
- Integers: `123`, `-456`
- Floating-point: `123.45`, `-67.89`, `1.23e4`
- Boolean: Represented as integers: `0` (false), `1` (true)

**String Literals:**
- Single-quoted: `'Text value'`
- Double-quoted identifiers: `"Column name with spaces"`

**Blob Literals:**
- Hex format: `x'53514C697465'` (SQLite)

**NULL:**
- Represents missing or unknown value: `null`

**Examples:**
```sql
select 42 as answer;
select 'Hello, world!' as greeting;
select x'DEADBEEF' as binary_data;
select null as no_value;
```

### 4.2 Operators

**Arithmetic Operators:**
- Addition: `+`
- Subtraction: `-`
- Multiplication: `*`
- Division: `/`
- Modulo (remainder): `%`

**Comparison Operators:**
- Equal: `=` or `==`
- Not equal: `!=` or `<>`
- Less than: `<`
- Greater than: `>`
- Less than or equal: `<=`
- Greater than or equal: `>=`

**Logical Operators:**
- AND: `and`
- OR: `or`
- XOR: `xor`
- NOT: `not`

**Bitwise Operators:**
- NOT: `~` — `~x` is `-x - 1` over the whole integer domain, not a fixed-width
  complement: `~3000000000` is `-3000000001` and `~9223372036854775807` is
  `-9223372036854775808`, both exact. A REAL operand truncates toward zero first, and the
  result takes its canonical form ([types.md § Physical
  representation](types.md#physical-representation)).
- `&`, `|`, `<<` and `>>` are **not implemented** — the parser rejects them.

**String Operators:**
- Concatenation: `||` — NULL if either operand is NULL; a non-text operand is
  rendered through the one value-to-text conversion
  ([types.md § Value to text](types.md#value-to-text)), so `b || ''` and
  `cast(b as text)` always agree. `like` coerces its operands the same way.

**JSON Path Operators:**
- `->`: Extract JSON value at path, returns JSON (syntactic sugar for `json_extract()`)
- `->>`: Extract JSON value at path, returns scalar TEXT (syntactic sugar for `cast(json_extract() as text)`)

Path shorthand: `expr -> 'name'` is equivalent to `expr -> '$.name'`; `expr -> 0` is equivalent to `expr -> '$[0]'`.

**IS Predicates (postfix boolean tests):**

These are postfix unary predicates on the left operand. They are **total** — they
never return NULL, even when the operand is NULL — so they route truthiness
through the engine's `isTruthy` (numeric-string coercion: `'abc'`, `'0'`, blobs ⇒
false), matching the `where` / `NOT` / logical-operator path.

- `expr is null` / `expr is not null`: NULL test
- `expr is true` / `expr is not true`: boolean test against truthiness
- `expr is false` / `expr is not false`: boolean test against falsiness

| operator       | operand NULL | operand non-NULL |
|----------------|--------------|------------------|
| `is true`      | `false`      | `isTruthy(v)`    |
| `is not true`  | `true`       | `not isTruthy(v)`|
| `is false`     | `false`      | `not isTruthy(v)`|
| `is not false` | `true`       | `isTruthy(v)`    |

The general binary form `a is b` (identity comparison of two expressions) is **not
supported** — only the postfix predicates above are recognized.

**Other Operators:**
- `in`: Tests if a value is in a set
- `not in`: Tests if a value is not in a set
- `like`: Pattern matching with wildcards
- `glob`: Pattern matching with Unix wildcards
- `between`: Tests if a value is within a range
- `exists`: Tests if a subquery returns any rows
- `case`: Conditional expression

**Examples:**
```sql
-- Arithmetic
select price, quantity, price * quantity as total from order_items;

-- String concatenation
select first_name || ' ' || last_name as full_name from users;

-- Comparison
select * from products where price > 100;

-- Logical operators
select * from employees
where (department = 'Sales' or department = 'Marketing')
and salary > 50000;

-- JSON path operators
select data -> 'name' from users;                -- extract as JSON
select data ->> 'age' from users;                -- extract as TEXT
select data -> 'address' -> 'city' from users;   -- chained access
select data -> 0 from json_array_col;            -- array index shorthand

-- IS NULL / IS NOT NULL
select * from users where profile_picture is null;

-- IN operator
select * from products
where category in ('Electronics', 'Computers', 'Accessories');

-- IN with subquery
select * from employees
where department_id in (
  select id from departments where location = 'Headquarters'
);

-- IN with value list (optimized with BTree for fast lookups)
select * from orders 
where status in ('pending', 'processing', 'shipped', 'delivered');

-- BETWEEN
select * from orders
where order_date between date('2023-01-01') and date('2023-12-31');

-- NOT BETWEEN  
select * from products
where price not between 10.00 and 100.00;

-- LIKE pattern matching
select * from users where email like '%@gmail.com';

-- CASE expression
select
  id,
  name,
  price,
  case
    when price < 10 then 'Budget'
    when price < 50 then 'Regular'
    when price < 100 then 'Premium'
    else 'Luxury'
  end as price_category
from products;

-- EXISTS
select * from customers as c
where exists (
  select 1 from orders as o
  where o.customer_id = c.id and o.total > 1000
);

-- NOT EXISTS  
select * from customers as c
where not exists (
  select 1 from orders as o
  where o.customer_id = c.id
);

-- NOT IN with value list
select * from products
where category not in ('Discontinued', 'Seasonal', 'Clearance');

-- NOT IN with subquery
select * from employees
where department_id not in (
  select id from departments where location = 'Remote'
);
```

### 4.3 Functions and Subexpressions

**Function Calls:**
```sql
function_name(argument1, argument2, ...)
```

**Subexpressions:**
```sql
(expression)
```

**Subqueries:**
- Scalar subquery: Returns a single value
- Row subquery: Returns a single row
- Table subquery: Returns a table result
- EXISTS subquery: Returns a boolean

**Examples:**
```sql
-- Scalar functions
select abs(-42), round(3.14159, 2), upper('hello');

-- Subexpressions for grouping
select (price + tax) * quantity as total from order_items;

-- Scalar subquery
select name, (select count(*) from orders where customer_id = c.id) as order_count
from customers as c;

-- Subquery with comparison
select * from products
where price > (select avg(price) from products);

-- Correlated subquery
select * from orders as o
where total > (
  select avg(total) from orders
  where customer_id = o.customer_id
);
```

### 4.4 Special Value Expressions

**COLLATE Expression:**
```sql
expr collate collation_name
```

In a comparison, the effective collation is resolved **symmetrically** from both operands by
provenance rank: an explicit `COLLATE` wrapper outranks a column's declared `COLLATE` clause,
which outranks a defaulted collation; with no contribution from either side the comparison is
`BINARY`. Two operands contributing *different* collations at the same explicit/declared rank
are a prepare-time error (apply an explicit `COLLATE` to disambiguate); conflicting defaults
resolve to `BINARY` silently. See `docs/types.md` § Comparison collation resolution.
`BETWEEN` is evaluated as two independent comparisons (`expr >= lower AND expr <= upper`), so a
`COLLATE` on a **bound** governs only *that bound's* comparison — it does not propagate to the
whole expression. For example `x BETWEEN 'a' COLLATE NOCASE AND 'z'` compares `x >= 'a'` under
`NOCASE` but `x <= 'z'` under the default collation; to collate both sides, put the `COLLATE` on
the tested expression (`x COLLATE NOCASE BETWEEN 'a' AND 'z'`).

**Custom collations are per-connection.** `BINARY`, `NOCASE`, and `RTRIM` are always available.
Any other collation must be registered with `db.registerCollation(name, comparator)` on **every**
`Database` that opens a table, index, or query naming it — and before that table is queried.
Naming an unregistered collation raises `no such collation sequence: <name>` rather than silently
comparing by byte order, matching SQLite. For a persisted database whose DDL carries a custom
`COLLATE`, register the collation immediately after opening the connection. `NOCASE` and `RTRIM`
may be replaced by re-registering them; `BINARY` may not — the engine resolves it directly, so
`registerCollation('BINARY', ...)` is rejected rather than partially honored. A memory table's
primary key, secondary indexes, range seeks, and `UNIQUE` enforcement all resolve their declared
collation names against the connection that owns the table, so a replaced `NOCASE` changes how
that table's keys sort and which values collide. The same now holds for the persistent
key-value store tables (`@quereus/store`) and the transaction-isolation overlay
(`@quereus/isolation`): pushed-constraint re-checks, `UNIQUE` conflict detection, and the
overlay/underlying merge comparator all resolve through the owning connection. So do
materialized-view maintenance (backing-key identity, `UNIQUE` self-conflict resolution through a
covering view, coarsening-collision telemetry) and the optimizer's contradiction check — the
latter declines to prove a predicate unsatisfiable at all when it cannot resolve a column's
collation, rather than assuming byte order and dropping rows.

**Grouping and hash keys.** `GROUP BY`, window `PARTITION BY`, the hash-join Bloom filter,
`AS OF` partitioning, and the isolation layer's set of primary keys staged by the open
transaction group rows by a normalized *string* form of each key value rather than by
running the comparator. They resolve that normalizer against the connection's collation registry
(`db.getKeyNormalizerResolver()`), so grouping, `where`, `order by`, and `distinct` all agree on
which rows are equal — including under a custom or replaced collation. A collation registered
**without** a `normalizer` can order rows but cannot bucket them: naming it as a grouping,
partition, or hash-join key over a **text** key raises `collation <name> has no key normalizer`
rather than silently grouping by bytes. Supply `{ normalizer }` to `registerCollation` for any
collation you intend to group by. A key whose declared type can never hold text (`n integer
collate mycoll`) buckets by value under any collation, so it needs no normalizer and does not
raise.

**Physical key bytes.** The store encodes each text key into a byte string by running the value
through the collation's key normalizer, resolved against the same connection registry
(`db.getKeyNormalizerResolver()`). So a custom (or overridden) collation governs the
physical key layout as well as comparison, and a primary-key `UNIQUE` check that goes through the
key sees exactly the collisions the comparator does. A collation with no normalizer cannot key a
persisted structure: naming it on a store table's text `PRIMARY KEY` column — or as the table key
collation `K` (`using store(collation = '…')`) on a table that encodes text under it — is rejected
at `CREATE TABLE`.

Those key bytes are only *sort*-preserving when the normalizer preserves order, which
`registerCollation` does not require — it promises only that a normalizer partitions strings the
way the comparator calls them equal. A collation asserts the stronger property with
`{ orderPreserving: true }`; without it the store declines the optimizations that equate byte
order with collation order (range seeks, elided sorts) and full-scans instead. Results are
identical either way. See [store.md § Order preservation](./store.md#order-preservation).

A **column**'s `COLLATE` clause is presently restricted to the collations its logical type
declares support for — `BINARY`/`NOCASE`/`RTRIM` for TEXT — so a custom collation cannot yet be
declared on a column, only on an index column (`create index … (v collate REVERSE)`) or in a
query. Types that declare no supported list (INTEGER, REAL, BLOB) accept any name at DDL and fail
later, when a comparator is built.

**CAST Expression:**
```sql
cast(expr as type)
```

**Parameter References:**
- Positional: `?`, `?1`, `?2`, ...
- Named: `:name`, `@name`, `$name`

**Examples:**
```sql
-- COLLATE
select * from customers
order by name collate nocase;

-- CAST
select cast(price as integer) as rounded_price
from products;

-- Parameters
-- (usually used in prepared statements)
select * from users where id = ? and status = ?;
select * from products where category = :category and price <= :max_price;
```
