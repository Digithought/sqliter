---
description: Views stored outside the default schema can now be used without spelling out their schema every time, as long as the schema is on the search path — the same rule tables already followed.
files:
  - packages/quereus/src/schema/manager.ts                          # findSchemaItem (~825); findSchemasContainingRelation (~718)
  - packages/quereus/src/schema/view.ts                             # isViewSchema narrowing guard (~31)
  - packages/quereus/src/planner/building/select.ts                 # ~433 FROM-clause dispatch, path-aware
  - packages/quereus/src/planner/building/insert.ts                 # ~550 DML target dispatch
  - packages/quereus/src/planner/building/update.ts                 # ~101 DML target dispatch
  - packages/quereus/src/planner/building/delete.ts                 # ~101 DML target dispatch
  - packages/quereus/src/planner/building/schema-resolution.ts      # ~88 "did you mean" hint now spans views
  - packages/quereus/src/planner/mutation/single-source.ts          # ~499 nested-view / MV write-through guards
  - packages/quereus/test/logic/06.4-schema-search-path.sqllogic    # tests 20-28
  - packages/quereus/test/view-home-schema.spec.ts                  # nested-object write-through rejects
  - docs/sql-select.md, docs/schema.md, docs/usage.md, docs/sql-txn.md, docs/sql-views.md, docs/materialized-views.md
repro: verified
---

# Unqualified view names resolve through the schema search path

## Outcome

An unqualified relation name — in a `from` clause or as an `insert` / `update` /
`delete` target — now resolves the same way for views as it already did for
tables: one search-path entry at a time, each entry's tables *and* views checked
together, first match wins whatever its kind. A qualified name still searches
only the named schema, and a stored view/MV body still resolves on its own home
schema path rather than the caller's.

One resolver does the work — `SchemaManager.findSchemaItem(itemName, dbName?,
schemaPath?)` — and all five dispatch sites route through it. `isViewSchema()`
in `schema/view.ts` splits the `TableSchema | ViewSchema` result.

Because tables and views share one namespace inside a schema (`create table`
rejects a name a view holds and vice versa), at most one can match per entry, so
ordering is well-defined: a table in an earlier path entry beats a view in a
later one.

Two deliberate behaviour changes, both wanted by the bug report:

- `select … from v with schema myapp` now finds `myapp.v`.
- An embedder that sets a non-`main` current schema via
  `SchemaManager.setCurrentSchema` **without** also setting `schema_path` loses
  unqualified *view* resolution — exactly what already happened to its tables.
  Documented in `docs/sql-select.md` § 2.1.1 as the "DDL landing vs. read
  resolution" asymmetry. No test depended on the old behaviour.

## Review findings

Reviewed the implement diff (`4afccc77`) before the handoff summary, then probed
behaviour with a scratch spec (since deleted).

### Fixed in this pass (minor)

- **Off-path *view* got no "did you mean" hint.** `select * from rv` with `temp`
  off the path produced a bare `Table 'rv' not found in schema path: main`,
  while the identical miss on a *table* added `Did you mean: temp.rt?`. The hint
  helper only scanned tables. Renamed `findSchemasContainingTable` →
  `findSchemasContainingRelation` (single caller,
  `building/schema-resolution.ts`) and taught it views. The error's `Table '…'`
  prefix is unchanged — three sqllogic files assert on it. Tests 21 and 28 now
  pin the hint rather than the weaker `not found`.
- **Three stale rationale comments.** `insert.ts` / `update.ts` / `delete.ts`
  each justified their post-resolution maintained-table backstop with "the
  dispatch above defaults an unqualified name to the current schema" — no longer
  true. The backstop itself is now unreachable by construction (both resolvers
  walk the same path), so it was kept as an explicit defense-in-depth net and
  the comments rewritten to say so instead of asserting a false mechanism.
- **`bodyPlanningContext(ctx, view)` built twice** in `analyzeView` — once for
  the body plan, once purely for `.schemaPath` a few lines down. Hoisted to one
  `bodyCtx` const.
- **Redundant re-narrowing.** The MV guard read
  `(!isViewSchema(bodySource) && isMaintainedTable(bodySource)) || …`, but the
  branch immediately above throws (`raiseMutationDiagnostic` returns `never`) on
  a view, so TypeScript already narrows it out. Simplified to
  `isMaintainedTable(bodySource) || …`; typecheck confirms the narrowing.
- **Docs beyond `sql-select.md` were untouched and one was actively wrong.**
  `docs/materialized-views.md` § Write boundary still described the DML dispatch
  as "each checks `getView(…)` … at name dispatch (current-schema default)" —
  a mechanism that no longer exists. Rewritten. Also corrected "unqualified
  *table* names" → relation names in `docs/schema.md` (§ Schema Path + the
  `schema_path` option row), `docs/usage.md` (options table, § Working with
  Multiple Schemas, and Resolution Order, which gained the cross-kind ordering
  rule), and `docs/sql-txn.md` § 9.2.6. Added a reference-side bullet to
  `docs/sql-views.md` — it documented home-schema resolution of the view *body*
  but said nothing about resolving the view *name*.

### Test gaps closed

The implementer flagged both of these as judged-redundant; both are now pinned,
since "the mechanism is identical" is exactly the claim a test should hold.

- **Test 28 — user-declared (non-`temp`) schema.** `myapp.uv` over `myapp.ut`:
  off-path miss with hint, on-path read, unqualified `insert` / `delete`, and
  statement-level `with schema myapp`. Confirms nothing in the `temp`-based
  coverage was riding on `temp` being special.
- **Test 27 — path ordering governs a WRITE target, not only a read.** Test 26
  pinned read ordering across a `main` table and a same-named `temp` view;
  writes were untested. Now both directions are pinned, including that the
  loser's rows are untouched.

Also verified by probe, no test added (each is covered transitively by the above
or is unobservable state): unqualified read/write of a materialized view through
the path; alias and qualified-column references to a path-resolved view; a CTE
still shadowing a path-resolved view name; `insert` / `update` / `delete`
against an *unqualified* nested view rejecting with the same diagnostic the
qualified form gives.

### Filed as a new ticket (major, pre-existing — not caused by this change)

- **`fix/bug-caller-cte-shadows-view-body`** — a reading statement's `with`
  clause is in scope while a stored view body is planned, so a CTE named after
  one of the body's source tables silently replaces it:
  `with lt as (select 1 as id, 999 as x) select * from lv` returns `x = 999`
  instead of `x = 10`. Silent wrong answers on the read path; on the write path
  it fails with `view body operator 'CTEReference' is not updateable in phase 1`
  — an internal operator name the user never wrote. Verified at `4afccc77`, so
  it predates this ticket (`building/select.ts` passes the caller's `cteNodes`
  into the body plan on a line this diff did not touch). Materialized views are
  unaffected — reading one reads its backing table. Root cause is the same
  naming-environment leak the home-schema-path rule already closes for schemas;
  the CTE namespace was never isolated. No open ticket claimed the site.

### Recorded as tripwires, not tickets

- `isViewSchema` is a structural guard keyed on the presence of a top-level
  `selectAst`, not a tagged union. `NOTE:` at `schema/view.ts` — if
  `TableSchema` ever gains that field, add a discriminant to both schemas rather
  than picking a different key.
- `findSchemaItem`'s no-path fallback restates `_findTable`'s default `main,
  temp` order. The session `schema_path` option always yields a path, so the
  branch is effectively dead — but the duplication can drift. `NOTE:` at the
  site.
- `bodyPlanningContext` re-parses `schema_path` per call; `_homeSchemaPath`
  already carries its own memoize-if-hot `NOTE:`, and the hoist above removed
  the extra call this diff added. Nothing further recorded.

### Checked, nothing found

- **Case folding.** `findSchemaItem` → `getSchemaItem` does not lowercase the
  item name itself, but `Schema.getTable` / `getView` both key on
  `name.toLowerCase()`, so it matches `_findTable`'s explicit fold.
- **`committed.` pseudo-schema.** `findSchemaItem('committed', …)` misses (no
  such schema) and falls through to `buildTableReference`, which intercepts it —
  identical to the pre-change `getView('committed', …)` miss. DML blocks the
  pseudo-schema earlier regardless.
- **Nested-view guard false positives.** The guard resolves the body's source on
  the body's home path, the same path `buildSelectStmt` plans the body under, so
  the name lookup and the plan-resolved base table cannot disagree about which
  object the name means.
- **Other unqualified-view resolution sites.** Swept every `getView` /
  `getMaintainedTable` / `getSchemaItem` caller. The remainder are DDL emitters
  operating on an already-canonicalized `plan.schemaName`, plus
  `scope-transform.ts:409`, which the open
  `fix/bug-view-write-subquery-in-body-uses-caller-schema` already claims — left
  untouched, as the implementer did.
- **Source hygiene.** `schema/manager.ts` is 3474 lines and `single-source.ts`
  1362 — both large, both pre-existing; this change adds 27 lines net to the
  first and none to the second, and no open ticket claims either for size. Not
  filed: the diff is not what made them big.

### Pre-existing, already tracked — not re-reported

`yarn docs:check` fails on `docs/schema.md`'s word-count ratchet (12918 vs
12109). Measured `git show HEAD:docs/schema.md` at 12879 words, so it was 770
over before this pass; the edits here add 39. Listed in
`tickets/.pre-existing-known.md` against `debt-doc-size-ratchet-red-at-head`.

## Validation

- `yarn lint` (all workspaces) — clean.
- `yarn workspace @quereus/quereus run typecheck` and the `tsconfig.test.json`
  pass — clean.
- `yarn test` (all workspaces) — **0 failing**; `@quereus/quereus` 8441 passing,
  13 pending (3m), matching the implement-stage baseline exactly. Total run 5m52s.
- Targeted re-run after the final comment/doc edits:
  `06.4-schema-search-path.sqllogic` and `view-home-schema.spec.ts` (27 passing).
