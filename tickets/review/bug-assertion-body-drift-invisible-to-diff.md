description: Fixed a bug where editing an integrity-check rule (assertion) inside a declared schema and re-applying didn't take effect — the schema diff only compared assertion names, not the rule body, so the old rule silently stayed active.
files:
  - packages/quereus/src/schema/catalog.ts                       # CatalogAssertion gained `definition` (~122-129); assertionSchemaToCatalog populates it from the existing `checkSql` local (~748-773)
  - packages/quereus/src/schema/schema-differ.ts                 # computeSchemaDiff assertion loop (~841-866) — now drop+recreates on body drift, not just presence
  - packages/quereus/test/logic/50-declarative-schema.sqllogic   # new isolated `assert_drift` schema block (~776-841): create → apply → redeclare with changed CHECK → diff shows drop+recreate → apply → re-diff empty → old-illegal/new-legal row commits, new-illegal row fails at commit
  - packages/quereus/test/schema-differ.spec.ts                  # new `catalogAssertion(sql)` helper (~70-81), `makeCatalog` extended with an assertions param, new describe block "assertion body drift" (3 cases: unchanged, changed, whitespace-only)
difficulty: easy
---

# Assertion body drift now visible to `diff schema` / `apply schema`

## What changed

`CatalogAssertion` gained a `definition: string` field — the canonical
CHECK-expression rendering (name/schema excluded), populated in
`assertionSchemaToCatalog` from the same `checkSql` local that already fed
`ddl`. This mirrors `CatalogView.definition` / `CatalogIndex.definition`,
which exist for exactly this reason: comparing bodies without name-rendering
noise.

`computeSchemaDiff`'s assertion loop (`schema-differ.ts` ~841-866) now looks
up the name-matched actual and compares `expressionToString(declared.check)`
against `matchedActual.definition`. On drift it emits a drop+recreate pair
(same shape as the existing view/index body-drift handling); on match it's a
no-op, same as before. The create-when-absent and drop-when-undeclared arms
are unchanged.

A `NOTE:`-style comment sits at the comparison site documenting a known
limitation, not a new one: assertion CHECK expressions are captured verbatim
at `CREATE ASSERTION` time and are never rewritten by `alter table … rename`
(unlike views/indexes, which reconcile in-diff renames before comparing). So
a table/column rename in the same diff as an otherwise-unchanged assertion
will now show a spurious-but-correct drop+recreate instead of staying silent.
This is strictly better than the prior silent-drift bug and is not something
this ticket attempts to fix — flagged here in case a future ticket wants
rename reconciliation for assertions too.

## How to validate

- Reproduction from the original bug report, now fixed:
  ```sql
  declare schema main { table t (x integer, primary key (x));
                        assertion a1 check (not exists (select 1 from t where x < 0)) }
  apply schema main;
  declare schema main { table t (x integer, primary key (x));
                        assertion a1 check (not exists (select 1 from t where x < 100)) }
  diff schema main;
  -- now: [{"ddl": "DROP ASSERTION IF EXISTS a1"}, {"ddl": "create assertion a1 check (not exists (select 1 from t where x < 100))"}]
  -- (previously: [])
  ```
- `packages/quereus/test/logic/50-declarative-schema.sqllogic` — new
  `assert_drift` schema block covers: create+apply, redeclare with a changed
  CHECK body → diff shows the drop+recreate pair, apply, re-diff is empty
  (idempotent), a row illegal under the OLD rule but legal under the NEW rule
  commits, a row illegal under the NEW rule fails at commit with a
  schema-qualified assertion name in the error.
- `packages/quereus/test/schema-differ.spec.ts` — new unit describe block
  covers: unchanged body → empty diff buckets, changed body → exactly one
  drop + one create, and a whitespace/formatting-only difference in the
  *declared* source → empty diff (both sides stringify from parsed ASTs, so
  formatting never matters — this is a sanity check on the compare, not a
  new mechanism).

## Known gaps / things the reviewer should look at

- No rename-reconciliation for assertions (see NOTE above) — deliberate
  non-goal per the implement ticket, not an oversight. Confirmed harmless: a
  same-diff table/column rename now just adds a correct-but-avoidable
  drop+recreate to an unrelated assertion; it does not break DDL ordering
  (assertion creates already run after table renames in
  `generateMigrationDDL`).
- Statement-ordering (drop-then-create pair landing correctly relative to
  other DDL in the same migration) was verified by the implement-stage
  investigation, not re-verified by a new dedicated test in this pass — the
  existing `positive_balance` / `qty_positive` assertion tests already
  exercise create/drop ordering against table changes elsewhere in the same
  file, and the new `assert_drift` block's drop+recreate pair round-trips
  through `apply schema` successfully, which exercises the real ordering
  path end-to-end (not just DDL string generation).
- Test suite: `yarn workspace @quereus/quereus test` → 8383 passing, 13
  pending (pre-existing skips, unrelated to this change). `yarn lint` clean
  (quereus's eslint + test-file typecheck pass produced no output).
