---
description: A table could be created with a computed column whose formula used a random or time-varying function, which the engine forbids everywhere else. CREATE TABLE now refuses it up front, the same as ALTER TABLE already did, instead of creating an unusable table.
files:
  - packages/quereus/src/schema/manager.ts                             # new validateGeneratedColumnDeterminism (~2358), wired into buildTableSchemaFromAST (~1940)
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic    # new § 5 (reject + escape-hatch accept)
  - packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic  # strict_generated block + stale comment fixed
  - docs/sql-ddl.md                                                    # Generated Columns determinism bullet (~376)
  - docs/determinism.md                                                # CREATE TABLE summary bullet list (~142)
---

# Implemented: non-deterministic `GENERATED ALWAYS AS` rejected at `CREATE TABLE`

## What shipped

`SchemaManager.buildTableSchemaFromAST` (`packages/quereus/src/schema/manager.ts`)
is the one builder shared by `createTable`, `buildDeclaredTableSchema`, and
`importTable` (catalog reload). It ran `extractGeneratedColumnDependencies` /
`topoSortGeneratedColumns` (reference + cycle analysis) but no determinism check
over `GENERATED ALWAYS AS` bodies — CHECK and DEFAULT got that check, generated
columns didn't. A table declaring `x integer generated always as (random())
stored` created successfully and then every INSERT/UPDATE failed with the
write-time determinism error, permanently.

Added `SchemaManager.validateGeneratedColumnDeterminism` (~line 2358),
mirroring `validateCheckConstraintDeterminism`'s shape: an AST walk over
`traverseAst`, rejecting any function call whose registry entry lacks
`FunctionFlags.DETERMINISTIC` (checked at both the column's own arity and
arity `-1`, same as the CHECK walk). **Not** modeled on `validateDefaultDeterminism`,
which builds the expression through `buildExpression` — a generated body is
written in terms of the table's own columns (no scope to build against yet)
and may embed a subquery that forward-references the table being created, so
an AST-only walk is the only form safe at this point.

Wired into `buildTableSchemaFromAST` itself (~line 1940), not called separately
from `createTable` the way the CHECK/DEFAULT validators are — so it runs on
every path through the shared builder, including `importTable` (catalog
reload). This mirrors the sibling ticket's (`bug-generated-body-unbound-qualifier-accepted-at-create-table`,
now in `complete/`) precedent for the unbound-qualifier check, which made the
same "runs on reload too" call and recorded it as an accepted tradeoff — see
below.

`nondeterministic_schema` (the existing DEFAULT/CHECK escape hatch) is read
live inside `buildTableSchemaFromAST` via `this.db.options.getBooleanOption(...)`
and gates the new check identically.

## Use cases to validate

- **Primary repro (the bug)**: `create table r (id integer primary key, x
  integer generated always as (random()) stored);` now fails at `CREATE TABLE`
  with `Non-deterministic expression not allowed in GENERATED ALWAYS AS for
  column 'x' in table 'r'...`, and the table is not created (a following
  `drop table r;` errors "not found in schema"). Covered:
  `41-generated-column-errors.sqllogic` § 5a, `44.1-nondeterministic-schema.sqllogic`
  `strict_generated`.
- **Escape hatch**: `pragma nondeterministic_schema = true;` then the same
  declaration succeeds, insert works, the generated value is concrete per row.
  Covered: `41-generated-column-errors.sqllogic` § 5b (also already covered
  end-to-end by the pre-existing `relaxed_generated` case in
  `44.1-nondeterministic-schema.sqllogic`, untouched by this change).
- **CREATE TABLE vs ALTER TABLE now agree**: both reject
  `generated always as (random())` at declaration time with the same message
  shape (column/table naming matches; CHECK/CREATE-TABLE path names the
  *function*, the write-time/ALTER path names the rendered *expression* — see
  Known gap below, this is pre-existing and not something this ticket changed).
- **Legitimate subquery-based generated columns still work**: full test suite
  (below) exercises several `generated always as ((select ...))` declarations,
  including ones that forward-reference sibling tables and ones exercised via
  catalog reload paths (ALTER ADD COLUMN backfill, materialized-view restore,
  maintained-table attach/detach) — none regressed. This was the specific risk
  the ticket flagged (an AST walk has no catalog dependency, so it shouldn't
  choke on a forward reference the way `buildExpression` would).

## Known gaps NOT touched by this change

- **Unknown function in a generated body** (e.g. `generated always as
  (nosuchfn(a))`) is still accepted at `CREATE TABLE` and fails at every
  write with `Function not found: nosuchfn/1`. `validateCheckConstraintDeterminism`
  has the identical hole for CHECK bodies (a function `findFunction` can't
  find isn't flagged non-deterministic — it's just silently skipped). This is
  the ticket's documented pre-existing gap, tracked separately in
  `tickets/backlog/bug-unknown-function-not-caught-at-declaration.md`. Deliberately
  not widened into this change.
- **Exact error-string parity between CREATE TABLE and write-time rejection**
  was flagged by the ticket as possibly unachievable and left that way: the new
  AST walk reports `Function '<name>' is not deterministic`, the existing
  write-time `validateDeterministicGenerated` reports `Expression: <rendered
  expr>`. Both use the same leading sentence and the same column/table naming
  (matches the CHECK-vs-DEFAULT precedent already in the codebase — DEFAULT's
  write-time message is also expression-shaped, CHECK's is also function-shaped).
  Not attempted to unify further.

## Tripwire / accepted-tradeoff carried forward, not re-litigated

The new check runs on **every** path through `buildTableSchemaFromAST`,
including catalog reload (`importTable`). A catalog persisted by a pre-fix
build with a non-deterministic generated column will now fail to *load*
rather than loading permanently unwritable. This is the same call the sibling
unbound-qualifier ticket made and recorded as an accepted tradeoff at
`unboundQualifierError` in `packages/quereus/src/schema/table.ts` (backwards
compatibility with pre-fix catalogs is not yet a project constraint). I did
not duplicate that `NOTE:` at the new call site — the existing one is the
single source of truth for this class of tradeoff and already states the
revisit condition ("stores written by older builds must open"). Flagging here
so the reviewer doesn't need to re-derive it, not proposing a second note.

## Validation

- `packages/quereus`: `node test-runner.mjs` (full suite) — **9233 passing, 0
  failing, 25 pending**.
- `packages/quereus`: `node test-runner.mjs --grep
  "44.1-nondeterministic-schema|41-generated-column-errors"` — 2 passing
  (both edited files individually, before the full run).
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn build` / `yarn test:store` not run — the change is schema-build-time
  logic (an AST walk), not storage-path-dependent; the sibling ticket made the
  same call for the same reason.

## Suggested review focus

- Confirm the AST walk's placement inside `buildTableSchemaFromAST` (before
  the `return`) doesn't run before `columns` (with `generatedExpr` populated)
  is fully built — it's the same local `columns` var the dependency/topo-sort
  extraction just used, so this should be safe by construction, but worth a
  second look.
- Confirm honoring `nondeterministic_schema` on the `importTable`/reload path
  is the right call (a session that starts with the pragma off, reloading a
  catalog written while it was on, would now reject the reload) — this is a
  narrower version of the same tradeoff already accepted for the unbound-qualifier
  check, but wasn't explicitly called out in the ticket's TODO list.
