----
description: Editing the rule inside a declared integrity check and re-applying the schema silently does nothing — the comparison only looks at the check's name, so the old rule stays in force while the declaration claims the new one.
files:
  - packages/quereus/src/schema/catalog.ts                       # CatalogAssertion (~122-125), assertionSchemaToCatalog (~742-770) — add canonical `definition`
  - packages/quereus/src/schema/schema-differ.ts                 # computeSchemaDiff assertion block (~841-855) — presence-only comparison; view block ~707-742 is the pattern to mirror
  - packages/quereus/test/logic/50-declarative-schema.sqllogic   # assertion sections, Steps 54-65 (~651-780)
  - packages/quereus/test/schema-differ.spec.ts                  # makeCatalog / catalogView helpers — add a catalogAssertion helper + unit cases
difficulty: easy
repro: verified
----

# A declared assertion's body change is invisible to `diff schema`

## Reproduction (re-ran this session, empty diff confirmed)

```sql
declare schema main { table t (x integer, primary key (x));
                      assertion a1 check (not exists (select 1 from t where x < 0)) }
apply schema main;
declare schema main { table t (x integer, primary key (x));
                      assertion a1 check (not exists (select 1 from t where x < 100)) }
diff schema main;
→ []
```

The rule changed (`< 0` → `< 100`); the diff is empty, `apply schema` emits
nothing, and the database keeps enforcing the old rule. Meanwhile the declared
schema *hash* does change (assertions joined the hash in
`bug-declared-assertion-ignores-target-schema`), so the version reads "changed"
while the diff reads "converged".

## Root cause

`computeSchemaDiff`'s assertion block (`schema-differ.ts` ~841-855) compares
declared vs actual **by name presence only** — create when the name is missing
from the catalog, drop when the name is missing from the declaration. There is
no body comparison. Tables, views, and indexes all compare a canonical
definition string and emit drop+recreate on drift; assertions were never wired
up that way.

The actual side has no canonical body to compare against, either:
`CatalogAssertion` carries only `{ name, ddl }`, where `ddl` is the full
`CREATE ASSERTION <qualified-name> CHECK (<expr>)` rendering. `CatalogView` and
`CatalogIndex` both carry a separate `definition` field holding just the
body — name/schema/tags excluded — precisely so the differ can compare bodies
without name rendering getting in the way. Assertions need the same field.

## Design

Add `definition: string` to `CatalogAssertion`, populated in
`assertionSchemaToCatalog` from the same source the `ddl`'s CHECK slot already
uses:

```ts
export interface CatalogAssertion {
	name: string;
	ddl: string;
	/** Canonical CHECK-expression rendering (name / schema excluded) … */
	definition: string;
}
```

`definition` = `expressionToString(assertionSchema.checkExpression)`, falling
back to `violationSql` exactly as the existing `checkSql` local already does —
so compute `checkSql` once and use it for both `ddl` and `definition`.

In the differ, compare `expressionToString(declaredAssertion.assertionStmt.check)`
against `matchedActual.definition`. Both sides run the same stringifier over
ASTs from the same parser, so an unchanged body is byte-identical — verified
this session:

```
ACTUAL   ddl: CREATE ASSERTION a1 CHECK (not exists (select 1 from t where X < 0))
DECLARED    : not exists (select 1 from t where X < 0)
```

Comparing bodies rather than full DDL also sidesteps the name-qualification
mismatch the fix ticket flagged (actual renders `"sch"."a1"` outside `main`,
declared renders whatever `applyAssertionSchemaDefault` produced, and the two
sides differ in keyword case anyway). Names are already matched by the map key,
which is the bare lowercased name on both sides.

New assertion loop shape (mirroring the view loop at ~707-742, minus renames —
assertions have no rename support and no alter primitive, so recreate is the
only unit):

```
for (const [name, declaredAssertion] of declaredAssertions) {
    const matchedActual = actualAssertions.get(name);
    if (!matchedActual) → assertionsToCreate.push(render(declared))
    else if (declaredBody !== matchedActual.definition) →
        assertionsToDrop.push(matchedActual.name)
        assertionsToCreate.push(render(declared))
}
```

`render(declared)` stays `createAssertionToString(applyAssertionSchemaDefault(
declaredAssertion.assertionStmt, targetSchemaName))` — unchanged from today.

### Ordering already works — do not re-litigate it

`generateMigrationDDL` emits `DROP ASSERTION IF EXISTS` early (before table
drops/creates, ~2539) and `assertionsToCreate` late (~2574), so a drop+recreate
pair lands in the right order. Confirmed this session that a `create assertion`
placed *before* an `ALTER TABLE … ADD COLUMN` in the same migration still
applies cleanly (assertion bodies are not resolved at create time), so no
statement-ordering change is needed for this ticket.

### Known non-goal: no rename support, no rewrite on table rename

An assertion's stored `checkExpression` is captured verbatim at CREATE
(`runtime/emit/create-assertion.ts` ~43) and is never rewritten by
`alter table … rename`. So a table/column rename in the same diff will make an
otherwise-unchanged assertion body look drifted and churn a drop+recreate.
That recreate is *correct* DDL (assertion creates run after table renames), just
noisy, and it is a strictly better outcome than today's silence. Views and
indexes reconcile in-diff renames before comparing; assertions have no such
reconciliation and this ticket does not add one. Record this as a `NOTE:`
comment at the new comparison site rather than filing it.

## TODO

- Add `definition: string` to `CatalogAssertion` in `catalog.ts`, with a doc
  comment in the style of `CatalogView.definition` / `CatalogIndex.definition`
  explaining that the name/schema are excluded so the differ compares bodies.
- Populate it in `assertionSchemaToCatalog` from the existing `checkSql` local
  (single computation feeding both `ddl` and `definition`).
- Rewrite the differ's declared-assertion loop to look up the matched actual and
  emit drop+recreate on body drift; keep the create-when-absent and
  drop-when-undeclared arms as they are.
- Add the `NOTE:` at the comparison site covering the no-rename-reconciliation
  limitation above.
- Extend `test/logic/50-declarative-schema.sqllogic` in the existing assertion
  region (Steps 54-65): after an assertion is applied, redeclare it with a
  changed CHECK body and assert `diff schema main` yields the
  `DROP ASSERTION IF EXISTS …` + `create assertion …` pair; `apply schema main`;
  re-`diff` and assert `[]` (idempotent); then prove the *new* rule is enforced
  and the *old* one is not (a row legal under the new rule but illegal under the
  old one commits; a row illegal under the new rule fails at commit).
- Add unit coverage in `test/schema-differ.spec.ts`: a `catalogAssertion(sql)`
  helper alongside `catalogView`, `makeCatalog` extended to accept assertions,
  and cases for (a) unchanged body → no assertion buckets populated,
  (b) changed body → one drop + one create, (c) whitespace/formatting-only
  difference in the declared source → no diff.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; stream output with
  `tee` per AGENTS.md.
