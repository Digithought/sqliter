---
description: The short form of CASE and the nullif function decide whether two values are "the same" by comparing raw bytes, so they disagree with the equals operator on case-insensitive columns and on duration columns.
files:
  - packages/quereus/src/runtime/emit/case.ts             # runSimpleCase — matches() calls compareSqlValues with no type/collation
  - packages/quereus/src/func/builtins/scalar.ts          # nullifFunc; also maxFunc/minFunc scalar forms at the same spot
  - packages/quereus/src/util/comparison.ts               # compareSqlValues (BINARY, no type) vs createTypedComparator
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # how `=` resolves its collation
  - packages/quereus/src/planner/building/expression.ts   # insertCrossTypeCoercion — already special-cases simple-CASE for JSON
  - packages/quereus/src/schema/function.ts               # bindArgs hook — the seam min/max already uses to get type context
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
difficulty: medium
---

# Simple `CASE` and `nullif` compare raw bytes instead of values

## What happens

Both surfaces answer "are these two values the same?" and both give a different answer
than the `=` operator does on the same pair.

Case-insensitive column:

```sql
create table t (id integer primary key, n text collate nocase);
insert into t values (1, 'bob');

select n = 'BOB' from t;                                  -- true
select case n when 'BOB' then 'hit' else 'miss' end from t;   -- 'miss'  (wrong)
select nullif(n, 'BOB') from t;                           -- 'bob'   (wrong; should be NULL)
```

Duration column (`docs/types.md` § "Semantic ordering" — `'PT1H'` and `'PT60M'` are one
elapsed time, and the engine treats them as equal everywhere else):

```sql
create table a (id integer primary key, d timespan);
insert into a values (1, 'PT1H');

select d = 'PT60M' from a;                                    -- true
select case d when 'PT60M' then 'hit' else 'miss' end from a; -- 'miss'  (wrong)
select nullif(d, 'PT60M') from a;                             -- 'PT1H'  (wrong; should be NULL)
```

Verified at HEAD (2026-07-27). JSON is partly spared: a plan-time
`cast(… as json)` (`insertCrossTypeCoercion`) already covers the simple-`CASE` WHEN
operand, so `case doc when '{ "a" : 1 }' …` hits — but `nullif(doc, '{ "a" : 1 }')`
still returns the document instead of NULL.

## Why

Both sites call `compareSqlValues(a, b)`, which is hard-wired to storage class +
`BINARY` collation and consults no logical type:

- `runtime/emit/case.ts`, `runSimpleCase` → `matches()`.
- `func/builtins/scalar.ts`, `nullifFunc`'s implementation.

The collation half of this is not new — simple `CASE` has never honored a declared
collation. The type half is what the semantic-ordering ruling added: `docs/types.md`
states that wherever a value of such a type is compared, the type's `compare` is the
order, and these two surfaces were missed.

## Expected behavior

`case x when v` and `nullif(x, y)` must use the same notion of equality the `=`
operator would use for the same operand pair — the collation resolved through the
shared provenance lattice, and the declared logical type's `compare` when the type
carries semantic ordering.

`CASE` has the operand plan nodes in hand at emit time, so it can resolve a per-WHEN
comparator the way `emitBetween` resolves a per-bound one — `emitBetween`'s
`makeBoundComparator` is the pattern to copy, since simple `CASE` has exactly the same
"one base expression against N independently-typed operands" shape.

`nullif` is a scalar function and gets no type context from the current registration
contract. `min`/`max` solved the identical problem for **aggregates** by adding an
`AggregateFunctionSchema.bindArgs` hook that the call site invokes once at emit time
with the argument's declared type and resolved collation (see
`tickets/complete/1-minmax-semantic-ordering.md`); the scalar function contract needs
the same seam, or `nullif` needs to be desugared at plan-build time into the comparison
it means.

## Also in scope

`func/builtins/scalar.ts` has **scalar** (multi-argument, non-aggregate) `max(…)` and
`min(…)` implementations that use the same bare `compareSqlValues`. The aggregate forms
were fixed; the scalar forms were not, so `max('PT2H', 'PT90M')` still returns `'PT2H'`.
Same root cause, same seam — fix them together.

## Coverage

Add the CASE / `nullif` / scalar-`min`/`max` cases to
`test/logic/15.1-semantic-ordering.sqllogic` for the duration and JSON types, and to
`test/logic/06.4.2-collation-extras.sqllogic` for the `collate nocase` case — the
collation regression is independent of the type-system one and deserves its own
assertions.
