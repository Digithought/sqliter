---
description: A computed column's formula used to be compiled separately by each kind of write statement, each accepting a different way of spelling the column names in it; now one shared builder handles all of them, so a table definition the engine accepts can no longer turn out to reject every insert.
files:
  - packages/quereus/src/planner/building/generated-column-scope.ts   # NEW — the shared builder
  - packages/quereus/src/planner/building/insert.ts                   # createGeneratedColumnProjection, appendGeneratedRecomputes
  - packages/quereus/src/planner/building/update.ts                   # generated recompute loop (~212)
  - packages/quereus/src/planner/building/alter-table.ts              # buildAddColumnBackfill generated arm
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts        # renamed fn + widened doc
  - packages/quereus/src/schema/rename-rewriter.ts                    # barrel re-export
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic
  - packages/quereus/test/logic/13.9.1-schema-authored-schema-path-isolation.sqllogic
  - docs/sql-ddl.md                                                   # § Generated Columns
  - docs/sql-alter.md                                                 # § ADD COLUMN
difficulty: medium
---

# Review: one row scope for generated-column expressions at every write site

## What changed

A new module `planner/building/generated-column-scope.ts` exports one function:

```ts
buildGeneratedColumnExpr(
  ctx: PlanningContext,
  tableSchema: TableSchema,
  columnName: string,              // for the determinism diagnostic; at ADD COLUMN this
                                   //  column is NOT yet in tableSchema.columns
  generatedExpr: AST.Expression,
  rowAttributes: ReadonlyArray<Attribute>,  // index-aligned with tableSchema.columns
): ScalarPlanNode
```

It does, in one place, what four sites each did differently:

1. clones the stored body and runs the self-qualifier strip over the clone (never the
   stored AST), folding `<table>.<col>` and `<own-schema>.<table>.<col>` to the bare form;
2. builds a `RegisteredScope` registering bare `<col>` **and** `new.<col>` per row
   attribute, both pointing at the same attribute;
3. wraps in `schemaAuthoredContext(ctx, tableSchema.schemaName)`;
4. builds the expression and runs `validateDeterministicGenerated` (honouring
   `nondeterministic_schema`).

All four sites now call it: `insert.ts` `createGeneratedColumnProjection` (the chain is
preserved — each iteration is handed *that* iteration's input attributes),
`insert.ts` `appendGeneratedRecomputes` (generated arm only; the DO UPDATE SET scope keeps
its own `<table>.<col>` registration, which serves user SQL), `update.ts`'s recompute loop,
and `alter-table.ts` `buildAddColumnBackfill`'s generated arm (its DEFAULT arm still uses
`buildRowDefaultScope`).

`stripSelfQualifierInCheckExpression` was renamed to
**`stripSelfQualifierInSchemaExpression`** — it now serves both CHECK and generated bodies.
Definition, barrel re-export, and both call sites plus the one test import were renamed
together; the doc comment was widened accordingly.

## Deviations from the ticket — read these first

**1. The ticket's stated interface (`GeneratedColumnBuild { scope, expr }`) was not used.**
The builder returns the finished `ScalarPlanNode` instead. Rationale: with `{scope, expr}`
each site still has to remember to wrap in `schemaAuthoredContext` and to run
`validateDeterministicGenerated` — exactly the kind of per-site drift the ticket exists to
kill. Returning the node makes both structural. Every site's remaining concern (which
attributes make up the row, where the node is placed) stays at the site.

**2. Mutation-context precedence went the OTHER way from the ticket's recommendation.**
The ticket said a generated body "should" follow CHECK/DEFAULT precedence, where a
`with context` variable claims the bare name. It does not, and the builder registers no
context symbols at all. Two reasons, both verified against the running engine:

- `ALTER TABLE … ADD COLUMN` backfill has **no mutation-context envelope**. Letting a
  context variable capture a bare name would make a generated declaration mean one thing on
  a write and another (or nothing at all) during backfill — reintroducing, at the context
  seam, exactly the divergence this ticket closes. Verified: `create table c1 (…, g integer
  generated always as (a + 1)) with context (a integer)` + `insert … with context a = 100`
  yields `g = 4` (column, 3+1) today, and still does.
- A generated body **cannot usefully name a context variable anyway**: the schema-time
  analysis rejects any bare name in a generated body that is not a column of the table.
  Verified: `generated always as (a + cap)` with `with context (cap integer)` is rejected at
  `CREATE TABLE` with `Column 'cap' referenced by generated column 'g' not found in table
  'c2'`. So the only reachable case is a *collision*, and honouring the ticket's preference
  would have been a pure regression there.

Consequence: there is **no duplicate-symbol risk** at all in the new builder (the ticket
flagged one), because no context symbols are registered beside the columns. Documented at
the code site and in `docs/sql-ddl.md` § Generated Columns. **If a reviewer disagrees with
this call, this is the one decision to re-litigate** — everything else follows the ticket.

**3. The ticket's claimed "fifth divergence" does not exist.** It said
`createGeneratedColumnProjection` built on a plain `{...ctx, scope}` while the others wrapped
in `schemaAuthoredContext`. It does — but its caller
(`createRowExpansionProjection`, `insert.ts` ~871) is already handed `schemaAuthoredCtx`, so
the INSERT path was already schema-authored. `13.9.1-schema-authored-schema-path-isolation
.sqllogic` § "Generated column, INSERT path" already pinned it. The change makes the wrap
explicit rather than inherited; no behaviour moved.

**4. `update.ts` lost a spelling it used to accept.** Its recompute used to build on
`schemaAuthoredUpdateCtx`, whose scope is the statement's `AliasedScope`, so a generated
body spelling `<statement-correlation>.<col>` (from `update t as x …`) would resolve on the
UPDATE path only. It now builds on the plain statement scope, so that spelling resolves
nowhere — matching the other three sites. This is intended narrowing, not a regression, but
it is a behaviour removal and is untested (no test exercised it before or after).

## Verified behaviour (before → after)

Each of these was run against the engine before and after:

| case | before | after |
|---|---|---|
| `create table z (…, g generated always as (z.a * 2))` then `insert` | `z.a isn't a column` | works |
| same with `main.z.a` | `main.z.a isn't a column` | works |
| same with `new.a` | `new.a isn't a column` | works |
| `alter table k2 add column h … (k2.a + 1)` | `k2.a isn't a column` | works |
| `alter table k1 add column g … (new.a * 2)` then a later `insert` | ALTER + backfill OK, **every later INSERT failed** | both work |
| `old.<col>` at INSERT / UPDATE / upsert / ALTER | rejected | still rejected, same message `old.a isn't a column` |
| `create table "new"` read from a generated body's subquery | works | works |
| context var named like a column, bare read in a generated body | resolves to the column | unchanged |

## Tests added

- **`41-generated-columns.sqllogic`** — new § "Row-scope spellings": one arm per accepted
  spelling (bare, `<table>.<col>`, `<schema>.<table>.<col>`, `new.<col>`), each covering
  INSERT → SELECT → UPDATE → SELECT → `on conflict do update` → SELECT. Plus:
  `new.<other generated column>` topological chain across all three write paths; a real
  table named `"new"` read from a generated body's subquery; the mutation-context
  no-shadow arm (asserts `g = 4`, not `101` — this is the assertion that pins deviation 2).
- **`41.13-alter-add-column-generated-backfill.sqllogic`** — new §§ 14 and 15: each spelling
  backfills an existing row **and** a subsequent INSERT succeeds **and** an UPDATE
  recomputes; then a two-step `add column g1` / `add column g2 … (new.g1 + 1)` chain.
- **`41-generated-column-errors.sqllogic`** — new § 4: `old.<col>` rejected at all four
  sites with the same message, and the rejected ALTER leaves the table alone.
- **`13.9.1-schema-authored-schema-path-isolation.sqllogic`** — the generated-column arm now
  covers UPDATE, `do update` and ADD COLUMN backfill alongside INSERT (a decoy `main.c` vs.
  the real `temp.c`). Its stale comment about `bug-update-generated-column-subquery-not-
  awaited` blocking the UPDATE arm was removed — that ticket is in `complete/` and the arm
  now passes.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (includes the `tsconfig.test.json` type pass).
- `yarn test` — 9233 passing in `packages/quereus`, all other workspaces green, 0 failing.
- Store path: `QUEREUS_TEST_STORE=true … --grep "File: 41"` (47 passing, includes all three
  41.* generated files) and `--grep "File: 13.9.1"` (passing). The full `yarn test:store`
  was **not** run — only the files this ticket touches.

## Known gaps — where to point the review

- **Not run:** full `yarn test:store`. Only the 41.* and 13.9.1 files were exercised on the
  store path.
- **Untested behaviour removal:** the `update t as x` correlation-qualified spelling
  (deviation 4). No test asserts it is now rejected.
- **`old.<col>` is still accepted at `CREATE TABLE` and only rejected at the first write.**
  `ALTER TABLE ADD COLUMN` rejects it at declaration time (the plan-time build runs there),
  but `CREATE TABLE` does not — the schema-time analysis classifies `old.` as `'foreign'`
  and lets it through. So `create table o (…, g generated always as (old.a + 1))` still
  succeeds and every write to `o` then fails. That is the same declaration-accepts /
  write-rejects shape this ticket set out to close, for the one spelling that is *supposed*
  to be rejected. It is pinned by a test as current behaviour, not fixed. Deciding whether
  `CREATE TABLE` should reject it is a judgement call about the schema-time classifier
  (`schema/generated-column-refs.ts` `classifyQualified`, which returns `'foreign'` for an
  unbound bare `old`) — worth a reviewer's opinion.
- **Column reference types changed at three of the four sites.** The shared builder resolves
  every column reference against `columnSchemaToScalarType(column)` — the *declared* type,
  which carries the declared collation — rather than the row attribute's own type. This
  matches what the CHECK builder and the ALTER backfill already did, and is why a generated
  expression comparing text now resolves the same collation a CHECK would. The INSERT and
  upsert paths previously used the attribute's type. No test regressed, but no test
  specifically covers a generated expression over a `collate nocase` column either — worth
  a targeted arm.
- **Tripwire parked in code, not a ticket:** `generated-column-scope.ts` carries a `NOTE:`
  that the builder clones and walks the stored body on every plan build of a write to a
  table with generated columns (the CHECK path already does exactly this). Plan-build only,
  bodies are small; the note says to cache the stripped form on the column schema if it ever
  profiles hot.
