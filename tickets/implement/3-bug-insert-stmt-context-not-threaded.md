---
description: An INSERT statement that declares a named temporary result set up front, or that says which schema to look names up in, only applies that to the rows being inserted — the clause that reports what was inserted, the conflict-handling clause, and several other parts still fail with "not found".
files:
  - packages/quereus/src/planner/building/insert.ts          # buildInsertStmt — the single site; see line refs below
  - packages/quereus/src/planner/building/update.ts          # ~72 — the correct shape to copy
  - packages/quereus/src/planner/building/delete.ts          # ~71 — same
  - packages/quereus/src/planner/building/select-context.ts  # buildWithContext
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic
difficulty: medium
repro: verified
---

# `buildInsertStmt` never threads its statement-level context into most of the statement

## Root cause — one site

`buildInsertStmt` (`packages/quereus/src/planner/building/insert.ts`) is the only DML
builder that does **not** derive one statement-level planning context and use it
throughout. It instead:

1. builds the leading `with` clause by hand into a local `parentCtes` map
   (line ~672), which it hands to exactly **one** consumer — the `select`-source
   branch (line ~695) — and never puts on the planning context; and
2. builds the `returning` projections and the `on conflict` clause plans against the
   **bare `ctx`** (lines ~839, ~877, ~896 and ~813) rather than against
   `contextWithSchemaPath`, so those two clauses lose the statement's `with schema`
   path as well.

`buildUpdateStmt` / `buildDeleteStmt` both call `buildWithContext` once near the top and
thread the resulting `contextWithCTEs` (and the scope derived from it) through every
user-authored clause including `returning`. Insert does not, so every insert clause other
than a `select` source is missing both the statement's common table expressions and its
`with schema` path.

## Arms — all verified against a built tree at `fd7d1521`

Setup for the common-table-expression cases:

```sql
create table p (id integer primary key, v text);
create table q (id integer primary key, w text);
insert into p values (1,'a'),(2,'b');
```

### Arm A — a leading `with` clause reaches only the `select` source

Everything below errors `Table 'c' not found in schema path: main`; the matching
`update` / `delete` shapes all succeed.

```sql
-- returning
with c as (select id, v from p) insert into q values (5,'e')
  returning id, (select count(*) from c) as n;

-- values row expression
with c as (select id from p) insert into q values (5, (select count(*) from c));

-- on conflict ... do update set
with c as (select id from p) insert into q values (1,'x')
  on conflict (id) do update set w = (select count(*) from c);

-- on conflict ... where
with c as (select id from p) insert into q values (1,'x')
  on conflict (id) do update set w='y' where (select count(*) from c) > 0;

-- with context assignment
with c as (select id from p) insert into mc with context who = (select count(*) from c)
  values (1,'x');

-- view target (both the source and the returning clause)
create view vq as select id, w from q;
with c as (select id, v from p) insert into vq select id, v from c;

-- materialized-view target
with c as (select id, v from p) insert into mvq select id, v from c;
```

Working today (do not regress): `with c as (…) insert into q select id, v from c` —
the one branch that gets `parentCtes`.

### Arm B — an insert's own `with` clause hides the ones it inherited

Because `parentCtes` starts empty and is filled from `stmt.withClause` alone, and
`buildWithContext` prefers a non-empty explicit argument over `ctx.cteNodes`, an insert
that carries its own `with` clause loses every definition it inherited from an enclosing
statement:

```sql
with a as (select id from p),
     b as (with c as (select 1 as k) insert into q select id + 40, 1 from a returning id)
select count(*) as n from b;
-- QuereusError: Table 'a' not found in schema path: main
```

Dropping the inner `with c as (select 1 as k)` makes it pass. The `update` analogue
passes with the inner clause present.

### Arm C — `with schema` does not reach `returning` or `on conflict`

Same site, same cause: those two clauses build on bare `ctx`. Setup:

```sql
declare schema s1 { table p { id integer primary key, v text }
                    table q { id integer primary key, w text } }
apply schema s1;
insert into s1.p values (1,'a'),(2,'b');
```

```sql
insert into q values (5,'e') with schema s1 returning id, (select count(*) from p) as n;
-- Table 'p' not found in schema path: main

insert into q values (1,'x') on conflict (id) do update set w = (select count(*) from p)
  with schema s1 returning w;
-- Table 'p' not found in schema path: main
```

`update q set w='k' with schema s1 returning id, (select count(*) from p) as n` and the
`delete` equivalent both succeed. `insert into q values (6, (select count(*) from p))
with schema s1` also succeeds — the `values` branch already gets
`contextWithSchemaPath`, which is why Arm C is narrower than Arm A.

## Shape of the fix

Mirror `buildUpdateStmt`. Call `buildWithContext(contextWithSchemaPath, stmt)` once,
above the CTE-name-target dispatch, and use the resulting `contextWithCTEs` for every
**user-authored** clause. Because `buildWithContext` seeds its map from `ctx.cteNodes`
and merges `stmt.withClause` on top, an own-clause name still shadows an inherited one —
which closes Arm B without extra work.

Then delete the hand-rolled `parentCtes` map and pass `contextWithCTEs` to
`buildSelectStmt` **without** the explicit third `parentCTEs` argument. Routing the
definitions through the context rather than the explicit argument is the safer of the
two: `select-context.ts` line ~126 documents that the explicit argument is precisely
what leaks a caller's namespace past `storedBodyContext`'s clearing on the stored-body
write-through path.

**Do not** thread the CTE context into the schema-authored expression builds —
`createRowExpansionProjection` (column defaults, generated columns) and
`buildConstraintChecks` / `buildNotNullDefaults` / `buildChildSideFKChecks`. A `default
(select … from c)` written in the table's DDL should not suddenly bind a caller's
statement-level `c`. Leave those on `contextWithSchemaPath` / `ctx` exactly as they are
today. (`buildUpdateStmt` does pass its CTE-aware `updateCtx` to `buildConstraintChecks`;
that asymmetry is pre-existing and out of scope here — don't "fix" it in this ticket, and
don't copy it either.)

For `returning` and the upsert clause plans, the scopes are currently parented on
`ctx.scope`; parent them on `contextWithCTEs.scope` and build the expressions with
`{ ...contextWithCTEs, scope: <thatScope> }`. That closes Arm A's returning/upsert cases
and Arm C together.

### Watch item while implementing

Hoisting `buildWithContext` above the view / materialized-view dispatch means the
`with` clause is now built *before* `buildViewMutation` re-plans the statement through
this same builder — and the re-plan builds `stmt.withClause` a second time
(`buildWithClause` does not memoize). One of the two node sets ends up unreferenced, so
this should be wasted planning work rather than a behavior change — but a common table
expression whose body is itself a DML statement must still execute exactly once. Verify
against `packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic` **and** add a case
of that shape with a view target, e.g.

```sql
with d as (insert into log values (1,'x') returning id)
insert into vq select id, 'z' from d;
```

`buildUpdateStmt` already has this same hoist-then-`buildViewMutation` ordering, so the
precedent exists; confirm rather than assume.

## Notes

The prerequisite named on the fix ticket (`bug-dml-cte-body-cannot-see-sibling-cte`) has
landed — it is in `tickets/complete/`. Arm B is only *observable* because of it.

Reproduction was done with a small script against the built package
(`packages/quereus/dist/src/index.js`) rather than the test harness; the SQL above is
copy-pasteable into `.sqllogic` form directly.

## TODO

### Phase 1 — fix

- Hoist a single `buildWithContext(contextWithSchemaPath, stmt)` call to just above the
  CTE-name-target dispatch in `buildInsertStmt`; keep the existing
  `contextForCteTarget(...)` narrowing for that branch (it already consumes the same
  context, just built inline today).
- Delete the hand-rolled `parentCtes` map (line ~672) and its `buildWithClause` import if
  it becomes unused.
- Thread `contextWithCTEs` into: `resolveCteTarget`, both `buildViewMutation` calls (view
  / MV target and the maintained-table backstop), `buildTableReference`, the
  `stmt.contextValues` build, `buildValuesStmt`, `buildSelectStmt` (dropping the explicit
  `parentCTEs` argument), and the three nested-DML source branches
  (`insert` / `update` / `delete`).
- Leave `createRowExpansionProjection`, `buildConstraintChecks`, `buildNotNullDefaults`
  and `buildChildSideFKChecks` on their current contexts.
- Parent the `returning` scope and the upsert scope on `contextWithCTEs.scope`, and build
  their expressions against `contextWithCTEs` instead of `ctx` — this is what closes
  Arm C.
- Update the comment block above the (now removed) `parentCtes` build so it describes the
  single-context shape, matching the comment style in `update.ts` lines ~67-72.

### Phase 2 — tests

- New `packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic` covering
  every Arm A shape above (returning, values row expression, `on conflict` set and
  where, `with context`, view target, materialized-view target), the Arm B nested case,
  and the already-working `select`-source shape as a regression guard.
- Add the Arm C `with schema` + `returning` and `with schema` + `on conflict` cases to
  `packages/quereus/test/logic/06.4-schema-search-path.sqllogic`, next to existing
  Test 17.
- Add the DML-bodied common table expression + view target case described under *Watch
  item* to `packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic`.

### Phase 3 — validate

- `yarn build`
- `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn lint`
- Check whether `docs/sql.md` / `docs/sql-select.md` state the visibility rule for a
  leading `with` clause on DML; if they call out the update/delete behavior, extend the
  statement to cover insert rather than adding a new section.
