---
description: Generated-column formulas now resolve names scope-aware — a name bound by a FROM clause inside the formula belongs to that source, so subqueries over other tables no longer trigger false "column not found" or false circular-dependency errors.
files:
  - packages/quereus/src/schema/rename/scope-frame.ts          # NEW — conservative FROM-frame model, extracted from self-qualifier-strip
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts # repointed at scope-frame.ts; behavior unchanged
  - packages/quereus/src/schema/generated-column-refs.ts       # NEW — collectGeneratedColumnRefs (own/foreign/unknown classification)
  - packages/quereus/src/schema/table.ts                       # extractGeneratedColumnDependencies, validateAddColumnGeneratedRefs, withGeneratedColumnGraph rewritten on the collector; resolveWithInFlightColumns wrapper
  - packages/quereus/src/schema/manager.ts                     # CREATE TABLE call site threads buildColumnSourceResolver(this.db)
  - packages/quereus/src/runtime/emit/alter-table.ts           # 3 withGeneratedColumnGraph call sites thread rctx.db resolver
  - packages/quereus/src/planner/building/alter-table.ts       # ADD COLUMN pre-flight threads ctx.db resolver
  - packages/quereus/test/logic/41-generated-column-scope.sqllogic  # NEW — CREATE-side arms
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic  # arm 10 workaround comment removed; unqualified arm 11 added
  - docs/sql-alter.md                                          # § ADD COLUMN "One current exception" note deleted
  - docs/sql-ddl.md                                            # § Generated Columns — resolution rule stated
---

# Review: scope-aware reference analysis for generated-column expressions

## What was built

One scope-aware reference collector for `generated always as (<expr>)` bodies,
consumed by both schema-time analyses so they give one answer to "does this name
bind the owning table's row?":

- `schema/rename/scope-frame.ts` (new): the conservative FROM-frame model
  (`ScopeFrame` — bound qualifiers, catalog-askable real sources, opaque flag, CTE
  names) extracted verbatim from the self-qualifier strip. The strip walker now
  consumes it; no behavior change there (full suite green).
- `schema/generated-column-refs.ts` (new): `collectGeneratedColumnRefs(expr,
  tableName, schemaName, resolveColumnInSource)` returns every column/identifier
  reference classified `'own'` / `'foreign'` / `'unknown'` per the ticket's spec.
  One interface addition vs. the ticket: refs carry both `name` (lowercase, for
  map lookups) and `originalName` (as written, so error messages keep the user's
  casing — the old messages interpolated the written spelling).
- `schema/table.ts`: `extractGeneratedColumnDependencies` and
  `validateAddColumnGeneratedRefs` rewritten on the collector, applying the
  ticket's binding × known-column table. `withGeneratedColumnGraph` grew the
  resolver parameter and forwards it. `resolveWithInFlightColumns` wraps the
  catalog resolver so questions about the target table answer from the in-flight
  column array (CREATE: table absent from catalog; DROP COLUMN: catalog holds the
  pre-drop set; ADD COLUMN: the wrapper adds the new column name so the
  pre-flight accepts exactly what the emitter's post-ALTER re-analysis will).
- Call sites thread `buildColumnSourceResolver(db)`: `schema/manager.ts`
  (CREATE), `runtime/emit/alter-table.ts` ×3 (add-column, per-constraint rounds,
  drop-column), `planner/building/alter-table.ts` (ADD COLUMN pre-flight).

Both existing error messages are byte-identical; the duplicate-column
suppression in the ADD COLUMN pre-flight is preserved (verified: `alter table
dup add column v … as (v * 2)` still reports "Column 'v' already exists").

## Verified behaviors (all in sqllogic, ran under memory AND store modules)

`41-generated-column-scope.sqllogic` (new):
- CREATE with subquery over another table, inner name unqualified — accepted, computes 42.
- Two generated columns each reading another table's like-named columns — no false cycle, correct values.
- Generated column reading another table's column sharing its own name — no false self-cycle.
- CTE arm `(with c(v) as (select 7) select v from c)` — accepted.
- Aliased self source `(select a from t x)` — inner `a` is the source's.
- Real table named `"new"` — FROM binding beats the row image.
- Subquery over the table's own rows at CREATE (in-flight wrapper).
- `new.<col>` and `main.t.<col>` record dependency edges — DROP COLUMN of the referenced column refused; `"temp".t.<col>` (other schema, same bare names) records none — drop allowed.
- Negatives with the exact old messages: bare typo, typo inside a subquery whose FROM lacks the name, self-cycle on ADD COLUMN, two-column cycle on CREATE.

`41.14` arm 10 keeps the qualified spelling; new arm 11 is the unqualified
spelling with correct backfill; the workaround comment is gone.

Validation run: `yarn build` clean; quereus suite 9233 passing / 0 failing;
`yarn lint` (eslint + tsc test pass) clean; `node test-runner.mjs --store
--grep "41"` 47 passing (the 1 pending is a pre-existing memory-only skip);
root `yarn test` (all workspaces) green.

## Known gaps / deviations for the reviewer

- **One new rejection the ticket's "only accepts more" claim doesn't cover:**
  `generated always as (new.nosuch)` (an unrebound `new.` naming a non-column)
  now raises "not found" at DDL time; previously it was accepted and the table
  broke at first write. This follows the ticket's binding table literally
  (`'own'` + `'column'` shape + unknown ⇒ raise) and the reference is dead by
  construction — but it is a behavior change in the reject direction.
- **DML bodies inside a generated expression** (`(select … from (insert …
  returning …) q)` and scalar-subquery DML): the old blind walk descended them
  and could raise "not found" for their bare names; the collector descends them
  under an opaque barrier, so their refs classify `'unknown'` (conservative
  edges, no rejections). Determinism validation at plan time remains the real
  gate for such bodies.
- **`with inverse` subtrees on result columns are not walked** (parity with the
  strip walker; the old walk visited them). A ref appearing *only* there loses
  its edge — pathological, since an inverse clause is view write-through
  metadata with no meaning in a generated body.
- **Window frame bounds are not walked** — parity with the old `traverseAst`
  (same `// TODO` there).
- **Opaque-source residual** (documented as a `NOTE:` at the collector header):
  an own-column name reachable only through an opaque source still yields a
  spurious dependency edge; two generated columns doing that to each other still
  raise a false cycle. Recording the edge is the deliberate safe half of the
  asymmetry.
- **Newly-accepted schemas depend on referenced tables being resolvable at
  re-analysis time.** Store import replays DDL in original order, so every
  legally-created schema re-analyzes consistently; a catalog manipulated
  out-of-band (referenced table missing when `withGeneratedColumnGraph` runs)
  would surface "not found" where creation succeeded.
- **Pre-existing, unchanged:** the *write path* still cannot evaluate a
  schema-qualified self reference (`main.t.a` in the body errors at INSERT with
  "main.t.a isn't a column") — the analysis accepts it and records the edge (as
  the old code did); evaluation is the sibling `generated-column-one-row-scope`
  ticket's territory. Also `temp.x.y` unquoted does not parse in expression
  position (contextual-keyword gap in the parser's three-part column arm) — the
  test spells it `"temp".x.y`.
- The ticket's Notes confirmed arm C (mutation-context collision) no longer
  reproduces and that the `new.<col>`-backfill-then-unwritable-table defect
  belongs to `generated-column-one-row-scope`; nothing here touches either.
