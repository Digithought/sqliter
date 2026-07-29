---
description: Adding a computed column to a table that already has rows leaves every one of those rows blank in the new column forever, even though rows inserted afterwards compute it correctly.
files:
  - packages/quereus/src/planner/building/alter-table.ts        # buildAddColumnBackfill — the root cause; keys only on DEFAULT
  - packages/quereus/src/runtime/emit/alter-table.ts            # runAddColumn — consumes the backfill; comments say "DEFAULT" throughout
  - packages/quereus/src/planner/nodes/alter-table-node.ts      # AddColumnBackfill type + doc
  - packages/quereus/src/vtab/memory/layer/manager.ts           # MemoryTableManager.addColumn ~line 1934 — NOT NULL gate needs the generated case
  - packages/quereus-store/src/common/store-module-alter.ts     # already gates on !backfillEvaluator — reference for the correct shape
  - packages/quereus-isolation/src/alter-migration.ts           # deriveAddColumnBackfill — passes the evaluator through; no change expected
  - packages/quereus/src/planner/validation/determinism-validator.ts  # validateDeterministicGenerated
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic   # existing generated-column error coverage
  - docs/sql-ddl.md                                             # § Generated Columns, § Default Values (ADD COLUMN backfill bullet)
  - docs/types.md                                               # § "ALTER backfills follow the same rule"
difficulty: medium
---

# Reproduced

Confirmed on a plain memory table, no store / transaction / constraint involved. All
probes below were run against `main` at `42554a03`.

```
create table at (id integer primary key, v integer);
insert into at values (1, 5);
alter table at add column g integer null generated always as (v * 2);
select * from at;   -- id=1 v=5 g=null    (should be g=10)
insert into at (id, v) values (2, 7);
select * from at;   -- id=1 g=null, id=2 g=14
```

Additional probes, all on a table already holding one row `(id=1, v=5)`:

| case | today |
| --- | --- |
| `add column g int null generated always as (v * 2)` | silently `g=null` |
| same, spelled `... virtual` | silently `g=null` |
| same, spelled `... stored` | silently `g=null` |
| `add column g int null generated always as (2)` (constant expression) | silently `g=null` |
| `add column g int null generated always as (h * 10)`, `h` itself generated | silently `g=null` |
| `add column g int not null generated always as (v * 2)` | rejected: *"NOT NULL constraint failed for column 'g' … column has no DEFAULT and existing rows cannot be backfilled"* |
| `add column g int null generated always as (v * 2) check (g > 100)` | silently accepted with `g=null` (the CHECK scan sees NULL, and `not (null > 100)` is NULL, so no violation is detected) |
| `add column g text null generated always as (random())` | silently accepted with `g=null` |
| `add column g int null generated always as (nope * 2)` | already rejected — *"Column 'nope' … not found"* |
| `add column g int null generated always as (g + 1)` | already rejected — *"Cyclic dependency in generated columns"* |
| the same column added through `declare schema main { … }` + `apply schema main` | silently `g=null` (routes through the same emitter) |

# Why it happens

`buildAddColumnBackfill` (planner/building/alter-table.ts) looks only for a `default`
constraint on the new column:

```ts
const defaultExpr = columnDef.constraints?.find(c => c.type === 'default')?.expr;
if (!defaultExpr) return undefined;
```

A `generated` constraint therefore never produces a backfill node, so `runAddColumn`
receives `backfill === undefined`, builds no `backfillEvaluator`, and hands the module an
ADD COLUMN with no per-row value source. Each module then writes its single fallback
value — which for a generated column is `null`, because a generated column has no
`defaultValue` (`columnDefToSchema` rejects a column carrying both). The column's
dependency graph *is* rebuilt correctly right afterwards (`withGeneratedColumnGraph`),
which is why every subsequent INSERT computes the value; only the pre-existing rows are
missed.

# Two questions the source ticket raised, now answered

**Virtual vs stored: no distinction to make.** This engine materializes a generated
column's value at write time regardless of the `VIRTUAL` / `STORED` keyword —
`createGeneratedColumnProjection` (planner/building/insert.ts) projects the computed value
into the row that gets stored, and `building/update.ts` appends implicit assignments for
the same purpose. Nothing recomputes a generated column on read. `generatedStored` is
informational only (surfaced as `table_info.generated` = 1 vs 2). `docs/sql-ddl.md`
already states this: *"VIRTUAL: Semantically computed on read (currently stored
identically to STORED; storage optimization is planned)"*. One backfill path covers both
spellings, and the probe table above confirms both are equally broken today.

**`ALTER TABLE ALTER COLUMN` turning a column into a computed one: no such statement.**
The parser rejects it — `alter table t alter column g set generated always as (v * 2)`
yields *"Expected NOT NULL, DATA TYPE, DEFAULT, COLLATE, or TAGS after SET"*. There is no
gap to close here, and adding that verb is out of scope for this ticket.

# Expected after the fix

Adding a computed column to a table with rows computes it for those rows, so the column's
value is a pure function of the row afterwards — identical to what the same declaration in
`create table` produces and to what a fresh insert produces. Anything the recomputation
cannot honour rejects the whole `ALTER` (leaving the table exactly as it was, via the
existing `revertAddColumn`) rather than half-populating it.

# Shape of the fix

The machinery already exists and is exercised by the `DEFAULT (new.<col>)` path: the
planner compiles a scalar node over a row scope of the table's *existing* columns, the
emitter installs a row slot over it and hands the module a per-row evaluator, and each
module calls that evaluator once per existing row. The generated case needs the same node
built from the generated expression instead of the default expression.

Points where the generated arm must **not** simply copy the default arm:

- **No `tryFoldLiteral` early return.** The default arm returns `undefined` for a
  literal-folding default because the module bulk-writes it from the column's
  `defaultValue`. A generated column has no `defaultValue`, so the same shortcut writes
  NULL — this is exactly the `generated always as (2)` probe above. Always build the
  per-row node for the generated arm.
- **Determinism validator.** Use `validateDeterministicGenerated`, not
  `validateDeterministicDefault`, matching the INSERT/UPDATE build sites. Both honour the
  `nondeterministic_schema` option, so the escape hatch is unchanged. *Behaviour change to
  call out in the handoff:* `add column g … generated always as (random())` is silently
  accepted today (and only fails at the next INSERT); it will be rejected at `ALTER` time,
  including on an empty table. That matches the existing DEFAULT arm, which validates at
  build time regardless of row count.
- **Do not route the generated expression through `schemaManager.validateAddColumnDefault`.**
  That validator rejects bare (unqualified) column references, which are the normal and
  required shape for a generated expression. It stays on the default arm only.
- The existing row scope (`buildRowDefaultScope`) already registers both `new.<col>` and
  the bare `<col>` for every existing column, so `v * 2` resolves with no scope change.
- `coerceTo` (convert the evaluated value to the new column's declared type unless the
  expression's static type already *is* that type) applies unchanged.

## The NOT NULL gate, in three places

`ALTER TABLE ADD COLUMN … NOT NULL` on a non-empty table is rejected wherever no value
source exists. Three gates exist and they do not agree on what counts as a value source:

- `runAddColumn` (runtime/emit/alter-table.ts, `if (hasNotNull && !delegatesBackfill &&
  !backfill)`) — keyed on the backfill's presence, so it starts behaving correctly the
  moment the generated arm produces one. No change needed.
- `StoreModuleBase.alterAddColumn` (quereus-store/src/common/store-module-alter.ts,
  `if (newColSchema.notNull && defaultValue === null && !backfillEvaluator)`) — already
  the right shape. No change needed.
- `MemoryTableManager.addColumn` (quereus/src/vtab/memory/layer/manager.ts, around
  line 1934, `if (newColumnSchema.notNull && defaultValue === null && !defaultIsLiteral &&
  !hasDefaultExpr && tableHasRows)`) — **needs the fix.** It enumerates *kinds of DEFAULT*
  rather than asking whether a per-row value source was supplied, so a NOT NULL generated
  column is rejected on a non-empty table even though the evaluator can fill it. Bring it
  in line with the store module's gate (exempt when a `backfillEvaluator` was supplied);
  keep the existing comment's reasoning about why the *per-row* NOT NULL check further
  down stays ungated — that is a separate check and should not change.

Once that is done, a NOT NULL generated column whose expression yields NULL for some
existing row is still rejected per-row inside the module's backfill
(`BaseLayer.recreatePrimaryTreeWithNewColumn`), which is the desired "reject the ALTER
rather than half-populate" behaviour.

## Downstream sites that need no change (verified)

- `quereus-isolation/src/alter-migration.ts` — `deriveAddColumnBackfill` reads the DEFAULT
  only for its `foldedDefault` fallback but forwards `change.backfillEvaluator` verbatim,
  and `computeAddColumnValue` prefers the evaluator when present. It inherits the fix.
- The batched data-change-event remap inside `runAddColumn` (`foldedDefault ?? null`, then
  the evaluator applied best-effort to each historical image) works unchanged: with a
  generated column `foldedDefault` is undefined and the evaluator supplies the value.
- `withGeneratedColumnGraph` / cycle and unknown-column rejection already work. Note that
  after the fix an unresolvable or self-referencing generated expression is caught
  *earlier* — at plan-build, when the backfill node's column refs fail to resolve against
  the existing-column scope — so the error text for those two cases changes from
  *"Column 'nope' … not found in table 't4'"* / *"Cyclic dependency in generated columns"*
  to a build-time resolution error. Both remain clear rejections and both remain
  pre-mutation. `test/logic/41-generated-column-errors.sqllogic` asserts these only via
  bare `-- error:` markers on `CREATE TABLE`, so nothing breaks; still, prefer keeping the
  specific messages if it is cheap to do so.

## Inline CHECK on a generated column

`buildAddColumnChecks` is gated on `backfill ?`, so a generated column with an inline
CHECK starts getting its predicates enforced per backfilled row as a side effect of this
fix. That is the correct outcome — the `check (g > 100)` probe above is silently accepted
today only because the un-backfilled NULL makes the post-backfill scan's `not (<check>)`
evaluate to NULL. After the fix that ALTER is correctly rejected.

# TODO

- Add a failing test first, in `packages/quereus/test/logic/` alongside
  `41-generated-column-errors.sqllogic` (a sibling `41.x-…` covering the success paths is
  the natural home): existing rows backfilled for `virtual`, for `stored`, for the
  bare/unspecified spelling, and for a constant generated expression; rows added
  afterwards agree with the backfilled ones; a generated expression over an existing
  generated column resolves.
- Widen `buildAddColumnBackfill` (planner/building/alter-table.ts) to source its
  expression from a `generated` constraint as well as a `default` one — mutually exclusive,
  since `columnDefToSchema` already rejects a column carrying both. Skip the
  `tryFoldLiteral` early return on the generated arm and use
  `validateDeterministicGenerated` for it. Leave `validateAddColumnDefault` on the default
  arm only.
- Fix the NOT NULL gate in `MemoryTableManager.addColumn`
  (quereus/src/vtab/memory/layer/manager.ts ~1934) so a supplied `backfillEvaluator`
  counts as a value source, mirroring `store-module-alter.ts`.
- Add coverage for `add column … not null generated always as (…)` — accepted and
  backfilled on a non-empty table when the expression is total; rejected, with the table
  left untouched, when it yields NULL for some existing row.
- Add coverage for the inline-CHECK interaction: `add column g … generated always as (v*2)
  check (g > 100)` must reject the ALTER and leave the table exactly as it was.
- Add coverage for the declarative route (`declare schema main { … }` + `apply schema
  main` adding a generated column to a populated table) — it goes through the same
  emitter, so it should pass once the planner arm lands, but it is the surface a user is
  most likely to hit.
- Widen the now-misleading "DEFAULT"-only wording in the comments on `emitAlterTable`,
  `runAddColumn`, the `backfillEvaluator` construction, `buildAddColumnBackfill`, and the
  `AddColumnBackfill` type doc (planner/nodes/alter-table-node.ts).
- Update `docs/sql-ddl.md`: the § Generated Columns bullet list should state that
  `ALTER TABLE ADD COLUMN … GENERATED ALWAYS AS` backfills existing rows, and the
  § Default Values ADD COLUMN bullet should stop reading as though DEFAULT is the only
  backfilled kind. Update the § "ALTER backfills follow the same rule" block in
  `docs/types.md` to cover the generated expression's conversion (it takes the same
  `coerceTo` identity-guarded path as a non-foldable DEFAULT).
- Run `yarn test` and `yarn lint` from the repo root. `yarn test:store` exercises the
  store module's own ADD COLUMN migration path, which this change reaches through the
  shared `backfillEvaluator` contract — run it if wall-clock allows, and say so either way
  in the review handoff.
