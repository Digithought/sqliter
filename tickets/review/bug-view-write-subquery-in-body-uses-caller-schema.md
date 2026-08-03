---
description: Updating or deleting through a view whose definition contains a sub-select used to fail with a "table not found" error or quietly change the wrong rows; those sub-selects now look their tables up in the view's own naming environment, the same one a plain read of the view uses.
files:
  - packages/quereus/src/parser/ast.ts                              # SelectStmt.storedHomeSchema (new)
  - packages/quereus/src/planner/planning-context.ts                # PlanningContext.storedBodyOf (new)
  - packages/quereus/src/planner/stored-body-context.ts             # storedBodyContext stamps storedBodyOf
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt honours the marker (~line 73)
  - packages/quereus/src/planner/mutation/scope-transform.ts        # mapNestedSelects (new); rebuildSelect gains onMetaExpr
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation marks the body (~line 83)
  - packages/quereus/test/view-home-schema.spec.ts                  # +11 cases, new describe block at the end
  - packages/quereus/test/view-cte-isolation.spec.ts                # +3 cases
  - docs/view-updateability.md                                      # § Schema resolution during write-through
  - docs/schema.md                                                  # ~line 335 — exception clauses dropped
  - docs/sql-views.md                                               # ~line 21 — exception clause dropped
difficulty: medium
---

# What shipped

A write through a view is **lowered** into an ordinary INSERT / UPDATE / DELETE
against the base table. Pieces of the view's definition get copied into that
lowered statement (the view's own `where`, each view column's base-term
expression, an authored `with inverse` put expression, a `with defaults` value),
and the lowered statement is planned on the **caller's** planning context. A
plain column reference survived that move because the lowering had already
rewritten it to a resolved base column — but a **sub-select** carried its `from`
names through verbatim, so they resolved in the writer's naming environment
instead of the view's.

The fix marks the fragment rather than swapping the context (the lowered
statement is a mix of caller-authored clauses and definition-derived fragments in
one AST, so no single context is right for it):

1. `AST.SelectStmt.storedHomeSchema?: string` — write-through lowering metadata,
   never set by the parser, inert everywhere else.
2. `PlanningContext.storedBodyOf?: string` — set by `storedBodyContext(ctx, schemaName)`,
   answering "is this context already that body's home environment?".
3. `buildSelectStmt` acts on the marker at the top of the build: swap to
   `storedBodyContext` **and** reset the explicit `parentCTEs` argument, guarded on
   `ctx.storedBodyOf !== stmt.storedHomeSchema`.
4. `mapNestedSelects(query, stamp)` in `mutation/scope-transform.ts` — deep-clones
   and stamps every *nested* sub-select root (top-level root not stamped; compound /
   union legs treated as nested).
5. `buildViewMutation` applies it once, on a clone, gated on `!view.ephemeral`.

The ticket's `with inverse` / `with defaults` clone gap is closed: `rebuildSelect`
gained an optional `onMetaExpr` (default `cloneExpr`), threaded into
`cloneInverseClause` / `cloneDefaultsClause`, and `mapNestedSelects` passes its own
no-substitution clone there so the descent reaches those two clauses. All other
`rebuildSelect` callers take the default and are byte-identical to before.

## Validation performed

`yarn workspace @quereus/quereus test` → **8467 passing, 0 failing, 13 pending**
(8453 before + the 14 new cases). Repo-wide `yarn test` → all workspaces green.
`yarn lint` → clean (that script also runs `tsc -p tsconfig.test.json --noEmit`).
`tsc -p packages/quereus/tsconfig.json --noEmit` → clean.

**The 14 new tests were verified to fail without the fix**, not just to pass with
it. Two negative runs:

- Marker disabled in `buildViewMutation` → all 13 sub-select cases fail (the
  14th, the ephemeral-target control, correctly still passes since it is never
  marked).
- Marker kept but the `parentCTEs` reset removed → exactly the 3 caller-CTE cases
  fail, the other 10 pass. This reproduces the ticket's claim that the reset is
  load-bearing and independent of the context swap, and is why the comment at that
  line names `buildExpressionPositionQueryExpr` + `buildWithContext` precedence.

Both edits were reverted; the tree holds only the real fix.

## Use cases to exercise when reviewing

All four ticket arms, plus the shapes added around them. Each is a `db.exec`
sequence; the pre-fix symptom is in the trailing comment.

```sql
-- Arm 1: hard failure for a view outside `main`
create table temp.a (id integer primary key, x integer);
create table temp.b (id integer primary key);
create view temp.va as select id, x from a where id in (select id from b);
update temp.va set x = 99 where id = 1;   -- was: Table 'b' not found in schema path: main
delete from temp.va where id = 1;         -- same

-- Arm 2: silent WRONG row set, in `main`, under a session schema_path
create view main.lv2 as select id, x from lt2 where id in (select id from ls2);
-- with an empty temp.ls2 shadowing main.ls2 and schema_path = 'temp,main':
update main.lv2 set x = 99 where id = 1;  -- was: reported success, changed nothing

-- Arm 3: the caller's `with` clause, no schema setup at all
with ls as (select 2 as id) update lv set x = 99 where id = 1;   -- was: updated nothing

-- Arm 4: a computed view column whose lineage is a correlated sub-select
create view temp.gv as select id, x, (select lbl from gl where gid = id) as lbl from gt;
update temp.gv set x = 77 where lbl = 'one';   -- was: Table 'gl' not found in schema path: main
```

Body shapes covered beyond the plain single-source one: a join body (`… join jb2 b
on b.k = a.k where a.k in (select k from jok)`), a membership set-op body with a
sub-select in **each** branch predicate (proves the marker reaches compound legs),
a body whose `from` is schema-qualified while its sub-select is not, an INSERT
through a view with `with defaults (kind = (select kind from dk limit 1))`, and an
INSERT through a view with `with inverse (code = (select code from lk where label =
new.label))`.

Negative controls that must stay green — these pin what must NOT change:

- A caller's own predicate sub-select (`update temp.pv2 set x = 0 where id in
  (select id from side2)`) still binds the **caller's** `side2`, in the same
  statement whose view body binds its own `pk2` on the home path.
- One caller `with` clause holding both a name the body reads (must not bind) and
  a name only the user's predicate reads (must bind).
- An ephemeral inline-subquery target with its own sub-select stays entirely on the
  caller's path.
- Every pre-existing case in both spec files passes **unedited**.

## Known gaps / things worth an adversarial look

- **Two sibling defects are still open and deliberately out of scope**, both filed
  separately and both reproducing in `main` with no schema path or caller CTE:
  `fix/bug-view-write-lineage-subquery-base-table-qualifier` (a body lineage
  sub-select qualifying its correlation with the base table's *name* fails the
  lowered UPDATE with `gt.id isn't a column`) and
  `fix/bug-view-write-body-cte-not-carried-into-lowering` (a body sub-select
  reading the body's own `with` clause). This ticket **changes the second one's
  failure mode**: it used to possibly bind a caller table of that name, and now
  always errors, because the marker clears the caller CTE namespace. That is a
  strict improvement but it is a behavior change on an already-broken path — worth
  confirming no test asserted the old shape (none did; suite is green).
- **A body's `with` clause CTE bodies are cloned unstamped** (`cloneWithClause` →
  `cloneQueryExpr`). Exact today only because no lowering copies a body's `with`
  clause into the lowered statement — that is precisely the second open ticket
  above. Called out in a `NOTE:` in `mapNestedSelects`' doc comment. If that ticket
  lands by carrying the body's CTEs into the lowering, their bodies need the stamp
  too.
- **`recordDependency` must keep receiving `viewIn`, not the marked clone.** The
  tracker stores only a `WeakRef`, so recording the temporary clone would let the
  dependency silently collapse on GC and `checkIntegrity()` would start returning
  false. The marker is therefore applied *after* the dependency block, and there is
  a comment saying why. This is a live footgun for anyone who later moves the
  marking earlier "to be before any spine dispatch".
- **Tripwire parked in code, not filed as a ticket:** `buildViewMutation` now
  deep-clones the whole body AST on every view-write plan *build*. Once per plan
  (plans are cached), proportional to body size — not measured as a problem, and
  the full suite's wall-clock did not move. `NOTE:` at the site in
  `view-mutation-builder.ts` says to skip the walk for a body with no nested
  sub-select if it ever shows up in a profile.
- **`rebuildSelect`'s new `onMetaExpr` parameter is defaulted**, so the three
  existing callers (`mapQueryExprUniform`, `transformScopedQuery`,
  `transformAliasScopedQuery`) are unchanged. Worth confirming that is the right
  call for each: those callers deliberately do NOT thread their *substitution* into
  the metadata clauses (the refs there are `new.`-qualified written-row reads), and
  nothing about this change argues they should now thread their *descent* either.
  I left them alone on that reasoning rather than because it was safer.
- **Test-shape caveat:** the join-body and set-op-body cases put the sub-select in
  a `where … in (select …)`. Those shapes happen to survive the multi-source /
  set-op writability analysis; a reviewer wanting broader confidence could try a
  sub-select in a join `on` condition or in a set-op branch's projection, which I
  did not exercise.
- Repo-wide `yarn test` was run and is green; `yarn test:store` (the LevelDB-backed
  re-run of the logic tests) was **not** — this change is purely plan-time name
  resolution with no store surface, so it should be unaffected, but that is
  reasoning, not a run.
