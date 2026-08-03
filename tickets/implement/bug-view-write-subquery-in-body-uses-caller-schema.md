---
description: Updating or deleting through a view whose definition contains a sub-select fails with a "table not found" error, or quietly changes the wrong rows, because that sub-select is looked up in the writer's naming environment instead of the view's own.
files:
  - packages/quereus/src/parser/ast.ts                              # SelectStmt — new optional `storedHomeSchema` marker
  - packages/quereus/src/planner/planning-context.ts                # PlanningContext — new optional `storedBodyOf` marker
  - packages/quereus/src/planner/stored-body-context.ts             # storedBodyContext — stamps `storedBodyOf`
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt — honours the marker (~line 73)
  - packages/quereus/src/planner/building/expression.ts             # buildExpressionPositionQueryExpr (~line 39) — passes ctx.cteNodes as an explicit arg
  - packages/quereus/src/planner/building/select-context.ts         # buildWithContext — explicit parentCTEs beats ctx.cteNodes
  - packages/quereus/src/planner/mutation/scope-transform.ts        # new `mapNestedSelects` walker; rebuildSelect / cloneExpr gap
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation — the one funnel that marks the body
  - packages/quereus/test/view-home-schema.spec.ts                  # write-through home-schema cases
  - packages/quereus/test/view-cte-isolation.spec.ts                # caller-CTE isolation cases
  - docs/view-updateability.md                                      # § Schema resolution during write-through
  - docs/schema.md                                                  # line ~335, "Stored bodies resolve against their home schema"
  - docs/sql-views.md                                               # line ~21, home-schema resolution bullet
difficulty: medium
repro: verified
---

# A sub-select copied out of a view definition must keep the view's naming environment

A view's definition is stored, so every unqualified name in it belongs to the
view's own schema first (its "home schema"), and never to the writing
statement's `with` clause. Reads follow that rule, and the *plan* of the body
during a write does too (`bodyPlanningContext` → `storedBodyContext`).

A write through a view is not executed as the body plan, though. It is
**lowered** into an ordinary INSERT / UPDATE / DELETE against the base table,
and pieces of the definition are copied into that lowered statement (the view's
own `where`, and the expression behind each view column). The lowered statement
is planned on the **caller's** context, so any table name inside a *sub-select*
in those copied pieces is resolved in the caller's naming environment. A plain
column reference survives because the lowering rewrites it to a resolved base
column; a sub-select's `from` names ride through verbatim.

## What breaks (all four reproduced on the current tree)

**Arm 1 — hard failure for a view outside `main`.**

```sql
create table temp.a (id integer primary key, x integer);
create table temp.b (id integer primary key);
create view temp.va as select id, x from a where id in (select id from b);

update temp.va set x = 99 where id = 1;   -- Table 'b' not found in schema path: main
delete from temp.va where id = 1;         -- same
select * from temp.va;                    -- works; view_info says updatable
```

**Arm 2 — silent wrong row set, in `main`, under a session `schema_path`.**

```sql
create table main.lt (id integer primary key, x integer);
create table main.ls (id integer primary key);
insert into main.lt values (1, 10);  insert into main.ls values (1);
create table temp.ls (id integer primary key);          -- empty, same name
create view main.lv as select id, x from lt where id in (select id from ls);

pragma schema_path = 'temp,main';
select * from main.lv;                    -- [{id:1, x:10}]  (read binds main.ls)
update main.lv set x = 99 where id = 1;   -- reports success, changes nothing
```

**Arm 3 — the caller's `with` clause leaks through the same hole**, with no
schema setup at all:

```sql
with ls as (select 2 as id) update main.lv set x = 99 where id = 1;
select * from main.lt;                    -- [{1, 10}] — silently updated nothing
```

**Arm 4 — a computed view column whose lineage is a correlated sub-select**
raises the same not-found on a non-`main` view (`update temp.gv set x = 77
where lbl = 'one'` → `Table 'gl' not found in schema path: main`, where `lbl`
is `(select lbl from gl where gid = id)`).

All four are the same root cause and close together.

## Expected behavior

- A table name inside a sub-select that came from a stored view / MV definition
  resolves on that object's home-schema path (its schema first, then the
  database default path) — exactly like the read.
- Such a name is **not** matched against the writing statement's `with` clause.
- The writing statement's *own* sub-selects keep the caller's path **and** the
  caller's CTEs: a user `where id in (select id from side)`, an `insert … select`
  source, and every name in an ephemeral DML target (a CTE-name target, an inline
  `update (select …) as v`) are caller-owned. All are pinned today in
  `test/view-home-schema.spec.ts` and `test/view-cte-isolation.spec.ts` and must
  stay green.

## Design — mark the fragment, not the context

`bodyPlanningContext` swaps the whole planning context, which cannot work here:
the lowered statement is a *mix* of caller-authored clauses and
definition-derived fragments in one AST, so no single context is right for it.
Resolution must be decided per fragment. Carry that decision **on the AST node**
and let the ordinary builder act on it.

**1. An AST marker.** A new optional field on `AST.SelectStmt`:

```ts
/**
 * Home schema of the stored view / materialized-view body this sub-select was
 * copied out of. Set by the write-through lowering …; inert everywhere else.
 */
storedHomeSchema?: string;
```

**2. A context marker so the body's own plan is unaffected.** `PlanningContext`
gains `readonly storedBodyOf?: string`, set by `storedBodyContext(ctx, schemaName)`
to `schemaName`. It answers "is this context already that body's home
environment?".

**3. `buildSelectStmt` honours the marker**, at the very top (before the
`stmt.schemaPath` / `with schema` swap, so an explicit in-body `with schema`
still wins on the path):

```ts
const storedSwap = stmt.storedHomeSchema !== undefined && ctx.storedBodyOf !== stmt.storedHomeSchema;
const storedCtx = storedSwap ? storedBodyContext(ctx, stmt.storedHomeSchema) : ctx;
if (storedSwap) parentCTEs = new Map();
```

The `parentCTEs` reset is **load-bearing** and not optional: clearing
`ctx.cteNodes` alone does not close Arm 3, because
`buildExpressionPositionQueryExpr` (`building/expression.ts` ~line 39) passes
`ctx.cteNodes` to `buildSelectStmt` as an *explicit* `parentCTEs` argument, and
`buildWithContext` prefers a non-empty explicit argument over `ctx.cteNodes`
(`building/select-context.ts` line 31). Verified: with the reset omitted, Arms 1
and 2 pass and Arm 3 still silently updates nothing.

The `ctx.storedBodyOf !== stmt.storedHomeSchema` guard is what makes the marker a
no-op while the body itself is being planned (`analyzeView` plans it under
`bodyPlanningContext`, which already IS that home context). Without the guard the
swap would re-clear `cteNodes` inside the body's own plan and break a body whose
sub-select reads the body's own `with` clause.

**4. One walker that applies the marker.** `mutation/scope-transform.ts` gains:

```ts
/** Deep-clone `query`, applying `stamp` to every NESTED sub-select root. */
export function mapNestedSelects(
	query: AST.QueryExpr,
	stamp: (sel: AST.SelectStmt) => AST.SelectStmt,
): AST.QueryExpr
```

built on the existing `rebuildSelect` with `descend`/`onLeg` = a recursion that
stamps each descended select root. The top-level root is **not** stamped (it is
the body itself, already planned under its home context); compound / union legs
are treated as nested, which is harmless under the guard in step 3 and is what
lets the set-operation spine's per-branch views inherit the marker.

**5. One site applies it.** `buildViewMutation` (`building/view-mutation-builder.ts`)
is the single funnel every view-mediated write passes through — single-source,
multi-source, decomposition, set-op, lens — so mark the body once, there, before
any spine dispatch, and every spine's copied fragments inherit it without each
spine being touched:

```ts
const view = viewIn.ephemeral
	? viewIn
	: { ...viewIn, selectAst: mapNestedSelects(viewIn.selectAst, sel => ({ ...sel, storedHomeSchema: viewIn.schemaName })) };
```

Marking a **clone** matters: the schema's stored `selectAst` must never be
mutated. An **ephemeral** target (CTE-name body, inline FROM-subquery) is part of
the caller's statement and is deliberately not marked — the mirror of
`bodyPlanningContext`'s existing ephemeral guard.

### Validated

This design was prototyped end to end on the current tree. Arms 1–4 pass; the
existing caller-path preservation cases pass; the full `packages/quereus` suite
was green (8453 passing, 0 failing, 13 pending) with the prototype applied. The
prototype was then reverted — none of it is in the tree.

### Known gap the prototype exposed

`rebuildSelect` clones a result column's `with inverse` clause and a select's
`with defaults` clause through `cloneInverseClause` / `cloneDefaultsClause`,
which call `cloneExpr` — whose subquery descent is hard-wired to
`cloneQueryExpr`, not the caller's `descend`. So `mapNestedSelects` as sketched
does **not** reach a sub-select inside an authored-inverse put expression or a
`with defaults (col = (select …))` value, and both of those fragments ARE copied
into the lowered INSERT / UPDATE (`rewriteAuthoredViewInsert`,
`collectAppendedDefaults` in `mutation/single-source.ts`). Close this as part of
the work — thread the walker's expression callback into those two clause clones
(or stamp them in a second explicit pass) and pin it with a test.

## Out of scope — filed separately

Two further defects at the same *symptom* but different code sites, both
reproduced standalone in `main` (no schema path, no caller CTE involved):

- `fix/bug-view-write-lineage-subquery-base-table-qualifier` — a body lineage
  sub-select that qualifies its correlation with the base table's *name*
  (`… where gl.id = gt.id`) fails the lowered UPDATE with `gt.id isn't a column`.
- `fix/bug-view-write-body-cte-not-carried-into-lowering` — a body sub-select
  that reads the body's own `with` clause fails the lowered write with
  `Table 'c' not found`.

After this ticket, the second one's failure mode improves from "may silently bind
a caller table of that name" to "always errors" — the marker clears the caller
CTE namespace — but the write still does not work.

## TODO

- Add `storedHomeSchema?: string` to `AST.SelectStmt` (`parser/ast.ts`), documented as
  write-through lowering metadata, inert elsewhere.
- Add `readonly storedBodyOf?: string` to `PlanningContext` and set it in
  `storedBodyContext`; extend that module's doc comment with the third isolation
  (a marked fragment planned on a foreign context re-enters the home environment).
- Apply the marker at the top of `buildSelectStmt`, including the `parentCTEs`
  reset, with a comment naming why the reset is required
  (`buildExpressionPositionQueryExpr` + `buildWithContext` precedence).
- Add `mapNestedSelects` to `mutation/scope-transform.ts` next to
  `mapQueryExprUniform`, documented as the stored-fragment marker walker.
- Close the `with inverse` / `with defaults` clone gap so nested sub-selects in
  those clauses are marked too.
- Mark the body once in `buildViewMutation`, gated on `!view.ephemeral`.
- Tests in `test/view-home-schema.spec.ts`: Arm 1 (update + delete) on a
  single-source body, on a join body, on a set-op membership body, and on a body
  whose `from` is schema-qualified but whose sub-select is not; Arm 2 (silent
  wrong row set); Arm 4 (computed-column lineage sub-select); an INSERT whose
  view supplies a `with defaults (col = (select …))` value from a non-`main`
  schema.
- Tests in `test/view-cte-isolation.spec.ts`: Arm 3 for update and delete, plus
  the negative — a caller CTE that the *user's own* predicate sub-select reads
  must still bind.
- Confirm the existing caller-path cases in both spec files still pass unchanged
  (they pinned the intended behavior; none should need editing).
- Update `docs/view-updateability.md` § Schema resolution during write-through:
  replace the "The gate covers the body **plan**…" paragraph with the marker
  mechanism; drop the now-stale ticket reference.
- Drop the "except for a subquery inside a body-derived expression …" exception
  clauses in `docs/schema.md` (~line 335) and `docs/sql-views.md` (~line 21).
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; the repo-wide
  `yarn test` was not run for this ticket (only the `quereus` package was).
