description: A declared UNIQUE constraint's helper index was showing up in schema introspection results as if the user had created it — this closes that leak so it behaves the same on both storage backends.
prereq:
files:
  - packages/quereus/src/func/builtins/schema.ts (schema() index rows, index_info())
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex — used, not changed)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts
  - docs/sql-ddl.md (§6.3, new bullet after the DROP INDEX note)
difficulty: easy
---

## Summary

`schema()` and `index_info()` (both in `packages/quereus/src/func/builtins/schema.ts`)
iterated indexes unfiltered, so the auto-built covering index behind a plain
`UNIQUE` constraint leaked into introspection output on the memory backend
(which materializes it as a real `IndexSchema` entry) while staying hidden on
the store backend (which doesn't materialize it). Every other DDL surface
(`ALTER INDEX`, `DROP INDEX`, `CREATE INDEX` dup-check, `collectSchemaCatalog`)
already filtered through `isHiddenImplicitIndex()` in
`packages/quereus/src/schema/catalog.ts` — these two table-valued functions
were the only read paths that hadn't been wired up.

## Fix (already landed, commit 7d6bba68)

Two call sites in `schema.ts`, both now filter through the existing
`isHiddenImplicitIndex(tableSchema, name)` predicate before yielding/including
a row:

- `schemaFunc`'s index-row generator: `if (isHiddenImplicitIndex(tableSchema, indexSchema.name)) continue;`
- `indexInfoFunc`: `table.indexes` filtered before concatenating with
  `exposedImplicitIndexes(table)` (the store-mode synthetic descriptor path for
  *exposed* implicit indexes — untouched, was already correct).

No other files under `src/` changed. Diff is a 2-line functional change plus
tests/docs.

## Test coverage added

- `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`, new section
  "6a": asserts `schema()` / `index_info()` omit the hidden implicit index for
  named, unnamed (`_uc_<cols>`), and mixed-case UNIQUE constraints; confirms
  the *exposed* case (`uq_vin`, via the `quereus.expose_implicit_index` tag)
  still appears with its tags on `index_info()` (schema() side was already
  pinned pre-fix); confirms a `CREATE UNIQUE INDEX`-derived (user-owned) index
  still appears on both surfaces. Runs on both memory and store backends
  (file's existing dual-backend convention, `requires-capability:
  standalone-index-ddl`).
- `test/alter-drop-rename-constraint.spec.ts`: this file observes the
  memory-only covering-index lifecycle (build on `CREATE TABLE … UNIQUE`,
  rename on `RENAME CONSTRAINT`, teardown on `DROP CONSTRAINT`). It previously
  read that lifecycle through `index_info()` — which, after the fix, correctly
  never shows a hidden implicit index, so it stopped working as an observation
  point. The `indexNames()` helper was rewritten to read
  `db._findTable(table)?.indexes` directly (the actual in-memory
  materialization the file's docstring says it's pinning). No assertions
  changed in intent — only which read path they go through.

## Verification performed (this pass, re-run against the landed commit)

- `yarn tsc -p tsconfig.json --noEmit` and `yarn tsc -p tsconfig.test.json --noEmit` in `packages/quereus` — both clean.
- `node test-runner.mjs --grep "10.5.7"` (memory) and `--store --grep "10.5.7"` (LevelDB) — both 1 passing.
- `node test-runner.mjs --grep "covering-index behaviour"` (the `alter-drop-rename-constraint.spec.ts` describe block) — 5 passing.
- Diff inspected directly (`git show 7d6bba68 -- packages/quereus/src/func/builtins/schema.ts`) — confirms the fix is exactly the 2-line filter described above, nothing broader.

Not independently re-run this pass (already reported green in the fix-stage
investigation, no reason to expect drift given the diff scope): full `yarn
test` (8056 passing) and full `node test-runner.mjs --store` (8047 passing, 22
pre-existing memory-only pending). Working tree was clean at handoff, so
nothing changed underneath those numbers.

## What to check in review

- Confirm no other introspection surface (e.g. a future `pragma`-style
  function, or a plugin-facing catalog API) does its own unfiltered
  `tableSchema.indexes` / `table.indexes` walk — the fix-stage ticket noted the
  full-suite green run was the evidence here, not an exhaustive grep audit.
- `alter-drop-rename-constraint.spec.ts`'s read-path change (`index_info()` →
  `db._findTable(table)?.indexes`) is in-scope (the old assertions were pinning
  the very leak being closed) but touches a file the original bug ticket's
  `files:` list didn't name up front — worth a second look since it's a test
  behavior change, not just a new test.
- No tripwires identified — the predicate (`isHiddenImplicitIndex`) is
  pre-existing and shared with the already-correct DDL surfaces, so this is a
  straight consistency fix, not new logic.

## TODO

- Adversarial review pass per stage rules (minor → fix inline; major → new
  ticket; speculative → tripwire comment, not a ticket).
- Promote to `tickets/complete/` with a `## Review findings` section.
