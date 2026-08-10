---
description: An integrity check now belongs to the schema it was declared in — creating, dropping, enforcing, and re-declaring it all target the right schema, and a check declared outside the default schema no longer breaks every later write to the database.
files:
  - packages/quereus/src/parser/ast.ts                              # CreateAssertionStmt.name is an IdentifierExpr
  - packages/quereus/src/parser/parser.ts                           # createAssertionStatement uses tableIdentifier()
  - packages/quereus/src/planner/building/create-assertion.ts       # landing-schema idiom (canonicalSchemaName ?? current)
  - packages/quereus/src/planner/building/drop-assertion.ts         # same idiom; qualifier no longer dropped
  - packages/quereus/src/planner/nodes/create-assertion-node.ts     # schemaName field
  - packages/quereus/src/planner/nodes/drop-assertion-node.ts       # schemaName field
  - packages/quereus/src/runtime/emit/create-assertion.ts           # lands in plan.schemaName; home-path + hoist-suppressed dep discovery
  - packages/quereus/src/runtime/emit/drop-assertion.ts             # per-schema lookup + qualified cache invalidation
  - packages/quereus/src/schema/assertion.ts                        # IntegrityAssertionSchema.schemaName
  - packages/quereus/src/core/database-assertions.ts                # home-path body plans; qualified cache keys; qualified violation messages
  - packages/quereus/src/core/database.ts                           # invalidateAssertionCache(schemaName, name)
  - packages/quereus/src/planner/analysis/assertion-classifier.ts   # findTable with [home, main, temp] fallback path
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts  # provenance-ambiguity NOTE
  - packages/quereus/src/emit/ast-stringify.ts                      # qualified renders
  - packages/quereus/src/schema/schema-differ.ts                    # applyAssertionSchemaDefault (exported, shared)
  - packages/quereus/src/schema/catalog.ts                          # generateDeclaredDDL assertion case; qualified catalog ddl
  - packages/quereus/src/func/builtins/schema.ts                    # assertion_info(): schema_name column, (schema_name, name) key
  - packages/quereus/src/func/builtins/explain.ts                   # explain_assertion: schema.name arg, home path, hoist suppression
  - packages/quereus/test/assertion-home-schema.spec.ts             # 10 specs
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts    # + 2 classifier home-schema specs
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # non-main assertion declarative section (~1718)
  - packages/quereus/test/schema/catalog.spec.ts                    # declared-DDL + hash regression specs
  - docs/sql-ddl.md, docs/schema.md, docs/functions.md, docs/optimizer-retrieve.md
---

# Assertions have a home schema — reviewed and complete

## What shipped

An integrity assertion now carries a schema identity end to end.

**Language surface.** `CreateAssertionStmt.name` is an `IdentifierExpr` parsed with
the shared `tableIdentifier()` helper, so `create assertion apol.a1 check (…)` and
`drop assertion [if exists] apol.a1` both work; an unqualified name means the
current schema, like every other DDL statement. Both builders resolve the landing
schema with the standard `canonicalSchemaName(…) ?? getCurrentSchemaName()` idiom
and carry it on the plan nodes; the emitters use it instead of `getMainSchema()`.

**Home-schema body resolution.** `IntegrityAssertionSchema` gained `schemaName`,
and every seam that plans a stored assertion body passes
`db._homeSchemaPath(schemaName)` — create-time dependency discovery, the
commit-time evaluator's `_buildPlan`, `executeViolationOnce` (via
`Statement._schemaPathOverride`), the hoist classifier's `findTable` (fallback
path `[home, 'main', 'temp']`), and `explain_assertion`. This kills the severe
failure mode: a non-`main` assertion with an unqualified body no longer makes
*every* write to the database fail at commit.

**Qualified identity keys.** The evaluator's plan cache, its DeltaExecutor
subscription ids, and `Database.invalidateAssertionCache` are keyed by lowercase
`schema.name`, so two same-named assertions in different schemas coexist and
enforce independently. `assertion_info()` gained a `schema_name` column and its
relational key is the honest `(schema_name, name)` pair. `explain_assertion`
accepts `'schema.name'` (bare name still works, first match across schemas).

**Declarative pipeline.** `applyAssertionSchemaDefault` (exported from
`schema-differ.ts`, shared with `catalog.ts`) qualifies the rendered
`create assertion` in migration DDL, so `apply schema apol` lands the assertion in
`apol` and an immediate re-`diff` is empty. `generateDeclaredDDL` gained the
missing `declaredAssertion` case, so a declared assertion participates in
`computeSchemaHash`.

**Adjacent fix folded in by the implementer.** `explain_assertion` never
suppressed assertion-hoisting while planning the body, so any canonical-shaped
(`not exists (select 1 from T where P)`) assertion folded to empty and the TVF
returned zero rows — pre-existing on `main` too. Now wrapped in
`withSuppressedAssertionHoist`, matching the commit-time evaluator.

## Review findings

Reviewed the implement diff (`97bc6b70`) file by file before reading the handoff.
Angles covered: schema-identity plumbing end to end, cache/subscription keying,
declarative diff/apply round trip, schema-change invalidation, hoist-classifier
soundness, docs currency, and test coverage of each arm.

### Fixed in this pass (minor)

- **`create-assertion.ts` — warning text described behavior that does not
  exist.** The implementer's new dependency-discovery warning claimed
  "enforcement falls back to the full violation query." It does not:
  `dependentTables` is read only by `assertion_info()` (verified — that is its
  single consumer); the evaluator recomputes its own base set from the compiled
  plan. Rewrote the message to say what actually degrades.
- **`create-assertion.ts` — dependency discovery ran with assertion-hoisting
  active.** `getPlan` there was unsuppressed, so another assertion's hoisted
  premises could fold a base reference out of the plan and blank
  `assertion_info().dependent_tables`. Wrapped in `withSuppressedAssertionHoist`,
  which also makes the discovered set agree with the evaluator's
  `baseTablesInPlan` (same suppression, same plan shape).
- **Violation messages were ambiguous for non-`main` assertions.** The handoff
  logged this as an accepted judgment call, reasoning that qualifying only
  non-`main` "felt inconsistent." But qualify-only-outside-`main` is already the
  established idiom here — `applyAssertionSchemaDefault` and
  `assertionSchemaToCatalog` both do exactly that. With same-named assertions in
  two schemas now legal, `Integrity assertion failed: dup` cannot identify which
  one fired. Added `assertionDisplayName()` next to `assertionCacheKey()`;
  non-`main` now reports `temp.dup`. Zero churn to the 37 existing pinned
  message sites (all `main`); updated the three new non-`main` expectations and
  documented the format in `docs/sql-ddl.md`.

### Test gaps closed (minor)

The implementer's 8 specs covered create/drop/enforce/collision well but left
three claims unexercised:

- **The classifier's new `[home, 'main', 'temp']` fallback path had no test at
  all** — the subtlest change in the diff. Added two unit specs to
  `assertion-as-premise.spec.ts`: home-first binding when the same table name
  exists in two schemas, and fallback to the default path when the home schema
  holds no such table.
- **"Unqualified means the current schema"** was asserted in docs and the ticket
  but never tested (only `main` was ever current). Added a spec that sets the
  current schema to `temp`, creates an unqualified assertion, and checks it both
  lands in and enforces from `temp`.
- **The documented `Schema not found` rejection** for a create qualified with a
  non-existent schema was untested. Added a spec. While writing it, confirmed
  the handoff's premise was wrong: `create table other.t` does *not* auto-create
  its schema either (`SchemaManager.createTable` throws). Auto-create happens
  only on catalog rehydration and declarative apply. So assertions match the
  direct-DDL behavior of tables — this is not a divergence and needs no change.

### Tripwires recorded (not tickets)

- **Hoist provenance carries the bare assertion name**, which is only unique per
  schema, so two same-named assertions hoisting onto the same table are
  indistinguishable in `source: { kind: 'assertion', name }`. Harmless today —
  invariant OPT-052 states provenance is informational and no rule branches on
  it. Parked as a `NOTE:` at `assertion-hoist-cache.ts:133` saying to key on
  `schemaName.name` if a rule ever reads it.

### Checked and found clean (no action)

- **Schema-name case handling.** `SchemaManager.addAssertion` / `removeAssertion`
  / `getSchema` all lowercase their lookups, and plan nodes carry canonicalized
  names, so `DROP ASSERTION APOL.A1` finds `apol.a1`.
- **Stale subscriptions on schema drop.** Considered whether a dropped schema
  could strand a compiled plan and live DeltaExecutor subscription for its
  assertions. There is no `drop schema` DDL in the engine — not reachable.
- **`getPlan` caching.** No plan cache behind `Database.getPlan`, so the new
  `schemaPath` argument cannot collide two same-SQL bodies from different
  schemas.
- **`CatalogAssertion.name` staying bare.** Confirmed the differ reads only
  `.name` from the actual catalog (never `.ddl`), and the catalog is per-schema,
  so bare is correct and the qualified `.ddl` is display-only.
- **Cross-schema-qualified declared items.** `assertion pol.a1` inside
  `declare schema other { … }` would be keyed bare and created in `pol`,
  diverging on re-diff. Verified declared views and materialized views have the
  identical gap (`declaredViews.set(item.viewStmt.view.name…)`) — pre-existing
  and consistent, not introduced here.
- **DRY.** `applyAssertionSchemaDefault` mirrors `applyViewSchemaDefault`
  exactly, `createAssertionToString` reuses the same `expressionToString`
  identifier rendering as `createViewToString`, and the home-path idiom matches
  the ten other `_homeSchemaPath` call sites. No duplication introduced.
- **Docs.** Read every doc mentioning assertions, not just the four the diff
  touched. `optimizer-assertions.md`, `optimizer-fd.md`, `architecture.md`,
  `incremental-maintenance.md`, `change-scope.md`, `invariants.md` (SCH-003,
  OPT-052), `errors.md`, `module-capabilities.md` — none makes a claim the
  change invalidates. `schema.md` is the canonical home-schema doc and was
  correctly extended.

### Deferred, by design

- **A declared assertion body change is invisible to `diff schema`**
  (presence-only comparison). Real, verified, pre-existing, distinct root cause
  — already filed by the implementer as
  `fix/bug-assertion-body-drift-invisible-to-diff`.
- **Assertions are not persisted** across a store-backed reopen. Explicitly
  out of scope on the original ticket; documented at `catalog.ts:750`.
- **The classifier's fallback path is the static `[home, 'main', 'temp']`**, not
  the live `schema_path` option (the classifier holds only a `SchemaManager`).
  Divergence needs a customized session path *plus* same-named tables across
  schemas, and hoisting is an additive optimizer overlay — enforcement always
  uses the true home path. Noted at the site by the implementer; accepted.

## Compatibility note

`computeSchemaHash` output changes for any declaration containing an assertion
(previously hashed as if absent). Such schemas report a version change on first
run after this lands. Sanctioned by AGENTS.md ("Backwards compat: don't worry
yet").

## Validation

- `yarn lint` — clean across all 17 workspaces.
- `yarn test` — fully green. `packages/quereus`: **8,380 passing**, 0 failing,
  13 pre-existing pendings (8,365 before the implement stage; +11 from the
  implementer, +4 from this review). All other workspaces passing.
- `yarn build` — clean across all packages.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
