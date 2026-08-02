----
description: An integrity check now belongs to the schema it was declared in — creating, dropping, enforcing, and re-declaring it all target the right schema, and a check declared outside the default schema no longer breaks every later write to the database.
files:
  - packages/quereus/src/parser/ast.ts                              # CreateAssertionStmt.name is now IdentifierExpr
  - packages/quereus/src/parser/parser.ts                           # createAssertionStatement uses tableIdentifier()
  - packages/quereus/src/planner/building/create-assertion.ts       # landing-schema idiom (canonicalSchemaName ?? current)
  - packages/quereus/src/planner/building/drop-assertion.ts         # same idiom; qualifier no longer dropped
  - packages/quereus/src/planner/nodes/create-assertion-node.ts     # schemaName field
  - packages/quereus/src/planner/nodes/drop-assertion-node.ts       # schemaName field
  - packages/quereus/src/runtime/emit/create-assertion.ts           # lands in plan.schemaName; home-path dep discovery; warn on discovery failure
  - packages/quereus/src/runtime/emit/drop-assertion.ts             # per-schema lookup + qualified cache invalidation
  - packages/quereus/src/schema/assertion.ts                        # IntegrityAssertionSchema.schemaName
  - packages/quereus/src/core/database-assertions.ts                # home-path body plans; schema-qualified cache keys
  - packages/quereus/src/core/database.ts                           # invalidateAssertionCache(schemaName, name)
  - packages/quereus/src/planner/analysis/assertion-classifier.ts   # findTable with [home, main, temp] fallback path
  - packages/quereus/src/emit/ast-stringify.ts                      # qualified renders (createAssertionToString, declared item)
  - packages/quereus/src/schema/schema-differ.ts                    # applyAssertionSchemaDefault (exported, shared); name.name reads
  - packages/quereus/src/schema/catalog.ts                          # generateDeclaredDDL assertion case; qualified catalog ddl
  - packages/quereus/src/func/builtins/schema.ts                    # assertion_info(): schema_name column, (schema_name, name) key
  - packages/quereus/src/func/builtins/explain.ts                   # explain_assertion: schema.name arg, home path, hoist suppression
  - packages/quereus/test/assertion-home-schema.spec.ts             # NEW — 8 specs
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # non-main assertion declarative section (~1718)
  - packages/quereus/test/schema/catalog.spec.ts                    # declared-DDL + hash regression specs
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts    # fixture gained schemaName
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts # name.name reads
  - packages/quereus/test/emit/ast-stringify.spec.ts, test/emit-missing-types.spec.ts, test/emit-roundtrip-property.spec.ts
  - docs/sql-ddl.md, docs/schema.md, docs/functions.md, docs/optimizer-retrieve.md
----

# Assertions have a home schema — implemented, ready for review

## What was built

An assertion now carries a schema identity end to end. All five arms of the fix
ticket landed:

**Language surface.** `CreateAssertionStmt.name` is an `IdentifierExpr` (was a
bare string), parsed with the shared `tableIdentifier()` helper, so
`create assertion apol.a1 check (…)` and `drop assertion [if exists] apol.a1`
both work; an unqualified name means the current schema, like every other DDL
statement. Both builders resolve the landing schema with the standard
`canonicalSchemaName(…) ?? getCurrentSchemaName()` idiom and carry it on the
plan nodes; the emitters use it instead of the hard-coded `getMainSchema()`.

**Home-schema body resolution.** `IntegrityAssertionSchema` gained `schemaName`,
and every seam that plans a stored assertion body now passes
`db._homeSchemaPath(schemaName)` (the machinery the materialized-view ticket
left behind): create-time dependency discovery, the commit-time evaluator's
`_buildPlan`, `executeViolationOnce` (via `Statement._schemaPathOverride`, set
right after `prepare` — race-free because compile is lazy), the hoist
classifier's `findTable` (fallback path `[home, 'main', 'temp']`), and
`explain_assertion`. This kills the severe failure mode: a non-`main` assertion
with an unqualified body no longer makes *every* write to the database fail at
commit.

**Qualified identity keys.** The evaluator's plan cache, its DeltaExecutor
subscription ids, and `Database.invalidateAssertionCache` are all keyed by
lowercase `schema.name`, so two same-named assertions in different schemas
coexist and enforce independently (spec-verified). `assertion_info()` gained a
`schema_name` column and its relational key is now the honest
`(schema_name, name)` pair. `explain_assertion` accepts `'schema.name'` (bare
name still works, first match across schemas).

**Declarative pipeline.** `applyAssertionSchemaDefault` (exported from
`schema-differ.ts`, shared with `catalog.ts` — not duplicated) qualifies the
rendered `create assertion` in migration DDL, so `apply schema apol` lands the
assertion in `apol` and an immediate re-`diff` is empty. The
`DROP ASSERTION IF EXISTS apol.a1` render now round-trips (sqllogic-verified via
a redeclare-without-assertion cycle). `generateDeclaredDDL` gained the missing
`declaredAssertion` case, so a declared assertion participates in
`computeSchemaHash` (regression specs: with-vs-without and body-A-vs-body-B all
hash differently). The catalog's per-assertion `ddl` renders the qualified name
for non-`main`; `CatalogAssertion.name` stays bare (catalog is per-schema and
the differ keys on bare name within it — confirmed intact).

**Diagnostics hardening (per the ticket).** The create-emitter's swallowed
dependency-discovery `catch` is now a warning naming the assertion and stating
that enforcement falls back to the full violation query.

## Adjacent fix folded in (flag for reviewer)

`explain_assertion` never suppressed assertion-hoisting while planning the
body, so for any canonical-shaped (`not exists (select 1 from T where P)`)
assertion the optimizer folded the assertion's own violation query to empty and
the TVF returned **zero rows** — pre-existing, on `main` too; discovered because
the new spec used a canonical shape. It now wraps planning in
`withSuppressedAssertionHoist`, exactly as the commit-time evaluator does. The
pre-existing `dotted-table-name.spec.ts` explain test only passed because it
used a non-hoistable aggregate shape.

## Known gaps / decisions the reviewer should weigh

- **`create assertion <schema>.<name>` does NOT auto-create the schema** — it
  errors `Schema not found: <schema>`. Tables and views auto-create via
  `SchemaManager.getOrCreateSchema`, but that method is private and assertions
  referencing tables in a schema imply the schema exists (in the declarative
  apply, table creates precede assertion creates). Deliberate divergence, cheap
  to change if the reviewer disagrees.
- **Violation messages stay bare-name** (`Integrity assertion failed: a1`) —
  ambiguous when two schemas share an assertion name. Kept because dozens of
  sqllogic expectations pin the exact text; qualifying only non-`main` felt
  inconsistent. Judgment call, not an oversight.
- **The classifier's fallback path is the static `[home, 'main', 'temp']`**, not
  the live `schema_path` option (the classifier only has a `SchemaManager`; the
  option lives on `Database`). Divergence requires a customized session path
  plus same-named tables across schemas, and hoisting is an optimizer overlay —
  enforcement itself always uses the true home path. Noted in a comment at the
  site.
- **A declared assertion body change is invisible to `diff schema`**
  (presence-only comparison) — real, verified, pre-existing, distinct root
  cause → filed as `fix/bug-assertion-body-drift-invisible-to-diff` rather than
  scope-creeping here.
- **Assertions are still not persisted** across a store-backed reopen — ticket
  explicitly out-of-scope, documented at `catalog.ts:750`.

## Compatibility note (expected, per ticket)

`computeSchemaHash` output changes for any declaration containing an assertion
(previously hashed as if absent — that was arm D's defect). Such schemas report
a version change on first run after this lands. Sanctioned by AGENTS.md
("Backwards compat: don't worry yet").

## How to validate

- `packages/quereus/test/assertion-home-schema.spec.ts` — the 8 targeted specs:
  qualified create/drop, home-schema body resolution under the default session
  path, home-first name-collision preference, same-named assertions in two
  schemas enforcing and dropping independently, the wrong-qualifier drop that
  previously deleted `main`'s assertion silently, and schema-qualified
  `explain_assertion`.
- `test/logic/50-declarative-schema.sqllogic` (`nm_assert_pol` section, ~1718):
  declare non-`main` schema with table+assertion → apply → empty diff →
  conforming insert commits → violating insert fails at COMMIT → unrelated
  `main` write still commits → redeclare without assertion → diff shows
  `DROP ASSERTION IF EXISTS nm_assert_pol.a1` → apply → gone, diff empty.
- `test/schema/catalog.spec.ts` — declared-DDL qualification and the three-way
  hash regression.
- Full validation run: `yarn lint` clean (all 17 workspaces); `yarn test` from
  repo root fully green — 8,376 passing in quereus core (up from 8,365; 0
  failing, 13 pre-existing pendings), all other workspaces passing; `yarn build`
  clean across all packages.
