---
description: A table could be created with a computed column whose formula used a random or time-varying function, which the engine forbids everywhere else. CREATE TABLE now refuses it up front, the same as ALTER TABLE already did, instead of creating an unusable table.
files:
  - packages/quereus/src/schema/manager.ts                             # validateGeneratedColumnDeterminism + shared findNonDeterministicCall / nonDeterministicDeclarationError; called from createTable
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic    # § 5 (reject, nested/virtual/subquery/date forms, deterministic control, escape hatch)
  - packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic  # strict_generated block
  - packages/quereus/test/schema/declaration-determinism-import.spec.ts # reload regression guard (review-stage addition)
  - docs/sql-ddl.md                                                    # Generated Columns determinism bullet
  - docs/determinism.md                                                # CREATE TABLE summary bullet list
---

# Complete: non-deterministic `GENERATED ALWAYS AS` rejected at `CREATE TABLE`

## What shipped

A table declaring e.g. `x integer generated always as (random()) stored` used to be
created successfully and then fail *every* INSERT and UPDATE with the write-time
determinism error — permanently unusable, with nothing said at declaration time.
`CHECK` and `DEFAULT` had a declaration-time determinism gate; generated columns did not.

`SchemaManager.validateGeneratedColumnDeterminism` now walks each `GENERATED ALWAYS AS`
body and rejects any function call whose registry entry lacks `FunctionFlags.DETERMINISTIC`.
It runs in `createTable`, beside the existing `validateDefaultDeterminism` /
`validateCheckConstraintDeterminism` calls and before `module.create`, so a refusal leaves
no storage behind. `pragma nondeterministic_schema = true` lifts it, exactly as it lifts
the DEFAULT and CHECK gates. `ALTER TABLE ADD COLUMN` already had its own equivalent gate,
so both authoring surfaces now agree.

The check walks the raw AST rather than building the expression the way the DEFAULT
validator does: a generated body names the table's own columns, so there is no scope to
build it against at declaration time, and it may embed a subquery that forward-references
the table being created.

## Review findings

Reviewed the implement diff (`91df9eb1`) before reading its handoff.

### Major — found and fixed in this pass

**The gate was wired into the shared schema builder, so catalog reload rejected tables the
same build had legitimately created.** The implementer put the call inside
`buildTableSchemaFromAST`, which is shared by `createTable`, `buildDeclaredTableSchema`
**and `importTable`** (the catalog rehydrate path, reached from quereus-store's
`rehydrateCatalog` → `SchemaManager.importCatalog`). `nondeterministic_schema` is a
*session* option: a user who turns it on, declares a generated column over `random()`, and
closes the database gets a catalog that no ordinary session can reopen — the pragma
defaults to off, so the rehydrate throws and the whole catalog open fails rather than the
one write that cannot be satisfied.

This is not the "pre-fix builds" backwards-compatibility tradeoff the sibling
unbound-qualifier ticket accepted; it is a same-build round-trip failure through the
project's own sanctioned escape hatch, and it is *worse* than the bug being fixed (a
database that will not open, versus a table that will not accept writes).

Reproduced before fixing: a scratch spec calling `importCatalog` with the persisted DDL
threw `Non-deterministic expression not allowed in GENERATED ALWAYS AS …` from
`validateGeneratedColumnDeterminism` ← `buildTableSchemaFromAST` ← `importTable`. The same
shape with a `default random()` column got past schema build — confirming the asymmetry
rather than a shared convention.

`createTable` states this convention explicitly, three separate times, for three other
guards it deliberately keeps out of the shared builder ("the import/rehydrate path shares
that builder and must still open a catalog written before this guard existed"). Fixed by
following it: the call moved to `createTable`, next to its two siblings. The
maintained-table create path (`createMaintainedTable` → `buildDeclaredTableSchema`) still
gets the check, because it registers through `sm.createTable`.

**Guard added:** `packages/quereus/test/schema/declaration-determinism-import.spec.ts` —
declare under the pragma, flip it off, re-import the DDL, for all three gates (GENERATED,
DEFAULT, CHECK) plus a control that the strict-mode rejection still fires. Not expressible
in `.sqllogic` (no import/reopen verb), hence a spec. All four fail against the
as-committed implementation and pass after the fix.

### Minor — fixed inline

- **Duplicated AST walk (DRY).** `validateGeneratedColumnDeterminism` was a verbatim copy
  of the ~20-line walk and error construction inside `validateCheckConstraintDeterminism`.
  Extracted `SchemaManager.findNonDeterministicCall(expr)` and the module-level
  `nonDeterministicDeclarationError(site, fn)`; both gates now share them, so the two
  surfaces cannot drift in how they explain the same rule.
- **Test coverage was one happy-path rejection.** § 5 of
  `41-generated-column-errors.sqllogic` covered only `generated always as (random())
  stored`. Added: the call nested inside a larger expression (`a + random()`), on a
  `VIRTUAL` column (`abs(random())`), inside a subquery the body selects from
  (`(select random())`), a non-`random()` member of the set (`date('now')`, asserting the
  message names the offending *function*), and a deterministic control that still builds
  and computes. All pass — confirming in particular that the walk descends into subquery
  bodies, which the implementer's tests never exercised.
- **`docs/determinism.md` documented the behavior that was wrong.** Its new bullet stated
  the gate "runs on every path that produces a table schema (`CREATE TABLE`, and catalog
  reload of a persisted schema alike)". Rewritten to state the actual rule and its reason,
  now covering all three gates rather than generated columns alone.

### Checked and found correct — no change

- **Aggregate false positives.** A generated body may hold a subquery, and aggregates would
  be walked by the same pass. `registration.ts` defaults every registration to
  `DETERMINISTIC` unless `deterministic: false` is passed, and no aggregate opts out — so
  `(select count(*) from …)` in a generated body is not falsely rejected. The full suite,
  which exercises several subquery-bearing generated columns (ALTER backfill,
  materialized-view restore, maintained-table attach/detach), confirms it.
- **Traversal short-circuit.** `traverseAst`'s `enterNode` returning `false` prunes that
  branch rather than aborting the walk; with the `if (offendingExpr) return false` guard
  the remaining siblings are entered and immediately pruned. Correct, if indirect.
- **Ordering inside the builder.** The implementer flagged a possible hazard from reading
  `columns` before it was fully built. Moot after the move — the check now reads the
  finished `baseTableSchema.columns`.
- **`docs/sql-ddl.md`, `docs/schema.md`, `docs/architecture.md`, `docs/module-authoring.md`.**
  Read the generated-column and determinism passages in each. `sql-ddl.md`'s edited bullet
  ("checked at declaration time — `CREATE TABLE` and `ALTER TABLE … ADD COLUMN` alike") is
  still accurate after the move. The other three describe the pragma and the write-time
  resolution frontier and needed no change.
- **Error-string parity between `CREATE TABLE` and the write-time rejection.** The
  declaration gate names the function, the write-time gate
  (`planner/validation/determinism-validator.ts`) names the rendered expression. Both share
  the leading sentence and the column/table naming. Pre-existing, matches the CHECK-vs-DEFAULT
  precedent, and out of this ticket's scope — left as-is, as the implementer proposed.

### Tripwires — parked in code, not filed

- **The two generated-column gates now disagree about catalog reload, on purpose.** The
  unbound-qualifier gate (`unboundQualifierError` in `schema/table.ts`) fires on reload; this
  determinism gate does not. A future reader could easily "fix" one to match the other and
  reintroduce the failure above. Recorded as a `NOTE:` in the
  `validateGeneratedColumnDeterminism` doc block, stating why they differ (a body naming
  nothing is unwritable in every session; a non-deterministic body is writable whenever the
  pragma is on) and the revisit condition (if reload ever gains a general "refuse schemas no
  write can satisfy" pass, revisit both together).

### Filed / appended elsewhere

- **`packages/quereus/src/schema/manager.ts` is 3,633 lines** (`wc -l`, 2026-08-10) — the
  largest non-test source file in the repo, and absent from the size theme ticket. Per the
  site-claim rule this is evidence for an existing ticket, not a new one: appended as an arm
  to `tickets/backlog/debt-oversized-source-files.md`, with the build-vs-register seam named
  (several guards already carry comments explaining they sit in `createTable` rather than in
  the shared builder — that line is the split).
- **Unknown functions in a generated body** (`generated always as (nosuchfn(a))`) are still
  accepted at declaration and fail at every write. `findNonDeterministicCall` skips a name
  the registry cannot resolve, exactly as the CHECK gate always has. Already tracked at
  `tickets/backlog/bug-unknown-function-not-caught-at-declaration.md`; not re-filed, not
  widened into this change.

### Empty categories

No new `fix/` or `plan/` tickets were spawned. The one major finding was a defect in this
ticket's own implement pass with a one-call-site fix, so it was corrected here rather than
handed onward; every other finding was minor or already claimed by an open ticket.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0; includes the test-file `tsc`
  pass).
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `packages/quereus`: `node test-runner.mjs` (full suite) — **9237 passing, 0 failing, 25
  pending** (9233 before this review pass; +4 from the new reload spec).
- `yarn test` (every workspace) — clean, exit 0; includes quereus-store, whose rehydrate
  path is what the reload regression would have broken.
- `yarn test:store` not run: it re-runs the same quereus logic tests against LevelDB and its
  reporter buffers output to completion, which risks the runner's 10-minute idle timeout.
  The reload path it would exercise is covered directly and deterministically by the new
  `importCatalog` spec — store calls the same `SchemaManager.importCatalog` entry point.
