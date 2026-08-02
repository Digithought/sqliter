----
description: Writing through a view that lives in a schema other than the default one fails, because the write path resolves the view's stored body against the writer's schema search path instead of the view's own schema.
files:
  - packages/quereus/src/planner/mutation/single-source.ts   # analyzeView (~460) and buildCteSelfCapture (~651) plan the body with the caller's ctx
  - packages/quereus/src/planner/mutation/backward-body.ts   # analyzeBodyLineage (~168) — same
  - packages/quereus/src/planner/mutation/set-op.ts          # body plans at ~507, ~1713, and per-leg at ~1792 — same
  - packages/quereus/src/planner/mutation/decomposition.ts   # check the lens body-plan site (~667) for the same pattern
  - packages/quereus/src/core/database.ts                    # _homeSchemaPath — the composition helper the read side already uses
  - packages/quereus/src/planner/building/select.ts          # PRECEDENT: read-side view expansion swaps in the home path (~447)
difficulty: medium
repro: verified
----

# Writing through a non-`main` view can't resolve the view's own sources

## What is broken

The read side of this defect was fixed by
`bug-declared-materialized-view-non-main-schema`: a stored view /
materialized-view body now resolves its unqualified names against the owning
object's schema first (`Database._homeSchemaPath` — home schema, then the
session default path). Reads, refresh, backing derivation, and maintenance
compilation all use it.

The **write-through path was deliberately left out of that ticket's scope** and
still resolves the body against the caller. Reproduced by running code:

```
create table temp.wt (id integer primary key, x integer);
create view temp.wv as select id, x from wt;
select * from temp.wv;                          -- OK (read side fixed)
insert into temp.wv (id, x) values (1, 11);
-- Table 'wt' not found in schema path: main
update temp.wv set x = 12 where id = 1;
-- Table 'wt' not found in schema path: main
```

So a view is readable but not writable purely as a function of which schema it
lives in — an inconsistency users will hit as soon as they write through any
non-`main` view whose body uses unqualified names.

## Where the fix goes

The mutation substrate re-plans the view's stored body with the calling
statement's planning context at each of these sites (each already has the
view — a `MutableViewLike` carrying `schemaName` — in scope):

- `single-source.ts` `analyzeView` and `buildCteSelfCapture`
- `backward-body.ts` `analyzeBodyLineage`
- `set-op.ts` — the membership-body plan, the flag-less-body plan, and
  `buildFlaglessLeg`'s per-leg plan (legs are slices of the stored body, so
  they take the same rule)
- `decomposition.ts` — verify whether the lens body-plan site needs it too
  (a lens deploys as an ordinary view; its body may be synthesized rather than
  authored, so it may already be fully qualified)

The fix at each site is the read-side pattern: plan the body with
`{ ...ctx, schemaPath: ctx.db._homeSchemaPath(view.schemaName) }` — swap the
path only for the *body* plan, never for the user's own predicate / SET /
RETURNING expressions, which must keep the caller's context.

## Expected behavior

- `insert` / `update` / `delete` through a view in any schema succeeds when the
  same statement's `select` through it succeeds.
- The user's WHERE / SET / RETURNING expressions still resolve under the
  caller's path (only the stored body switches to the home path).
- Existing `main`-schema write-through behavior is byte-identical
  (`_homeSchemaPath('main')` equals today's default path).

## Test expectations

- Insert / update / delete through a non-`main` (e.g. `temp`) single-source view
  whose body reads a sibling table unqualified, under the default session path.
- A set-operation-bodied writable view in a non-`main` schema (the membership
  and flag-less forms), same conditions.
- A name-collision case: the body must bind the home-schema table when both
  `main` and the view's schema hold a table of that name (mirror the read-side
  spec `test/view-home-schema.spec.ts`).
