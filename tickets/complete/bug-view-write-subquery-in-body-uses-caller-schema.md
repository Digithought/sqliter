---
description: Updating or deleting through a view whose definition contains a sub-select used to fail with a "table not found" error or quietly change the wrong rows; those sub-selects now look their tables up in the view's own naming environment, the same one a plain read of the view uses.
files:
  - packages/quereus/src/parser/ast.ts                              # SelectStmt.storedHomeSchema
  - packages/quereus/src/planner/planning-context.ts                # PlanningContext.storedBodyOf
  - packages/quereus/src/planner/stored-body-context.ts             # storedBodyContext stamps storedBodyOf
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt honours the marker (~73)
  - packages/quereus/src/planner/mutation/scope-transform.ts        # mapNestedSelects; rebuildSelect gains onMetaExpr
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation marks the body (~83)
  - packages/quereus/test/view-home-schema.spec.ts                  # +12 cases
  - packages/quereus/test/view-cte-isolation.spec.ts                # +3 cases
  - docs/view-updateability.md                                      # § Schema resolution during write-through
  - docs/schema.md, docs/sql-views.md                               # exception clauses dropped
---

# What shipped

A write through a view is **lowered** into an ordinary INSERT / UPDATE / DELETE
against the base table. Fragments of the view's definition are copied into that
lowered statement (the view's own `where`, each view column's base-term
expression, an authored `with inverse` put expression, a `with defaults` value),
and the lowered statement is planned on the **caller's** planning context. A
plain column reference survived that move because the lowering had already
rewritten it to a resolved base column — a **sub-select** carried its `from`
names through verbatim and so resolved in the writer's naming environment.

Because the lowered statement is a mix of caller-authored clauses and
definition-derived fragments in one AST, no single context is right for it, so
the fix marks the fragment rather than swapping the context:

1. `AST.SelectStmt.storedHomeSchema?: string` — write-through lowering metadata,
   never set by the parser, inert everywhere else.
2. `PlanningContext.storedBodyOf?: string` — set by `storedBodyContext(ctx, schemaName)`,
   answering "is this context already that body's home environment?".
3. `buildSelectStmt` acts on the marker at the top of the build: swap to
   `storedBodyContext` **and** reset the explicit `parentCTEs` argument, guarded on
   `ctx.storedBodyOf !== stmt.storedHomeSchema`.
4. `mapNestedSelects(query, stamp)` in `mutation/scope-transform.ts` deep-clones
   and stamps every *nested* sub-select root (top-level root not stamped; compound
   legs treated as nested). `rebuildSelect` gained an optional `onMetaExpr`
   (default `cloneExpr`) so the descent also reaches `with inverse` / `with defaults`.
5. `buildViewMutation` applies it once, on a clone, gated on `!view.ephemeral`.

## Review findings

### Checked and clean

- **Read the implement diff before the handoff summary.** The mechanism is sound
  and the comments at each site are accurate, including the two non-obvious ones:
  why `recordDependency` must keep receiving the un-cloned view (the tracker holds
  only a `WeakRef`, so a temporary would let the dependency collapse on GC), and
  why the `parentCTEs` reset is load-bearing independently of the context swap
  (`buildExpressionPositionQueryExpr` passes the caller's `cteNodes` in as an
  explicit argument, which `buildWithContext` prefers over `ctx.cteNodes`).
- **The `{ ...viewIn, selectAst }` spread.** Both concrete inputs are plain data —
  `ViewSchema` is an interface of data fields, and `maintainedTableViewLike`
  (`schema/derivation.ts`) returns a fresh object literal — so nothing is lost to
  the spread. Traced every consumer of the resulting object inside
  `buildViewMutation` for identity dependence: the lens / decomposition / set-op
  lookups all key on `schemaName` + `name`, and the only genuinely
  identity-sensitive consumer (`recordDependency`) is already excluded. The
  planner's `WeakMap` caches key on `TableSchema` / `SchemaManager` /
  `TableDerivation`, never on a view-like.
- **Set-operation spine.** Per-branch synthetic view-likes do not re-enter
  `buildViewMutation` (`buildSetOpMutation` calls the branch write builder
  directly), so the marker is applied exactly once and no dependency is recorded
  twice. The stamped compound legs carry it into each branch.
- **`storedBodyOf` guard.** Correctly makes the marker inert while the body itself
  is planned, which is what lets a body's own `with` clause survive. One
  conditional weakness parked as a tripwire, below.
- **Docs.** Read every doc the change touched *and* grepped the rest of `docs/`
  and `packages/quereus/README.md` for the old "still resolves on the caller's
  path" exception wording — no stale copy remains. The new
  `view-updateability.md` § *Schema resolution during write-through* matches the
  code, and its map row for the body-replan gate is still accurate.
- **Lint and tests.** `yarn lint` (repo-wide; the quereus package's real lint runs
  eslint plus `tsc -p tsconfig.test.json --noEmit`) — clean. `yarn test`
  (repo-wide) — all workspaces green; quereus 8468 passing / 0 failing / 13
  pending. No pre-existing failures surfaced, so `tickets/.pre-existing-error.md`
  was not written.
- **`yarn test:store` not run** — same deferral the implementer recorded, for the
  same reason: this change is plan-time name resolution with no store surface.
  Reasoning, not a run.

### Fixed in this pass (minor)

- **No coverage of the materialized-view side of the funnel.** An MV reaches
  `buildViewMutation` through a different adapter object than a plain view
  (`maintainedTableViewLike` vs `ViewSchema`), and the marker is applied to a
  spread copy of whichever arrives — so the MV path deserved its own pin. Added
  `updates through a temp materialized view whose body predicate holds a
  sub-select` to `test/view-home-schema.spec.ts`; verified passing.

### Filed as a new ticket (major)

- **`fix/bug-view-write-subquery-shadow-analysis-wrong-schema`** — the *analysis*
  that decides whether a reference inside a sub-query is local or reaches outward
  looks its `from` sources up in one fixed schema (the connection's current
  schema), consulting neither the session schema path nor the view's home path.
  Root site: `tableSourceColumnNames` in `mutation/scope-transform.ts`, whose
  `schemaManager.getTable` / `getView` calls take no path. Two arms, both
  reproduced on the current tree:
  - a sub-query in the **user's own** statement over a table reached through
    `pragma schema_path` is rejected with a spurious
    `unsupported-subquery-correlation` diagnostic;
  - a sub-query inside the **view's definition** is sized up against a
    different same-named table, so the lowering re-points a reference that should
    have stayed local — producing `Scalar subquery returned more than one row`
    in the reproduction, and a silently different row set for other column layouts.

  This is adjacent to, not part of, the landed fix: that fix moved *plan-time*
  resolution of definition-derived fragments onto the home path and left this
  analysis on the caller's, so the two now disagree. Both arms were broken before
  this ticket too (differently — the pre-fix plan also bound the caller's table),
  so it is not a regression. A cross-reference line was added to the existing
  `fix/bug-view-write-lineage-subquery-base-table-qualifier`, which lives in the
  same descent at a different site.

### Tripwires (parked in code, not filed)

- `building/select.ts`, at the `storedSwap` guard: the guard compares **schema
  names**, not body identity, so a fragment stamped for view A would also count as
  at-home inside a different body of the same schema. Exact today because that
  needs a nested write-through (a view over a view), which `analyzeView` rejects
  outright. `NOTE:` at the site says to key `storedBodyOf` on the body object if
  that restriction is ever lifted.
- Two tripwires the implementer parked stand as written and were re-checked:
  the per-plan-build deep clone of the body AST in `view-mutation-builder.ts`
  (once per plan, plans are cached; the suite's wall clock did not move), and the
  unstamped `with`-clause CTE bodies in `mapNestedSelects`' doc comment (exact
  until `fix/bug-view-write-body-cte-not-carried-into-lowering` lands).

### Considered and deliberately not actioned

- **`rebuildSelect`'s new `onMetaExpr` default.** The implementer flagged the
  three existing callers (`mapQueryExprUniform`, `transformScopedQuery`,
  `transformAliasScopedQuery`) as worth a second opinion. Leaving them on the
  default is right: each threads a *substitution* it must not apply to the
  metadata clauses (whose refs are `new.`-qualified written-row reads), and
  threading their descent alone would buy nothing — none of them needs to reach a
  sub-select inside those clauses. Their behaviour is byte-identical to before.
- **The behaviour change on `fix/bug-view-write-body-cte-not-carried-into-lowering`'s
  path** (a body sub-select reading the body's own `with` now always errors rather
  than possibly binding a caller table of that name). Confirmed no test asserted
  the old shape and the suite is green; it is a strict improvement on an
  already-broken path, and it is recorded in that ticket's neighbourhood via the
  `view-updateability.md` paragraph.
- **The test-shape caveat the implementer raised** (join-body and set-op-body
  cases put the sub-select in a `where … in (select …)` rather than a join `on`
  condition or a branch projection). Not pursued: those shapes are governed by the
  multi-source / set-op writability analysis, not by the marker, and the marker's
  reach into compound legs is already pinned by the set-op case.
