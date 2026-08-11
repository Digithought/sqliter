---
description: Two schema-time checks that read the expressions written into a table definition used to carry near-identical copies of the code that walks those expressions; they now share one walk, with no intended change in behavior.
files:
  - packages/quereus/src/schema/expr-scope/frame.ts             # NEW (moved from schema/rename/scope-frame.ts)
  - packages/quereus/src/schema/expr-scope/walk.ts              # NEW — the single traversal
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # now a handler over the walk
  - packages/quereus/src/schema/generated-column-refs.ts        # now a handler over the walk
  - packages/quereus/src/parser/visitor.ts                      # reciprocal NOTE: only
  - packages/quereus/test/schema/expr-scope-walk.spec.ts        # NEW — 20 cases
difficulty: medium
---

# Review: one scope-aware expression walk, two analyses on top of it

## What landed

A table definition can hold expressions: a `check (...)` constraint body, a
`generated always as (...)` column body. Two schema-time analyses read them, and both
walked the tree themselves:

- **`self-qualifier-strip.ts`** rewrites — `check (t.qty > 0)` on table `t` becomes
  `check (qty > 0)`, unless an inner `from` could have rebound `t` or `qty`.
- **`generated-column-refs.ts`** reports — every reference in a generated body,
  classified `'own'` / `'foreign'` / `'unbound'` / `'unknown'`.

Their two `switch` statements were arm-for-arm identical apart from the leaf action.
They are now one function.

- `schema/rename/scope-frame.ts` → `schema/expr-scope/frame.ts`, contents unchanged
  apart from the file references in its header comment. Exported names all kept.
- New `schema/expr-scope/walk.ts`: `walkSchemaExpressionScope(root, options, handlers)`
  with `ScopeWalkOptions { defaultSchema, seedBindings }` and
  `ScopeWalkHandlers { onColumn, onIdentifier? }`. Decomposed into `visit`,
  `visitSelect`, `visitDml`, `visitBarrier`, `visitResultColumns`,
  `visitWindowDefinition`.
- Both analyses keep their exported signatures. `self-qualifier-strip.ts` stayed in
  `rename/` — it is re-exported through `schema/rename-rewriter.ts`, the seam its two
  planner callers import from, and that re-export is untouched.
- `visitStrip` / `visitStripBarrier` / `visitCollect` / `visitCollectBarrier` deleted;
  the four classifier/recorder functions take the frame stack as a parameter instead
  of reading it off their state object.
- Reciprocal `NOTE:` comments in `walk.ts` and `parser/visitor.ts`, so a grep from
  either finds the other. `traverseAst` is untouched otherwise.

Net: **319 lines deleted, 71 added** across the three touched source files.

## What to check first

**The one real behavior widening.** The strip's old walk had *no* `insert` / `update` /
`delete` arms — it stopped at a DML node. The merged walk has them (the collector's,
verbatim), so the strip now *visits* DML subtrees for the first time. The claim is it
still rewrites nothing there: each DML arm pushes an `opaqueScopeFrame()`, and
`stripColumnQualifier`'s capture loop returns on the first frame with `hasOpaque`
before it can clear `col.table`. Worth confirming that reading independently — it is
the one place the merge could have changed an outcome.

Pinned by `test/schema/expr-scope-walk.spec.ts` →
*"rewrites nothing under a barrier, even though it now walks there"*: five bodies
(insert-select, update set/where, delete where, CTE body, derived-table body) each
carrying `t.qty`, asserting `changed === false` **and** byte-stable stringification.

**Everything else is meant to be identical.** Each arm was ported verbatim. The two
ordering invariants that a careless merge would break, both now pinned:

- `stack[0]` is the seed frame and every classifier loop deliberately starts at index
  1. Moving the seed or changing a bound silently reclassifies everything.
- A CTE's name is registered on `withFrame.cteNames` *after* its own body is walked,
  so a non-recursive CTE cannot see itself. Swapping that order flips which sources
  `collectScopeBindings` calls opaque.

## Use cases to exercise

Behavior worth poking at, in SQL terms:

- `create table t (qty int, check (t.qty > 0))` — the qualifier is folded away; the
  constraint plans. Same for `main.t.qty`, and `main.t.qty` on a `temp.t` must NOT be
  treated as a self-reference (`defaultSchema` is the owning schema, never a search
  path).
- `check (exists (select 1 from other where other.k = t.qty))` — `t.qty` still strips,
  because `other` is askable and does not expose `qty`.
- `check (exists (with c as (select 1) select t.qty from c))` — no strip: a CTE source
  is opaque, so capture cannot be ruled out.
- `generated always as (a + b)` where `a`/`b` are own columns — dependency edges
  recorded; a cycle still raises.
- `generated always as (d.x)` with nothing binding `d` — still rejected at declaration
  time as an unbound qualifier (`'unbound'` must not have collapsed into `'unknown'`).
- `alter table … add column … generated always as (…)` over both the backfill paths.

Guard rails, all green: `41-generated-column-scope`, `41-generated-column-errors`,
`41-generated-columns`, `41-generated-column-extras`,
`41.13-alter-add-column-generated-backfill`, `41.14-alter-add-column-subquery-backfill`,
`13.9-schema-authored-cte-isolation`, `40-constraints`, `40.2-check-extras`,
`41.3-alter-rename-propagation` (all `packages/quereus/test/logic/`), plus
`test/schema/clone-expr-isolation.spec.ts` and
`test/schema/column-scope-body-spellings.spec.ts`.

## Validation run

- `yarn build` — clean.
- `yarn test` (repo root, all workspaces) — **0 failing**; `packages/quereus` alone
  reports **9348 passing, 25 pending** (was 9346 before this ticket; +2 is the strip
  block in the new spec, the other 18 new cases replace nothing).
- `yarn lint` and `yarn typecheck` in `packages/quereus` — both exit 0.
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` written.

## Known gaps — read these before signing off

- **The walk still skips six kinds of sub-expression, on purpose.** `returning` lists,
  upsert clauses, `contextValues`, a result column's `with inverse (...)`, a select's
  trailing `with defaults (...)`, and window frame bound expressions
  (`rows between <expr> preceding …`). Both predecessors had exactly these gaps and
  this ticket preserved them so the diff stays mechanical. `walk.ts` carries a
  "deliberately not descended" comment block listing them and naming the owner:
  `debt-schema-scope-walk-uncovered-subtrees` (already sitting in `tickets/implement/`
  as `3.5-…`). One spec case — *"does NOT descend a RETURNING list"* — pins the gap as
  the current contract, with a comment saying the follow-on flips it. **If you think
  a gap should close now, that is the follow-on ticket, not a finding here.**
- **`onIdentifier` has no end-to-end coverage.** The parser produces no `identifier`
  node in expression position today — bare `qty` parses as a `column`, and I checked
  `s.f()` / `current_timestamp` / `x.y` explicitly. So the spec exercises that handler
  by *hand-building* an `IdentifierExpr` into a parsed `coalesce(qty, 0)`. The
  collector's identifier classification therefore has no SQL-level test. That predates
  this ticket (the arm came over from the old `traverseAst`-based analysis) and I did
  not widen or narrow it — but it means "the identifier path works" rests on a
  synthetic AST, and I would not call it verified beyond routing.
- **No sqllogic added.** Nothing user-visible was intended to change, so new
  end-to-end cases would only re-assert what the guard-rail files above already cover.
  The new coverage is deliberately at walk level, where both analyses inherit it.
- **The new spec is a floor, not a ceiling.** 20 cases over the seed frame, FROM
  frames, CTE/derived barriers, the DML arms, and leaf routing. It does not enumerate
  every AST node kind the walk switches on — `case`, `in`, `between`, `values`, `join`,
  `functionSource`, `cast`, `collate`, `unary` are covered only transitively through
  the sqllogic guard rails. A reviewer adding node-kind cases here is adding real value.
- **No tripwires filed and no accepted tradeoffs recorded** — nothing conditional came
  up that was not already owned by the follow-on ticket.
