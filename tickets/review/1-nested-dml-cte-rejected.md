---
description: A block that inserts, updates or deletes rows is now only allowed at the very start of a statement; putting one inside a sub-query or a saved view is rejected with a clear message instead of silently doing nothing (or silently running again on every read).
files:
  - packages/quereus/src/planner/planning-context.ts                  # new optional field `topLevelWithClauses`
  - packages/quereus/src/planner/building/block.ts                    # buildBlock marks the set; collectTopLevelWithClauses; NOTE about stored-body re-plans
  - packages/quereus/src/planner/building/with.ts                     # buildWithClause gate + rejectNestedDataModifyingCte
  - packages/quereus/test/logic/13.12-nested-dml-cte-rejected.sqllogic # new — the whole behaviour
  - packages/quereus/test/view-cte-isolation.spec.ts                  # updated — the view case now rejects at CREATE time
  - packages/quereus/test/logic/13.11-unreferenced-dml-cte.sqllogic   # unchanged, must keep passing (the top-level guarantee)
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic  # unchanged, must keep passing (read-only nesting)
  - docs/sql-select.md            # § 3.7 — new "Where a data-modifying CTE may appear"
  - docs/runtime-caching.md       # § Shared CTE materialization — gap list went 2 → 1
  - docs/view-updateability.md    # the body-CTE-DML guard is now a backstop, not the first line
difficulty: medium
---

# Reject a data-modifying `with` member outside a statement's own leading clause

## What shipped

A `with` member whose body is an `insert` / `update` / `delete … returning` is now accepted
**only** in a statement's own leading `with` clause. Everywhere else it is a build-time
error. This replaces three different prior behaviours (silently dropped, written once per
statement, re-written on every read of a view) with one rejection, matching PostgreSQL.

Three code changes, all in the planner's build phase:

1. **`PlanningContext.topLevelWithClauses`** (`planner/planning-context.ts`) — a new
   optional `ReadonlySet<AST.WithClause>`. Absent ⇒ nothing is top-level ⇒ conservative
   rejection. Every context is derived by object spread, so it propagates to every nested
   builder for free.
2. **`buildBlock`** (`planner/building/block.ts`) collects the leading `with` clause of each
   statement it was handed into that set — keyed on the **clause AST object**, not the
   statement — and builds both `buildStatement` and `attachUnreferencedDmlCtes` under the
   marked context. (The unreferenced-member sink rebuilds the same clause object and must
   stay allowed.)
3. **`buildWithClause`** (`planner/building/with.ts`) rejects a data-modifying member, before
   any member is built, when the clause is not in that set. One check on the clause covers
   every nesting position at once, because they all funnel through `buildWithContext` or
   `buildStoredBodyCTEs` into this function.

Error message (a stable substring the sqllogic assertions key on is
`only allowed in a statement's own leading WITH clause`):

> `WITH member 'c' is an INSERT, which is only allowed in a statement's own leading WITH clause — not in a subquery or a stored view/materialized-view body, where the write would either be dropped or re-driven on every evaluation. Move the mutation to the statement that uses this query.`

`StatusCode.ERROR`, sited at `cte.query.loc`.

## Use cases to check

### Must reject (all verified in `test/logic/13.12-nested-dml-cte-rejected.sqllogic`)

Each of these is covered **both** referenced and unreferenced — the unreferenced ones were
the reported bug (silent no-op), the referenced ones are a deliberate narrowing of shapes
that used to write:

| position | example |
| --- | --- |
| `from` sub-query | `select * from (with c as (insert … returning k) select 42 as x) z` |
| scalar sub-query | `select (with c as (insert … returning k) select k from c) as x` |
| `exists` sub-query | `select 1 where exists (with c as (insert … returning k) select k from c)` |
| `in` sub-query | `select id from d where id in (with c as (insert … returning k) select k from c)` |
| clause nested in another CTE's body | `with o as (with c as (insert … returning k) select k from c) select k from o` |
| compound arm | `select 1 as x union all select x from (with c as (insert …) …) z` |
| nested clause feeding an outer `insert` | `insert into t (k) select x from (with c as (insert …) …) z` |
| nested clause in `update … where` / `delete … where` | `update d set v = 99 where id in (select x from (with c as (insert …) …) z)` |
| `create view` body | `create view v as with c as (insert … returning k) select k as x from c` |
| `create materialized view` body | same shape |
| `create table … maintained as` body | same shape |
| `create assertion` body | rejection text wrapped in the create-assertion diagnostic |
| correlated scalar sub-query | `select (select x from (with c as (insert into t values (src.k) returning k) …) z) from src` |

All `update` and `delete` bodies reject in the same positions, not just `insert`.
Every rejection is checked to have written **nothing**.

### Must still work (positive controls, same file)

- A statement's own leading clause writes exactly as before — referenced and unreferenced,
  `insert` / `update` / `delete`, and on an outer `insert` / `update` / `delete` as well as a
  `select`. `13.11-unreferenced-dml-cte.sqllogic` is the deep coverage and is unchanged.
- **Read-only** nested `with` clauses are untouched: in a `from` sub-query, a scalar
  sub-query, an `in` sub-query, a `create view` body, a `create materialized view` body, and
  nested *inside a top-level DML CTE's own body* (`with c as (with z as (select …) insert …
  returning k) select k from c` — the outer clause is the statement's own, the inner one is
  read-only). `13.7-cte-sibling-visibility.sqllogic` is the deep coverage and is unchanged.
- View write-through with a top-level DML CTE still works: the write-through re-plan carries
  the **same** clause object, which is why the marker is keyed on the clause rather than the
  statement. Pinned by the existing `13.11` cases `vt14` / `vt15`.

### Behaviour that changed for existing users

- `create view` / `create materialized view` / `create table … maintained` /
  `create assertion` now reject such a body at **definition** time. The materialized-view
  case in particular replaces a late, misleading
  `body is non-deterministic (SINK (unreferenced-cte c))`.
- The correlated data-modifying CTE gap in `docs/runtime-caching.md` is retired by making
  the shape unreachable. The second gap (a CTE reading a base table another CTE writes) is
  untouched and still listed.

## Validation run

- `yarn test` from the repo root: all workspaces green (quereus 9229 passing / 25 pending;
  every other package unchanged and passing). `yarn lint` from the root: clean.
- The three positions not expressible in `.sqllogic` were probed directly first
  (maintained-table body, assertion body, correlated scalar sub-query) and then folded into
  the sqllogic file, so nothing rests on an unrepeatable manual check.

## Known gaps — please push on these

- **Stored bodies re-planned as top-level statements.** Several analysis paths call
  `db._buildPlan([<stored body AST>])` — `func/builtins/schema.ts`,
  `planner/analysis/assertion-plan.ts`, `core/database-materialized-views-plan-builders.ts`,
  `runtime/emit/materialized-view-helpers.ts`, `schema/lens-prover.ts`,
  `func/builtins/explain.ts`. Those calls mark the body's own clause top-level, so a body
  that *already contains* a data-modifying member is still accepted there. Unreachable for
  anything created after this change; reachable only for a definition persisted by an older
  build (or hand-injected via `importCatalog`). Parked as a `NOTE:` at the `buildBlock`
  marker site, per the plan ticket's explicit instruction not to add a "is this a stored
  body" flag to `_buildPlan`. Worth a second opinion on whether that instruction still holds
  now that the code is in front of you.
- **`view-cte-isolation.spec.ts` now constructs its legacy-shaped views via
  `db.schemaManager.importCatalog([...])`** instead of `create view`, because `create view`
  rejects them. That keeps the downstream write-through guard (`unsupported-body-cte-dml`)
  and the `view_info` all-`NO` predicate covered — they are exactly the older-catalog
  backstop. Check that this is the right way to model "persisted by an older build" and not
  a test that has quietly stopped testing what it says it does. A new sibling test asserts
  the definition-time rejection.
- **The check is on the clause, not on each nesting site.** That is the point (it covers
  positions added later for free), but it means the *only* thing standing between a nested
  position and acceptance is that `buildBlock` did not put that clause object in the set. If
  some future path re-enters `buildBlock` on a nested statement, the gate opens silently.
  There is no assertion guarding that today.
- **Test floor, not ceiling.** `13.12` is one `-- error:` per position plus positive
  controls; it does not cross positions (a DML CTE two nesting levels down inside a view
  body inside a sub-query), and it does not cover `with recursive` + DML in a nested
  position (the recursive path rejects a DML body for other reasons before reaching here —
  unverified, worth a probe).
- **No spec-level test** exercises the `topLevelWithClauses` field directly; its behaviour
  is only observable through the SQL surface. The several `test/**/*.spec.ts` files that
  hand-construct a `PlanningContext` literal compile unchanged because the field is
  optional — which is also the reason a hand-built context silently rejects every
  data-modifying member. That is the intended conservative direction, but it is untested.
