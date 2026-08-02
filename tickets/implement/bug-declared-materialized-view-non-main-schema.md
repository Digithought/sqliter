----
description: A view or materialized view that lives in a schema other than the default one cannot find the tables it reads from, so declaring one and applying the declaration fails outright.
files:
  - packages/quereus/src/planner/building/select.ts               # view expansion at reference time (~line 443)
  - packages/quereus/src/planner/building/create-view.ts          # buildCreateViewStmt / planViewBody
  - packages/quereus/src/planner/building/materialized-view.ts    # buildCreateMaterializedViewStmt (~line 51)
  - packages/quereus/src/planner/building/ddl.ts                  # `create table … maintained as` body (line 41)
  - packages/quereus/src/planner/building/alter-table.ts          # `alter table … set maintained as` body (line 186)
  - packages/quereus/src/planner/building/constraint-builder.ts   # PRECEDENT: home-schema resolution, lines 154-167
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # PRECEDENT: same pattern, lines 290-297
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # body re-plan seams: 146, 351-356, 514, 1116, 1533, 2608, 2654
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts # buildMaintenancePlan, line 184
  - packages/quereus/src/core/database.ts                         # prepare (467), getPlan (1883), _buildPlan (2046), _buildProbeContext (2016)
  - packages/quereus/src/schema/schema-differ.ts                   # renderFreshTableCreate (1049), view creates (711, 723, 731)
  - packages/quereus/src/schema/catalog.ts                         # lines 805-838 already qualify view/MV names — mirror it
  - packages/quereus/test/logic/50-declarative-schema.sqllogic     # declarative coverage
  - packages/quereus/test/tmp-repro.spec.ts                        # leftover always-passing debug spec — delete
difficulty: hard
repro: verified
----

# Views and materialized views can't resolve their own sources outside `main`

## What is broken

Two independent defects that together make the reported case fail. Both were
reproduced by running code, not inferred.

### 1. A stored body resolves against the *caller*, not against its own schema

When a query references a view, the engine re-plans the view's stored body using
the calling statement's schema search path. Same for a materialized view: its
body text is re-prepared on refresh, on backing-shape derivation, and on
maintenance planning — each time against whatever path happens to be current.

So an unqualified table name inside the body means "whatever the *reader's* path
resolves it to", not "the table sitting next to this view". Observed directly:

```
create table temp.t (id integer primary key, x integer);
create materialized view temp.mv as select id, x from t;
-- Table 't' not found in schema path: main
--   Did you mean: temp.t?
```

Even setting the path so the create succeeds only defers the failure — the body
is re-planned later with the path reset:

```
pragma schema_path = 'main,temp';
create materialized view temp.mv as select id, x from t;   -- OK
pragma schema_path = 'main';
refresh materialized view temp.mv;
-- Table 't' not found in schema path: main
```

And for a plain view, the *read* breaks:

```
create view vpol.vpol_v as select id, x from vpol_t;   -- (created with vpol on the path)
select * from vpol.vpol_v;                             -- default path
-- Table 'vpol_t' not found in schema path: main
```

This is a standalone, user-visible bug — nothing to do with declared schemas.

**The codebase already resolves this the right way everywhere else.** CHECK
constraints (`constraint-builder.ts:154-167`) and foreign keys
(`foreign-key-builder.ts:290-297`) both plan their bodies with
`schemaPath = [tableSchema.schemaName]` plus a temporary current-schema switch,
precisely so unqualified references inside a stored expression resolve next to
the object that owns them. Views and materialized views are the outliers.

### 2. The declarative migration renderer forgets the target schema

`apply schema X` turns the difference into plain SQL statements and executes each
one. Tables and indexes get an explicit `X.` prefix (`applyTableDefaults`,
`applyIndexDefaults` in `schema-differ.ts`). Views and materialized views get no
prefix on their own name, so they would land in the current schema even once
defect 1 is fixed. `catalog.ts:805-838` already applies exactly this
qualification for the same statements on the baseline-emission path — the differ
simply never got the same treatment.

Note the drop side already qualifies (`DROP VIEW IF EXISTS vpol.vpol_v` in
`generateMigrationDDL`), so today a re-apply emits a qualified drop paired with an
unqualified create.

## Why the fix goes in the resolver, not the renderer

There were two candidate shapes. Both were built as end-states and diffed.

**Rejected — rewrite the body's references into the generated DDL** (store
`select id, x from mvpol.mvpol_t`). This breaks the declarative pipeline's
idempotency requirement. Measured: after hand-creating that exact end state,
`diff schema mvpol` reports outstanding work forever, because the differ compares
the declared body text (`… from mvpol_t`) against the stored body text
(`… from mvpol.mvpol_t`):

```
diff schema mvpol
-> alter table mvpol.mvpol_mv set maintained as select id, x from mvpol_t
```

Making that converge would mean applying the same qualifying rewrite to the
declared side of every canonical-body comparison, and building a scope-aware
reference rewriter (aliases, CTEs, subqueries) to do it — for a result that is
still only cosmetically different.

**Chosen — resolve a body against its home schema.** Measured: with the body
stored unqualified and the MV created under a path that includes its home schema,
`diff schema mvpol` returns **no rows** immediately. Zero changes needed to any
comparison or canonicalization code, and it fixes the standalone refresh and
plain-view read failures above as a side effect.

### Path composition

Recommendation: a body plans with `[<object's schema>, ...<database default
path>]`, deduped. Home schema wins, and nothing that resolves today stops
resolving (notably a `main` view that reads a `temp` table unqualified, which the
default `main, temp` order allows).

The constraint/FK precedent uses the stricter exclusive form
(`[tableSchema.schemaName]`, no fallback). Aligning the two is worth doing but is
not this ticket — if you pick the exclusive form here instead, say so in the
handoff and confirm the `temp` case above.

The database *default* path is the right base, not the calling statement's path:
a statement-level `with schema …` clause is the caller's business and must not
leak into a stored object's resolution, which is exactly the caller-dependence
that makes refresh fail today.

## Expected behavior

- A view or materialized view declared in any schema applies, lands in that
  schema, and resolves its sources there.
- A re-`diff` immediately after `apply schema` reports no remaining difference.
- `refresh materialized view` works regardless of the session's schema path.
- Reading a non-`main` view under the default path works.

## Adjacent, deliberately out of scope

- **Assertions** are broken the same way but at a different site — the grammar has
  no schema qualifier for an assertion name at all (`AST.CreateAssertionStmt.name`
  is a bare string), so a declared assertion in a non-`main` schema silently lands
  in `main` and `diff schema` re-emits it on every run. Tracked separately as
  `bug-declared-assertion-ignores-target-schema`. Do not widen this ticket into it.
- An **unqualified view name** in a `from` clause resolves only against the current
  schema, never the schema path (`select.ts:433`), unlike an unqualified table
  name. Pre-existing and unchanged by this work; only noting it so it isn't
  mistaken for a regression.

## TODO

### Phase 1 — bodies resolve against their home schema

- Add one shared helper that composes a body's schema path from the owning
  object's schema name plus the database default path, so every site below uses
  the same rule (and one place documents it).
- Thread an optional schema-path override through `Database._buildProbeContext`
  → `_buildPlan` → `getPlan` / `prepare` (`core/database.ts` 2016 / 2046 / 1883 /
  467). The MV body re-plan seams only have `bodySql` in hand today, so this is
  the plumbing they need. Consider whether the existing
  `withSuppressedMaterializedViewRewrite` ambient seam is a better carrier —
  explicit parameter preferred unless it forces awkward signatures.
- Plan the body with the home path at create time: `buildCreateViewStmt`
  (`create-view.ts`), `buildCreateMaterializedViewStmt`
  (`materialized-view.ts:51`), `create table … maintained as` (`ddl.ts:41`),
  `alter table … set maintained as` (`alter-table.ts:186`).
- Plan the body with the home path at reference time: the view-expansion branch
  in `select.ts` (~443-452) currently passes `parentContext` straight through.
- Thread the MV's `schemaName` into every body re-plan in
  `materialized-view-helpers.ts`: `deriveBackingShapeUnguarded` (146),
  `collectBodyRows` (351/356) and its callers (514, 1116, 1533), `revalidateBody`
  (2648-2654) and the sibling `getPlan` at 2608.
- Thread it into maintenance planning:
  `database-materialized-views-plan-builders.ts:184`.
- Check whether the current-schema switch the constraint builder performs
  alongside the path override is also needed here, or whether the path alone
  suffices — the DDL-landing-vs-read asymmetry documented in
  `docs/sql-select.md` §"DDL landing vs. read resolution" is the thing to reason
  against.

### Phase 2 — the differ qualifies view and materialized-view names

- `renderFreshTableCreate` (`schema-differ.ts:1049`): when the declared item is a
  materialized view and the target schema is not `main`, set the view's schema
  before rendering — mirror `applyTableDefaults` and the identical block already
  in `catalog.ts:822-838`.
- Same for the three plain-view renders at `schema-differ.ts` 711, 723 and 731.
- Leave every canonical-body comparison alone. Verified: with Phase 1 in place the
  unqualified stored body matches the unqualified declared body and `diff` after
  `apply` is empty.

### Phase 3 — tests and docs

- `test/logic/50-declarative-schema.sqllogic`: declare a non-`main` schema holding
  a table, a plain view and a materialized view; apply it; assert the apply
  succeeds, that selecting from both returns the expected rows under the default
  schema path, and that a following `diff schema` yields no rows.
- Spec coverage for the two standalone failures, which the sqllogic file does not
  reach: `refresh materialized view` on a non-`main` MV after the session path has
  been reset, and a plain `select` from a non-`main` view under the default path.
- Delete `test/tmp-repro.spec.ts` — an always-passing debug spec left behind by the
  investigation that filed this bug; the coverage above replaces it.
- Document the rule ("a stored view / materialized-view body resolves unqualified
  names against its own schema first, independent of the reader") in
  `docs/schema.md` § schema path, `docs/sql-select.md` § 2.1.1 Schema Search Path,
  `docs/sql-views.md`, and `docs/materialized-views.md`.
- Run `yarn lint` and `yarn test` from the repo root before handing off.
