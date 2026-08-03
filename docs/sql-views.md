# SQL Views & Materialized Views

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 2.8 CREATE VIEW Statement

A view is a named query. Selecting from it re-evaluates the body on every reference (a view is not cached — see [Materialized Views](#210-create-materialized-view-statement) for the stored, kept-consistent variant).

**Syntax:**
```sql
create view [if not exists] view_name [(column[, ...])]
  as query_expr [with defaults (column = expr [, ...])]
[with tags (key = value [, ...])]

drop view [if exists] view_name;
```

- `query_expr` is any relation-producing expression — a `select`, a `values (...)`, or a `with … select`. A **DML body** (`insert`/`update`/`delete … returning`) is **rejected at create time**: a view re-evaluates per reference, so a write-per-read body is incoherent.
- **Home-schema resolution:** the body's unqualified names resolve against the *view's own schema* first, then the session default path — independent of the reader's schema path (a statement-level `with schema` never leaks into the body). A view in a non-`main` schema that reads its sibling tables unqualified works under any session path. The same isolation covers the common-table-expression namespace: a caller's `with` clause never shadows a name the body reads, and the body sees only its own `with` clause (if it has one) plus its home-schema objects Both isolations have one exception, on writes only: a subquery inside a body expression the write-through lowering copies into the base statement still resolves on the caller's path and against the caller's CTEs (see [View Updateability](view-updateability.md#schema-resolution-during-write-through)).
- **Referencing a view unqualified:** the view *name* — in a `from` clause or as an `insert` / `update` / `delete` target — resolves through the reader's schema search path exactly as a table name does, so a view in a non-`main` schema needs that schema on the path (or a qualifier). See [§2.1.1 Schema Search Path](sql-select.md#211-schema-search-path-with-schema).
- An optional column list renames the body's output columns (arity must match).
- `with defaults (col = expr, ...)` is a trailing clause of the **core select** (it binds to the whole query expression after `limit`/`offset`, before `with tags`): it declares per-column **omitted-insert defaults** for write-through — typically for a base column the view projects away (see [§2.9](#29-updatable-views)). Column names must be distinct; each `expr` must be self-contained (it cannot reference the inserted row's columns); the target is resolved (and a typo rejected) at write time, not at create — the base-column lineage it resolves against is only assembled when the view is an actual write target.
- `with tags (...)` attaches metadata (informational only — reserved `quereus.*` keys are validated, but none carries view behavior; see [§2.9](#29-updatable-views)).
- `drop view` is **refused** while an assertion's stored CHECK body still names the view (`if exists` does not weaken that — it governs absence, not dependency); drop or redefine the assertion first. See [sql-ddl.md § 2.6.1](sql-ddl.md#261-createdrop-assertion-global-integrity-constraints).

**Examples:**
```sql
create view ActiveUsers as select * from Users where active = 1;
create view UserNames(uid, label) as select id, name from Users;
create view NewUsers(uid, label) as select id, name from Users
  with defaults (created = epoch_ms('now'));
drop view if exists ActiveUsers;
```

## 2.9 Updatable Views

Views, non-recursive CTEs, and subqueries in `from` are **uniformly mutable**: `insert` / `update` / `delete` against them is rewritten to operate on the underlying base table(s), reusing all constraint / conflict / foreign-key machinery. A relation is updatable iff a deterministic decomposition exists at plan time; otherwise the mutation surfaces a structured diagnostic naming the operator or column that obstructed it. There is **no** `with check option` and **no** `instead of` trigger surface — write-through is predicate-driven, not declared per view.

Reads and writes through a view report the *base* table(s) to `getChangeScope()` and `Database.watch` (see [Usage Guide](usage.md)).

**What is writable (single-source projection-and-filter view):**

- A **passthrough or renamed** column (`c`, `c as alias`) routes the value straight to its base column — writable on both `insert` and `update`.
- An **invertible-expression** column (`v + 1 as w`) is writable on `update` (the assignment is lowered through the inverse: `set w = 9` ⇒ `set v = 8`). It is **not** insertable.
- A **computed / non-invertible** column (`lower(name)`, a window or aggregate output) is **read-only**; writing it raises the `no-inverse` diagnostic — *unless* the result column carries an **authored inverse**: `expr as col with inverse (base_col = expr-over-NEW, ...)` upgrades the column to writable on both `update` and `insert` (each assignment computes a base column from the written view row, referenced via the mandatory `new.` qualifier). Targets must be base columns of the FROM sources; `new.*` references must be output columns of the select — both validated at build time wherever the clause appears. See [vu-inverses.md § Authored inverses](vu-inverses.md#authored-inverses-with-inverse).
- A column **omitted** from an `insert` but pinned by an equality predicate is supplied automatically: `create view GreenMen as select * from Men where color = 'green'` lets `insert into GreenMen (name) values ('Bob')` default `color` to `'green'`. A view-declared `with defaults (col = expr, ...)` entry fills a still-omitted column next (ahead of the base column's declared `default` — the dominant use is a base column the view projects away); base-column `default`s fill the rest; a `not null` column with no available value is rejected.
- A top-level reference in `where` / `set` / `returning` must name a **view** column — a base column the view projects away does not silently resolve (`unknown-view-column`).

```sql
create view GreenMen as select id, name, color from Men where color = 'green';
insert into GreenMen (id, name) values (7, 'Bob');   -- color defaults to 'green'
update GreenMen set name = 'Bobby' where id = 7;      -- routes to Men
delete from GreenMen where id = 7;                    -- routes to Men
```

**Multi-source (key-preserving inner-join) views** support `update` / `delete` and two-table `insert` write-through: each output column routes to its owning base table, FK-parent before FK-child. Outer joins, set-operations, aggregates, self-joins, `> 2`-table and composite-key joins are rejected with a diagnostic.

**`returning`** through a view projects rows through the *view's* column list, evaluated against post-mutation state (single-source all ops; multi-source `update` / `delete`).

**Insert defaults — and no override tags.** A view declares omitted-insert defaults first-class via the body select's trailing `with defaults (col = expr, ...)` clause ([§2.8](#28-create-view-statement)); the expression is evaluated per omitted-insert row, ahead of the base column's declared `default`. Write *routing* is not a tag — it is expressed by predicates and per-row writable **presence/membership columns** (the outer-join existence column, the set-op membership columns). To realize a non-default deletion side (e.g. delete the FK-parent), expose the side as an outer-join existence column and write it: `update v set hasP = false where ...`.

The entire `quereus.update.*` tag namespace is retired: the routing keys (`target` / `exclude` / `delete_via` / `policy`) and the `default_for.<col>` insert-default override (both its view-DDL and statement-level sites; superseded by the `with defaults` clause — a per-statement default is expressed as an explicit insert value) are now an `unknown-reserved-tag` error at any site. See [View Updateability](view-updateability.md) for the full per-operator semantics and the complete diagnostic catalog.

## 2.10 CREATE MATERIALIZED VIEW Statement

A materialized view stores its body in a keyed backing relation kept consistent with its sources **synchronously, inside the writing transaction** (row-time maintenance). It is observably indistinguishable from the plain view it derives from — reads-own-writes hold, a rollback reverts source and backing together — only served from stored rows. There is one maintenance model and **no refresh-policy knob**.

**Syntax:**
```sql
create materialized view [if not exists] view_name [(column[, ...])]
  [using module_name [(module_args...)]]
  as query_expr [with defaults (column = expr [, ...])]
[with tags (key = value [, ...])]

refresh materialized view view_name;
drop materialized view [if exists] view_name;
```

The `create materialized view` form is normalization sugar for the declared-shape **table form** — `create table name (columns...) [using module(...)] maintained [(columns)] as query_expr [with defaults (...)] [with tags (...)]` — where the table layout is authored and the body must derive exactly that shape (the optional `maintained (columns)` rename list is the lossless persistence encoding of a sugar MV's explicit renames; its absence marks an implicit body that reshapes to follow its source). The `with defaults (...)` clause rides the body `query_expr` (the core select), not the DDL statement. The table form is also the canonical persistence/export rendering for every maintained table; `refresh materialized view` and `drop materialized view` work on any maintained table regardless of authoring form. See [materialized-views.md § DDL statements](materialized-views.md#ddl-statements) and the `SET MAINTAINED` / `DROP MAINTAINED` lifecycle verbs in [§2.7](sql-alter.md#27-alter-table-statement).

- The body is evaluated and stored at create; create is all-or-nothing.
- `refresh` is **not required for currency** (row-time maintenance keeps it live); it is an explicit resync verb, useful after a source *schema* change marks the view `stale`.
- `using module(...)` places the maintained table in the named [backing-host](mv-backing-host.md#backing-host-capability) module; omitted ⇒ the in-memory default. An unknown module or one without the capability is rejected at build time.
- the body select's trailing `with defaults (col = expr, ...)` clause carries the same omitted-insert-default semantics as on a plain view ([§2.8](#28-create-view-statement)) — the default is supplied on the rewritten *source* insert and is transparent to row-time backing maintenance.
- `drop table` / `drop view` reject a materialized-view name and redirect to `drop materialized view` (and vice-versa).

**Eligibility (enforced at create).** Row-time maintenance is only affordable for bodies whose per-write delta is bounded, so the accepted shape is narrow. Eligible bodies:

- a **single source** with a projection (+ optional `where` / `order by`) that includes every PK column as a passthrough — the covering-index shape;
- a **single-source aggregate** (`group by` over bare source columns);
- a **single-source lateral table-valued-function** fan-out;
- a **1:1 row-preserving inner/cross join**.

Any other body (general joins, set-operations, recursion, `distinct`, `limit`/`offset`, non-deterministic projections) is **rejected at create** with a diagnostic that steers you to a plain `view` (live re-evaluation) or `create table … as <body>` (one-off snapshot).

**Write-through.** `insert` / `update` / `delete` against a materialized-view name is rewritten to its source table (via the same [updatable-view](#29-updatable-views) machinery) and the row-time hook syncs the backing within the statement. Per-column writeability is inherited verbatim (passthrough writable, computed read-only).

**Covering structures.** A materialized view that projects a UNIQUE constraint's columns (plus the source PK), ordered by those columns, can *cover* that constraint — its backing table then answers `insert or replace` / `or ignore` / conflict detection at O(log n), row-time. This is the substrate the [lens](#211-logical-schemas-and-lenses) layer's set-level enforcement builds on.

**Declarative schema.** A `materialized view` item is accepted inside `declare schema { … }`; a definition change — body, explicit column list, or `with defaults` clause (the body string carries it, so `bodyHash` over the canonical definition detects it) — schedules a drop-and-recreate.

```sql
create materialized view mv as select id, x from t order by x;
refresh materialized view mv;
drop materialized view if exists mv;
```

See [Materialized Views](materialized-views.md) for the maintenance arms, the eligibility detail, and the covering-structure / enforcement model.

## 2.11 Logical Schemas and Lenses

A **logical schema** is an embodiment-free design — tables, types, and logical constraints with no module, indexes, or storage hints. A **lens** maps each logical table onto a **basis** (module-backed) schema as a bidirectional view, built on the updatable-view machinery: `get` is an ordinary `select`, `put` is the predicate-driven propagation. At deploy the lens compiles to an inline view, so the query processor sees an ordinary view over basis.

**Syntax:**
```sql
declare logical schema schema_name { table_item* assertion_item* ... }

declare lens for logical_schema over basis_schema {
  view logical_table as select_expr;
  ...
}

apply schema logical_schema;   -- compiles + deploys the lens-backed views
```

- A `logical` schema rejects `using module(...)`, indexes, and physical storage constructs at build time; tags are allowed (engine-facing metadata).
- A `declare lens` block supplies **sparse overrides** — only the deviations (rename, compute, filter). Columns an override does not cover are gap-filled by the default name-based mapper; every logical column must end up mapped to basis (an uncovered column the basis cannot back is a compile error).
- A lens override body must be a single `select` whose `from` sources live in the declared basis (compound set-operations and cross-basis re-anchoring are rejected).
- The logical spec's constraints are **attached** at the lens boundary and enforced per class — row-local (`not null`, `check`) and foreign keys (child- and parent-side, incl. cascade actions) are live; `unique` / primary keys enforce row-time when a basis covering materialized view answers the key, else commit-time detection.

**Inspect the effective mapping:**
```sql
select * from quereus_effective_lens('LogicalSchema', 'TableName');
```

The lens layer is the most recently landed of these features and is evolving (n-way decomposition, module mapping advertisements, and access-shape routing are partially shipped). See [Lenses and Layered Schemas](lens.md) for the full model, the prover, and the constraint-attachment classes.
