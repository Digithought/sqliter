---
description: Fixed a bug where editing an integrity-check rule (assertion) inside a declared schema and re-applying didn't take effect — the schema comparison only looked at rule names, not rule bodies, so the old rule silently stayed active.
files:
  - packages/quereus/src/schema/catalog.ts                       # CatalogAssertion.definition (~122-129); populated in assertionSchemaToCatalog (~748-780)
  - packages/quereus/src/schema/schema-differ.ts                 # computeSchemaDiff assertion loop (~841-873)
  - packages/quereus/src/schema/rename-rewriter.ts               # (read-only) rename propagation — assertions absent; see follow-up ticket
  - packages/quereus/test/logic/50-declarative-schema.sqllogic   # assert_drift / assert_addcol / assert_rename blocks (~776-950)
  - packages/quereus/test/schema-differ.spec.ts                  # describe "assertion body drift" — 5 cases
  - docs/schema.md                                               # new § "Assertion body-change detection (drop+recreate)"
---

# Assertion body drift is visible to `diff schema` / `apply schema`

## What shipped

`CatalogAssertion` carries a `definition` field: the canonical CHECK-expression
rendering (name and schema qualification excluded), produced by the same
`expressionToString` that already fed `ddl`. `computeSchemaDiff`'s assertion loop
compares the declared body against it and, on drift, emits a drop+recreate pair —
the shape the index and view body-drift paths already use, since an assertion has
no in-place "redefine" primitive. The create-when-absent and drop-when-undeclared
arms are unchanged.

Before: redeclaring an assertion with a different CHECK body produced an empty
diff and left the old rule enforcing. After: the diff shows
`DROP ASSERTION IF EXISTS …` + `create assertion …`, applying converges, and the
new rule is the one enforced.

## Review findings

Reviewed the implement diff (`430b9108`) against the differ, catalog, migration-DDL
ordering, rename propagation, and the declarative test corpus. Behavior was probed
empirically with a scratch spec (since deleted) covering six interaction scenarios;
findings below are what that surfaced.

### Verified correct (no action)

- **The fix itself.** Reproduction from the bug report now emits the drop+recreate
  pair; re-diff after apply is empty; the recreated assertion is the one enforced
  (a row illegal under the old rule commits, one illegal under the new rule fails
  at commit with the schema-qualified name in the error).
- **Statement ordering.** `generateMigrationDDL` emits assertion drops before every
  other drop and assertion creates after the table/view/index creates. Probed the
  two orderings that could plausibly break: (a) drift plus a same-apply
  `ADD COLUMN` where the *new* body names the newly added column — the
  `create assertion` runs before the `ALTER TABLE`, and applies cleanly because an
  assertion body binds at enforcement time, not create time (unlike a view, which
  plans at create); (b) drift plus a table rename — the rename runs first, so the
  recreate names an existing table. Both now have sqllogic regressions
  (`assert_addcol`, `assert_rename` blocks) — the implement handoff flagged
  ordering as verified-by-investigation-only, so this closes that gap.
- **Non-`main` schemas.** The drop is schema-qualified from `schemaPrefix` and the
  recreate from `applyAssertionSchemaDefault`; the create path does not rewrite the
  stored body with schema qualifiers, so a round-trip re-diff is empty rather than
  churning forever. Covered by the `assert_drift` sqllogic block.
- **Type safety / hygiene.** No `any`, no new exported surface, the new field is
  required (so every construction site is compiler-checked — there is exactly one).

### Fixed in this pass (minor)

- **Duplicated create-push** across the two arms of the assertion loop —
  collapsed to a single early-`continue` shape (`schema-differ.ts` ~855).
- **`docs/schema.md` had no assertion entry** alongside its constraint / index /
  view body-drift sections, so the doc read as if assertions were never compared.
  Added § "Assertion body-change detection (drop+recreate)" documenting the
  comparison, the ordering, the no-case-folding policy, and the rename limitation.
- **Case-folding policy was undocumented at the code site.** Confirmed empirically
  that a case-only edit (`from T where X`) churns a drop+recreate; that matches the
  view/MV policy (fold only where a recreate is expensive) and is cheap here, so
  the behavior stands with a comment stating why.
- **Test coverage.** Added two unit cases (only the drifted member of several
  name-matched assertions churns; the undeclared→drop-only arm, previously
  untested) and the two sqllogic interaction blocks above. Suite: 8385 passing,
  13 pending (pre-existing skips); `yarn workspace @quereus/quereus lint` clean.

### Filed as new tickets (major)

- `fix/bug-table-rename-breaks-dependent-assertions` — **pre-existing, verified,
  not caused by this change.** `ALTER TABLE … RENAME` propagates into view bodies,
  MV bodies, CHECK constraints, and index predicates, but never into assertion
  CHECK bodies. Rename a table and leave an assertion naming it: every subsequent
  write to the renamed table fails with `Table 't' not found`, and `diff schema`
  reports converged (both sides still render the old name, so there is no drift to
  see). Root cause is the rename propagation in `runtime/emit/alter-table.ts`, not
  the differ. Pointer comments left at the differ's assertion loop and in
  `docs/schema.md`.
- `backlog/debt-schema-differ-file-too-large` — `schema-differ.ts` measures 2725
  lines (`wc -l`, 2026-08-02), its spec 1057. Not caused by this change (~15 lines
  added), but locating the assertion loop and confirming its ordering interactions
  meant reading most of the file.

### Tripwires (recorded, not ticketed)

- `catalog.ts` ~756 — when `checkExpression` is absent, `definition` falls back to
  `violationSql`, a `select 1 where not (…)` query that can never equal a declared
  CHECK body. That path is unreachable today (`importDDL` throws on assertion DDL),
  but if assertion reconstruction from persisted `violationSql` is ever
  implemented, every such assertion reads as permanently drifted and re-churns on
  each apply. `NOTE:` comment at the site.

### Checked, nothing found

- Resource cleanup / error handling: the change adds no allocation, no async work,
  no catch — nothing to leak or swallow.
- Performance: one extra map lookup and one string compare per declared assertion,
  over a collection already walked twice. Not measured because the magnitude is
  visible in the code.
- `test:store`: not run (LevelDB path, several minutes). The change is
  catalog/differ-only with no storage interaction, and the diff never reaches a
  module boundary.
