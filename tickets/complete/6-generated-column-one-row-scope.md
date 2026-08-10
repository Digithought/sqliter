---
description: A computed column's formula used to be compiled separately by each kind of write statement, each accepting a different way of spelling the column names in it; now one shared builder handles all of them, so a table definition the engine accepts can no longer turn out to reject every insert.
files:
  - packages/quereus/src/planner/building/generated-column-scope.ts   # the shared builder
  - packages/quereus/src/planner/building/insert.ts                   # createGeneratedColumnProjection, appendGeneratedRecomputes
  - packages/quereus/src/planner/building/update.ts                   # generated recompute loop
  - packages/quereus/src/planner/building/alter-table.ts              # buildAddColumnBackfill generated arm
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts        # renamed fn + widened doc
  - packages/quereus/src/schema/rename-rewriter.ts                    # barrel re-export
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic
  - docs/sql-ddl.md                                                   # § Generated Columns
  - docs/sql-alter.md                                                 # § ADD COLUMN
  - docs/determinism.md                                               # ADD COLUMN generated arm; INSERT/UPDATE validation list
---

# One row scope for generated-column expressions at every write site

## What shipped

`planner/building/generated-column-scope.ts` exports one function,
`buildGeneratedColumnExpr`, which compiles a `generated always as (...)` body against
the row it computes from. It strips self-qualifiers on a clone of the stored AST,
registers bare `<col>` and `new.<col>` per row attribute, wraps in
`schemaAuthoredContext`, builds, and runs `validateDeterministicGenerated`.

All four sites that used to do this differently now call it: the INSERT row-expansion
projection chain, the `on conflict do update` recompute, the UPDATE recompute, and the
`alter table ... add column` backfill. `stripSelfQualifierInCheckExpression` was
renamed `stripSelfQualifierInSchemaExpression` (it now serves CHECK and generated
bodies both), with the barrel re-export, both call sites, and the one test import moved
together.

Accepted spellings, identical at all four sites: `<col>`, `<table>.<col>`,
`<own-schema>.<table>.<col>`, `new.<col>`. `old.<col>` is rejected. Mutation-context
variables deliberately do **not** shadow a column inside a generated body — see the
implement handoff's deviation 2, which the review upheld (rationale below).

## Review findings

Read the implement diff (`1928326b`) before the handoff summary. Ran probes against the
live engine for each claim that looked load-bearing.

### Fixed in this pass (minor)

- **False claim in the builder's doc comment.** It stated that because no
  mutation-context symbols are registered, `registerSymbol` "cannot see a duplicate key
  here". It can — proven below. Claim removed, replaced with an accurate `NOTE:` at the
  registration site.
- **Silent skip on a short row array.** `if (!attr) return;` dropped a column's
  registration without a word; the name would then fall through to the enclosing scope
  and bind whatever happened to be there — the exact silent-misresolution class this
  ticket closes. All four callers derive their row from `tableSchema.columns` so it
  cannot fire today; it now raises `StatusCode.INTERNAL` naming the column, the index,
  and both lengths.
- **Two stale comments left by the refactor.** `insert.ts`
  `registerExistingRowColumns` still advertised itself as shared with the
  generated-column recompute (no longer true), and `update.ts`'s
  `schemaAuthoredUpdateCtx` comment still listed the generated recompute among its
  consumers (no longer true). Both corrected.
- **A comment describing syntax the parser does not accept.** `update.ts` justified the
  narrowing by saying `x.<col>` from `update t as x ...` now resolves nowhere. The
  parser rejects `update <t> as <x>` outright (`Expected 'SET' after table name in
  UPDATE. Got 'as'.`), so the handoff's "untested behaviour removal" (deviation 4) is
  unreachable from user SQL — `stmt.alias` is only ever set by the view-mutation
  lowering, with a synthesised collision-proof name. Comment rewritten to say that; no
  test is warranted for a form that cannot be written.
- **Untested collation behaviour** (a gap the handoff flagged). The builder resolves
  every column reference at its *declared* type, which carries the declared collation —
  a change from the attribute's own type on the INSERT and upsert paths. Verified it
  works and pinned it: a `collate nocase` column compared inside a generated body now
  has arms in `41-generated-columns.sqllogic` (INSERT, UPDATE, `do update`, each with a
  non-vacuous 0-result case) and `41.13-...backfill.sqllogic` § 16 (backfill plus later
  inserts).
- **Docs the change should have touched but did not.** `docs/determinism.md` described
  the ADD COLUMN generated arm as building its own scope and listed only three of the
  four validation sites; both now name the shared builder. `docs/sql-ddl.md`'s spelling
  table said an unbindable qualifier "fails" without saying *when* — now states that
  ALTER rejects at declaration and CREATE TABLE does not (see the ticket below).

### Filed as tickets (major)

- **`backlog/bug-create-table-accepts-generated-body-no-write-can-satisfy`** — the
  handoff raised `old.<col>` being accepted at `CREATE TABLE` and rejected at every
  write, and asked for a reviewer's opinion. Verified, and the class is wider than
  `old.`: `create table g (..., x generated always as (d.v + 1))` — with `d` a real
  table that nothing in the body selects from — is also accepted, and then every write
  to `g` fails with `d.v isn't a column`, permanently. `ALTER TABLE ADD COLUMN` rejects
  both spellings at declaration time, so the two ways of declaring the identical column
  disagree. Filed at the representation rung rather than as a point fix: the classifier
  in `schema/generated-column-refs.ts` labels "an inner FROM binds this" and "nothing
  binds this" with the same `'foreign'` value, so no consumer can reject the second
  without also rejecting the first. Opinion, since it was asked for: `CREATE TABLE`
  should converge on the ALTER pre-flight — a create that succeeds here produces a table
  that cannot be used at all, which is not a defensible laxity.
- **`backlog/bug-scope-symbol-keys-collide-with-dotted-column-names`** — a table with a
  column `a` and a quoted column `"new.a"` cannot be written to at all once anything
  registers qualified names: `QuereusError: Symbol 'new.a' already exists in the same
  scope.` Verified at three sites. Two pre-date this diff (the CHECK scope in
  `constraint-builder.ts`, the `do update` SET scope in `insert.ts`); the new builder
  adds a third, so plain INSERT/UPDATE on a table with a generated column now hits it
  where it did not before. Deliberately **not** patched locally: a duplicate-skip would
  silently bind one of the two columns, and the class recurs at the next builder that
  registers a qualified name. Root cause is the flat `<qualifier>.<name>` string key in
  `RegisteredScope`; filed at the representation rung. Reads of such a column work
  today, so the fix should keep them working rather than narrow acceptance.

### Tripwires (recorded in code, not filed)

- The `NOTE:` in `generated-column-scope.ts` about cloning and walking the stored body
  on every plan build — left as the implementer parked it; the reasoning (plan-build
  only, bodies small, CHECK path already does exactly this) holds.
- One `NOTE:` added at the registration site in the same file, pointing at the dotted-
  column-name collision ticket and warning against papering over it locally.

### Checked, nothing found

- **Deviation 1** (returning a finished node instead of the ticket's `{scope, expr}`
  pair): the right call. `{scope, expr}` leaves each site free to forget the
  `schemaAuthoredContext` wrap or the determinism check, which is how the four sites
  drifted originally.
- **Deviation 2** (mutation-context variables do not shadow a column): upheld. Both
  supporting facts re-derived — the ADD COLUMN backfill has no context envelope, and a
  bare name in a generated body that is not a column is already rejected at DDL time, so
  honouring the ticket's stated preference could only ever change a collision's outcome
  and would break a working backfill. The assertion pinning it (`g = 4`, not `101`) is in
  the test suite.
- **Deviation 3** (the ticket's claimed fifth divergence): confirmed non-existent, as the
  handoff said.
- **Row-attribute alignment at all four call sites.** ADD COLUMN maps `rowAttrs` from
  `tableSchema.columns`; INSERT takes the row-expansion projection's output; upsert maps
  `existingAttributes` from `tableSchema.columns`; UPDATE takes the table reference's
  attributes. All four are exactly `tableSchema.columns.length` by construction — hence
  the guard above being unreachable rather than load-bearing.
- **Chain preservation on the INSERT path** — each iteration is still handed *its own*
  input attributes, so `new.<other generated column>` sees the freshly computed value.
  Tested across all three write paths.
- **Rename completeness** — `stripSelfQualifierInCheckExpression` has no residual
  references anywhere in the repo.
- **Unused imports / dead locals after the refactor** — none; `schemaAuthoredUpdateCtx`
  and `registerExistingRowColumns` both retain other consumers.
- **Source hygiene** — the new module is one exported function of ~50 statements behind a
  doc block; no split warranted.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean (includes the `tsconfig.test.json` type pass).
- `yarn test` — **9233 passing, 0 failing** in `packages/quereus`; all other workspaces
  green.
- `yarn test:store` — **9225 passing, 0 failing**. This closes the handoff's largest
  stated gap ("full `yarn test:store` was not run").
- `QUEREUS_TEST_STORE=true ... --grep "File: 41"` — 47 passing; memory path 48 passing
  (the store path skips one file), both including the new collation arms.
