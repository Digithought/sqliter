---
description: When a table declares a computed column, the engine works out which other columns that formula depends on by scanning the text for names, without tracking which table each name belongs to — so a formula that looks up a value in another table gets rejected as broken, or wrongly reported as referring to itself in a circle.
files:
  - packages/quereus/src/schema/table.ts                       # extractGeneratedColumnDependencies (~1438), validateAddColumnGeneratedRefs (~1495), withGeneratedColumnGraph (~1408)
  - packages/quereus/src/schema/manager.ts                     # ~1924 — CREATE TABLE call site; has `this.db`
  - packages/quereus/src/runtime/emit/alter-table.ts           # ~847, ~921, ~1247 — withGeneratedColumnGraph call sites; have `rctx.db`
  - packages/quereus/src/planner/building/alter-table.ts       # ~296 — validateAddColumnGeneratedRefs call site; has `ctx.db`
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts # StripFrame / collectStripBindings — the conservative frame model to extract and share
  - packages/quereus/src/schema/rename/shared.ts               # ResolveColumnInSource, objectRefKey, eq
  - packages/quereus/src/schema/column-source-resolver.ts      # buildColumnSourceResolver — the catalog-backed resolver to thread in
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic  # arm 10 encodes the workaround this removes
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - docs/sql-alter.md                                          # § ADD COLUMN — "One current exception:" note to delete
  - docs/sql-ddl.md                                            # § Generated Columns — bullet at "Generated column expressions must be deterministic."
repro: verified
difficulty: hard
---

# Scope-aware reference analysis for generated-column expressions

## What is wrong

A `generated always as (<expr>)` body is analysed twice at schema time:

- `extractGeneratedColumnDependencies` (`schema/table.ts` ~1438) builds the
  column-index dependency graph fed to `topoSortGeneratedColumns`, and rejects a name it
  cannot find among the table's columns.
- `validateAddColumnGeneratedRefs` (`schema/table.ts` ~1495) is the `ALTER TABLE ADD
  COLUMN` pre-flight that raises the same two errors earlier.

Both walk the AST with `traverseAst` and no scope stack at all. Every bare name anywhere
in the expression — including inside a subquery whose own `FROM` plainly binds it — is
read as a reference to the table being defined.

Meanwhile the *rename* verb already resolves the very same expressions correctly:
`ALTER TABLE … RENAME COLUMN` rewrites a generated body through
`renameColumnInCheckExpression` (`schema/rename/column-rename.ts`), a scope-aware walk
seeded with the owning table, consulting `buildColumnSourceResolver` at each inner
`FROM` frame. `docs/sql-alter.md` § RENAME COLUMN documents that behaviour. So the engine
has two answers to "does this name in this generated body refer to this table's column?"
and they disagree.

## Verified failures

All reproduced against `main` at the time of writing, via `new Database()` + `db.exec`.

**False rejection (CREATE).**

```sql
create table d (k integer primary key, v integer);
create table t (
  id integer primary key,
  g  integer generated always as ((select v from d where d.k = id limit 1))
);
-- Error: Column 'v' referenced by generated column 'g' not found in table 't'
```

`v` belongs to `d`, named by the subquery's own `FROM`. Spelling it `d.v` works and
produces the right value, which is the documented workaround
(`41.14-alter-add-column-subquery-backfill.sqllogic` arm 10, plus a note in
`docs/sql-alter.md` § ADD COLUMN).

**False rejection (ALTER ADD COLUMN).** Identical expression, identical message, from the
pre-flight instead.

**False circularity — two generated columns.**

```sql
create table d2 (k integer primary key, w integer, g integer);
create table t2 (
  id integer primary key,
  w  integer generated always as ((select g from d2 where d2.k = id limit 1)),
  g  integer generated always as ((select w from d2 where d2.k = id limit 1))
);
-- Error: Cyclic dependency in generated columns: 'w', 'g'
```

Neither body names the other column; both name `d2`'s.

**False circularity — self-edge on CREATE.**

```sql
create table l0 (k integer primary key, g integer);
create table l1 (id integer primary key,
  g integer generated always as ((select g from l0 where l0.k = id limit 1)));
-- Error: Cyclic dependency in generated columns: 'g'
```

**False circularity — self-edge on ADD COLUMN.** Same shape through
`validateAddColumnGeneratedRefs`:

```sql
alter table t5 add column g integer
  generated always as ((select g from d5 where d5.k = id limit 1));
-- Error: Cyclic dependency in generated columns: 'g'
```

**Common table expression arm.**

```sql
create table j1 (id integer primary key,
  g integer generated always as ((with c(v) as (select 7) select v from c)));
-- Error: Column 'v' referenced by generated column 'g' not found in table 'j1'
```

## What to build

One reference collector for generated-column bodies, scope-aware, used by both schema-time
call sites — so "which names in this body bind the owning table's row" has exactly one
answer, the one the rename verb already gives.

### Which walker to build on — and why not the rename probe

`columnReferencedInCheckExpression` (`schema/rename/column-rename.ts`) is the obvious
candidate and is *almost* right, but its unqualified-binding scan
(`unqualifiedRefBindsTarget`, ~660) is **optimistic**: a frame whose `FROM` holds a source
it cannot analyse — an inline subquery source, a function source, or a common table
expression with an explicit column list — registers no binding at all, so the walk falls
straight through to the seed and answers "binds the owning table". That is exactly the
common table expression failure above, and reusing the probe would carry it over.

`stripSelfQualifierInCheckExpression` (`schema/rename/self-qualifier-strip.ts`) already
carries the **conservative** frame model this needs: `StripFrame.hasOpaque` marks a frame
holding an unanalysable source, `StripFrame.realSources` are asked through
`ResolveColumnInSource`, and common table expression sources are opaque by construction.
Build on that model.

Extract the frame model — `StripFrame`, `collectStripBindings`, `buildStripFrame`,
`isStripCteName`, the barrier push — into a new
`packages/quereus/src/schema/rename/scope-frame.ts`, and have both the self-qualifier strip
and the new collector consume it. Do not fork a second copy.

### The collector

New module, `packages/quereus/src/schema/generated-column-refs.ts`:

```ts
/** How a reference in a generated body relates to the table being defined. */
export type RefBinding =
  /** Binds the owning table's row: bare name captured by the seed, `<table>.<col>`,
   *  `<own-schema>.<table>.<col>`, or an unrebound `new.<col>`. */
  | 'own'
  /** Binds something else: an analysable inner FROM source exposes the name, or the
   *  qualifier resolves to another object. */
  | 'foreign'
  /** Cannot be decided: an intervening frame holds a subquery / function / CTE source. */
  | 'unknown';

export interface GeneratedColumnRef {
  /** Lowercase name as written. */
  readonly name: string;
  /** `'column'` refs may raise "not found"; `'identifier'` refs never do (a bare
   *  identifier may legitimately be a function or a mutation-context variable). */
  readonly shape: 'column' | 'identifier';
  readonly binding: RefBinding;
}

export function collectGeneratedColumnRefs(
  expr: AST.Expression,
  tableName: string,
  schemaName: string,
  resolveColumnInSource: ResolveColumnInSource,
): GeneratedColumnRef[];
```

The `new.<col>` arm matters even though nothing accepts that spelling on the write path
today: the sibling ticket `generated-column-one-row-scope` makes it resolve, and a
`new.<col>` reference that records no dependency edge would be computed out of topological
order. Match it the way `matchesRowImage` does — only for an unqualified `new` qualifier
that no frame above the seed rebinds, since `new` is not a reserved word in this parser.
`old.<col>` is **not** a row image in a generated body (there is no old row to compute
from) and must answer `'foreign'`.

### How the two call sites consume it

Per reference, per generated column:

| binding | known column of the table | not a column of the table |
|---|---|---|
| `'own'` | record dependency edge | `'column'` shape → raise "not found"; `'identifier'` shape → ignore (unchanged) |
| `'foreign'` | ignore entirely | ignore entirely |
| `'unknown'` | record dependency edge | ignore silently |

The `'unknown'` row is deliberately asymmetric. Recording the edge keeps today's
topological ordering for every schema that currently works — a missing edge would compute
a generated column before its dependency and silently write NULL, which is worse than a
spurious edge. Staying silent on an unknown name removes the false rejection without
inventing a new one. Net effect: this ticket only ever *accepts* more than today, never
less.

### Threading the resolvers

`extractGeneratedColumnDependencies` and `validateAddColumnGeneratedRefs` grow a
`ResolveColumnInSource` parameter; `withGeneratedColumnGraph` grows one too and forwards it.
Callers build it with `buildColumnSourceResolver(db)`:

- `schema/manager.ts` ~1924 — `this.db`
- `runtime/emit/alter-table.ts` ~847, ~921, ~1247 — `rctx.db`
- `planner/building/alter-table.ts` ~296 — `ctx.db`

**The catalog does not yet hold the table under analysis**, and at `DROP COLUMN` it still
holds the *pre-drop* column set. Wrap the catalog resolver so a question about the target
table (`schemaName` + `tableName`, case-folded) is answered from the in-flight `columns`
array instead of the catalog. Without the wrapper, a generated body containing a subquery
over its own table answers wrongly in both directions.

## Edge cases & interactions

- **CREATE TABLE, table absent from catalog.** A generated body with a subquery over the
  table being created (`(select max(id) from t)`): the wrapper above must answer from the
  in-flight columns, not return `false`.
- **DROP COLUMN.** `withGeneratedColumnGraph` runs before `schema.addTable(finalSchema)`;
  the wrapper must answer from the post-drop `columns` array, not the stale catalog entry.
- **ADD COLUMN, new column not yet in the catalog.** A top-level bare reference to the new
  column name is still a self-cycle (`'own'` + not in `existingColumns` ⇒ cycle error, the
  existing behaviour). The same name inside a subquery over a real table exposing it is
  `'foreign'` and must not be a cycle.
- **ADD COLUMN of a name that already exists.** `validateAddColumnGeneratedRefs` currently
  suppresses the cycle error in that case so `runAddColumn`'s duplicate-column check
  reports the real problem. Preserve that.
- **`new` / `old` as real table names.** `create table "new" (…)` is legal. A generated body
  containing `(select max("new".a) from "new")` must resolve through the `FROM` binding, not
  the row image — the `isQualifierReboundAboveSeed` rule.
- **`old.<col>`** answers `'foreign'` — it names nothing in a generated body.
- **Schema-qualified self reference.** `main.t.a` in a body owned by `main.t` is `'own'`;
  `other.t.a` is `'foreign'` even though the bare names collide. The current code compares
  bare names only and gets the second case wrong.
- **Aliased self source.** `(select a from t x)` inside `t`'s own generated body: the alias
  binds the source, the inner `a` is that source's, not the seed's.
- **Common table expression shadowing the owning table.** `(with t as (select 1 as a)
  select a from t)` — the frame is opaque, so `'unknown'`; `a` is a column of the table, so
  the edge is recorded (conservative) and nothing is rejected.
- **Compound / recursive select inside the body.** The frame model must descend union arms
  and `with recursive` bodies the way `visitStrip` already does.
- **Determinism validation is unaffected** — it runs on the built plan node, not here.
- **Store path.** These schemas round-trip through the store module; run `yarn test:store`
  on the alter/generated logic files if the change touches serialized `TableSchema` fields
  (it should not — only the analysis that fills `generatedColumnDependencies`).
- **Residual to leave documented, not fixed:** a self-column name reached only through an
  opaque source still yields a spurious dependency edge, and if two generated columns do
  that to each other the false-cycle error survives. Recording the edge is the safe half of
  the asymmetry above. Leave a `NOTE:` at the collector.

## Tests

`packages/quereus/test/logic/` — a new `41-generated-column-scope.sqllogic` is the natural
home for the CREATE-side arms; the ALTER-side arms belong in
`41.14-alter-add-column-subquery-backfill.sqllogic`.

- Subquery over another table, inner name **unqualified**, on CREATE — accepted, computes
  the right value (`42` in the repro above).
- Same on `ALTER TABLE … ADD COLUMN`, with the existing rows backfilled correctly.
- `41.14` arm 10: keep the qualified spelling as its own arm (it must not regress) and add
  the unqualified spelling alongside; delete the comment explaining the workaround.
- Two generated columns each reading another table's like-named column — accepted, both
  values correct.
- Generated column whose subquery selects a column of another table with the **same name as
  itself** — accepted, no false self-cycle, correct value.
- Common table expression arm (`with c(v) as (select 7) select v from c`) — accepted.
- **Negative arms that must still fail**, with today's messages:
  - genuine typo: `generated always as (nosuch + 1)` → `Column 'nosuch' referenced by
    generated column 'g' not found in table 't'`.
  - genuine self reference: `add column g … generated always as (g + 1)` → `Cyclic
    dependency in generated columns: 'g'`.
  - genuine two-column cycle on CREATE.
- Aliased self source and `create table "new"` arms per the edge-case list.

## Docs

- `docs/sql-alter.md` § ADD COLUMN — delete the sentence beginning "One current exception:
  inside a `GENERATED ALWAYS AS` expression, a subquery may not name another table's column
  *unqualified*…" and the workaround it prescribes.
- `docs/sql-ddl.md` § Generated Columns (the bullet at "Generated column expressions must be
  deterministic…") — state the resolution rule plainly: a name in a generated expression
  resolves against the table being defined unless a `FROM` clause inside the expression
  binds it, the same rule a CHECK constraint follows.

## Notes for whoever picks this up

- Arm C of the originating plan ticket — a mutation-context variable colliding with a column
  name making the table unwritable — **no longer reproduces**. `mutationContextVarNames` /
  `shadowedByContext` in `planner/building/constraint-builder.ts` and
  `planner/building/default-scope.ts` already skip the bare column registration, and
  `docs/sql-ddl.md` § 2.6.2 documents the precedence. Verified across INSERT, UPDATE, DELETE,
  an expression DEFAULT reading the variable, and a NOT NULL column whose DEFAULT reads it.
  Nothing to do.
- The plan ticket referenced a sibling `bug-ddl-accepts-definitions-that-break-first-write`.
  No such ticket exists on the board. The instance of that class found here — `ALTER TABLE …
  ADD COLUMN … GENERATED ALWAYS AS (new.<col> …)` backfills successfully and then leaves the
  table rejecting every INSERT — is fixed by the sibling ticket
  `generated-column-one-row-scope`, not by this one.

## TODO

- Extract `StripFrame` and its builders from `schema/rename/self-qualifier-strip.ts` into
  `schema/rename/scope-frame.ts`; repoint the strip walker at it. No behaviour change —
  confirm with the existing rename/strip specs before going further.
- Add `schema/generated-column-refs.ts` with `collectGeneratedColumnRefs` per the interface
  above, built on the shared frame model.
- Rewrite `extractGeneratedColumnDependencies` on the collector, applying the
  binding × known-column table.
- Rewrite `validateAddColumnGeneratedRefs` on the same collector, preserving the
  duplicate-column suppression and the existing two error messages verbatim.
- Thread `ResolveColumnInSource` through `withGeneratedColumnGraph` and the four call sites;
  add the in-flight-columns wrapper for the target table.
- Leave a `NOTE:` at the collector recording the opaque-source residual.
- Add the sqllogic arms above; rework `41.14` arm 10.
- Update `docs/sql-alter.md` and `docs/sql-ddl.md`.
- `yarn build`, `yarn test`, `yarn lint`. Run `yarn test:store` for the alter/generated logic
  files.
