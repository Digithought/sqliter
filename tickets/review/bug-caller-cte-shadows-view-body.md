description: A query could silently return wrong answers from a view when it defined a temporary named result set (a `with` clause) that happened to share a name with something the view reads. The bug is fixed; this ticket is the code-review pass over the fix plus the new regression tests and doc updates added to close it out.
files:
  - packages/quereus/src/planner/stored-body-context.ts       # new home of `storedBodyContext` (moved out of mutation/)
  - packages/quereus/src/planner/mutation/body-context.ts     # `bodyPlanningContext` now imports `storedBodyContext` from the new module
  - packages/quereus/src/planner/building/select.ts            # ~452 view expansion, ~543 stale-MV re-validation — import path updated
  - packages/quereus/src/planner/building/create-view.ts       # ~24 create-time body plan now routed through `storedBodyContext`
  - packages/quereus/src/planner/building/create-assertion.ts  # ~59 assertion body plan now routed through `storedBodyContext`
  - packages/quereus/test/view-cte-isolation.spec.ts           # new — regression coverage for this bug
  - packages/quereus/test/view-home-schema.spec.ts             # pre-existing sibling coverage (schema-path isolation; untouched)
  - docs/schema.md                                             # ~335 "Stored bodies resolve against their home schema" — CTE-namespace sentence added
  - docs/sql-views.md                                          # ~21 "Home-schema resolution" — same one-line addition
repro: verified
difficulty: easy
---

# A caller's `with` clause leaked into a stored view body — fix landed, now needs review

## Status: fix, tests, and docs all in place; `yarn test`, `yarn workspace @quereus/quereus run lint`, `yarn workspace @quereus/quereus run typecheck`, and `yarn build` all green

The prior (`implement`) pass diagnosed and fixed the bug; this pass added the
regression tests, updated the two docs sections, and resolved the two
judgement calls the implement ticket left open. No behavior changed since the
implement ticket's fix — only tests, docs, and a pure code-motion refactor.

## The bug (for context)

A view's stored body must bind the same objects on every reference. The
common-table-expression (CTE) namespace — the names introduced by a `with`
clause — was not isolated between a caller's statement and a view's stored
body, so a caller `with` clause whose name matched something the view's body
read would silently shadow it. Example:

```sql
create table main.lt (id integer primary key, x integer);
insert into main.lt values (1, 10);
create view main.lv as select id, x from lt;

with lt as (select 1 as id, 999 as x) select * from lv;
-- before the fix: [{"id":1,"x":999}]  (wrong — reads the caller's `lt`)
-- after the fix:  [{"id":1,"x":10}]   (correct — reads main.lt)
```

Three independent leak channels all had to close: the explicit `cteNodes`
argument passed into the body plan, `select-context.ts`'s fallback to
`ctx.cteNodes` when that argument was empty, and the shared
`cteReferenceCache` (keyed by bare `cteName:alias`, mutated in place on a
context object body contexts inherit by reference — this last one is why a
caller CTE and a *same-named body-local* CTE could still collide even after
the first two channels were closed). Full detail, including all four
reproductions, is in git history (`git log --all --oneline -- packages/quereus/src/planner/stored-body-context.ts packages/quereus/src/planner/mutation/body-context.ts`) — the implement-stage ticket body itself is gone now that the ticket has moved past `implement/`, so the ADRs above are the record.

## What this pass did

### 1. Regression tests — `packages/quereus/test/view-cte-isolation.spec.ts` (new file, 10 cases)

Kept separate from `view-home-schema.spec.ts` rather than folded into it: that
file's framing is specifically non-`main`-schema / schema-*path* isolation,
and this bug is schema-independent (every repro uses `main` only) — it's
CTE-*namespace* isolation, a related but distinct naming-environment leak.
Cases, one per channel plus one per must-not-break direction called out in the
original investigation:

- caller `with` shadowing a view's base table is blocked on **read**,
  **update**, and **delete** (three separate `it`s — update/delete are the
  sharpest regression guard, since before the fix they didn't return wrong
  data, they *threw* — `view body operator 'CTEReference' is not updateable in
  phase 1` — because the caller's CTEReference node isn't decomposable);
- a caller CTE that itself reads the view, nested inside a second caller CTE,
  is isolated too;
- the third (`cteReferenceCache`) channel specifically: a view with a
  body-local CTE `c`, read from inside a caller statement that both defines
  its own CTE `c` **and** references it in the caller's own `from` — this is
  the one that survives channel 1+2 fixes alone;
- must-stay-correct: a view's own body-local `with` still resolves; an
  ephemeral CTE-name write target still reads its own CTE; a caller `where`
  subquery still sees the caller's CTEs when writing through a view;
  `insert … returning` through a view is unaffected by an unrelated caller
  `with`; a materialized-view read (which doesn't re-plan the body at all
  absent staleness) is unaffected.

All 10 pass. Run in isolation: `yarn workspace @quereus/quereus run mocha --loader ts-node/esm test/view-cte-isolation.spec.ts` (or just `yarn test`, which runs the whole suite — see Validation below).

### 2. Docs

- `docs/schema.md` § "Stored bodies resolve against their home schema"
  (~line 335): added a paragraph stating the CTE-namespace rule explicitly —
  a stored body binds only its own `with` clause plus home-path schema
  objects; a caller CTE of any name is invisible to it; ephemeral targets are
  excluded (kept the caller's CTEs, same as they keep the caller's schema
  path).
- `docs/sql-views.md` § "Home-schema resolution" (~line 21): one-sentence
  addition in that section's terser voice, same rule.

### 3. Judgement calls resolved

**Layering.** The implement ticket flagged that `storedBodyContext` lived
under `planner/mutation/` but was imported by `planner/building/select.ts` —
backwards, and (as this pass confirmed) not even the *only* such edge:
`mutation/single-source.ts`, `mutation/set-op.ts`, and
`mutation/backward-body.ts` already import `buildSelectStmt` from
`building/select.ts`, so `building` ↔ `mutation` were already mutually
dependent at the file level before this fix. Resolved by moving
`storedBodyContext` (the schema-path + CTE-clearing logic, no
`MutableViewLike` dependency) to a new top-level module,
`planner/stored-body-context.ts`, alongside the existing
`planner/planning-context.ts`. `mutation/body-context.ts` now imports it for
`bodyPlanningContext` (the write-path wrapper that additionally needs
`MutableViewLike` to check `view.ephemeral`); `building/select.ts` imports it
directly. No behavior change — confirmed by the full green test run above.
`create-view.ts` and `create-assertion.ts` (below) also import it directly.

**Optional symmetry.** `building/create-view.ts`'s `planViewBody` and
`building/create-assertion.ts`'s `planAssertionBody` both previously inlined
`{ ...ctx, schemaPath: ctx.db._homeSchemaPath(schemaName) }` — the schema-path
swap only, without clearing `cteNodes` / `cteReferenceCache`. Both now call
`storedBodyContext(ctx, schemaName)` instead. As the implement ticket noted,
this was **not reachable** with a non-empty caller CTE map before the change
(SQL has no `with … create view …` / `with … create assertion …` form), so
it's a consistency fix, not a behavior fix — confirmed by the full test suite
staying green (no create-time test regressed).

## Known gaps / things the next reviewer should form their own opinion on

- The regression spec is new and only reviewed by its author (me, this pass).
  Worth an independent read for: are the 10 cases actually independent (i.e.,
  does deleting the `storedBodyContext` CTE-clearing lines fail *each* of
  them, or would some pass anyway)? I did not re-verify by reverting the fix
  and re-running — I relied on the original investigation's channel-by-channel
  isolation testing (documented as already done in the implement pass) plus
  my own read of which case exercises which channel.
- I did not add a case for a caller CTE shadowing a view referenced through
  **two levels of view nesting** (view A's body reads view B, both under a
  caller `with` that names something both bodies read). The fix is structural
  (every stored-body context clears `cteNodes`/`cteReferenceCache`
  independently at every nesting level via the same `storedBodyContext` call
  in `select.ts`'s view-expansion branch), so I'm confident it holds, but it
  is untested at that depth specifically.
- The `git log` pointer above for full original-investigation detail (four
  reproductions, the exact error text for the update/delete case, the
  `cteReferenceCache` mechanism write-up) assumes reviewers can reach prior
  commits; if this ticket's history gets squashed before landing, that detail
  is lost. Worth pulling the relevant paragraphs forward into a code comment
  or doc if squashing is likely — I judged the existing doc comments on
  `storedBodyContext` (in `planner/stored-body-context.ts`) and
  `bodyPlanningContext` (in `mutation/body-context.ts`) sufficient for a
  future reader who doesn't need the full incident narrative, only the rule
  and why it exists.

## Validation

- `yarn test` (repo root, full workspace) — green: quereus package
  8451 passing / 13 pending, all other workspaces green too.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn build` (repo root) — clean, including the three bundled apps.
