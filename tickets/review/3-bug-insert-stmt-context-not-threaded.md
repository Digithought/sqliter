----
description: An insert statement that declares a temporary named result set up front, or that says which schema to look names up in, now applies that to the whole statement instead of only the rows being inserted.
files:
  - packages/quereus/src/planner/building/insert.ts                            # the whole fix — one hoisted call, then threading
  - packages/quereus/test/logic/13.8-insert-with-clause-visibility.sqllogic    # new
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic               # Tests 17a / 17b added
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic                # two view-target cases added
  - docs/sql-select.md                                                          # §2.1.1 and §3.7 prose
difficulty: medium
----

# Review: `buildInsertStmt` now derives ONE statement-level context

## What changed

`buildInsertStmt` (`packages/quereus/src/planner/building/insert.ts`) was the only DML
builder that did not derive a single statement-level planning context. It built its leading
`with` clause by hand into a local `parentCtes` map handed to exactly one consumer (the
`select` source branch), and built `returning` / `on conflict` against the bare incoming
`ctx` rather than the schema-path-aware one.

The fix mirrors `buildUpdateStmt`:

- One `buildWithContext(contextWithSchemaPath, stmt)` call, hoisted to just above the
  CTE-name-target dispatch.
- The resulting `contextWithCTEs` is threaded through every **user-authored** clause:
  `resolveCteTarget`, all three `buildViewMutation` calls, `buildTableReference`, the
  `with context` assignment build, `buildValuesStmt`, `buildSelectStmt` (the explicit
  `parentCTEs` argument is now dropped — definitions ride the context instead, which is
  what keeps them from leaking past `storedBodyContext`'s clearing on the stored-body
  write-through path), the three nested-DML source branches, `buildUpsertClausePlans`, and
  the `returning` scope + projections.
- The hand-rolled `parentCtes` map and the now-unused `buildWithClause` / `CTEScopeNode`
  imports are gone.
- Schema-authored builds are deliberately **untouched**: `createRowExpansionProjection`
  (column defaults, generated columns) stays on `contextWithSchemaPath`, and
  `buildConstraintChecks` / `buildNotNullDefaults` / `buildChildSideFKChecks` stay on `ctx`.

Because `buildWithContext` seeds from `ctx.cteNodes` and merges `stmt.withClause` on top,
an insert's own `with` clause now **shadows into** rather than **replaces** its inherited
definitions — which closes the second arm without extra code.

## Use cases to test / validate

All of these errored with `Table 'c' not found in schema path: main` before, and pass now.
Setup: `create table p (id integer primary key, v text); insert into p values (1,'a'),(2,'b');`

```sql
-- RETURNING
with c as (select id, v from p) insert into q values (5,'e')
  returning id, (select count(*) from c) as n;

-- scalar subquery inside a VALUES row
with c as (select id from p) insert into q values (6, (select count(*) from c));

-- view target (source AND returning)
with c as (select id, v from p) insert into vq select id, v from c;
with c as (select id from p) insert into vq values (7,'g') returning id, (select count(*) from c) as n;

-- materialized-view target
with c as (select id, v from p) insert into mvq select id, v from c;

-- nested DML source
with c as (select id from p)
insert into q5 insert into q5src values (8,'h') returning id + (select count(*) from c), w;

-- an insert's own WITH clause no longer hides what it inherited
with a as (select id from p),
     b as (with c as (select 1 as k) insert into q select id+40, (select k from c) from a returning id)
select count(*) as n from b;

-- WITH SCHEMA now reaches a RETURNING subquery
insert into products (id, name) values (5,'Whatsit') with schema myapp
  returning id, (select count(*) from lookup) as n;
```

Regression guards worth re-running by hand: `with c as (…) insert into q select … from c`
(the one branch that always worked), and the shadowing case
`with a as (…), b as (with a as (select 77 as id) insert … from a returning id) …`.

## Tests added

- **`test/logic/13.8-insert-with-clause-visibility.sqllogic`** (new) — every shape above,
  plus a control that a schema-authored `default (select count(*) from c)` still binds the
  **real** table `c` when the inserting statement declares a CTE of that name, plus the
  blocked shapes below pinned as errors.
- **`test/logic/06.4-schema-search-path.sqllogic`** — Test 17a (`with schema` + a
  `returning` subquery over a table that exists only in the non-default schema) and
  Test 17b (the `on conflict` analogue, pinned as an error).
- **`test/logic/13.6-cte-dml-runs-once.sqllogic`** — two cases pinning that a
  data-modifying CTE feeding an insert **through a view** still writes exactly once, now
  that the `with` clause is built above the view dispatch and therefore built twice (once
  here, once when `buildViewMutation` re-plans). Verified: one log row, not two.

## Validation run

- `yarn build` — clean.
- `yarn test` — 8649 passing in `packages/quereus`, all other workspaces green, exit 0.
- `yarn lint` — clean.
- `yarn docs:check` — only the two already-known ratchet failures (`docs/schema.md`,
  `docs/sync.md`, tracked as `debt-docs-size-ratchet-red-again` in
  `tickets/.pre-existing-known.md`). `docs/sql-select.md` is not over budget after the
  prose added below.

## Known gaps — read these before reviewing

**1. Two of the ticket's Arm A shapes are NOT closed, and cannot be from this site.**
`on conflict … do update set/where` and `with context <var> = …` now *resolve* the
statement's CTEs and `with schema` path — the "not found" error is gone — but a **subquery
in either position still cannot execute**: `DmlExecutorNode.getChildren()` does not expose
its upsert expressions or its `mutationContextValues`, so those subtrees never reach the
optimizer and hit the runtime still logical (`No emitter registered for Aggregate`, or
`RetrieveNode … was not rewritten to a physical access node`). Verified as pre-existing and
independent: the same statements fail identically with no `with` clause and no
`with schema`, and it hits `update` / `delete` `with context` too. Filed as
`fix/bug-dml-side-expressions-invisible-to-optimizer` with the full repro. **The two test
files pin those statements as expected errors, naming that slug** — they must be converted
to real assertions, not deleted, when it lands.

**2. Inherited CTE definitions still leak into schema-authored expressions.** A column
`default (select count(*) from c)` binds an **enclosing** statement's CTE named `c` instead
of the real table `c` — silently wrong stored value, no error. Reproduced. This is
pre-existing (the schema-authored builds receive contexts derived from the incoming `ctx`,
whose `cteNodes` this change does not touch) and was explicitly out of scope per the
implement ticket. Filed as `fix/bug-schema-defaults-bind-callers-cte`. The statement's
*own* `with` clause is correctly kept out, and 13.8 pins that.

**3. Test floor, not ceiling.** The new coverage is behavioral `.sqllogic` only — no
planner-level assertion that the CTE definitions actually ride the context rather than an
explicit argument. If the reviewer wants that pinned structurally, `test/plan/` is the
place. Also untested: an insert whose target is a **lens**-routed view with a leading
`with` clause, and the multi-source view-insert decomposition path (`preBuiltSource`) with
one — both go through `buildViewMutation`, which now receives `contextWithCTEs`, but no
case exercises the combination.

**4. Not run:** `yarn test:store`. Nothing in this change is storage-module-specific
(planner-only), but the new logic files have not been exercised against the LevelDB store
leg.

## Tripwire parked in code

`packages/quereus/src/planner/building/insert.ts` carries a `NOTE:` at the hoisted
`buildWithContext` call: hoisting above the view dispatch means the `with` clause is built
twice on a view target (`buildWithClause` does not memoize) — wasted planning work, not a
behavior change, and once-only execution of a DML-bodied definition is pinned by the new
13.6 cases. If view write-through planning cost ever shows up, memoize per
`(context, withClause)` rather than re-ordering the dispatch.

## Docs updated

`docs/sql-select.md`:
- §2.1.1 — the schema search path applies to unqualified names anywhere in the declaring
  statement, not only the `FROM` clause and the DML target.
- §3.7 — a new "Visibility inside the declaring statement" pair of bullets: which clauses
  see the statement's own `with` clause (with the `on conflict` / `with context` execution
  gap flagged), and why schema-authored expressions are excluded.
