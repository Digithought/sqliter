---
description: Writing through a view that lives in a schema other than the default one either fails outright or silently writes to the wrong table, because the write path resolves the view's stored definition against the writer's schema search path instead of the view's own schema.
files:
  - packages/quereus/src/planner/mutation/single-source.ts        # analyzeView (~460) and buildCteSelfCapture (~651) plan the body with the caller's ctx
  - packages/quereus/src/planner/mutation/backward-body.ts        # analyzeBodyLineage (~168) — same (used by multi-source AND decomposition/lens)
  - packages/quereus/src/planner/mutation/set-op.ts               # body plans at ~507 and ~1713, per-leg at ~1792; synthetic branch views at ~698 / ~1779
  - packages/quereus/src/planner/building/dml-target.ts           # resolveCteTarget / resolveSubqueryTarget — the EPHEMERAL targets the fix must NOT touch
  - packages/quereus/src/planner/building/view-mutation-builder.ts # dispatch; buildEnvelopeSource (~1028) plans the USER's insert source — leave on caller ctx
  - packages/quereus/src/core/database.ts                         # _homeSchemaPath (~2071) — the composition helper the read side already uses
  - packages/quereus/src/planner/building/select.ts               # PRECEDENT: read-side view expansion swaps in the home path (~451)
  - packages/quereus/test/view-home-schema.spec.ts                # the read-side spec this ticket's tests extend
  - docs/schema.md                                                # line ~335 already states the rule this ticket makes true for writes
difficulty: medium
repro: verified
---

# Writing through a non-`main` view resolves the view's sources against the wrong schema

## What is broken

A stored view / materialized-view body must resolve its unqualified table names
against the **owning object's** schema first, then the database default path —
never against the writing statement's path. `docs/schema.md` § "Stored bodies
resolve against their home schema" already states this, and the read side
implements it (`Database._homeSchemaPath`, wired into `building/select.ts`,
refresh, maintenance, and the static `view_info` / `column_info` probes by
`bug-declared-materialized-view-non-main-schema`).

The **write-through path was left out of that ticket's scope**. Every mutation
entry point re-plans the stored body with the *calling statement's* context, so
write-through resolves the body's sources on the caller's path. Two failure
modes, both reproduced by running code against a clean tree:

**1. Hard failure — the view is readable but not writable.**

```
create table temp.wt (id integer primary key, x integer);
create view temp.wv as select id, x from wt;
select * from temp.wv;                          -- OK (read side already fixed)
insert into temp.wv (id, x) values (1, 11);     -- Table 'wt' not found in schema path: main
update temp.wv set x = 12 where id = 1;         -- same
delete from temp.wv where id = 1;               -- same
```

Meanwhile the static surface says the view *is* writable, so the surface and the
dynamic write disagree — the invariant `docs/view-updateability.md` claims:

```
select schema, name, is_insertable_into, is_updatable, is_deletable from view_info('wv');
-- temp | wv | YES | YES | YES
```

**2. Silent wrong-table write — no error at all.** When the caller's path happens
to reach a *same-named* table in another schema, the write lands there:

```
create table main.lt (id integer primary key, tag text);
insert into main.lt values (1, 'main');
create table temp.lt (id integer primary key, tag text);
insert into temp.lt values (1, 'temp');
create view main.lv as select id, tag from lt;      -- body binds main.lt (home path)
pragma schema_path = 'temp,main';                   -- session now prefers temp
update main.lv set tag = 'w' where id = 1;
select * from main.lt;   -- [{id:1, tag:'main'}]   <-- NOT updated
select * from temp.lt;   -- [{id:1, tag:'w'}]      <-- the write went here
```

The read of `main.lv` returns the `main.lt` row; the update through the same view
in the same session rewrites `temp.lt`. This is the more serious arm — it
corrupts data with no diagnostic.

## Scope: which write paths are affected

Verified broken (all fail today, all fixed by the change below):

| body shape | route | body-plan site |
|---|---|---|
| single-source view | `analyzeView` | `single-source.ts` ~460 |
| single-source view with a selection predicate (default recovery) | `analyzeView` | same |
| join-bodied (multi-source) view | `analyzeBodyLineage` | `backward-body.ts` ~168 |
| set-op membership view (`union exists left as …`) | `analyzeSetOpView` | `set-op.ts` ~507 |
| flag-less set-op view (literal discriminators) | `analyzeFlaglessSetOpView` + per-leg | `set-op.ts` ~1713, ~1792 |
| materialized-view write-through | `analyzeView` | `single-source.ts` ~460 |
| decomposition / lens logical table | `analyzeBodyLineage` | `backward-body.ts` ~168 |

`decomposition.ts` needs **no** change of its own: its only body plan goes through
`analyzeBodyLineage`, and its lowered base ops already name members
schema-qualified (`member.relation.schema`, set from the basis schema in
`schema/mapping-advertisement-tags.ts`). The same holds for the single-source /
multi-source lowerings — `tableIdentifier(table)` emits `schema: table.schemaName`
off the plan-resolved `TableSchema`, so once the body plans on the right path the
base ops are explicit.

## The fix, and the one trap in it

At each body-plan site, swap the schema path for the **body** plan only:

```ts
buildSelectStmt({ ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) }, sel)
```

The caller's own predicate / SET / RETURNING expressions and the user's
`insert … select` source (`view-mutation-builder.ts` `buildEnvelopeSource`) keep
`ctx` untouched — verified: a user `where id in (select id from side)` still binds
the caller-path `side`.

**Trap — ephemeral targets must be excluded.** A CTE-name DML target and an
inline-subquery DML target (`update (select …) as v …`) route through the *same*
substrate via an ephemeral `MutableViewLike` built in
`planner/building/dml-target.ts`. Those carry
`schemaName: ctx.schemaManager.getCurrentSchemaName()`, documented in that file
as **cosmetic** — they are not stored objects and their bodies MUST resolve on the
caller's path. Applying the swap ungated breaks them; measured on a one-site
patch of `analyzeView` alone:

```
create table temp.et (id integer primary key, x integer);
update (select id, x from et) as v set x = 99 where id = 1 with schema "temp";
-- before: OK.  with an ungated fix: Table 'et' not found in schema path: main
with c as (select id, x from et) update c set x = 77 where id = 1 with schema "temp";
-- same regression; likewise the CTE self-read form that drives buildCteSelfCapture
```

(`temp` is a keyword, hence `with schema "temp"`.) There is **no sqllogic or spec
coverage** for `with schema` on an ephemeral DML target today, so this regression
would land silently — the guard tests below are not optional.

So the swap must be gated on `!view.ephemeral`. Put the gate in exactly one place:

```ts
// planner/mutation/body-context.ts (new, or an existing shared module in that dir)
/**
 * The planning context a STORED view/MV body plans under: its own schema first,
 * then the database default path (Database._homeSchemaPath), independent of the
 * writing statement's path. An EPHEMERAL target (a CTE body / inline-subquery
 * target — dml-target.ts) is part of the caller's statement, not a stored object:
 * its `schemaName` is cosmetic and its body must keep the caller's path verbatim.
 */
export function bodyPlanningContext(ctx: PlanningContext, view: MutableViewLike): PlanningContext {
	if (view.ephemeral) return ctx;
	return { ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) };
}
```

Watch the module graph when siting it: `set-op.ts` imports `propagate`, never the
reverse (`propagate.ts` ~259 pins that direction), so a standalone module with no
mutation-internal imports is the safe home.

**Second-order trap — synthetic branch views drop the flag.** `set-op.ts` builds
per-branch / per-leg `MutableViewLike`s (~698 and ~1779) that inherit
`view.schemaName` but **not** `view.ephemeral`. An ephemeral membership-set-op
target *does* reach `buildSetOpMutation` (the membership dispatch at
`view-mutation-builder.ts` ~100 is not ephemeral-gated, unlike the flag-less one
at ~113), so a branch of an ephemeral target would re-acquire the home path
through the back door. Propagate `ephemeral` onto both synthetic branch views.

## Expected behavior

- `insert` / `update` / `delete` through a view or materialized view in any schema
  succeeds whenever the same statement's `select` through it succeeds, for every
  body shape in the table above.
- A write through a stored view binds the same base tables the read binds, under
  any session `schema_path` and any statement-level `with schema` — including the
  collision case where both the home schema and the caller's path hold a table of
  that name.
- The caller's WHERE / SET / RETURNING expressions and the `insert … select`
  source still resolve on the caller's path.
- `main`-schema write-through is byte-identical (`_homeSchemaPath('main')` under
  the default `schema_path` is today's path).
- Ephemeral CTE-name and inline-subquery DML targets are unchanged under both a
  session path and a statement `with schema`.

## Known adjacent defect — do not trip over it

An **unqualified view name in a FROM clause never resolves through the schema
path at all** (`building/select.ts` ~433 looks only in
`getCurrentSchemaName()`), so `create view temp.nv2 as select id, x from nv1`
fails even with `nv1` in `temp`. Filed separately as
`fix/bug-unqualified-view-name-ignores-schema-path`. Consequence for this ticket:
do **not** write a test that composes one non-`main` view over another by
unqualified name — it fails for that unrelated reason. Qualify the inner name if
such a case is needed.

That defect also masks a latent hole here: `analyzeView`'s nested-view and
maintained-table guards (`single-source.ts` ~497 / ~513) look the body's FROM name
up with `getView(fromTable.table.schema ?? null, …)` / `getMaintainedTable(…)`,
which resolve against the *current* schema, not the body's home path. The MV arm
is covered by the plan-resolved `isMaintainedTable(baseTable)` fallback right
beside it (verified: the MV-over-MV reject still fires correctly for a `temp`
view). The plain-view arm has no such fallback — it is unreachable only because
of the adjacent defect above.

## TODO

- Add the shared `bodyPlanningContext(ctx, view)` helper described above, with the
  `view.ephemeral` gate and the doc comment explaining why ephemeral is excluded.
- Use it at all six body-plan sites: `single-source.ts` `analyzeView` (~460) and
  `buildCteSelfCapture` (~651); `backward-body.ts` `analyzeBodyLineage` (~168);
  `set-op.ts` `analyzeSetOpView` (~507), `analyzeFlaglessSetOpView` (~1713), and
  `buildFlaglessLeg` (~1792).
- Propagate `ephemeral` onto the synthetic branch views in `set-op.ts` (~698,
  ~1779) so a branch of an ephemeral target keeps the caller's path.
- Leave `view-mutation-builder.ts` `buildEnvelopeSource` (~1028) on `ctx` — that
  is the user's `insert … select` source, not the stored body.
- Add a `NOTE:` comment at `single-source.ts` ~497 recording that the nested-view
  name guard resolves against the current schema rather than the body's home path,
  and that it becomes reachable once
  `bug-unqualified-view-name-ignores-schema-path` lands.

Tests — extend `packages/quereus/test/view-home-schema.spec.ts` with a
write-through `describe` (it already owns the read-side half of this rule):

- Single-source view in `temp` whose body reads a sibling table unqualified:
  insert, update, delete, each verified against the base table.
- Single-source view in `temp` with a selection predicate (`where kind = 'a'`):
  insert recovers the pinned column.
- Join-bodied view in `temp`: update through it.
- Membership set-op view in `temp` (`union exists left as inl, exists right as
  inr`): read the probes, data update, flag-routed insert, delete fan-out.
- Flag-less set-op view in `temp` (literal-discriminator legs, the shape in
  `test/logic/93.6-set-op-flagless-write.sqllogic`): insert, update, delete.
- Materialized-view write-through in `temp`: insert and update.
- Collision: `main.ct` and `temp.ct` both exist; a write through `temp.cv` (body
  `from ct`) hits `temp.ct` and leaves `main.ct` untouched.
- Session-path leak: `main.lv` over `main.lt` with `pragma schema_path =
  'temp,main'` and a `temp.lt` present — the write must land in `main.lt` (this is
  failure mode 2 above; it currently writes the wrong table with no error).
- Caller-path preservation: a user `where … in (select id from side)` where `side`
  exists in both schemas resolves the caller's one.
- Ephemeral guards (the regression this fix can silently cause), each under
  `with schema "temp"` against a `temp`-only table: inline-subquery target
  (`update (select …) as v …`), CTE-name target, and the CTE self-read form
  (`… where id in (select id from c)`, which drives `buildCteSelfCapture`).
- `main`-schema controls for the single-source and set-op shapes, unchanged.

Validation:

- `yarn workspace @quereus/quereus run test` — the view-mutation surface is dense;
  pay particular attention to `test/logic/93.*.sqllogic`,
  `test/logic/53.1-materialized-view-write-through.sqllogic`,
  `test/logic/06.4-schema-search-path.sqllogic`, and
  `test/plan/view-dependency-invalidation.spec.ts`.
- `yarn lint` and `yarn typecheck`.
- `docs/schema.md` ~335 already states the rule; check whether
  `docs/view-updateability.md` needs a sentence noting that write-through resolves
  the body on the home path while user clauses stay on the caller's, and update it
  if the write half is not already covered there.
