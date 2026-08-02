---
description: Renaming a table (or a column) silently breaks any integrity-check rule that mentions it — afterwards every write to that table fails with a confusing "table not found" error. Make renames rewrite those rules the same way they already rewrite views.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                      # propagateTableRenameInSchema (~2038) / propagateColumnRenameInSchema (~2179) — the two call sites
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts         # NEW — the propagation pass itself (keeps alter-table.ts from growing)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # shape/style precedent for a per-object-kind rename helper module
  - packages/quereus/src/schema/assertion.ts                              # IntegrityAssertionSchema; new shared violation-SQL builder goes here
  - packages/quereus/src/runtime/emit/create-assertion.ts                 # the one place that builds violationSql today — must share the builder
  - packages/quereus/src/schema/rename-rewriter.ts                        # renameTableInAst / renameColumnInAst — the walkers to reuse verbatim
  - packages/quereus/src/schema/manager.ts                                # SchemaManager.addAssertion — re-registering fires assertion_modified
  - packages/quereus/src/core/database-assertions.ts                      # AssertionEvaluator — recompiles from violationSql when schemaGeneration bumps
  - packages/quereus/src/schema/schema-differ.ts                          # assertion loop ~841-871 — its NOTE describes today's behavior and must be corrected
  - docs/sql-alter.md                                                     # lines 19 / 29 enumerate what a rename propagates into; assertions must join the list
  - docs/schema.md                                                        # § "Assertion body-change detection" (~line 551) — same
  - packages/quereus/test/logic/95-assertions.sqllogic                    # end-to-end assertion coverage
  - packages/quereus/test/assertion-home-schema.spec.ts                   # style precedent for a schema-scoped assertion spec
difficulty: medium
repro: verified
---

# `ALTER TABLE … RENAME` must follow into assertion bodies

## What is wrong

An assertion (`create assertion a1 check (not exists (select 1 from t where x < 0))`)
stores its CHECK expression as written, plus a derived `violationSql`
(`select 1 where not (<expr>)`) that the commit-time evaluator re-parses and
re-plans. `ALTER TABLE … RENAME` rewrites the renamed name into every other
dependent the catalog knows about — CHECK expressions on every table, foreign-key
targets, partial-index predicates, view bodies, materialized-view bodies — but
never into assertion bodies. The assertion stays bound to the vanished name.

Because assertions are evaluated at commit over the tables that changed, the
result is that **every write to the renamed table fails**, with an error naming a
table the user just renamed away and no mention of the assertion.

## Reproduction (verified, both arms)

Table rename:

```
create table t ( x integer primary key );
create assertion a1 check (not exists (select 1 from t where x < 0));
alter table t rename to t2;
insert into t2 values (7);
-- Table 't' not found in schema path: main
```

Column rename:

```
create table u ( id integer primary key, x integer );
create assertion a2 check (not exists (select 1 from u where x < 0));
alter table u rename column x to y;
insert into u values (1, -3);
-- Column not found: x
```

Verified in-process against `Database` at HEAD. After the table rename the stored
body is unchanged: `select 1 where not (not exists (select 1 from t where x < 0))`.

## Expected behavior

A rename carries into every live assertion in the renamed object's schema exactly
the way it carries into a view body: the stored CHECK expression AST is rewritten
in place, the derived `violationSql` is regenerated from it, and the assertion is
re-registered so dependent caches invalidate. After the rename the assertion
enforces the same rule against the renamed table.

## How it should work

### Where the pass hooks in

`propagateTableRenameInSchema` and `propagateColumnRenameInSchema` (both in
`alter-table.ts`) each already have a block guarded by
`schema.name.toLowerCase() === renamedSchemaLower` that walks views and then
materialized views. The assertion walk goes in that same block, right after the
view loop. Assertions do not feed materialized views, so relative order against
the MV pass does not matter; placing it next to the view loop keeps the "plain
schema-level objects first" reading.

Scope it to the renamed object's own schema — **the identical scope the view and
MV loops already use**. An assertion's stored body resolves unqualified names
against the assertion's own schema first (`Database._homeSchemaPath`), so an
unqualified `t` inside an assertion living in some *other* schema does not
necessarily mean the renamed table, and rewriting it would be a false positive.
Cross-schema references are a real but *shared* gap — see "Deliberately not in
scope" below.

### What the pass rewrites, per assertion

- **`checkExpression`** — in place, via `renameTableInAst(expr, oldName, newName, renamedSchemaName)`
  for the table arm, and `renameColumnInAst(expr, tableName, oldCol, newCol, renamedSchemaName, resolveColumnInSource)`
  for the column arm. These are the same entry points the view-body loops use, and
  for the same reason: an assertion body is a full expression that owns its own
  FROM scopes (`not exists (select … from t …)`), so the *unseeded* walker is
  correct — `renameColumnInCheckExpression`, which seeds an implicit binding to the
  owning table, is **not**. Thread the statement's existing `resolveColumnInSource`
  (built by `buildColumnSourceResolver`) so the scope-aware walk behaves exactly as
  it does for view bodies.
- **`violationSql`** — regenerated from the rewritten `checkExpression`. It must be
  byte-identical to what `CREATE ASSERTION` would have produced for the same
  expression, so extract the one-line construction currently inlined in
  `emitCreateAssertion` into a shared exported helper (suggested:
  `buildAssertionViolationSql(check: AST.Expression): string` in
  `src/schema/assertion.ts`) and call it from both sites. `schema/assertion.ts`
  importing `expressionToString` from `src/emit/ast-stringify.ts` introduces no
  cycle (that module imports only parser/AST, constants and util).
- **`dependentTables`** — informational only (the evaluator recomputes its own base
  set when it compiles). On a table rename, string-map each entry's `base`
  (`<schema>.<old>` → `<schema>.<new>`) and the base portion of `relationKey`
  (`<base>#<nodeId>`). Do **not** re-plan the body to rediscover dependencies: this
  runs mid-DDL and a planning failure there would be a new failure mode for no
  enforcement benefit. Column renames leave this field untouched.
- Skip the assertion entirely when the rewriter reports no change (`false`), so
  unaffected assertions are neither re-registered nor eventful.

Build a new record (`{ ...assertion, violationSql, dependentTables }`) and register
it through `SchemaManager.addAssertion(schema.name, updated)`. The AST itself is
mutated in place, mirroring how the view loop treats `selectAst` — `oldObject` on
the emitted event shares the rewritten AST, which no consumer reads. Going through
`addAssertion` (rather than `Schema.addAssertion`) is what fires
`assertion_modified`, which is what invalidates the optimizer's assertion-hoist
cache (`planner/analysis/assertion-hoist-cache.ts` listens for `assertion_*`).

Iterate over `Array.from(schema.getAllAssertions())` — the loop re-registers into
the same map it is walking, matching the `Array.from` the table and view loops
already use.

### What needs no change

- **The evaluator's plan cache.** `AssertionEvaluator` bumps `schemaGeneration` on
  every `table_modified`, which the rename already fires before the propagation
  runs, so the next commit recompiles from the rewritten `violationSql`. No new
  invalidation hook.
- **Persistence pre-flight.** `assertRenameDependentsPersistable` needs no assertion
  arm: no module persists assertions (`CatalogObjectKind` is `'view' | 'materializedView' | 'table'`,
  and the store package has no assertion catalog path). Confirm this with a grep
  before concluding; if a store assertion path does exist, the veto arm becomes
  required for the same unfailable-propagation reason the view arm exists.
- **The differ.** Once stored bodies track renames, no assertion rename
  reconciliation is needed for the well-formed declarative case: declaring the
  rename hint *and* updating the assertion body to the new name converges, because
  `apply schema` runs the rename (which rewrites the stored body) before the
  assertion recreate, and the re-diff then compares new-name against new-name. The
  pre-existing spurious drop+recreate on that first diff is unchanged and still
  harmless.

### Where the file boundary goes

Put the pass in a new `src/runtime/emit/assertion-rename-helpers.ts` rather than
growing `alter-table.ts`. Measured: `alter-table.ts` is 2347 lines
(`wc -l packages/quereus/src/runtime/emit/alter-table.ts`) and is already named in
`backlog/debt-emit-source-files-too-large`. `materialized-view-helpers.ts` is the
precedent for a per-object-kind rename helper module.

## Deliberately not in scope

**Cross-schema references.** An assertion in `main` whose body names `temp.u`
explicitly is *not* rewritten when `temp.u` is renamed — verified: the body stays
`select 1 where not (not exists (select 1 from "temp".u where x < 0))` and every
subsequent write fails with `Table not found: temp.u`. This is not specific to
assertions: a **view** in `main` over `temp.u` breaks identically (also verified —
its `sql` stays `create view vu as select x from "temp".u` and selecting from it
raises `Table not found: temp.u`), and materialized views share the shape. Foreign
keys and CHECK expressions are unaffected because the table loop already walks
every schema.

Fixing it properly means teaching the rename walkers an "only match an
*explicitly* schema-qualified reference" mode and running the view / MV / assertion
loops over every schema under that mode — one change benefiting all three object
kinds, which is why it does not belong inside an assertions-only ticket. Filed as
`backlog/bug-rename-not-propagated-across-schemas`.

Leave a `NOTE:` at the new pass saying the walk is home-schema-scoped, why (an
assertion resolves unqualified names against its own schema first), and that the
cross-schema case is that ticket. A related sub-case also stays open there: an
assertion in `temp` whose unqualified `t` resolves to `main.t` through the session
search path — verified reachable, and not decidable from the stored body alone
since the search path is mutable session state.

## Also discovered while reproducing (filed separately, not this ticket's work)

- `fix/bug-assertion-body-can-name-missing-table` — `CREATE ASSERTION` accepts a
  body naming a table that does not exist, and `DROP TABLE` does not check for
  assertions referring to the dropped table. Either way, every later write to the
  whole database fails. This is why the declarative half of the original report is
  only *half* fixed here: an `apply schema` whose declared assertion body was left
  on the pre-rename name will, on the next round, recreate the assertion against
  the missing table without complaint.
- `backlog/bug-assertion-info-dependent-tables-always-empty` — dependency discovery
  at create time misses base tables reached through a subquery, which is every
  realistic assertion body. Display-only.

## TODO

Phase 1 — shared violation-SQL builder

- Extract `buildAssertionViolationSql(check)` into `src/schema/assertion.ts`, using
  `expressionToString`; keep the exact `select 1 where not (<expr>)` shape.
- Rewire `emitCreateAssertion` to call it, preserving its existing error wrapping
  (`Cannot create assertion '<name>': failed to convert check expression to SQL`).

Phase 2 — the propagation pass

- Add `src/runtime/emit/assertion-rename-helpers.ts` exporting
  `propagateTableRenameToAssertions` and `propagateColumnRenameToAssertions`,
  each taking the `Database`, the `Schema`, the renamed schema name, the names
  involved, and (column arm) the shared `ResolveColumnInSource`.
- Rewrite `checkExpression` in place; on change, regenerate `violationSql`, map
  `dependentTables` (table arm only), and re-register via
  `SchemaManager.addAssertion`.
- Call both from the `schema.name === renamedSchema` block of
  `propagateTableRenameInSchema` / `propagateColumnRenameInSchema`, immediately
  after the view loop.
- Add the home-schema-scope `NOTE:` described above.

Phase 3 — tests

- `test/logic/95-assertions.sqllogic`: a rename section covering, for both the
  table and the column arm — a benign write succeeding after the rename, and a
  violating write still raising `Integrity assertion failed: …`. Include a body
  carrying a table-qualified self-reference (`… from t where t.x < 0`), which
  today survives the rename untouched.
- New `test/assertion-rename-propagation.spec.ts`:
  - stored `violationSql` and `checkExpression` name the new table/column after
    each rename kind;
  - an `assertion_modified` event fires for a rewritten assertion, and does **not**
    fire for an assertion the rename did not touch;
  - an assertion in `temp` naming `temp.qt` survives a rename of `temp.qt`
    (home-schema scoping works for a non-`main` schema);
  - negative: an assertion in `temp` naming `temp.qt` is untouched when an
    unrelated `main.qt` is renamed.
- Do **not** add a test asserting the cross-schema behavior — it is a known defect,
  not a contract.

Phase 4 — docs

- `docs/sql-alter.md` lines 19 and 29: add assertion bodies to the enumerated list
  of what each rename propagates into, noting the home-schema scope.
- `docs/schema.md` § "Assertion body-change detection" (~line 551): the paragraph
  claiming an assertion's stored CHECK expression "is never rewritten by
  `ALTER TABLE … RENAME`" is now wrong. Replace with what actually holds, and
  restate the converse case (declared body left on the old name) as pointing at
  `bug-assertion-body-can-name-missing-table` rather than at this ticket.
- `src/schema/schema-differ.ts` assertion loop (~850-859): same correction to its
  `NOTE:`.

Phase 5 — validation

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/q-test.log`
- `yarn lint`
