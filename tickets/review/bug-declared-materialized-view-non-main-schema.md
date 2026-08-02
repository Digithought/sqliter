----
description: Views and materialized views in a schema other than the default one now find their own tables — declaring, applying, reading, and refreshing them all work; this is the implementation handoff for review.
files:
  - packages/quereus/src/core/database.ts                          # _homeSchemaPath helper; schemaPath override through getPlan/_buildPlan/_buildProbeContext
  - packages/quereus/src/core/statement.ts                         # _schemaPathOverride internal field, consumed at both _buildPlan call sites
  - packages/quereus/src/planner/building/create-view.ts           # planViewBody grew homeSchemaName param
  - packages/quereus/src/planner/building/materialized-view.ts     # create-time body plan under home path
  - packages/quereus/src/planner/building/ddl.ts                   # `create table … maintained as` body — same
  - packages/quereus/src/planner/building/alter-table.ts           # `set maintained as` body — same
  - packages/quereus/src/planner/building/select.ts                # read-time view expansion swaps in the home path (~447)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # deriveBackingShape / collectBodyRows / revalidateBody / referencedSourceColumns / linkCoveredUniqueConstraints now home-path
  - packages/quereus/src/runtime/emit/materialized-view.ts         # refresh callers updated
  - packages/quereus/src/schema/manager.ts                         # import-path deriveBackingShape caller
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts # maintenance planning (both body plans) home-path
  - packages/quereus/src/core/database-materialized-views-plans.ts # manager-context _buildPlan signature mirrors Database's
  - packages/quereus/src/func/builtins/schema.ts                   # information-schema updateability probes home-path
  - packages/quereus/src/schema/schema-differ.ts                   # applyViewSchemaDefault qualifies view/MV creates
  - packages/quereus/test/view-home-schema.spec.ts                 # new spec (6 cases)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic     # new non-main view+MV declarative section
  - docs/schema.md, docs/sql-select.md, docs/sql-views.md, docs/materialized-views.md
----

# Home-schema body resolution for views and materialized views — implemented

## What was built

Two independent fixes, per the ticket's design:

**1. A stored body resolves against its owner's schema, not the caller's.**
New `Database._homeSchemaPath(schemaName)` composes `[owner's schema,
...session default path]` (deduped; the default path comes from the
`schema_path` option, default `'main'`, so `_homeSchemaPath('main')` is exactly
today's path — zero behavior change for `main` objects). An optional
`schemaPath` override now threads through `getPlan` → `_buildPlan` →
`_buildProbeContext`, and `Statement` gained an internal `_schemaPathOverride`
field (set right after `prepare()`; compile is deferred, so this is race-free —
used by `collectBodyRows`, the one seam that plans through a prepared
statement). Every seam that plans a view / MV body passes the home path:

- create time: `create view`, `create materialized view`,
  `create table … maintained as`, `alter table … set maintained as`
  (all via a new optional param on `planViewBody`);
- read time: the view-expansion branch in `building/select.ts`;
- MV lifecycle: backing-shape derivation, create-fill / refresh row collection,
  stale re-validation, staleness column analysis, covered-unique linking,
  and both maintenance-plan body compilations;
- the static updateability surfaces (`view_info` / `column_info` and their
  set-op insertability probes in `func/builtins/schema.ts`).

Chosen composition is the ticket's recommended inclusive form (home first, then
default path), **path only — no current-schema switch**. Rationale: the
documented DDL-landing-vs-read asymmetry (docs/sql-select.md § 2.1.1) says
unqualified *reads* never consult the current schema; a body is a pure read, so
the path alone reproduces read semantics faithfully. Consequence honestly
stated: an unqualified *plain-view* name nested inside a body still resolves
only against the current schema (the pre-existing asymmetry the ticket declared
out of scope) — a nested unqualified *maintained table* does resolve, because
maintained tables resolve through `findTable`'s path walk.

**2. The declarative differ qualifies view / MV names.** New
`applyViewSchemaDefault` in `schema-differ.ts` (mirror of `applyTableDefaults`
and the identical block in `catalog.ts`) applied at all four render sites: the
MV sugar in `renderFreshTableCreate` and the three plain-view create renders
(fresh create, definition-drift recreate, hinted-rename recreate). Canonical-
body comparisons untouched, per the ticket's measurement.

## Verified (ran, not inferred)

Every expected behavior from the ticket, exercised live and now in tests:

- `create materialized view temp.mv as select … from t` (body reads `temp.t`
  unqualified) succeeds under the default path; refresh after a
  `pragma schema_path` reset succeeds; row-time maintenance flows through.
- `select` from a non-`main` plain view under the default path works.
- A declared non-`main` schema holding table + view + MV applies, both are
  readable under the default path, the MV maintains through inserts, and
  `diff schema` **immediately after apply is empty** (and stays empty after
  refresh).
- Name-collision: a temp view over `ct` binds `temp.ct` even when `main.ct`
  exists (home-first ordering observable).

Coverage: `test/view-home-schema.spec.ts` (6 specs — the standalone failures
sqllogic can't reach, incl. path-reset refresh) and a new section at the end of
`test/logic/50-declarative-schema.sqllogic` (apply / read / refresh /
re-diff-empty). `test/tmp-repro.spec.ts` (leftover always-passing debug spec)
deleted. `yarn lint` clean; `yarn test` fully green from root (8363 passing in
quereus core, all other workspaces passing, 13 pre-existing pendings).

## Known gaps / follow-ups for the reviewer

- **Write-through is still broken for non-`main` views** — deliberately outside
  this ticket's scope. Verified live (`insert into temp.wv …` → `Table 'wt' not
  found in schema path: main`) and filed as
  `fix/bug-view-write-through-ignores-home-schema` with the exact sites
  (the mutation substrate plans bodies with the caller's context) and the
  read-side pattern to apply.
- **Not threaded (judged out of scope, worth a reviewer glance):**
  `schema/lens-prover.ts` (714, 1274) and `func/builtins/explain.ts` (801) plan
  a lens slot's `compiledBody` without a home path — lens bodies are compiled
  against a basis schema and may already be qualified; unverified either way.
  `core/database-assertions.ts` (292) plans assertion bodies — assertions are
  separately tracked (`fix/bug-declared-assertion-ignores-target-schema`).
- **Tripwire (recorded in code):** `_homeSchemaPath` re-reads and re-parses the
  `schema_path` option on every body plan. Cheap (a split on a short string),
  but if body re-plans ever show up hot, memoize on the option's change hook.
- The `MaterializedViewManagerContext._buildPlan` member now aliases
  `Database['_buildPlan']` directly instead of restating a narrower signature —
  intentional (the context is the Database cast; drift-proof).
- Interface note: `deriveBackingShape`, `collectBodyRows`, `revalidateBody`,
  and `referencedSourceColumns` each grew a `schemaName` parameter (second
  position). All callers updated; nothing outside `src/` imported them.

## Review use cases worth poking

- A `main` view reading a `temp` table unqualified: before this change the body
  planned under the session path (`'main'` default) and failed; it still fails
  the same way (home path for `main` = `['main']`). Confirm that's acceptable —
  the ticket's "nothing that resolves today stops resolving" bar is met, but
  the sentence in the ticket assumed a `main,temp` default that the option does
  not actually ship.
- MV-over-MV across schemas (mv2 in schema A reading mv1 in schema B
  unqualified) — resolves only if B is on the composed path; qualified names
  always work. Untested here.
- `apply schema` for a non-`main` schema whose view definition *drifts* later
  (the drop+recreate render path, differ site 2/3) — exercised indirectly by
  existing main-schema sqllogic steps, not by a non-`main` drift case.
