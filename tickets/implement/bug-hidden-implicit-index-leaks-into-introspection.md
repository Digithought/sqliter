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

## Status: fix already applied and verified during the fix-stage investigation

The root cause turned out to be a two-line omission, so the fix, its tests, and
the doc update were completed directly rather than deferred. This ticket
documents what changed so the implement → review handoff has a real diff to
review, not a re-derivation of the fix stage's work.

## Root cause

`schema()` and `index_info()` in `packages/quereus/src/func/builtins/schema.ts`
iterated `tableSchema.indexes` (and, for `index_info()`, `table.indexes`)
unfiltered. Every other DDL surface (`ALTER INDEX`, `DROP INDEX`, `CREATE INDEX`
duplicate-check, `collectSchemaCatalog`) already treats the auto-built covering
structure behind a `UNIQUE` constraint as hidden unless the constraint opted in
via the `quereus.expose_implicit_index` tag, using the predicate
`isHiddenImplicitIndex(tableSchema, indexName)` in
`packages/quereus/src/schema/catalog.ts`. These two table-valued functions were
the only two read paths that hadn't been wired to that predicate — so the
memory backend (which materializes the structure as a real `IndexSchema` entry)
leaked it into introspection, while the store backend (which doesn't
materialize it) did not.

## What changed

- `schema.ts`'s `schemaFunc` generator: skip an index row when
  `isHiddenImplicitIndex(tableSchema, indexSchema.name)` is true, before
  yielding it.
- `indexInfoFunc`: filter `table.indexes` through the same predicate before
  concatenating with the already-correct `exposedImplicitIndexes(table)` list
  (which supplies the store-mode synthetic descriptor for *exposed* implicit
  indexes — unaffected by this change).
- `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`: added section
  "6a" — cross-backend assertions that `schema()` / `index_info()` omit the
  named, unnamed (`_uc_<cols>`), and mixed-case hidden cases; that the exposed
  case (`uq_vin`) still appears via `index_info()` with its tags (schema() side
  was already pinned); and that a `create unique index`-derived constraint
  (the user's own index) still appears on both surfaces. Runs on both backends
  per the file's existing `requires-capability: standalone-index-ddl` /
  dual-backend convention.
- `test/alter-drop-rename-constraint.spec.ts`: this file's `indexNames()` helper
  previously read `index_info()` to observe the memory-specific covering-index
  lifecycle (build on `CREATE TABLE … UNIQUE`, rename on `RENAME CONSTRAINT`,
  teardown on `DROP CONSTRAINT`). With the fix, `index_info()` now legitimately
  never shows a hidden implicit index, so it can no longer serve as that
  observation point. Rewrote the helper to read `db._findTable(table)?.indexes`
  directly instead — the actual in-memory materialization the file's docstring
  says it's pinning. No behavioral assertion changed; only the read path the
  assertions go through.
- `docs/sql-ddl.md` §6.3: added one bullet after the existing "`DROP INDEX` on
  an implicit covering structure raises `no such index`" note, stating that
  `schema()` / `index_info()` also omit the hidden structure on every backend,
  while the exposed case and `CREATE UNIQUE INDEX`-derived indexes keep
  appearing — closing the doc gap the ticket description pointed at.

## Verification performed

- `yarn tsc -p tsconfig.json --noEmit` and `yarn tsc -p tsconfig.test.json --noEmit`
  in `packages/quereus` — clean.
- `node test-runner.mjs --grep "10.5.7"` and `node test-runner.mjs --store --grep "10.5.7"`
  — both pass (the new cross-backend assertions included).
- `node test-runner.mjs --grep "50-metadata-tags"` and the `--store` variant —
  both pass (the exposed-index regression guard the ticket called out is
  intact).
- `yarn test` (full workspace, memory backend) — 8056 passing, 0 failing.
- `node test-runner.mjs --store` (full `packages/quereus` logic suite against
  LevelDB) — 8047 passing, 22 pending (pre-existing memory-only skips), 0
  failing.

No pre-existing failures were encountered; nothing was written to
`tickets/.pre-existing-error.md`.

## Gaps / things a reviewer should double check

- I did not exhaustively re-grep every test file that queries `schema()` /
  `index_info()` for a name shaped like a UNIQUE constraint beyond the ones the
  full suite run already exercises — the full-suite green run is the actual
  evidence of no other regressions, not an exhaustive manual audit.
- The `alter-drop-rename-constraint.spec.ts` rewrite changes *how* the covering
  index's memory-only lifecycle is observed (via `TableSchema.indexes` instead
  of `index_info()`). This is a deliberate, in-scope consequence of the fix
  (the old assertions were pinning the very leak this ticket closes), not scope
  creep — but worth a reviewer's eye since it touches a file this ticket's
  `files:` list didn't originally name.

## TODO

- Review the diff above.
- Promote to `tickets/complete/` with a `## Review findings` section (expected:
  none, or minor/nit-only, given the verification already performed).
