----
description: When a lens maps a logical schema onto tables that live in another schema, writing the mapping without spelling out that schema on every table name either fails to read or silently reads a same-named table from the wrong schema.
files:
  - packages/quereus/src/schema/lens-compiler.ts   # compileOverrideBody (1193) — the one site; body assembled at 1316-1320; collectOverrideSources (1324); validateOverrideBasisSources (1381)
  - packages/quereus/src/schema/rename-rewriter.ts # PRECEDENT: scope-aware AST walker with CTE scope frames (visitTableRename 82, pushWithFrame 986)
  - packages/quereus/src/parser/ast.ts             # SelectStmt.withClause.ctes; CommonTableExpr (803) has type 'commonTableExpr' + name
  - packages/quereus/src/schema/lens-prover.ts     # planBody (343) round-trips the body through astToString + db.getPlan — no schema path; qualified text is what makes it work
  - packages/quereus/src/func/builtins/explain.ts  # effectiveSql (777) + lensInverseDispositions (801) — same, via _buildPlan
  - packages/quereus/src/planner/building/select.ts # read-time view expansion (451): a lens view's body plans under the LOGICAL schema's home path
  - packages/quereus/test/logic/52-lens-overrides.sqllogic # every existing override qualifies its sources, so the gap is untested
  - packages/quereus/test/lens-overrides.spec.ts   # unit coverage incl. the effective_sql assertion (455)
  - docs/lens.md                                   # § Body-shape restrictions (line 242) states the unqualified-defaults-to-basis rule
difficulty: medium
repro: verified
----

# A lens override body's unqualified table names never reach the basis schema

## What is broken

A lens maps a *logical* schema (what the application sees) onto a *basis*
schema (where the data actually lives):

```sql
declare lens for carapp over ybasis {
  view Car as select id, speed as maxSpeed from CarCore
}
```

`CarCore` is unqualified. The lens compiler treats that as "a table in the basis
schema" — `collectOverrideSources` resolves it that way, and
`validateOverrideBasisSources` documents unqualified names as defaulting to the
basis. But the compiled body is stored with the authored FROM copied verbatim
(`{ ...select, columns: composed }`), so **nothing records which schema the name
meant**. Every later consumer re-resolves the bare name its own way, and none of
them knows about the basis:

- read time — `select.ts:451` plans the body under the *logical* schema's home
  path (`carapp, main`);
- the prover (`planBody`) and `explain` (`lensInverseDispositions`) round-trip
  the body through SQL text and plan it with **no** path context at all.

### Measured behavior (ran each variant against a scratch `Database`)

| # | override FROM | today |
|---|---|---|
| a | `from ybasis.CarCore` (qualified) | works — baseline |
| b | `from CarCore` | `Table 'CarCore' not found in schema path: carapp, main` |
| c | `from (select … from CarCore) s` | same error (nested source) |
| e | `… where id in (select id from CarCore)` | same error (nested subquery) |
| h | `from CarCore c join CarExtra x on …` | same error |
| f | `from CarCore`, **and** a `main.CarCore` also exists | **deploys and reads `main.CarCore` — wrong rows, no error** |
| g | basis is `main`, `from CarCore` | works (only because `main` is on the default path) |
| d | `with CarCore as (…) select … from CarCore` | works — the CTE shadows the basis name |

Row **f** is the serious one: the compiler validated coverage and gap-filled
against `ybasis.CarCore`, then the read bound `main.CarCore`. Compile-time
provenance and run-time rows describe different tables, silently.

Row **d** is the constraint on any fix: a CTE that shadows a basis table name
must keep binding the CTE.

Not a regression from `bug-declared-materialized-view-non-main-schema`. That
change made a stored view body resolve against the schema the *view* lives in —
for a lens view that is the logical schema, which is exactly the schema the
basis tables are **not** in.

## Root cause and fix

One site decides it: `compileOverrideBody` (`schema/lens-compiler.ts:1193`),
whose closing lines assemble the stored body while preserving the authored FROM.
The compiler already holds the resolved `TableSchema` for each source, so the
schema each unqualified name was understood to mean is known and then discarded.

**Fix: qualify the compiled body's bare basis sources at compile time**, so the
body is self-describing and every downstream consumer (read, prover, `explain`,
`quereus_effective_lens`, relation-backing derivation) agrees by construction.
This matches the synthesized bodies — `compileDefaultBody` and
`compileDecompositionBody` already emit fully-qualified table references — so
after the fix *every* stored lens body is qualified, and the "which path does a
lens body resolve against" question stops existing.

Rejected alternative: thread a basis-aware schema path through each consumer.
That is four-plus sites, each of which must remember; the four sites all guessing
the same wrong way is the shape of this bug, not the cure for it.

### Arm 1 — qualify the compiled body

Add a `qualifyBasisSources(select, basisSchemaName, schemaManager)` in
`lens-compiler.ts`, applied where the body is assembled:

```ts
const body: AST.SelectStmt = qualifyBasisSources(
  { ...select, columns: composed }, basisSchemaName, schemaManager,
);
```

Rules:

- Rewrite a FROM `table` node **only** when all of: `table.schema` is undefined;
  the bare name is not in the CTE-name shadow set (below); and
  `schemaManager.getSchema(basisSchemaName)?.getTable(name)` resolves. Otherwise
  leave it exactly as authored (an unresolvable bare name stays opaque and
  surfaces the same error it does today).
- Descend everywhere `validateOverrideBasisSources` descends — subquery sources,
  function-source arguments, `with` CTE bodies, compound legs, `order by`, and
  scalar / `where` / `in` / `exists` subqueries. That validator's doc comment
  (line 1364) explains why it walks reflectively rather than by `type`
  discriminant: some containers holding nested SELECTs have no `type` field.
  A reflective clone-rewrite over plain objects/arrays fits the same reasoning.
- **Do not mutate the input AST.** `select` is `override.select`, which is also
  stored as `slot.override` *and* is part of the declared-lens AST held in the
  catalog; mutating it would edit the user's authored declaration in place (and
  perturb DDL round-trip / declarative-equivalence output). Copy along the
  rewritten path.
- CTE shadow set: collect every `commonTableExpr` name anywhere in the override
  AST into one lowercased set and never qualify those names. This is
  deliberately conservative — a name declared as a CTE in one nested scope
  disables qualification for that name in *all* scopes, leaving today's behavior
  (which is the bug) for that one name rather than risking a wrong bind. Proper
  per-scope frames (as `rename-rewriter.ts` maintains) are the alternative;
  choose the global set unless per-scope falls out cheaply, and leave a `NOTE:`
  at the site recording the trade so a future reader meets it.

### Arm 2 — stop `collectOverrideSources` mistaking a CTE for a basis table

Same wrong assumption, same site. `collectOverrideSources` (line 1324) resolves
any bare FROM name against the basis schema, so a CTE that shadows a basis table
name is collected as *that basis table* — and its columns then drive `*`
expansion and gap-fill. Measured today:

```sql
declare lens for carapp over ybasis {
  view Car as with CarCore as (select 9 as id, 1 as speed)
              select id, speed as maxSpeed from CarCore
}
-- deploy succeeds; `color` is gap-filled from ybasis.CarCore, which the CTE
-- does not expose; the read then fails with: Column not found: color
```

Pass the shadow set from arm 1 into `collectOverrideSources` and treat a
shadowed bare name as an opaque source (`hasOpaqueSource = true`) instead of a
basis table. The example above then fails at **deploy** with the existing precise
coverage diagnostic ("uncovered column 'color' … not reachable from the
override's FROM") rather than deploying a body that cannot read. No existing test
uses a CTE in a lens override, so this arm has no fixture fallout.

## Expected behavior

- An override naming its basis tables unqualified reads identically to one that
  qualifies them, for any basis schema — including nested sources and subqueries.
- With a same-named table in `main` and in the basis, the override binds the
  **basis** one (variant f above).
- A CTE shadowing a basis table name still binds the CTE (variant d).
- Reading, `explain`ing, and proving agree with what the compiler validated.
- A source qualified with a *different* existing schema is still rejected at
  deploy by `validateOverrideBasisSources` — unchanged.
- Qualified overrides behave identically to today. `quereus_effective_lens`'s
  `effective_sql` for a formerly-unqualified override now shows the basis
  qualifier; that is the intended, honest output (and matches what synthesized
  bodies already print). The existing assertion at `lens-overrides.spec.ts:455`
  checks only `speed as maxspeed`, so it is unaffected.

## TODO

- Add `qualifyBasisSources` to `schema/lens-compiler.ts` — reflective,
  non-mutating clone-rewrite; CTE-shadow set; basis-resolvable bare names only.
- Apply it where `compileOverrideBody` assembles `body` (line ~1319).
- Thread the CTE-shadow set into `collectOverrideSources` so a shadowed bare
  name counts as opaque rather than as a basis table.
- Leave a `NOTE:` at the shadow-set site if the global (non-per-scope) form is
  kept, stating what it gives up.
- Extend `test/logic/52-lens-overrides.sqllogic` with a section covering:
  unqualified single source over a non-`main` basis (same rows as § 1); a
  two-table basis join, both sources unqualified; basis `main`, unqualified
  (no regression); a same-named table in `main` and the basis — the read must
  return the basis rows; and a CTE shadowing a basis table name.
- Add to `test/lens-overrides.spec.ts`: an unqualified override whose
  `effective_sql` from `quereus_effective_lens` carries the basis qualifier and
  whose per-column `inverse` dispositions match the qualified equivalent (today
  the body fails to plan there and every column degrades to `'none'`); and the
  CTE-shadow gap-fill case now erroring at deploy with the coverage diagnostic.
- Update `docs/lens.md` § Body-shape restrictions (line 242) — record that the
  compiled body stores the basis qualifier the compiler resolved, and note the
  CTE-shadow caveat.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
