---
description: Writing through a view could wrongly reject the statement, or change the wrong rows, when a sub-query read a table living outside the default schema; the planner's pre-write check now looks tables up the same way the query itself does.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # tableSourceColumnNames, new fromResolutionContext, transformScopedQuery
  - packages/quereus/src/planner/mutation/cte-flatten.ts            # baseColumnsOf
  - packages/quereus/test/view-home-schema.spec.ts                  # new describe + one case in the ephemeral section
  - docs/view-updateability.md                                      # § Schema resolution during write-through
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt — the plan-time twin (unchanged)
  - packages/quereus/src/planner/building/select-context.ts         # enterStoredBodyEnv — the plan-time twin (unchanged)
difficulty: medium
---

# What changed

Before a write through a view is lowered onto its base table, the planner runs a
static pass over every sub-query in the statement, asking per `from` source
"which columns does this source have?". That shadow set decides, per column
reference inside the sub-query, whether the reference is local to the sub-query
or reaches outward to the view's row.

That lookup resolved a source's name in **one fixed schema** — the connection's
current schema, normally `main` — while the plan that actually executes resolves
the same names through the session schema path (and, for a fragment copied out of
a view's own definition, the view's home environment). Analysis and plan
disagreed, and the disagreement was not conservative.

Three sites, one defect:

- `tableSourceColumnNames` (`planner/mutation/scope-transform.ts`) now resolves
  through `SchemaManager.findSchemaItem` against `ctx.schemaPath` — the same
  primitive `building/select.ts`'s FROM branch uses.
- New `fromResolutionContext` in the same file re-enters a stamped fragment's
  environment before that lookup: `storedBodyContext` on the view's home schema →
  the body's declared `with schema` path → the fragment's own `with schema`
  clause. Same order and precedence as `enterStoredBodyEnv` + `buildSelectStmt`.
  It is applied per select inside `transformScopedQuery`, not threaded.
- `baseColumnsOf` (`planner/mutation/cte-flatten.ts`) now uses `findTable` against
  `ctx.schemaPath`. This one is an **ephemeral** target, so no home-schema swap —
  the caller's path is the right environment.

`docs/view-updateability.md` § Schema resolution during write-through gained the
static half of the rule (it described only the plan-time half), and its stale
"two related defects remain open" paragraph is gone — both are now closed.

# How to exercise it

All three reproduce with a fresh `Database` and no fixtures beyond the SQL shown.

**Arm 1 — a user sub-query source reached through the session path was rejected:**

```sql
pragma schema_path = 'temp,main';
create table temp.t (id integer primary key, x integer);
create table temp.side (tag text primary key, ref integer);
create view temp.v as select id, x from t;
update temp.v set x = 99 where exists (select 1 from side where side.ref = id);
```

Previously: `cannot write through view 'v': the reference 'id' inside a subquery
cannot be proven correlated … (a 'select *' / table-valued function / unresolved
source)`. `temp.side` is none of those. Now the matching rows update.

**Arm 2 — a body sub-query silently changed meaning.** `gl` in both schemas, only
`temp.gl` has an `id`:

```sql
create table temp.gt (id integer primary key, x integer);
create table temp.gl (id integer primary key, lbl text);
create table main.gl (gid integer primary key, lbl text);   -- same name, no `id`
create table main.side (tag text primary key);
create view temp.gv as select id, x, (select lbl from gl where id = 1) as lbl from gt;
update temp.gv set x = 77 where exists (select 1 from side where side.tag = lbl);
```

Previously: `Scalar subquery returned more than one row` — the analysis sized `gl`
up as `main.gl` (no `id`), called the body's local `id` an outward correlation and
re-pointed it at the updated row. With a different column layout the same
mis-decision produces no error, only a row set that disagrees with the read.

**Arm 3 — a CTE chain's base table:**

```sql
pragma schema_path = 'temp,main';
create table temp.ml (id integer primary key, v integer);
with a (p, q) as (select * from ml), t as (select * from a) update t set q = 99 where p = 1;
```

Previously: `cannot write through common table expression 'a': a column rename
over a 'select *' body whose source columns are not statically resolvable cannot
be inlined`. The identical statement against `main.ml` worked.

# Validation performed

- `yarn test` from the repo root: **all workspaces green**, `packages/quereus`
  8525 passing / 0 failing (8516 before, +9 new). No pre-existing failures
  surfaced.
- `yarn lint` from the repo root: clean.
- Nine new tests in `packages/quereus/test/view-home-schema.spec.ts` — eight in
  the new describe "write-through sub-query shadow analysis resolves sources like
  the plan does", one ("resolves a CTE chain's base table on the session path when
  a rename list must be paired") added to the existing ephemeral-DML-targets
  section.
- **Discrimination checked, not assumed.** The fix was temporarily reverted in
  place and the new tests re-run: 4 fail without it (arm 1 outward, arm 1
  shadowed, arm 2, the declared-path case; plus arm 3 on its own revert), and the
  4 controls/negatives pass either way by design.
- Every positive case asserts the write's row set **equals** an independently
  computed matching read, not merely that nothing threw — arm 2's original failure
  mode is a silent row-set divergence.
- Confirmed by grep that no fixed-schema `getTable(` / `getView(` /
  `getSchemaItem(` lookup remains anywhere under `packages/quereus/src/planner/mutation/`.

# Known gaps and things worth an adversarial look

- **Only sub-query-operand predicate forms reach the analysis.** Instrumenting
  `tableSourceColumnNames` showed that `update v set … where <computed col> =
  'literal'` never reaches it, while `where exists (select … <computed col> …)`
  reaches it twice (once for the caller's source on the caller's path, once for
  the body's on the home path). Arm 2's test therefore leans on the `exists`
  spelling; the top-level-comparison spelling is a passenger. Worth confirming
  whether the top-level form genuinely needs no analysis or is silently skipping
  one it should run.
- **The declared-path case (step 2) is isolated via a same-name shadow, not an
  unreachable schema.** Only `main` and `temp` exist, and a `main` view's home
  path already spans both — so the test puts a same-named `dk` in `main` (no
  `id`) against the real `temp.dk` (with `id`) and relies on the declared clause
  flipping the order. A reviewer with a way to attach a third schema could pin
  this more directly.
- **Body-local CTE names taint the analysis scope.** `storedBodyContext` clears
  `cteNodes`, and this pass has no plan nodes from which to rebuild a CTE
  namespace, so a stamped fragment naming a body-local block resolves to nothing.
  Not a regression and nothing reaches it today; pinned by the test "pins the
  body-local-block boundary of the analysis environment" and documented at
  `fromResolutionContext` and in `docs/view-updateability.md`. It is the one place
  the analysis is strictly weaker than the plan.
- **Tripwire parked in code, not filed:** the `committed.` pseudo-schema (`from
  committed.t`) is not intercepted by this analysis the way `resolveTableSchema`
  intercepts it at plan time, so such a source taints rather than resolving.
  Behaviour is unchanged by this work (unresolvable before, unresolvable after)
  and it is only reachable if someone writes through a view whose sub-query names
  a `committed.`-qualified source. Recorded as a `NOTE:` on
  `tableSourceColumnNames`.
- **Negative coverage is `select *` and a table-valued function only.** Both are
  asserted to still raise `cannot be proven correlated` under a session schema
  path. A genuinely unknown name is covered indirectly (it is the same `null`
  return) but has no dedicated new case.
- **Multi-source (join-body) writes have no new test.** The ticket's analysis says
  `multi-source.ts` reaches this same code through the shared
  `makeViewColumnDescend` / `transformScopedExpr` with no second lookup, and the
  grep above supports that, but no new test pins a join-bodied view under a
  non-default path going through the sub-query analysis specifically.

# Filed separately

`tickets/fix/bug-correlated-subquery-cannot-read-outer-computed-column.md` — an
unrelated, pre-existing, verified runtime defect found while building arm 2's
test oracle: a correlated sub-query that references an outer **computed**
projection column fails with `No row context found for column …`. It needs no
views or schemas to reproduce. Root cause located: `canPushAcrossProject`'s
attribute collector (`walkExpr`, `planner/rules/predicate/rule-predicate-pushdown.ts`)
skips relational children, so a correlated reference inside a sub-query operand is
invisible to the safety gate and the filter is pushed below the projection that
defines the column. Because of it, arm 2's oracle is spelled against the base
tables rather than as a read through the view; the test carries a comment pointing
at that ticket so it can be simplified once fixed.
