---
description: A computed column saved to persistent storage comes back empty after the database is closed and reopened — the rule that computes it is silently thrown away, and every row written afterwards stores nothing in that column.
files:
  - packages/quereus/src/schema/ddl-generator.ts                  # formatColumnDef (~497-537) — the one site to change
  - packages/quereus/src/schema/column.ts                         # ColumnSchema.generated / .generatedExpr / .generatedStored (lines 49-54)
  - packages/quereus/src/schema/table.ts                          # columnDefToSchema ~425-440 — the re-parse side that reconstructs the three fields
  - packages/quereus/src/emit/ast-stringify.ts                    # columnConstraintsToString ~1600 — the AST-side rendering of the same clause
  - packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts  # in-memory KV provider harness to copy for the new reopen spec
  - packages/quereus-store/test/ddl-generator.spec.ts             # unit-level DDL text assertions
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts # generator → parse round-trip suite
repro: verified
difficulty: easy
---

# Emit `generated always as` from the canonical DDL generator

## Root cause — one site

`formatColumnDef` in `packages/quereus/src/schema/ddl-generator.ts` renders a column's
type, nullability, `COLLATE`, inline `PRIMARY KEY`, `DEFAULT` and tags. It has no branch
for `GENERATED ALWAYS AS`, so `ColumnSchema.generated` / `.generatedExpr` /
`.generatedStored` never reach the persisted text. Every other layer is already correct:
the parser accepts the clause, `columnDefToSchema` (`schema/table.ts` ~425) reconstructs all
three fields from it, and the insert/update planner honours them. The single missing
emission is the whole bug.

`generateTableDDL` and `generateMaintainedTableDDL` both funnel through
`generateTableDDLInternal` → `formatColumnDef`, so one branch fixes both.

## Verified, before and after

Reproduced in-process against `@quereus/store` over the in-memory KV provider
(create → persist → `close()` → fresh `Database` + `StoreModule` over the same provider →
`rehydrateCatalog`), on this table:

```sql
create table G (id integer primary key,
                a integer null,
                g integer null generated always as (a + 1) stored,
                v integer null generated always as (a * 2)) using store
```

Before (current `main`):

```
DDL: CREATE TABLE "main"."G" ("id" INTEGER NOT NULL PRIMARY KEY, "a" INTEGER NULL,
                              "g" INTEGER NULL, "v" INTEGER NULL) USING store
cols after reopen: id(gen=false) a(gen=false) g(gen=false) v(gen=false)
row inserted after reopen: { id: 2, a: 7, g: null, v: null }
insert into G (id, a, g) values (3, 1, 999)  -> accepted, no error
```

After adding the branch below (prototype applied, then reverted — the tree is unmodified):

```
DDL: ... "g" INTEGER NULL GENERATED ALWAYS AS (a + 1) STORED,
         "v" INTEGER NULL GENERATED ALWAYS AS (a * 2) VIRTUAL ...
cols after reopen: g(gen=true,stored=true) v(gen=true,stored=false)
row inserted after reopen: { id: 2, a: 7, g: 8, v: 14 }
insert into G (id, a, g) values (3, 1, 999)  -> "Cannot INSERT into generated column 'g'"
```

So both halves of the expected behaviour — correct recomputation and restored
non-writability — fall out of the one emission. No refusal path is needed; the persistence
layer supports computed columns fine once it is told about them.

## The change

In `formatColumnDef`, after the `DEFAULT` block and before the tags block:

```ts
if (col.generated && col.generatedExpr) {
    colDef += ` GENERATED ALWAYS AS (${expressionToString(col.generatedExpr)})`;
    colDef += col.generatedStored ? ' STORED' : ' VIRTUAL';
}
```

Notes on the shape:

- **Placement after `DEFAULT` is safe and mutually exclusive** — `columnDefToSchema`
  (`schema/table.ts` ~435) already rejects a column carrying both `DEFAULT` and
  `GENERATED ALWAYS AS`, so the two branches can never both fire. Column constraints parse
  in a loop in any order, so nothing else about the ordering matters.
- **Emit the storage keyword explicitly**, `STORED` or `VIRTUAL`, rather than following the
  AST stringifier's convention of eliding the default `VIRTUAL`. This file's stated stance
  (see its header comment) is that persisted DDL is fully explicit so it re-parses
  identically under any reader. Both forms re-parse to `stored: false`, so this is a
  readability/robustness choice, not a correctness one.
- **Guard on `generatedExpr` being present.** `GENERATED ALWAYS AS` has no
  expression-less form, so a hypothetical `generated: true` with no expression has nothing
  faithful to emit. Every producer in the tree populates the expression (the parser always
  does; `buildConstraintsFromColumn` in `runtime/emit/alter-table.ts` ~2467 already guards
  the same way), so the guard is unreachable defence, not a silent drop.
- Rendering goes through `expressionToString`, the same emitter `DEFAULT` and `CHECK` use,
  so the generated body re-parses to the same AST it came from.

## Blast radius measured, not assumed

With the prototype applied and `@quereus/quereus` rebuilt:

- `yarn workspace @quereus/quereus run test` — 8696 passing, 13 pending, 0 failing.
- `yarn workspace @quereus/store run test` — 1363 passing, 0 failing.

Nothing pins the old (lossy) column text. Note that the store test suite resolves
`@quereus/quereus` through its built `dist`, so **the engine package must be rebuilt before
the store specs see a source change** — a store run against a stale `dist` silently passes.

## What the schema differ makes of it

Checked, per the fix ticket's scope note: `computeColumnAttributeChange`
(`schema/schema-differ.ts` ~2408) compares nullability, data type, `DEFAULT`, collation and
tags. It never reads `generated`, before or after this change, so the new clause causes no
differ churn — a declared generated column and a live one compare equal on every dimension
the differ looks at. `declarative-equivalence.spec.ts` (the `gen-virtual` / `gen-stored`
cases) exercises the create-from-declaration path and stays green.

The flip side — a declarative schema that *changes* a column's generated body is silently
ignored — is a real but separate gap that needs SQL syntax that does not exist yet
(`ALTER COLUMN … SET/DROP GENERATED`). Filed as
`backlog/feat-alter-column-generated-clause` rather than folded in here.

## TODO

- Add the `GENERATED ALWAYS AS` branch to `formatColumnDef` in
  `packages/quereus/src/schema/ddl-generator.ts`, with a short comment in the style of the
  neighbouring `COLLATE` block explaining what a missing clause costs on reopen.
- Add a case to `packages/quereus-store/test/ddl-generator.spec.ts` pinning the emitted text
  for a stored column and a virtual one (the suite's `makeColumn` helper takes a
  `Partial<ColumnSchema>`, so `{ generated: true, generatedExpr, generatedStored }` drops
  straight in).
- Add `packages/quereus-store/test/generated-column-reopen.spec.ts` — copy the in-memory KV
  provider harness from `add-column-inline-constraint-reopen.spec.ts` — asserting across a
  real persist → `close()` → fresh `Database`/`StoreModule` → `rehydrateCatalog` cycle:
  - `rehydrateCatalog` reports no errors;
  - the reopened columns carry `generated`, the right `generatedExpr`, and the right
    `generatedStored` for both a `stored` and a `virtual` column;
  - a row inserted *after* the reopen gets the computed values (not `null`);
  - a direct `insert` into the generated column is rejected after the reopen;
  - a `rename column` of a column named by the generated body, done before the close,
    re-persists the rewritten body and still computes correctly after the reopen
    (`renameColumnInColumnExpressions` in `schema/rename-rewriter.ts` already rewrites
    `generatedExpr` in memory — this leg is what proves the rewrite now survives).
- Add a generated-column case to
  `packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts` covering
  `generateTableDDL → parse → columnDefToSchema`, so the engine-side round-trip is pinned
  without needing the store.
- Rebuild `@quereus/quereus` before running the store suites; then run
  `yarn workspace @quereus/quereus run test` and `yarn workspace @quereus/store run test`.
