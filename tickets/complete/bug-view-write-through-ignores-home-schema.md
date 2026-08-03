---
description: Writing through a view that lives in a schema other than the default one used to fail outright, or silently write to a same-named table in the wrong schema; writes now resolve the view's stored definition the same way reads do.
files:
  - packages/quereus/src/planner/mutation/body-context.ts        # NEW — the single gate (`bodyPlanningContext`)
  - packages/quereus/src/planner/mutation/single-source.ts       # analyzeView (~462), buildCteSelfCapture (~664), NOTE at ~500
  - packages/quereus/src/planner/mutation/backward-body.ts       # analyzeBodyLineage (~171)
  - packages/quereus/src/planner/mutation/set-op.ts              # body plans ~510 / ~1722, per-leg ~1809; branch views ~702 / ~1788
  - packages/quereus/test/view-home-schema.spec.ts               # +17 tests in a `view write-through` describe
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic # +Tests 18/19 (added at review) — runs in store mode too
  - docs/view-updateability.md                                   # "Schema resolution during write-through" section + impl-map row
  - docs/schema.md                                               # "Stored bodies…" paragraph now says reads AND writes
repro: verified
---

# View write-through resolves the body on the view's home schema

A stored view / materialized-view body resolves its unqualified table names
against the **owning object's** schema first, then the database default path.
Reads already did this. Writes re-planned the body with the *calling statement's*
context, so a write through a non-`main` view either errored
(`Table 'wt' not found in schema path: main`) or, when the caller's path reached a
same-named table in another schema, silently wrote **that** table.

One helper is the fix:

```ts
// planner/mutation/body-context.ts
export function bodyPlanningContext(ctx: PlanningContext, view: MutableViewLike): PlanningContext {
	if (view.ephemeral) return ctx;
	return { ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) };
}
```

applied at all six body-plan sites under `planner/mutation/` (`analyzeView`,
`buildCteSelfCapture`, `analyzeBodyLineage`, `analyzeSetOpView`,
`analyzeFlaglessSetOpView`, `buildFlaglessLeg`), plus `ephemeral` propagation onto
the synthetic per-branch / per-leg view-likes in `set-op.ts` so a branch of an
ephemeral target cannot re-acquire the home path through its inherited (cosmetic)
`schemaName`.

An **ephemeral** DML target — a CTE name, or an inline `update (select …) as v`
— is part of the caller's statement, not a stored object, so it keeps the
caller's path. That gate is load-bearing and is what the guard tests protect.

## Review findings

### Checked

- **The implement diff first, before the handoff summary.** Then every
  `buildSelectStmt` call site under `planner/mutation/` (6 — all gated) and every
  *other* stored-body plan seam in the engine, to confirm the new gate agrees with
  them rather than contradicting: read-side view expansion and the materialized-view
  stale re-validation (`planner/building/select.ts` ~451 / ~541), the `view_info` /
  `column_info` probes (`func/builtins/schema.ts` ~774 / ~810 / ~829 / ~1220), and
  the MV plan builders (`core/database-materialized-views-plan-builders.ts`). All
  already compose the same home path; no seam was left on the caller's context.
- **Whether the lowered base statement can re-resolve the base table itself.** It
  cannot: `single-source.ts` ~207, `multi-source.ts` ~2957 and `decomposition.ts`
  ~2183 all emit a schema-**qualified** identifier taken from the resolved
  `TableSchema`, so the base target is pinned by the body plan.
- **That `{ ...ctx, schemaPath }` is a safe shallow swap.** `outputScopes`,
  `cteNodes` and the build caches are shared by reference, so the downstream
  `ctx.outputScopes.get(joinNode)` reads in the join / set-op capture builders still
  hit the scopes the swapped context registered. The join and set-op tests exercise
  exactly this and pass.
- **The lens path**, which reaches `analyzeBodyLineage` through a compiled
  `ViewSchema` whose *basis* lives in a different schema than the logical one
  (`schema/lens-compiler.ts` ~217). Safe: the read path already plans that same body
  on the same logical home path, so the compiled body's basis references must
  already be schema-qualified.
- **That the `ephemeral` gate is load-bearing**, independently of the implementer's
  claim: temporarily forcing `bodyPlanningContext` to `return ctx` makes the newly
  added sqllogic case fail (`Table 'products' not found in schema path: main`), and
  the change was reverted after measuring.
- **Docs**, by reading every file the change touched and the ones it should have —
  `docs/schema.md`, `docs/view-updateability.md`, `docs/sql-ddl.md` (assertion home
  schema, unaffected), `docs/sql-alter.md`.
- Lint, typecheck (via `yarn lint`, which type-checks the spec files) and the full
  `yarn test`, plus a targeted **store-mode** run of the sqllogic file below — the
  one validation the implementer flagged as not exercised.

### Found — major, filed as a ticket

- **A subquery inside a body-derived expression still resolves on the caller's
  path.** The gate covers the body *plan*. It does not cover the fragments the
  lowering copies into the base statement (the view's own `where`, and each view
  column's base-term expression), which are planned with the rest of the lowered
  statement on the caller's context (`buildBaseOp`). A plain column reference is
  already fully resolved by then; a **subquery** carries its `from` names through
  verbatim. Two arms, one site:
  - `update` / `delete` through *any* non-`main` view whose body has a subquery
    fails with `Table 'b' not found in schema path: main`, while
    `view_info` reports `is_updatable = YES` and the read works — the same
    surface/behaviour disagreement this ticket set out to remove. Reproduced for
    single-source, join, and membership set-op bodies, and for a body whose `from`
    is qualified but whose subquery is not (which proves the failure comes from the
    copied predicate, not the body plan). `insert` is unaffected.
  - Even in `main`, under a session `schema_path` that reaches a same-named table,
    the write silently affects **no rows** and reports success.

  The second arm is **pre-existing**, verified by disabling this ticket's swap and
  re-running: identical outcome. Filed as
  `fix/bug-view-write-subquery-in-body-uses-caller-schema` (repro: verified). Not
  fixed here — the lowered statement is a mix of caller-authored and
  definition-derived AST, so no single schema path is correct for it; the
  resolution has to be decided per fragment at the copy site
  (`planner/mutation/scope-transform.ts`), which is a design change, not a patch.

### Found — minor, fixed in this pass

- **Both docs overclaimed.** `docs/schema.md` and `docs/view-updateability.md` both
  asserted, without qualification, that a write binds the same base tables the
  matching read does. Scoped to the truth and pointed at the new ticket.
- **No sqllogic coverage** (the implementer's own listed gap). Added Tests 18/19 to
  `test/logic/06.4-schema-search-path.sqllogic`: insert/update/delete through a view
  stored in the declared `myapp` schema under a `main` session path, and the
  home-schema-beats-session-path collision arm. Confirmed it fails without the fix
  and passes with it, in **both** memory and store mode — so the change now has
  store-path coverage.

### Found — nothing, and why

- **No missed body-plan site.** Enumerated exhaustively (above), not sampled.
- **No resource-cleanup finding**: the change allocates nothing and opens nothing —
  it returns a spread object.
- **No error-handling or type-safety finding**: no `catch`, no `any`, no cast, and
  no diagnostic text was added or altered.
- **No source-size finding**: `body-context.ts` is 26 lines including its doc
  comment (measured with `wc -l`); no touched file grew by more than ~20 lines.
- **No performance finding claimed**: `_homeSchemaPath` re-parses the `schema_path`
  option string on each call and write-through now calls it once per body plan.
  This was **not** measured, so no magnitude is asserted; the existing `NOTE:` at
  `core/database.ts` ~2072 already records the memoization option and is the right
  home for it.

### Tripwires

- None new. Two conditional concerns already carry `NOTE:`-style comments at their
  exact sites and were left there rather than duplicated: the nested-view name guard
  in `single-source.ts` ~500 (unreachable until
  `fix/bug-unqualified-view-name-ignores-schema-path` lands, and that ticket already
  names it), and the `_homeSchemaPath` re-parse cost in `core/database.ts` ~2072.
- The `ephemeral` propagation in `buildFlaglessLeg` is unreachable today (the
  flag-less dispatch is itself `!view.ephemeral`-gated) and the code comment says
  so. Kept: it is two tokens, it makes the two synthetic-branch builders identical,
  and removing it would become a silent wrong-table write the moment that gate
  changes.

## Validation

- `yarn test` — 8439 passing / 13 pending in `packages/quereus`, every other
  workspace green, 0 failing.
- `yarn lint` — clean (includes the `tsc -p tsconfig.test.json` pass over the specs).
- `QUEREUS_TEST_STORE=true` targeted run of `06.4-schema-search-path.sqllogic` — passing.
- No pre-existing failures surfaced.
