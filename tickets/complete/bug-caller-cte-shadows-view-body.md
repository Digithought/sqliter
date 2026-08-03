---
description: A query could silently return wrong answers from a view when it defined a temporary named result set (a `with` clause) that happened to share a name with something the view reads. Fixed, regression-tested, documented, and reviewed.
files:
  - packages/quereus/src/planner/stored-body-context.ts        # the fix — the context every stored body plans under
  - packages/quereus/src/planner/mutation/body-context.ts      # write-path wrapper, delegates to it
  - packages/quereus/src/planner/building/select.ts            # ~452 view expansion, ~543 stale-MV re-validation
  - packages/quereus/src/planner/building/create-view.ts       # ~24 create-time body plan
  - packages/quereus/src/planner/building/create-assertion.ts  # ~59 assertion body plan
  - packages/quereus/test/view-cte-isolation.spec.ts           # regression coverage (12 cases)
  - docs/schema.md, docs/sql-views.md, docs/view-updateability.md
repro: verified
---

# A caller's `with` clause leaked into a stored view body

## What was wrong

A view's stored body must bind the same objects on every reference. The
common-table-expression namespace — the names a `with` clause introduces — was
not isolated between a caller's statement and a view's stored body, so a caller
`with` clause whose name matched something the body read silently shadowed it:

```sql
create table main.lt (id integer primary key, x integer);
insert into main.lt values (1, 10);
create view main.lv as select id, x from lt;

with lt as (select 1 as id, 999 as x) select * from lv;
-- before: [{"id":1,"x":999}]   after: [{"id":1,"x":10}]
```

On the write path the same leak did not return wrong rows, it threw:
`view body operator 'CTEReference' is not updateable in phase 1` — a CTE
reference is not decomposable.

## The fix

`storedBodyContext(ctx, schemaName)` (`planner/stored-body-context.ts`) is the
one context every stored body plans under, on read and write alike. It swaps
`schemaPath` to the object's home path (pre-existing behavior) and clears
`cteNodes` and `cteReferenceCache`. Three leak channels had to close together:
the explicit `cteNodes` argument threaded into the body plan; `select-context.ts`'s
fallback to `ctx.cteNodes` whenever that argument is empty; and the shared
`cteReferenceCache`, keyed by bare `cteName:alias` and mutated in place on an
object body contexts inherit by reference — the last is why a caller CTE could
still collide with a *same-named body-local* CTE after the first two closed.

Call sites: view expansion and stale-MV re-validation in `building/select.ts`,
`bodyPlanningContext` in `mutation/body-context.ts` (which guards the ephemeral
case first), plus `create-view.ts` / `create-assertion.ts` for consistency
(not reachable with a non-empty caller CTE map — SQL has no `with … create view`).

The module sits at the top level of `planner/` rather than under `mutation/`,
since `building/` and `mutation/` both consume it.

## Review findings

**Checked:** the full fix + implement diff read cold; every `_homeSchemaPath`
call site in `src/` (the remaining ones build plans through `_buildPlan` /
`getPlan`, which start from a fresh root context — no caller CTEs to leak);
`cteReferenceCache` producers and consumers (lazily created, so clearing to
`undefined` is safe); the other context fields the fix does *not* clear; the
regression spec re-derived independently; the three touched docs plus
`view-updateability.md`, which the implement pass should have touched and did not;
lint, typecheck, full test suite, `docs:check`.

**Fixed in this pass (minor):**

- *Test independence was asserted, not measured.* Re-ran the spec with the
  clearing removed: all 5 leak cases fail, all 5 must-not-break cases pass either
  way. Re-ran with only `cteNodes` cleared: exactly one case fails — the
  body-local-CTE-vs-caller-CTE case — confirming it is the sole
  `cteReferenceCache` guard, as claimed. No redundant cases.
- *Two coverage gaps closed* (`view-cte-isolation.spec.ts`, now 12 cases, both
  verified to fail without the fix): a view read through a second view, where
  both bodies read the shadowed name; and a **stale materialized view** whose
  source was dropped — the caller CTE resolved the name the derivation could no
  longer resolve, so the stale-MV re-validation in `select.ts` saw a healthy body
  and served stale rows instead of raising. That path was previously untested
  (the existing MV case does not re-plan the body at all, so it passes with or
  without the fix — kept as a guard, but it proves nothing on its own).
- *Docs overclaimed.* `schema.md` and `sql-views.md` stated the CTE isolation
  without qualification; write-through lowering is a real exception (see the
  major finding below). Both now carry it, and `view-updateability.md`
  § "Schema resolution during write-through" — the section that documents this
  gate, and which the implement pass left describing the schema path only — now
  covers the CTE namespace and its gap. The `schema.md` paragraph was tightened
  while adding the caveat, so the file is 10 words *smaller* than at HEAD.

**Filed (major):** the caller's CTE namespace leaks through the *lowered* write
statement, which the gate does not reach — same root-cause site as the open
`fix/bug-view-write-subquery-in-body-uses-caller-schema`, so it was appended
there as **Arm 3** rather than filed fresh. Verified on the current tree,
post-fix, all in `main` with no schema-path setup:

```sql
create view main.lv as select id, x from lt where id in (select id from ls);
update main.lv set x = 99 where id = 1;                       -- lt = [{1,99}]
with ls as (select 2 as id) update main.lv set x = 99 where id = 1;
select * from main.lt;                                        -- [{1,10}] — silently updated nothing
```

The view's stored `where` is copied into the base statement and planned on the
caller's context, so its `ls` binds the caller's CTE. The schema arm and this
CTE arm must close together; that ticket now says so.

**Tripwire (not a ticket):** `storedBodyContext` clears the CTE namespace and the
schema path but still inherits the caller's `scope` and `aggregates`. Neither is
exploitable today — a stored body only contains names that resolved at create
time, and its own FROM shadows the caller's scope; probed a view-body aggregate
built inside a caller `HAVING` context (`ctx.aggregates` matching in
`building/function-call.ts` compares function name and argument *names* only,
with no attribute-id check) and it did not mis-match. Parked as a `NOTE:` at the
site, naming the conditions that would make it real (a parameterized view, a
lateral or correlated stored body).

**Not found:** no error-handling, resource-cleanup, or type-safety issues — the
fix is a pure spread with two fields nulled, on an interface where both are
already optional. No DRY or layering complaint survives the implement pass's
move of the module out of `mutation/`. No file-size concern: the new module is 43
lines (`wc -l`), mostly the doc comment carrying the three-channel explanation.

**Corrections to the handoff:** the single-spec command it documents
(`yarn workspace @quereus/quereus run mocha --loader ts-node/esm …`) does not
work on Windows — `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Working form, from the repo
root: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/view-cte-isolation.spec.ts`
(or `yarn workspace @quereus/quereus run test:single <path>`, which bails on
first failure).

## Validation

- `yarn test` — green: quereus 8453 passing / 13 pending (8451 before, +2 new
  cases), every other workspace green.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn docs:check` — one failure, `docs/schema.md` 930 words over its ratchet.
  Pre-existing and already tracked as `debt-doc-size-ratchet-red-at-head` in
  `tickets/.pre-existing-known.md`; red before this ticket chain started (12906
  words vs a 12109 ratchet), and this pass left the file smaller than it found it.
