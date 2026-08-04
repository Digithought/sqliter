---
description: Renaming a table or column used to silently break every integrity-check rule that mentioned it, so all later writes failed with a confusing "table not found" error; renames now rewrite those rules the same way they already rewrite views.
files:
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts        # the propagation pass (both arms)
  - packages/quereus/src/runtime/emit/alter-table.ts                     # two call sites, in the same-schema block after the view loop
  - packages/quereus/src/schema/assertion.ts                             # buildAssertionViolationSql (shared builder)
  - packages/quereus/src/runtime/emit/create-assertion.ts                # calls the shared builder
  - packages/quereus/src/schema/schema-differ.ts                         # corrected NOTE on the assertion loop
  - packages/quereus/test/assertion-rename-propagation.spec.ts           # catalog-level invariants
  - packages/quereus/test/logic/95-assertions.sqllogic                   # end-to-end rename section
  - docs/sql-alter.md                                                    # RENAME TABLE / RENAME COLUMN propagation lists
  - docs/schema.md                                                       # § Assertion body-change detection
repro: verified
---

# `ALTER TABLE … RENAME` follows into assertion bodies

## What shipped

An assertion's stored CHECK-expression AST is now rewritten in place by
`ALTER TABLE … RENAME` / `RENAME COLUMN`, and the derived `violationSql` (the text
the commit-time evaluator re-parses and re-plans) is regenerated from it, exactly
the way a view body is rewritten. The record is re-registered through
`SchemaManager.addAssertion` so `assertion_modified` fires and the optimizer's
assertion-hoist cache invalidates. Before this, every write after such a rename
failed with `Table 't' not found` / `Column not found: x` — naming something the
user had just renamed away, and never naming the assertion.

`buildAssertionViolationSql` moved to `src/schema/assertion.ts` and is shared by
`CREATE ASSERTION` and the rename pass, so a rewritten body regenerates
byte-identically to what a fresh create would have produced.

The pass lives in its own file (`assertion-rename-helpers.ts`, 154 lines) rather
than in `alter-table.ts`, which is 2,427 lines and already named in
`backlog/debt-emit-source-files-too-large`.

## Review findings

Reviewed the implement diff (`d35d0b7e`) against the current tree before reading
the handoff. Nothing in the diff was wrong. What the review added is coverage of
the shapes the handoff itself flagged as untested, plus two defects found by
probing around the change — both pre-existing and neither caused by it.

### Verified correct (no change needed)

- **Every walker shape the handoff listed as untested works.** Probed in-process:
  a body joining two tables where only one is renamed (FROM *and* ON clause both
  follow), an aliased source (`from t as tt`), a CTE body, a table-qualified
  column reference (`where u.x < 0`), a rename inside an explicit transaction that
  also writes rows, and a column rename on a *different* table that happens to
  share the column name (correctly untouched). All now pinned by tests.
- **Rollback.** A rolled-back `ALTER TABLE … RENAME` leaves both the table and the
  assertion body on the new name — coherent with each other, and consistent with
  the engine-wide "the schema half escapes ROLLBACK" behaviour documented at
  `alter-table.ts`'s `rebuildViaShadowTable`. Nothing assertion-specific here.
- **Cache invalidation.** The claim in `database-assertions.ts` that
  `assertion_modified` need not bump the evaluator's generation holds: the rename
  fires `table_modified` for the renamed table in the same statement, and the
  evaluator only compares generations at COMMIT, after the whole `ALTER`. The
  hoist cache does listen to `assertion_modified` and invalidates.
- **The hoist cannot leak onto a name freed by the rename.** Rename `t` to `t2`,
  create a fresh `t`, insert a row the old rule would have forbidden: the row
  stays visible to a matching filter. Now a regression test — this is the failure
  mode the fix most needed pinning, since a stale hoisted premise is a *wrong
  answer*, not an error.
- **`dependentTables` re-key**, schema scoping (`renamedSchemaName` is compared
  case-insensitively throughout `rename-rewriter.ts`), the same-schema gate on
  both call sites, and the absence of an assertion arm in
  `assertRenameDependentsPersistable` (assertions are not persisted —
  `CatalogObjectKind` has no assertion member) all check out as described.
- **Source hygiene / DRY.** The two arms share their re-register and violation-SQL
  paths; the remaining duplication is a five-line loop per arm whose bodies differ
  in how `dependentTables` is handled. Collapsing it behind two callbacks would
  cost more clarity than it saves — left alone deliberately.

### Fixed in this pass (minor)

- **Untested body shapes are now tested.** `95-assertions.sqllogic` gained a
  "Body shapes the walk has to follow" section (join / alias / CTE /
  table-qualified column), a rename-mid-transaction case, and the freed-name-reuse
  regression above. These matter because an assertion body is walked **unseeded**
  and nothing else in the suite exercises that entry point.
- **Tripwire recorded in code.** `assertion-rename-helpers.ts` now carries a
  `NOTE:` on why there is no per-assertion `try`/`catch` (a catch would leave
  `checkExpression` rewritten while `violationSql` still named the old table —
  silently the exact breakage this pass prevents) and what the fix would be if it
  ever becomes reachable (a dry-run probe before any mutation, not a catch).
- **`docs/sql-alter.md`** now states the one-level-deep limit of RENAME COLUMN
  propagation (see the second finding below). The rest of the doc changes from the
  implement stage were re-read against the code and are accurate; `docs/schema.md`
  and `docs/sql-ddl.md` have since been updated further by
  `bug-assertion-body-can-name-missing-table` and the drop-guard work, and are
  consistent with the current behaviour.

### Filed as new tickets (major, both pre-existing)

- **`fix/bug-assertion-over-materialized-view-never-enforced`** — an assertion
  whose body names a materialized view is *never* checked: violating rows commit
  silently, on the source write, on any later write, and on a direct write to the
  materialized view. The identical rule over a plain view is enforced. Cause: a
  plain view is expanded at plan time so the assertion's plan reads the base
  table, while a materialized view *is* a table, and maintaining it inside the
  transaction does not add it to the changed-table set the evaluator dispatches
  on. Verified with no `ALTER` in the repro, so it is not a regression from this
  work — but it was found because this ticket's DROP-guard neighbours treat such
  assertions as live dependencies.
- **`backlog/bug-rename-column-breaks-objects-reading-a-view`** — `RENAME COLUMN`
  propagates exactly one level. Rewriting a view body can shift the name that view
  *exposes*, and readers of the old name (a second view, or an assertion over
  either) are never revisited. Verified for view-over-view and for
  assertion-over-view; the assertion case fails every write in the database.
  Filed separately from `bug-rename-not-propagated-across-schemas` rather than
  appended to it: same call sites, but that ticket widens the walk sideways
  (other schemas) and this one widens it downward (dependents of a dependent), and
  neither fix delivers the other. Each ticket names the other.

### Known gaps left open, deliberately

- **Cross-schema references** remain unrewritten — shared verbatim with views and
  materialized views, tracked by `bug-rename-not-propagated-across-schemas`, and
  correctly not asserted by any test (it is a defect, not a contract).
- **`dependentTables` is cosmetic and independently broken**
  (`bug-assertion-info-dependent-tables-always-empty`), so the spec asserts the
  re-key is *consistent* rather than that any entry exists. Unchanged judgement —
  real coverage needs that bug fixed first.
- **`yarn test:store`** (LevelDB-backed re-run) still not run; out of the default
  agent test scope, and the propagation is engine-level with no store path.

## Validation

- `yarn test` (all workspaces): **8675 passing** in `packages/quereus`, every other
  workspace green, **0 failing**, 13 pending (pre-existing).
- `yarn lint` for `packages/quereus` (eslint + `tsc -p tsconfig.test.json
  --noEmit`): clean.
- `yarn docs:check`: two pre-existing failures on `docs/schema.md` and
  `docs/sync.md` (both over their recorded word ratchets), already tracked by
  `plan/1-debt-docs-size-ratchet-red-again`. `docs/sql-alter.md`, the file this
  pass edited, is not among them.
