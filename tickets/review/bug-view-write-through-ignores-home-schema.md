---
description: Writing through a view that lives in a schema other than the default one used to fail outright, or silently write to a same-named table in the wrong schema; writes now resolve the view's stored definition the same way reads do.
files:
  - packages/quereus/src/planner/mutation/body-context.ts        # NEW — the single gate (`bodyPlanningContext`)
  - packages/quereus/src/planner/mutation/single-source.ts       # analyzeView (~462), buildCteSelfCapture (~664), NOTE at ~500
  - packages/quereus/src/planner/mutation/backward-body.ts       # analyzeBodyLineage (~171)
  - packages/quereus/src/planner/mutation/set-op.ts              # body plans ~510 / ~1722, per-leg ~1807; branch views ~700 / ~1786
  - packages/quereus/test/view-home-schema.spec.ts               # +17 tests in a new `view write-through` describe
  - docs/view-updateability.md                                   # new "Schema resolution during write-through" section + impl-map row
  - docs/schema.md                                               # "Stored bodies…" paragraph now says reads AND writes
difficulty: medium
repro: verified
---

# Review: view write-through now resolves the body on the view's home schema

## What changed

A stored view / materialized-view body must resolve its unqualified table names
against the **owning object's** schema first, then the database default path. The
read side already did this (`Database._homeSchemaPath`, wired into
`building/select.ts`, refresh, maintenance, and the `view_info` / `column_info`
probes). The **write** side re-planned the body with the *calling statement's*
context, so a write through a non-`main` view either errored
(`Table 'wt' not found in schema path: main`) or, when the caller's path reached a
same-named table in another schema, silently wrote **that** table with no
diagnostic.

One new helper is the whole fix:

```ts
// planner/mutation/body-context.ts
export function bodyPlanningContext(ctx: PlanningContext, view: MutableViewLike): PlanningContext {
	if (view.ephemeral) return ctx;
	return { ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) };
}
```

It is applied at all six body-plan sites the ticket named:

| site | file |
|---|---|
| `analyzeView` (single-source views + MV write-through) | `single-source.ts` ~462 |
| `buildCteSelfCapture` (the CTE self-read second body plan) | `single-source.ts` ~664 |
| `analyzeBodyLineage` (multi-source / decomposition / lens) | `backward-body.ts` ~171 |
| `analyzeSetOpView` (membership set-op body) | `set-op.ts` ~510 |
| `analyzeFlaglessSetOpView` (flag-less set-op body) | `set-op.ts` ~1722 |
| `buildFlaglessLeg` (per-leg oracle plan) | `set-op.ts` ~1807 |

Plus the second-order trap: the synthetic per-branch / per-leg `MutableViewLike`s
in `set-op.ts` (~700, ~1786) now carry the target's `ephemeral` flag, so a branch
of an ephemeral target cannot re-acquire the home path through the inherited
(cosmetic) `schemaName`.

`view-mutation-builder.ts` `buildEnvelopeSource` was deliberately left on `ctx` —
that plans the *user's* `insert … select` source, not the stored body.

A `NOTE:` was added at `single-source.ts` ~500 recording that the nested-view name
guard (`getView(fromTable.table.schema ?? null, …)`) resolves against the current
schema rather than the body's home path, and that it becomes reachable once
`fix/bug-unqualified-view-name-ignores-schema-path` lands.

## The `ephemeral` gate is load-bearing — please attack it

A CTE-name DML target and an inline-subquery DML target (`update (select …) as v
…`) route through the *same* substrate via an ephemeral `MutableViewLike` built in
`planner/building/dml-target.ts`. Those are part of the caller's statement, not
stored objects, and their bodies must keep the caller's path. Applying the swap
ungated breaks them, and there is **no sqllogic coverage** for `with schema` on an
ephemeral DML target — so the guard tests in the spec are the only thing standing
between that gate and a silent regression.

Measured both directions (temporary local edits, reverted):

- Gate the swap off entirely (`return ctx` always) → **11 of 17** new tests fail;
  the 3 ephemeral guards and the 2 `main` controls still pass.
- Remove only the `view.ephemeral` early return → the **3 ephemeral guards** fail
  and everything else passes.
- Remove only the `ephemeral` propagation onto the flagged synthetic branch view
  → the set-op ephemeral test fails with a **silent wrong-table write**
  (`temp.sl` left at 10, the write landed in `main.sl`), no error raised.

## Testing / validation done

`packages/quereus/test/view-home-schema.spec.ts` gained a
`home-schema body resolution (view write-through)` describe — 17 tests, all
passing, covering:

- single-source view in `temp`: insert / update / delete, each checked against the
  base table; plus a `view_info('wv')` agreement test (static surface said
  writable while the dynamic write threw — that disagreement is the user-visible
  symptom)
- single-source view in `temp` with a selection predicate — the insert recovers
  the pinned `kind` column
- join-bodied view in `temp` — update routes to the owning side only
- membership set-op view in `temp` — probe read, data update, flag-routed insert,
  delete fan-out
- flag-less set-op view in `temp` (literal-discriminator legs) — insert / update /
  delete
- materialized-view write-through in `temp` — insert and update, base and backing
  both checked
- **collision**: `main.ct` and `temp.ct` both exist; a write through `temp.cv`
  hits `temp.ct` and leaves `main.ct` untouched
- **session-path leak**: `main.lv` over `main.lt` under
  `pragma schema_path = 'temp,main'` with a `temp.lt` present — the write lands in
  `main.lt` (this is the silent-corruption arm)
- caller-path preservation: a user `where id in (select id from side)` and an
  `insert … select from src`, each with `side` / `src` present in *both* schemas,
  resolve the caller's one
- ephemeral guards under `with schema "temp"`: inline-subquery target, CTE-name
  target, the CTE self-read form (drives `buildCteSelfCapture`), and a
  set-op-bodied CTE target with same-named tables in both schemas
- `main`-schema controls for the single-source and membership set-op shapes

Full validation, all green:

- `yarn test` — 8439 passing / 13 pending in `packages/quereus`, every other
  workspace green, exit 0. Includes `test/logic/93.*.sqllogic`,
  `test/logic/53.1-materialized-view-write-through.sqllogic`,
  `test/logic/06.4-schema-search-path.sqllogic`, and
  `test/plan/view-dependency-invalidation.spec.ts`.
- `yarn lint` — exit 0.
- `yarn typecheck` — exit 0.

Not run: `yarn test:store` (the LevelDB-backed re-run). This change is entirely in
the planner's schema-path composition and touches no storage path, so the store
run should be unaffected — but it was not exercised.

## Known gaps / things worth a skeptical look

- **Flag-less branch `ephemeral` propagation is untestable today.** Unlike the
  membership dispatch, the flag-less dispatch in `view-mutation-builder.ts` ~113
  *is* `!view.ephemeral`-gated, so no ephemeral target reaches `buildFlaglessLeg`.
  The propagation there is defensive and the code comment says so. If a reviewer
  thinks unreachable-defensive code should not ship, that is a fair call —
  removing it is safe today and unsafe the moment that gate changes.
- **`buildCteSelfCapture` gets the helper but is always ephemeral.** The call
  there is a no-op by construction (`analyzeView`, which it delegates to, already
  applied the same helper). It is there so the two body plans in that function
  provably share one context rather than diverging if the CTE-target invariant
  ever loosens. Arguably noise.
- **Latent hole left in place, deliberately.** `analyzeView`'s nested-view name
  guard (`single-source.ts` ~500) still resolves the body's FROM name against the
  *current* schema, not the body's home path. It is unreachable because an
  unqualified view name in a FROM clause never resolves through the schema path at
  all — tracked as `fix/bug-unqualified-view-name-ignores-schema-path`. Marked
  with a `NOTE:` at the site. The MV arm beside it is already covered by the
  plan-resolved `isMaintainedTable(baseTable)` fallback; the plain-view arm is
  not. If the reviewer disagrees that this is genuinely unreachable, it is a real
  latent defect, not a tripwire.
- **No sqllogic coverage added.** All new coverage is in the TypeScript spec,
  because the interesting cases need a session `pragma schema_path` change
  mid-file and a `with schema` on an ephemeral target — both awkward in the
  sqllogic harness, and the `with schema` + ephemeral combination has no existing
  sqllogic precedent to copy. A reviewer may reasonably want the plain
  non-`main` write-through arm mirrored into `test/logic/06.4-schema-search-path.sqllogic`.
- **Nothing was done about the cost of `_homeSchemaPath`.** It re-parses the
  `schema_path` option string on every call, and write-through now calls it once
  per body plan (twice for a self-reading CTE, once per leg for a flag-less
  set-op). The existing `NOTE:` in `core/database.ts` ~2081 already flags the
  memoization option; no new note added. Not measured.

## Review findings

(to be filled in by the review stage)
