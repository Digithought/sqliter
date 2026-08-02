----
description: An integrity check that is supposed to live in one schema is quietly created in the default schema instead. The result is worse than it sounds — after that happens, every write to the database fails at commit, and the tool that keeps a schema matching its declaration never stops re-creating the check.
files:
  - packages/quereus/src/parser/ast.ts                              # CreateAssertionStmt.name (line ~387) — bare string, no schema slot
  - packages/quereus/src/parser/parser.ts                           # createAssertionStatement (~3109); tableIdentifier (~955) is the qualified-name helper
  - packages/quereus/src/planner/building/create-assertion.ts       # builder — must resolve the landing schema
  - packages/quereus/src/planner/building/drop-assertion.ts         # builder — drops `stmt.name.schema` on the floor today
  - packages/quereus/src/planner/nodes/create-assertion-node.ts     # node needs a schemaName field
  - packages/quereus/src/planner/nodes/drop-assertion-node.ts       # node needs a schemaName field
  - packages/quereus/src/runtime/emit/create-assertion.ts           # `getMainSchema() // Store in main schema for now` (line 71); getPlan at line 46; swallowed catch at 65
  - packages/quereus/src/runtime/emit/drop-assertion.ts             # `getMainSchema() // Look in main schema for now` (line 18)
  - packages/quereus/src/schema/assertion.ts                        # IntegrityAssertionSchema — needs schemaName
  - packages/quereus/src/schema/manager.ts                          # canonicalSchemaName / getCurrentSchemaName idiom; getAllAssertions (~466)
  - packages/quereus/src/core/database-assertions.ts                # cache key (255); _buildPlan (292); prepare/compile (426); context iface (66-68)
  - packages/quereus/src/core/database.ts                           # _homeSchemaPath (2071), getPlan/_buildPlan schemaPath params; invalidateAssertionCache (2561)
  - packages/quereus/src/core/statement.ts                          # _schemaPathOverride (74)
  - packages/quereus/src/planner/analysis/assertion-classifier.ts   # findTable at line 86 — resolves against main/temp, mis-targets the hoist
  - packages/quereus/src/emit/ast-stringify.ts                      # createAssertionToString (1229); declared-item render (1511)
  - packages/quereus/src/schema/schema-differ.ts                    # applyViewSchemaDefault (1072) is the model; assertion sites 297, 467, 846, 2519
  - packages/quereus/src/schema/catalog.ts                          # assertionSchemaToCatalog (742); generateDeclaredDDL (767) has NO assertion case
  - packages/quereus/src/schema/schema-hasher.ts                    # consumes generateDeclaredDDL
  - packages/quereus/src/func/builtins/schema.ts                    # assertion_info() TVF (~556) — no schema column, claims name is a key
  - packages/quereus/src/func/builtins/explain.ts                   # explain_assertion (~961) — find-first-by-name across schemas; plans body on session path
  - packages/quereus/test/emit/ast-stringify.spec.ts                # line 318 reads assertionStmt.name as a string
  - packages/quereus/test/emit-missing-types.spec.ts                # line 187 builds a CreateAssertionStmt literal
  - packages/quereus/test/emit-roundtrip-property.spec.ts           # lines 671, 771 build CreateAssertionStmt literals
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # non-main declarative section (~1668) is the place to add coverage
  - packages/quereus/test/view-home-schema.spec.ts                  # the sibling ticket's spec — same shape for assertions
  - docs/sql-ddl.md                                                 # § 2.6.1 CREATE/DROP ASSERTION
  - docs/schema.md                                                  # assertion change events, SchemaDiff
difficulty: hard
repro: verified
----

# An assertion has no schema of its own

## Background in one paragraph

An *assertion* in Quereus is a named integrity check that is evaluated when a
transaction commits: `create assertion a1 check (<condition>)`. Every other named
object — a table, an index, a view, a materialized view — belongs to a *schema*
(a namespace; every database has at least `main` and `temp`, and a `declare schema
<name> { … }` block creates more). An assertion does not. The two emitters that
create and drop one are hard-coded to the `main` schema, with the comments
`// Store in main schema for now` and `// Look in main schema for now`.

Everything below follows from that single missing piece of identity.

## What was reproduced

All four observations below were run, not inferred. The scratch spec used to get
them has been removed; the reproductions are trivially reconstructed from the
snippets here.

### 1. A non-`main` declaration never converges, and the check lands in `main`

```sql
declare schema apol using (default_vtab_module = 'memory') {
	table at_t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
	assertion a1 check (not exists (select 1 from at_t where x < 0))
}
apply schema apol;
diff schema apol;
```

`apply` reports success. `diff` still asks for
`create assertion a1 check (not exists (select 1 from at_t where x < 0))`, and
will on every subsequent run — the object it just created is in `main`, and the
comparison only looks inside `apol`. Confirmed directly: after the apply,
`main` holds `a1` and `apol` does not. The same declaration against `main`
converges on the first apply.

### 2. Every write to the database then fails at commit

This is the severe one and it was not previously recorded. Commit-time
enforcement compiles **every** live assertion whenever **any** base table changed
in the transaction (`database-assertions.ts`, `runGlobalAssertions` → the
unconditional `for (const assertion of assertions) getOrCompilePlan(assertion)`
loop). The stray `a1` sitting in `main` has an unqualified body naming `at_t`,
which exists only in `apol`, so compiling it throws. Verified with a write to a
completely unrelated table:

```
insert into main.unrelated values (1);
→ QuereusError: Table 'at_t' not found in schema path: main
```

So one mis-placed assertion makes the whole database unwritable until it is
dropped. The failure surfaces at COMMIT, far from the statement that caused it.

### 3. `drop assertion apol.a1` is accepted and silently drops the wrong thing

The original ticket recorded that the grammar cannot accept a schema-qualified
assertion name. That is **not** what happens — `DROP` shares the general
qualified-name parser (`tableIdentifier`), so `drop assertion temp.qa` parses
fine. The builder then reads only `stmt.name.name` and the emitter looks in
`main`, so the qualifier is discarded and an assertion of that name in `main` is
removed instead. Verified: `create assertion qa …` (lands in `main`) followed by
`drop assertion temp.qa` succeeds, removing `main.qa`. A silently-wrong drop is
worse than the parse error the ticket predicted.

### 4. Assertions are invisible to the declared-schema hash

`generateDeclaredDDL` (`catalog.ts:767`) has cases for tables, indexes, views and
materialized views — and none for assertions. `computeSchemaHash` is built on it.
Verified: three declarations — one with `check (x < 0)`, one with `check (x < 100)`,
and one with no assertion at all — all hash to `aVQXMAAaWg4`. Changing or removing
a declared assertion therefore does not change the schema version.

This is a different mistake from the missing schema identity, but it lives at the
same code site (`generateDeclaredDDL`, which must gain an assertion case anyway in
order to qualify the assertion's name), so it is an arm of this ticket rather than
its own.

## Why it is a language-surface change

`CreateAssertionStmt.name` is a bare `string` (`ast.ts:387`). A table, index or
view name is an `IdentifierExpr`, which carries an optional `schema`. So today no
statement — generated or hand-typed — can put an assertion anywhere but `main`,
and no rendered DDL can say where an assertion lives. The fix starts in the
grammar and the AST and follows through the builders, emitters, catalog, differ
and the commit-time evaluator.

## Prior art to copy, not reinvent

The sibling ticket `bug-declared-materialized-view-non-main-schema` (now in
`tickets/complete/`) solved the identical shape for views and materialized views
and left behind exactly the machinery this ticket needs:

- **`Database._homeSchemaPath(schemaName)`** (`database.ts:2071`) composes
  `[owner's schema, ...session default path]`, deduped. For `'main'` it equals
  today's default path, so `main` behavior is unchanged by construction.
- **`getPlan(sql, schemaPath?)`**, **`_buildPlan(stmts, params?, schemaPathOverride?)`**
  and **`_buildProbeContext(params?, schemaPathOverride?)`** already accept the
  override.
- **`Statement._schemaPathOverride`** (`statement.ts:74`) is the seam for the one
  call path that plans through a prepared statement. `Statement.compile()` is lazy
  and `db.prepare()` does not cache or share statements, so setting the field
  right after `prepare` is race-free (established during that ticket's review).
- **`applyViewSchemaDefault(stmt, targetSchemaName)`** (`schema-differ.ts:1072`) is
  the exported helper that stamps the declared schema onto a rendered statement.
  An assertion equivalent should be written the same way and shared with
  `catalog.ts` (that ticket's review had to un-duplicate exactly this).
- The landing-schema idiom used by every DDL builder is
  `stmt.x.schema ? sm.canonicalSchemaName(stmt.x.schema) : sm.getCurrentSchemaName()`
  — see `planner/building/create-view.ts:60`.

Reading that ticket's `## Review findings` before starting is worth the ten
minutes; it enumerates the seams that were easy to miss for views.

## Expected behavior

- An assertion declared inside a schema is created in that schema, and a
  re-`diff` immediately after `apply schema` reports no remaining difference.
- `create assertion <schema>.<name> check (…)` and
  `drop assertion [if exists] <schema>.<name>` both name the intended schema; an
  unqualified name means the current schema, matching every other DDL statement.
- A stored assertion body resolves its unqualified table names against the
  assertion's own schema first, independent of the session's search path — the
  same rule views and materialized views now follow.
- Two assertions with the same name in different schemas coexist without either
  shadowing the other or corrupting the other's cached plan.
- A change to a declared assertion changes the declared-schema hash.
- Nothing about `main`-schema assertions changes.

## Out of scope (mentioned so it is not rediscovered)

Assertions are **not persisted**. `collectSchemaCatalog` emits a
`CatalogAssertion` per assertion, but the only consumer is the differ;
`SchemaManager.importDDL` throws on `createAssertion`, and nothing feeds assertion
DDL back into `importCatalog`. So an assertion does not survive reopening a
store-backed database. That is a missing capability rather than a defect in this
ticket's chain, and `catalog.ts:750-754` already documents the gap. Do not try to
add persistence here.

## Compatibility note

Arm D changes `computeSchemaHash` output for any declaration containing an
assertion (today it hashes as if the assertion were absent). That is the point of
the fix, but it means such schemas report a version change on first run after this
lands. Per `AGENTS.md` ("Backwards compat: don't worry yet") this is acceptable —
just say so in the handoff so the reviewer is not surprised.

## TODO

### Phase 1 — schema identity on the statement and the schema object

- Change `CreateAssertionStmt.name` from `string` to `IdentifierExpr`; parse it
  with the existing `tableIdentifier()` helper in `createAssertionStatement`.
- Add `schemaName: string` to `IntegrityAssertionSchema`.
- `buildCreateAssertionStmt` / `buildDropAssertionStmt`: resolve the landing
  schema with the `canonicalSchemaName(…) ?? getCurrentSchemaName()` idiom and
  carry it on `CreateAssertionNode` / `DropAssertionNode`.
- `emitCreateAssertion`: land in `plan.schemaName` instead of `getMainSchema()`;
  set `schemaName` on the stored `IntegrityAssertionSchema`; keep the duplicate
  check (it is already per-schema, so it becomes correct once the schema is
  right). Update the `note:` to `createAssertion(<schema>.<name>)`.
- `emitDropAssertion`: look in `plan.schemaName`; honor `ifExists` per schema.
- `createAssertionToString` and the declared-item renderer at
  `ast-stringify.ts:1511` render the qualified name.

### Phase 2 — a stored body resolves against its home schema

- Widen `AssertionEvaluatorContext._buildPlan` to accept the schema-path override
  and pass `db._homeSchemaPath(assertion.schemaName)` at
  `database-assertions.ts:292`.
- `executeViolationOnce` needs the assertion's schema too: set
  `stmt._schemaPathOverride` on the prepared statement before `stmt.compile()`
  (line 426). Thread the schema through its call sites rather than re-deriving it.
- `emitCreateAssertion`'s dependency discovery (`rctx.db.getPlan(violationSql)`,
  line 46) plans under the home path. Its `catch` at line 65 currently swallows a
  total failure — in the reproduction above it produced `dependent_tables: []`
  with only a debug log. Raise it to a warning that names the assertion and says
  enforcement falls back to the full violation query, so a silent degradation is
  distinguishable from an assertion that genuinely has no dependencies.
- `assertion-classifier.ts:86`: `schemaManager.findTable(name, schema)` with
  `schema === undefined` searches `main` then `temp`. For a non-`main` assertion
  with an unqualified body this resolves to the *wrong* table, and the hoisted
  synthetic CHECK is then folded onto that table's plan — a correctness hazard,
  not just a missed optimization. Pass the assertion's home schema as the
  fallback. Note the classifier currently receives only `{ name, violationSql }`-ish
  assertion data; widen what it is given.
- `explain_assertion` (`explain.ts:961`) plans the body on the session path and
  finds the assertion by bare name across all schemas — give it the home path and
  let it accept a `schema.name` argument (bare name keeps working).

### Phase 3 — identity keys stop colliding across schemas

- `AssertionEvaluator.cache` is keyed by lowercase bare name (line 255). Key it by
  `schema.name` so two same-named assertions in different schemas do not evict
  each other's compiled plan.
- `Database.invalidateAssertionCache(name)` (line 2561) and its caller in
  `emitDropAssertion` take the qualified key.
- `assertion_info()` (`func/builtins/schema.ts`): add a `schema_name` column and
  change `relationalAdvertisement.keys` from `[[{index: 0}]]` to the
  (schema_name, name) pair. The current single-column key is an untrue uniqueness
  claim the moment two schemas hold the same assertion name, and the optimizer is
  entitled to act on it.
- `SchemaManager.getAllAssertions()` flattens every schema; audit its callers now
  that names are no longer globally unique.

### Phase 4 — declarative pipeline

- Add `applyAssertionSchemaDefault` next to `applyViewSchemaDefault` in
  `schema-differ.ts` and use it at line 846 (`assertionsToCreate`). Do not inline
  a second copy in `catalog.ts` — export and share it.
- `schema-differ.ts:297` and `:467` read `item.assertionStmt.name` as a string;
  update for the `IdentifierExpr` change. Confirm the per-schema
  duplicate-name detection still keys on the bare name within the target schema.
- The `DROP ASSERTION IF EXISTS <prefix><name>` render at line 2519 already emits
  a schema prefix — once Phase 1 lands it stops being a lie. Verify it round-trips.
- Add the missing `declaredAssertion` case to `generateDeclaredDDL`
  (`catalog.ts:767`), qualified via the shared helper. Note `declaredSeed` is
  also absent there; leave it alone (a seed is data, not shape).
- `assertionSchemaToCatalog` (`catalog.ts:742`) renders the qualified name.

### Phase 5 — tests and docs

- Extend `test/logic/50-declarative-schema.sqllogic`, alongside the
  `nm_view_pol` section added by the sibling ticket (~line 1668): declare a
  non-`main` schema holding a table and an assertion, apply, assert `diff` is
  empty, insert a violating row and assert the COMMIT fails, insert a conforming
  row and assert it succeeds, and confirm an unrelated write still commits.
- Spec coverage in the style of `test/view-home-schema.spec.ts` for: an assertion
  created directly with `create assertion <schema>.<name>`; its body resolving
  unqualified names in its own schema under the default session path; two
  same-named assertions in two schemas both enforcing independently;
  `drop assertion <schema>.<name>` removing the right one and leaving the other.
- A regression spec for the hash arm: two declarations differing only in an
  assertion body must hash differently, and a declaration with an assertion must
  differ from the same one without.
- Update the three test files that build `CreateAssertionStmt` literals or read
  `assertionStmt.name` as a string (`emit/ast-stringify.spec.ts:318`,
  `emit-missing-types.spec.ts:187`, `emit-roundtrip-property.spec.ts:671` and
  `:771`).
- `docs/sql-ddl.md` § 2.6.1: document the qualified spelling for both `create` and
  `drop`, and the home-schema body-resolution rule (cross-reference the view/MV
  rule rather than restating it). `docs/schema.md`: assertions now carry a schema.
- Run `yarn lint` and `yarn test` from the repo root; both must be green.
