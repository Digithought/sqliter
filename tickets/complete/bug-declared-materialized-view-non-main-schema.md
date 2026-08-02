----
description: Views and materialized views that live in a schema other than the default one now find their own tables — declaring, applying, reading, refreshing, and optimizing them all work.
files:
  - packages/quereus/src/core/database.ts                          # _homeSchemaPath; schemaPath override through getPlan/_buildPlan/_buildProbeContext
  - packages/quereus/src/core/statement.ts                         # _schemaPathOverride, consumed at both _buildPlan call sites
  - packages/quereus/src/planner/building/create-view.ts           # planViewBody homeSchemaName param
  - packages/quereus/src/planner/building/materialized-view.ts     # create-time body plan under home path
  - packages/quereus/src/planner/building/ddl.ts                   # `create table … maintained as` body
  - packages/quereus/src/planner/building/alter-table.ts           # `set maintained as` body
  - packages/quereus/src/planner/building/select.ts                # read-time view expansion (~451) AND stale-MV re-validation (~539, review fix)
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # join-subsumption body re-plan (review fix)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # backing shape / body rows / revalidate / staleness columns / covered-unique linking
  - packages/quereus/src/runtime/emit/materialized-view.ts         # refresh callers
  - packages/quereus/src/schema/manager.ts                         # import-path deriveBackingShape caller
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts # maintenance planning
  - packages/quereus/src/core/database-materialized-views-plans.ts # manager-context _buildPlan signature
  - packages/quereus/src/func/builtins/schema.ts                   # view_info / column_info updateability probes
  - packages/quereus/src/schema/schema-differ.ts                   # applyViewSchemaDefault (exported during review)
  - packages/quereus/src/schema/catalog.ts                         # baseline DDL emission now shares applyViewSchemaDefault (review fix)
  - packages/quereus/test/view-home-schema.spec.ts                 # 8 specs
  - packages/quereus/test/logic/50-declarative-schema.sqllogic     # non-main view+MV declarative section
  - docs/schema.md, docs/sql-select.md, docs/sql-views.md, docs/materialized-views.md, docs/sql-txn.md, docs/usage.md
----

# Home-schema body resolution for views and materialized views — complete

## What shipped

**A stored body resolves against its owner's schema, not the caller's.**
`Database._homeSchemaPath(schemaName)` composes `[owner's schema, ...session
default path]` (deduped). `_homeSchemaPath('main')` equals today's default path,
so `main` objects are unchanged. An optional `schemaPath` override threads
through `getPlan` → `_buildPlan` → `_buildProbeContext`, plus a
`Statement._schemaPathOverride` field for the one seam that plans through a
prepared statement (`collectBodyRows`). Every seam that plans a view / MV body
now passes the home path: create time (`create view`, `create materialized
view`, `create table … maintained as`, `alter table … set maintained as`), read
time (view expansion, stale-MV re-validation), the MV lifecycle (backing-shape
derivation, create-fill / refresh, staleness column analysis, covered-unique
linking, maintenance-plan compilation), the automatic query-rewrite rule, and
the static updateability surfaces (`view_info` / `column_info`).

**The declarative differ qualifies view / MV names.** `applyViewSchemaDefault`
in `schema-differ.ts` is applied at all four render sites, so `apply schema` for
a non-`main` declared schema lands its views and MVs in that schema rather than
whichever schema is current at apply time. `catalog.ts`'s baseline DDL emission
shares the same helper.

Chosen composition is path-only (home first, then the session default) with no
current-schema switch — a body is a pure read, and unqualified reads never
consult the current schema (docs/sql-select.md § 2.1.1). Consequence, stated in
the docs: a nested unqualified *plain-view* name inside a body still resolves
only against the current schema (a pre-existing asymmetry, out of scope here); a
nested unqualified *maintained table* does resolve.

## Review findings

Reviewed the implement diff (`aea396f7`) first-hand before the handoff summary,
then swept every remaining body-planning call site in `src/` for the same
pattern.

### Defects found and fixed in this pass

**A stale non-`main` materialized view was unreadable** (verified by running it,
not inferred). `building/select.ts` re-validates a stale MV's stored body before
resolving the reference; that re-plan still used the caller's context. For a
non-`main` MV with an unqualified body the re-plan threw `Table 'par' not found
in schema path: main`, which got wrapped and surfaced as a false
`materialized view 'par_ix' is stale; a source changed in an incompatible way —
drop and recreate`. The materialized rows were there and readable; only the
guard was wrong. The equivalent `main` case returned rows normally. Fixed with
the same home-path context swap the view-expansion branch uses; regression test
`keeps a STALE non-main materialized view readable`.

**The automatic join-subsumption rewrite never fired for a non-`main` MV**
(verified: same fixture in `temp` vs `main`, plan tree contained the MV table
only in the `main` case). `rules/cache/rule-materialized-view-rewrite.ts`
re-plans the MV body to prove the join is 1:1; that call used the session path,
threw, and was swallowed by a bare `catch` that drops the MV as a candidate.
Wrong results were never possible — the query fell back to recomputing the join
— but the MV was silently useless as an index. Fixed, plus the `catch` now logs
(a silent drop here is indistinguishable from "shape didn't match", which is
exactly why this hid). Regression test `lets the join-subsumption rewrite fire
for a non-main materialized view`.

**DRY: `catalog.ts` held two hand-inlined copies of the new
`applyViewSchemaDefault`** (one for views, one for MVs) — the implementer noted
the duplication in the handoff but left it. Exported the helper and collapsed
both blocks; 30 lines → 6, behavior identical.

### Major finding — new ticket

**A lens override body's unqualified table names never reach its basis schema.**
Verified: a lens whose override writes `from CarCore` (rather than
`from ybasis.CarCore`) over a non-`main` basis fails to read at all —
`Table 'CarCore' not found in schema path: carapp, main`. The lens compiler
*defines* an unqualified override source as belonging to the basis schema (it
resolves it that way, and its cross-basis guard documents it), but stores the
FROM verbatim, so every later consumer resolves it against the search path
instead. This is **not** a regression — the same read failed before this ticket
with `schema path: main` — and the home-schema rule does not reach it, because a
lens view's home schema is the *logical* schema, which is precisely where the
basis tables are not. Distinct root cause, distinct site → filed as
`fix/bug-lens-override-body-ignores-basis-schema` (repro: verified).

### Checked and found correct (no action)

- **Create-time vs read-time home-schema agreement.** `create view` /
  `create materialized view` / `create table … maintained as` all derive the
  landing schema the same way the emitters do (explicit qualifier, else current
  schema), so the path a body validates under at create equals the one it plans
  under at read.
- **A body's own `with schema` still wins.** `with schema` is a clause of the
  stored SELECT, and `buildSelectStmt` re-overrides the path from it — the home
  path is the base, not a replacement. So no authored body changed meaning.
- **No `main`-schema regression.** `_homeSchemaPath('main')` is the default path
  verbatim; the `?? ['main', 'temp']` fallback (reachable only via
  `pragma schema_path = ''`) matches `SchemaManager.findTable`'s own implicit
  default, so the two resolution routes agree.
- **Schema-resolution caching is path-keyed** (`table:path(a,b):name`), so the
  planning context shared between a caller and a view body cannot cross-pollute.
- **Nested view expansion recurses correctly** — each nested body picks up its
  own owner's home path.
- **`view_info` / `column_info` for a non-`main` view** now report real
  updateability (`YES/YES` with base-table lineage) rather than the conservative
  fallback. Ran it.
- **Non-`main` view definition *drift* re-apply** — the handoff flagged the
  differ's drop+recreate render path as untested. Ran it: the diff renders
  `DROP VIEW IF EXISTS dr.v` + `create view dr.v as …`, applies, reads the new
  definition, and re-diffs empty.
- **MV over MV in a non-`main` schema** (`mv2` reading `mv1` unqualified,
  same schema) — ran it, works. Cross-*schema* MV-over-MV resolves only if the
  upstream's schema is on the composed path, which is the documented rule.
- **The lens-prover / `explain` lens seams the handoff left unthreaded** are now
  characterized rather than unknown: the *synthesized* lens bodies
  (`compileDefaultBody`, `compileDecompositionBody`) emit fully-qualified table
  references, so they need no home path. Only the *override* body is affected —
  covered by the new ticket above.
- **Statement override is race-free** — `Statement.compile()` is lazy and
  `db.prepare()` does not cache or share statements, so setting
  `_schemaPathOverride` immediately after `prepare` cannot miss.

### Documentation

The implementer updated four docs; two more resolution-order lists were left
stale and are now consistent: `docs/sql-txn.md` § 9.2.6 and `docs/usage.md`
§ schema resolution order each gained the stored-body exception. Corrected one
inaccurate claim in `docs/schema.md`: CHECK-constraint and foreign-key bodies do
*not* follow the identical rule — they resolve against the owning table's schema
**only**, with no default-path fallback.

Deliberately **not** documented: that write-through to a non-`main` view still
fails. That is tracked as `fix/bug-view-write-through-ignores-home-schema`,
which sits in the top-priority stage and will land before a reader could act on
a caveat; adding and then removing one is churn.

### Tripwires

- The implementer's own `NOTE:` in `Database._homeSchemaPath` (re-parses the
  `schema_path` option on every body plan; memoize on the option's change hook
  if body re-plans ever show up hot) — reviewed and left as recorded. It is a
  string split on a short string per plan; nothing measured it as hot.
- No new tripwires were added this pass.

### Not found / explicitly empty

- **No performance findings.** Nothing on a hot path changed; the only added
  work per body plan is one option read and an array filter over a path of
  typically one or two entries.
- **No resource-cleanup or error-handling findings** beyond the swallowed
  `catch` fixed above. The specs open and `close()` their databases in
  `afterEach`.
- **No source-hygiene findings.** The diff added short, single-purpose helpers
  and touched no file's structure. `materialized-view-helpers.ts` remains large
  (3,093 lines) but that is already tracked by
  `backlog/debt-emit-source-files-too-large`, which names the file and its line
  count — not re-reported.
- **One pre-existing duplication left alone:** the
  `stmt.x.schema ? canonicalSchemaName(…) : getCurrentSchemaName()` landing-schema
  idiom now appears at 8 sites (7 of them predate this ticket). Collapsing it
  into a `SchemaManager` helper touches five files for no behavior change, which
  is wider than this review's remit; it is small enough not to warrant a ticket
  of its own.

## Validation

- `yarn lint` — clean across all 17 workspaces.
- `yarn test` — fully green from the repo root: 8,365 passing in quereus core
  (up 2 from the handoff's 8,363 — the two new regression specs), every other
  workspace passing, 0 failing, 13 pre-existing pendings.
- `test/view-home-schema.spec.ts` — 8 passing.

## Follow-on tickets

- `fix/bug-view-write-through-ignores-home-schema` — filed by the implementer;
  write-through was deliberately out of scope here.
- `fix/bug-lens-override-body-ignores-basis-schema` — filed by this review.
- `fix/bug-declared-assertion-ignores-target-schema` — pre-existing; assertion
  bodies (`core/database-assertions.ts`) are the same family, tracked there.
