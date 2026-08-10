---
description: A named block that inserts, updates or deletes rows behaves unpredictably when it sits inside a sub-query or a saved view instead of at the start of a statement — sometimes the write silently disappears, sometimes it re-runs on every read. Reject those positions with a clear error instead.
files:
  - packages/quereus/src/planner/planning-context.ts        # new field: which `with` clauses are a statement's own
  - packages/quereus/src/planner/building/block.ts          # buildBlock sets it; attachUnreferencedDmlCtes is the top-level guarantee
  - packages/quereus/src/planner/building/with.ts           # buildWithClause — where the rejection goes
  - packages/quereus/src/planner/building/select-context.ts # buildWithContext / buildStoredBodyCTEs — the two other callers
  - packages/quereus/src/planner/building/create-view.ts    # planViewBody — existing precedent: a DML *body* is already rejected here
  - packages/quereus/test/logic/13.11-unreferenced-dml-cte.sqllogic  # the top-level guarantee this mirrors
  - packages/quereus/test/logic/13.7-cte-sibling-visibility.sqllogic  # nested READ-ONLY `with` clauses — must keep passing
  - docs/sql-select.md            # § Common Table Expressions — visibility rules
  - docs/runtime-caching.md       # § Shared CTE materialization — the open-gap list this closes
repro: verified
difficulty: medium
---

# Reject a data-modifying `with` member outside a statement's own leading clause

## What was observed

Verified against the current build (`node --import ./packages/quereus/register.mjs <script>`,
memory tables). A `with` member whose body is an `insert` / `update` / `delete` behaves
**three different ways** depending on position and on whether anything reads it:

| Position | Member referenced? | Today |
| --- | --- | --- |
| statement's own leading clause | either | writes exactly once — guaranteed (`attachUnreferencedDmlCtes`) |
| `from` sub-query, scalar sub-query, `exists`/`in` sub-query, a nested clause inside another CTE body | **no** | **silently does nothing** — no rows written, no error |
| same nested positions | **yes** | writes once per statement execution |
| correlated scalar sub-query | yes | writes once for the whole statement, and every outer row is handed the first row's `RETURNING` set |
| stored view body | yes | **re-drives the write on every read of the view** |
| stored view body | no | silently does nothing; `create view` accepts the definition |
| materialized-view body | either | `create materialized view` fails late with a confusing "body is non-deterministic (SINK (unreferenced-cte c))" message |

Concrete transcripts:

```sql
create table t (k integer primary key);

-- unreferenced, nested → nothing happens, no error
select * from (with c as (insert into t (k) values (1) returning k) select 42 as x) z;
-- → [{"x":42}]   t stays empty

-- referenced, nested → the write DOES happen
select * from (with c as (insert into t (k) values (1) returning k) select k as x from c) z;
-- → [{"x":1}]    t = [{"k":1}]

-- stored view body, referenced → writes on EVERY read of the view
create view v as with c as (insert into t (k) values (1) returning k) select k as x from c;
select * from v;   -- writes a row, every time it is run
```

The "silently does nothing" rows are the reported bug. The rows that *do* write are the
part that makes a narrow patch wrong: they are inconsistent with each other, PostgreSQL
rejects every one of them, and the view case directly contradicts a rule this codebase
already states and enforces elsewhere (`planViewBody` refuses a `create view v as insert …`
with "a view re-evaluates on every reference, which would re-drive the write").

## Root cause

One decision is **missing**, not wrong: nothing records *where* a `with` clause is being
built, so no builder can tell a statement's own leading clause from a nested one.

- `buildWithClause` / `buildCommonTableExpr` (`planner/building/with.ts`) build every
  member identically regardless of position.
- The write guarantee lives entirely in `attachUnreferencedDmlCtes`
  (`planner/building/block.ts`), which by construction only ever sees top-level statements.
- Every nested position therefore falls through with no owner: a *referenced* member gets
  its write driven by the reference (which is why some cases work), an *unreferenced* one
  is dropped with the rest of the unused plan.

## What to build

Make position part of what a `with` clause is built with, then **reject** a data-modifying
member built outside a statement's own leading clause. Rejection — not "make it run" — for
three reasons: it matches PostgreSQL; it needs no new runtime machinery; and the "make it
run" option first requires deciding what "once per statement execution" means for a
sub-query evaluated once per outer row, which is an open question already recorded in
`docs/runtime-caching.md`.

### The position marker

Add to `PlanningContext`:

```ts
/**
 * The `with` clauses that belong to a TOP-LEVEL statement of this build, by AST object
 * identity. Set once by `buildBlock` from the statements it is handed; inherited by every
 * derived context through the usual spread, so a clause met anywhere below still compares
 * correctly.
 *
 * Read only by `buildWithClause`, to decide whether a data-modifying member is in a
 * position that can honour the once-per-statement write guarantee.
 */
readonly topLevelWithClauses?: ReadonlySet<AST.WithClause>;
```

Key on the **clause object**, not on the statement object. The view write-through path
re-plans a statement into a rewritten one (`{...stmt, table: base}`) that carries the *same*
clause object, so a top-level `with c as (insert …) update v …` must keep working; keying on
the statement would break it. A nested clause — a sub-select's own, a stored body's carried
one — is always a distinct object from any top-level clause, so it never matches.

`buildBlock` collects the marker and uses the marked context for both `buildStatement` and
`attachUnreferencedDmlCtes` (the latter rebuilds the top-level clause and must stay allowed).

### The check

In `buildWithClause`, alongside the existing duplicate-name scan and **before** any member is
built:

```ts
const topLevel = ctx.topLevelWithClauses?.has(withClause) ?? false;
// … for each member: if (!topLevel && isDataModifyingCte(cte)) → error
```

Message must name the block, its body kind, and the fix. Suggested wording (adjust to taste,
but keep a stable substring for the sqllogic assertions):

> `WITH member 'c' is an INSERT, which is only allowed in a statement's own leading WITH clause — not in a subquery or a stored view/materialized-view body, where the write would either be dropped or re-driven on every evaluation. Move the mutation to the statement that uses this query.`

`StatusCode.ERROR` (a permanent rejection, like the sibling `planViewBody` DML-body reject),
with line/column from `cte.query.loc`.

Putting the check in `buildWithClause` rather than at each nesting position covers all of
them at once — `from` sub-query, scalar / `exists` / `in` sub-query, a clause nested inside
another CTE body, a stored view body, a materialized-view body, a maintained-table body, an
assertion body — and covers any nesting position added later. All of those funnel through
`buildWithContext` → `buildWithClause` or `buildStoredBodyCTEs` → `buildWithClause`.

### Behaviour changes to expect (all intended)

- The silently-dropped cases become a build-time error. **This is the fix.**
- The cases that currently *do* write (nested + referenced, correlated, view body) also
  become a build-time error. Call this out in the docs — it is a deliberate narrowing, and
  it retires the first "known gap" bullet in `docs/runtime-caching.md`
  (correlated data-modifying CTE) by making the shape unreachable rather than undefined.
- `create view` / `create materialized view` / `create table … maintained` / `create assertion`
  now reject such a body at definition time, because each plans its body through
  `buildSelectStmt` on a nested context. The materialized-view case in particular replaces
  today's late, misleading "body is non-deterministic (SINK (unreferenced-cte c))" error.
- **Read-only** nested `with` clauses are untouched — only `isDataModifyingCte` members are
  rejected. `test/logic/13.7-cte-sibling-visibility.sqllogic` exercises several (a DML CTE
  body carrying its own read-only `with` clause, `select n from (with z as (…) …)`, two
  levels of nesting) and must keep passing unchanged.

### Known limit — record it, do not build machinery for it

Several analysis paths re-plan a **stored** body as if it were a standalone top-level
statement — `db._buildPlan([view.selectAst])` in `func/builtins/schema.ts`,
`planner/analysis/assertion-plan.ts`, `core/database-materialized-views-plan-builders.ts`,
`runtime/emit/materialized-view-helpers.ts`, `schema/lens-prover.ts`, `func/builtins/explain.ts`.
Those calls mark the body's own clause top-level, so a body that *already contains* a
data-modifying member would still be accepted there. Unreachable for anything created after
this change (the definition-time gate rejects it first); reachable only for a definition
persisted by an older build. Park it as a `NOTE:` at the `buildBlock` marker site — do not
add a "is this a stored body" flag to `_buildPlan` for it.

## TODO

- Add `topLevelWithClauses` to `PlanningContext` (`planner/planning-context.ts`) with the doc
  comment explaining clause-identity keying and why it is optional (absent ⇒ nothing is
  top-level ⇒ conservative rejection).
- In `buildBlock` (`planner/building/block.ts`): build the set from the statements' own
  `withClause` objects, derive the block context once, and use it for `buildStatement` **and**
  `attachUnreferencedDmlCtes`. Add the `NOTE:` about stored bodies re-planned as top-level
  statements by the analysis paths listed above.
- In `buildWithClause` (`planner/building/with.ts`): reject a data-modifying member when the
  clause is not marked top-level, before any member is built. Point the comment at
  `attachUnreferencedDmlCtes` (the guarantee this is the boundary of) and at `planViewBody`
  (the sibling reject with the same rationale).
- Update `attachUnreferencedDmlCtes`'s doc comment: its "a `with` clause on a NESTED statement
  … is out of scope" paragraph now describes an *enforced* boundary, not an accepted omission.
- New `packages/quereus/test/logic/13.12-nested-dml-cte-rejected.sqllogic`, one `-- error:`
  case per position, using the shapes verified above: `from` sub-query, scalar sub-query,
  `exists` sub-query, `in` sub-query, a nested clause inside a top-level CTE's body, a
  compound arm, a nested clause feeding an outer `insert`, a nested clause in an `update …
  where`, `create view`, `create materialized view`. Cover referenced **and** unreferenced
  members — both must reject. Add positive controls: the top-level clause still writes, and
  a nested **read-only** `with` clause still works in a sub-query and in a view body.
- Update `docs/sql-select.md` § Common Table Expressions: state that a data-modifying member
  is legal only in a statement's own leading `WITH` clause, and is rejected in a sub-query or
  a stored view / materialized-view body.
- Update `docs/runtime-caching.md` § Shared CTE materialization: drop the correlated
  data-modifying CTE bullet from the open-gap list and say the shape is now rejected at build
  time. Leave the second bullet (a CTE reading a base table another CTE writes) — this change
  does not touch it.
- Run `yarn lint` and `yarn test` from the repo root; stream output
  (`yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`).
