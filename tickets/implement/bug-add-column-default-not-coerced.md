---
description: When you add a new column to an existing table and give it a default value, the rows that were already there store that default as raw text instead of converting it to the column's declared type — so old rows and new rows end up holding different-looking values.
files:
  - packages/quereus/src/types/validation.ts                        # home for the new shared fold+coerce helper
  - packages/quereus/src/types/index.ts                             # re-export
  - packages/quereus/src/index.ts                                   # public re-export (store + isolation import from here)
  - packages/quereus/src/planner/building/alter-table.ts            # buildAddColumnBackfill — needs to carry the target type + identity flag
  - packages/quereus/src/planner/nodes/alter-table-node.ts          # AddColumnBackfill interface
  - packages/quereus/src/runtime/emit/alter-table.ts                # backfillEvaluator (~504), foldedDefault (~443/567), alterColumnEventValueRemap (~1255)
  - packages/quereus/src/vtab/memory/layer/manager.ts               # addColumn literal fold (~1915)
  - packages/quereus/src/vtab/memory/layer/alter-column.ts          # planTightenNotNull (~207)
  - packages/quereus-store/src/common/store-module-alter.ts         # alterAddColumn literal fold (~160)
  - packages/quereus-store/src/common/store-module-alter-column.ts  # alterColumnSetNotNull literal detection (~300)
  - packages/quereus-isolation/src/alter-migration.ts               # deriveAddColumnBackfill (~278), deriveSetNotNullBackfill (~319)
  - packages/quereus/test/logic/                                    # sqllogic home for the new coverage
difficulty: medium
---

# Confirmed behavior

All reproduced on `main` against a plain in-memory table (no store, no isolation
layer). Each case ran the ALTER, then an INSERT that lets the *same* default apply,
and compared.

**1. Literal default, ADD COLUMN — backfilled row keeps the raw literal.**

```sql
create table t (a integer primary key, b integer);
insert into t values (1, 10);
alter table t add column n integer default '7';
insert into t (a, b) values (2, 20);
select a, n, typeof(n) from t order by a;
-- a=1  n='7'    typeof=text      <-- backfilled
-- a=2  n=7      typeof=integer   <-- inserted
```

For a `json` column the split is sharper — the backfilled cell holds the default's
raw *source text*, which is not the stored form any write path produces:

```sql
alter table j add column n json default '"abc"';
-- backfilled: n = '"abc"'  (text)
-- inserted:   n = 'abc'    (the parsed JSON string scalar)
```

**2. Non-foldable default (`new.<col>`), ADD COLUMN — same split.** Not mentioned in
the original report; the per-row evaluator's result is stored verbatim too.

```sql
create table e (a integer primary key, b text);
insert into e values (1, '7');
alter table e add column n integer default (new.b);
insert into e (a, b) values (2, '20');
-- a=1  n='7'  typeof=text      <-- backfilled by the evaluator
-- a=2  n=20   typeof=integer   <-- inserted
```

**3. `alter column … set not null` with a DEFAULT — same split.**

```sql
create table s (a integer primary key, b integer null default '5');
insert into s (a, b) values (1, null);
alter table s alter column b set not null;
-- a=1  b='5'  typeof=text
```

**4. An unconvertible literal default is accepted and stored as garbage.**

```sql
create table u (a integer primary key);
insert into u values (1);
alter table u add column n integer default 'abc';   -- accepted today
-- u: a=1  n='abc'  typeof=text
```

The equivalent INSERT throws `MISMATCH` (StatusCode 20):
`Type conversion failed for column 'n': Cannot convert 'abc' to INTEGER`.

# Root cause

Every non-ALTER write path converts each cell to its column's declared logical type
before it reaches storage. `emitInsert`
(`packages/quereus/src/runtime/emit/insert.ts:24`) builds that conversion at the top
of the DML pipeline via `buildRowCoercion`, so constraint checking *and* the storage
layer (told `preCoerced`) both see the declared form. `coerceRowToSchema` is the
equivalent for callers that write rows directly.

The ALTER backfill paths never call either. They take the DEFAULT expression straight
from the AST, run `tryFoldLiteral` on it, and store the resulting raw literal — or,
for a non-foldable default, store the evaluator's raw result. Eight sites do this
independently, and they all currently agree *with each other* on the un-converted
value, which is why nothing has caught it:

| # | Site | What it folds/produces |
|---|---|---|
| 1 | `vtab/memory/layer/manager.ts:1915` | ADD COLUMN literal default (memory module) |
| 2 | `quereus-store/src/common/store-module-alter.ts:160` | ADD COLUMN literal default (store module) |
| 3 | `quereus-isolation/src/alter-migration.ts:278` (`deriveAddColumnBackfill`) | ADD COLUMN literal default for staged overlay rows |
| 4 | `runtime/emit/alter-table.ts:443` → used at `:567` | ADD COLUMN literal default written into the batched **data-change events** |
| 5 | `runtime/emit/alter-table.ts:504-527` (`backfillEvaluator`) | ADD COLUMN per-row `new.<col>` default — feeds sites 1, 2 and 3 |
| 6 | `vtab/memory/layer/alter-column.ts:207` (`planTightenNotNull`) | SET NOT NULL backfill literal (memory) |
| 7 | `quereus-store/src/common/store-module-alter-column.ts:300` (`alterColumnSetNotNull`) | SET NOT NULL backfill literal (store) |
| 8 | `quereus-isolation/src/alter-migration.ts:319` (`deriveSetNotNullBackfill`) | SET NOT NULL backfill literal for staged overlay rows |

Because they must stay mutually consistent (a divergence between the isolation
overlay and the committed store is worse than the current uniform wrongness), **all
eight move together in one change.**

Note the isolation overlay writes its staged rows with `preCoerced: true`, so it can
never pick up the conversion implicitly — site 3 and site 8 need it applied
explicitly.

## Trap: conversion is not idempotent — the evaluator path needs an identity guard

`buildRowCoercion` deliberately **skips** a cell whose producing expression's static
logical type already *is* the target column's logical type, because re-converting is
destructive for some types. JSON's `parse` reads a plain JS string as JSON *source*,
so re-converting a stored JSON value either changes it (stored text `9` becomes the
number 9) or throws (stored text `abc` is not valid JSON source).

This is live today for ADD COLUMN. Verified on `main`:

```sql
create table t (a integer primary key, j json);
insert into t values (1, '"abc"'), (2, '9');   -- stored: j = 'abc' (text), j = 9 (integer)
alter table t add column k json default (new.j);
-- k = 'abc' and k = 9 — CORRECT today, because the raw copy happens to be right
```

A blanket coercion on the evaluator result would re-parse the already-stored JSON and
break this currently-correct case (row 1 would throw). So the evaluator path must
carry the same identity check `buildRowCoercion` uses: compare the backfill
expression's static `logicalType` (`backfill.node.getType().logicalType`) to the new
column's (`inferType(columnDef.dataType)`) and convert only when they differ. Types
are compared by **object identity** — the registry hands out one shared `LogicalType`
instance per type.

The folded-literal path needs no such guard: an AST literal is always raw source form
(a TEXT literal `'"abc"'`), never already-in-declared-form.

# Expected after the fix

A backfilled cell is indistinguishable from the cell a fresh INSERT under the same
default would produce — same value, same `typeof`, for the literal path, the
`new.<col>` evaluator path, and the SET NOT NULL path, and identically across the
memory module, the store module, and rows staged in an open transaction behind the
isolation layer.

## Decision made here: an unconvertible literal default now rejects the ALTER

Case 4 above must stop storing garbage. The two options were:

- **(chosen) Coerce at fold time and let it throw**, so
  `alter table u add column n integer default 'abc'` fails with the same `MISMATCH`
  message the INSERT gives, whether or not the table has rows.
- Coerce lazily per backfilled row, so an empty table still accepts the broken
  default (matching `CREATE TABLE`, which accepts `n integer default 'abc'` today and
  only fails at the first INSERT).

Chosen the first: DDL acceptance that does not depend on how many rows happen to be
in the table is far less surprising than "works on an empty table, fails once you
have one row", and the error names the real problem at the moment it is introduced.
The cost is a deliberate asymmetry with `CREATE TABLE`, which still accepts an
unconvertible literal default silently — that gap is real but out of scope here; if
it should close, it closes by making CREATE stricter, not ALTER looser. Flag it in
the review handoff rather than widening this ticket.

# Design

Add one shared helper so the eight sites cannot drift again, exported from the core
package (the store and isolation packages import from `@quereus/quereus`).

Suggested home `packages/quereus/src/types/validation.ts` — it already owns
`validateAndParse` / `coerceRowToSchema` / `buildRowCoercion`, and it already imports
`../schema/column.js`. Adding a type-only `../parser/ast.js` import plus a value
import of `../parser/utils.js` (`tryFoldLiteral`) introduces no cycle: `parser/utils`
depends only on `common/` and `parser/ast`.

```ts
/**
 * Fold a DEFAULT expression to a literal AND convert it to the column's declared
 * logical type — the value a fresh INSERT under the same DEFAULT would store.
 * Returns undefined when the expression does not fold (the caller's per-row
 * evaluator path), null when it folds to NULL.
 *
 * @throws QuereusError (MISMATCH) when the literal cannot be converted, with the
 *   same message text the INSERT path produces.
 */
export function foldDefaultToType(
  expr: Expression | undefined,
  logicalType: LogicalType,
  columnName: string,
): SqlValue | undefined;
```

Naming is the implementer's call; keep it discoverable next to `tryFoldLiteral`.

For the evaluator path, widen `AddColumnBackfill`
(`planner/nodes/alter-table-node.ts:16`) to carry what the emitter needs to decide
conversion, computed in `buildAddColumnBackfill`
(`planner/building/alter-table.ts:235`) where both the node and the columnDef are in
hand:

```ts
export interface AddColumnBackfill {
  readonly node: ScalarPlanNode;
  readonly rowDescriptor: RowDescriptor;
  /**
   * The new column's logical type, or undefined when the default expression's
   * static type already IS that type — conversion is skipped there, exactly as
   * `buildRowCoercion` skips an identity match (re-converting is destructive for
   * JSON). See the identity-guard note in this ticket.
   */
  readonly coerceTo?: LogicalType;
}
```

The emitter then converts inside `backfillEvaluator` **before** the per-row CHECK
predicates run — matching the write path, where `emitInsert` coerces at the top of
the pipeline and constraint checking sees the declared form.

# TODO

## Phase 1 — shared helper

- Add the fold+coerce helper to `packages/quereus/src/types/validation.ts`; re-export
  from `src/types/index.ts` and `src/index.ts` (both already export
  `validateAndParse` / `coerceRowToSchema` / `tryFoldLiteral`, so follow that shape).
- Unit-cover the helper directly: non-foldable expr → `undefined`; `default null` →
  `null`; `'7'` on INTEGER → `7`; `'"abc"'` on JSON → `'abc'`; `-123.0` on REAL (the
  UnaryExpr case `tryFoldLiteral` already handles) → `-123`; `'abc'` on INTEGER →
  throws MISMATCH with the INSERT path's message.

## Phase 2 — ADD COLUMN literal default (sites 1-4)

- `vtab/memory/layer/manager.ts` `addColumn`: fold through the helper against
  `newColumnSchema.logicalType`. Keep the existing `defaultIsLiteral` / NOT-NULL
  gating semantics — a coerced NULL is still NULL.
- `quereus-store/src/common/store-module-alter.ts` `alterAddColumn`: same, against
  `newColSchema.logicalType`.
- `quereus-isolation/src/alter-migration.ts` `deriveAddColumnBackfill`: same. It
  already builds the new column via `columnDefToSchema`, so the logical type is in
  hand; keep the existing "undefined and null both collapse to null" contract.
- `runtime/emit/alter-table.ts` `runAddColumn`: fold `foldedDefault` through the
  helper against `inferType(columnDef.dataType)` so the batched data-change events
  (`:567`) carry the same value the rows do. Confirm the NOT NULL gate at `:468`
  still reads correctly against the coerced value.

## Phase 3 — ADD COLUMN evaluator default (site 5)

- Add `coerceTo` to `AddColumnBackfill` and populate it in `buildAddColumnBackfill`,
  set only when `backfill.node.getType().logicalType !== inferType(columnDef.dataType)`
  (identity comparison — one shared `LogicalType` instance per type).
- In `runAddColumn`'s `backfillEvaluator`, convert the evaluated value via
  `validateAndParse` when `coerceTo` is set, **before** the CHECK predicates are
  evaluated against `[...row, value]`.
- Confirm the NOT NULL rejection in `base.ts` `recreatePrimaryTreeWithNewColumn` still
  fires — converting `null` yields `null`, so the check is unaffected, but assert it.

## Phase 4 — SET NOT NULL backfill (sites 6-8)

- `vtab/memory/layer/alter-column.ts` `planTightenNotNull`: fold the column's own
  DEFAULT through the helper against `oldCol.logicalType`.
- `quereus-isolation/src/alter-migration.ts` `deriveSetNotNullBackfill`: same, against
  the pre-alter overlay column's `logicalType`.
- `quereus-store/src/common/store-module-alter-column.ts` `alterColumnSetNotNull`:
  same. **Also fix an adjacent inconsistency on that line** — it detects the literal
  with a hand-rolled `expr.type === 'literal'` check instead of `tryFoldLiteral`, so a
  signed numeric default (`default -5`, a UnaryExpr) is invisible to the store and the
  ALTER rejects where the memory module backfills. Route it through the shared helper
  like the other seven.
- `runtime/emit/alter-table.ts` `alterColumnEventValueRemap` (`:1255`, the
  `setNotNull === true` branch): fold through the helper so the remapped historical
  event images match the stored rows.

## Phase 5 — tests

- New sqllogic (e.g. `packages/quereus/test/logic/41.11-alter-add-column-default-coercion.sqllogic`)
  — runs under both the memory module (`yarn test`) and the store module
  (`yarn test:store`), and assertions read back through `typeof(...)`, which is
  module-agnostic. Cover:
  - literal `'7'` on an INTEGER column: backfilled row and a later inserted row agree
    on value *and* `typeof`;
  - literal `'"abc"'` on a JSON column: backfilled row equals the inserted row;
  - `default (new.<col>)` where the source column's type differs from the new column's
    (e.g. `text` → `integer`): backfilled row matches the inserted row;
  - **regression guard** for the identity case: `add column k json default (new.j)`
    where `j` is already `json` must leave `'abc'` and `9` untouched (this is the case
    a blanket coercion breaks);
  - `alter column … set not null` with a mismatched literal DEFAULT backfills the
    converted value;
  - `add column n integer default 'abc'` on a non-empty table errors (MISMATCH), and —
    per the decision above — on an empty table too.
- Isolation coverage in `packages/quereus-isolation/test/isolation-layer.spec.ts`
  (there is an existing ADD COLUMN backfill `describe` around `:2177`): inside an open
  transaction, stage an insert, run `add column n integer default '7'`, assert the
  staged row reads back as INTEGER `7` before commit and still after commit — i.e. the
  overlay and the committed store agree on the *converted* value.
- Check whether any existing test asserts the un-converted behavior and update it
  rather than working around it.

## Phase 6 — validation

- `yarn build`, `yarn lint`, `yarn test` from the repo root.
- `yarn test:store` — the store leg is one of the eight sites and the new sqllogic is
  written to exercise it; do not skip.
- `yarn workspace @quereus/quereus-isolation test` (or the root `yarn test`, which
  fans out) for the isolation spec.

## Handoff notes for review

- Say explicitly whether the `CREATE TABLE` asymmetry (it still accepts an
  unconvertible literal default silently, e.g.
  `create table t (a integer primary key, n integer default 'abc')`, and only fails at
  the first INSERT) should be closed by a follow-up ticket. It is a real gap, it is
  deliberately out of scope here, and the reviewer should decide rather than inherit
  it silently.
- Note whether `docs/sql.md` or `docs/types.md` describe ALTER default handling and
  need a line about the conversion; update in place if so (no new summary doc).
