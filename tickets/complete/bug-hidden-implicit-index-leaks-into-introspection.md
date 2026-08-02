description: A declared UNIQUE constraint's helper index was showing up in schema introspection results as if the user had created it — this closes that leak so it behaves the same on both storage backends.
files:
  - packages/quereus/src/func/builtins/schema.ts (schema() index rows, index_info())
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex — used, not changed)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts
  - docs/sql-ddl.md (§6.3), docs/functions.md (index_info section)
---

## What shipped

`schema()` and `index_info()` filter their index rows through the pre-existing
`isHiddenImplicitIndex(tableSchema, name)` predicate, so the auto-built covering
index behind a plain `UNIQUE` constraint no longer surfaces as if the user had
created it. Previously it leaked on the memory backend (which materializes it as
a real `IndexSchema`) while staying invisible on the store backend (which does
not) — the two introspection functions were the last read paths not yet wired to
the predicate that `ALTER INDEX`, `DROP INDEX`, `CREATE INDEX` dup-check and
`collectSchemaCatalog` already used.

Exposed implicit indexes (`quereus.expose_implicit_index = true`) still appear,
with their tags, on both backends. A `CREATE UNIQUE INDEX`-derived index is the
user's own and always appears.

Landed in commit `7d6bba68` (fix stage): 2-line functional change in
`packages/quereus/src/func/builtins/schema.ts`, plus tests and a docs bullet.
Later tickets (`bug-unique-constraint-name-collides-with-index-name`,
`bug-rename-column-shifts-unnamed-unique-index-name`,
`bug-duplicate-unnamed-unique-constraint`,
`bug-memory-unique-reuses-partial-index`) have since layered assertions on top of
this behavior in the same sqllogic file, so it is well exercised.

## Review findings

**Scope audit — other unfiltered index read paths (the ticket's main open
question).** Swept every `.indexes` reference in `packages/quereus/src` and in
every other package. Nothing else needs the filter:

- Introspection / catalog surfaces: only `schema()`, `index_info()` (now fixed)
  and `collectSchemaCatalog` (already filtered). `quereus-store`'s
  `buildCatalogEntry` filters too.
- Everything else is physical/internal and *wants* the implicit structure:
  memory layer + manager, store scan/constraint/index modules, isolation overlay
  schemas, planner access-path selection, `catalog-persistability`'s AST clone,
  `shiftSchemaIndicesForDrop`. `quereus-sync`'s `sync-manager-impl.ts:443`
  snapshots index names to reclaim *physical index stores* on eviction — must
  stay unfiltered.
- No plugin-facing catalog API walks indexes outside these.

**Test-file read-path change** (`alter-drop-rename-constraint.spec.ts`:
`index_info()` → `db._findTable(table)?.indexes`) — checked and correct. That
file's stated purpose is pinning the memory-only materialization lifecycle, and
`index_info()` stopped being a valid observation point for it once the leak
closed; assertion intent is unchanged, and the docstring now says so. The
cross-backend behavior it used to observe indirectly is covered directly by the
sqllogic file.

**Test coverage** — reviewed section 6a (named / unnamed `_uc_<cols>` /
mixed-case hidden cases, exposed-with-tags case, `CREATE UNIQUE INDEX` case,
both backends). Ran the 10.5.7 file on memory and store (1 passing each) and the
`covering-index behaviour` describe block (9 passing). No coverage gap found
worth an extra case: the exposed→unexposed transition and rename interactions
are already pinned elsewhere in the same file by the follow-on tickets.

**Docs** — read every touched doc and the ones that should have been touched.
`docs/sql-ddl.md` §6.3 and `docs/schema.md` already state the rule correctly.
`docs/functions.md`, the reference for these two TVFs, did not mention it —
**fixed inline**: one sentence after the `index_info()` column table pointing at
sql-ddl §6.3. `node scripts/check-docs.mjs` passes (links, sizes).

**Tripwire recorded** — `isHiddenImplicitIndex` rebuilds the table's exposure
map on every call, so the `schema()` loop is O(indexes × unique constraints) per
table; `collectSchemaCatalog` hoists the map instead. Irrelevant at realistic
table widths. Parked as a `NOTE:` comment at the call site in
`packages/quereus/src/func/builtins/schema.ts`, not filed as a ticket.

**No new tickets filed** — nothing major found. The change is a straight
consistency fix onto a shared, pre-existing predicate; no new logic, no error
paths, no resource lifecycle, no type-safety concerns (the `index_info` filter
keeps the `IndexSchema | SyntheticExposedIndex` union intact).

## Verification

- `yarn lint` (all workspaces) — clean, exit 0, including the quereus
  `tsc -p tsconfig.test.json --noEmit` pass over spec files.
- `node scripts/check-docs.mjs` — OK.
- `node test-runner.mjs --grep "10.5.7"` (memory) and `--store --grep "10.5.7"`
  — 1 passing each. `--grep "covering-index behaviour"` — 9 passing.
- Full quereus suite (`node test-runner.mjs --no-bail`): **8322 passing, 13
  pending, 2 failing**. Both failures are in the optimizer/join planner and are
  **not from this ticket's diff**:
  - `rulePredicateInferenceEquivalence › Inferred predicate is pushed to the
    vtab access leaf when supported` (`test/optimizer/rule-predicate-inference-equivalence.spec.ts:232`)
  - `Plan shape: scalar-aggregate subquery decorrelation (filter site) ›
    rewrites a HAVING comparison … into a grouped left join`
    (`test/plan/scalar-agg-decorrelation.spec.ts:393`)

  Cause: uncommitted concurrent work sitting in the shared working tree from the
  in-flight implement tickets (`src/planner/cost/index.ts`,
  `rules/access/rule-select-access-path.ts`, `rules/access/rule-key-set-seek.ts`,
  `rules/join/rule-join-physical-selection.ts`, plus untracked
  `rules/join/index-nested-loop.ts` and `rules/shared/access-leaf.ts`). Both
  failing assertions are about INDEXSEEK counts and join physical selection —
  exactly what those edits change. Deliberately **not** recorded in
  `tickets/.pre-existing-error.md`: they are not broken at HEAD and not stale;
  they belong to work another agent is mid-way through, whose own validation
  will resolve them. Nothing was skipped, disabled or loosened.
