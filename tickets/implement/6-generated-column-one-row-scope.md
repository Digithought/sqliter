---
description: A computed column's formula is compiled separately by each kind of write statement, and each one accepts a different way of spelling the column names in it — so a table definition the engine accepted can turn out to reject every insert, or work for an update but not an insert.
prereq: generated-column-refs-scope-aware
files:
  - packages/quereus/src/planner/building/insert.ts             # createGeneratedColumnProjection (~208), registerExistingRowColumns (~314), appendGeneratedRecomputes (~331)
  - packages/quereus/src/planner/building/update.ts             # ~139-153 tableColumnScope/AliasedScope, ~208-222 generated recompute
  - packages/quereus/src/planner/building/alter-table.ts        # buildAddColumnBackfill ~273-341
  - packages/quereus/src/planner/building/default-scope.ts      # buildRowDefaultScope — the ALTER backfill scope
  - packages/quereus/src/planner/building/constraint-builder.ts # ~167-177 — the clone + strip precedent to copy
  - packages/quereus/src/planner/building/schema-authored-context.ts
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripSelfQualifierInCheckExpression
  - packages/quereus/src/schema/column-source-resolver.ts       # buildColumnSourceResolver
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic
  - docs/sql-ddl.md                                             # § Generated Columns
  - docs/sql-alter.md                                           # § ADD COLUMN
repro: verified
difficulty: medium
---

# One row scope for generated-column expressions, at every write site

## What is wrong

A `generated always as (<expr>)` body is compiled at four independent places, each of which
builds its own scope by hand and registers a different set of names:

| site | scope built by | names registered |
|---|---|---|
| `building/insert.ts` `createGeneratedColumnProjection` (~208) | inline `RegisteredScope` | bare `<col>` only |
| `building/insert.ts` `appendGeneratedRecomputes` (~331), the `ON CONFLICT DO UPDATE` recompute | `registerExistingRowColumns` (~314) | bare `<col>`, `<table>.<col>` |
| `building/update.ts` (~208-222) | `AliasedScope` over `tableColumnScope` (~139-153) | bare `<col>`, `<correlation>.<col>` |
| `building/alter-table.ts` `buildAddColumnBackfill` (~273-341) | `buildRowDefaultScope` | bare `<col>`, `new.<col>` |

Four sites, four accepted spellings. The same stored expression therefore means different
things depending on which statement compiles it — and, since `CREATE TABLE` and `ALTER
TABLE ADD COLUMN` validate against *none* of them, a definition the engine accepts can turn
out to reject every write.

A fifth divergence rides along: `createGeneratedColumnProjection` builds with a plain
`{ ...ctx, scope }` while the other three wrap in `schemaAuthoredContext(...)`. So a bare
table name in a subquery inside a generated body resolves against the session schema path on
the INSERT path and against the table's own schema everywhere else. (Read from the code, not
reproduced — the INSERT path currently rejects the qualified spellings needed to set up the
divergence. Cover it with a test.)

## Verified failures

**A generated column that qualifies its own table's column makes the table unwritable.**

```sql
create table z (id integer primary key, a integer,
                g integer generated always as (z.a * 2) stored);
-- accepted
insert into z (id, a) values (1, 1);
-- Error: z.a isn't a column
```

Same for the schema-qualified spelling (`main.z.a` → `main.z.a isn't a column`), and for
`alter table z2 add column h integer generated always as (z2.a + 1)` → `z2.a isn't a
column`. Removing the qualifier makes everything work. Nothing warns at declaration time.

**`new.<col>` is accepted by ALTER and then rejected by every INSERT.**

```sql
create table k1 (id integer primary key, a integer);
insert into k1 values (1, 3);
alter table k1 add column g integer generated always as (new.a * 2);
-- accepted; backfills correctly: {"id":1,"a":3,"g":6}
insert into k1 (id, a) values (2, 5);
-- Error: new.a isn't a column
```

The table is left holding rows it can never gain another one of. The same happens with
`new.<other generated column>` (`generated always as (new.g1 + 1)`).

`old.<col>` is rejected at ALTER time (`old.a isn't a column`) — consistent, and it should
stay rejected.

## What to build

One builder for the generated-expression row scope, used by all four sites, plus one
self-qualifier strip applied on the way in — so a generated body means the same thing
wherever it is compiled.

### Decided: which spellings a generated expression accepts

| spelling | accepted | how |
|---|---|---|
| `<col>` | yes | registered by the shared scope builder |
| `<table>.<col>` | yes | folded to `<col>` by the strip, before the scope is consulted |
| `<own-schema>.<table>.<col>` | yes | same |
| `new.<col>` | yes | registered by the shared scope builder, same target as the bare form |
| `old.<col>` | **no** | a generated value is computed from the row being written; there is no old row to compute from |
| any other qualifier | no | resolves through the ordinary scope chain, as today |

`new.<col>` is **accepted rather than rejected** deliberately: `ALTER TABLE … ADD COLUMN`
accepts and correctly backfills it today, so rejecting it would break a statement that
currently succeeds; and both `CHECK` (`planner/building/constraint-builder.ts` ~113) and
column `DEFAULT` (`planner/building/default-scope.ts` ~44) already accept it — for a
`DEFAULT` it is the *only* accepted spelling, since a bare column reference there is
rejected outright. In a generated expression `new.<col>` is an exact alias for the bare
form: the value the generated column is computed from.

### The strip, not extra scope keys

Fold `<table>.<col>` / `<schema>.<table>.<col>` with
`stripSelfQualifierInCheckExpression` (`schema/rename/self-qualifier-strip.ts`), on a
`cloneExpr` copy — never the stored AST — exactly as
`planner/building/constraint-builder.ts` ~167-177 already does for CHECK constraints, and
for the reason documented there: the row scope is an ancestor of every subquery planned
inside the body, so seeding `<table>.<col>` keys would let a join peer's parent-chain
fallback resolve an inner relation's qualified columns against the outer row context. The
strip is already scope-aware and already declines to strip where an intervening `FROM`
could capture the resulting bare name.

Despite its name the function is not CHECK-specific — it takes an expression, a table name,
a schema name and a `ResolveColumnInSource`. Rename it if that reads better; either way both
callers must reach the same implementation.

### The shared builder

New module, `packages/quereus/src/planner/building/generated-column-scope.ts`:

```ts
/**
 * The scope and the rewritten expression a generated column's body is compiled
 * against. `expr` is a clone whenever the strip fired, the stored AST otherwise.
 */
export interface GeneratedColumnBuild {
  readonly scope: RegisteredScope;
  readonly expr: AST.Expression;
}

export function buildGeneratedColumnExpr(
  ctx: PlanningContext,
  tableSchema: TableSchema,
  column: ColumnSchema,
  /** Row attributes, index-aligned with `tableSchema.columns`. */
  rowAttributes: ReadonlyArray<Attribute>,
): GeneratedColumnBuild;
```

Every site then goes through it, and each keeps only its own concern (which attributes make
up the row, where the resulting node is placed). All four must build the expression under
`schemaAuthoredContext(ctx, tableSchema.schemaName)`.

`buildRowDefaultScope` (`default-scope.ts`) already registers bare + `new.<col>` and is the
closest existing shape; either build on it or register the same pair directly. Do not add
`old.<col>`.

## Edge cases & interactions

- **Mutation-context variable shadowing a column name.** `constraint-builder.ts` and
  `buildRowDefaultScope` skip the *bare* registration for a name a `with context` variable
  claims, leaving `new.<col>` as the way to reach the column
  (`docs/sql-ddl.md` § 2.6.2). Decide and document whether a generated body follows the same
  precedence. **It should** — otherwise a table declaring a context variable named like a
  column resolves the same bare name two ways depending on whether it sits in a CHECK or a
  generated body. `RegisteredScope.registerSymbol` throws on a duplicate key, so a site that
  registers both without the skip fails at plan time with an internal message naming neither.
- **Generated column reading another generated column.** `createGeneratedColumnProjection`
  chains one projection per generated column in `generatedColumnTopoOrder` so each sees the
  freshly computed value. The shared builder must be handed *that iteration's* input
  attributes, not the table reference's — do not collapse the chain.
- **`new.<other generated column>`** must resolve to the same freshly-computed attribute the
  bare form does, in every one of the four sites.
- **`old.<col>` stays rejected** with the current error, at all four sites.
- **A real table named `new`.** `create table "new" (…)` is legal. A generated body
  containing `(select max("new".a) from "new")` must still read the table — the row scope is
  an ancestor, so the subquery's own `FROM` binds first; add a test.
- **UPDATE's synthesised correlation name.** `building/update.ts` ~152 uses
  `stmt.alias ?? tableName` as the correlation, set by the view-mutation single-source
  lowering. Folding `<table>.<col>` in the expression before the scope is consulted must not
  disturb that — the strip rewrites the *stored body's* self-qualifier, and the
  `AliasedScope` continues to serve the statement's own SET / WHERE / RETURNING expressions.
- **View / lens decomposition writes.** A write through a view is re-planned through the same
  INSERT / UPDATE builders per member, so each member's generated columns route through the
  shared builder too. Check `planner/building/view-mutation-builder.ts` for any fifth site.
- **`ON CONFLICT DO UPDATE`.** `registerExistingRowColumns` (~314) is shared by the DO UPDATE
  SET scope *and* the generated recompute. Only the generated arm moves to the new builder;
  the DO UPDATE SET scope keeps its `<table>.<col>` registration, which is user-facing SQL,
  not a stored body.
- **ALTER ADD COLUMN backfill vs. subsequent INSERT.** The pair must accept exactly the same
  expression — that equivalence is the point of the ticket, and the `new.<col>` failure above
  is its counterexample. Every new sqllogic arm should exercise both.
- **Determinism validation** (`validateDeterministicGenerated`) runs on the built node at
  each site and must keep running at each site.
- **Store path.** `yarn test:store` for the generated / alter logic files — the ALTER
  backfill goes through the store module.

## Tests

`packages/quereus/test/logic/41-generated-columns.sqllogic` and
`41.13-alter-add-column-generated-backfill.sqllogic`; negative arms in
`41-generated-column-errors.sqllogic`.

For each accepted spelling — bare, `<table>.<col>`, `<schema>.<table>.<col>`, `new.<col>` —
one arm covering all four paths end to end:

- `CREATE TABLE` with the generated column, then `INSERT`, then `SELECT` the computed value.
- `UPDATE` a dependency and re-`SELECT` — the generated value recomputes.
- `INSERT … ON CONFLICT (…) DO UPDATE SET` a dependency — the generated value recomputes.
- `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS (<same spelling>)` over existing rows —
  backfills correctly, **and a subsequent `INSERT` succeeds** (this is what fails today for
  `new.<col>`).

Plus:

- `old.<col>` rejected at every one of the four sites, same message.
- `new.<other generated column>` computes in topological order — `alter table … add column
  g1 … (a * 2)` then `add column g2 … (new.g1 + 1)`, backfill *and* a later insert.
- A generated body whose subquery names a bare table that exists in two schemas — resolves
  against the table's own schema on the INSERT path, matching the other three
  (`schemaAuthoredContext`).
- `create table "new" (…)` read from a generated body's subquery.
- A table declaring a `with context` variable named like a column, with a generated body
  reading that bare name — resolves per the documented precedence, and no internal
  duplicate-symbol error.

## Docs

- `docs/sql-ddl.md` § Generated Columns — list the accepted spellings and state that they are
  the same at `CREATE TABLE`, `INSERT`, `UPDATE`, `ON CONFLICT DO UPDATE` and `ALTER TABLE …
  ADD COLUMN`. Say `old.<col>` is not accepted, and why.
- `docs/sql-alter.md` § ADD COLUMN — the paragraph describing generated backfill currently
  says only "a generated expression's bare column references resolve the same way"; widen it
  to the full accepted set, and note that a declaration the ALTER accepts is one every
  subsequent INSERT accepts.

## TODO

- Add `planner/building/generated-column-scope.ts` with `buildGeneratedColumnExpr`: clone +
  `stripSelfQualifierInCheckExpression` (resolver from `buildColumnSourceResolver(ctx.db)`),
  then a `RegisteredScope` registering bare `<col>` and `new.<col>` per row attribute, with
  the mutation-context bare-name skip.
- Rewire `insert.ts` `createGeneratedColumnProjection` — including wrapping in
  `schemaAuthoredContext`, which it currently omits.
- Rewire `insert.ts` `appendGeneratedRecomputes` (generated arm only; leave the DO UPDATE SET
  scope alone).
- Rewire `update.ts`'s generated recompute loop.
- Rewire `alter-table.ts` `buildAddColumnBackfill`'s generated arm; leave the DEFAULT arm on
  `buildRowDefaultScope`.
- Add the sqllogic arms above.
- Update `docs/sql-ddl.md` and `docs/sql-alter.md`.
- `yarn build`, `yarn test`, `yarn lint`; `yarn test:store` for the generated / alter logic
  files.
